import React, { useRef, useEffect, useState } from 'react';
import {
  Box, Button, ButtonGroup, Chip, ToggleButtonGroup, ToggleButton,
} from '@mui/material';
import BuildIcon from '@mui/icons-material/Build';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import FastForwardIcon from '@mui/icons-material/FastForward';
import type { EditorLanguage } from '../editor/CodeEditor';

interface DebugToolbarProps {
  activeCount: number;
  totalSteps: number;
  language: EditorLanguage;
  isRunning: boolean;
  sabActive: boolean;
  onCompile: () => void;
  onSetLanguage: (lang: EditorLanguage) => void;
  onStep: () => void;
  onStepN: (n: number) => void;
  onRun: () => void;
  onStop: () => void;
  onReset: () => void;
}

function formatRate(rate: number): string {
  if (rate >= 1e9) return `${(rate / 1e9).toFixed(1)}G`;
  if (rate >= 1e6) return `${(rate / 1e6).toFixed(1)}M`;
  if (rate >= 1e3) return `${(rate / 1e3).toFixed(1)}K`;
  return `${Math.round(rate)}`;
}

export const DebugToolbar: React.FC<DebugToolbarProps> = ({
  activeCount, totalSteps, language, isRunning, sabActive,
  onCompile, onSetLanguage, onStep, onStepN, onRun, onStop, onReset,
}) => {
  const totalStepsRef = useRef(totalSteps);
  const lastStepsRef = useRef(totalSteps);
  const lastTimeRef = useRef(0);
  const [measuredRate, setMeasuredRate] = useState(0);

  useEffect(() => {
    totalStepsRef.current = totalSteps;
  }, [totalSteps]);

  useEffect(() => {
    if (!isRunning) {
      lastStepsRef.current = totalStepsRef.current;
      lastTimeRef.current = performance.now();
      return;
    }
    lastStepsRef.current = totalStepsRef.current;
    lastTimeRef.current = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      const dt = (now - lastTimeRef.current) / 1000;
      if (dt > 0) {
        const ds = totalStepsRef.current - lastStepsRef.current;
        setMeasuredRate(ds / dt);
      }
      lastStepsRef.current = totalStepsRef.current;
      lastTimeRef.current = now;
    }, 500);
    return () => clearInterval(interval);
  }, [isRunning]);

  const stepsPerSec = isRunning ? measuredRate : 0;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, height: 40 }}>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={language}
        onChange={(_, val) => { if (val) onSetLanguage(val); }}
        sx={{ height: 26 }}
      >
        <ToggleButton value="arrayforth" sx={{ textTransform: 'none', fontSize: '10px', px: 1 }}>
          arrayForth
        </ToggleButton>
        <ToggleButton value="recurse" sx={{ textTransform: 'none', fontSize: '10px', px: 1 }}>
          Recurse
        </ToggleButton>
        <ToggleButton value="cube" sx={{ textTransform: 'none', fontSize: '10px', px: 1 }}>
          CUBE
        </ToggleButton>
      </ToggleButtonGroup>

      <Button
        size="small"
        variant="contained"
        color="success"
        startIcon={<BuildIcon />}
        onClick={onCompile}
        sx={{ textTransform: 'none', fontSize: '11px' }}
      >
        Compile
      </Button>

      <ButtonGroup size="small" variant="outlined">
        <Button onClick={onStep} disabled={isRunning} title="Step (F10)">
          <SkipNextIcon fontSize="small" />
        </Button>
        <Button onClick={() => onStepN(100)} disabled={isRunning} title="Step 100">
          <FastForwardIcon fontSize="small" />
        </Button>
        {isRunning ? (
          <Button onClick={onStop} color="warning" title="Stop (Esc)">
            <PauseIcon fontSize="small" />
          </Button>
        ) : (
          <Button onClick={onRun} color="success" title="Run (F5)">
            <PlayArrowIcon fontSize="small" />
          </Button>
        )}
        <Button onClick={onReset} color="error" title="Reset">
          <RestartAltIcon fontSize="small" />
        </Button>
      </ButtonGroup>

      <Box sx={{ ml: 'auto', display: 'flex', gap: 1 }}>
        {sabActive && (
          <Chip
            size="small"
            label="SAB"
            color="success"
            title="SharedArrayBuffer VCO clocks active"
            sx={{ fontSize: '10px', height: 20 }}
          />
        )}
        {isRunning && stepsPerSec > 0 && (
          <Chip
            size="small"
            label={`${formatRate(stepsPerSec)} steps/s`}
            variant="outlined"
            sx={{ fontSize: '10px', height: 20 }}
          />
        )}
        <Chip
          size="small"
          label={`Active: ${activeCount}/144`}
          sx={{ fontSize: '10px', height: 20 }}
        />
        <Chip
          size="small"
          label={`Steps: ${totalSteps}`}
          variant="outlined"
          sx={{ fontSize: '10px', height: 20 }}
        />
      </Box>
    </Box>
  );
};
