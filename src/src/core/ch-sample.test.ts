import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compileCube } from './cube';
import { GA144 } from './ga144';
import { ROM_DATA } from './rom-data';
import { buildBootStream } from './bootstream';
import { detectResolution, taggedCoord, readIoWrite, isHsync, isVsync } from '../ui/emulator/vgaResolution';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const samplePath = join(__dirname, '../../samples/CH.cube');

describe('CH.cube Swiss flag sample', () => {
  it('compiles without errors', () => {
    const source = readFileSync(samplePath, 'utf-8');
    const result = compileCube(source);
    expect(result.errors).toHaveLength(0);
    expect(result.nodes.length).toBe(7);

    const coords = result.nodes.map(n => n.coord).sort((a, b) => a - b);
    expect(coords).toEqual([116, 117, 217, 616, 617, 716, 717]);
  });

  it('all nodes fit within 64-word RAM limit', () => {
    const source = readFileSync(samplePath, 'utf-8');
    const result = compileCube(source);
    expect(result.errors).toHaveLength(0);
    for (const node of result.nodes) {
      expect(node.len, `node ${node.coord} exceeds 64 words`).toBeLessThanOrEqual(64);
    }
  });

  it('produces correct VGA output via boot stream', { timeout: 120_000 }, () => {
    const source = readFileSync(samplePath, 'utf-8');
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const boot = buildBootStream(compiled.nodes);
    console.log(`Boot stream: ${boot.words.length} words, path: ${boot.path.length} nodes, wire: ${boot.wireNodes.length}`);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.loadViaBootStream(buildBootStream(compiled.nodes).bytes);
    ga.stepUntilDone(50_000_000);
    const snap = ga.getSnapshot();

    const counts = new Map<number, number>();
    let hsyncCount = 0, vsyncCount = 0;
    for (let i = 0; i < snap.ioWriteCount; i++) {
      const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
      const coord = taggedCoord(tagged);
      counts.set(coord, (counts.get(coord) ?? 0) + 1);
      if (isHsync(tagged)) hsyncCount++;
      if (isVsync(tagged)) vsyncCount++;
    }
    console.log('IO write counts:', Object.fromEntries(counts));
    console.log(`HSYNC: ${hsyncCount}, VSYNC: ${vsyncCount}`);

    const res = detectResolution(snap.ioWrites, snap.ioWriteCount, snap.ioWriteStart, snap.ioWriteTimestamps);
    console.log('Resolution:', res);

    expect(res.hasSyncSignals).toBe(true);
    expect(res.width).toBe(640);
    expect(res.height).toBe(480);
  });
});
