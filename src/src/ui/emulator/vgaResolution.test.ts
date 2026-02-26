import { describe, it, expect } from 'vitest';
import {
  detectResolution,
  ResolutionTracker,
  readIoWrite,
  taggedCoord,
  taggedValue,
  decodeDac,
  isHsync,
  isVsync,
  isDacWrite,
  PIN17_DRIVE_LOW,
  PIN17_DRIVE_HIGH,
} from './vgaResolution';
import { VGA_NODE_R, VGA_NODE_G, VGA_NODE_B, VGA_NODE_SYNC } from '../../core/constants';

/** Build a tagged IO write value: (coord << 18) | ioValue */
function tag(coord: number, value: number): number {
  return coord * 0x40000 + value;
}

/** Helper: run detectResolution with a fresh tracker. */
function detect(ioWrites: number[], count?: number, start?: number) {
  const tracker = new ResolutionTracker();
  const n = count ?? ioWrites.length;
  const s = start ?? 0;
  return detectResolution(tracker, ioWrites, n, s, n);
}

describe('tagged format helpers', () => {
  it('taggedCoord / taggedValue round-trip', () => {
    const t = tag(617, 0x2ABCD & 0x3FFFF);
    expect(taggedCoord(t)).toBe(617);
    expect(taggedValue(t)).toBe(0x2ABCD & 0x3FFFF);
  });

  it('decodeDac undoes XOR encoding', () => {
    expect(decodeDac(0x155)).toBe(0);
    expect(decodeDac(0x0AA)).toBe(0x1FF);
    expect(decodeDac(0)).toBe(0x155);
  });

  it('isHsync detects sync node pin17 drive low', () => {
    expect(isHsync(tag(VGA_NODE_SYNC, PIN17_DRIVE_LOW))).toBe(true);
    expect(isHsync(tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH))).toBe(false);
    expect(isHsync(tag(VGA_NODE_R, PIN17_DRIVE_LOW))).toBe(false);
  });

  it('isVsync detects sync node pin17 drive high', () => {
    expect(isVsync(tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH))).toBe(true);
    expect(isVsync(tag(VGA_NODE_SYNC, PIN17_DRIVE_LOW))).toBe(false);
    expect(isVsync(tag(VGA_NODE_R, PIN17_DRIVE_HIGH))).toBe(false);
  });

  it('isDacWrite identifies R/G/B nodes', () => {
    expect(isDacWrite(tag(VGA_NODE_R, 0))).toBe(true);
    expect(isDacWrite(tag(VGA_NODE_G, 0))).toBe(true);
    expect(isDacWrite(tag(VGA_NODE_B, 0))).toBe(true);
    expect(isDacWrite(tag(VGA_NODE_SYNC, 0))).toBe(false);
    expect(isDacWrite(tag(300, 0))).toBe(false);
  });
});

