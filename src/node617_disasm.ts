import { compileCube } from './src/core/cube/index.ts';
import { disassemble } from './src/core/disassembler.ts';
import { readFileSync } from 'fs';

const source = readFileSync('./samples/CH.cube', 'utf-8');
const result = compileCube(source);

for (const node of result.nodes) {
  if (node.coord === 617) {
    console.log(`Node ${node.coord}: len=${node.len} words`);
    // Disassemble each word
    for (let i = 0; i < node.len; i++) {
      const v = node.mem[i];
      if (v !== null && v !== undefined) {
        try {
          const asm = disassemble(v, i);
          console.log(`  [${i}] 0x${v.toString(16).padStart(5,'0')}  ${asm}`);
        } catch {
          console.log(`  [${i}] 0x${v.toString(16).padStart(5,'0')}  (data)`);
        }
      }
    }
  }
}
