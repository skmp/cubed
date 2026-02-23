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
import { disassembleRom, formatDisassembly } from './disassembler';

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

  it('diagnostic: disassemble node 708 ROM', () => {
    const lines = disassembleRom(708, ROM_DATA);
    console.log('=== Node 708 ROM disassembly (proper) ===');
    for (const l of lines) console.log(l);
  });

  it('diagnostic: trace node 708 cold boot (first 200 steps)', () => {
    const source = `node 709\n/\\\nfill{value=0xAA, count=1}\n`;
    const compiled = compileCube(source);
    const boot = buildBootStream(compiled.nodes);
    const bits = GA144.buildSerialBits(Array.from(boot.bytes), BOOT_BAUD_PERIOD, IDLE_PERIOD);

    console.log(`Boot stream: ${boot.words.length} words, ${boot.bytes.length} bytes`);
    console.log(`Serial bits segments: ${bits.length}`);
    for (let i = 0; i < Math.min(bits.length, 20); i++) {
      console.log(`  bit[${i}]: value=${bits[i].value} duration=${bits[i].duration}`);
    }

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();

    const node708 = ga.getNodeByCoord(708);
    console.log(`\nInitial: P=0x${ga.getSnapshot(708).selectedNode!.registers.P.toString(16)}`);

    let bitIdx = 0;
    let remaining = bits.length > 0 ? bits[0].duration : 0;
    let prevP = -1;
    for (let step = 0; step < 200; step++) {
      // Drive pin17
      if (bitIdx < bits.length) {
        node708.setPin17(bits[bitIdx].value);
        remaining--;
        if (remaining <= 0) {
          bitIdx++;
          remaining = bitIdx < bits.length ? bits[bitIdx].duration : 0;
        }
      } else {
        node708.setPin17(false); // RS232 idle = LOW
      }

      const snap708 = ga.getSnapshot(708).selectedNode!;
      const pin = node708.getPin17();
      const p = snap708.registers.P;
      // Log every step, but annotate when P changes
      const pChanged = p !== prevP;
      const romWord = p >= 0x80 && p < 0xC0 ? ROM_DATA[708][p - 0x80] : null;
      const disasm = romWord !== null ? ` [${formatDisassembly(romWord)}]` : '';
      console.log(
        `step ${step}: P=0x${p.toString(16).padStart(3,'0')} ` +
        `iI=${snap708.slotIndex} T=0x${snap708.registers.T.toString(16).padStart(5,'0')} ` +
        `S=0x${snap708.registers.S.toString(16).padStart(5,'0')} ` +
        `A=0x${snap708.registers.A.toString(16).padStart(5,'0')} ` +
        `B=0x${snap708.registers.B.toString(16).padStart(3,'0')} ` +
        `R=0x${snap708.registers.R.toString(16).padStart(5,'0')} ` +
        `IO=0x${snap708.registers.IO.toString(16).padStart(5,'0')} ` +
        `pin17=${pin ? '1' : '0'} ${snap708.state}` +
        (pChanged ? disasm : '')
      );
      prevP = p;

      ga.stepProgram();
    }
  });

  it('single node (709): serial boot loads RAM and sets B=IO', () => {
    const source = `node 709\n/\\\nfill{value=0xAA, count=1}\n`;

    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const boot = buildBootStream(compiled.nodes);
    const bits = GA144.buildSerialBits(
      Array.from(boot.bytes),
      BOOT_BAUD_PERIOD,
      IDLE_PERIOD,
    );

    console.log(`Boot stream: ${boot.words.length} words, ${boot.bytes.length} bytes`);
    console.log(`Serial bits: ${bits.length} segments, total duration: ${bits.reduce((s,b) => s+b.duration, 0)} steps`);
    for (let i = 0; i < Math.min(bits.length, 30); i++) {
      console.log(`  bit[${i}]: value=${bits[i].value ? 1 : 0} duration=${bits[i].duration}`);
    }

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();

    const node708 = ga.getNodeByCoord(708);

    // Run with periodic snapshots
    const maxSteps = 1_000_000;
    let bitIdx = 0;
    let remaining = bits.length > 0 ? bits[0].duration : 0;
    const checkpoints = [100, 1000, 5000, 10000, 50000, 100000, 500000, 999999];

    for (let step = 0; step < maxSteps; step++) {
      // Drive pin17
      if (bitIdx < bits.length) {
        node708.setPin17(bits[bitIdx].value);
        remaining--;
        if (remaining <= 0) {
          bitIdx++;
          remaining = bitIdx < bits.length ? bits[bitIdx].duration : 0;
        }
      } else {
        node708.setPin17(false); // RS232 idle = LOW
      }

      if (checkpoints.includes(step)) {
        const s708 = ga.getSnapshot(708).selectedNode!;
        const s709 = ga.getSnapshot(709).selectedNode!;
        console.log(
          `[step ${step}] 708: P=0x${s708.registers.P.toString(16)} iI=${s708.slotIndex} ` +
          `T=0x${s708.registers.T.toString(16)} state=${s708.state} ` +
          `IO=0x${s708.registers.IO.toString(16)} pin17=${node708.getPin17() ? 1 : 0} ` +
          `bitIdx=${bitIdx}/${bits.length}`
        );
        console.log(
          `         709: P=0x${s709.registers.P.toString(16)} iI=${s709.slotIndex} ` +
          `T=0x${s709.registers.T.toString(16)} state=${s709.state} ` +
          `B=0x${s709.registers.B.toString(16)}`
        );
      }

      ga.stepProgram();
    }

    console.log(`Total steps: ${ga.getTotalSteps()}`);

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

  it('east-then-south turn (709→717→617): serial boot across direction change', () => {
    // Tests the path turning from east to south at node 717.
    // Path: 708→E→709→E→710→...→E→717→S→617
    const source = [
      'node 709', '/\\', 'fill{value=0x709, count=1}',
      'node 717', '/\\', 'fill{value=0x717, count=1}',
      'node 617', '/\\', 'fill{value=0x617, count=1}',
    ].join('\n') + '\n';
    const { ga, compiled, boot } = bootViaSerial(source, 5_000_000);

    console.log(`Boot stream: ${boot.words.length} words, path: ${boot.path.length} nodes, wire: ${boot.wireNodes.length}`);

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

  it.skip('all 144 nodes: full serial boot of entire chip', { timeout: 120_000 }, () => {
    const source = allNodeSource();
    const { ga, compiled, boot, bpHit } = bootViaSerial(source, 100_000_000);

    expect(compiled.nodes).toHaveLength(144);
    console.log(
      `Boot stream: ${boot.words.length} words, ${boot.bytes.length} bytes, ` +
      `path: ${boot.path.length} nodes, wire: ${boot.wireNodes.length}`
    );
    console.log(`bpHit=${bpHit}, totalSteps=${ga.getTotalSteps()}, active=${ga.getActiveCount()}`);

    // Diagnostic: check specific nodes along the path
    for (const coord of [709, 710, 717, 617, 17, 0, 100]) {
      const s = ga.getSnapshot(coord).selectedNode!;
      console.log(
        `  node ${coord}: P=0x${s.registers.P.toString(16)} B=0x${s.registers.B.toString(16)} ` +
        `state=${s.state} RAM[0]=0x${s.ram[0].toString(16)}`
      );
    }

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
    }

    // Check B register separately (don't fail on first B mismatch)
    let bMismatches = 0;
    for (const node of compiled.nodes) {
      const snap = ga.getSnapshot(node.coord).selectedNode!;
      if (snap.registers.B !== PORT.IO) bMismatches++;
    }

    if (failedNodes.length > 0) {
      console.log(`Failed nodes (${failedNodes.length}):\n` + failedNodes.join('\n'));
    }
    console.log(`${144 - failedNodes.length}/144 nodes OK, B mismatches: ${bMismatches}, total steps: ${ga.getTotalSteps()}`);
    expect(totalMismatches).toBe(0);
  });
});
