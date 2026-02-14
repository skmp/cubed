import React from 'react';
import { Box, Tooltip } from '@mui/material';
import { NodeState } from '../../core/types';
import { NODE_COLORS } from '../theme';
import { BOOT_NODES, ANALOG_NODES } from '../../core/constants';

interface NodeCellProps {
  coord: number;
  state: NodeState;
  isSelected: boolean;
  onClick: (coord: number) => void;
}

export const NodeCell: React.FC<NodeCellProps> = React.memo(({ coord, state, isSelected, onClick }) => {
  const bgColor = NODE_COLORS[state] || NODE_COLORS.suspended;
  const isBoot = BOOT_NODES.includes(coord);
  const isAnalog = ANALOG_NODES.includes(coord);

  const label = `${coord} (${state})`;

  return (
    <Tooltip title={label} placement="top" arrow enterDelay={300}>
      <Box
        onClick={() => onClick(coord)}
        sx={{
          width: 26,
          height: 26,
          backgroundColor: bgColor,
          border: isSelected ? `2px solid ${NODE_COLORS.selected}` : '1px solid #333',
          borderRadius: '2px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          fontSize: '7px',
          color: '#fff',
          fontWeight: isSelected ? 'bold' : 'normal',
          position: 'relative',
          userSelect: 'none',
          '&:hover': {
            filter: 'brightness(1.3)',
          },
        }}
      >
        {coord.toString().padStart(3, '0')}
        {isBoot && (
          <Box sx={{
            position: 'absolute', top: 0, right: 0,
            width: 4, height: 4, borderRadius: '50%',
            backgroundColor: '#FF5722',
          }} />
        )}
        {isAnalog && (
          <Box sx={{
            position: 'absolute', bottom: 0, right: 0,
            width: 4, height: 4, borderRadius: '50%',
            backgroundColor: '#9C27B0',
          }} />
        )}
      </Box>
    </Tooltip>
  );
});
