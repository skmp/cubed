// Script to extract ROM data from Racket source files
import { readFileSync, writeFileSync } from 'fs';

// Read rom-dump.rkt
const romDump = readFileSync('../reference/ga144/src/rom-dump.rkt', 'utf8');

// Parse ROM dump - format: '(coord val1 val2 val3 ...)
const romData = {};
const dumpLines = romDump.split('\n');
for (const line of dumpLines) {
  const m = line.match(/^'?\((\d+)\s+(.+)\)\s*$/);
  if (m) {
    const coord = parseInt(m[1]);
    const values = m[2].trim().split(/\s+/).map(v => parseInt(v));
    if (values.length > 0 && !isNaN(values[0])) {
      romData[coord] = values;
    }
  }
}

console.log(`Extracted ${Object.keys(romData).length} ROM entries`);

// Read rom.rkt for symbol tables
const romSrc = readFileSync('../reference/ga144/src/rom.rkt', 'utf8');

// Parse ROM symbol tables
function parseRomSymbols(blockName, src) {
  // Find the block - handle both defconst and define
  const startIdx = src.indexOf(`${blockName} '(`);
  if (startIdx === -1) return {};

  // Find the content after '(
  let i = src.indexOf("'(", startIdx);
  if (i === -1) return {};
  i += 1; // skip quote

  // Find matching closing paren
  let depth = 0;
  let content = '';
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    if (ch === ')') { depth--; if (depth === 0) { content += ch; break; } }
    content += ch;
  }

  const symbols = {};
  const symRegex = /\("([^"]+)"\s*\.?\s*(?:#x([0-9a-fA-F]+)|(\d+))\)/g;
  let m;
  while ((m = symRegex.exec(content)) !== null) {
    const name = m[1];
    const addr = m[2] ? parseInt(m[2], 16) : parseInt(m[3]);
    symbols[name] = addr;
  }
  return symbols;
}

const romSymbols = {
  basic: parseRomSymbols('basic-rom', romSrc),
  analog: parseRomSymbols('analog-rom', romSrc),
  serdes_boot: parseRomSymbols('serdes-boot-rom', romSrc),
  sync_boot: parseRomSymbols('sync-boot-rom', romSrc),
  async_boot: parseRomSymbols('async-boot-rom', romSrc),
  spi_boot: parseRomSymbols('spi-boot-rom', romSrc),
  one_wire: parseRomSymbols('1-wire-rom', romSrc),
};

console.log('ROM symbol tables:');
for (const [name, syms] of Object.entries(romSymbols)) {
  console.log(`  ${name}: ${Object.keys(syms).length} symbols`);
}

// Generate TypeScript
let ts = `// ROM dump data for all 144 GA144 nodes
// Auto-generated from reference/ga144/src/rom-dump.rkt
// DO NOT EDIT MANUALLY

export const ROM_DATA: Record<number, number[]> = {\n`;

const coords = Object.keys(romData).map(Number).sort((a, b) => a - b);
for (const coord of coords) {
  const values = romData[coord];
  ts += `  ${coord}: [${values.join(', ')}],\n`;
}
ts += `};\n\n`;

ts += `// ROM symbol tables (entry points) from reference/ga144/src/rom.rkt\n`;
ts += `export const ROM_SYMBOLS: Record<string, Record<string, number>> = {\n`;
for (const [name, syms] of Object.entries(romSymbols)) {
  if (Object.keys(syms).length === 0) {
    ts += `  ${name}: {},\n`;
    continue;
  }
  const entries = Object.entries(syms).map(([k, v]) => `'${k}': 0x${v.toString(16)}`).join(', ');
  ts += `  ${name}: { ${entries} },\n`;
}
ts += `};\n`;

writeFileSync('src/core/rom-data.ts', ts);
console.log(`\nWrote src/core/rom-data.ts (${ts.length} bytes, ${coords.length} nodes)`);
