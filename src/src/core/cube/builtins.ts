/**
 * Built-in predicate code generation for CUBE.
 * Each builtin emits F18A code for its operation.
 *
 * Supports multidirectional modes: given any subset of known arguments,
 * computes the unknown ones. For predicates like `greater` and `equal`,
 * supports conditional branching via fail labels.
 */
import { OPCODE_MAP } from '../constants';
import { CodeBuilder } from '../codegen/builder';
import type { VarMapping } from './varmapper';

// ---- Arg info type ----

export interface ArgInfo {
  mapping?: VarMapping;
  literal?: number;
}

/** Whether an argument is "known" (has a literal or a RAM mapping) */
function isKnown(arg: ArgInfo | undefined): arg is ArgInfo {
  return arg !== undefined && (arg.literal !== undefined || arg.mapping !== undefined);
}

/** Same check as isKnown but without type narrowing (for use after prior narrowing) */
function isArgKnown(arg: ArgInfo): boolean {
  return arg.literal !== undefined || arg.mapping !== undefined;
}

// ---- Load / Store helpers ----

/** Load a variable's value onto the stack (T register) */
export function emitLoad(builder: CodeBuilder, mapping: VarMapping): void {
  if (mapping.ramAddr !== undefined) {
    builder.emitLiteral(mapping.ramAddr);
    builder.emitOp(OPCODE_MAP.get('a!')!);
    builder.emitOp(OPCODE_MAP.get('@')!);
  }
}

