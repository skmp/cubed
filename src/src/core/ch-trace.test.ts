import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compileCube } from './cube';
import { GA144 } from './ga144';
import { SerialBits } from './serial';
import { ROM_DATA } from './rom-data';
import { buildBootStream } from './bootstream';
import { VGA_NODE_R, VGA_NODE_G, VGA_NODE_B } from './constants';
import {
  readIoWrite, readIoTimestamp, taggedCoord,
  isHsync, isVsync,
} from '../ui/emulator/vgaResolution';
import {
  renderIoWrites, createRenderState,
} from '../ui/emulator/vgaRenderer';
import { ResolutionTracker } from '../ui/emulator/vgaResolution';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const samplePath = join(__dirname, '../../samples/CH.cube');

function bootGA() {
  const source = readFileSync(samplePath, 'utf-8');
  const compiled = compileCube(source);
  expect(compiled.errors).toHaveLength(0);
  const ga = new GA144('test');
  ga.setRomData(ROM_DATA);
  ga.reset();
  ga.enqueueSerialBits(708, SerialBits.bootStreamBits(
    Array.from(buildBootStream(compiled.nodes).bytes), GA144.BOOT_BAUD));
  return ga;
}

/** Run until first complete frame, collecting all IO writes incrementally. */
function collectFirstFrame(ga: GA144) {
  const tracker = new ResolutionTracker();
  const CHUNK = 500_000;
  const MAX_STEPS = 80_000_000;
  for (let stepped = 0; stepped < MAX_STEPS; stepped += CHUNK) {
    ga.stepUntilDone(CHUNK);
    const s = ga.getSnapshot();
    tracker.process(s.ioWrites, s.ioWriteCount, s.ioWriteStart, s.ioWriteSeq, s.ioWriteTimestamps);
    if (tracker.complete) break;
  }
  return { tracker, snapshot: ga.getSnapshot() };
}

