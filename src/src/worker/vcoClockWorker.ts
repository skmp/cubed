/**
 * VCO Clock Worker — free-running 18-bit counter for one analog node.
 *
 * Receives { sab, slotIndex, coord } on init. Writes an 18-bit counter
 * derived from wall-clock time into its SharedArrayBuffer slot at ~1 kHz.
 * The node-specific phase offset is baked in; thermal jitter is added
 * on the read side in f18a.ts.
 */

interface VcoClockInit {
  sab: SharedArrayBuffer;
  slotIndex: number;
  coord: number;
}

const VCO_TICKS_PER_MS = 3_000_000; // ~3 GHz nominal VCO frequency
const WRAP_PERIOD_MS = 0x40000 / VCO_TICKS_PER_MS; // ~0.0874 ms per 18-bit wrap

self.onmessage = (e: MessageEvent<VcoClockInit>) => {
  const { sab, slotIndex, coord } = e.data;
  const counters = new Uint32Array(sab);
  const nodeOffset = (coord * 40499 + 112771) & 0x3FFFF;

  const tick = () => {
    const nowMs = performance.now();
    const phase = (nowMs % (WRAP_PERIOD_MS * 256)) / WRAP_PERIOD_MS;
    const baseTicks = Math.floor(phase * 0x40000) & 0x3FFFF;
    Atomics.store(counters, slotIndex, (baseTicks + nodeOffset) & 0x3FFFF);
  };

  setInterval(tick, 1);
  tick();
};
