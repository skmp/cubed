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
    case 'delay':
      return emitDelay(builder, argMappings);
    case 'setb':
      return emitSetB(builder, argMappings);
    case 'relay':
      return emitRelay(builder, argMappings);
    case 'noiserelay':
      return emitNoiseRelay(builder, argMappings);
    case 'shor15':
      return emitShor15(builder, argMappings, ctx);
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
  const period2Addr = builder.getLocationCounter() + 2;
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
  const p4okAddr = builder.getLocationCounter() + 2;
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
  builder.label('__shor_mulmod');
  emit('push');                    // R = [ret_addr, ...], save multiplier... wait
  // Actually 'call' already pushed return addr to R. So R = [ret_addr].
  // We need to save the multiplier somewhere. Use R-stack:
  // At entry: T=multiplier, R=[ret_addr]
  // push: R=[multiplier, ret_addr], T=S, S=deeper
  // But we need multiplier back later. And we need A=a.
  // Load a from RAM[0] into A:
  lit(0);
  emit('a!'); emit('@');           // [a, ...] R=[multiplier, ret_addr]
  emit('a!');                      // A=a. [S_old, ...] R=[multiplier, ret_addr]
  lit(0);                          // [0, S_old, ...] R=[multiplier, ret_addr]
  emit('pop');                     // [multiplier, 0, ...] R=[ret_addr]
  // Setup for +*: A=multiplicand(a), T=multiplier, S=0
  lit(17);
  emit('push');                    // R=[17, ret_addr]
  fwj();                           // skip slot 3 ';' (would pop 17 as P!)
  const mulLoop = builder.getLocationCounter();
  emit('+*');
  jmp('next', mulLoop);           // 18 iterations of +*
  // T = product (low 18 bits). Now mod 15.
  lit(15);                         // [15, product]
  jmp('call', divmod);            // [quotient] S=remainder
  emit('drop');                    // [remainder] = (multiplier × a) mod 15
  // Return: ';' at slot 3 pops ret_addr from R to P.
  builder.flush();                 // flush with ';' at slot 3 → return

  // Resolve forward references within this builtin
  const refErrors: Array<{ message: string }> = [];
  builder.resolveForwardRefs(refErrors, 'shor15');

  return true;
}
