/**
 * CUBE compiler main pipeline.
 * parse → resolve → type check → allocate → map variables → emit
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
import type { CompiledProgram, CompileError } from '../types';

export interface CubeCompileResult extends CompiledProgram {
  symbols?: Map<string, ResolvedSymbol>;
  variables?: VariableMap;
  sourceMap?: SourceMapEntry[];
  nodeCoord?: number;
  warnings?: CompileError[];
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

  // Resolve symbols
  const { resolved, errors: resolveErrors } = resolve(ast);
  if (resolveErrors.length > 0) {
    return { nodes: [], errors: resolveErrors };
  }

  // Type check
  const { errors: typeErrors } = typeCheck(resolved);
  if (typeErrors.length > 0) {
    return { nodes: [], errors: typeErrors };
  }

  // Allocate nodes
  const plan = allocateNodes(resolved);

  // Map variables
  const varMap = mapVariables(resolved.variables);

  // Emit code
  const { nodes, errors: emitErrors, warnings, sourceMap } = emitCode(resolved, plan, varMap);

  return {
    nodes,
    errors: emitErrors,
    warnings,
    symbols: resolved.symbols,
    variables: varMap,
    sourceMap,
    nodeCoord: plan.nodeCoord,
  };
}
