import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compileCube } from './cube';
import { GA144 } from './ga144';
import { SerialBits } from './serial';
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
    ga.enqueueSerialBits(708, SerialBits.bootStreamBits(Array.from(buildBootStream(compiled.nodes).bytes), GA144.BOOT_BAUD));
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

  it('produces VGA output with chunked stepping (UI-like)', { timeout: 120_000 }, () => {
    const source = readFileSync(samplePath, 'utf-8');
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.enqueueSerialBits(708, SerialBits.bootStreamBits(Array.from(buildBootStream(compiled.nodes).bytes), GA144.BOOT_BAUD));

    // Mimic the worker run loop: step in 50K chunks, check active count,
    // advance idle time when all nodes suspended (like the worker does)
    const CHUNK = 50_000;
    const MAX_CHUNKS = 1000; // 50M steps max
    let totalIdleAdvances = 0;
    let consecutiveIdle = 0;
    for (let c = 0; c < MAX_CHUNKS; c++) {
      ga.stepProgramN(CHUNK);
      if (ga.getActiveCount() === 0) {
        ga.advanceIdleTime(50 * 1e6); // 50ms in ns, like the worker
        totalIdleAdvances++;
        consecutiveIdle++;
        if (consecutiveIdle > 5) {
          console.log(`Deadlock after chunk ${c}, totalSteps=${ga.getTotalSteps()}, idle advances=${totalIdleAdvances}`);
          break;
        }
      } else {
        consecutiveIdle = 0;
      }
    }

    const snap = ga.getSnapshot();
    const res = detectResolution(snap.ioWrites, snap.ioWriteCount, snap.ioWriteStart, snap.ioWriteTimestamps);
    console.log('Chunked resolution:', res, 'total idle advances:', totalIdleAdvances);

    expect(res.hasSyncSignals).toBe(true);
    expect(res.width).toBe(640);
    expect(res.height).toBe(480);
  });

  it('works after double load (reset + enqueueSerialBits twice)', { timeout: 120_000 }, () => {
    const source = readFileSync(samplePath, 'utf-8');
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();

    // First load (like initial page load auto-compile)
    ga.enqueueSerialBits(708, SerialBits.bootStreamBits(Array.from(buildBootStream(compiled.nodes).bytes), GA144.BOOT_BAUD));

    // Second load (like auto-compile debounce firing again)
    ga.reset();
    ga.enqueueSerialBits(708, SerialBits.bootStreamBits(Array.from(buildBootStream(compiled.nodes).bytes), GA144.BOOT_BAUD));

    ga.stepUntilDone(50_000_000);
    const snap = ga.getSnapshot();
    const res = detectResolution(snap.ioWrites, snap.ioWriteCount, snap.ioWriteStart, snap.ioWriteTimestamps);
    console.log('Double-load resolution:', res);

    expect(res.hasSyncSignals).toBe(true);
    expect(res.width).toBe(640);
    expect(res.height).toBe(480);
  });
});
