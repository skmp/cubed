import { describe, it } from 'vitest';
import { CodeBuilder } from './codegen/builder';
import { emitBuiltin } from './cube/builtins';
import { XOR_ENCODING } from './types';
import { OPCODE_MAP } from './constants';

const REV = new Map<number, string>();
for (const [n, v] of OPCODE_MAP.entries()) if (!REV.has(v)) REV.set(v, n);

const BRANCH = new Set([2, 4, 5, 6, 7]);
function disasm(raw: number, addr: number): string {
  const s0 = (raw >> 13) & 31, s1 = (raw >> 8) & 31, s2 = (raw >> 3) & 31, s3 = (raw & 7) << 1;
  const a13 = raw & 0x1FFF, a8 = raw & 0xFF, a3 = raw & 7;
  let p = '';
  if (BRANCH.has(s0)) return `[${String(addr).padStart(2)}] ${REV.get(s0)}(${a13})`;
  p = REV.get(s0) ?? `?${s0}`;
  if (BRANCH.has(s1)) return `[${String(addr).padStart(2)}] ${p}|${REV.get(s1)}(${a8})`;
  p += `|${REV.get(s1) ?? `?${s1}`}`;
  if (BRANCH.has(s2)) return `[${String(addr).padStart(2)}] ${p}|${REV.get(s2)}(${a3})`;
  return `[${String(addr).padStart(2)}] ${p}|${REV.get(s2) ?? `?${s2}`}|${REV.get(s3) ?? `?${s3}`}`;
}

describe('pf_tx disasm', () => {
  it('full disassembly direct', () => {
    const builder = new CodeBuilder(128);
    emitBuiltin(builder, 'pf_tx', []);
    const { mem, len, labels } = builder.build();

    const lo: Record<string, number> = {};
    for (const [k, v] of labels) lo[k] = v;
    console.log('Labels:', JSON.stringify(lo));
    console.log(`len=${len}`);
    for (let i = 0; i < len; i++) {
      const raw = mem[i];
      if (raw == null) { console.log(`[${i}] null`); continue; }
      const d = raw ^ XOR_ENCODING;
      console.log(disasm(d, i));
    }
  });
});

describe('pf_rx disasm', () => {
  it('full disassembly direct (bypasses size check)', () => {
    const builder = new CodeBuilder(128); // large enough to see all words
    emitBuiltin(builder, 'pf_rx', []);
    const { mem, len, labels } = builder.build();

    const lo: Record<string, number> = {};
    for (const [k, v] of labels) lo[k] = v;
    console.log('Labels:', JSON.stringify(lo));
    console.log(`len=${len}`);
    for (let i = 0; i < len; i++) {
      const raw = mem[i];
      if (raw == null) { console.log(`[${i}] null`); continue; }
      const d = raw ^ XOR_ENCODING;
      console.log(disasm(d, i));
    }
  });
});
