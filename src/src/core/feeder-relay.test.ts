import { describe, it, expect } from 'vitest';
import { GA144 } from './ga144';
import { ROM_DATA } from './rom-data';
import { compileCube } from './cube';
import { VGA_NODE_R, VGA_NODE_G, VGA_NODE_B } from './constants';
import {
  readIoWrite,
  taggedCoord,
  taggedValue,
  decodeDac,
  isHsync,
  isVsync,
} from '../ui/emulator/vgaResolution';

function runCube(source: string, maxSteps = 10_000_000) {
  const compiled = compileCube(source);
  expect(compiled.errors).toHaveLength(0);
  const ga = new GA144('test');
  ga.setRomData(ROM_DATA);
  ga.reset();
  ga.load(compiled);
  ga.stepUntilDone(maxSteps);
  return { ga, snap: ga.getSnapshot() };
}

function countIoByCoord(snap: { ioWrites: number[]; ioWriteStart: number; ioWriteCount: number }) {
  const counts = new Map<number, number>();
  for (let i = 0; i < snap.ioWriteCount; i++) {
    const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
    const coord = taggedCoord(tagged);
    counts.set(coord, (counts.get(coord) || 0) + 1);
  }
  return counts;
}

describe('setb builtin', () => {
  it('compiles setb without errors', () => {
    const source = `
node 117
/\\
setb{addr=0x1D5}
`;
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);
  });

  it('redirects fill output to a port after setb', () => {
    // Node 116 sets B to right port, fills 5 values.
    // Node 117 should receive those values.
    // Node 117 reads from left and writes to IO.
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
    const { snap } = runCube(source, 1_000);
    const counts = countIoByCoord(snap);
    console.log('setb+fill test: IO writes by coord:', Object.fromEntries(counts));
    expect(counts.get(117)).toBe(5);
  });
});

describe('relay builtin', () => {
  it('compiles relay without errors', () => {
    const source = `
node 117
/\\
relay{port=0x1D5, count=10}
`;
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);
  });

  it('transfers values from feeder to DAC via relay', () => {
    // Node 116 sends 3 values via fill with B=right port
    // Node 117 relays them to IO
    const source = `
node 116
/\\
setb{addr=0x1D5}
/\\
fill{value=0x155, count=3}

node 117
/\\
relay{port=0x1D5, count=3}
`;
    const { snap } = runCube(source, 1_000);
    const counts = countIoByCoord(snap);
    console.log('relay test: IO writes by coord:', Object.fromEntries(counts));
    expect(counts.get(117)).toBe(3);

    // Check the values are correct (0x155 = zero DAC output)
    for (let i = 0; i < snap.ioWriteCount; i++) {
      const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
      if (taggedCoord(tagged) === 117) {
        expect(taggedValue(tagged)).toBe(0x155);
      }
    }
  });
});

describe('feeder-relay pipeline synchronization', () => {
  it('transfers a full row (640 pixels) from feeder to DAC', () => {
    const source = `
node 116
/\\
setb{addr=0x1D5}
/\\
fill{value=0x0AA, count=640}

node 117
/\\
relay{port=0x1D5, count=640}
`;
    const { snap } = runCube(source, 100_000);
    const counts = countIoByCoord(snap);
    console.log('640px row test: IO writes by coord:', Object.fromEntries(counts));
    expect(counts.get(117)).toBe(640);
  });

  it('transfers multiple rows with nested relay loop', () => {
    // Feeder sends 3 rows x 10 pixels
    // Relay uses loop{n=3} relay{count=10} again{}
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
    const { snap } = runCube(source, 10_000);
    const counts = countIoByCoord(snap);
    console.log('3x10 row test: IO writes by coord:', Object.fromEntries(counts));
    expect(counts.get(117)).toBe(30);
  });

  it('synchronizes three channels through blocking port handshake', () => {
    // 3 feeder-relay pairs, each sending 10 values
    const source = `
node 116
/\\
setb{addr=0x1D5}
/\\
fill{value=0x0AA, count=10}

node 117
/\\
relay{port=0x1D5, count=10}

node 616
/\\
setb{addr=0x1D5}
/\\
fill{value=0x155, count=10}

node 617
/\\
relay{port=0x1D5, count=10}

node 716
/\\
setb{addr=0x1D5}
/\\
fill{value=0x155, count=10}

node 717
/\\
relay{port=0x1D5, count=10}
`;
    const { snap } = runCube(source, 10_000);
    const counts = countIoByCoord(snap);
    console.log('3-channel test: IO writes by coord:', Object.fromEntries(counts));
    expect(counts.get(117)).toBe(10);
    expect(counts.get(617)).toBe(10);
    expect(counts.get(717)).toBe(10);
  });

  it('handles mixed fill segments (like Swiss flag rows)', () => {
    // Feeder sends: 4 zero + 3 max + 3 zero = 10 pixels
    // Relay receives 10 pixels
    const source = `
node 116
/\\
setb{addr=0x1D5}
/\\
fill{value=0x155, count=4}
/\\
fill{value=0x0AA, count=3}
/\\
fill{value=0x155, count=3}

node 117
/\\
relay{port=0x1D5, count=10}
`;
    const { snap } = runCube(source, 10_000);
    const counts = countIoByCoord(snap);
    console.log('mixed segments test: IO writes by coord:', Object.fromEntries(counts));
    expect(counts.get(117)).toBe(10);

    // Check values
    let zeroCount = 0, maxCount = 0;
    for (let i = 0; i < snap.ioWriteCount; i++) {
      const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
      if (taggedCoord(tagged) === 117) {
        const val = taggedValue(tagged);
        const dac = decodeDac(val);
        if (dac === 0) zeroCount++;
        else if (dac === 0x1FF) maxCount++;
      }
    }
    expect(zeroCount).toBe(7); // 4 + 3 zero segments
    expect(maxCount).toBe(3);  // 3 max segment
  });
});

describe('inter-node port communication', () => {
  it('fill with B=right port produces port writes (not IO writes) on the feeder', () => {
    // Node 116 sets B to right port and fills — should NOT produce IO writes on 116
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
    const { snap } = runCube(source, 1_000);
    const counts = countIoByCoord(snap);
    console.log('feeder IO test:', Object.fromEntries(counts));
    // Node 116 should NOT have IO writes (it writes to port, not IO)
    expect(counts.get(116)).toBeUndefined();
    // Node 117 should have the IO writes
    expect(counts.get(117)).toBe(5);
  });
});
