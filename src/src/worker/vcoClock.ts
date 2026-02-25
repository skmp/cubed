/**
 * VCO Clock Manager — spawns/destroys SharedArrayBuffer-backed clock workers
 * for all 5 analog nodes. Falls back gracefully when SAB is unavailable.
 *
 * SAB layout (10 × Uint32 = 40 bytes):
 *   Slots 0-4:  VCO counters (18-bit, written by clock workers)
 *   Slots 5-9:  Thermal temperatures (scaled ×1000, written by emulator worker)
 *   Slot index N corresponds to ANALOG_NODES[N].
 */
import { ANALOG_NODES } from '../core/constants';

/** Offset into the Uint32Array where thermal temperature slots begin. */
export const THERMAL_OFFSET = ANALOG_NODES.length;

export interface VcoClockState {
  sab: SharedArrayBuffer;
  counters: Uint32Array;
  workers: Worker[];
}

/**
 * Create VCO clock workers backed by SharedArrayBuffer.
 * Returns null if SharedArrayBuffer is unavailable (no COOP/COEP headers).
 */
export function createVcoClocks(): VcoClockState | null {
  if (typeof SharedArrayBuffer === 'undefined') return null;
  if (typeof self !== 'undefined' && 'crossOriginIsolated' in self && !self.crossOriginIsolated) {
    return null;
  }

  // 5 counter slots + 5 thermal temperature slots
  const sab = new SharedArrayBuffer(ANALOG_NODES.length * 2 * 4);
  const counters = new Uint32Array(sab);

  const workers = ANALOG_NODES.map((coord, slotIndex) => {
    const w = new Worker(
      new URL('./vcoClockWorker.ts', import.meta.url),
      { type: 'module' },
    );
    w.postMessage({ sab, slotIndex, coord });
    return w;
  });

  return { sab, counters, workers };
}

/** Terminate all VCO clock workers. */
export function destroyVcoClocks(state: VcoClockState): void {
  for (const w of state.workers) {
    w.terminate();
  }
}
