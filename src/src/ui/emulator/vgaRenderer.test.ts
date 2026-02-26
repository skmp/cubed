import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  renderIoWrites,
  createRenderState,
  clearToBlack,
  fillNoise,
  DAC_TO_8BIT,
} from './vgaRenderer';
import {
  DAC_XOR,
  detectResolution,
  ResolutionTracker,
  readIoWrite,
  taggedCoord,
  isHsync as isHsyncCheck,
} from './vgaResolution';
import {
  VGA_NODE_R,
  VGA_NODE_G,
  VGA_NODE_B,
  VGA_NODE_SYNC,
} from '../../core/constants';
import { GA144 } from '../../core/ga144';
import { ROM_DATA } from '../../core/rom-data';
import { compileCube } from '../../core/cube';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---- Constants ----
const W = 640;
const H = 480;

// ---- Helpers ----

/** Create a tagged IO write: (coord << 18) | value */
function tag(coord: number, value: number): number {
  return coord * 0x40000 + value;
}

/** Create a DAC write with the desired 9-bit output value (applies XOR encoding) */
function dacWrite(coord: number, desired: number): number {
  return tag(coord, desired ^ DAC_XOR);
}

/** HSYNC: node 217 pin17 driven low (bits 17:16 = 10) */
function hsync(): number {
  return tag(VGA_NODE_SYNC, 0x20000);
}

/** VSYNC: node 217 pin17 driven high (bits 17:16 = 11) */
function vsync(): number {
  return tag(VGA_NODE_SYNC, 0x30000);
}

/** Read pixel at (x,y) from RGBA texture buffer */
function readPixel(data: Uint8Array, w: number, x: number, y: number): { r: number; g: number; b: number; a: number } {
  const off = (y * w + x) * 4;
  return { r: data[off], g: data[off + 1], b: data[off + 2], a: data[off + 3] };
}

// F18A runs at ~700 MHz → ~1.43 ns/cycle. A pixel step takes ~10 cycles ≈ 14.3 ns.
const NS_PER_PIXEL = 14.3;
// Within a step, B/G/Sync/R arrive in descending node-index order, ~1.4 ns apart.
const NS_INTRA_STEP = 1.43;

/**
 * Generate guest wall-clock timestamps (nanoseconds) for an array of IO writes.
 * B,G,R within the same pixel share a step; HSYNC/VSYNC get sub-ns offsets
 * to model the GA144's descending-index stepping order (717→617→217→117).
 */
function guestTimestamps(writes: number[], startNs = 21_000_000): number[] {
  const ts: number[] = [];
  let stepStart = startNs;
  let intraIdx = 0;

  for (let i = 0; i < writes.length; i++) {
    const coord = taggedCoord(writes[i]);
    if (coord === VGA_NODE_B) {
      intraIdx = 0;
      ts.push(stepStart + intraIdx * NS_INTRA_STEP);
    } else if (coord === VGA_NODE_G) {
      intraIdx = 1;
      ts.push(stepStart + intraIdx * NS_INTRA_STEP);
    } else if (coord === VGA_NODE_SYNC) {
      intraIdx = 2;
      ts.push(stepStart + intraIdx * NS_INTRA_STEP);
    } else if (coord === VGA_NODE_R) {
      intraIdx = 3;
      ts.push(stepStart + intraIdx * NS_INTRA_STEP);
      stepStart += NS_PER_PIXEL;
    } else {
      ts.push(stepStart + intraIdx * NS_INTRA_STEP);
    }
  }
  return ts;
}

/** Generate a full 640-pixel scanline of a single color. */
function solidRow(r: number, g: number, b: number): { r: number; g: number; b: number }[] {
  return Array.from({ length: W }, () => ({ r, g, b }));
}

/** Build a complete frame: VSYNC, then rows of B/G/R pixels + HSYNC each, then VSYNC.
 *  Each row must have exactly 640 pixels for correct 1:1 time-sampling. */
