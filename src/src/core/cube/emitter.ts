/**
 * CUBE code emitter.
 * Generates F18A machine code from a resolved CUBE program.
 */
import { OPCODE_MAP } from '../constants';
import { CodeBuilder } from '../codegen/builder';
import { SymbolKind } from './resolver';
import type { ResolvedProgram, ResolvedSymbol } from './resolver';
import type { VariableMap, VarMapping } from './varmapper';
import { allocateFields } from './varmapper';
import type { AllocationPlan } from './allocator';
import type { CompiledNode, CompileError } from '../types';
import type { Conjunction, ConjunctionItem, Application, Unification, Term, PredicateDef } from './ast';
import { emitBuiltin, emitLoad, emitLoadLiteral, emitStore } from './builtins';
import type { BuiltinContext, ArgInfo } from './builtins';
import { getRomFunctions } from './rom-functions';
import { analyzeClauses } from './clause-analysis';

// ---- Source map entry: maps F18A address to CUBE source location ----

export interface SourceMapEntry {
  addr: number;
  line: number;
  col: number;
  label: string;
}

// ---- Emitter context threaded through all emission functions ----

interface EmitContext {
  builder: CodeBuilder;
  resolved: ResolvedProgram;
  varMap: VariableMap;
  builtinCtx: BuiltinContext;
  errors: CompileError[];
  warnings: CompileError[];
  sourceMap: SourceMapEntry[];
  /** Label to jump to when the current clause/guard fails */
  failLabel?: string;
  /** Counter for generating unique labels */
  labelCounter: number;
}

function nextLabel(ctx: EmitContext, prefix: string): string {
  return `__${prefix}_${ctx.labelCounter++}`;
}

// ---- Main entry point ----

export function emitCode(
  resolved: ResolvedProgram,
  plan: AllocationPlan,
  varMap: VariableMap,
): { nodes: CompiledNode[]; errors: CompileError[]; warnings: CompileError[]; sourceMap: SourceMapEntry[] } {
  const builder = new CodeBuilder(64);
  const symbols = new Map<string, number>();

  // Determine ROM divmod address for the target node
  const romFuncs = getRomFunctions(plan.nodeCoord);
  const romDivmodAddr = romFuncs['divmod'];

  const ctx: EmitContext = {
    builder,
    resolved,
    varMap,
    builtinCtx: { romDivmodAddr },
    errors: [],
    warnings: [],
    sourceMap: [],
    labelCounter: 0,
  };

  emitConjunction(ctx, resolved.program.conjunction);

  // End with a return/suspend
  builder.emitOp(OPCODE_MAP.get(';')!);

  // Resolve any forward references
  const refErrors: Array<{ message: string }> = [];
  builder.resolveForwardRefs(refErrors, 'cube');
  for (const e of refErrors) {
    ctx.warnings.push({ line: 0, col: 0, message: e.message });
  }

  const { mem, len } = builder.build();

  // Error if code exceeds RAM, warn if close to limit
  if (len > 64) {
    ctx.errors.push({
      line: 0, col: 0,
      message: `Generated code uses ${len}/64 words of RAM — exceeds limit`,
    });
  } else if (len > 56) {
    ctx.warnings.push({
      line: 0, col: 0,
      message: `Generated code uses ${len}/64 words of RAM — close to limit`,
    });
  }

  return {
    nodes: [{
      coord: plan.nodeCoord,
      mem,
      len,
      symbols,
    }],
    errors: ctx.errors,
    warnings: ctx.warnings,
    sourceMap: ctx.sourceMap,
  };
}

// ---- Conjunction ----

function emitConjunction(ctx: EmitContext, conjunction: Conjunction): void {
  for (const item of conjunction.items) {
    emitItem(ctx, item);
  }
}

// ---- Single item dispatch ----

function emitItem(ctx: EmitContext, item: ConjunctionItem): void {
  switch (item.kind) {
    case 'application':
      if (item.functor !== '__node') {
        ctx.sourceMap.push({
          addr: ctx.builder.getLocationCounter(),
          line: item.loc.line,
          col: item.loc.col,
          label: item.functor,
        });
      }
      emitApplication(ctx, item);
      break;
    case 'unification':
      ctx.sourceMap.push({
        addr: ctx.builder.getLocationCounter(),
        line: item.loc.line,
        col: item.loc.col,
        label: `${item.variable} = ...`,
      });
      emitUnification(ctx, item);
      break;
    case 'predicate_def':
      // Predicate definitions are handled when called via emitUserPredCall
      break;
    case 'type_def':
      // Type definitions don't generate code yet
      break;
  }
}

