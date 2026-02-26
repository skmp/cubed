/**
 * Tests for CUBE assembly support:
 * - lit.hex18/hex9/hex8 literal push builtins
 * - lit.ascii/utf8 string packing builtins
 * - f18a.xxx{addr=N} / f18a.xxx{rel=N} address opcodes
 * - String literal tokenization and parsing
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tokenizeCube, CubeTokenType } from './tokenizer';
import { parseCube } from './parser';
import { compileCube } from './compiler';
import { OPCODE_MAP } from '../constants';
import { XOR_ENCODING } from '../types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---- Helpers ----

/** Compile a CUBE source and return the first node's memory */
function compileAndGetMem(source: string): { mem: number[]; len: number; errors: string[] } {
  const result = compileCube(source);
  const errors = result.errors.map(e => e.message);
  if (result.nodes.length === 0) return { mem: [], len: 0, errors };
  return { mem: Array.from(result.nodes[0].mem), len: result.nodes[0].len, errors };
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

  it('variable addr resolves as label reference', () => {
    // addr=x is now valid when x is a label — produces a forward ref
    const source = 'label{name=start} /\\ f18a.dup /\\ f18a.jump{addr=start}';
    const result = compileCube(source);
    expect(result.errors).toHaveLength(0);
    expect(result.nodes.length).toBeGreaterThan(0);
  });
});

// ---- Labels ----

