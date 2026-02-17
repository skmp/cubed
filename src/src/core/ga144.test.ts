import { describe, it, expect } from 'vitest';
import { GA144 } from './ga144';
import { coordToIndex, VGA_NODE_R, VGA_NODE_SYNC } from './constants';
import {
  readIoWrite,
  taggedCoord,
  taggedValue,
  isVsync,
  isHsync,
  PIN17_DRIVE_LOW,
  PIN17_DRIVE_HIGH,
} from '../ui/emulator/vgaResolution';

const SYNC_INDEX = coordToIndex(VGA_NODE_SYNC);
const R_INDEX = coordToIndex(VGA_NODE_R);

function tag(coord: number, value: number): number {
  return coord * 0x40000 + value;
}

function snapshotTagged(snapshot: { ioWrites: number[]; ioWriteStart: number; ioWriteCount: number }): number[] {
  const values: number[] = [];
  for (let i = 0; i < snapshot.ioWriteCount; i++) {
    values.push(readIoWrite(snapshot.ioWrites, snapshot.ioWriteStart, i));
  }
  return values;
}

describe('GA144 IO write ring buffer (EVB002 tagged format)', () => {
  it('tags IO writes with node coordinate', () => {
    const ga = new GA144('test');
    ga.reset();
    ga.onIoWrite(R_INDEX, 0x42);

    const snap = ga.getSnapshot();
    const vals = snapshotTagged(snap);
    expect(vals).toHaveLength(1);
    expect(taggedCoord(vals[0])).toBe(VGA_NODE_R);
    expect(taggedValue(vals[0])).toBe(0x42);
  });

  it('retains data between VSYNC boundaries', () => {
    const ga = new GA144('test');
    ga.reset();
    ga.onIoWrite(SYNC_INDEX, PIN17_DRIVE_HIGH); // VSYNC
    ga.onIoWrite(R_INDEX, 1);
    ga.onIoWrite(R_INDEX, 2);
    ga.onIoWrite(SYNC_INDEX, PIN17_DRIVE_HIGH); // VSYNC

    const snap = ga.getSnapshot();
    const vals = snapshotTagged(snap);
    expect(vals).toEqual([
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),
      tag(VGA_NODE_R, 1),
      tag(VGA_NODE_R, 2),
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),
    ]);
  });

  it('drops older frame data when a new VSYNC arrives', () => {
    const ga = new GA144('test');
    ga.reset();
    ga.onIoWrite(SYNC_INDEX, PIN17_DRIVE_HIGH); // VSYNC 1
    ga.onIoWrite(R_INDEX, 1);
    ga.onIoWrite(SYNC_INDEX, PIN17_DRIVE_HIGH); // VSYNC 2
    ga.onIoWrite(R_INDEX, 2);
    ga.onIoWrite(SYNC_INDEX, PIN17_DRIVE_HIGH); // VSYNC 3

    const snap = ga.getSnapshot();
    const vals = snapshotTagged(snap);
    expect(vals).toEqual([
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),
      tag(VGA_NODE_R, 2),
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),
    ]);
  });

  it('identifies HSYNC and VSYNC signals', () => {
    expect(isHsync(tag(VGA_NODE_SYNC, PIN17_DRIVE_LOW))).toBe(true);
    expect(isVsync(tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH))).toBe(true);
    // Non-sync nodes should not trigger
    expect(isHsync(tag(VGA_NODE_R, PIN17_DRIVE_LOW))).toBe(false);
    expect(isVsync(tag(VGA_NODE_R, PIN17_DRIVE_HIGH))).toBe(false);
  });
});
