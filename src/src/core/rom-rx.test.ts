import { describe, it, expect } from 'vitest';
import { ROM_DATA } from './rom-data';
import { disassembleRom } from './disassembler';

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
    const lines = disassembleRom(200, ROM_DATA);
    expect(lines.length).toBe(64);
    console.log(`Node 200 ROM disassembly (first 10 words):`);
    for (const line of lines.slice(0, 10)) console.log(line);
  });
});
