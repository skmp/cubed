import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GA144 } from './ga144';
import { ROM_DATA } from './rom-data';
import { compileCube } from './cube';
import { VGA_NODE_R, VGA_NODE_G, VGA_NODE_B } from './constants';
import {
  readIoWrite,
  taggedCoord,
  taggedValue,
  decodeDac,
  isVsync,
  isHsync,
  detectResolution,
} from '../ui/emulator/vgaResolution';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const samplePath = join(__dirname, '../../samples/CH.cube');
const source = readFileSync(samplePath, 'utf-8');

/** Decode a full frame of VGA output into an RGB pixel array. */
function decodeFrame(snap: {
  ioWrites: number[];
  ioWriteStart: number;
  ioWriteCount: number;
}): { r: number; g: number; b: number }[][] {
  const rows: { r: number; g: number; b: number }[][] = [];
  let currentRow: { r: number; g: number; b: number }[] = [];
  let pendingR = 0, pendingG = 0, pendingB = 0;

  for (let i = 0; i < snap.ioWriteCount; i++) {
    const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);

    if (isVsync(tagged)) {
      if (currentRow.length > 0) rows.push(currentRow);
      currentRow = [];
      continue;
    }
    if (isHsync(tagged)) {
      if (currentRow.length > 0) {
        rows.push(currentRow);
        currentRow = [];
      }
      continue;
    }

    const coord = taggedCoord(tagged);
    const val = taggedValue(tagged);

    if (coord === VGA_NODE_R) {
      pendingR = decodeDac(val);
    } else if (coord === VGA_NODE_G) {
      pendingG = decodeDac(val);
    } else if (coord === VGA_NODE_B) {
      pendingB = decodeDac(val);
    } else {
      continue;
    }

    // Emit pixel on R write (R is timing master)
    if (coord === VGA_NODE_R) {
      currentRow.push({ r: pendingR, g: pendingG, b: pendingB });
    }
  }

  return rows;
}

describe('CH.cube Swiss flag sample', () => {
  it('compiles without errors', () => {
    const result = compileCube(source);
    expect(result.errors).toHaveLength(0);
    expect(result.nodes.length).toBe(4);

    const coords = result.nodes.map(n => n.coord).sort((a, b) => a - b);
    expect(coords).toEqual([117, 217, 617, 717]);
  });

  it('produces IO writes from all 4 nodes including sync signals', () => {
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.load(compiled);
    ga.stepUntilDone(50_000_000);

    const snap = ga.getSnapshot();
    const ioCount = snap.ioWriteCount;

    // We should have IO writes
    expect(ioCount).toBeGreaterThan(0);

    // Count signals by type
    let rCount = 0, gCount = 0, bCount = 0, hsyncCount = 0, vsyncCount = 0;
    for (let i = 0; i < ioCount; i++) {
      const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
      const coord = taggedCoord(tagged);
      if (coord === VGA_NODE_R) rCount++;
      else if (coord === VGA_NODE_G) gCount++;
      else if (coord === VGA_NODE_B) bCount++;
      else if (isVsync(tagged)) vsyncCount++;
      else if (isHsync(tagged)) hsyncCount++;
    }

    // Each DAC channel should produce pixel writes
    expect(rCount).toBeGreaterThan(0);
    expect(gCount).toBeGreaterThan(0);
    expect(bCount).toBeGreaterThan(0);

    // Sync node should produce HSYNC and VSYNC signals
    expect(hsyncCount).toBeGreaterThan(0);
    expect(vsyncCount).toBeGreaterThan(0);
  });

  it('detects correct 640x480 resolution from sync signals', () => {
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.load(compiled);
    ga.stepUntilDone(50_000_000);

    const snap = ga.getSnapshot();
    const res = detectResolution(
      snap.ioWrites,
      snap.ioWriteCount,
      snap.ioWriteStart,
    );
    expect(res.hasSyncSignals).toBe(true);
    expect(res.width).toBe(640);
    expect(res.height).toBe(480);
  });

  it('renders correct simplified Swiss flag colors', () => {
    const compiled = compileCube(source);
    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.load(compiled);
    ga.stepUntilDone(50_000_000);

    const snap = ga.getSnapshot();
    const rows = decodeFrame(snap);

    // Should have 480 rows
    expect(rows.length).toBe(480);
    // Each row should have 640 pixels
    expect(rows[0].length).toBe(640);

    // Helper: check a pixel is a given color (9-bit DAC: 0=off, 0x1FF=max)
    const isBlack = (p: { r: number; g: number; b: number }) =>
      p.r === 0 && p.g === 0 && p.b === 0;
    const isRed = (p: { r: number; g: number; b: number }) =>
      p.r === 0x1FF && p.g === 0 && p.b === 0;
    const isWhite = (p: { r: number; g: number; b: number }) =>
      p.r === 0x1FF && p.g === 0x1FF && p.b === 0x1FF;

    // --- Row 0 (black margin) ---
    expect(isBlack(rows[0][0])).toBe(true);
    expect(isBlack(rows[0][320])).toBe(true);

    // --- Row 130 (red-only flag area, no bar) ---
    expect(isBlack(rows[130][0])).toBe(true);
    expect(isBlack(rows[130][191])).toBe(true);
    expect(isRed(rows[130][192])).toBe(true);
    expect(isRed(rows[130][320])).toBe(true);
    expect(isRed(rows[130][447])).toBe(true);
    expect(isBlack(rows[130][448])).toBe(true);

    // --- Row 240 (white bar center) ---
    // 192 black + 48 red + 160 white + 48 red + 192 black
    expect(isBlack(rows[240][0])).toBe(true);
    expect(isRed(rows[240][192])).toBe(true);
    expect(isRed(rows[240][239])).toBe(true);
    expect(isWhite(rows[240][240])).toBe(true);
    expect(isWhite(rows[240][320])).toBe(true);
    expect(isWhite(rows[240][399])).toBe(true);
    expect(isRed(rows[240][400])).toBe(true);
    expect(isRed(rows[240][447])).toBe(true);
    expect(isBlack(rows[240][448])).toBe(true);

    // --- Row 450 (black margin below flag) ---
    expect(isBlack(rows[450][0])).toBe(true);
    expect(isBlack(rows[450][320])).toBe(true);
  });

  it('node 217 produces sync writes to IO register', () => {
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.load(compiled);
    ga.stepUntilDone(50_000_000);

    // Check node 217 state — should have written to IO register
    const snap = ga.getSnapshot(217);
    expect(snap.selectedNode).toBeDefined();
    // Node 217 should have produced some IO writes (HSYNC/VSYNC)
    // Its IO register should reflect the last write (VSYNC = 0x30000)
    expect(snap.selectedNode!.registers.IO).toBe(0x30000);
  });
});
