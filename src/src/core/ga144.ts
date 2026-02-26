/**
 * GA144 chip controller - manages 144 F18A nodes.
 * Port of reference/ga144/src/ga144.rkt
 */
import { F18ANode } from './f18a';
import { NUM_NODES, coordToIndex, indexToCoord, ANALOG_NODES } from './constants';
import { NodeState } from './types';
import type { GA144Snapshot, CompiledProgram } from './types';
import { recordIdle } from './thermal';
import type { ThermalState } from './thermal';
import {
  createEventQueue, enqueue, dequeue, peekTime, isEmpty,
  removeByTypeAndPayload, clearQueue,
  EVT_NODE, EVT_SERIAL,
  type EventQueue,
} from './event-queue';
import { SerialBits } from './serial';
import type { SerialBit } from './serial';

export interface IoWriteDelta {
  writes: number[];
  timestamps: number[];
  startSeq: number;
  totalSeq: number;
}

export class GA144 {
  readonly name: string;
  private nodes: F18ANode[];
  private activeNodes: F18ANode[];
  private lastActiveIndex: number = NUM_NODES - 1;
  private totalSteps = 0;
  private guestWallClock = 0;
  private _breakpointHit = false;
  private eventsSinceIdleSweep = 0;

  // Event queue for discrete event simulation
  private eventQueue: EventQueue = createEventQueue();
  private readonly _evt = { time: 0, type: 0, payload: 0 }; // reusable dequeue scratch

  // Serial bit state — only one EVT_SERIAL event in the queue at a time
  private serialBitValues: boolean[] = [];
  private serialBitTimes: number[] = [];  // absolute start time for each bit
  private serialEndTime: number = 0;      // absolute end time of last bit
  private serialBitIndex: number = 0;     // next bit to fire
  private serialNode: F18ANode | null = null;

  // IO write capture for VGA display — ring buffer of recent writes
  private static readonly IO_WRITE_CAPACITY = 2_000_000;
  private ioWriteBuffer: number[] = new Array(GA144.IO_WRITE_CAPACITY);
  private ioWriteTimestamps: number[] = new Array(GA144.IO_WRITE_CAPACITY);
  private ioWriteJitter: Float32Array = new Float32Array(GA144.IO_WRITE_CAPACITY);
  private ioWriteStart = 0;     // ring start index
  private ioWriteStartSeq = 0;  // sequence number at ring start
  private ioWriteSeq = 0;       // next sequence number to write
  private lastVsyncSeq: number | null = null;

  // ROM data loaded externally
  private romData: Record<number, number[]> = {};

  // SharedArrayBuffer VCO counters for analog nodes (null = fallback)
  private vcoCounters: Uint32Array | null = null;

  /** Nominal nanoseconds per step tick (one ALU instruction). */
  static readonly NS_PER_TICK = 1.5;

  /** Boot UART baud rate. */
  static readonly BOOT_BAUD = 921_600;

  constructor(name: string = 'chip1') {
    this.name = name;
    this.nodes = new Array(NUM_NODES);
    this.activeNodes = new Array(NUM_NODES);

    // Create 144 nodes
    for (let i = 0; i < NUM_NODES; i++) {
      this.nodes[i] = new F18ANode(i, this);
      this.activeNodes[i] = this.nodes[i];
    }

    // Initialize neighbor connections
    for (const node of this.nodes) {
      node.init();
    }
  }

  setRomData(romData: Record<number, number[]>): void {
    this.romData = romData;
    this.reset();
  }

  /** Set SharedArrayBuffer-backed VCO counters for analog nodes. */
  setVcoCounters(counters: Uint32Array | null): void {
    this.vcoCounters = counters;
    // Wire to existing analog nodes immediately
    if (counters) {
      for (let i = 0; i < ANALOG_NODES.length; i++) {
        this.getNodeByCoord(ANALOG_NODES[i]).setVcoCounter(counters, i);
      }
    }
  }