// ---- Application ----

function emitApplication(ctx: EmitContext, app: Application): void {
  if (app.functor === '__node') return;

  const sym = ctx.resolved.symbols.get(app.functor);
  if (!sym) return;

  switch (sym.kind) {
    case SymbolKind.BUILTIN:
      emitBuiltinCall(ctx, app, sym);
      break;
    case SymbolKind.F18A_OP:
      if (sym.opcode !== undefined) ctx.builder.emitOp(sym.opcode);
      break;
    case SymbolKind.ROM_FUNC:
      if (sym.romAddr !== undefined) {
        ctx.builder.emitJump(OPCODE_MAP.get('call')!, sym.romAddr);
      }
      break;
    case SymbolKind.USER_PRED:
      emitUserPredCall(ctx, app, sym);
      break;
    case SymbolKind.CONSTRUCTOR:
      emitConstructorApp(ctx, app, sym);
      break;
    default:
      break;
  }
}

// ---- Builtin call ----

function emitBuiltinCall(ctx: EmitContext, app: Application, sym: ResolvedSymbol): void {
  const argMappings = new Map<string, ArgInfo>();
  for (const arg of app.args) {
    const termInfo = resolveTermValue(arg.value, ctx.varMap);
    argMappings.set(arg.name, termInfo);
  }

  const builtinCtx: BuiltinContext = {
    ...ctx.builtinCtx,
    failLabel: ctx.failLabel,
  };

  emitBuiltin(ctx.builder, sym.name, argMappings, builtinCtx);
}

// ---- User predicate call ----

function emitUserPredCall(ctx: EmitContext, app: Application, sym: ResolvedSymbol): void {
  if (!sym.def) return;

  // Set up parameter bindings
  for (const arg of app.args) {
    const paramIdx = sym.params?.indexOf(arg.name);
    if (paramIdx !== undefined && paramIdx >= 0) {
      const paramName = sym.params![paramIdx];
      const paramMapping = ctx.varMap.vars.get(paramName);
      if (paramMapping) {
        const termInfo = resolveTermValue(arg.value, ctx.varMap);
        if (termInfo.literal !== undefined) {
          emitLoadLiteral(ctx.builder, termInfo.literal);
          emitStore(ctx.builder, paramMapping);
        } else if (termInfo.mapping) {
          emitLoad(ctx.builder, termInfo.mapping);
          emitStore(ctx.builder, paramMapping);
        }
      }
    }
  }

  if (sym.def.clauses.length === 1) {
    // Single clause: inline directly
    emitConjunction(ctx, sym.def.clauses[0]);
  } else if (sym.def.clauses.length > 1) {
    // Multiple clauses: conditional branching
    emitMultiClausePred(ctx, sym.def);
  }
}

// ---- Multi-clause predicate emission ----

function emitMultiClausePred(ctx: EmitContext, def: PredicateDef): void {
  const analysis = analyzeClauses(def, ctx.resolved.symbols, ctx.varMap);
  const endLabel = nextLabel(ctx, 'end');
  const clauseLabels: string[] = [];

  for (let i = 0; i < def.clauses.length; i++) {
    clauseLabels.push(nextLabel(ctx, `clause${i}`));
  }
  const failLabel = nextLabel(ctx, 'fail');

  for (let i = 0; i < def.clauses.length; i++) {
    const clause = def.clauses[i];
    const disc = analysis[i];
    const nextClauseLabel = i + 1 < def.clauses.length ? clauseLabels[i + 1] : failLabel;

    ctx.builder.label(clauseLabels[i]);

    if (disc) {
      if (disc.kind === 'literal_match') {
        emitLiteralTest(ctx, disc.paramName, disc.value, nextClauseLabel);
      } else if (disc.kind === 'constructor_match') {
        emitConstructorTagTest(ctx, disc.paramName, disc.constructorName, nextClauseLabel);
      }
    }

    // Emit clause body with fail label pointing to next clause
    const savedFailLabel = ctx.failLabel;
    ctx.failLabel = nextClauseLabel;
    emitConjunction(ctx, clause);
    ctx.failLabel = savedFailLabel;

    // Jump to end after successful clause (unless last)
    if (i < def.clauses.length - 1) {
      ctx.builder.addForwardRef(endLabel);
      ctx.builder.emitJump(OPCODE_MAP.get('jump')!, 0);
    }
  }

  // Fail: all clauses failed — halt
  const failAddr = ctx.builder.label(failLabel);
  ctx.builder.emitJump(OPCODE_MAP.get('jump')!, failAddr);

  // End: successful clause completed
  ctx.builder.label(endLabel);

  const refErrors: Array<{ message: string }> = [];
  ctx.builder.resolveForwardRefs(refErrors, `pred:${def.name}`);
  for (const e of refErrors) {
    ctx.warnings.push({ line: def.loc.line, col: def.loc.col, message: e.message });
  }
}

