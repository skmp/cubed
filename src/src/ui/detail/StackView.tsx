import React from 'react';
import { Box, Typography } from '@mui/material';

const hex18 = (v: number): string => '0x' + (v & 0x3FFFF).toString(16).toUpperCase().padStart(5, '0');

interface StackViewProps {
  dstack: number[];
  rstack: number[];
}

export const StackView: React.FC<StackViewProps> = ({ dstack, rstack }) => {
  return (
    <Box sx={{ display: 'flex', gap: 2 }}>
      <Box sx={{ flex: 1 }}>
        <Typography variant="caption" sx={{ color: '#90caf9', fontWeight: 'bold' }}>
          Data Stack
        </Typography>
        {dstack.map((val, i) => (
          <Box
            key={i}
            sx={{
              fontFamily: 'monospace',
              fontSize: '11px',
              py: 0.15,
              px: 0.5,
              backgroundColor: i < 2 ? '#1a2a1a' : 'transparent',
              color: i === 0 ? '#4CAF50' : i === 1 ? '#81C784' : '#888',
            }}
          >
            <Box component="span" sx={{ color: '#555', mr: 1 }}>
              {i === 0 ? 'T' : i === 1 ? 'S' : `${i - 2}`}
            </Box>
            {hex18(val)}
          </Box>
        ))}
      </Box>
      <Box sx={{ flex: 1 }}>
        <Typography variant="caption" sx={{ color: '#ce93d8', fontWeight: 'bold' }}>
          Return Stack
        </Typography>
        {rstack.map((val, i) => (
          <Box
            key={i}
            sx={{
              fontFamily: 'monospace',
              fontSize: '11px',
              py: 0.15,
              px: 0.5,
              backgroundColor: i === 0 ? '#2a1a2a' : 'transparent',
              color: i === 0 ? '#ce93d8' : '#888',
            }}
          >
            <Box component="span" sx={{ color: '#555', mr: 1 }}>
              {i === 0 ? 'R' : `${i - 1}`}
            </Box>
            {hex18(val)}
          </Box>
        ))}
      </Box>
    </Box>
  );
};
