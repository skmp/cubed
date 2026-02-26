/**
 * Boot stream construction for the GA144 chip.
 *
 * Converts compiled node data (CompiledNode[]) into the boot stream wire
 * format expected by the GA144's async boot ROM at node 708.  This enables
 * flashing real hardware (e.g. EVB002) over a serial connection.
 *
 * Ported from reference/ga144/src/bootstream.rkt
 */

import { WORD_MASK } from './types';
import type { CompiledNode } from './types';
import {
  OPCODE_MAP, PORT,
  getDirectionAddress,
} from './constants';

// ---------------------------------------------------------------------------
// Compass directions (matching reference: N=0, E=1, S=2, W=3)
// ---------------------------------------------------------------------------

const N = 0, E = 1, S = 2, W = 3;
type CompassDir = 0 | 1 | 2 | 3;

const COORD_CHANGES: readonly number[] = [100, 1, -100, -1]; // N, E, S, W

const OPPOSITE: readonly CompassDir[] = [S, W, N, E]; // N↔S, E↔W

const DIR_NAMES: readonly ('north' | 'east' | 'south' | 'west')[] = [
  'north', 'east', 'south', 'west',
];

// ---------------------------------------------------------------------------
// Standalone word assembler (matching reference assemble.rkt)
// ---------------------------------------------------------------------------

// Per-slot XOR bits, matching reference xor-bits
const XOR_BITS = [0b01010, 0b10101, 0b01010, 0b101];
// Per-slot address masks, matching reference const-masks
const CONST_MASKS = [0x3FFFF, 0x3FF, 0xFF, 0x7];
// Per-slot bit shift amounts
const SHIFTS = [13, 8, 3, 0];

/**
 * Assemble a single instruction slot.
 * String values are looked up as opcodes and XOR-encoded per-slot.
 * Numeric values are treated as addresses/data, masked to slot width.
 * null/false values contribute 0.
 */
function assembleInst(
  value: string | number | null | false,
  slot: number,
): number {
  if (value === null || value === false) return 0;
  if (typeof value === 'string') {
    const opcodeIndex = OPCODE_MAP.get(value);
    if (opcodeIndex === undefined) {
      throw new Error(`Unknown opcode: ${value}`);
    }
    // Slot 3 divides by 4 (3-bit encoding), slots 0-2 use full index
    const adjusted = slot === 3 ? Math.floor(opcodeIndex / 4) : opcodeIndex;
    return (adjusted ^ XOR_BITS[slot]) << SHIFTS[slot];
  }
  // Numeric: address or data, masked to slot width
  return (value & CONST_MASKS[slot]);
}

/**
 * Assemble an 18-bit instruction word from up to 4 slots.
 *
 * Each slot can be:
 * - A string: opcode name (looked up in OPCODE_MAP, XOR-encoded per slot)
 * - A number: address or data value (masked to slot bit width)
 * - null / '.' placeholder: fills with 0 (default encoding)
 *
 * A single numeric argument is treated as a raw data word (masked to 18 bits).
 *
 * Matches the reference implementation's `(word ...)` / `assemble-word`.
 */
export function assembleWord(
  s0: string | number | null,
  s1: string | number | null = null,
  s2: string | number | null = null,
  s3: string | number | null = null,
): number {
  // Pure data word: single number
  if (typeof s0 === 'number' && s1 === null && s2 === null && s3 === null) {
    return s0 & WORD_MASK;
  }
  return (
    assembleInst(s0, 0) |
    assembleInst(s1, 1) |
    assembleInst(s2, 2) |
    assembleInst(s3, 3)
  );
}

// ---------------------------------------------------------------------------
// Direction helper
// ---------------------------------------------------------------------------

/** Get the port address for compass direction `dir` at node `coord`. */
function getDirection(coord: number, dir: CompassDir): number {
  return getDirectionAddress(coord, DIR_NAMES[dir]);
}

// ---------------------------------------------------------------------------
// Boot path
// ---------------------------------------------------------------------------

/**
 * Reference async boot path (path1 from DB004 page 31).
 * Starts at node 708 and visits all 144 nodes in a Hamiltonian zigzag:
 *   9E, 7S, 17W, (N+16E, N+16W)×3, N+7E
 */
export function getAsyncPath1(): CompassDir[] {
  const repeat = (dir: CompassDir, n: number): CompassDir[] =>
    Array.from({ length: n }, () => dir);
  const nenw = [N, ...repeat(E, 16), N, ...repeat(W, 16)];
  return [
    ...repeat(E, 9),
    ...repeat(S, 7),
    ...repeat(W, 17),
    ...nenw, ...nenw, ...nenw,
    N, ...repeat(E, 7),
  ] as CompassDir[];
  // Total: 9 + 7 + 17 + 3*(1+16+1+16) + 1 + 7 = 9+7+17+102+8 = 143
  // Plus the implicit start at 708 = 144 nodes total
}

/**
 * Trim a boot path to end just after the last target node.
 * This avoids generating relay code for trailing nodes that have no code.
 */
