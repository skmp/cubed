/**
 * NIC10 sample compilation test: compiles NIC10.cube and validates
 * that all 26 AN007 nodes compile without errors and fit in 64 words.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compileCube } from './cube';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('NIC10 sample: 10baseT NIC', () => {

  it('NIC10.cube compiles all 26 nodes without errors', () => {
    const source = readFileSync(join(__dirname, '../../samples/NIC10.cube'), 'utf-8');
    const compiled = compileCube(source);

    if (compiled.errors.length > 0) {
      console.log('Compilation errors:');
      for (const e of compiled.errors) {
        console.log(`  line ${e.line}:${e.col}: ${e.message}`);
      }
    }

    if (compiled.warnings && compiled.warnings.length > 0) {
      console.log('Warnings:');
      for (const w of compiled.warnings) {
        console.log(`  line ${w.line}:${w.col}: ${w.message}`);
      }
    }

    // Report per-node statistics even if there are errors
    if (compiled.nodes.length > 0) {
      console.log(`\nCompiled ${compiled.nodes.length} nodes:`);
      for (const node of compiled.nodes) {
        const status = node.len > 64 ? ' *** OVERFLOW ***' : '';
        console.log(`  node ${node.coord}: ${node.len}/64 words${status}`);
      }
    }

    // First pass: just check compilation and report sizes
    // (errors may occur during development)
    if (compiled.errors.length > 0) {
      // Re-compile node by node to get individual stats
      const _lines = source.split('\n');
      console.log('\nPer-node compilation (allowing errors):');
      // Extract node blocks from source for individual compilation
    }

    expect(compiled.errors).toHaveLength(0);
    expect(compiled.nodes.length).toBe(27); // 26 AN007 nodes + node 017 (de-jitter)

    const expectedCoords = new Set([
      112, 116, 216, 316,  // wire nodes
      217,                  // active pull-down yanker
      117, 17,             // RX pin decode + de-jitter
      16, 15, 14, 13,     // RX timing, parsing, framing, CRC
      12, 11, 10,         // RX packing, byteswap, control
      111, 113, 114,       // TX control, unpack, CRC
      214, 314, 315,       // TX delay FIFO, framing, mux
      115, 215,            // link negotiation
      317, 417,            // TX pin, oscillator
      108, 109, 110,       // DMA nodes
    ]);

    for (const node of compiled.nodes) {
      expect(expectedCoords.has(node.coord), `unexpected node ${node.coord}`).toBe(true);
      expect(node.len, `node ${node.coord} exceeds 64 words (${node.len})`).toBeLessThanOrEqual(64);
    }
  });
});
