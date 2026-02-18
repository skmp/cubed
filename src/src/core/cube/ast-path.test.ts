import { describe, it, expect } from 'vitest';
import { tokenizeCube } from './tokenizer';
import { parseCube } from './parser';
import { indexAst, getItemAtPath, getParentPath, getItemIndex, itemPath, clausePath, argPath, termPath } from './ast-path';
import type { CubeProgram, Application, PredicateDef, Unification } from './ast';

function parse(source: string): CubeProgram {
  const { tokens } = tokenizeCube(source);
  const { ast, errors } = parseCube(tokens);
  expect(errors).toHaveLength(0);
  return ast;
}

describe('path encoding helpers', () => {
  it('itemPath encodes correctly', () => {
    expect(itemPath(0)).toBe('i0');
    expect(itemPath(5)).toBe('i5');
  });

  it('clausePath encodes correctly', () => {
    expect(clausePath('i2', 1)).toBe('i2.c1');
  });

  it('argPath encodes correctly', () => {
    expect(argPath('i0', 2)).toBe('i0.a2');
  });

  it('termPath encodes correctly', () => {
    expect(termPath('i0.a1')).toBe('i0.a1.v');
  });
});

describe('indexAst', () => {
  it('indexes a single application', () => {
    const ast = parse('plus{a=1, b=2, c=x}');
    const index = indexAst(ast);
    // Root item
    expect(index.has('i0')).toBe(true);
    const item = index.get('i0');
    expect(item).toBeDefined();
    expect((item as Application).kind).toBe('application');
    // Args
    expect(index.has('i0.a0')).toBe(true);
    expect(index.has('i0.a1')).toBe(true);
    expect(index.has('i0.a2')).toBe(true);
    // Term values
    expect(index.has('i0.a0.v')).toBe(true);
    expect(index.has('i0.a1.v')).toBe(true);
    expect(index.has('i0.a2.v')).toBe(true);
  });

  it('indexes a predicate definition with clauses', () => {
    const ast = parse('foo = lambda{x}. (bar{a=x} \\/ baz{a=x})');
    const index = indexAst(ast);
    expect(index.has('i0')).toBe(true);
    // Clauses
    expect(index.has('i0.c0')).toBe(true);
    expect(index.has('i0.c1')).toBe(true);
    // Items in clauses
    expect(index.has('i0.c0.i0')).toBe(true);
    expect(index.has('i0.c1.i0')).toBe(true);
  });

  it('indexes multiple conjunction items', () => {
    const ast = parse('a{x=1} /\\ b{y=2} /\\ x = 3');
    const index = indexAst(ast);
    expect(index.has('i0')).toBe(true);
    expect(index.has('i1')).toBe(true);
    expect(index.has('i2')).toBe(true);
  });

  it('indexes unifications', () => {
    const ast = parse('x = 42');
    const index = indexAst(ast);
    expect(index.has('i0')).toBe(true);
    expect(index.has('i0.v')).toBe(true); // term value
  });
});

describe('getItemAtPath', () => {
  it('gets root-level items', () => {
    const ast = parse('a{x=1} /\\ b{y=2}');
    const item0 = getItemAtPath(ast, 'i0');
    expect(item0).toBeDefined();
    expect((item0 as Application).functor).toBe('a');

    const item1 = getItemAtPath(ast, 'i1');
    expect(item1).toBeDefined();
    expect((item1 as Application).functor).toBe('b');
  });

  it('gets items inside predicate clauses', () => {
    const ast = parse('foo = lambda{x}. (bar{a=x} \\/ baz{a=x})');
    const item = getItemAtPath(ast, 'i0.c1.i0');
    expect(item).toBeDefined();
    expect((item as Application).functor).toBe('baz');
  });

  it('returns undefined for out-of-range paths', () => {
    const ast = parse('a{x=1}');
    expect(getItemAtPath(ast, 'i99')).toBeUndefined();
  });

  it('returns the item when path has inapplicable segments', () => {
    // i0 is an application, not a predicate — trying to access clause .c0 just returns i0 itself
    const ast = parse('a{x=1}');
    const result = getItemAtPath(ast, 'i0.c0.i0');
    expect(result).toBeDefined();
    expect((result as Application).functor).toBe('a');
  });
});

describe('getParentPath', () => {
  it('returns empty for root items', () => {
    expect(getParentPath('i0')).toBe('');
    expect(getParentPath('i3')).toBe('');
  });

  it('returns parent for nested items', () => {
    expect(getParentPath('i2.c1.i0')).toBe('i2.c1');
  });
});

describe('getItemIndex', () => {
  it('extracts index from root path', () => {
    expect(getItemIndex('i0')).toBe(0);
    expect(getItemIndex('i5')).toBe(5);
  });

  it('extracts index from nested path', () => {
    expect(getItemIndex('i2.c1.i3')).toBe(3);
  });
});
