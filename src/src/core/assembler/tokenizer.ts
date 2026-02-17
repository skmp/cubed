import { OPCODE_MAP, NAMED_ADDRESSES } from '../constants';

export const TokenType = {
  OPCODE: 0,
  NUMBER: 1,
  LABEL_DEF: 2,    // : name
  WORD_REF: 3,     // reference to a defined word
  DIRECTIVE: 4,    // node, org, .., etc.
  CONSTANT: 5,     // up, down, left, right, io, etc.
  EOF: 6,
} as const;
export type TokenType = typeof TokenType[keyof typeof TokenType];

export interface Token {
  type: TokenType;
  value: string;
  numValue?: number;
  line: number;
  col: number;
}

// Extend NAMED_ADDRESSES with directional aliases
const DIRECTION_ALIASES: Record<string, string> = {
  north: 'north',
  south: 'south',
  east: 'east',
  west: 'west',
};

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
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

      // Line comment: \ to end of line
      if (line[col] === '\\') {
        break;
      }

      // Paren comment: ( ... )
      if (line[col] === '(') {
        const end = line.indexOf(')', col);
        if (end >= 0) {
          col = end + 1;
        } else {
          break; // unclosed paren comment spans to end of line
        }
        continue;
      }

      // Label definition: : name
      if (line[col] === ':' && col + 1 < line.length && /\s/.test(line[col + 1])) {
        col++; // skip ':'
        while (col < line.length && /\s/.test(line[col])) col++;
        const start = col;
        while (col < line.length && !/\s/.test(line[col])) col++;
        const name = line.substring(start, col);
        tokens.push({ type: TokenType.LABEL_DEF, value: name, line: lineNum + 1, col: start + 1 });
        continue;
      }

      // Read a word token
      const startCol = col;
      while (col < line.length && !/\s/.test(line[col])) col++;
      const word = line.substring(startCol, col);

      if (word.length === 0) continue;

      // Check what kind of token it is
      const token = classifyToken(word, lineNum + 1, startCol + 1);
      tokens.push(token);
    }
  }

  tokens.push({ type: TokenType.EOF, value: '', line: lines.length, col: 0 });
  return tokens;
}

function classifyToken(word: string, line: number, col: number): Token {
  // Check for '..' directive
  if (word === '..') {
    return { type: TokenType.DIRECTIVE, value: '..', line, col };
  }
  // Check for ',' directive
  if (word === ',') {
    return { type: TokenType.DIRECTIVE, value: ',', line, col };
  }
  // Check for '/' directive
  if (word === '/') {
    return { type: TokenType.DIRECTIVE, value: '/', line, col };
  }

  // Check for directives that overlap with opcodes (if, -if, next, unext, for)
  // Note: these are compile-time directives that handle control flow
  if (word === 'for') {
    return { type: TokenType.DIRECTIVE, value: 'for', line, col };
  }
  if (word === 'begin' || word === 'end' || word === 'then' || word === 'while') {
    return { type: TokenType.DIRECTIVE, value: word, line, col };
  }

  // 'node' and 'org' are always directives
  if (word === 'node' || word === 'org') {
    return { type: TokenType.DIRECTIVE, value: word, line, col };
  }
  if (word === '+cy' || word === '-cy') {
    return { type: TokenType.DIRECTIVE, value: word, line, col };
  }

  // Check if it's an opcode
  if (OPCODE_MAP.has(word)) {
    return { type: TokenType.OPCODE, value: word, line, col };
  }

  // Check if it's a named constant
  if (word in NAMED_ADDRESSES) {
    return { type: TokenType.CONSTANT, value: word, numValue: NAMED_ADDRESSES[word], line, col };
  }
  // Direction aliases (these need node context to resolve properly)
  if (word in DIRECTION_ALIASES) {
    return { type: TokenType.CONSTANT, value: word, line, col };
  }

  // Try to parse as number
  const num = parseNumber(word);
  if (num !== null) {
    return { type: TokenType.NUMBER, value: word, numValue: num, line, col };
  }

  // Treat as word reference (label reference, possibly with @node suffix)
  return { type: TokenType.WORD_REF, value: word, line, col };
}

function parseNumber(word: string): number | null {
  if (word.startsWith('0x') || word.startsWith('0X')) {
    const val = parseInt(word.substring(2), 16);
    return isNaN(val) ? null : val;
  }
  if (word.startsWith('0b') || word.startsWith('0B')) {
    const val = parseInt(word.substring(2), 2);
    return isNaN(val) ? null : val;
  }
  // Allow negative numbers
  const val = parseInt(word, 10);
  return isNaN(val) ? null : val;
}
