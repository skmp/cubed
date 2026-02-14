/**
 * Shared CodeBuilder for F18A instruction word packing.
 * Used by both the arrayForth assembler and the CUBE compiler.
 *
 * F18A instruction word format (18 bits):
 *   Slot 0: bits 17-13 (5 bits)
 *   Slot 1: bits 12-8  (5 bits)
 *   Slot 2: bits 7-3   (5 bits)
 *   Slot 3: bits 2-0   (3 bits, opcode >> 1)
 *
 * All words are XOR-encoded with 0x15555 before storage.
 */
import { XOR_ENCODING, WORD_MASK } from '../types';
import { OPCODE_MAP } from '../constants';

const NOP = 0x1C; // nop opcode

export class CodeBuilder {
  private mem: (number | null)[];
  private locationCounter: number;
  private slotPointer: number;
  private currentWord: number[];
  private labels: Map<string, number>;
  private forwardRefs: Array<{ name: string; wordAddr: number; slot: number }>;
  private extendedArith: number;

  constructor(memSize: number = 64) {
    this.mem = new Array(memSize).fill(null);
    this.locationCounter = 0;
    this.slotPointer = 0;
    this.currentWord = [NOP, NOP, NOP, NOP];
    this.labels = new Map();
    this.forwardRefs = [];
    this.extendedArith = 0;
  }

  getLocationCounter(): number {
    return this.locationCounter;
  }

  setLocationCounter(addr: number): void {
    this.locationCounter = addr;
  }

  getSlotPointer(): number {
    return this.slotPointer;
  }

  setExtendedArith(value: number): void {
    this.extendedArith = value;
  }

  getExtendedArith(): number {
    return this.extendedArith;
  }

  private assembleWord(slots: number[]): number {
    const raw = (slots[0] << 13) | (slots[1] << 8) | (slots[2] << 3) | (slots[3] & 0x7);
    return raw ^ XOR_ENCODING;
  }

  flush(): void {
    if (this.slotPointer === 0) return;
    const word = this.assembleWord(this.currentWord);
    if (this.locationCounter < this.mem.length) {
      this.mem[this.locationCounter] = word;
    }
    this.locationCounter++;
    this.slotPointer = 0;
    this.currentWord = [NOP, NOP, NOP, NOP];
  }

  emitOp(opcode: number): void {
    if (this.slotPointer >= 4) {
      this.flush();
    }
    if (this.slotPointer === 3) {
      // Slot 3 only has 3 bits: opcode must be even
      if (opcode % 2 !== 0) {
        this.flush();
      } else {
        this.currentWord[3] = opcode >> 1;
        this.flush();
        return;
      }
    }
    this.currentWord[this.slotPointer] = opcode;
    this.slotPointer++;
  }

  emitJump(opcode: number, addr: number): void {
    if (this.slotPointer >= 3) {
      this.flush();
    }
    const slot = this.slotPointer;
    this.currentWord[slot] = opcode;

    let raw: number;
    switch (slot) {
      case 0:
        raw = (opcode << 13) | ((addr | this.extendedArith) & 0x1FFF);
        break;
      case 1:
        raw = (this.currentWord[0] << 13) | (opcode << 8) | (addr & 0xFF);
        break;
      case 2:
        raw = (this.currentWord[0] << 13) | (this.currentWord[1] << 8) | (opcode << 3) | (addr & 0x7);
        break;
      default:
        raw = 0;
    }

    if (this.locationCounter < this.mem.length) {
      this.mem[this.locationCounter] = raw ^ XOR_ENCODING;
    }
    this.locationCounter++;
    this.slotPointer = 0;
    this.currentWord = [NOP, NOP, NOP, NOP];
  }

  emitLiteral(value: number): void {
    this.emitOp(OPCODE_MAP.get('@p')!);
    this.flush();
    if (this.locationCounter < this.mem.length) {
      this.mem[this.locationCounter] = (value & WORD_MASK) ^ XOR_ENCODING;
    }
    this.locationCounter++;
  }

  emitData(value: number): void {
    this.flush();
    if (this.locationCounter < this.mem.length) {
      this.mem[this.locationCounter] = (value & WORD_MASK) ^ XOR_ENCODING;
    }
    this.locationCounter++;
  }

  label(name: string): number {
    this.flush();
    this.labels.set(name, this.locationCounter);
    return this.locationCounter;
  }

  addForwardRef(name: string): void {
    this.forwardRefs.push({
      name,
      wordAddr: this.locationCounter,
      slot: this.slotPointer,
    });
  }

  getLabel(name: string): number | undefined {
    return this.labels.get(name);
  }

  getLabels(): Map<string, number> {
    return this.labels;
  }

  getForwardRefs(): Array<{ name: string; wordAddr: number; slot: number }> {
    return this.forwardRefs;
  }

  resolveForwardRefs(errors: Array<{ message: string }>, context: string): void {
    for (const ref of this.forwardRefs) {
      const addr = this.labels.get(ref.name);
      if (addr !== undefined) {
        const encoded = this.mem[ref.wordAddr];
        if (encoded !== null) {
          const raw = encoded ^ XOR_ENCODING;
          let patched: number;
          switch (ref.slot) {
            case 0: patched = (raw & 0x3E000) | (addr & 0x1FFF); break;
            case 1: patched = (raw & 0x3FF00) | (addr & 0xFF); break;
            case 2: patched = (raw & 0x3FFF8) | (addr & 0x7); break;
            default: patched = raw;
          }
          this.mem[ref.wordAddr] = patched ^ XOR_ENCODING;
        }
      } else {
        errors.push({ message: `Unresolved reference: ${ref.name} in ${context}` });
      }
    }
  }

  build(): { mem: (number | null)[]; len: number; labels: Map<string, number> } {
    this.flush();
    let len = 0;
    for (let j = this.mem.length - 1; j >= 0; j--) {
      if (this.mem[j] !== null) { len = j + 1; break; }
    }
    return { mem: this.mem, len, labels: this.labels };
  }
}
