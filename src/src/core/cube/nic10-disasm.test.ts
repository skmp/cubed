/**
 * NIC10 per-node disassembly tests.
 * Each node's expected disassembly is traced from the AN007 reference source
 * (docs/txt/AN007-141105-10BASET.txt) and verified against our CUBE compiler output.
 *
 * Nodes use individual f18a.* ops which the CodeBuilder packs into 4-slot words.
 * Register setup (A, B, P) is done via node boot descriptors in the node directive,
 * producing zero preamble code in RAM.
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
    expect(getNode(112).a).toBe(0x175);
    expect(getNode(112).b).toBe(0x1D5);
    expect(disasm(112)).toEqual([
      '[ 0] @|!b|jump(0)',
    ]);
  });

  it('node 116: RX wire — begin begin @ !b unext unext wir ;', () => {
    expect(getNode(116).a).toBe(0x115);
    expect(getNode(116).b).toBe(0x145);
    expect(disasm(116)).toEqual([
      '[ 0] @|!b|unext|unext',
      '[ 1] jump(0)',
    ]);
  });

  it('node 216: RX wire — same pattern as 116', () => {
    expect(getNode(216).a).toBe(0x145);
    expect(getNode(216).b).toBe(0x1D5);
    expect(disasm(216)).toEqual([
      '[ 0] @|!b|unext|unext',
      '[ 1] jump(0)',
    ]);
  });

  it('node 316: TX wire — same pattern as 116', () => {
    expect(getNode(316).a).toBe(0x175);
    expect(getNode(316).b).toBe(0x1D5);
    expect(disasm(316)).toEqual([
      '[ 0] @|!b|unext|unext',
      '[ 1] jump(0)',
    ]);
  });

  // --- Simple nodes ---

  it('node 217: RX active pull-down (yanker)', () => {
    expect(getNode(217).a).toBe(0x1D5);
    expect(getNode(217).b).toBe(0x15D);
    expect(disasm(217)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x25555 (data)',
      '[ 2] @p|.|.|.',
      '[ 3] 0x05555 (data)',
      '[ 4] @p|.|.|.',
      '[ 5] 0x15555 (data)',
      '[ 6] over|over|over|.',
      '[ 7] over|over|over|.',
      '[ 8] over|over|!b|.',
      '[ 9] @|@p|.|.',
      '[10] 0x00009 (data)',
      '[11] push|.|.|.',
      '[12] drop|@b|.|+*',
      '[13] -if(0)',
      '[14] .|.|next(12)',
      '[15] drop|!b|!b|.',
      '[16] jump(9)',
      '[17] drop|jump(9)',
    ]);
  });

  it('node 117: RX pin Manchester decode', () => {
    expect(getNode(117).a).toBe(0x175);
    expect(getNode(117).b).toBe(0x15D);
    expect(disasm(117)).toEqual([
      '[ 0] push|@b|jump(4)',
      '[ 1] -if(0)',
      '[ 2] pop|!b|!|.',
      '[ 3] drop|.|.|;',
      '[ 4] over|!b|!|.',
      '[ 5] pop|drop|drop|;',
      '[ 6] call(0)',
      '[ 7] a!|@b|!|.',
      '[ 8] @p|.|.|.',
      '[ 9] 0x00004 (data)',
      '[10] push|a!|.|.',
      '[11] unext|jump(6)',
    ]);
  });

  it('node 017: RX de-jitter buffer', () => {
    expect(getNode(17).a).toBe(0x115);
    expect(getNode(17).b).toBe(0x1D5);
    expect(disasm(17)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x20000 (data)',
      '[ 2] @|over|and|dup',
      '[ 3] .|+|dup|.',
      '[ 4] +|!b|jump(2)',
    ]);
  });

  it('node 417: TX oscillator', () => {
    // Node 417 has no boot descriptors — uses inline register setup
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
    expect(getNode(314).a).toBe(0x115);
    expect(getNode(314).b).toBe(0x1D5);
    expect(disasm(314)).toEqual([
      '[ 0] @p|!b|;',
      '[ 1] 0x05b52 (data)',
      '[ 2] @p|!b|;',
      '[ 3] 0x05b52 (data)',
      '[ 4] @p|!b|.|;',
      '[ 5] 0x0370a (data)',
      '[ 6] -if(0)',
      '[ 7] call(0)',
      '[ 8] call(1)',
      '[ 9] jump(5)',
      '[10] call(0)',
      '[11] @p|.|.|.',
      '[12] 0x0001e (data)',
      '[13] push|.|.|.',
      '[14] call(2)',
      '[15] call(3)',
      '[16] next(14)',
      '[17] call(2)',
      '[18] call(2)',
      '[19] @|jump(23)',
      '[20] -if(0)',
      '[21] call(4)',
      '[22] jump(5)',
      '[23] if(26)',
      '[24] call(2)',
      '[25] jump(19)',
      '[26] call(3)',
      '[27] jump(19)',
    ]);
  });

  it('node 315: TX mux', () => {
    expect(getNode(315).b).toBe(0x175);
    expect(disasm(315)).toEqual([
      '[ 0] @p|drop|!p|;',
      '[ 1] 0x049b2 (data)',
      '[ 2] and|@b|and|@p',
      '[ 3] 0x05b52 (data)',
      '[ 4] @p|!b|;',
      '[ 5] 0x049b2 (data)',
      '[ 6] over|and|@b|+',
      '[ 7] push|.|.|.',
      '[ 8] call(4)',
      '[ 9] next(8)',
      '[10] ;',
      '[11] a|dup|a!|.',
      '[12] call(0)',
      '[13] push|ex',
      '[14] push|call(0)',
      '[15] ;',
      '[16] @p|.|.|.',
      '[17] 0x001d5 (data)',
      '[18] a!|@|drop|.',
      '[19] @p|.|.|.',
      '[20] 0x0015d (data)',
      '[21] a!|@|dup|.',
      '[22] push|@p|.|.',
      '[23] 0x02000 (data)',
      '[24] and|jump(29)',
      '[25] if(0)',
      '[26] @p|.|.|.',
      '[27] 0x00115 (data)',
      '[28] call(11)',
      '[29] pop|2*|2*|.',
      '[30] -if(0)',
      '[31] @p|.|.|.',
      '[32] 0x001d5 (data)',
      '[33] call(11)',
      '[34] jump(16)',
      '[35] @p|!b|;',
      '[36] 0x05b52 (data)',
      '[37] @p|!b|;',
      '[38] 0x10026 (data)',
    ]);
  });

  it('node 317: TX pin / Manchester encoder', () => {
    expect(getNode(317).a).toBe(0x145);
    expect(getNode(317).b).toBe(0x15D);
    expect(disasm(317)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x20000 (data)',
      '[ 2] @p|.|.|.',
      '[ 3] 0x30000 (data)',
      '[ 4] over|over|over|.',
      '[ 5] over|over|over|.',
      '[ 6] over|over|.|.',
      '[ 7] @|drop|!b|.',
      '[ 8] @|drop|!b|;',
      '[ 9] drop|call(7)',
      '[10] drop|;',
      '[11] @p|.|.|.',
      '[12] 0x00000 (data)',
      '[13] dup|!|.|.',
      '[14] push|@p|.|.',
      '[15] 0x00000 (data)',
      '[16] .|@|drop|.',
      '[17] !b|.|.|.',
      '[18] @|drop|unext|.',
      '[19] dup|@p|.|.',
      '[20] 0x0000f (data)',
      '[21] push|.|.|.',
      '[22] @p|.|.|.',
      '[23] 0x04e1f (data)',
      '[24] push|.|.|.',
      '[25] @|drop|drop|.',
      '[26] @b|2*|2*|.',
      '[27] -if(36)',
      '[28] drop|next(25)',
      '[29] next(22)',
      '[30] drop|.|.|.',
      '[31] @|drop|dup|.',
      '[32] !b|@|drop|.',
      '[33] @p|.|.|.',
      '[34] 0x00051 (data)',
      '[35] jump(14)',
      '[36] drop|@|drop|dup',
      '[37] !b|.|.|.',
      '[38] @b|jump(47)',
      '[39] -if(0)',
      '[40] drop|@p|.|.',
      '[41] 0x00004 (data)',
      '[42] push|.|.|.',
      '[43] @|drop|unext|.',
      '[44] @p|.|.|.',
      '[45] 0x00053 (data)',
      '[46] jump(14)',
      '[47] jump(36)',
      '[48] @p|.|.|.',
      '[49] 0x004e1 (data)',
      '[50] jump(14)',
    ]);
  });

  it('node 113: TX unpack', () => {
    expect(getNode(113).a).toBe(0x1D5);
    expect(getNode(113).b).toBe(0x175);
    expect(disasm(113)).toEqual([
      '[ 0] 2/|2/|2/|.',
      '[ 1] 2/|2/|2/|.',
      '[ 2] 2/|2/|;',
      '[ 3] @p|.|.|.',
      '[ 4] 0x00007 (data)',
      '[ 5] push|.|.|.',
      '[ 6] over|over|and|.',
      '[ 7] !b|2/|next(14)',
      '[ 8] drop|;',
      '[ 9] @p|.|.|.',
      '[10] 0x20000 (data)',
      '[11] !b|;',
      '[12] @|dup|!b|.',
      '[13] -|jump(14)',
      '[14] -if(12)',
      '[15] -|push|.|.',
      '[16] @p|.|.|.',
      '[17] 0x00001 (data)',
      '[18] if(19)',
      '[19] @|over|over|.',
      '[20] call(0)',
      '[21] drop|jump(24)',
      '[22] if(0)',
      '[23] call(9)',
      '[24] call(3)',
      '[25] drop|next(19)',
      '[26] call(9)',
      '[27] jump(12)',
    ]);
  });

  it('node 114: TX CRC', () => {
    expect(getNode(114).a).toBe(0x175);
    expect(getNode(114).b).toBe(0x145);
    expect(disasm(114)).toEqual([
      '[ 0] push|dup|.|+',
      '[ 1] pop|or|push|dup',
      '[ 2] .|+|over|.',
      '[ 3] over|and|.|.',
      '[ 4] if(0)',
      '[ 5] drop|pop|;',
      '[ 6] or|@p|.|.',
      '[ 7] 0x00130 (data)',
      '[ 8] or|pop|.|.',
      '[ 9] @p|.|.|.',
      '[10] 0x11db7 (data)',
      '[11] or|;',
      '[12] @|dup|!b|.',
      '[13] -|jump(14)',
      '[14] -if(12)',
      '[15] @p|.|.|.',
      '[16] 0x04000 (data)',
      '[17] dup|dup|or|dup',
      '[18] @p|.|.|.',
      '[19] 0x0001f (data)',
      '[20] push|.|.|.',
      '[21] @|dup|!b|.',
      '[22] @p|.|.|.',
      '[23] 0x00001 (data)',
      '[24] or|call(0)',
      '[25] next(21)',
      '[26] dup|!b|call(24)',
      '[27] over|.|.|.',
      '[28] @|jump(29)',
      '[29] -if(26)',
      '[30] !b|@p|.|.',
      '[31] 0x0001f (data)',
      '[32] push|.|.|.',
      '[33] @p|.|.|.',
      '[34] 0x00000 (data)',
      '[35] call(0)',
      '[36] next(33)',
      '[37] @p|.|.|.',
      '[38] 0x00003 (data)',
      '[39] push|.|.|.',
      '[40] dup|.|+|.',
      '[41] push|dup|.|+',
      '[42] pop|next(40)',
      '[43] @p|.|.|.',
      '[44] 0x0001f (data)',
      '[45] push|.|.|.',
      '[46] dup|.|+|.',
      '[47] push|dup|.|+',
      '[48] pop|dup|dup|.',
      '[49] or|dup|.|+',
      '[50] @p|.|.|.',
      '[51] 0x00001 (data)',
      '[52] or|!b|next(54)',
      '[53] jump(12)',
    ]);
  });

  it('node 214: TX delay FIFO', () => {
    expect(getNode(214).a).toBe(0x145);
    expect(getNode(214).b).toBe(0x115);
    expect(disasm(214)).toEqual([
      '[ 0] @|dup|!b|.',
      '[ 1] -|jump(2)',
      '[ 2] -if(0)',
      '[ 3] dup|or|.|.',
      '[ 4] @p|.|.|.',
      '[ 5] 0x0001f (data)',
      '[ 6] push|.|.|.',
      '[ 7] @|jump(7)',
      '[ 8] @|jump(19)',
      '[ 9] -if(0)',
      '[10] push|@p|.|.',
      '[11] 0x0001f (data)',
      '[12] push|.|.|.',
      '[13] dup|!b|next(13)',
      '[14] @p|.|.|.',
      '[15] 0x0001f (data)',
      '[16] push|.|.|.',
      '[17] @|!b|unext|.',
      '[18] pop|!b|jump(16)',
      '[19] !b|jump(8)',
    ]);
  });

  // --- RX path nodes ---

  it('node 014: RX framing', () => {
    expect(getNode(14).a).toBe(0x1D5);
    expect(getNode(14).b).toBe(0x175);
    expect(disasm(14)).toEqual([
      '[ 0] @p|.|.|.',
      '[ 1] 0x28040 (data)',
      '[ 2] @p|.|.|.',
      '[ 3] 0x28000 (data)',
      '[ 4] !b|@p|.|.',
      '[ 5] 0x00000 (data)',
      '[ 6] !b|.|.|.',
      '[ 7] @|jump(11)',
      '[ 8] -if(0)',
      '[ 9] !b|@|!b|.',
      '[10] jump(7)',
      '[11] !b|@p|.|.',
      '[12] 0x00007 (data)',
      '[13] push|.|.|.',
      '[14] @|jump(17)',
      '[15] -if(0)',
      '[16] jump(0)',
      '[17] next(14)',
      '[18] @p|.|.|.',
      '[19] 0x00037 (data)',
      '[20] push|.|.|.',
      '[21] @|jump(24)',
      '[22] -if(0)',
      '[23] jump(0)',
      '[24] over|over|and|.',
      '[25] @p|.|.|.',
      '[26] 0x3ffff (data)',
      '[27] if(38)',
      '[28] dup|or|.|.',
      '[29] @|jump(35)',
      '[30] -if(0)',
      '[31] @p|.|.|.',
      '[32] 0x28000 (data)',
      '[33] !b|drop|!b|.',
      '[34] jump(7)',
      '[35] !b|@p|.|.',
      '[36] 0x00001 (data)',
      '[37] .|+|jump(37)',
      '[38] drop|over|over|.',
      '[39] or|.|.|.',
      '[40] drop|next(21)',
      '[41] jump(0)',
    ]);
  });

  it('node 013: RX CRC', () => {
    expect(getNode(13).a).toBe(0x175);
    expect(getNode(13).b).toBe(0x1D5);
    expect(disasm(13)).toEqual([
      '[ 0] push|dup|.|+',
      '[ 1] pop|or|push|dup',
      '[ 2] .|+|over|.',
      '[ 3] over|and|.|.',
      '[ 4] if(0)',
      '[ 5] drop|pop|;',
      '[ 6] or|@p|.|.',
      '[ 7] 0x00130 (data)',
      '[ 8] or|pop|.|.',
      '[ 9] @p|.|.|.',
      '[10] 0x11db7 (data)',
      '[11] or|;',
      '[12] push|push|.|.',
      '[13] @p|.|.|.',
      '[14] 0x3c000 (data)',
      '[15] or|pop|and|.',
      '[16] -|jump(20)',
      '[17] if(0)',
      '[18] @p|.|.|.',
      '[19] 0x00040 (data)',
      '[20] pop|or|!b|.',
      '[21] @|!b|;',
      '[22] @|jump(26)',
      '[23] -if(0)',
      '[24] !b|@|!b|.',
      '[25] jump(22)',
      '[26] !b|@p|.|.',
      '[27] 0x04000 (data)',
      '[28] dup|dup|or|dup',
      '[29] @p|.|.|.',
      '[30] 0x0001f (data)',
      '[31] push|.|.|.',
      '[32] @|jump(35)',
      '[33] -if(0)',
      '[34] call(12)',
      '[35] dup|!b|.|.',
      '[36] @p|.|.|.',
      '[37] 0x00001 (data)',
      '[38] or|call(0)',
      '[39] next(32)',
      '[40] dup|!b|call(40)',
      '[41] over|.|.|.',
      '[42] @|jump(43)',
      '[43] -if(40)',
      '[44] call(12)',
      '[45] ;',
      '[46] jump(46)',
    ]);
  });

  it('node 012: RX pack', () => {
    expect(getNode(12).a).toBe(0x1D5);
    expect(getNode(12).b).toBe(0x175);
    expect(disasm(12)).toEqual([
      '[ 0] @|jump(4)',
      '[ 1] -if(0)',
      '[ 2] !b|@|!b|.',
      '[ 3] jump(0)',
      '[ 4] !b|@p|.|.',
      '[ 5] 0x10000 (data)',
      '[ 6] dup|.|.|.',
      '[ 7] @|jump(19)',
      '[ 8] -if(0)',
      '[ 9] push|.|.|.',
      '[10] drop|2/|.|.',
      '[11] over|.|.|.',
      '[12] dup|@p|.|.',
      '[13] 0x00001 (data)',
      '[14] and|jump(15)',
      '[15] -if(10)',
      '[16] drop|2/|!b|.',
      '[17] pop|!b|@|.',
      '[18] !b|jump(0)',
      '[19] push|dup|.|.',
      '[20] @p|.|.|.',
      '[21] 0x00001 (data)',
      '[22] and|jump(26)',
      '[23] if(0)',
      '[24] drop|2/|!b|dup',
      '[25] dup|.|.|.',
      '[26] drop|pop|.|!p',
      '[27] if(0)',
      '[28] drop|2/|over|.',
      '[29] or|jump(7)',
      '[30] drop|2/|jump(31)',
    ]);
  });

  it('node 011: RX byteswap', () => {
    expect(getNode(11).a).toBe(0x175);
    expect(getNode(11).b).toBe(0x1D5);
    expect(disasm(11)).toEqual([
      '[ 0] @|jump(4)',
      '[ 1] -if(0)',
      '[ 2] !b|@|!b|.',
      '[ 3] jump(0)',
      '[ 4] !b|@p|.|.',
      '[ 5] 0x3ffff (data)',
      '[ 6] dup|dup|or|.',
      '[ 7] @p|.|.|.',
      '[ 8] 0x002f7 (data)',
      '[ 9] push|.|.|.',
      '[10] @|jump(35)',
      '[11] -if(0)',
      '[12] push|@|dup|.',
      '[13] push|2/|2/|.',
      '[14] 2/|pop|.|.',
      '[15] @p|.|.|.',
      '[16] 0x00007 (data)',
      '[17] and|pop|or|.',
      '[18] over|@p|.|.',
      '[19] 0x3ffc0 (data)',
      '[20] .|+|.|+*',
      '[21] -if(0)',
      '[22] drop|@p|.|.',
      '[23] 0x00020 (data)',
      '[24] or|dup|.|.',
      '[25] drop|over|.|.',
      '[26] @p|.|.|.',
      '[27] 0x3fa11 (data)',
      '[28] .|+|-|.',
      '[29] -if(33)',
      '[30] drop|@p|.|.',
      '[31] 0x00010 (data)',
      '[32] or|dup|.|.',
      '[33] drop|!b|!b|.',
      '[34] jump(0)',
      '[35] a|push|dup|.',
      '[36] 2*|2*|a!|.',
      '[37] @p|.|.|.',
      '[38] 0x00009 (data)',
      '[39] push|+*|unext|.',
      '[40] drop|over|a|.',
      '[41] and|!b|pop|.',
      '[42] a!|next(10)',
      '[43] @|jump(44)',
      '[44] -if(43)',
      '[45] jump(12)',
    ]);
  });

  it('node 010: RX control', () => {
    expect(getNode(10).a).toBe(0x1D5);
    expect(getNode(10).b).toBe(0x115);
    expect(disasm(10)).toEqual([
      '[ 0] dup|dup|or|.',
      '[ 1] @p|!b|!b|.',
      '[ 2] 0x09b52 (data)',
      '[ 3] dup|dup|or|.',
      '[ 4] @p|!b|!b|.',
      '[ 5] 0x09f52 (data)',
      '[ 6] @p|!b|@b|;',
      '[ 7] 0x04235 (data)',
      '[ 8] @p|.|.|.',
      '[ 9] 0x00000 (data)',
      '[10] @|jump(13)',
      '[11] if(0)',
      '[12] ;',
      '[13] call(6)',
      '[14] -if(18)',
      '[15] @|jump(16)',
      '[16] -if(15)',
      '[17] @|jump(10)',
      '[18] jump(10)',
    ]);
  });

  // --- Complex nodes ---

  it('node 016: RX timing (boot descriptors)', () => {
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
      '[22] dup|or|call(18)',
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
      '[37] dup|or|call(34)',
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
      '[54] dup|or|call(52)',
      '[55] if(57)',
      '[56] jump(22)',
      '[57] call(0)',
      '[58] ;',
      '[59] call(0)',
      '[60] jump(32)',
    ]);
  });

  it('node 015: RX parsing', () => {
    expect(getNode(15).a).toBe(0x1D5);
    expect(getNode(15).b).toBe(0x175);
    expect(disasm(15)).toEqual([
      '[ 0] @p|drop|!p|;',
      '[ 1] 0x049b2 (data)',
      '[ 2] @b|and|@b|+',
      '[ 3] @p|drop|!p|;',
      '[ 4] 0x049b2 (data)',
      '[ 5] and|@b|and|@p',
      '[ 6] 0x23db2 (data)',
      '[ 7] @b|+|@p|;',
      '[ 8] 0x2af2a (data)',
      '[ 9] a!|;',
      '[10] a|@p|.|.',
      '[11] 0x0015d (data)',
      '[12] a!|@|2*|.',
      '[13] -if(0)',
      '[14] drop|a!|drop|;',
      '[15] drop|a!|.|.',
      '[16] @p|.|.|.',
      '[17] 0x3ffff (data)',
      '[18] !|!|;',
      '[19] dup|or|.|.',
      '[20] !|@b|.|@p',
      '[21] 0x1a000 (data)',
      '[22] !|;',
      '[23] jump(20)',
    ]);
  });

  it('node 111: TX control', () => {
    expect(getNode(111).a).toBe(0x175);
    expect(getNode(111).b).toBe(0x1D5);
    expect(disasm(111)).toEqual([
      '[ 0] dup|dup|or|.',
      '[ 1] @p|!b|!b|.',
      '[ 2] 0x09b52 (data)',
      '[ 3] dup|dup|or|.',
      '[ 4] @p|!b|!b|.',
      '[ 5] 0x09f52 (data)',
      '[ 6] @p|drop|!p|;',
      '[ 7] 0x049b2 (data)',
      '[ 8] 2/|ex',
      '[ 9] @p|.|.|.',
      '[10] 0x00001 (data)',
      '[11] .|+|;',
      '[12] @p|.|.|.',
      '[13] 0x00000 (data)',
      '[14] @b|drop|jump(14)',
    ]);
  });

  it('node 115: link negotiation (buffer)', () => {
    expect(getNode(115).a).toBe(0x115);
    expect(getNode(115).b).toBe(0x15D);
    expect(disasm(115)).toEqual([
      '[ 0] @p|drop|!p|;',
      '[ 1] 0x049b2 (data)',
      '[ 2] and|@b|and|@p',
      '[ 3] 0x23db2 (data)',
      '[ 4] @b|+|jump(5)',
      '[ 5] a!|.|.|.',
      '[ 6] !|a!|;',
      '[ 7] @|call(0)',
      '[ 8] @b|@p|.|.',
      '[ 9] 0x00400 (data)',
      '[10] or|dup|.|.',
      '[11] @p|.|.|.',
      '[12] 0x00400 (data)',
      '[13] and|jump(17)',
      '[14] if(0)',
      '[15] call(3)',
      '[16] jump(7)',
      '[17] drop|@p|.|.',
      '[18] 0x02000 (data)',
      '[19] and|jump(20)',
      '[20] -if(8)',
      '[21] jump(7)',
    ]);
  });

  it('node 215: link negotiation (autoneg)', () => {
    expect(getNode(215).a).toBe(0x145);
    expect(getNode(215).b).toBe(0x115);
    expect(disasm(215)).toEqual([
      '[ 0] @p|drop|!p|;',
      '[ 1] 0x049b2 (data)',
      '[ 2] and|@b|and|@p',
      '[ 3] 0x05b52 (data)',
      '[ 4] @p|!b|;',
      '[ 5] 0x05b25 (data)',
      '[ 6] @|dup|call(0)',
      '[ 7] dup|@p|.|.',
      '[ 8] 0x00041 (data)',
      '[ 9] @p|.|.|.',
      '[10] 0x04041 (data)',
      '[11] and|@p|.|.',
      '[12] 0x00041 (data)',
      '[13] @p|.|.|.',
      '[14] 0x04041 (data)',
      '[15] or|jump(16)',
      '[16] -if(6)',
      '[17] call(4)',
      '[18] @p|.|.|.',
      '[19] 0x00004 (data)',
      '[20] push|.|.|.',
      '[21] @p|.|.|.',
      '[22] 0x00041 (data)',
      '[23] call(5)',
      '[24] next(21)',
      '[25] @p|.|.|.',
      '[26] 0x00007 (data)',
      '[27] push|.|.|.',
      '[28] @p|.|.|.',
      '[29] 0x04041 (data)',
      '[30] call(5)',
      '[31] next(28)',
      '[32] call(3)',
      '[33] @p|.|.|.',
      '[34] 0x20000 (data)',
      '[35] push|.|.|.',
      '[36] @p|.|.|.',
      '[37] 0x0a2c0 (data)',
      '[38] push|.|.|.',
      '[39] unext|next(36)',
      '[40] jump(6)',
    ]);
  });

  // --- DMA nodes ---

  it('node 108: SRAM master', () => {
    expect(getNode(108).a).toBe(0x1D5);
    expect(getNode(108).b).toBe(0x175);
    expect(disasm(108)).toEqual([
      '[ 0] push|@|push|.',
      '[ 1] @|pop|pop|.',
      '[ 2] ex',
      '[ 3] push|@|pop|.',
      '[ 4] ex',
      '[ 5] @b|!|;',
      '[ 6] @p|.|.|.',
      '[ 7] 0x00001 (data)',
      '[ 8] .|+|;',
      '[ 9] jump(9)',
    ]);
  });

  it('node 109: DMA nexus slave', () => {
    expect(getNode(109).a).toBe(0x175);
    expect(getNode(109).b).toBe(0x1D5);
    expect(disasm(109)).toEqual([
      '[ 0] dup|dup|or|.',
      '[ 1] @p|!b|!b|.',
      '[ 2] 0x05bb2 (data)',
      '[ 3] !b|!b|;',
      '[ 4] dup|dup|or|.',
      '[ 5] @p|!b|!b|.',
      '[ 6] 0x05bb2 (data)',
      '[ 7] !b|@b|;',
      '[ 8] push|@|push|.',
      '[ 9] @|pop|pop|.',
      '[10] ex',
      '[11] push|@|pop|.',
      '[12] ex',
      '[13] @p|!b|.|.',
      '[14] 0x01a52 (data)',
      '[15] jump(15)',
    ]);
  });

  it('node 110: DMA nexus', () => {
    expect(getNode(110).a).toBe(0x115);
    expect(getNode(110).b).toBe(0x175);
    expect(disasm(110)).toEqual([
      '[ 0] dup|dup|or|.',
      '[ 1] @p|!b|!b|.',
      '[ 2] 0x05bb2 (data)',
      '[ 3] !b|!b|;',
      '[ 4] dup|dup|or|.',
      '[ 5] @p|!b|!b|.',
      '[ 6] 0x05bb2 (data)',
      '[ 7] !b|@b|;',
      '[ 8] @|push|@|.',
      '[ 9] push|@|pop|.',
      '[10] pop|ex',
      '[11] @|push|@|.',
      '[12] pop|ex',
      '[13] !|;',
      '[14] @p|.|.|.',
      '[15] 0x00000 (data)',
      '[16] @p|!b|.|.',
      '[17] 0x04235 (data)',
      '[18] @p|.|.|.',
      '[19] 0x3ffff (data)',
      '[20] a!|@|push|;',
      '[21] call(14)',
      '[22] @p|.|.|.',
      '[23] 0x0015d (data)',
      '[24] a!|@p|.|.',
      '[25] 0x0a800 (data)',
      '[26] dup|.|.|.',
      '[27] drop|jump(46)',
      '[28] if(0)',
      '[29] @|over|and|.',
      '[30] -if(27)',
      '[31] 2*|2*|.|.',
      '[32] -if(0)',
      '[33] @p|.|.|.',
      '[34] 0x001d5 (data)',
      '[35] call(20)',
      '[36] 2*|2*|.|.',
      '[37] -if(0)',
      '[38] @p|.|.|.',
      '[39] 0x00115 (data)',
      '[40] call(20)',
      '[41] jump(22)',
      '[42] 2*|2*|.|.',
      '[43] -if(27)',
      '[44] @b|call(17)',
      '[45] jump(22)',
      '[46] jump(22)',
    ]);
  });
});
