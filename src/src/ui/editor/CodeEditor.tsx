import React, { useRef, useCallback, useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { OnMount } from '@monaco-editor/react';
import { Box, Select, MenuItem, type SelectChangeEvent } from '@mui/material';
import { registerArrayForthLanguage } from './arrayforthLang';
import { registerCubeLanguage } from './cubeLang';
import type { CompileError, CompiledNode } from '../../core/types';

// Import sample files using Vite's ?raw imports
import defaultArrayforth from '../../../samples/default.aforth?raw';
import sampleMd5Hash from '../../../samples/md5-hash.cube?raw';
import sampleFeatureDemo from '../../../samples/feature-demo.cube?raw';
import sampleMd5MultiNode from '../../../samples/md5-multi-node.cube?raw';
import sampleSha256 from '../../../samples/sha256.cube?raw';
import sampleLucasSeries from '../../../samples/lucas-series.cube?raw';
import sampleFibonacci from '../../../samples/fibonacci.cube?raw';
import sampleMultiNodeStack from '../../../samples/multi-node-stack.cube?raw';
import sampleWireRouting from '../../../samples/wire-routing.cube?raw';
import sampleRamNode from '../../../samples/ram-node.cube?raw';
import sampleI2cSensor from '../../../samples/i2c-sensor.cube?raw';
import sampleWireframeSphere from '../../../samples/wireframe-sphere.cube?raw';
import sampleBlueRectangle from '../../../samples/blue-rectangle.cube?raw';
import sampleCH from '../../../samples/CH.cube?raw';
import samplePS from '../../../samples/PS.cube?raw';
import sampleFR from '../../../samples/FR.cube?raw';
import sampleNL from '../../../samples/NL.cube?raw';
import sampleUN from '../../../samples/UN.cube?raw';
import sampleShor from '../../../samples/shor.cube?raw';
import sampleRSX from '../../../samples/RSX.cube?raw';

const DEFAULT_ARRAYFORTH = defaultArrayforth;

const CUBE_SAMPLES: Record<string, string> = {
  'RSX (Shor N=15)': sampleRSX,
  'Shor (N=15)': sampleShor,
  'FR': sampleFR,
  'NL': sampleNL,
  'UN': sampleUN,
  'PS': samplePS,
  'CH': sampleCH,
  'Blue Rectangle': sampleBlueRectangle,
  'MD5 Hash': sampleMd5Hash,
  'Feature Demo': sampleFeatureDemo,
  'MD5 Multi-Node': sampleMd5MultiNode,
  'SHA-256': sampleSha256,
  'Lucas Series': sampleLucasSeries,
  'Fibonacci': sampleFibonacci,
  'Multi-Node Stack': sampleMultiNodeStack,
  'Wire Routing': sampleWireRouting,
  'RAM Node': sampleRamNode,
  'I2C Sensor': sampleI2cSensor,
  'Wireframe Sphere': sampleWireframeSphere,
};

const CUBE_SAMPLE_NAMES = Object.keys(CUBE_SAMPLES);

const DEFAULT_CUBE = CUBE_SAMPLES['Shor (N=15)'];

export type EditorLanguage = 'arrayforth' | 'recurse' | 'cube';

type EditorInstance = Parameters<OnMount>[0];
type MonacoInstance = Parameters<OnMount>[1];

interface CodeEditorProps {
  language: EditorLanguage;
  onCompile: (source: string) => void;
  onSourceChange?: (source: string) => void;
  errors: CompileError[];
  compiledNodes?: CompiledNode[];
  initialSource?: string | null;
}

export const CodeEditor: React.FC<CodeEditorProps> = ({ language, onCompile, onSourceChange, errors, compiledNodes, initialSource }) => {
  const editorRef = useRef<EditorInstance | null>(null);
  const monacoRef = useRef<MonacoInstance | null>(null);
  const languagesRegistered = useRef(false);
  const onCompileRef = useRef(onCompile);
  const [selectedSample, setSelectedSample] = useState('FR');

  useEffect(() => {
    onCompileRef.current = onCompile;
  }, [onCompile]);

  const onSourceChangeRef = useRef(onSourceChange);
  useEffect(() => {
    onSourceChangeRef.current = onSourceChange;
  }, [onSourceChange]);

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

    // Notify parent with initial editor content so compile triggers on load
    onSourceChangeRef.current?.(editor.getValue());
  }, [language]);

  // Load initial source from URL if provided
  useEffect(() => {
    if (initialSource && editorRef.current) {
      editorRef.current.setValue(initialSource);
      onSourceChangeRef.current?.(initialSource);
    }
  }, [initialSource]);

  // Switch language when prop changes
  useEffect(() => {
    if (monacoRef.current && editorRef.current) {
      const model = editorRef.current.getModel();
      if (model) {
        monacoRef.current.editor.setModelLanguage(model, language);
      }
      // Set default source for the language
      const currentSource = editorRef.current.getValue();
      const isDefault = Object.values(CUBE_SAMPLES).includes(currentSource) ||
        currentSource === DEFAULT_ARRAYFORTH || currentSource === '';
      if (isDefault) {
        const newSource = language === 'cube' ? DEFAULT_CUBE : DEFAULT_ARRAYFORTH;
        editorRef.current.setValue(newSource);
        onSourceChangeRef.current?.(newSource);
      }
    }
  }, [language]);

  // Handle sample selection
  const handleSampleChange = useCallback((event: SelectChangeEvent) => {
    const name = event.target.value;
    setSelectedSample(name);
    const sample = CUBE_SAMPLES[name];
    if (sample && editorRef.current) {
      editorRef.current.setValue(sample);
      onSourceChangeRef.current?.(sample);
    }
  }, []);

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
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {language === 'cube' && (
        <Box sx={{ px: 1, py: 0.5, borderBottom: '1px solid #333', flexShrink: 0 }}>
          <Select
            value={selectedSample}
            onChange={handleSampleChange}
            size="small"
            variant="standard"
            sx={{
              color: '#ccc',
              fontSize: 12,
              '& .MuiSelect-icon': { color: '#888' },
              '&:before': { borderColor: '#555' },
            }}
          >
            {CUBE_SAMPLE_NAMES.map(name => (
              <MenuItem key={name} value={name} sx={{ fontSize: 12 }}>
                {name}
              </MenuItem>
            ))}
          </Select>
        </Box>
      )}
      <Box sx={{ flex: 1, minHeight: 0, border: '1px solid #333' }}>
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
      {/* Status bar: errors + node usage */}
      {(errors.length > 0 || (compiledNodes && compiledNodes.length > 0)) && (
        <Box sx={{
          maxHeight: 150,
          overflow: 'auto',
          borderTop: '1px solid #333',
          bgcolor: '#1a1a1a',
          flexShrink: 0,
          fontFamily: '"JetBrains Mono", "Fira Code", monospace',
          fontSize: 12,
        }}>
          {errors.length > 0 && errors.map((err, i) => (
            <Box
              key={`err-${i}`}
              onClick={() => {
                if (editorRef.current) {
                  editorRef.current.revealLineInCenter(err.line || 1);
                  editorRef.current.setPosition({
                    lineNumber: err.line || 1,
                    column: err.col || 1,
                  });
                  editorRef.current.focus();
                }
              }}
              sx={{
                px: 1,
                py: 0.25,
                color: '#ff6b6b',
                cursor: 'pointer',
                '&:hover': { bgcolor: '#2a1515' },
              }}
            >
              {err.line ? `${err.line}:${err.col || 1}` : '?'}: {err.message}
            </Box>
          ))}
          {compiledNodes && compiledNodes.length > 0 && (
            <Box sx={{ px: 1, py: 0.5, color: '#8c8', display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
              {compiledNodes.map(node => {
                const wordsUsed = node.mem.filter(w => w !== null && w !== 0).length;
                return (
                  <Box key={node.coord} component="span" sx={{ whiteSpace: 'nowrap' }}>
                    <Box component="span" sx={{ color: '#6b6' }}>
                      {node.coord}
                    </Box>
                    <Box component="span" sx={{ color: '#666', mx: 0.3 }}>
                      {wordsUsed}/{node.mem.length}w
                    </Box>
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};
