export const HSYNC_BIT = 0x20000;
export const VSYNC_BIT = 0x10000;

export interface Resolution {
  width: number;
  height: number;
  hasSyncSignals: boolean;
}

export function detectResolution(ioWrites: number[], count: number): Resolution & { complete: boolean } {
  let x = 0;
  let maxX = 0;
  let y = 0;
  let hasSyncSignals = false;
  let frameStarted = false;

  for (let i = 0; i < count; i++) {
    const val = ioWrites[i];
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
