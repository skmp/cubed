import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compileCube } from './cube';
import { GA144 } from './ga144';
import { SerialBits } from './serial';
import { ROM_DATA } from './rom-data';
import { buildBootStream } from './bootstream';

import { ResolutionTracker } from '../ui/emulator/vgaResolution';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const samplePath = join(__dirname, '../../samples/CH.cube');

/** Boot and run a GA144 with the CH.cube program, processing IO writes
 *  incrementally to avoid ring buffer overflow. Returns after the first
 *  complete frame is detected or MAX_STEPS is reached. */
function bootAndDetect(ga: GA144, compiled: ReturnType<typeof compileCube>) {
  ga.setRomData(ROM_DATA);
  ga.reset();
  ga.enqueueSerialBits(708, SerialBits.bootStreamBits(
    Array.from(buildBootStream(compiled.nodes).bytes), GA144.BOOT_BAUD));

  const tracker = new ResolutionTracker();
  const CHUNK = 500_000;
  const MAX_STEPS = 50_000_000;
  for (let stepped = 0; stepped < MAX_STEPS; stepped += CHUNK) {
    ga.stepUntilDone(CHUNK);
    const s = ga.getSnapshot();
    tracker.process(s.ioWrites, s.ioWriteCount, s.ioWriteStart, s.ioWriteSeq, s.ioWriteTimestamps);
    if (tracker.complete) break;
  }
  return tracker.getResolution();
}

describe('CH.cube Swiss flag sample', () => {
  it('compiles without errors', () => {
    const source = readFileSync(samplePath, 'utf-8');
    const result = compileCube(source);
    for (const e of result.errors) console.log(`  ${e.line}:${e.col} ${e.message}`);
    expect(result.errors).toHaveLength(0);
    expect(result.nodes.length).toBe(12);

    const coords = result.nodes.map(n => n.coord).sort((a, b) => a - b);
    expect(coords).toEqual([116, 117, 217, 317, 417, 517, 615, 616, 617, 715, 716, 717]);
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

    const ga = new GA144('test');
    const res = bootAndDetect(ga, compiled);
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
    ga.enqueueSerialBits(708, SerialBits.bootStreamBits(
      Array.from(buildBootStream(compiled.nodes).bytes), GA144.BOOT_BAUD));

    // Mimic the worker run loop: step in 50K chunks, check active count,
    // advance idle time when all nodes suspended (like the worker does)
    const tracker = new ResolutionTracker();
    const CHUNK = 500_000;
    const MAX_CHUNKS = 100; // 50M steps max
    let totalIdleAdvances = 0;
    let consecutiveIdle = 0;
    for (let c = 0; c < MAX_CHUNKS; c++) {
      ga.stepProgramN(CHUNK);
      const s = ga.getSnapshot();
      tracker.process(s.ioWrites, s.ioWriteCount, s.ioWriteStart, s.ioWriteSeq, s.ioWriteTimestamps);
      if (ga.getActiveCount() === 0) {
        ga.advanceIdleTime(50 * 1e6); // 50ms in ns, like the worker
        totalIdleAdvances++;
        consecutiveIdle++;
        if (consecutiveIdle > 5) break;
      } else {
        consecutiveIdle = 0;
      }
      if (tracker.complete) break;
    }

    const res = tracker.getResolution();
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
    ga.enqueueSerialBits(708, SerialBits.bootStreamBits(
      Array.from(buildBootStream(compiled.nodes).bytes), GA144.BOOT_BAUD));

    // Second load (like auto-compile debounce firing again)
    ga.reset();
    ga.enqueueSerialBits(708, SerialBits.bootStreamBits(
      Array.from(buildBootStream(compiled.nodes).bytes), GA144.BOOT_BAUD));

    // Process incrementally after the double-load
    const tracker = new ResolutionTracker();
    const CHUNK = 500_000;
    const MAX_STEPS = 50_000_000;
    for (let stepped = 0; stepped < MAX_STEPS; stepped += CHUNK) {
      ga.stepUntilDone(CHUNK);
      const s = ga.getSnapshot();
      tracker.process(s.ioWrites, s.ioWriteCount, s.ioWriteStart, s.ioWriteSeq, s.ioWriteTimestamps);
      if (tracker.complete) break;
    }

    const res = tracker.getResolution();
    console.log('Double-load resolution:', res);

    expect(res.hasSyncSignals).toBe(true);
    expect(res.width).toBe(640);
    expect(res.height).toBe(480);
  });
});
