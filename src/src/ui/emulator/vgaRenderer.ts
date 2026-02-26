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
 * Time-based sampling approach: HSYNC defines row boundaries, and each row's
 * time span is divided into `texW` equal intervals. For each pixel column,
 * R/G/B channels are independently sampled at that time — using the latest
 * value each channel had written by that point. This matches real VGA DAC
 * behavior and correctly handles channels running at different rates.
 *
 * When timestamps are unavailable, falls back to R-write-driven rendering
 * where each R write produces a pixel using the latest G/B values.
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

  const seq = needsFullRedraw ? startSeq : state.lastDrawnSeq;
  if (needsFullRedraw) {
    cursor.x = 0;
    cursor.y = 0;
    state.forceFullRedraw = false;
    if (streamReset) {
      state.hasReceivedSignal = false;
      fillNoise(texData);
    }
  }

  // Use time-based sampling when timestamps are available and sync signals present
  if (hasSyncSignals && ioWriteTimestamps) {
    return renderTimeBased(state, texData, texW, texH, ioWrites, ioWriteCount,
      ioWriteStart, ioWriteSeq, seq, ioWriteTimestamps);
  }

  // Fallback: R-write-driven rendering (no timestamps or no sync signals)
  return renderRDriven(state, texData, texW, texH, ioWrites, ioWriteCount,
    ioWriteStart, ioWriteSeq, hasSyncSignals, seq);
}

/** Time-based rendering: sample R/G/B at evenly spaced intervals within each HSYNC row. */
function renderTimeBased(
  state: VgaRenderState,
  texData: Uint8Array,
  texW: number,
  texH: number,
  ioWrites: number[],
  ioWriteCount: number,
  ioWriteStart: number,
  ioWriteSeq: number,
  seq: number,
  timestamps: number[],
): boolean {
  const startSeq = ioWriteSeq - ioWriteCount;
  const cursor = state.cursor;

  // Collect rows of timestamped channel writes between HSYNC/VSYNC boundaries.
  // Each row is: { rWrites: [ts, val][], gWrites: [ts, val][], bWrites: [ts, val][], startTs, endTs }
  interface RowData {
    rWrites: [number, number][];
    gWrites: [number, number][];
    bWrites: [number, number][];
    startTs: number;
    endTs: number;
    isAfterVsync: boolean;
  }

  const rows: RowData[] = [];
  let currentRow: RowData = { rWrites: [], gWrites: [], bWrites: [], startTs: -1, endTs: -1, isAfterVsync: false };
  let sawVsync = false;
  let pendingHsyncTs = -1;

  for (let s = seq; s < ioWriteSeq; s++) {
    const offset = s - startSeq;
    if (offset < 0 || offset >= ioWriteCount) continue;
    const tagged = readIoWrite(ioWrites, ioWriteStart, offset);
    const coord = taggedCoord(tagged);
    const val = taggedValue(tagged);
    const ts = readIoTimestamp(timestamps, ioWriteStart, offset);

    if (isVsync(tagged)) {
      // Flush current row if it has data
      if (currentRow.rWrites.length > 0 || currentRow.gWrites.length > 0 || currentRow.bWrites.length > 0) {
        currentRow.endTs = ts;
        rows.push(currentRow);
      }
      // Flush pending HSYNC
      pendingHsyncTs = -1;
      currentRow = { rWrites: [], gWrites: [], bWrites: [], startTs: -1, endTs: -1, isAfterVsync: true };
      sawVsync = true;
      continue;
    }

    if (isHsync(tagged)) {
      pendingHsyncTs = ts;
      continue;
    }

    // DAC write — check if pending HSYNC should be resolved
    if (pendingHsyncTs >= 0) {
      if (coord === VGA_NODE_R && Math.abs(ts - pendingHsyncTs) <= 10) {
        // Same step as HSYNC — R belongs to current row, then break
        const decoded = DAC_TO_8BIT[decodeDac(val)];
        if (currentRow.startTs < 0) currentRow.startTs = ts;
        currentRow.rWrites.push([ts, decoded]);
        currentRow.endTs = pendingHsyncTs;
        rows.push(currentRow);
        currentRow = { rWrites: [], gWrites: [], bWrites: [], startTs: -1, endTs: -1, isAfterVsync: false };
        pendingHsyncTs = -1;
        continue;
      } else {
        // Different step — HSYNC is a real line break
        currentRow.endTs = pendingHsyncTs;
        if (currentRow.rWrites.length > 0 || currentRow.gWrites.length > 0 || currentRow.bWrites.length > 0) {
          rows.push(currentRow);
        }
        currentRow = { rWrites: [], gWrites: [], bWrites: [], startTs: -1, endTs: -1, isAfterVsync: false };
        pendingHsyncTs = -1;
      }
    }

    const decoded = DAC_TO_8BIT[decodeDac(val)];
    if (currentRow.startTs < 0) currentRow.startTs = ts;

    if (coord === VGA_NODE_R) {
      if (!state.hasReceivedSignal) state.hasReceivedSignal = true;
      currentRow.rWrites.push([ts, decoded]);
    } else if (coord === VGA_NODE_G) {
      currentRow.gWrites.push([ts, decoded]);
    } else if (coord === VGA_NODE_B) {
      currentRow.bWrites.push([ts, decoded]);
    }
  }

  // Push final in-progress row (if any)
  if (currentRow.rWrites.length > 0 || currentRow.gWrites.length > 0 || currentRow.bWrites.length > 0) {
    // Estimate endTs from the last write
    const lastR = currentRow.rWrites.length > 0 ? currentRow.rWrites[currentRow.rWrites.length - 1][0] : 0;
    const lastG = currentRow.gWrites.length > 0 ? currentRow.gWrites[currentRow.gWrites.length - 1][0] : 0;
    const lastB = currentRow.bWrites.length > 0 ? currentRow.bWrites[currentRow.bWrites.length - 1][0] : 0;
    currentRow.endTs = Math.max(lastR, lastG, lastB);
    rows.push(currentRow);
  }

  // Render each row by time-sampling
  for (const row of rows) {
    if (row.isAfterVsync) {
      cursor.x = 0;
      cursor.y = 0;
    }

    if (row.rWrites.length === 0 && row.gWrites.length === 0 && row.bWrites.length === 0) continue;
    if (cursor.y >= texH) continue;

    const rowStart = row.startTs;
    const rowEnd = row.endTs;
    const rowDuration = rowEnd - rowStart;

    if (rowDuration <= 0) {
      // All writes in the same instant — just render them sequentially
      renderRowSequential(row.rWrites, row.gWrites, row.bWrites, texData, texW, texH, cursor);
    } else {
      // Time-sample: divide row duration into texW equal intervals
      const pixelDt = rowDuration / texW;
      let rIdx = 0, gIdx = 0, bIdx = 0;
      let curR = 0, curG = 0, curB = 0;

      for (let x = 0; x < texW; x++) {
        const sampleT = rowStart + x * pixelDt;

        // Advance R to latest write at or before sampleT
        while (rIdx < row.rWrites.length && row.rWrites[rIdx][0] <= sampleT) {
          curR = row.rWrites[rIdx][1];
          rIdx++;
        }
        // Advance G to latest write at or before sampleT
        while (gIdx < row.gWrites.length && row.gWrites[gIdx][0] <= sampleT) {
          curG = row.gWrites[gIdx][1];
          gIdx++;
        }
        // Advance B to latest write at or before sampleT
        while (bIdx < row.bWrites.length && row.bWrites[bIdx][0] <= sampleT) {
          curB = row.bWrites[bIdx][1];
          bIdx++;
        }

        if (cursor.y < texH && x < texW) {
          const texOff = (cursor.y * texW + x) * 4;
          texData[texOff]     = curR;
          texData[texOff + 1] = curG;
          texData[texOff + 2] = curB;
          texData[texOff + 3] = 255;
        }
      }
    }

    cursor.x = 0;
    cursor.y++;
  }

  state.lastDrawnSeq = ioWriteSeq;
  return true;
}