function buildFrame(rows: { r: number; g: number; b: number }[][]): { writes: number[]; timestamps: number[] } {
  const writes: number[] = [vsync()];
  for (const row of rows) {
    for (const pixel of row) {
      writes.push(dacWrite(VGA_NODE_B, pixel.b));
      writes.push(dacWrite(VGA_NODE_G, pixel.g));
      writes.push(dacWrite(VGA_NODE_R, pixel.r));
    }
    writes.push(hsync());
  }
  writes.push(vsync());
  return { writes, timestamps: guestTimestamps(writes) };
}

/** Create a 640×480 test setup */
function setup() {
  const texData = new Uint8Array(W * H * 4);
  const state = createRenderState();
  return { texData, state };
}

// ---- Tests ----

describe('vgaRenderer', () => {
  describe('basic pixel rendering with sync signals', () => {
    it('renders a row of solid red', () => {
      const { texData, state } = setup();
      const { writes, timestamps } = buildFrame([solidRow(0x1FF, 0, 0)]);

      renderIoWrites(state, texData, W, H, writes, writes.length, 0, writes.length, true, timestamps);

      expect(readPixel(texData, W, 0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
      expect(readPixel(texData, W, 319, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
      expect(readPixel(texData, W, 639, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    });

    it('renders a row of solid white', () => {
      const { texData, state } = setup();
      const { writes, timestamps } = buildFrame([solidRow(0x1FF, 0x1FF, 0x1FF)]);

      renderIoWrites(state, texData, W, H, writes, writes.length, 0, writes.length, true, timestamps);

      expect(readPixel(texData, W, 0, 0)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
      expect(readPixel(texData, W, 639, 0)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    });

    it('renders a row with distinct pixel colors', () => {
      const { texData, state } = setup();

      // Build a row: first half red, second half green
      const row: { r: number; g: number; b: number }[] = [];
      for (let i = 0; i < 320; i++) row.push({ r: 0x1FF, g: 0, b: 0 });
      for (let i = 0; i < 320; i++) row.push({ r: 0, g: 0x1FF, b: 0 });

      const { writes, timestamps } = buildFrame([row]);
      renderIoWrites(state, texData, W, H, writes, writes.length, 0, writes.length, true, timestamps);

      // Well within red region
      expect(readPixel(texData, W, 0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
      expect(readPixel(texData, W, 310, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
      // Well within green region
      expect(readPixel(texData, W, 330, 0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
      expect(readPixel(texData, W, 639, 0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    });
  });

  describe('HSYNC row advancement', () => {
    it('advances to next row on HSYNC', () => {
      const { texData, state } = setup();
      const { writes, timestamps } = buildFrame([
        solidRow(0x1FF, 0, 0),
        solidRow(0, 0x1FF, 0),
      ]);

      renderIoWrites(state, texData, W, H, writes, writes.length, 0, writes.length, true, timestamps);

      expect(readPixel(texData, W, 0, 0).r).toBe(255);
      expect(readPixel(texData, W, 0, 0).g).toBe(0);
      expect(readPixel(texData, W, 0, 1).g).toBe(255);
      expect(readPixel(texData, W, 0, 1).r).toBe(0);
    });

    it('ignores HSYNC when no pixels have been written on the row', () => {
      const { texData, state } = setup();

      // VSYNC, empty HSYNCs, then a full row, HSYNC, VSYNC
      const writes: number[] = [vsync(), hsync(), hsync()];
      const row = solidRow(0x1FF, 0, 0);
      for (const px of row) {
        writes.push(dacWrite(VGA_NODE_B, px.b));
        writes.push(dacWrite(VGA_NODE_G, px.g));
        writes.push(dacWrite(VGA_NODE_R, px.r));
      }
      writes.push(hsync(), vsync());
      const ts = guestTimestamps(writes);

      renderIoWrites(state, texData, W, H, writes, writes.length, 0, writes.length, true, ts);

      // Pixel should be on row 0 (empty HSYNCs don't advance)
      expect(readPixel(texData, W, 0, 0).r).toBe(255);
      expect(readPixel(texData, W, 639, 0).r).toBe(255);
    });
  });

  describe('VSYNC handling', () => {
    it('resets cursor to (0,0) on VSYNC', () => {
      const { texData, state } = setup();

      // Row 0: red, row 1: green, then VSYNC, then row 0: blue
      const writes: number[] = [];
      for (const px of solidRow(0x1FF, 0, 0)) {
        writes.push(dacWrite(VGA_NODE_B, px.b), dacWrite(VGA_NODE_G, px.g), dacWrite(VGA_NODE_R, px.r));
      }
      writes.push(hsync());
      for (const px of solidRow(0, 0x1FF, 0)) {
        writes.push(dacWrite(VGA_NODE_B, px.b), dacWrite(VGA_NODE_G, px.g), dacWrite(VGA_NODE_R, px.r));
      }
      writes.push(vsync());
      for (const px of solidRow(0, 0, 0x1FF)) {
        writes.push(dacWrite(VGA_NODE_B, px.b), dacWrite(VGA_NODE_G, px.g), dacWrite(VGA_NODE_R, px.r));
      }
      const ts = guestTimestamps(writes);

      renderIoWrites(state, texData, W, H, writes, writes.length, 0, writes.length, true, ts);

      // After VSYNC, blue row overwrites row 0
      expect(readPixel(texData, W, 0, 0)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
      expect(readPixel(texData, W, 639, 0)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
    });

    it('does not clear to black when VSYNC is the last entry', () => {
      const { texData, state } = setup();
      clearToBlack(texData);

      const { writes, timestamps } = buildFrame([solidRow(0x1FF, 0, 0)]);
      renderIoWrites(state, texData, W, H, writes, writes.length, 0, writes.length, true, timestamps);

      // Pixel was rendered — trailing VSYNC doesn't clear it
      expect(readPixel(texData, W, 0, 0).r).toBe(255);
      expect(readPixel(texData, W, 639, 0).r).toBe(255);
    });

    it('preserves background when VSYNC has subsequent DAC writes', () => {
      const { texData, state } = setup();

      // Fill with white
      for (let i = 0; i < texData.length; i += 4) {
        texData[i] = texData[i+1] = texData[i+2] = 255;
        texData[i+3] = 255;
      }
      state.hasReceivedSignal = true;

      // Render one red row
      const { writes, timestamps } = buildFrame([solidRow(0x1FF, 0, 0)]);
      renderIoWrites(state, texData, W, H, writes, writes.length, 0, writes.length, true, timestamps);

      // Row 0: red
      expect(readPixel(texData, W, 0, 0).r).toBe(255);
      expect(readPixel(texData, W, 0, 0).g).toBe(0);
      // Row 1+: still white (untouched)
      expect(readPixel(texData, W, 0, 1)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    });
  });

  describe('incremental rendering', () => {
    it('processes only new writes on incremental update', () => {
      const { texData, state } = setup();

      // Batch 1: VSYNC + one red row + HSYNC
      const batch1Writes: number[] = [vsync()];
      for (const px of solidRow(0x1FF, 0, 0)) {
        batch1Writes.push(dacWrite(VGA_NODE_B, px.b), dacWrite(VGA_NODE_G, px.g), dacWrite(VGA_NODE_R, px.r));
      }
      batch1Writes.push(hsync());
      const ts1 = guestTimestamps(batch1Writes);
      renderIoWrites(state, texData, W, H, batch1Writes, batch1Writes.length, 0, batch1Writes.length, true, ts1);
      expect(readPixel(texData, W, 0, 0).r).toBe(255);

      // Batch 2: extends buffer with a green row
      const batch2Writes = [...batch1Writes];
      for (const px of solidRow(0, 0x1FF, 0)) {
        batch2Writes.push(dacWrite(VGA_NODE_B, px.b), dacWrite(VGA_NODE_G, px.g), dacWrite(VGA_NODE_R, px.r));
      }
      batch2Writes.push(hsync());
      const ts2 = guestTimestamps(batch2Writes);
      renderIoWrites(state, texData, W, H, batch2Writes, batch2Writes.length, 0, batch2Writes.length, true, ts2);

      expect(readPixel(texData, W, 0, 0).r).toBe(255);
      expect(readPixel(texData, W, 0, 1).g).toBe(255);
    });

    it('triggers full redraw when data is dropped', () => {
      const { texData, state } = setup();

      // Batch 1: red row
      const { writes: b1, timestamps: ts1 } = buildFrame([solidRow(0x1FF, 0, 0)]);
      renderIoWrites(state, texData, W, H, b1, b1.length, 0, b1.length, true, ts1);
      expect(state.lastDrawnSeq).toBe(b1.length);

      // Batch 2: green row with a big gap in seq (data dropped)
      const { writes: b2, timestamps: ts2 } = buildFrame([solidRow(0, 0x1FF, 0)]);
      const fakeSeq = b1.length + 100000;
      renderIoWrites(state, texData, W, H, b2, b2.length, 0, fakeSeq, true, ts2);

      // Full redraw from batch2: green
      expect(readPixel(texData, W, 0, 0).g).toBe(255);
      expect(readPixel(texData, W, 0, 0).r).toBe(0);
    });
  });

  describe('row wrapping with sync signals', () => {
    it('wraps to next row via HSYNC', () => {
      const { texData, state } = setup();
      const { writes, timestamps } = buildFrame([
        solidRow(0x1FF, 0, 0),
        solidRow(0, 0x1FF, 0),
      ]);

      renderIoWrites(state, texData, W, H, writes, writes.length, 0, writes.length, true, timestamps);

      expect(readPixel(texData, W, 0, 0).r).toBe(255);
      expect(readPixel(texData, W, 639, 0).r).toBe(255);
      expect(readPixel(texData, W, 0, 1).g).toBe(255);
      expect(readPixel(texData, W, 639, 1).g).toBe(255);
    });
  });

  describe('full frame rendering with CH.cube-like data', () => {
    it('renders a simplified Swiss flag pattern', () => {
      const { texData, state } = setup();

      const BLACK = { r: 0, g: 0, b: 0 };
      const RED   = { r: 0x1FF, g: 0, b: 0 };
      const WHITE = { r: 0x1FF, g: 0x1FF, b: 0x1FF };

      // Swiss flag: black border, red background, white cross
      // Rows 0-119 and 360-479: all black
      // Rows 120-359: cols 0-159 and 480-639 black, rest red, cross region white
      const rows: { r: number; g: number; b: number }[][] = [];
      for (let y = 0; y < H; y++) {
        const row: { r: number; g: number; b: number }[] = [];
        for (let x = 0; x < W; x++) {
          if (y < 120 || y >= 360 || x < 160 || x >= 480) {
            row.push(BLACK);
          } else if ((y >= 200 && y < 280) && (x >= 280 && x < 360)) {
            row.push(WHITE); // center of cross
          } else if ((y >= 200 && y < 280) || (x >= 280 && x < 360)) {
            row.push(WHITE); // cross arms
          } else {
            row.push(RED);
          }
        }
        rows.push(row);
      }

      const { writes, timestamps } = buildFrame(rows);
      renderIoWrites(state, texData, W, H, writes, writes.length, 0, writes.length, true, timestamps);

      // Corners: black
      expect(readPixel(texData, W, 0, 0)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
      expect(readPixel(texData, W, 639, 479)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
      // Center of red area (e.g. y=150, x=200): red
      expect(readPixel(texData, W, 200, 150).r).toBe(255);
      expect(readPixel(texData, W, 200, 150).g).toBe(0);
      // Center of cross (y=240, x=320): white
      expect(readPixel(texData, W, 320, 240)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    });

    it('preserves frame on trailing VSYNC after full frame', () => {
      const { texData, state } = setup();

      const rows = Array.from({ length: H }, () => solidRow(0x1FF, 0, 0));
      const { writes, timestamps } = buildFrame(rows);
      renderIoWrites(state, texData, W, H, writes, writes.length, 0, writes.length, true, timestamps);

      // Spot-check several pixels
      for (const [x, y] of [[0,0], [319,239], [639,479]]) {
        const px = readPixel(texData, W, x, y);
        expect(px.r).toBe(255);
        expect(px.g).toBe(0);
        expect(px.b).toBe(0);
      }
    });
  });

  describe('integration with GA144 snapshot data', () => {
    it('renders from a ring buffer with non-zero start offset', () => {
      const { texData, state } = setup();

      // Build a single-row frame and place it at a non-zero offset in a ring buffer
      const frameWrites: number[] = [vsync()];
      for (const px of solidRow(0x1FF, 0, 0)) {
        frameWrites.push(dacWrite(VGA_NODE_B, px.b), dacWrite(VGA_NODE_G, px.g), dacWrite(VGA_NODE_R, px.r));
      }
      frameWrites.push(hsync());
      // Second row: green
      for (const px of solidRow(0, 0x1FF, 0)) {
        frameWrites.push(dacWrite(VGA_NODE_B, px.b), dacWrite(VGA_NODE_G, px.g), dacWrite(VGA_NODE_R, px.r));
      }
      frameWrites.push(hsync(), vsync());

      const capacity = frameWrites.length + 100;
      const buffer = new Array(capacity).fill(0);
      const tsBuf = new Array(capacity).fill(0);
      const startOffset = 37;

      const allTs = guestTimestamps(frameWrites);
      for (let i = 0; i < frameWrites.length; i++) {
        buffer[(startOffset + i) % capacity] = frameWrites[i];
        tsBuf[(startOffset + i) % capacity] = allTs[i];
      }

      renderIoWrites(state, texData, W, H, buffer, frameWrites.length, startOffset, frameWrites.length, true, tsBuf);

      // Row 0: red
      expect(readPixel(texData, W, 0, 0).r).toBe(255);
      expect(readPixel(texData, W, 639, 0).r).toBe(255);
      // Row 1: green
      expect(readPixel(texData, W, 0, 1).g).toBe(255);
      expect(readPixel(texData, W, 639, 1).g).toBe(255);
    });
  });

  describe('DAC encoding', () => {
    it('correctly decodes XOR-encoded DAC values', () => {
      expect(DAC_TO_8BIT[0]).toBe(0);
      expect(DAC_TO_8BIT[0x1FF]).toBe(255);
      expect(DAC_TO_8BIT[256]).toBe(Math.floor(256 * 255 / 511));
    });
  });

  describe('HSYNC interleaving with DAC writes (timestamp-based)', () => {
    it('handles HSYNC arriving between G and R writes using timestamps', () => {
      const { texData, state } = setup();

      // 640 pixels on row 0. On the last pixel, HSYNC arrives between G and R
      // (same step as R → deferred HSYNC). Then 640 green pixels on row 1.
      const writes: number[] = [vsync()];
      // First 639 red pixels
      for (let i = 0; i < 639; i++) {
        writes.push(dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF));
      }
      // 640th pixel: B, G, then HSYNC, then R (same step)
      writes.push(dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0));
      writes.push(hsync());
      writes.push(dacWrite(VGA_NODE_R, 0x1FF));
      // Row 1: 640 green pixels
      for (let i = 0; i < W; i++) {
        writes.push(dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0x1FF), dacWrite(VGA_NODE_R, 0));
      }
      writes.push(hsync(), vsync());

      const ts = guestTimestamps(writes);
      renderIoWrites(state, texData, W, H, writes, writes.length, 0, writes.length, true, ts);

      // Row 0: all 640 red pixels (including the last one where HSYNC was deferred)
      expect(readPixel(texData, W, 0, 0).r).toBe(255);
      expect(readPixel(texData, W, 639, 0).r).toBe(255);
      // Row 1: green
      expect(readPixel(texData, W, 0, 1).g).toBe(255);
      expect(readPixel(texData, W, 639, 1).g).toBe(255);
    });

    it('applies HSYNC immediately when R write is in a different step', () => {
      const { texData, state } = setup();

      // 640 red pixels, then HSYNC (different step from next R), then 640 green pixels
      const writes: number[] = [vsync()];
      for (let i = 0; i < W; i++) {
        writes.push(dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF));
      }
      writes.push(hsync());
      for (let i = 0; i < W; i++) {
        writes.push(dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0x1FF), dacWrite(VGA_NODE_R, 0));
      }
      writes.push(hsync(), vsync());

      const ts = guestTimestamps(writes);
      renderIoWrites(state, texData, W, H, writes, writes.length, 0, writes.length, true, ts);

      // Row 0: red
      expect(readPixel(texData, W, 0, 0).r).toBe(255);
      expect(readPixel(texData, W, 639, 0).r).toBe(255);
      // Row 1: green
      expect(readPixel(texData, W, 0, 1).g).toBe(255);
      expect(readPixel(texData, W, 639, 1).g).toBe(255);
    });
  });

  describe('GA144 integration with CH.cube', () => {
    let snap: ReturnType<GA144['getSnapshot']>;

    beforeAll(() => {
      const samplePath = join(__dirname, '../../../samples/CH.cube');
      const source = readFileSync(samplePath, 'utf-8');
      const compiled = compileCube(source);
      const ga = new GA144('test');
      ga.setRomData(ROM_DATA);
      ga.reset();
      ga.load(compiled);
      ga.stepUntilDone(50_000_000);
      snap = ga.getSnapshot();
    }, 300000);

    it('verifies HSYNC position relative to DAC writes', () => {
      const { ioWrites, ioWriteStart, ioWriteCount } = snap;
      let firstHsyncIdx = -1;
      for (let i = 0; i < ioWriteCount; i++) {
        const tagged = readIoWrite(ioWrites, ioWriteStart, i);
        if (isHsyncCheck(tagged)) { firstHsyncIdx = i; break; }
      }
      expect(firstHsyncIdx).toBeGreaterThan(0);

      let rCountBeforeHsync = 0;
      for (let i = 0; i < firstHsyncIdx; i++) {
        const tagged = readIoWrite(ioWrites, ioWriteStart, i);
        if (taggedCoord(tagged) === VGA_NODE_R) rCountBeforeHsync++;
      }
      expect(rCountBeforeHsync).toBe(640);
    });

    it('renders Swiss flag with correct color distribution', () => {
      const res = detectResolution(new ResolutionTracker(), snap.ioWrites, snap.ioWriteCount, snap.ioWriteStart, snap.ioWriteSeq, snap.ioWriteTimestamps);
      expect(res.hasSyncSignals).toBe(true);
      expect(res.complete).toBe(true);

      const texData = new Uint8Array(W * H * 4);
      const state = createRenderState();
      renderIoWrites(state, texData, W, H, snap.ioWrites, snap.ioWriteCount, snap.ioWriteStart, snap.ioWriteSeq, true, snap.ioWriteTimestamps);

      expect(readPixel(texData, W, 0, 0)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
      expect(readPixel(texData, W, 320, 0)).toEqual({ r: 0, g: 0, b: 0, a: 255 });

      let redCount = 0, crossCount = 0, blackCount = 0;
      for (let i = 0; i < texData.length; i += 4) {
        const r = texData[i], g = texData[i+1], b = texData[i+2];
        if (r === 0 && g === 0 && b === 0) blackCount++;
        else if (r === 255 && g === 0 && b === 0) redCount++;
        else if (g === 255 && b === 255) crossCount++;
      }

      expect(redCount).toBeGreaterThan(10000);
      expect(crossCount).toBeGreaterThan(1000);
      expect(blackCount).toBeGreaterThan(100000);
    });
  });
});
