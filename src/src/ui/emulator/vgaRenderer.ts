/**
 * Pure VGA frame renderer — extracts the pixel rendering logic from VgaDisplay
 * into a testable function with no React/WebGL dependencies.
 */
import { VGA_NODE_R, VGA_NODE_G, VGA_NODE_B } from '../../core/constants';
import {
  readIoWrite,
  readIoTimestamp,
  taggedCoord,
  taggedValue,
  decodeDac,
  isHsync,
  isVsync,
} from './vgaResolution';

// ---- Precomputed 9-bit DAC → 8-bit channel lookup (512 entries) ----
export const DAC_TO_8BIT = new Uint8Array(512);
for (let i = 0; i < 512; i++) {
  DAC_TO_8BIT[i] = (i * 255 / 511) | 0;
}

/** Mutable state carried across incremental render calls. */
export interface VgaRenderState {
  cursor: { x: number; y: number };
  hasReceivedSignal: boolean;
  lastDrawnSeq: number;
  forceFullRedraw: boolean;
  lastHasSyncSignals: boolean | null;
  /** Accumulated channel values for current pixel (persisted across incremental calls) */
  pendingR: number;
  pendingG: number;
  pendingB: number;
  hasR: boolean;
  hasG: boolean;
  hasB: boolean;
}

export function createRenderState(): VgaRenderState {
  return {
    cursor: { x: 0, y: 0 },
    hasReceivedSignal: false,
    lastDrawnSeq: 0,
    forceFullRedraw: false,
    lastHasSyncSignals: null,
    pendingR: 0,
    pendingG: 0,
    pendingB: 0,
    hasR: false,
    hasG: false,
    hasB: false,
  };
}

export function fillNoise(data: Uint8Array): void {
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = (Math.random() * 256) | 0;
    data[i + 1] = (Math.random() * 256) | 0;
    data[i + 2] = (Math.random() * 256) | 0;
    data[i + 3] = 255;
  }
}

export function clearToBlack(data: Uint8Array): void {
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
    data[i + 3] = 255;
  }
}

/**
 * Render IO writes into an RGBA texture buffer.
 * This is the core rendering logic extracted from VgaDisplay's useEffect.
 *
 * When timestamps are provided, HSYNC deferral uses timestamp comparison:
 * if an R write has the same timestamp as the HSYNC, they happened in the
 * same global step, so the R write belongs to the line before the HSYNC.
 * Without timestamps, falls back to immediate HSYNC with cursor.x > 0 guard.
 *
 * Returns true if the texture was modified (dirty).
 */
