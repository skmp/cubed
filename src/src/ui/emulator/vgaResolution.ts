import { VGA_NODE_R, VGA_NODE_G, VGA_NODE_B, VGA_NODE_SYNC } from '../../core/constants';

// DAC XOR encoding — the F18A DAC value is stored as (desired ^ 0x155)
export const DAC_XOR = 0x155;

// Pin17 states in bits 17:16 of the IO register
// 00 = high-Z, 01 = weak pulldown, 10 = drive low, 11 = drive high
export const PIN17_HIGHZ = 0x00000;       // bits 17:16 = 00
export const PIN17_PULLDOWN = 0x10000;    // bits 17:16 = 01 (h-blank end)
export const PIN17_DRIVE_LOW = 0x20000;   // bits 17:16 = 10 (HSYNC)
export const PIN17_DRIVE_HIGH = 0x30000;  // bits 17:16 = 11 (VSYNC)
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

/** Check if an IO write from the sync node signals h-blank end.
 *  EVB002: node 217 pin17 weak pulldown (bits 17:16 = 01) — marks the
 *  transition from blanking to active pixel period. */
export function isHblankEnd(tagged: number): boolean {
  const coord = taggedCoord(tagged);
  if (coord !== VGA_NODE_SYNC) return false;
  const val = taggedValue(tagged);
  return (val & PIN17_MASK) === PIN17_PULLDOWN;
}

/** Check if a tagged write is a DAC pixel write (from R, G, or B node). */
export function isDacWrite(tagged: number): boolean {
  const coord = taggedCoord(tagged);
  return coord === VGA_NODE_R || coord === VGA_NODE_G || coord === VGA_NODE_B;
}

export interface SyncClocks {
  hsyncHz: number | null;  // HSYNC frequency in Hz (null if not enough data)
  vsyncHz: number | null;  // VSYNC frequency in Hz (null if not enough data)
}

/**
 * Calculate HSYNC and VSYNC clock frequencies from IO write timestamps.
 * Measures the median period between consecutive HSYNC/VSYNC signals.
 * Timestamps are in nanoseconds (guest wall clock).
 */
export function detectSyncClocks(
  ioWrites: number[],
  count: number,
  start: number,
  timestamps: number[],
): SyncClocks {
  const hsyncTs: number[] = [];
  const vsyncTs: number[] = [];

  for (let i = 0; i < count; i++) {
    const tagged = readIoWrite(ioWrites, start, i);
    if (isHsync(tagged)) {
      hsyncTs.push(readIoTimestamp(timestamps, start, i));
    } else if (isVsync(tagged)) {
      vsyncTs.push(readIoTimestamp(timestamps, start, i));
    }
  }

  function medianFreqHz(ts: number[]): number | null {
    if (ts.length < 2) return null;
    const periods: number[] = [];
    for (let i = 1; i < ts.length; i++) {
      const dt = ts[i] - ts[i - 1];
      if (dt > 0) periods.push(dt);
    }
    if (periods.length === 0) return null;
    periods.sort((a, b) => a - b);
    const median = periods[Math.floor(periods.length / 2)];
    if (median <= 0) return null;
    return 1e9 / median;  // nanoseconds → Hz
  }

  return {
    hsyncHz: medianFreqHz(hsyncTs),
    vsyncHz: medianFreqHz(vsyncTs),
  };
}

/**
 * Stateful resolution tracker. Processes IO writes incrementally and
 * determines width/height from sync pulses:
 *   - Width is set when an HSYNC arrives (= R-writes since the previous HSYNC)
 *   - Height is set when a VSYNC arrives (= HSYNC count since the previous VSYNC)
 * Until the first VSYNC, width/height remain at their defaults (640×480).
 */
export class ResolutionTracker {
  /** Detected width (R-writes per line). */
  width = 640;
  /** Detected height (lines per frame). */
  height = 480;
  /** True once we have seen at least one sync signal. */
  hasSyncSignals = false;
  /** True once we have a VSYNC-confirmed frame size. */
  complete = false;
  /** HSYNC frequency in Hz (null if not enough data). */
  hsyncHz: number | null = null;
  /** VSYNC frequency in Hz (null if not enough data). */
  vsyncHz: number | null = null;

  // ---- internal counters ----
  private rCountSinceHsync = 0;
  private hsyncCountSinceVsync = 0;
  private pendingHsyncTs = -1;
  private lastProcessedSeq = 0;
  // Sync clock tracking — store last timestamp to compute period
  private lastHsyncTs = -1;
  private lastVsyncTs = -1;
  // Use the first R-write timestamp as frame start for V-rate on first frame
  private firstPixelTs = -1;

