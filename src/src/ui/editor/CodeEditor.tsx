import React, { useRef, useCallback, useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { OnMount } from '@monaco-editor/react';
import { Box, Select, MenuItem, type SelectChangeEvent } from '@mui/material';
import { registerArrayForthLanguage } from './arrayforthLang';
import { registerCubeLanguage } from './cubeLang';
import type { CompileError } from '../../core/types';

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

const DEFAULT_ARRAYFORTH = defaultArrayforth;

const CUBE_SAMPLES: Record<string, string> = {
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
  'Blue Rectangle': sampleBlueRectangle,
};

const CUBE_SAMPLE_NAMES = Object.keys(CUBE_SAMPLES);

const DEFAULT_CUBE = CUBE_SAMPLES['MD5 Hash'];

export type EditorLanguage = 'arrayforth' | 'recurse' | 'cube';

interface CodeEditorProps {
  language: EditorLanguage;
  onCompile: (source: string) => void;
  onSourceChange?: (source: string) => void;
  errors: CompileError[];
  initialSource?: string | null;
}

export const CodeEditor: React.FC<CodeEditorProps> = ({ language, onCompile, onSourceChange, errors, initialSource }) => {
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const languagesRegistered = useRef(false);
  const onCompileRef = useRef(onCompile);
  onCompileRef.current = onCompile;
  const [selectedSample, setSelectedSample] = useState(CUBE_SAMPLE_NAMES[0]);

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

  // Load initial source from URL if provided
  useEffect(() => {
    if (initialSource && editorRef.current) {
      editorRef.current.setValue(initialSource);
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
        editorRef.current.setValue(language === 'cube' ? DEFAULT_CUBE : DEFAULT_ARRAYFORTH);
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
      <Box sx={{ flex: 1, border: '1px solid #333' }}>
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
    </Box>
  );
};
