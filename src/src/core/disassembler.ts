import { OPCODES, ADDRESS_REQUIRED, INSTRUCTIONS_USING_REST_OF_WORD } from './constants';
import { XOR_ENCODING } from './types';

export interface DisassembledSlot {
  opcode: string;
  address?: number;
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
    slots[0].address = word & 0x3FF; // 10 bits
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

  // Slot 3: bits 2-0, shift left by 1 to get 5-bit opcode (only even opcodes)
  const slot3opcode = (xored & 0x7) << 1;
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
      parts.push(`${slot.opcode} 0x${slot.address.toString(16)}`);
    } else {
      parts.push(slot.opcode);
    }
  }
  return parts.join(' ');
}
