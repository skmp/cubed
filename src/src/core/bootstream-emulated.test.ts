/**
 * End-to-end boot ROM serial simulation test.
 *
 * Unlike bootstream-load.test.ts (which uses loadViaBootStream to directly
 * inject code into RAM), these tests exercise the real boot path:
 *
 *   serial bits on node 708's pin17 → boot ROM RX → mesh forwarding → all nodes loaded
 *
 * This validates that the boot ROM, serial encoding, baud timing, and mesh
 * relay logic all work together correctly.
 */
import { describe, it, expect } from 'vitest';
import { GA144 } from './ga144';
import { ROM_DATA } from './rom-data';
import { compileCube } from './cube';
import { buildBootStream } from './bootstream';
import { PORT, OPCODES } from './constants';
import { XOR_ENCODING } from './types';

// ============================================================
// Constants
// ============================================================

const BOOT_BAUD_PERIOD = GA144.BOOT_BAUD_PERIOD; // ~723 steps per bit
const IDLE_PERIOD = BOOT_BAUD_PERIOD * 10;        // let boot ROM see idle line

// ============================================================
// Helper
// ============================================================

/**
 * Compile a CUBE source, build the boot stream, convert to serial bits,
 * and run the GA144 with serial input on node 708.
 */
function bootViaSerial(source: string, maxSteps: number) {
  const compiled = compileCube(source);
  expect(compiled.errors).toHaveLength(0);

  const boot = buildBootStream(compiled.nodes);
  const bits = GA144.buildSerialBits(
    Array.from(boot.bytes),
    BOOT_BAUD_PERIOD,
    IDLE_PERIOD,
  );

  const ga = new GA144('test');
  ga.setRomData(ROM_DATA);
  ga.reset();

  const bpHit = ga.stepWithSerialBits(708, bits, maxSteps);

  return { ga, compiled, boot, bpHit };
}

