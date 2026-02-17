import { readFileSync } from 'fs';
import { compileCube } from './src/core/cube/compiler';
import { GA144 } from './src/core/ga144';

const OPCODES = [
  ';', 'ex', 'jump', 'call', 'unext', 'next', 'if', '-if',
  '@p', '@+', '@b', '@', '!p', '!+', '!b', '!',
  '+*', '2*', '2/', '-', '+', 'and', 'or', 'drop',
  'dup', 'pop', 'over', 'a', '.', 'push', 'b!', 'a!',
];

function disassemble(raw: number): string {
  const decoded = raw ^ 0x15555;
  const s0 = (decoded >> 13) & 0x1F;
  const s1 = (decoded >> 8) & 0x1F;
  const s2 = (decoded >> 3) & 0x1F;
  const s3 = (decoded & 0x07) << 1;
  return `${OPCODES[s0]} ${OPCODES[s1]} ${OPCODES[s2]} ${OPCODES[s3]}`;
}

const source = readFileSync('samples/blue-rectangle.cube', 'utf-8');
const result = compileCube(source);

console.log('=== Compilation ===');
console.log('Errors:', result.errors.map(e => e.message));
for (const node of result.nodes) {
  console.log(`Node ${node.coord}: ${node.len} words`);
}

// Disassemble node 117
const node117data = result.nodes.find(n => n.coord === 117);
if (node117data) {
  console.log('\n=== Node 117 Disassembly ===');
  for (let addr = 0; addr < node117data.len; addr++) {
    const raw = node117data.mem[addr];
    if (raw === null) { console.log(`  ${addr.toString().padStart(3)}: (null)`); continue; }
    const hex = '0x' + raw.toString(16).padStart(5, '0');
    const decoded = raw ^ 0x15555;
    // Check if this looks like a data word (preceded by @p in previous word)
    const isData = addr > 0 && node117data.mem[addr-1] !== null;
    console.log(`  ${addr.toString().padStart(3)}: ${hex}  ${disassemble(raw)}  (raw: 0x${decoded.toString(16).padStart(5, '0')}, dec: ${raw})`);
  }
}

// Run emulation
console.log('\n=== Emulation ===');
const chip = new GA144('test');
chip.reset();
chip.load({ nodes: result.nodes, errors: [] });

const n117 = chip.getNodeByCoord(117);
let snap117 = n117.getSnapshot();
console.log('Initial: P=' + snap117.registers.P + ' T=' + snap117.registers.T + ' R=' + snap117.registers.R + ' B=0x' + snap117.registers.B.toString(16));

// Step and track first 30 steps in detail, then batch step and check IO writes
for (let step = 0; step < 30; step++) {
  chip.stepProgram();
  snap117 = n117.getSnapshot();
  const gsnap = chip.getSnapshot(117);
  console.log('Step ' + (step+1).toString().padStart(3) + ': P=' + snap117.registers.P.toString().padStart(5)
    + ' T=' + snap117.registers.T.toString().padStart(6)
    + ' S=' + snap117.registers.S.toString().padStart(6)
    + ' R=' + snap117.registers.R.toString().padStart(6)
    + ' state=' + snap117.state
    + ' io=' + gsnap.ioWrites.length);
}

// Now batch step - each fill(640) loop needs 640*2 + overhead steps per scanline
// Total: 480 scanlines * ~1300 steps + overhead ≈ 624K steps
// Run in batches and report IO write counts
console.log('\n=== Batch stepping ===');
const batchSize = 10000;
for (let batch = 0; batch < 200; batch++) {
  for (let i = 0; i < batchSize; i++) {
    chip.stepProgram();
  }
  const gsnap = chip.getSnapshot(117);
  snap117 = n117.getSnapshot();
  if (batch % 20 === 0 || gsnap.ioWrites.length >= 307681) {
    console.log(`After ${(batch+1) * batchSize + 30} steps: io_writes=${gsnap.ioWrites.length} P=${snap117.registers.P} R=${snap117.registers.R} state=${snap117.state}`);
  }
  if (gsnap.ioWrites.length >= 307681) {
    console.log('Expected 307681 IO writes (640*480 pixels + 480 hsyncs + 1 vsync)');
    break;
  }
}

const finalSnap = chip.getSnapshot(117);
console.log(`\nFinal: ${finalSnap.ioWrites.length} IO writes`);
// Check first few and last few IO writes
if (finalSnap.ioWrites.length > 0) {
  console.log('First 5 IO writes:', finalSnap.ioWrites.slice(0, 5).map(v => '0x' + v.toString(16)));
  console.log('Last 5 IO writes:', finalSnap.ioWrites.slice(-5).map(v => '0x' + v.toString(16)));
}
