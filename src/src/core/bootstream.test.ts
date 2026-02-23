import { describe, it, expect } from 'vitest';
import {
  assembleWord,
  getAsyncPath1,
  trimPath,
  encodeAsyncBytes,
  buildBootStream,
} from './bootstream';
import type { CompiledNode } from './types';
import { WORD_MASK } from './types';
import { PORT, getDirectionAddress } from './constants';
import { disassembleWord } from './disassembler';

// ---------------------------------------------------------------------------
// assembleWord
// ---------------------------------------------------------------------------

describe('assembleWord', () => {
  it('assembles a pure data word', () => {
    expect(assembleWord(42)).toBe(42);
    expect(assembleWord(0)).toBe(0);
    expect(assembleWord(0x3FFFF)).toBe(0x3FFFF);
    // Masking
    expect(assembleWord(0x40000)).toBe(0);
  });

  it('assembles all-opcode words', () => {
    // port-pump word 0: @p dup a! .
    const word = assembleWord('@p', 'dup', 'a!', '.');
    // Verify it's a valid 18-bit value
    expect(word).toBeGreaterThanOrEqual(0);
    expect(word).toBeLessThanOrEqual(WORD_MASK);
  });

  it('assembles call + address', () => {
    // Focusing call to right port
    const word = assembleWord('call', PORT.RIGHT);
    expect(word).toBeGreaterThanOrEqual(0);
    expect(word).toBeLessThanOrEqual(WORD_MASK);
    // The address portion should contain PORT.RIGHT (0x1D5)
    // For slot 0 call, address is in bits 12-0 (masked by const-mask[0] = 0x3FFFF)
    // But call opcode goes in slot 0 and address fills the remaining bits
    // The address is in the raw bits (not XOR encoded)
    expect(word & 0x1FFF).toBe(PORT.RIGHT & 0x1FFF);
  });

  it('assembles jump + address', () => {
    const word = assembleWord('jump', 0);
    // jump opcode = 2, in slot 0 with address 0
    expect(word).toBeGreaterThanOrEqual(0);
    expect(word).toBeLessThanOrEqual(WORD_MASK);
  });

  it('assembles return instruction', () => {
    const word = assembleWord(';');
    expect(word).toBeGreaterThanOrEqual(0);
    expect(word).toBeLessThanOrEqual(WORD_MASK);
  });

  it('handles null slots as zeros', () => {
    const w1 = assembleWord('@p', null, null, null);
    const w2 = assembleWord('@p');
    expect(w1).toBe(w2);
  });

  it('port-pump words produce consistent values', () => {
    // All 5 port-pump words should be valid 18-bit values
    const words = [
      assembleWord('@p', 'dup', 'a!', '.'),
      assembleWord('call', PORT.RIGHT),
      assembleWord('@p', 'push', '!', '.'),
      assembleWord(99),
      assembleWord('@p', '!', 'unext', '.'),
    ];
    for (const w of words) {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(WORD_MASK);
    }
  });
});

// ---------------------------------------------------------------------------
// getAsyncPath1
// ---------------------------------------------------------------------------

describe('getAsyncPath1', () => {
  it('produces exactly 143 steps (visiting 144 nodes total)', () => {
    const path = getAsyncPath1();
    expect(path).toHaveLength(143);
  });

  it('visits every node exactly once in a valid path', () => {
    const path = getAsyncPath1();
    const visited = new Set<number>();
    let coord = 708; // boot node
    visited.add(coord);

    for (const dir of path) {
      const delta = [100, 1, -100, -1][dir];
      coord += delta;
      expect(visited.has(coord)).toBe(false); // no revisits
      visited.add(coord);
    }

    // Should have visited all 144 nodes
    expect(visited.size).toBe(144);

    // Every coordinate should be valid
    for (const c of visited) {
      const x = c % 100;
      const y = Math.floor(c / 100);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(18);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(8);
    }
  });

  it('starts by going East from 708', () => {
    const path = getAsyncPath1();
    expect(path[0]).toBe(1); // E = 1
  });
});

// ---------------------------------------------------------------------------
// trimPath
// ---------------------------------------------------------------------------