/**
 * Generate CUBE source that loads `fill{value=<coord>, count=1}` on every
 * one of the 144 GA144 nodes.
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

describe('boot ROM serial simulation', () => {

  it('diagnostic: trace node 708 boot ROM execution', () => {
    // Disassemble the async boot ROM for node 708
    const rom = ROM_DATA[708];
    const lines: string[] = [];
    for (let i = 0; i < rom.length; i++) {
      const raw = rom[i];
      const d = raw ^ XOR_ENCODING;
      const s0 = (d >> 13) & 0x1F;
      const s1 = (d >> 8) & 0x1F;
      const s2 = (d >> 3) & 0x1F;
      const s3 = (d & 0x7) << 1;
      const BRANCH = new Set([2, 4, 5, 6, 7]);
      const addr = 0x80 + i;
      let line = `[0x${addr.toString(16)}]`;
      if (BRANCH.has(s0)) {
        line += ` ${OPCODES[s0]}(${d & 0x1FFF})`;
      } else {
        line += ` ${OPCODES[s0]}`;
        if (BRANCH.has(s1)) {
          line += ` ${OPCODES[s1]}(${d & 0xFF})`;
        } else {
          line += ` ${OPCODES[s1]}`;
          if (BRANCH.has(s2)) {
            line += ` ${OPCODES[s2]}(${d & 0x7})`;
          } else {
            line += ` ${OPCODES[s2]} ${OPCODES[s3]}`;
          }
        }
      }
      line += `  (raw=0x${raw.toString(16).padStart(5,'0')})`;
      lines.push(line);
    }
    console.log('=== Node 708 ROM disassembly ===');
    for (const l of lines) console.log(l);

    // Now trace execution for 50 steps
    const source = `node 709\n/\\\nfill{value=0xAA, count=1}\n`;
    const compiled = compileCube(source);
    const boot = buildBootStream(compiled.nodes);
    const bits = GA144.buildSerialBits(Array.from(boot.bytes), BOOT_BAUD_PERIOD, IDLE_PERIOD);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();

    const node708 = ga.getNodeByCoord(708);
    console.log('\n=== Node 708 execution trace (first 100 steps) ===');
    console.log(`Initial: P=0x${ga.getSnapshot(708).selectedNode!.registers.P.toString(16)}`);

    let bitIdx = 0;
    let remaining = bits.length > 0 ? bits[0].duration : 0;
    for (let step = 0; step < 100; step++) {
      // Drive pin17
      if (bitIdx < bits.length) {
        node708.setPin17(bits[bitIdx].value);
        remaining--;
        if (remaining <= 0) {
          bitIdx++;
          remaining = bitIdx < bits.length ? bits[bitIdx].duration : 0;
        }
      } else {
        node708.setPin17(true);
      }

      const snap708 = ga.getSnapshot(708).selectedNode!;
      const pin = node708.getPin17();
      console.log(
        `step ${step}: P=0x${snap708.registers.P.toString(16).padStart(2,'0')} ` +
        `iI=${snap708.slotIndex} T=0x${snap708.registers.T.toString(16)} ` +
        `A=0x${snap708.registers.A.toString(16)} B=0x${snap708.registers.B.toString(16)} ` +
        `R=0x${snap708.registers.R.toString(16)} IO=0x${snap708.registers.IO.toString(16)} ` +
        `pin17=${pin} state=${snap708.state}`
      );

      ga.stepProgram();
    }
  });

  it('single node (709): serial boot loads RAM and sets B=IO', () => {
    const source = `node 709\n/\\\nfill{value=0xAA, count=1}\n`;
    const { ga, compiled } = bootViaSerial(source, 1_000_000);

    const snap = ga.getSnapshot(709);
    expect(snap.selectedNode).toBeDefined();
    const ram = snap.selectedNode!.ram;
    const expectedMem = compiled.nodes[0].mem;
    const expectedLen = compiled.nodes[0].len;

    let mismatches = 0;
    for (let i = 0; i < expectedLen; i++) {
      if (expectedMem[i] !== null && ram[i] !== expectedMem[i]) {
        mismatches++;
        console.log(
          `  RAM[${i}]: expected 0x${expectedMem[i]!.toString(16).padStart(5, '0')} ` +
          `got 0x${ram[i].toString(16).padStart(5, '0')}`
        );
      }
    }
    expect(mismatches).toBe(0);
    expect(snap.selectedNode!.registers.B).toBe(PORT.IO);
    console.log(
      `Node 709: ${expectedLen} words verified, B=0x${snap.selectedNode!.registers.B.toString(16)}, ` +
      `steps=${ga.getTotalSteps()}`
    );
  });

  it('three nodes (709, 710, 711): serial boot with mesh forwarding', () => {
    const source = [
      'node 709', '/\\', 'fill{value=0x111, count=1}',
      'node 710', '/\\', 'fill{value=0x222, count=1}',
      'node 711', '/\\', 'fill{value=0x333, count=1}',
    ].join('\n') + '\n';
    const { ga, compiled } = bootViaSerial(source, 2_000_000);

    for (const node of compiled.nodes) {
      const snap = ga.getSnapshot(node.coord);
      expect(snap.selectedNode, `node ${node.coord} not found`).toBeDefined();
      const ram = snap.selectedNode!.ram;

      let nodeMismatches = 0;
      for (let i = 0; i < node.len; i++) {
        if (node.mem[i] !== null && ram[i] !== node.mem[i]) {
          nodeMismatches++;
          console.log(
            `  node ${node.coord} RAM[${i}]: expected 0x${node.mem[i]!.toString(16).padStart(5, '0')} ` +
            `got 0x${ram[i].toString(16).padStart(5, '0')}`
          );
        }
      }
      expect(nodeMismatches).toBe(0);
      expect(snap.selectedNode!.registers.B, `node ${node.coord} B`).toBe(PORT.IO);
      console.log(`Node ${node.coord}: ${node.len} words verified`);
    }
    console.log(`Total steps: ${ga.getTotalSteps()}`);
  });

  it('all 144 nodes: full serial boot of entire chip', { timeout: 120_000 }, () => {
    const source = allNodeSource();
    const { ga, compiled, boot } = bootViaSerial(source, 100_000_000);

    expect(compiled.nodes).toHaveLength(144);
    console.log(
      `Boot stream: ${boot.words.length} words, ${boot.bytes.length} bytes, ` +
      `path: ${boot.path.length} nodes, wire: ${boot.wireNodes.length}`
    );

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
    console.log(`${144 - failedNodes.length}/144 nodes OK, total steps: ${ga.getTotalSteps()}`);
    expect(totalMismatches).toBe(0);
  });
});
