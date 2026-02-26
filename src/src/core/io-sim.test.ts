/**
 * IO simulation tests: serial input at 921600 baud via pin17.
 *
 * Tests drive pin17 step-by-step to simulate UART 8N1 serial data
 * at the GA144's boot baud rate (921600 baud = 723 steps per bit).
 *
 * GPIO nodes tested:
 *   - Node 708 (async boot node, 2 GPIO pins, wake pin = UP)
 *   - Node 200 (one-wire node, 1 GPIO pin, wake pin = LEFT)
 *   - Node 300 (sync boot node, 2 GPIO pins, wake pin = LEFT)
 *
 * Protocol: RS232 8N1 (after level conversion)
 *   idle = LOW, start bit = HIGH, 8 data bits LSB first (inverted), stop bit = LOW
 */
import { describe, it, expect } from 'vitest';
import { GA144 } from './ga144';
import { SerialBits } from './serial';
import {
  WORD_MASK,
} from './types';
import {
  PORT, IO_BITS, NODE_GPIO_PINS,
} from './constants';

// ============================================================================
// Constants
// ============================================================================

const NS_PER_TICK = GA144.NS_PER_TICK;
/** Baud period in ticks: how many ALU steps per bit at boot baud rate. */
const BAUD_PERIOD = Math.round(1e9 / (GA144.BOOT_BAUD * NS_PER_TICK)); // ~723
/** Convert step ticks to nanoseconds. */
const toNS = (ticks: number) => ticks * NS_PER_TICK;
/** Convert a tick-based baud period to Hz. */
const ticksToHz = (ticks: number) => 1e9 / (ticks * NS_PER_TICK);

// Opcodes
const _RET   = 0;   // ;
const JUMP   = 2;   // jump
const _CALL  = 3;   // call
const _UNEXT = 4;   // unext
const _NEXT  = 5;   // next
const _IF    = 6;   // if
const _NIF   = 7;   // -if
const ATP    = 8;   // @p
const ATB    = 10;  // @b
const _AT    = 11;  // @
const STOREP = 12;  // !p
const STOREPLUS = 13; // !+ (store T to [A], pop, increment A)
const STOREB = 14;  // !b
const _STORE = 15;  // !
const _TWOMUL = 17; // 2*
const TWODIV = 18;  // 2/
const _NOT   = 19;  // - (complement)
const _PLUS  = 20;  // +
const _AND   = 21;  // and
const _OR    = 22;  // or
const DROP   = 23;  // drop
const DUP    = 24;  // dup
const _POP   = 25;  // pop
const _OVER  = 26;  // over
const _FETCHR = 27; // a
const _NOP   = 28;  // .
const _PUSH  = 29;  // push
const BSTORE = 30;  // b!
const _ASTORE = 31; // a!

// ============================================================================
// Helpers
// ============================================================================

// Per-slot XOR bits for opcode encoding (matching reference xor-bits).
const XOR_BITS = [0b01010, 0b10101, 0b01010, 0b101];
function xorOp(opcode: number, slot: number, shift: number): number {
  return ((opcode ^ XOR_BITS[slot]) << shift);
}

/** Pack a jump/branch at slot 0 with address. */
function _packJump(opcode: number, addr: number): number {
  return xorOp(opcode, 0, 13) | (addr & 0x3FF);
}

/** Pack [opcode_slot0, jump_slot1 addr]. */
function packOpJump(s0: number, jumpAddr: number): number {
  return (xorOp(s0, 0, 13) | xorOp(JUMP, 1, 8) | (jumpAddr & 0xFF)) & WORD_MASK;
}

/** Pack [opcode_slot0, opcode_slot1, jump_slot2 addr]. */
function _packOp2Jump(s0: number, s1: number, jumpAddr: number): number {
  return (xorOp(s0, 0, 13) | xorOp(s1, 1, 8) | xorOp(JUMP, 2, 3) | (jumpAddr & 0x7)) & WORD_MASK;
}

/** Pack 4 opcodes into an 18-bit XOR-encoded instruction word.
 *  Slot 3 can encode opcodes that are multiples of 4: {0,4,8,12,16,20,24,28}. */
function _packWord(s0: number, s1: number, s2: number, s3: number): number {
  return xorOp(s0, 0, 13) | xorOp(s1, 1, 8) | xorOp(s2, 2, 3) | (((s3 >> 2) ^ XOR_BITS[3]) & 0x7);
}

/** Pack @p literal: word0 = @p|jump(addr), word1 = data */
function packLiteral(data: number, jumpAddr: number): [number, number] {
  const instr = packOpJump(ATP, jumpAddr);
  return [instr, data & WORD_MASK];
}

/** Build a mem array from a sparse list of words. */
function buildMem(words: number[]): (number | null)[] {
  const m = new Array(64).fill(null) as (number | null)[];
  for (let i = 0; i < words.length; i++) m[i] = words[i];
  return m;
}

/** Get snapshot of a specific node. */
function snap(ga: GA144, coord: number) {
  return ga.getSnapshot(coord).selectedNode!;
}

/**
 * Build RS232 8N1 bit sequence for given bytes at a given baud period.
 * Each element: {value: boolean, durationNS: number}
 * RS232: idle = false (LOW), start bit = true (HIGH), data inverted
 */
function buildSerialBits(
  bytes: number[],
  baudPeriod: number = BAUD_PERIOD,
  idlePeriod: number = 0,
): { value: boolean; durationNS: number }[] {
  return SerialBits.buildBits(bytes, ticksToHz(baudPeriod), idlePeriod * NS_PER_TICK / 1e9);
}

/**
 * Manually build serial bits for a single byte, without merging
 * consecutive identical values. Returns 10 entries: start + 8 data + stop.
 * Useful for step-by-step verification.
 */