  /**
   * Flush all 144 nodes' thermal temperatures and the guest wall clock
   * to the SharedArrayBuffer. Called periodically by the emulator worker
   * so the clock worker can incorporate thermal jitter into VCO counter values.
   *
   * SAB layout: [0..4] VCO counters, [5..148] thermal temps × 1000
   */
  flushVcoTemperatures(): void {
    if (!this.vcoCounters) return;
    const thermalOffset = ANALOG_NODES.length; // = 5
    for (let i = 0; i < NUM_NODES; i++) {
      const temp = this.nodes[i].thermal.temperature;
      Atomics.store(this.vcoCounters, thermalOffset + i, Math.floor(temp * 1000));
    }
  }

  // ========================================================================
  // Active list management (swap-based O(1) add/remove)
  // ========================================================================

  removeFromActiveList(node: F18ANode): void {
    const idx = node.activeIndex;
    if (idx > this.lastActiveIndex) return; // already inactive

    const last = this.activeNodes[this.lastActiveIndex];
    // Swap with last active
    this.activeNodes[idx] = last;
    this.activeNodes[this.lastActiveIndex] = node;
    last.activeIndex = idx;
    node.activeIndex = this.lastActiveIndex;
    this.lastActiveIndex--;
  }

  addToActiveList(node: F18ANode): void {
    const idx = node.activeIndex;
    if (idx <= this.lastActiveIndex) return; // already active

    this.lastActiveIndex++;
    const first = this.activeNodes[this.lastActiveIndex];
    // Swap with first inactive
    this.activeNodes[this.lastActiveIndex] = node;
    this.activeNodes[idx] = first;
    first.activeIndex = idx;
    node.activeIndex = this.lastActiveIndex;
  }

  // ========================================================================
  // Event queue node scheduling
  // ========================================================================

  /** Remove a node from the event queue (called when node suspends). */
  deactivateNode(node: F18ANode): void {
    removeByTypeAndPayload(this.eventQueue, EVT_NODE, node.index);
  }

  /** Enqueue a node into the event queue (called when node wakes up). */
  enqueueNode(node: F18ANode): void {
    enqueue(this.eventQueue, node.thermal.simulatedTime, EVT_NODE, node.index);
  }

  // ========================================================================
  // Stepping — event-driven discrete event simulation
  // ========================================================================

  /**
   * Pop the soonest event and execute it. Returns true if breakpoint hit.
   */
  stepProgram(): boolean {
    this.stepProgramN(1);
    return this._breakpointHit;
  }

  /**
   * Step up to N node-events. Returns true if a breakpoint was hit.
   *
   * Hot-loop optimization: after executing a node event, if the node's
   * next timestamp is still earlier than the new queue head, re-execute
   * it immediately without touching the queue.
   */
  stepProgramN(n: number): boolean {
    this._breakpointHit = false;
    const q = this.eventQueue;
    const evt = this._evt;
    let remaining = n;

    while (remaining > 0) {
      if (!dequeue(q, evt)) return false; // queue empty — chip idle

      this.guestWallClock = evt.time;

      if (evt.type === EVT_SERIAL) {
        // Serial pin17 edge — set pin and enqueue next bit
        const bitIdx = evt.payload;
        if (this.serialNode && bitIdx < this.serialBitValues.length) {
          this.serialNode.setPin17(this.serialBitValues[bitIdx]);
        }
        this.serialBitIndex = bitIdx + 1;
        if (this.serialBitIndex < this.serialBitValues.length) {
          enqueue(q, this.serialBitTimes[this.serialBitIndex], EVT_SERIAL, this.serialBitIndex);
        }
        this.idleSweepTick();
        continue; // serial events don't consume budget
      }

      // EVT_NODE — step one instruction
      const node = this.nodes[evt.payload];
      node.stepProgram();
      this.totalSteps++;
      remaining--;
      if (this._breakpointHit) {
        if (!node.isSuspended()) {
          enqueue(q, node.thermal.simulatedTime, EVT_NODE, node.index);
        }
        return true;
      }

      // Hot loop: keep re-executing this node while it's the soonest
      if (!node.isSuspended() && remaining > 0 && !isEmpty(q)) {
        let nextTime = node.thermal.simulatedTime;
        const headTime = peekTime(q);
        while (remaining > 0 && nextTime <= headTime) {
          this.guestWallClock = nextTime;
          node.stepProgram();
          this.totalSteps++;
          remaining--;
          if (this._breakpointHit || node.isSuspended()) break;
          nextTime = node.thermal.simulatedTime;
          this.idleSweepTick();
        }
      }

      // Re-enqueue if still active
      if (!node.isSuspended()) {
        enqueue(q, node.thermal.simulatedTime, EVT_NODE, node.index);
      }

      this.idleSweepTick();
    }

    return this._breakpointHit;
  }

