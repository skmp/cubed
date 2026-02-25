import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compileCube } from './cube';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('flag word counts', () => {
  for (const name of ['CH', 'FR', 'NL', 'PS', 'UN', 'blue-rectangle']) {
    it(`${name}.cube word counts`, () => {
      const source = readFileSync(join(__dirname, `../../samples/${name}.cube`), 'utf-8');
      const result = compileCube(source);
      expect(result.errors).toHaveLength(0);
      for (const n of result.nodes) {
        console.log(`${name} node ${n.coord}: ${n.len}/64`);
      }
    });
  }
});
