/**
 * ECHO2 sample end-to-end test: compile ECHO2.cube, boot via serial,
 * send bytes, and verify they are echoed back via pin1 serial output.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GA144 } from './ga144';
import { SerialBits } from './serial';
import { ROM_DATA } from './rom-data';
import { compileCube } from './cube';
import { buildBootStream } from './bootstream';
import { disassembleWord } from './disassembler';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Boot GA144 with ECHO2, wait for user code, return ready GA144 */
function bootEcho2() {
  const source = readFileSync(join(__dirname, '../../samples/ECHO2.cube'), 'utf-8');
  const compiled = compileCube(source);
  if (compiled.errors.length > 0) throw new Error(compiled.errors[0].message);

  const ga = new GA144('test');
  ga.setRomData(ROM_DATA);
  ga.reset();
  ga.enqueueSerialBits(708, SerialBits.bootStreamBits(
    Array.from(buildBootStream(compiled.nodes).bytes), GA144.BOOT_BAUD));

  const node708 = ga.getNodeByCoord(708);
  let started = false;
  node708.onFirstRamInstruction = () => { started = true; };

  for (let i = 0; i < 1000 && !started; i++) ga.stepUntilDone(100_000);
  if (!started) throw new Error('User code never started');
  ga.stepUntilDone(10_000);

  return { ga, compiled };
}

describe('ECHO2 sample: serial echo via raw assembly', () => {

  it('ECHO2.cube compiles to a single node 708', () => {
    const source = readFileSync(join(__dirname, '../../samples/ECHO2.cube'), 'utf-8');
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.nodes).toHaveLength(1);
    expect(compiled.nodes[0].coord).toBe(708);
    expect(compiled.nodes[0].len).toBeLessThanOrEqual(64);
  });

  it('echoes back serial input bytes', { timeout: 30_000 }, () => {
    const { ga } = bootEcho2();

    // Send bytes one at a time — ECHO2 is half-duplex, so it needs to
    // finish echoing each byte before the next one arrives on the wire.
    const testBytes = [0x41, 0x42, 0x48]; // 'A', 'B', 'H'
    for (const b of testBytes) {
      ga.sendSerialInput([b]);
      ga.stepUntilDone(5_000_000); // enough for RX + TX + gap
    }

    const echoed = ga.decodeSerialOutput(708);

    expect(echoed.length).toBeGreaterThanOrEqual(testBytes.length);
    for (let i = 0; i < testBytes.length; i++) {
      expect(echoed[i]).toBe(testBytes[i]);
    }
  });

  it('echoes multiple batches of input', { timeout: 30_000 }, () => {
    const { ga } = bootEcho2();

    // Send each byte individually with processing time between
    for (const b of [0x61, 0x62, 0x63]) { // 'a', 'b', 'c'
      ga.sendSerialInput([b]);
      ga.stepUntilDone(5_000_000);
    }

    const echoed = ga.decodeSerialOutput(708);

    expect(echoed.length).toBeGreaterThanOrEqual(3);
    expect(echoed[0]).toBe(0x61);
    expect(echoed[1]).toBe(0x62);
    expect(echoed[2]).toBe(0x63);
  });

  it('no slot-2 address overflow in compiled binary', () => {
    const source = readFileSync(join(__dirname, '../../samples/ECHO2.cube'), 'utf-8');
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const node = compiled.nodes[0];
    // Verify no call/jump in slot 2 has a truncated address
    for (let i = 0; i < node.len; i++) {
      const raw = node.mem[i];
      if (raw === null || raw === undefined) continue;
      const dis = disassembleWord(raw);
      const slot2 = dis.slots[2];
      if (slot2 && slot2.address !== undefined) {
        // Slot 2 only has 3-bit address field (0-7)
        expect(slot2.address).toBeLessThanOrEqual(7);
      }
    }
  });

  it('ioWritesToBits produces correct pin drive transitions', { timeout: 30_000 }, () => {
    const { ga } = bootEcho2();

    ga.sendSerialInput([0x41]);
    ga.stepUntilDone(5_000_000);

    const bits = ga.ioWritesToBits(708);
    // emit8 sends 10 bits (start + 8 data + stop), producing multiple transitions
    expect(bits.length).toBeGreaterThan(0);

    const decoded = ga.decodeSerialOutput(708);
    expect(decoded.length).toBeGreaterThanOrEqual(1);
    expect(decoded[0]).toBe(0x41);
  });

  it('disassemble compiled binary', () => {
    const source = readFileSync(join(__dirname, '../../samples/ECHO2.cube'), 'utf-8');
    const compiled = compileCube(source);
    expect(compiled.errors).toHaveLength(0);

    const node = compiled.nodes[0];
    console.log(`Node ${node.coord}: ${node.len} words, b=${node.b?.toString(16)}, p=${node.p}`);

    for (let i = 0; i < node.len; i++) {
      const raw = node.mem[i];
      if (raw === null || raw === undefined) {
        console.log(`  [${i.toString().padStart(2)}] <null>`);
        continue;
      }
      const dis = disassembleWord(raw);
      const slots = dis.slots
        .filter((s: any) => s !== null)
        .map((s: any) => {
          let str = s.opcode;
          if (s.address !== undefined) str += `(${s.address})`;
          return str;
        })
        .join(' ');
      console.log(`  [${i.toString().padStart(2)}] 0x${raw.toString(16).padStart(5, '0')}  ${slots}`);
    }
  });

  it('check serial output bits', { timeout: 30_000 }, () => {
    const { ga } = bootEcho2();

    ga.sendSerialInput([0x41]);
    ga.stepUntilDone(5_000_000);

    const bits = ga.ioWritesToBits(708);
    console.log('Bit segments:', bits.length);
    for (const b of bits) {
      console.log(`  ${b.value ? 'HIGH' : 'LOW'}: ${b.durationNS.toFixed(0)} ns`);
    }

    const decoded = ga.decodeSerialOutput(708);
    console.log('Decoded:', decoded.length, 'bytes:', decoded.map(b => `0x${b.toString(16)}`));

    // Raw IO writes
    const snap = ga.getSnapshot(708);
    let count708lo = 0;
    const vals: string[] = [];
    for (let i = 0; i < snap.ioWriteCount; i++) {
      const pos = (snap.ioWriteStart + i) % snap.ioWrites.length;
      const tagged = snap.ioWrites[pos];
      const coord = (tagged / 0x40000) | 0;
      const val = tagged & 0x3FFFF;
      if (coord === 708 && val <= 3) {
        count708lo++;
        if (vals.length < 30) vals.push(`${val}`);
      }
    }
    console.log('Pin drive writes:', count708lo, 'values:', vals.join(', '));
  });
});
