/**
 * Comprehensive port communication unit tests.
 *
 * Tests all four cardinal directions, multiport read/write,
 * boundary-node blocking, IO register handshake status bits,
 * sequential transfers, multi-hop wake chains, and LUDR parity
 * correctness across node coordinate parities.
 *
 * Node coordinate format: YXX (row * 100 + col).
 *
 * IMPORTANT: Reader programs must loop (`@|jump(0)`) instead of ending
 * with RET (`;`). After RET, P=R (init 0x15555) which is a port address,
 * causing the node to fetch instructions from port space and corrupt T.
 */
import { describe, it, expect } from 'vitest';
import { GA144 } from './ga144';
import {
  WORD_MASK, NodeState,
} from './types';
import {
  PORT, IO_BITS,
  getDirectionAddress,
} from './constants';

// ============================================================================
// Opcode constants
// ============================================================================

const RET   = 0;   // ;
const JUMP  = 2;   // jump
const NEXT  = 5;   // next
const ATP   = 8;   // @p
const ATB   = 10;  // @b
const AT    = 11;  // @
const STOREB = 14; // !b
const STORE = 15;  // !
const DROP  = 23;  // drop
const NOP   = 28;  // .
const PUSH  = 29;  // push
const ASTORE = 31; // a!

// ============================================================================
// Test helpers
// ============================================================================

// Per-slot XOR bits for opcode encoding (matching reference xor-bits).
const XOR_BITS = [0b01010, 0b10101, 0b01010, 0b101];
function xorOp(opcode: number, slot: number, shift: number): number {
  return ((opcode ^ XOR_BITS[slot]) << shift);
}

/**
 * Pack 4 opcodes into an 18-bit instruction word.
 * Slot 3 can encode opcodes that are multiples of 4: {0,4,8,12,16,20,24,28}.
 */
function packWord(s0: number, s1: number, s2: number, s3: number): number {
  return xorOp(s0, 0, 13) | xorOp(s1, 1, 8) | xorOp(s2, 2, 3) | (((s3 >> 2) ^ XOR_BITS[3]) & 0x7);
}

/** Pack a jump/branch instruction at a given slot. */
function packJump(opcode: number, addr: number, slot: number = 0): number {
  switch (slot) {
    case 0: return xorOp(opcode, 0, 13) | (addr & 0x1FFF);
    case 1: return xorOp(NOP, 0, 13) | xorOp(opcode, 1, 8) | (addr & 0xFF);
    case 2: return xorOp(NOP, 0, 13) | xorOp(NOP, 1, 8) | xorOp(opcode, 2, 3) | (addr & 0x7);
    default: return 0;
  }
}

/** Pack [opcode_slot0, jump_slot1 addr]. */
function packOpJump(s0: number, jumpAddr: number): number {
  return (xorOp(s0, 0, 13) | xorOp(JUMP, 1, 8) | (jumpAddr & 0xFF)) & WORD_MASK;
}

/** Get snapshot of a specific node. */
function snap(ga: GA144, coord: number) {
  return ga.getSnapshot(coord).selectedNode!;
}

/** Build a mem array from a sparse list of words. */
function buildMem(words: number[]): (number | null)[] {
  const m = new Array(64).fill(null) as (number | null)[];
  for (let i = 0; i < words.length; i++) m[i] = words[i];
  return m;
}

/**
 * Reader instruction word: `@|jump(0)` — reads from port, then loops.
 * After the port read completes (T=value), JUMP(0) re-fetches word0
 * and the next @ blocks again. T is preserved because the second @
 * hasn't completed when it blocks.
 */
const READER_LOOP = packOpJump(AT, 0);

/**
 * Reader instruction word via B: `@b|jump(0)` — reads from [B] port, then loops.
 */
const READER_B_LOOP = packOpJump(ATB, 0);

/**
 * Writer instruction word: `!|jump(0)` — writes T to port, then loops.
 */
const WRITER_LOOP = packOpJump(STORE, 0);

/**
 * Set up a writer→reader pair on two adjacent nodes connected in a
 * given compass direction. Returns { ga, writerCoord, readerCoord }.
 *
 * Writer: push/next delay loop, then writes T to port.
 * Reader: `@|jump(0)` — loops reading from port.
 *
 * The writer uses a push/next delay (5 iterations) so the reader
 * registers on the port first.
 */
