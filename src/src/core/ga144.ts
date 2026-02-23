/**
 * GA144 chip controller - manages 144 F18A nodes.
 * Port of reference/ga144/src/ga144.rkt
 */
import { F18ANode } from './f18a';
import { NUM_NODES, coordToIndex, indexToCoord } from './constants';
import { NodeState } from './types';
import type { GA144Snapshot, CompiledProgram } from './types';
import type { ThermalState } from './thermal';

export class GA144 {
  readonly name: string;
  private nodes: F18ANode[];
  private activeNodes: F18ANode[];
  private lastActiveIndex: number = NUM_NODES - 1;
  private totalSteps = 0;
  private _breakpointHit = false;

  // IO write capture for VGA display — ring buffer of recent writes
  private static readonly IO_WRITE_CAPACITY = 2_000_000;
  private ioWriteBuffer: number[] = new Array(GA144.IO_WRITE_CAPACITY);
  private ioWriteTimestamps: number[] = new Array(GA144.IO_WRITE_CAPACITY);
  private ioWriteJitter: Float32Array = new Float32Array(GA144.IO_WRITE_CAPACITY);
  private ioWriteStart = 0;     // ring start index
  private ioWriteStartSeq = 0;  // sequence number at ring start
  private ioWriteSeq = 0;       // next sequence number to write
  private lastVsyncSeq: number | null = null;
  private loadedNodes: Set<number> = new Set();

  // ROM data loaded externally
  private romData: Record<number, number[]> = {};

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
  // Stepping
  // ========================================================================

  /** Step all active nodes once. Returns true if breakpoint hit. */
  stepProgram(): boolean {
    this._breakpointHit = false;
    this.totalSteps++;

    for (let i = this.lastActiveIndex; i >= 0; i--) {
      this.activeNodes[i].stepProgram();
    }

    return this._breakpointHit;
  }

  /** Step N times. Returns true if breakpoint hit. */
  stepProgramN(n: number): boolean {
    for (let i = 0; i < n; i++) {
      if (this.stepProgram()) return true;
    }
    return false;
  }

  /** Step until all nodes are suspended or breakpoint hit */
  stepUntilDone(maxSteps: number = 1000000): boolean {
    for (let i = 0; i < maxSteps; i++) {
      if (this.stepProgram()) return true;
      if (this.lastActiveIndex < 0) return false; // all suspended
    }
    return false;
  }

  /**
   * Step the simulation while driving pin17 of a given node according to
   * a UART serial stream.
   *
   * `bits` is an array of {value: boolean, duration: number} pairs where
   * duration is measured in GA144 step ticks.  Pin17 is set to each value for
   * `duration` ticks, then the next entry is used.  After all bits are sent
   * pin17 is left at idle (true = mark).
   *
   * Returns true if a breakpoint was hit.
   */
  stepWithSerialBits(
    coord: number,
    bits: { value: boolean; duration: number }[],
    maxSteps: number = 10_000_000,
  ): boolean {
    const node = this.getNodeByCoord(coord);
    let bitIdx = 0;
    let remaining = bits.length > 0 ? bits[0].duration : 0;

    for (let step = 0; step < maxSteps; step++) {
      // Update pin17 from current bit
      if (bitIdx < bits.length) {
        node.setPin17(bits[bitIdx].value);
        remaining--;
        if (remaining <= 0) {
          bitIdx++;
          remaining = bitIdx < bits.length ? bits[bitIdx].duration : 0;
        }
      } else {
        node.setPin17(true); // idle = mark
      }

      if (this.stepProgram()) return true;
      if (this.lastActiveIndex < 0) return false;
    }
    return false;
  }

  /**
   * Build a UART 8N1 bit sequence for the given bytes and baud period (in
   * GA144 steps per bit).  Idle is high (mark), start bit is low, stop is
   * high.  Returns array suitable for stepWithSerialBits().
   *
   * The sequence starts with a configurable idle prefix so the RX node can
   * see the line idle before the start bit arrives.
   */
  static buildSerialBits(
    bytes: number[],
    baudPeriod: number,
    idlePeriod: number = 0,
  ): { value: boolean; duration: number }[] {
    const bits: { value: boolean; duration: number }[] = [];

    const push = (value: boolean, duration: number) => {
      if (bits.length > 0 && bits[bits.length - 1].value === value) {
        bits[bits.length - 1].duration += duration;
      } else {
        bits.push({ value, duration });
      }
    };

    // Lead-in idle
    if (idlePeriod > 0) push(true, idlePeriod);

    for (const byte of bytes) {
      push(false, baudPeriod); // start bit (low)
      for (let bit = 0; bit < 8; bit++) {
        push(((byte >> bit) & 1) === 1, baudPeriod); // LSB first
      }
      push(true, baudPeriod); // stop bit (high)
    }

    // Trailing idle
    push(true, baudPeriod * 2);
    return bits;
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
    if (this.loadedNodes.size === 0 || this.loadedNodes.has(nodeIndex)) {
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
      this.pushIoWrite(tagged, thermal?.lastJitteredTime ?? 0);
    }
  }

