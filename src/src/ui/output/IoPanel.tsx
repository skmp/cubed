import React, { useState, useCallback } from 'react';
import { Box, TextField, IconButton } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import { VgaDisplay } from '../emulator/VgaDisplay';
import { SerialOutput } from '../emulator/SerialOutput';

interface IoPanelProps {
  ioWrites: number[];
  ioWriteTimestamps: number[];
  ioWriteCount: number;
  ioWriteStart: number;
  ioWriteSeq: number;
  onSendSerialInput: (bytes: number[]) => void;
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

  const sendText = useCallback(() => {
    if (serialText.length === 0) return;
    const encoded = new TextEncoder().encode(serialText + '\n');
    onSendSerialInput(Array.from(encoded));
    setSerialText('');
  }, [serialText, onSendSerialInput]);

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
      <SerialOutput
        ioWrites={ioWrites}
        ioWriteCount={ioWriteCount}
        ioWriteStart={ioWriteStart}
        ioWriteSeq={ioWriteSeq}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', px: 1, py: 0.5, gap: 1 }}>
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
