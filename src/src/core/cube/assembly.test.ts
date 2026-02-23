/**
 * Tests for CUBE assembly support:
 * - lit.hex18/hex9/hex8 literal push builtins
 * - lit.ascii/utf8 string packing builtins
 * - f18a.xxx{addr=N} / f18a.xxx{rel=N} address opcodes
 * - String literal tokenization and parsing
 */
import { describe, it, expect } from 'vitest';
import { tokenizeCube, CubeTokenType } from './tokenizer';
import { parseCube } from './parser';
import { compileCube } from './compiler';
import { OPCODE_MAP } from '../constants';
import { XOR_ENCODING } from '../types';

// ---- Helpers ----

/** Compile a CUBE source and return the first node's memory */
function compileAndGetMem(source: string): { mem: number[]; errors: string[] } {
  const result = compileCube(source);
  const errors = result.errors.map(e => e.message);
  if (result.nodes.length === 0) return { mem: [], errors };
  return { mem: Array.from(result.nodes[0].mem), errors };
}

/** Decode a data word (raw, not XOR-encoded) from memory following an @p+jump instruction */
function findLiteralData(mem: number[]): number[] {
  const data: number[] = [];
  for (let i = 0; i < mem.length; i++) {
    const decoded = mem[i] ^ XOR_ENCODING;
    const s0 = (decoded >> 13) & 0x1F;
    // @p is opcode 8
    if (s0 === 8) {
      // Next word after the instruction word containing @p is the jump target,
      // and the word after that is the data. But with emitLiteral, the layout is:
      // word[i] = @p + jump(i+2) encoded, word[i+1] = raw data
      if (i + 1 < mem.length) {
        data.push(mem[i + 1]); // data word is raw (not XOR-encoded)
        i++; // skip data word
      }
    }
  }
  return data;
}

// ---- Tokenizer tests ----

describe('string literal tokenization', () => {
  it('tokenizes a simple string', () => {
    const { tokens, errors } = tokenizeCube('"hello"');
    expect(errors).toHaveLength(0);
    expect(tokens[0].type).toBe(CubeTokenType.STRING_LIT);
    expect(tokens[0].strValue).toBe('hello');
  });

  it('handles escape sequences', () => {
    const { tokens, errors } = tokenizeCube('"a\\nb\\t\\r\\\\"');
    expect(errors).toHaveLength(0);
    expect(tokens[0].strValue).toBe('a\nb\t\r\\');
  });

  it('handles escaped quote', () => {
    const { tokens, errors } = tokenizeCube('"say \\"hi\\""');
    expect(errors).toHaveLength(0);
    expect(tokens[0].strValue).toBe('say "hi"');
  });

  it('handles empty string', () => {
    const { tokens, errors } = tokenizeCube('""');
    expect(errors).toHaveLength(0);
    expect(tokens[0].type).toBe(CubeTokenType.STRING_LIT);
    expect(tokens[0].strValue).toBe('');
  });
});

// ---- Parser tests ----

describe('string literal parsing', () => {
  it('parses string as argument value', () => {
    const { tokens } = tokenizeCube('lit.ascii{s="AB"}');
    const { ast, errors } = parseCube(tokens);
    expect(errors).toHaveLength(0);
    const item = ast.conjunction.items[0];
    expect(item.kind).toBe('application');
    if (item.kind === 'application') {
      expect(item.functor).toBe('lit.ascii');
      expect(item.args[0].name).toBe('s');
      expect(item.args[0].value.kind).toBe('string_literal');
      if (item.args[0].value.kind === 'string_literal') {
        expect(item.args[0].value.value).toBe('AB');
      }
    }
  });
});

// ---- lit.hex18 tests ----

describe('lit.hex18', () => {
  it('pushes an 18-bit literal', () => {
    const { mem, errors } = compileAndGetMem('lit.hex18{value=0x3FFFF}');
    expect(errors).toHaveLength(0);
    expect(mem.length).toBeGreaterThan(0);
    const data = findLiteralData(mem);
    expect(data).toContain(0x3FFFF);
  });

  it('masks to 18 bits', () => {
    const { mem, errors } = compileAndGetMem('lit.hex18{value=0x40000}');
    expect(errors).toHaveLength(0);
    const data = findLiteralData(mem);
    // 0x40000 & 0x3FFFF = 0
    expect(data).toContain(0);
  });

  it('pushes a small value', () => {
    const { mem, errors } = compileAndGetMem('lit.hex18{value=42}');
    expect(errors).toHaveLength(0);
    const data = findLiteralData(mem);
    expect(data).toContain(42);
  });
});

// ---- lit.hex9 tests ----

describe('lit.hex9', () => {
  it('pushes a 9-bit literal', () => {
    const { mem, errors } = compileAndGetMem('lit.hex9{value=0x1FF}');
    expect(errors).toHaveLength(0);
    const data = findLiteralData(mem);
    expect(data).toContain(0x1FF);
  });

  it('masks values above 9 bits', () => {
    const { mem, errors } = compileAndGetMem('lit.hex9{value=0x200}');
    expect(errors).toHaveLength(0);
    const data = findLiteralData(mem);
    // 0x200 & 0x1FF = 0
    expect(data).toContain(0);
  });
});

// ---- lit.hex8 tests ----

