/**
 * cubec — CUBE language command-line compiler
 *
 * Usage:
 *   ./node_modules/.bin/esbuild --bundle cubec.ts --platform=node --format=esm | node --input-type=module - <file.cube>
 *   # or use the cubec wrapper script
 *
 * Options:
 *   --verbose   Show symbols, variables, source map
 *   --disasm    Show per-node disassembly
 *   --json      Output compile result as JSON
 *   --quiet     Only show errors
 *   --svg       Output SVG visualization to <file>.svg
 */
import { readFileSync, writeFileSync } from 'fs';
import { compileCube } from './src/core/cube/compiler';
import { tokenizeCube } from './src/core/cube/tokenizer';
import { parseCube } from './src/core/cube/parser';
import { disassembleNode } from './src/core/disassembler';
import { layoutAST } from './src/ui/cube3d/layoutEngine';
import { sceneGraphToSVG } from './src/ui/cube3d/svgExport';

// ---- Argument parsing ----

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const files = args.filter(a => !a.startsWith('--'));

if (files.length === 0) {
  console.error('cubec — CUBE language compiler for GA144');
  console.error('');
  console.error('Usage: ./cubec <file.cube> [options]');
  console.error('');
  console.error('Options:');
  console.error('  --verbose   Show symbols, variables, source map');
  console.error('  --disasm    Show per-node disassembly');
  console.error('  --json      Output compile result as JSON');
  console.error('  --quiet     Only show errors');
  console.error('  --svg       Output SVG visualization to <file>.svg');
  process.exit(1);
}

const verbose = flags.has('--verbose');
const disasm = flags.has('--disasm');
const jsonOut = flags.has('--json');
const quiet = flags.has('--quiet');
const svgOut = flags.has('--svg');

// ---- Compile ----

const filePath = files[0];
let source: string;
try {
  source = readFileSync(filePath, 'utf-8');
} catch {
  console.error(`Error: cannot read file '${filePath}'`);
  process.exit(1);
}

const result = compileCube(source);

// ---- SVG output ----

if (svgOut) {
  const { tokens, errors: tokErrors } = tokenizeCube(source);
  if (tokErrors.length === 0) {
    const { ast, errors: parseErrors } = parseCube(tokens);
    if (parseErrors.length === 0) {
      const sceneGraph = layoutAST(ast);
      const svg = sceneGraphToSVG(sceneGraph);
      const svgPath = filePath.replace(/\.cube$/, '.svg');
      writeFileSync(svgPath, svg, 'utf-8');
      console.log(`  SVG written to ${svgPath}`);
    } else {
      console.error('  SVG: parse errors, skipping SVG generation');
    }
  } else {
    console.error('  SVG: tokenization errors, skipping SVG generation');
  }
}

// ---- JSON output mode ----

if (jsonOut) {
  const out = {
    file: filePath,
    errors: result.errors,
    nodes: result.nodes.map(n => ({
      coord: n.coord,
      memLen: n.mem.length,
      mem: Array.from(n.mem).map(w => '0x' + w.toString(16).padStart(5, '0')),
    })),
    symbols: result.symbols ? Object.fromEntries(result.symbols) : undefined,
    variables: result.variables ? Object.fromEntries(
      [...result.variables.entries()].map(([k, v]) => [k, { addr: v.addr, field: v.field }])
    ) : undefined,
    sourceMap: result.sourceMap,
    nodeCoord: result.nodeCoord,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(result.errors.length > 0 ? 1 : 0);
}

// ---- Errors ----

if (result.errors.length > 0) {
  console.error(`\x1b[31m✗ ${filePath}: ${result.errors.length} error(s)\x1b[0m`);
  for (const err of result.errors) {
    const loc = err.line ? `:${err.line}${err.col ? ':' + err.col : ''}` : '';
    console.error(`  ${filePath}${loc}: ${err.message}`);
  }
  process.exit(1);
}

if (quiet) {
  console.log(`\x1b[32m✓ ${filePath}\x1b[0m`);
  process.exit(0);
}

// ---- Summary ----

console.log(`\x1b[32m✓ ${filePath}\x1b[0m — compiled successfully`);
console.log('');

// Node summary
for (const node of result.nodes) {
  const wordsUsed = node.mem.filter(w => w !== 0).length;
  console.log(`  Node ${node.coord.toString().padStart(3, '0')}: ${wordsUsed} words used (${node.mem.length} allocated)`);
}

if (result.nodeCoord !== undefined) {
  console.log(`  Target node: ${result.nodeCoord}`);
}

// ---- Verbose: symbols, variables, source map ----

if (verbose) {
  console.log('');

  if (result.symbols && result.symbols.size > 0) {
    console.log('  \x1b[1mSymbols:\x1b[0m');
    for (const [name, sym] of result.symbols) {
      console.log(`    ${name.padEnd(24)} ${sym.kind.padEnd(12)} ${sym.addr !== undefined ? '@' + sym.addr : ''}`);
    }
    console.log('');
  }

  if (result.variables && result.variables.size > 0) {
    console.log('  \x1b[1mVariables:\x1b[0m');
    for (const [name, mapping] of result.variables) {
      console.log(`    ${name.padEnd(24)} RAM[0x${mapping.addr.toString(16)}] (${mapping.field})`);
    }
    console.log('');
  }

  if (result.sourceMap && result.sourceMap.length > 0) {
    console.log('  \x1b[1mSource Map:\x1b[0m');
    for (const entry of result.sourceMap) {
      console.log(`    @${entry.addr.toString().padStart(3)} → line ${entry.line.toString().padStart(3)}:${entry.col.toString().padStart(2)}  ${entry.label}`);
    }
    console.log('');
  }
}

// ---- Disassembly ----

if (disasm) {
  console.log('  \x1b[1mDisassembly:\x1b[0m');

  for (const node of result.nodes) {
    console.log(`\n  Node ${node.coord.toString().padStart(3, '0')}:`);
    const lines = disassembleNode(node);
    for (let i = 0; i < lines.length; i++) {
      // Check if this address has a source map label
      let label = '';
      if (result.sourceMap) {
        const entry = result.sourceMap.find(e => e.addr === i);
        if (entry) label = `  \x1b[33m; ${entry.label}\x1b[0m`;
      }
      console.log(`    ${lines[i]}${label}`);
    }
  }
  console.log('');
}
