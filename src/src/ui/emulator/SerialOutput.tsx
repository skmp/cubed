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
const SCAN_WINDOW = 2_000_000; // scan full ring buffer (matches IO_WRITE_CAPACITY)
const MAX_ROWS = 12; // max history rows to display

// asynctx{} tags data writes with bit 17 (0x20000) to distinguish them from
// serial drive bits (values 2/3). Relay nodes write raw untagged values.
const ASYNCTX_DATA_TAG = 0x20000;

export const SerialOutput: React.FC<SerialOutputProps> = ({
  ioWrites, ioWriteCount, ioWriteStart, ioWriteSeq,
}) => {
  const rows = useMemo(() => {
    // Scan backwards, collecting complete SERIAL_FIELDS-sized groups
    // from the same serial node. Each complete group is one result row.
    const scanStart = Math.max(0, ioWriteCount - SCAN_WINDOW);
    const groups: { node: number; values: number[] }[] = [];
    let activeNode: number | null = null;
    let pending: number[] = [];

    for (let i = ioWriteCount - 1; i >= scanStart; i--) {
      const tagged = readIoWrite(ioWrites, ioWriteStart, i);
      const coord = taggedCoord(tagged);
      const rawVal = taggedValue(tagged);

      if (!SERIAL_NODES.has(coord)) {
        // Non-serial write (VGA pixel, sync, etc.) — skip without breaking group.
        // Serial data writes are interleaved with VGA writes in the ring buffer,
        // so we must not reset the pending group here.
        continue;
      }

      // asynctx writes data tagged with bit 17; drive bits are untagged (values 2/3).
      // Relay nodes (e.g. 317) write raw untagged data — accept all their writes.
      let dataVal: number | null = null;
      if (rawVal & ASYNCTX_DATA_TAG) {
        // Tagged data write from asynctx — unmask to get actual value
        dataVal = rawVal & ~ASYNCTX_DATA_TAG;
      } else if (rawVal > 3) {
        // Untagged relay write — raw value, not a drive bit
        dataVal = rawVal;
      }
      // rawVal <= 3 and untagged: serial drive bit — skip without breaking group

      if (dataVal === null) continue;

      if (activeNode === null) activeNode = coord;
      if (coord !== activeNode) {
        // Different serial node — save completed group if full, start new
        if (pending.length === SERIAL_FIELDS) groups.push({ node: activeNode, values: [...pending] });
        pending = [];
        activeNode = coord;
      }
      pending.unshift(dataVal);
      if (pending.length === SERIAL_FIELDS) {
        groups.push({ node: activeNode, values: [...pending] });
        pending = [];
        if (groups.length >= MAX_ROWS) break;
      }
    }

    // Reverse so oldest is at top, newest at bottom
    groups.reverse();
    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ioWrites, ioWriteCount, ioWriteStart, ioWriteSeq]);

  if (rows.length === 0) return null;

  const labels = ['N', 'a', 'r', 'p', 'q'];

  return (
    <Box sx={{ px: 1, py: 0.5, borderBottom: '1px solid #333', bgcolor: '#1a1a2e', maxHeight: 180, overflowY: 'auto' }}>
      {rows.map((row, idx) => {
        const pairs = row.values.slice(0, labels.length).map((v, i) => `${labels[i]}=${v}`);
        const N = row.values[0];
        const p = row.values.length > 3 ? row.values[3] : undefined;
        const q = row.values.length > 4 ? row.values[4] : undefined;
        const factorStr = p !== undefined && q !== undefined ? `  →  ${N} = ${p} × ${q}` : '';
        const isLatest = idx === rows.length - 1;
        return (
          <Typography
            key={idx}
            variant="caption"
            display="block"
            sx={{ fontFamily: 'monospace', fontSize: '11px', color: isLatest ? '#0f0' : '#0a0' }}
          >
            SERIAL [{row.node}]: {pairs.join('  ')}{factorStr}
          </Typography>
        );
      })}
    </Box>
  );
};
