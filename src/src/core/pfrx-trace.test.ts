/**
 * Diagnostic test for pf_rx compilation output.
 * Verifies code generation without running the emulator.
 */
import { describe, it, expect } from 'vitest';
import { compileCube } from './cube';

describe('pf_rx code generation', () => {
  it('compiles pf_rx and produces valid node data', () => {
    const compiled = compileCube(`node 200\n/\\\npf_rx{}\n`);
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.nodes).toHaveLength(1);

    const node = compiled.nodes[0];
    expect(node.coord).toBe(200);
    expect(node.len).toBeGreaterThan(0);
    expect(node.len).toBeLessThanOrEqual(64);

    // Verify all memory words are valid 18-bit values
    for (let i = 0; i < node.len; i++) {
      if (node.mem[i] !== null) {
        expect(node.mem[i]! & ~0x3FFFF).toBe(0);
      }
    }
  });

  it('pf_rx code is non-trivial (uses most of available RAM)', () => {
    const compiled = compileCube(`node 200\n/\\\npf_rx{}\n`);
    const node = compiled.nodes[0];
    // pf_rx is a complex builtin — should use significant RAM
    expect(node.len).toBeGreaterThan(30);
  });
});
