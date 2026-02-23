/**
 * CUBE type checker.
 * Combines structural validation (arity checks) with
 * Hindley-Milner type inference.
 */
import type { CompileError } from '../types';
import type { ResolvedProgram } from './resolver';
import { SymbolKind } from './resolver';
import { inferProgram } from './inference';

export function typeCheck(resolved: ResolvedProgram): { errors: CompileError[] } {
  const errors: CompileError[] = [];
  const { program, symbols } = resolved;

  // Structural validation: arity and parameter checks
  for (const item of program.conjunction.items) {
    if (item.kind === 'application') {
      if (item.functor === '__node' || item.functor === '__include') continue;

      const sym = symbols.get(item.functor);
      if (sym && sym.params) {
        if (sym.kind === SymbolKind.BUILTIN) {
          const provided = item.args.map(a => a.name);
          const missing = sym.params.filter(p => !provided.includes(p));
          const bareName = sym.name.startsWith('std.') ? sym.name.slice(4) : sym.name;
          if (bareName === 'greater' || bareName === 'not' || bareName === 'equal') {
            if (missing.length > 0) {
              errors.push({
                line: item.loc.line,
                col: item.loc.col,
                message: `'${item.functor}' requires all parameters: ${sym.params.join(', ')}`,
              });
            }
          }
        }
      }
    }

    if (item.kind === 'predicate_def') {
      for (const clause of item.clauses) {
        for (const ci of clause.items) {
          if (ci.kind === 'application' && ci.functor !== '__node' && ci.functor !== '__include') {
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

  // If structural validation passes, run type inference
  if (errors.length === 0) {
    const { errors: inferErrors } = inferProgram(resolved);
    errors.push(...inferErrors);
  }

  return { errors };
}