// ---- Literal discriminant test ----

function emitLiteralTest(
  ctx: EmitContext,
  paramName: string,
  value: number,
  failLabel: string,
): void {
  const paramMapping = ctx.varMap.vars.get(paramName);
  if (!paramMapping) return;

  emitLoad(ctx.builder, paramMapping);

  if (value === 0) {
    // if jumps when T = 0 → match
    ctx.builder.flush();
    const matchAddr = ctx.builder.getLocationCounter() + 2;
    ctx.builder.emitJump(OPCODE_MAP.get('if')!, matchAddr);
    ctx.builder.addForwardRef(failLabel);
    ctx.builder.emitJump(OPCODE_MAP.get('jump')!, 0);
  } else {
    // XOR with expected value: T = param ^ value (0 if equal)
    ctx.builder.emitLiteral(value);
    ctx.builder.emitOp(OPCODE_MAP.get('or')!);  // XOR

    ctx.builder.flush();
    const matchAddr = ctx.builder.getLocationCounter() + 2;
    ctx.builder.emitJump(OPCODE_MAP.get('if')!, matchAddr);
    ctx.builder.addForwardRef(failLabel);
    ctx.builder.emitJump(OPCODE_MAP.get('jump')!, 0);
  }
}

// ---- Constructor tag test (for clause discrimination) ----

/**
 * Test if a parameter matches a specific constructor tag.
 * Loads the param, extracts tag bits, compares with expected tag.
 * Jumps to failLabel if no match.
 */
function emitConstructorTagTest(
  ctx: EmitContext,
  paramName: string,
  constructorName: string,
  failLabel: string,
): void {
  const paramMapping = ctx.varMap.vars.get(paramName);
  if (!paramMapping) return;

  const sym = ctx.resolved.symbols.get(constructorName);
  if (!sym || sym.kind !== SymbolKind.CONSTRUCTOR) return;

  const tag = sym.tag ?? 0;
  const tagBits = sym.tagBits ?? 0;

  emitLoad(ctx.builder, paramMapping);

  if (tagBits > 0) {
    // Extract tag bits
    const tagMask = (1 << tagBits) - 1;
    emitLoadLiteral(ctx.builder, tagMask);
    ctx.builder.emitOp(OPCODE_MAP.get('and')!);    // T = descriptor & tagMask
  }
  // If tagBits === 0, T is just the value (only 1 constructor, always matches)

  if (tagBits > 0) {
    if (tag === 0) {
      ctx.builder.flush();
      const matchAddr = ctx.builder.getLocationCounter() + 2;
      ctx.builder.emitJump(OPCODE_MAP.get('if')!, matchAddr);
      ctx.builder.addForwardRef(failLabel);
      ctx.builder.emitJump(OPCODE_MAP.get('jump')!, 0);
    } else {
      emitLoadLiteral(ctx.builder, tag);
      ctx.builder.emitOp(OPCODE_MAP.get('or')!);   // XOR
      ctx.builder.flush();
      const matchAddr = ctx.builder.getLocationCounter() + 2;
      ctx.builder.emitJump(OPCODE_MAP.get('if')!, matchAddr);
      ctx.builder.addForwardRef(failLabel);
      ctx.builder.emitJump(OPCODE_MAP.get('jump')!, 0);
    }
  }
  // If tagBits === 0 and there's only one constructor, no test needed
}

// ---- Constructor application (construction) ----

