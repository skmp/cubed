/**
 * CUBE language tokenizer.
 * Tokenizes CUBE source text into a stream of tokens.
 */
import type { CompileError } from '../types';

export const CubeTokenType = {
  IDENT: 0,        // lowercase identifier
  TYPE_IDENT: 1,   // Capitalized identifier (type constructor)
  INT_LIT: 2,      // integer literal
  LAMBDA: 3,       // lambda
  LAMBDA_TYPE: 4,  // Lambda (type-level)
  LBRACE: 5,       // {
  RBRACE: 6,       // }
  LPAREN: 7,       // (
  RPAREN: 8,       // )
  COMMA: 9,        // ,
  COLON: 10,       // :
  DOT: 11,         // .
  EQUALS: 12,      // =
  ARROW: 13,       // ->
  CONJUNCTION: 14, // /\  (and)
  DISJUNCTION: 15, // \/  (or)
  PLUS: 16,        // + (type sum)
  RENAME_ARROW: 17,// <-
  NODE: 18,        // node (directive)
  EOF: 19,
} as const;
export type CubeTokenType = typeof CubeTokenType[keyof typeof CubeTokenType];

export interface CubeToken {
  type: CubeTokenType;
  value: string;
  numValue?: number;
  line: number;
  col: number;
}

export function tokenizeCube(source: string): { tokens: CubeToken[]; errors: CompileError[] } {
  const tokens: CubeToken[] = [];
  const errors: CompileError[] = [];
  const lines = source.split('\n');

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    let col = 0;

    while (col < line.length) {
      // Skip whitespace
      if (/\s/.test(line[col])) {
        col++;
        continue;
      }

      // Line comment: -- to end of line
      if (col + 1 < line.length && line[col] === '-' && line[col + 1] === '-') {
        break;
      }

      // Two-character operators
      if (col + 1 < line.length) {
        const two = line[col] + line[col + 1];

        if (two === '/\\') {
          tokens.push({ type: CubeTokenType.CONJUNCTION, value: '/\\', line: lineNum + 1, col: col + 1 });
          col += 2;
          continue;
        }
        if (two === '\\/') {
          tokens.push({ type: CubeTokenType.DISJUNCTION, value: '\\/', line: lineNum + 1, col: col + 1 });
          col += 2;
          continue;
        }
        if (two === '->') {
          tokens.push({ type: CubeTokenType.ARROW, value: '->', line: lineNum + 1, col: col + 1 });
          col += 2;
          continue;
        }
        if (two === '<-') {
          tokens.push({ type: CubeTokenType.RENAME_ARROW, value: '<-', line: lineNum + 1, col: col + 1 });
          col += 2;
          continue;
        }
      }

      // Single-character tokens
      const ch = line[col];
      if (ch === '{') { tokens.push({ type: CubeTokenType.LBRACE, value: '{', line: lineNum + 1, col: col + 1 }); col++; continue; }
      if (ch === '}') { tokens.push({ type: CubeTokenType.RBRACE, value: '}', line: lineNum + 1, col: col + 1 }); col++; continue; }
      if (ch === '(') { tokens.push({ type: CubeTokenType.LPAREN, value: '(', line: lineNum + 1, col: col + 1 }); col++; continue; }
      if (ch === ')') { tokens.push({ type: CubeTokenType.RPAREN, value: ')', line: lineNum + 1, col: col + 1 }); col++; continue; }
      if (ch === ',') { tokens.push({ type: CubeTokenType.COMMA, value: ',', line: lineNum + 1, col: col + 1 }); col++; continue; }
      if (ch === ':') { tokens.push({ type: CubeTokenType.COLON, value: ':', line: lineNum + 1, col: col + 1 }); col++; continue; }
      if (ch === '.') { tokens.push({ type: CubeTokenType.DOT, value: '.', line: lineNum + 1, col: col + 1 }); col++; continue; }
      if (ch === '=') { tokens.push({ type: CubeTokenType.EQUALS, value: '=', line: lineNum + 1, col: col + 1 }); col++; continue; }
      if (ch === '+') { tokens.push({ type: CubeTokenType.PLUS, value: '+', line: lineNum + 1, col: col + 1 }); col++; continue; }

      // Number literal (including negative)
      if (/\d/.test(ch) || (ch === '-' && col + 1 < line.length && /\d/.test(line[col + 1]))) {
        const startCol = col;
        if (ch === '-') col++;
        // Hex
        if (col + 1 < line.length && line[col] === '0' && (line[col + 1] === 'x' || line[col + 1] === 'X')) {
          col += 2;
          while (col < line.length && /[0-9a-fA-F]/.test(line[col])) col++;
        } else {
          while (col < line.length && /\d/.test(line[col])) col++;
        }
        const numStr = line.substring(startCol, col);
        const numValue = numStr.startsWith('0x') || numStr.startsWith('0X') || numStr.startsWith('-0x') || numStr.startsWith('-0X')
          ? parseInt(numStr, 16)
          : parseInt(numStr, 10);
        if (isNaN(numValue)) {
          errors.push({ line: lineNum + 1, col: startCol + 1, message: `Invalid number: ${numStr}` });
        } else {
          tokens.push({ type: CubeTokenType.INT_LIT, value: numStr, numValue, line: lineNum + 1, col: startCol + 1 });
        }
        continue;
      }

      // Identifier (includes dotted names like f18a.dup, rom.interp)
      if (/[a-zA-Z_]/.test(ch)) {
        const startCol = col;
        while (col < line.length && /[a-zA-Z0-9_]/.test(line[col])) col++;
        // Allow dotted names for namespaced identifiers (f18a.xxx, rom.xxx)
        if (col < line.length && line[col] === '.' && col + 1 < line.length && /[a-zA-Z_]/.test(line[col + 1])) {
          col++; // skip dot
          while (col < line.length && /[a-zA-Z0-9_]/.test(line[col])) col++;
        }
        const word = line.substring(startCol, col);

        // Keywords
        if (word === 'lambda') {
          tokens.push({ type: CubeTokenType.LAMBDA, value: word, line: lineNum + 1, col: startCol + 1 });
        } else if (word === 'Lambda') {
          tokens.push({ type: CubeTokenType.LAMBDA_TYPE, value: word, line: lineNum + 1, col: startCol + 1 });
        } else if (word === 'node') {
          tokens.push({ type: CubeTokenType.NODE, value: word, line: lineNum + 1, col: startCol + 1 });
        } else if (/^[A-Z]/.test(word) && !word.includes('.')) {
          // Capitalized, no dot → type identifier
          tokens.push({ type: CubeTokenType.TYPE_IDENT, value: word, line: lineNum + 1, col: startCol + 1 });
        } else {
          tokens.push({ type: CubeTokenType.IDENT, value: word, line: lineNum + 1, col: startCol + 1 });
        }
        continue;
      }

      // Unknown character
      errors.push({ line: lineNum + 1, col: col + 1, message: `Unexpected character: '${ch}'` });
      col++;
    }
  }

  tokens.push({ type: CubeTokenType.EOF, value: '', line: lines.length, col: 0 });
  return { tokens, errors };
}
