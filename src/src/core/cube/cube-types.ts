/**
 * Hindley-Milner type system for CUBE.
 * Provides type representations, substitution, unification, and inference.
 */

// ---- Type representation ----

export type Type = TVar | TCon | TApp | TFunc;

/** Type variable (fresh or unified) */
export interface TVar {
  kind: 'tvar';
  id: number;
}

/** Type constructor (e.g. Int, Float, o) */
export interface TCon {
  kind: 'tcon';
  name: string;
}

/** Type application: a parameterized type (e.g. List{alpha=Int}) */
export interface TApp {
  kind: 'tapp';
  constructor: string;
  args: Map<string, Type>;
}

/** Function/predicate type: {x1:t1, ..., xn:tn} -> t0 */
export interface TFunc {
  kind: 'tfunc';
  params: Map<string, Type>;
  returnType: Type;
}

// ---- Type scheme for polymorphism ----

export interface TypeScheme {
  /** Universally quantified type variable IDs */
  quantified: Set<number>;
  type: Type;
}

// ---- Constructors ----

let nextVarId = 0;

export function freshVar(): TVar {
  return { kind: 'tvar', id: nextVarId++ };
}

export function resetVarCounter(): void {
  nextVarId = 0;
}

export const tInt: TCon = { kind: 'tcon', name: 'Int' };
export const tFloat: TCon = { kind: 'tcon', name: 'Float' };
export const tProp: TCon = { kind: 'tcon', name: 'o' };

export function tCon(name: string): TCon {
  return { kind: 'tcon', name };
}

export function tApp(constructor: string, args: Map<string, Type>): TApp {
  return { kind: 'tapp', constructor, args };
}

export function tFunc(params: Map<string, Type>, returnType: Type): TFunc {
  return { kind: 'tfunc', params, returnType };
}

// ---- Substitution (union-find) ----

export class Substitution {
  private bindings = new Map<number, Type>();

  /** Apply substitution to a type, following chains */
  apply(t: Type): Type {
    switch (t.kind) {
      case 'tvar': {
        const bound = this.bindings.get(t.id);
        if (bound) {
          const resolved = this.apply(bound);
          // Path compression
          if (resolved !== bound) this.bindings.set(t.id, resolved);
          return resolved;
        }
        return t;
      }
      case 'tcon':
        return t;
      case 'tapp': {
        const newArgs = new Map<string, Type>();
        for (const [k, v] of t.args) newArgs.set(k, this.apply(v));
        return { kind: 'tapp', constructor: t.constructor, args: newArgs };
      }
      case 'tfunc': {
        const newParams = new Map<string, Type>();
        for (const [k, v] of t.params) newParams.set(k, this.apply(v));
        return { kind: 'tfunc', params: newParams, returnType: this.apply(t.returnType) };
      }
    }
  }

  /** Bind a type variable to a type */
  bind(id: number, t: Type): void {
    this.bindings.set(id, t);
  }

  /** Get all free type variable IDs in a type */
  freeVars(t: Type): Set<number> {
    const resolved = this.apply(t);
    const result = new Set<number>();
    this.collectFreeVars(resolved, result);
    return result;
  }

  private collectFreeVars(t: Type, result: Set<number>): void {
    switch (t.kind) {
      case 'tvar':
        result.add(t.id);
        break;
      case 'tcon':
        break;
      case 'tapp':
        for (const v of t.args.values()) this.collectFreeVars(v, result);
        break;
      case 'tfunc':
        for (const v of t.params.values()) this.collectFreeVars(v, result);
        this.collectFreeVars(t.returnType, result);
        break;
    }
  }
}

// ---- Unification ----

export class UnificationError extends Error {
  t1: Type;
  t2: Type;
  constructor(t1: Type, t2: Type, message?: string) {
    super(message ?? `Cannot unify ${prettyType(t1)} with ${prettyType(t2)}`);
    this.t1 = t1;
    this.t2 = t2;
  }
}

