import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compileCube } from './cube';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const samplePath = join(__dirname, '../../samples/FR.cube');

describe('FR.cube French flag sample', () => {
  it('compiles without errors', () => {
    const source = readFileSync(samplePath, 'utf-8');
    const result = compileCube(source);
    expect(result.errors).toHaveLength(0);
    expect(result.nodes.length).toBe(7);

    const coords = result.nodes.map(n => n.coord).sort((a, b) => a - b);
    expect(coords).toEqual([116, 117, 217, 616, 617, 716, 717]);
  });

  it('all nodes fit within 64-word RAM limit', () => {
    const source = readFileSync(samplePath, 'utf-8');
    const result = compileCube(source);
    expect(result.errors).toHaveLength(0);
    for (const node of result.nodes) {
      expect(node.len, `node ${node.coord} exceeds 64 words`).toBeLessThanOrEqual(64);
    }
  });
});
