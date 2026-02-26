import { OPCODES, ADDRESS_REQUIRED, INSTRUCTIONS_USING_REST_OF_WORD } from './constants';
import { XOR_ENCODING } from './types';

export interface DisassembledSlot {
  opcode: string;
  address?: number;
  /** True when the jump/call address has bit 9 set, enabling extended arithmetic mode */
  extendedArith?: boolean;
}

export interface DisassembledWord {
  slots: (DisassembledSlot | null)[];
  raw: number;
}

/**
 * Disassemble an 18-bit instruction word into up to 4 instruction slots.
 * Port of reference/ga144/src/disassemble.rkt
 */
export function disassembleWord(word: number): DisassembledWord {
  const xored = word ^ XOR_ENCODING;
  const slots: (DisassembledSlot | null)[] = [null, null, null, null];

  // Slot 0: bits 17-13, 10-bit address field
  const slot0opcode = (xored >> 13) & 0x1F;
  const slot0name = OPCODES[slot0opcode];
  slots[0] = { opcode: slot0name };
  if (ADDRESS_REQUIRED.has(slot0name)) {
    const addr = word & 0x3FF; // 10 bits
    slots[0].address = addr;
    if ((slot0name === 'jump' || slot0name === 'call') && (addr & 0x200)) {
      slots[0].extendedArith = true;
    }
    return { slots, raw: word };
  }
  if (INSTRUCTIONS_USING_REST_OF_WORD.has(slot0name)) {
    return { slots, raw: word };
  }

  // Slot 1: bits 12-8, 8-bit address field
  const slot1opcode = (xored >> 8) & 0x1F;
  const slot1name = OPCODES[slot1opcode];
  slots[1] = { opcode: slot1name };
  if (ADDRESS_REQUIRED.has(slot1name)) {
    slots[1].address = word & 0xFF; // 8 bits
    return { slots, raw: word };
  }
  if (INSTRUCTIONS_USING_REST_OF_WORD.has(slot1name)) {
    return { slots, raw: word };
  }

  // Slot 2: bits 7-3, 3-bit address field
  const slot2opcode = (xored >> 3) & 0x1F;
  const slot2name = OPCODES[slot2opcode];
  slots[2] = { opcode: slot2name };
  if (ADDRESS_REQUIRED.has(slot2name)) {
    slots[2].address = word & 0x7; // 3 bits
    return { slots, raw: word };
  }
  if (INSTRUCTIONS_USING_REST_OF_WORD.has(slot2name)) {
    return { slots, raw: word };
  }

  // Slot 3: bits 2-0, shift left by 2 to get 5-bit opcode (opcodes 0,4,8,12,16,20,24,28)
  const slot3opcode = (xored & 0x7) << 2;
  const slot3name = OPCODES[slot3opcode];
  slots[3] = { opcode: slot3name };

  return { slots, raw: word };
}

/**
 * Format a disassembled word as a human-readable string
 */
export function formatDisassembly(word: number): string {
  const dis = disassembleWord(word);
  const parts: string[] = [];
  for (const slot of dis.slots) {
    if (!slot) break;
    if (slot.address !== undefined) {
      const ea = slot.extendedArith ? ' [ea]' : '';
      parts.push(`${slot.opcode} 0x${slot.address.toString(16)}${ea}`);
    } else {
      parts.push(slot.opcode);
    }
  }
  return parts.join(' ');
}

/**
 * Per-slot address masks matching f18a.ts doStep().
 * Slot 0: 10-bit address, mask preserves bits 17-10
 * Slot 1: 8-bit address, mask preserves bits 17-9
 * Slot 2: 3-bit address, mask preserves bits 17-9 and 7-3
 */
const SLOT_MASKS = [0x3FC00, 0x3FE00, 0x3FEF8];

/**
 * Compute the effective jump/branch target address for a given slot,
 * accounting for the F18A's P-relative masking where short address fields
 * only replace the lower bits of P.
 *
 * At runtime, P has already been incremented past the current word when the
 * instruction executes (P = wordAddr + 1 after the fetch).  The short address
 * field replaces the lower bits of this post-fetch P, not the word's own address.
 */
function effectiveAddress(rawAddr: number, slot: number, wordAddr: number): number {
  if (slot >= SLOT_MASKS.length) return rawAddr;
  const postFetchP = wordAddr + 1;
  return (postFetchP & SLOT_MASKS[slot]) | rawAddr;
}

/**
 * Format the instruction slots of a disassembled word with pipe separators.
 * Branch/jump instructions show their target address in parentheses.
 * When wordAddr is provided, addresses are resolved to effective targets
 * accounting for per-slot masking.
 */