function setupDirectionTransfer(
  writerCoord: number,
  readerCoord: number,
  direction: 'north' | 'east' | 'south' | 'west',
  value: number,
) {
  const ga = new GA144('test');
  ga.reset();

  const writerPort = getDirectionAddress(writerCoord, direction);
  const oppositeDir: Record<string, 'north' | 'east' | 'south' | 'west'> = {
    north: 'south', south: 'north', east: 'west', west: 'east',
  };
  const readerPort = getDirectionAddress(readerCoord, oppositeDir[direction]);

  ga.load({
    nodes: [
      {
        coord: readerCoord,
        mem: buildMem([READER_LOOP]),
        len: 1,
        a: readerPort,
        p: 0,
      },
      {
        coord: writerCoord,
        mem: buildMem([
          packOpJump(PUSH, 1),              // push count→R, jump 1
          packJump(NEXT, 1),                // next loop
          packWord(STORE, NOP, NOP, RET),   // ! stores T to port
        ]),
        len: 3,
        a: writerPort,
        p: 0,
        stack: [value, 5], // T=5, S=value; after push: R=5, T=value
      },
    ],
    errors: [],
  });

  return { ga, writerCoord, readerCoord };
}

// ============================================================================
// 1. Cardinal direction transfers
// ============================================================================

describe('cardinal direction port transfers', () => {
  it('east: even-x writer → odd-x reader', () => {
    // 304 (x=4 even) east → 305 (x=5 odd) west
    const { ga, readerCoord } = setupDirectionTransfer(304, 305, 'east', 0xAAAA);
    ga.stepProgramN(15);
    expect(snap(ga, readerCoord).registers.T).toBe(0xAAAA);
  });

  it('west: odd-x writer → even-x reader', () => {
    // 305 (x=5 odd) west → 304 (x=4 even) east
    const { ga, readerCoord } = setupDirectionTransfer(305, 304, 'west', 0xBBBB);
    ga.stepProgramN(15);
    expect(snap(ga, readerCoord).registers.T).toBe(0xBBBB);
  });

  it('north: even-y writer → odd-y reader', () => {
    // 204 (y=2 even) north → 304 (y=3 odd) south
    const { ga, readerCoord } = setupDirectionTransfer(204, 304, 'north', 0xCCCC);
    ga.stepProgramN(15);
    expect(snap(ga, readerCoord).registers.T).toBe(0xCCCC);
  });

  it('south: odd-y writer → even-y reader', () => {
    // 304 (y=3 odd) south → 204 (y=2 even) north
    const { ga, readerCoord } = setupDirectionTransfer(304, 204, 'south', 0xDDDD);
    ga.stepProgramN(15);
    expect(snap(ga, readerCoord).registers.T).toBe(0xDDDD);
  });

  it('east: odd-x writer → even-x reader (reversed parity)', () => {
    // 305 (x=5 odd) east → 306 (x=6 even) west
    const { ga, readerCoord } = setupDirectionTransfer(305, 306, 'east', 0x1234);
    ga.stepProgramN(15);
    expect(snap(ga, readerCoord).registers.T).toBe(0x1234);
  });

  it('south: even-y writer → odd-y reader', () => {
    // 104 (y=1 odd) south → 4 (y=0 even) north
    const { ga, readerCoord } = setupDirectionTransfer(104, 4, 'south', 0x5678);
    ga.stepProgramN(15);
    expect(snap(ga, readerCoord).registers.T).toBe(0x5678);
  });
});

// ============================================================================
// 2. Boundary-node blocking (all 4 edges)
// ============================================================================

