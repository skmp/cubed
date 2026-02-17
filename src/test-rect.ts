import { readFileSync } from 'fs';
import { compileCube } from './src/core/cube/compiler';

const source = readFileSync('samples/blue-rectangle.cube', 'utf-8');
const result = compileCube(source);

console.log('Errors:', result.errors.map(e => e.message));
console.log('Nodes:', result.nodes.length);
for (const node of result.nodes) {
  const wordsUsed = node.mem.filter(w => w !== null && w !== 0).length;
  console.log('  Node ' + node.coord + ': ' + wordsUsed + ' words, mem length: ' + node.len);
}

const OPCODES = [
  'ret', 'exec', 'jmp', 'call', 'unext', 'next', 'if', '-if',
  '@p', '@+', '@b', '@', '!p', '!+', '!b', '!',
  '+*', '2*', '2/', 'not', '+', 'and', 'or', 'drop',
  'dup', 'pop', 'over', 'a', '.', 'push', 'b!', 'a!',
];

for (const node of result.nodes) {
  console.log('\nNode ' + node.coord + ' disassembly:');
  for (let addr = 0; addr < node.len; addr++) {
    const raw = node.mem[addr];
    if (raw === null) { console.log('  ' + addr + ': (null)'); continue; }
    const decoded = raw ^ 0x15555;
    const s0 = (decoded >> 13) & 0x1F;
    const s1 = (decoded >> 8) & 0x1F;
    const s2 = (decoded >> 3) & 0x1F;
    const s3 = decoded & 0x07;
    const ops = [OPCODES[s0], OPCODES[s1], OPCODES[s2], OPCODES[s3]];
    const hex = '0x' + raw.toString(16).padStart(5, '0');
    console.log('  ' + addr.toString().padStart(3) + ': ' + hex + '  ' + ops.join(' '));
  }
}
