import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GA144 } from './ga144';
import { ROM_DATA } from './rom-data';
import { compileCube } from './cube';
import { VGA_NODE_R, VGA_NODE_G, VGA_NODE_B } from './constants';
import type { GA144Snapshot } from './types';
import {
  readIoWrite,
  taggedCoord,
  taggedValue,
  decodeDac,
  isVsync,
  isHsync,
  detectResolution,
} from '../ui/emulator/vgaResolution';
import {
  renderIoWrites,
  createRenderState,
  DAC_TO_8BIT,
} from '../ui/emulator/vgaRenderer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const samplePath = join(__dirname, '../../samples/FR.cube');
const source = readFileSync(samplePath, 'utf-8');
const chSource = readFileSync(join(__dirname, '../../samples/CH.cube'), 'utf-8');

describe('FR.cube French flag sample', () => {
  let snap: GA144Snapshot;
  let ga: GA144;

  beforeAll(() => {
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);
    ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.load(compiled);
    ga.stepUntilDone(100_000_000);
    snap = ga.getSnapshot();
  }, 600_000);

  it('compiles without errors', () => {
    const result = compileCube(source);
    expect(result.errors).toHaveLength(0);
    expect(result.nodes.length).toBe(7);
    const coords = result.nodes.map(n => n.coord).sort((a, b) => a - b);
    expect(coords).toEqual([116, 117, 217, 616, 617, 716, 717]);
  });

  it('produces correct pixel counts per channel', () => {
    let rCount = 0, gCount = 0, bCount = 0;
    for (let i = 0; i < snap.ioWriteCount; i++) {
      const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
      const coord = taggedCoord(tagged);
      if (coord === VGA_NODE_R) rCount++;
      else if (coord === VGA_NODE_G) gCount++;
      else if (coord === VGA_NODE_B) bCount++;
    }
    expect(rCount).toBe(480 * 640);
    expect(gCount).toBe(480 * 640);
    expect(bCount).toBe(480 * 640);
  });

  it('renders correct French flag colors', () => {
    // French flag: 3 vertical stripes
    // Blue (214px): R=0, G=0, B=max
    // White (213px): R=max, G=max, B=max
    // Red (213px): R=max, G=0, B=0
    //
    // Expected per-channel:
    //   R max: (213 + 213) * 480 = 204480 (white + red stripes)
    //   R zero: 214 * 480 = 102720 (blue stripe)
    //   G max: 213 * 480 = 102240 (white stripe only)
    //   G zero: (214 + 213) * 480 = 204960 (blue + red)
    //   B max: (214 + 213) * 480 = 204960 (blue + white)
    //   B zero: 213 * 480 = 102240 (red stripe only)

    let rZero = 0, rMax = 0, rOther = 0;
    let gZero = 0, gMax = 0, gOther = 0;
    let bZero = 0, bMax = 0, bOther = 0;

    for (let i = 0; i < snap.ioWriteCount; i++) {
      const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
      const coord = taggedCoord(tagged);
      const val = taggedValue(tagged);
      const dac = decodeDac(val);

      if (coord === VGA_NODE_R) {
        if (dac === 0) rZero++;
        else if (dac === 0x1FF) rMax++;
        else rOther++;
      } else if (coord === VGA_NODE_G) {
        if (dac === 0) gZero++;
        else if (dac === 0x1FF) gMax++;
        else gOther++;
      } else if (coord === VGA_NODE_B) {
        if (dac === 0) bZero++;
        else if (dac === 0x1FF) bMax++;
        else bOther++;
      }
    }

    console.log('R:', rZero, 'zero,', rMax, 'max,', rOther, 'other');
    console.log('G:', gZero, 'zero,', gMax, 'max,', gOther, 'other');
    console.log('B:', bZero, 'zero,', bMax, 'max,', bOther, 'other');

    // No intermediate values
    expect(rOther).toBe(0);
    expect(gOther).toBe(0);
    expect(bOther).toBe(0);

    // Total per channel
    expect(rZero + rMax).toBe(480 * 640);
    expect(gZero + gMax).toBe(480 * 640);
    expect(bZero + bMax).toBe(480 * 640);

    // R: white(213) + red(213) = 426 max pixels per row
    expect(rMax).toBe(426 * 480);
    // G: white(213) = 213 max pixels per row
    expect(gMax).toBe(213 * 480);
    // B: blue(214) + white(213) = 427 max pixels per row
    expect(bMax).toBe(427 * 480);
  });

  it('channels are properly interleaved (R,G,B for each pixel)', () => {
    // Analyze channel ordering across the first row
    // Count how many R writes come before corresponding G and B writes
    let rIdx = 0, gIdx = 0, bIdx = 0;
    const rPositions: number[] = [];
    const gPositions: number[] = [];
    const bPositions: number[] = [];
    let dacIdx = 0;

    // Collect positions of first 2000 DAC writes (>640*3 = one full row)
    for (let i = 0; i < snap.ioWriteCount && dacIdx < 2000; i++) {
      const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
      const coord = taggedCoord(tagged);
      if (coord === VGA_NODE_R) { rPositions.push(dacIdx); dacIdx++; }
      else if (coord === VGA_NODE_G) { gPositions.push(dacIdx); dacIdx++; }
      else if (coord === VGA_NODE_B) { bPositions.push(dacIdx); dacIdx++; }
    }

    console.log(`First row: R writes=${rPositions.length}, G writes=${gPositions.length}, B writes=${bPositions.length}`);

    // Check ordering for first 10 pixel triplets
    console.log('First 10 pixel triplets (position in stream):');
    for (let p = 0; p < 10 && p < rPositions.length; p++) {
      console.log(`  pixel ${p}: R@${rPositions[p]} G@${gPositions[p]} B@${bPositions[p]}`);
    }

    // Check mid-row (around blue→white transition at pixel 214)
    console.log('Around blue→white transition (pixels 212-216):');
    for (let p = 212; p <= 216 && p < rPositions.length; p++) {
      const rTagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, rPositions[p]);
      const gTagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, gPositions[p]);
      const bTagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, bPositions[p]);
      const rDac = decodeDac(taggedValue(rTagged));
      const gDac = decodeDac(taggedValue(gTagged));
      const bDac = decodeDac(taggedValue(bTagged));
      console.log(`  pixel ${p}: R=${rDac === 0x1FF ? 'MAX' : '0'} G=${gDac === 0x1FF ? 'MAX' : '0'} B=${bDac === 0x1FF ? 'MAX' : '0'}`);
    }

    // Check that R always comes before G and B for same pixel
    // (since renderer triggers on R)
    let rBeforeG = 0, rAfterG = 0, rBeforeB = 0, rAfterB = 0;
    const limit = Math.min(rPositions.length, gPositions.length, bPositions.length, 640);
    for (let p = 0; p < limit; p++) {
      if (rPositions[p] < gPositions[p]) rBeforeG++;
      else rAfterG++;
      if (rPositions[p] < bPositions[p]) rBeforeB++;
      else rAfterB++;
    }
    console.log(`R before G: ${rBeforeG}/${limit}, R after G: ${rAfterG}/${limit}`);
    console.log(`R before B: ${rBeforeB}/${limit}, R after B: ${rAfterB}/${limit}`);
  });

  it('CH.cube has same interleaving pattern', () => {
    // Compare with CH.cube to see if it has the same R-first ordering
    const compiled = compileCube(chSource);
    expect(compiled.errors).toHaveLength(0);
    const chGa = new GA144('ch-test');
    chGa.setRomData(ROM_DATA);
    chGa.reset();
    chGa.load(compiled);
    chGa.stepUntilDone(100_000_000);
    const chSnap = chGa.getSnapshot();

    const rPos: number[] = [];
    const gPos: number[] = [];
    const bPos: number[] = [];
    let idx = 0;

    for (let i = 0; i < chSnap.ioWriteCount && idx < 2000; i++) {
      const tagged = readIoWrite(chSnap.ioWrites, chSnap.ioWriteStart, i);
      const coord = taggedCoord(tagged);
      if (coord === VGA_NODE_R) { rPos.push(idx); idx++; }
      else if (coord === VGA_NODE_G) { gPos.push(idx); idx++; }
      else if (coord === VGA_NODE_B) { bPos.push(idx); idx++; }
    }

    console.log(`CH first row: R=${rPos.length}, G=${gPos.length}, B=${bPos.length}`);
    console.log('CH first 10 pixel triplets:');
    for (let p = 0; p < 10 && p < rPos.length; p++) {
      console.log(`  pixel ${p}: R@${rPos[p]} G@${gPos[p]} B@${bPos[p]}`);
    }

    let rBeforeG = 0, rAfterG = 0;
    const limit = Math.min(rPos.length, gPos.length, 640);
    for (let p = 0; p < limit; p++) {
      if (rPos[p] < gPos[p]) rBeforeG++;
      else rAfterG++;
    }
    console.log(`CH: R before G: ${rBeforeG}/${limit}, R after G: ${rAfterG}/${limit}`);
  }, 600_000);

  it('analyzes writes around HSYNC boundaries', () => {
    // Find the first HSYNC and examine writes before and after it
    let firstHsyncIdx = -1;
    for (let i = 0; i < snap.ioWriteCount; i++) {
      const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
      if (isHsync(tagged)) {
        firstHsyncIdx = i;
        break;
      }
    }
    expect(firstHsyncIdx).toBeGreaterThan(0);

    // Count R, G, B writes before the first HSYNC
    let rBefore = 0, gBefore = 0, bBefore = 0;
    for (let i = 0; i < firstHsyncIdx; i++) {
      const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
      const coord = taggedCoord(tagged);
      if (coord === VGA_NODE_R) rBefore++;
      else if (coord === VGA_NODE_G) gBefore++;
      else if (coord === VGA_NODE_B) bBefore++;
    }
    console.log(`Before HSYNC #0 (at index ${firstHsyncIdx}): R=${rBefore} G=${gBefore} B=${bBefore}`);

    // Show 10 writes before and after HSYNC
    console.log('Writes around first HSYNC:');
    for (let i = Math.max(0, firstHsyncIdx - 5); i <= firstHsyncIdx + 10; i++) {
      if (i >= snap.ioWriteCount) break;
      const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
      const coord = taggedCoord(tagged);
      const val = taggedValue(tagged);
      let label = '';
      if (isHsync(tagged)) label = 'HSYNC';
      else if (isVsync(tagged)) label = 'VSYNC';
      else if (coord === VGA_NODE_R) label = `R=${decodeDac(val) === 0x1FF ? 'MAX' : '0'}`;
      else if (coord === VGA_NODE_G) label = `G=${decodeDac(val) === 0x1FF ? 'MAX' : '0'}`;
      else if (coord === VGA_NODE_B) label = `B=${decodeDac(val) === 0x1FF ? 'MAX' : '0'}`;
      else label = `node${coord}=0x${val.toString(16)}`;
      console.log(`  [${i}] ${label}${i === firstHsyncIdx ? ' <<<' : ''}`);
    }

    // Now check: do all rows have exactly 640 R, 640 G, 640 B?
    // Walk through the entire stream and count per-row
    let rowR = 0, rowG = 0, rowB = 0, row = 0;
    const mismatches: string[] = [];
    for (let i = 0; i < snap.ioWriteCount; i++) {
      const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
      if (isVsync(tagged)) break;
      if (isHsync(tagged)) {
        if (rowR !== rowG || rowR !== rowB || rowR !== 640) {
          mismatches.push(`Row ${row}: R=${rowR} G=${rowG} B=${rowB}`);
        }
        row++;
        rowR = 0; rowG = 0; rowB = 0;
        continue;
      }
      const coord = taggedCoord(tagged);
      if (coord === VGA_NODE_R) rowR++;
      else if (coord === VGA_NODE_G) rowG++;
      else if (coord === VGA_NODE_B) rowB++;
    }
    console.log(`Total rows checked: ${row}`);
    if (mismatches.length > 0) {
      console.log('Row mismatches:');
      for (const m of mismatches.slice(0, 10)) console.log(`  ${m}`);
    } else {
      console.log('All rows have exactly 640 R, 640 G, 640 B');
    }
  });

  it('renders correct pixel colors through vgaRenderer', () => {
    // Use the actual renderer to render FR.cube and check pixel colors
    const res = detectResolution(snap.ioWrites, snap.ioWriteCount, snap.ioWriteStart, snap.ioWriteTimestamps);
    console.log('FR resolution:', res);

    const texW = res.width;
    const texH = res.height;
    const texData = new Uint8Array(texW * texH * 4);
    const state = createRenderState();

    renderIoWrites(
      state,
      texData,
      texW,
      texH,
      snap.ioWrites,
      snap.ioWriteCount,
      snap.ioWriteStart,
      snap.ioWriteSeq,
      res.hasSyncSignals,
      snap.ioWriteTimestamps,
    );

    // Check pixels in the blue stripe (x=100, y=240 — middle of frame)
    const checkPixel = (x: number, y: number) => {
      const off = (y * texW + x) * 4;
      return { r: texData[off], g: texData[off + 1], b: texData[off + 2] };
    };

    // Blue stripe: x < 214 → R=0, G=0, B=max
    const bluePixel = checkPixel(100, 240);
    console.log('Blue stripe pixel (100, 240):', bluePixel);

    // White stripe: 214 <= x < 427 → R=max, G=max, B=max
    const whitePixel = checkPixel(320, 240);
    console.log('White stripe pixel (320, 240):', whitePixel);

    // Red stripe: x >= 427 → R=max, G=0, B=0
    const redPixel = checkPixel(550, 240);
    console.log('Red stripe pixel (550, 240):', redPixel);

    // Also check a few rows to see if there's drift
    for (const y of [0, 100, 200, 300, 400, 479]) {
      const p0 = checkPixel(0, y);
      const p213 = checkPixel(213, y);
      const p214 = checkPixel(214, y);
      const p426 = checkPixel(426, y);
      const p427 = checkPixel(427, y);
      const p639 = checkPixel(texW - 1, y);
      console.log(`Row ${y}: x=0(${p0.r},${p0.g},${p0.b}) x=213(${p213.r},${p213.g},${p213.b}) x=214(${p214.r},${p214.g},${p214.b}) x=426(${p426.r},${p426.g},${p426.b}) x=427(${p427.r},${p427.g},${p427.b}) x=${texW-1}(${p639.r},${p639.g},${p639.b})`);
    }

    // Verify blue stripe
    expect(bluePixel.r).toBe(0);
    expect(bluePixel.g).toBe(0);
    expect(bluePixel.b).toBe(255);

    // Verify white stripe
    expect(whitePixel.r).toBe(255);
    expect(whitePixel.g).toBe(255);
    expect(whitePixel.b).toBe(255);

    // Verify red stripe
    expect(redPixel.r).toBe(255);
    expect(redPixel.g).toBe(0);
    expect(redPixel.b).toBe(0);
  });
});
