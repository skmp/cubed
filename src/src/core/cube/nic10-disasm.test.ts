/**
 * NIC10 per-node disassembly tests.
 * Each node's expected disassembly is traced from the AN007 reference source
 * (docs/txt/AN007-141105-10BASET.txt) and verified against our CUBE compiler output.
 *
 * Nodes use individual f18a.* ops which the CodeBuilder packs into 4-slot words.
 * Most nodes have a register-setup preamble (std.setb + lit.hex18 + f18a.astore)
 * before the AN007-equivalent code. Node 016 uses f18a.reg.* boot descriptors instead.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compileCube } from './compiler';
import { disassembleNode } from '../disassembler';
import type { CompiledNode } from '../types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('NIC10 per-node disassembly', () => {
  let nodeMap: Map<number, CompiledNode>;

  beforeAll(() => {
    const source = readFileSync(join(__dirname, '../../../samples/NIC10.cube'), 'utf-8');
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.nodes.length).toBe(27);
    nodeMap = new Map(compiled.nodes.map(n => [n.coord, n]));
  });

  function disasm(coord: number): string[] {
    const node = nodeMap.get(coord);
    expect(node, `node ${coord} not found`).toBeDefined();
    return disassembleNode(node!);
  }

  function getNode(coord: number): CompiledNode {
    const node = nodeMap.get(coord);
    expect(node, `node ${coord} not found`).toBeDefined();
    return node!;
  }

  // --- Wire nodes (AN007 §2.4.2, §2.3.3.1) ---

  it('node 112: TX wire — @ !b wire ;', () => {
    // AN007: wire 00 @ !b wire ; 01
    // Preamble: setb(0x15D) + lit(0x1D5) + a! → 5 words
    // Then: @ !b jump(wire) at addr 5
    expect(disasm(112)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x001d5 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x00175 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] @|!b|jump(5)',
    ]);
  });

  it('node 116: RX wire — begin begin @ !b unext unext wir ;', () => {
    // AN007: wir 00 begin begin @ !b unext unext wir ; 02
    // Preamble: setb(0x15D) + lit(0x145) b! + lit(0x115) a! → 5 words
    expect(disasm(116)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x00145 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x00115 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] @|!b|unext|unext',
      '[ 6] jump(5)',
    ]);
  });

  it('node 216: RX wire — same pattern as 116', () => {
    expect(disasm(216)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x001d5 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x00145 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] @|!b|unext|unext',
      '[ 6] jump(5)',
    ]);
  });

  it('node 316: TX wire — same pattern as 116', () => {
    expect(disasm(316)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x001d5 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x00175 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] @|!b|unext|unext',
      '[ 6] jump(5)',
    ]);
  });

  // --- Simple nodes ---

  it('node 217: RX active pull-down (yanker)', () => {
    // AN007 §2.3.3.1: init + yanker loop
    // Preamble: setb(0x15D) + lit(0x1D5) a!
    // Then: literals 25555, 5555, 15555, 8× over, !b, yanker loop
    expect(disasm(217)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x0015d (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x001d5 (data)',
      '[ 4] a!|@p|.|.',
      '[ 5] 0x25555 (data)',
      '[ 6] @p|.|.|.',
      '[ 7] 0x05555 (data)',
      '[ 8] @p|.|.|.',
      '[ 9] 0x15555 (data)',
      '[10] over|over|over|.',
      '[11] over|over|over|.',
      '[12] over|over|!b|.',
      '[13] @|@p|.|.',
      '[14] 0x00009 (data)',
      '[15] push|.|.|.',
      '[16] drop|@b|.|;',
      '[17] -if(0)',
      '[18] .|.|next(0)',
      '[19] drop|!b|!b|.',
      '[20] jump(13)',
      '[21] drop|jump(13)',
    ]);
  });

  it('node 117: RX pin Manchester decode', () => {
    // AN007 §2.3.1: edge/run routines
    // Preamble: setb(0x15D) + lit(0x175) a!
    expect(disasm(117)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x0015d (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x00175 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] push|@b|jump(1)',
      '[ 6] -if(0)',
      '[ 7] pop|!b|!|.',
      '[ 8] drop|.|.|;',
      '[ 9] over|!b|!|.',
      '[10] pop|drop|drop|;',
      '[11] call(5)',
      '[12] a!|@b|!|.',
      '[13] @p|.|.|.',
      '[14] 0x00004 (data)',
      '[15] push|a!|.|.',
      '[16] unext|jump(11)',
    ]);
  });

  it('node 017: RX de-jitter buffer', () => {
    // AN007 §2.3.2: wire with extended arith, circular shift
    // Preamble: setb(0x15D) + lit(0x1D5) b! + lit(0x115) a!
    // Then: lit(0x20000), tight loop: @ over and dup .+ dup .+ !b jump
    expect(disasm(17)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x001d5 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x00115 (data)',
      '[ 4] a!|@p|.|.',
      '[ 5] 0x20000 (data)',
      '[ 6] @|over|and|dup',
      '[ 7] .|+|dup|.',
      '[ 8] +|!b|jump(6)',
    ]);
  });

  it('node 417: TX oscillator', () => {
    // AN007 §2.4.9.1: 10 MHz osc → 20 MHz edges to node 317
    // No std.setb — uses inline register setup
    // init: up a! @ drop . io b! left a! ...
    expect(disasm(417)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x00145 (data)',
      '[ 2] a!|@|drop|.',
      '[ 3] @p|.|.|.',
      '[ 4] 0x0015d (data)',
      '[ 5] b!|@p|.|.',
      '[ 6] 0x00175 (data)',
      '[ 7] a!|@p|.|.',
      '[ 8] 0x00175 (data)',
      '[ 9] @p|.|.|.',
      '[10] 0x15555 (data)',
      '[11] @p|.|.|.',
      '[12] 0x00145 (data)',
      '[13] @p|.|.|.',
      '[14] 0x00000 (data)',
      '[15] @p|.|.|.',
      '[16] 0x10000 (data)',
      '[17] @p|.|.|.',
      '[18] 0x00175 (data)',
      '[19] @p|.|.|.',
      '[20] 0x15555 (data)',
      '[21] @p|.|.|.',
      '[22] 0x00145 (data)',
      '[23] @p|.|.|.',
      '[24] 0x00800 (data)',
      '[25] @p|.|.|.',
      '[26] 0x10800 (data)',
      '[27] dup|dup|drop|.',
      '[28] drop|.|.|.',
      '[29] .|@|drop|.',
      '[30] !b|a!|!|.',
      '[31] a!|jump(29)',
    ]);
  });

  // --- TX path nodes ---

  it('node 314: TX framing', () => {
    // AN007 §2.4.6: preamble + framing
    expect(disasm(314)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x001d5 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x00115 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] @p|!b|;',
      '[ 6] 0x05b52 (data)',
      '[ 7] @p|!b|;',
      '[ 8] 0x05b52 (data)',
      '[ 9] @p|!b|.|;',
      '[10] 0x0370f (data)',
      '[11] -if(0)',
      '[12] call(5)',
      '[13] call(6)',
      '[14] jump(10)',
      '[15] call(5)',
      '[16] @p|.|.|.',
      '[17] 0x0001e (data)',
      '[18] push|.|.|.',
      '[19] call(7)',
      '[20] call(8)',
      '[21] next(19)',
      '[22] call(7)',
      '[23] call(7)',
      '[24] @|jump(28)',
      '[25] -if(0)',
      '[26] call(9)',
      '[27] jump(10)',
      '[28] if(31)',
      '[29] call(7)',
      '[30] jump(24)',
      '[31] call(8)',
      '[32] jump(24)',
    ]);
  });

  it('node 315: TX mux', () => {
    // AN007 §2.4.7: packet/link pulse multiplexor
    expect(disasm(315)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x00175 (data)',
      '[ 2] b!|.|.|.',
      '[ 3] @p|drop|!p|;',
      '[ 4] 0x049b2 (data)',
      '[ 5] and|@b|and|@p',
      '[ 6] 0x05b52 (data)',
      '[ 7] @p|!b|;',
      '[ 8] 0x049b2 (data)',
      '[ 9] over|and|@b|+',
      '[10] push|.|.|.',
      '[11] call(7)',
      '[12] next(11)',
      '[13] ;',
      '[14] a|dup|a!|.',
      '[15] call(3)',
      '[16] push|ex',
      '[17] push|call(3)',
      '[18] ;',
      '[19] @p|.|.|.',
      '[20] 0x001d5 (data)',
      '[21] a!|@|drop|.',
      '[22] @p|.|.|.',
      '[23] 0x0015d (data)',
      '[24] a!|@|dup|.',
      '[25] push|@p|.|.',
      '[26] 0x02000 (data)',
      '[27] and|jump(32)',
      '[28] if(0)',
      '[29] @p|.|.|.',
      '[30] 0x00115 (data)',
      '[31] call(14)',
      '[32] pop|2*|2*|.',
      '[33] -if(0)',
      '[34] @p|.|.|.',
      '[35] 0x001d5 (data)',
      '[36] call(14)',
      '[37] jump(19)',
      '[38] @p|!b|;',
      '[39] 0x05b52 (data)',
      '[40] @p|!b|;',
      '[41] 0x10029 (data)',
    ]);
  });

  it('node 317: TX pin / Manchester encoder', () => {
    // AN007 §2.4.9: 0bit, 1bit, init, sil, slp, goose, idle, flp
    expect(disasm(317)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x0015d (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x00145 (data)',
      '[ 4] a!|@p|.|.',
      '[ 5] 0x20000 (data)',
      '[ 6] @p|.|.|.',
      '[ 7] 0x30000 (data)',
      '[ 8] over|over|over|.',
      '[ 9] over|over|over|.',
      '[10] over|over|.|.',
      '[11] @|drop|!b|.',
      '[12] @|drop|!b|;',
      '[13] drop|call(11)',
      '[14] drop|;',
      '[15] @p|.|.|.',
      '[16] 0x00000 (data)',
      '[17] dup|!|.|.',
      '[18] push|@p|.|.',
      '[19] 0x00000 (data)',
      '[20] .|@|drop|.',
      '[21] !b|.|.|.',
      '[22] @|drop|unext|.',
      '[23] dup|@p|.|.',
      '[24] 0x0000f (data)',
      '[25] push|.|.|.',
      '[26] @p|.|.|.',
      '[27] 0x04e1f (data)',
      '[28] push|.|.|.',
      '[29] @|drop|drop|.',
      '[30] @b|2*|2*|.',
      '[31] -if(40)',
      '[32] drop|next(29)',
      '[33] next(26)',
      '[34] drop|.|.|.',
      '[35] @|drop|dup|.',
      '[36] !b|@|drop|.',
      '[37] @p|.|.|.',
      '[38] 0x00051 (data)',
      '[39] jump(18)',
      '[40] drop|@|drop|dup',
      '[41] !b|.|.|.',
      '[42] @b|jump(51)',
      '[43] -if(0)',
      '[44] drop|@p|.|.',
      '[45] 0x00004 (data)',
      '[46] push|.|.|.',
      '[47] @|drop|unext|.',
      '[48] @p|.|.|.',
      '[49] 0x00053 (data)',
      '[50] jump(18)',
      '[51] jump(40)',
      '[52] @p|.|.|.',
      '[53] 0x004e1 (data)',
      '[54] jump(18)',
    ]);
  });

  it('node 113: TX unpack', () => {
    // AN007 §2.4.3: big-endian octet pairs → LSB-first bitstream
    expect(disasm(113)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x00175 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x001d5 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] 2/|2/|2/|.',
      '[ 6] 2/|2/|2/|.',
      '[ 7] 2/|2/|;',
      '[ 8] @p|.|.|.',
      '[ 9] 0x00007 (data)',
      '[10] push|.|.|.',
      '[11] over|over|and|.',
      '[12] !b|2/|next(3)',
      '[13] drop|;',
      '[14] @p|.|.|.',
      '[15] 0x20000 (data)',
      '[16] !b|;',
      '[17] @|dup|!b|.',
      '[18] -|jump(19)',
      '[19] -if(17)',
      '[20] -|push|.|.',
      '[21] @p|.|.|.',
      '[22] 0x00001 (data)',
      '[23] if(24)',
      '[24] @|over|over|.',
      '[25] call(5)',
      '[26] drop|jump(29)',
      '[27] if(0)',
      '[28] call(14)',
      '[29] call(8)',
      '[30] drop|next(24)',
      '[31] call(14)',
      '[32] jump(17)',
    ]);
  });

  it('node 114: TX CRC', () => {
    // AN007 §2.4.4: CRC-32, polynomial 0x11DB7
    expect(disasm(114)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x00145 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x00175 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] push|dup|.|+',
      '[ 6] pop|or|push|dup',
      '[ 7] .|+|over|.',
      '[ 8] over|and|.|.',
      '[ 9] if(0)',
      '[10] drop|pop|;',
      '[11] or|@p|.|.',
      '[12] 0x00130 (data)',
      '[13] or|pop|.|.',
      '[14] @p|.|.|.',
      '[15] 0x11db7 (data)',
      '[16] or|;',
      '[17] @|dup|!b|.',
      '[18] -|jump(19)',
      '[19] -if(17)',
      '[20] @p|.|.|.',
      '[21] 0x04000 (data)',
      '[22] dup|dup|or|dup',
      '[23] @p|.|.|.',
      '[24] 0x0001f (data)',
      '[25] push|.|.|.',
      '[26] @|dup|!b|.',
      '[27] @p|.|.|.',
      '[28] 0x00001 (data)',
      '[29] or|call(5)',
      '[30] next(26)',
      '[31] dup|!b|call(5)',
      '[32] over|.|.|.',
      '[33] @|jump(34)',
      '[34] -if(31)',
      '[35] !b|@p|.|.',
      '[36] 0x0001f (data)',
      '[37] push|.|.|.',
      '[38] @p|.|.|.',
      '[39] 0x00000 (data)',
      '[40] call(5)',
      '[41] next(38)',
      '[42] @p|.|.|.',
      '[43] 0x00003 (data)',
      '[44] push|.|.|.',
      '[45] dup|.|+|.',
      '[46] push|dup|.|+',
      '[47] pop|next(45)',
      '[48] @p|.|.|.',
      '[49] 0x0001f (data)',
      '[50] push|.|.|.',
      '[51] dup|.|+|.',
      '[52] push|dup|.|+',
      '[53] pop|dup|dup|.',
      '[54] or|dup|.|+',
      '[55] @p|.|.|.',
      '[56] 0x00001 (data)',
      '[57] or|!b|next(3)',
      '[58] jump(17)',
    ]);
  });

  it('node 214: TX delay FIFO', () => {
    // AN007 §2.4.5: 32-word circular buffer
    expect(disasm(214)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x00115 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x00145 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] @|dup|!b|.',
      '[ 6] -|jump(7)',
      '[ 7] -if(5)',
      '[ 8] dup|or|.|.',
      '[ 9] @p|.|.|.',
      '[10] 0x0001f (data)',
      '[11] push|.|.|.',
      '[12] @|jump(12)',
      '[13] @|jump(24)',
      '[14] -if(0)',
      '[15] push|@p|.|.',
      '[16] 0x0001f (data)',
      '[17] push|.|.|.',
      '[18] dup|!b|next(2)',
      '[19] @p|.|.|.',
      '[20] 0x0001f (data)',
      '[21] push|.|.|.',
      '[22] @|!b|unext|.',
      '[23] pop|!b|jump(5)',
      '[24] !b|jump(13)',
    ]);
  });

  // --- RX path nodes ---

  it('node 014: RX framing', () => {
    // AN007 §2.3.5: strips preamble, appends status
    expect(disasm(14)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x00175 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x001d5 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] @p|.|.|.',
      '[ 6] 0x28040 (data)',
      '[ 7] @p|.|.|.',
      '[ 8] 0x28000 (data)',
      '[ 9] !b|@p|.|.',
      '[10] 0x00000 (data)',
      '[11] !b|.|.|.',
      '[12] @|jump(16)',
      '[13] -if(0)',
      '[14] !b|@|!b|.',
      '[15] jump(12)',
      '[16] !b|@p|.|.',
      '[17] 0x00007 (data)',
      '[18] push|.|.|.',
      '[19] @|jump(22)',
      '[20] -if(0)',
      '[21] jump(5)',
      '[22] next(19)',
      '[23] @p|.|.|.',
      '[24] 0x00037 (data)',
      '[25] push|.|.|.',
      '[26] @|jump(29)',
      '[27] -if(0)',
      '[28] jump(5)',
      '[29] over|over|and|.',
      '[30] @p|.|.|.',
      '[31] 0x3ffff (data)',
      '[32] if(43)',
      '[33] dup|or|.|.',
      '[34] @|jump(40)',
      '[35] -if(0)',
      '[36] @p|.|.|.',
      '[37] 0x28000 (data)',
      '[38] !b|drop|!b|.',
      '[39] jump(12)',
      '[40] !b|@p|.|.',
      '[41] 0x00001 (data)',
      '[42] .|+|jump(2)',
      '[43] drop|over|over|.',
      '[44] or|.|.|.',
      '[45] drop|next(26)',
      '[46] jump(5)',
    ]);
  });

  it('node 013: RX CRC', () => {
    // AN007 §2.3.6: CRC-32 check
    expect(disasm(13)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x001d5 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x00175 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] push|dup|.|+',
      '[ 6] pop|or|push|dup',
      '[ 7] .|+|over|.',
      '[ 8] over|and|.|.',
      '[ 9] if(0)',
      '[10] drop|pop|;',
      '[11] or|@p|.|.',
      '[12] 0x00130 (data)',
      '[13] or|pop|.|.',
      '[14] @p|.|.|.',
      '[15] 0x11db7 (data)',
      '[16] or|;',
      '[17] push|push|.|.',
      '[18] @p|.|.|.',
      '[19] 0x3c000 (data)',
      '[20] or|pop|and|.',
      '[21] -|jump(25)',
      '[22] if(0)',
      '[23] @p|.|.|.',
      '[24] 0x00040 (data)',
      '[25] pop|or|!b|.',
      '[26] @|!b|;',
      '[27] @|jump(31)',
      '[28] -if(0)',
      '[29] !b|@|!b|.',
      '[30] jump(27)',
      '[31] !b|@p|.|.',
      '[32] 0x04000 (data)',
      '[33] dup|dup|or|dup',
      '[34] @p|.|.|.',
      '[35] 0x0001f (data)',
      '[36] push|.|.|.',
      '[37] @|jump(40)',
      '[38] -if(0)',
      '[39] call(17)',
      '[40] dup|!b|.|.',
      '[41] @p|.|.|.',
      '[42] 0x00001 (data)',
      '[43] or|call(5)',
      '[44] next(37)',
      '[45] dup|!b|call(5)',
      '[46] over|.|.|.',
      '[47] @|jump(48)',
      '[48] -if(45)',
      '[49] call(17)',
      '[50] ;',
      '[51] jump(51)',
    ]);
  });

  it('node 012: RX pack', () => {
    // AN007 §2.3.7: bitstream → 16-bit octet pairs
    expect(disasm(12)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x00175 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x001d5 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] @|jump(9)',
      '[ 6] -if(0)',
      '[ 7] !b|@|!b|.',
      '[ 8] jump(5)',
      '[ 9] !b|@p|.|.',
      '[10] 0x10000 (data)',
      '[11] dup|.|.|.',
      '[12] @|jump(24)',
      '[13] -if(0)',
      '[14] push|.|.|.',
      '[15] drop|2/|.|.',
      '[16] over|.|.|.',
      '[17] dup|@p|.|.',
      '[18] 0x00001 (data)',
      '[19] and|jump(20)',
      '[20] -if(15)',
      '[21] drop|2/|!b|.',
      '[22] pop|!b|@|.',
      '[23] !b|jump(5)',
      '[24] push|dup|.|.',
      '[25] @p|.|.|.',
      '[26] 0x00001 (data)',
      '[27] and|jump(31)',
      '[28] if(0)',
      '[29] drop|2/|!b|dup',
      '[30] dup|.|.|.',
      '[31] drop|pop|.|dup',
      '[32] if(0)',
      '[33] drop|2/|over|.',
      '[34] or|jump(12)',
      '[35] drop|2/|jump(4)',
    ]);
  });

  it('node 011: RX byteswap', () => {
    // AN007 §2.3.8: endian conversion, 1518-octet max
    expect(disasm(11)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x001d5 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x00175 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] @|jump(9)',
      '[ 6] -if(0)',
      '[ 7] !b|@|!b|.',
      '[ 8] jump(5)',
      '[ 9] !b|@p|.|.',
      '[10] 0x3ffff (data)',
      '[11] dup|dup|or|.',
      '[12] @p|.|.|.',
      '[13] 0x002f7 (data)',
      '[14] push|.|.|.',
      '[15] @|jump(40)',
      '[16] -if(0)',
      '[17] push|@|dup|.',
      '[18] push|2/|2/|.',
      '[19] 2/|pop|.|.',
      '[20] @p|.|.|.',
      '[21] 0x00007 (data)',
      '[22] and|pop|or|.',
      '[23] over|@p|.|.',
      '[24] 0x3ffc0 (data)',
      '[25] .|+|.|!p',
      '[26] -if(0)',
      '[27] drop|@p|.|.',
      '[28] 0x00020 (data)',
      '[29] or|dup|.|.',
      '[30] drop|over|.|.',
      '[31] @p|.|.|.',
      '[32] 0x3fa11 (data)',
      '[33] .|+|-|.',
      '[34] -if(38)',
      '[35] drop|@p|.|.',
      '[36] 0x00010 (data)',
      '[37] or|dup|.|.',
      '[38] drop|!b|!b|.',
      '[39] jump(5)',
      '[40] a|push|dup|.',
      '[41] 2*|2*|a!|.',
      '[42] @p|.|.|.',
      '[43] 0x00009 (data)',
      '[44] push|+*|unext|.',
      '[45] drop|over|a|.',
      '[46] and|!b|pop|.',
      '[47] a!|next(15)',
      '[48] @|jump(49)',
      '[49] -if(48)',
      '[50] jump(17)',
    ]);
  });

  it('node 010: RX control', () => {
    // AN007 §2.3.9: DMA, stores packets, descriptor queue
    expect(disasm(10)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x00115 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x001d5 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] dup|dup|or|.',
      '[ 6] @p|!b|!b|.',
      '[ 7] 0x09b52 (data)',
      '[ 8] dup|dup|or|.',
      '[ 9] @p|!b|!b|.',
      '[10] 0x09f52 (data)',
      '[11] @p|!b|@b|;',
      '[12] 0x04235 (data)',
      '[13] @p|.|.|.',
      '[14] 0x00000 (data)',
      '[15] @|jump(18)',
      '[16] if(0)',
      '[17] ;',
      '[18] call(11)',
      '[19] -if(23)',
      '[20] @|jump(21)',
      '[21] -if(20)',
      '[22] @|jump(15)',
      '[23] jump(15)',
    ]);
  });

  // --- Complex nodes ---

  it('node 016: RX timing (boot descriptors)', () => {
    // AN007 §2.3.3: timing discrimination
    // Uses f18a.reg.* — no preamble, registers set via boot descriptors
    const node = getNode(16);
    expect(node.a).toBe(0x1D5);
    expect(node.b).toBe(0x15D);
    expect(node.p).toBe(0x3C);

    expect(disasm(16)).toEqual([
      '[ 0] a|@p|.|.',
      '[ 1] 0x00115 (data)',
      '[ 2] a!|dup|!|.',
      '[ 3] a!|;',
      '[ 4] dup|push|.|.',
      '[ 5] @p|.|.|.',
      '[ 6] 0x00030 (data)',
      '[ 7] push|.|.|.',
      '[ 8] @b|2*|2*|.',
      '[ 9] -if(0)',
      '[10] drop|@|.|@p',
      '[11] 0x18000 (data)',
      '[12] drop|pop|drop|.',
      '[13] pop|-|.|+',
      '[14] ;',
      '[15] drop|next(8)',
      '[16] next(5)',
      '[17] dup|or|;',
      '[18] a|@p|.|.',
      '[19] 0x00175 (data)',
      '[20] a!|over|!|.',
      '[21] a!|drop|;',
      '[22] dup|or|call(2)',
      '[23] @p|.|.|.',
      '[24] 0x00004 (data)',
      '[25] push|.|.|.',
      '[26] @b|2*|2*|.',
      '[27] -if(0)',
      '[28] @|call(18)',
      '[29] ;',
      '[30] next(26)',
      '[31] -|call(0)',
      '[32] call(18)',
      '[33] @p|.|.|.',
      '[34] 0x186a0 (data)',
      '[35] call(52)',
      '[36] if(52)',
      '[37] dup|or|call(2)',
      '[38] call(18)',
      '[39] @p|.|.|.',
      '[40] 0x00096 (data)',
      '[41] call(52)',
      '[42] if(51)',
      '[43] @p|.|.|.',
      '[44] 0x3ff9c (data)',
      '[45] .|+|.|.',
      '[46] -if(38)',
      '[47] @p|.|.|.',
      '[48] 0x00064 (data)',
      '[49] call(52)',
      '[50] drop|jump(38)',
      '[51] jump(32)',
      '[52] call(4)',
      '[53] if(57)',
      '[54] dup|or|call(4)',
      '[55] if(57)',
      '[56] jump(22)',
      '[57] call(0)',
      '[58] ;',
      '[59] call(0)',
      '[60] jump(32)',
    ]);
  });

  it('node 015: RX parsing', () => {
    // AN007 §2.3.4: FLP/SLP decode, link state machine
    expect(disasm(15)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x00175 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x001d5 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] @p|drop|!p|;',
      '[ 6] 0x049b2 (data)',
      '[ 7] @b|and|@b|+',
      '[ 8] @p|drop|!p|;',
      '[ 9] 0x049b2 (data)',
      '[10] and|@b|and|@p',
      '[11] 0x23db2 (data)',
      '[12] @b|+|@p|;',
      '[13] 0x2af2a (data)',
      '[14] a!|;',
      '[15] a|@p|.|.',
      '[16] 0x0015d (data)',
      '[17] a!|@|2*|.',
      '[18] -if(0)',
      '[19] drop|a!|drop|;',
      '[20] drop|a!|.|.',
      '[21] @p|.|.|.',
      '[22] 0x3ffff (data)',
      '[23] !|!|;',
      '[24] dup|or|.|.',
      '[25] !|@b|.|unext',
      '[26] -if(0)',
      '[27] !|;',
      '[28] jump(25)',
    ]);
  });

  it('node 111: TX control', () => {
    // AN007 §2.4.1: DMA, reads t.xn, retrieves packet data
    expect(disasm(111)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x001d5 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x00175 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] dup|dup|or|.',
      '[ 6] @p|!b|!b|.',
      '[ 7] 0x09b52 (data)',
      '[ 8] dup|dup|or|.',
      '[ 9] @p|!b|!b|.',
      '[10] 0x09f52 (data)',
      '[11] @p|drop|!p|;',
      '[12] 0x049b2 (data)',
      '[13] 2/|ex',
      '[14] @p|.|.|.',
      '[15] 0x00001 (data)',
      '[16] .|+|;',
      '[17] @p|.|.|.',
      '[18] 0x00000 (data)',
      '[19] @b|drop|jump(3)',
    ]);
  });

  it('node 115: link negotiation (buffer)', () => {
    // AN007 §2.4.7.1: passes link states from 015 to 215
    expect(disasm(115)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x0015d (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x00115 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] @p|drop|!p|;',
      '[ 6] 0x049b2 (data)',
      '[ 7] and|@b|and|@p',
      '[ 8] 0x23db2 (data)',
      '[ 9] @b|+|jump(5)',
      '[10] a!|.|.|.',
      '[11] !|a!|;',
      '[12] @|call(5)',
      '[13] @b|@p|.|.',
      '[14] 0x00400 (data)',
      '[15] or|dup|.|.',
      '[16] @p|.|.|.',
      '[17] 0x00400 (data)',
      '[18] and|jump(22)',
      '[19] if(0)',
      '[20] call(8)',
      '[21] jump(12)',
      '[22] drop|@p|.|.',
      '[23] 0x02000 (data)',
      '[24] and|jump(25)',
      '[25] -if(13)',
      '[26] jump(12)',
    ]);
  });

  it('node 215: link negotiation (autoneg)', () => {
    // AN007 §2.4.7.1: 802.3 10FD autoneg code words
    expect(disasm(215)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x00115 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x00145 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] @p|drop|!p|;',
      '[ 6] 0x049b2 (data)',
      '[ 7] and|@b|and|@p',
      '[ 8] 0x05b52 (data)',
      '[ 9] @p|!b|;',
      '[10] 0x05b25 (data)',
      '[11] @|dup|call(5)',
      '[12] dup|@p|.|.',
      '[13] 0x00041 (data)',
      '[14] @p|.|.|.',
      '[15] 0x04041 (data)',
      '[16] and|@p|.|.',
      '[17] 0x00041 (data)',
      '[18] @p|.|.|.',
      '[19] 0x04041 (data)',
      '[20] or|jump(21)',
      '[21] -if(11)',
      '[22] call(9)',
      '[23] @p|.|.|.',
      '[24] 0x00004 (data)',
      '[25] push|.|.|.',
      '[26] @p|.|.|.',
      '[27] 0x00041 (data)',
      '[28] call(10)',
      '[29] next(26)',
      '[30] @p|.|.|.',
      '[31] 0x00007 (data)',
      '[32] push|.|.|.',
      '[33] @p|.|.|.',
      '[34] 0x04041 (data)',
      '[35] call(10)',
      '[36] next(33)',
      '[37] call(8)',
      '[38] @p|.|.|.',
      '[39] 0x20000 (data)',
      '[40] push|.|.|.',
      '[41] @p|.|.|.',
      '[42] 0x0a2c0 (data)',
      '[43] push|.|.|.',
      '[44] unext|next(41)',
      '[45] jump(11)',
    ]);
  });

  // --- DMA nodes ---

  it('node 108: SRAM master', () => {
    // AN007 §2.5.1: shared memory read/write
    expect(disasm(108)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x00175 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x001d5 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] push|@|push|.',
      '[ 6] @|pop|pop|.',
      '[ 7] ex',
      '[ 8] push|@|pop|.',
      '[ 9] ex',
      '[10] @b|!|;',
      '[11] @p|.|.|.',
      '[12] 0x00001 (data)',
      '[13] .|+|;',
      '[14] jump(14)',
    ]);
  });

  it('node 109: DMA nexus slave', () => {
    // AN007 §2.5.2: intermediary between 110 and 108
    expect(disasm(109)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x001d5 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x00175 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] dup|dup|or|.',
      '[ 6] @p|!b|!b|.',
      '[ 7] 0x05bb2 (data)',
      '[ 8] !b|!b|;',
      '[ 9] dup|dup|or|.',
      '[10] @p|!b|!b|.',
      '[11] 0x05bb2 (data)',
      '[12] !b|@b|;',
      '[13] push|@|push|.',
      '[14] @|pop|pop|.',
      '[15] ex',
      '[16] push|@|pop|.',
      '[17] ex',
      '[18] @p|!b|.|.',
      '[19] 0x01a52 (data)',
      '[20] jump(20)',
    ]);
  });

  it('node 110: DMA nexus', () => {
    // AN007 §2.5.3: central polling dispatcher
    expect(disasm(110)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x00175 (data)',
      '[ 2] b!|@p|.|.',
      '[ 3] 0x00115 (data)',
      '[ 4] a!|.|.|.',
      '[ 5] dup|dup|or|.',
      '[ 6] @p|!b|!b|.',
      '[ 7] 0x05bb2 (data)',
      '[ 8] !b|!b|;',
      '[ 9] dup|dup|or|.',
      '[10] @p|!b|!b|.',
      '[11] 0x05bb2 (data)',
      '[12] !b|@b|;',
      '[13] @|push|@|.',
      '[14] push|@|pop|.',
      '[15] pop|ex',
      '[16] @|push|@|.',
      '[17] pop|ex',
      '[18] !|;',
      '[19] @p|.|.|.',
      '[20] 0x00000 (data)',
      '[21] @p|!b|.|.',
      '[22] 0x04235 (data)',
      '[23] @p|.|.|.',
      '[24] 0x3ffff (data)',
      '[25] a!|@|push|;',
      '[26] call(19)',
      '[27] @p|.|.|.',
      '[28] 0x0015d (data)',
      '[29] a!|@p|.|.',
      '[30] 0x0a800 (data)',
      '[31] dup|.|.|.',
      '[32] drop|jump(51)',
      '[33] if(0)',
      '[34] @|over|and|.',
      '[35] -if(32)',
      '[36] 2*|2*|.|.',
      '[37] -if(0)',
      '[38] @p|.|.|.',
      '[39] 0x001d5 (data)',
      '[40] call(25)',
      '[41] 2*|2*|.|.',
      '[42] -if(0)',
      '[43] @p|.|.|.',
      '[44] 0x00115 (data)',
      '[45] call(25)',
      '[46] jump(27)',
      '[47] 2*|2*|.|.',
      '[48] -if(32)',
      '[49] @b|call(22)',
      '[50] jump(27)',
      '[51] jump(27)',
    ]);
  });
});