describe('boundary-node blocking', () => {
  it('west edge (x=0): write to LEFT blocks forever', () => {
    const ga = new GA144('test');
    ga.reset();
    ga.load({
      nodes: [{
        coord: 400, // x=0
        mem: buildMem([WRITER_LOOP]),
        len: 1,
        a: PORT.LEFT,
        p: 0,
        stack: [0x42],
      }],
      errors: [],
    });
    ga.stepProgramN(50);
    expect(snap(ga, 400).state).toBe(NodeState.BLOCKED_WRITE);
  });

  it('east edge (x=17): write to east blocks forever', () => {
    const ga = new GA144('test');
    ga.reset();
    const eastPort = getDirectionAddress(317, 'east');
    ga.load({
      nodes: [{
        coord: 317, // x=17
        mem: buildMem([WRITER_LOOP]),
        len: 1,
        a: eastPort,
        p: 0,
        stack: [0x42],
      }],
      errors: [],
    });
    ga.stepProgramN(50);
    expect(snap(ga, 317).state).toBe(NodeState.BLOCKED_WRITE);
  });

  it('north edge (y=7): write to north blocks forever', () => {
    const ga = new GA144('test');
    ga.reset();
    const northPort = getDirectionAddress(704, 'north');
    ga.load({
      nodes: [{
        coord: 704, // y=7
        mem: buildMem([WRITER_LOOP]),
        len: 1,
        a: northPort,
        p: 0,
        stack: [0x42],
      }],
      errors: [],
    });
    ga.stepProgramN(50);
    expect(snap(ga, 704).state).toBe(NodeState.BLOCKED_WRITE);
  });

  it('south edge (y=0): write to south blocks forever', () => {
    const ga = new GA144('test');
    ga.reset();
    const southPort = getDirectionAddress(4, 'south');
    ga.load({
      nodes: [{
        coord: 4, // y=0
        mem: buildMem([WRITER_LOOP]),
        len: 1,
        a: southPort,
        p: 0,
        stack: [0x42],
      }],
      errors: [],
    });
    ga.stepProgramN(50);
    expect(snap(ga, 4).state).toBe(NodeState.BLOCKED_WRITE);
  });

  it('west edge (x=0): read from LEFT blocks forever', () => {
    const ga = new GA144('test');
    ga.reset();
    ga.load({
      nodes: [{
        coord: 400,
        mem: buildMem([READER_LOOP]),
        len: 1,
        a: PORT.LEFT,
        p: 0,
      }],
      errors: [],
    });
    ga.stepProgramN(50);
    expect(snap(ga, 400).state).toBe(NodeState.BLOCKED_READ);
  });

  it('corner node (0,0): write to south blocks', () => {
    const ga = new GA144('test');
    ga.reset();
    const southPort = getDirectionAddress(0, 'south');
    ga.load({
      nodes: [{
        coord: 0,
        mem: buildMem([WRITER_LOOP]),
        len: 1,
        a: southPort,
        p: 0,
        stack: [0x42],
      }],
      errors: [],
    });
    ga.stepProgramN(50);
    expect(snap(ga, 0).state).toBe(NodeState.BLOCKED_WRITE);
  });
});

// ============================================================================
// 3. Multiport write
// ============================================================================

describe('multiport write', () => {
  it('RDLU multiport write delivers to multiple waiting readers', () => {
    // Node 305 writes to rdlu multiport (0x1A5).
    // Node 304 reads from east (RIGHT), node 306 reads from west (LEFT).
    const ga = new GA144('test');
    ga.reset();

    const rdluPort = 0x1A5;
    const port304 = getDirectionAddress(304, 'east');  // RIGHT
    const port306 = getDirectionAddress(306, 'west');  // LEFT

    ga.load({
      nodes: [
        {
          coord: 304,
          mem: buildMem([READER_LOOP]),
          len: 1, a: port304, p: 0,
        },
        {
          coord: 306,
          mem: buildMem([READER_LOOP]),
          len: 1, a: port306, p: 0,
        },
        {
          coord: 305,
          mem: buildMem([
            packOpJump(PUSH, 1),
            packJump(NEXT, 1),
            packWord(STORE, NOP, NOP, RET),
          ]),
          len: 3, a: rdluPort, p: 0,
          stack: [0xFACE, 5],
        },
      ],
      errors: [],
    });

    ga.stepProgramN(15);

    expect(snap(ga, 304).registers.T).toBe(0xFACE);
    expect(snap(ga, 306).registers.T).toBe(0xFACE);
  });

  it('multiport write to single-neighbor reader completes without blocking', () => {
    // Node 305 writes rdlu but only 304 (east neighbor via RIGHT) is reading.
    const ga = new GA144('test');
    ga.reset();

    const rdluPort = 0x1A5;
    const port304 = getDirectionAddress(304, 'east');

    ga.load({
      nodes: [
        {
          coord: 304,
          mem: buildMem([READER_LOOP]),
          len: 1, a: port304, p: 0,
        },
        {
          coord: 305,
          mem: buildMem([
            packOpJump(PUSH, 1),
            packJump(NEXT, 1),
            packWord(STORE, NOP, NOP, RET),
          ]),
          len: 3, a: rdluPort, p: 0,
          stack: [0xBEEF, 5],
        },
      ],
      errors: [],
    });

    ga.stepProgramN(15);
    expect(snap(ga, 304).registers.T).toBe(0xBEEF);
    // Writer should not be blocked (multiport write never blocks)
    expect(snap(ga, 305).state).not.toBe(NodeState.BLOCKED_WRITE);
  });
});

