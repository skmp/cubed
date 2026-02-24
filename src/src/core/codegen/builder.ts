/**
 * Shared CodeBuilder for F18A instruction word packing.
 * Used by both the arrayForth assembler and the CUBE compiler.
 *
 * F18A instruction word format (18 bits):
 *   Slot 0: bits 17-13 (5 bits)
 *   Slot 1: bits 12-8  (5 bits)
 *   Slot 2: bits 7-3   (5 bits)
 *   Slot 3: bits 2-0   (3 bits, value << 2 = opcode)
 *
 * Slot 3 can only encode opcodes that are multiples of 4: {0,4,8,12,16,20,24,28}
 * = {;, unext, @p, !p, +*, +, dup, .}. The default slot 3 value is 7
 * ('.'/nop). Subroutines that need ';' at slot 3 must emit it explicitly.
 *
 * All instruction words are XOR-encoded with 0x15555 before storage.
 * Data words (literals) are stored raw (NOT XOR-encoded).
 */
import { WORD_MASK } from '../types';
import { OPCODE_MAP } from '../constants';

const NOP = 0x1C; // nop opcode (5-bit slots only, CANNOT fit in slot 3)
const SLOT3_DEFAULT = 0x07; // slot 3 default: '.' (nop, opcode 28 >> 2 = 7)
const JMP_OPCODE = 2; // jump opcode

export class CodeBuilder {
  private mem: (number | null)[];
  private locationCounter: number;
  private slotPointer: number;
  private currentWord: number[];
  private labels: Map<string, number>;
  private forwardRefs: Array<{ name: string; wordAddr: number; slot: number }>;
  private extendedArith: number;
  private _lastWasJump = false;
  /** Pending data words placed after @p (inline literal pattern). */
  private pendingData: number[] = [];

  constructor(memSize: number = 64) {
    this.mem = new Array(memSize).fill(null);
    this.locationCounter = 0;
    this.slotPointer = 0;
    this.currentWord = [NOP, NOP, NOP, SLOT3_DEFAULT];
    this.labels = new Map();
    this.forwardRefs = [];
    this.extendedArith = 0;
  }

