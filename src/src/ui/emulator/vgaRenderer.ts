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
}

export function createRenderState(): VgaRenderState {
  return {
    cursor: { x: 0, y: 0 },
    hasReceivedSignal: false,
    lastDrawnSeq: 0,
    forceFullRedraw: false,
    lastHasSyncSignals: null,
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
 *
 * Two-pass approach for multi-channel sync:
 * 1. First pass: collect per-channel write arrays (R[], G[], B[]) ignoring sync signals
 * 2. Second pass: combine by index — pixel N = (R[N], G[N], B[N]) — and lay out rows
 *    using HSYNC/VSYNC R-count boundaries.
 *
 * This handles channels arriving in any order and at different rates, since each
 * channel's writes are indexed independently by their per-channel sequence number.
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
    if (streamReset) {
      state.hasReceivedSignal = false;
      fillNoise(texData);
    } else if (state.hasReceivedSignal) {
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

  // Pass 1: Collect all R, G, B values into per-channel arrays.
  // Also collect HSYNC/VSYNC positions (by R-write index) for row layout.
  const rVals: number[] = [];
  const gVals: number[] = [];
  const bVals: number[] = [];
  // Row boundaries: rIndex at which each HSYNC occurs
  const hsyncAtR: number[] = [];
  let vsyncAtR = -1;
  let pendingHsyncTs = -1;

  for (let s = seq; s < ioWriteSeq; s++) {
    const offset = s - startSeq;
    if (offset < 0 || offset >= ioWriteCount) continue;
    const tagged = readIoWrite(ioWrites, ioWriteStart, offset);
    const coord = taggedCoord(tagged);
    const val = taggedValue(tagged);

    if (hasSyncSignals) {
      if (isVsync(tagged)) {
        vsyncAtR = rVals.length;
        pendingHsyncTs = -1;
        continue;
      }
      if (isHsync(tagged)) {
        if (ioWriteTimestamps) {
          pendingHsyncTs = readIoTimestamp(ioWriteTimestamps, ioWriteStart, offset);
        } else {
          hsyncAtR.push(rVals.length);
        }
        continue;
      }
    }

    if (coord === VGA_NODE_R) {
      if (!state.hasReceivedSignal) {
        state.hasReceivedSignal = true;
        clearToBlack(texData);
      }
      // Resolve deferred HSYNC
      if (pendingHsyncTs >= 0 && ioWriteTimestamps) {
        const rTs = readIoTimestamp(ioWriteTimestamps, ioWriteStart, offset);
        if (rTs === pendingHsyncTs) {
          // Same step — R belongs to the line before HSYNC
          rVals.push(DAC_TO_8BIT[decodeDac(val)]);
          hsyncAtR.push(rVals.length);
          pendingHsyncTs = -1;
          continue;
        } else {
          // Different step — HSYNC was a real line break before this R
          hsyncAtR.push(rVals.length);
          pendingHsyncTs = -1;
        }
      }
      rVals.push(DAC_TO_8BIT[decodeDac(val)]);
    } else if (coord === VGA_NODE_G) {
      gVals.push(DAC_TO_8BIT[decodeDac(val)]);
    } else if (coord === VGA_NODE_B) {
      bVals.push(DAC_TO_8BIT[decodeDac(val)]);
    }
  }

  // Pass 2: Render pixels by combining R, G, B arrays by index.
  // Use HSYNC boundaries to determine row breaks.
  let rIdx = 0;
  let hsyncIdx = 0;

  // Handle VSYNC: reset cursor if present
  if (vsyncAtR >= 0 && vsyncAtR === 0) {
    cursor.x = 0;
    cursor.y = 0;
  }

  for (rIdx = 0; rIdx < rVals.length; rIdx++) {
    // Check for VSYNC at this R index
    if (vsyncAtR >= 0 && rIdx === vsyncAtR) {
      cursor.x = 0;
      cursor.y = 0;
    }

    // Check for HSYNC at this R index
    while (hsyncIdx < hsyncAtR.length && hsyncAtR[hsyncIdx] === rIdx) {
      if (cursor.x > 0) {
        cursor.y++;
        cursor.x = 0;
      }
      hsyncIdx++;
    }

    // Combine R, G, B by index
    const r = rVals[rIdx];
    const g = rIdx < gVals.length ? gVals[rIdx] : 0;
    const b = rIdx < bVals.length ? bVals[rIdx] : 0;

    if (cursor.y < texH && cursor.x < texW) {
      const texOff = (cursor.y * texW + cursor.x) * 4;
      texData[texOff]     = r;
      texData[texOff + 1] = g;
      texData[texOff + 2] = b;
      texData[texOff + 3] = 255;
    }
    cursor.x++;
    if (!hasSyncSignals && cursor.x >= texW) { cursor.x = 0; cursor.y++; }
  }

  // Handle trailing HSYNC after last pixel
  while (hsyncIdx < hsyncAtR.length && hsyncAtR[hsyncIdx] === rVals.length) {
    if (cursor.x > 0) { cursor.y++; cursor.x = 0; }
    hsyncIdx++;
  }

  state.lastDrawnSeq = ioWriteSeq;
  return true;
}
