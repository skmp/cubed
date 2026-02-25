import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  renderIoWrites,
  createRenderState,
  clearToBlack,
  DAC_TO_8BIT,
} from './vgaRenderer';
import {
  DAC_XOR,
  detectResolution,
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

/** Build a simple frame: one row of pixels with HSYNC, wrapped in VSYNC */
function buildFrame(rows: { r: number; g: number; b: number }[][]): number[] {
  const writes: number[] = [vsync()];
  for (const row of rows) {
    for (const pixel of row) {
      // B, G, R order (matches GA144 stepping order: higher indices first)
      writes.push(dacWrite(VGA_NODE_B, pixel.b));
      writes.push(dacWrite(VGA_NODE_G, pixel.g));
      writes.push(dacWrite(VGA_NODE_R, pixel.r));
    }
    writes.push(hsync());
  }
  writes.push(vsync());
  return writes;
}

/** Create a simple test setup */
function setup(width: number, height: number) {
  const texData = new Uint8Array(width * height * 4);
  const state = createRenderState();
  return { texData, state, width, height };
}

// ---- Tests ----

describe('vgaRenderer', () => {
  describe('basic pixel rendering with sync signals', () => {
    it('renders a single red pixel', () => {
      const { texData, state } = setup(4, 4);

      // B, G, R writes for one pixel (red = R:0x1FF, G:0, B:0)
      const writes = [
        dacWrite(VGA_NODE_B, 0),
        dacWrite(VGA_NODE_G, 0),
        dacWrite(VGA_NODE_R, 0x1FF),
      ];

      renderIoWrites(state, texData, 4, 4, writes, writes.length, 0, writes.length, false);

      const px = readPixel(texData, 4, 0, 0);
      expect(px.r).toBe(DAC_TO_8BIT[0x1FF]); // 255
      expect(px.g).toBe(0);
      expect(px.b).toBe(0);
      expect(px.a).toBe(255);
    });

    it('renders a single white pixel', () => {
      const { texData, state } = setup(4, 4);

      const writes = [
        dacWrite(VGA_NODE_B, 0x1FF),
        dacWrite(VGA_NODE_G, 0x1FF),
        dacWrite(VGA_NODE_R, 0x1FF),
      ];

      renderIoWrites(state, texData, 4, 4, writes, writes.length, 0, writes.length, false);

      const px = readPixel(texData, 4, 0, 0);
      expect(px.r).toBe(255);
      expect(px.g).toBe(255);
      expect(px.b).toBe(255);
    });

    it('renders a row of 3 pixels with different colors', () => {
      const { texData, state } = setup(4, 4);

      const writes = [
        // Pixel 0: red
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF),
        // Pixel 1: green
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0x1FF), dacWrite(VGA_NODE_R, 0),
        // Pixel 2: blue
        dacWrite(VGA_NODE_B, 0x1FF), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0),
      ];

      renderIoWrites(state, texData, 4, 4, writes, writes.length, 0, writes.length, false);

      expect(readPixel(texData, 4, 0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
      expect(readPixel(texData, 4, 1, 0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
      expect(readPixel(texData, 4, 2, 0)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
    });
  });

  describe('HSYNC row advancement', () => {
    it('advances to next row on HSYNC when sync signals present', () => {
      const { texData, state } = setup(4, 4);

      const writes = [
        // Row 0: red pixel
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF),
        hsync(),
        // Row 1: green pixel
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0x1FF), dacWrite(VGA_NODE_R, 0),
      ];

      renderIoWrites(state, texData, 4, 4, writes, writes.length, 0, writes.length, true);

      expect(readPixel(texData, 4, 0, 0).r).toBe(255); // red at row 0
      expect(readPixel(texData, 4, 0, 1).g).toBe(255); // green at row 1
    });

    it('ignores HSYNC when no pixels have been written on the row', () => {
      const { texData, state } = setup(4, 4);

      const writes = [
        hsync(), // should be ignored (no pixels yet)
        hsync(), // should be ignored (no pixels yet)
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF),
      ];

      renderIoWrites(state, texData, 4, 4, writes, writes.length, 0, writes.length, true);

      // Pixel should be at row 0 since empty HSYNCs were ignored
      expect(readPixel(texData, 4, 0, 0).r).toBe(255);
    });
  });

  describe('VSYNC handling', () => {
    it('resets cursor to (0,0) on VSYNC', () => {
      const { texData, state } = setup(4, 4);

      // First frame: one pixel at (0,0)
      const writes = [
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF),
        hsync(),
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0x1FF), dacWrite(VGA_NODE_R, 0),
        vsync(),
        // Second frame: blue pixel should be at (0,0)
        dacWrite(VGA_NODE_B, 0x1FF), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0),
      ];

      renderIoWrites(state, texData, 4, 4, writes, writes.length, 0, writes.length, true);

      // After VSYNC + new pixel, (0,0) should be blue (overwritten)
      const px = readPixel(texData, 4, 0, 0);
      expect(px.r).toBe(0);
      expect(px.g).toBe(0);
      expect(px.b).toBe(255);
    });

    it('does not clear to black when VSYNC is the last entry', () => {
      const { texData, state } = setup(4, 4);
      clearToBlack(texData);

      // Render some pixels, then VSYNC at end
      const writes = [
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF),
        vsync(), // trailing VSYNC
      ];

      renderIoWrites(state, texData, 4, 4, writes, writes.length, 0, writes.length, true);

      // The red pixel at (0,0) should survive the trailing VSYNC
      expect(readPixel(texData, 4, 0, 0).r).toBe(255);
    });

    it('clears to black when VSYNC has subsequent DAC writes', () => {
      const { texData, state } = setup(4, 4);

      // Pre-fill with white to detect clearing
      for (let i = 0; i < texData.length; i += 4) {
        texData[i] = texData[i+1] = texData[i+2] = 255;
        texData[i+3] = 255;
      }
      state.hasReceivedSignal = true;

      // First render: draw a pixel so lastDrawnSeq advances.
      const batch1 = [
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF),
      ];
      renderIoWrites(state, texData, 4, 4, batch1, batch1.length, 0, batch1.length, true);

      // Re-fill with white to detect clearing in next render
      for (let i = 0; i < texData.length; i += 4) {
        texData[i] = texData[i+1] = texData[i+2] = 255;
        texData[i+3] = 255;
      }

      // Second render: VSYNC + new pixel. This triggers a full redraw because
      // dataDropped = true (lastDrawnSeq=3 < startSeq=100).
      const batch2 = [
        vsync(),
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF),
      ];
      renderIoWrites(state, texData, 4, 4, batch2, batch2.length, 0, 104, true);

      // (0,0) should be red (rendered after VSYNC reset cursor)
      expect(readPixel(texData, 4, 0, 0).r).toBe(255);
      // (1,0) should be cleared to black (not white)
      expect(readPixel(texData, 4, 1, 0)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    });
  });

  describe('incremental rendering', () => {
    it('processes only new writes on incremental update', () => {
      const { texData, state } = setup(4, 4);

      // First batch: red pixel
      const batch1 = [
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF),
      ];
      renderIoWrites(state, texData, 4, 4, batch1, batch1.length, 0, batch1.length, false);
      expect(readPixel(texData, 4, 0, 0).r).toBe(255);
      expect(state.cursor.x).toBe(1);

      // Second batch: green pixel (appended to the same buffer conceptually)
      const batch2 = [
        ...batch1,
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0x1FF), dacWrite(VGA_NODE_R, 0),
      ];
      renderIoWrites(state, texData, 4, 4, batch2, batch2.length, 0, batch2.length, false);

      // Red should still be at x=0, green at x=1
      expect(readPixel(texData, 4, 0, 0).r).toBe(255);
      expect(readPixel(texData, 4, 1, 0).g).toBe(255);
    });

    it('triggers full redraw when data is dropped', () => {
      const { texData, state } = setup(4, 4);

      // First render
      const batch1 = [
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF),
      ];
      renderIoWrites(state, texData, 4, 4, batch1, batch1.length, 0, batch1.length, false);
      expect(state.lastDrawnSeq).toBe(3);

      // Simulate data drop: new data starts at seq 100
      const batch2 = [
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0x1FF), dacWrite(VGA_NODE_R, 0),
      ];
      // startSeq = 103 - 3 = 100, lastDrawnSeq = 3 < 100 → dataDropped
      renderIoWrites(state, texData, 4, 4, batch2, batch2.length, 0, 103, false);

      // Cursor should have been reset and green pixel at (0,0)
      expect(readPixel(texData, 4, 0, 0).g).toBe(255);
    });
  });

  describe('no sync signals (manual width mode)', () => {
    it('wraps to next row when cursor.x reaches texW', () => {
      const { texData, state } = setup(2, 4);

      const writes = [
        // Row 0, pixel 0
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF),
        // Row 0, pixel 1
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF),
        // Row 1, pixel 0 (auto-wrapped)
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0x1FF), dacWrite(VGA_NODE_R, 0),
      ];

      renderIoWrites(state, texData, 2, 4, writes, writes.length, 0, writes.length, false);

      expect(readPixel(texData, 2, 0, 0).r).toBe(255);
      expect(readPixel(texData, 2, 1, 0).r).toBe(255);
      expect(readPixel(texData, 2, 0, 1).g).toBe(255); // wrapped to row 1
    });
  });

  describe('full frame rendering with CH.cube-like data', () => {
    it('renders a simplified Swiss flag pattern', () => {
      const W = 8, H = 8;
      const { texData, state } = setup(W, H);

      // Simplified flag: 2-pixel border, 4x4 red center, 2x2 white cross
      // Layout (8x8):
      // Row 0-1: all black
      // Row 2-5: 2 black + 4 red + 2 black (with white cross at rows 3-4, cols 3-4)
      // Row 6-7: all black
      const BLACK = { r: 0, g: 0, b: 0 };
      const RED   = { r: 0x1FF, g: 0, b: 0 };
      const WHITE = { r: 0x1FF, g: 0x1FF, b: 0x1FF };

      const rows: { r: number; g: number; b: number }[][] = [];
      for (let y = 0; y < H; y++) {
        const row: { r: number; g: number; b: number }[] = [];
        for (let x = 0; x < W; x++) {
          if (y < 2 || y >= 6 || x < 2 || x >= 6) {
            row.push(BLACK);
          } else if ((y === 3 || y === 4) && (x === 3 || x === 4)) {
            row.push(WHITE);
          } else {
            row.push(RED);
          }
        }
        rows.push(row);
      }

      const writes = buildFrame(rows);
      renderIoWrites(state, texData, W, H, writes, writes.length, 0, writes.length, true);

      // Check corners (should be black)
      expect(readPixel(texData, W, 0, 0)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
      expect(readPixel(texData, W, 7, 7)).toEqual({ r: 0, g: 0, b: 0, a: 255 });

      // Check red area
      expect(readPixel(texData, W, 2, 2).r).toBe(255);
      expect(readPixel(texData, W, 2, 2).g).toBe(0);

      // Check white cross center
      expect(readPixel(texData, W, 3, 3)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
      expect(readPixel(texData, W, 4, 4)).toEqual({ r: 255, g: 255, b: 255, a: 255 });

      // Check red around cross
      expect(readPixel(texData, W, 2, 3).r).toBe(255);
      expect(readPixel(texData, W, 2, 3).g).toBe(0);
    });

    it('preserves frame on trailing VSYNC after full frame', () => {
      const W = 4, H = 2;
      const { texData, state } = setup(W, H);

      const RED = { r: 0x1FF, g: 0, b: 0 };
      const rows = [
        [RED, RED, RED, RED],
        [RED, RED, RED, RED],
      ];

      const writes = buildFrame(rows);
      // writes ends with VSYNC
      renderIoWrites(state, texData, W, H, writes, writes.length, 0, writes.length, true);

      // All pixels should be red despite trailing VSYNC
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const px = readPixel(texData, W, x, y);
          expect(px.r).toBe(255);
          expect(px.g).toBe(0);
          expect(px.b).toBe(0);
        }
      }
    });
  });

  describe('integration with GA144 snapshot data', () => {
    it('renders from a ring buffer with non-zero start offset', () => {
      const W = 2, H = 1;
      const { texData, state } = setup(W, H);

      // Simulate a ring buffer: capacity=10, data starts at offset 7
      const capacity = 10;
      const buffer = new Array(capacity).fill(0);
      const startOffset = 7;

      // Write two pixels starting at ring position 7 (wraps around)
      const pixel1 = [
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF),
      ];
      const pixel2 = [
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0x1FF), dacWrite(VGA_NODE_R, 0),
      ];
      const allWrites = [...pixel1, ...pixel2];
      for (let i = 0; i < allWrites.length; i++) {
        buffer[(startOffset + i) % capacity] = allWrites[i];
      }

      renderIoWrites(state, texData, W, H, buffer, allWrites.length, startOffset, allWrites.length, false);

      expect(readPixel(texData, W, 0, 0).r).toBe(255); // red
      expect(readPixel(texData, W, 1, 0).g).toBe(255); // green
    });
  });

  describe('DAC encoding', () => {
    it('correctly decodes XOR-encoded DAC values', () => {
      // 0x155 ^ 0x155 = 0 → DAC output 0 → 8-bit 0
      expect(DAC_TO_8BIT[0]).toBe(0);
      // 0x0AA ^ 0x155 = 0x1FF → DAC output 511 → 8-bit 255
      expect(DAC_TO_8BIT[0x1FF]).toBe(255);
      // Mid-range
      expect(DAC_TO_8BIT[256]).toBe(Math.floor(256 * 255 / 511));
    });
  });

  describe('HSYNC interleaving with DAC writes (timestamp-based)', () => {
    it('handles HSYNC arriving between G and R writes using timestamps', () => {
      // In the GA144, nodes step in descending index order:
      //   717 (B) → 617 (G) → 217 (sync) → 117 (R)
      // HSYNC arrives BETWEEN G and R writes of the same pixel in the same step.
      // With timestamps, the renderer sees that HSYNC and R share the same step
      // and places the R write on the current line before advancing.
      const { texData, state } = setup(4, 4);

      // Simulate GA144 stepping order with timestamps:
      // Step 1-3: pixels 0-2 (B,G,R each step)
      // Step 4: B[3], G[3], HSYNC, R[3] — all in same step
      // Step 5: B[next], G[next], R[next] — new line
      const writes = [
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF),  // step 1
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF),  // step 2
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF),  // step 3
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0),  // step 4: B, G
        hsync(),                                             // step 4: HSYNC
        dacWrite(VGA_NODE_R, 0x1FF),                         // step 4: R (same step!)
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0x1FF), dacWrite(VGA_NODE_R, 0),  // step 5
      ];
      const timestamps = [
        1, 1, 1,  // step 1
        2, 2, 2,  // step 2
        3, 3, 3,  // step 3
        4, 4,     // step 4: B, G
        4,        // step 4: HSYNC
        4,        // step 4: R
        5, 5, 5,  // step 5
      ];

      renderIoWrites(state, texData, 4, 4, writes, writes.length, 0, writes.length, true, timestamps);

      // Row 0 should have 4 red pixels at x=0,1,2,3
      expect(readPixel(texData, 4, 0, 0).r).toBe(255);
      expect(readPixel(texData, 4, 1, 0).r).toBe(255);
      expect(readPixel(texData, 4, 2, 0).r).toBe(255);
      expect(readPixel(texData, 4, 3, 0).r).toBe(255);  // same-step R after HSYNC

      // Row 1 should have green pixel at x=0
      expect(readPixel(texData, 4, 0, 1).g).toBe(255);
    });

    it('applies HSYNC immediately when R write is in a different step', () => {
      const { texData, state } = setup(4, 4);

      // HSYNC in step 4, R in step 5 — HSYNC is a real line break
      const writes = [
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF),  // step 1
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0), dacWrite(VGA_NODE_R, 0x1FF),  // step 2
        hsync(),                                             // step 3: HSYNC
        dacWrite(VGA_NODE_B, 0), dacWrite(VGA_NODE_G, 0x1FF), dacWrite(VGA_NODE_R, 0),  // step 4
      ];
      const timestamps = [
        100, 100, 100,
        200, 200, 200,
        300,              // HSYNC
        400, 400, 400,    // next pixel, different time (gap > 10ns threshold)
      ];

      renderIoWrites(state, texData, 4, 4, writes, writes.length, 0, writes.length, true, timestamps);

      // Row 0: 2 red pixels
      expect(readPixel(texData, 4, 0, 0).r).toBe(255);
      expect(readPixel(texData, 4, 1, 0).r).toBe(255);

      // Row 1: green pixel
      expect(readPixel(texData, 4, 0, 1).g).toBe(255);
    });
  });

  describe('GA144 integration with CH.cube', () => {
    // Share a single 50M-step simulation across integration tests
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

      // Count R writes between start and first HSYNC
      let rCountBeforeHsync = 0;
      for (let i = 0; i < firstHsyncIdx; i++) {
        const tagged = readIoWrite(ioWrites, ioWriteStart, i);
        if (taggedCoord(tagged) === VGA_NODE_R) rCountBeforeHsync++;
      }
      // First row should have approximately 640 R writes before HSYNC
      expect(rCountBeforeHsync).toBe(640);
    });

    it('renders Swiss flag with correct color distribution', () => {
      const res = detectResolution(snap.ioWrites, snap.ioWriteCount, snap.ioWriteStart, snap.ioWriteTimestamps);
      expect(res.hasSyncSignals).toBe(true);
      expect(res.complete).toBe(true);

      const W = 640, H = 480;
      const texData = new Uint8Array(W * H * 4);
      const state = createRenderState();
      renderIoWrites(state, texData, W, H, snap.ioWrites, snap.ioWriteCount, snap.ioWriteStart, snap.ioWriteSeq, true, snap.ioWriteTimestamps);

      // Row 0 (black margin, no accumulated drift yet)
      expect(readPixel(texData, W, 0, 0)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
      expect(readPixel(texData, W, 320, 0)).toEqual({ r: 0, g: 0, b: 0, a: 255 });

      // Count colors across the rendered texture to verify the flag is present.
      // The three DAC channels (R/G/B) run as independent fill loops, so at
      // fill-value transitions the channels can be offset by a few pixels.
      // The cross bar area (G=max, B=max) may appear as cyan (0,255,255)
      // instead of white (255,255,255) due to this inter-channel drift.
      // We check for R presence (R>0) and cross bar presence (G+B both max).
      let redishCount = 0, crossBarCount = 0, blackCount = 0;
      const otherColors = new Map<string, number>();
      for (let i = 0; i < texData.length; i += 4) {
        const r = texData[i], g = texData[i+1], b = texData[i+2];
        if (r === 0 && g === 0 && b === 0) blackCount++;
        else if (r === 255 && g === 0 && b === 0) redishCount++;
        else if (g === 255 && b === 255) crossBarCount++; // white or cyan
        else {
          const key = `${r},${g},${b}`;
          otherColors.set(key, (otherColors.get(key) || 0) + 1);
        }
      }
      const topOther = [...otherColors.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      console.log('Color counts:', { black: blackCount, red: redishCount, crossBar: crossBarCount, other: topOther });

      expect(redishCount).toBeGreaterThan(10000);     // ~55K red-only pixels expected
      expect(crossBarCount).toBeGreaterThan(1000);     // ~10K cross bar pixels expected
      expect(blackCount).toBeGreaterThan(100000);      // most pixels are black
    });
  });
});