export function renderIoWrites(
  state: VgaRenderState,
  texData: Uint8Array,
  texW: number,
  texH: number,
  ioWrites: number[],
  ioWriteCount: number,
  ioWriteStart: number,
  ioWriteSeq: number,
  hasSyncSignals: boolean,
  ioWriteTimestamps?: number[],
): boolean {
  if (ioWriteCount === 0) return false;

  const cursor = state.cursor;
  const startSeq = ioWriteSeq - ioWriteCount;
  const streamReset = ioWriteSeq < state.lastDrawnSeq;
  const dataDropped = state.lastDrawnSeq < startSeq;
  const syncChanged = state.lastHasSyncSignals !== null && state.lastHasSyncSignals !== hasSyncSignals;
  state.lastHasSyncSignals = hasSyncSignals;
  const needsFullRedraw = state.forceFullRedraw || streamReset || dataDropped || syncChanged;

  let seq = needsFullRedraw ? startSeq : state.lastDrawnSeq;
  if (needsFullRedraw) {
    cursor.x = 0;
    cursor.y = 0;
    state.forceFullRedraw = false;
    state.pendingR = 0; state.pendingG = 0; state.pendingB = 0;
    state.hasR = false; state.hasG = false; state.hasB = false;
    if (streamReset) {
      state.hasReceivedSignal = false;
      fillNoise(texData);
    } else if (state.hasReceivedSignal) {
      // Only clear to black if there is subsequent pixel data
      let hasSubsequentDacWrite = false;
      for (let lookSeq = seq + 1; lookSeq < ioWriteSeq; lookSeq++) {
        const lookOffset = lookSeq - startSeq;
        if (lookOffset < 0 || lookOffset >= ioWriteCount) continue;
        const lookTagged = readIoWrite(ioWrites, ioWriteStart, lookOffset);
        const lookCoord = taggedCoord(lookTagged);
        if (
          lookCoord === VGA_NODE_R ||
          lookCoord === VGA_NODE_G ||
          lookCoord === VGA_NODE_B
        ) {
          hasSubsequentDacWrite = true;
          break;
        }
      }
      if (hasSubsequentDacWrite) {
        clearToBlack(texData);
      }
    }
  }

  // Accumulate R/G/B from the 3 DAC nodes.
  // Track which channels have been received for the current pixel.
  // Emit the pixel when all three channels have arrived, regardless of order.
  // These are persisted in state for incremental rendering.
  let { pendingR, pendingG, pendingB, hasR, hasG, hasB } = state;
  // Timestamp-based HSYNC deferral: when HSYNC arrives, we record its
  // timestamp and defer the line break. On the next pixel emit, if the
  // last DAC write shares the same timestamp as the HSYNC, the pixel
  // belongs to the current line (they were produced in the same global step).
  // Otherwise the HSYNC is a real line boundary.
  let pendingHsyncTs = -1; // timestamp of deferred HSYNC (-1 = none)

  for (; seq < ioWriteSeq; seq++) {
    const offset = seq - startSeq;
    if (offset < 0 || offset >= ioWriteCount) continue;
    const tagged = readIoWrite(ioWrites, ioWriteStart, offset);
    const coord = taggedCoord(tagged);
    const val = taggedValue(tagged);

    if (hasSyncSignals) {
      if (isVsync(tagged)) {
        cursor.y = 0; cursor.x = 0;
        pendingHsyncTs = -1;
        hasR = false; hasG = false; hasB = false;
        continue;
      }
      if (isHsync(tagged)) {
        if (ioWriteTimestamps) {
          // Defer — we'll resolve when we see the next pixel emit
          pendingHsyncTs = readIoTimestamp(ioWriteTimestamps, ioWriteStart, offset);
        } else if (cursor.x > 0) {
          // No timestamps available — immediate HSYNC
          cursor.y++; cursor.x = 0;
        }
        continue;
      }
    }

    // DAC channel writes — decode XOR encoding and accumulate
    if (coord === VGA_NODE_R) {
      if (!state.hasReceivedSignal) {
        state.hasReceivedSignal = true;
        clearToBlack(texData);
      }
      pendingR = DAC_TO_8BIT[decodeDac(val)];
      hasR = true;
    } else if (coord === VGA_NODE_G) {
      pendingG = DAC_TO_8BIT[decodeDac(val)];
      hasG = true;
    } else if (coord === VGA_NODE_B) {
      pendingB = DAC_TO_8BIT[decodeDac(val)];
      hasB = true;
    } else {
      continue;
    }

    // Emit pixel when all three channels have arrived
    if (hasR && hasG && hasB) {
      // Resolve deferred HSYNC using timestamps
      if (pendingHsyncTs >= 0 && ioWriteTimestamps) {
        const dacTs = readIoTimestamp(ioWriteTimestamps, ioWriteStart, offset);
        if (dacTs === pendingHsyncTs) {
          // Same step — pixel belongs to the line before HSYNC.
          // Emit pixel on current line, then advance.
          if (cursor.y < texH && cursor.x < texW) {
            const texOff = (cursor.y * texW + cursor.x) * 4;
            texData[texOff]     = pendingR;
            texData[texOff + 1] = pendingG;
            texData[texOff + 2] = pendingB;
            texData[texOff + 3] = 255;
          }
          cursor.x++;
          cursor.y++; cursor.x = 0;
          pendingHsyncTs = -1;
          hasR = false; hasG = false; hasB = false;
          continue;
        } else {
          // Different step — HSYNC precedes this pixel.
          // Apply line break first, then emit pixel on new line.
          if (cursor.x > 0) { cursor.y++; cursor.x = 0; }
          pendingHsyncTs = -1;
        }
      }

      if (cursor.y < texH && cursor.x < texW) {
        const texOff = (cursor.y * texW + cursor.x) * 4;
        texData[texOff]     = pendingR;
        texData[texOff + 1] = pendingG;
        texData[texOff + 2] = pendingB;
        texData[texOff + 3] = 255;
      }
      cursor.x++;
      if (!hasSyncSignals && cursor.x >= texW) { cursor.x = 0; cursor.y++; }
      hasR = false; hasG = false; hasB = false;
    }
  }

  // Persist channel accumulation state for next incremental call
  state.pendingR = pendingR;
  state.pendingG = pendingG;
  state.pendingB = pendingB;
  state.hasR = hasR;
  state.hasG = hasG;
  state.hasB = hasB;

  state.lastDrawnSeq = ioWriteSeq;
  return true;
}
