/**
 * Clause analysis for multi-clause predicate definitions.
 * Identifies discriminants that distinguish clauses for conditional branching.
 */
import type { PredicateDef, Conjunction } from './ast';
import type { ResolvedSymbol } from './resolver';
import { SymbolKind } from './resolver';

// ---- Discriminant types ----

export interface LiteralMatchDiscriminant {
  kind: 'literal_match';
  paramName: string;
  value: number;
}

export interface GuardDiscriminant {
  kind: 'guard';
  guardType: string; // e.g. 'greater'
}

export interface ConstructorMatchDiscriminant {
  kind: 'constructor_match';
  paramName: string;
  constructorName: string;
}

export type ClauseDiscriminant = LiteralMatchDiscriminant | GuardDiscriminant | ConstructorMatchDiscriminant | null;

// ---- Main analysis function ----

/**
 * Analyze clauses of a predicate definition to find discriminants.
 * Returns one discriminant (or null) per clause.
 */
export function analyzeClauses(
  def: PredicateDef,
  symbols: Map<string, ResolvedSymbol>,
): ClauseDiscriminant[] {
  const paramNames = new Set(def.params.map(p => p.name));
  return def.clauses.map(clause => analyzeClause(clause, paramNames, symbols));
}

/**
 * Analyze a single clause to find its discriminant.
 * Looks for unifications of the form `param = literal`, `param = Constructor{...}`,
 * or `param = nullary_constructor` where param is a formal parameter.
 */
function analyzeClause(
  clause: Conjunction,
  paramNames: Set<string>,
  symbols: Map<string, ResolvedSymbol>,
): ClauseDiscriminant {
  for (const item of clause.items) {
    // Look for unification: param = literal or param = Constructor{...} or param = nullary
    if (item.kind === 'unification') {
      if (paramNames.has(item.variable)) {
        if (item.term.kind === 'literal') {
          return {
            kind: 'literal_match',
            paramName: item.variable,
            value: item.term.value,
          };
        }
        if (item.term.kind === 'app_term') {
          return {
            kind: 'constructor_match',
            paramName: item.variable,
            constructorName: item.term.functor,
          };
        }
        // Bare identifier that's a nullary constructor (e.g. `n = nil`)
        if (item.term.kind === 'var') {
          const sym = symbols.get(item.term.name);
          if (sym && sym.kind === SymbolKind.CONSTRUCTOR) {
            return {
              kind: 'constructor_match',
              paramName: item.variable,
              constructorName: item.term.name,
            };
          }
        }
      }
    }

    // Look for guard predicates: greater{a=param, b=literal}
    if (item.kind === 'application') {
      if (item.functor === 'greater') {
        return { kind: 'guard', guardType: 'greater' };
      }
    }
  }

  // No discriminant found — this is a catch-all clause
  return null;
}
