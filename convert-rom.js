// Temporary script to convert Racket ROM data to TypeScript
const fs = require('fs');

// Parse rom-dump.rkt
const dumpContent = fs.readFileSync('reference/ga144/src/rom-dump.rkt', 'utf8');

// Each line looks like: '(707 158394 60592 ...)
// The first number is the node coordinate, followed by 64 data words
const romData = {};
const lineRegex = /'\((\d+)\s+([\d\s]+)\)/g;
let match;
while ((match = lineRegex.exec(dumpContent)) !== null) {
  const nodeId = parseInt(match[1]);
  const values = match[2].trim().split(/\s+/).map(Number);
  romData[nodeId] = values;
}

console.log(`Parsed ${Object.keys(romData).length} nodes from rom-dump.rkt`);

// Verify each node has exactly 64 words
for (const [nodeId, values] of Object.entries(romData)) {
  if (values.length !== 64) {
    console.warn(`WARNING: Node ${nodeId} has ${values.length} words (expected 64)`);
  }
}

// Parse rom.rkt for symbol tables
const romContent = fs.readFileSync('reference/ga144/src/rom.rkt', 'utf8');

// Extract all defconst definitions with ROM symbol tables
const symbols = {};
const defconstRegex = /\(defconst\s+([\w-]+)\s+'?\(([\s\S]*?)\)\)/g;
while ((match = defconstRegex.exec(romContent)) !== null) {
  const name = match[1];
  const body = match[2];

  // Extract key-value pairs like ("warm" . #xa9) or ("warm". #xa9)
  const entryRegex = /\("([^"]+)"\s*\.\s*#x([0-9a-fA-F]+)\)/g;
  let entryMatch;
  const entries = {};
  while ((entryMatch = entryRegex.exec(body)) !== null) {
    entries[entryMatch[1]] = parseInt(entryMatch[2], 16);
  }

  if (Object.keys(entries).length > 0) {
    // Convert name like "basic-rom" -> "basic", "async-boot-rom" -> "async_boot"
    let shortName = name.replace(/-rom$/, '').replace(/-/g, '_');
    symbols[shortName] = entries;
  }
}

console.log(`Parsed ${Object.keys(symbols).length} ROM symbol tables:`);
for (const [name, entries] of Object.entries(symbols)) {
  console.log(`  ${name}: ${Object.keys(entries).length} entries`);
}

// Generate TypeScript
let ts = `// ROM dump data for all 144 GA144 nodes
// Extracted from reference/ga144/src/rom-dump.rkt
// Each node has 64 words of 18-bit ROM data

export const ROM_DATA: Record<number, number[]> = {\n`;

// Sort nodes by coordinate for readability
const sortedNodes = Object.keys(romData).map(Number).sort((a, b) => a - b);
for (let i = 0; i < sortedNodes.length; i++) {
  const nodeId = sortedNodes[i];
  const values = romData[nodeId];
  const comma = i < sortedNodes.length - 1 ? ',' : '';
  ts += `  ${nodeId}: [${values.join(', ')}]${comma}\n`;
}

ts += `};\n\n`;

// Add symbol tables
ts += `// ROM symbol tables extracted from reference/ga144/src/rom.rkt
// Maps ROM type names to their named entry points with addresses
export const ROM_SYMBOLS: Record<string, Record<string, number>> = {\n`;

const symbolNames = Object.keys(symbols);
for (let i = 0; i < symbolNames.length; i++) {
  const name = symbolNames[i];
  const entries = symbols[name];
  const comma = i < symbolNames.length - 1 ? ',' : '';
  const entryStrs = Object.entries(entries).map(([k, v]) => `'${k}': 0x${v.toString(16)}`);
  ts += `  ${name}: { ${entryStrs.join(', ')} }${comma}\n`;
}

ts += `};\n`;

// Ensure directory exists
const outDir = 'src/src/core';
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(`${outDir}/rom-data.ts`, ts);
console.log(`Written ${outDir}/rom-data.ts`);
console.log(`Total nodes: ${sortedNodes.length}`);
console.log(`File size: ${ts.length} bytes`);
