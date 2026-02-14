/**
 * arrayForth assembler/compiler.
 * Compiles arrayForth source into per-node binary programs.
 * Port of reference/ga144/src/compile.rkt and assemble.rkt
 */
import { tokenize, TokenType } from './tokenizer';
import {
  OPCODE_MAP, ADDRESS_REQUIRED,
  NAMED_ADDRESSES, getDirectionAddress,
} from '../constants';
import { CodeBuilder } from '../codegen/builder';
import type { CompiledProgram, CompiledNode, CompileError } from '../types';

interface NodeCompileState {
  coord: number;
  builder: CodeBuilder;
  controlStack: number[];
  symbols: Map<string, number>;
}

function createNodeState(coord: number): NodeCompileState {
  return {
    coord,
    builder: new CodeBuilder(64),
    controlStack: [],
    symbols: new Map(),
  };
}

export function compile(source: string): CompiledProgram {
  const tokens = tokenize(source);
  const errors: CompileError[] = [];
  const nodeStates: Map<number, NodeCompileState> = new Map();
  let currentNode: NodeCompileState | null = null;

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];

    if (token.type === TokenType.EOF) break;

    // Handle directives
    if (token.type === TokenType.DIRECTIVE) {
      switch (token.value) {
        case 'node': {
          // Flush previous node
          if (currentNode) currentNode.builder.flush();
          // Get node number
          i++;
          const numToken = tokens[i];
          if (!numToken || numToken.numValue === undefined) {
            errors.push({ line: token.line, col: token.col, message: 'Expected node number after "node"' });
            i++;
            continue;
          }
          const coord = numToken.numValue;
          if (!nodeStates.has(coord)) {
            nodeStates.set(coord, createNodeState(coord));
          }
          currentNode = nodeStates.get(coord)!;
          i++;
          continue;
        }

        case 'org': {
          if (!currentNode) { errors.push({ line: token.line, col: token.col, message: '"org" without active node' }); i++; continue; }
          currentNode.builder.flush();
          i++;
          const numToken = tokens[i];
          if (!numToken || numToken.numValue === undefined) {
            errors.push({ line: token.line, col: token.col, message: 'Expected address after "org"' });
            i++;
            continue;
          }
          currentNode.builder.setLocationCounter(numToken.numValue);
          i++;
          continue;
        }

        case '..': {
          if (!currentNode) { i++; continue; }
          currentNode.builder.flush();
          i++;
          continue;
        }

        case ',': {
          if (!currentNode) { i++; continue; }
          i++;
          const numToken = tokens[i];
          if (!numToken || numToken.numValue === undefined) {
            errors.push({ line: token.line, col: token.col, message: 'Expected value after ","' });
            i++;
            continue;
          }
          currentNode.builder.emitData(numToken.numValue);
          i++;
          continue;
        }

        case '/': {
          if (!currentNode) { i++; continue; }
          currentNode.builder.flush();
          i++;
          continue;
        }

        case '+cy': {
          if (currentNode) currentNode.builder.setExtendedArith(0x200);
          i++;
          continue;
        }

        case '-cy': {
          if (currentNode) currentNode.builder.setExtendedArith(0);
          i++;
          continue;
        }

        case 'for': {
          if (!currentNode) { i++; continue; }
          // 'for' compiles as 'push' (>r) opcode
          currentNode.builder.emitOp(OPCODE_MAP.get('push')!);
          i++;
          continue;
        }

        case 'begin': {
          if (!currentNode) { i++; continue; }
          currentNode.builder.flush();
          currentNode.controlStack.push(currentNode.builder.getLocationCounter());
          i++;
          continue;
        }

        case 'end': {
          if (!currentNode) { i++; continue; }
          if (currentNode.controlStack.length === 0) {
            errors.push({ line: token.line, col: token.col, message: '"end" without matching "begin"' });
            i++;
            continue;
          }
          const beginAddr = currentNode.controlStack.pop()!;
          currentNode.builder.emitJump(OPCODE_MAP.get('jump')!, beginAddr);
          i++;
          continue;
        }

        case 'while': {
          if (!currentNode) { i++; continue; }
          currentNode.builder.flush();
          const whileAddr = currentNode.builder.getLocationCounter();
          currentNode.controlStack.push(whileAddr);
          currentNode.builder.emitJump(OPCODE_MAP.get('-if')!, 0);
          i++;
          continue;
        }

        case 'then': {
          if (!currentNode) { i++; continue; }
          currentNode.builder.flush();
          if (currentNode.controlStack.length === 0) {
            errors.push({ line: token.line, col: token.col, message: '"then" without matching "if"' });
            i++;
            continue;
          }
          currentNode.controlStack.pop();
          i++;
          continue;
        }

        case 'if': {
          if (!currentNode) { i++; continue; }
          i++;
          const addrToken = tokens[i];
          let addr = 0;
          if (addrToken && addrToken.type === TokenType.WORD_REF) {
            const resolved = currentNode.builder.getLabel(addrToken.value);
            if (resolved !== undefined) {
              addr = resolved;
            } else {
              currentNode.builder.addForwardRef(addrToken.value);
            }
            i++;
          } else if (addrToken && addrToken.numValue !== undefined) {
            addr = addrToken.numValue;
            i++;
          }
          currentNode.builder.emitJump(OPCODE_MAP.get('if')!, addr);
          continue;
        }

        case '-if': {
          if (!currentNode) { i++; continue; }
          i++;
          const addrToken = tokens[i];
          let addr = 0;
          if (addrToken && addrToken.type === TokenType.WORD_REF) {
            const resolved = currentNode.builder.getLabel(addrToken.value);
            if (resolved !== undefined) {
              addr = resolved;
            }
            i++;
          } else if (addrToken && addrToken.numValue !== undefined) {
            addr = addrToken.numValue;
            i++;
          }
          currentNode.builder.emitJump(OPCODE_MAP.get('-if')!, addr);
          continue;
        }

        case 'next': {
          if (!currentNode) { i++; continue; }
          i++;
          const addrToken = tokens[i];
          let addr = 0;
          if (addrToken && addrToken.type === TokenType.WORD_REF) {
            const resolved = currentNode.builder.getLabel(addrToken.value);
            if (resolved !== undefined) {
              addr = resolved;
            }
            i++;
          } else if (addrToken && addrToken.numValue !== undefined) {
            addr = addrToken.numValue;
            i++;
          }
          currentNode.builder.emitJump(OPCODE_MAP.get('next')!, addr);
          continue;
        }

        case 'unext': {
          if (!currentNode) { i++; continue; }
          currentNode.builder.emitOp(OPCODE_MAP.get('unext')!);
          i++;
          continue;
        }

        default:
          i++;
          continue;
      }
    }

    // Label definition
    if (token.type === TokenType.LABEL_DEF) {
      if (!currentNode) { errors.push({ line: token.line, col: token.col, message: 'Label definition without active node' }); i++; continue; }
      const addr = currentNode.builder.label(token.value);
      currentNode.symbols.set(token.value, addr);
      i++;
      continue;
    }

    // Opcode
    if (token.type === TokenType.OPCODE) {
      if (!currentNode) { errors.push({ line: token.line, col: token.col, message: 'Opcode without active node' }); i++; continue; }

      const opcode = OPCODE_MAP.get(token.value)!;

      // Check if this is a jump/call instruction
      if (ADDRESS_REQUIRED.has(token.value)) {
        i++;
        const addrToken = tokens[i];
        let addr = 0;

        if (addrToken) {
          if (addrToken.numValue !== undefined) {
            addr = addrToken.numValue;
          } else if (addrToken.type === TokenType.WORD_REF) {
            const resolved = currentNode.builder.getLabel(addrToken.value);
            if (resolved !== undefined) {
              addr = resolved;
            } else {
              currentNode.builder.addForwardRef(addrToken.value);
            }
          } else if (addrToken.type === TokenType.CONSTANT) {
            addr = addrToken.numValue ?? NAMED_ADDRESSES[addrToken.value] ?? 0;
          }
          i++;
        }

        currentNode.builder.emitJump(opcode, addr);
        continue;
      }

      currentNode.builder.emitOp(opcode);
      i++;
      continue;
    }

    // Number literal
    if (token.type === TokenType.NUMBER) {
      if (!currentNode) { errors.push({ line: token.line, col: token.col, message: 'Literal without active node' }); i++; continue; }
      currentNode.builder.emitLiteral(token.numValue!);
      i++;
      continue;
    }

    // Named constant (up, down, left, right, io, etc.)
    if (token.type === TokenType.CONSTANT) {
      if (!currentNode) { errors.push({ line: token.line, col: token.col, message: 'Constant without active node' }); i++; continue; }

      let value: number;
      if (['north', 'south', 'east', 'west'].includes(token.value)) {
        value = getDirectionAddress(currentNode.coord, token.value as 'north' | 'east' | 'south' | 'west');
      } else {
        value = token.numValue ?? NAMED_ADDRESSES[token.value] ?? 0;
      }
      currentNode.builder.emitLiteral(value);
      i++;
      continue;
    }

    // Word reference - look up label or resolve as a call
    if (token.type === TokenType.WORD_REF) {
      if (!currentNode) { errors.push({ line: token.line, col: token.col, message: 'Word reference without active node' }); i++; continue; }

      const atIdx = token.value.indexOf('@');
      let wordName = token.value;
      if (atIdx > 0) {
        wordName = token.value.substring(0, atIdx);
      }

      if (wordName === '/p' || wordName === '/a' || wordName === '/b') {
        i++;
        const valToken = tokens[i];
        if (valToken) {
          i++;
        }
        continue;
      }

      const resolved = currentNode.builder.getLabel(wordName);
      if (resolved !== undefined) {
        currentNode.builder.emitJump(OPCODE_MAP.get('call')!, resolved);
      } else {
        currentNode.builder.addForwardRef(wordName);
        currentNode.builder.emitJump(OPCODE_MAP.get('call')!, 0);
      }
      i++;
      continue;
    }

    i++;
  }

  // Flush last node
  if (currentNode) currentNode.builder.flush();

  // Build output
  const nodes: CompiledNode[] = [];
  for (const [coord, state] of nodeStates) {
    const resolveErrors: Array<{ message: string }> = [];
    state.builder.resolveForwardRefs(resolveErrors, `node ${coord}`);
    for (const err of resolveErrors) {
      errors.push({ line: 0, col: 0, message: err.message });
    }

    const { mem, len } = state.builder.build();

    nodes.push({
      coord,
      mem,
      len,
      symbols: state.symbols,
    });
  }

  return { nodes, errors };
}
