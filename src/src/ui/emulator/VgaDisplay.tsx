import React, { useRef, useEffect, useState } from 'react';
import { Box, Chip, TextField, Typography } from '@mui/material';

// ---- Constants ----

const HSYNC_BIT = 0x20000;
const VSYNC_BIT = 0x10000;
const COLOR_MASK = 0x1FF;

const NOISE_W = 640;
const NOISE_H = 480;

// ---- Precomputed DAC → RGBA lookup (512 entries × 4 bytes) ----

const DAC_LUT = new Uint8Array(512 * 4);
for (let i = 0; i < 512; i++) {
  DAC_LUT[i * 4]     = ((i >> 6) & 0x7) * 255 / 7 | 0;
  DAC_LUT[i * 4 + 1] = ((i >> 3) & 0x7) * 255 / 7 | 0;
  DAC_LUT[i * 4 + 2] = (i & 0x7) * 255 / 7 | 0;
  DAC_LUT[i * 4 + 3] = 255;
}

// ---- Shaders ----

const VERT_SRC = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - (a_pos.y + 1.0) * 0.5);
}`;

const FRAG_SRC = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
void main() {
  gl_FragColor = texture2D(u_tex, v_uv);
}`;

// ---- Types ----

interface VgaDisplayProps {
  ioWrites: number[];
  ioWriteCount: number;
}

interface Resolution {
  width: number;
  height: number;
  hasSyncSignals: boolean;
}

interface GlState {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  texture: WebGLTexture;
}

// ---- Resolution detection ----

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

// ---- WebGL helpers ----

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}

function initWebGL(canvas: HTMLCanvasElement): GlState | null {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false });
  if (!gl) return null;

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vs || !fs) return null;

  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.useProgram(program);

  // Fullscreen quad
  const vbo = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  // Texture
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return { gl, program, texture };
}

function fillNoise(data: Uint8Array) {
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = (Math.random() * 256) | 0;
    data[i + 1] = (Math.random() * 256) | 0;
    data[i + 2] = (Math.random() * 256) | 0;
    data[i + 3] = 255;
  }
}


// ---- Component ----

export const VgaDisplay: React.FC<VgaDisplayProps> = ({ ioWrites, ioWriteCount }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glStateRef = useRef<GlState | null>(null);
  const texDataRef = useRef<Uint8Array>(new Uint8Array(0));
  const texWRef = useRef(0);
  const texHRef = useRef(0);
  const lastDrawnRef = useRef(0);
  const cursorRef = useRef({ x: 0, y: 0 });
  const cachedResRef = useRef<Resolution | null>(null);
  const dirtyRef = useRef(true);
  const rafRef = useRef(0);
  const [pixelScale, setPixelScale] = useState(0);
  const [manualWidth, setManualWidth] = useState(4);

  // ---- Resolution (cached after first complete frame) ----

  if (ioWriteCount < lastDrawnRef.current) cachedResRef.current = null;

  let resolution: Resolution;
  if (cachedResRef.current) {
    resolution = cachedResRef.current;
  } else {
    const det = detectResolution(ioWrites, ioWriteCount);
    if (det.complete) cachedResRef.current = det;
    resolution = det;
  }

  const displayWidth = resolution.hasSyncSignals ? resolution.width : (ioWriteCount > 0 ? manualWidth : NOISE_W);
  const displayHeight = resolution.hasSyncSignals
    ? resolution.height
    : (ioWriteCount > 0 ? Math.max(1, Math.ceil(ioWriteCount / manualWidth)) : NOISE_H);

  const effectiveScale = pixelScale > 0 ? pixelScale
    : displayWidth >= 320 ? 1 : displayWidth >= 64 ? 4 : 12;

  const canvasWidth = displayWidth * effectiveScale;
  const canvasHeight = displayHeight * effectiveScale;

  // ---- WebGL init + noise + RAF loop ----

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const state = initWebGL(canvas);
    if (!state) return;
    glStateRef.current = state;

    // Initial noise texture
    const data = new Uint8Array(NOISE_W * NOISE_H * 4);
    fillNoise(data);
    texDataRef.current = data;
    texWRef.current = NOISE_W;
    texHRef.current = NOISE_H;

    canvas.width = NOISE_W;
    canvas.height = NOISE_H;

    const { gl, texture } = state;
    gl.viewport(0, 0, NOISE_W, NOISE_H);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, NOISE_W, NOISE_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    dirtyRef.current = false;

    // RAF loop
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      if (!dirtyRef.current || !glStateRef.current) return;
      dirtyRef.current = false;

      const { gl: g, texture: tex } = glStateRef.current;
      const w = texWRef.current;
      const h = texHRef.current;

      const c = canvasRef.current;
      if (c && (c.width !== w || c.height !== h)) {
        c.width = w;
        c.height = h;
        g.viewport(0, 0, w, h);
      }

      g.bindTexture(g.TEXTURE_2D, tex);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, texDataRef.current);
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      gl.deleteTexture(texture);
      gl.deleteProgram(state.program);
    };
  }, []);

  // ---- Incremental pixel updates ----

  useEffect(() => {
    if (!glStateRef.current || ioWriteCount === 0) return;

    const hasSyncSignals = resolution.hasSyncSignals;
    // Write into existing texture — only reallocate when locked resolution differs
    const texW = texWRef.current;
    const texH = texHRef.current;
    const texData = texDataRef.current;
    const cursor = cursorRef.current;

    // Buffer was trimmed/reset — just reset cursor, keep existing texture content (noise bleeds through)
    const needsFullRedraw = ioWriteCount < lastDrawnRef.current;
    let startIdx: number;
    if (needsFullRedraw) {
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
      if (cursor.y < texH && cursor.x < texW) {
        const lutOff = (val & COLOR_MASK) * 4;
        const texOff = (cursor.y * texW + cursor.x) * 4;
        texData[texOff]     = DAC_LUT[lutOff];
        texData[texOff + 1] = DAC_LUT[lutOff + 1];
        texData[texOff + 2] = DAC_LUT[lutOff + 2];
        texData[texOff + 3] = 255;
      }
      cursor.x++;
      if (!hasSyncSignals && cursor.x >= texW) { cursor.x = 0; cursor.y++; }
    }

    lastDrawnRef.current = ioWriteCount;
    dirtyRef.current = true;
  }, [ioWriteCount, resolution.hasSyncSignals, ioWrites]);

  // Force full redraw when user changes scale/width settings
  useEffect(() => {
    lastDrawnRef.current = 0;
    dirtyRef.current = true;
  }, [effectiveScale, manualWidth]);

  // ---- Render ----

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
            width: canvasWidth,
            height: canvasHeight,
            imageRendering: 'pixelated',
          }}
        />
      </Box>
    </Box>
  );
};
