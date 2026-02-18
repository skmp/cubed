/**
 * Immutable AST mutation helpers.
 * Each function returns a new CubeProgram with the specified change applied.
 * The original AST is never modified.
 */
import type {
  CubeProgram, Conjunction, ConjunctionItem, Application, Unification,
  Term, ArgBinding, SourceLoc,
} from './ast';

const LOC_ZERO: SourceLoc = { line: 0, col: 0 };

/** Deep clone a CubeProgram. */
function cloneProgram(program: CubeProgram): CubeProgram {
  return JSON.parse(JSON.stringify(program));
}

/**
 * Navigate to a conjunction by path (e.g., "" for root, "i2.c1" for clause 1 of item 2).
 * Returns the conjunction and its parent info for mutation.
 */
function getConjunction(program: CubeProgram, conjPath: string): Conjunction | undefined {
  if (conjPath === '') return program.conjunction;

  const segments = conjPath.split('.');
  let conjunction = program.conjunction;

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];

    if (seg.startsWith('i')) {
      const idx = parseInt(seg.slice(1), 10);
      const item = conjunction.items[idx];
      if (!item) return undefined;

      const nextSeg = segments[s + 1];
      if (nextSeg?.startsWith('c') && item.kind === 'predicate_def') {
        const clauseIdx = parseInt(nextSeg.slice(1), 10);
        conjunction = item.clauses[clauseIdx];
        if (!conjunction) return undefined;
        s++; // skip clause segment
      }
    }
  }

  return conjunction;
}

/** Add a conjunction item at a given path. */
export function addConjunctionItem(
  program: CubeProgram,
  conjPath: string,
  item: ConjunctionItem,
  insertIndex?: number,
): CubeProgram {
  const clone = cloneProgram(program);
  const conj = getConjunction(clone, conjPath);
  if (!conj) return clone;

  const idx = insertIndex ?? conj.items.length;
  conj.items.splice(idx, 0, item);
  return clone;
}

/** Remove a conjunction item by its path (e.g., "i3" or "i2.c1.i0"). */
export function removeConjunctionItem(
  program: CubeProgram,
  itemPath: string,
): CubeProgram {
  const clone = cloneProgram(program);
  const lastDot = itemPath.lastIndexOf('.i');
  let conjPath: string;
  let itemIdx: number;

  if (lastDot === -1) {
    // Root level: "i3"
    conjPath = '';
    itemIdx = parseInt(itemPath.slice(1), 10);
  } else {
    conjPath = itemPath.slice(0, lastDot);
    itemIdx = parseInt(itemPath.slice(lastDot + 2), 10);
  }

  const conj = getConjunction(clone, conjPath);
  if (!conj || itemIdx < 0 || itemIdx >= conj.items.length) return clone;

  conj.items.splice(itemIdx, 1);
  return clone;
}

/** Replace a conjunction item at a given path. */
export function replaceConjunctionItem(
  program: CubeProgram,
  itemPath: string,
  newItem: ConjunctionItem,
): CubeProgram {
  const clone = cloneProgram(program);
  const lastDot = itemPath.lastIndexOf('.i');
  let conjPath: string;
  let itemIdx: number;

  if (lastDot === -1) {
    conjPath = '';
    itemIdx = parseInt(itemPath.slice(1), 10);
  } else {
    conjPath = itemPath.slice(0, lastDot);
    itemIdx = parseInt(itemPath.slice(lastDot + 2), 10);
  }

  const conj = getConjunction(clone, conjPath);
  if (!conj || itemIdx < 0 || itemIdx >= conj.items.length) return clone;

  conj.items[itemIdx] = newItem;
  return clone;
}

/** Update a literal value at a given path (e.g., "i3.a1.v"). */
export function updateLiteralValue(
  program: CubeProgram,
  path: string,
  newValue: number,
): CubeProgram {
  const clone = cloneProgram(program);
  const node = navigateToNode(clone, path);
  if (node && node.kind === 'literal') {
    node.value = newValue;
  }
  return clone;
}

/** Update the functor name of an application or the variable name of a unification. */
export function updateNodeLabel(
  program: CubeProgram,
  itemPath: string,
  newName: string,
): CubeProgram {
  const clone = cloneProgram(program);
  const lastDot = itemPath.lastIndexOf('.i');
  let conjPath: string;
  let itemIdx: number;

  if (lastDot === -1) {
    conjPath = '';
    itemIdx = parseInt(itemPath.slice(1), 10);
  } else {
    conjPath = itemPath.slice(0, lastDot);
    itemIdx = parseInt(itemPath.slice(lastDot + 2), 10);
  }

  const conj = getConjunction(clone, conjPath);
  if (!conj || itemIdx < 0 || itemIdx >= conj.items.length) return clone;

  const item = conj.items[itemIdx];
  if (item.kind === 'application') {
    item.functor = newName;
  } else if (item.kind === 'unification') {
    item.variable = newName;
  } else if (item.kind === 'predicate_def') {
    item.name = newName;
  }
  return clone;
}

