import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { tokenizeCube } from './tokenizer';
import { parseCube } from './parser';
import { serializeCube } from './serializer';
import type { CubeProgram, Application } from './ast';

/** Parse source text into AST, asserting no errors. */
function parse(source: string): CubeProgram {
  const { tokens, errors: tokErrors } = tokenizeCube(source);
  expect(tokErrors).toHaveLength(0);
  const { ast, errors: parseErrors } = parseCube(tokens);
  expect(parseErrors).toHaveLength(0);
  return ast;
}

/** Strip loc fields for structural comparison (locs change after serialization). */
function stripLocs(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripLocs);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'loc') continue;
      result[k] = stripLocs(v);
    }
    return result;
  }
  return obj;
}

describe('serializeCube', () => {
  it('serializes a simple application', () => {
    const source = 'plus{a=1, b=2, c=x}';
    const ast = parse(source);
    const serialized = serializeCube(ast);
    expect(serialized).toContain('plus');
    expect(serialized).toContain('a=1');
    expect(serialized).toContain('b=2');
    expect(serialized).toContain('c=x');
  });

  it('serializes a unification', () => {
    const source = 'x = 42';
    const ast = parse(source);
    const serialized = serializeCube(ast);
    expect(serialized).toContain('x = 42');
  });

  it('serializes hex literals for values >= 0x100', () => {
    const source = 'f18a.setb{addr=0x155}';
    const ast = parse(source);
    const serialized = serializeCube(ast);
    expect(serialized).toContain('0x155');
  });

  it('serializes a predicate definition', () => {
    const source = 'foo = lambda{a, b}. plus{a=a, b=b, c=c}';
    const ast = parse(source);
    const serialized = serializeCube(ast);
    expect(serialized).toContain('foo = lambda{a, b}.');
    expect(serialized).toContain('plus');
  });

  it('serializes multi-clause predicate definitions', () => {
    const source = 'foo = lambda{x}. (bar{a=x} \\/ baz{a=x})';
    const ast = parse(source);
    const serialized = serializeCube(ast);
    expect(serialized).toContain('\\/');
    expect(serialized).toContain('bar');
    expect(serialized).toContain('baz');
  });

  it('serializes node directives', () => {
    const source = 'node 117\n\n/\\\n\nfill{value=0x155, count=640}';
    const ast = parse(source);
    const serialized = serializeCube(ast);
    expect(serialized).toContain('node 117');
    expect(serialized).toContain('fill');
  });

  it('serializes conjunctions with /\\', () => {
    const source = 'a{} /\\ b{}';
    const ast = parse(source);
    const serialized = serializeCube(ast);
    expect(serialized).toContain('/\\');
  });

  it('serializes zero-arg applications without braces', () => {
    const source = 'node 0\n\n/\\\n\nagain{}';
    const ast = parse(source);
    const serialized = serializeCube(ast);
    // 'again' with no args should serialize as 'again' (from the AST which has args=[])
    // But it was parsed from 'again{}' which gives args=[]
    const reparsed = parse(serialized);
    const items = reparsed.conjunction.items;
    const agn = items.find(i => i.kind === 'application' && i.functor === 'again') as Application;
    expect(agn).toBeDefined();
    expect(agn.args).toHaveLength(0);
  });

  it('round-trips a predicate definition', () => {
    const source = 'fib_step = lambda{a:Int, b:Int, next:Int}. plus{a=a, b=b, c=next}';
    const ast1 = parse(source);
    const serialized = serializeCube(ast1);
    const ast2 = parse(serialized);
    expect(stripLocs(ast1)).toEqual(stripLocs(ast2));
  });

  it('round-trips applications with nested terms', () => {
    const source = 'plus{a=1, b=2, c=x} /\\ minus{a=x, b=3, c=y}';
    const ast1 = parse(source);
    const serialized = serializeCube(ast1);
    const ast2 = parse(serialized);
    expect(stripLocs(ast1)).toEqual(stripLocs(ast2));
  });

  it('round-trips multi-node programs', () => {
    const source = 'node 117\n\n/\\\n\nfill{value=0x155, count=640}\n\nnode 617\n\n/\\\n\nfill{value=0x0AA, count=640}';
    const ast1 = parse(source);
    const serialized = serializeCube(ast1);
    const ast2 = parse(serialized);
    expect(stripLocs(ast1)).toEqual(stripLocs(ast2));
  });
});

// Round-trip tests for sample .cube files
describe('serializer round-trip on sample files', () => {
  const samplesDir = join(__dirname, '../../../samples');
  const sampleFiles = [
    'fibonacci.cube',
    'blue-rectangle.cube',
    'CH.cube',
    'PS.cube',
    'FR.cube',
  ];

  for (const file of sampleFiles) {
    it(`round-trips ${file}`, () => {
      const source = readFileSync(join(samplesDir, file), 'utf-8');
      const ast1 = parse(source);
      const serialized = serializeCube(ast1);
      const ast2 = parse(serialized);
      expect(stripLocs(ast1)).toEqual(stripLocs(ast2));
    });
  }
});
