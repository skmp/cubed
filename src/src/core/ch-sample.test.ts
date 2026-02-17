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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const samplePath = join(__dirname, '../../samples/CH.cube');
const source = readFileSync(samplePath, 'utf-8');


describe('CH.cube Swiss flag sample', () => {
  // Share simulation across tests to avoid running 50M steps multiple times
  let snap: GA144Snapshot;
  let ga: GA144;

  beforeAll(() => {
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);
    ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.load(compiled);
    ga.stepUntilDone(50_000_000);
    snap = ga.getSnapshot();
  }, 300_000);

  it('compiles without errors', () => {
    const result = compileCube(source);
    expect(result.errors).toHaveLength(0);
    expect(result.nodes.length).toBe(4);

    const coords = result.nodes.map(n => n.coord).sort((a, b) => a - b);
    expect(coords).toEqual([117, 217, 617, 717]);
  });

  it('produces IO writes from all 4 nodes including sync signals', () => {
    const ioCount = snap.ioWriteCount;
    expect(ioCount).toBeGreaterThan(0);

    // Count signals by type
    let rCount = 0, gCount = 0, bCount = 0, hsyncCount = 0, vsyncCount = 0;
    const coordCounts = new Map<number, number>();
    for (let i = 0; i < ioCount; i++) {
      const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
      const coord = taggedCoord(tagged);
      coordCounts.set(coord, (coordCounts.get(coord) || 0) + 1);
      if (coord === VGA_NODE_R) rCount++;
      else if (coord === VGA_NODE_G) gCount++;
      else if (coord === VGA_NODE_B) bCount++;
      else if (isVsync(tagged)) vsyncCount++;
      else if (isHsync(tagged)) hsyncCount++;
    }

    console.log('IO writes:', ioCount, 'R:', rCount, 'G:', gCount, 'B:', bCount,
      'hsync:', hsyncCount, 'vsync:', vsyncCount);
    console.log('All coords:', Object.fromEntries(coordCounts));

    // Each DAC channel produces exactly 480*640 = 307200 pixel writes per frame.
    // The total pixel count is exact even though HSYNC timing drifts slightly.
    expect(rCount).toBe(480 * 640);
    expect(gCount).toBe(480 * 640);
    expect(bCount).toBe(480 * 640);

    // Sync node should produce HSYNC and VSYNC signals
    expect(hsyncCount).toBeGreaterThan(0);
    expect(vsyncCount).toBeGreaterThan(0);
  });

  it('detects approximately 640x480 resolution from sync signals', () => {
    const res = detectResolution(
      snap.ioWrites,
      snap.ioWriteCount,
      snap.ioWriteStart,
      snap.ioWriteTimestamps,
    );
    expect(res.hasSyncSignals).toBe(true);
    // With timestamp-based HSYNC deferral, the resolution should be exact
    // when HSYNC and the last R write of each row share the same global step.
    // Allow ±2 for timing granularity.
    expect(res.width).toBeGreaterThanOrEqual(638);
    expect(res.width).toBeLessThanOrEqual(642);
    expect(res.height).toBeGreaterThanOrEqual(479);
    expect(res.height).toBeLessThanOrEqual(481);
  });

  it('renders correct simplified Swiss flag colors', () => {
    // Verify pixel data by checking DAC value distributions per channel.
    // Due to timing drift between sync and DAC nodes (~2 steps/row), HSYNC-
    // delimited rows have variable widths which causes cumulative spatial skew.
    // Instead of checking pixel positions in decoded rows, we verify that
    // each channel outputs the correct total count of each DAC value.
    //
    // CH.cube Swiss flag layout (640x480):
    //   R channel (node 117): max for 256x256 flag area, zero elsewhere
    //   G channel (node 617): max for 160x64 white bar only, zero elsewhere
    //   B channel (node 717): same as G
    //
    // Expected per-channel pixel counts:
    //   R max: 256 rows * 256 px = 65536
    //   G max: 64 rows * 160 px = 10240
    //   B max: 64 rows * 160 px = 10240

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

    // No intermediate DAC values — only 0 (off) and 0x1FF (max)
    expect(rOther).toBe(0);
    expect(gOther).toBe(0);
    expect(bOther).toBe(0);

    // Total pixel count per channel
    expect(rZero + rMax).toBe(480 * 640);
    expect(gZero + gMax).toBe(480 * 640);
    expect(bZero + bMax).toBe(480 * 640);

    // R channel: 256 rows * 256 pixels = 65536 max pixels
    expect(rMax).toBe(256 * 256);
    expect(rZero).toBe(480 * 640 - 256 * 256);

    // G channel: 64 rows * 160 pixels = 10240 max pixels
    expect(gMax).toBe(64 * 160);
    expect(gZero).toBe(480 * 640 - 64 * 160);

    // B channel: same as G (white bar only)
    expect(bMax).toBe(64 * 160);
    expect(bZero).toBe(480 * 640 - 64 * 160);
  });

  it('node 217 produces sync writes to IO register', () => {
    // Check node 217 state — should have written to IO register
    const nodeSnap = ga.getSnapshot(217);
    expect(nodeSnap.selectedNode).toBeDefined();
    // Node 217 should have produced VSYNC (0x30000) as its last IO write
    expect(nodeSnap.selectedNode!.registers.IO).toBe(0x30000);
  });
});
