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
  stringValue?: string;
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
  // Strip std. prefix for standard library builtins
  const bareName = name.startsWith('std.') ? name.slice(4) : name;
  switch (bareName) {
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
    case 'forever':
      return emitForever(builder);
    case 'repeat':
      return emitRepeat(builder);
    case 'delay':
      return emitDelay(builder, argMappings);
    case 'setb':
      return emitSetB(builder, argMappings);
    case 'relay':
      return emitRelay(builder, argMappings);
    case 'noiserelay':
      return emitNoiseRelay(builder, argMappings);
    case 'deltarelay':
      return emitDeltaRelay(builder, argMappings);
    case 'shor15':
      return emitShor15(builder, argMappings, ctx);
    case 'asynctx':
      return emitAsyncTx(builder, argMappings);
    case 'asyncecho8':
      return emitAsyncEcho8(builder);
    case 'hellotx':
      return emitHelloTx(builder);
    case 'hellotx_rx':
      return emitHelloTxRx(builder);
    case 'hellotx_tx':
      return emitHelloTxTx(builder);
    case 'pf_rx':
      return emitPfRx(builder);
    case 'pf_tx':
      return emitPfTx(builder);
    // Literal value builtins
    case 'lit.hex18':
      return emitLitHex(builder, argMappings, 0x3FFFF);
    case 'lit.hex9':
      return emitLitHex(builder, argMappings, 0x1FF);
    case 'lit.hex8':
      return emitLitHex(builder, argMappings, 0xFF);
    case 'lit.ascii':
      return emitLitAscii(builder, argMappings);
    case 'lit.utf8':
      return emitLitUtf8(builder, argMappings);
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
  // Setup: T = 0 (accumulator), S = multiplicand, A = multiplier
  // After 18 iterations: A = low 18 bits of product, T = high 18 bits
  loadArg(builder, a);                       // T = a
  loadArg(builder, b);                       // T = b, S = a
  builder.emitOp(OPCODE_MAP.get('a!')!);     // A = b (multiplier). T = S = a
  builder.emitLiteral(0);                    // T = 0, S = a (multiplicand)

  builder.emitLiteral(17);
  builder.emitOp(OPCODE_MAP.get('push')!);  // R = 17
  builder.flushWithJump();                   // skip slot 3 (';' would pop R to P)
  const loopAddr = builder.getLocationCounter();
  builder.emitOp(OPCODE_MAP.get('+*')!);
  builder.emitJump(OPCODE_MAP.get('next')!, loopAddr);

  // Product low 18 bits in A; push onto data stack
  builder.emitOp(OPCODE_MAP.get('a')!);     // T = product

  if (c?.mapping) emitStore(builder, c.mapping);
  return true;
}

