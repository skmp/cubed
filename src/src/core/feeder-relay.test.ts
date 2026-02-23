import { describe, it, expect } from 'vitest';
import { GA144 } from './ga144';
import { ROM_DATA } from './rom-data';
import { compileCube } from './cube';
import {
  readIoWrite,
  taggedCoord,
  taggedValue,
} from '../ui/emulator/vgaResolution';

function runCube(source: string, maxSteps = 10_000) {
  const compiled = compileCube(source);
  expect(compiled.errors).toHaveLength(0);
  const ga = new GA144('test');
  ga.setRomData(ROM_DATA);
  ga.reset();
  ga.loadViaBootStream(compiled);
  ga.stepUntilDone(maxSteps);
  return { ga, snap: ga.getSnapshot() };
}

function ioWritesByCoord(snap: { ioWrites: number[]; ioWriteStart: number; ioWriteCount: number }) {
  const map = new Map<number, number[]>();
  for (let i = 0; i < snap.ioWriteCount; i++) {
    const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
    const coord = taggedCoord(tagged);
    const val = taggedValue(tagged);
    if (!map.has(coord)) map.set(coord, []);
    map.get(coord)!.push(val);
  }
  return map;
}

describe('CUBE compilation', () => {
  it('compiles setb without errors', () => {
    const compiled = compileCube(`node 117\n/\\\nsetb{addr=0x1D5}\n`);
    expect(compiled.errors).toHaveLength(0);
  });

  it('compiles relay without errors', () => {
    const compiled = compileCube(`node 117\n/\\\nrelay{port=0x1D5, count=10}\n`);
    expect(compiled.errors).toHaveLength(0);
  });

  it('compiles fill without errors', () => {
    const compiled = compileCube(`node 117\n/\\\nfill{value=0x0AA, count=5}\n`);
    expect(compiled.errors).toHaveLength(0);
  });

  it('compiles multi-node feeder+relay without errors', () => {
    const source = `
node 116
/\\
setb{addr=0x1D5}
/\\
fill{value=0x0AA, count=5}

node 117
/\\
relay{port=0x1D5, count=5}
`;
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.nodes).toHaveLength(2);
  });
});

describe('single-node fill to IO', () => {
  it('fill writes correct count to IO', () => {
    // Node 117 fills 5 values directly to IO (B defaults to 0x15D)
    const { snap } = runCube(`node 117\n/\\\nfill{value=0x0AA, count=5}\n`);
    const writes = ioWritesByCoord(snap);
    const node117 = writes.get(117) ?? [];
    expect(node117.length).toBe(5);
    for (const v of node117) {
      expect(v).toBe(0x0AA);
    }
  });

  it('fill with count=1 writes exactly 1 value', () => {
    const { snap } = runCube(`node 117\n/\\\nfill{value=0x155, count=1}\n`);
    const writes = ioWritesByCoord(snap);
    expect(writes.get(117)?.length).toBe(1);
  });
});

describe('feeder→relay inter-node communication', () => {
  it('relay receives values from feeder and writes to IO', () => {
    const source = `
node 116
/\\
setb{addr=0x1D5}
/\\
fill{value=0x0AA, count=5}

node 117
/\\
relay{port=0x1D5, count=5}
`;
    const { snap } = runCube(source, 10_000);
    const writes = ioWritesByCoord(snap);
    const node117 = writes.get(117) ?? [];
    // Relay should produce IO writes; exact count depends on boot init
    // Just verify we get at least the expected fill count
    expect(node117.length).toBeGreaterThanOrEqual(5);
    // All relay writes should be the fill value
    const fillValues = node117.filter(v => v === 0x0AA);
    expect(fillValues.length).toBe(5);
  });

  it('feeder (node 116) does not produce IO writes when B=port', () => {
    const source = `
node 116
/\\
setb{addr=0x1D5}
/\\
fill{value=0x0AA, count=5}

node 117
/\\
relay{port=0x1D5, count=5}
`;
    const { snap } = runCube(source, 10_000);
    const writes = ioWritesByCoord(snap);
    // Node 116 writes to port, not IO — so no IO writes from 116
    expect(writes.get(116)).toBeUndefined();
  });
});

describe('loop + fill + relay', () => {
  it('loop/again with fill transfers multiple batches', () => {
    const source = `
node 116
/\\
setb{addr=0x1D5}
/\\
loop{n=3}
/\\ fill{value=0x0AA, count=10}
/\\ again{}

node 117
/\\
loop{n=3}
/\\ relay{port=0x1D5, count=10}
/\\ again{}
`;
    const { snap } = runCube(source, 50_000);
    const writes = ioWritesByCoord(snap);
    const node117 = writes.get(117) ?? [];
    const fillValues = node117.filter(v => v === 0x0AA);
    expect(fillValues.length).toBe(30); // 3 × 10
  });
});
