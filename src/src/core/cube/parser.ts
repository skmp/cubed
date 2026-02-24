/**
 * CUBE language recursive descent parser.
 * Parses a token stream into a CUBE AST.
 *
 * Grammar (from docs/cube-language.md Section 8):
 *   prg  ::= con
 *   con  ::= (df | af) (/\ (df | af))*
 *   df   ::= pdf | tdf
 *   pdf  ::= ident = lambda{params}. (con \/ con \/ ...)
 *   tdf  ::= TYPE_IDENT = Lambda{type_params}. V + V + ...
 *   af   ::= ident = term | ident{args}
 *   term ::= ident | int_lit | ident{args} | {renames}
 */
import { CubeTokenType } from './tokenizer';
import type { CubeToken } from './tokenizer';
import type { CompileError } from '../types';
import type {
  CubeProgram, Conjunction, ConjunctionItem, PredicateDef, TypeDef,
  ParamDecl, VariantDef, FieldDecl, TypeExpr,
  AtomicFormula, Application, Unification,
  Term, VarTerm, LitTerm, StringLitTerm, AppTerm, ArgBinding,
} from './ast';

export function parseCube(tokens: CubeToken[]): { ast: CubeProgram; errors: CompileError[] } {
  const errors: CompileError[] = [];
  let pos = 0;

  function peek(): CubeToken {
    return tokens[pos] ?? { type: CubeTokenType.EOF, value: '', line: 0, col: 0 };
  }

  function advance(): CubeToken {
    const tok = tokens[pos];
    if (pos < tokens.length - 1) pos++;
    return tok;
  }

  function expect(type: CubeTokenType, msg: string): CubeToken {
    const tok = peek();
    if (tok.type !== type) {
      errors.push({ line: tok.line, col: tok.col, message: `Expected ${msg}, got '${tok.value}'` });
      return tok;
    }
    return advance();
  }

  function check(type: CubeTokenType): boolean {
    return peek().type === type;
  }

  function match(type: CubeTokenType): boolean {
    if (check(type)) {
      advance();
      return true;
    }
    return false;
  }

  // ---- Program ----

  function parseProgram(): CubeProgram {
    const loc = { line: peek().line, col: peek().col };
    const conjunction = parseConjunction();

    // Continue parsing when additional node directives appear without /\
    // (multi-node programs separate node blocks with blank lines, not /\)
    while (peek().type === CubeTokenType.NODE) {
      const next = parseConjunction();
      conjunction.items.push(...next.items);
    }

    return { kind: 'program', conjunction, loc };
  }

  // ---- Conjunction: items separated by /\ ----

  function parseConjunction(stopAtDef = false): Conjunction {
    const loc = { line: peek().line, col: peek().col };
    const items: ConjunctionItem[] = [];

    if (peek().type === CubeTokenType.EOF || peek().type === CubeTokenType.RPAREN) {
      return { kind: 'conjunction', items, loc };
    }

    items.push(parseConjunctionItem());

    while (check(CubeTokenType.CONJUNCTION)) {
      // In body mode, stop if the token after /\ starts a new definition
      if (stopAtDef && looksLikeDefinitionAfterConj()) break;
      advance(); // consume /\;
      items.push(parseConjunctionItem());
    }

    return { kind: 'conjunction', items, loc };
  }

  /** Peek past the /\ to check if the next item is a definition or node directive.
   *  This is used to stop unparenthesized predicate bodies from consuming sibling defs. */
  function looksLikeDefinitionAfterConj(): boolean {
    // pos is at the /\ token; peek past it
    const afterConj = tokens[pos + 1];
    if (!afterConj) return false;

    // node directive
    if (afterConj.type === CubeTokenType.NODE) return true;

    // TYPE_IDENT = ... → type definition
    if (afterConj.type === CubeTokenType.TYPE_IDENT) {
      const afterName = tokens[pos + 2];
      if (afterName && afterName.type === CubeTokenType.EQUALS) return true;
    }

    // ident = lambda{...} → predicate definition
    if (afterConj.type === CubeTokenType.IDENT) {
      const afterName = tokens[pos + 2];
      if (afterName && afterName.type === CubeTokenType.EQUALS) {
        const afterEquals = tokens[pos + 3];
        if (afterEquals && afterEquals.type === CubeTokenType.LAMBDA) return true;
      }
    }

    return false;
  }

  // ---- Conjunction Item: definition or atomic formula ----

  function parseConjunctionItem(): ConjunctionItem {
    const tok = peek();

    // #include directive: #include name
    if (tok.type === CubeTokenType.INCLUDE) {
      advance();
      return {
        kind: 'application',
        functor: '__include',
        args: [{
          name: 'module',
          value: { kind: 'var', name: tok.value, loc: { line: tok.line, col: tok.col } },
          loc: { line: tok.line, col: tok.col },
        }],
        loc: { line: tok.line, col: tok.col },
      };
    }

    // node directive: node NNN /\ ...
    if (tok.type === CubeTokenType.NODE) {
      return parseNodeDirective();
    }

    // Type definition: TYPE_IDENT = Lambda{...}. ...
    if (tok.type === CubeTokenType.TYPE_IDENT) {
      const next = tokens[pos + 1];
      if (next && next.type === CubeTokenType.EQUALS) {
        return parseTypeDef();
      }
    }

    // Check for predicate definition: ident = lambda{...}. ...
    // vs unification: ident = term
    // vs application: ident{args}
    if (tok.type === CubeTokenType.IDENT) {
      const next = tokens[pos + 1];

      // ident = lambda{...}. ... → predicate def
      if (next && next.type === CubeTokenType.EQUALS) {
        const afterEquals = tokens[pos + 2];
        if (afterEquals && afterEquals.type === CubeTokenType.LAMBDA) {
          return parsePredicateDef();
        }
        // ident = term → unification
        return parseUnification();
      }

      // ident{args} → application
      if (next && next.type === CubeTokenType.LBRACE) {
        return parseApplication();
      }

      // Bare ident with no operator following → treat as zero-arg application
      return parseApplication();
    }

    errors.push({ line: tok.line, col: tok.col, message: `Unexpected token: '${tok.value}'` });
    advance();
    return { kind: 'application', functor: '_error', args: [], loc: { line: tok.line, col: tok.col } };
  }

  // ---- Node directive (compiles to node annotation) ----

  function parseNodeDirective(): AtomicFormula {
    const tok = advance(); // consume 'node'
    const numTok = expect(CubeTokenType.INT_LIT, 'node number');
    const args: ArgBinding[] = [{
      name: 'coord',
      value: { kind: 'literal', value: numTok.numValue ?? 0, loc: { line: numTok.line, col: numTok.col } },
      loc: { line: numTok.line, col: numTok.col },
    }];

    // Optional boot descriptor block: node NNN { a=0x175, b=0x1D5, p=0 }
    if (check(CubeTokenType.LBRACE)) {
      advance(); // consume {
      if (!check(CubeTokenType.RBRACE)) {
        args.push(parseArgBinding());
        while (match(CubeTokenType.COMMA)) {
          args.push(parseArgBinding());
        }
      }
      expect(CubeTokenType.RBRACE, '}');
    }

    return {
      kind: 'application',
      functor: '__node',
      args,
      loc: { line: tok.line, col: tok.col },
    };
  }

  // ---- Predicate Definition ----

  function parsePredicateDef(): PredicateDef {
    const nameTok = advance(); // ident
    const loc = { line: nameTok.line, col: nameTok.col };
    expect(CubeTokenType.EQUALS, '=');
    expect(CubeTokenType.LAMBDA, 'lambda');
    expect(CubeTokenType.LBRACE, '{');

    const params = parseParamList();
    expect(CubeTokenType.RBRACE, '}');
    expect(CubeTokenType.DOT, '.');

    // Parse body: either parenthesized disjunction or single conjunction
    const clauses: Conjunction[] = [];

    if (check(CubeTokenType.LPAREN)) {
      advance(); // (
      clauses.push(parseConjunction());
      while (check(CubeTokenType.DISJUNCTION)) {
        advance(); // \/
        clauses.push(parseConjunction());
      }
      expect(CubeTokenType.RPAREN, ')');
    } else {
      // Single clause (no parens) — stop at the next definition boundary
      // so the body doesn't greedily consume sibling definitions
      clauses.push(parseConjunction(true));
    }

    return {
      kind: 'predicate_def',
      name: nameTok.value,
      params,
      localDefs: [],
      clauses,
      loc,
    };
  }

  // ---- Param list: x1:tau1, x2:tau2, ... ----

  function parseParamList(): ParamDecl[] {
    const params: ParamDecl[] = [];
    if (check(CubeTokenType.RBRACE)) return params;

    params.push(parseParamDecl());
    while (match(CubeTokenType.COMMA)) {
      params.push(parseParamDecl());
    }
    return params;
  }

  function parseParamDecl(): ParamDecl {
    const tok = peek();
    const nameTok = advance(); // ident
    const loc = { line: tok.line, col: tok.col };

    let typeAnnotation: TypeExpr | undefined;
    if (match(CubeTokenType.COLON)) {
      typeAnnotation = parseTypeExpr();
    }

    return { name: nameTok.value, typeAnnotation, loc };
  }

  // ---- Type Definition ----

  function parseTypeDef(): TypeDef {
    const nameTok = advance(); // TYPE_IDENT
    const loc = { line: nameTok.line, col: nameTok.col };
    expect(CubeTokenType.EQUALS, '=');
    expect(CubeTokenType.LAMBDA_TYPE, 'Lambda');
    expect(CubeTokenType.LBRACE, '{');

    const typeParams: string[] = [];
    if (!check(CubeTokenType.RBRACE)) {
      typeParams.push(advance().value);
      while (match(CubeTokenType.COMMA)) {
        if (match(CubeTokenType.COLON)) advance(); // skip TYPE annotation
        typeParams.push(advance().value);
      }
    }
    expect(CubeTokenType.RBRACE, '}');
    expect(CubeTokenType.DOT, '.');

    const variants: VariantDef[] = [];
    variants.push(parseVariant());
    while (check(CubeTokenType.PLUS)) {
      advance(); // +
      variants.push(parseVariant());
    }

    return { kind: 'type_def', name: nameTok.value, typeParams, variants, loc };
  }

  function parseVariant(): VariantDef {
    const nameTok = advance(); // constructor name
    const loc = { line: nameTok.line, col: nameTok.col };
    const fields: FieldDecl[] = [];

    if (match(CubeTokenType.LBRACE)) {
      if (!check(CubeTokenType.RBRACE)) {
        fields.push(parseFieldDecl());
        while (match(CubeTokenType.COMMA)) {
          fields.push(parseFieldDecl());
        }
      }
      expect(CubeTokenType.RBRACE, '}');
    }

    return { name: nameTok.value, fields, loc };
  }

  function parseFieldDecl(): FieldDecl {
    const nameTok = advance();
    const loc = { line: nameTok.line, col: nameTok.col };
    expect(CubeTokenType.COLON, ':');
    const type = parseTypeExpr();
    return { name: nameTok.value, type, loc };
  }

  // ---- Type Expressions ----

  function parseTypeExpr(): TypeExpr {
    const tok = peek();

    // Function type: {params} -> returnType
    if (tok.type === CubeTokenType.LBRACE) {
      // Could be function type
      const savedPos = pos;
      try {
        advance(); // {
        const params: Record<string, TypeExpr> = {};
        if (!check(CubeTokenType.RBRACE)) {
          const pName = advance().value;
          expect(CubeTokenType.COLON, ':');
          params[pName] = parseTypeExpr();
          while (match(CubeTokenType.COMMA)) {
            const pn = advance().value;
            expect(CubeTokenType.COLON, ':');
            params[pn] = parseTypeExpr();
          }
        }
        expect(CubeTokenType.RBRACE, '}');
        expect(CubeTokenType.ARROW, '->');
        const returnType = parseTypeExpr();
        return { kind: 'func_type', params, returnType, loc: { line: tok.line, col: tok.col } };
      } catch {
        pos = savedPos;
      }
    }

    // Type application: K{X1=sigma1, ...}
    if (tok.type === CubeTokenType.TYPE_IDENT) {
      const name = advance().value;
      const args: Record<string, TypeExpr> = {};
      if (match(CubeTokenType.LBRACE)) {
        if (!check(CubeTokenType.RBRACE)) {
          const argName = advance().value;
          expect(CubeTokenType.EQUALS, '=');
          args[argName] = parseTypeExpr();
          while (match(CubeTokenType.COMMA)) {
            const an = advance().value;
            expect(CubeTokenType.EQUALS, '=');
            args[an] = parseTypeExpr();
          }
        }
        expect(CubeTokenType.RBRACE, '}');
      }
      if (Object.keys(args).length > 0) {
        return { kind: 'type_app', constructor: name, args, loc: { line: tok.line, col: tok.col } };
      }
      return { kind: 'type_var', name, loc: { line: tok.line, col: tok.col } };
    }

    // Type variable: alpha
    if (tok.type === CubeTokenType.IDENT) {
      return { kind: 'type_var', name: advance().value, loc: { line: tok.line, col: tok.col } };
    }

    errors.push({ line: tok.line, col: tok.col, message: `Expected type expression, got '${tok.value}'` });
    advance();
    return { kind: 'type_var', name: '_error', loc: { line: tok.line, col: tok.col } };
  }

  // ---- Atomic Formulas ----

  function parseUnification(): Unification {
    const varTok = advance(); // ident
    const loc = { line: varTok.line, col: varTok.col };
    expect(CubeTokenType.EQUALS, '=');
    const term = parseTerm();
    return { kind: 'unification', variable: varTok.value, term, loc };
  }

  function parseApplication(): Application {
    const functorTok = advance(); // ident
    const loc = { line: functorTok.line, col: functorTok.col };
    const args: ArgBinding[] = [];

    if (match(CubeTokenType.LBRACE)) {
      if (!check(CubeTokenType.RBRACE)) {
        args.push(parseArgBinding());
        while (match(CubeTokenType.COMMA)) {
          args.push(parseArgBinding());
        }
      }
      expect(CubeTokenType.RBRACE, '}');
    }

    return { kind: 'application', functor: functorTok.value, args, loc };
  }

  function parseArgBinding(): ArgBinding {
    const nameTok = advance();
    const loc = { line: nameTok.line, col: nameTok.col };
    expect(CubeTokenType.EQUALS, '=');
    const value = parseTerm();
    return { name: nameTok.value, value, loc };
  }

  // ---- Terms ----

  function parseTerm(): Term {
    const tok = peek();

    // Integer literal
    if (tok.type === CubeTokenType.INT_LIT) {
      advance();
      return { kind: 'literal', value: tok.numValue!, loc: { line: tok.line, col: tok.col } };
    }

    // String literal
    if (tok.type === CubeTokenType.STRING_LIT) {
      advance();
      return { kind: 'string_literal', value: tok.strValue ?? '', loc: { line: tok.line, col: tok.col } } as StringLitTerm;
    }

    // Port renaming: {x1'<-x1, ...}
    if (tok.type === CubeTokenType.LBRACE) {
      // Check if this is a rename (look for <- pattern)
      const savedPos = pos;
      advance(); // {
      if (peek().type === CubeTokenType.IDENT) {
        const next1 = tokens[pos + 1];
        if (next1 && next1.type === CubeTokenType.RENAME_ARROW) {
          // This is a rename
          pos = savedPos;
          return parseRenameTerm();
        }
      }
      pos = savedPos;
    }

    // Identifier (variable or application term)
    if (tok.type === CubeTokenType.IDENT) {
      advance();
      // Check if followed by {args} → app term
      if (check(CubeTokenType.LBRACE)) {
        advance(); // {
        const args: ArgBinding[] = [];
        if (!check(CubeTokenType.RBRACE)) {
          args.push(parseArgBinding());
          while (match(CubeTokenType.COMMA)) {
            args.push(parseArgBinding());
          }
        }
        expect(CubeTokenType.RBRACE, '}');
        return { kind: 'app_term', functor: tok.value, args, loc: { line: tok.line, col: tok.col } } as AppTerm;
      }
      return { kind: 'var', name: tok.value, loc: { line: tok.line, col: tok.col } } as VarTerm;
    }

    // Type identifier used as a constructor term
    if (tok.type === CubeTokenType.TYPE_IDENT) {
      advance();
      if (check(CubeTokenType.LBRACE)) {
        advance();
        const args: ArgBinding[] = [];
        if (!check(CubeTokenType.RBRACE)) {
          args.push(parseArgBinding());
          while (match(CubeTokenType.COMMA)) {
            args.push(parseArgBinding());
          }
        }
        expect(CubeTokenType.RBRACE, '}');
        return { kind: 'app_term', functor: tok.value, args, loc: { line: tok.line, col: tok.col } } as AppTerm;
      }
      return { kind: 'var', name: tok.value, loc: { line: tok.line, col: tok.col } } as VarTerm;
    }

    errors.push({ line: tok.line, col: tok.col, message: `Expected term, got '${tok.value}'` });
    advance();
    return { kind: 'literal', value: 0, loc: { line: tok.line, col: tok.col } } as LitTerm;
  }

  function parseRenameTerm(): Term {
    const loc = { line: peek().line, col: peek().col };
    expect(CubeTokenType.LBRACE, '{');
    const mappings: Array<{ from: string; to: string }> = [];

    const toName = advance().value;
    expect(CubeTokenType.RENAME_ARROW, '<-');
    const fromName = advance().value;
    mappings.push({ from: fromName, to: toName });

    while (match(CubeTokenType.COMMA)) {
      const to = advance().value;
      expect(CubeTokenType.RENAME_ARROW, '<-');
      const from = advance().value;
      mappings.push({ from, to });
    }

    expect(CubeTokenType.RBRACE, '}');
    return { kind: 'rename', mappings, loc };
  }

  // ---- Run parser ----

  const ast = parseProgram();
  return { ast, errors };
}
