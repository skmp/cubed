import React from 'react';
import { Box } from '@mui/material';
import { VgaDisplay } from '../emulator/VgaDisplay';
import { SerialOutput } from '../emulator/SerialOutput';

interface IoPanelProps {
  ioWrites: number[];
  ioWriteTimestamps: number[];
  ioWriteCount: number;
  ioWriteStart: number;
  ioWriteSeq: number;
}

export const IoPanel: React.FC<IoPanelProps> = ({
  ioWrites,
  ioWriteTimestamps,
  ioWriteCount,
  ioWriteStart,
  ioWriteSeq,
}) => {
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      <VgaDisplay
        ioWrites={ioWrites}
        ioWriteTimestamps={ioWriteTimestamps}
        ioWriteCount={ioWriteCount}
        ioWriteStart={ioWriteStart}
        ioWriteSeq={ioWriteSeq}
      />
      <SerialOutput
        ioWrites={ioWrites}
        ioWriteCount={ioWriteCount}
        ioWriteStart={ioWriteStart}
        ioWriteSeq={ioWriteSeq}
      />
    </Box>
  );
};
