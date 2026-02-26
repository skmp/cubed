/**
 * Tests for boot stream serial encoding at 921600 baud.
 * Verifies encoding, timing, and round-trip — no heavy simulation.
 */
import { describe, it, expect } from 'vitest';
import { GA144 } from './ga144';
import { compileCube } from './cube';
import { buildBootStream } from './bootstream';

const GA144_MOPS  = GA144.GA144_MOPS;
const BOOT_BAUD   = GA144.BOOT_BAUD;
const BAUD_PERIOD = GA144.BOOT_BAUD_PERIOD;

describe('boot stream serial encoding at 921600 baud', () => {

  it('BOOT_BAUD_PERIOD is correct for 921600 baud at 666 MHz', () => {
    const expected = Math.round(GA144_MOPS / BOOT_BAUD);
    expect(BAUD_PERIOD).toBe(expected);
    expect(BAUD_PERIOD).toBeGreaterThan(700);
    expect(BAUD_PERIOD).toBeLessThan(750);
  });

  it('encodeAsyncBootromBytes produces 3 bytes per word, all valid uint8', () => {
    const compiled = compileCube(`node 709\n/\\\nfill{value=0xAA, count=1}\n`);
    expect(compiled.errors).toHaveLength(0);
    const boot = buildBootStream(compiled.nodes);
    expect(boot.bytes.length).toBe(boot.words.length * 3);
    for (const b of boot.bytes) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(255);
    }
  });

  it('encodeAsyncBootromBytes round-trips: bytes decode back to original words', () => {
    const compiled = compileCube(`node 709\n/\\\nfill{value=0xBB, count=1}\n`);
    expect(compiled.errors).toHaveLength(0);
    const boot = buildBootStream(compiled.nodes);
    const bytes = boot.bytes;

    for (let w = 0; w < boot.words.length; w++) {
      const b0 = bytes[w * 3 + 0] ^ 0xFF;
      const b1 = bytes[w * 3 + 1] ^ 0xFF;
      const b2 = bytes[w * 3 + 2] ^ 0xFF;
      const low2  = (b0 & 0xC0) >> 6;
      const mid8  = b1;
      const high8 = b2;
      const decoded = low2 | (mid8 << 2) | (high8 << 10);
      expect(decoded).toBe(boot.words[w] & 0x3FFFF);
    }
  });

  it('buildSerialBits at 921600 baud has correct total duration', () => {
    const compiled = compileCube(`node 709\n/\\\nfill{value=0x42, count=1}\n`);
    expect(compiled.errors).toHaveLength(0);
    const boot = buildBootStream(compiled.nodes);
    const byteArray = Array.from(boot.bytes);
    const idlePeriod = BAUD_PERIOD * 10;
    const bits = GA144.buildSerialBits(byteArray, BAUD_PERIOD, idlePeriod);
    const toNS = (ticks: number) => ticks * GA144.NS_PER_TICK;
    const totalDuration = bits.reduce((s, b) => s + b.durationNS, 0);
    const expectedTotal = toNS(idlePeriod + boot.bytes.length * 10 * BAUD_PERIOD + BAUD_PERIOD * 2);
    expect(totalDuration).toBe(expectedTotal);
  });

  it('serial bit stream starts with idle then start bit', () => {
    const boot = buildBootStream(
      compileCube(`node 709\n/\\\nfill{value=1, count=1}\n`).nodes
    );
    const bits = GA144.buildSerialBits(Array.from(boot.bytes), BAUD_PERIOD, BAUD_PERIOD * 5);
    expect(bits.length).toBeGreaterThanOrEqual(2);
    expect(bits[0].value).toBe(false);  // RS232 idle = LOW on pin17
    expect(bits[1].value).toBe(true);   // RS232 start bit = HIGH on pin17
  });

  it('bit timing is uniform across all bytes', () => {
    const testBytes = [0xAE, 0x00, 0xFF, 0x55, 0xAA];
    const bits = GA144.buildSerialBits(testBytes, BAUD_PERIOD, 0);
    let totalBitPeriods = 0;
    const baudNS = BAUD_PERIOD * GA144.NS_PER_TICK;
    for (const seg of bits) {
      expect(seg.durationNS % baudNS).toBe(0);
      totalBitPeriods += seg.durationNS / baudNS;
    }
    expect(totalBitPeriods).toBe(testBytes.length * 10 + 2);
  });
});
