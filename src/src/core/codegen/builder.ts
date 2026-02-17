/**
 * Shared CodeBuilder for F18A instruction word packing.
 * Used by both the arrayForth assembler and the CUBE compiler.
 *
 * F18A instruction word format (18 bits):
 *   Slot 0: bits 17-13 (5 bits)
 *   Slot 1: bits 12-8  (5 bits)
 *   Slot 2: bits 7-3   (5 bits)
 *   Slot 3: bits 2-0   (3 bits, value << 1 = opcode)
 *
 * Slot 3 can only encode even opcodes 0-14. There is NO NOP for slot 3.
 * The default slot 3 value is 0 (';'/return). Use emitJump() to skip
 * slot 3 when its execution would be harmful.
 *
 * All instruction words are XOR-encoded with 0x15555 before storage.
 * Data words (literals) are stored raw (NOT XOR-encoded).
 */
import { XOR_ENCODING, WORD_MASK } from '../types';
import { OPCODE_MAP } from '../constants';

const NOP = 0x1C; // nop opcode (5-bit slots only, CANNOT fit in slot 3)
const SLOT3_DEFAULT = 0x00; // slot 3 default: ';' (return, opcode 0)
const JMP_OPCODE = 2; // jump opcode

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
    this.currentWord = [NOP, NOP, NOP, SLOT3_DEFAULT];
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

  /**
   * Flush the current partial word to memory.
   * WARNING: Unused slot 3 will contain ';' (return), which pops R to P.
   * For safe flushing, use flushWithJump() instead when slot 3 side effects
   * would be harmful.
   */
  flush(): void {
    if (this.slotPointer === 0) return;
    const word = this.assembleWord(this.currentWord);
    if (this.locationCounter < this.mem.length) {
      this.mem[this.locationCounter] = word;
    }
    this.locationCounter++;
    this.slotPointer = 0;
    this.currentWord = [NOP, NOP, NOP, SLOT3_DEFAULT];
  }

  /**
   * Flush the current partial word by inserting a 'jump' to a target address
   * at the next available slot. This ensures slot 3 is never reached,
   * avoiding its side effects.
   *
   * @param targetAddr - Address to jump to (default: next sequential word)
   */
  flushWithJump(targetAddr?: number): void {
    if (this.slotPointer === 0) return;

    const target = targetAddr ?? (this.locationCounter + 1);

    if (this.slotPointer <= 2) {
      // Insert jump at current slot to skip remaining slots (including slot 3)
      this.emitJump(JMP_OPCODE, target);
    } else {
      // slotPointer === 3: all 5-bit slots used, can't insert jump.
      // Fall back to regular flush with ';' at slot 3.
      this.flush();
    }
  }

  emitOp(opcode: number): void {
    if (this.slotPointer >= 4) {
      this.flush();
    }
    if (this.slotPointer === 3) {
      // Slot 3 only has 3 bits: only even opcodes 0-14 can fit
      if (opcode % 2 !== 0 || opcode > 14) {
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
    this.currentWord = [NOP, NOP, NOP, SLOT3_DEFAULT];
  }

  /**
   * Emit @p literal: loads a constant value via @p instruction.
   * Uses emitJump(jump) after @p to skip slot 3, preventing ';' from
   * corrupting P when the return stack has non-return-address values.
   */
  emitLiteral(value: number): void {
    // @p and jump must be in the same instruction word. @p reads from P
    // (the data word at loc+1), then jump skips past it to loc+2.
    // If @p ends up at slot 2+, the jump can't fit in the same word,
    // causing @p to read the wrong word (the next instruction, not data).
    // Flush first if there's not enough room for both @p + jump.
    if (this.slotPointer >= 2) {
      this.flushWithJump();
    }
    this.emitOp(OPCODE_MAP.get('@p')!);
    // Jump past the literal data word to skip slot 3 safely.
    // After @p reads from P (the data word), P is already at loc+2.
    // The jump target loc+2 matches P, so it's effectively a no-op for P.
    const continueAddr = this.locationCounter + 2;
    this.emitJump(JMP_OPCODE, continueAddr);
    // Store literal data (NOT XOR-encoded — @p reads raw values)
    if (this.locationCounter < this.mem.length) {
      this.mem[this.locationCounter] = value & WORD_MASK;
    }
    this.locationCounter++;
  }

  /**
   * Emit @p literal with a forward reference: the data word will be
   * patched to the resolved label address when resolveForwardRefs runs.
   * Unlike addForwardRef (which patches XOR-encoded instruction words),
   * this patches the raw data word directly.
   */
  emitLiteralRef(labelName: string): void {
    // Same slot-2 guard as emitLiteral: @p + jump must share a word.
    if (this.slotPointer >= 2) {
      this.flushWithJump();
    }
    this.emitOp(OPCODE_MAP.get('@p')!);
    const continueAddr = this.locationCounter + 2;
    this.emitJump(JMP_OPCODE, continueAddr);
    // Store placeholder data word (will be patched by resolveForwardRefs)
    const dataAddr = this.locationCounter;
    if (dataAddr < this.mem.length) {
      this.mem[dataAddr] = 0;
    }
    this.locationCounter++;
    // Record as a literal forward ref (slot = -1 signals raw data patch)
    this.forwardRefs.push({ name: labelName, wordAddr: dataAddr, slot: -1 });
  }

  emitData(value: number): void {
    this.flush();
    if (this.locationCounter < this.mem.length) {
      // Data words are NOT XOR-encoded
      this.mem[this.locationCounter] = value & WORD_MASK;
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
        if (ref.slot === -1) {
          // Raw data word patch (from emitLiteralRef) — NOT XOR-encoded
          this.mem[ref.wordAddr] = addr & WORD_MASK;
        } else {
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
        }
      } else {
        errors.push({ message: `Unresolved reference: ${ref.name} in ${context}` });
      }
    }
  }

  build(): { mem: (number | null)[]; len: number; maxAddr: number; labels: Map<string, number> } {
    this.flush();
    // maxAddr is the highest address the compiler tried to write to,
    // even if it was beyond the mem array bounds (silent truncation).
    const maxAddr = this.locationCounter;
    let len = 0;
    for (let j = this.mem.length - 1; j >= 0; j--) {
      if (this.mem[j] !== null) { len = j + 1; break; }
    }
    return { mem: this.mem, len, maxAddr, labels: this.labels };
  }
}
