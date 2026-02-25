/**
 * Main-thread ring buffer that reconstructs IO write data from worker batches.
 */
import type { IoWriteBatch } from './emulatorProtocol';

const CAPACITY = 2_000_000;

export class IoWriteBuffer {
  readonly writes: number[] = new Array(CAPACITY);
  readonly timestamps: number[] = new Array(CAPACITY);
  start = 0;
  count = 0;
  seq = 0;

  appendBatch(batch: IoWriteBatch): void {
    for (let i = 0; i < batch.writes.length; i++) {
      const idx = (this.start + this.count) % CAPACITY;
      this.writes[idx] = batch.writes[i];
      this.timestamps[idx] = batch.timestamps[i];
      if (this.count >= CAPACITY) {
        this.start = (this.start + 1) % CAPACITY;
      } else {
        this.count++;
      }
    }
    this.seq = batch.totalSeq;
  }

  reset(): void {
    this.start = 0;
    this.count = 0;
    this.seq = 0;
  }
}