/**
 * Emit code to construct a value: allocate fields, store field values,
 * compute descriptor = (base << tagBits) | tag, leave in T.
 *
 * Since emitLoad clobbers A (for variable loads), we store each field
 * individually using explicit address computation.
 */
function emitConstructorApp(ctx: EmitContext, app: Application, sym: ResolvedSymbol): void {
  const tag = sym.tag ?? 0;
  const tagBits = sym.tagBits ?? 0;
  const fields = sym.fields ?? [];

  if (fields.length === 0) {
    // Nullary constructor: descriptor = tag
    emitLoadLiteral(ctx.builder, tag);
    return;
  }

  // Allocate a contiguous block for fields (compile-time allocation)
  const baseAddr = allocateFields(ctx.varMap, fields.length);

  // Store each field value at base+i using explicit address per field
  for (let i = 0; i < fields.length; i++) {
    const fieldName = fields[i];
    const arg = app.args.find(a => a.name === fieldName);
    if (arg) {
      const termInfo = resolveTermValue(arg.value, ctx.varMap);
      if (termInfo.literal !== undefined) {
        emitLoadLiteral(ctx.builder, termInfo.literal);
      } else if (termInfo.mapping) {
        emitLoad(ctx.builder, termInfo.mapping);
      }
      // Store T at address base+i
      ctx.builder.emitOp(OPCODE_MAP.get('push')!);   // save value to R
      emitLoadLiteral(ctx.builder, baseAddr + i);
      ctx.builder.emitOp(OPCODE_MAP.get('a!')!);      // A = base + i
      ctx.builder.emitOp(OPCODE_MAP.get('pop')!);     // restore value
      ctx.builder.emitOp(OPCODE_MAP.get('!')!);        // store to [A]
    }
  }

  // Compute descriptor: (baseAddr << tagBits) | tag, leave in T
  const descriptor = tagBits > 0 ? (baseAddr << tagBits) | tag : baseAddr;
  emitLoadLiteral(ctx.builder, descriptor);
}

/**
 * Emit code to deconstruct a constructor value (pattern matching):
 * extract tag, compare with expected, extract fields.
 *
 * Since emitStore clobbers the A register, we extract fields one at a time
 * using explicit addresses (base+offset) rather than @+.
 */
