/**
 * Tests for CUBE standard library (#include std) support:
 * - #include tokenization
 * - std.xxxx builtin resolution and compilation
 * - Error on unknown modules
 * - Backward compatibility with bare names
 */
import { describe, it, expect } from 'vitest';
import { tokenizeCube, CubeTokenType } from './tokenizer';
import { parseCube } from './parser';
import { compileCube } from './compiler';
import { serializeCube } from './serializer';

// ---- Helpers ----

/** Compile a CUBE source and return the first node's memory and errors */
function compileAndGetMem(source: string): { mem: number[]; errors: string[] } {
  const result = compileCube(source);
  const errors = result.errors.map(e => e.message);
  if (result.nodes.length === 0) return { mem: [], errors };
  return { mem: Array.from(result.nodes[0].mem), errors };
}

// ---- Tokenizer tests ----

describe('#include tokenization', () => {
  it('tokenizes #include std', () => {
    const { tokens, errors } = tokenizeCube('#include std');
    expect(errors).toHaveLength(0);
    expect(tokens[0].type).toBe(CubeTokenType.INCLUDE);
    expect(tokens[0].value).toBe('std');
  });

  it('tokenizes #include with extra whitespace', () => {
    const { tokens, errors } = tokenizeCube('#include   std');
    expect(errors).toHaveLength(0);
    expect(tokens[0].type).toBe(CubeTokenType.INCLUDE);
    expect(tokens[0].value).toBe('std');
  });

  it('errors on unknown directive', () => {
    const { errors } = tokenizeCube('#define FOO');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/Unknown directive/);
  });

  it('errors on missing module name', () => {
    const { errors } = tokenizeCube('#include');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/Expected module name/);
  });

  it('#include does not consume trailing tokens', () => {
    const { tokens, errors } = tokenizeCube('#include std\nfill{value=1, count=1}');
    expect(errors).toHaveLength(0);
    expect(tokens[0].type).toBe(CubeTokenType.INCLUDE);
    expect(tokens[1].type).toBe(CubeTokenType.IDENT);
    expect(tokens[1].value).toBe('fill');
  });
});

// ---- Parser tests ----

describe('#include parsing', () => {
  it('parses #include std as __include application', () => {
    const { tokens } = tokenizeCube('#include std');
    const { ast, errors } = parseCube(tokens);
    expect(errors).toHaveLength(0);
    const item = ast.conjunction.items[0];
    expect(item.kind).toBe('application');
    if (item.kind === 'application') {
      expect(item.functor).toBe('__include');
      expect(item.args[0].name).toBe('module');
      expect(item.args[0].value.kind).toBe('var');
      if (item.args[0].value.kind === 'var') {
        expect(item.args[0].value.name).toBe('std');
      }
    }
  });

  it('parses #include std with following code', () => {
    const { tokens } = tokenizeCube('#include std\n/\\\nstd.fill{value=1, count=1}');
    const { ast, errors } = parseCube(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.conjunction.items.length).toBe(2);
    expect(ast.conjunction.items[0].kind).toBe('application');
    expect(ast.conjunction.items[1].kind).toBe('application');
    if (ast.conjunction.items[1].kind === 'application') {
      expect(ast.conjunction.items[1].functor).toBe('std.fill');
    }
  });
});

// ---- Serializer tests ----

describe('#include serialization', () => {
  it('round-trips #include std', () => {
    const { tokens } = tokenizeCube('#include std\n/\\\nstd.fill{value=1, count=1}');
    const { ast } = parseCube(tokens);
    const serialized = serializeCube(ast);
    expect(serialized).toContain('#include std');
    expect(serialized).toContain('std.fill');
  });
});

// ---- Compilation tests ----