describe('lit.hex8', () => {
  it('pushes an 8-bit literal', () => {
    const { mem, errors } = compileAndGetMem('lit.hex8{value=0xFF}');
    expect(errors).toHaveLength(0);
    const data = findLiteralData(mem);
    expect(data).toContain(0xFF);
  });
});

// ---- lit.ascii tests ----

describe('lit.ascii', () => {
  it('packs 2 ASCII chars into one word', () => {
    const { mem, errors } = compileAndGetMem('lit.ascii{s="AB"}');
    expect(errors).toHaveLength(0);
    const data = findLiteralData(mem);
    // 'A'=65, 'B'=66 → (65 << 9) | 66 = 33344 + 66 = 33346
    expect(data).toContain((65 << 9) | 66);
  });

  it('pads odd-length strings', () => {
    const { mem, errors } = compileAndGetMem('lit.ascii{s="A"}');
    expect(errors).toHaveLength(0);
    const data = findLiteralData(mem);
    // 'A'=65, pad=0 → (65 << 9) | 0
    expect(data).toContain(65 << 9);
  });

  it('handles empty string', () => {
    const { mem, errors } = compileAndGetMem('lit.ascii{s=""}');
    expect(errors).toHaveLength(0);
    const data = findLiteralData(mem);
    expect(data).toContain(0);
  });

  it('packs 4 chars into 2 words', () => {
    const { mem, errors } = compileAndGetMem('lit.ascii{s="ABCD"}');
    expect(errors).toHaveLength(0);
    const data = findLiteralData(mem);
    expect(data).toContain((65 << 9) | 66); // "AB"
    expect(data).toContain((67 << 9) | 68); // "CD"
  });
});

// ---- lit.utf8 tests ----

describe('lit.utf8', () => {
  it('packs ASCII-range UTF-8 same as lit.ascii', () => {
    const { mem, errors } = compileAndGetMem('lit.utf8{s="hi"}');
    expect(errors).toHaveLength(0);
    const data = findLiteralData(mem);
    // 'h'=104, 'i'=105
    expect(data).toContain((104 << 9) | 105);
  });
});

// ---- f18a address opcode tests ----

describe('f18a address opcodes', () => {
  it('f18a.jump{addr=0x10} emits jump', () => {
    const { mem, errors } = compileAndGetMem('f18a.jump{addr=0x10}');
    expect(errors).toHaveLength(0);
    expect(mem.length).toBeGreaterThan(0);
    // Decode first word: slot 0 should be jump (opcode 2)
    const decoded = mem[0] ^ XOR_ENCODING;
    const s0 = (decoded >> 13) & 0x1F;
    expect(s0).toBe(OPCODE_MAP.get('jump')!);
    // Address is in lower 13 bits (raw, not XOR-encoded)
    const addr = mem[0] & 0x3FF;
    expect(addr).toBe(0x10);
  });

  it('f18a.call{addr=0x20} emits call', () => {
    const { mem, errors } = compileAndGetMem('f18a.call{addr=0x20}');
    expect(errors).toHaveLength(0);
    const decoded = mem[0] ^ XOR_ENCODING;
    const s0 = (decoded >> 13) & 0x1F;
    expect(s0).toBe(OPCODE_MAP.get('call')!);
    const addr = mem[0] & 0x3FF;
    expect(addr).toBe(0x20);
  });

  it('f18a.IF{addr=5} emits conditional branch', () => {
    const { mem, errors } = compileAndGetMem('f18a.IF{addr=5}');
    expect(errors).toHaveLength(0);
    const decoded = mem[0] ^ XOR_ENCODING;
    const s0 = (decoded >> 13) & 0x1F;
    expect(s0).toBe(OPCODE_MAP.get('if')!);
  });

  it('f18a.nif{addr=5} emits negative-if branch', () => {
    const { mem, errors } = compileAndGetMem('f18a.nif{addr=5}');
    expect(errors).toHaveLength(0);
    const decoded = mem[0] ^ XOR_ENCODING;
    const s0 = (decoded >> 13) & 0x1F;
    expect(s0).toBe(OPCODE_MAP.get('-if')!);
  });

  it('f18a.next{addr=0} emits next with address', () => {
    const { mem, errors } = compileAndGetMem('f18a.next{addr=0}');
    expect(errors).toHaveLength(0);
    const decoded = mem[0] ^ XOR_ENCODING;
    const s0 = (decoded >> 13) & 0x1F;
    expect(s0).toBe(OPCODE_MAP.get('next')!);
  });

  it('bare f18a.dup still works (no args)', () => {
    const { mem, errors } = compileAndGetMem('f18a.dup');
    expect(errors).toHaveLength(0);
    expect(mem.length).toBeGreaterThan(0);
  });

  it('errors on non-literal addr', () => {
    // Using a variable instead of a literal should error
    const result = compileCube('f18a.jump{addr=x}');
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---- Integration: lit + f18a together ----

describe('assembly integration', () => {
  it('lit followed by f18a ops compiles', () => {
    const source = 'lit.hex18{value=0x155} /\\ f18a.dup /\\ f18a.astore';
    const { mem, errors } = compileAndGetMem(source);
    expect(errors).toHaveLength(0);
    expect(mem.length).toBeGreaterThan(0);
    const data = findLiteralData(mem);
    expect(data).toContain(0x155);
  });
});
