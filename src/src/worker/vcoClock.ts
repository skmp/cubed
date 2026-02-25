/**
 * VCO Clock Manager — spawns a single SharedArrayBuffer-backed clock worker
 * that updates all 5 analog node VCO counters.
 *
 * SAB layout (150 × Uint32 = 600 bytes):
 *   Slots 0-4:    VCO counters (18-bit, written by clock worker)
 *   Slots 5-148:  Thermal temperatures (scaled ×1000, written by emulator worker)
 *                 Index = THERMAL_OFFSET + linearNodeIndex (0-143)
 *   Slot 149:     Control flag (0 = run, non-zero = exit; written by main thread)
 */
import { ANALOG_NODES } from '../core/constants';

/** Offset into the Uint32Array where thermal temperature slots begin. */
export const THERMAL_OFFSET = ANALOG_NODES.length;

/** Offset for the control flag (0 = run, non-zero = exit). */
export const CONTROL_OFFSET = THERMAL_OFFSET + 144;

/** Total number of Uint32 slots in the SAB. */
export const SAB_SLOT_COUNT = CONTROL_OFFSET + 1;

export interface VcoClockState {
  sab: SharedArrayBuffer;
  counters: Uint32Array;
  workers: Worker[];
}

/**
 * Create a single VCO clock worker backed by SharedArrayBuffer.
 * Requires cross-origin isolation (COOP/COEP headers).
 */
export function createVcoClocks(): VcoClockState {
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

/** Signal VCO clock worker to exit and terminate. */
export function destroyVcoClocks(state: VcoClockState): void {
  Atomics.store(state.counters, CONTROL_OFFSET, 1);
  for (const w of state.workers) {
    w.terminate();
  }
}
