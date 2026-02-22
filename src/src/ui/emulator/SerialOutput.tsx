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

const SERIAL_FIELDS = 5; // N, a, r, p, q
const SCAN_WINDOW = 50000; // only scan recent writes

export const SerialOutput: React.FC<SerialOutputProps> = ({
  ioWrites, ioWriteCount, ioWriteStart, ioWriteSeq,
}) => {
  const { values, sourceNode } = useMemo(() => {
    // Scan backwards to find the most recent serial node that has written,
    // then collect its last SERIAL_FIELDS writes.
    const scanStart = Math.max(0, ioWriteCount - SCAN_WINDOW);
    let activeNode: number | null = null;
    const result: number[] = [];
    for (let i = ioWriteCount - 1; i >= scanStart; i--) {
      const tagged = readIoWrite(ioWrites, ioWriteStart, i);
      const coord = taggedCoord(tagged);
      if (!SERIAL_NODES.has(coord)) continue;
      // Latch onto whichever serial node we see first (most recent)
      if (activeNode === null) activeNode = coord;
      if (coord !== activeNode) break; // stop if we hit a different serial node
      result.unshift(taggedValue(tagged));
      if (result.length >= SERIAL_FIELDS) break;
    }
    return { values: result, sourceNode: activeNode };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ioWrites, ioWriteCount, ioWriteStart, ioWriteSeq]);

  if (values.length === 0) return null;

  // Decode Shor's output: [N, a, r, p, q]
  const labels = ['N', 'a', 'r', 'p', 'q'];
  const pairs = values.slice(0, labels.length).map((v, i) => `${labels[i]}=${v}`);
  const N = values[0];
  const p = values.length > 3 ? values[3] : undefined;
  const q = values.length > 4 ? values[4] : undefined;
  const factorStr = p !== undefined && q !== undefined ? `  →  ${N} = ${p} × ${q}` : '';

  return (
    <Box sx={{ px: 1, py: 0.5, borderBottom: '1px solid #333', bgcolor: '#1a1a2e' }}>
      <Typography
        variant="caption"
        sx={{ fontFamily: 'monospace', fontSize: '11px', color: '#0f0' }}
      >
        SERIAL [{sourceNode}]: {pairs.join('  ')}{factorStr}
      </Typography>
    </Box>
  );
};
