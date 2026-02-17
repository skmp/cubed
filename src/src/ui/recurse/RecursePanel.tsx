import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Typography } from '@mui/material';
import { evaluate } from './dsl';
import { encodeSource, decodeSource } from '../urlSource';

const STARTER = `CUBE VGA Rectangle Generator
This program generates a blue-rectangle.cube sample!
Edit the parameters below to change the output.

Generate a centered blue rectangle on green background:
@cube_rect(117, 220, 140, 200, 200, 0, 0, 7, 0, 7, 0)`;

type ViewMode = 'split' | 'editor' | 'output';
const VIEW_MODES: ViewMode[] = ['split', 'editor', 'output'];

const FONT_FAMILIES = [
  '"JetBrains Mono", "Fira Code", monospace',
  'Georgia, "Times New Roman", serif',
  '"Helvetica Neue", Arial, sans-serif',
];
const FONT_FAMILY_LABELS = ['mono', 'serif', 'sans'];
const FONT_WEIGHTS = ['normal', 'bold', 'lighter'] as const;
const FONT_WEIGHT_LABELS = ['normal', 'bold', 'light'];

interface Metrics {
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  fontFamilyIdx: number;
  fontWeightIdx: number;
  darkTheme: boolean;
}

const DEFAULT_METRICS: Metrics = {
  fontSize: 14,
  lineHeight: 1.6,
  letterSpacing: 0,
  fontFamilyIdx: 0,
  fontWeightIdx: 0,
  darkTheme: true,
};