  private idleSweepTick(): void {
    this.eventsSinceIdleSweep++;
    if (this.eventsSinceIdleSweep >= 1000) {
      this.eventsSinceIdleSweep = 0;
      for (let i = NUM_NODES - 1; i > this.lastActiveIndex; i--) {
        const node = this.activeNodes[i];
        const dt = this.guestWallClock - node.thermal.simulatedTime;
        if (dt > 0) {
          recordIdle(node.thermal, dt);
        }
      }
    }
  }

  /**
   * Advance guest wall clock while all nodes are idle.
   * Accumulates leakage energy for all suspended nodes and updates
   * their simulated time so power/energy reporting stays accurate.
   *
   * @param dtNS - Nanoseconds to advance (e.g. from host wall-clock delta)
   */
  advanceIdleTime(dtNS: number): void {
    if (dtNS <= 0) return;
    this.guestWallClock += dtNS;
    for (let i = 0; i < NUM_NODES; i++) {
      const node = this.nodes[i];
      const dt = this.guestWallClock - node.thermal.simulatedTime;
      if (dt > 0) {
        recordIdle(node.thermal, dt);
      }
    }
  }

  /** Step until all nodes are suspended or breakpoint hit */
  stepUntilDone(maxSteps: number = 1000000): boolean {
    return this.stepProgramN(maxSteps);
  }

  /**
   * Enqueue serial bits and step the simulation until serial delivery
   * completes or maxSteps is reached.
   *
   * `bits` is an array of {value: boolean, durationNS: number} pairs
   * with relative durations. They are converted to absolute times
   * relative to guestWallClock and enqueued as EVT_SERIAL events.
   *
   * Returns true if a breakpoint was hit.
   */
  stepWithSerialBits(
    coord: number,
    bits: { value: boolean; durationNS: number }[],
    maxSteps: number = 10_000_000,
  ): boolean {
    this.enqueueSerialBits(coord, bits);
    return this.stepUntilDone(maxSteps);
  }

  onBreakpoint(): void {
    this._breakpointHit = true;
  }

  /** Called by F18ANode when an IO register write occurs.
   *  Each write is tagged with the node coordinate so the VGA display
   *  can separate R/G/B channels from DAC nodes 117/617/717 and
   *  sync signals from GPIO nodes.  Stored as (coord << 18) | value.
   *  The thermal state provides jittered timing for analog output recording. */
  onIoWrite(nodeIndex: number, value: number, thermal?: ThermalState): void {
    const coord = indexToCoord(nodeIndex);
    const tagged = coord * 0x40000 + value;  // coord << 18 | value
    // On VSYNC (node 217 pin17 driven high: bits 17:16 = 11),
    // drop everything before the previous VSYNC to keep one full frame.
    if (coord === 217 && (value & 0x30000) === 0x30000) {
      if (this.lastVsyncSeq !== null && this.lastVsyncSeq > this.ioWriteStartSeq) {
        const drop = this.lastVsyncSeq - this.ioWriteStartSeq;
        this.ioWriteStart = (this.ioWriteStart + drop) % this.ioWriteBuffer.length;
        this.ioWriteStartSeq = this.lastVsyncSeq;
      }
      this.lastVsyncSeq = this.ioWriteSeq;
    }
    this.pushIoWrite(tagged, thermal?.simulatedTime ?? 0, thermal?.lastJitteredTime ?? 0);
  }

