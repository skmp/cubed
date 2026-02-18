import { describe, it, expect } from 'vitest';
import { tokenizeCube } from './tokenizer';
import { parseCube } from './parser';
import { serializeCube } from './serializer';
import {
  addConjunctionItem,
  removeConjunctionItem,
  replaceConjunctionItem,
  updateLiteralValue,
  updateNodeLabel,
  addArgBinding,
  removeArgBinding,
  createApplication,
  createUnification,
  createArgBinding,
  createLiteral,
  createVar,
} from './ast-mutations';
import type { CubeProgram, Application, Unification } from './ast';

function parse(source: string): CubeProgram {
  const { tokens } = tokenizeCube(source);
  const { ast, errors } = parseCube(tokens);
  expect(errors).toHaveLength(0);
  return ast;
}

/** Round-trip: mutate AST, serialize, reparse, verify no errors. */
function assertRoundTrips(ast: CubeProgram): CubeProgram {
  const serialized = serializeCube(ast);
  const reparsed = parse(serialized);
  return reparsed;
}

describe('addConjunctionItem', () => {
  it('appends an application to root conjunction', () => {
    const ast = parse('a{x=1}');
    const newAst = addConjunctionItem(ast, '', createApplication('b'));
    expect(newAst.conjunction.items).toHaveLength(2);
    expect((newAst.conjunction.items[1] as Application).functor).toBe('b');
    assertRoundTrips(newAst);
  });

  it('inserts at a specific index', () => {
    const ast = parse('a{x=1} /\\ c{z=3}');
    const newAst = addConjunctionItem(ast, '', createApplication('b'), 1);
    expect(newAst.conjunction.items).toHaveLength(3);
    expect((newAst.conjunction.items[1] as Application).functor).toBe('b');
  });

  it('does not mutate the original AST', () => {
    const ast = parse('a{x=1}');
    const newAst = addConjunctionItem(ast, '', createApplication('b'));
    expect(ast.conjunction.items).toHaveLength(1);
    expect(newAst.conjunction.items).toHaveLength(2);
  });
});

describe('removeConjunctionItem', () => {
  it('removes a root-level item by path', () => {
    const ast = parse('a{x=1} /\\ b{y=2} /\\ c{z=3}');
    const newAst = removeConjunctionItem(ast, 'i1');
    expect(newAst.conjunction.items).toHaveLength(2);
    expect((newAst.conjunction.items[0] as Application).functor).toBe('a');
    expect((newAst.conjunction.items[1] as Application).functor).toBe('c');
    assertRoundTrips(newAst);
  });

  it('handles removing the only item', () => {
    const ast = parse('a{x=1}');
    const newAst = removeConjunctionItem(ast, 'i0');
    expect(newAst.conjunction.items).toHaveLength(0);
  });

  it('does not mutate the original AST', () => {
    const ast = parse('a{x=1} /\\ b{y=2}');
    const newAst = removeConjunctionItem(ast, 'i0');
    expect(ast.conjunction.items).toHaveLength(2);
    expect(newAst.conjunction.items).toHaveLength(1);
  });
});

describe('replaceConjunctionItem', () => {
  it('replaces a root-level item', () => {
    const ast = parse('a{x=1} /\\ b{y=2}');
    const newAst = replaceConjunctionItem(ast, 'i1', createApplication('c'));
    expect((newAst.conjunction.items[1] as Application).functor).toBe('c');
    assertRoundTrips(newAst);
  });
});

describe('updateLiteralValue', () => {
  it('updates a literal inside an application arg', () => {
    const ast = parse('plus{a=1, b=2, c=x}');
    const newAst = updateLiteralValue(ast, 'i0.a0.v', 99);
    const app = newAst.conjunction.items[0] as Application;
    expect(app.args[0].value.kind).toBe('literal');
    if (app.args[0].value.kind === 'literal') {
      expect(app.args[0].value.value).toBe(99);
    }
    assertRoundTrips(newAst);
  });

  it('does not mutate the original AST', () => {
    const ast = parse('plus{a=1, b=2, c=x}');
    const newAst = updateLiteralValue(ast, 'i0.a0.v', 99);
    const origApp = ast.conjunction.items[0] as Application;
    if (origApp.args[0].value.kind === 'literal') {
      expect(origApp.args[0].value.value).toBe(1);
    }
  });
});

describe('updateNodeLabel', () => {
  it('renames an application functor', () => {
    const ast = parse('foo{x=1}');
    const newAst = updateNodeLabel(ast, 'i0', 'bar');
    expect((newAst.conjunction.items[0] as Application).functor).toBe('bar');
    assertRoundTrips(newAst);
  });

  it('renames a unification variable', () => {
    const ast = parse('x = 42');
    const newAst = updateNodeLabel(ast, 'i0', 'y');
    expect((newAst.conjunction.items[0] as Unification).variable).toBe('y');
    assertRoundTrips(newAst);
  });
});

describe('addArgBinding', () => {
  it('adds an arg to an application', () => {
    const ast = parse('foo{x=1}');
    const newAst = addArgBinding(ast, 'i0', createArgBinding('y', createLiteral(2)));
    const app = newAst.conjunction.items[0] as Application;
    expect(app.args).toHaveLength(2);
    expect(app.args[1].name).toBe('y');
    assertRoundTrips(newAst);
  });
});

describe('removeArgBinding', () => {
  it('removes an arg from an application', () => {
    const ast = parse('plus{a=1, b=2, c=x}');
    const newAst = removeArgBinding(ast, 'i0.a1');
    const app = newAst.conjunction.items[0] as Application;
    expect(app.args).toHaveLength(2);
    expect(app.args[0].name).toBe('a');
    expect(app.args[1].name).toBe('c');
    assertRoundTrips(newAst);
  });
});

describe('factory functions', () => {
  it('createApplication produces valid AST', () => {
    const app = createApplication('test', [
      createArgBinding('x', createLiteral(42)),
      createArgBinding('y', createVar('z')),
    ]);
    expect(app.kind).toBe('application');
    expect(app.functor).toBe('test');
    expect(app.args).toHaveLength(2);
  });

  it('createUnification produces valid AST', () => {
    const uni = createUnification('x', createLiteral(42));
    expect(uni.kind).toBe('unification');
    expect(uni.variable).toBe('x');
    expect(uni.term.kind).toBe('literal');
  });
});