/** Render a row sequentially when all writes share the same timestamp. */
function renderRowSequential(
  rWrites: [number, number][],
  gWrites: [number, number][],
  bWrites: [number, number][],
  texData: Uint8Array,
  texW: number,
  texH: number,
  cursor: { x: number; y: number },
): void {
  // Use the longest channel array to determine pixel count
  const count = Math.max(rWrites.length, gWrites.length, bWrites.length);
  for (let i = 0; i < count && cursor.x < texW; i++) {
    const r = i < rWrites.length ? rWrites[i][1] : 0;
    const g = i < gWrites.length ? gWrites[i][1] : 0;
    const b = i < bWrites.length ? bWrites[i][1] : 0;
    if (cursor.y < texH) {
      const texOff = (cursor.y * texW + cursor.x) * 4;
      texData[texOff]     = r;
      texData[texOff + 1] = g;
      texData[texOff + 2] = b;
      texData[texOff + 3] = 255;
    }
    cursor.x++;
  }
}

/** Fallback R-write-driven rendering when timestamps are unavailable. */
function renderRDriven(
  state: VgaRenderState,
  texData: Uint8Array,
  texW: number,
  texH: number,
  ioWrites: number[],
  ioWriteCount: number,
  ioWriteStart: number,
  ioWriteSeq: number,
  hasSyncSignals: boolean,
  seq: number,
): boolean {
  const startSeq = ioWriteSeq - ioWriteCount;
  const cursor = state.cursor;
  let latestG = 0;
  let latestB = 0;
  let pendingHsync = false;

  for (let s = seq; s < ioWriteSeq; s++) {
    const offset = s - startSeq;
    if (offset < 0 || offset >= ioWriteCount) continue;
    const tagged = readIoWrite(ioWrites, ioWriteStart, offset);
    const coord = taggedCoord(tagged);
    const val = taggedValue(tagged);

    if (hasSyncSignals) {
      if (isVsync(tagged)) {
        if (pendingHsync) {
          if (cursor.x > 0) { cursor.y++; cursor.x = 0; }
          pendingHsync = false;
        }
        cursor.x = 0;
        cursor.y = 0;
        continue;
      }
      if (isHsync(tagged)) {
        pendingHsync = true;
        continue;
      }
    }

    if (coord === VGA_NODE_R) {
      if (!state.hasReceivedSignal) state.hasReceivedSignal = true;

      if (pendingHsync) {
        if (cursor.x > 0) { cursor.y++; cursor.x = 0; }
        pendingHsync = false;
      }

      const r8 = DAC_TO_8BIT[decodeDac(val)];
      if (cursor.y < texH && cursor.x < texW) {
        const texOff = (cursor.y * texW + cursor.x) * 4;
        texData[texOff]     = r8;
        texData[texOff + 1] = latestG;
        texData[texOff + 2] = latestB;
        texData[texOff + 3] = 255;
      }
      cursor.x++;
      if (!hasSyncSignals && cursor.x >= texW) { cursor.x = 0; cursor.y++; }
    } else if (coord === VGA_NODE_G) {
      latestG = DAC_TO_8BIT[decodeDac(val)];
    } else if (coord === VGA_NODE_B) {
      latestB = DAC_TO_8BIT[decodeDac(val)];
    }
  }

  if (pendingHsync) {
    if (cursor.x > 0) { cursor.y++; cursor.x = 0; }
  }

  state.lastDrawnSeq = ioWriteSeq;
  return true;
}
