/**
 * Quick verification: compile all sample .cube files and report errors
 */
import fs from 'fs';
import path from 'path';
import { compileCube } from './src/core/cube/compiler.ts';

const samplesDir = path.resolve('samples');
const files = fs.readdirSync(samplesDir).filter(f => f.endsWith('.cube'));

let passed = 0;
let failed = 0;

for (const file of files) {
  const filePath = path.join(samplesDir, file);
  const source = fs.readFileSync(filePath, 'utf-8');
  const result = compileCube(source);

  if (result.errors.length > 0) {
    console.log(`FAIL: ${file}`);
    for (const err of result.errors) {
      console.log(`  ${err.line}:${err.col} ${err.message}`);
    }
    failed++;
  } else {
    console.log(`OK:   ${file} (${result.nodes.length} node(s))`);
    passed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed out of ${files.length} files`);