describe('std.xxxx builtins', () => {
  it('std.fill compiles when #include std is present', () => {
    const source = '#include std\n/\\\nstd.fill{value=0x155, count=10}';
    const { mem, errors } = compileAndGetMem(source);
    expect(errors).toHaveLength(0);
    expect(mem.length).toBeGreaterThan(0);
  });

  it('std.loop and std.again compile', () => {
    const source = '#include std\n/\\\nstd.loop{n=5}\n/\\\nstd.fill{value=0x155, count=10}\n/\\\nstd.again{}';
    const { mem, errors } = compileAndGetMem(source);
    expect(errors).toHaveLength(0);
    expect(mem.length).toBeGreaterThan(0);
  });

  it('std.send compiles', () => {
    const source = '#include std\n/\\\nstd.send{port=0x15D, value=0x20000}';
    const { mem, errors } = compileAndGetMem(source);
    expect(errors).toHaveLength(0);
    expect(mem.length).toBeGreaterThan(0);
  });

  it('std.delay compiles', () => {
    const source = '#include std\n/\\\nstd.delay{n=100}';
    const { mem, errors } = compileAndGetMem(source);
    expect(errors).toHaveLength(0);
    expect(mem.length).toBeGreaterThan(0);
  });

  it('std.setb compiles', () => {
    const source = '#include std\n/\\\nstd.setb{addr=0x15D}';
    const { mem, errors } = compileAndGetMem(source);
    expect(errors).toHaveLength(0);
    expect(mem.length).toBeGreaterThan(0);
  });

  it('std.plus compiles', () => {
    const source = '#include std\n/\\\nstd.plus{a=1, b=2, c=x}';
    const { mem, errors } = compileAndGetMem(source);
    expect(errors).toHaveLength(0);
    expect(mem.length).toBeGreaterThan(0);
  });

  it('std.fill produces same code as bare fill', () => {
    const bareResult = compileCube('fill{value=0x155, count=10}');
    const stdResult = compileCube('#include std\n/\\\nstd.fill{value=0x155, count=10}');
    expect(bareResult.errors).toHaveLength(0);
    expect(stdResult.errors).toHaveLength(0);
    expect(bareResult.nodes.length).toBe(1);
    expect(stdResult.nodes.length).toBe(1);
    // The memory should be identical
    expect(Array.from(stdResult.nodes[0].mem)).toEqual(Array.from(bareResult.nodes[0].mem));
  });
});

describe('std.xxxx without #include std', () => {
  it('std.fill fails without #include std', () => {
    const source = 'std.fill{value=0x155, count=10}';
    const result = compileCube(source);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toMatch(/Undefined/);
  });
});

describe('backward compatibility', () => {
  it('bare fill still works without #include', () => {
    const { mem, errors } = compileAndGetMem('fill{value=0x155, count=10}');
    expect(errors).toHaveLength(0);
    expect(mem.length).toBeGreaterThan(0);
  });

  it('bare loop/again still works', () => {
    const { mem, errors } = compileAndGetMem('loop{n=3}\n/\\\nfill{value=0x155, count=10}\n/\\\nagain{}');
    expect(errors).toHaveLength(0);
    expect(mem.length).toBeGreaterThan(0);
  });

  it('bare send still works', () => {
    const { mem, errors } = compileAndGetMem('send{port=0x15D, value=0x20000}');
    expect(errors).toHaveLength(0);
    expect(mem.length).toBeGreaterThan(0);
  });
});

describe('unknown module error', () => {
  it('errors on #include with unknown module name', () => {
    const source = '#include foo\n/\\\nfill{value=1, count=1}';
    const result = compileCube(source);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toMatch(/Unknown module.*foo/);
  });
});

describe('multi-node with #include std', () => {
  it('std builtins work in multi-node programs', () => {
    const source = [
      '#include std',
      '/\\',
      'node 117',
      '/\\',
      'std.fill{value=0x155, count=640}',
      '',
      'node 617',
      '/\\',
      'std.fill{value=0x0AA, count=640}',
    ].join('\n');
    const result = compileCube(source);
    expect(result.errors).toHaveLength(0);
    expect(result.nodes.length).toBe(2);
  });
});
