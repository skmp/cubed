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
  totalEnergyPJ: number;
  chipPowerMW: number;
  totalSimTimeNS: number;
  language: EditorLanguage;
  isRunning: boolean;
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

/** Auto-scale energy from picojoules to the best SI unit (pJ → nJ → μJ → mJ → J → kJ → MJ) */
function formatEnergy(pj: number): string {
  if (pj < 1e3) return `${pj.toFixed(1)} pJ`;
  if (pj < 1e6) return `${(pj / 1e3).toFixed(1)} nJ`;
  if (pj < 1e9) return `${(pj / 1e6).toFixed(1)} μJ`;
  if (pj < 1e12) return `${(pj / 1e9).toFixed(1)} mJ`;
  if (pj < 1e15) return `${(pj / 1e12).toFixed(1)} J`;
  if (pj < 1e18) return `${(pj / 1e15).toFixed(1)} kJ`;
  return `${(pj / 1e18).toFixed(1)} MJ`;
}

/** Auto-scale power from milliwatts to the best SI unit (nW → μW → mW → W → kW) */
function formatPower(mw: number): string {
  if (mw < 1e-3) return `${(mw * 1e6).toFixed(1)} nW`;
  if (mw < 1) return `${(mw * 1e3).toFixed(1)} μW`;
  if (mw < 1e3) return `${mw.toFixed(1)} mW`;
  if (mw < 1e6) return `${(mw / 1e3).toFixed(1)} W`;
  return `${(mw / 1e6).toFixed(1)} kW`;
}

export const DebugToolbar: React.FC<DebugToolbarProps> = ({
  activeCount, totalSteps, totalEnergyPJ, chipPowerMW, totalSimTimeNS,
  language, isRunning,
  onCompile, onSetLanguage, onStep, onStepN, onRun, onStop, onReset,
}) => {
  const totalStepsRef = useRef(totalSteps);
  const totalEnergyRef = useRef(totalEnergyPJ);
  const totalSimTimeRef = useRef(totalSimTimeNS);
  const lastStepsRef = useRef(totalSteps);
  const lastEnergyRef = useRef(totalEnergyPJ);
  const lastSimTimeRef = useRef(totalSimTimeNS);
  const lastTimeRef = useRef(0);
  const [measuredRate, setMeasuredRate] = useState(0);
  const [measuredAvgPower, setMeasuredAvgPower] = useState(0);

  useEffect(() => {
    totalStepsRef.current = totalSteps;
  }, [totalSteps]);

  useEffect(() => {
    totalEnergyRef.current = totalEnergyPJ;
  }, [totalEnergyPJ]);

  useEffect(() => {
    totalSimTimeRef.current = totalSimTimeNS;
  }, [totalSimTimeNS]);

  useEffect(() => {
    if (!isRunning) {
      lastStepsRef.current = totalStepsRef.current;
      lastEnergyRef.current = totalEnergyRef.current;
      lastSimTimeRef.current = totalSimTimeRef.current;
      lastTimeRef.current = performance.now();
      return;
    }
    lastStepsRef.current = totalStepsRef.current;
    lastEnergyRef.current = totalEnergyRef.current;
    lastSimTimeRef.current = totalSimTimeRef.current;
    lastTimeRef.current = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      const dt = (now - lastTimeRef.current) / 1000;
      if (dt > 0) {
        const ds = totalStepsRef.current - lastStepsRef.current;
        setMeasuredRate(ds / dt);
        // Average power in CPU clock domain: delta energy (pJ) / delta sim time (ns)
        // pJ / ns = mW
        const dE = totalEnergyRef.current - lastEnergyRef.current;
        const dSimT = totalSimTimeRef.current - lastSimTimeRef.current;
        setMeasuredAvgPower(dSimT > 0 ? dE / dSimT : 0); // pJ/ns = mW
      }
      lastStepsRef.current = totalStepsRef.current;
      lastEnergyRef.current = totalEnergyRef.current;
      lastSimTimeRef.current = totalSimTimeRef.current;
      lastTimeRef.current = now;
    }, 500);
    return () => clearInterval(interval);
  }, [isRunning]);

  const stepsPerSec = isRunning ? measuredRate : 0;
  const avgPowerMW = isRunning ? measuredAvgPower : 0;

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
        <Chip
          size="small"
          label={formatEnergy(totalEnergyPJ)}
          variant="outlined"
          title="Cumulative energy dissipated (all nodes)"
          sx={{ fontSize: '10px', height: 20 }}
        />
        <Chip
          size="small"
          label={formatPower(chipPowerMW)}
          variant="outlined"
          title="Instantaneous chip power consumption"
          sx={{ fontSize: '10px', height: 20 }}
        />
        {isRunning && avgPowerMW > 0 && (
          <Chip
            size="small"
            label={`avg ${formatPower(avgPowerMW)}`}
            variant="outlined"
            title="Average power (1s rolling window)"
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
