/**
 * VCO Clock Worker — single worker that updates all 5 analog node VCO counters.
 *
 * Reads thermal temperatures of all 144 nodes from SAB to compute VCO values
 * that reflect both per-node and neighborhood thermal conditions (substrate
 * thermal coupling). Runs a tight loop, checking a control flag for exit.
 *
 * SAB layout:
 *   [0..4]     VCO counters (written here)
 *   [5..148]   Thermal temps × 1000 for 144 nodes (read here)
 *   [149]      Control flag (0 = run, non-zero = exit)
 */

interface AnalogNodeInit {
  slotIndex: number;
  coord: number;
}

interface VcoClockInit {
  sab: SharedArrayBuffer;
  analogNodes: AnalogNodeInit[];
}

const VCO_TICKS_PER_MS = 3_000_000; // ~3 GHz nominal VCO frequency
const WRAP_PERIOD_MS = 0x40000 / VCO_TICKS_PER_MS; // ~0.0874 ms per 18-bit wrap
const THERMAL_OFFSET = 5; // thermal slots start at index 5
const CONTROL_SLOT = THERMAL_OFFSET + 144; // = 149

/** Convert YXX coord to linear index (0-143). Inlined to avoid importing core. */
function coordToIndex(coord: number): number {
  return Math.floor(coord / 100) * 18 + (coord % 100);
}

/** Get neighbor coords for a node (up to 4, excluding out-of-bounds). */
function getNeighborIndices(coord: number): number[] {
  const row = Math.floor(coord / 100);
  const col = coord % 100;
  const indices: number[] = [];
  if (row < 7) indices.push(coordToIndex(coord + 100)); // north
  if (row > 0) indices.push(coordToIndex(coord - 100)); // south
  if (col < 17) indices.push(coordToIndex(coord + 1));  // east
  if (col > 0) indices.push(coordToIndex(coord - 1));   // west
  return indices;
}

interface PreparedNode {
  slotIndex: number;
  nodeOffset: number;
  thermalSlot: number;       // SAB index for this node's thermal temp
  neighborSlots: number[];   // SAB indices for neighbor thermal temps
}

self.onmessage = (e: MessageEvent<VcoClockInit>) => {
  const { sab, analogNodes } = e.data;
  const counters = new Uint32Array(sab);

  // Pre-compute per-node constants
  const prepared: PreparedNode[] = analogNodes.map(({ slotIndex, coord }) => ({
    slotIndex,
    nodeOffset: (coord * 40499 + 112771) & 0x3FFFF,
    thermalSlot: THERMAL_OFFSET + coordToIndex(coord),
    neighborSlots: getNeighborIndices(coord).map(i => THERMAL_OFFSET + i),
  }));

  // Tight loop — exits when control flag is set
  for (;;) {
    if (Atomics.load(counters, CONTROL_SLOT) !== 0) break;

    const nowMs = performance.now();
    const phase = (nowMs % (WRAP_PERIOD_MS * 256)) / WRAP_PERIOD_MS;
    const baseTicks = Math.floor(phase * 0x40000) & 0x3FFFF;

    for (const node of prepared) {
      // Own thermal contribution (factor 17)
      const ownTempScaled = Atomics.load(counters, node.thermalSlot);
      const thermalOffset = Math.floor((ownTempScaled / 1000) * 17) & 0x3FFFF;

      // Neighbor thermal contribution (factor 3, ~1/6th of own effect)
      let neighborSum = 0;
      for (const slot of node.neighborSlots) {
        neighborSum += Atomics.load(counters, slot);
      }
      const avgNeighborTemp = node.neighborSlots.length > 0
        ? neighborSum / (node.neighborSlots.length * 1000)
        : 0;
      const neighborEffect = Math.floor(avgNeighborTemp * 3) & 0x3FFFF;

      const value = (baseTicks + node.nodeOffset + thermalOffset + neighborEffect) & 0x3FFFF;
      Atomics.store(counters, node.slotIndex, value);
    }
  }
};
