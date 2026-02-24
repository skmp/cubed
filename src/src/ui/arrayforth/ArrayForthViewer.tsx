import { useRef, useEffect } from 'react';
import { Box } from '@mui/material';
import * as monaco from 'monaco-editor';
import { registerArrayForthLanguage } from '../editor/arrayforthLang';

interface ArrayForthViewerProps {
  source: string;
}

let langRegistered = false;

export function ArrayForthViewer({ source }: ArrayForthViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    if (!langRegistered) {
      registerArrayForthLanguage(monaco);
      langRegistered = true;
    }

    const editor = monaco.editor.create(containerRef.current, {
      value: source,
      language: 'arrayforth',
      theme: 'vs-dark',
      readOnly: true,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: 'monospace',
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      automaticLayout: true,
    });
    editorRef.current = editor;

    return () => {
      editor.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update content when source changes
  useEffect(() => {
    if (editorRef.current) {
      const model = editorRef.current.getModel();
      if (model && model.getValue() !== source) {
        model.setValue(source);
      }
    }
  }, [source]);

  return (
    <Box
      ref={containerRef}
      sx={{ width: '100%', height: '100%' }}
    />
  );
}
