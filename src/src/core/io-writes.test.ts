/**
 * Tests for GA144.ioWritesToBits() — converts IO write ring buffer entries
 * into SerialBit[] segments suitable for serial decoding.
 */
import { describe, it, expect } from 'vitest';
import { GA144 } from './ga144';
import { ROM_DATA } from './rom-data';
import { coordToIndex } from './constants';
import type { SerialBit } from './serial';

/** Create a fresh GA144 and inject IO writes for the given node coord. */
function makeGaWithWrites(
  coord: number,
  writes: { value: number; timeNS: number }[],
): GA144 {
  const ga = new GA144('test');
  ga.setRomData(ROM_DATA);
  ga.reset();
  const idx = coordToIndex(coord);
  for (const w of writes) {
    ga.onIoWrite(idx, w.value, { simulatedTime: w.timeNS } as any);
  }
  return ga;
}

describe('ioWritesToBits', () => {

  it('returns empty for a node with no IO writes', () => {
    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    expect(ga.ioWritesToBits(708)).toEqual([]);
  });

  it('returns empty when all writes are for a different node', () => {
    const ga = makeGaWithWrites(100, [
      { value: 2, timeNS: 0 },
      { value: 3, timeNS: 1000 },
    ]);
    expect(ga.ioWritesToBits(708)).toEqual([]);
  });

  it('ignores IO writes with value > 3 (non-pin-drive writes)', () => {
    const ga = makeGaWithWrites(708, [
      { value: 0x100, timeNS: 0 },
      { value: 0x3FFFF, timeNS: 1000 },
    ]);
    expect(ga.ioWritesToBits(708)).toEqual([]);
  });

  it('single pin-drive write produces one zero-duration segment', () => {
    const ga = makeGaWithWrites(708, [
      { value: 3, timeNS: 500 },
    ]);
    const bits = ga.ioWritesToBits(708);
    expect(bits).toHaveLength(1);
    expect(bits[0].value).toBe(true);   // bit 0 of 3 is set
    expect(bits[0].durationNS).toBe(0); // last segment has no end
  });

  it('two transitions produce correct duration', () => {
    const ga = makeGaWithWrites(708, [
      { value: 3, timeNS: 1000 },  // pin1 HIGH
      { value: 2, timeNS: 2085 },  // pin1 LOW
    ]);
    const bits = ga.ioWritesToBits(708);
    expect(bits).toHaveLength(2);
    expect(bits[0]).toEqual({ value: true, durationNS: 1085 });
    expect(bits[1]).toEqual({ value: false, durationNS: 0 });
  });

  it('merges consecutive same-value transitions', () => {
    // Two HIGH writes in a row should merge into one segment
    const ga = makeGaWithWrites(708, [
      { value: 3, timeNS: 0 },     // pin1 HIGH
      { value: 3, timeNS: 1000 },  // pin1 HIGH again
      { value: 2, timeNS: 2000 },  // pin1 LOW
    ]);
    const bits = ga.ioWritesToBits(708);
    expect(bits).toHaveLength(2);
    expect(bits[0]).toEqual({ value: true, durationNS: 2000 });
    expect(bits[1]).toEqual({ value: false, durationNS: 0 });
  });

  it('bit 0 determines pin1 state (values 2 vs 3)', () => {
    // value 2 = 0b10 → bit 0 = 0 → LOW
    // value 3 = 0b11 → bit 0 = 1 → HIGH
    const ga = makeGaWithWrites(708, [
      { value: 2, timeNS: 0 },
      { value: 3, timeNS: 1000 },
      { value: 2, timeNS: 2000 },
    ]);
    const bits = ga.ioWritesToBits(708);
    expect(bits).toHaveLength(3);
    expect(bits[0].value).toBe(false); // value 2, bit 0 = 0
    expect(bits[1].value).toBe(true);  // value 3, bit 0 = 1
    expect(bits[2].value).toBe(false); // value 2, bit 0 = 0
  });

  it('value 0 and 1 also work (no pin17 drive)', () => {
    const ga = makeGaWithWrites(708, [
      { value: 0, timeNS: 0 },     // bit 0 = 0 → LOW
      { value: 1, timeNS: 1000 },  // bit 0 = 1 → HIGH
    ]);
    const bits = ga.ioWritesToBits(708);
    expect(bits).toHaveLength(2);
    expect(bits[0].value).toBe(false);
    expect(bits[1].value).toBe(true);
  });

  it('filters writes for the correct node only', () => {
    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    const idx708 = coordToIndex(708);
    const idx100 = coordToIndex(100);
    // Interleave writes from two nodes
    ga.onIoWrite(idx708, 3, { simulatedTime: 0 } as any);
    ga.onIoWrite(idx100, 2, { simulatedTime: 500 } as any);
    ga.onIoWrite(idx708, 2, { simulatedTime: 1000 } as any);

    const bits708 = ga.ioWritesToBits(708);
    expect(bits708).toHaveLength(2);
    expect(bits708[0]).toEqual({ value: true, durationNS: 1000 });

    const bits100 = ga.ioWritesToBits(100);
    expect(bits100).toHaveLength(1);
    expect(bits100[0]).toEqual({ value: false, durationNS: 0 });
  });

  it('decodeSerialOutput round-trips a byte through ioWritesToBits', () => {
    // Simulate emit1-style pin drive for byte 0x41 ('A')
    // FTDI inverted: start=HIGH, data 1→LOW, data 0→HIGH, stop=LOW
    const baud = GA144.BOOT_BAUD;
    const bitNS = 1e9 / baud;
    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    const idx = coordToIndex(708);

    // Build pin-drive sequence for 0x41 = 0b01000001
    // emit1 uses: (bit & 1) XOR 3 → value. So data 1 → 2 (LOW pin1), data 0 → 3 (HIGH pin1)
    // Start bit: emit1(0) → value 3 (HIGH = start)
    // Data LSB first: 1,0,0,0,0,0,1,0 → values: 2,3,3,3,3,3,2,3
    // Stop bit: emit1(1) → value 2 (LOW = stop/idle)
    const pinValues = [3, 2, 3, 3, 3, 3, 3, 2, 3, 2]; // start + 8 data + stop
    let t = 0;
    for (const v of pinValues) {
      ga.onIoWrite(idx, v, { simulatedTime: t } as any);
      t += bitNS;
    }

    const decoded = ga.decodeSerialOutput(708, baud);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toBe(0x41);
  });

  it('decodes multiple bytes from sequential pin drives', () => {
    const baud = GA144.BOOT_BAUD;
    const bitNS = 1e9 / baud;
    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    const idx = coordToIndex(708);

    // Helper: build pin values for one byte
    function byteToPin(byte: number): number[] {
      const vals = [3]; // start bit: HIGH
      for (let i = 0; i < 8; i++) {
        vals.push(((byte >> i) & 1) ^ 3); // emit1: (bit & 1) XOR 3
      }
      vals.push(2); // stop bit: LOW
      return vals;
    }

    const testBytes = [0x41, 0x42, 0x48];
    let t = 0;
    for (const b of testBytes) {
      for (const v of byteToPin(b)) {
        ga.onIoWrite(idx, v, { simulatedTime: t } as any);
        t += bitNS;
      }
      t += bitNS * 2; // idle gap between bytes
    }

    const decoded = ga.decodeSerialOutput(708, baud);
    expect(decoded.length).toBeGreaterThanOrEqual(3);
    expect(decoded[0]).toBe(0x41);
    expect(decoded[1]).toBe(0x42);
    expect(decoded[2]).toBe(0x48);
  });
});
