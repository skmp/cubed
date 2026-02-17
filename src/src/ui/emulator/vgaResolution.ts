import { VGA_NODE_R, VGA_NODE_G, VGA_NODE_B, VGA_NODE_SYNC } from '../../core/constants';

// DAC XOR encoding — the F18A DAC value is stored as (desired ^ 0x155)
export const DAC_XOR = 0x155;

// Pin17 states in bits 17:16 of the IO register
// 00 = high-Z, 01 = weak pulldown, 10 = drive low, 11 = drive high
export const PIN17_DRIVE_LOW = 0x20000;   // bits 17:16 = 10
export const PIN17_DRIVE_HIGH = 0x30000;  // bits 17:16 = 11
export const PIN17_MASK = 0x30000;        // bits 17:16

export interface Resolution {
  width: number;
  height: number;
  hasSyncSignals: boolean;
}

/** Read a tagged IO write from the ring buffer.
 *  Returns the raw tagged value: (coord * 0x40000 + ioValue). */
export function readIoWrite(ioWrites: number[], start: number, idx: number): number {
  const cap = ioWrites.length;
  if (cap === 0) return 0;
  const pos = start + idx;
  return ioWrites[pos >= cap ? pos - cap : pos];
}

/** Extract node coordinate from a tagged IO write. */
export function taggedCoord(tagged: number): number {
  return (tagged / 0x40000) | 0;
}

/** Extract 18-bit IO value from a tagged IO write. */
export function taggedValue(tagged: number): number {
  return tagged & 0x3FFFF;
}

/** Decode a 9-bit DAC value from IO register, undoing XOR encoding. */
export function decodeDac(ioValue: number): number {
  return (ioValue & 0x1FF) ^ DAC_XOR;
}

/** Check if an IO write from the sync node signals HSYNC.
 *  EVB001: node 217 pin17 driven low (bits 17:16 = 10). */
export function isHsync(tagged: number): boolean {
  const coord = taggedCoord(tagged);
  if (coord !== VGA_NODE_SYNC) return false;
  const val = taggedValue(tagged);
  return (val & PIN17_MASK) === PIN17_DRIVE_LOW;
}

/** Check if an IO write from the sync node signals VSYNC.
 *  EVB001: node 217 pin17 driven high (bits 17:16 = 11) — frame marker. */
export function isVsync(tagged: number): boolean {
  const coord = taggedCoord(tagged);
  if (coord !== VGA_NODE_SYNC) return false;
  const val = taggedValue(tagged);
  return (val & PIN17_MASK) === PIN17_DRIVE_HIGH;
}

/** Check if a tagged write is a DAC pixel write (from R, G, or B node). */
export function isDacWrite(tagged: number): boolean {
  const coord = taggedCoord(tagged);
  return coord === VGA_NODE_R || coord === VGA_NODE_G || coord === VGA_NODE_B;
}

export function detectResolution(ioWrites: number[], count: number, start: number = 0): Resolution & { complete: boolean } {
  let x = 0;
  let maxX = 0;
  let y = 0;
  let hasSyncSignals = false;
  let frameStarted = false;

  for (let i = 0; i < count; i++) {
    const tagged = readIoWrite(ioWrites, start, i);
    if (isVsync(tagged)) {
      hasSyncSignals = true;
      if (frameStarted) {
        if (x > maxX) maxX = x;
        const height = Math.max(y + (x > 0 ? 1 : 0), 1);
        return { width: maxX || 1, height, hasSyncSignals: true, complete: true };
      }
      frameStarted = true;
      y = 0;
      x = 0;
    } else if (isHsync(tagged)) {
      hasSyncSignals = true;
      if (x > maxX) maxX = x;
      y++;
      x = 0;
    } else if (taggedCoord(tagged) === VGA_NODE_R) {
      // Count pixels by the R channel writes (all 3 channels write in lockstep)
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