  /**
   * Returns true if the last emitted instruction was an unconditional jump
   * at slot 0 (meaning there is no pending partial word and no fall-through).
   * The emitter uses this to skip appending a halt loop after code that
   * already ends with an infinite loop (e.g. subroutine-based builtins).
   */
  endsWithJump(): boolean {
    return this._lastWasJump;
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

  /**
   * Per-slot XOR bits for opcode encoding (matching reference xor-bits).
   * Only opcodes are XOR-encoded; addresses/data are stored raw.
   */
  private static readonly XOR_BITS = [0b01010, 0b10101, 0b01010, 0b101];

  private assembleWord(slots: number[]): number {
    // XOR-encode each opcode slot individually (matching reference assemble-inst).
    // Address bits are NOT XOR-encoded — they're added separately in emitJump.
    const s0 = (slots[0] ^ CodeBuilder.XOR_BITS[0]) << 13;
    const s1 = (slots[1] ^ CodeBuilder.XOR_BITS[1]) << 8;
    const s2 = (slots[2] ^ CodeBuilder.XOR_BITS[2]) << 3;
    const s3 = (slots[3] ^ CodeBuilder.XOR_BITS[3]) & 0x7;
    return s0 | s1 | s2 | s3;
  }

  /**
   * Flush the current partial word to memory.
   * Unused slot 3 will contain '.' (nop), which is harmless.
   */
  flush(): void {
    if (this.slotPointer === 0 && this.pendingData.length === 0) return;
    if (this.slotPointer > 0) {
      const word = this.assembleWord(this.currentWord);
      if (this.locationCounter < this.mem.length) {
        this.mem[this.locationCounter] = word;
      }
      this.locationCounter++;
    }
    // Write any pending data words (from @p inline literals)
    for (const data of this.pendingData) {
      if (this.locationCounter < this.mem.length) {
        this.mem[this.locationCounter] = data;
      }
      this.locationCounter++;
    }
    this.pendingData = [];
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

    if (this.slotPointer === 1) {
      // slot 1: 8-bit address range (0–255), safe for 64-word RAM
      this.emitJump(JMP_OPCODE, target);
    } else if (this.slotPointer === 2 && target <= 7) {
      // slot 2: only 3-bit address range (0–7) — only safe for small targets
      this.emitJump(JMP_OPCODE, target);
    } else {
      // slot 2 with large target, or slot 3: flush safely with '.' at slot 3.
      // Since SLOT3_DEFAULT='.', flush() is always safe here.
      // After flush, execution naturally continues at the next sequential word.
      // Only emit a redirect jump when an explicit non-sequential target is given.
      this.flush();
      if (targetAddr !== undefined && target !== this.locationCounter) {
        this.emitJump(JMP_OPCODE, target);
      }
    }
  }

  emitOp(opcode: number): void {
    if (opcode === undefined || opcode === null || isNaN(opcode)) {
      throw new Error(`emitOp: invalid opcode ${opcode} — check OPCODE_MAP key spelling`);
    }
    if (this.slotPointer >= 4) {
      this.flush();
    }
    if (this.slotPointer === 3) {
      // Slot 3 only has 3 bits: only opcodes that are multiples of 4 can fit (0,4,8,...,28)
      if (opcode % 4 !== 0 || opcode > 28) {
        this.flush();
      } else {
        this.currentWord[3] = opcode >> 2;
        this.flush();
        return;
      }
    }
    this._lastWasJump = false;
    this.currentWord[this.slotPointer] = opcode;
    this.slotPointer++;
  }

  emitJump(opcode: number, addr: number): void {
    // 'if' (6) and '-if' (7) are conditional branches.
    // When the branch is NOT taken, the F18A continues executing subsequent slots.
    // The address bits alias into slots 1/2/3 of the word, which for small addresses
    // (addr < 256) decode as ';' (opcode 0) in slot 1 — this pops R and corrupts P.
    // Therefore, 'if'/'if' MUST always land at slot 0 to use the full 13-bit address.
    // Even at slot 0, small addresses still decode as ';' at slot 1, but this is
    // the INTENDED F18A idiom: the caller uses 'call' to push a return address,
    // and the ';' at slot 1 serves as the subroutine return when the branch exits.
    const IF_OPCODE = 6, MIF_OPCODE = 7;
    if ((opcode === IF_OPCODE || opcode === MIF_OPCODE) && this.slotPointer >= 1) {
      // Flush pending instructions so that 'if'/'if' lands at slot 0.
      // Use flushWithJump to avoid leaving ';' (return) in slot 3 of the flush word.
      this.flushWithJump();
    } else if (this.slotPointer >= 3) {
      this.flush();
    }
    const slot = this.slotPointer;
    this.currentWord[slot] = opcode;

    // Assemble instruction word with XOR-encoded opcodes and raw address bits.
    // Matches reference: opcodes get per-slot XOR, addresses do NOT.
    let encoded: number;
    switch (slot) {
      case 0: {
        const s0 = (opcode ^ CodeBuilder.XOR_BITS[0]) << 13;
        encoded = s0 | ((addr | this.extendedArith) & 0x1FFF);
        break;
      }
      case 1: {
        const s0 = (this.currentWord[0] ^ CodeBuilder.XOR_BITS[0]) << 13;
        const s1 = (opcode ^ CodeBuilder.XOR_BITS[1]) << 8;
        encoded = s0 | s1 | (addr & 0xFF);
        break;
      }
      case 2: {
        const s0 = (this.currentWord[0] ^ CodeBuilder.XOR_BITS[0]) << 13;
        const s1 = (this.currentWord[1] ^ CodeBuilder.XOR_BITS[1]) << 8;
        const s2 = (opcode ^ CodeBuilder.XOR_BITS[2]) << 3;
        encoded = s0 | s1 | s2 | (addr & 0x7);
        break;
      }
      default:
        encoded = 0;
    }

    if (this.locationCounter < this.mem.length) {
      this.mem[this.locationCounter] = encoded;
    }
    this.locationCounter++;
    // Write any pending data words (from @p inline literals)
    for (const data of this.pendingData) {
      if (this.locationCounter < this.mem.length) {
        this.mem[this.locationCounter] = data;
      }
      this.locationCounter++;
    }
    this.pendingData = [];
    this.slotPointer = 0;
    this.currentWord = [NOP, NOP, NOP, SLOT3_DEFAULT];
    // Track whether the last emitted instruction was any branch/jump instruction
    // (jump, call, next, if, -if, unext). All of these consume a word and leave
    // SP=0. The emitter uses this to skip appending a halt loop after code
    // that already ends at a word boundary with a jump.
    this._lastWasJump = true;
  }

  /**
   * Emit @p literal: loads a constant value via @p instruction.
   * Uses emitJump(jump) after @p to skip slot 3, preventing ';' from
   * corrupting P when the return stack has non-return-address values.
   */
  emitLiteral(value: number): void {
    // Matches reference arrayForth compiler: @p fills remaining slots with '.',
    // then data word follows. @p increments P past the data word, so the nops
    // in remaining slots are harmless.
    // If slotPointer >= 2, flush first to make room for @p in this word.
    if (this.slotPointer >= 2) {
      this.flushWithJump();
    }
    this.emitOp(OPCODE_MAP.get('@p')!);
    // Fill remaining slots with nop/'.', matching reference @p .. pattern
    this.flush();
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
    // Same pattern as emitLiteral: @p fills rest with nops, data word follows.
    if (this.slotPointer >= 2) {
      this.flushWithJump();
    }
    this.emitOp(OPCODE_MAP.get('@p')!);
    this.flush();
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

  /**
   * Reserve a data word to be emitted after the current instruction word.
   * Matches the reference arrayForth @p inline pattern: @p is placed in a slot,
   * subsequent opcodes can still fill remaining slots in the same word,
   * and the data word is written immediately after the instruction word flushes.
   * Multiple reserveDataWord calls queue multiple data words in order.
   */
  reserveDataWord(value: number): void {
    this.pendingData.push(value & WORD_MASK);
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
            // Address bits are stored raw (not XOR-encoded), so we can
            // patch them directly by clearing and OR'ing.
            let patched: number;
            switch (ref.slot) {
              case 0: patched = (encoded & ~0x1FFF) | (addr & 0x1FFF); break;
              case 1: patched = (encoded & ~0xFF) | (addr & 0xFF); break;
              case 2: patched = (encoded & ~0x7) | (addr & 0x7); break;
              default: patched = encoded;
            }
            this.mem[ref.wordAddr] = patched;
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
