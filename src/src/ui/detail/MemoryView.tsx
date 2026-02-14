import React from 'react';
import { Box, Tabs, Tab } from '@mui/material';
import { formatDisassembly } from '../../core/disassembler';

const hex18 = (v: number): string => (v & 0x3FFFF).toString(16).toUpperCase().padStart(5, '0');
const hex8 = (v: number): string => v.toString(16).toUpperCase().padStart(2, '0');

interface MemoryViewProps {
  ram: number[];
  rom: number[];
  pc: number;
}

export const MemoryView: React.FC<MemoryViewProps> = ({ ram, rom, pc }) => {
  const [tab, setTab] = React.useState(0);
  const data = tab === 0 ? ram : rom;
  const baseAddr = tab === 0 ? 0 : 0x80;

  return (
    <Box>
      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        sx={{ minHeight: 28, '& .MuiTab-root': { minHeight: 28, py: 0, fontSize: '11px' } }}
      >
        <Tab label="RAM (0x00-0x3F)" />
        <Tab label="ROM (0x80-0xBF)" />
      </Tabs>
      <Box sx={{ maxHeight: 400, overflow: 'auto', mt: 0.5 }}>
        {data.map((word, i) => {
          const addr = baseAddr + i;
          const isPC = addr === (pc & 0xFF);
          return (
            <Box
              key={i}
              sx={{
                display: 'flex',
                fontFamily: 'monospace',
                fontSize: '10px',
                py: 0.1,
                px: 0.5,
                backgroundColor: isPC ? '#1a3a1a' : 'transparent',
                borderLeft: isPC ? '2px solid #4CAF50' : '2px solid transparent',
                '&:hover': { backgroundColor: '#222' },
              }}
            >
              <Box sx={{ width: 35, color: '#666' }}>
                {hex8(addr)}
              </Box>
              <Box sx={{ width: 55, color: isPC ? '#4CAF50' : '#ccc' }}>
                {hex18(word)}
              </Box>
              <Box sx={{ flex: 1, color: '#888', ml: 1 }}>
                {formatDisassembly(word)}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
