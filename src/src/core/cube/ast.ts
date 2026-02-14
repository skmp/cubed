/**
 * CUBE language AST type definitions.
 * Based on the formal grammar from docs/cube-language.md Section 8.
 */

// Source location for error reporting
export interface SourceLoc {
  line: number;
  col: number;
}

// === Top-level program ===

export interface CubeProgram {
  kind: 'program';
  conjunction: Conjunction;
  loc: SourceLoc;
}

// === Conjunction: items separated by /\ ===

export interface Conjunction {
  kind: 'conjunction';
  items: ConjunctionItem[];
  loc: SourceLoc;
}

export type ConjunctionItem = PredicateDef | TypeDef | AtomicFormula;

// === Predicate Definition ===
// p = lambda{x1:tau1, ..., xk:tauk}. (con1 \/ ... \/ conn)

export interface PredicateDef {
  kind: 'predicate_def';
  name: string;
  params: ParamDecl[];
  localDefs: (PredicateDef | TypeDef)[];
  clauses: Conjunction[]; // disjunction of conjunctions
  loc: SourceLoc;
}

export interface ParamDecl {
  name: string;
  typeAnnotation?: TypeExpr;
  loc: SourceLoc;
}

// === Type Definition ===
// K = Lambda{X1:TYPE, ..., Xm:TYPE}. V1 + ... + Vn

export interface TypeDef {
  kind: 'type_def';
  name: string;
  typeParams: string[];
  variants: VariantDef[];
  loc: SourceLoc;
}

export interface VariantDef {
  name: string;
  fields: FieldDecl[];
  loc: SourceLoc;
}

export interface FieldDecl {
  name: string;
  type: TypeExpr;
  loc: SourceLoc;
}

// === Type Expressions ===

export type TypeExpr =
  | TypeVar
  | TypeApp
  | FuncType;

export interface TypeVar {
  kind: 'type_var';
  name: string;
  loc: SourceLoc;
}

export interface TypeApp {
  kind: 'type_app';
  constructor: string;
  args: Record<string, TypeExpr>;
  loc: SourceLoc;
}

export interface FuncType {
  kind: 'func_type';
  params: Record<string, TypeExpr>;
  returnType: TypeExpr;
  loc: SourceLoc;
}

// === Atomic Formulas ===
// af :: z = t | z{x1=t1, ..., xn=tn}

export type AtomicFormula = Unification | Application;

export interface Unification {
  kind: 'unification';
  variable: string;
  term: Term;
  loc: SourceLoc;
}

export interface Application {
  kind: 'application';
  functor: string;       // predicate/constructor name (or f18a.xxx / rom.xxx)
  args: ArgBinding[];
  loc: SourceLoc;
}

export interface ArgBinding {
  name: string;
  value: Term;
  loc: SourceLoc;
}

// === Terms ===
// t :: z{x1=t1, ..., xn=tn} | {x1'<-x1, ..., xn'<-xn} | literal

export type Term =
  | VarTerm
  | LitTerm
  | AppTerm
  | RenameTerm;

export interface VarTerm {
  kind: 'var';
  name: string;
  loc: SourceLoc;
}

export interface LitTerm {
  kind: 'literal';
  value: number;
  loc: SourceLoc;
}

export interface AppTerm {
  kind: 'app_term';
  functor: string;
  args: ArgBinding[];
  loc: SourceLoc;
}

export interface RenameTerm {
  kind: 'rename';
  mappings: Array<{ from: string; to: string }>;
  loc: SourceLoc;
}
