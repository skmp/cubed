/**
 * Monaco language definition for CUBE.
 */
import type { Monaco } from '@monaco-editor/react';

export function registerCubeLanguage(monaco: Monaco): void {
  // Register the language
  monaco.languages.register({ id: 'cube' });

  // Monarch tokenizer
  monaco.languages.setMonarchTokensProvider('cube', {
    keywords: ['lambda', 'Lambda', 'node'],
    builtins: ['plus', 'minus', 'times', 'greater', 'not', 'equal'],
    typeKeywords: ['Int', 'Float'],

    operators: ['/\\', '\\/', '=', '->', '<-', '+'],

    tokenizer: {
      root: [
        // Comments
        [/--.*$/, 'comment'],

        // Operators
        [/\/\\/, 'operator.conjunction'],
        [/\\\//, 'operator.disjunction'],
        [/->/, 'operator.arrow'],
        [/<-/, 'operator.rename'],

        // Numbers
        [/0[xX][0-9a-fA-F]+/, 'number.hex'],
        [/-?\d+/, 'number'],

        // Namespaced identifiers (f18a.xxx, rom.xxx)
        [/f18a\.[a-zA-Z_]\w*/, 'keyword.f18a'],
        [/rom\.[a-zA-Z_]\w*/, 'keyword.rom'],

        // Type identifiers (capitalized)
        [/[A-Z]\w*/, {
          cases: {
            '@typeKeywords': 'type',
            '@keywords': 'keyword',
            '@default': 'type.identifier',
          },
        }],

        // Regular identifiers
        [/[a-z_]\w*/, {
          cases: {
            '@keywords': 'keyword',
            '@builtins': 'keyword.builtin',
            '@default': 'identifier',
          },
        }],

        // Delimiters
        [/[{}()[\]]/, 'delimiter.bracket'],
        [/[,.:=+]/, 'delimiter'],
      ],
    },
  });

  // Language configuration (auto-close, comments, etc.)
  monaco.languages.setLanguageConfiguration('cube', {
    comments: {
      lineComment: '--',
    },
    brackets: [
      ['{', '}'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '(', close: ')' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '(', close: ')' },
    ],
  });
}
