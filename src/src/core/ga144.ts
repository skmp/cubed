/**
 * GA144 chip controller - manages 144 F18A nodes.
 * Port of reference/ga144/src/ga144.rkt
 */
import { F18ANode } from './f18a';
import { NUM_NODES, coordToIndex } from './constants';
import { NodeState } from './types';
import type { GA144Snapshot, CompiledProgram } from './types';

export class GA144 {
  readonly name: string;
  private nodes: F18ANode[];
  private activeNodes: F18ANode[];
  private lastActiveIndex: number = NUM_NODES - 1;
  private totalSteps = 0;
  private _breakpointHit = false;

  // IO write capture for VGA display
  private ioWriteBuffer: number[] = [];
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

  onBreakpoint(_node: F18ANode): void {
    this._breakpointHit = true;
  }

  /** Called by F18ANode when an IO register write occurs (VGA DAC output) */
  onIoWrite(nodeIndex: number, value: number): void {
    if (this.loadedNodes.size === 0 || this.loadedNodes.has(nodeIndex)) {
      this.ioWriteBuffer.push(value);
    }
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

  // ========================================================================
  // Reset
  // ========================================================================

  reset(): void {
    this.totalSteps = 0;
    this._breakpointHit = false;
    this.ioWriteBuffer = [];
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
      ioWriteCount: this.ioWriteBuffer.length,
    };
  }
}
