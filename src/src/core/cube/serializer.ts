/**
 * CUBE AST serializer — converts a CubeProgram AST back to source text.
 * The output is canonical CUBE that the parser can consume identically.
 *
 * Round-trip guarantee: parse(serialize(ast)) should produce a structurally
 * equivalent AST (ignoring loc fields and comment whitespace).
 */
import type {
  CubeProgram, Conjunction, ConjunctionItem, PredicateDef, TypeDef,
  ParamDecl, VariantDef, TypeExpr,
  Application, Unification, Term, ArgBinding,
} from './ast';

/** Serialize a CubeProgram AST to CUBE source text. */
export function serializeCube(program: CubeProgram): string {
  return serializeConjunctionTopLevel(program.conjunction);
}

/**
 * Top-level conjunction serialization.
 * Groups items by __node directives with blank lines between node blocks.
 */
function serializeConjunctionTopLevel(con: Conjunction): string {
  const groups: ConjunctionItem[][] = [[]];

  for (const item of con.items) {
    if (isNodeDirective(item)) {
      // Start a new group
      groups.push([item]);
    } else {
      groups[groups.length - 1].push(item);
    }
  }

  // Filter out empty groups
  const nonEmpty = groups.filter(g => g.length > 0);

  return nonEmpty.map(group => {
    return group.map(serializeItem).join('\n/\\\n');
  }).join('\n\n');
}

function isNodeDirective(item: ConjunctionItem): boolean {
  return item.kind === 'application' && item.functor === '__node';
}

/** Serialize a conjunction as /\-separated items. */
function serializeConjunction(con: Conjunction): string {
  return con.items.map(serializeItem).join(' /\\ ');
}

/** Serialize a single conjunction item. */
function serializeItem(item: ConjunctionItem): string {
  switch (item.kind) {
    case 'predicate_def':
      return serializePredicateDef(item);
    case 'type_def':
      return serializeTypeDef(item);
    case 'application':
      return serializeApplication(item);
    case 'unification':
      return serializeUnification(item);
  }
}

/** Serialize a predicate definition. */
function serializePredicateDef(def: PredicateDef): string {
  const params = def.params.map(serializeParamDecl).join(', ');
  const body = def.clauses.map(serializeConjunction).join(' \\/ ');

  if (def.clauses.length > 1) {
    return `${def.name} = lambda{${params}}. (${body})`;
  }
  return `${def.name} = lambda{${params}}. ${body}`;
}

function serializeParamDecl(p: ParamDecl): string {
  if (p.typeAnnotation) {
    return `${p.name}:${serializeTypeExpr(p.typeAnnotation)}`;
  }
  return p.name;
}

/** Serialize a type definition. */
function serializeTypeDef(def: TypeDef): string {
  const params = def.typeParams.join(', ');
  const variants = def.variants.map(serializeVariant).join(' + ');
  return `${def.name} = Lambda{${params}}. ${variants}`;
}

function serializeVariant(v: VariantDef): string {
  if (v.fields.length === 0) return v.name;
  const fields = v.fields.map(f => `${f.name}: ${serializeTypeExpr(f.type)}`).join(', ');
  return `${v.name}{${fields}}`;
}

/** Serialize a type expression. */
function serializeTypeExpr(te: TypeExpr): string {
  switch (te.kind) {
    case 'type_var':
      return te.name;
    case 'type_app': {
      const entries = Object.entries(te.args);
      if (entries.length === 0) return te.constructor;
      const args = entries.map(([k, v]) => `${k}=${serializeTypeExpr(v)}`).join(', ');
      return `${te.constructor}{${args}}`;
    }
    case 'func_type': {
      const params = Object.entries(te.params).map(([k, v]) => `${k}: ${serializeTypeExpr(v)}`).join(', ');
      return `{${params}} -> ${serializeTypeExpr(te.returnType)}`;
    }
  }
}

/** Serialize an application (or __node directive). */
function serializeApplication(app: Application): string {
  // Special handling for __node → node NNN
  if (app.functor === '__node') {
    const coord = app.args[0]?.value;
    if (coord && coord.kind === 'literal') {
      return `node ${coord.value}`;
    }
  }

  // Special handling for __include → #include <name>
  if (app.functor === '__include') {
    const mod = app.args[0]?.value;
    if (mod && mod.kind === 'var') {
      return `#include ${mod.name}`;
    }
  }

  if (app.args.length === 0) {
    return app.functor;
  }
  const args = app.args.map(serializeArgBinding).join(', ');
  return `${app.functor}{${args}}`;
}

function serializeArgBinding(ab: ArgBinding): string {
  return `${ab.name}=${serializeTerm(ab.value)}`;
}

/** Serialize a unification. */
function serializeUnification(u: Unification): string {
  return `${u.variable} = ${serializeTerm(u.term)}`;
}

/** Serialize a term. */
function serializeTerm(t: Term): string {
  switch (t.kind) {
    case 'var':
      return t.name;
    case 'literal':
      return serializeLiteral(t.value);
    case 'app_term': {
      if (t.args.length === 0) return t.functor;
      const args = t.args.map(serializeArgBinding).join(', ');
      return `${t.functor}{${args}}`;
    }
    case 'string_literal':
      return `"${t.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
    case 'rename': {
      const mappings = t.mappings.map(m => `${m.to}<-${m.from}`).join(', ');
      return `{${mappings}}`;
    }
  }
}

/** Format a numeric literal: hex for values >= 0x100 or negative hex, decimal otherwise. */
function serializeLiteral(value: number): string {
  if (value < 0) {
    return `-0x${Math.abs(value).toString(16)}`;
  }
  if (value >= 0x100) {
    return `0x${value.toString(16).toUpperCase()}`;
  }
  return String(value);
}
