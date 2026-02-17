import { readFileSync } from 'fs';
import { compileCube } from './src/core/cube/index.ts';
import { GA144 } from './src/core/ga144.ts';
import { ROM_DATA } from './src/core/rom-data.ts';
import { readIoWrite, taggedCoord, taggedValue, isHsync, isVsync } from './src/ui/emulator/vgaResolution.ts';
import { VGA_NODE_R, VGA_NODE_G, VGA_NODE_B, VGA_NODE_SYNC } from './src/core/constants.ts';

const source = readFileSync('./samples/CH.cube', 'utf-8');
const result = compileCube(source);
console.log('compile errors:', result.errors.length);
if (result.errors.length > 0) {
  console.log(JSON.stringify(result.errors, null, 2));
  process.exit(1);
}
console.log('nodes:', result.nodes.map((n: any) => n.coord).sort((a: number, b: number) => a - b));

const ga = new GA144('test');
ga.setRomData(ROM_DATA);
ga.reset();
ga.load(result);

// Run a modest number of steps to check initial behavior
ga.stepUntilDone(500_000);
const snap = ga.getSnapshot();
console.log('IO writes after 500K steps:', snap.ioWriteCount);

let rCount = 0, gCount = 0, bCount = 0, syncCount = 0, hsyncCount = 0, vsyncCount = 0;
const coordCounts = new Map<number, number>();
for (let i = 0; i < snap.ioWriteCount; i++) {
  const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
  const coord = taggedCoord(tagged);
  coordCounts.set(coord, (coordCounts.get(coord) || 0) + 1);
  if (coord === VGA_NODE_R) rCount++;
  else if (coord === VGA_NODE_G) gCount++;
  else if (coord === VGA_NODE_B) bCount++;
  else if (coord === VGA_NODE_SYNC) {
    syncCount++;
    if (isHsync(tagged)) hsyncCount++;
    else if (isVsync(tagged)) vsyncCount++;
    else console.log('  sync node wrote unknown value:', taggedValue(tagged).toString(16));
  }
}

console.log('R:', rCount, 'G:', gCount, 'B:', bCount);
console.log('sync:', syncCount, 'hsync:', hsyncCount, 'vsync:', vsyncCount);
console.log('all coords:', Object.fromEntries(coordCounts));

// Show first 20 IO writes
console.log('\nFirst 20 IO writes:');
for (let i = 0; i < Math.min(20, snap.ioWriteCount); i++) {
  const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
  const coord = taggedCoord(tagged);
  const val = taggedValue(tagged);
  let label = '';
  if (coord === VGA_NODE_R) label = 'R';
  else if (coord === VGA_NODE_G) label = 'G';
  else if (coord === VGA_NODE_B) label = 'B';
  else if (isHsync(tagged)) label = 'HSYNC';
  else if (isVsync(tagged)) label = 'VSYNC';
  else label = 'node' + coord;
  console.log('  [' + i + '] ' + label + ' coord=' + coord + ' val=0x' + val.toString(16));
}