/** Add an arg binding to an application. */
export function addArgBinding(
  program: CubeProgram,
  appPath: string,
  arg: ArgBinding,
): CubeProgram {
  const clone = cloneProgram(program);
  const lastDot = appPath.lastIndexOf('.i');
  let conjPath: string;
  let itemIdx: number;

  if (lastDot === -1) {
    conjPath = '';
    itemIdx = parseInt(appPath.slice(1), 10);
  } else {
    conjPath = appPath.slice(0, lastDot);
    itemIdx = parseInt(appPath.slice(lastDot + 2), 10);
  }

  const conj = getConjunction(clone, conjPath);
  if (!conj) return clone;

  const item = conj.items[itemIdx];
  if (item?.kind === 'application') {
    item.args.push(arg);
  }
  return clone;
}

/** Remove an arg binding by its path (e.g., "i3.a1"). */
export function removeArgBinding(
  program: CubeProgram,
  argBindingPath: string,
): CubeProgram {
  const clone = cloneProgram(program);
  // Parse the path: everything before .aN is the application path, N is the arg index
  const match = argBindingPath.match(/^(.+)\.a(\d+)$/);
  if (!match) return clone;

  const [, appPath, argIdxStr] = match;
  const argIdx = parseInt(argIdxStr, 10);

  const lastDot = appPath.lastIndexOf('.i');
  let conjPath: string;
  let itemIdx: number;

  if (lastDot === -1) {
    conjPath = '';
    itemIdx = parseInt(appPath.slice(1), 10);
  } else {
    conjPath = appPath.slice(0, lastDot);
    itemIdx = parseInt(appPath.slice(lastDot + 2), 10);
  }

  const conj = getConjunction(clone, conjPath);
  if (!conj) return clone;

  const item = conj.items[itemIdx];
  if (item?.kind === 'application' && argIdx >= 0 && argIdx < item.args.length) {
    item.args.splice(argIdx, 1);
  }
  return clone;
}

/** Create a new empty application node. */
export function createApplication(functor: string, args?: ArgBinding[]): Application {
  return {
    kind: 'application',
    functor,
    args: args ?? [],
    loc: LOC_ZERO,
  };
}

/** Create a new unification node. */
export function createUnification(variable: string, term: Term): Unification {
  return {
    kind: 'unification',
    variable,
    term,
    loc: LOC_ZERO,
  };
}

/** Create a new arg binding. */
export function createArgBinding(name: string, value: Term): ArgBinding {
  return { name, value, loc: LOC_ZERO };
}

/** Create a literal term. */
export function createLiteral(value: number): Term {
  return { kind: 'literal', value, loc: LOC_ZERO };
}

/** Create a variable term. */
export function createVar(name: string): Term {
  return { kind: 'var', name, loc: LOC_ZERO };
}

/**
 * Navigate deep into the cloned AST to find the node at a given path.
 * This is a mutable reference into the clone — modifications will update the clone.
 */
function navigateToNode(program: CubeProgram, path: string): Term | undefined {
  const segments = path.split('.');
  let conjunction = program.conjunction;
  let currentItem: ConjunctionItem | undefined;

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];

    if (seg.startsWith('i')) {
      const idx = parseInt(seg.slice(1), 10);
      currentItem = conjunction.items[idx];
      if (!currentItem) return undefined;
    } else if (seg.startsWith('c') && currentItem?.kind === 'predicate_def') {
      const clauseIdx = parseInt(seg.slice(1), 10);
      conjunction = currentItem.clauses[clauseIdx];
      if (!conjunction) return undefined;
      currentItem = undefined;
    } else if (seg.startsWith('a') && currentItem) {
      const argIdx = parseInt(seg.slice(1), 10);
      if (currentItem.kind === 'application') {
        const arg = currentItem.args[argIdx];
        if (!arg) return undefined;
        // If next segment is 'v', return the term value
        if (segments[s + 1] === 'v') {
          return arg.value;
        }
      }
    } else if (seg === 'v' && currentItem?.kind === 'unification') {
      return currentItem.term;
    }
  }

  return undefined;
}
