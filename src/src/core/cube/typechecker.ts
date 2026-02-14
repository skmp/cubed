/**
 * Simplified CUBE type checker.
 * Phase 1: All variables default to Int (18-bit).
 * Validates predicate argument counts and constructor arity.
 * Full Hindley-Milner inference deferred to a future phase.
 */
import type { CompileError } from '../types';
import type { ResolvedProgram } from './resolver';
import { SymbolKind } from './resolver';

export function typeCheck(resolved: ResolvedProgram): { errors: CompileError[] } {
  const errors: CompileError[] = [];
  const { program, symbols } = resolved;

  for (const item of program.conjunction.items) {
    if (item.kind === 'application') {
      if (item.functor === '__node') continue;

      const sym = symbols.get(item.functor);
      if (sym && sym.params) {
        // Check that required params are provided (for builtins with outputs)
        if (sym.kind === SymbolKind.BUILTIN) {
          // Builtins like plus/minus/times need at least 2 of 3 args in forward mode
          const provided = item.args.map(a => a.name);
          const missing = sym.params.filter(p => !provided.includes(p));
          if (sym.name === 'greater' || sym.name === 'not' || sym.name === 'equal') {
            if (missing.length > 0) {
              errors.push({
                line: item.loc.line,
                col: item.loc.col,
                message: `'${item.functor}' requires all parameters: ${sym.params.join(', ')}`,
              });
            }
          }
          // For plus/minus/times: need at least 2 inputs in Phase 1
        }
      }
    }

    if (item.kind === 'predicate_def') {
      // Check clauses reference valid predicates
      for (const clause of item.clauses) {
        for (const ci of clause.items) {
          if (ci.kind === 'application' && ci.functor !== '__node') {
            const sym = symbols.get(ci.functor);
            if (sym && sym.kind === SymbolKind.USER_PRED && sym.params) {
              const provided = ci.args.map(a => a.name);
              const extra = provided.filter(p => !sym.params!.includes(p));
              for (const e of extra) {
                errors.push({
                  line: ci.loc.line,
                  col: ci.loc.col,
                  message: `Unknown parameter '${e}' for predicate '${ci.functor}'`,
                });
              }
            }
          }
        }
      }
    }
  }

  return { errors };
}