  private pushIoWrite(value: number, simulatedTime: number, jitteredTime: number = 0): void {
    const capacity = this.ioWriteBuffer.length;
    const size = this.ioWriteSeq - this.ioWriteStartSeq;
    if (size >= capacity) {
      // Overwrite oldest entry
      this.ioWriteStart = (this.ioWriteStart + 1) % capacity;
      this.ioWriteStartSeq++;
    }
    const idx = (this.ioWriteStart + (this.ioWriteSeq - this.ioWriteStartSeq)) % capacity;
    this.ioWriteBuffer[idx] = value;
    this.ioWriteTimestamps[idx] = simulatedTime;
    this.ioWriteJitter[idx] = jitteredTime;
    this.ioWriteSeq++;
  }

  // ========================================================================
  // Loading
  // ========================================================================

  load(compiled: CompiledProgram): void {
    // Clear the event queue — non-loaded nodes (executing ROM) would
    // consume step budget without contributing to the test scenario.
    clearQueue(this.eventQueue);

    for (const nodeData of compiled.nodes) {
      const index = coordToIndex(nodeData.coord);
      if (index >= 0 && index < NUM_NODES) {
        this.nodes[index].load(nodeData);
        // node.load() calls fetchI(); enqueue the node so it participates
        enqueue(this.eventQueue, this.nodes[index].thermal.simulatedTime, EVT_NODE, index);
      }
    }
  }

  /** Inter-stream gap in ns when appending serial bits. */
  private static readonly SERIAL_GAP_NS = 1_000_000; // 1 ms gap between streams to ensure clear separation

  /**
   * Append serial bits and enqueue the first new edge event if no serial
   * event is currently in-flight. Can be called multiple times to extend
   * an ongoing serial stream.
   *
   * Bit durations are relative (each is the hold time for that bit value).
   * When appending to an existing stream, the new bits are time-shifted to
   * start after the last existing bit's end time + a gap.
   */
  enqueueSerialBits(
    coord: number,
    bits: SerialBit[],
  ): void {
    if (bits.length === 0) return;
    this.serialNode = this.getNodeByCoord(coord);

    const baseIdx = this.serialBitValues.length;

    // Start time: after the last bit ends (+ gap), or guestWallClock,
    // whichever is later. This ensures new bits are always scheduled in
    // the future even if called long after the previous stream ended.
    let absTime = Math.max(this.serialEndTime, this.guestWallClock) + GA144.SERIAL_GAP_NS;

    // Append values and pre-compute absolute times
    for (let i = 0; i < bits.length; i++) {
      this.serialBitValues.push(bits[i].value);
      this.serialBitTimes.push(absTime);
      absTime += bits[i].durationNS;
    }
    this.serialEndTime = absTime;

    // Enqueue first new bit only if no serial event is already in-flight.
    // If a chain is running (serialBitIndex < baseIdx), it will naturally
    // reach the appended bits via the bitIdx+1 chain in the handler.
    if (this.serialBitIndex >= baseIdx) {
      enqueue(this.eventQueue, this.serialBitTimes[baseIdx], EVT_SERIAL, baseIdx);
    }
  }

  /** Returns true if serial boot stream is still being delivered. */
  isBooting(): boolean {
    return this.serialNode !== null;
  }

  /**
   * Send bytes as serial input to node 708 at boot baud rate.
   * Appends to any in-flight serial stream (boot or prior input).
   */
  sendSerialInput(bytes: number[]): void {
    if (bytes.length === 0) return;
    const bits = SerialBits.buildBits(bytes, GA144.BOOT_BAUD);
    this.enqueueSerialBits(708, bits);
  }

  // ========================================================================
  // Reset
  // ========================================================================

