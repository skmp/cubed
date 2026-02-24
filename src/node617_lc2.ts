import { readFileSync } from 'fs';
import { CodeBuilder } from './src/core/codegen/builder.ts';
import { compileCube } from './src/core/cube/index.ts';

// Track all build() calls with their locationCounters
const buildCalls: Array<{lc: number, sp: number, afterLc: number}> = [];
const origBuild = CodeBuilder.prototype.build;
CodeBuilder.prototype.build = function() {
  const lcBefore = this['locationCounter'];
  const spBefore = this['slotPointer'];
  const result = origBuild.call(this);
  buildCalls.push({lc: lcBefore, sp: spBefore, afterLc: this['locationCounter']});
  return result;
};

// Also track emitOp to count operations
const _opCount617 = 0;

const source = readFileSync('./samples/CH.cube', 'utf-8');
const result = compileCube(source);

console.log('All build() calls:');
buildCalls.forEach((c, i) => {
  console.log(`  build[${i}]: lc_before=${c.lc}, sp=${c.sp}, lc_after=${c.afterLc}, total_words=${c.afterLc}`);
});

for (const node of result.nodes) {
  console.log(`Node ${node.coord}: len=${node.len}`);
}
