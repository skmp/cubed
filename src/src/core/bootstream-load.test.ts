/**
 * Integration test: boot stream loading.
 *
 * The single-node test uses loadViaBootStream() which exercises the real
 * serial boot path (serial bits → boot ROM → mesh relay).
 *
 * The 144-node test uses load() (direct RAM injection) for speed, since
 * full serial boot of 144 nodes takes ~17 minutes.  The full serial boot
 * path for multiple nodes is tested in bootstream-emulated.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { GA144 } from './ga144';
import { ROM_DATA } from './rom-data';
import { compileCube } from './cube';
import { buildBootStream } from './bootstream';
import { PORT } from './constants';

// ============================================================
// Helpers
// ============================================================

/**
 * Generate a CUBE source that loads `fill{value=<coord>, count=1}` on
 * every one of the 144 GA144 nodes.
 */
function allNodeSource(): string {
  const lines: string[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 18; col++) {
      const coord = row * 100 + col;
      lines.push(`node ${coord}`);
      lines.push('/\\');
      lines.push(`fill{value=${coord}, count=1}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ============================================================
// Tests
// ============================================================

describe('boot stream loading', () => {

  it('single node (709): loads RAM and sets B=0x15D via serial boot', { timeout: 10_000 }, () => {
    const source = `node 709\n/\\\nfill{value=0xAA, count=1}\n`;
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.loadViaBootStream(compiled);

    // Run until boot completes and program settles
    ga.stepUntilDone(2_000_000);

    // Inspect node 709
    const snap = ga.getSnapshot(709);
    expect(snap.selectedNode).toBeDefined();
    const ram = snap.selectedNode!.ram;
    const expectedMem = compiled.nodes[0].mem;
    const expectedLen = compiled.nodes[0].len;

    let mismatches = 0;
    for (let i = 0; i < expectedLen; i++) {
      if (expectedMem[i] !== null && ram[i] !== expectedMem[i]) {
        mismatches++;
        console.log(`  RAM[${i}]: expected 0x${expectedMem[i]!.toString(16).padStart(5,'0')} got 0x${ram[i].toString(16).padStart(5,'0')}`);
      }
    }
    expect(mismatches).toBe(0);
    expect(snap.selectedNode!.registers.B).toBe(PORT.IO);
    console.log(`Node 709: ${expectedLen} words verified, B=0x${snap.selectedNode!.registers.B.toString(16)}`);
  });

  // Uses load() (direct injection) for speed — full serial boot of 144 nodes
  // is tested in bootstream-emulated.test.ts
  it('all 144 nodes: RAM contents match compiled output', () => {
    const source = allNodeSource();
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.nodes).toHaveLength(144);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.load(compiled);

    let totalMismatches = 0;
    const failedNodes: string[] = [];

    for (const node of compiled.nodes) {
      const snap = ga.getSnapshot(node.coord);
      expect(snap.selectedNode, `node ${node.coord} not found`).toBeDefined();
      const ram = snap.selectedNode!.ram;

      let nodeMismatches = 0;
      for (let i = 0; i < node.len; i++) {
        if (node.mem[i] !== null && ram[i] !== node.mem[i]) {
          nodeMismatches++;
        }
      }
      if (nodeMismatches > 0) {
        failedNodes.push(`node ${node.coord}: ${nodeMismatches} words differ`);
      }
      totalMismatches += nodeMismatches;

      expect(snap.selectedNode!.registers.B, `node ${node.coord} B`).toBe(PORT.IO);
    }

    if (failedNodes.length > 0) {
      console.log(`Failed nodes (${failedNodes.length}):\n` + failedNodes.join('\n'));
    }
    console.log(`${144 - failedNodes.length}/144 nodes OK`);
    expect(totalMismatches).toBe(0);
  });

  it('boot stream word count is reasonable for 144 nodes', () => {
    const source = allNodeSource();
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const bootResult = buildBootStream(compiled.nodes);

    console.log(`Boot stream: ${bootResult.words.length} words, ${bootResult.bytes.length} bytes`);
    console.log(`Path: ${bootResult.path.length} nodes, wire: ${bootResult.wireNodes.length}`);

    expect(bootResult.words.length).toBeGreaterThan(144 * 5);
    expect(bootResult.bytes.length).toBe(bootResult.words.length * 3);
    expect(bootResult.wireNodes).toHaveLength(0);
  });
});