describe('label support', () => {
  it('backward label ref: label then jump', () => {
    const source = 'label{name=loop} /\\ f18a.dup /\\ f18a.storeb /\\ f18a.jump{addr=loop}';
    const { mem, errors } = compileAndGetMem(source);
    expect(errors).toHaveLength(0);
    expect(mem.length).toBeGreaterThan(0);
    // The jump should target address 0 (where label was defined)
    const lastInstrWord = mem[mem.length - 1];
    const jumpAddr = lastInstrWord & 0x3FF;
    expect(jumpAddr).toBe(0);
  });

  it('forward label ref: jump then label', () => {
    const source = 'f18a.jump{addr=skip} /\\ f18a.dup /\\ label{name=skip} /\\ f18a.drop';
    const { mem, errors } = compileAndGetMem(source);
    expect(errors).toHaveLength(0);
    expect(mem.length).toBeGreaterThan(0);
    // First word is the jump — its address should point to where label{name=skip} was defined
    const jumpAddr = mem[0] & 0x3FF;
    // skip label is after the jump word and the dup word
    expect(jumpAddr).toBeGreaterThan(0);
  });

  it('call to label and return', () => {
    const source = [
      'f18a.call{addr=sub}',
      '/\\ f18a.jump{addr=done}',
      '/\\ label{name=sub}',
      '/\\ f18a.dup',
      '/\\ f18a.ret',
      '/\\ label{name=done}',
    ].join(' ');
    const { mem, errors } = compileAndGetMem(source);
    expect(errors).toHaveLength(0);
    expect(mem.length).toBeGreaterThan(0);
  });

  it('next with label for counted loop', () => {
    const source = [
      'lit.hex18{value=9}',
      '/\\ f18a.push',
      '/\\ label{name=loop}',
      '/\\ f18a.dup',
      '/\\ f18a.drop',
      '/\\ f18a.next{addr=loop}',
    ].join(' ');
    const { mem, errors } = compileAndGetMem(source);
    expect(errors).toHaveLength(0);
    expect(mem.length).toBeGreaterThan(0);
  });

  it('undefined label produces error', () => {
    const source = 'f18a.jump{addr=nowhere}';
    const result = compileCube(source);
    // Should produce a warning about unresolved forward ref
    const allMessages = [...result.errors.map(e => e.message), ...result.warnings.map(w => w.message)];
    expect(allMessages.some(m => m.includes('nowhere'))).toBe(true);
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

// ---- f18a.insn tests ----

describe('f18a.insn', () => {
  it('emits a single word with 4 opcodes', () => {
    // a @p a! dup → all 4 slots filled (matching reference yank word 0 pattern)
    const source = 'f18a.insn{s0=f18a.a, s1=f18a.fetchp, s2=f18a.astore, s3=f18a.dup, d=0x115}';
    const { mem, len, errors } = compileAndGetMem(source);
    expect(errors).toHaveLength(0);
    // 2 words (insn + data) + 1 halt loop appended by emitter
    expect(len).toBe(3);
    // Decode instruction word: s0=a(27), s1=@p(8), s2=a!(31), s3=dup(24>>2=6)
    const decoded0 = mem[0] ^ XOR_ENCODING;
    expect((decoded0 >> 13) & 0x1F).toBe(27); // a
    expect((decoded0 >> 8) & 0x1F).toBe(8);   // @p
    expect((decoded0 >> 3) & 0x1F).toBe(31);  // a!
    expect(decoded0 & 0x7).toBe(24 >> 2);     // dup (slot3: 24/4=6)
    // Data word
    expect(mem[1]).toBe(0x115);
  });

  it('fills unspecified slots with nop', () => {
    // Only s0 specified → s1,s2=nop(28), s3=.(28>>2=7)
    const source = 'f18a.insn{s0=f18a.drop}';
    const { mem, errors } = compileAndGetMem(source);
    expect(errors).toHaveLength(0);
    const decoded0 = mem[0] ^ XOR_ENCODING;
    expect((decoded0 >> 13) & 0x1F).toBe(23); // drop
    expect((decoded0 >> 8) & 0x1F).toBe(28);  // nop
    expect((decoded0 >> 3) & 0x1F).toBe(28);  // nop
    expect(decoded0 & 0x7).toBe(7);           // . (slot3 default)
  });

  it('handles ; filling rest of word', () => {
    // store a! ; → should fill s3 with nop
    const source = 'f18a.insn{s0=f18a.store, s1=f18a.astore, s2=f18a.ret}';
    const { mem, errors } = compileAndGetMem(source);
    expect(errors).toHaveLength(0);
    const decoded0 = mem[0] ^ XOR_ENCODING;
    expect((decoded0 >> 13) & 0x1F).toBe(15); // !
    expect((decoded0 >> 8) & 0x1F).toBe(31);  // a!
    expect((decoded0 >> 3) & 0x1F).toBe(0);   // ;
    // s3 filled with nop after ;
    expect(decoded0 & 0x7).toBe(7);           // .
  });

  it('handles jump at slot 0 with address', () => {
    const source = 'f18a.insn{s0=f18a.jump, a=0x10}';
    const { mem, len, errors } = compileAndGetMem(source);
    expect(errors).toHaveLength(0);
    expect(len).toBe(1);
    const decoded0 = mem[0] ^ XOR_ENCODING;
    expect((decoded0 >> 13) & 0x1F).toBe(2); // jump
    expect(mem[0] & 0x1FFF).toBe(0x10);      // address (raw, not XOR-encoded)
  });

  it('handles call at slot 1 with preceding opcode', () => {
    // drop call(0x20) → slot 0 = drop, slot 1 = call with 8-bit address
    const source = 'f18a.insn{s0=f18a.drop, s1=f18a.call, a=0x20}';
    const { mem, len, errors } = compileAndGetMem(source);
    expect(errors).toHaveLength(0);
    expect(len).toBe(1);
    const decoded0 = mem[0] ^ XOR_ENCODING;
    expect((decoded0 >> 13) & 0x1F).toBe(23); // drop
    expect((decoded0 >> 8) & 0x1F).toBe(3);   // call
    expect(mem[0] & 0xFF).toBe(0x20);         // 8-bit address
  });

  it('handles label references in address field', () => {
    const source = 'label{name=target} /\\ f18a.insn{s0=f18a.jump, a=target}';
    const { mem, len, errors } = compileAndGetMem(source);
    expect(errors).toHaveLength(0);
    expect(len).toBe(1);
    // Label is at address 0, so jump target should be 0
    expect(mem[0] & 0x1FFF).toBe(0);
  });
});

// ---- Node boot descriptor syntax ----

describe('node boot descriptor syntax', () => {
  it('parses node with boot descriptors', () => {
    const { tokens, errors } = tokenizeCube('node 112 { a=0x175, b=0x1D5 }');
    expect(errors).toHaveLength(0);
    const { ast, errors: parseErrors } = parseCube(tokens);
    expect(parseErrors).toHaveLength(0);
    const nodeItem = ast.conjunction.items[0];
    expect(nodeItem.kind).toBe('application');
    if (nodeItem.kind === 'application') {
      expect(nodeItem.functor).toBe('__node');
      expect(nodeItem.args).toHaveLength(3); // coord, a, b
      expect(nodeItem.args[0].name).toBe('coord');
      expect(nodeItem.args[1].name).toBe('a');
      expect(nodeItem.args[1].value).toEqual(expect.objectContaining({ kind: 'literal', value: 0x175 }));
      expect(nodeItem.args[2].name).toBe('b');
      expect(nodeItem.args[2].value).toEqual(expect.objectContaining({ kind: 'literal', value: 0x1D5 }));
    }
  });

  it('parses node without boot descriptors (backward compatible)', () => {
    const { tokens, errors } = tokenizeCube('node 112');
    expect(errors).toHaveLength(0);
    const { ast, errors: parseErrors } = parseCube(tokens);
    expect(parseErrors).toHaveLength(0);
    const nodeItem = ast.conjunction.items[0];
    if (nodeItem.kind === 'application') {
      expect(nodeItem.functor).toBe('__node');
      expect(nodeItem.args).toHaveLength(1); // only coord
    }
  });

  it('sets CompiledNode.a and .b from boot descriptors', () => {
    const source = 'node 112 { a=0x175, b=0x1D5 }\n/\\\nf18a.dup';
    const result = compileCube(source);
    expect(result.errors).toHaveLength(0);
    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0];
    expect(node.coord).toBe(112);
    expect(node.a).toBe(0x175);
    expect(node.b).toBe(0x1D5);
  });

  it('sets CompiledNode.p from boot descriptor', () => {
    const source = 'node 016 { p=0x3C }\n/\\\nf18a.dup';
    const result = compileCube(source);
    expect(result.errors).toHaveLength(0);
    const node = result.nodes[0];
    expect(node.p).toBe(0x3C);
  });

  it('sets CompiledNode.io from boot descriptor', () => {
    const source = 'node 112 { io=0x15D }\n/\\\nf18a.dup';
    const result = compileCube(source);
    expect(result.errors).toHaveLength(0);
    const node = result.nodes[0];
    expect(node.io).toBe(0x15D);
  });

  it('does not emit preamble code for boot descriptors', () => {
    // Boot descriptor a/b should NOT produce any code — only metadata.
    // Boot descriptors produce no code — only metadata.
    const source = 'node 112 { a=0x175, b=0x1D5 }\n/\\\nlabel{name=go}\n/\\\nf18a.fetch\n/\\\nf18a.storeb\n/\\\nf18a.jump{addr=go}';
    const result = compileCube(source);
    expect(result.errors).toHaveLength(0);
    const node = result.nodes[0];
    // Should be: [0] @|!b|jump(0) — just 1 word, no preamble
    expect(node.len).toBe(1);
    expect(node.a).toBe(0x175);
    expect(node.b).toBe(0x1D5);
  });

  it('reports error for unknown boot descriptor key', () => {
    const source = 'node 112 { x=5 }\n/\\\nf18a.dup';
    const result = compileCube(source);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain('Unknown node boot descriptor');
  });

  it('combines boot descriptors with all a, b, p', () => {
    const source = 'node 016 { a=0x1D5, b=0x15D, p=0x3C }\n/\\\nf18a.dup';
    const result = compileCube(source);
    expect(result.errors).toHaveLength(0);
    const node = result.nodes[0];
    expect(node.a).toBe(0x1D5);
    expect(node.b).toBe(0x15D);
    expect(node.p).toBe(0x3C);
  });
});

// ---- ROM function address resolution in f18a address opcodes ----

describe('ROM function address resolution', () => {
  it('f18a.call{addr=rom.byte} resolves on node 708', () => {
    const source = 'node 708\n/\\\nf18a.call{addr=rom.byte}';
    const result = compileCube(source);
    expect(result.errors).toHaveLength(0);
    expect(result.nodes).toHaveLength(1);
    const mem = result.nodes[0].mem;
    const decoded = mem[0] ^ XOR_ENCODING;
    expect((decoded >> 13) & 0x1F).toBe(OPCODE_MAP.get('call')!);
    expect(mem[0] & 0x3FF).toBe(0xd0); // rom.byte = 0xd0
  });

  it('f18a.jump{addr=rom.sync} resolves on node 708', () => {
    const source = 'node 708\n/\\\nf18a.jump{addr=rom.sync}';
    const result = compileCube(source);
    expect(result.errors).toHaveLength(0);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].mem[0] & 0x3FF).toBe(0xbe); // rom.sync = 0xbe
  });

  it('rom.xxx on wrong node type produces unresolved ref warning', () => {
    // node 0 has basic ROM, no rom.byte
    const source = 'node 0\n/\\\nf18a.call{addr=rom.byte}';
    const result = compileCube(source);
    const msgs = [
      ...result.errors.map(e => e.message),
      ...(result.warnings?.map(w => w.message) ?? []),
    ];
    expect(msgs.some(m => m.includes('rom.byte'))).toBe(true);
  });
});

// ---- ECHO2.cube end-to-end compilation ----

describe('ECHO2.cube sample', () => {
  it('compiles successfully on node 708', () => {
    const source = readFileSync(
      join(__dirname, '../../../samples/ECHO2.cube'),
      'utf-8',
    );
    const result = compileCube(source);
    expect(result.errors.map(e => `L${e.line}: ${e.message}`)).toEqual([]);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].coord).toBe(708);
    expect(result.nodes[0].len).toBeLessThanOrEqual(64);
  });
});