// ============================================================================
// 4. Multiport read
// ============================================================================

describe('multiport read', () => {
  it('multiport read receives from first available writer', () => {
    // Node 305 reads from rdlu multiport (0x1A5).
    // Node 304 (east of 305) writes via its east port after delay.
    const ga = new GA144('test');
    ga.reset();

    const rdluPort = 0x1A5;
    const port304 = getDirectionAddress(304, 'east'); // RIGHT

    ga.load({
      nodes: [
        {
          coord: 305,
          mem: buildMem([
            // @|jump(0) but reading from multiport
            packOpJump(AT, 0),
          ]),
          len: 1, a: rdluPort, p: 0,
        },
        {
          coord: 304,
          mem: buildMem([
            packOpJump(PUSH, 1),
            packJump(NEXT, 1),
            packWord(STORE, NOP, NOP, RET),
          ]),
          len: 3, a: port304, p: 0,
          stack: [0xCAFE, 5],
        },
      ],
      errors: [],
    });

    ga.stepProgramN(15);
    expect(snap(ga, 305).registers.T).toBe(0xCAFE);
  });
});

// ============================================================================
// 5. Sequential transfers (multiple words)
// ============================================================================

describe('sequential transfers', () => {
  it('two consecutive writes from A to B', () => {
    // Node 304 writes two values (0x111 then 0x222), then enters NOP loop.
    // Node 305 reads in a loop; after writer stops, the third @ blocks.
    // At that point T = last received value (0x222).
    //
    // IMPORTANT: Slot 3 of an F18A word can only encode even opcodes 0-14.
    // NOP (28) in slot 3 silently becomes !p (12), so we use packOpJump
    // (which puts jump in slot 1) to avoid slot 3 execution entirely.
    const ga = new GA144('test');
    ga.reset();

    const writerPort = getDirectionAddress(304, 'east');
    const readerPort = getDirectionAddress(305, 'west');

    ga.load({
      nodes: [
        {
          coord: 304,
          // word0: !|jump(1) — first write, then jump to word1
          // word1: .|jump(2) — delay (gives reader time to register)
          // word2: !|jump(3) — second write, then jump to word3
          // word3: .|jump(3) — NOP loop (writer stops)
          mem: buildMem([
            packOpJump(STORE, 1), // word0: !|jump(1)
            packOpJump(NOP, 2),   // word1: .|jump(2)
            packOpJump(STORE, 3), // word2: !|jump(3)
            packOpJump(NOP, 3),   // word3: .|jump(3) NOP loop
          ]),
          len: 4,
          a: writerPort,
          p: 0,
          stack: [0x222, 0x111], // T=0x111, S=0x222; first write=0x111, second=0x222
        },
        {
          coord: 305,
          // @|jump(0) — reads from port in a loop
          // After writer stops, the third read blocks. T = 0x222 (last received).
          mem: buildMem([READER_LOOP]),
          len: 1,
          a: readerPort,
          p: 0,
        },
      ],
      errors: [],
    });

    ga.stepProgramN(20);

    // Reader's third @ blocks (writer is in NOP loop), T holds last received value
    expect(snap(ga, 305).registers.T).toBe(0x222);
  });
});

// ============================================================================
// 6. Wake chain (A blocks on B, B blocks on C, C writes to B, B writes to A)
// ============================================================================

