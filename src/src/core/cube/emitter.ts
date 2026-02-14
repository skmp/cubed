/**
 * CUBE code emitter.
 * Generates F18A machine code from a resolved CUBE program.
 */
import { OPCODE_MAP } from '../constants';
import { CodeBuilder } from '../codegen/builder';
import { SymbolKind } from './resolver';
import type { ResolvedProgram, ResolvedSymbol } from './resolver';
import type { VariableMap, VarMapping } from './varmapper';
import type { AllocationPlan } from './allocator';
import type { CompiledNode } from '../types';
import type { Conjunction, ConjunctionItem, Application, Unification, Term } from './ast';
import { emitBuiltin, emitLoad, emitLoadLiteral, emitStore } from './builtins';

export function emitCode(
  resolved: ResolvedProgram,
  plan: AllocationPlan,
  varMap: VariableMap,
): CompiledNode[] {
  const builder = new CodeBuilder(64);
  const symbols = new Map<string, number>();

  emitConjunction(builder, resolved.program.conjunction, resolved, varMap);

  // End with a return/suspend
  builder.emitOp(OPCODE_MAP.get(';')!);

  const { mem, len } = builder.build();

  return [{
    coord: plan.nodeCoord,
    mem,
    len,
    symbols,
  }];
}

function emitConjunction(
  builder: CodeBuilder,
  conjunction: Conjunction,
  resolved: ResolvedProgram,
  varMap: VariableMap,
): void {
  for (const item of conjunction.items) {
    emitItem(builder, item, resolved, varMap);
  }
}

function emitItem(
  builder: CodeBuilder,
  item: ConjunctionItem,
  resolved: ResolvedProgram,
  varMap: VariableMap,
): void {
  switch (item.kind) {
    case 'application':
      emitApplication(builder, item, resolved, varMap);
      break;
    case 'unification':
      emitUnification(builder, item, resolved, varMap);
      break;
    case 'predicate_def':
      // User predicate definitions generate callable code
      emitPredicateDef(builder, item, resolved, varMap);
      break;
    case 'type_def':
      // Type definitions don't generate code in Phase 1
      break;
  }
}

function emitApplication(
  builder: CodeBuilder,
  app: Application,
  resolved: ResolvedProgram,
  varMap: VariableMap,
): void {
  if (app.functor === '__node') return; // Node directives handled earlier

  const sym = resolved.symbols.get(app.functor);
  if (!sym) return; // Already reported as error in resolver

  switch (sym.kind) {
    case SymbolKind.BUILTIN:
      emitBuiltinCall(builder, app, sym, varMap);
      break;
    case SymbolKind.F18A_OP:
      emitF18aOp(builder, app, sym);
      break;
    case SymbolKind.ROM_FUNC:
      emitRomCall(builder, sym);
      break;
    case SymbolKind.USER_PRED:
      emitUserPredCall(builder, app, sym, resolved, varMap);
      break;
    default:
      break;
  }
}

function emitBuiltinCall(
  builder: CodeBuilder,
  app: Application,
  sym: ResolvedSymbol,
  varMap: VariableMap,
): void {
  // Build arg mappings from application arguments
  const argMappings = new Map<string, { mapping?: VarMapping; literal?: number }>();

  for (const arg of app.args) {
    const termInfo = resolveTermValue(arg.value, varMap);
    argMappings.set(arg.name, termInfo);
  }

  emitBuiltin(builder, sym.name, argMappings);
}

function emitF18aOp(
  builder: CodeBuilder,
  _app: Application,
  sym: ResolvedSymbol,
): void {
  if (sym.opcode === undefined) return;
  builder.emitOp(sym.opcode);
}

function emitRomCall(
  builder: CodeBuilder,
  sym: ResolvedSymbol,
): void {
  if (sym.romAddr === undefined) return;
  builder.emitJump(OPCODE_MAP.get('call')!, sym.romAddr);
}

function emitUserPredCall(
  builder: CodeBuilder,
  app: Application,
  sym: ResolvedSymbol,
  resolved: ResolvedProgram,
  varMap: VariableMap,
): void {
  if (!sym.def) return;

  // Phase 1: Inline the first clause of the predicate
  // Set up parameter bindings
  for (const arg of app.args) {
    const paramIdx = sym.params?.indexOf(arg.name);
    if (paramIdx !== undefined && paramIdx >= 0) {
      // Bind actual argument to formal parameter
      const paramName = sym.params![paramIdx];
      const paramMapping = varMap.vars.get(paramName);
      if (paramMapping) {
        const termInfo = resolveTermValue(arg.value, varMap);
        if (termInfo.literal !== undefined) {
          emitLoadLiteral(builder, termInfo.literal);
          emitStore(builder, paramMapping);
        } else if (termInfo.mapping) {
          emitLoad(builder, termInfo.mapping);
          emitStore(builder, paramMapping);
        }
      }
    }
  }

  // Emit first clause body (Phase 1: no disjunction handling)
  if (sym.def.clauses.length > 0) {
    emitConjunction(builder, sym.def.clauses[0], resolved, varMap);
  }
}

function emitUnification(
  builder: CodeBuilder,
  unif: Unification,
  _resolved: ResolvedProgram,
  varMap: VariableMap,
): void {
  const varMapping = varMap.vars.get(unif.variable);
  if (!varMapping) return;

  const termInfo = resolveTermValue(unif.term, varMap);
  if (termInfo.literal !== undefined) {
    emitLoadLiteral(builder, termInfo.literal);
    emitStore(builder, varMapping);
  } else if (termInfo.mapping) {
    emitLoad(builder, termInfo.mapping);
    emitStore(builder, varMapping);
  }
}

function emitPredicateDef(
  _builder: CodeBuilder,
  _def: ConjunctionItem,
  _resolved: ResolvedProgram,
  _varMap: VariableMap,
): void {
  // In Phase 1, predicate definitions are handled when called via emitUserPredCall.
  // The definition itself doesn't emit code at the point of definition.
}

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
