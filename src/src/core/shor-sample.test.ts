import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compileCube } from './cube';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('new sample compilation', () => {
  it('shor.cube compiles all 6 nodes', () => {
    const source = readFileSync(join(__dirname, '../../samples/shor.cube'), 'utf-8');
    const compiled = compileCube(source);
    if (compiled.errors.length > 0) {
      console.log('Errors:', compiled.errors);
    }
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.nodes.length).toBe(6);
    // Log word counts per node for RAM budget analysis
    for (const node of compiled.nodes) {
      console.log(`Node ${node.coord}: ${node.len} words`);
    }
  });

  it('NL.cube compiles all 7 nodes', () => {
    const source = readFileSync(join(__dirname, '../../samples/NL.cube'), 'utf-8');
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.nodes.length).toBe(7);
  });

  it('UN.cube compiles all 7 nodes', () => {
    const source = readFileSync(join(__dirname, '../../samples/UN.cube'), 'utf-8');
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.nodes.length).toBe(7);
  });
});