function emitDivide(
  builder: CodeBuilder,
  dividend: ArgInfo,
  divisor: ArgInfo,
  divmodAddr: number,
): void {
  // ROM --u/mod convention: stack = [neg_divisor, dividend, 0(high_word)]
  // The divisor must be NEGATED (two's complement) before calling.
  // The 0 high-word is required for the extended-precision division loop.
  // Returns: T = quotient, S = remainder
  builder.emitLiteral(0);             // high word (required by divmod)
  loadArg(builder, dividend);
  loadArg(builder, divisor);
  // Negate divisor: - (NOT), then add 1  →  ~T + 1 = -T
  builder.emitOp(OPCODE_MAP.get('-')!);
  builder.emitLiteral(1);
  builder.emitOp(OPCODE_MAP.get('+')!);
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
    // Load value first, then set A to port address.
    // a! consumes the port from T, revealing the value underneath.
    loadArg(builder, value);
    emitLoadLiteral(builder, port.literal);
    builder.emitOp(OPCODE_MAP.get('a!')!);     // A = port address
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
// Loop uses `next` at slot 0 (13-bit addr) for the counted loop.
// When `next` falls through (R=0), execution continues at the next word.

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
  builder.emitOp(OPCODE_MAP.get('push')!);           // R = count-1
  builder.flushWithJump();                            // skip slot 3
  const loopAddr = builder.getLocationCounter();
  builder.emitOp(OPCODE_MAP.get('dup')!);            // T = value, S = value
  builder.emitOp(OPCODE_MAP.get('!b')!);             // write T to [B=0x15D], pop → T = value
  builder.flushWithJump();                            // skip slot 3
  builder.emitJump(OPCODE_MAP.get('next')!, loopAddr); // decrement R, loop if R!=0
  // next falls through here when done
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

// ---- forever{}: begin unconditional infinite loop ----
// Marks the loop start address. No counter setup — paired with repeat{}.

function emitForever(builder: CodeBuilder): boolean {
  loopStack.push(builder.getLocationCounter());
  return true;
}

// ---- repeat{}: end unconditional infinite loop ----
// Emits jump back to the matching forever{} start.

function emitRepeat(builder: CodeBuilder): boolean {
  const loopAddr = loopStack.pop();
  if (loopAddr === undefined) return false;

  builder.flushWithJump();
  builder.emitJump(OPCODE_MAP.get('jump')!, loopAddr);
  return true;
}

// ---- delay{n}: burn n cycles in a tight next loop (no IO) ----
// Loop body matches fill{} timing: dup drop [flushWithJump] next = 2 words/iteration.
// When `next` falls through (R=0), execution continues at the next word.

function emitDelay(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const n = args.get('n');
  if (!n || n.literal === undefined) return false;
  if (n.literal <= 0) return true;

  emitLoadLiteral(builder, n.literal - 1);             // T = n-1
  builder.emitOp(OPCODE_MAP.get('push')!);             // R = n-1
  builder.flushWithJump();                              // skip slot 3
  const loopAddr = builder.getLocationCounter();
  builder.emitOp(OPCODE_MAP.get('dup')!);              // dup (matches fill timing)
  builder.emitOp(OPCODE_MAP.get('drop')!);             // drop
  builder.flushWithJump();                              // skip slot 3
  builder.emitJump(OPCODE_MAP.get('next')!, loopAddr); // decrement R, loop
  // next falls through here when done
  return true;
}

// ---- setb{addr}: set B register to a new address ----
// Changes the target of !b writes. Default B is 0x15D (IO register).
// Set to a port address (e.g. 0x1D5 for right) to redirect fill{} output.

function emitSetB(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const addr = args.get('addr');
  if (!addr || addr.literal === undefined) return false;

  emitLoadLiteral(builder, addr.literal);              // T = address
  builder.emitOp(OPCODE_MAP.get('b!')!);               // B = address
  return true;
}

// ---- relay{port, count}: read from port and write to IO, count times ----
// Used for DAC relay nodes that read pixel data from a neighbor and output it.
// Uses blocking read (@) from A register and write (!b) to B register (IO).

function emitRelay(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const port = args.get('port');
  const count = args.get('count');
  if (!port || port.literal === undefined) return false;
  if (!count || count.literal === undefined) return false;
  if (count.literal <= 0) return true;

  emitLoadLiteral(builder, port.literal);              // T = port address
  builder.emitOp(OPCODE_MAP.get('a!')!);               // A = port address
  emitLoadLiteral(builder, count.literal - 1);          // T = count-1
  builder.emitOp(OPCODE_MAP.get('push')!);              // R = count-1
  builder.flushWithJump();                               // skip slot 3
  const loopAddr = builder.getLocationCounter();
  builder.emitOp(OPCODE_MAP.get('@')!);                 // blocking read from [A=port] → T
  builder.emitOp(OPCODE_MAP.get('!b')!);                // write T to [B=0x15D (IO)], pop
  builder.flushWithJump();                               // skip slot 3
  builder.emitJump(OPCODE_MAP.get('next')!, loopAddr);
  return true;
}

// ---- noiserelay{port, noiseport, count}: relay XORed with noise ----
// Reads from `port` (e.g. feeder neighbor), reads from `noiseport` (e.g. VCO DATA),
// XORs them together, writes result to IO via !b.
// Both nodes on the relay side must be analog for noiseport=DATA to work.
//
// Inner loop per iteration:
//   @          read feeder → T            (A = port)
//   lit(noiseport) a!   switch A to noise source
//   @          read noise → T, S = feeder_val
//   or         T = feeder_val XOR noise   (F18A 'or' = XOR)
//   !b         write to IO
//   lit(port) a!   restore A to feeder port
//   next

function emitNoiseRelay(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const port = args.get('port');
  const noiseport = args.get('noiseport');
  const count = args.get('count');
  if (!port || port.literal === undefined) return false;
  if (!noiseport || noiseport.literal === undefined) return false;
  if (!count || count.literal === undefined) return false;
  if (count.literal <= 0) return true;

  // Setup: A = feeder port, R = count-1
  emitLoadLiteral(builder, port.literal);               // T = port address
  builder.emitOp(OPCODE_MAP.get('a!')!);                // A = port address
  emitLoadLiteral(builder, count.literal - 1);           // T = count-1
  builder.emitOp(OPCODE_MAP.get('push')!);               // R = count-1
  builder.flushWithJump();                                // skip slot 3

  const loopAddr = builder.getLocationCounter();
  // Read feeder value
  builder.emitOp(OPCODE_MAP.get('@')!);                  // T = feeder_val (blocking read from [A])
  // Switch A to noise port and read
  emitLoadLiteral(builder, noiseport.literal);            // T = noiseport addr, S = feeder_val
  builder.emitOp(OPCODE_MAP.get('a!')!);                  // A = noiseport, T = feeder_val
  builder.emitOp(OPCODE_MAP.get('@')!);                   // T = noise, S = feeder_val
  builder.emitOp(OPCODE_MAP.get('or')!);                  // T = feeder_val XOR noise
  builder.emitOp(OPCODE_MAP.get('!b')!);                  // write to [B=IO], pop
  // Restore A to feeder port for next iteration
  emitLoadLiteral(builder, port.literal);                  // T = port addr
  builder.emitOp(OPCODE_MAP.get('a!')!);                   // A = port addr, pop
  builder.flushWithJump();                                  // skip slot 3
  builder.emitJump(OPCODE_MAP.get('next')!, loopAddr);
  return true;
}

// ---- deltarelay{port, count}: relay delta (current - prev) to IO ----
// Reads from `port` (e.g. VCO DATA 0x141), computes the difference from
// the previous reading, writes the delta to IO via !b.  Uses RAM[0x3F]
// to store the previous value across iterations.
//
// Uses one's complement subtraction (current + ~prev) which gives
// (current - prev - 1).  The constant -1 offset is a uniform DC bias
// invisible in noise visualisation.
//
// Inner loop per iteration:
//   @          read current from [A=port]
//   dup        duplicate current (need a copy for storing as prev)
//   lit(0x3F) a!   switch A to prev storage
//   @          read prev from RAM
//   -          T = ~prev  (one's complement negate)
//   +          T = current + ~prev = delta - 1
//   !b         write delta to [B=IO]
//   !          store current to [A=0x3F] (new prev)
//   lit(port) a!   restore A to port
//   next

function emitDeltaRelay(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const port = args.get('port');
  const count = args.get('count');
  if (!port || port.literal === undefined) return false;
  if (!count || count.literal === undefined) return false;
  if (count.literal <= 0) return true;

  const PREV_ADDR = 0x3F; // RAM location for previous value

  // Initialize prev = 0
  emitLoadLiteral(builder, 0);                                // T = 0
  emitLoadLiteral(builder, PREV_ADDR);                        // T = 0x3F, S = 0
  builder.emitOp(OPCODE_MAP.get('a!')!);                      // A = 0x3F
  builder.emitOp(OPCODE_MAP.get('!')!);                       // RAM[0x3F] = 0, pop

  // Setup: A = port, R = count-1
  emitLoadLiteral(builder, port.literal);                     // T = port
  builder.emitOp(OPCODE_MAP.get('a!')!);                      // A = port
  emitLoadLiteral(builder, count.literal - 1);                // T = count-1
  builder.emitOp(OPCODE_MAP.get('push')!);                    // R = count-1
  builder.flushWithJump();                                     // skip slot 3

  const loopAddr = builder.getLocationCounter();

  // Read current value from port
  builder.emitOp(OPCODE_MAP.get('@')!);                       // T = current
  builder.emitOp(OPCODE_MAP.get('dup')!);                     // T = current, S = current

  // Load prev from RAM[0x3F]
  emitLoadLiteral(builder, PREV_ADDR);                        // T = 0x3F, S = current, S2 = current
  builder.emitOp(OPCODE_MAP.get('a!')!);                      // A = 0x3F
  builder.emitOp(OPCODE_MAP.get('@')!);                       // T = prev, S = current, S2 = current
  builder.flushWithJump();                                     // skip slot 3 (avoid ';' popping R)

  // Compute delta: current + ~prev (one's complement subtraction)
  builder.emitOp(OPCODE_MAP.get('-')!);                       // T = ~prev
  builder.emitOp(OPCODE_MAP.get('+')!);                       // T = current + ~prev = delta
  builder.flushWithJump();                                     // skip slot 3

  // Output delta, store current as new prev
  builder.emitOp(OPCODE_MAP.get('!b')!);                      // write delta to [B=IO], pop → T = current
  builder.emitOp(OPCODE_MAP.get('!')!);                       // write current to [A=0x3F], pop → stack empty

  // Restore A to port for next iteration
  emitLoadLiteral(builder, port.literal);                     // T = port
  builder.emitOp(OPCODE_MAP.get('a!')!);                      // A = port
  builder.flushWithJump();                                     // skip slot 3
  builder.emitJump(OPCODE_MAP.get('next')!, loopAddr);
  return true;
}

// ---- shor15{noise_port, out_port}: Real Shor's algorithm for N=15 ----
//
// Emits a self-contained infinite loop that factors N=15:
//   1. Reads noise from noise_port, derives random base a ∈ [2..9]
//   2. Computes a^2 mod 15 to find period; if a²≡1 → r=2, else r=4
//   3. Verifies coprimality via a^4 ≡ 1 check; retries if not coprime
//   4. Outputs N=15, a, r, p=3, q=5 via !b to out_port
//
// All coprime bases for N=15 in [2..9] yield factors 3 and 5 (since
// 15 = 3×5 and the GCD extraction always gives {3,5}), so we hardcode
// the factor output to save ~30 words of GCD computation.
//
// The multiply-mod-15 routine is emitted once as a callable subroutine
// and called 3 times, saving ~30 words vs inlining.
//
// RAM: [0]=a.  B=out_port throughout.
// ROM divmod required (basic/analog nodes: 0x2d6).
// Total: ~53 words.
//
// Stack state is annotated as [T, S, deeper...] R=[rstack]

function emitShor15(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
  ctx: BuiltinContext,
): boolean {
  const noisePort = args.get('noise_port');
  const outPort = args.get('out_port');
  if (!noisePort || noisePort.literal === undefined) return false;
  if (!outPort || outPort.literal === undefined) return false;
  if (ctx.romDivmodAddr === undefined) return false;

  const op = (name: string) => OPCODE_MAP.get(name)!;
  const lit = (v: number) => emitLoadLiteral(builder, v);
  const emit = (name: string) => builder.emitOp(op(name));
  const jmp = (opName: string, addr: number) => builder.emitJump(op(opName), addr);
  const fwj = () => builder.flushWithJump();

  const divmod = ctx.romDivmodAddr;

  // === SETUP: B = out_port ===
  lit(outPort.literal);
  emit('b!');
  fwj();

  const mainLoop = builder.getLocationCounter();

  // === 1. Read noise, derive a ∈ [2..9] ===
  lit(noisePort.literal);
  emit('a!'); emit('@');           // [noise]
  lit(7);
  emit('and');                     // [noise & 7]  (0..7)
  lit(2);
  emit('.'); emit('+');            // [a]  (2..9)

  // === 2. Store a to RAM[0], keep copy on stack ===
  // dup lit(0) a! ! → RAM[0]=a, T=a (! pops T, S becomes new T = dup's copy)
  emit('dup');                     // [a, a]
  lit(0);
  emit('a!'); emit('!');           // RAM[0]=a, [a]
  fwj();

  // === 3. Compute a² mod 15 via subroutine ===
  builder.addForwardRef('__shor_mulmod');
  jmp('call', 0);                 // [a²%15]

  // === 4. Period check: a² ≡ 1 (mod 15)? ===
  // Keep a²%15 on stack for period-4 path via dup.
  emit('dup');                     // [a²%15, a²%15]
  lit(1);
  emit('or');                      // [a²%15 XOR 1, a²%15]
  // 'if' pops T. If T=0 (a²≡1) → period 2, jump over period-4 jump.
  // After 'if' pops: T = S = a²%15 in both branches.
  // +3 because jmp('if') at sp=1 emits: flush-word (+1) + if-word (+1) + p4-jump (+1)
  const period2Addr = builder.getLocationCounter() + 3;
  jmp('if', period2Addr);         // T=0 → skip to period 2 code
  builder.addForwardRef('__shor_p4');
  jmp('jump', 0);                 // T≠0 → period 4 path

  // === PERIOD 2 PATH ===
  // After 'if' jumped here: T = a²%15 (from S). Don't need it.
  emit('drop');                    // discard a²%15
  lit(2);                          // [2]  (r=2)
  builder.addForwardRef('__shor_output');
  jmp('jump', 0);                 // → output

  // === PERIOD 4 PATH ===
  builder.label('__shor_p4');
  // After 'if' didn't jump, then jump brought us here: T = a²%15
  // Compute a⁴ = (a²)² by multiplying a²%15 by a, twice more:
  // a³ = a² × a, then a⁴ = a³ × a.
  builder.addForwardRef('__shor_mulmod');
  jmp('call', 0);                 // [a³%15]
  builder.addForwardRef('__shor_mulmod');
  jmp('call', 0);                 // [a⁴%15]

  // Coprime check: a⁴ ≡ 1 (mod 15)?
  lit(1);
  emit('or');                      // [a⁴%15 XOR 1]
  // If T=0 → coprime, continue. If T≠0 → not coprime, retry.
  // +3 because jmp('if') at sp=1 emits: flush-word (+1) + if-word (+1) + retry-jump (+1)
  const p4okAddr = builder.getLocationCounter() + 3;
  jmp('if', p4okAddr);            // T=0 → coprime
  jmp('jump', mainLoop);          // not coprime → retry

  // p4ok: coprime confirmed, r=4
  lit(4);                          // [4]  (r=4)

  // === OUTPUT: N=15, a, r, p=3, q=5 ===
  builder.label('__shor_output');
  // T=r. Output 5 values via !b.
  emit('push');                    // R=r
  lit(15);
  emit('!b');                      // output N=15
  lit(0);
  emit('a!'); emit('@');           // [a]  (load from RAM[0])
  fwj();
  emit('!b');                      // output a
  emit('pop');                     // [r]
  fwj();
  emit('!b');                      // output r
  lit(3);
  emit('!b');                      // output p=3
  lit(5);
  emit('!b');                      // output q=5
  jmp('jump', mainLoop);          // loop forever

  // === SUBROUTINE: mulmod15 ===
  // Pre:  T = multiplier, RAM[0] = a
  // Post: T = (multiplier × a) mod 15
  // Clobbers: A, S, R (return addr handled by call/;)
  //
  // F18A +* convention: T=0 (accumulator), S=multiplicand, A=multiplier.
  // After 18 iterations: A = low 18 bits of product, T = high 18 bits.
  builder.label('__shor_mulmod');
  // At entry: T=multiplier, R=[ret_addr]
  emit('push');                    // R=[multiplier, ret_addr], T=S_old
  lit(0);
  emit('a!'); emit('@');           // A=0, T=RAM[0]=a. R=[multiplier, ret_addr]
  emit('pop');                     // T=multiplier, S=a. R=[ret_addr]
  emit('a!');                      // A=multiplier (pop T). T=S=a
  lit(0);                          // T=0, S=a
  // Setup complete: T=0, S=a(multiplicand), A=multiplier
  lit(17);
  emit('push');                    // R=[17, ret_addr]
  fwj();                           // skip slot 3 ';' (would pop 17 as P!)
  const mulLoop = builder.getLocationCounter();
  emit('+*');
  jmp('next', mulLoop);           // 18 iterations of +*
  // After +*: A=low product, T=high(0 for small), S=a(unchanged).
  emit('a');                       // [product, high(0), ...]
  lit(0x3FFF1);                    // [-15 (negated), product]
  jmp('call', divmod);            // [quotient] S=remainder
  emit('drop');                    // [remainder] = (multiplier × a) mod 15
  emit(';');                       // return: pop R to P

  // Resolve forward references within this builtin
  const refErrors: Array<{ message: string }> = [];
  builder.resolveForwardRefs(refErrors, 'shor15');

  return true;
}

// ---- asynctx{port, count?}: async serial TX of 18-bit words ----
//
// Reads 18-bit words from inter-node `port` (blocking @) and transmits
// each as 3 async serial bytes over the IO pin (B=0x15D), using the
// standard boot wire protocol from rom-dump-bootstream.rkt:
//
//   emit1(bit): (bit & 1) XOR 3 → !b   then 865-cycle delay
//               F18A 'or' = XOR, so: bit=0 → 0b11 (drive high/idle),
//                                    bit=1 → 0b10 (drive low/mark)
//   emit8(n):   start-bit(0), 8 data bits LSB-first via (dup emit1 2/), stop-bit(1)
//   emit18(n):  3× emit8  (low byte, mid byte, high byte)
//
// If `count` is provided, transmits exactly `count` words per frame and
// repeats the frame forever (original behavior).
//
// If `count` is omitted, transmits continuously — reads one word at a
// time from the port and transmits it, looping forever.
//
// B register must be set to IO (0x15D) before use; this builtin sets it.
// A is set to port for blocking reads; restored each outer-loop iteration.
//
// RAM: none. R-stack depth: max 5 (outer next, emit18 ret, emit8 ret, bit-loop next, emit1 delay).
// Total words: ~35-40 (fits comfortably in 64-word node RAM).

function emitAsyncTx(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const port = args.get('port');
  const count = args.get('count');
  if (!port || port.literal === undefined) return false;
  // count is optional: if provided, transmit count words per frame; if omitted, continuous
  const hasCount = count !== undefined && count.literal !== undefined && count.literal > 0;

  const op = (name: string) => OPCODE_MAP.get(name)!;
  const lit = (v: number) => emitLoadLiteral(builder, v);
  const emit = (name: string) => builder.emitOp(op(name));
  const jmp = (opName: string, addr: number) => builder.emitJump(op(opName), addr);
  const fwj = () => builder.flushWithJump();

  // === SETUP ===
  // B = IO (0x15D) — set once, never changes.
  lit(0x15D);
  emit('b!');
  fwj();

  if (hasCount) {
    // === FRAME LOOP: reload counter and transmit count words, repeat forever ===
    const frameLoop = builder.getLocationCounter();
    lit(port.literal);
    emit('a!');
    lit(count!.literal! - 1);
    emit('push');                    // R = [count-1]
    fwj();

    // === INNER LOOP: read one word and transmit it ===
    const outerLoop = builder.getLocationCounter();
    emit('@');                       // T = word from port (blocking, A = port)
    emit('dup');                     // T = value, S = value
    lit(0x20000);
    emit('or');                      // T = value | 0x20000, S = value
    emit('!b');                      // write tagged value to IO (B=0x15D), pop → T = value
    fwj();
    builder.addForwardRef('__asynctx_emit18');
    jmp('call', 0);                  // call emit18(T) — serial TX

    // Restore A to port (emit18 clobbers A), then loop for remaining words
    lit(port.literal);
    emit('a!');
    fwj();
    jmp('next', outerLoop);         // decrement R, loop count times
    jmp('jump', frameLoop);         // all count words sent — repeat frame forever
  } else {
    // === CONTINUOUS MODE: read and transmit one word at a time, forever ===
    lit(port.literal);
    emit('a!');
    fwj();

    const loop = builder.getLocationCounter();
    emit('@');                       // T = word from port (blocking, A = port)
    emit('dup');                     // T = value, S = value
    // Tag data write with bit 17 (0x20000) so SerialOutput can distinguish
    // it from serial drive bits (values 2/3). drive bits: 0<=val<=3;
    // tagged data: val|0x20000 (always >=0x20000).
    lit(0x20000);
    emit('or');                      // T = value | 0x20000, S = value
    emit('!b');                      // write tagged value to IO (B=0x15D), pop → T = value
    fwj();
    builder.addForwardRef('__asynctx_emit18');
    jmp('call', 0);                  // call emit18(T) — serial TX

    // Restore A to port (emit18 clobbers A), then loop forever
    lit(port.literal);
    emit('a!');
    fwj();
    jmp('jump', loop);              // repeat forever
  }

  // === EMIT18: send 18-bit word T as 3 bytes ===
  // ( n -- ) clobbers T, uses R for return address + emit8/emit1 R-stack
  builder.label('__asynctx_emit18');
  builder.addForwardRef('__asynctx_emit8');
  jmp('call', 0);                  // emit8: send bits [7:0], T = T >> 8
  builder.addForwardRef('__asynctx_emit8');
  jmp('call', 0);                  // emit8: send bits [15:8], T = T >> 8
  builder.addForwardRef('__asynctx_emit8');
  jmp('call', 0);                  // emit8: send bits [17:16] (+ zeros), T dropped
  emit('drop');                    // clean up leftover shifted value
  emit(';');                       // return from emit18

  // === EMIT8: send 8 bits LSB-first with start/stop bits ===
  // ( n -- n>>8 ) start-bit(0), 8 data bits, stop-bit(1)
  // R-stack at entry: R=[ret_emit18 | ret_outer]
  builder.label('__asynctx_emit8');
  // Start bit: transmit 0
  lit(0);
  builder.addForwardRef('__asynctx_emit1');
  jmp('call', 0);                  // emit1(0) — start bit (drive low)

  // Data bits: 7 for dup emit1 2/ next
  lit(7);
  emit('push');                    // R = [7, ret]
  fwj();
  const bitLoop = builder.getLocationCounter();
  emit('dup');                     // T = n, S = n
  builder.addForwardRef('__asynctx_emit1');
  jmp('call', 0);                  // emit1(T) — sends LSB
  emit('2/');                      // T = T >> 1 (logical shift right)
  fwj();
  jmp('next', bitLoop);           // loop 8 times

  // Stop bit: transmit 1
  lit(1);
  builder.addForwardRef('__asynctx_emit1');
  jmp('call', 0);                  // emit1(1) — stop bit (drive high)
  emit(';');                       // return from emit8

  // === EMIT1: transmit one bit over IO ===
  // ( bit -- ) drives IO: (bit & 1) XOR 3 → !b
  // F18A 'or' = XOR: bit=0 → 0b11 (drive high/idle), bit=1 → 0b10 (drive low)
  // Note: on real hardware a ~865-cycle baud delay follows each !b. In the
  // emulator that delay is omitted so results appear without millions of idle steps.
  builder.label('__asynctx_emit1');
  lit(1);
  emit('and');                     // T = bit & 1
  lit(3);
  emit('or');                      // T = (bit & 1) XOR 3  (F18A 'or' = XOR)
  emit('!b');                      // drive IO pin, pop
  emit(';');                       // return from emit1

  // Resolve all forward refs within this builtin
  const refErrors: Array<{ message: string }> = [];
  builder.resolveForwardRefs(refErrors, 'asynctx');

  return true;
}

// ---- asyncecho8{}: async serial byte echo — RX via rom.byte, TX via bit-bang ----
//
// Receives one byte from the async serial boot pin using node 708's ROM function
// `byte` (call to 0xd0), then transmits it back as a framed UART byte using the
// same boot-wire bit-bang protocol as asynctx{}.
//
// Only valid on node 708 (async_boot), which has rom.byte at 0xd0.
// B is set to IO (0x15D) for TX (!b) and emulator display.
//
// Architecture (infinite loop, no args):
//   echoLoop:
//     call rom.byte (0xd0)  → T = received byte (8-bit, low 8 bits)
//     dup lit(0x20000) or !b  → write tagged byte to IO (emulator display)
//     call emit8(T)           → TX byte back over async serial
//     jump echoLoop
//
//   emit8(n): start-bit(0), 8 data bits LSB-first, stop-bit(1)
//   emit1(bit): (bit & 1) XOR 3 → !b  (boot-wire drive encoding)
//
// R-stack depth: max 4 (echoLoop call→ret + emit8 ret + bit-loop next + emit1 ret).
// Total: ~32 words (fits comfortably in 64-word node RAM).

function emitAsyncEcho8(
  builder: CodeBuilder,
): boolean {
  const BYTE_ROM_ADDR = 0xd0; // rom.byte on node 708 (async_boot)
  const SYNC_ROM_ADDR = 0xbe; // rom.sync: ( io -- d ) measures half-bit-period
  const BAUD_ADDR     = 0x3E; // RAM word reserved for measured baud delay (d)

  const op = (name: string) => OPCODE_MAP.get(name)!;
  const lit = (v: number) => emitLoadLiteral(builder, v);
  const emit = (name: string) => builder.emitOp(op(name));
  const jmp = (opName: string, addr: number) => builder.emitJump(op(opName), addr);
  const fwj = () => builder.flushWithJump();

  // === SETUP: B = IO (0x15D) ===
  lit(0x15D);
  emit('b!');
  fwj();

  // === AUTO-BAUD: call rom.sync to measure incoming baud rate ===
  // sync ( io -- d ): waits for a high pulse on the serial pin, measures its
  // width, returns d = half-bit-period.  We pass current io via @b.
  // rom.byte (called next) will measure again for each byte start bit, but we
  // need d for our TX delay.  Store d in RAM word BAUD_ADDR.
  emit('@b');                      // T = current io value (input to sync)
  jmp('call', SYNC_ROM_ADDR);      // T = d (half-bit-period measured from RX)
  lit(BAUD_ADDR);
  emit('a!');                      // A = BAUD_ADDR
  emit('!+');                      // RAM[BAUD_ADDR] = d, pop
  fwj();

  // === ECHO LOOP: receive one byte, display it, echo it back, repeat ===
  const echoLoop = builder.getLocationCounter();
  jmp('call', BYTE_ROM_ADDR);      // T = received byte (8-bit); sync rerun by ROM

  // Tag and write to IO for emulator display
  emit('dup');                     // T = byte, S = byte
  lit(0x20000);
  emit('or');                      // T = byte | 0x20000, S = byte
  emit('!b');                      // write tagged to IO, pop → T = byte
  fwj();

  // Echo the byte back
  builder.addForwardRef('__asyncecho8_emit8');
  jmp('call', 0);                  // call emit8(byte)
  jmp('jump', echoLoop);           // loop forever

  // === EMIT8: send 8 bits LSB-first with start/stop bits ===
  // ( byte -- byte>>8 )  clobbers T, uses R for bit counter + return addr
  builder.label('__asyncecho8_emit8');
  lit(0);
  builder.addForwardRef('__asyncecho8_emit1');
  jmp('call', 0);                  // start bit (0)
  lit(7);
  emit('push');                    // R = [7, ret_emit8]
  fwj();
  const bitLoop = builder.getLocationCounter();
  emit('dup');
  builder.addForwardRef('__asyncecho8_emit1');
  jmp('call', 0);                  // emit1(LSB of byte)
  emit('2/');                      // T = byte >> 1
  fwj();
  jmp('next', bitLoop);            // loop 8 times
  lit(1);
  builder.addForwardRef('__asyncecho8_emit1');
  jmp('call', 0);                  // stop bit (1)
  emit(';');                       // return from emit8

  // === EMIT1: transmit one bit via async serial pin, then delay one bit period ===
  // ( bit -- )  encoding: (bit & 1) XOR 3 → !b, then delay 2×d cycles.
  // d (half-bit-period) is stored at BAUD_ADDR.
  // F18A tight loop: push d onto R, then 'unext' in slot 3 decrements R and
  // loops back to the start of its own instruction word until R hits zero.
  // We run two passes (2×d) to cover a full bit period from rom.sync's
  // half-period measurement.
  builder.label('__asyncecho8_emit1');
  lit(1);
  emit('and');                     // T = bit & 1
  lit(3);
  emit('or');                      // T = (bit & 1) XOR 3  (F18A 'or' = XOR)
  emit('!b');                      // drive async serial pin (B=0x15D), pop
  fwj();
  lit(BAUD_ADDR);
  emit('a!');                      // A = BAUD_ADDR
  emit('@');                       // T = d (half-bit-period count)
  emit('push');                    // R = d (loop counter, first half)
  fwj();
  // First half-period tight loop: 'unext' at slot 3 loops back to start of its word
  emit('.');                       // nop
  emit('.');                       // nop
  emit('.');                       // nop
  emit('unext');                   // slot 3: R-- and jump back to start of this word
  // Second half-period: reload d and spin again
  emit('@');                       // T = d (reload for second pass)
  emit('push');                    // R = d
  fwj();
  emit('.');
  emit('.');
  emit('.');
  emit('unext');                   // slot 3: R-- and jump back to start of this word
  emit(';');                       // return from emit1

  // Resolve all forward refs
  const refErrors: Array<{ message: string }> = [];
  builder.resolveForwardRefs(refErrors, 'asyncecho8');

  return true;
}

// ---- hellotx{}: wait for any input byte, send "HELLO WORLD\r\n", loop ----
//
// RAM layout (top of 64-word space):
//   0x30–0x3C  : 13 data words — ASCII bytes of "HELLO WORLD\r\n"
//   0x3D       : string length - 1 = 12  (for 'next' loop counter)
//   0x3E       : measured half-bit-period (d) from rom.sync
//
// Code occupies words 0x00 upward; data at 0x30+ is written directly.
// The emit8/emit1 subroutines are identical to asyncecho8.

function emitHelloTx(builder: CodeBuilder): boolean {
  const BYTE_ROM_ADDR = 0xd0;
  const SYNC_ROM_ADDR = 0xbe;
  const MSG = [72, 69, 76, 76, 79, 32, 87, 79, 82, 76, 68, 13, 10]; // "HELLO WORLD\r\n"
  const MSG_BASE  = 0x30;                 // RAM address of first byte
  const MSG_LEN_ADDR = MSG_BASE + MSG.length; // 0x3D: holds length-1 for 'next'
  const BAUD_ADDR = MSG_LEN_ADDR + 1;    // 0x3E

  const op  = (name: string) => OPCODE_MAP.get(name)!;
  const lit  = (v: number) => emitLoadLiteral(builder, v);
  const emit = (name: string) => builder.emitOp(op(name));
  const jmp  = (opName: string, addr: number) => builder.emitJump(op(opName), addr);
  const fwj  = () => builder.flushWithJump();

  // Write string bytes and length into data RAM directly
  builder.setLocationCounter(MSG_BASE);
  for (const byte of MSG) builder.emitData(byte);
  builder.emitData(MSG.length - 1);  // length-1 at MSG_LEN_ADDR (for 'next' loop)
  // Leave BAUD_ADDR (0x3E) as 0 for now; filled at runtime by sync

  // Code starts at word 0
  builder.setLocationCounter(0);

  // === SETUP: B = IO (0x15D) ===
  lit(0x15D);
  emit('b!');
  fwj();

  // === AUTO-BAUD: rom.sync measures half-bit-period, store in BAUD_ADDR ===
  emit('@b');
  jmp('call', SYNC_ROM_ADDR);          // T = d
  lit(BAUD_ADDR);
  emit('a!');
  emit('!+');                          // RAM[BAUD_ADDR] = d, pop
  fwj();

  // === MAIN LOOP: wait for any input byte, then send "HELLO WORLD\r\n" ===
  const mainLoop = builder.getLocationCounter();
  jmp('call', BYTE_ROM_ADDR);          // T = received byte (discarded)
  emit('drop');                        // discard it
  fwj();

  // Point A at start of string, push length-1 as 'next' counter
  lit(MSG_BASE);
  emit('a!');                          // A = &MSG[0]
  lit(MSG_LEN_ADDR);
  fwj();
  // load length-1 from RAM
  emit('a!');                          // A = MSG_LEN_ADDR  (clobbers A momentarily)
  emit('@');                           // T = length-1
  emit('push');                        // R = [length-1, ...]
  fwj();
  // restore A to string base
  lit(MSG_BASE);
  emit('a!');
  fwj();

  // === STRING LOOP: fetch byte from [A++], emit8 it, next ===
  const strLoop = builder.getLocationCounter();
  emit('@+');                          // T = MSG[i], A++
  builder.addForwardRef('__hellotx_emit8');
  jmp('call', 0);                      // call emit8(byte)
  emit('drop');                        // discard shifted byte residue
  fwj();
  jmp('next', strLoop);                // loop over all bytes
  jmp('jump', mainLoop);               // done — wait for next input byte

  // === EMIT8 ===
  builder.label('__hellotx_emit8');
  lit(0);
  builder.addForwardRef('__hellotx_emit1');
  jmp('call', 0);                      // start bit
  lit(7);
  emit('push');
  fwj();
  const bitLoop = builder.getLocationCounter();
  emit('dup');
  builder.addForwardRef('__hellotx_emit1');
  jmp('call', 0);
  emit('2/');
  fwj();
  jmp('next', bitLoop);
  lit(1);
  builder.addForwardRef('__hellotx_emit1');
  jmp('call', 0);                      // stop bit
  emit(';');                           // return from emit8

  // === EMIT1 ===
  builder.label('__hellotx_emit1');
  lit(1);
  emit('and');
  lit(3);
  emit('or');                          // (bit & 1) XOR 3
  emit('!b');                          // drive pin
  fwj();
  lit(BAUD_ADDR);
  emit('a!');
  emit('@');
  emit('push');
  fwj();
  emit('.');  emit('.');  emit('.');
  emit('unext');                       // first half-period
  emit('@');
  emit('push');
  fwj();
  emit('.');  emit('.');  emit('.');
  emit('unext');                       // second half-period
  emit(';');                           // return from emit1

  const refErrors: Array<{ message: string }> = [];
  builder.resolveForwardRefs(refErrors, 'hellotx');

  return true;
}

// ---- hellotx_rx{}: node 200 — bit-bang async serial RX, relay to node 100 ----
//
// Pin17 = bit17 = MSB of 18-bit F18A word = 0x20000 at IO (0x15D).
// (IO AND PIN): MSB set ↔ pin17 high. '-if' branches when MSB set.
//
// Protocol to node 100 via UP port (0x145):
//   First word:       d = measured half-bit-period (TX baud calibration)
//   Subsequent words: received byte value
//
// Baud: count ~4-cycle iterations while waiting for start bit → d.
// Receive: 1.5-period delay to bit 0 center, then rolled 8-bit loop.
//
// RAM layout:
//   0x3C: accumulator (byte being assembled)
//   0x3D: bit counter scratch (unused — R used instead via ex trick)
//   0x3E: half-bit-period d
//
// Bit loop design: R holds 'next' counter (7 for 8 iters). Inline
// delay uses push/unext which needs R — so we save/restore R via the
// return-stack ex trick: push counter, ex with d, unext, ex back.
// Actually simpler: store acc in RAM, use R only for next counter,
// inline the delay as a tight 'push d; . . . unext' without a call.
// The delay push/unext temporarily uses R but 'next' restores it via
// the address word — actually 'next' and 'unext' share R and conflict.
//
// Conflict-free solution: unroll the inter-bit delay as a fixed number
// of nops proportional to d, OR use A register as delay counter.
// We use A: lit(d_addr); a!; @; push; . . . unext runs the delay,
// then restore A to d_addr for the next load. 'next' jumps BEFORE
// the delay runs, so R is free for 'next'. The trick: put the delay
// BEFORE the sample in the loop body, so 'next' is at the end.
//
// Loop body order: [delay full period] [sample pin] [shift into acc] [next]
// First iteration: delay already happened (1.5-period wait before loop).
// So: skip first delay, then sample→next→delay→sample→...
// Achieved by entering loop at the sample point:
//
//   push 7 (R=7)
//   jump → sample_point (enter loop mid-way)
//   loop_top:
//     [inline delay: load d, push, . . . unext]  ← uses R as delay counter
//   sample_point:                                  ← 'next' jumps here
//     [sample pin17 into acc]
//   next → loop_top
//
// BUT 'next' and the inline unext both use R — conflict!
// The delay unext decrements R to 0, then next decrements R again → wrong.
//
// FINAL SOLUTION: avoid 'next' entirely. Use a RAM counter for the bit loop.
// 8 iterations, countdown in RAM. No R conflict with delay unext.

// ---- hellotx_rx{}: node 200 — bit-bang async serial RX, relay to node 100 ----
//
// Pin17 = bit17 = MSB of 18-bit F18A word = 0x20000 at IO (0x15D).
// '-if' branches when MSB set ↔ pin17 high (mark/idle).
//
// Protocol to node 100 via UP port (0x145):
//   First word:       d = measured half-bit-period (TX baud calibration)
//   Subsequent words: received byte value
//
// Baud: count ~4-cycle iterations while waiting for start bit → d.
// Receive: 1.5-period delay to bit 0 center, then 8-bit loop using RAM
// counter (avoids R conflict with inline push/unext delay).
//
// RAM: ACC_ADDR=0x3C (accumulator), BCNT_ADDR=0x3D (bit counter), BAUD_ADDR=0x3E (d)
// Accumulation: acc = (acc>>1) | pin17_bit each step; shift right 10 at end.

function emitHelloTxRx(builder: CodeBuilder): boolean {
  const PIN       = 0x20000;
  const UP_PORT   = 0x145;
  const BAUD_ADDR = 0x3E;

  const op   = (name: string) => OPCODE_MAP.get(name)!;
  const lit   = (v: number) => emitLoadLiteral(builder, v);
  const emit  = (name: string) => builder.emitOp(op(name));
  const jmp   = (opName: string, addr: number) => builder.emitJump(op(opName), addr);
  const fwj   = () => builder.flushWithJump();

  // === SETUP: B = IO ===
  lit(0x15D); emit('b!'); fwj();

  // === MAIN LOOP ===
  const mainLoopAddr = builder.getLocationCounter();

  // Wait for IDLE (pin17 high).
  // (IO AND PIN) XOR PIN: 0 if high, PIN if low. 'if' loops while low ✓
  const waitIdleAddr = builder.getLocationCounter();
  emit('@b'); lit(PIN); emit('and'); lit(PIN); emit('or');
  jmp('if', waitIdleAddr);

  // Measure baud: count ~4-cycle iterations until start bit falls.
  // (IO AND PIN): MSB set while pin high → '-if' loops while high ✓
  lit(0); fwj();
  const measureAddr = builder.getLocationCounter();
  lit(1); emit('+'); fwj();
  emit('@b'); lit(PIN); emit('and');
  jmp('-if', measureAddr);

  // T = d. Store and send to node 100 for TX calibration.
  emit('dup'); lit(BAUD_ADDR); emit('a!'); emit('!+'); fwj();
  lit(UP_PORT); emit('a!'); emit('!'); fwj();

  // Delay 1.5 periods (3 × half): center on bit 0.
  // Delay sub: call pushes ret-addr to R; push(d) stacks d above it;
  // unext counts d down, pops d, leaving ret-addr; ';' returns ✓
  // This means call+delay works even inside a 'next' loop because
  // R = [..., d, ret-addr, next-ctr, ...] and each layer pops cleanly.
  builder.addForwardRef('__hellotxrx_dly');
  jmp('call', 0);
  builder.addForwardRef('__hellotxrx_dly');
  jmp('call', 0);
  builder.addForwardRef('__hellotxrx_dly');
  jmp('call', 0);

  // === RECEIVE 8 BITS using 'next' loop (R = bit counter) ===
  // Accumulate MSB-first in T: T = (T>>1) | pin17.
  // After 8 iterations: bits in 17..10. Shift right 10 → byte.
  // 'next' counter in R; delay call stacks d+ret above it — safe ✓
  lit(0); fwj();                               // T = acc = 0
  lit(7); emit('push'); fwj();                 // R = 7 (8 iterations)
  const bitLoopAddr = builder.getLocationCounter();
  emit('2/');
  emit('@b'); lit(PIN); emit('and'); emit('or'); fwj(); // acc = (acc>>1)|pin17
  builder.addForwardRef('__hellotxrx_dly');
  jmp('call', 0);                              // delay half period
  builder.addForwardRef('__hellotxrx_dly');
  jmp('call', 0);                              // delay half period → full period
  jmp('next', bitLoopAddr);

  // Byte received in T (bits 17..10). Shift right 10 → bits 7..0.
  for (let i = 0; i < 10; i++) emit('2/');
  fwj();

  // Send byte to node 100, loop
  lit(UP_PORT); emit('a!'); emit('!'); fwj();
  jmp('jump', mainLoopAddr);

  // === DELAY SUBROUTINE: loads d, spins d iters, returns ===
  builder.label('__hellotxrx_dly');
  lit(BAUD_ADDR); emit('a!'); emit('@'); emit('push'); fwj();
  emit('.'); emit('.'); emit('.');
  emit('unext');
  emit(';');                           // return from delay

  const rxRefErrors: Array<{ message: string }> = [];
  builder.resolveForwardRefs(rxRefErrors, 'hellotx_rx');
  return true;
}

function emitHelloTxTx(builder: CodeBuilder): boolean {
  const MSG          = [72, 69, 76, 76, 79, 32, 87, 79, 82, 76, 68, 13, 10];
  const MSG_BASE     = 0x30;
  const MSG_LEN_ADDR = MSG_BASE + MSG.length; // 0x3D
  const BAUD_ADDR    = MSG_LEN_ADDR + 1;      // 0x3E
  const UP_PORT      = 0x145;

  const op   = (name: string) => OPCODE_MAP.get(name)!;
  const lit   = (v: number) => emitLoadLiteral(builder, v);
  const emit  = (name: string) => builder.emitOp(op(name));
  const jmp   = (opName: string, addr: number) => builder.emitJump(op(opName), addr);
  const fwj   = () => builder.flushWithJump();

  // Write string data into high RAM
  builder.setLocationCounter(MSG_BASE);
  for (const byte of MSG) builder.emitData(byte);
  builder.emitData(MSG.length - 1);
  builder.setLocationCounter(0);

  // === SETUP: B = IO, receive d from node 200 ===
  lit(0x15D); emit('b!'); fwj();
  lit(UP_PORT); emit('a!');
  emit('@');
  lit(BAUD_ADDR); emit('a!'); emit('!+'); fwj();

  // === MAIN LOOP: wait for trigger, send string ===
  const mainLoop = builder.getLocationCounter();
  lit(UP_PORT); emit('a!'); emit('@'); emit('drop'); fwj();

  lit(MSG_LEN_ADDR); emit('a!'); emit('@'); emit('push'); fwj(); // R = length-1
  lit(MSG_BASE); emit('a!'); fwj();

  const strLoop = builder.getLocationCounter();
  emit('@+');
  builder.addForwardRef('__hellotxtx_emit8');
  jmp('call', 0);
  emit('drop'); fwj();
  jmp('next', strLoop);
  jmp('jump', mainLoop);

  // === EMIT8: start(0) + 8 data bits LSB-first + stop(1) ===
  builder.label('__hellotxtx_emit8');
  lit(0); builder.addForwardRef('__hellotxtx_emit1'); jmp('call', 0);
  lit(7); emit('push'); fwj();
  const bitLoop = builder.getLocationCounter();
  emit('dup'); builder.addForwardRef('__hellotxtx_emit1'); jmp('call', 0);
  emit('2/'); fwj();
  jmp('next', bitLoop);
  lit(1); builder.addForwardRef('__hellotxtx_emit1'); jmp('call', 0);
  emit(';');                           // return from emit8

  // === EMIT1: (bit&1) XOR 3 → !b, then delay 2×d ===
  builder.label('__hellotxtx_emit1');
  lit(1); emit('and'); lit(3); emit('or'); emit('!b'); fwj();
  lit(BAUD_ADDR); emit('a!'); emit('@'); emit('push'); fwj();
  emit('.'); emit('.'); emit('.');
  emit('unext');
  emit('@'); emit('push'); fwj();
  emit('.'); emit('.'); emit('.');
  emit('unext');
  emit(';');                           // return from emit1

  const txRefErrors: Array<{ message: string }> = [];
  builder.resolveForwardRefs(txRefErrors, 'hellotx_tx');
  return true;
}

// ---- pf_rx{}: node 200 — polyForth-style auto-baud async serial RX ----
//
// Architecture mirrors polyForth pFDISK.blk block 1996.
// Auto-bauds from first received byte, then relays each byte UP to node 100.
//
// F18A conditional branch idiom: '-if' at slot 0 is the only safe encoding.
// When '-if' does NOT branch, slot 1 contains ';' (from addr bits 12:8=0 for
// small RAM addresses). This ';' pops R and jumps — it is INTENTIONAL as the
// subroutine return. Every loop that exits to sequential code MUST use 'call'
// so that R holds the correct return address when '-if' falls through.
//
// waitHigh sub: @b|-if(top) — loops while LOW (bit17=0→branch), returns via ';' when HIGH.
// waitLow sub:  @b|-|-if(top) — loops while HIGH (bit17=0 after NOT→branch), returns via ';' when LOW.
// cntSub: counts iterations while LOW using @b|-if(cntBody) with counter in S.
//   '-if' with raw @b (no NOT): branches when bit17=0 (LOW=loop), falls-through when HIGH (done).
//
// Bit accumulation: acc = (acc>>1) or @b, repeated 8×.
//   After >>10 + &0xFF, noise bits 0–16 are fully shifted out.
//   pin17 of @b contributes to bit 7 of the final byte.
//
// RAM: BAUD_D=0x3E (half-period), BAUD15=0x3D (1.5× period for entry delay).
// Word budget: 64 max.

function emitPfRx(builder: CodeBuilder): boolean {
  const UP_PORT = 0x145;
  const BAUD_D  = 0x3E;
  const BAUD15  = 0x3D;

  const op  = (name: string) => OPCODE_MAP.get(name)!;
  const lit  = (v: number) => emitLoadLiteral(builder, v);
  const emit = (name: string) => builder.emitOp(op(name));
  const jmp  = (o: string, a: number) => builder.emitJump(op(o), a);
  const fwj  = () => builder.flushWithJump();

  // ── Setup ────────────────────────────────────────────────────────────────
  // Load 0x3FFFF into IO register via !b.  B=0x15D (IO port) at reset.
  // The waitHigh subroutine body immediately follows the initial lit so we
  // fold !b into the first iteration of waitHigh (saves 1 word).
  lit(0x3FFFF);

  // ── call waitHigh (initial idle wait) ───────────────────────────────────
  // addForwardRef records this call word so resolveForwardRefs patches the
  // 13-bit addr field to the waitHigh subroutine entry point.
  builder.addForwardRef('__pfrx_wH');
  jmp('call', 0);                   // addr patched to wH label below

  // ── call waitLow (start-bit detection) ──────────────────────────────────
  builder.addForwardRef('__pfrx_wL');
  jmp('call', 0);                   // addr patched to wL label below

  // ── Auto-baud counter ───────────────────────────────────────────────────
  // Push initial counter=0, call cntSub.
  // Returns: T=last IO value (HIGH), S=count. Caller drops T → T=count=d.
  lit(0); fwj();
  builder.addForwardRef('__pfrx_cnt');
  jmp('call', 0);
  emit('drop'); fwj();              // drop last IO val → T = count = d

  // ── Store d and 1.5d timing constants ──────────────────────────────────
  emit('dup'); lit(BAUD_D); emit('a!'); emit('!'); fwj();
  emit('dup'); emit('2/'); fwj();
  emit('+');
  lit(BAUD15); emit('a!'); emit('!'); fwj();

  // ── Send d to node 100 for TX calibration ──────────────────────────────
  lit(BAUD_D); emit('a!'); emit('@'); fwj();
  lit(UP_PORT); emit('a!'); emit('!'); fwj();

  // ── Main receive loop ────────────────────────────────────────────────────
  const mainLoopAddr = builder.getLocationCounter();
  builder.addForwardRef('__pfrx_wL');   // re-use same waitLow sub
  jmp('call', 0);

  // Entry delay: 1.5 baud periods to centre on bit 0.
  lit(BAUD15); emit('a!'); emit('@'); fwj();
  emit('push'); fwj();
  emit('.'); emit('.'); emit('.'); emit('unext');

  // Receive 8 bits: acc = (acc >> 1) | @b, 8 times.
  lit(0); fwj();
  lit(7); emit('push'); fwj();
  const bitAddr = builder.getLocationCounter();
  emit('2/'); emit('@b'); fwj();
  emit('or');
  builder.addForwardRef('__pfrx_dly');
  jmp('call', bitAddr);             // full-period delay
  jmp('next', bitAddr);

  // Extract byte: 10× 2/ then mask.
  emit('2/'); emit('2/'); fwj();
  emit('2/'); emit('2/'); fwj();
  emit('2/'); emit('2/'); fwj();
  emit('2/'); emit('2/'); fwj();
  emit('2/'); emit('2/'); fwj();
  lit(0xFF); emit('and'); fwj();

  // Send byte to node 100, loop.
  lit(UP_PORT); emit('a!'); emit('!'); fwj();
  jmp('jump', mainLoopAddr);

  // ═══════════════════════════════════════════════════════════════════════
  // Subroutines (placed after main code; reached via forward-ref 'call').
  // Each uses the F18A idiom: '-if' at slot 0.  When NOT branching, slot 1
  // decodes as ';' (bits 12:8 of the small target addr = 0), which pops R
  // and returns to the caller.  This is INTENTIONAL.
  // ═══════════════════════════════════════════════════════════════════════

  // ── waitHigh: loops while pin17=LOW, returns via ';' when HIGH ───────────
  // First word also does '!b' (writes IO=0x3FFFF on every pass — harmless).
  // '-if' with raw @b: bit17=0(LOW)→branch; bit17=1(HIGH)→';'→return.
  builder.label('__pfrx_wH');
  emit('!b'); emit('@b'); fwj();    // !b|@b|jump(next word)
  jmp('-if', builder.getLabel('__pfrx_wH')!);   // at slot0; fall-through=';'=return

  // ── waitLow: loops while pin17=HIGH, returns via ';' when LOW ────────────
  // '@b -' (NOT): HIGH→bit17=0→branch(loop); LOW→bit17=1→';'→return.
  builder.label('__pfrx_wL');
  emit('@b'); emit('-'); fwj();     // @b|-|jump(next word)
  jmp('-if', builder.getLabel('__pfrx_wL')!);   // at slot0; fall-through=';'=return

  // ── cntSub: counts while LOW, returns (via ';') when HIGH ───────────────
  // Entry: T=counter (0). @b pushes IO → T=IO, S=counter.
  // '-if' with raw @b: LOW(bit17=0)→branch to cntBody; HIGH(bit17=1)→';'→return.
  // On return: T=IO, S=count. Caller does 'drop' → T=count=d.
  // cntBody: drop IO → T=count; count++; loop.
  builder.label('__pfrx_cnt');
  emit('@b'); fwj();                // push IO
  builder.addForwardRef('__pfrx_cntBody');
  jmp('-if', 0);                    // at slot0: LOW→cntBody; HIGH→';'→return
  // cntBody:
  builder.label('__pfrx_cntBody');
  emit('drop'); fwj();              // drop IO → T=count
  lit(1); emit('+'); fwj();        // count++
  jmp('jump', builder.getLabel('__pfrx_cnt')!);  // loop

  // ── delay sub: spins 2×BAUD_D steps, then returns ───────────────────────
  // 'next' at slot0 with small address: when R=0, slot1 bits = (addr>>8)&31 = 0 = ';'
  // This gives the subroutine return implicitly — no explicit ';' word needed.
  builder.label('__pfrx_dly');
  lit(BAUD_D); emit('a!'); emit('@'); fwj();
  emit('dup'); emit('+'); fwj();   // T = 2d
  emit('push'); fwj();             // push to R as loop counter
  const dlyLoop = builder.getLocationCounter();
  jmp('next', dlyLoop);            // loops; on exit, slot1=';' returns to caller

  builder.resolveForwardRefs([], 'pf_rx');
  return true;
}

// ---- pf_tx{}: node 100 — polyForth-style bit-bang async serial TX ----
//
// Branchless bit output — avoids 'if'/'then' whose fall-through on F18A
// aliases small addresses as ';' (return) in slot1, crashing the node.
//
// Strategy: MARK=0x25555, SPACE=0x35555 differ only at bit16.
//   output = MARK XOR (bit << 16)  where bit = 0 or 1 (F18A 'or' = XOR).
//   Shift 'bit' left 16 places via a call to doShift16 (inner unext loop).
//
// F18A jump bit-width rule:
//   Slot 0 = 13-bit addr, Slot 1 = 8-bit addr, Slot 2 = 3-bit addr.
//   CRITICAL: never pack two ops followed by fwj() when the continuation
//   address > 7 — the slot-2 jump only encodes 3 bits and silently
//   corrupts the target.  Safe rule: at most 1 non-literal op per word.
//
// putchar (char_inv --):  char_inv = char XOR 0xFF  (pre-inverted in data)
//   frame = char_inv << 1       ; start bit = 0 at bit0
//   A = BAUD_D RAM addr (for delay reads throughout)
//   R = 9 (10 iterations: start + 8 data + stop)
//   bitloop:
//     dup                         ; T=frame, S=frame
//     lit(1) and                  ; T=bit(0|1), S=frame
//     call(doShift16)             ; T=bit<<16, S=frame
//     lit(MARK) or !b             ; XOR: MARK^0=MARK  MARK^0x10000=SPACE
//     2/                          ; next bit
//     @ push [. . . unext]        ; delay d iterations
//   next(bitloop)
//   drop ; (return)
//
// doShift16: ( bit -- bit<<16 )
//   lit(15) push                  ; R=15
//   [2* . . unext]                ; 16× 2*  (unext in slot3 is valid)
//   ; (return)                    ; R restored by unext's rPop = P_ret from call
//
// RAM layout (MSG pre-inverted — no runtime XOR needed):
//   0x30 = MSG_BASE  : "HELLO" XOR 0xFF each byte (5 bytes)
//   0x35             : MSG.length-1 = 4  (for outer string next-loop)
//   0x3E = BAUD_D    : d (written at runtime by setup)
//
// Code layout (48 words, data starts at 0x30 = 48):
//   0x00–0x05 : setup        (6 words)  — slot-2 jumps OK: targets 3,6 ≤ 7
//   0x06–0x10 : main loop    (11 words)
//   0x11–0x13 : string loop  (3 words)
//   0x14–0x1A : putchar      (7 words)
//   0x1B–0x2A : bit loop     (16 words)
//   0x2B–0x2F : doShift16    (5 words)

function emitPfTx(builder: CodeBuilder): boolean {
  // Pre-invert message bytes: putchar receives char XOR 0xFF (avoids runtime XOR).
  const MSG_RAW  = [72, 69, 76, 76, 79]; // "HELLO"
  const MSG      = MSG_RAW.map(b => (b ^ 0xFF) & 0xFF);
  const MSG_BASE = 0x33;  // moved up: code now uses 51 words (0-50)
  const BAUD_D   = 0x3E;
  const UP_PORT  = 0x145;
  const MARK     = 0x25555;

  const op   = (name: string) => OPCODE_MAP.get(name)!;
  const lit  = (v: number) => emitLoadLiteral(builder, v);
  const emit = (name: string) => builder.emitOp(op(name));
  const jmp  = (o: string, a: number) => builder.emitJump(op(o), a);
  const fwj  = () => builder.flushWithJump();

  // ── Data: write pre-inverted string + length into high RAM ────────────
  builder.setLocationCounter(MSG_BASE);
  for (const b of MSG) builder.emitData(b);
  builder.emitData(MSG.length - 1);   // length-1 for 'next' loop (at 0x38)
  builder.setLocationCounter(0);

  // ── Setup (words 0–5): receive d from UP port, store at BAUD_D ──────────
  lit(UP_PORT); emit('a!'); emit('@'); fwj(); // [0,1,2]: a!|@|jump(3)
  lit(BAUD_D);  emit('a!'); emit('!+'); fwj(); // [3,4,5]: a!|!+|jump(6)

  // ── Main loop (words 6–16) ─────────────────────────────────────────
  const mainLoopAddr = builder.getLocationCounter(); // = 6
  lit(UP_PORT); emit('a!'); fwj();            // [6,7,8]   A = UP port
  emit('@'); fwj();                           // [9]       blocking read → trigger byte
  emit('drop'); fwj();                        // [10]      discard
  lit(MSG_BASE); emit('a!'); fwj();           // [11,12,13] A = string base
  lit(MSG.length - 1); emit('push'); fwj();   // [14,15,16] R = 4 (string loop counter)

  // ── String loop (words 17–22): save/restore A across putchar ────────
  // Putchar uses A for baud-delay reads, corrupting the string pointer.
  // Save A (string ptr) on the return stack before calling putchar,
  // restore it afterward using pop + a!.
  //
  // Stack trace:
  //   @+ : T=char_inv, A=ptr+1
  //   a  : T=ptr+1, S=char_inv
  //   push: rPush(ptr+1); T=char_inv.  R=ptr+1, rstack=[..,loop_ctr]
  //   call(pc): rPush(P); P=pc.  R=ret_addr, rstack=[..,loop_ctr,ptr+1]
  //   ... putchar transmits char ...
  //   (return via ;): P=R=ret_addr, rPop: R=ptr+1, rstack=[..,loop_ctr]
  //   pop : T=ptr+1, rPop: R=loop_ctr
  //   a!  : A=ptr+1 (restored)
  //   next: loop back
  const strLoopAddr = builder.getLocationCounter(); // = 17
  emit('@+'); fwj();                                    // [17] read char, A=ptr+1
  emit('a'); emit('push'); fwj();                       // [18] save A to rstack
  builder.addForwardRef('__pftx_pc'); jmp('call', 0);   // [19] call putchar
  emit('pop'); emit('a!'); fwj();                       // [20] restore A from rstack
  jmp('next', strLoopAddr);                              // [21]
  jmp('jump', mainLoopAddr);                             // [22]

  // ── putchar (words 23–29): transmit 8N1 frame branchlessly ──────────
  builder.label('__pftx_pc');
  emit('2*'); fwj();                               // [23] frame = char_inv << 1
  lit(BAUD_D); emit('a!'); fwj();                  // [24,25,26] A = BAUD_D addr
  lit(9); emit('push'); fwj();                     // [27,28,29] R = 9 (10-bit loop)

  // ── Bit loop (words 30–45) ─────────────────────────────────────────
  const bitLoopAddr = builder.getLocationCounter(); // = 30
  emit('dup'); fwj();                               // [30]    T=S=frame
  lit(1); emit('and'); fwj();                       // [31,32,33] T=bit(0|1), S=frame
  builder.addForwardRef('__pftx_ds16'); jmp('call', 0); // [34] call(doShift16)
  lit(MARK); emit('or'); fwj();                     // [35,36,37] T = MARK ^ (bit<<16)
  emit('!b'); fwj();                                // [38]    write MARK or SPACE to IO
  emit('2/'); fwj();                                // [39]    shift frame right (next bit)
  emit('@'); emit('2*'); fwj();                     // [40]    T = 2d (scaled for unext timing)
  emit('push'); fwj();                              // [41]    R = 2d
  emit('.'); emit('.'); emit('.'); emit('unext');    // [42]    spin 2d iters (delay)
  jmp('next', bitLoopAddr);                         // [43]
  emit('drop'); fwj();                              // [44]    pop frame
  emit(';'); builder.flush();                       // [45]    return to string loop

  // ── doShift16 (words 46–50): ( bit -- bit<<16 ) ───────────────────
  builder.label('__pftx_ds16');
  lit(15); emit('push'); fwj();                     // [46,47,48] R = 15 (16 iters)
  emit('2*'); emit('.'); emit('.'); emit('unext');   // [49]  2*|.|.|unext (1 word)
  emit(';'); builder.flush();                       // [50]  return

  // Code ends at word 50.  Data lives at MSG_BASE (0x33) through 0x38.
  // Advance LC past the data so the emitter's halt-loop doesn't overwrite it.
  builder.resolveForwardRefs([], 'pf_tx');
  builder.setLocationCounter(MSG_BASE + MSG.length + 1);  // past data
  return true;
}

// ---- lit.hex18/hex9/hex8{value=N}: push masked literal onto T ----

function emitLitHex(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
  mask: number,
): boolean {
  const value = args.get('value');
  if (!value || value.literal === undefined) return false;
  builder.emitLiteral(value.literal & mask);
  return true;
}

// ---- lit.ascii{s="..."}: emit ASCII chars packed 2-per-word onto T ----
// Packing: word = (char[i] << 9) | char[i+1], 9 bits each.

function emitLitAscii(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const s = args.get('s');
  if (!s || s.stringValue === undefined) return false;
  const str = s.stringValue;
  if (str.length === 0) {
    builder.emitLiteral(0);
    return true;
  }
  for (let i = 0; i < str.length; i += 2) {
    const c0 = str.charCodeAt(i) & 0x1FF;
    const c1 = i + 1 < str.length ? str.charCodeAt(i + 1) & 0x1FF : 0;
    builder.emitLiteral((c0 << 9) | c1);
  }
  return true;
}

// ---- lit.utf8{s="..."}: emit UTF-8 bytes packed 2-per-word onto T ----
// Encodes string as UTF-8, then packs 2 bytes per 18-bit word (9 bits each).

function emitLitUtf8(
  builder: CodeBuilder,
  args: Map<string, ArgInfo>,
): boolean {
  const s = args.get('s');
  if (!s || s.stringValue === undefined) return false;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(s.stringValue);
  if (bytes.length === 0) {
    builder.emitLiteral(0);
    return true;
  }
  for (let i = 0; i < bytes.length; i += 2) {
    const b0 = bytes[i] & 0x1FF;
    const b1 = i + 1 < bytes.length ? bytes[i + 1] & 0x1FF : 0;
    builder.emitLiteral((b0 << 9) | b1);
  }
  return true;
}