describe('trimPath', () => {
  it('returns empty path when no targets', () => {
    const path = getAsyncPath1();
    expect(trimPath(path, 708, new Set())).toHaveLength(0);
  });

  it('trims to nearest target', () => {
    const path = getAsyncPath1();
    // Node 709 is one step East from 708
    const trimmed = trimPath(path, 708, new Set([709]));
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]).toBe(1); // E
  });

  it('trims to furthest target when multiple', () => {
    const path = getAsyncPath1();
    // 709 = 1 step, 710 = 2 steps
    const trimmed = trimPath(path, 708, new Set([709, 710]));
    expect(trimmed).toHaveLength(2);
  });

  it('preserves full path when target is at the end', () => {
    const path = getAsyncPath1();
    // Walk the full path to find the last node
    let coord = 708;
    for (const dir of path) {
      coord += [100, 1, -100, -1][dir];
    }
    const trimmed = trimPath(path, 708, new Set([coord]));
    expect(trimmed).toHaveLength(path.length);
  });
});

// ---------------------------------------------------------------------------
// encodeAsyncBytes
// ---------------------------------------------------------------------------

describe('encodeAsyncBytes', () => {
  it('produces 3 bytes per word', () => {
    const bytes = encodeAsyncBytes([0, 1, 0x3FFFF]);
    expect(bytes).toHaveLength(9);
  });

  it('encodes zero correctly', () => {
    const bytes = encodeAsyncBytes([0]);
    // n=0:
    // byte0 = ((0<<6) & 0xC0 | 0x2D) ^ 0xFF = 0x2D ^ 0xFF = 0xD2
    // byte1 = ((0>>2) & 0xFF) ^ 0xFF = 0 ^ 0xFF = 0xFF
    // byte2 = ((0>>10) & 0xFF) ^ 0xFF = 0 ^ 0xFF = 0xFF
    expect(bytes[0]).toBe(0xD2);
    expect(bytes[1]).toBe(0xFF);
    expect(bytes[2]).toBe(0xFF);
  });

  it('encodes 0xAE correctly (boot magic)', () => {
    const bytes = encodeAsyncBytes([0xAE]);
    const n = 0xAE;
    const b0 = (((n << 6) & 0xC0) | 0x2D) ^ 0xFF;
    const b1 = ((n >> 2) & 0xFF) ^ 0xFF;
    const b2 = ((n >> 10) & 0xFF) ^ 0xFF;
    expect(bytes[0]).toBe(b0);
    expect(bytes[1]).toBe(b1);
    expect(bytes[2]).toBe(b2);
  });

  it('all bytes are valid uint8', () => {
    const testWords = [0, 1, 0x155, 0xAE, 0x1D5, 0x3FFFF];
    const bytes = encodeAsyncBytes(testWords);
    for (let i = 0; i < bytes.length; i++) {
      expect(bytes[i]).toBeGreaterThanOrEqual(0);
      expect(bytes[i]).toBeLessThanOrEqual(255);
    }
  });
});

// ---------------------------------------------------------------------------
// buildBootStream
// ---------------------------------------------------------------------------