export function trimPath(
  fullPath: CompassDir[],
  bootNode: number,
  targetCoords: Set<number>,
): CompassDir[] {
  // If boot node itself is the only target, return empty path
  if (targetCoords.size === 0) return [];

  let coord = bootNode;
  let lastTargetIndex = -1;

  for (let i = 0; i < fullPath.length; i++) {
    coord += COORD_CHANGES[fullPath[i]];
    if (targetCoords.has(coord)) {
      lastTargetIndex = i;
    }
  }

  if (lastTargetIndex < 0) {
    // No target nodes found along path (they might all be at the boot node)
    return [];
  }

  return fullPath.slice(0, lastTargetIndex + 1);
}

// ---------------------------------------------------------------------------
// Per-node boot code generators
// ---------------------------------------------------------------------------

/**
 * Port pump: relay code to forward `len` words through a node.
 * The node reads from its incoming port (set by focusing call) and writes
 * to the outgoing port in direction `dir`.
 */
function portPump(coord: number, dir: CompassDir, len: number): number[] {
  return [
    assembleWord('@p', 'dup', 'a!', '.'),
    assembleWord('call', getDirection(coord, dir)),
    assembleWord('@p', 'push', '!', '.'),
    assembleWord(len - 1),
    assembleWord('@p', '!', 'unext', '.'),
  ];
}

/**
 * Load pump: code to load `len` words into a node's RAM.
 * If len is null/0, emit just `;` (return — wire-only node).
 */
function loadPump(len: number | null): number[] {
  if (len) {
    return [
      assembleWord('@p', 'a!', '@p', '.'),
      assembleWord(0),       // start address (filled by boot protocol)
      assembleWord(len - 1), // loop count
      assembleWord('push', '.', '.', '.'),
      assembleWord('@p', '!+', 'unext', '.'),
    ];
  }
  return [assembleWord(';')];
}

/**
 * Boot descriptors: initialize registers and jump to starting address.
 */
function bootDescriptors(node: CompiledNode): number[] {
  const words: number[] = [];

  // Set A register
  if (node.a !== undefined) {
    words.push(assembleWord('@p', 'a!', '.', '.'));
    words.push(assembleWord(node.a));
  }

  // Set IO register (requires setting B to IO port, writing, then restoring B)
  if (node.io !== undefined) {
    words.push(assembleWord('@p', '@p', 'b!', '.'));
    words.push(assembleWord(node.io));
    words.push(assembleWord(PORT.IO)); // 0x15D
    words.push(assembleWord('!b', '.', '.', '.'));
  }

  // Set B register
  if (node.b !== undefined) {
    words.push(assembleWord('@p', 'b!', '.', '.'));
    words.push(assembleWord(node.b));
  }

  // Load stack values
  if (node.stack && node.stack.length > 0) {
    words.push(assembleWord('@p', 'push'));
    words.push(assembleWord(node.stack.length - 1));
    words.push(assembleWord('@p', 'unext'));
    for (const v of node.stack) {
      words.push(assembleWord(v));
    }
  }

  // Jump to starting address
  words.push(assembleWord('jump', node.p ?? 0));

  return words;
}

/**
 * Extract the used portion of a node's memory (non-null words up to len).
 */
