/**
 * Hindley-Milner type inference for CUBE programs.
 * Walks the resolved AST and infers types for all variables,
 * checking consistency of predicate applications.
 */
import type { CompileError } from '../types';
import type { ResolvedProgram, ResolvedSymbol } from './resolver';
import { SymbolKind } from './resolver';
import type {
  Conjunction, ConjunctionItem, Application,
  Unification, Term, PredicateDef, TypeDef, TypeExpr,
} from './ast';
import {
  type Type, type TypeScheme,
  Substitution, UnificationError,
  freshVar, resetVarCounter, tInt, tProp, tCon,
  unify, instantiate, prettyType,
} from './cube-types';

// ---- Type environment ----

interface TypeEnv {
  /** Variable name → type */
  vars: Map<string, Type>;
  /** Predicate/builtin name → type scheme */
  predicates: Map<string, TypeScheme>;
  /** Constructor name → type scheme */
  constructors: Map<string, TypeScheme>;
}

function cloneEnv(env: TypeEnv): TypeEnv {
  return {
    vars: new Map(env.vars),
    predicates: new Map(env.predicates),
    constructors: new Map(env.constructors),
  };
}

// ---- Builtin type signatures ----

function makeBuiltinSchemes(): Map<string, TypeScheme> {
  const schemes = new Map<string, TypeScheme>();

  // plus{a:Int, b:Int, c:Int} -> o
  // minus, times: same signature
  for (const name of ['plus', 'minus', 'times']) {
    schemes.set(name, {
      quantified: new Set(),
      type: {
        kind: 'tfunc',
        params: new Map([['a', tInt], ['b', tInt], ['c', tInt]]),
        returnType: tProp,
      },
    });
  }

  // greater{a:Int, b:Int} -> o
  schemes.set('greater', {
    quantified: new Set(),
    type: {
      kind: 'tfunc',
      params: new Map([['a', tInt], ['b', tInt]]),
      returnType: tProp,
    },
  });

  // equal{a:α, b:α} -> o (polymorphic)
  const eqAlpha = freshVar();
  schemes.set('equal', {
    quantified: new Set([eqAlpha.id]),
    type: {
      kind: 'tfunc',
      params: new Map([['a', eqAlpha], ['b', eqAlpha]]),
      returnType: tProp,
    },
  });

  // not{goal:o} -> o
  schemes.set('not', {
    quantified: new Set(),
    type: {
      kind: 'tfunc',
      params: new Map([['goal', tProp]]),
      returnType: tProp,
    },
  });

  // band, bor, bxor: {a:Int, b:Int, c:Int} -> o
  for (const name of ['band', 'bor', 'bxor']) {
    schemes.set(name, {
      quantified: new Set(),
      type: {
        kind: 'tfunc',
        params: new Map([['a', tInt], ['b', tInt], ['c', tInt]]),
        returnType: tProp,
      },
    });
  }

  // bnot: {a:Int, b:Int} -> o
  schemes.set('bnot', {
    quantified: new Set(),
    type: {
      kind: 'tfunc',
      params: new Map([['a', tInt], ['b', tInt]]),
      returnType: tProp,
    },
  });

  // shl, shr: {a:Int, n:Int, c:Int} -> o
  for (const name of ['shl', 'shr']) {
    schemes.set(name, {
      quantified: new Set(),
      type: {
        kind: 'tfunc',
        params: new Map([['a', tInt], ['n', tInt], ['c', tInt]]),
        returnType: tProp,
      },
    });
  }

  // send: {port:Int, value:Int} -> o
  schemes.set('send', {
    quantified: new Set(),
    type: {
      kind: 'tfunc',
      params: new Map([['port', tInt], ['value', tInt]]),
      returnType: tProp,
    },
  });

  // recv: {port:Int, value:Int} -> o
  schemes.set('recv', {
    quantified: new Set(),
    type: {
      kind: 'tfunc',
      params: new Map([['port', tInt], ['value', tInt]]),
      returnType: tProp,
    },
  });

  // setb: {addr:Int} -> o
  schemes.set('setb', {
    quantified: new Set(),
    type: {
      kind: 'tfunc',
      params: new Map([['addr', tInt]]),
      returnType: tProp,
    },
  });

  // relay: {port:Int, count:Int} -> o
  schemes.set('relay', {
    quantified: new Set(),
    type: {
      kind: 'tfunc',
      params: new Map([['port', tInt], ['count', tInt]]),
      returnType: tProp,
    },
  });

  return schemes;
}

