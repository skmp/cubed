import React from 'react';
import { Box, Typography, Paper } from '@mui/material';
import { NodeCell } from './NodeCell';
import { NodeState } from '../../core/types';
import { coordToIndex } from '../../core/constants';

interface ChipGridProps {
  nodeStates: NodeState[];
  nodeCoords: number[];
  selectedCoord: number | null;
  onNodeClick: (coord: number) => void;
}

export const ChipGrid: React.FC<ChipGridProps> = ({ nodeStates, selectedCoord, onNodeClick }) => {
  // Render grid: row 7 at top, row 0 at bottom, cols 0-17 left to right
  const rows = [];
  for (let row = 7; row >= 0; row--) {
    const cells = [];
    for (let col = 0; col <= 17; col++) {
      const coord = row * 100 + col;
      const index = coordToIndex(coord);
      cells.push(
        <NodeCell
          key={coord}
          coord={coord}
          state={nodeStates[index]}
          isSelected={selectedCoord === coord}
          onClick={onNodeClick}
        />
      );
    }
    rows.push(
      <Box key={row} sx={{ display: 'flex', gap: '1px' }}>
        {cells}
      </Box>
    );
  }

  return (
    <Paper
      elevation={2}
      sx={{ p: 1, backgroundColor: '#0a0a0a', overflow: 'auto' }}
    >
      <Typography variant="caption" sx={{ mb: 0.5, display: 'block', color: '#888' }}>
        GA144 Chip — 8×18 Node Grid
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
        {rows}
      </Box>
      <Box sx={{ mt: 0.5, display: 'flex', gap: 2, fontSize: '10px', color: '#888' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box sx={{ width: 8, height: 8, backgroundColor: '#4CAF50', borderRadius: 1 }} /> Running
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box sx={{ width: 8, height: 8, backgroundColor: '#2196F3', borderRadius: 1 }} /> Read
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box sx={{ width: 8, height: 8, backgroundColor: '#FF9800', borderRadius: 1 }} /> Write
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box sx={{ width: 8, height: 8, backgroundColor: '#424242', borderRadius: 1 }} /> Idle
        </Box>
      </Box>
    </Paper>
  );
};
