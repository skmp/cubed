import { describe, it, expect } from 'vitest';
import { GA144 } from './ga144';
import { readIoWrite, VSYNC_BIT } from '../ui/emulator/vgaResolution';

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
    ga.onIoWrite(0, VSYNC_BIT);
    ga.onIoWrite(0, 1);
    ga.onIoWrite(0, 2);
    ga.onIoWrite(0, VSYNC_BIT);

    const snap = ga.getSnapshot();
    expect(snapshotValues(snap)).toEqual([VSYNC_BIT, 1, 2, VSYNC_BIT]);
  });

  it('drops older frame data when a new VSYNC arrives', () => {
    const ga = new GA144('test');
    ga.reset();
    ga.onIoWrite(0, VSYNC_BIT);
    ga.onIoWrite(0, 1);
    ga.onIoWrite(0, VSYNC_BIT);
    ga.onIoWrite(0, 2);
    ga.onIoWrite(0, VSYNC_BIT);

    const snap = ga.getSnapshot();
    expect(snapshotValues(snap)).toEqual([VSYNC_BIT, 2, VSYNC_BIT]);
  });
});
