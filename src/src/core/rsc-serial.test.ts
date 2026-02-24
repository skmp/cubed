/**
 * RSC sample end-to-end test: compile RSC.cube, boot via serial,
 * and validate that the continuous async serial TX on node 708 produces
 * correctly-structured Shor's factoring results.
 *
 * Pipeline: noise(508) → shor15(608) → asynctx(708) → IO writes
 *
 * shor15 outputs 5 values per result: [N=15, a, r, p, q]
 * asynctx tags each data write with bit 17 (0x20000) so we can
 * distinguish them from serial drive bits (values 2/3).
 *
 * Uses loadViaBootStream() which exercises the real serial boot path:
 *   compiled nodes → boot stream → serial bits on 708 pin17 → boot ROM RX → mesh relay
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GA144 } from './ga144';
import { ROM_DATA } from './rom-data';
import { compileCube } from './cube';
import { readIoWrite, taggedCoord, taggedValue } from '../ui/emulator/vgaResolution';
import { buildBootStream } from './bootstream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// asynctx{} tags data writes with bit 17 to distinguish from serial drive bits
const ASYNCTX_DATA_TAG = 0x20000;

/**
 * Extract asynctx-tagged data values from node 708's IO writes.
 * Filters out serial drive bits (untagged values 0–3) and returns
 * the actual data values in chronological order.
 */
function extractSerialData(snap: {
  ioWrites: number[];
  ioWriteStart: number;
  ioWriteCount: number;
}): number[] {
  const values: number[] = [];
  for (let i = 0; i < snap.ioWriteCount; i++) {
    const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
    const coord = taggedCoord(tagged);
    if (coord !== 708) continue;
    const raw = taggedValue(tagged);
    // asynctx tags data with bit 17; drive bits are untagged (0–3)
    if (raw & ASYNCTX_DATA_TAG) {
      values.push(raw & ~ASYNCTX_DATA_TAG);
    }
  }
  return values;
}

/**
 * Group a flat array of serial data values into 5-element result tuples.
 * Returns complete groups only (trailing partial group is discarded).
 */
function groupResults(data: number[]): number[][] {
  const groups: number[][] = [];
  for (let i = 0; i + 5 <= data.length; i += 5) {
    groups.push(data.slice(i, i + 5));
  }
  return groups;
}

describe('RSC sample: continuous serial TX', () => {

  it('RSC.cube compiles all 7 nodes without errors', () => {
    const source = readFileSync(join(__dirname, '../../samples/RSC.cube'), 'utf-8');
    const compiled = compileCube(source);
    if (compiled.errors.length > 0) {
      console.log('Errors:', compiled.errors);
    }
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.nodes.length).toBe(7);

    const expectedCoords = new Set([117, 617, 717, 217, 508, 608, 708]);
    for (const node of compiled.nodes) {
      expect(expectedCoords.has(node.coord), `unexpected node ${node.coord}`).toBe(true);
      expect(node.len).toBeLessThanOrEqual(64);
    }
  });

  it('minimal pipeline (508→608→708) boots and produces serial output', { timeout: 60_000 }, () => {
    // Test just the 3 pipeline nodes to isolate boot relay issues
    const source = [
      '#include std',
      '',
      'node 508',
      '/\\',
      'x = 0',
      '/\\',
      'std.loop{n=32767}',
      '/\\ std.plus{a=x, b=1, c=x}',
      '/\\ std.send{port=0x145, value=x}',
      '/\\ std.again{}',
      '',
      'node 608',
      '/\\',
      'std.shor15{noise_port=0x145, out_port=0x115}',
      '',
      'node 708',
      '/\\',
      'std.asynctx{port=0x115}',
    ].join('\n') + '\n';

    // Also test simpler 2-node case to isolate
    const source2 = [
      '#include std',
      'node 608',
      '/\\',
      'std.shor15{noise_port=0x145, out_port=0x115}',
      'node 708',
      '/\\',
      'std.asynctx{port=0x115}',
    ].join('\n') + '\n';
    const compiled2 = compileCube(source2);
    expect(compiled2.errors).toHaveLength(0);
    const boot2 = buildBootStream(compiled2.nodes);
    console.log(`2-node boot stream: ${boot2.words.length} words, path: ${boot2.path.length} nodes, wire: ${boot2.wireNodes.length}`);

    const ga2 = new GA144('test2');
    ga2.setRomData(ROM_DATA);
    ga2.reset();
    ga2.loadViaBootStream(compiled2);
    for (const coord of [608, 708]) {
      const ns = ga2.getSnapshot(coord).selectedNode!;
      console.log(
        `2-node post-boot ${coord}: P=0x${ns.registers.P.toString(16)} ` +
        `state=${ns.state} B=0x${ns.registers.B.toString(16)} A=0x${ns.registers.A.toString(16)}`
      );
    }

    const compiled = compileCube(source);
    if (compiled.errors.length > 0) console.log('Errors:', compiled.errors);
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.nodes.length).toBe(3);

    // Diagnostic: check boot stream structure
    const boot = buildBootStream(compiled.nodes);
    console.log(`Boot stream: ${boot.words.length} words, path: ${boot.path.length} nodes, wire: ${boot.wireNodes.length}`);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.loadViaBootStream(compiled);

    // Check if nodes loaded correctly after boot
    for (const coord of [508, 608, 708]) {
      const ns = ga.getSnapshot(coord).selectedNode!;
      console.log(
        `post-boot ${coord}: P=0x${ns.registers.P.toString(16)} ` +
        `state=${ns.state} B=0x${ns.registers.B.toString(16)} A=0x${ns.registers.A.toString(16)}`
      );
    }

    ga.stepUntilDone(500_000);

    const snap = ga.getSnapshot();
    const serialData = extractSerialData(snap);
    const results = groupResults(serialData);

    console.log(`Serial data: ${serialData.length} values, ${results.length} complete results`);
    for (const [i, r] of results.entries()) {
      console.log(`  result[${i}]: N=${r[0]} a=${r[1]} r=${r[2]} p=${r[3]} q=${r[4]}`);
    }

    expect(results.length).toBeGreaterThanOrEqual(1);

    for (const [N, a, r, p, q] of results) {
      expect(N).toBe(15);
      expect(a).toBeGreaterThanOrEqual(2);
      expect(a).toBeLessThanOrEqual(9);
      expect([2, 4]).toContain(r);
      expect(p * q).toBe(15);
      expect(new Set([p, q])).toEqual(new Set([3, 5]));
    }
  });

  it('full RSC.cube: serial boot and continuous serial output', { timeout: 60_000 }, () => {
    const source = readFileSync(join(__dirname, '../../samples/RSC.cube'), 'utf-8');
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.loadViaBootStream(compiled);

    ga.stepUntilDone(2_000_000);

    const snap = ga.getSnapshot();
    const serialData = extractSerialData(snap);
    const results = groupResults(serialData);

    console.log(`Serial data: ${serialData.length} values, ${results.length} complete results`);
    expect(results.length).toBeGreaterThanOrEqual(3);

    for (const [N, a, r, p, q] of results) {
      expect(N).toBe(15);
      expect(a).toBeGreaterThanOrEqual(2);
      expect(a).toBeLessThanOrEqual(9);
      expect([2, 4]).toContain(r);
      expect(p * q).toBe(15);
      expect(new Set([p, q])).toEqual(new Set([3, 5]));
    }
  });
});