describe('Node 217 sync timing investigation', () => {

  it('measures h-blank and v-blank intervals', { timeout: 120_000 }, () => {
    const ga = bootGA();
    const { snapshot: s } = collectFirstFrame(ga);

    // Walk through the IO writes and measure intervals
    let lastHsyncTs = -1;
    let lastVsyncTs = -1;
    let lastPixelTs = -1;

    // H-blank = gap from last pixel write to first pixel write of next row
    // (pixels between HSYNC boundaries)
    const hBlankGaps: number[] = [];  // HSYNC to first pixel of next row
    const hFrontPorchGaps: number[] = [];  // last pixel to HSYNC
    const vBlankGaps: number[] = [];  // VSYNC to first HSYNC

    let afterHsync = false;
    let afterVsync = false;
    let hsyncCount = 0;
    let vsyncCount = 0;

    for (let i = 0; i < s.ioWriteCount; i++) {
      const tagged = readIoWrite(s.ioWrites, s.ioWriteStart, i);
      const ts = readIoTimestamp(s.ioWriteTimestamps, s.ioWriteStart, i);

      if (isVsync(tagged)) {
        vsyncCount++;
        afterVsync = true;
        lastVsyncTs = ts;
        if (lastPixelTs >= 0) {
          // "front porch" before vsync
        }
        continue;
      }

      if (isHsync(tagged)) {
        hsyncCount++;
        afterHsync = true;
        if (lastPixelTs >= 0) {
          hFrontPorchGaps.push(ts - lastPixelTs);
        }
        lastHsyncTs = ts;
        if (afterVsync && lastVsyncTs >= 0) {
          vBlankGaps.push(ts - lastVsyncTs);
          afterVsync = false;
        }
        continue;
      }

      const coord = taggedCoord(tagged);
      if (coord === VGA_NODE_R || coord === VGA_NODE_G || coord === VGA_NODE_B) {
        if (afterHsync && lastHsyncTs >= 0) {
          hBlankGaps.push(ts - lastHsyncTs);
          afterHsync = false;
        }
        lastPixelTs = ts;
      }
    }

    console.log(`HSYNC count: ${hsyncCount}, VSYNC count: ${vsyncCount}`);

    if (hBlankGaps.length > 0) {
      hBlankGaps.sort((a, b) => a - b);
      const med = hBlankGaps[Math.floor(hBlankGaps.length / 2)];
      console.log(`H-blank (HSYNC to first pixel): min=${hBlankGaps[0].toFixed(1)} median=${med.toFixed(1)} max=${hBlankGaps[hBlankGaps.length - 1].toFixed(1)} count=${hBlankGaps.length}`);
    }

    if (hFrontPorchGaps.length > 0) {
      hFrontPorchGaps.sort((a, b) => a - b);
      const med = hFrontPorchGaps[Math.floor(hFrontPorchGaps.length / 2)];
      console.log(`H-front-porch (last pixel to HSYNC): min=${hFrontPorchGaps[0].toFixed(1)} median=${med.toFixed(1)} max=${hFrontPorchGaps[hFrontPorchGaps.length - 1].toFixed(1)} count=${hFrontPorchGaps.length}`);
    }

    if (vBlankGaps.length > 0) {
      console.log(`V-blank (VSYNC to first HSYNC): ${vBlankGaps.map(v => v.toFixed(1)).join(', ')}`);
    }

    // Verify we have sync signals
    expect(hsyncCount).toBeGreaterThan(400);
  });

  it('renders single-pass and checks R/G/B edge alignment', { timeout: 120_000 }, () => {
    const ga = bootGA();
    const { snapshot: s } = collectFirstFrame(ga);

    const texW = 640, texH = 480;
    const texData = new Uint8Array(texW * texH * 4);
    const state = createRenderState();

    renderIoWrites(
      state, texData, texW, texH,
      s.ioWrites, s.ioWriteCount, s.ioWriteStart, s.ioWriteSeq,
      true, s.ioWriteTimestamps
    );

    // Measure R, G, B left/right edges per row
    type Edge = { left: number; right: number };
    const rEdges: Edge[] = [];
    const gEdges: Edge[] = [];
    const bEdges: Edge[] = [];

    for (let y = 0; y < texH; y++) {
      let rL = -1, rR = -1, gL = -1, gR = -1, bL = -1, bR = -1;
      for (let x = 0; x < texW; x++) {
        const off = (y * texW + x) * 4;
        if (texData[off] > 0) { if (rL < 0) rL = x; rR = x; }
        if (texData[off + 1] > 0) { if (gL < 0) gL = x; gR = x; }
        if (texData[off + 2] > 0) { if (bL < 0) bL = x; bR = x; }
      }
      rEdges.push({ left: rL, right: rR });
      gEdges.push({ left: gL, right: gR });
      bEdges.push({ left: bL, right: bR });
    }

    // Expected layout:
    //   Flag: rows 112-367, cols 192-447 (R)
    //   Vertical bar (G/B): rows 152-327, cols 288-351
    //   Horizontal bar (G/B): rows 208-271, cols 240-399

    // Print key transition rows
    console.log('\nRow | R left | R right | G left | G right | B left | B right');
    console.log('--- | ------ | ------- | ------ | ------- | ------ | -------');
    const keyRows = [
      ...Array.from({ length: 6 }, (_, i) => 110 + i),  // around flag top
      ...Array.from({ length: 6 }, (_, i) => 150 + i),  // around vbar top
      ...Array.from({ length: 6 }, (_, i) => 206 + i),  // around hbar top
      ...Array.from({ length: 6 }, (_, i) => 269 + i),  // around hbar bottom/vbar transition
      ...Array.from({ length: 6 }, (_, i) => 325 + i),  // around vbar bottom
      ...Array.from({ length: 6 }, (_, i) => 365 + i),  // around flag bottom
    ];
    for (const y of keyRows) {
      if (y >= texH) continue;
      console.log(`${y} | ${rEdges[y].left} | ${rEdges[y].right} | ${gEdges[y].left} | ${gEdges[y].right} | ${bEdges[y].left} | ${bEdges[y].right}`);
    }

    // Check R consistency across top vs bottom
    const topRLeft = rEdges.filter((_, y) => y >= 112 && y <= 271).map(e => e.left);
    const botRLeft = rEdges.filter((_, y) => y >= 272 && y <= 367).map(e => e.left);
    const topRUnique = [...new Set(topRLeft)].sort((a, b) => a - b);
    const botRUnique = [...new Set(botRLeft)].sort((a, b) => a - b);
    console.log(`\nTop R left (112-271): ${topRUnique.join(', ')}`);
    console.log(`Bot R left (272-367): ${botRUnique.join(', ')}`);

    // Check G/B consistency: vbar-only rows (top vs bottom)
    const topGLeft = gEdges.filter((_, y) => y >= 152 && y <= 207).map(e => e.left);
    const botGLeft = gEdges.filter((_, y) => y >= 272 && y <= 327).map(e => e.left);
    const topGUnique = [...new Set(topGLeft)].sort((a, b) => a - b);
    const botGUnique = [...new Set(botGLeft)].sort((a, b) => a - b);
    console.log(`\nTop G left (152-207 vbar): ${topGUnique.join(', ')}`);
    console.log(`Bot G left (272-327 vbar): ${botGUnique.join(', ')}`);

    // Count rows where R edges differ significantly from expected (192, 447)
    let rShiftedRows = 0;
    for (let y = 112; y <= 367; y++) {
      if (Math.abs(rEdges[y].left - 192) > 5) {
        rShiftedRows++;
        if (rShiftedRows <= 10) {
          console.log(`  R shifted row ${y}: left=${rEdges[y].left} right=${rEdges[y].right}`);
        }
      }
    }
    console.log(`Total R-shifted rows (>5px from 192): ${rShiftedRows}`);

    // Analyze raw timestamp data around the transition at row 272
    // Walk the IO writes to find per-row timing details
    const _startSeq2 = s.ioWriteSeq - s.ioWriteCount;
    let rowIdx = 0;
    let rCountInRow = 0;
    let firstRTsInRow = -1;
    let firstGTsInRow = -1;
    let _lastWriteTsInRow = -1;
    let hsyncTs = -1;

    console.log('\nRaw row timing around transition (rows 270-275):');
    for (let i = 0; i < s.ioWriteCount; i++) {
      const tagged = readIoWrite(s.ioWrites, s.ioWriteStart, i);
      const ts = readIoTimestamp(s.ioWriteTimestamps, s.ioWriteStart, i);
      const coord = taggedCoord(tagged);

      if (isVsync(tagged)) {
        rowIdx = 0;
        rCountInRow = 0;
        firstRTsInRow = -1;
        firstGTsInRow = -1;
        hsyncTs = -1;
        continue;
      }

      if (isHsync(tagged)) {
        if (rowIdx >= 270 && rowIdx <= 275) {
          const rowDur = hsyncTs >= 0 ? ts - hsyncTs : -1;
          const rToG = (firstRTsInRow >= 0 && firstGTsInRow >= 0) ? firstGTsInRow - firstRTsInRow : 0;
          console.log(`  Row ${rowIdx}: R=${rCountInRow} firstR=${firstRTsInRow.toFixed(0)} firstG=${firstGTsInRow.toFixed(0)} R-G offset=${rToG.toFixed(1)}ns rowDur=${rowDur.toFixed(0)}ns`);
        }
        hsyncTs = ts;
        rowIdx++;
        rCountInRow = 0;
        firstRTsInRow = -1;
        firstGTsInRow = -1;
        _lastWriteTsInRow = -1;
        continue;
      }

      if (coord === VGA_NODE_R) {
        rCountInRow++;
        if (firstRTsInRow < 0) firstRTsInRow = ts;
        _lastWriteTsInRow = ts;
      } else if (coord === VGA_NODE_G) {
        if (firstGTsInRow < 0) firstGTsInRow = ts;
        _lastWriteTsInRow = ts;
      }
    }
  });
});
