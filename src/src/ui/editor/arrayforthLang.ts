import * as monaco from 'monaco-editor';

export function registerArrayForthLanguage(m: typeof monaco) {
  m.languages.register({ id: 'arrayforth' });

  m.languages.setMonarchTokensProvider('arrayforth', {
    keywords: [
      ';', 'ex', 'jump', 'call', 'unext', 'next', 'if', '-if',
      '@p', '@+', '@b', '@', '!p', '!+', '!b', '!',
      '+*', '2*', '2/', '-', '+', 'and', 'or', 'drop',
      'dup', 'pop', 'over', 'a', '.', 'push', 'b!', 'a!',
    ],
    directives: ['node', 'org', 'for', 'begin', 'end', 'then', 'while', 'warm'],
    constants: ['up', 'down', 'left', 'right', 'io', 'north', 'south', 'east', 'west'],

    tokenizer: {
      root: [
        [/\(.*?\)/, 'comment'],
        [/\\.*$/, 'comment'],
        [/:\s+\w+/, 'type.identifier'], // : word definitions
        [/\.\.\s/, 'keyword.control'],
        [/0x[0-9a-fA-F]+/, 'number.hex'],
        [/0b[01]+/, 'number.binary'],
        [/-?\d+/, 'number'],
        [/[a-zA-Z@!+*\/;.\-][a-zA-Z0-9@!+*\/;.\-]*/, {
          cases: {
            '@keywords': 'keyword',
            '@directives': 'keyword.control',
            '@constants': 'constant',
            '@default': 'identifier',
          },
        }],
      ],
    },
  });

  m.languages.setLanguageConfiguration('arrayforth', {
    comments: {
      lineComment: '\\',
      blockComment: ['(', ')'],
    },
    brackets: [],
    autoClosingPairs: [
      { open: '(', close: ')' },
    ],
  });
}