// ---- Main inference function ----

export function inferProgram(resolved: ResolvedProgram): { errors: CompileError[] } {
  resetVarCounter();
  const errors: CompileError[] = [];
  const sub = new Substitution();

  const env: TypeEnv = {
    vars: new Map(),
    predicates: makeBuiltinSchemes(),
    constructors: new Map(),
  };

  // First pass: register type definitions and constructors
  for (const item of resolved.program.conjunction.items) {
    if (item.kind === 'type_def') {
      registerTypeDef(item, env);
    }
  }

  // Second pass: register user predicate signatures (with fresh type vars)
  for (const item of resolved.program.conjunction.items) {
    if (item.kind === 'predicate_def') {
      registerPredDef(item, env);
    }
  }

  // Third pass: infer types through all items
  inferConjunction(resolved.program.conjunction, env, sub, resolved.symbols, errors);

  return { errors };
}

// ---- Type definition registration ----

function registerTypeDef(
  def: TypeDef,
  env: TypeEnv,
): void {
  // Create type variables for type parameters
  const typeParamVars = new Map<string, Type>();
  const quantifiedIds = new Set<number>();
  for (const param of def.typeParams) {
    const tv = freshVar();
    typeParamVars.set(param, tv);
    quantifiedIds.add(tv.id);
  }

  // The result type: K{X1=tv1, ..., Xm=tvm}
  const resultType: Type = def.typeParams.length > 0
    ? { kind: 'tapp', constructor: def.name, args: new Map(typeParamVars) }
    : tCon(def.name);

  // Register each constructor
  for (const variant of def.variants) {
    const params = new Map<string, Type>();
    for (const field of variant.fields) {
      // Resolve field type: look up type params, default to Int
      const fieldType = resolveTypeExpr(field.type, typeParamVars);
      params.set(field.name, fieldType);
    }

    // Constructor type: {field1:t1, ...} -> ResultType
    const ctorType: Type = variant.fields.length > 0
      ? { kind: 'tfunc', params, returnType: resultType }
      : resultType; // Nullary constructors are just values of the result type

    env.constructors.set(variant.name, {
      quantified: new Set(quantifiedIds),
      type: ctorType,
    });
  }
}

function resolveTypeExpr(
  typeExpr: TypeExpr,
  typeParamVars: Map<string, Type>,
): Type {
  if (typeExpr.kind === 'type_var') {
    const tv = typeParamVars.get(typeExpr.name);
    return tv ?? tCon(typeExpr.name);
  }
  if (typeExpr.kind === 'type_app') {
    return tCon(typeExpr.constructor);
  }
  return tInt; // Default
}

// ---- Predicate definition registration ----

function registerPredDef(
  def: PredicateDef,
  env: TypeEnv,
): void {
  const params = new Map<string, Type>();
  for (const param of def.params) {
    const tv = freshVar();
    params.set(param.name, tv);
    // Also register the parameter variable in the env
    env.vars.set(param.name, tv);
  }

  const predType: Type = {
    kind: 'tfunc',
    params,
    returnType: tProp,
  };

  env.predicates.set(def.name, {
    quantified: new Set(),
    type: predType,
  });
}

// ---- Conjunction inference ----

function inferConjunction(
  conj: Conjunction,
  env: TypeEnv,
  sub: Substitution,
  symbols: Map<string, ResolvedSymbol>,
  errors: CompileError[],
): void {
  for (const item of conj.items) {
    inferItem(item, env, sub, symbols, errors);
  }
}

// ---- Item inference ----

function inferItem(
  item: ConjunctionItem,
  env: TypeEnv,
  sub: Substitution,
  symbols: Map<string, ResolvedSymbol>,
  errors: CompileError[],
): void {
  switch (item.kind) {
    case 'application':
      inferApplication(item, env, sub, symbols, errors);
      break;
    case 'unification':
      inferUnification(item, env, sub, errors);
      break;
    case 'predicate_def':
      inferPredicateDef(item, env, sub, symbols, errors);
      break;
    case 'type_def':
      // Already handled in registration pass
      break;
  }
}

// ---- Application inference ----

