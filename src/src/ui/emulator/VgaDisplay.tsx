import React, { useRef, useEffect, useMemo, useState } from 'react';
import { Box, Typography, Chip, TextField } from '@mui/material';

const HSYNC_BIT = 0x20000;
const VSYNC_BIT = 0x10000;
const SYNC_MASK = HSYNC_BIT | VSYNC_BIT;
const COLOR_MASK = 0x1FF;

interface VgaDisplayProps {
  ioWrites: number[];
  ioWriteCount: number;
}

function dacToRgb(value: number): string {
  const r = ((value >> 6) & 0x7) * 255 / 7 | 0;
  const g = ((value >> 3) & 0x7) * 255 / 7 | 0;
  const b = (value & 0x7) * 255 / 7 | 0;
  return `rgb(${r},${g},${b})`;
}

function detectResolution(ioWrites: number[], count: number): { width: number; height: number; hasSyncSignals: boolean } {
  let x = 0, maxX = 0, y = 0;
  let hasSyncSignals = false;
  for (let i = 0; i < count; i++) {
    const val = ioWrites[i];
    if (val & VSYNC_BIT) { hasSyncSignals = true; y = 0; x = 0; }
    else if (val & HSYNC_BIT) { hasSyncSignals = true; if (x > maxX) maxX = x; y++; x = 0; }
    else { x++; }
  }
  if (x > maxX) maxX = x;
  return { width: maxX || 1, height: Math.max(y + (x > 0 ? 1 : 0), 1), hasSyncSignals };
}

export const VgaDisplay: React.FC<VgaDisplayProps> = ({ ioWrites, ioWriteCount }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastDrawnRef = useRef(0);
  const cursorRef = useRef({ x: 0, y: 0 });
  const prevDimsRef = useRef({ w: 0, h: 0 });
  const [pixelScale, setPixelScale] = useState(0);
  const [manualWidth, setManualWidth] = useState(4);

  const resolution = useMemo(
    () => detectResolution(ioWrites, ioWriteCount),
    [ioWrites, ioWriteCount],
  );

  const displayWidth = resolution.hasSyncSignals ? resolution.width : manualWidth;
  const displayHeight = resolution.hasSyncSignals
    ? resolution.height
    : Math.max(1, Math.ceil(ioWriteCount / manualWidth));

  const effectiveScale = pixelScale > 0 ? pixelScale
    : displayWidth >= 320 ? 1 : displayWidth >= 64 ? 4 : 12;

  const canvasWidth = displayWidth * effectiveScale;
  const canvasHeight = displayHeight * effectiveScale;

  // Draw effect — incremental by default, full redraw when dimensions change or buffer resets
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || ioWriteCount === 0) return;

    const scale = effectiveScale;
    const hasSyncSignals = resolution.hasSyncSignals;
    const w = displayWidth;

    // Detect if we need a full redraw (dimensions changed, buffer reset, or first draw)
    const needsFullRedraw =
      ioWriteCount < lastDrawnRef.current ||  // buffer was reset
      canvasWidth !== prevDimsRef.current.w ||
      canvasHeight !== prevDimsRef.current.h;

    // Update canvas DOM dimensions if needed (this clears the canvas)
    if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
    if (canvas.height !== canvasHeight) canvas.height = canvasHeight;
    prevDimsRef.current = { w: canvasWidth, h: canvasHeight };

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let startIdx: number;
    const cursor = cursorRef.current;

    if (needsFullRedraw) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);
      cursor.x = 0;
      cursor.y = 0;
      startIdx = 0;
    } else {
      startIdx = lastDrawnRef.current;
    }

    // Draw pixels from startIdx to ioWriteCount
    for (let i = startIdx; i < ioWriteCount; i++) {
      const val = ioWrites[i];
      if (hasSyncSignals) {
        if (val & VSYNC_BIT) { cursor.y = 0; cursor.x = 0; continue; }
        if (val & HSYNC_BIT) { cursor.y++; cursor.x = 0; continue; }
      }
      ctx.fillStyle = dacToRgb(val & COLOR_MASK);
      ctx.fillRect(cursor.x * scale, cursor.y * scale, scale, scale);
      cursor.x++;
      if (!hasSyncSignals && cursor.x >= w) { cursor.x = 0; cursor.y++; }
    }

    lastDrawnRef.current = ioWriteCount;
  }, [ioWriteCount, effectiveScale, resolution.hasSyncSignals, displayWidth, canvasWidth, canvasHeight, ioWrites]);

  // Full redraw when user changes scale/width settings
  useEffect(() => {
    prevDimsRef.current = { w: 0, h: 0 }; // force full redraw on next render
  }, [effectiveScale, manualWidth]);

  let totalPixels = ioWriteCount;
  if (resolution.hasSyncSignals) {
    let syncCount = 0;
    for (let i = 0; i < ioWriteCount; i++) {
      if (ioWrites[i] & SYNC_MASK) syncCount++;
    }
    totalPixels = ioWriteCount - syncCount;
  }

  return (
    <Box sx={{ backgroundColor: '#0a0a0a', border: '1px solid #333', borderRadius: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5, borderBottom: '1px solid #222' }}>
        <Typography variant="caption" sx={{ color: '#888', fontWeight: 'bold', fontSize: '10px' }}>
          VGA Output
        </Typography>
        <Chip label={`${ioWriteCount} writes`} size="small" sx={{ fontSize: '9px', height: 18 }} />
        {ioWriteCount > 0 && (
          <>
            <Chip label={`${displayWidth}×${displayHeight}`} size="small" sx={{ fontSize: '9px', height: 18 }} />
            <Chip label={`${totalPixels} px`} size="small" sx={{ fontSize: '9px', height: 18 }} />
          </>
        )}
        {!resolution.hasSyncSignals && ioWriteCount > 0 && (
          <>
            <Typography variant="caption" sx={{ color: '#555', fontSize: '9px' }}>W:</Typography>
            <TextField
              type="number" size="small" value={manualWidth}
              onChange={(e) => setManualWidth(Math.max(1, parseInt(e.target.value) || 4))}
              slotProps={{ htmlInput: { min: 1, max: 640 } }}
              sx={{ width: 48, '& input': { fontSize: '10px', py: 0.25, px: 0.5, color: '#ccc' }, '& fieldset': { borderColor: '#444' } }}
            />
          </>
        )}
        {ioWriteCount > 0 && (
          <>
            <Typography variant="caption" sx={{ color: '#555', fontSize: '9px' }}>Scale:</Typography>
            <TextField
              type="number" size="small" value={pixelScale || ''} placeholder="auto"
              onChange={(e) => setPixelScale(Math.max(0, Math.min(32, parseInt(e.target.value) || 0)))}
              slotProps={{ htmlInput: { min: 0, max: 32 } }}
              sx={{ width: 48, '& input': { fontSize: '10px', py: 0.25, px: 0.5, color: '#ccc' }, '& fieldset': { borderColor: '#444' } }}
            />
          </>
        )}
      </Box>
      {ioWriteCount > 0 ? (
        <Box sx={{ overflow: 'auto', maxHeight: 520, p: 0.5 }}>
          <canvas
            ref={canvasRef}
            width={canvasWidth}
            height={canvasHeight}
            style={{ display: 'block', backgroundColor: '#000', imageRendering: 'pixelated' }}
          />
        </Box>
      ) : (
        <Box sx={{ p: 1 }}>
          <Typography variant="caption" sx={{ color: '#555', fontSize: '10px' }}>
            No IO writes yet. Compile and run a program that writes to the IO port.
          </Typography>
        </Box>
      )}
    </Box>
  );
};
