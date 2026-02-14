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

const DEFAULT_CUBE = `-- Simple addition: compute 3 + 4
-- Result is stored in variable 'result'
plus{a=3, b=4, c=result}
`;

export type EditorLanguage = 'arrayforth' | 'cube';

interface CodeEditorProps {
  language: EditorLanguage;
  onCompile: (source: string) => void;
  errors: CompileError[];
}

export const CodeEditor: React.FC<CodeEditorProps> = ({ language, onCompile, errors }) => {
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const languagesRegistered = useRef(false);

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

    // Ctrl+Enter to compile
    editor.addAction({
      id: 'compile',
      label: 'Compile & Load',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => {
        const source = editor.getValue();
        onCompile(source);
      },
    });
  }, [onCompile, language]);

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
