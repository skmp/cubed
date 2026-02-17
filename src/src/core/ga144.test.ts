import { describe, it, expect } from 'vitest';
import { GA144 } from './ga144';
import { coordToIndex } from './constants';
import { readIoWrite, VSYNC_BIT } from '../ui/emulator/vgaResolution';

// Node 117 is a DAC node (EVB001 VGA output) — use its index for IO write tests
const NODE_117_INDEX = coordToIndex(117);

function snapshotValues(snapshot: { ioWrites: number[]; ioWriteStart: number; ioWriteCount: number }): number[] {
  const values: number[] = [];
  for (let i = 0; i < snapshot.ioWriteCount; i++) {
    values.push(readIoWrite(snapshot.ioWrites, snapshot.ioWriteStart, i));
  }
  return values;
}

describe('GA144 IO write ring buffer', () => {
  it('retains data from the last frame boundary to the next VSYNC', () => {
    const ga = new GA144('test');
    ga.reset();
    ga.onIoWrite(NODE_117_INDEX, VSYNC_BIT);
    ga.onIoWrite(NODE_117_INDEX, 1);
    ga.onIoWrite(NODE_117_INDEX, 2);
    ga.onIoWrite(NODE_117_INDEX, VSYNC_BIT);

    const snap = ga.getSnapshot();
    expect(snapshotValues(snap)).toEqual([VSYNC_BIT, 1, 2, VSYNC_BIT]);
  });

  it('drops older frame data when a new VSYNC arrives', () => {
    const ga = new GA144('test');
    ga.reset();
    ga.onIoWrite(NODE_117_INDEX, VSYNC_BIT);
    ga.onIoWrite(NODE_117_INDEX, 1);
    ga.onIoWrite(NODE_117_INDEX, VSYNC_BIT);
    ga.onIoWrite(NODE_117_INDEX, 2);
    ga.onIoWrite(NODE_117_INDEX, VSYNC_BIT);

    const snap = ga.getSnapshot();
    expect(snapshotValues(snap)).toEqual([VSYNC_BIT, 2, VSYNC_BIT]);
  });

  it('ignores IO writes from non-DAC nodes', () => {
    const ga = new GA144('test');
    ga.reset();
    ga.onIoWrite(0, 42);  // Node 000 is not a DAC node
    ga.onIoWrite(NODE_117_INDEX, 7);

    const snap = ga.getSnapshot();
    expect(snapshotValues(snap)).toEqual([7]);
  });
});
