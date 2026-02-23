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

describe('GA144.buildSerialBits', () => {
  it('produces correct bit count for a single byte', () => {
    // 8N1: 1 start + 8 data + 1 stop = 10 bits per byte
    const bits = GA144.buildSerialBits([0x41], 100, 200);
    const totalDuration = bits.reduce((s, b) => s + b.duration, 0);
    expect(totalDuration).toBe(200 + 10 * 100 + 200);
  });

  it('first non-idle segment is low (start bit)', () => {
    const bits = GA144.buildSerialBits([0xFF], 100, 200);
    expect(bits[0].value).toBe(true);  // idle
    expect(bits[1].value).toBe(false); // start bit
  });

  it('byte 0x00 is all zero data bits (all low after start)', () => {
    const bits = GA144.buildSerialBits([0x00], 100, 0);
    expect(bits[0].value).toBe(false);
    expect(bits[0].duration).toBe(900); // start + 8 data merged = 9 × 100
    expect(bits[1].value).toBe(true);   // stop + trailing
  });

  it('byte 0xFF is all one data bits', () => {
    const bits = GA144.buildSerialBits([0xFF], 100, 0);
    expect(bits[0].value).toBe(false);
    expect(bits[0].duration).toBe(100); // start bit only
    expect(bits[1].value).toBe(true);
    expect(bits[1].duration).toBe(8 * 100 + 100 + 2 * 100); // data + stop + trailing
  });
});