  /** Reset all state (e.g. on stream reset). */
  reset(): void {
    this.width = 640;
    this.height = 480;
    this.hasSyncSignals = false;
    this.complete = false;
    this.hsyncHz = null;
    this.vsyncHz = null;
    this.rCountSinceHsync = 0;
    this.hsyncCountSinceVsync = 0;
    this.pendingHsyncTs = -1;
    this.lastProcessedSeq = 0;
    this.lastHsyncTs = -1;
    this.lastVsyncTs = -1;
    this.firstPixelTs = -1;
  }

  /** Process new IO writes since the last call. */
  process(
    ioWrites: number[],
    ioWriteCount: number,
    ioWriteStart: number,
    ioWriteSeq: number,
    timestamps?: number[],
  ): void {
    const startSeq = ioWriteSeq - ioWriteCount;

    // Detect stream reset (seq went backwards) — full reset
    if (ioWriteSeq < this.lastProcessedSeq) {
      this.reset();
    }
    // Data drop (ring buffer overwrote unprocessed entries) — reset
    // counters for the current line/frame but keep confirmed resolution
    if (this.lastProcessedSeq < startSeq) {
      this.hsyncCountSinceVsync = 0;
      this.rCountSinceHsync = 0;
      this.pendingHsyncTs = -1;
      this.lastProcessedSeq = startSeq;
    }

    const fromSeq = Math.max(this.lastProcessedSeq, startSeq);
    for (let s = fromSeq; s < ioWriteSeq; s++) {
      const offset = s - startSeq;
      if (offset < 0 || offset >= ioWriteCount) continue;
      const tagged = readIoWrite(ioWrites, ioWriteStart, offset);

      if (isVsync(tagged)) {
        this.hasSyncSignals = true;
        // Flush any pending HSYNC
        if (this.pendingHsyncTs >= 0) {
          this.applyHsync();
        }
        // Count the in-progress line if it has pixels
        const lines = this.hsyncCountSinceVsync + (this.rCountSinceHsync > 0 ? 1 : 0);
        if (lines > 0) {
          this.height = lines;
          this.complete = true;
        }
        // Update VSYNC clock — use firstPixelTs as start of first frame
        if (timestamps) {
          const ts = readIoTimestamp(timestamps, ioWriteStart, offset);
          const prevTs = this.lastVsyncTs >= 0 ? this.lastVsyncTs : this.firstPixelTs;
          if (prevTs >= 0 && ts > prevTs) {
            this.vsyncHz = 1e9 / (ts - prevTs);
          }
          this.lastVsyncTs = ts;
        }
        this.hsyncCountSinceVsync = 0;
        this.rCountSinceHsync = 0;
        this.pendingHsyncTs = -1;
      } else if (isHsync(tagged)) {
        this.hasSyncSignals = true;
        // Update HSYNC clock
        if (timestamps) {
          const ts = readIoTimestamp(timestamps, ioWriteStart, offset);
          if (this.lastHsyncTs >= 0 && ts > this.lastHsyncTs) {
            this.hsyncHz = 1e9 / (ts - this.lastHsyncTs);
          }
          this.lastHsyncTs = ts;
          this.pendingHsyncTs = ts;
        } else {
          this.applyHsync();
        }
      } else if (taggedCoord(tagged) === VGA_NODE_R) {
        // Track first pixel timestamp for V-rate on first frame
        if (this.firstPixelTs < 0 && timestamps) {
          this.firstPixelTs = readIoTimestamp(timestamps, ioWriteStart, offset);
        }
        // Resolve deferred HSYNC
        if (this.pendingHsyncTs >= 0 && timestamps) {
          const rTs = readIoTimestamp(timestamps, ioWriteStart, offset);
          if (Math.abs(rTs - this.pendingHsyncTs) <= 10) {
            // Same step — R belongs to the line before HSYNC
            this.rCountSinceHsync++;
            this.applyHsync();
            continue;
          } else {
            // Different step — HSYNC was a real line break before this R
            this.applyHsync();
          }
        }
        this.rCountSinceHsync++;
      }
    }

    this.lastProcessedSeq = ioWriteSeq;
  }

  private applyHsync(): void {
    if (this.rCountSinceHsync > 0) {
      this.width = this.rCountSinceHsync;
    }
    this.hsyncCountSinceVsync++;
    this.rCountSinceHsync = 0;
    this.pendingHsyncTs = -1;
  }

  /** Return a snapshot of the current resolution state. */
  getResolution(): Resolution & { complete: boolean } {
    return {
      width: this.width,
      height: this.height,
      hasSyncSignals: this.hasSyncSignals,
      complete: this.complete,
    };
  }
}

/** Process IO writes into a tracker and return the current resolution.
 *  Pass the same tracker across calls for incremental updates. */
export function detectResolution(
  tracker: ResolutionTracker,
  ioWrites: number[],
  count: number,
  start: number,
  ioWriteSeq: number,
  timestamps?: number[],
): Resolution & { complete: boolean } {
  tracker.process(ioWrites, count, start, ioWriteSeq, timestamps);
  return tracker.getResolution();
}
