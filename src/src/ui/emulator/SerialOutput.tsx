import React, { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import { SERIAL_NODES } from '../../core/constants';
import { readIoWrite, taggedCoord, taggedValue } from './vgaResolution';

interface SerialOutputProps {
  ioWrites: number[];
  ioWriteCount: number;
  ioWriteStart: number;
  ioWriteSeq: number;
}

const SCAN_WINDOW = 2_000_000;

// asynctx{} and ECHO2 tag data writes with bit 17 (0x20000) to distinguish
// them from serial drive bits (values 2/3).
const ASYNCTX_DATA_TAG = 0x20000;

/** Format a value as a printable char, escape sequence, or hex. */
function formatValue(v: number): string {
  if (v <= 0xFF) {
    if (v >= 0x20 && v <= 0x7E) return String.fromCharCode(v);
    if (v === 0x0A) return '\\n';
    if (v === 0x0D) return '\\r';
    if (v === 0x09) return '\\t';
    return '\\x' + v.toString(16).padStart(2, '0');
  }
  return '\\u{' + v.toString(16) + '}';
}

export const SerialOutput: React.FC<SerialOutputProps> = ({
  ioWrites, ioWriteCount, ioWriteStart, ioWriteSeq,
}) => {
  const text = useMemo(() => {
    const scanStart = Math.max(0, ioWriteCount - SCAN_WINDOW);
    const parts: string[] = [];

    for (let i = scanStart; i < ioWriteCount; i++) {
      const tagged = readIoWrite(ioWrites, ioWriteStart, i);
      const coord = taggedCoord(tagged);
      const rawVal = taggedValue(tagged);

      if (!SERIAL_NODES.has(coord)) continue;

      let dataVal: number | null = null;
      if (rawVal & ASYNCTX_DATA_TAG) {
        dataVal = rawVal & ~ASYNCTX_DATA_TAG;
      } else if (rawVal > 3) {
        dataVal = rawVal;
      }

      if (dataVal !== null) parts.push(formatValue(dataVal));
    }

    return parts.join('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ioWrites, ioWriteCount, ioWriteStart, ioWriteSeq]);

  if (text.length === 0) return null;

  return (
    <Box sx={{ px: 1, py: 0.5, borderBottom: '1px solid #333', bgcolor: '#1a1a2e', maxHeight: 180, overflowY: 'auto' }}>
      <Typography
        variant="caption"
        display="block"
        sx={{ fontFamily: 'monospace', fontSize: '11px', color: '#0f0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
      >
        SERIAL: {text}
      </Typography>
    </Box>
  );
};
