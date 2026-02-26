/**
 * ECHO2 sample end-to-end test: compile ECHO2.cube, boot via serial,
 * send bytes, and verify they are echoed back as tagged IO writes.
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
import { readIoWrite, taggedCoord, taggedValue } from '../ui/emulator/vgaResolution';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ECHO_DATA_TAG = 0x20000;

function extractEchoedBytes(snap: {
  ioWrites: number[];
  ioWriteStart: number;
  ioWriteCount: number;
}): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < snap.ioWriteCount; i++) {
    const tagged = readIoWrite(snap.ioWrites, snap.ioWriteStart, i);
    const coord = taggedCoord(tagged);
    if (coord !== 708) continue;
    const raw = taggedValue(tagged);
    if (raw & ECHO_DATA_TAG) {
      bytes.push(raw & 0xFF);
    }
  }
  return bytes;
}

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

    const snap = ga.getSnapshot();
    const echoed = extractEchoedBytes(snap);

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

    const snap = ga.getSnapshot();
    const echoed = extractEchoedBytes(snap);

    expect(echoed.length).toBeGreaterThanOrEqual(3);
    expect(echoed[0]).toBe(0x61);
    expect(echoed[1]).toBe(0x62);
    expect(echoed[2]).toBe(0x63);
  });
});
