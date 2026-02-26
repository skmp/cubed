/**
 * Tests for worker-related components: IoWriteBuffer and GA144.getIoWritesDelta.
 *
 * These test the data transfer layer used by the emulator Web Worker.
 * The actual Worker is not instantiated (vitest runs in Node.js).
 */
import { describe, it, expect } from 'vitest';
import { IoWriteBuffer } from './ioWriteBuffer';
import { GA144 } from '../core/ga144';
import { SerialBits } from '../core/serial';
import { ROM_DATA } from '../core/rom-data';
import { compileCube } from '../core/cube';
import { buildBootStream } from '../core/bootstream';

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('IoWriteBuffer', () => {
  it('appends a single batch', () => {
    const buf = new IoWriteBuffer();
    buf.appendBatch({
      writes: [100, 200, 300],
      timestamps: [1, 2, 3],
      startSeq: 0,
      totalSeq: 3,
    });
    expect(buf.count).toBe(3);
    expect(buf.seq).toBe(3);
    expect(buf.start).toBe(0);
    expect(buf.writes[0]).toBe(100);
    expect(buf.writes[1]).toBe(200);
    expect(buf.writes[2]).toBe(300);
    expect(buf.timestamps[0]).toBe(1);
    expect(buf.timestamps[2]).toBe(3);
  });

  it('appends multiple batches sequentially', () => {
    const buf = new IoWriteBuffer();
    buf.appendBatch({ writes: [10, 20], timestamps: [1, 2], startSeq: 0, totalSeq: 2 });
    buf.appendBatch({ writes: [30, 40], timestamps: [3, 4], startSeq: 2, totalSeq: 4 });
    expect(buf.count).toBe(4);
    expect(buf.seq).toBe(4);
    expect(buf.writes[0]).toBe(10);
    expect(buf.writes[3]).toBe(40);
  });

  it('reset clears all state', () => {
    const buf = new IoWriteBuffer();
    buf.appendBatch({ writes: [1, 2, 3], timestamps: [1, 2, 3], startSeq: 0, totalSeq: 3 });
    buf.reset();
    expect(buf.count).toBe(0);
    expect(buf.seq).toBe(0);
    expect(buf.start).toBe(0);
  });

  it('handles empty batch', () => {
    const buf = new IoWriteBuffer();
    buf.appendBatch({ writes: [], timestamps: [], startSeq: 0, totalSeq: 0 });
    expect(buf.count).toBe(0);
    expect(buf.seq).toBe(0);
  });
});

describe('GA144.getIoWritesDelta', () => {
  it('returns empty delta when no writes have occurred', () => {
    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    const delta = ga.getIoWritesDelta(0);
    expect(delta.writes).toHaveLength(0);
    expect(delta.timestamps).toHaveLength(0);
    expect(delta.totalSeq).toBe(0);
    expect(delta.startSeq).toBe(0);
  });

  it('returns IO writes after stepping a booted program', () => {
    const source = readFileSync(join(__dirname, '../../samples/RSC.cube'), 'utf-8');
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.enqueueSerialBits(708, SerialBits.bootStreamBits(Array.from(buildBootStream(compiled.nodes).bytes), GA144.BOOT_BAUD));
    ga.stepUntilDone(10_000_000);

    // Should have some IO writes from RSC serial output
    const delta = ga.getIoWritesDelta(0);
    expect(delta.writes.length).toBeGreaterThan(0);
    expect(delta.timestamps.length).toBe(delta.writes.length);
    expect(delta.totalSeq).toBeGreaterThan(0);
  });

  it('returns only new writes since sinceSeq', () => {
    const source = readFileSync(join(__dirname, '../../samples/RSC.cube'), 'utf-8');
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.enqueueSerialBits(708, SerialBits.bootStreamBits(Array.from(buildBootStream(compiled.nodes).bytes), GA144.BOOT_BAUD));

    // Step partially
    ga.stepProgramN(2_000_000);
    const delta1 = ga.getIoWritesDelta(0);
    const seq1 = delta1.totalSeq;

    // Step more
    ga.stepProgramN(2_000_000);
    const delta2 = ga.getIoWritesDelta(seq1);

    // delta2 should only contain new writes
    expect(delta2.startSeq).toBe(seq1);
    expect(delta2.totalSeq).toBeGreaterThanOrEqual(seq1);
    // Combined should equal getting all from 0
    const deltaAll = ga.getIoWritesDelta(0);
    expect(deltaAll.writes.length).toBe(delta1.writes.length + delta2.writes.length);
  });

  it('IoWriteBuffer reconstructs same data as getIoWritesDelta batches', () => {
    const source = readFileSync(join(__dirname, '../../samples/RSC.cube'), 'utf-8');
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.enqueueSerialBits(708, SerialBits.bootStreamBits(Array.from(buildBootStream(compiled.nodes).bytes), GA144.BOOT_BAUD));

    const buf = new IoWriteBuffer();
    let lastSeq = 0;

    // Simulate worker sending batches in chunks
    for (let i = 0; i < 5; i++) {
      ga.stepProgramN(1_000_000);
      const delta = ga.getIoWritesDelta(lastSeq);
      buf.appendBatch(delta);
      lastSeq = delta.totalSeq;
    }

    // Get the full delta from the beginning
    const fullDelta = ga.getIoWritesDelta(0);

    // Buffer should have same data
    expect(buf.seq).toBe(fullDelta.totalSeq);
    expect(buf.count).toBe(fullDelta.writes.length);

    // Verify first and last entries match
    if (fullDelta.writes.length > 0) {
      expect(buf.writes[buf.start]).toBe(fullDelta.writes[0]);
      const lastIdx = (buf.start + buf.count - 1) % 2_000_000;
      expect(buf.writes[lastIdx]).toBe(fullDelta.writes[fullDelta.writes.length - 1]);
    }
  });
});
