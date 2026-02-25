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

/** Read the timestamp (simulated time in ns) for an IO write from the ring buffer. */
export function readIoTimestamp(timestamps: number[], start: number, idx: number): number {
  const cap = timestamps.length;
  if (cap === 0) return 0;
  const pos = start + idx;
  return timestamps[pos >= cap ? pos - cap : pos];
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
 *  EVB002: node 217 pin17 driven low (bits 17:16 = 10). */
export function isHsync(tagged: number): boolean {
  const coord = taggedCoord(tagged);
  if (coord !== VGA_NODE_SYNC) return false;
  const val = taggedValue(tagged);
  return (val & PIN17_MASK) === PIN17_DRIVE_LOW;
}

/** Check if an IO write from the sync node signals VSYNC.
 *  EVB002: node 217 pin17 driven high (bits 17:16 = 11) — frame marker. */
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

export function detectResolution(
  ioWrites: number[],
  count: number,
  start: number = 0,
  timestamps?: number[],
): Resolution & { complete: boolean } {
  let x = 0;
  let maxX = 0;
  let y = 0;
  let hasSyncSignals = false;
  let pendingHsyncTs = -1; // timestamp of deferred HSYNC (-1 = none)

  for (let i = 0; i < count; i++) {
    const tagged = readIoWrite(ioWrites, start, i);
    if (isVsync(tagged)) {
      hasSyncSignals = true;
      if (y > 0 || x > 0) {
        if (x > maxX) maxX = x;
        const height = Math.max(y + (x > 0 ? 1 : 0), 1);
        return { width: maxX || 1, height, hasSyncSignals: true, complete: true };
      }
      pendingHsyncTs = -1;
    } else if (isHsync(tagged)) {
      hasSyncSignals = true;
      if (timestamps) {
        // Record HSYNC timestamp — defer line break until we see
        // the next R write and can compare timestamps.
        pendingHsyncTs = readIoTimestamp(timestamps, start, i);
      } else if (x > 0) {
        if (x > maxX) maxX = x;
        y++;
        x = 0;
      }
    } else if (taggedCoord(tagged) === VGA_NODE_R) {
      x++;
      // Apply deferred HSYNC: if the R write has the same timestamp
      // as the HSYNC, it was produced in the same global step, so it
      // belongs to the current line (before the line break).
      if (pendingHsyncTs >= 0) {
        const rTs = timestamps ? readIoTimestamp(timestamps, start, i) : -1;
        if (Math.abs(rTs - pendingHsyncTs) > 10) {
          // Different step — HSYNC legitimately precedes this R write.
          // Apply the deferred line break BEFORE counting this R write.
          // Undo the x++ for this R write, apply HSYNC, then re-count it.
          x--;
          if (x > maxX) maxX = x;
          y++;
          x = 1; // this R write starts the new row
          pendingHsyncTs = -1;
        } else {
          // Same step — R belongs to the line before HSYNC.
          // Apply HSYNC after this R write.
          if (x > maxX) maxX = x;
          y++;
          x = 0;
          pendingHsyncTs = -1;
        }
      }
    }
  }

  // No complete frame found — use what we have from HSYNC-delimited rows
  if (hasSyncSignals && maxX > 0) {
    return {
      width: maxX,
      height: Math.max(y + (x > 0 ? 1 : 0), 1),
      hasSyncSignals,
      complete: false,
    };
  }
  if (x > maxX) maxX = x;
  return {
    width: maxX || 1,
    height: Math.max(y + (x > 0 ? 1 : 0), 1),
    hasSyncSignals,
    complete: false,
  };
}