/** Store T register value into a variable's location (consumes T) */
export function emitStore(builder: CodeBuilder, mapping: VarMapping): void {
  if (mapping.ramAddr !== undefined) {
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

/** Load an argument (literal or variable) onto T */
function loadArg(builder: CodeBuilder, arg: ArgInfo): void {
  if (arg.literal !== undefined) {
    emitLoadLiteral(builder, arg.literal);
  } else if (arg.mapping) {
    emitLoad(builder, arg.mapping);
  }
}

/** Emit: T = -T (two's complement negate) */
function emitNegate(builder: CodeBuilder): void {
  builder.emitOp(OPCODE_MAP.get('-')!);   // bitwise complement
  builder.emitLiteral(1);
  builder.emitOp(OPCODE_MAP.get('.')!);    // nop (required before + after literal)
  builder.emitOp(OPCODE_MAP.get('+')!);    // +1
}

// ---- Builtin context (for ROM access, fail labels) ----

export interface BuiltinContext {
  /** Label to jump to on failure (for greater, equal check mode) */
  failLabel?: string;
  /** ROM divmod address, if available on the target node */
  romDivmodAddr?: number;
}

// ---- Main entry point ----

/**
 * Emit code for builtin predicates.
 * Returns true if handled, false if unknown.
 */
export function emitBuiltin(
  builder: CodeBuilder,
  name: string,
  argMappings: Map<string, ArgInfo>,
  ctx: BuiltinContext = {},
): boolean {
  switch (name) {
    case 'plus':
      return emitPlus(builder, argMappings);
    case 'minus':
      return emitMinus(builder, argMappings);
    case 'times':
      return emitTimes(builder, argMappings, ctx);
    case 'greater':
      return emitGreater(builder, argMappings, ctx);
    case 'equal':
      return emitEqual(builder, argMappings, ctx);
    case 'not':
      // Not requires suspension semantics — no-op for now
      return true;
    // Bitwise operations
    case 'band':
      return emitBand(builder, argMappings);
    case 'bor':
      return emitBor(builder, argMappings);
    case 'bxor':
      return emitBxor(builder, argMappings);
    case 'bnot':
      return emitBnot(builder, argMappings);
    case 'shl':
      return emitShl(builder, argMappings);
    case 'shr':
      return emitShr(builder, argMappings);
    // Port I/O
    case 'send':
      return emitSend(builder, argMappings);
    case 'recv':
      return emitRecv(builder, argMappings);
    // VGA / loop constructs
    case 'fill':
      return emitFill(builder, argMappings);
    case 'loop':
      return emitLoop(builder, argMappings);
    case 'again':
      return emitAgain(builder);
    default:
      return false;
  }
}

// ---- plus{a, b, c}: a + b = c ----

function emitPlus(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const a = args.get('a');
  const b = args.get('b');
  const c = args.get('c');

  if (isKnown(a) && isKnown(b)) {
    // Forward: c = a + b
    loadArg(builder, a);
    loadArg(builder, b);
    builder.emitOp(OPCODE_MAP.get('+')!);
    if (c?.mapping) emitStore(builder, c.mapping);
    return true;
  }

  if (isKnown(a) && isKnown(c)) {
    // Reverse: b = c - a
    loadArg(builder, a);
    emitNegate(builder);      // T = -a
    loadArg(builder, c);
    builder.emitOp(OPCODE_MAP.get('+')!);  // T = c + (-a) = c - a
    if (b?.mapping) emitStore(builder, b.mapping);
    return true;
  }

  if (isKnown(b) && isKnown(c)) {
    // Reverse: a = c - b
    loadArg(builder, b);
    emitNegate(builder);      // T = -b
    loadArg(builder, c);
    builder.emitOp(OPCODE_MAP.get('+')!);  // T = c + (-b) = c - b
    if (a?.mapping) emitStore(builder, a.mapping);
    return true;
  }

  return false; // Not enough known args
}

// ---- minus{a, b, c}: a - b = c ----

function emitMinus(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const a = args.get('a');
  const b = args.get('b');
  const c = args.get('c');

  if (isKnown(a) && isKnown(b)) {
    // Forward: c = a - b
    loadArg(builder, b);
    emitNegate(builder);      // T = -b
    loadArg(builder, a);
    builder.emitOp(OPCODE_MAP.get('+')!);  // T = a + (-b) = a - b
    if (c?.mapping) emitStore(builder, c.mapping);
    return true;
  }

  if (isKnown(a) && isKnown(c)) {
    // Reverse: b = a - c
    loadArg(builder, c);
    emitNegate(builder);      // T = -c
    loadArg(builder, a);
    builder.emitOp(OPCODE_MAP.get('+')!);  // T = a + (-c) = a - c
    if (b?.mapping) emitStore(builder, b.mapping);
    return true;
  }

  if (isKnown(b) && isKnown(c)) {
    // Reverse: a = b + c
    loadArg(builder, b);
    loadArg(builder, c);
    builder.emitOp(OPCODE_MAP.get('+')!);  // T = b + c
    if (a?.mapping) emitStore(builder, a.mapping);
    return true;
  }

  return false;
}

// ---- times{a, b, c}: a * b = c ----

function emitTimes(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
  ctx: BuiltinContext,
): boolean {
  const a = args.get('a');
  const b = args.get('b');
  const c = args.get('c');

  if (isKnown(a) && isKnown(b)) {
    // Forward: c = a * b
    return emitMultiplyForward(builder, a, b, c);
  }

  if (isKnown(a) && isKnown(c) && ctx.romDivmodAddr !== undefined) {
    // Reverse: b = c / a (using ROM divmod)
    emitDivide(builder, c, a, ctx.romDivmodAddr);
    if (b?.mapping) emitStore(builder, b.mapping);
    return true;
  }

  if (isKnown(b) && isKnown(c) && ctx.romDivmodAddr !== undefined) {
    // Reverse: a = c / b (using ROM divmod)
    emitDivide(builder, c, b, ctx.romDivmodAddr);
    if (a?.mapping) emitStore(builder, a.mapping);
    return true;
  }

  return false;
}

function emitMultiplyForward(
  builder: CodeBuilder,
  a: ArgInfo,
  b: ArgInfo,
  c: ArgInfo | undefined,
): boolean {
  // F18A multiply using +* (multiply step):
  // Setup: A = multiplicand, S = 0, T = multiplier
  // After 17 iterations: S:T = 36-bit product (T = low 18 bits)
  loadArg(builder, a);
  builder.emitOp(OPCODE_MAP.get('a!')!);  // A = a
  builder.emitLiteral(0);                  // T = 0 → S
  loadArg(builder, b);                     // T = b, S = 0

  builder.emitLiteral(17);
  builder.emitOp(OPCODE_MAP.get('push')!);  // R = 17
  builder.flushWithJump();                   // skip slot 3 (';' would pop R to P)
  const loopAddr = builder.getLocationCounter();
  builder.emitOp(OPCODE_MAP.get('+*')!);
  builder.emitJump(OPCODE_MAP.get('next')!, loopAddr);

  if (c?.mapping) emitStore(builder, c.mapping);
  return true;
}

function emitDivide(
  builder: CodeBuilder,
  dividend: ArgInfo,
  divisor: ArgInfo,
  divmodAddr: number,
): void {
  // ROM divmod convention: T = divisor, S = dividend
  // Returns: T = quotient, S = remainder
  loadArg(builder, dividend);
  loadArg(builder, divisor);
  builder.emitJump(OPCODE_MAP.get('call')!, divmodAddr);
  // T now holds quotient
}

// ---- greater{a, b}: succeeds when a > b ----

function emitGreater(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
  ctx: BuiltinContext,
): boolean {
  const a = args.get('a');
  const b = args.get('b');
  if (!isKnown(a) || !isKnown(b)) return false;

  // Compute a - b - 1 to test a > b
  // If (a - b - 1) >= 0, then a - b >= 1, then a > b: SUCCESS
  // If (a - b - 1) < 0, then a <= b: FAIL
  //
  // -if jumps when T bit 17 = 0 (T >= 0 in signed) → jumps on SUCCESS
  // So: -if <skip_fail>, then fall through to jump <failLabel>

  // Step 1: compute a - b
  loadArg(builder, b);
  emitNegate(builder);                        // T = -b
  loadArg(builder, a);
  builder.emitOp(OPCODE_MAP.get('+')!);       // T = a - b

  // Step 2: subtract 1 → T = a - b - 1
  // -1 = complement of 0 (0x3FFFF in 18-bit)
  builder.emitLiteral(0);
  builder.emitOp(OPCODE_MAP.get('-')!);       // complement 0 → 0x3FFFF = -1
  builder.emitOp(OPCODE_MAP.get('.')!);       // nop
  builder.emitOp(OPCODE_MAP.get('+')!);       // T = (a - b) + (-1) = a - b - 1

  if (ctx.failLabel) {
    // -if jumps when T >= 0 → success, skip over fail jump
    builder.flush();
    const continueAddr = builder.getLocationCounter() + 2; // skip the fail jump
    builder.emitJump(OPCODE_MAP.get('-if')!, continueAddr);
    // Fall through = failure: jump to fail label
    builder.addForwardRef(ctx.failLabel);
    builder.emitJump(OPCODE_MAP.get('jump')!, 0); // patched by forward ref
    // continueAddr lands here: success path continues
  }
  // If no failLabel, just leave the test result on stack

  return true;
}

// ---- equal{a, b}: unification / equality check ----

function emitEqual(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
  ctx: BuiltinContext,
): boolean {
  const a = args.get('a');
  const b = args.get('b');
  if (!a || !b) return false;

  const aKnown = isArgKnown(a);
  const bKnown = isArgKnown(b);

  if (aKnown && !bKnown && b.mapping) {
    // Assignment: b = a
    loadArg(builder, a);
    emitStore(builder, b.mapping);
    return true;
  }

  if (bKnown && !aKnown && a.mapping) {
    // Assignment: a = b
    loadArg(builder, b);
    emitStore(builder, a.mapping);
    return true;
  }

  if (aKnown && bKnown) {
    // Check mode: verify a == b, fail if not
    loadArg(builder, a);
    loadArg(builder, b);
    builder.emitOp(OPCODE_MAP.get('or')!);  // XOR: T = a ^ b (0 if equal)

    if (ctx.failLabel) {
      // if jumps when T = 0 (equal) → success, skip fail
      builder.flush();
      const continueAddr = builder.getLocationCounter() + 2;
      builder.emitJump(OPCODE_MAP.get('if')!, continueAddr);
      // Fall through = not equal: jump to fail label
      builder.addForwardRef(ctx.failLabel);
      builder.emitJump(OPCODE_MAP.get('jump')!, 0);
      // continueAddr: success path
    }
    return true;
  }

  if (a.mapping && b.mapping) {
    // Both are variables: copy a to b
    emitLoad(builder, a.mapping);
    emitStore(builder, b.mapping);
    return true;
  }

  return false;
}

// ---- band{a, b, c}: c = a AND b ----

function emitBand(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const a = args.get('a');
  const b = args.get('b');
  const c = args.get('c');
  if (!isKnown(a) || !isKnown(b)) return false;

  loadArg(builder, a);
  loadArg(builder, b);
  builder.emitOp(OPCODE_MAP.get('and')!);
  if (c?.mapping) emitStore(builder, c.mapping);
  return true;
}

// ---- bor{a, b, c}: c = a OR b ----
// F18A has no OR instruction. Synthesize via DeMorgan: a|b = ~(~a & ~b)

function emitBor(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const a = args.get('a');
  const b = args.get('b');
  const c = args.get('c');
  if (!isKnown(a) || !isKnown(b)) return false;

  // ~a
  loadArg(builder, a);
  builder.emitOp(OPCODE_MAP.get('-')!);    // NOT a
  // ~b
  loadArg(builder, b);
  builder.emitOp(OPCODE_MAP.get('-')!);    // NOT b
  // ~a & ~b
  builder.emitOp(OPCODE_MAP.get('and')!);
  // ~(~a & ~b) = a | b
  builder.emitOp(OPCODE_MAP.get('-')!);    // NOT
  if (c?.mapping) emitStore(builder, c.mapping);
  return true;
}

// ---- bxor{a, b, c}: c = a XOR b ----

function emitBxor(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const a = args.get('a');
  const b = args.get('b');
  const c = args.get('c');
  if (!isKnown(a) || !isKnown(b)) return false;

  loadArg(builder, a);
  loadArg(builder, b);
  builder.emitOp(OPCODE_MAP.get('or')!);   // F18A 'or' is actually XOR
  if (c?.mapping) emitStore(builder, c.mapping);
  return true;
}

// ---- bnot{a, b}: b = NOT a ----

function emitBnot(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const a = args.get('a');
  const b = args.get('b');
  if (!isKnown(a)) return false;

  loadArg(builder, a);
  builder.emitOp(OPCODE_MAP.get('-')!);    // bitwise complement
  if (b?.mapping) emitStore(builder, b.mapping);
  return true;
}

// ---- shl{a, n, c}: c = a << n (n must be literal) ----

function emitShl(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const a = args.get('a');
  const n = args.get('n');
  const c = args.get('c');
  if (!isKnown(a) || !n || n.literal === undefined) return false;

  loadArg(builder, a);
  const count = n.literal;
  for (let i = 0; i < count; i++) {
    builder.emitOp(OPCODE_MAP.get('2*')!);
  }
  if (c?.mapping) emitStore(builder, c.mapping);
  return true;
}

// ---- shr{a, n, c}: c = a >> n (n must be literal) ----

function emitShr(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const a = args.get('a');
  const n = args.get('n');
  const c = args.get('c');
  if (!isKnown(a) || !n || n.literal === undefined) return false;

  loadArg(builder, a);
  const count = n.literal;
  for (let i = 0; i < count; i++) {
    builder.emitOp(OPCODE_MAP.get('2/')!);
  }
  if (c?.mapping) emitStore(builder, c.mapping);
  return true;
}

// ---- send{port, value}: blocking write to port ----
// port must be a literal (0x1D5=right, 0x115=down, 0x175=left, 0x145=up)

function emitSend(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const port = args.get('port');
  const value = args.get('value');
  if (!port || port.literal === undefined || !isKnown(value)) return false;

  if (port.literal === 0x15D) {
    // Optimize: B register defaults to 0x15D (IO port) on F18A reset.
    // Use !b instead of setting up A register — saves 2 words.
    loadArg(builder, value);
    builder.emitOp(OPCODE_MAP.get('!b')!);     // write T to [B=0x15D]
  } else {
    emitLoadLiteral(builder, port.literal);
    builder.emitOp(OPCODE_MAP.get('a!')!);     // A = port address
    loadArg(builder, value);
    builder.emitOp(OPCODE_MAP.get('!')!);      // blocking write T to [A]
  }
  return true;
}

// ---- recv{port, value}: blocking read from port ----
// port must be a literal

function emitRecv(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const port = args.get('port');
  const value = args.get('value');
  if (!port || port.literal === undefined) return false;

  emitLoadLiteral(builder, port.literal);
  builder.emitOp(OPCODE_MAP.get('a!')!);     // A = port address
  builder.emitOp(OPCODE_MAP.get('@')!);       // blocking read from [A] → T
  if (value?.mapping) emitStore(builder, value.mapping);
  return true;
}

// ---- fill{value, count}: fill count pixels to IO register via !b ----
// Uses B register which defaults to 0x15D (IO port) on F18A reset.
// Emits a tight next loop: lit value, lit count-1, push, [dup !b, next], drop

function emitFill(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const value = args.get('value');
  const count = args.get('count');
  if (!isKnown(value) || !count || count.literal === undefined) return false;
  if (count.literal <= 0) return true;

  loadArg(builder, value);                           // T = value
  emitLoadLiteral(builder, count.literal - 1);       // T = count-1, S = value
  builder.emitOp(OPCODE_MAP.get('push')!);           // R = count-1, T = value
  builder.flushWithJump();                            // skip slot 3 (';' would pop R to P)
  const loopAddr = builder.getLocationCounter();
  builder.emitOp(OPCODE_MAP.get('dup')!);            // T = value, S = value
  builder.emitOp(OPCODE_MAP.get('!b')!);             // write T to [B=0x15D], pop → T = value
  builder.flushWithJump();                            // skip slot 3 (';' would pop R to P during loop)
  builder.emitJump(OPCODE_MAP.get('next')!, loopAddr); // decrement R, loop if R!=0
  builder.emitOp(OPCODE_MAP.get('drop')!);           // clean up: pop value
  return true;
}

// ---- loop{n}: begin counted loop ----
// Pushes n-1 to R register and records loop start address.
// Uses a label stack stored in the CodeBuilder's label system.

const loopStack: number[] = [];

function emitLoop(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const n = args.get('n');
  if (!n || n.literal === undefined) return false;
  if (n.literal <= 0) return true;

  emitLoadLiteral(builder, n.literal - 1);           // T = n-1
  builder.emitOp(OPCODE_MAP.get('push')!);           // R = n-1
  builder.flushWithJump();                            // skip slot 3 (';' would pop R to P)
  loopStack.push(builder.getLocationCounter());       // save loop start address
  return true;
}

// ---- again{}: end counted loop ----
// Emits next instruction jumping back to the matching loop start.

function emitAgain(builder: CodeBuilder): boolean {
  const loopAddr = loopStack.pop();
  if (loopAddr === undefined) return false;

  builder.flushWithJump();                            // skip slot 3, ensure next gets slot 0 (13-bit addr)
  builder.emitJump(OPCODE_MAP.get('next')!, loopAddr);
  return true;
}