  private pushIoWrite(value: number, jitteredTime: number = 0): void {
    const capacity = this.ioWriteBuffer.length;
    const size = this.ioWriteSeq - this.ioWriteStartSeq;
    if (size >= capacity) {
      // Overwrite oldest entry
      this.ioWriteStart = (this.ioWriteStart + 1) % capacity;
      this.ioWriteStartSeq++;
    }
    const idx = (this.ioWriteStart + (this.ioWriteSeq - this.ioWriteStartSeq)) % capacity;
    this.ioWriteBuffer[idx] = value;
    this.ioWriteTimestamps[idx] = this.totalSteps;
    this.ioWriteJitter[idx] = jitteredTime;
    this.ioWriteSeq++;
  }

  // ========================================================================
  // Loading
  // ========================================================================

  load(compiled: CompiledProgram): void {
    this.loadedNodes.clear();
    for (const nodeData of compiled.nodes) {
      const index = coordToIndex(nodeData.coord);
      if (index >= 0 && index < NUM_NODES) {
        this.nodes[index].load(nodeData);
        this.loadedNodes.add(index);
      }
    }
  }

  /**
   * Load compiled nodes via boot stream processing.
   *
   * Processes the boot stream frames directly (matching the reference
   * simulator's approach), bypassing the serial protocol layer.  The boot
   * ROM's serial auto-baud and bit-banging protocol is not simulated;
   * instead, boot frame words are injected into nodes via the existing
   * load() method.
   *
   * This is equivalent to what real hardware does after the serial layer
   * decodes the boot stream: each node receives its code, register init
   * values (A, B, IO, stack), and starting P address.
   */
  static readonly BOOT_BAUD = 921_600;
  static readonly GA144_MOPS = 666_000_000;
  static readonly BOOT_BAUD_PERIOD = Math.round(GA144.GA144_MOPS / GA144.BOOT_BAUD); // ~723

  loadViaBootStream(
    compiled: CompiledProgram,
  ): void {
    this.load(compiled);
  }

  // ========================================================================
  // Reset
  // ========================================================================

  reset(): void {
    this.totalSteps = 0;
    this._breakpointHit = false;
    this.ioWriteStart = 0;
    this.ioWriteStartSeq = 0;
    this.ioWriteSeq = 0;
    this.ioWriteJitter = new Float32Array(GA144.IO_WRITE_CAPACITY);
    this.lastVsyncSeq = null;
    this.lastActiveIndex = NUM_NODES - 1;

    for (let i = 0; i < NUM_NODES; i++) {
      this.activeNodes[i] = this.nodes[i];
      this.nodes[i].activeIndex = i;
    }

    for (const node of this.nodes) {
      const coord = node.getCoord();
      node.reset(this.romData[coord]);
    }

    // After reset, trigger initial fetch for all nodes
    for (const node of this.nodes) {
      node.fetchI();
    }
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

  getSnapshot(selectedCoord?: number): GA144Snapshot {
    const states: NodeState[] = new Array(NUM_NODES);
    const coords: number[] = new Array(NUM_NODES);

    for (let i = 0; i < NUM_NODES; i++) {
      states[i] = this.nodes[i].getState();
      coords[i] = this.nodes[i].getCoord();
    }

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
      activeCount: this.lastActiveIndex + 1,
      totalSteps: this.totalSteps,
      selectedNode,
      ioWrites: this.ioWriteBuffer,
      ioWriteTimestamps: this.ioWriteTimestamps,
      ioWriteJitter: this.ioWriteJitter,
      ioWriteStart: this.ioWriteStart,
      ioWriteCount: this.ioWriteSeq - this.ioWriteStartSeq,
      ioWriteSeq: this.ioWriteSeq,
    };
  }
}
