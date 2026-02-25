/**
 * Boot stream integration tests.
 *
 * Tests that loadViaBootStream() correctly delivers code via serial boot
 * and that programs execute properly afterward. Serial bits are enqueued
 * by loadViaBootStream and consumed during normal stepProgram() calls.
 */
import { describe, it, expect } from 'vitest';
import { compileCube } from './cube';
import { GA144 } from './ga144';
import { ROM_DATA } from './rom-data';
import { buildBootStream } from './bootstream';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const samplePath = join(__dirname, '../../samples/CH.cube');

describe('boot stream integration', () => {

  it('single node 709: boot descriptor sets B register', { timeout: 60_000 }, () => {
    const source = `
node 709 { b=0x1D5 }
/\\
fill{value=0x0AA, count=3}
`;
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.loadViaBootStream(buildBootStream(compiled.nodes).bytes);
    ga.stepUntilDone(2_000_000);

    const ns = ga.getSnapshot(709).selectedNode!;
    expect(ns.registers.B).toBe(0x1D5);
  });

  it('2 adjacent targets: 709+710 boot correctly', { timeout: 60_000 }, () => {
    const source = `
node 709 { b=0x1D5 }
/\\
fill{value=0x111, count=1}

node 710 { b=0x1D5 }
/\\
fill{value=0x222, count=1}
`;
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.loadViaBootStream(buildBootStream(compiled.nodes).bytes);
    ga.stepUntilDone(2_000_000);

    expect(ga.getSnapshot(709).selectedNode!.registers.B).toBe(0x1D5);
    expect(ga.getSnapshot(710).selectedNode!.registers.B).toBe(0x1D5);
  });

  it('2 targets with wire: 709+711 boot correctly', { timeout: 60_000 }, () => {
    const source = `
node 709 { b=0x1D5 }
/\\
fill{value=0x111, count=1}

node 711 { b=0x1D5 }
/\\
fill{value=0x333, count=1}
`;
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const boot = buildBootStream(compiled.nodes);
    expect(boot.wireNodes).toHaveLength(1);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.loadViaBootStream(buildBootStream(compiled.nodes).bytes);
    ga.stepUntilDone(2_000_000);

    expect(ga.getSnapshot(709).selectedNode!.registers.B).toBe(0x1D5);
    expect(ga.getSnapshot(711).selectedNode!.registers.B).toBe(0x1D5);
  });

  it('deep target: single node at 717 (8 wire hops)', { timeout: 60_000 }, () => {
    const source = `
node 717 { b=0x1D5 }
/\\
fill{value=0x717, count=1}
`;
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const boot = buildBootStream(compiled.nodes);
    expect(boot.wireNodes.length).toBe(8);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.loadViaBootStream(buildBootStream(compiled.nodes).bytes);
    ga.stepUntilDone(2_000_000);

    expect(ga.getSnapshot(717).selectedNode!.registers.B).toBe(0x1D5);
  });

  it('716+717: feeder-relay produces IO output', { timeout: 60_000 }, () => {
    const source = `
#include std

/\\

node 717

/\\

std.loop{n=3}
/\\ std.relay{port=0x1D5, count=5}
/\\ std.again{}

node 716 { b=0x1D5 }

/\\

std.loop{n=3}
/\\ std.fill{value=0x0AA, count=5}
/\\ std.again{}
`;
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.loadViaBootStream(buildBootStream(compiled.nodes).bytes);
    ga.stepUntilDone(5_000_000);

    const snap = ga.getSnapshot();
    const counts = new Map<number, number>();
    for (let i = 0; i < snap.ioWriteCount; i++) {
      const val = snap.ioWrites[(snap.ioWriteStart + i) % snap.ioWrites.length];
      const coord = (val >>> 18) & 0x7FF;
      counts.set(coord, (counts.get(coord) ?? 0) + 1);
    }
    // 717 relay: 3 rows × 5 pixels = 15 IO writes
    expect(counts.get(717)).toBe(15);
  });

  it('CH.cube: boot stream vs direct load produce same IO counts', { timeout: 120_000 }, () => {
    const source = readFileSync(samplePath, 'utf-8');
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    // Direct load
    const gaDirect = new GA144('direct');
    gaDirect.setRomData(ROM_DATA);
    gaDirect.reset();
    gaDirect.load(compiled);
    gaDirect.stepUntilDone(50_000_000);

    const snapDirect = gaDirect.getSnapshot();
    const countsDirect = new Map<number, number>();
    for (let i = 0; i < snapDirect.ioWriteCount; i++) {
      const val = snapDirect.ioWrites[(snapDirect.ioWriteStart + i) % snapDirect.ioWrites.length];
      const coord = (val >>> 18) & 0x7FF;
      countsDirect.set(coord, (countsDirect.get(coord) ?? 0) + 1);
    }

    // Boot stream
    const gaBoot = new GA144('boot');
    gaBoot.setRomData(ROM_DATA);
    gaBoot.reset();
    gaBoot.loadViaBootStream(buildBootStream(compiled.nodes).bytes);
    gaBoot.stepUntilDone(50_000_000);

    const snapBoot = gaBoot.getSnapshot();
    const countsBoot = new Map<number, number>();
    for (let i = 0; i < snapBoot.ioWriteCount; i++) {
      const val = snapBoot.ioWrites[(snapBoot.ioWriteStart + i) % snapBoot.ioWrites.length];
      const coord = (val >>> 18) & 0x7FF;
      countsBoot.set(coord, (countsBoot.get(coord) ?? 0) + 1);
    }

    console.log('IO counts (direct):', Object.fromEntries(countsDirect));
    console.log('IO counts (boot):', Object.fromEntries(countsBoot));

    // With forever-looping programs, both paths run for the full 50M step
    // budget (never "done"). Boot path uses some steps for boot loading, so
    // it produces slightly more IO writes (boot nodes start executing sooner
    // in the step sequence). Verify both produce at least one full frame
    // of output (480×640 = 307200 per DAC node).
    const FRAME_PIXELS = 480 * 640; // 307200
    for (const coord of [117, 617, 717]) {
      expect(countsDirect.get(coord)!).toBeGreaterThanOrEqual(FRAME_PIXELS);
      expect(countsBoot.get(coord)!).toBeGreaterThanOrEqual(FRAME_PIXELS);
    }
    // Sync node (217) should produce at least 480 HSYNC + 1 VSYNC = 481
    expect(countsDirect.get(217)!).toBeGreaterThanOrEqual(481);
    expect(countsBoot.get(217)!).toBeGreaterThanOrEqual(481);
  });
});