export const RecursePanel: React.FC = () => {
  const [source, setSource] = useState(STARTER);
  const [output, setOutput] = useState('');
  const [errors, setErrors] = useState(0);
  const [evalTime, setEvalTime] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>('split');
  const [metrics, setMetrics] = useState<Metrics>(DEFAULT_METRICS);
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const evalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);

  // Run evaluation
  const runEval = useCallback((src: string) => {
    const t0 = performance.now();
    const result = evaluate(src);
    const t1 = performance.now();
    setOutput(result.output);
    setErrors(result.errors);
    setEvalTime(Math.round((t1 - t0) * 100) / 100);
  }, []);

  // Debounced evaluation
  useEffect(() => {
    if (evalTimerRef.current) clearTimeout(evalTimerRef.current);
    evalTimerRef.current = setTimeout(() => runEval(source), 150);
    return () => { if (evalTimerRef.current) clearTimeout(evalTimerRef.current); };
  }, [source, runEval]);

  // Re-evaluate every second for @time
  useEffect(() => {
    timeIntervalRef.current = setInterval(() => runEval(source), 1000);
    return () => { if (timeIntervalRef.current) clearInterval(timeIntervalRef.current); };
  }, [source, runEval]);

  // Load from URL hash on mount
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    const hash = window.location.hash;
    if (hash.startsWith('#recurse=')) {
      const encoded = hash.slice('#recurse='.length);
      decodeSource(encoded).then(decoded => {
        if (!decoded) return;
        try {
          const data = JSON.parse(decoded);
          if (data.source) setSource(data.source);
          if (data.metrics) setMetrics({ ...DEFAULT_METRICS, ...data.metrics });
        } catch {
          // If it's not JSON, treat as plain source
          setSource(decoded);
        }
      });
    }
  }, []);

  // Track cursor position
  const handleSelect = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const textBefore = ta.value.slice(0, pos);
    const line = textBefore.split('\n').length;
    const lastNewline = textBefore.lastIndexOf('\n');
    const col = pos - lastNewline;
    setCursorPos({ line, col });
  }, []);

  // Keyboard shortcuts
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const alt = e.altKey;

    // Ctrl+S — save to URL
    if (ctrl && !shift && !alt && e.key === 's') {
      e.preventDefault();
      const data = JSON.stringify({ source, metrics });
      encodeSource(data).then(encoded => {
        const url = new URL(window.location.href);
        url.hash = `recurse=${encoded}`;
        window.history.replaceState(null, '', url.toString());
      });
      return;
    }

    // Ctrl+Enter — force eval
    if (ctrl && !shift && !alt && e.key === 'Enter') {
      e.preventDefault();
      runEval(source);
      return;
    }

    // Ctrl+E — cycle view mode
    if (ctrl && !shift && !alt && e.key === 'e') {
      e.preventDefault();
      setViewMode(v => VIEW_MODES[(VIEW_MODES.indexOf(v) + 1) % VIEW_MODES.length]);
      return;
    }

    // Ctrl+] / Ctrl+[ — font size
    if (ctrl && !shift && !alt && (e.key === ']' || e.key === '[')) {
      e.preventDefault();
      setMetrics(m => ({ ...m, fontSize: Math.max(8, Math.min(48, m.fontSize + (e.key === ']' ? 1 : -1))) }));
      return;
    }

    // Ctrl+Shift+] / Ctrl+Shift+[ — line height
    if (ctrl && shift && !alt && (e.key === '}' || e.key === '{' || e.key === ']' || e.key === '[')) {
      // On most keyboards Ctrl+Shift+] produces } and Ctrl+Shift+[ produces {
      const increasing = e.key === '}' || e.key === ']';
      e.preventDefault();
      setMetrics(m => ({
        ...m,
        lineHeight: Math.max(0.8, Math.min(3, Math.round((m.lineHeight + (increasing ? 0.1 : -0.1)) * 10) / 10)),
      }));
      return;
    }

    // Ctrl+Alt+] / Ctrl+Alt+[ — letter spacing
    if (ctrl && alt && !shift && (e.key === ']' || e.key === '[')) {
      e.preventDefault();
      setMetrics(m => ({
        ...m,
        letterSpacing: Math.max(-5, Math.min(20, Math.round((m.letterSpacing + (e.key === ']' ? 0.5 : -0.5)) * 10) / 10)),
      }));
      return;
    }

    // Ctrl+Shift+L — cycle font family
    if (ctrl && shift && !alt && (e.key === 'L' || e.key === 'l')) {
      e.preventDefault();
      setMetrics(m => ({ ...m, fontFamilyIdx: (m.fontFamilyIdx + 1) % FONT_FAMILIES.length }));
      return;
    }

    // Ctrl+Shift+W — cycle font weight
    if (ctrl && shift && !alt && (e.key === 'W' || e.key === 'w')) {
      e.preventDefault();
      setMetrics(m => ({ ...m, fontWeightIdx: (m.fontWeightIdx + 1) % FONT_WEIGHTS.length }));
      return;
    }

    // Ctrl+Shift+T — toggle theme
    if (ctrl && shift && !alt && (e.key === 'T' || e.key === 't')) {
      e.preventDefault();
      setMetrics(m => ({ ...m, darkTheme: !m.darkTheme }));
      return;
    }
  }, [source, metrics, runEval]);

  const showEditor = viewMode !== 'output';
  const showOutput = viewMode !== 'editor';

  const editorBg = '#1a1a2e';
  const outputBg = metrics.darkTheme ? '#0f0f23' : '#fafafa';
  const outputColor = metrics.darkTheme ? '#e0e0e0' : '#1a1a1a';
  const statusBg = '#16162a';
  const borderColor = '#2a2a4a';

  return (
    <Box
      ref={panelRef}
      onKeyDown={handleKeyDown}
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        bgcolor: editorBg,
      }}
    >
      {/* Main content area */}
      <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Source editor */}
        {showEditor && (
          <Box
            sx={{
              flex: showOutput ? 1 : 1,
              display: 'flex',
              flexDirection: 'column',
              borderRight: showOutput ? `1px solid ${borderColor}` : 'none',
              overflow: 'hidden',
            }}
          >
            <Box
              sx={{
                px: 1.5,
                py: 0.5,
                borderBottom: `1px solid ${borderColor}`,
                color: '#888',
                fontSize: 11,
                fontFamily: 'monospace',
                userSelect: 'none',
              }}
            >
              SOURCE
            </Box>
            <Box
              component="textarea"
              ref={textareaRef}
              value={source}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setSource(e.target.value)}
              onSelect={handleSelect}
              onKeyUp={handleSelect}
              onClick={handleSelect}
              spellCheck={false}
              sx={{
                flex: 1,
                resize: 'none',
                border: 'none',
                outline: 'none',
                bgcolor: editorBg,
                color: '#c8d6e5',
                fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                fontSize: 13,
                lineHeight: 1.7,
                p: 1.5,
                overflow: 'auto',
                caretColor: '#90caf9',
                '&::selection': {
                  bgcolor: '#2a4a6a',
                },
              }}
            />
          </Box>
        )}

        {/* Output pane */}
        {showOutput && (
          <Box
            sx={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <Box
              sx={{
                px: 1.5,
                py: 0.5,
                borderBottom: `1px solid ${borderColor}`,
                color: '#888',
                fontSize: 11,
                fontFamily: 'monospace',
                userSelect: 'none',
                bgcolor: outputBg,
              }}
            >
              OUTPUT
            </Box>
            <Box
              sx={{
                flex: 1,
                overflow: 'auto',
                p: 1.5,
                bgcolor: outputBg,
                color: outputColor,
                fontFamily: FONT_FAMILIES[metrics.fontFamilyIdx],
                fontSize: metrics.fontSize,
                lineHeight: metrics.lineHeight,
                letterSpacing: `${metrics.letterSpacing}px`,
                fontWeight: FONT_WEIGHTS[metrics.fontWeightIdx],
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                transition: 'font-size 0.15s, line-height 0.15s, letter-spacing 0.15s, background-color 0.2s, color 0.2s',
              }}
            >
              {output}
            </Box>
          </Box>
        )}
      </Box>

      {/* Status bar */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          px: 1.5,
          py: 0.4,
          bgcolor: statusBg,
          borderTop: `1px solid ${borderColor}`,
          color: '#777',
          fontSize: 11,
          fontFamily: '"JetBrains Mono", monospace',
          userSelect: 'none',
          flexShrink: 0,
        }}
      >
        <Typography sx={{ fontSize: 'inherit', fontFamily: 'inherit', color: 'inherit' }}>
          Ln {cursorPos.line}, Col {cursorPos.col}
        </Typography>
        <Typography sx={{ fontSize: 'inherit', fontFamily: 'inherit', color: 'inherit' }}>
          {evalTime}ms
        </Typography>
        <Typography sx={{
          fontSize: 'inherit',
          fontFamily: 'inherit',
          color: errors > 0 ? '#ef5350' : 'inherit',
        }}>
          {errors} error{errors !== 1 ? 's' : ''}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: 'inherit', fontFamily: 'inherit', color: '#555' }}>
          {metrics.fontSize}px
          {' | '}
          {metrics.lineHeight}lh
          {' | '}
          {metrics.letterSpacing}ls
          {' | '}
          {FONT_FAMILY_LABELS[metrics.fontFamilyIdx]}
          {' | '}
          {FONT_WEIGHT_LABELS[metrics.fontWeightIdx]}
          {' | '}
          {metrics.darkTheme ? 'dark' : 'light'}
          {' | '}
          {viewMode}
        </Typography>
      </Box>
    </Box>
  );
};