function inferApplication(
  app: Application,
  env: TypeEnv,
  sub: Substitution,
  symbols: Map<string, ResolvedSymbol>,
  errors: CompileError[],
): void {
  if (app.functor === '__node') return;

  const sym = symbols.get(app.functor);
  if (!sym) return;

  // Get the type scheme for this predicate/constructor
  let scheme: TypeScheme | undefined;
  if (sym.kind === SymbolKind.BUILTIN || sym.kind === SymbolKind.USER_PRED) {
    scheme = env.predicates.get(app.functor);
  } else if (sym.kind === SymbolKind.CONSTRUCTOR) {
    scheme = env.constructors.get(app.functor);
  }

  if (!scheme) return;

  // Instantiate the scheme (replace quantified vars with fresh ones)
  const instType = instantiate(scheme);

  // For function types, unify each argument
  if (instType.kind === 'tfunc') {
    for (const arg of app.args) {
      const paramType = instType.params.get(arg.name);
      if (paramType) {
        const argType = inferTerm(arg.value, env, sub, errors);
        try {
          unify(sub, paramType, argType);
        } catch (e) {
          if (e instanceof UnificationError) {
            errors.push({
              line: arg.loc.line,
              col: arg.loc.col,
              message: `Type error in '${app.functor}': parameter '${arg.name}' expected ${prettyType(sub.apply(paramType))} but got ${prettyType(sub.apply(argType))}`,
            });
          }
        }
      }
    }
  }
}

// ---- Unification inference ----

function inferUnification(
  unif: Unification,
  env: TypeEnv,
  sub: Substitution,
  errors: CompileError[],
): void {
  const varType = getOrCreateVarType(unif.variable, env);
  const termType = inferTerm(unif.term, env, sub, errors);

  try {
    unify(sub, varType, termType);
  } catch (e) {
    if (e instanceof UnificationError) {
      errors.push({
        line: unif.loc.line,
        col: unif.loc.col,
        message: `Type error: cannot unify '${unif.variable}' (${prettyType(sub.apply(varType))}) with ${prettyType(sub.apply(termType))}`,
      });
    }
  }
}

// ---- Predicate definition inference ----

function inferPredicateDef(
  def: PredicateDef,
  env: TypeEnv,
  sub: Substitution,
  symbols: Map<string, ResolvedSymbol>,
  errors: CompileError[],
): void {
  // Infer each clause in the predicate's own environment
  const predEnv = cloneEnv(env);

  // Add parameters to the local environment
  for (const param of def.params) {
    if (!predEnv.vars.has(param.name)) {
      predEnv.vars.set(param.name, freshVar());
    }
  }

  for (const clause of def.clauses) {
    inferConjunction(clause, predEnv, sub, symbols, errors);
  }

  // If multiple clauses, their inferred parameter types should be consistent
  // (already handled by shared variables in predEnv)
}

// ---- Term type inference ----

function inferTerm(
  term: Term,
  env: TypeEnv,
  sub: Substitution,
  errors: CompileError[],
): Type {
  switch (term.kind) {
    case 'literal':
      return tInt;
    case 'var':
      return getOrCreateVarType(term.name, env);
    case 'app_term': {
      // Constructor application as a term
      const scheme = env.constructors.get(term.functor);
      if (!scheme) {
        // Unknown constructor — treat as fresh type
        return freshVar();
      }
      const instType = instantiate(scheme);

      if (instType.kind === 'tfunc') {
        // Unify arguments
        for (const arg of term.args) {
          const paramType = instType.params.get(arg.name);
          if (paramType) {
            const argType = inferTerm(arg.value, env, sub, errors);
            try {
              unify(sub, paramType, argType);
            } catch (e) {
              if (e instanceof UnificationError) {
                errors.push({
                  line: arg.loc.line,
                  col: arg.loc.col,
                  message: `Type error in constructor '${term.functor}': field '${arg.name}' expected ${prettyType(sub.apply(paramType))} but got ${prettyType(sub.apply(argType))}`,
                });
              }
            }
          }
        }
        return instType.returnType;
      }
      // Nullary constructor: instType is the result type directly
      return instType;
    }
    case 'rename':
      return freshVar();
  }
}

// ---- Helpers ----

function getOrCreateVarType(name: string, env: TypeEnv): Type {
  let t = env.vars.get(name);
  if (!t) {
    t = freshVar();
    env.vars.set(name, t);
  }
  return t;
}
