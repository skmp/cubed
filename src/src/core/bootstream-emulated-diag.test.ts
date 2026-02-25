/**
 * Diagnostic boot ROM serial simulation tests.
 *
 * Tests: node isolation, code size thresholds, boot stream comparison,
 * time-lapse tracing, direct-load bypass, frame1 structure validation.
 */
import { describe, it, expect } from 'vitest';
import { GA144 } from './ga144';
import { ROM_DATA } from './rom-data';
import { compileCube } from './cube';
import { buildBootStream } from './bootstream';
import { PORT } from './constants';
import { disassembleNode } from './disassembler';

const BOOT_BAUD_PERIOD = GA144.BOOT_BAUD_PERIOD;
const IDLE_PERIOD = BOOT_BAUD_PERIOD * 10;

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

describe('boot ROM serial simulation (diagnostics)', () => {

  it('diagnostic: 508+608 with real CUBE code (no 708 target)', { timeout: 120_000 }, () => {
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
    ].join('\n') + '\n';

    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const boot = buildBootStream(compiled.nodes);
    console.log(`Boot stream: ${boot.words.length} words, path: ${boot.path.length} nodes, wire: ${boot.wireNodes.length}`);

    console.log(`  frame1 header: magic=0x${boot.words[0]?.toString(16)} dir=0x${boot.words[1]?.toString(16)} len=${boot.words[2]}`);
    const frame2Start = 3 + boot.words[2];
    console.log(`  frame2 starts at word[${frame2Start}]: startP=${boot.words[frame2Start]} pad=${boot.words[frame2Start+1]} codeLen=${boot.words[frame2Start+2]}`);

    const { ga } = bootViaSerial(source, 50_000_000);

    for (const node of compiled.nodes) {
      const snap = ga.getSnapshot(node.coord);
      const ns = snap.selectedNode!;
      console.log(
        `node ${node.coord}: P=0x${ns.registers.P.toString(16)} B=0x${ns.registers.B.toString(16)} ` +
        `A=0x${ns.registers.A.toString(16)} state=${ns.state} RAM[0]=0x${ns.ram[0].toString(16)}`
      );
      const isRunning = ns.state === 'running' || ns.state === 'blocked_write';
      let nodeMismatches = 0;
      for (let i = 0; i < node.len; i++) {
        if (node.mem[i] !== null && ns.ram[i] !== node.mem[i]) {
          if (isRunning) {
            console.log(
              `  ${node.coord} RAM[${i}]: post-boot modified ` +
              `0x${node.mem[i]!.toString(16).padStart(5, '0')} → 0x${ns.ram[i].toString(16).padStart(5, '0')} (OK)`
            );
          } else {
            nodeMismatches++;
            console.log(
              `  ${node.coord} RAM[${i}]: expected 0x${node.mem[i]!.toString(16).padStart(5, '0')} ` +
              `got 0x${ns.ram[i].toString(16).padStart(5, '0')}`
            );
          }
        }
      }
      expect(nodeMismatches, `node ${node.coord} RAM`).toBe(0);
      if (!isRunning) {
        expect(ns.registers.B, `node ${node.coord} B`).toBe(PORT.IO);
      }
    }
  });

  it('diagnostic: isolate which node code causes failure', { timeout: 120_000 }, () => {
    const cases: [string, string][] = [
      ['A: 508=fill, 608=shor15', [
        '#include std',
        'node 508', '/\\', 'fill{value=0x508, count=1}',
        'node 608', '/\\', 'std.shor15{noise_port=0x145, out_port=0x115}',
      ].join('\n') + '\n'],
      ['B: 508=CUBE, 608=fill', [
        '#include std',
        'node 508', '/\\', 'x = 0', '/\\',
        'std.loop{n=32767}', '/\\ std.plus{a=x, b=1, c=x}',
        '/\\ std.send{port=0x145, value=x}', '/\\ std.again{}',
        'node 608', '/\\', 'fill{value=0x608, count=1}',
      ].join('\n') + '\n'],
      ['C: single 608 shor15', [
        '#include std',
        'node 608', '/\\', 'std.shor15{noise_port=0x145, out_port=0x115}',
      ].join('\n') + '\n'],
      ['D: single 508 CUBE', [
        '#include std',
        'node 508', '/\\', 'x = 0', '/\\',
        'std.loop{n=32767}', '/\\ std.plus{a=x, b=1, c=x}',
        '/\\ std.send{port=0x145, value=x}', '/\\ std.again{}',
      ].join('\n') + '\n'],
    ];

    for (const [label, source] of cases) {
      const compiled = compileCube(source);
      if (compiled.errors.length > 0) {
        console.log(`${label}: compile errors: ${compiled.errors.join(', ')}`);
        continue;
      }
      const boot = buildBootStream(compiled.nodes);
      const bits = GA144.buildSerialBits(Array.from(boot.bytes), BOOT_BAUD_PERIOD, IDLE_PERIOD);
      const ga = new GA144('test');
      ga.setRomData(ROM_DATA);
      ga.reset();
      ga.stepWithSerialBits(708, bits, 50_000_000);

      let ok = true;
      const nodeResults: string[] = [];
      for (const node of compiled.nodes) {
        const ns = ga.getSnapshot(node.coord).selectedNode!;
        let mismatches = 0;
        for (let i = 0; i < node.len; i++) {
          if (node.mem[i] !== null && ns.ram[i] !== node.mem[i]) mismatches++;
        }
        const _pOk = node.p === undefined ? true : ns.registers.P === node.p;
        const stuck = ns.state === 'blocked_read' &&
          (ns.registers.P === 0x175 || ns.registers.P === 0x1D5 ||
           ns.registers.P === 0x145 || ns.registers.P === 0x115);
        nodeResults.push(
          `  ${node.coord}: P=0x${ns.registers.P.toString(16)} B=0x${ns.registers.B.toString(16)} ` +
          `A=0x${ns.registers.A.toString(16)} state=${ns.state} ` +
          `RAM=${mismatches === 0 ? 'OK' : `${mismatches} mismatches`} ` +
          `${stuck ? 'STUCK_ON_PORT' : ''}`
        );
        if (mismatches > 0 || stuck) ok = false;
      }
      console.log(`${label}: boot=${boot.words.length}w path=${boot.path.length} → ${ok ? 'PASS' : 'FAIL'}`);
      for (const r of nodeResults) console.log(r);
    }
  });

  it('diagnostic: CUBE code on 709 vs 508 + code size threshold', { timeout: 120_000 }, () => {
    const cases: [string, string][] = [
      ['709 CUBE code', [
        '#include std',
        'node 709', '/\\', 'x = 0', '/\\',
        'std.loop{n=32767}', '/\\ std.plus{a=x, b=1, c=x}',
        '/\\ std.send{port=0x145, value=x}', '/\\ std.again{}',
      ].join('\n') + '\n'],
      ['508 fill×1 (~7w)', `node 508\n/\\\nfill{value=0x508, count=1}\n`],
      ['508 fill×2 (~14w)', `node 508\n/\\\nfill{value=1, count=1}\n/\\\nfill{value=2, count=1}\n`],
      ['508 fill×3 (~21w)', `node 508\n/\\\nfill{value=1, count=1}\n/\\\nfill{value=2, count=1}\n/\\\nfill{value=3, count=1}\n`],
      ['508 CUBE (23w)', [
        '#include std',
        'node 508', '/\\', 'x = 0', '/\\',
        'std.loop{n=32767}', '/\\ std.plus{a=x, b=1, c=x}',
        '/\\ std.send{port=0x145, value=x}', '/\\ std.again{}',
      ].join('\n') + '\n'],
    ];

    for (const [label, source] of cases) {
      const compiled = compileCube(source);
      if (compiled.errors.length > 0) {
        console.log(`${label}: compile errors`);
        continue;
      }
      const node = compiled.nodes[0];
      const boot = buildBootStream(compiled.nodes);
      const bits = GA144.buildSerialBits(Array.from(boot.bytes), BOOT_BAUD_PERIOD, IDLE_PERIOD);
      const ga = new GA144('test');
      ga.setRomData(ROM_DATA);
      ga.reset();
      ga.stepWithSerialBits(708, bits, 50_000_000);

      const ns = ga.getSnapshot(node.coord).selectedNode!;
      let mismatches = 0;
      for (let i = 0; i < node.len; i++) {
        if (node.mem[i] !== null && ns.ram[i] !== node.mem[i]) mismatches++;
      }
      const stuck = ns.state === 'blocked_read' &&
        (ns.registers.P === 0x175 || ns.registers.P === 0x1D5 ||
         ns.registers.P === 0x145 || ns.registers.P === 0x115);
      console.log(
        `${label}: len=${node.len} boot=${boot.words.length}w → ` +
        `P=0x${ns.registers.P.toString(16)} A=0x${ns.registers.A.toString(16)} ` +
        `B=0x${ns.registers.B.toString(16)} state=${ns.state} ` +
        `RAM=${mismatches === 0 ? 'OK' : `${mismatches}err`} ` +
        `${stuck ? 'STUCK' : 'ok'}`
      );
    }
  });

  it('diagnostic: compare boot stream words CUBE vs fill (709 target)', { timeout: 60_000 }, () => {
    const cubeSrc = [
      '#include std',
      'node 709', '/\\', 'x = 0', '/\\',
      'std.loop{n=32767}', '/\\ std.plus{a=x, b=1, c=x}',
      '/\\ std.send{port=0x145, value=x}', '/\\ std.again{}',
    ].join('\n') + '\n';
    const fillSrc = `node 709\n/\\\nfill{value=0xAA, count=1}\n`;

    for (const [label, source] of [['FILL', fillSrc], ['CUBE', cubeSrc]] as const) {
      const compiled = compileCube(source);
      expect(compiled.errors).toHaveLength(0);
      const boot = buildBootStream(compiled.nodes);
      const node = compiled.nodes[0];

      console.log(`\n=== ${label} (len=${node.len}) ===`);
      console.log(`Boot stream: ${boot.words.length} words`);
      console.log(`Frame1 header: magic=0x${boot.words[0]?.toString(16)} dir=0x${boot.words[1]?.toString(16)} len=${boot.words[2]}`);

      const frame1Len = boot.words[2];
      console.log('Frame1 code:');
      for (let i = 0; i < frame1Len; i++) {
        const w = boot.words[3 + i];
        console.log(`  code[${i}]: 0x${w.toString(16).padStart(5, '0')}`);
      }

      console.log('Compiled node memory:');
      for (let i = 0; i < node.len; i++) {
        const v = node.mem[i];
        console.log(`  mem[${i}]: ${v === null ? 'null' : '0x' + v.toString(16).padStart(5, '0')}`);
      }

      const bits = GA144.buildSerialBits(Array.from(boot.bytes), BOOT_BAUD_PERIOD, IDLE_PERIOD);
      const ga = new GA144('test');
      ga.setRomData(ROM_DATA);
      ga.reset();
      ga.stepWithSerialBits(708, bits, 5_000_000);

      const ns = ga.getSnapshot(709).selectedNode!;
      let mismatches = 0;
      for (let i = 0; i < node.len; i++) {
        if (node.mem[i] !== null && ns.ram[i] !== node.mem[i]) {
          mismatches++;
          console.log(`  RAM[${i}]: expected 0x${node.mem[i]!.toString(16).padStart(5, '0')} got 0x${ns.ram[i].toString(16).padStart(5, '0')}`);
        }
      }
      console.log(
        `Result: P=0x${ns.registers.P.toString(16)} A=0x${ns.registers.A.toString(16)} ` +
        `B=0x${ns.registers.B.toString(16)} state=${ns.state} RAM=${mismatches === 0 ? 'OK' : mismatches + ' mismatches'}`
      );

      if (label === 'CUBE') {
        console.log('Full RAM dump:');
        for (let i = 0; i < 64; i++) {
          const expected = i < node.len && node.mem[i] !== null ? '0x' + node.mem[i]!.toString(16).padStart(5, '0') : '-';
          console.log(`  RAM[${i}]: 0x${ns.ram[i].toString(16).padStart(5, '0')} (expected: ${expected})`);
        }
      }
    }
  });

  it('diagnostic: 709 CUBE time-lapse (check state at boot completion)', { timeout: 60_000 }, () => {
    const source = [
      '#include std',
      'node 709', '/\\', 'x = 0', '/\\',
      'std.loop{n=32767}', '/\\ std.plus{a=x, b=1, c=x}',
      '/\\ std.send{port=0x145, value=x}', '/\\ std.again{}',
    ].join('\n') + '\n';

    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);
    const boot = buildBootStream(compiled.nodes);
    const bits = GA144.buildSerialBits(Array.from(boot.bytes), BOOT_BAUD_PERIOD, IDLE_PERIOD);
    const totalBitDuration = bits.reduce((s, b) => s + b.duration, 0);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();

    const node708 = ga.getNodeByCoord(708);
    let bitIdx = 0;
    let remaining = bits.length > 0 ? bits[0].duration : 0;

    const checkpoints = [
      Math.floor(totalBitDuration * 0.5),
      Math.floor(totalBitDuration * 0.9),
      totalBitDuration,
      totalBitDuration + 100,
      totalBitDuration + 1000,
      totalBitDuration + 10000,
      totalBitDuration + 100000,
      5_000_000,
    ];
    let checkIdx = 0;

    for (let step = 0; step < 5_000_000; step++) {
      if (bitIdx < bits.length) {
        node708.setPin17(bits[bitIdx].value);
        remaining--;
        if (remaining <= 0) {
          bitIdx++;
          remaining = bitIdx < bits.length ? bits[bitIdx].duration : 0;
        }
      } else {
        node708.setPin17(false);
      }

      ga.stepProgram();

      if (checkIdx < checkpoints.length && step >= checkpoints[checkIdx]) {
        const ns709 = ga.getSnapshot(709).selectedNode!;
        const ns708 = ga.getSnapshot(708).selectedNode!;
        console.log(
          `step ${step}: 709 P=0x${ns709.registers.P.toString(16)} A=0x${ns709.registers.A.toString(16)} ` +
          `B=0x${ns709.registers.B.toString(16)} R=0x${ns709.registers.R.toString(16)} ` +
          `T=0x${ns709.registers.T.toString(16)} state=${ns709.state} | ` +
          `708 P=0x${ns708.registers.P.toString(16)} state=${ns708.state}`
        );
        checkIdx++;
      }
    }
  });

  it('diagnostic: direct-load CUBE on 709 (bypass boot)', { timeout: 10_000 }, () => {
    const source = [
      '#include std',
      'node 709', '/\\', 'x = 0', '/\\',
      'std.loop{n=32767}', '/\\ std.plus{a=x, b=1, c=x}',
      '/\\ std.send{port=0x145, value=x}', '/\\ std.again{}',
    ].join('\n') + '\n';

    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const node = compiled.nodes[0];
    console.log(`Compiled 709: len=${node.len} p=${node.p} a=${node.a} b=${node.b} io=${node.io}`);
    console.log('Disassembly:');
    for (const line of disassembleNode(node)) console.log(`  ${line}`);

    const ga = new GA144('test');
    ga.setRomData(ROM_DATA);
    ga.reset();
    ga.load(compiled);

    for (let step = 0; step < 100; step++) {
      ga.stepProgram();
      const ns = ga.getSnapshot(709).selectedNode!;
      if (ns.state !== 'running') {
        console.log(
          `step ${step}: STOPPED P=0x${ns.registers.P.toString(16)} A=0x${ns.registers.A.toString(16)} ` +
          `B=0x${ns.registers.B.toString(16)} T=0x${ns.registers.T.toString(16)} ` +
          `S=0x${ns.registers.S.toString(16)} R=0x${ns.registers.R.toString(16)} state=${ns.state}`
        );
        break;
      }
    }

    const ns = ga.getSnapshot(709).selectedNode!;
    console.log(
      `Final: P=0x${ns.registers.P.toString(16)} A=0x${ns.registers.A.toString(16)} ` +
      `B=0x${ns.registers.B.toString(16)} T=0x${ns.registers.T.toString(16)} ` +
      `state=${ns.state}`
    );
  });

  it('diagnostic: frame1 structure validation for 3-node RSC', { timeout: 30_000 }, () => {
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

    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const boot = buildBootStream(compiled.nodes);
    const words = boot.words;

    const magic = words[0];
    const dir = words[1];
    const frame1Len = words[2];
    console.log(`frame1: magic=0x${magic.toString(16)} dir=0x${dir.toString(16)} len=${frame1Len}`);
    expect(magic).toBe(0xAE);

    const f2 = 3 + frame1Len;
    const f2StartP = words[f2];
    const f2Pad = words[f2 + 1];
    const f2CodeLen = words[f2 + 2];
    console.log(`frame2: startP=${f2StartP} pad=${f2Pad} codeLen=${f2CodeLen} (at word[${f2}])`);

    for (const node of compiled.nodes) {
      let end = node.len;
      while (end > 0 && (node.mem[end - 1] === null || node.mem[end - 1] === undefined)) {
        end--;
      }
      console.log(`  node ${node.coord}: len=${node.len} usedPortion=${end} b=${node.b} p=${node.p}`);
      expect(end, `node ${node.coord} used portion should match len`).toBe(node.len);
    }

    const code = words.slice(3, 3 + frame1Len);
    console.log(`\nSimulating frame1 relay chain (${code.length} words):`);

    let pos = 0;
    const pathCoords = boot.path;
    const wireSet = new Set(boot.wireNodes);
    const nodeMap = new Map(compiled.nodes.map(n => [n.coord, n]));

    for (let pi = 0; pi < pathCoords.length && pos < code.length; pi++) {
      const coord = pathCoords[pi];
      const isWire = wireSet.has(coord);
      const node = nodeMap.get(coord);
      const startPos = pos;

      pos++;

      if (isWire) {
        if (pos + 5 <= code.length) {
          const relayCount = (code[pos + 3] & 0x3FFFF) + 1;
          pos += 5;
          pos += relayCount;
          pos++;
          console.log(`  [${startPos}] ${coord} (wire): relay ${relayCount} words, consumed ${pos - startPos}`);
        }
      } else if (node) {
        const remaining = code.length - pos;
        if (remaining >= 5) {
          const hasPortPump = pi < pathCoords.length - 1;
          if (hasPortPump && remaining > 6) {
            const relayCount = (code[pos + 3] & 0x3FFFF) + 1;
            pos += 5;
            pos += relayCount;
            const lpLen = (code[pos + 2] & 0x3FFFF) + 1;
            pos += 5;
            pos += lpLen;

            let descWords = 0;
            if (node.a !== undefined) descWords += 2;
            if (node.io !== undefined) descWords += 4;
            if (node.b !== undefined) descWords += 2;
            if (node.stack && node.stack.length > 0) descWords += 2 + node.stack.length;
            descWords += 1;
            pos += descWords;
            console.log(
              `  [${startPos}] ${coord} (target): relay ${relayCount}, load ${lpLen}, desc ${descWords}, consumed ${pos - startPos}`
            );
          } else {
            const lpCount = (code[pos + 2] & 0x3FFFF) + 1;
            pos += 5;
            pos += lpCount;
            let descWords = 0;
            if (node.a !== undefined) descWords += 2;
            if (node.io !== undefined) descWords += 4;
            if (node.b !== undefined) descWords += 2;
            if (node.stack && node.stack.length > 0) descWords += 2 + node.stack.length;
            descWords += 1;
            pos += descWords;
            console.log(
              `  [${startPos}] ${coord} (target, last): load ${lpCount}, desc ${descWords}, consumed ${pos - startPos}`
            );
          }
        }
      }
    }
    console.log(`\nTotal consumed: ${pos}/${code.length} (remaining: ${code.length - pos})`);
    expect(pos).toBe(code.length);
  });
});