/** Unify two types under the given substitution. Throws UnificationError on failure. */
export function unify(sub: Substitution, t1: Type, t2: Type): void {
  const a = sub.apply(t1);
  const b = sub.apply(t2);

  // Same type variable
  if (a.kind === 'tvar' && b.kind === 'tvar' && a.id === b.id) return;

  // Bind variable
  if (a.kind === 'tvar') {
    if (occursIn(sub, a.id, b)) {
      throw new UnificationError(a, b, `Infinite type: ${prettyType(a)} occurs in ${prettyType(b)}`);
    }
    sub.bind(a.id, b);
    return;
  }
  if (b.kind === 'tvar') {
    if (occursIn(sub, b.id, a)) {
      throw new UnificationError(a, b, `Infinite type: ${prettyType(b)} occurs in ${prettyType(a)}`);
    }
    sub.bind(b.id, a);
    return;
  }

  // Same constructors
  if (a.kind === 'tcon' && b.kind === 'tcon') {
    if (a.name !== b.name) {
      throw new UnificationError(a, b);
    }
    return;
  }

  // Type applications
  if (a.kind === 'tapp' && b.kind === 'tapp') {
    if (a.constructor !== b.constructor) {
      throw new UnificationError(a, b);
    }
    for (const [k, v] of a.args) {
      const bv = b.args.get(k);
      if (bv) unify(sub, v, bv);
    }
    return;
  }

  // Function types
  if (a.kind === 'tfunc' && b.kind === 'tfunc') {
    for (const [k, v] of a.params) {
      const bv = b.params.get(k);
      if (bv) unify(sub, v, bv);
    }
    unify(sub, a.returnType, b.returnType);
    return;
  }

  throw new UnificationError(a, b);
}

/** Occurs check: does variable id appear in type t? */
function occursIn(sub: Substitution, id: number, t: Type): boolean {
  const resolved = sub.apply(t);
  switch (resolved.kind) {
    case 'tvar': return resolved.id === id;
    case 'tcon': return false;
    case 'tapp':
      for (const v of resolved.args.values()) {
        if (occursIn(sub, id, v)) return true;
      }
      return false;
    case 'tfunc':
      for (const v of resolved.params.values()) {
        if (occursIn(sub, id, v)) return true;
      }
      return occursIn(sub, id, resolved.returnType);
  }
}

// ---- Generalization and instantiation ----

/**
 * Generalize a type: collect all free type variables not in the environment
 * and quantify them.
 */
export function generalize(sub: Substitution, envFreeVars: Set<number>, t: Type): TypeScheme {
  const free = sub.freeVars(t);
  const quantified = new Set<number>();
  for (const id of free) {
    if (!envFreeVars.has(id)) quantified.add(id);
  }
  return { quantified, type: sub.apply(t) };
}

/**
 * Instantiate a type scheme by replacing quantified variables with fresh ones.
 */
export function instantiate(scheme: TypeScheme): Type {
  if (scheme.quantified.size === 0) return scheme.type;

  const mapping = new Map<number, Type>();
  for (const id of scheme.quantified) {
    mapping.set(id, freshVar());
  }

  return substituteVars(scheme.type, mapping);
}

function substituteVars(t: Type, mapping: Map<number, Type>): Type {
  switch (t.kind) {
    case 'tvar': {
      const replacement = mapping.get(t.id);
      return replacement ?? t;
    }
    case 'tcon':
      return t;
    case 'tapp': {
      const newArgs = new Map<string, Type>();
      for (const [k, v] of t.args) newArgs.set(k, substituteVars(v, mapping));
      return { kind: 'tapp', constructor: t.constructor, args: newArgs };
    }
    case 'tfunc': {
      const newParams = new Map<string, Type>();
      for (const [k, v] of t.params) newParams.set(k, substituteVars(v, mapping));
      return { kind: 'tfunc', params: newParams, returnType: substituteVars(t.returnType, mapping) };
    }
  }
}

// ---- Pretty printing ----

export function prettyType(t: Type): string {
  switch (t.kind) {
    case 'tvar': return `?${t.id}`;
    case 'tcon': return t.name;
    case 'tapp': {
      const args = [...t.args.entries()].map(([k, v]) => `${k}=${prettyType(v)}`).join(', ');
      return args ? `${t.constructor}{${args}}` : t.constructor;
    }
    case 'tfunc': {
      const params = [...t.params.entries()].map(([k, v]) => `${k}:${prettyType(v)}`).join(', ');
      return `{${params}} -> ${prettyType(t.returnType)}`;
    }
  }
}
