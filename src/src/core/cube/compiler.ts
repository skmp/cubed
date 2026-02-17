/**
 * CUBE compiler main pipeline.
 * parse → split by node → (resolve → type check → allocate → map variables → emit) per node
 */
import { tokenizeCube } from './tokenizer';
import { parseCube } from './parser';
import { resolve } from './resolver';
import type { ResolvedSymbol } from './resolver';
import { typeCheck } from './typechecker';
import { allocateNodes } from './allocator';
import { mapVariables } from './varmapper';
import type { VariableMap } from './varmapper';
import { emitCode } from './emitter';
import type { SourceMapEntry } from './emitter';
import type { CubeProgram, ConjunctionItem } from './ast';
import type { CompiledProgram, CompiledNode, CompileError } from '../types';

export interface CubeCompileResult extends CompiledProgram {
  symbols?: Map<string, ResolvedSymbol>;
  variables?: VariableMap;
  sourceMap?: SourceMapEntry[];
  nodeCoord?: number;
  warnings?: CompileError[];
}

/**
 * Split a multi-node program into per-node sub-programs.
 * Items before the first `node` directive are shared definitions
 * available to all nodes. Each `node NNN` starts a new group
 * that runs until the next `node` directive.
 */
function splitByNode(program: CubeProgram): { coord: number; program: CubeProgram }[] {
  const items = program.conjunction.items;
  const shared: ConjunctionItem[] = [];
  const groups: { coord: number; items: ConjunctionItem[] }[] = [];
  let current: { coord: number; items: ConjunctionItem[] } | null = null;

  for (const item of items) {
    if (item.kind === 'application' && item.functor === '__node') {
      const coordArg = item.args.find(a => a.name === 'coord');
      if (coordArg && coordArg.value.kind === 'literal') {
        current = { coord: coordArg.value.value, items: [item] };
        groups.push(current);
      }
    } else if (current) {
      current.items.push(item);
    } else {
      shared.push(item);
    }
  }

  if (groups.length === 0) {
    // No node directives — single-node compilation (default coord 408)
    return [{ coord: 408, program }];
  }

  return groups.map(g => ({
    coord: g.coord,
    program: {
      ...program,
      conjunction: {
        ...program.conjunction,
        items: [...shared, ...g.items],
      },
    },
  }));
}

export function compileCube(source: string): CubeCompileResult {
  // Tokenize
  const { tokens, errors: tokenErrors } = tokenizeCube(source);
  if (tokenErrors.length > 0) {
    return { nodes: [], errors: tokenErrors };
  }

  // Parse
  const { ast, errors: parseErrors } = parseCube(tokens);
  if (parseErrors.length > 0) {
    return { nodes: [], errors: parseErrors };
  }

  // Split by node directives
  const nodeGroups = splitByNode(ast);

  // Compile each node group independently
  const allNodes: CompiledNode[] = [];
  const allErrors: CompileError[] = [];
  const allWarnings: CompileError[] = [];
  const allSourceMap: SourceMapEntry[] = [];
  let lastSymbols: Map<string, ResolvedSymbol> | undefined;
  let lastVarMap: VariableMap | undefined;

  for (const group of nodeGroups) {
    // Resolve symbols for this node group
    const { resolved, errors: resolveErrors } = resolve(group.program);
    if (resolveErrors.length > 0) {
      allErrors.push(...resolveErrors);
      continue;
    }

    // Type check
    const { errors: typeErrors } = typeCheck(resolved);
    if (typeErrors.length > 0) {
      allErrors.push(...typeErrors);
      continue;
    }

    // Allocate
    const plan = allocateNodes(resolved);

    // Map variables
    const varMap = mapVariables(resolved.variables);

    // Emit code
    const { nodes, errors: emitErrors, warnings, sourceMap } = emitCode(resolved, plan, varMap);

    allNodes.push(...nodes);
    allErrors.push(...emitErrors);
    if (warnings) allWarnings.push(...warnings);
    if (sourceMap) allSourceMap.push(...sourceMap);
    lastSymbols = resolved.symbols;
    lastVarMap = varMap;
  }

  return {
    nodes: allErrors.length > 0 ? [] : allNodes,
    errors: allErrors,
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
    symbols: lastSymbols,
    variables: lastVarMap,
    sourceMap: allSourceMap.length > 0 ? allSourceMap : undefined,
    nodeCoord: nodeGroups.length === 1 ? nodeGroups[0].coord : undefined,
  };
}
