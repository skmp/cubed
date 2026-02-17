import React from 'react';
import {
  Box, Button, ButtonGroup, Slider, Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import FastForwardIcon from '@mui/icons-material/FastForward';
import { ChipGrid } from '../chip/ChipGrid';
import { NodeDetailPanel } from '../detail/NodeDetailPanel';
import { VgaDisplay } from './VgaDisplay';
import type { NodeState, NodeSnapshot } from '../../core/types';
import type { SourceMapEntry } from '../../core/cube/emitter';

interface EmulatorPanelProps {
  nodeStates: NodeState[];
  nodeCoords: number[];
  selectedCoord: number | null;
  selectedNode: NodeSnapshot | null;
  isRunning: boolean;
  stepsPerFrame: number;
  sourceMap: SourceMapEntry[] | null;
  ioWrites: number[];
  ioWriteCount: number;
  onNodeClick: (coord: number) => void;
  onStep: () => void;
  onStepN: (n: number) => void;
  onRun: () => void;
  onStop: () => void;
  onReset: () => void;
  onSetStepsPerFrame: (n: number) => void;
}

export const EmulatorPanel: React.FC<EmulatorPanelProps> = ({
  nodeStates, nodeCoords, selectedCoord, selectedNode,
  isRunning, stepsPerFrame, sourceMap, ioWrites, ioWriteCount,
  onNodeClick, onStep, onStepN, onRun, onStop, onReset, onSetStepsPerFrame,
}) => {
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Debug controls bar */}
      <Box sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1,
        py: 0.5,
        borderBottom: '1px solid #333',
        backgroundColor: '#1a1a1a',
        flexShrink: 0,
      }}>
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

        <Box sx={{ width: 120, ml: 1 }}>
          <Typography variant="caption" sx={{ color: '#888', fontSize: '9px' }}>
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
      </Box>

      {/* VGA display — always visible in emulator tab */}
      <Box sx={{
        flexShrink: 0,
        borderBottom: '1px solid #333',
        maxHeight: '50%',
        overflow: 'auto',
      }}>
        <VgaDisplay ioWrites={ioWrites} ioWriteCount={ioWriteCount} />
      </Box>

      {/* Main content: chip grid + node detail */}
      <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <Box sx={{
          width: 510,
          flexShrink: 0,
          overflow: 'auto',
          borderRight: '1px solid #333',
          p: 1,
        }}>
          <ChipGrid
            nodeStates={nodeStates}
            nodeCoords={nodeCoords}
            selectedCoord={selectedCoord}
            onNodeClick={onNodeClick}
          />
        </Box>
        <Box sx={{ flex: 1, overflow: 'auto' }}>
          <NodeDetailPanel node={selectedNode} sourceMap={sourceMap} />
        </Box>
      </Box>
    </Box>
  );
};
