import React, { useState, useCallback } from 'react';
import { Box, Chip, TextField, IconButton } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import { VgaDisplay } from '../emulator/VgaDisplay';
import { SerialOutput } from '../emulator/SerialOutput';

interface IoPanelProps {
  ioWrites: number[];
  ioWriteTimestamps: number[];
  ioWriteCount: number;
  ioWriteStart: number;
  ioWriteSeq: number;
  onSendSerialInput: (bytes: number[], baud: number) => void;
}

export const IoPanel: React.FC<IoPanelProps> = ({
  ioWrites,
  ioWriteTimestamps,
  ioWriteCount,
  ioWriteStart,
  ioWriteSeq,
  onSendSerialInput,
}) => {
  const [serialText, setSerialText] = useState('');
  const [baudRate, setBaudRate] = useState(921600);

  const sendText = useCallback(() => {
    if (serialText.length === 0) return;
    const encoded = new TextEncoder().encode(serialText + '\n');
    onSendSerialInput(Array.from(encoded), baudRate);
    setSerialText('');
  }, [serialText, baudRate, onSendSerialInput]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  }, [sendText]);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      <VgaDisplay
        ioWrites={ioWrites}
        ioWriteTimestamps={ioWriteTimestamps}
        ioWriteCount={ioWriteCount}
        ioWriteStart={ioWriteStart}
        ioWriteSeq={ioWriteSeq}
      />
      {ioWriteCount > 0 && (
        <Box sx={{ px: 1, py: 0.5 }}>
          <Chip label={`${ioWriteCount} IO writes`} size="small" sx={{ fontSize: '9px', height: 18 }} />
        </Box>
      )}
      <SerialOutput
        ioWrites={ioWrites}
        ioWriteTimestamps={ioWriteTimestamps}
        ioWriteCount={ioWriteCount}
        ioWriteStart={ioWriteStart}
        ioWriteSeq={ioWriteSeq}
        baud={baudRate}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', px: 1, py: 0.5, gap: 1 }}>
        <TextField
          size="small"
          variant="outlined"
          label="Baud"
          type="number"
          value={baudRate}
          onChange={(e) => setBaudRate(Number(e.target.value) || 115200)}
          sx={{ width: 100 }}
          inputProps={{ style: { fontFamily: 'monospace', fontSize: 13 } }}
        />
        <TextField
          size="small"
          variant="outlined"
          placeholder="Serial input..."
          value={serialText}
          onChange={(e) => setSerialText(e.target.value)}
          onKeyDown={handleKeyDown}
          sx={{ flex: 1 }}
          inputProps={{ style: { fontFamily: 'monospace', fontSize: 13 } }}
        />
        <IconButton size="small" onClick={sendText} disabled={serialText.length === 0}>
          <SendIcon fontSize="small" />
        </IconButton>
      </Box>
    </Box>
  );
};
