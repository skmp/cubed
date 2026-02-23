import { describe, it, expect } from 'vitest';
import { ROM_DATA } from './rom-data';
import { XOR_ENCODING } from './types';
import { OPCODES } from './constants';

function decodeOp(n: number): string { return OPCODES[n] ?? `?${n}`; }

function disasmWord(raw: number, addr: number): string {
  const s0 = (raw >> 13) & 0x1F;
  const s1 = (raw >> 8)  & 0x1F;
  const s2 = (raw >> 3)  & 0x1F;
  const s3 = (raw & 0x7) << 2;
  const BRANCH = new Set([2, 4, 5, 6, 7]);
  const parts: string[] = [];
  if (BRANCH.has(s0)) {
    return `[${String(addr).padStart(3)}] ${decodeOp(s0)}(${raw & 0x1FFF})`;
  }
  parts.push(decodeOp(s0));
  if (BRANCH.has(s1)) {
    parts.push(`${decodeOp(s1)}(${raw & 0xFF})`);
    return `[${String(addr).padStart(3)}] ${parts.join(' | ')}`;
  }
  parts.push(decodeOp(s1));
  if (BRANCH.has(s2)) {
    parts.push(`${decodeOp(s2)}(${raw & 0x7})`);
    return `[${String(addr).padStart(3)}] ${parts.join(' | ')}`;
  }
  parts.push(decodeOp(s2));
  parts.push(decodeOp(s3));
  return `[${String(addr).padStart(3)}] ${parts.join(' | ')}`;
}

describe('ROM data', () => {
  it('ROM_DATA is keyed by node coord (YXX format)', () => {
    expect(typeof ROM_DATA).toBe('object');
    // Node 0 (row 0, col 0) exists
    expect(ROM_DATA[0]).toBeDefined();
    expect(Array.isArray(ROM_DATA[0])).toBe(true);
    expect(ROM_DATA[0].length).toBe(64);
  });

  it('all 144 nodes have 64-word ROM', () => {
    let count = 0;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 18; col++) {
        const coord = row * 100 + col;
        expect(ROM_DATA[coord], `node ${coord}`).toBeDefined();
        expect(ROM_DATA[coord].length, `node ${coord} length`).toBe(64);
        count++;
      }
    }
    expect(count).toBe(144);
  });

  it('disassembles ROM of node 200', () => {
    const rom = ROM_DATA[200];
    expect(rom).toBeDefined();
    const lines: string[] = [];
    for (let i = 0; i < rom.length; i++) {
      const decoded = rom[i] ^ XOR_ENCODING;
      lines.push(disasmWord(decoded, i + 0x80));
    }
    expect(lines.length).toBe(64);
    console.log(`Node 200 ROM disassembly (first 10 words):`);
    for (const line of lines.slice(0, 10)) console.log(line);
  });
});