  reset(): void {
    this.totalSteps = 0;
    this.guestWallClock = 0;
    this._breakpointHit = false;
    this.eventsSinceIdleSweep = 0;
    this.ioWriteStart = 0;
    this.ioWriteStartSeq = 0;
    this.ioWriteSeq = 0;
    this.ioWriteJitter = new Float32Array(GA144.IO_WRITE_CAPACITY);
    this.lastVsyncSeq = null;
    this.lastActiveIndex = NUM_NODES - 1;

    // Clear the event queue
    clearQueue(this.eventQueue);

    for (let i = 0; i < NUM_NODES; i++) {
      this.activeNodes[i] = this.nodes[i];
      this.nodes[i].activeIndex = i;
    }

    for (const node of this.nodes) {
      const coord = node.getCoord();
      node.reset(this.romData[coord]);
    }

    // Re-wire VCO counters after node reset (setupPorts() clears them)
    if (this.vcoCounters) {
      for (let i = 0; i < ANALOG_NODES.length; i++) {
        this.getNodeByCoord(ANALOG_NODES[i]).setVcoCounter(this.vcoCounters, i);
      }
    }

    // After reset, trigger initial fetch for all nodes
    for (const node of this.nodes) {
      node.fetchI();
    }

    // Enqueue all 144 nodes at simulatedTime=0 (with collision nudging)
    for (let i = 0; i < NUM_NODES; i++) {
      enqueue(this.eventQueue, this.nodes[i].thermal.simulatedTime, EVT_NODE, i);
    }

    // Clear serial state
    this.serialBitValues = [];
    this.serialBitTimes = [];
    this.serialEndTime = 0;
    this.serialBitIndex = 0;
    this.serialNode = null;
  }

  // ========================================================================
  // Queries
  // ========================================================================

  getNodeByCoord(coord: number): F18ANode {
    return this.nodes[coordToIndex(coord)];
  }

  getNodeByIndex(index: number): F18ANode {
    return this.nodes[index];
  }

  getActiveCount(): number {
    return this.lastActiveIndex + 1;
  }

  getTotalSteps(): number {
    return this.totalSteps;
  }

  // ========================================================================
  // Snapshots for React UI
  // ========================================================================

  /** Extract IO writes since a given sequence number (for delta transfer). */
  getIoWritesDelta(sinceSeq: number): IoWriteDelta {
    const from = Math.max(sinceSeq, this.ioWriteStartSeq);
    const count = this.ioWriteSeq - from;
    if (count <= 0) {
      return { writes: [], timestamps: [], startSeq: from, totalSeq: this.ioWriteSeq };
    }
    const writes = new Array(count);
    const timestamps = new Array(count);
    for (let i = 0; i < count; i++) {
      const offset = from - this.ioWriteStartSeq + i;
      const idx = (this.ioWriteStart + offset) % this.ioWriteBuffer.length;
      writes[i] = this.ioWriteBuffer[idx];
      timestamps[i] = this.ioWriteTimestamps[idx];
    }
    return { writes, timestamps, startSeq: from, totalSeq: this.ioWriteSeq };
  }

  getSnapshot(selectedCoord?: number): GA144Snapshot {
    const states: NodeState[] = new Array(NUM_NODES);
    const coords: number[] = new Array(NUM_NODES);

    let totalEnergyPJ = 0;
    for (let i = 0; i < NUM_NODES; i++) {
      states[i] = this.nodes[i].getState();
      coords[i] = this.nodes[i].getCoord();
      totalEnergyPJ += this.nodes[i].thermal.totalEnergy;
    }
    // Instantaneous power estimate: active nodes at typical power, idle at leakage
    const active = this.lastActiveIndex + 1;
    const idle = NUM_NODES - active;
    const chipPowerMW = active * 4.5 + idle * 100e-6; // 4.5 mW active, 100 nW idle

    let selectedNode = null;
    if (selectedCoord !== undefined) {
      const idx = coordToIndex(selectedCoord);
      if (idx >= 0 && idx < NUM_NODES) {
        selectedNode = this.nodes[idx].getSnapshot();
      }
    }

    return {
      nodeStates: states,
      nodeCoords: coords,
      activeCount: active,
      totalSteps: this.totalSteps,
      selectedNode,
      ioWrites: this.ioWriteBuffer,
      ioWriteTimestamps: this.ioWriteTimestamps,
      ioWriteJitter: this.ioWriteJitter,
      ioWriteStart: this.ioWriteStart,
      ioWriteCount: this.ioWriteSeq - this.ioWriteStartSeq,
      ioWriteSeq: this.ioWriteSeq,
      totalEnergyPJ,
      chipPowerMW,
      totalSimTimeNS: this.guestWallClock,
    };
  }
}
