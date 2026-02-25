import React, { useRef, useCallback, useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { OnMount } from '@monaco-editor/react';
import { Box, Select, MenuItem, IconButton, Tooltip, LinearProgress, TextField, Typography, type SelectChangeEvent } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import UsbIcon from '@mui/icons-material/Usb';
import { registerArrayForthLanguage } from './arrayforthLang';
import { registerCubeLanguage } from './cubeLang';
import type { CompileError, CompiledNode } from '../../core/types';

// Web Serial API type declarations
interface SerialPortOptions { baudRate: number }
interface WebSerialPort {
  open(options: SerialPortOptions): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  writable: WritableStream<Uint8Array> | null;
}
interface Serial { requestPort(): Promise<WebSerialPort> }
function getSerial(): Serial | null {
  const nav = navigator as Navigator & { serial?: Serial };
  return nav.serial ?? null;
}

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
import sampleRSA from '../../../samples/RSA.cube?raw';
import sampleRSC from '../../../samples/RSC.cube?raw';
import sampleEcho from '../../../samples/ECHO.cube?raw';
import sampleHello from '../../../samples/HELLO.cube?raw';
import sampleHello2 from '../../../samples/HELLO2.cube?raw';
import sampleHelloPF from '../../../samples/HELLO-PF.cube?raw';
import sampleNIC10 from '../../../samples/NIC10.cube?raw';

const DEFAULT_ARRAYFORTH = defaultArrayforth;

const CUBE_SAMPLES: Record<string, string> = {
  'NIC10 (10baseT NIC, AN007)': sampleNIC10,
  'HELLO-PF (Port B, polyForth)': sampleHelloPF,
  'HELLO2 (Port B, bit-bang)': sampleHello2,
  'HELLO (Serial)': sampleHello,
  'ECHO (Serial RX/TX)': sampleEcho,
  'RSC (Serial TX)': sampleRSC,
  'RSA (Delta VCO)': sampleRSA,
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

const DEFAULT_CUBE = CUBE_SAMPLES['RSC (Serial TX)'];

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
  bootStreamBytes?: Uint8Array | null;
}

export const CodeEditor: React.FC<CodeEditorProps> = ({ language, onCompile, onSourceChange, errors, compiledNodes, initialSource, bootStreamBytes }) => {
  const editorRef = useRef<EditorInstance | null>(null);
  const monacoRef = useRef<MonacoInstance | null>(null);
  const languagesRegistered = useRef(false);
  const onCompileRef = useRef(onCompile);
  const [selectedSample, setSelectedSample] = useState('RSC (Serial TX)');
  const [baudRate, setBaudRate] = useState(921600);
  const [serialProgress, setSerialProgress] = useState<number | null>(null);
  const [serialError, setSerialError] = useState<string | null>(null);

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

  const handleDownload = useCallback(() => {
    if (!bootStreamBytes) return;
    const blob = new Blob([bootStreamBytes as unknown as BlobPart], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bootstream.bin';
    a.click();
    URL.revokeObjectURL(url);
  }, [bootStreamBytes]);

  const handleSendSerial = useCallback(async () => {
    if (!bootStreamBytes) return;
    const serial = getSerial();
    if (!serial) return;
    let port: WebSerialPort | null = null;
    try {
      port = await serial.requestPort();
      await port.open({ baudRate });
      setSerialProgress(0);
      setSerialError(null);
      await port.setSignals({ requestToSend: true });
      await new Promise(r => setTimeout(r, 50));
      await port.setSignals({ requestToSend: false });
      await new Promise(r => setTimeout(r, 100));
      const writer = port.writable!.getWriter();
      const total = bootStreamBytes.length;
      let sent = 0;
      while (sent < total) {
        const end = Math.min(sent + 64, total);
        await writer.write(bootStreamBytes.slice(sent, end));
        sent = end;
        setSerialProgress((sent / total) * 100);
      }
      writer.releaseLock();
      await port.close();
      setSerialProgress(null);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'NotFoundError') {
        setSerialProgress(null);
        return;
      }
      setSerialError(err instanceof Error ? err.message : String(err));
      setSerialProgress(null);
      try { if (port) await port.close(); } catch { /* ignore */ }
    }
  }, [bootStreamBytes, baudRate]);

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
        <Box sx={{ px: 1, py: 0.5, borderBottom: '1px solid #333', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 1 }}>
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
          <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 0.5 }}>
            {serialProgress !== null && (
              <LinearProgress variant="determinate" value={serialProgress} sx={{ width: 60 }} />
            )}
            {serialError && (
              <Typography variant="caption" sx={{ color: '#ff6b6b', fontSize: 10, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {serialError}
              </Typography>
            )}
            <Tooltip title={bootStreamBytes ? `Download bootstream.bin (${bootStreamBytes.length} bytes)` : 'No boot stream available'}>
              <span>
                <IconButton size="small" onClick={handleDownload} disabled={!bootStreamBytes} sx={{ color: '#aaa' }}>
                  <DownloadIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <TextField
              type="number"
              size="small"
              value={baudRate}
              onChange={(e) => setBaudRate(Math.max(1, parseInt(e.target.value) || 921600))}
              disabled={serialProgress !== null}
              slotProps={{ htmlInput: { min: 1 } }}
              sx={{
                width: 80,
                '& input': { fontSize: '10px', py: 0.25, px: 0.5, color: '#ccc' },
                '& fieldset': { borderColor: '#444' },
              }}
            />
            <Tooltip title={!getSerial() ? 'Web Serial not available (use Chrome/Edge)' : !bootStreamBytes ? 'No boot stream available' : 'Send over serial'}>
              <span>
                <IconButton size="small" onClick={handleSendSerial} disabled={!bootStreamBytes || !getSerial() || serialProgress !== null} sx={{ color: '#aaa' }}>
                  <UsbIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
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
