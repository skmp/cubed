import { describe, it } from 'vitest';
import { CodeBuilder } from './codegen/builder';
import { emitBuiltin } from './cube/builtins';
import { formatWord } from './disassembler';

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
      console.log(formatWord(raw, i));
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
      console.log(formatWord(raw, i));
    }
  });
});
