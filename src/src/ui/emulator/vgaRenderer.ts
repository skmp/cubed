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

// Maximum pixels per row for per-channel indexing buffers
const MAX_ROW_WIDTH = 1024;

/** Mutable state carried across incremental render calls. */
export interface VgaRenderState {
  cursor: { x: number; y: number };
  hasReceivedSignal: boolean;
  lastDrawnSeq: number;
  forceFullRedraw: boolean;
  lastHasSyncSignals: boolean | null;
  /** Last-seen channel values (fallback when buffer index is out of range) */
  pendingR: number;
  pendingG: number;
  pendingB: number;
  /** Per-row channel write counts */
  channelRowR: number;
  channelRowG: number;
  channelRowB: number;
  /** Pixels already emitted for current row */
  channelEmitted: number;
  /** Per-row indexed buffers for R, G, B channel values */
  channelRBuf: Uint8Array;
  channelGBuf: Uint8Array;
  channelBBuf: Uint8Array;
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
    channelRowR: 0,
    channelRowG: 0,
    channelRowB: 0,
    channelEmitted: 0,
    channelRBuf: new Uint8Array(MAX_ROW_WIDTH),
    channelGBuf: new Uint8Array(MAX_ROW_WIDTH),
    channelBBuf: new Uint8Array(MAX_ROW_WIDTH),
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
    state.channelRowR = 0; state.channelRowG = 0; state.channelRowB = 0;
    state.channelEmitted = 0;
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

  // Per-channel indexing: R, G, B relays may produce writes at different rates.
  // G and B can run ahead of R due to R's sync signal overhead, or R can arrive
  // first in the initial row. We buffer all three channels by index and emit
  // pixels when the minimum of all three counts advances.
  let { pendingR, pendingG, pendingB } = state;
  let rCount = state.channelRowR;
  let gCount = state.channelRowG;
  let bCount = state.channelRowB;
  const rBuf = state.channelRBuf;
  const gBuf = state.channelGBuf;
  const bBuf = state.channelBBuf;
  let emitted = state.channelEmitted; // pixels already emitted for current row
  let pendingHsyncTs = -1;

  /** Emit all pixels where we have all three channel values */
  const flushPixels = () => {
    const ready = Math.min(rCount, gCount, bCount);
    while (emitted < ready) {
      if (cursor.y < texH && cursor.x < texW) {
        const texOff = (cursor.y * texW + cursor.x) * 4;
        texData[texOff]     = emitted < rBuf.length ? rBuf[emitted] : 0;
        texData[texOff + 1] = emitted < gBuf.length ? gBuf[emitted] : 0;
        texData[texOff + 2] = emitted < bBuf.length ? bBuf[emitted] : 0;
        texData[texOff + 3] = 255;
      }
      cursor.x++;
      emitted++;
      if (!hasSyncSignals && cursor.x >= texW) { cursor.x = 0; cursor.y++; }
    }
  };

  for (; seq < ioWriteSeq; seq++) {
    const offset = seq - startSeq;
    if (offset < 0 || offset >= ioWriteCount) continue;
    const tagged = readIoWrite(ioWrites, ioWriteStart, offset);
    const coord = taggedCoord(tagged);
    const val = taggedValue(tagged);

    if (hasSyncSignals) {
      if (isVsync(tagged)) {
        flushPixels();
        cursor.y = 0; cursor.x = 0;
        pendingHsyncTs = -1;
        rCount = 0; gCount = 0; bCount = 0; emitted = 0;
        continue;
      }
      if (isHsync(tagged)) {
        if (ioWriteTimestamps) {
          pendingHsyncTs = readIoTimestamp(ioWriteTimestamps, ioWriteStart, offset);
        } else {
          flushPixels();
          if (cursor.x > 0) { cursor.y++; cursor.x = 0; }
          rCount = 0; gCount = 0; bCount = 0; emitted = 0;
        }
        continue;
      }
    }

    // DAC channel writes — decode and buffer by per-channel index
    if (coord === VGA_NODE_R) {
      if (!state.hasReceivedSignal) {
        state.hasReceivedSignal = true;
        clearToBlack(texData);
      }

      // Resolve deferred HSYNC before processing this R write
      if (pendingHsyncTs >= 0 && ioWriteTimestamps) {
        const rTs = readIoTimestamp(ioWriteTimestamps, ioWriteStart, offset);
        if (rTs === pendingHsyncTs) {
          // Same step — this R belongs to the line before HSYNC.
          // Buffer the R, flush, then advance line.
          if (rCount < rBuf.length) rBuf[rCount] = DAC_TO_8BIT[decodeDac(val)];
          rCount++;
          flushPixels();
          cursor.y++; cursor.x = 0;
          rCount = 0; gCount = 0; bCount = 0; emitted = 0;
          pendingHsyncTs = -1;
          continue;
        } else {
          // Different step — HSYNC precedes this R write.
          flushPixels();
          if (cursor.x > 0) { cursor.y++; cursor.x = 0; }
          rCount = 0; gCount = 0; bCount = 0; emitted = 0;
          pendingHsyncTs = -1;
        }
      }

      if (rCount < rBuf.length) rBuf[rCount] = DAC_TO_8BIT[decodeDac(val)];
      rCount++;
    } else if (coord === VGA_NODE_G) {
      if (gCount < gBuf.length) gBuf[gCount] = DAC_TO_8BIT[decodeDac(val)];
      gCount++;
    } else if (coord === VGA_NODE_B) {
      if (bCount < bBuf.length) bBuf[bCount] = DAC_TO_8BIT[decodeDac(val)];
      bCount++;
    } else {
      continue;
    }

    // Try to emit completed pixels
    flushPixels();
  }

  // Persist state for next incremental call
  state.pendingR = pendingR;
  state.pendingG = pendingG;
  state.pendingB = pendingB;
  state.channelRowR = rCount;
  state.channelRowG = gCount;
  state.channelRowB = bCount;
  state.channelEmitted = emitted;

  state.lastDrawnSeq = ioWriteSeq;
  return true;
}
