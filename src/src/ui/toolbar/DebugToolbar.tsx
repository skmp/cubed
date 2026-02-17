import React from 'react';
import {
  Box, Button, ButtonGroup, Chip, Slider, ToggleButtonGroup, ToggleButton, Typography,
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
  stepsPerFrame: number;
  onCompile: () => void;
  onSetLanguage: (lang: EditorLanguage) => void;
  onStep: () => void;
  onStepN: (n: number) => void;
  onRun: () => void;
  onStop: () => void;
  onReset: () => void;
  onSetStepsPerFrame: (n: number) => void;
}

export const DebugToolbar: React.FC<DebugToolbarProps> = ({
  activeCount, totalSteps, language, isRunning, stepsPerFrame,
  onCompile, onSetLanguage, onStep, onStepN, onRun, onStop, onReset, onSetStepsPerFrame,
}) => {
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

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, width: 180 }}>
        <Typography variant="caption" sx={{ color: '#888', fontSize: '9px', whiteSpace: 'nowrap' }}>
          Steps/frame: {stepsPerFrame}
        </Typography>
        <Slider
          size="small"
          value={stepsPerFrame}
          onChange={(_, v) => onSetStepsPerFrame(v as number)}
          min={1}
          max={10000}
          step={1}
          sx={{ py: 0 }}
        />
      </Box>

      <Box sx={{ ml: 'auto', display: 'flex', gap: 1 }}>
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
