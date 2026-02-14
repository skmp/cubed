import React from 'react';
import { Table, TableBody, TableCell, TableRow, Typography } from '@mui/material';
import type { F18ARegisters } from '../../core/types';

const hex = (v: number, bits: number = 18): string => {
  const digits = Math.ceil(bits / 4);
  return '0x' + (v & ((1 << bits) - 1)).toString(16).toUpperCase().padStart(digits, '0');
};

interface RegisterViewProps {
  registers: F18ARegisters;
  slotIndex: number;
}

export const RegisterView: React.FC<RegisterViewProps> = ({ registers, slotIndex }) => {
  const regs = [
    { name: 'P', value: registers.P, bits: 10 },
    { name: 'I', value: registers.I, bits: 18 },
    { name: 'A', value: registers.A, bits: 18 },
    { name: 'B', value: registers.B, bits: 9 },
    { name: 'T', value: registers.T, bits: 18 },
    { name: 'S', value: registers.S, bits: 18 },
    { name: 'R', value: registers.R, bits: 18 },
    { name: 'IO', value: registers.IO, bits: 18 },
  ];

  return (
    <>
      <Typography variant="caption" sx={{ color: '#888', mb: 0.5, display: 'block' }}>
        Slot: {slotIndex}
      </Typography>
      <Table size="small" sx={{ '& td': { py: 0.25, px: 1, fontFamily: 'monospace', fontSize: '11px' } }}>
        <TableBody>
          {regs.map(r => (
            <TableRow key={r.name}>
              <TableCell sx={{ color: '#90caf9', width: 30 }}>{r.name}</TableCell>
              <TableCell>{hex(r.value, r.bits)}</TableCell>
              <TableCell sx={{ color: '#888' }}>{r.value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
};
