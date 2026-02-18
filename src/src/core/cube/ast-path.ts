/**
 * AST path system for stable node identity.
 * Each AST node gets a deterministic path string based on its
 * structural position in the tree, enabling stable SceneNode IDs.
 */
import type {
  CubeProgram, Conjunction, ConjunctionItem,
  Term, ArgBinding,
} from './ast';

/** Encode a conjunction item index. */
export function itemPath(index: number): string {
  return `i${index}`;
}

/** Encode a clause index within a predicate definition. */
export function clausePath(parent: string, index: number): string {
  return `${parent}.c${index}`;
}

/** Encode an arg binding index within an application. */
export function argPath(parent: string, index: number): string {
  return `${parent}.a${index}`;
}

/** Encode the term value of an arg or unification. */
export function termPath(parent: string): string {
  return `${parent}.v`;
}

/** Encode a variant index within a type definition. */
export function variantPath(parent: string, index: number): string {
  return `${parent}.t${index}`;
}

/** Type for any AST node we might want to reference. */
export type AstNode = ConjunctionItem | Term | ArgBinding | Conjunction;

/**
 * Build a complete index of all AST nodes by path.
 * Returns a map from path string to the AST node at that path.
 */
export function indexAst(program: CubeProgram): Map<string, AstNode> {
  const index = new Map<string, AstNode>();
  indexConjunction(program.conjunction, '', index);
  return index;
}

function indexConjunction(con: Conjunction, prefix: string, index: Map<string, AstNode>) {
  for (let i = 0; i < con.items.length; i++) {
    const path = prefix ? `${prefix}.i${i}` : `i${i}`;
    const item = con.items[i];
    index.set(path, item);
    indexItem(item, path, index);
  }
}

function indexItem(item: ConjunctionItem, path: string, index: Map<string, AstNode>) {
  switch (item.kind) {
    case 'predicate_def':
      for (let c = 0; c < item.clauses.length; c++) {
        const cp = `${path}.c${c}`;
        index.set(cp, item.clauses[c]);
        indexConjunction(item.clauses[c], cp, index);
      }
      break;
    case 'type_def':
      // Variants are indexed but not deeply walked (no sub-AST)
      for (let v = 0; v < item.variants.length; v++) {
        // Variants don't have a separate AstNode type, skip deep indexing
      }
      break;
    case 'application':
      indexArgs(item.args, path, index);
      break;
    case 'unification':
      indexTerm(item.term, `${path}.v`, index);
      break;
  }
}

function indexArgs(args: ArgBinding[], parentPath: string, index: Map<string, AstNode>) {
  for (let a = 0; a < args.length; a++) {
    const ap = `${parentPath}.a${a}`;
    index.set(ap, args[a]);
    indexTerm(args[a].value, `${ap}.v`, index);
  }
}

function indexTerm(term: Term, path: string, index: Map<string, AstNode>) {
  index.set(path, term);
  if (term.kind === 'app_term') {
    indexArgs(term.args, path, index);
  }
}

/**
 * Get the conjunction item at a root-level path like "i3".
 * Returns undefined if not found.
 */
export function getItemAtPath(program: CubeProgram, path: string): ConjunctionItem | undefined {
  const segments = path.split('.');
  let conjunction = program.conjunction;

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];

    if (seg.startsWith('i')) {
      const idx = parseInt(seg.slice(1), 10);
      const item = conjunction.items[idx];
      if (!item) return undefined;

      // If this is the last segment, return the item
      if (s === segments.length - 1) return item;

      // Navigate deeper based on next segment
      const nextSeg = segments[s + 1];
      if (nextSeg?.startsWith('c') && item.kind === 'predicate_def') {
        const clauseIdx = parseInt(nextSeg.slice(1), 10);
        conjunction = item.clauses[clauseIdx];
        if (!conjunction) return undefined;
        s++; // skip the clause segment
        continue;
      }

      return item;
    }
  }

  return undefined;
}

/**
 * Get the parent conjunction path for an item path.
 * "i3" → "" (root), "i2.c1.i0" → "i2.c1"
 */
export function getParentPath(path: string): string {
  const lastDot = path.lastIndexOf('.i');
  if (lastDot === -1) return '';
  return path.slice(0, lastDot);
}

/**
 * Get the item index from a path ending with "iN".
 */
export function getItemIndex(path: string): number {
  const lastSeg = path.split('.').pop() ?? '';
  if (lastSeg.startsWith('i')) {
    return parseInt(lastSeg.slice(1), 10);
  }
  return -1;
}
