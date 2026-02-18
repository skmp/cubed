import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { Box, Chip, TextField, Typography, Button } from '@mui/material';
import {
  detectResolution,
  type Resolution,
} from './vgaResolution';
import {
  renderIoWrites,
  fillNoise,
  type VgaRenderState,
} from './vgaRenderer';

// ---- Constants ----

const NOISE_W = 640;
const NOISE_H = 480;

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
  ioWriteTimestamps: number[];
  ioWriteCount: number;
  ioWriteStart: number;
  ioWriteSeq: number;
}

interface GlState {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  texture: WebGLTexture;
  vbo: WebGLBuffer;
}

// ---- WebGL helpers ----

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function initWebGL(canvas: HTMLCanvasElement): GlState | null {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: true });
  if (!gl) return null;

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vs || !fs) return null;

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return null;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return null;
  }
  gl.useProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  // Fullscreen quad
  const vbo = gl.createBuffer();
  if (!vbo) {
    gl.deleteProgram(program);
    return null;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, 'a_pos');
  if (posLoc === -1) {
    gl.deleteBuffer(vbo);
    gl.deleteProgram(program);
    return null;
  }
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  // Texture
  const texture = gl.createTexture();
  if (!texture) {
    gl.deleteBuffer(vbo);
    gl.deleteProgram(program);
    return null;
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return { gl, program, texture, vbo };
}

// ---- Component ----

export const VgaDisplay: React.FC<VgaDisplayProps> = ({ ioWrites, ioWriteTimestamps, ioWriteCount, ioWriteStart, ioWriteSeq }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glStateRef = useRef<GlState | null>(null);
  const texDataRef = useRef<Uint8Array>(new Uint8Array(0));
  const texWRef = useRef(0);
  const texHRef = useRef(0);
  const renderStateRef = useRef<VgaRenderState>({ cursor: { x: 0, y: 0 }, hasReceivedSignal: false, lastDrawnSeq: 0, forceFullRedraw: false, lastHasSyncSignals: null });
  const dirtyRef = useRef(true);
  const rafRef = useRef(0);
  const [pixelScale, setPixelScale] = useState(0);
  const [manualWidth, setManualWidth] = useState(4);
  const [lastDrawnSeqSnapshot, setLastDrawnSeqSnapshot] = useState(0);
  const [cachedRes, setCachedRes] = useState<Resolution | null>(null);

  const handleExport = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vga-frame-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }, []);

  // ---- Resolution (cached after first complete frame) ----

  const ioWriteStartSeq = ioWriteSeq - ioWriteCount;
  const streamReset = ioWriteSeq < lastDrawnSeqSnapshot;
  const dataDropped = lastDrawnSeqSnapshot < ioWriteStartSeq;
  const needsResReset = streamReset || dataDropped;
  const resolution = useMemo<Resolution & { complete: boolean }>(() => {
    if (needsResReset) {
      return detectResolution(ioWrites, ioWriteCount, ioWriteStart, ioWriteTimestamps);
    }
    if (cachedRes) {
      return { ...cachedRes, complete: true };
    }
    return detectResolution(ioWrites, ioWriteCount, ioWriteStart, ioWriteTimestamps);
  }, [ioWrites, ioWriteCount, ioWriteStart, ioWriteTimestamps, needsResReset, cachedRes]);

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

    const cleanupState = (state: GlState | null) => {
      if (!state) return;
      state.gl.deleteTexture(state.texture);
      state.gl.deleteBuffer(state.vbo);
      state.gl.deleteProgram(state.program);
    };

    const initState = (): GlState | null => {
      const state = initWebGL(canvas);
      if (!state) return null;
      glStateRef.current = state;

      const w = texWRef.current || NOISE_W;
      const h = texHRef.current || NOISE_H;
      let data = texDataRef.current;
      if (data.length !== w * h * 4) {
        data = new Uint8Array(NOISE_W * NOISE_H * 4);
        fillNoise(data);
        texDataRef.current = data;
        texWRef.current = NOISE_W;
        texHRef.current = NOISE_H;
      }

      canvas.width = texWRef.current;
      canvas.height = texHRef.current;

      const { gl, texture } = state;
      gl.viewport(0, 0, texWRef.current, texHRef.current);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, texWRef.current, texHRef.current, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      dirtyRef.current = false;

      return state;
    };

    const handleContextLost = (e: Event) => {
      e.preventDefault();
      glStateRef.current = null;
    };

    const handleContextRestored = () => {
      cleanupState(glStateRef.current);
      const state = initState();
      if (state) dirtyRef.current = true;
    };

    canvas.addEventListener('webglcontextlost', handleContextLost, false);
    canvas.addEventListener('webglcontextrestored', handleContextRestored, false);

    const state = initState();
    if (!state) {
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      return;
    }

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
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      cleanupState(glStateRef.current ?? state);
      glStateRef.current = null;
    };
  }, []);

  // ---- Incremental pixel updates ----
  // Delegates to the pure renderIoWrites() function for testability.

  useEffect(() => {
    if (!glStateRef.current || ioWriteCount === 0) return;

    const dirty = renderIoWrites(
      renderStateRef.current,
      texDataRef.current,
      texWRef.current,
      texHRef.current,
      ioWrites,
      ioWriteCount,
      ioWriteStart,
      ioWriteSeq,
      resolution.hasSyncSignals,
      ioWriteTimestamps,
    );
    if (dirty) dirtyRef.current = true;
    // Sync lastDrawnSeq to state for resolution reset detection
    setLastDrawnSeqSnapshot(renderStateRef.current.lastDrawnSeq);
    // Cache resolution after first complete detection
    if (!cachedRes && resolution.complete) {
      setCachedRes({ width: resolution.width, height: resolution.height, hasSyncSignals: resolution.hasSyncSignals });
    }
    if (needsResReset && cachedRes) {
      setCachedRes(null);
    }
  }, [ioWriteCount, ioWriteSeq, ioWriteStart, resolution, ioWrites, ioWriteTimestamps, cachedRes, needsResReset]);

  // Force full redraw when user changes scale/width settings
  useEffect(() => {
    const rs = renderStateRef.current;
    rs.forceFullRedraw = true;
    rs.cursor.x = 0;
    rs.cursor.y = 0;
    rs.lastDrawnSeq = 0;
    rs.hasReceivedSignal = false;
    rs.pendingR = 0; rs.pendingG = 0; rs.pendingB = 0;
    rs.channelRowR = 0; rs.channelRowG = 0; rs.channelRowB = 0;
    rs.channelEmitted = 0;
    fillNoise(texDataRef.current);
    dirtyRef.current = true;
    // Reset resolution tracking state — necessary to sync with ref reset above
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLastDrawnSeqSnapshot(0);
    setCachedRes(null);
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
        <Button
          size="small"
          variant="outlined"
          onClick={handleExport}
          disabled={ioWriteCount === 0}
          sx={{ ml: 'auto', textTransform: 'none', fontSize: '10px', height: 22, minWidth: 0, px: 1 }}
          aria-label="Export VGA frame as PNG"
        >
          Export PNG
        </Button>
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