describe('wake chain', () => {
  it('three-node relay: C → B → A', () => {
    // Nodes: 303 (A) ← 304 (B) ← 305 (C)
    // A reads from east (blocks on B).
    // B reads from east (blocks on C), then writes to west (wakes A), then NOPs.
    // C writes to west after delay (wakes B), then NOPs.
    const ga = new GA144('test');
    ga.reset();

    const aPort = getDirectionAddress(303, 'east');
    const bEast = getDirectionAddress(304, 'east');
    const bWest = getDirectionAddress(304, 'west');
    const cPort = getDirectionAddress(305, 'west');

    // B relay program:
    // word0: @|jump(1)   — read from [A=eastPort] into T
    // word1: @p|jump(3)  — fetch literal (west port addr)
    // word2: bWest        — literal data
    // word3: a!|jump(4)  — set A=westPort
    // word4: !|.|.|.     — write T to west, then NOPs (NO loop)
    // word5: .|jump(5)   — NOP loop (B stops writing)
    ga.load({
      nodes: [
        {
          coord: 303,
          mem: buildMem([READER_LOOP]),
          len: 1,
          a: aPort,
          p: 0,
        },
        {
          coord: 304,
          mem: buildMem([
            packOpJump(AT, 1),                        // word0: @|jump(1)
            packOpJump(ATP, 3),                       // word1: @p|jump(3)
            bWest,                                     // word2: literal
            packOpJump(ASTORE, 4),                     // word3: a!|jump(4)
            packOpJump(STORE, 5),                      // word4: !|jump(5) single write
            packOpJump(NOP, 5),                        // word5: .|jump(5) NOP loop
          ]),
          len: 6,
          a: bEast,
          p: 0,
        },
        {
          coord: 305,
          mem: buildMem([
            packOpJump(PUSH, 1),
            packJump(NEXT, 1),
            packOpJump(STORE, 3),             // !|jump(3) single write
            packOpJump(NOP, 3),               // .|jump(3) NOP loop
          ]),
          len: 4,
          a: cPort,
          p: 0,
          stack: [0x3210, 5],
        },
      ],
      errors: [],
    });

    ga.stepProgramN(30);

    // A reads once, then its second @ blocks (B is in NOP loop).
    // T = 0x3210 (the relayed value from C).
    expect(snap(ga, 303).registers.T).toBe(0x3210);
  });
});

// ============================================================================
// 7. IO register handshake status bits
// ============================================================================

describe('IO register handshake bits', () => {
  it('pending write on RIGHT shows Rw bit set in neighbor IO', () => {
    // Node 304 writes to east (RIGHT), blocking because 305 isn't reading.
    // Node 305's IO register should show Rw_BIT (bit 15) set.
    const ga = new GA144('test');
    ga.reset();

    const writerPort = getDirectionAddress(304, 'east');

    ga.load({
      nodes: [
        {
          coord: 304,
          mem: buildMem([WRITER_LOOP]),
          len: 1, a: writerPort, p: 0, stack: [0x42],
        },
        {
          // Node 305: delay then read IO register
          // IMPORTANT: @b|jump(2) loops at word2, NOT jump(0) which
          // would restart the delay loop with the IO value as R.
          coord: 305,
          mem: buildMem([
            packOpJump(PUSH, 1),
            packJump(NEXT, 1),
            packOpJump(ATB, 2),  // @b|jump(2) — reads [B=IO], loops at word2
          ]),
          len: 3, p: 0,
          stack: [0, 10], // delay 10 iterations
        },
      ],
      errors: [],
    });

    ga.stepProgramN(20);

    expect(snap(ga, 304).state).toBe(NodeState.BLOCKED_WRITE);
    const ioVal = snap(ga, 305).registers.T;
    expect(ioVal & IO_BITS.Rw_BIT).toBe(IO_BITS.Rw_BIT);
  });

  it('pending read on RIGHT clears Rr bit in neighbor IO', () => {
    // Node 304 reads from east (RIGHT), blocking because 305 isn't writing.
    // Node 305's IO should show bit 16 (Rr) cleared.
    const ga = new GA144('test');
    ga.reset();

    const readerPort = getDirectionAddress(304, 'east');

    ga.load({
      nodes: [
        {
          coord: 304,
          mem: buildMem([READER_LOOP]),
          len: 1, a: readerPort, p: 0,
        },
        {
          // Same fix as above: @b|jump(2) loops at word2, not jump(0)
          coord: 305,
          mem: buildMem([
            packOpJump(PUSH, 1),
            packJump(NEXT, 1),
            packOpJump(ATB, 2),  // @b|jump(2) — reads [B=IO], loops at word2
          ]),
          len: 3, p: 0,
          stack: [0, 10],
        },
      ],
      errors: [],
    });

    ga.stepProgramN(20);

    expect(snap(ga, 304).state).toBe(NodeState.BLOCKED_READ);
    const ioVal = snap(ga, 305).registers.T;
    // Bit 16 (Rr) should be cleared (0) indicating pending read
    expect(ioVal & (1 << 16)).toBe(0);
  });
});