function formatSlots(dis: DisassembledWord, wordAddr?: number): string {
  const parts: string[] = [];
  let slotIdx = 0;
  for (const slot of dis.slots) {
    if (!slot) break;
    if (slot.address !== undefined) {
      const addr = wordAddr !== undefined
        ? effectiveAddress(slot.address, slotIdx, wordAddr)
        : slot.address;
      const ea = slot.extendedArith ? '[ea]' : '';
      parts.push(`${slot.opcode}(${addr})${ea}`);
    } else {
      parts.push(slot.opcode);
    }
    slotIdx++;
  }
  return parts.join('|');
}

/**
 * Check if a disassembled word contains @p (literal fetch),
 * meaning the next word in memory is a data literal.
 */
function hasLiteralFetch(dis: DisassembledWord): boolean {
  for (const slot of dis.slots) {
    if (!slot) break;
    if (slot.opcode === '@p') return true;
  }
  return false;
}

/**
 * Format a single XOR-encoded word with pipe-separated instructions
 * and an optional decimal address prefix.
 *
 * Examples:
 *   formatWord(word)       → "@b|.|jump(6)"
 *   formatWord(word, 0)    → "[ 0] @b|.|jump(6)"
 *   formatWord(word, 42)   → "[42] @b|.|jump(6)"
 */
export function formatWord(word: number, addr?: number): string {
  const instr = formatSlots(disassembleWord(word), addr);
  if (addr !== undefined) {
    return `[${String(addr).padStart(2)}] ${instr}`;
  }
  return instr;
}

/**
 * Disassemble an array of XOR-encoded words into formatted strings.
 * Detects @p literals and formats subsequent words as data.
 * Addresses are shown in decimal.
 *
 * Example:
 *   disassembleRange(mem.slice(0, len), 0)
 *   → ["[ 0] @p|jump(2)", "[ 1] 0x000aa (data)", ...]
 */
export function disassembleRange(words: number[], baseAddr: number = 0): string[] {
  const lines: string[] = [];
  let nextIsData = false;

  for (let i = 0; i < words.length; i++) {
    const addr = baseAddr + i;
    const addrStr = `[${String(addr).padStart(2)}]`;

    if (nextIsData) {
      lines.push(`${addrStr} 0x${words[i].toString(16).padStart(5, '0')} (data)`);
      nextIsData = false;
      continue;
    }

    const dis = disassembleWord(words[i]);
    lines.push(`${addrStr} ${formatSlots(dis, addr)}`);
    nextIsData = hasLiteralFetch(dis);
  }

  return lines;
}

/**
 * Disassemble ROM for a given node coordinate.
 * ROM words are XOR-encoded; addresses start at 0x80 and are shown in hex.
 *
 * Example:
 *   disassembleRom(708, ROM_DATA)
 *   → ["[0x80] @b|.|-if(6)", "[0x81] .|drop|next(5)", ...]
 */
export function disassembleRom(coord: number, romData: Record<number, number[]>): string[] {
  const rom = romData[coord];
  if (!rom) return [];

  const lines: string[] = [];
  let nextIsData = false;

  for (let i = 0; i < rom.length; i++) {
    const addrStr = `[0x${(0x80 + i).toString(16)}]`;

    if (nextIsData) {
      lines.push(`${addrStr} 0x${rom[i].toString(16).padStart(5, '0')} (data)`);
      nextIsData = false;
      continue;
    }

    const romAddr = 0x80 + i;
    const dis = disassembleWord(rom[i]);
    lines.push(`${addrStr} ${formatSlots(dis, romAddr)}`);
    nextIsData = hasLiteralFetch(dis);
  }

  return lines;
}

/**
 * Disassemble a compiled node's RAM contents.
 * Handles null entries and detects @p data words.
 * Addresses are shown in decimal.
 *
 * Example:
 *   disassembleNode({ mem: [...], len: 5, coord: 708 })
 *   → ["[ 0] @p|jump(2)", "[ 1] 0x000aa (data)", ...]
 */
export function disassembleNode(node: { mem: (number | null)[]; len: number; coord: number }): string[] {
  const lines: string[] = [];
  let nextIsData = false;
  const count = Math.min(node.len, node.mem.length);

  for (let i = 0; i < count; i++) {
    const word = node.mem[i];
    const addrStr = `[${String(i).padStart(2)}]`;

    if (word === null || word === undefined) {
      lines.push(`${addrStr} <empty>`);
      nextIsData = false;
      continue;
    }

    if (nextIsData) {
      lines.push(`${addrStr} 0x${word.toString(16).padStart(5, '0')} (data)`);
      nextIsData = false;
      continue;
    }

    const dis = disassembleWord(word);
    lines.push(`${addrStr} ${formatSlots(dis, i)}`);
    nextIsData = hasLiteralFetch(dis);
  }

  return lines;
}