function emitConstructorMatch(
  ctx: EmitContext,
  varMapping: VarMapping,
  functor: string,
  args: { name: string; value: Term }[],
): void {
  const sym = ctx.resolved.symbols.get(functor);
  if (!sym || sym.kind !== SymbolKind.CONSTRUCTOR) return;

  const tag = sym.tag ?? 0;
  const tagBits = sym.tagBits ?? 0;
  const fields = sym.fields ?? [];

  if (fields.length === 0 && tagBits === 0) {
    // Nullary constructor with no tag bits — nothing to match
    return;
  }

  // Load the variable being matched
  emitLoad(ctx.builder, varMapping);

  // We'll need the base address later for field extraction.
  // For nullary constructors (no fields), we just check the tag.
  // baseAddr is computed at runtime by shifting right.
  // We store the descriptor in a temp RAM location so we can recover it.
  // But: if tagBits === 0, the value IS the base address (no tag).

  if (tagBits > 0) {
    // Save descriptor to return stack for later field extraction
    if (fields.length > 0) {
      ctx.builder.emitOp(OPCODE_MAP.get('dup')!);   // dup descriptor
      ctx.builder.emitOp(OPCODE_MAP.get('push')!);   // save to R
    }

    // Extract tag: T & ((1 << tagBits) - 1)
    const tagMask = (1 << tagBits) - 1;
    emitLoadLiteral(ctx.builder, tagMask);
    ctx.builder.emitOp(OPCODE_MAP.get('and')!);    // T = descriptor & tagMask

    // Compare tag with expected
    if (tag === 0) {
      if (ctx.failLabel) {
        ctx.builder.flush();
        const matchAddr = ctx.builder.getLocationCounter() + 2;
        ctx.builder.emitJump(OPCODE_MAP.get('if')!, matchAddr);
        ctx.builder.addForwardRef(ctx.failLabel);
        ctx.builder.emitJump(OPCODE_MAP.get('jump')!, 0);
      }
    } else {
      emitLoadLiteral(ctx.builder, tag);
      ctx.builder.emitOp(OPCODE_MAP.get('or')!);   // XOR: 0 if equal
      if (ctx.failLabel) {
        ctx.builder.flush();
        const matchAddr = ctx.builder.getLocationCounter() + 2;
        ctx.builder.emitJump(OPCODE_MAP.get('if')!, matchAddr);
        ctx.builder.addForwardRef(ctx.failLabel);
        ctx.builder.emitJump(OPCODE_MAP.get('jump')!, 0);
      }
    }

    // Tag matched — recover descriptor and extract base address
    if (fields.length > 0) {
      ctx.builder.emitOp(OPCODE_MAP.get('pop')!);    // T = descriptor
      for (let i = 0; i < tagBits; i++) {
        ctx.builder.emitOp(OPCODE_MAP.get('2/')!);   // shift right
      }
      // T = base address — store into temp for repeated access
      ctx.builder.emitOp(OPCODE_MAP.get('push')!);   // save base to R
    }
  } else if (fields.length > 0) {
    // tagBits === 0: T is the base address directly
    ctx.builder.emitOp(OPCODE_MAP.get('push')!);     // save base to R
  }

  // Extract each field individually using explicit address loads.
  // Base address is on the return stack.
  for (let i = 0; i < fields.length; i++) {
    const fieldName = fields[i];
    const arg = args.find(a => a.name === fieldName);

    if (arg && arg.value.kind === 'var') {
      const fieldVarMapping = ctx.varMap.vars.get(arg.value.name);
      if (fieldVarMapping) {
        // Load field: set A = base + i, fetch
        ctx.builder.emitOp(OPCODE_MAP.get('pop')!);    // T = base
        if (i < fields.length - 1) {
          ctx.builder.emitOp(OPCODE_MAP.get('dup')!);   // keep base for next field
          ctx.builder.emitOp(OPCODE_MAP.get('push')!);   // save base back to R
        }
        if (i > 0) {
          emitLoadLiteral(ctx.builder, i);
          ctx.builder.emitOp(OPCODE_MAP.get('+')!);     // T = base + i
        }
        ctx.builder.emitOp(OPCODE_MAP.get('a!')!);      // A = base + i
        ctx.builder.emitOp(OPCODE_MAP.get('@')!);        // T = [A] = field value
        emitStore(ctx.builder, fieldVarMapping);
      }
    } else {
      // Field not bound to a variable — skip, but still need to maintain R stack
      if (i < fields.length - 1) {
        // base is still on R, leave it there
      } else {
        // Last field, pop base from R to clean up
        ctx.builder.emitOp(OPCODE_MAP.get('pop')!);
        ctx.builder.emitOp(OPCODE_MAP.get('drop')!);
      }
    }
  }
}

// ---- Unification ----

function emitUnification(ctx: EmitContext, unif: Unification): void {
  const varMapping = ctx.varMap.vars.get(unif.variable);
  if (!varMapping) return;

  if (unif.term.kind === 'app_term') {
    // Constructor pattern match with fields: x = cons{head=h, tail=t}
    emitConstructorMatch(ctx, varMapping, unif.term.functor, unif.term.args);
    return;
  }

  // Check if the term is a bare identifier that's a nullary constructor
  if (unif.term.kind === 'var') {
    const sym = ctx.resolved.symbols.get(unif.term.name);
    if (sym && sym.kind === SymbolKind.CONSTRUCTOR) {
      // Nullary constructor: x = nil → store tag value
      const tag = sym.tag ?? 0;
      emitLoadLiteral(ctx.builder, tag);
      emitStore(ctx.builder, varMapping);
      return;
    }
  }

  const termInfo = resolveTermValue(unif.term, ctx.varMap);
  if (termInfo.literal !== undefined) {
    emitLoadLiteral(ctx.builder, termInfo.literal);
    emitStore(ctx.builder, varMapping);
  } else if (termInfo.mapping) {
    emitLoad(ctx.builder, termInfo.mapping);
    emitStore(ctx.builder, varMapping);
  }
}

// ---- Term value resolution ----

function resolveTermValue(
  term: Term,
  varMap: VariableMap,
): { mapping?: VarMapping; literal?: number } {
  switch (term.kind) {
    case 'literal':
      return { literal: term.value };
    case 'var': {
      const mapping = varMap.vars.get(term.name);
      return mapping ? { mapping } : {};
    }
    default:
      return {};
  }
}