describe('detectResolution', () => {
  it('detects width from HSYNC and height from VSYNC', () => {
    const ioWrites = [
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),  // VSYNC start
      tag(VGA_NODE_R, 1), tag(VGA_NODE_R, 2), tag(VGA_NODE_R, 3),
      tag(VGA_NODE_SYNC, PIN17_DRIVE_LOW),   // HSYNC → width=3
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),  // VSYNC end → height=1
    ];
    const res = detect(ioWrites);
    expect(res.complete).toBe(true);
    expect(res.hasSyncSignals).toBe(true);
    expect(res.width).toBe(3);
    expect(res.height).toBe(1);
  });

  it('width tracks last HSYNC-delimited line', () => {
    const ioWrites = [
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),  // VSYNC start
      tag(VGA_NODE_R, 1), tag(VGA_NODE_R, 2),
      tag(VGA_NODE_SYNC, PIN17_DRIVE_LOW),   // HSYNC → width=2
      tag(VGA_NODE_R, 3), tag(VGA_NODE_R, 4), tag(VGA_NODE_R, 5),
      tag(VGA_NODE_SYNC, PIN17_DRIVE_LOW),   // HSYNC → width=3
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),  // VSYNC end → height=2
    ];
    const res = detect(ioWrites);
    expect(res.complete).toBe(true);
    expect(res.width).toBe(3);
    expect(res.height).toBe(2);
  });

  it('defaults to 640x480 with no sync signals', () => {
    const ioWrites = [
      tag(VGA_NODE_R, 1), tag(VGA_NODE_R, 2), tag(VGA_NODE_R, 3),
    ];
    const res = detect(ioWrites);
    expect(res.complete).toBe(false);
    expect(res.hasSyncSignals).toBe(false);
    expect(res.width).toBe(640);
    expect(res.height).toBe(480);
  });

  it('defaults height to 480 before first VSYNC', () => {
    const ioWrites = [
      tag(VGA_NODE_R, 1), tag(VGA_NODE_R, 2),
      tag(VGA_NODE_SYNC, PIN17_DRIVE_LOW),   // HSYNC → width=2
      tag(VGA_NODE_R, 3),
    ];
    const res = detect(ioWrites);
    expect(res.complete).toBe(false);
    expect(res.hasSyncSignals).toBe(true);
    expect(res.width).toBe(2);
    expect(res.height).toBe(480);
  });

  it('reads from a circular buffer start offset', () => {
    const buf = [10, 11, 12, 13];
    expect(readIoWrite(buf, 2, 0)).toBe(12);
    expect(readIoWrite(buf, 2, 1)).toBe(13);
    expect(readIoWrite(buf, 2, 2)).toBe(10);
  });

  it('detects resolution with a non-zero start offset', () => {
    const ioWrites = [
      tag(VGA_NODE_R, 99),                     // leftover (skipped via start=1)
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),     // VSYNC start
      tag(VGA_NODE_R, 1), tag(VGA_NODE_R, 2),
      tag(VGA_NODE_SYNC, PIN17_DRIVE_LOW),      // HSYNC → width=2
      tag(VGA_NODE_R, 3),
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),     // VSYNC end → height=2
    ];
    const tracker = new ResolutionTracker();
    const res = detectResolution(tracker, ioWrites, 6, 1, 6);
    expect(res.complete).toBe(true);
    expect(res.width).toBe(2);
    expect(res.height).toBe(2);
  });

  it('ignores G/B node writes when counting width', () => {
    const ioWrites = [
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),
      tag(VGA_NODE_R, 1), tag(VGA_NODE_G, 1), tag(VGA_NODE_B, 1),
      tag(VGA_NODE_R, 2), tag(VGA_NODE_G, 2), tag(VGA_NODE_B, 2),
      tag(VGA_NODE_SYNC, PIN17_DRIVE_LOW),   // HSYNC → width=2
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),  // VSYNC → height=1
    ];
    const res = detect(ioWrites);
    expect(res.complete).toBe(true);
    expect(res.width).toBe(2);
    expect(res.height).toBe(1);
  });

  it('incremental processing across batches', () => {
    const tracker = new ResolutionTracker();
    // Feed first batch: VSYNC + 2 R writes
    const batch1 = [
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),
      tag(VGA_NODE_R, 1), tag(VGA_NODE_R, 2),
    ];
    detectResolution(tracker, batch1, 3, 0, 3);
    expect(tracker.getResolution().complete).toBe(false);
    expect(tracker.getResolution().width).toBe(640); // no HSYNC yet

    // Feed second batch: HSYNC + 1 R + VSYNC
    const batch2 = [
      ...batch1,
      tag(VGA_NODE_SYNC, PIN17_DRIVE_LOW),   // HSYNC → width=2
      tag(VGA_NODE_R, 3),
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),  // VSYNC → height=2
    ];
    const res = detectResolution(tracker, batch2, 6, 0, 6);
    expect(res.complete).toBe(true);
    expect(res.width).toBe(2);
    expect(res.height).toBe(2);
  });
});
