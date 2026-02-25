/**
 * VCO Clock Manager — spawns a single SharedArrayBuffer-backed clock worker
 * that updates all 5 analog node VCO counters. Falls back gracefully when
 * SAB is unavailable.
 *
 * SAB layout (151 × Uint32 = 604 bytes):
 *   Slots 0-4:    VCO counters (18-bit, written by clock worker)
 *   Slots 5-148:  Thermal temperatures (scaled ×1000, written by emulator worker)
 *                 Index = THERMAL_OFFSET + linearNodeIndex (0-143)
 *   Slots 149-150: Guest wall clock (nanoseconds as lo/hi Uint32, written by emulator)
 */
import { ANALOG_NODES } from '../core/constants';

/** Offset into the Uint32Array where thermal temperature slots begin. */
export const THERMAL_OFFSET = ANALOG_NODES.length;

/** Offset for guest wall clock (64-bit ns as two Uint32 words). */
export const GUEST_CLOCK_OFFSET = THERMAL_OFFSET + 144;

/** Total number of Uint32 slots in the SAB. */
export const SAB_SLOT_COUNT = GUEST_CLOCK_OFFSET + 2;

export interface VcoClockState {
  sab: SharedArrayBuffer;
  counters: Uint32Array;
  workers: Worker[];
}

/**
 * Create a single VCO clock worker backed by SharedArrayBuffer.
 * Returns null if SharedArrayBuffer is unavailable (no COOP/COEP headers).
 */
export function createVcoClocks(): VcoClockState | null {
  if (typeof SharedArrayBuffer === 'undefined') return null;
  if (typeof self !== 'undefined' && 'crossOriginIsolated' in self && !self.crossOriginIsolated) {
    return null;
  }

  const sab = new SharedArrayBuffer(SAB_SLOT_COUNT * 4);
  const counters = new Uint32Array(sab);

  const w = new Worker(
    new URL('./vcoClockWorker.ts', import.meta.url),
    { type: 'module' },
  );
  w.postMessage({
    sab,
    analogNodes: ANALOG_NODES.map((coord, slotIndex) => ({ slotIndex, coord })),
  });

  return { sab, counters, workers: [w] };
}

/** Terminate VCO clock worker. */
export function destroyVcoClocks(state: VcoClockState): void {
  for (const w of state.workers) {
    w.terminate();
  }
}
