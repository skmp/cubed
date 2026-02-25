/**
 * GA144 chip controller - manages 144 F18A nodes.
 * Port of reference/ga144/src/ga144.rkt
 */
import { F18ANode } from './f18a';
import { NUM_NODES, coordToIndex, indexToCoord } from './constants';
import { NodeState } from './types';
import type { GA144Snapshot, CompiledProgram } from './types';
import type { ThermalState } from './thermal';

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

  // ROM data loaded externally
  private romData: Record<number, number[]> = {};

  // Serial boot stream state — bits are driven into node 708's pin17
  // each step, consumed during normal stepProgram() calls.
  private serialBits: { value: boolean; duration: number }[] = [];
  private serialBitIdx = 0;
  private serialRemaining = 0;
  private serialNode: F18ANode | null = null;

  // Stored boot stream bytes for re-enqueuing serial bits on reset
  private pendingBootBytes: Uint8Array | null = null;

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

    // Drive serial boot stream into node 708's pin17
    if (this.serialNode) {
      if (this.serialBitIdx < this.serialBits.length) {
        this.serialNode.setPin17(this.serialBits[this.serialBitIdx].value);
        this.serialRemaining--;
        if (this.serialRemaining <= 0) {
          this.serialBitIdx++;
          this.serialRemaining = this.serialBitIdx < this.serialBits.length
            ? this.serialBits[this.serialBitIdx].duration : 0;
        }
      } else {
        this.serialNode.setPin17(false); // idle after all bits sent
        this.serialNode = null; // done with serial stream
        this.serialBits = [];
      }
    }

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
   * a serial bit stream with RS232 polarity (idle = LOW, start = HIGH).
   *
   * `bits` is an array of {value: boolean, duration: number} pairs where
   * duration is measured in GA144 step ticks.  Pin17 is set to each value for
   * `duration` ticks, then the next entry is used.  After all bits are sent
   * pin17 is left at idle (false = RS232 idle / mark).
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
        node.setPin17(false); // idle = RS232 mark (LOW on pin17)
      }

      if (this.stepProgram()) return true;
      if (this.lastActiveIndex < 0) return false;
    }
    return false;
  }

  /**
   * Build a serial bit sequence with RS232 polarity for GA144 async boot.
   *
   * On real hardware, the RS232 level converter inverts all levels:
   *   UART idle (mark/HIGH) → RS232 -12V → pin17 LOW
   *   UART start (space/LOW) → RS232 +12V → pin17 HIGH
   *   UART data 0 (space) → pin17 HIGH
   *   UART data 1 (mark) → pin17 LOW
   *   UART stop (mark/HIGH) → pin17 LOW
   *
   * The bytes are already XOR'd with 0xFF by encodeAsyncBytes (host-side
   * inversion per BOOT-02 spec).  The RS232 inversion here cancels with
   * the host XOR, so the F18A reads data bits "high true."
   *
   * The first byte of each word has a calibration pattern (0x2D in the low
   * 6 bits) that produces the sequence 1101101 on pin17 (start + 6 bits),
   * enabling auto-baud detection via a double-wide HIGH pulse.
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

    // Lead-in idle (RS232 idle = LOW on pin17)
    if (idlePeriod > 0) push(false, idlePeriod);

    for (const byte of bytes) {
      // RS232 inverts all levels compared to standard UART
      push(true, baudPeriod); // start bit: HIGH on pin17
      for (let bit = 0; bit < 8; bit++) {
        // Invert each data bit (RS232 inversion)
        push(((byte >> bit) & 1) === 0, baudPeriod); // LSB first, inverted
      }
      push(false, baudPeriod); // stop bit: LOW on pin17
    }

    // Trailing idle (RS232 idle = LOW)
    push(false, baudPeriod * 2);
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
    for (const nodeData of compiled.nodes) {
      const index = coordToIndex(nodeData.coord);
      if (index >= 0 && index < NUM_NODES) {
        this.nodes[index].load(nodeData);
      }
    }
  }

  /**
   * Load compiled nodes via the real serial boot path.
   *
   * Builds a boot stream from compiled nodes, converts it to serial bits,
   * and drives them into node 708's pin17.  The boot ROM receives the
   * serial data, decodes it, and relays code across the mesh to all
   * target nodes — exactly as real GA144 hardware boots.
   *
   * Serial bits are enqueued and consumed during normal stepProgram()
   * calls — boot and program execution happen naturally together,
   * exactly as on real hardware.
   */
  static readonly BOOT_BAUD = 921_600;
  static readonly GA144_MOPS = 666_000_000;
  static readonly BOOT_BAUD_PERIOD = Math.round(GA144.GA144_MOPS / GA144.BOOT_BAUD); // ~723

  /**
   * Load a boot stream for serial delivery to node 708.
   * The bytes are converted to serial bits and driven into pin17.
   * Stored for re-enqueuing on each reset().
   */
  loadViaBootStream(bytes: Uint8Array): void {
    if (bytes.length === 0) return;

    this.pendingBootBytes = bytes;
    this.enqueueBootStream(bytes);

    // Reset step counter and IO buffer for clean starting state
    this.totalSteps = 0;
    this.ioWriteStart = 0;
    this.ioWriteStartSeq = 0;
    this.ioWriteSeq = 0;
    this.lastVsyncSeq = null;
  }

  /** Enqueue serial bits from raw boot stream bytes into node 708's pin17. */
  private enqueueBootStream(bytes: Uint8Array): void {
    this.serialBits = GA144.buildSerialBits(
      Array.from(bytes),
      GA144.BOOT_BAUD_PERIOD,
      GA144.BOOT_BAUD_PERIOD * 10, // idle lead-in for auto-baud detection
    );
    this.serialBitIdx = 0;
    this.serialRemaining = this.serialBits.length > 0 ? this.serialBits[0].duration : 0;
    this.serialNode = this.getNodeByCoord(708);
  }

  /** Returns true if serial boot stream is still being delivered. */
  isBooting(): boolean {
    return this.serialNode !== null;
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

    // Re-enqueue serial boot stream if boot bytes were loaded
    if (this.pendingBootBytes) {
      this.enqueueBootStream(this.pendingBootBytes);
    } else {
      this.serialBits = [];
      this.serialBitIdx = 0;
      this.serialRemaining = 0;
      this.serialNode = null;
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
