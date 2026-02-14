import React, { useRef, useCallback, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import type { OnMount } from '@monaco-editor/react';
import { Box } from '@mui/material';
import { registerArrayForthLanguage } from './arrayforthLang';
import { registerCubeLanguage } from './cubeLang';
import type { CompileError } from '../../core/types';

const DEFAULT_ARRAYFORTH = `\\ GA144 Port Execution Example
\\ Node 609 acts as a slave memory array
\\ Node 608 stores values via port execution

node 609
: main r---

node 608
: set ( a )
    @p ! ! ;
    .. @p a! ..
: @next ( -n )
    @p ! @ ;
    .. @+ !p ..
: !next ( n )
    @p ! ! ;
    .. @p !+ ..
: fetch ( a-n ) set @next ;
: store ( na ) set !next ;

: main
 right a!

 0
 10 for
    dup dup . +
    over
    store
    1 . +
 next
`;

const DEFAULT_CUBE = `-- MD5 Hash on GA144 (AN001)
-- Models the multi-node MD5 pipeline from the GreenArrays
-- application note using CUBE's concurrent dataflow semantics.
--
-- Nodes 205/105: bitwise round functions
-- Nodes 206/106: constant fetch + add + rotate
-- Nodes 204/104: message buffer with index computation

-- f'(x,y,z) = (x AND y) OR (NOT(x) AND z)
md5f = lambda{x:Int, y:Int, z:Int, r:Int}.
  (f18a.and{} /\\ f18a.xor{})

/\\

-- g'(x,y,z) = (x AND z) OR (y AND NOT(z))
md5g = lambda{x:Int, y:Int, z:Int, r:Int}.
  (f18a.and{} /\\ f18a.xor{})

/\\

-- h'(x,y,z) = x XOR y XOR z
md5h = lambda{x:Int, y:Int, z:Int, r:Int}.
  (f18a.xor{} /\\ f18a.xor{})

/\\

-- i'(x,y,z) = y XOR (x OR NOT(z))
md5i = lambda{x:Int, y:Int, z:Int, r:Int}.
  (f18a.xor{} /\\ f18a.xor{})

/\\

-- One MD5 step: out = b + (a + f(b,c,d) + msg + k)
-- Rotation omitted for clarity (handled by nodes 206/106)
md5step = lambda{a:Int, b:Int, c:Int, d:Int,
                  msg:Int, kon:Int, out:Int}.
  (md5f{x=b, y=c, z=d, r=fval} /\\
   plus{a=a, b=fval, c=s1} /\\
   plus{a=s1, b=msg, c=s2} /\\
   plus{a=s2, b=kon, c=s3} /\\
   plus{a=s3, b=b, c=out})

/\\

-- Compute first MD5 step on empty message
-- Initial digest: A=0x67452301 B=0xEFCDAB89
--                 C=0x98BADCFE D=0x10325476
-- T[0] = 0xD76AA478 (low 16 bits)
md5step{a=0x2301, b=0xAB89, c=0xDCFE,
        d=0x5476, msg=128, kon=0xA478,
        out=result}
`;

export type EditorLanguage = 'arrayforth' | 'cube';

interface CodeEditorProps {
  language: EditorLanguage;
  onCompile: (source: string) => void;
  onSourceChange?: (source: string) => void;
  errors: CompileError[];
}

export const CodeEditor: React.FC<CodeEditorProps> = ({ language, onCompile, onSourceChange, errors }) => {
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const languagesRegistered = useRef(false);
  const onCompileRef = useRef(onCompile);
  onCompileRef.current = onCompile;

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    if (!languagesRegistered.current) {
      registerArrayForthLanguage(monaco);
      registerCubeLanguage(monaco);
      languagesRegistered.current = true;
    }

    const model = editor.getModel();
    if (model) monaco.editor.setModelLanguage(model, language);

    // Ctrl+Enter to compile (use ref to avoid stale closure)
    editor.addAction({
      id: 'compile',
      label: 'Compile & Load',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => {
        const source = editor.getValue();
        onCompileRef.current(source);
      },
    });
  }, [language]);

  // Switch language when prop changes
  useEffect(() => {
    if (monacoRef.current && editorRef.current) {
      const model = editorRef.current.getModel();
      if (model) {
        monacoRef.current.editor.setModelLanguage(model, language);
      }
      // Set default source for the language
      const currentSource = editorRef.current.getValue();
      const isDefault = currentSource === DEFAULT_ARRAYFORTH || currentSource === DEFAULT_CUBE || currentSource === '';
      if (isDefault) {
        editorRef.current.setValue(language === 'cube' ? DEFAULT_CUBE : DEFAULT_ARRAYFORTH);
      }
    }
  }, [language]);

  // Update error markers
  useEffect(() => {
    if (monacoRef.current && editorRef.current) {
      const model = editorRef.current.getModel();
      if (model) {
        const markers = errors.map(err => ({
          severity: monacoRef.current.MarkerSeverity.Error,
          message: err.message,
          startLineNumber: err.line || 1,
          startColumn: err.col || 1,
          endLineNumber: err.line || 1,
          endColumn: (err.col || 1) + 10,
        }));
        monacoRef.current.editor.setModelMarkers(model, 'compiler', markers);
      }
    }
  }, [errors]);

  return (
    <Box sx={{ height: '100%', border: '1px solid #333' }}>
      <Editor
        height="100%"
        defaultLanguage={language}
        defaultValue={language === 'cube' ? DEFAULT_CUBE : DEFAULT_ARRAYFORTH}
        theme="vs-dark"
        onMount={handleMount}
        onChange={(value) => onSourceChange?.(value ?? '')}
        options={{
          fontSize: 13,
          fontFamily: '"JetBrains Mono", "Fira Code", monospace',
          minimap: { enabled: false },
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          wordWrap: 'off',
          tabSize: 2,
          renderWhitespace: 'none',
        }}
      />
    </Box>
  );
};
