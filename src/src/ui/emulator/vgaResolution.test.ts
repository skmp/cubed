import { describe, it, expect } from 'vitest';
import {
  detectResolution,
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

describe('tagged format helpers', () => {
  it('taggedCoord / taggedValue round-trip', () => {
    const t = tag(617, 0x2ABCD & 0x3FFFF);
    expect(taggedCoord(t)).toBe(617);
    expect(taggedValue(t)).toBe(0x2ABCD & 0x3FFFF);
  });

  it('decodeDac undoes XOR encoding', () => {
    // Writing DAC value 0 → stored as 0 ^ 0x155 = 0x155
    expect(decodeDac(0x155)).toBe(0);
    // Writing DAC value 0x1FF → stored as 0x1FF ^ 0x155 = 0x0AA
    expect(decodeDac(0x0AA)).toBe(0x1FF);
    // Writing DAC value 0x155 → stored as 0x155 ^ 0x155 = 0
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
  it('detects width/height when the last line ends at VSYNC', () => {
    const ioWrites = [
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),  // VSYNC start
      tag(VGA_NODE_R, 1), tag(VGA_NODE_R, 2), tag(VGA_NODE_R, 3),
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),  // VSYNC end
    ];
    const res = detectResolution(ioWrites, ioWrites.length);
    expect(res.complete).toBe(true);
    expect(res.hasSyncSignals).toBe(true);
    expect(res.width).toBe(3);
    expect(res.height).toBe(1);
  });

  it('detects max width across HSYNC-delimited lines', () => {
    const ioWrites = [
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),  // VSYNC start
      tag(VGA_NODE_R, 1), tag(VGA_NODE_R, 2),
      tag(VGA_NODE_SYNC, PIN17_DRIVE_LOW),   // HSYNC
      tag(VGA_NODE_R, 3),
      tag(VGA_NODE_SYNC, PIN17_DRIVE_LOW),   // HSYNC
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),  // VSYNC end
    ];
    const res = detectResolution(ioWrites, ioWrites.length);
    expect(res.complete).toBe(true);
    expect(res.width).toBe(2);
    expect(res.height).toBe(2);
  });

  it('handles data with no sync signals (counts R-node writes)', () => {
    const ioWrites = [
      tag(VGA_NODE_R, 1), tag(VGA_NODE_R, 2), tag(VGA_NODE_R, 3),
      tag(VGA_NODE_R, 4), tag(VGA_NODE_R, 5),
    ];
    const res = detectResolution(ioWrites, ioWrites.length);
    expect(res.complete).toBe(false);
    expect(res.hasSyncSignals).toBe(false);
    expect(res.width).toBe(5);
    expect(res.height).toBe(1);
  });

  it('reads from a circular buffer start offset', () => {
    const buf = [10, 11, 12, 13];
    expect(readIoWrite(buf, 2, 0)).toBe(12);
    expect(readIoWrite(buf, 2, 1)).toBe(13);
    expect(readIoWrite(buf, 2, 2)).toBe(10);
  });

  it('detects resolution with a non-zero start offset', () => {
    const ioWrites = [
      tag(VGA_NODE_R, 99),                     // leftover from previous frame
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),     // VSYNC start
      tag(VGA_NODE_R, 1), tag(VGA_NODE_R, 2),
      tag(VGA_NODE_SYNC, PIN17_DRIVE_LOW),      // HSYNC
      tag(VGA_NODE_R, 3),
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),     // VSYNC end
    ];
    const res = detectResolution(ioWrites, 6, 1);
    expect(res.complete).toBe(true);
    expect(res.width).toBe(2);
    expect(res.height).toBe(2);
  });

  it('ignores G/B node writes when counting pixels', () => {
    const ioWrites = [
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),
      tag(VGA_NODE_R, 1), tag(VGA_NODE_G, 1), tag(VGA_NODE_B, 1),
      tag(VGA_NODE_R, 2), tag(VGA_NODE_G, 2), tag(VGA_NODE_B, 2),
      tag(VGA_NODE_SYNC, PIN17_DRIVE_HIGH),
    ];
    const res = detectResolution(ioWrites, ioWrites.length);
    expect(res.complete).toBe(true);
    expect(res.width).toBe(2);  // Only R writes count
    expect(res.height).toBe(1);
  });
});
