/**
 * CUBE symbol resolver.
 * Builds a scope tree, registers builtins and F18A/ROM primitives,
 * resolves all predicate/constructor references.
 */
import { OPCODES } from '../constants';
import { getRomFunctions } from './rom-functions';
import type { CompileError } from '../types';
import type {
  CubeProgram, Conjunction, ConjunctionItem,
  PredicateDef, Application,
  Term,
} from './ast';

// === Resolved symbol types ===

export const SymbolKind = {
  BUILTIN: 'builtin',
  F18A_OP: 'f18a_op',
  ROM_FUNC: 'rom_func',
  USER_PRED: 'user_pred',
  CONSTRUCTOR: 'constructor',
  VARIABLE: 'variable',
} as const;
export type SymbolKind = typeof SymbolKind[keyof typeof SymbolKind];

export interface ResolvedSymbol {
  kind: SymbolKind;
  name: string;
  opcode?: number;       // for F18A ops
  romAddr?: number;      // for ROM functions
  params?: string[];     // for user predicates
  def?: PredicateDef;    // for user predicates
}

export interface ResolvedProgram {
  program: CubeProgram;
  symbols: Map<string, ResolvedSymbol>;
  nodeCoord: number;     // target node coordinate
  variables: Set<string>; // all variables used
}

// Builtin predicate parameter definitions
const BUILTIN_PARAMS: Record<string, string[]> = {
  plus:    ['a', 'b', 'c'],
  minus:   ['a', 'b', 'c'],
  times:   ['a', 'b', 'c'],
  greater: ['a', 'b'],
  not:     ['goal'],
  equal:   ['a', 'b'],
};

// F18A opcode names mapped to clean identifiers
const F18A_NAMES: Record<string, string> = {
  ';':    'ret',
  'ex':   'ex',
  'jump': 'jump',
  'call': 'call',
  'unext': 'unext',
  'next': 'next',
  'if':   'IF',
  '-if':  'nif',
  '@p':   'fetchp',
  '@+':   'fetchplus',
  '@b':   'fetchb',
  '@':    'fetch',
  '!p':   'storep',
  '!+':   'storeplus',
  '!b':   'storeb',
  '!':    'store',
  '+*':   'mulstep',
  '2*':   'shl',
  '2/':   'shr',
  '-':    'not',
  '+':    'add',
  'and':  'and',
  'or':   'xor',
  'drop': 'drop',
  'dup':  'dup',
  'pop':  'pop',
  'over': 'over',
  'a':    'a',
  '.':    'nop',
  'push': 'push',
  'b!':   'bstore',
  'a!':   'astore',
};

export function resolve(program: CubeProgram, targetCoord: number = 408): { resolved: ResolvedProgram; errors: CompileError[] } {
  const errors: CompileError[] = [];
  const symbols = new Map<string, ResolvedSymbol>();
  const variables = new Set<string>();

  // Register builtins
  for (const [name, params] of Object.entries(BUILTIN_PARAMS)) {
    symbols.set(name, { kind: SymbolKind.BUILTIN, name, params });
  }

  // Register F18A primitives as f18a.xxx
  for (let i = 0; i < OPCODES.length; i++) {
    const rawName = OPCODES[i];
    const cleanName = F18A_NAMES[rawName] ?? rawName;
    const fullName = `f18a.${cleanName}`;
    symbols.set(fullName, { kind: SymbolKind.F18A_OP, name: fullName, opcode: i });
  }

  // Detect target node from program (look for __node directive)
  let nodeCoord = targetCoord;
  for (const item of program.conjunction.items) {
    if (item.kind === 'application' && item.functor === '__node') {
      const coordArg = item.args.find(a => a.name === 'coord');
      if (coordArg && coordArg.value.kind === 'literal') {
        nodeCoord = coordArg.value.value;
      }
    }
  }

  // Register ROM functions for target node
  const romFuncs = getRomFunctions(nodeCoord);
  for (const [name, addr] of Object.entries(romFuncs)) {
    symbols.set(`rom.${name}`, { kind: SymbolKind.ROM_FUNC, name: `rom.${name}`, romAddr: addr });
  }

  // First pass: collect user predicate definitions
  collectDefs(program.conjunction, symbols, errors);

  // Second pass: resolve all references and collect variables
  resolveConjunction(program.conjunction, symbols, variables, errors);

  return {
    resolved: { program, symbols, nodeCoord, variables },
    errors,
  };
}

function collectDefs(conjunction: Conjunction, symbols: Map<string, ResolvedSymbol>, errors: CompileError[]): void {
  for (const item of conjunction.items) {
    if (item.kind === 'predicate_def') {
      if (symbols.has(item.name)) {
        errors.push({ line: item.loc.line, col: item.loc.col, message: `Redefinition of '${item.name}'` });
      }
      symbols.set(item.name, {
        kind: SymbolKind.USER_PRED,
        name: item.name,
        params: item.params.map(p => p.name),
        def: item,
      });
      // Recurse into clauses
      for (const clause of item.clauses) {
        collectDefs(clause, symbols, errors);
      }
    }
  }
}

function resolveConjunction(conjunction: Conjunction, symbols: Map<string, ResolvedSymbol>, variables: Set<string>, errors: CompileError[]): void {
  for (const item of conjunction.items) {
    resolveItem(item, symbols, variables, errors);
  }
}

function resolveItem(item: ConjunctionItem, symbols: Map<string, ResolvedSymbol>, variables: Set<string>, errors: CompileError[]): void {
  switch (item.kind) {
    case 'predicate_def':
      for (const param of item.params) {
        variables.add(param.name);
      }
      for (const clause of item.clauses) {
        resolveConjunction(clause, symbols, variables, errors);
      }
      break;

    case 'type_def':
      // Type defs don't need variable resolution in Phase 1
      break;

    case 'unification':
      variables.add(item.variable);
      resolveTerm(item.term, symbols, variables, errors);
      break;

    case 'application':
      resolveApplication(item, symbols, variables, errors);
      break;
  }
}

function resolveApplication(app: Application, symbols: Map<string, ResolvedSymbol>, variables: Set<string>, errors: CompileError[]): void {
  if (app.functor === '__node') return; // Skip node directives

  const sym = symbols.get(app.functor);
  if (!sym) {
    errors.push({ line: app.loc.line, col: app.loc.col, message: `Undefined predicate or function: '${app.functor}'` });
  } else if (sym.kind === SymbolKind.BUILTIN || sym.kind === SymbolKind.USER_PRED) {
    // Validate argument names match parameter names
    if (sym.params) {
      for (const arg of app.args) {
        if (!sym.params.includes(arg.name)) {
          errors.push({ line: arg.loc.line, col: arg.loc.col, message: `Unknown parameter '${arg.name}' for '${app.functor}'` });
        }
      }
    }
  }

  for (const arg of app.args) {
    resolveTerm(arg.value, symbols, variables, errors);
  }
}

function resolveTerm(term: Term, symbols: Map<string, ResolvedSymbol>, variables: Set<string>, errors: CompileError[]): void {
  switch (term.kind) {
    case 'var':
      variables.add(term.name);
      break;
    case 'literal':
      break;
    case 'app_term':
      if (!symbols.has(term.functor)) {
        errors.push({ line: term.loc.line, col: term.loc.col, message: `Undefined constructor or predicate: '${term.functor}'` });
      }
      for (const arg of term.args) {
        resolveTerm(arg.value, symbols, variables, errors);
      }
      break;
    case 'rename':
      break;
  }
}
