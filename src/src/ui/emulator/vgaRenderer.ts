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
  /** Duration of the last fully rendered row (HSYNC-delimited). Used to
   *  correctly time-sample partial rows that span chunk boundaries. */
  lastRowDuration: number;
}

export function createRenderState(): VgaRenderState {
  return {
    cursor: { x: 0, y: 0 },
    hasReceivedSignal: false,
    lastDrawnSeq: 0,
    forceFullRedraw: false,
    lastHasSyncSignals: null,
    lastRowDuration: 0,
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

interface RowData {
  rWrites: [number, number][];
  gWrites: [number, number][];
  bWrites: [number, number][];
  startTs: number;
  endTs: number;
  isAfterVsync: boolean;
  /** True if this row was not terminated by HSYNC/VSYNC (partial data). */
  isPartial: boolean;
}

export interface RenderResult {
  dirty: boolean;
  /** Number of VSYNC boundaries encountered in this render call. */
  vsyncCount: number;
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
 * Returns dirty flag and vsync count.
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
  ioWriteTimestamps: number[],
): RenderResult {
  if (ioWriteCount === 0) return { dirty: false, vsyncCount: 0 };

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

  // Collect rows of timestamped channel writes between HSYNC/VSYNC boundaries.
  const rows: RowData[] = [];
  const newRow = (afterVsync: boolean): RowData => ({
    rWrites: [], gWrites: [], bWrites: [], startTs: -1, endTs: -1,
    isAfterVsync: afterVsync, isPartial: false,
  });

  let currentRow = newRow(false);
  let pendingHsyncTs = -1;
  /** Seq position after the last HSYNC/VSYNC — the start of the current
   *  incomplete row. Used to roll back lastDrawnSeq for partial rows. */
  let lastCompletedSeq = seq;

  for (let s = seq; s < ioWriteSeq; s++) {
    const offset = s - startSeq;
    if (offset < 0 || offset >= ioWriteCount) continue;
    const tagged = readIoWrite(ioWrites, ioWriteStart, offset);
    const coord = taggedCoord(tagged);
    const val = taggedValue(tagged);
    const ts = readIoTimestamp(ioWriteTimestamps, ioWriteStart, offset);

    if (hasSyncSignals) {
      if (isVsync(tagged)) {
        // Flush current row if it has data
        if (currentRow.rWrites.length > 0 || currentRow.gWrites.length > 0 || currentRow.bWrites.length > 0) {
          currentRow.endTs = ts;
          rows.push(currentRow);
        }
        pendingHsyncTs = -1;
        lastCompletedSeq = s + 1;
        currentRow = newRow(true);
        continue;
      }

      if (isHsync(tagged)) {
        pendingHsyncTs = ts;
        continue;
      }
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
        lastCompletedSeq = s + 1;
        currentRow = newRow(false);
        pendingHsyncTs = -1;
        continue;
      } else {
        // Different step — HSYNC is a real line break
        currentRow.endTs = pendingHsyncTs;
        if (currentRow.rWrites.length > 0 || currentRow.gWrites.length > 0 || currentRow.bWrites.length > 0) {
          rows.push(currentRow);
        }
        lastCompletedSeq = s;
        currentRow = newRow(false);
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

  // Push final in-progress row as partial (no HSYNC/VSYNC delimiter yet).
  // Use the previous row's duration for time-sampling so it renders at the
  // correct pixel positions instead of being stretched across 640 columns.
  if (currentRow.rWrites.length > 0 || currentRow.gWrites.length > 0 || currentRow.bWrites.length > 0) {
    const lastR = currentRow.rWrites.length > 0 ? currentRow.rWrites[currentRow.rWrites.length - 1][0] : 0;
    const lastG = currentRow.gWrites.length > 0 ? currentRow.gWrites[currentRow.gWrites.length - 1][0] : 0;
    const lastB = currentRow.bWrites.length > 0 ? currentRow.bWrites[currentRow.bWrites.length - 1][0] : 0;
    currentRow.endTs = Math.max(lastR, lastG, lastB);
    currentRow.isPartial = true;
    rows.push(currentRow);
  }

  // Render each row by time-sampling
  let vsyncCount = 0;
  for (const row of rows) {
    if (row.isAfterVsync) {
      cursor.x = 0;
      cursor.y = 0;
      vsyncCount++;
    }

    if (row.rWrites.length === 0 && row.gWrites.length === 0 && row.bWrites.length === 0) continue;
    if (cursor.y >= texH) continue;

    const rowStart = row.startTs;
    const rowEnd = row.endTs;
    const rowDuration = rowEnd - rowStart;

    if (row.isPartial && state.lastRowDuration > 0) {
      // Partial row (no HSYNC yet): use previous row's duration to calculate
      // time-per-pixel so data renders at the correct x positions. Only render
      // columns covered by the partial data, leaving the rest untouched.
      const pixelDt = state.lastRowDuration / texW;
      let rIdx = 0, gIdx = 0, bIdx = 0;
      let curR = 0, curG = 0, curB = 0;
      // Compute how many columns the partial data covers based on the
      // reference row duration. Render at least those columns; if data
      // happens to extend further (same row, just missing HSYNC), render all.
      const dataCols = Math.min(texW, Math.ceil((rowEnd - rowStart) / pixelDt) + 1);

      for (let x = 0; x < dataCols; x++) {
        const sampleT = rowStart + (x + 1) * pixelDt;

        while (rIdx < row.rWrites.length && row.rWrites[rIdx][0] <= sampleT) {
          curR = row.rWrites[rIdx][1];
          rIdx++;
        }
        while (gIdx < row.gWrites.length && row.gWrites[gIdx][0] <= sampleT) {
          curG = row.gWrites[gIdx][1];
          gIdx++;
        }
        while (bIdx < row.bWrites.length && row.bWrites[bIdx][0] <= sampleT) {
          curB = row.bWrites[bIdx][1];
          bIdx++;
        }

        const texOff = (cursor.y * texW + x) * 4;
        texData[texOff]     = curR;
        texData[texOff + 1] = curG;
        texData[texOff + 2] = curB;
        texData[texOff + 3] = 255;
      }
      // Don't advance cursor.y — this row will be re-rendered completely
      // when the next chunk delivers the HSYNC that ends it.
      // Roll back lastDrawnSeq so the partial row's data is re-processed.
      state.lastDrawnSeq = lastCompletedSeq;
      return { dirty: true, vsyncCount };
    }

    if (rowDuration <= 0) {
      // All writes in the same instant — just render them sequentially
      renderRowSequential(row.rWrites, row.gWrites, row.bWrites, texData, texW, texH, cursor);
    } else {
      // Time-sample: divide row duration into texW equal intervals
      const pixelDt = rowDuration / texW;
      let rIdx = 0, gIdx = 0, bIdx = 0;
      let curR = 0, curG = 0, curB = 0;

      for (let x = 0; x < texW; x++) {
        const sampleT = rowStart + (x + 1) * pixelDt;

        while (rIdx < row.rWrites.length && row.rWrites[rIdx][0] <= sampleT) {
          curR = row.rWrites[rIdx][1];
          rIdx++;
        }
        while (gIdx < row.gWrites.length && row.gWrites[gIdx][0] <= sampleT) {
          curG = row.gWrites[gIdx][1];
          gIdx++;
        }
        while (bIdx < row.bWrites.length && row.bWrites[bIdx][0] <= sampleT) {
          curB = row.bWrites[bIdx][1];
          bIdx++;
        }

        const texOff = (cursor.y * texW + x) * 4;
        texData[texOff]     = curR;
        texData[texOff + 1] = curG;
        texData[texOff + 2] = curB;
        texData[texOff + 3] = 255;
      }
      state.lastRowDuration = rowDuration;
    }

    cursor.x = 0;
    cursor.y++;
  }

  state.lastDrawnSeq = ioWriteSeq;
  return { dirty: true, vsyncCount };
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
