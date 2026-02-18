/**
 * Decompiler: converts CompiledNode[] into arrayforth source text.
 * Uses the disassembler to decode instructions and formats them
 * as valid arrayforth syntax.
 */
import { disassembleWord } from './disassembler';
import { NAMED_ADDRESSES } from './constants';
import type { CompiledNode } from './types';

// Reverse lookup: address → named constant
const ADDRESS_NAMES: Map<number, string> = new Map(
  Object.entries(NAMED_ADDRESSES).map(([name, addr]) => [addr, name])
);

function formatAddress(addr: number): string {
  return ADDRESS_NAMES.get(addr) ?? `0x${addr.toString(16)}`;
}

function decompileNode(node: CompiledNode): string {
  const lines: string[] = [];
  lines.push(`node ${node.coord}`);

  if (node.p !== undefined && node.p !== 0) {
    lines.push(`org ${node.p}`);
  }

  for (let addr = 0; addr < node.len; addr++) {
    const word = node.mem[addr];
    if (word === null || word === undefined) continue;

    // Check if this word is a data literal (follows @p)
    // We'll let the disassembler handle @p naturally
    const dis = disassembleWord(word);
    const parts: string[] = [];

    for (const slot of dis.slots) {
      if (!slot) break;
      if (slot.address !== undefined) {
        parts.push(`${slot.opcode} ${formatAddress(slot.address)}`);
      } else if (slot.opcode === '.') {
        parts.push('.');
      } else {
        parts.push(slot.opcode);
      }
    }

    // Add symbol labels
    if (node.symbols) {
      for (const [name, symAddr] of node.symbols) {
        if (symAddr === addr) {
          lines.push(`: ${name}`);
        }
      }
    }

    const comment = `\\ ${addr.toString(16).padStart(2, '0')}: ${(word & 0x3FFFF).toString(16).padStart(5, '0')}`;
    lines.push(`  ${parts.join(' ')}  ${comment}`);
  }

  return lines.join('\n');
}

/**
 * Decompile compiled nodes into arrayforth source text.
 */
export function decompile(nodes: CompiledNode[]): string {
  return nodes.map(decompileNode).join('\n\n');
}
