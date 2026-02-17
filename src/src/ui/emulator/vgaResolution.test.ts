import { describe, it, expect } from 'vitest';
import { detectResolution, HSYNC_BIT, VSYNC_BIT, readIoWrite } from './vgaResolution';

describe('detectResolution', () => {
  it('detects width/height when the last line ends at VSYNC', () => {
    const ioWrites = [
      VSYNC_BIT,
      0x001, 0x002, 0x003,
      VSYNC_BIT,
    ];
    const res = detectResolution(ioWrites, ioWrites.length);
    expect(res.complete).toBe(true);
    expect(res.hasSyncSignals).toBe(true);
    expect(res.width).toBe(3);
    expect(res.height).toBe(1);
  });

  it('detects max width across HSYNC-delimited lines', () => {
    const ioWrites = [
      VSYNC_BIT,
      0x001, 0x002,
      HSYNC_BIT,
      0x003,
      HSYNC_BIT,
      VSYNC_BIT,
    ];
    const res = detectResolution(ioWrites, ioWrites.length);
    expect(res.complete).toBe(true);
    expect(res.width).toBe(2);
    expect(res.height).toBe(2);
  });

  it('handles data with no sync signals', () => {
    const ioWrites = [1, 2, 3, 4, 5];
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
    const ioWrites = [1, VSYNC_BIT, 1, 1, HSYNC_BIT, 1, VSYNC_BIT];
    const res = detectResolution(ioWrites, 6, 1);
    expect(res.complete).toBe(true);
    expect(res.width).toBe(2);
    expect(res.height).toBe(2);
  });
});
