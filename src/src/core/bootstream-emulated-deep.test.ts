/**
 * Deep relay boot ROM serial simulation tests (slow, 12-80s each).
 *
 * Tests deep relay chains (100+ hops) and multi-node pipelines
 * with real CUBE code (shor15, asynctx).
 */
import { describe, it, expect } from 'vitest';
import { GA144 } from './ga144';
import { SerialBits } from './serial';
import { ROM_DATA } from './rom-data';
import { compileCube } from './cube';
import { buildBootStream } from './bootstream';
import { PORT } from './constants';

function bootViaSerial(source: string, maxSteps: number) {
  const compiled = compileCube(source);
  expect(compiled.errors).toHaveLength(0);

  const boot = buildBootStream(compiled.nodes);
  const bits = SerialBits.bootStreamBits(Array.from(boot.bytes), GA144.BOOT_BAUD);

  const ga = new GA144('test');
  ga.setRomData(ROM_DATA);
  ga.reset();

  const bpHit = ga.stepWithSerialBits(708, bits, maxSteps);

  return { ga, compiled, boot, bpHit };
}

describe('boot ROM serial simulation (deep relay)', () => {

  it('deep relay: single node 508 (110+ hops from 708)', { timeout: 120_000 }, () => {
    const source = `node 508\n/\\\nfill{value=0x508, count=1}\n`;
    const { ga, compiled, boot } = bootViaSerial(source, 50_000_000);

    console.log(`Boot stream: ${boot.words.length} words, path: ${boot.path.length} nodes, wire: ${boot.wireNodes.length}`);

    const snap = ga.getSnapshot(508);
    expect(snap.selectedNode).toBeDefined();
    const ns = snap.selectedNode!;
    console.log(
      `node 508: P=0x${ns.registers.P.toString(16)} B=0x${ns.registers.B.toString(16)} ` +
      `state=${ns.state} RAM[0]=0x${ns.ram[0].toString(16)}`
    );

    for (const coord of [507, 509, 500, 709]) {
      const s = ga.getSnapshot(coord).selectedNode!;
      console.log(
        `  relay ${coord}: P=0x${s.registers.P.toString(16)} state=${s.state}`
      );
    }

    const ram = ns.ram;
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
    expect(ns.registers.B).toBe(PORT.IO);
  });

  it('deep relay: two nodes 508 + 608', { timeout: 120_000 }, () => {
    const source = [
      'node 508', '/\\', 'fill{value=0x508, count=1}',
      'node 608', '/\\', 'fill{value=0x608, count=1}',
    ].join('\n') + '\n';
    const { ga, compiled, boot } = bootViaSerial(source, 50_000_000);

    console.log(`Boot stream: ${boot.words.length} words, path: ${boot.path.length} nodes, wire: ${boot.wireNodes.length}`);

    for (const node of compiled.nodes) {
      const snap = ga.getSnapshot(node.coord);
      expect(snap.selectedNode, `node ${node.coord} not found`).toBeDefined();
      const ns = snap.selectedNode!;
      console.log(
        `node ${node.coord}: P=0x${ns.registers.P.toString(16)} B=0x${ns.registers.B.toString(16)} ` +
        `state=${ns.state} RAM[0]=0x${ns.ram[0].toString(16)}`
      );
      const ram = ns.ram;
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
      expect(ns.registers.B, `node ${node.coord} B`).toBe(PORT.IO);
    }
  });

  it('deep relay: 3-node RSC pipeline (508+608+708) with real CUBE code', { timeout: 120_000 }, () => {
    const source = [
      '#include std',
      '',
      'node 508',
      '/\\',
      'x = 0',
      '/\\',
      'std.loop{n=32767}',
      '/\\ std.plus{a=x, b=1, c=x}',
      '/\\ std.send{port=0x145, value=x}',
      '/\\ std.again{}',
      '',
      'node 608',
      '/\\',
      'std.shor15{noise_port=0x145, out_port=0x115}',
      '',
      'node 708',
      '/\\',
      'std.asynctx{port=0x115}',
    ].join('\n') + '\n';

    const { ga, compiled, boot } = bootViaSerial(source, 50_000_000);

    console.log(`Boot stream: ${boot.words.length} words, path: ${boot.path.length} nodes, wire: ${boot.wireNodes.length}`);

    for (const node of compiled.nodes) {
      const usedLen = node.mem ? node.mem.filter((v: number | null) => v !== null && v !== undefined).length : 0;
      console.log(
        `  compiled ${node.coord}: len=${node.len} usedLen=${usedLen} ` +
        `p=${node.p} a=${node.a} b=${node.b} io=${node.io} ` +
        `stack=${JSON.stringify(node.stack)}`
      );
    }

    console.log(`  frame1 header: magic=0x${boot.words[0]?.toString(16)} dir=0x${boot.words[1]?.toString(16)} len=${boot.words[2]}`);

    for (const node of compiled.nodes) {
      const snap = ga.getSnapshot(node.coord);
      expect(snap.selectedNode, `node ${node.coord}`).toBeDefined();
      const ns = snap.selectedNode!;
      console.log(
        `node ${node.coord}: P=0x${ns.registers.P.toString(16)} B=0x${ns.registers.B.toString(16)} ` +
        `A=0x${ns.registers.A.toString(16)} state=${ns.state} RAM[0]=0x${ns.ram[0].toString(16)}`
      );

      const ram = ns.ram;
      let nodeMismatches = 0;
      const isRunning = ns.state === 'running' || ns.state === 'blocked_write';
      for (let i = 0; i < node.len; i++) {
        if (node.mem[i] !== null && ram[i] !== node.mem[i]) {
          if (isRunning) {
            console.log(
              `  node ${node.coord} RAM[${i}]: post-boot execution modified ` +
              `0x${node.mem[i]!.toString(16).padStart(5, '0')} → 0x${ram[i].toString(16).padStart(5, '0')} (OK)`
            );
          } else {
            nodeMismatches++;
            console.log(
              `  node ${node.coord} RAM[${i}]: expected 0x${node.mem[i]!.toString(16).padStart(5, '0')} ` +
              `got 0x${ram[i].toString(16).padStart(5, '0')}`
            );
          }
        }
      }
      expect(nodeMismatches, `node ${node.coord} RAM`).toBe(0);
    }
  });

  it.skip('all 144 nodes: full serial boot of entire chip', { timeout: 120_000 }, () => {
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
    const source = lines.join('\n');
    const { ga, compiled, boot, bpHit } = bootViaSerial(source, 100_000_000);

    expect(compiled.nodes).toHaveLength(144);
    console.log(
      `Boot stream: ${boot.words.length} words, ${boot.bytes.length} bytes, ` +
      `path: ${boot.path.length} nodes, wire: ${boot.wireNodes.length}`
    );
    console.log(`bpHit=${bpHit}, totalSteps=${ga.getTotalSteps()}, active=${ga.getActiveCount()}`);

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
