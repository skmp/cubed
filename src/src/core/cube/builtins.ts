/**
 * Built-in predicate code generation for CUBE.
 * Each builtin emits F18A code for its operation.
 *
 * Phase 1: Forward-mode only (all inputs → compute output).
 * Multidirectional (any subset known → compute others) deferred.
 */
import { OPCODE_MAP } from '../constants';
import { CodeBuilder } from '../codegen/builder';
import type { VarMapping } from './varmapper';

/** Load a variable's value onto the stack (T register) */
export function emitLoad(builder: CodeBuilder, mapping: VarMapping): void {
  if (mapping.ramAddr !== undefined) {
    // @p a! [addr] @
    builder.emitLiteral(mapping.ramAddr);
    builder.emitOp(OPCODE_MAP.get('a!')!);
    builder.emitOp(OPCODE_MAP.get('@')!);
  }
}

/** Store T register value into a variable's location */
export function emitStore(builder: CodeBuilder, mapping: VarMapping): void {
  if (mapping.ramAddr !== undefined) {
    // @p a! [addr] ! (but we need to preserve T)
    // Actually: dup @p a! [addr] !
    // Wait, we want to store T without consuming it? For now consume it.
    // push @p a! [addr] pop ! (save T, set A, restore T, store)
    // Simpler: just set A to addr and store
    builder.emitOp(OPCODE_MAP.get('push')!);  // save T to R
    builder.emitLiteral(mapping.ramAddr);
    builder.emitOp(OPCODE_MAP.get('a!')!);
    builder.emitOp(OPCODE_MAP.get('pop')!);   // restore T from R
    builder.emitOp(OPCODE_MAP.get('!')!);      // store T to [A]
  }
}

/** Load a literal value onto the stack */
export function emitLoadLiteral(builder: CodeBuilder, value: number): void {
  builder.emitLiteral(value);
}

/**
 * Emit code for builtin predicates.
 * Returns true if handled, false if unknown.
 */
export function emitBuiltin(
  builder: CodeBuilder,
  name: string,
  argMappings: Map<string, { mapping?: VarMapping; literal?: number }>,
): boolean {
  switch (name) {
    case 'plus':
      return emitArithmetic(builder, argMappings, 'add');

    case 'minus':
      return emitSubtract(builder, argMappings);

    case 'times':
      return emitMultiply(builder, argMappings);

    case 'greater':
      return emitGreater(builder, argMappings);

    case 'equal':
      return emitEqual(builder, argMappings);

    case 'not':
      // Phase 1: not is a no-op (negation requires suspension semantics)
      return true;

    default:
      return false;
  }
}

function loadArg(builder: CodeBuilder, arg: { mapping?: VarMapping; literal?: number }): void {
  if (arg.literal !== undefined) {
    emitLoadLiteral(builder, arg.literal);
  } else if (arg.mapping) {
    emitLoad(builder, arg.mapping);
  }
}

function emitArithmetic(
  builder: CodeBuilder,
  args: Map<string, { mapping?: VarMapping; literal?: number }>,
  _opName: string,
): boolean {
  const a = args.get('a');
  const b = args.get('b');
  const c = args.get('c');
  if (!a || !b) return false;

  // Load a, load b, op, store c
  loadArg(builder, a);
  loadArg(builder, b);
  builder.emitOp(OPCODE_MAP.get('+')!); // add

  if (c?.mapping) {
    emitStore(builder, c.mapping);
  }

  return true;
}

function emitSubtract(
  builder: CodeBuilder,
  args: Map<string, { mapping?: VarMapping; literal?: number }>,
): boolean {
  const a = args.get('a');
  const b = args.get('b');
  const c = args.get('c');
  if (!a || !b) return false;

  // a - b: load b, negate (com), load 1, add (to get -b), load a, add
  // F18A negate: - (bitwise complement) then +1
  // So: load a, load b, - (com b), 1 . + (add 1 to get -b), + (add a)
  loadArg(builder, b);
  builder.emitOp(OPCODE_MAP.get('-')!);  // complement
  builder.emitLiteral(1);
  builder.emitOp(OPCODE_MAP.get('.')!);   // nop
  builder.emitOp(OPCODE_MAP.get('+')!);   // +1 → now T = -b
  loadArg(builder, a);
  builder.emitOp(OPCODE_MAP.get('+')!);   // T = a + (-b) = a - b

  if (c?.mapping) {
    emitStore(builder, c.mapping);
  }
  return true;
}

function emitMultiply(
  builder: CodeBuilder,
  args: Map<string, { mapping?: VarMapping; literal?: number }>,
): boolean {
  const a = args.get('a');
  const b = args.get('b');
  const c = args.get('c');
  if (!a || !b) return false;

  // F18A multiply using +* (multiply step):
  // Setup: A = multiplicand, S = 0 (accumulator), T = multiplier
  // After 17 iterations of +*: S:T = 36-bit product (S=high, T=low)
  //
  // Stack setup: load 0 first (becomes S), then load b (becomes T)
  loadArg(builder, a);
  builder.emitOp(OPCODE_MAP.get('a!')!);  // A = a (multiplicand)
  builder.emitLiteral(0);                  // T = 0 (will become S=accumulator)
  loadArg(builder, b);                     // T = b (multiplier), S = 0

  // 17 iterations: push 17, loop +* next
  builder.emitLiteral(17);
  builder.emitOp(OPCODE_MAP.get('push')!);  // R = 17
  builder.flush();
  const loopAddr = builder.getLocationCounter();
  builder.emitOp(OPCODE_MAP.get('+*')!);
  builder.emitJump(OPCODE_MAP.get('next')!, loopAddr);
  // After loop: T = low 18 bits of product (what we want)

  if (c?.mapping) {
    emitStore(builder, c.mapping);
  }
  return true;
}

function emitGreater(
  builder: CodeBuilder,
  args: Map<string, { mapping?: VarMapping; literal?: number }>,
): boolean {
  const a = args.get('a');
  const b = args.get('b');
  if (!a || !b) return false;

  // a > b: compute a - b, check sign bit
  // If result is positive (bit 17 = 0), a > b
  // -if jumps if T bit 17 is 1 (negative)
  // For now: just compute a - b and leave on stack
  loadArg(builder, b);
  builder.emitOp(OPCODE_MAP.get('-')!);   // complement b
  builder.emitLiteral(1);
  builder.emitOp(OPCODE_MAP.get('.')!);
  builder.emitOp(OPCODE_MAP.get('+')!);   // -b
  loadArg(builder, a);
  builder.emitOp(OPCODE_MAP.get('+')!);   // a - b

  return true;
}

function emitEqual(
  builder: CodeBuilder,
  args: Map<string, { mapping?: VarMapping; literal?: number }>,
): boolean {
  const a = args.get('a');
  const b = args.get('b');
  if (!a || !b) return false;

  // Unification: copy a to b or b to a (whichever has a storage location)
  if (a.literal !== undefined && b.mapping) {
    emitLoadLiteral(builder, a.literal);
    emitStore(builder, b.mapping);
  } else if (b.literal !== undefined && a.mapping) {
    emitLoadLiteral(builder, b.literal);
    emitStore(builder, a.mapping);
  } else if (a.mapping && b.mapping) {
    emitLoad(builder, a.mapping);
    emitStore(builder, b.mapping);
  }

  return true;
}
