import React, { useRef, useEffect, useState } from 'react';
import { Box, Chip, TextField, Typography } from '@mui/material';

const HSYNC_BIT = 0x20000;
const VSYNC_BIT = 0x10000;
const COLOR_MASK = 0x1FF;

interface VgaDisplayProps {
  ioWrites: number[];
  ioWriteCount: number;
}

interface Resolution {
  width: number;
  height: number;
  hasSyncSignals: boolean;
}

function dacToRgb(value: number): string {
  const r = ((value >> 6) & 0x7) * 255 / 7 | 0;
  const g = ((value >> 3) & 0x7) * 255 / 7 | 0;
  const b = (value & 0x7) * 255 / 7 | 0;
  return `rgb(${r},${g},${b})`;
}

/** Scan for the first complete frame (VSYNC→lines→VSYNC) and return its dimensions. */
function detectResolution(ioWrites: number[], count: number): Resolution & { complete: boolean } {
  let x = 0, maxX = 0, y = 0;
  let hasSyncSignals = false;
  let frameStarted = false;
  for (let i = 0; i < count; i++) {
    const val = ioWrites[i];
    if (val & VSYNC_BIT) {
      hasSyncSignals = true;
      if (frameStarted && maxX > 0) {
        return { width: maxX, height: Math.max(y, 1), hasSyncSignals: true, complete: true };
      }
      frameStarted = true;
      y = 0; x = 0;
    } else if (val & HSYNC_BIT) {
      hasSyncSignals = true;
      if (x > maxX) maxX = x;
      y++; x = 0;
    } else { x++; }
  }
  if (x > maxX) maxX = x;
  return { width: maxX || 1, height: Math.max(y + (x > 0 ? 1 : 0), 1), hasSyncSignals, complete: false };
}

const NOISE_W = 640;
const NOISE_H = 480;

function drawNoise(canvas: HTMLCanvasElement) {
  canvas.width = NOISE_W;
  canvas.height = NOISE_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(NOISE_W, NOISE_H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (Math.random() * 256) | 0;
    d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

export const VgaDisplay: React.FC<VgaDisplayProps> = ({ ioWrites, ioWriteCount }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastDrawnRef = useRef(0);
  const cursorRef = useRef({ x: 0, y: 0 });
  const noiseDrawnRef = useRef(false);
  const cachedResRef = useRef<Resolution | null>(null);
  const [pixelScale, setPixelScale] = useState(0);
  const [manualWidth, setManualWidth] = useState(4);

  // Resolve resolution — cache once a complete frame is detected
  if (ioWriteCount < lastDrawnRef.current) {
    // Buffer was reset
    cachedResRef.current = null;
  }
  let resolution: Resolution;
  if (cachedResRef.current) {
    resolution = cachedResRef.current;
  } else {
    const det = detectResolution(ioWrites, ioWriteCount);
    if (det.complete) cachedResRef.current = det;
    resolution = det;
  }

  const displayWidth = resolution.hasSyncSignals ? resolution.width : manualWidth;
  const displayHeight = resolution.hasSyncSignals
    ? resolution.height
    : Math.max(1, Math.ceil(ioWriteCount / manualWidth));

  const effectiveScale = pixelScale > 0 ? pixelScale
    : displayWidth >= 320 ? 1 : displayWidth >= 64 ? 4 : 12;

  const canvasWidth = displayWidth * effectiveScale;
  const canvasHeight = displayHeight * effectiveScale;

  // Draw noise when there's nothing to show
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || ioWriteCount > 0) return;
    if (!noiseDrawnRef.current) {
      drawNoise(canvas);
      noiseDrawnRef.current = true;
    }
  }, [ioWriteCount]);

  // Draw effect — incremental by default, full redraw when dimensions change or buffer resets
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || ioWriteCount === 0) return;
    noiseDrawnRef.current = false;

    const scale = effectiveScale;
    const hasSyncSignals = resolution.hasSyncSignals;
    const w = displayWidth;

    // Only resize canvas when dimensions actually grow — avoids clearing
    const needsResize = canvas.width < canvasWidth || canvas.height < canvasHeight;
    const needsFullRedraw =
      needsResize ||
      ioWriteCount < lastDrawnRef.current; // buffer was reset

    if (needsResize) {
      canvas.width = Math.max(canvas.width, canvasWidth);
      canvas.height = Math.max(canvas.height, canvasHeight);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let startIdx: number;
    const cursor = cursorRef.current;

    if (needsFullRedraw) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      cursor.x = 0;
      cursor.y = 0;
      startIdx = 0;
    } else {
      startIdx = lastDrawnRef.current;
    }

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

  // Force full redraw when user changes scale/width settings
  useEffect(() => {
    lastDrawnRef.current = 0;
  }, [effectiveScale, manualWidth]);

  return (
    <Box sx={{ backgroundColor: '#0a0a0a', border: '1px solid #333', borderRadius: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5, borderBottom: '1px solid #222' }}>
        <Typography variant="caption" sx={{ color: '#888', fontWeight: 'bold', fontSize: '10px' }}>
          VGA Output
        </Typography>
        <Chip label={`${ioWriteCount} writes`} size="small" sx={{ fontSize: '9px', height: 18 }} />
        {ioWriteCount > 0 && (
          <Chip label={`${displayWidth}×${displayHeight}`} size="small" sx={{ fontSize: '9px', height: 18 }} />
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
      <Box sx={{ overflow: 'auto', maxHeight: 520, p: 0.5 }}>
        <canvas
          ref={canvasRef}
          style={{
            display: 'block',
            width: ioWriteCount > 0 ? canvasWidth : NOISE_W,
            height: ioWriteCount > 0 ? canvasHeight : NOISE_H,
            backgroundColor: '#000',
            imageRendering: 'pixelated',
          }}
        />
      </Box>
    </Box>
  );
};