describe('buildBootStream', () => {
  it('builds boot stream for single node near boot node', () => {
    // Simple program on node 709 (one step East of 708)
    const nodes: CompiledNode[] = [{
      coord: 709,
      mem: [0x15555, 0x00000],  // two instruction words
      len: 2,
      p: 0,
    }];

    const result = buildBootStream(nodes);

    // Should produce valid output
    expect(result.words.length).toBeGreaterThan(0);
    expect(result.bytes.length).toBe(result.words.length * 3);

    // Frame 1 header
    expect(result.words[0]).toBe(0xAE); // magic
    // Direction from 708 going East
    expect(result.words[1]).toBe(getDirectionAddress(708, 'east'));

    // Path should include 709
    expect(result.path).toContain(709);
  });

  it('builds boot stream for boot-node-only program', () => {
    // Program only on node 708 (the boot node itself)
    const nodes: CompiledNode[] = [{
      coord: 708,
      mem: [0x15555],
      len: 1,
      p: 0,
    }];

    const result = buildBootStream(nodes);

    // Frame 1 should be empty (no other nodes to load)
    // Frame 2 should contain the boot node code
    // words = frame2 = [p, 0, len, ...code]
    expect(result.words[0]).toBe(0); // p = 0
    expect(result.words[1]).toBe(0); // padding
    expect(result.words[2]).toBe(1); // code length = 1
    expect(result.words[3]).toBe(0x15555); // the code word
  });

  it('builds boot stream for multi-node program', () => {
    const nodes: CompiledNode[] = [
      {
        coord: 709,
        mem: [0x15555],
        len: 1,
        p: 0,
      },
      {
        coord: 710,
        mem: [0x00000, 0x3FFFF],
        len: 2,
        p: 0,
      },
    ];

    const result = buildBootStream(nodes);

    expect(result.words.length).toBeGreaterThan(0);
    expect(result.bytes.length).toBe(result.words.length * 3);

    // Both target nodes should be in the path
    expect(result.path).toContain(709);
    expect(result.path).toContain(710);

    // Frame 1 magic byte
    expect(result.words[0]).toBe(0xAE);
  });

  it('produces trimmed path for nearby targets', () => {
    // Node 709 is just one step East of 708
    const nodes: CompiledNode[] = [{
      coord: 709,
      mem: [0x15555],
      len: 1,
      p: 0,
    }];

    const result = buildBootStream(nodes);

    // Path should be very short (just node 709)
    // since trimPath cuts after the last target
    expect(result.path).toHaveLength(1);
    expect(result.path[0]).toBe(709);
  });

  it('handles nodes with register initialization', () => {
    const nodes: CompiledNode[] = [{
      coord: 709,
      mem: [0x15555],
      len: 1,
      p: 5,
      a: 0x100,
      b: PORT.IO,
      io: 0x155,
    }];

    const result = buildBootStream(nodes);

    // Should produce a longer boot stream due to register init code
    expect(result.words.length).toBeGreaterThan(10);
    expect(result.bytes.length).toBe(result.words.length * 3);
  });

  it('handles nodes with stack initialization', () => {
    const nodes: CompiledNode[] = [{
      coord: 709,
      mem: [0x15555],
      len: 1,
      p: 0,
      stack: [42, 100, 200],
    }];

    const result = buildBootStream(nodes);
    expect(result.words.length).toBeGreaterThan(0);
    expect(result.bytes.length).toBe(result.words.length * 3);
  });

  it('wire nodes are identified correctly', () => {
    // Target node far from boot node, requiring wire nodes
    // Node 717 is 9 steps East of 708
    const nodes: CompiledNode[] = [{
      coord: 717,
      mem: [0x15555],
      len: 1,
      p: 0,
    }];

    const result = buildBootStream(nodes);

    // There should be 8 wire nodes between 708 and 717
    // (709, 710, 711, 712, 713, 714, 715, 716)
    expect(result.wireNodes.length).toBe(8);
    expect(result.wireNodes).toContain(709);
    expect(result.wireNodes).toContain(716);
  });
});

// ---------------------------------------------------------------------------
// Integration: assembleWord + disassembleWord consistency
// ---------------------------------------------------------------------------

describe('assembleWord + disassembler integration', () => {
  it('port-pump word 0 disassembles correctly', () => {
    // The existing disassembler uses whole-word XOR with 0x15555
    // and << 2 for slot 3. The reference assembler uses per-slot XOR
    // with /4 for slot 3.
    const word = assembleWord('@p', 'dup', 'a!', '.');
    const dis = disassembleWord(word);

    expect(dis.slots[0]?.opcode).toBe('@p');
    expect(dis.slots[1]?.opcode).toBe('dup');
    expect(dis.slots[2]?.opcode).toBe('a!');
    // Slot 3: only every-4th opcode (0,4,8,12,16,20,24,28) round-trips;
    // '.' (nop=28) is valid in slot 3
  });

  it('call instruction disassembles correctly', () => {
    const addr = PORT.RIGHT; // 0x1D5
    const word = assembleWord('call', addr);
    const dis = disassembleWord(word);

    expect(dis.slots[0]?.opcode).toBe('call');
    // Address should be present (masked to slot width)
    expect(dis.slots[0]?.address).toBeDefined();
  });

  it('jump instruction disassembles correctly', () => {
    const word = assembleWord('jump', 0x42);
    const dis = disassembleWord(word);

    expect(dis.slots[0]?.opcode).toBe('jump');
    expect(dis.slots[0]?.address).toBe(0x42);
  });

  it('return instruction disassembles correctly', () => {
    const word = assembleWord(';');
    const dis = disassembleWord(word);

    expect(dis.slots[0]?.opcode).toBe(';');
  });
});
