export const HSYNC_BIT = 0x20000;
export const VSYNC_BIT = 0x10000;

export interface Resolution {
  width: number;
  height: number;
  hasSyncSignals: boolean;
}

export function readIoWrite(ioWrites: number[], start: number, idx: number): number {
  const cap = ioWrites.length;
  if (cap === 0) return 0;
  const pos = start + idx;
  return ioWrites[pos >= cap ? pos - cap : pos];
}

export function detectResolution(ioWrites: number[], count: number, start: number = 0): Resolution & { complete: boolean } {
  let x = 0;
  let maxX = 0;
  let y = 0;
  let hasSyncSignals = false;
  let frameStarted = false;

  for (let i = 0; i < count; i++) {
    const val = readIoWrite(ioWrites, start, i);
    if (val & VSYNC_BIT) {
      hasSyncSignals = true;
      if (frameStarted) {
        if (x > maxX) maxX = x;
        const height = Math.max(y + (x > 0 ? 1 : 0), 1);
        return { width: maxX || 1, height, hasSyncSignals: true, complete: true };
      }
      frameStarted = true;
      y = 0;
      x = 0;
    } else if (val & HSYNC_BIT) {
      hasSyncSignals = true;
      if (x > maxX) maxX = x;
      y++;
      x = 0;
    } else {
      x++;
    }
  }

  if (x > maxX) maxX = x;
  return {
    width: maxX || 1,
    height: Math.max(y + (x > 0 ? 1 : 0), 1),
    hasSyncSignals,
    complete: false,
  };
}
