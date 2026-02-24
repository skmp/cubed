/**
 * NIC10.cube compilation test.
 * Verifies all 26 AN007 nodes compile without errors.
 */
import { describe, it, expect } from 'vitest';
import { compileCube } from './compiler';
import * as fs from 'fs';
import * as path from 'path';

describe('NIC10.cube', () => {
  it('compiles all nodes without errors', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../samples/NIC10.cube'),
      'utf-8',
    );
    const result = compileCube(source);
    // Print errors first
    if (result.errors.length > 0) {
      console.log('ERRORS:');
      for (const e of result.errors) console.log(`  L${e.line}:${e.col} ${e.message}`);
    }
    // Log node info
    for (const node of result.nodes) {
      const extra: string[] = [];
      if (node.a !== undefined) extra.push(`a=0x${node.a.toString(16)}`);
      if (node.b !== undefined) extra.push(`b=0x${node.b.toString(16)}`);
      if (node.p !== undefined) extra.push(`p=0x${node.p.toString(16)}`);
      console.log(`  node ${node.coord}: ${node.len} words ${extra.join(' ')}`);
    }
    // Check for suspiciously small nodes (missing /\ causing silent parse truncation)
    const EXPECTED_MIN_WORDS: Record<number, number> = {
      112: 1, 116: 2, 216: 2, 316: 2,
      217: 10, 117: 10, 17: 5,
      16: 50, 15: 25, 14: 15, 13: 20, 12: 15, 11: 15, 10: 10,
      111: 10, 113: 10, 114: 20, 214: 15,
      314: 10, 315: 15, 115: 10, 215: 15,
      317: 20, 417: 10, 108: 5, 109: 10, 110: 20,
    };
    for (const node of result.nodes) {
      const min = EXPECTED_MIN_WORDS[node.coord] ?? 1;
      if (node.len < min) {
        console.log(`  WARNING: node ${node.coord} only ${node.len} words, expected >= ${min}`);
      }
    }
    expect(result.errors).toHaveLength(0);
    expect(result.nodes.length).toBe(27); // 26 AN007 nodes + node 017
    for (const node of result.nodes) {
      expect(node.len).toBeLessThanOrEqual(64);
    }
  });
});
