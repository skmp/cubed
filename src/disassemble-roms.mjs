/**
 * Disassemble GA144 ROMs and write annotated documentation to docs/rom/
 *
 * Usage: node disassemble-roms.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// We can't import TS directly, so we'll extract what we need manually.

// ---- Constants (from constants.ts) ----
const OPCODES = [
  ';', 'ex', 'jump', 'call', 'unext', 'next', 'if', '-if',
  '@p', '@+', '@b', '@', '!p', '!+', '!b', '!',
  '+*', '2*', '2/', '-', '+', 'and', 'or', 'drop',
  'dup', 'pop', 'over', 'a', '.', 'push', 'b!', 'a!',
];

const ADDRESS_REQUIRED = new Set(['jump', 'call', 'next', 'if', '-if']);
const INSTRUCTIONS_USING_REST_OF_WORD = new Set([';', 'ex']);

const XOR_ENCODING = 0x15555;

// ---- ROM Types per node ----
const ANALOG_NODES = [709, 713, 717, 617, 117];
const SERDES_NODES = [1, 701];
const SYNC_BOOT_NODES = [300];
const ASYNC_BOOT_NODES = [708];
const SPI_BOOT_NODES = [705];
const ONE_WIRE_NODES = [200];

function getRomType(coord) {
  if (ANALOG_NODES.includes(coord)) return 'analog';
  if (SERDES_NODES.includes(coord)) return 'serdes_boot';
  if (SYNC_BOOT_NODES.includes(coord)) return 'sync_boot';
  if (ASYNC_BOOT_NODES.includes(coord)) return 'async_boot';
  if (SPI_BOOT_NODES.includes(coord)) return 'spi_boot';
  if (ONE_WIRE_NODES.includes(coord)) return 'one_wire';
  return 'basic';
}

// ---- ROM Symbols ----
const ROM_SYMBOLS = {
  basic: { 'relay': 0xa1, 'warm': 0xa9, '*.17': 0xb0, '*.': 0xb7, 'taps': 0xbc, 'interp': 0xc4, 'triangle': 0xce, 'clc': 0xd3, '--u/mod': 0x2d5, '-u/mod': 0x2d6, 'poly': 0xaa },
  analog: { 'relay': 0xa1, 'warm': 0xa9, '*.17': 0xb0, '*.': 0xb7, '-dac': 0xbc, 'interp': 0xc4, 'triangle': 0xce, 'clc': 0xd3, '--u/mod': 0x2d5, '-u/mod': 0x2d6, 'poly': 0xaa },
  serdes_boot: { 'relay': 0xa1, 'warm': 0xa9, 'cold': 0xaa, '*.17': 0xb0, '*.': 0xb7, 'taps': 0xbc, 'interp': 0xc4, 'triangle': 0xce, 'clc': 0xd3, '--u/mod': 0x2d5, '-u/mod': 0x2d6, 'poly': 0xaa },
  sync_boot: { 'relay': 0xa1, 'warm': 0xa9, 'cold': 0xaa, 'ser-exec': 0xb6, 'ser-copy': 0xb9, 'sget': 0xbe, '6in': 0xc0, '2in': 0xc2, '*.17': 0xcc, 'taps': 0xd3, 'triangle': 0xdb },
  async_boot: { 'relay': 0xa1, 'warm': 0xa9, 'cold': 0xaa, 'ser-exec': 0xae, 'ser-copy': 0xb3, 'wait': 0xbb, 'sync': 0xbe, 'start': 0xc5, 'delay': 0xc8, '18ibits': 0xcb, 'byte': 0xd0, '4bits': 0xd2, '2bits': 0xd3, '1bit': 0xd4, 'lsh': 0xd9, 'rsh': 0xdb },
  spi_boot: { 'relay': 0xa1, 'warm': 0xa9, '8obits': 0xc2, 'ibit': 0xc7, 'half': 0xca, 'select': 0xcc, 'obit': 0xd0, 'rbit': 0xd5, '18ibits': 0xd9, 'cold': 0xaa, 'spi-boot': 0xb0, 'spi-exec': 0xb6, 'spi-copy': 0xbc },
  one_wire: { 'rcv': 0x9e, 'bit': 0xa1, 'warm': 0xa9, 'cold': 0xaa, 'triangle': 0xbe, '*.17': 0xc3, '*.': 0xca, 'interp': 0xcf, 'clc': 0xcf, '--u/mod': 0x2d1, '-u/mod': 0x2d2 },
};

// ---- Disassembler ----
function disassembleWord(word) {
  const xored = word ^ XOR_ENCODING;
  const slots = [null, null, null, null];

  const slot0opcode = (xored >> 13) & 0x1F;
  const slot0name = OPCODES[slot0opcode];
  slots[0] = { opcode: slot0name };
  if (ADDRESS_REQUIRED.has(slot0name)) {
    slots[0].address = word & 0x3FF;
    return { slots, raw: word };
  }
  if (INSTRUCTIONS_USING_REST_OF_WORD.has(slot0name)) {
    return { slots, raw: word };
  }

  const slot1opcode = (xored >> 8) & 0x1F;
  const slot1name = OPCODES[slot1opcode];
  slots[1] = { opcode: slot1name };
  if (ADDRESS_REQUIRED.has(slot1name)) {
    slots[1].address = word & 0xFF;
    return { slots, raw: word };
  }
  if (INSTRUCTIONS_USING_REST_OF_WORD.has(slot1name)) {
    return { slots, raw: word };
  }

  const slot2opcode = (xored >> 3) & 0x1F;
  const slot2name = OPCODES[slot2opcode];
  slots[2] = { opcode: slot2name };
  if (ADDRESS_REQUIRED.has(slot2name)) {
    slots[2].address = word & 0x7;
    return { slots, raw: word };
  }
  if (INSTRUCTIONS_USING_REST_OF_WORD.has(slot2name)) {
    return { slots, raw: word };
  }

  const slot3opcode = (xored & 0x7) << 2;
  const slot3name = OPCODES[slot3opcode];
  slots[3] = { opcode: slot3name };

  return { slots, raw: word };
}

function formatSlots(dis) {
  const parts = [];
  for (const slot of dis.slots) {
    if (!slot) break;
    if (slot.address !== undefined) {
      parts.push(`${slot.opcode}(0x${slot.address.toString(16)})`);
    } else {
      parts.push(slot.opcode);
    }
  }
  return parts.join(' | ');
}

function hasLiteralFetch(dis) {
  for (const slot of dis.slots) {
    if (!slot) break;
    if (slot.opcode === '@p') return true;
  }
  return false;
}

// ---- Load ROM data ----
// rom-data.ts exports ROM_DATA as a Record<number, number[]>
// We need to parse it. Easier to just eval the relevant part.
const romDataFile = readFileSync(join(__dirname, 'src/core/rom-data.ts'), 'utf-8');

// Extract ROM_DATA object - it's a Record<number, number[]>
// Parse it by finding the assignment and extracting the JSON-like object
const romDataMatch = romDataFile.match(/export const ROM_DATA[^=]*=\s*(\{[\s\S]*?\n\};)/);
if (!romDataMatch) {
  console.error('Could not parse ROM_DATA from rom-data.ts');
  process.exit(1);
}
// Convert to valid JS and eval
const romDataStr = romDataMatch[1].replace(/;$/, '');
const ROM_DATA = eval(`(${romDataStr})`);

// ---- Generate disassembly for a ROM type ----
function disassembleRom(coord, romData, symbols) {
  const rom = romData[coord];
  if (!rom) return null;

  // Build reverse symbol map: address -> name
  const addrToSymbol = {};
  for (const [name, addr] of Object.entries(symbols)) {
    if (!addrToSymbol[addr]) addrToSymbol[addr] = [];
    addrToSymbol[addr].push(name);
  }

  const lines = [];
  let nextIsData = false;

  for (let i = 0; i < rom.length; i++) {
    const addr = 0x80 + i;
    const addrHex = `0x${addr.toString(16)}`;

    // Add label if this address has a symbol
    if (addrToSymbol[addr]) {
      lines.push('');
      lines.push(`; ---- ${addrToSymbol[addr].join(' / ')} ----`);
    }

    const rawHex = `0x${rom[i].toString(16).padStart(5, '0')}`;

    if (nextIsData) {
      lines.push(`  [${addrHex}]  ${rawHex}  (data: ${rom[i]})`);
      nextIsData = false;
      continue;
    }

    const dis = disassembleWord(rom[i]);
    const instr = formatSlots(dis);
    lines.push(`  [${addrHex}]  ${rawHex}  ${instr}`);
    nextIsData = hasLiteralFetch(dis);
  }

  return lines;
}

// ---- Main ----
const outDir = join(__dirname, '..', 'docs', 'rom');
mkdirSync(outDir, { recursive: true });

// Representative nodes for each ROM type
const romTypes = {
  'async_boot': { coord: 708, label: 'Async Serial Boot ROM (node 708)' },
  'sync_boot': { coord: 300, label: 'Sync Serial Boot ROM (node 300)' },
  'spi_boot': { coord: 705, label: 'SPI Boot ROM (node 705)' },
  'one_wire': { coord: 200, label: '1-Wire Boot ROM (node 200)' },
  'serdes_boot': { coord: 1, label: 'SerDes Boot ROM (node 001)' },
  'basic': { coord: 0, label: 'Basic Math ROM (node 000)' },
  'analog': { coord: 709, label: 'Analog ROM (node 709)' },
};

for (const [type, { coord, label }] of Object.entries(romTypes)) {
  const symbols = ROM_SYMBOLS[type] || {};
  const lines = disassembleRom(coord, ROM_DATA, symbols);
  if (!lines) {
    console.log(`  Skipping ${type}: no ROM data for node ${coord}`);
    continue;
  }

  const header = [
    `# ${label}`,
    ``,
    `ROM type: \`${type}\``,
    `Representative node: ${coord}`,
    `ROM address range: 0x80 - 0xBF (64 words)`,
    ``,
    `## Symbols`,
    ``,
    `| Symbol | Address |`,
    `|--------|---------|`,
  ];

  // Sort symbols by address
  const sortedSymbols = Object.entries(symbols).sort((a, b) => a[1] - b[1]);
  for (const [name, addr] of sortedSymbols) {
    header.push(`| ${name} | 0x${addr.toString(16)} |`);
  }

  header.push('');
  header.push('## Disassembly');
  header.push('');
  header.push('```');

  const footer = ['```', ''];

  const content = [...header, ...lines, ...footer].join('\n');
  const filename = `${type}.md`;
  writeFileSync(join(outDir, filename), content);
  console.log(`  Written: docs/rom/${filename} (${lines.length} lines)`);
}

// Also write an index
const indexLines = [
  '# GA144 ROM Disassembly Index',
  '',
  'Disassembled ROM contents for all GA144 ROM types.',
  'Generated by `node src/disassemble-roms.mjs`.',
  '',
  '## ROM Types',
  '',
  '| ROM Type | Representative Node | File |',
  '|----------|-------------------|------|',
];

for (const [type, { coord, label }] of Object.entries(romTypes)) {
  indexLines.push(`| ${label} | ${coord} | [${type}.md](${type}.md) |`);
}

indexLines.push('');
indexLines.push('## Node ROM Type Assignments');
indexLines.push('');
indexLines.push('| Node Coordinates | ROM Type |');
indexLines.push('|-----------------|----------|');
indexLines.push(`| ${ANALOG_NODES.join(', ')} | analog |`);
indexLines.push(`| ${SERDES_NODES.join(', ')} | serdes_boot |`);
indexLines.push(`| ${SYNC_BOOT_NODES.join(', ')} | sync_boot |`);
indexLines.push(`| ${ASYNC_BOOT_NODES.join(', ')} | async_boot |`);
indexLines.push(`| ${SPI_BOOT_NODES.join(', ')} | spi_boot |`);
indexLines.push(`| ${ONE_WIRE_NODES.join(', ')} | one_wire |`);
indexLines.push('| All others | basic |');
indexLines.push('');

writeFileSync(join(outDir, 'README.md'), indexLines.join('\n'));
console.log('  Written: docs/rom/README.md');

console.log('\nDone!');