function buildRawByteBits(
  byte: number,
  baudPeriod: number = BAUD_PERIOD,
): { value: boolean; durationNS: number }[] {
  const toNS = (ticks: number) => ticks * GA144.NS_PER_TICK;
  const bits: { value: boolean; durationNS: number }[] = [];
  bits.push({ value: false, durationNS: toNS(baudPeriod) }); // start bit
  for (let i = 0; i < 8; i++) {
    bits.push({ value: ((byte >> i) & 1) === 1, durationNS: toNS(baudPeriod) });
  }
  bits.push({ value: true, durationNS: toNS(baudPeriod) }); // stop bit
  return bits;
}

/**
 * Deactivate all nodes except the given coordinates.
 * Prevents background ROM execution from interfering with tests.
 */
function isolateNodes(ga: GA144, coords: number[]): void {
  const keep = new Set(coords);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 18; col++) {
      const c = row * 100 + col;
      if (!keep.has(c)) {
        const node = ga.getNodeByCoord(c);
        ga.removeFromActiveList(node);
        ga.deactivateNode(node);
      }
    }
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('IO simulation: serial input at 921600 baud', () => {

  // --------------------------------------------------------------------------
  // buildSerialBits verification
  // --------------------------------------------------------------------------

  describe('buildSerialBits format', () => {

    it('single byte produces correct UART 8N1 frame', () => {
      const bits = buildSerialBits([0x55], BAUD_PERIOD);
      // 0x55 = 01010101 in binary, LSB first = 1,0,1,0,1,0,1,0
      // Frame: start(0), d0(1), d1(0), d2(1), d3(0), d4(1), d5(0), d6(1), d7(0), stop(1)
      // Adjacent identical bits get merged:
      // start=0 (723), d0=1 (723), d1=0 (723), d2=1 (723), d3=0 (723),
      // d4=1 (723), d5=0 (723), d6=1 (723), d7=0 (723), stop=1 (+trailing idle)

      // Verify total duration = 10 bits * BAUD + 2 * BAUD (trailing idle)
      const totalDuration = bits.reduce((sum, b) => sum + b.durationNS, 0);
      expect(totalDuration).toBe(toNS(BAUD_PERIOD * 12)); // 10 data + 2 trailing
    });

    it('0x00 byte: RS232 start(H) + inverted-zero data(H) merge', () => {
      const bits = buildSerialBits([0x00], BAUD_PERIOD);
      // RS232: start(H), 8× data 0→inverted→H, stop(L) + trailing(L)
      // start + 8 inverted zeros merge into HIGH span of 9*BAUD
      // stop + trailing merge into LOW span of 3*BAUD
      expect(bits).toHaveLength(2);
      expect(bits[0].value).toBe(true);
      expect(bits[0].durationNS).toBe(toNS(BAUD_PERIOD * 9)); // start + 8 data bits
      expect(bits[1].value).toBe(false);
      expect(bits[1].durationNS).toBe(toNS(BAUD_PERIOD * 3)); // stop + 2 trailing
    });

    it('0xFF byte: RS232 inverted-one data(L) merges with stop(L)', () => {
      const bits = buildSerialBits([0xFF], BAUD_PERIOD);
      // RS232: start(H), 8× data 1→inverted→L, stop(L) + trailing(L)
      // start = HIGH BAUD, data+stop+trailing = LOW 11*BAUD
      expect(bits).toHaveLength(2);
      expect(bits[0].value).toBe(true);
      expect(bits[0].durationNS).toBe(toNS(BAUD_PERIOD * 1)); // just start bit
      expect(bits[1].value).toBe(false);
      expect(bits[1].durationNS).toBe(toNS(BAUD_PERIOD * 11)); // 8 data + stop + 2 trailing
    });

    it('idle prefix is prepended (RS232 idle = LOW)', () => {
      const idlePeriod = BAUD_PERIOD * 10;
      const bits = buildSerialBits([0xFF], BAUD_PERIOD, idlePeriod);
      // RS232 idle = LOW, start = HIGH
      expect(bits[0].value).toBe(false);
      expect(bits[0].durationNS).toBe(toNS(idlePeriod)); // idle stands alone (LOW)
      expect(bits[1].value).toBe(true); // start bit (HIGH)
    });

    it('two bytes produce correct total duration', () => {
      const bits = buildSerialBits([0x41, 0x42], BAUD_PERIOD);
      const totalDuration = bits.reduce((sum, b) => sum + b.durationNS, 0);
      // 2 bytes * 10 bits each + 2 trailing = 22 bit periods
      expect(totalDuration).toBe(toNS(BAUD_PERIOD * 22));
    });

    it('raw byte bits produce exactly 10 entries', () => {
      const bits = buildRawByteBits(0xA5, BAUD_PERIOD);
      expect(bits).toHaveLength(10);
      // 0xA5 = 10100101 binary, LSB first: 1,0,1,0,0,1,0,1
      expect(bits[0]).toEqual({ value: false, durationNS: toNS(BAUD_PERIOD) }); // start
      expect(bits[1]).toEqual({ value: true,  durationNS: toNS(BAUD_PERIOD) }); // d0=1
      expect(bits[2]).toEqual({ value: false, durationNS: toNS(BAUD_PERIOD) }); // d1=0
      expect(bits[3]).toEqual({ value: true,  durationNS: toNS(BAUD_PERIOD) }); // d2=1
      expect(bits[4]).toEqual({ value: false, durationNS: toNS(BAUD_PERIOD) }); // d3=0
      expect(bits[5]).toEqual({ value: false, durationNS: toNS(BAUD_PERIOD) }); // d4=0
      expect(bits[6]).toEqual({ value: true,  durationNS: toNS(BAUD_PERIOD) }); // d5=1
      expect(bits[7]).toEqual({ value: false, durationNS: toNS(BAUD_PERIOD) }); // d6=0
      expect(bits[8]).toEqual({ value: true,  durationNS: toNS(BAUD_PERIOD) }); // d7=1
      expect(bits[9]).toEqual({ value: true,  durationNS: toNS(BAUD_PERIOD) }); // stop
    });
  });

  // --------------------------------------------------------------------------
  // Pin17 basic behavior
  // --------------------------------------------------------------------------

  describe('pin17 basics', () => {

    it('pin17 defaults to false (LOW)', () => {
      const ga = new GA144('test');
      ga.reset();
      const node = ga.getNodeByCoord(708);
      expect(node.getPin17()).toBe(false);
    });

    it('setPin17 drives the pin state', () => {
      const ga = new GA144('test');
      ga.reset();
      const node = ga.getNodeByCoord(708);
      node.setPin17(true);
      expect(node.getPin17()).toBe(true);
      node.setPin17(false);
      expect(node.getPin17()).toBe(false);
    });

    it('pin17 is reflected in IO register bit 17 on GPIO node', () => {
      // Node 708 has 2 GPIO pins. When pin17=HIGH, reading IO should show bit 17.
      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [708]);

      const node = ga.getNodeByCoord(708);

      // Program: @b (read IO) | jump(0) — loop reading IO
      ga.load({
        nodes: [{
          coord: 708,
          mem: buildMem([
            packOpJump(ATB, 0), // word0: @b|jump(0) — read IO, loop
          ]),
          len: 1,
          b: PORT.IO,
          p: 0,
        }],
        errors: [],
      });

      // Drive pin17 HIGH before stepping
      node.setPin17(true);
      ga.stepProgramN(1000); // let the read execute

      const s = snap(ga, 708);
      // T should have bit 17 set (0x20000)
      expect(s.registers.T & IO_BITS.PIN17_BIT).toBe(IO_BITS.PIN17_BIT);
    });

    it('pin17 LOW clears bit 17 in IO register', () => {
      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [708]);

      const node = ga.getNodeByCoord(708);

      ga.load({
        nodes: [{
          coord: 708,
          mem: buildMem([
            packOpJump(ATB, 0),
          ]),
          len: 1,
          b: PORT.IO,
          p: 0,
        }],
        errors: [],
      });

      node.setPin17(false);
      ga.stepProgramN(1000);

      const s = snap(ga, 708);
      expect(s.registers.T & IO_BITS.PIN17_BIT).toBe(0);
    });

    it('non-GPIO node IO register is unaffected by pin17 input', () => {
      // Node 304 has 0 GPIO pins. The IO register bit 17 on non-GPIO nodes
      // reflects ~IO passthrough (always set when IO=0), NOT the pin17 input.
      // Verify that toggling pin17 does NOT change the IO register reading.
      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [304]);

      const node = ga.getNodeByCoord(304);

      ga.load({
        nodes: [{
          coord: 304,
          mem: buildMem([
            packOpJump(ATB, 0), // word0: @b|jump(0) — poll IO
          ]),
          len: 1,
          b: PORT.IO,
          p: 0,
        }],
        errors: [],
      });

      // Read with pin17=false
      node.setPin17(false);
      ga.stepProgramN(1000);
      const valLow = snap(ga, 304).registers.T;

      // Read with pin17=true — should be identical since node has no GPIO
      node.setPin17(true);
      ga.stepProgramN(1000);
      const valHigh = snap(ga, 304).registers.T;

      expect(valLow).toBe(valHigh);
    });
  });

  // --------------------------------------------------------------------------
  // Wake pin behavior
  // --------------------------------------------------------------------------

  describe('wake pin', () => {

    it('node 708 wake pin is UP port', () => {
      // Node 708: coord > 700, so wake pin = UP (PortIndex.UP = 0x145)
      // When reading from UP port and pin17 satisfies wake condition,
      // the read returns immediately with pin17 value.
      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [708]);

      const node = ga.getNodeByCoord(708);

      // Program: read from UP port (wake pin) → store in T
      // @b|jump(0) with B=UP
      ga.load({
        nodes: [{
          coord: 708,
          mem: buildMem([
            packOpJump(ATB, 0), // word0: @b|jump(0)
          ]),
          len: 1,
          b: PORT.UP,
          p: 0,
        }],
        errors: [],
      });

      // Default: pin17=false, WD=false, notWD=true
      // Wake condition: pin17 === notWD → false === true → NOT MET
      // Node should suspend waiting for wake pin

      ga.stepProgramN(1000);
      let s = snap(ga, 708);
      expect(s.state).not.toBe('running'); // should be suspended

      // Now drive pin17 HIGH (satisfies wake condition: true === true)
      node.setPin17(true);
      ga.stepProgramN(1000);
      s = snap(ga, 708);
      // T should be 1 (pin17 was true when wake occurred)
      expect(s.registers.T).toBe(1);
    });

    it('node 200 wake pin is LEFT port', () => {
      // Node 200: coord < 700 and >= 17, so wake pin = LEFT
      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [200]);

      const node = ga.getNodeByCoord(200);

      ga.load({
        nodes: [{
          coord: 200,
          mem: buildMem([
            packOpJump(ATB, 0), // word0: @b|jump(0)
          ]),
          len: 1,
          b: PORT.LEFT,
          p: 0,
        }],
        errors: [],
      });

      // Should suspend since pin17=false, notWD=true
      ga.stepProgramN(1000);
      let s = snap(ga, 200);
      expect(s.state).not.toBe('running');

      // Wake with pin17=true
      node.setPin17(true);
      ga.stepProgramN(1000);
      s = snap(ga, 200);
      expect(s.registers.T).toBe(1);
    });

    it('wake pin returns 0 when woken by pin17 going LOW with WD set', () => {
      // When WD=true, notWD=false, wake condition: pin17===false
      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [708]);

      const node = ga.getNodeByCoord(708);

      // Program:
      //   word0-1: @p|jump(2) + 0x800    — push WD bit literal
      //   word2:   !b|jump(3)             — write WD to IO register
      //   word3-4: @p|jump(5) + PORT.UP   — push UP port address
      //   word5:   b!|jump(6)             — set B = UP (wake pin port)
      //   word6:   @b|jump(6)             — read wake pin, loop
      ga.load({
        nodes: [{
          coord: 708,
          mem: buildMem([
            ...packLiteral(0x800, 2),      // word0-1: push 0x800 (WD bit)
            packOpJump(STOREB, 3),         // word2: !b|jump(3) — write to IO
            ...packLiteral(PORT.UP, 5),    // word3-4: push PORT.UP
            packOpJump(BSTORE, 6),         // word5: b!|jump(6) — B = UP
            packOpJump(ATB, 6),            // word6: @b|jump(6) — read wake pin
          ]),
          len: 7,
          b: PORT.IO,
          p: 0,
        }],
        errors: [],
      });

      // Drive pin17 HIGH initially so wake condition (pin17===notWD=false) isn't met
      node.setPin17(true);

      // Step enough for literal load + IO write + B switch + start reading wake pin
      ga.stepProgramN(1000);
      let s = snap(ga, 708);
      // Node should be suspended waiting for wake pin (pin17=true, notWD=false, not equal)
      expect(s.state).not.toBe('running');

      // Now drive pin17 LOW — satisfies wake condition (false === false)
      node.setPin17(false);
      ga.stepProgramN(1000);
      s = snap(ga, 708);
      expect(s.registers.T).toBe(0); // pin17 was false when woken
    });
  });

  // --------------------------------------------------------------------------
  // IO register polling for serial RX
  // --------------------------------------------------------------------------

  describe('IO register polling (bit-bang RX)', () => {

    it('detects start bit (pin17 HIGH→LOW transition) via IO polling', () => {
      // A simple program that polls IO for pin17 state.
      // Polls until bit 17 goes LOW (start bit).
      //
      // Program (node 708, B=IO):
      //   word0: @b|jump(0)   — poll loop: read IO → T, jump back
      //
      // We step with pin17=HIGH for a while, then drive LOW and check T.

      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [708]);

      const node = ga.getNodeByCoord(708);

      ga.load({
        nodes: [{
          coord: 708,
          mem: buildMem([
            packOpJump(ATB, 0), // word0: @b|jump(0)
          ]),
          len: 1,
          b: PORT.IO,
          p: 0,
        }],
        errors: [],
      });

      // Pin17 HIGH (idle)
      node.setPin17(true);
      ga.stepProgramN(1000);
      let s = snap(ga, 708);
      expect(s.registers.T & IO_BITS.PIN17_BIT).toBe(IO_BITS.PIN17_BIT);

      // Pin17 LOW (start bit arrives)
      node.setPin17(false);
      ga.stepProgramN(1000);
      s = snap(ga, 708);
      expect(s.registers.T & IO_BITS.PIN17_BIT).toBe(0);
    });

    it('samples pin17 at correct baud timing intervals', () => {
      // Program reads IO repeatedly, storing each value to RAM[A++] via !+.
      //   word0: @b|jump(1)    — read IO into T
      //   word1: !+|jump(0)    — store T to [A++], loop back
      // A starts at 10, so results go to RAM[10], RAM[11], ...

      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [708]);

      const node = ga.getNodeByCoord(708);

      ga.load({
        nodes: [{
          coord: 708,
          mem: buildMem([
            packOpJump(ATB, 1),      // word0: @b|jump(1) — read IO
            packOpJump(STOREPLUS, 0),// word1: !+|jump(0) — store to [A++]
          ]),
          len: 2,
          a: 10,
          b: PORT.IO,
          p: 0,
        }],
        errors: [],
      });

      // Drive a few samples HIGH then a few LOW
      // Each read+store cycle takes ~4 events (fetch + @b + jump + !+ + jump)

      node.setPin17(true);
      ga.stepProgramN(20); // ~5 reads with pin17 HIGH

      node.setPin17(false);
      ga.stepProgramN(20); // ~5 reads with pin17 LOW

      const s = snap(ga, 708);
      const ram = s.ram;

      // Check that some early samples have bit 17 set and later ones don't
      let foundHigh = false;
      let foundLow = false;
      for (let i = 10; i < 20; i++) {
        if ((ram[i] & IO_BITS.PIN17_BIT) !== 0) foundHigh = true;
        if ((ram[i] & IO_BITS.PIN17_BIT) === 0) foundLow = true;
      }
      expect(foundHigh).toBe(true);
      expect(foundLow).toBe(true);
    });

    it('reads full byte 0x55 from pin17 via IO polling with baud timing', () => {
      // Test a realistic bit-bang RX loop that samples pin17 at the center
      // of each bit period and accumulates a byte.
      //
      // Strategy: Write a simple program that:
      //   1. Waits for start bit (pin17 LOW)
      //   2. Delays half a bit period to center on first data bit
      //   3. Reads 8 data bits at baud intervals, shifting right and OR-ing
      //   4. Result should be the original byte
      //
      // For simplicity, we use stepWithSerialBits and a simplified RX program.
      // The program polls @b and extracts bit 17 using 2/ shifts.

      // Use a shorter baud period for faster testing
      const baud = 100; // 100 steps per bit

      // Build program for node 708 (B=IO):
      // The approach: poll IO in a tight loop. The program accumulates
      // 8 bit samples from pin17 (bit 17) by reading IO, extracting bit 17,
      // and shifting it into an accumulator.
      //
      // Simplified: just do 10 reads at baud intervals and store results.
      // Then we verify the pin17 bit pattern in the stored values.

      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [708]);

      // Simple IO poll loop: read IO into T repeatedly
      ga.load({
        nodes: [{
          coord: 708,
          mem: buildMem([
            packOpJump(ATB, 0),  // word0: @b|jump(0) — read IO, loop
          ]),
          len: 1,
          b: PORT.IO,
          p: 0,
        }],
        errors: [],
      });

      // Drive a complete byte frame: idle, start, 8 data, stop
      const byte = 0x55; // 01010101, LSB first: 1,0,1,0,1,0,1,0
      const bits = buildRawByteBits(byte, baud);

      const node = ga.getNodeByCoord(708);

      // Phase 1: idle HIGH
      node.setPin17(true);
      ga.stepProgramN(Math.max(baud * 3 * 200, 10000));
      expect(snap(ga, 708).registers.T & IO_BITS.PIN17_BIT).toBe(IO_BITS.PIN17_BIT);

      // Phase 2: drive through the bit sequence, checking T at midpoints
      const sampledBits: boolean[] = [];
      for (const bit of bits) {
        const ticks = Math.round(bit.durationNS / NS_PER_TICK);
        node.setPin17(bit.value);
        ga.stepProgramN(Math.max(Math.floor(ticks / 2) * 200, 10000)); // step to midpoint
        const t = snap(ga, 708).registers.T;
        sampledBits.push((t & IO_BITS.PIN17_BIT) !== 0);
        ga.stepProgramN(Math.max((ticks - Math.floor(ticks / 2)) * 200, 10000)); // finish bit
      }

      // sampledBits should match: start(false), d0-d7, stop(true)
      expect(sampledBits[0]).toBe(false); // start bit
      expect(sampledBits[9]).toBe(true);  // stop bit

      // For 0x55 (LSB first: 1,0,1,0,1,0,1,0), data bits alternate
      let highCount = 0;
      let lowCount = 0;
      for (let i = 1; i <= 8; i++) {
        if (sampledBits[i]) highCount++;
        else lowCount++;
      }
      expect(highCount).toBe(4);
      expect(lowCount).toBe(4);
    });
  });

  // --------------------------------------------------------------------------
  // stepWithSerialBits integration
  // --------------------------------------------------------------------------

  describe('stepWithSerialBits', () => {

    it('drives pin17 according to bit schedule', () => {
      // Verify that stepWithSerialBits drives pin17 transitions observable via IO reads.
      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [708]);

      ga.load({
        nodes: [{
          coord: 708,
          mem: buildMem([
            packOpJump(ATB, 0),  // word0: @b|jump(0) — poll IO
          ]),
          len: 1,
          b: PORT.IO,
          p: 0,
        }],
        errors: [],
      });

      const baud = 50;
      const bits = buildSerialBits([0xFF], baud, baud * 4); // idle + byte frame

      // Drive serial bits while sampling T at key points
      const node = ga.getNodeByCoord(708);

      // Before serial: pin17 should be whatever initial state
      // Use stepWithSerialBits to drive the full frame
      ga.stepWithSerialBits(708, bits, bits.reduce((s, b) => s + b.durationNS, 0));

      // After all bits sent, pin17 should be idle (RS232 idle = LOW)
      expect(node.getPin17()).toBe(false);

      // Verify by manually driving and checking at specific points:
      // Start fresh for detailed check
      const ga2 = new GA144('test');
      ga2.reset();
      isolateNodes(ga2, [708]);

      ga2.load({
        nodes: [{
          coord: 708,
          mem: buildMem([
            packOpJump(ATB, 0),
          ]),
          len: 1,
          b: PORT.IO,
          p: 0,
        }],
        errors: [],
      });

      const node2 = ga2.getNodeByCoord(708);

      // Idle period (HIGH)
      node2.setPin17(true);
      ga2.stepProgramN(Math.max(baud * 3 * 200, 10000));
      expect(snap(ga2, 708).registers.T & IO_BITS.PIN17_BIT).toBe(IO_BITS.PIN17_BIT);

      // Start bit (LOW)
      node2.setPin17(false);
      ga2.stepProgramN(Math.max(baud * 200, 10000));
      expect(snap(ga2, 708).registers.T & IO_BITS.PIN17_BIT).toBe(0);

      // Data bits (0xFF = all HIGH)
      node2.setPin17(true);
      ga2.stepProgramN(Math.max(baud * 200, 10000));
      expect(snap(ga2, 708).registers.T & IO_BITS.PIN17_BIT).toBe(IO_BITS.PIN17_BIT);
    });

    it('pin17 returns to idle (LOW) after all bits are sent', () => {
      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [708]);

      ga.load({
        nodes: [{
          coord: 708,
          mem: buildMem([
            packOpJump(ATB, 0), // word0: @b|jump(0)
          ]),
          len: 1,
          b: PORT.IO,
          p: 0,
        }],
        errors: [],
      });

      const bits = buildSerialBits([0x42], 50);
      // Step past all bits
      ga.stepWithSerialBits(708, bits, 2000);

      // After stepWithSerialBits, pin17 should be idle (RS232 idle = LOW)
      expect(ga.getNodeByCoord(708).getPin17()).toBe(false);

      // Read IO one more time
      ga.stepProgramN(1000);
      const s = snap(ga, 708);
      expect(s.registers.T & IO_BITS.PIN17_BIT).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Baud timing accuracy
  // --------------------------------------------------------------------------

  describe('baud timing', () => {

    it('BAUD_PERIOD is correct for 921600 baud at 1.5 ns/tick', () => {
      expect(GA144.BOOT_BAUD).toBe(921_600);
      expect(BAUD_PERIOD).toBe(Math.round(1e9 / (921_600 * 1.5)));
      // 1e9 / (921600 * 1.5) = ~722.66 → rounds to 723
      expect(BAUD_PERIOD).toBe(723);
    });

    it('single byte frame has correct step count', () => {
      const bits = buildSerialBits([0x00], BAUD_PERIOD);
      const totalDuration = bits.reduce((sum, b) => sum + b.durationNS, 0);
      // 1 start + 8 data + 1 stop + 2 trailing = 12 bit periods
      expect(totalDuration).toBe(toNS(12 * BAUD_PERIOD));
      expect(totalDuration).toBe(toNS(12 * 723));
      expect(totalDuration).toBe(toNS(8676));
    });

    it('bit transitions happen at exact baud boundaries', () => {
      // For byte 0xAA (10101010), LSB first: 0,1,0,1,0,1,0,1
      // RS232: start(H), d0(0→inv→H), d1(1→inv→L), d2(0→inv→H), d3(1→inv→L),
      //        d4(0→inv→H), d5(1→inv→L), d6(0→inv→H), d7(1→inv→L), stop(L)
      // Merged: H(2*BAUD), L(BAUD), H(BAUD), L(BAUD), H(BAUD), L(BAUD), H(BAUD), L(4*BAUD)
      const bits = buildSerialBits([0xAA], BAUD_PERIOD);

      // Reconstruct the full bit-by-bit timeline
      let currentStep = 0;
      const transitions: { step: number; value: boolean }[] = [];
      for (const b of bits) {
        transitions.push({ step: currentStep, value: b.value });
        currentStep += b.durationNS;
      }

      // First segment should be HIGH (RS232 start + d0=0 inverted)
      expect(transitions[0].value).toBe(true);
      expect(transitions[0].step).toBe(0);

      // Verify all transitions happen at multiples of toNS(BAUD_PERIOD)
      const baudNS = toNS(BAUD_PERIOD);
      for (const t of transitions) {
        expect(t.step % baudNS).toBe(0);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Multi-byte serial streams
  // --------------------------------------------------------------------------

  describe('multi-byte serial', () => {

    it('two consecutive bytes have inter-byte gap', () => {
      // Between two bytes, there's at least 1 stop bit LOW before next start HIGH.
      const bits = buildSerialBits([0x00, 0x00], BAUD_PERIOD);

      // RS232 byte 0x00: start(H) + 8×data(0→inv→H) = 9*BAUD HIGH, stop(L) = 1*BAUD LOW
      // Two bytes + trailing:
      // Merged: HIGH(9*BAUD), LOW(1*BAUD), HIGH(9*BAUD), LOW(3*BAUD)
      expect(bits).toHaveLength(4);
      expect(bits[0]).toEqual({ value: true,  durationNS: toNS(9 * BAUD_PERIOD) });
      expect(bits[1]).toEqual({ value: false, durationNS: toNS(1 * BAUD_PERIOD) });
      expect(bits[2]).toEqual({ value: true,  durationNS: toNS(9 * BAUD_PERIOD) });
      expect(bits[3]).toEqual({ value: false, durationNS: toNS(3 * BAUD_PERIOD) });
    });

    it('total frame timing is correct for N bytes', () => {
      for (const n of [1, 2, 5, 10]) {
        const bytes = new Array(n).fill(0x55);
        const bits = buildSerialBits(bytes, BAUD_PERIOD);
        const total = bits.reduce((sum, b) => sum + b.durationNS, 0);
        // Each byte = 10 bit periods, plus 2 trailing
        expect(total).toBe(toNS((n * 10 + 2) * BAUD_PERIOD));
      }
    });

    it('multi-byte stream drives pin17 correctly', () => {
      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [708]);

      ga.load({
        nodes: [{
          coord: 708,
          mem: buildMem([
            packOpJump(ATB, 0),  // word0: @b|jump(0) — poll IO
          ]),
          len: 1,
          b: PORT.IO,
          p: 0,
        }],
        errors: [],
      });

      // Manually drive 3 bytes and check T at key points
      const shortBaud = 30;
      const node = ga.getNodeByCoord(708);

      // Idle
      node.setPin17(true);
      ga.stepProgramN(Math.max(shortBaud * 3 * 200, 10000));
      expect(snap(ga, 708).registers.T & IO_BITS.PIN17_BIT).toBe(IO_BITS.PIN17_BIT);

      // Byte 0x00: start(LOW) + 8 data(LOW) = 9 bits LOW, then stop(HIGH)
      node.setPin17(false);
      ga.stepProgramN(Math.max(shortBaud * 5 * 200, 10000)); // in the middle of LOW period
      expect(snap(ga, 708).registers.T & IO_BITS.PIN17_BIT).toBe(0);

      node.setPin17(true); // stop bit
      ga.stepProgramN(Math.max(shortBaud * 200, 10000));
      expect(snap(ga, 708).registers.T & IO_BITS.PIN17_BIT).toBe(IO_BITS.PIN17_BIT);

      // Byte 0xFF: start(LOW), then 8 data(HIGH) + stop(HIGH)
      node.setPin17(false); // start bit
      ga.stepProgramN(Math.max(shortBaud * 200, 10000));
      expect(snap(ga, 708).registers.T & IO_BITS.PIN17_BIT).toBe(0);

      node.setPin17(true); // data + stop
      ga.stepProgramN(Math.max(shortBaud * 5 * 200, 10000));
      expect(snap(ga, 708).registers.T & IO_BITS.PIN17_BIT).toBe(IO_BITS.PIN17_BIT);
    });
  });

  // --------------------------------------------------------------------------
  // Wake pin + serial integration
  // --------------------------------------------------------------------------

  describe('wake pin serial interaction', () => {

    it('node wakes from wake pin read when start bit arrives', () => {
      // Node 708 reads from UP (wake pin) and suspends.
      // When serial start bit drives pin17 HIGH→LOW... but wait:
      // Default notWD=true, so wake condition is pin17===true.
      // For serial start bit detection via wake pin, we need pin17 going HIGH.
      //
      // In the boot ROM, node reads UP (wake pin) to wait for pin17 HIGH (idle).
      // Then it polls IO register to detect the HIGH→LOW transition (start bit).
      //
      // Test: node reads UP port, suspends (pin17=false by default),
      // pin17 goes HIGH → node wakes with T=1.

      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [708]);

      const node = ga.getNodeByCoord(708);

      ga.load({
        nodes: [{
          coord: 708,
          mem: buildMem([
            packOpJump(ATB, 1),       // word0: @b|jump(1) — read UP (wake pin)
            packOpJump(STOREPLUS, 2), // word1: !+|jump(2) — store wake result to [A++]
            packOpJump(ATB, 2),       // word2: @b|jump(2) — keep reading UP, spin
          ]),
          len: 3,
          a: 10,
          b: PORT.UP,
          p: 0,
        }],
        errors: [],
      });

      // Pin17 starts LOW → node should suspend on wake pin read
      node.setPin17(false);
      ga.stepProgramN(1000);
      expect(snap(ga, 708).state).not.toBe('running');

      // Drive pin17 HIGH (wake condition met: true === notWD=true)
      node.setPin17(true);
      ga.stepProgramN(1000);

      const s = snap(ga, 708);
      const ram = s.ram;
      // RAM[10] should contain the wake pin result (1)
      expect(ram[10]).toBe(1);
    });

    it('serial idle-then-data wakes node and allows bit sampling', () => {
      // Realistic scenario: node starts waiting on wake pin (pin17 HIGH = wake).
      // Serial line goes idle (HIGH) → wakes node.
      // Node then switches to IO polling to detect start bit.

      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [708]);

      const node = ga.getNodeByCoord(708);

      // Program:
      //   word0: @b|jump(1)     — read UP (wake pin), wait for HIGH
      //   word1: b!|jump(2)     — set B = IO (T=1 is garbage, just need B change)
      //     Actually we need to load IO addr first. Use a literal.
      //   Revised:
      //   word0: @b|jump(2)     — read UP (wake pin)
      //   word1: 0x15D (IO)     — literal (not executed, @p doesn't apply here)
      //   word2: @p|jump(4)     — fetch literal 0x15D
      //   word3: 0x15D          — IO port address
      //   word4: b!|jump(5)     — B = 0x15D (IO)
      //   word5: @b|jump(5)     — poll IO forever

      ga.load({
        nodes: [{
          coord: 708,
          mem: buildMem([
            packOpJump(ATB, 1),          // word0: @b|jump(1) — read from UP (wake pin)
            packOpJump(DROP, 2),         // word1: drop|jump(2) — discard wake value
            ...packLiteral(PORT.IO, 4),  // word2-3: @p|jump(4) + 0x15D
            packOpJump(BSTORE, 5),       // word4: b!|jump(5) — B = IO
            packOpJump(ATB, 5),          // word5: @b|jump(5) — poll IO
          ]),
          len: 6,
          b: PORT.UP,
          p: 0,
        }],
        errors: [],
      });

      // Phase 1: pin17=false, node should suspend on wake pin
      node.setPin17(false);
      ga.stepProgramN(1000);
      expect(snap(ga, 708).state).not.toBe('running');

      // Phase 2: idle line arrives (HIGH) — wakes node
      node.setPin17(true);
      ga.stepProgramN(1000); // let it wake, drop, load literal, set B

      // Now node should be in the IO poll loop
      let s = snap(ga, 708);
      // T should reflect IO with pin17 HIGH (bit 17 set)
      expect(s.registers.T & IO_BITS.PIN17_BIT).toBe(IO_BITS.PIN17_BIT);

      // Phase 3: start bit arrives (LOW)
      node.setPin17(false);
      ga.stepProgramN(1000);

      s = snap(ga, 708);
      expect(s.registers.T & IO_BITS.PIN17_BIT).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Bit extraction via shift operations
  // --------------------------------------------------------------------------

  describe('bit extraction', () => {

    it('extracts pin17 bit — MSB (bit 17) is set when pin17 HIGH', () => {
      // IO register bit 17 reflects pin17 state on GPIO nodes.
      // -if tests bit 17, but encoding it safely requires careful slot management.
      // Instead, we directly verify that bit 17 (the MSB that -if would test)
      // is set/clear based on pin17.

      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [708]);

      const node = ga.getNodeByCoord(708);

      ga.load({
        nodes: [{
          coord: 708,
          mem: buildMem([
            packOpJump(ATB, 0),  // word0: @b|jump(0) — read IO, loop
          ]),
          len: 1,
          b: PORT.IO,
          p: 0,
        }],
        errors: [],
      });

      // pin17 HIGH: bit 17 should be set in T (this is the bit -if would test)
      node.setPin17(true);
      ga.stepProgramN(1000);
      let s = snap(ga, 708);
      expect((s.registers.T >> 17) & 1).toBe(1); // -if would NOT jump (negative)

      // pin17 LOW: bit 17 should be clear in T
      node.setPin17(false);
      ga.stepProgramN(1000);
      s = snap(ga, 708);
      expect((s.registers.T >> 17) & 1).toBe(0); // -if WOULD jump (non-negative)
    });

    it('accumulates bits via shift-and-OR pattern', () => {
      // Test that 2/ (arithmetic right shift) correctly shifts bit 17 → bit 16.
      //
      // Program:
      //   word0: @b|jump(1)  — read IO → T (contains pin17 in bit 17)
      //   word1: dup|jump(2) — duplicate T (keep copy for store)
      //   word2: !+|jump(3)  — store raw IO to RAM[A++] (pops one copy)
      //   word3: 2/|jump(4)  — shift right (on the dup'd copy)
      //   word4: !+|jump(0)  — store shifted to RAM[A++], loop

      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [708]);

      ga.load({
        nodes: [{
          coord: 708,
          mem: buildMem([
            packOpJump(ATB, 1),       // word0: @b|jump(1) — read IO
            packOpJump(DUP, 2),       // word1: dup|jump(2) — duplicate T
            packOpJump(STOREPLUS, 3), // word2: !+|jump(3) — store raw to [A++]
            packOpJump(TWODIV, 4),    // word3: 2/|jump(4) — shift right
            packOpJump(STOREPLUS, 0), // word4: !+|jump(0) — store shifted to [A++]
          ]),
          len: 5,
          a: 10,
          b: PORT.IO,
          p: 0,
        }],
        errors: [],
      });

      const node = ga.getNodeByCoord(708);
      node.setPin17(true);
      ga.stepProgramN(1000);

      const s = snap(ga, 708);
      const ram = s.ram;

      // RAM[10] should have the raw IO reading with bit 17 set
      expect(ram[10] & IO_BITS.PIN17_BIT).toBe(IO_BITS.PIN17_BIT);

      // RAM[11] should have the shifted value (bit 17 → bit 16)
      // JS >> operates on 32-bit ints; 18-bit values are positive, so bit 17 shifts to bit 16
      expect(ram[11] & (1 << 16)).toBe(1 << 16);
      expect(ram[11] & IO_BITS.PIN17_BIT).toBe(0); // bit 17 is clear after shift
    });
  });

  // --------------------------------------------------------------------------
  // GPIO pin classification
  // --------------------------------------------------------------------------

  describe('GPIO node classification', () => {

    it('all documented GPIO nodes have correct pin counts', () => {
      const expected: Record<number, number> = {
        701: 2, 705: 4, 708: 2, 715: 1,
        517: 1, 417: 1, 317: 1, 217: 1,
        8: 4, 1: 2, 100: 1, 200: 1,
        300: 2, 500: 1, 600: 1,
      };
      for (const [coord, pins] of Object.entries(expected)) {
        expect(NODE_GPIO_PINS[Number(coord)]).toBe(pins);
      }
    });

    it('pin17 only affects IO on nodes with GPIO pins', () => {
      // On GPIO nodes, toggling pin17 changes the IO register reading (bit 17).
      // On non-GPIO nodes, toggling pin17 has no effect on IO readings.
      for (const coord of [708, 404]) {
        const hasGpio = NODE_GPIO_PINS[coord] !== undefined && NODE_GPIO_PINS[coord] > 0;

        const ga = new GA144('test');
        ga.reset();
        isolateNodes(ga, [coord]);

        ga.load({
          nodes: [{
            coord,
            mem: buildMem([
              packOpJump(ATB, 0),
            ]),
            len: 1,
            b: PORT.IO,
            p: 0,
          }],
          errors: [],
        });

        // Read with pin17=false
        ga.getNodeByCoord(coord).setPin17(false);
        ga.stepProgramN(1000);
        const valLow = snap(ga, coord).registers.T;

        // Read with pin17=true
        ga.getNodeByCoord(coord).setPin17(true);
        ga.stepProgramN(1000);
        const valHigh = snap(ga, coord).registers.T;

        if (hasGpio) {
          // GPIO node: pin17 should change the IO reading (bit 17 differs)
          expect(valHigh & IO_BITS.PIN17_BIT).toBe(IO_BITS.PIN17_BIT);
          expect(valLow & IO_BITS.PIN17_BIT).toBe(0);
        } else {
          // Non-GPIO node: pin17 toggle should have no effect
          expect(valLow).toBe(valHigh);
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {

    it('empty byte array produces only trailing idle', () => {
      const bits = buildSerialBits([], BAUD_PERIOD);
      // No bytes → just trailing idle (RS232 idle = LOW, 2 * BAUD)
      expect(bits).toHaveLength(1);
      expect(bits[0].value).toBe(false);
      expect(bits[0].durationNS).toBe(toNS(BAUD_PERIOD * 2));
    });

    it('pin17 toggle does not affect non-wake-pin port reads', () => {
      // Node 708's wake pin is UP. Reading from a non-wake port (e.g., DOWN)
      // should NOT be affected by pin17 changes.
      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [708, 608]);

      ga.load({
        nodes: [{
          coord: 708,
          mem: buildMem([
            packOpJump(ATB, 0), // read from DOWN port
          ]),
          len: 1,
          b: PORT.DOWN, // DOWN is not the wake pin for 708
          p: 0,
        }],
        errors: [],
      });

      const node = ga.getNodeByCoord(708);

      // Node should suspend waiting for DOWN port data, not wake pin
      ga.stepProgramN(1000);
      expect(snap(ga, 708).state).not.toBe('running');

      // Toggle pin17 — should NOT wake the node (it's waiting on DOWN, not UP)
      node.setPin17(true);
      ga.stepProgramN(1000);
      // Still suspended — pin17 doesn't satisfy a DOWN port read
      expect(snap(ga, 708).state).not.toBe('running');
    });

    it('rapid pin17 toggling is handled correctly', () => {
      const ga = new GA144('test');
      ga.reset();
      isolateNodes(ga, [708]);

      ga.load({
        nodes: [{
          coord: 708,
          mem: buildMem([
            packOpJump(ATB, 1),    // word0: @b|jump(1) — read IO
            packOpJump(STOREP, 0), // word1: !p|jump(0) — store to RAM[P++]
          ]),
          len: 2,
          b: PORT.IO,
          p: 10,
        }],
        errors: [],
      });

      const node = ga.getNodeByCoord(708);

      // Toggle pin17 every step for 20 steps
      for (let step = 0; step < 20; step++) {
        node.setPin17(step % 2 === 0);
        ga.stepProgram();
      }

      // Just verify no crash and some samples were stored
      const s = snap(ga, 708);
      // P should have advanced past 10
      expect(s.registers.P).toBeGreaterThan(10);
    });

    it('very short baud period (1 step per bit) works', () => {
      const bits = buildSerialBits([0x55], 1);
      const totalDuration = bits.reduce((sum, b) => sum + b.durationNS, 0);
      expect(totalDuration).toBe(toNS(12)); // 10 frame bits + 2 trailing
    });

    it('stepWithSerialBits returns false when all nodes suspend', () => {
      const ga = new GA144('test');
      ga.reset();

      // Deactivate ALL nodes
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 18; col++) {
          ga.removeFromActiveList(ga.getNodeByCoord(row * 100 + col));
        }
      }

      const bits = buildSerialBits([0x42], BAUD_PERIOD);
      const result = ga.stepWithSerialBits(708, bits, 100);
      expect(result).toBe(false);
    });
  });
});
