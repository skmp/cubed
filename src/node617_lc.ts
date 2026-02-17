import { compileCube } from './src/core/cube/index.ts';
import { readFileSync } from 'fs';
import { CodeBuilder } from './src/core/codegen/builder.ts';

// Monkey-patch CodeBuilder to track max locationCounter
const origBuild = CodeBuilder.prototype.build;
CodeBuilder.prototype.build = function() {
  console.log('locationCounter before flush in build():', this['locationCounter'], 'slotPointer:', this['slotPointer']);
  const result = origBuild.call(this);
  console.log('locationCounter after build:', this['locationCounter']);
  return result;
};

const source = readFileSync('./samples/CH.cube', 'utf-8');
const result = compileCube(source);

for (const node of result.nodes) {
  if (node.coord === 617) {
    console.log(`Node ${node.coord}: len=${node.len}`);
  }
}
