import { describe, it, expect } from 'vitest';
import { detectResolution, HSYNC_BIT, VSYNC_BIT } from './vgaResolution';

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
});
