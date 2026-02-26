/**
 * Unit tests for pf_rx{} and pf_tx{} builtins and SerialBits.buildBits().
 * Tests compilation and serial bit encoding only — no heavy simulation.
 */

import { describe, it, expect } from 'vitest';
import { GA144 } from './ga144';
import { SerialBits } from './serial';
import { compileCube } from './cube';

// Test baud rates expressed in Hz. These are chosen to give round nanosecond values.
// 1e9/150 Hz → 150 ns/bit (equivalent to 100 ticks × 1.5 ns/tick)
const BAUD_150NS = 1e9 / 150;   // ≈ 6_666_667 Hz, 150 ns/bit
const BAUD_150NS_IDLE_300NS = 300e-9; // 200 ticks × 1.5 ns = 300 ns idle

describe('pf_rx and pf_tx compilation', () => {
  it('compiles pf_rx without errors and under 64 words', () => {
    const compiled = compileCube(`node 200\n/\\\npf_rx{}\n`);
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.nodes).toHaveLength(1);
    expect(compiled.nodes[0].len).toBeLessThanOrEqual(64);
  });

  it('compiles pf_tx without errors and under 64 words', () => {
    const compiled = compileCube(`node 100\n/\\\npf_tx{}\n`);
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.nodes).toHaveLength(1);
    expect(compiled.nodes[0].len).toBeLessThanOrEqual(64);
  });

  it('compiles HELLO-PF (both nodes) without errors', () => {
    const source = `node 200\n/\\\npf_rx{}\n\nnode 100\n/\\\npf_tx{}\n`;
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.nodes).toHaveLength(2);
  });
});

describe('SerialBits.buildBits (RS232 polarity)', () => {
  it('produces correct bit count for a single byte', () => {
    // 8N1: 1 start + 8 data + 1 stop + 2 trailing = 12 bit periods, plus idle
    const bitNS = 150;
    const idleNS = 300;
    const bits = SerialBits.buildBits([0x41], BAUD_150NS, BAUD_150NS_IDLE_300NS);
    const totalDuration = bits.reduce((s, b) => s + b.durationNS, 0);
    expect(totalDuration).toBe(idleNS + 10 * bitNS + 2 * bitNS);
  });

  it('idle is LOW, first non-idle segment is HIGH (RS232 start bit)', () => {
    const bits = SerialBits.buildBits([0xFF], BAUD_150NS, BAUD_150NS_IDLE_300NS);
    expect(bits[0].value).toBe(false); // RS232 idle = LOW
    expect(bits[1].value).toBe(true);  // RS232 start bit = HIGH
  });

  it('byte 0x00: all-zero data inverts to all-HIGH after start', () => {
    // RS232: start=HIGH, data bits inverted: 0→HIGH, stop=LOW
    // Byte 0x00: start(H) + 8×data(H) = 9×HIGH merged, then stop(L) + trailing(L)
    const bitNS = 150;
    const bits = SerialBits.buildBits([0x00], BAUD_150NS);
    expect(bits[0].value).toBe(true);
    expect(bits[0].durationNS).toBe(9 * bitNS); // start + 8 inverted-zero data
    expect(bits[1].value).toBe(false);  // stop + trailing = LOW
  });

  it('byte 0xFF: all-one data inverts to all-LOW after start', () => {
    // RS232: start(H), then 8×data inverted(L), then stop(L) + trailing(L)
    const bitNS = 150;
    const bits = SerialBits.buildBits([0xFF], BAUD_150NS);
    expect(bits[0].value).toBe(true);
    expect(bits[0].durationNS).toBe(bitNS); // just start bit (HIGH)
    expect(bits[1].value).toBe(false);
    expect(bits[1].durationNS).toBe(8 * bitNS + bitNS + 2 * bitNS); // data + stop + trailing
  });

  it('NS_PER_TICK is still accessible on GA144', () => {
    expect(GA144.NS_PER_TICK).toBe(1.5);
  });
});