// ============================================================================
// 8. LUDR parity verification across all 4 parity combinations
// ============================================================================

describe('LUDR parity across all node parity combos', () => {
  it('even-x/even-y pair: 204↔205 east-west', () => {
    const { ga, readerCoord } = setupDirectionTransfer(204, 205, 'east', 0x1111);
    ga.stepProgramN(15);
    expect(snap(ga, readerCoord).registers.T).toBe(0x1111);
  });

  it('odd-x/even-y pair: 205↔206 east-west', () => {
    const { ga, readerCoord } = setupDirectionTransfer(205, 206, 'east', 0x2222);
    ga.stepProgramN(15);
    expect(snap(ga, readerCoord).registers.T).toBe(0x2222);
  });

  it('even-x/odd-y pair: 304↔305 east-west', () => {
    const { ga, readerCoord } = setupDirectionTransfer(304, 305, 'east', 0x3333);
    ga.stepProgramN(15);
    expect(snap(ga, readerCoord).registers.T).toBe(0x3333);
  });

  it('odd-x/odd-y pair: 305↔306 east-west', () => {
    const { ga, readerCoord } = setupDirectionTransfer(305, 306, 'east', 0x4444);
    ga.stepProgramN(15);
    expect(snap(ga, readerCoord).registers.T).toBe(0x4444);
  });

  it('north-south across even-y/odd-y boundary: 204↔304', () => {
    const { ga, readerCoord } = setupDirectionTransfer(204, 304, 'north', 0x5555);
    ga.stepProgramN(15);
    expect(snap(ga, readerCoord).registers.T).toBe(0x5555);
  });

  it('north-south across odd-y/even-y boundary: 304↔404', () => {
    const { ga, readerCoord } = setupDirectionTransfer(304, 404, 'north', 0x6666);
    ga.stepProgramN(15);
    expect(snap(ga, readerCoord).registers.T).toBe(0x6666);
  });
});

// ============================================================================
// 9. Port read/write via B register (@b/!b)
// ============================================================================

describe('port access via B register', () => {
  it('write via !b and read via @b on connected nodes', () => {
    const ga = new GA144('test');
    ga.reset();

    const port304 = getDirectionAddress(304, 'east');
    const port305 = getDirectionAddress(305, 'west');

    ga.load({
      nodes: [
        {
          coord: 305,
          mem: buildMem([READER_B_LOOP]), // @b|jump(0)
          len: 1,
          b: port305,
          p: 0,
        },
        {
          coord: 304,
          mem: buildMem([
            packOpJump(PUSH, 1),
            packJump(NEXT, 1),
            packWord(STOREB, NOP, NOP, RET), // !b writes T to [B]
          ]),
          len: 3,
          b: port304,
          p: 0,
          stack: [0xABCD, 5],
        },
      ],
      errors: [],
    });

    ga.stepProgramN(15);
    expect(snap(ga, 305).registers.T).toBe(0xABCD);
  });
});

// ============================================================================
// 10. 18-bit boundary values through ports
// ============================================================================

describe('18-bit boundary values through ports', () => {
  it('transfers 0x00000 (zero)', () => {
    const { ga, readerCoord } = setupDirectionTransfer(304, 305, 'east', 0x00000);
    ga.stepProgramN(15);
    expect(snap(ga, readerCoord).registers.T).toBe(0x00000);
  });

  it('transfers 0x3FFFF (max 18-bit)', () => {
    const { ga, readerCoord } = setupDirectionTransfer(304, 305, 'east', 0x3FFFF);
    ga.stepProgramN(15);
    expect(snap(ga, readerCoord).registers.T).toBe(0x3FFFF);
  });

  it('transfers 0x15555 (XOR_ENCODING value)', () => {
    const { ga, readerCoord } = setupDirectionTransfer(304, 305, 'east', 0x15555);
    ga.stepProgramN(15);
    expect(snap(ga, readerCoord).registers.T).toBe(0x15555);
  });

  it('transfers 0x2AAAA (~XOR_ENCODING & WORD_MASK)', () => {
    const { ga, readerCoord } = setupDirectionTransfer(304, 305, 'east', 0x2AAAA);
    ga.stepProgramN(15);
    expect(snap(ga, readerCoord).registers.T).toBe(0x2AAAA);
  });
});
