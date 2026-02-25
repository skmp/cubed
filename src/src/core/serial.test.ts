/**
 * Unit tests for pf_rx{} and pf_tx{} builtins and GA144.buildSerialBits().
 * Tests compilation and serial bit encoding only — no heavy simulation.
 */

import { describe, it, expect } from 'vitest';
import { GA144 } from './ga144';
import { compileCube } from './cube';

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

describe('GA144.buildSerialBits (RS232 polarity)', () => {
  it('produces correct bit count for a single byte', () => {
    // 8N1: 1 start + 8 data + 1 stop = 10 bits per byte
    const bits = GA144.buildSerialBits([0x41], 100, 200);
    const toNS = (ticks: number) => ticks * GA144.NS_PER_TICK;
    const totalDuration = bits.reduce((s, b) => s + b.durationNS, 0);
    expect(totalDuration).toBe(toNS(200 + 10 * 100 + 200));
  });

  it('idle is LOW, first non-idle segment is HIGH (RS232 start bit)', () => {
    const bits = GA144.buildSerialBits([0xFF], 100, 200);
    expect(bits[0].value).toBe(false); // RS232 idle = LOW
    expect(bits[1].value).toBe(true);  // RS232 start bit = HIGH
  });

  it('byte 0x00: all-zero data inverts to all-HIGH after start', () => {
    // RS232: start=HIGH, data bits inverted: 0→HIGH, stop=LOW
    // Byte 0x00: start(H) + 8×data(H) = 9×HIGH merged, then stop(L) + trailing(L)
    const toNS = (ticks: number) => ticks * GA144.NS_PER_TICK;
    const bits = GA144.buildSerialBits([0x00], 100, 0);
    expect(bits[0].value).toBe(true);
    expect(bits[0].durationNS).toBe(toNS(900)); // start + 8 inverted-zero data = 9 × 100
    expect(bits[1].value).toBe(false);  // stop + trailing = LOW
  });

  it('byte 0xFF: all-one data inverts to all-LOW after start', () => {
    // RS232: start(H), then 8×data inverted(L), then stop(L) + trailing(L)
    // start = HIGH 100, then data+stop+trailing = LOW
    const toNS = (ticks: number) => ticks * GA144.NS_PER_TICK;
    const bits = GA144.buildSerialBits([0xFF], 100, 0);
    expect(bits[0].value).toBe(true);
    expect(bits[0].durationNS).toBe(toNS(100)); // just start bit (HIGH)
    expect(bits[1].value).toBe(false);
    expect(bits[1].durationNS).toBe(toNS(8 * 100 + 100 + 2 * 100)); // data + stop + trailing
  });
});