function getUsedPortion(node: CompiledNode): number[] | null {
  if (!node.mem || node.len === 0) return null;
  // Trim trailing null/false entries (matching reference get-used-portion)
  let end = node.len;
  while (end > 0 && (node.mem[end - 1] === null || node.mem[end - 1] === undefined)) {
    end--;
  }
  if (end === 0) return null;
  const result: number[] = [];
  for (let i = 0; i < end; i++) {
    result.push(node.mem[i] ?? 0);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Frame construction
// ---------------------------------------------------------------------------

/**
 * Build Frame 1 of the async boot stream.
 * Loads code for all nodes except the boot node.
 *
 * Processes nodes in reverse path order: the last node in the chain is
 * assembled first, and each earlier node's code includes a port-pump to
 * relay all subsequent code through it.
 */
function makeAsyncFrame1(
  nodeMap: Map<number, CompiledNode>,
  bootNode: number,
  path: CompassDir[],
): { frame: number[]; visitedCoords: number[]; wireNodes: number[] } {
  if (path.length === 0) {
    return { frame: [], visitedCoords: [], wireNodes: [] };
  }

  const firstDir = path[0];

  // Walk the path to build ordered node list
  // (path[0] steps from bootNode to first node, then path[1..] steps onward)
  const orderedCoords: number[] = [];
  let coord = bootNode + COORD_CHANGES[firstDir];

  for (let i = 1; i < path.length; i++) {
    orderedCoords.push(coord);
    coord += COORD_CHANGES[path[i]];
  }
  orderedCoords.push(coord); // last node in path

  // Reverse path and node list for reverse-order assembly
  const rpath = [...path].reverse(); // rpath[0] = last dir, rpath[N-1] = first dir after start
  const rcoords = [...orderedCoords].reverse();

  // Build the boot code in reverse order
  let code: number[] = [];
  const wireNodes: number[] = [];

  for (let i = 0; i < rcoords.length; i++) {
    const nodeCoord = rcoords[i];
    const node = nodeMap.get(nodeCoord);

    // In the forward path, rpath[i] = the direction from the previous node
    // TO this node.  rpath[i-1] = the direction from this node TO the next.
    //   prev: direction used to reach this node (for focusing call)
    //   dir:  direction from this node to the next (for port pump relay)
    const prev = rpath[i];
    const dir = i > 0 ? rpath[i - 1] : rpath[i];

    // Get node code
    const nodeCode = node ? getUsedPortion(node) : null;

    const newCode: number[] = [];

    // 1. Focusing call: call back toward previous node in path
    //    Reference: (vector-ref (vector S W N E) prev)
    //    This maps prev direction index to the opposite direction
    newCode.push(
      assembleWord('call', getDirection(nodeCoord, OPPOSITE[prev]))
    );

    // 2. Port pump: relay all previous code through this node
    if (code.length > 0) {
      newCode.push(...portPump(nodeCoord, dir, code.length));
      if (!nodeCode) {
        wireNodes.push(nodeCoord);
      }
    }

    // 3. Previous code (to be relayed)
    newCode.push(...code);

    // 4. Load pump + node code + boot descriptors
    if (nodeCode) {
      newCode.push(...loadPump(nodeCode.length));
      newCode.push(...nodeCode);
      newCode.push(...bootDescriptors(node!));
    } else {
      newCode.push(...loadPump(null));
    }

    code = newCode;
  }

  // Frame 1 header
  const frame = [
    0xAE,                                  // async boot magic byte
    getDirection(bootNode, firstDir),      // port direction from boot node
    code.length,                           // total frame length
    ...code,
  ];

  return { frame, visitedCoords: orderedCoords, wireNodes };
}

// ---------------------------------------------------------------------------
// Serial byte encoding
// ---------------------------------------------------------------------------

/**
 * Encode boot stream words as bytes for the node 708 bootrom protocol.
 * Matches reference `sget-convert`.
 *
 * Each 18-bit word is encoded as 3 bytes with XOR inversion and a 0x2D
 * calibration pattern in the low 6 bits of byte 0 for auto-baud detection.
 */
export function encodeAsyncBootromBytes(words: number[]): Uint8Array {
  const bytes = new Uint8Array(words.length * 3);
  for (let i = 0; i < words.length; i++) {
    const n = words[i] & WORD_MASK;
    // Reference encoding (note: cons builds in reverse, then reversed)
    // byte order per word: low bits first
    bytes[i * 3 + 0] = (((n << 6) & 0xC0) | 0x2D) ^ 0xFF;
    bytes[i * 3 + 1] = ((n >> 2) & 0xFF) ^ 0xFF;
    bytes[i * 3 + 2] = ((n >> 10) & 0xFF) ^ 0xFF;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BootStreamResult {
  /** 18-bit boot stream words (Frame 1 + Frame 2). */
  words: number[];
  /** Async serial byte encoding (3 bytes per word). */
  bytes: Uint8Array;
  /** Node coordinates in visitation order (excluding boot node). */
  path: number[];
  /** Coordinates of intermediate relay (wire) nodes. */
  wireNodes: number[];
}

/**
 * Build an async boot stream from compiled nodes.
 *
 * @param nodes - Compiled node data (output of compileCube or similar)
 * @param bootNode - Boot node coordinate (default: 708 for async serial)
 * @returns Boot stream in both word and byte formats
 */
export function buildBootStream(
  nodes: CompiledNode[],
  bootNode: number = 708,
): BootStreamResult {
  // Build node lookup by coordinate
  const nodeMap = new Map<number, CompiledNode>();
  for (const node of nodes) {
    nodeMap.set(node.coord, node);
  }

  // Compute path: use full zigzag, trimmed to last target
  const targetCoords = new Set(
    nodes.filter(n => n.coord !== bootNode).map(n => n.coord)
  );
  const fullPath = getAsyncPath1();
  const path = trimPath(fullPath, bootNode, targetCoords);

  // Build Frame 1 (all non-boot nodes)
  const { frame: frame1, visitedCoords, wireNodes } =
    makeAsyncFrame1(nodeMap, bootNode, path);

  // Build Frame 2 (boot node's own code)
  const bootNodeData = nodeMap.get(bootNode);
  const bootCode = bootNodeData ? (getUsedPortion(bootNodeData) ?? []) : [];
  const frame2 = [
    bootNodeData?.p ?? 0,  // starting P for boot node
    0,                     // unused (protocol padding)
    bootCode.length,       // code word count
    ...bootCode,
  ];

  const words = [...frame1, ...frame2];
  const bytes = encodeAsyncBootromBytes(words);

  return {
    words,
    bytes,
    path: visitedCoords,
    wireNodes,
  };
}
