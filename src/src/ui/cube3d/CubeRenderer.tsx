import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { Box, Typography, IconButton } from '@mui/material';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import type { CubeProgram } from '../../core/cube/ast';
import { layoutAST, filterSceneGraph } from './layoutEngine';
import type { SceneNode } from './layoutEngine';
import { CubeScene } from './CubeScene';

interface CubeRendererProps {
  ast: CubeProgram | null;
}

export function CubeRenderer({ ast }: CubeRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusStack, setFocusStack] = useState<string[]>([]);

  // Reset focus when AST changes (new compilation)
  useEffect(() => {
    setFocusStack([]);
    setSelectedId(null);
    setHoveredId(null);
    setCameraResetKey(k => k + 1);
  }, [ast]);

  const fullSceneGraph = useMemo(() => {
    if (!ast) return { nodes: [], pipes: [] };
    return layoutAST(ast);
  }, [ast]);

  // Apply focus filtering
  const sceneGraph = useMemo(() => {
    if (focusStack.length === 0) return fullSceneGraph;
    const focusId = focusStack[focusStack.length - 1];
    return filterSceneGraph(fullSceneGraph, focusId);
  }, [fullSceneGraph, focusStack]);

  const focusedLabel = useMemo(() => {
    if (focusStack.length === 0) return null;
    const focusId = focusStack[focusStack.length - 1];
    const node = fullSceneGraph.nodes.find(n => n.id === focusId);
    return node?.label ?? focusId;
  }, [fullSceneGraph, focusStack]);

  const hoveredNode: SceneNode | undefined = hoveredId
    ? sceneGraph.nodes.find(n => n.id === hoveredId)
    : undefined;

  // Incremented to trigger camera reset on focus change
  const [cameraResetKey, setCameraResetKey] = useState(0);

  const handleDoubleClick = useCallback((id: string) => {
    // Check if the node has children in the full scene graph
    const hasChildren = fullSceneGraph.nodes.some(n => n.parentId === id);
    if (hasChildren) {
      setFocusStack(prev => [...prev, id]);
      setSelectedId(null);
      setHoveredId(null);
      setCameraResetKey(k => k + 1);
    }
  }, [fullSceneGraph]);

  const handleBack = useCallback(() => {
    setFocusStack(prev => prev.slice(0, -1));
    setSelectedId(null);
    setHoveredId(null);
    setCameraResetKey(k => k + 1);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      containerRef.current.requestFullscreen();
    }
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  if (!ast) {
    return (
      <Box sx={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#666',
      }}>
        <Typography variant="body2">
          Compile a CUBE program to see the 3D view
        </Typography>
      </Box>
    );
  }

  return (
    <Box ref={containerRef} sx={{ height: '100%', position: 'relative', bgcolor: '#121212' }}>
      <Canvas
        camera={{ position: [6, 4, 6], fov: 50 }}
        style={{ background: '#121212' }}
      >
        <CubeScene
          sceneGraph={sceneGraph}
          selectedId={selectedId}
          hoveredId={hoveredId}
          onHover={setHoveredId}
          onClick={setSelectedId}
          onDoubleClick={handleDoubleClick}
          resetKey={cameraResetKey}
        />
      </Canvas>

      {/* Focus breadcrumb / back button */}
      {focusStack.length > 0 && (
        <Box sx={{
          position: 'absolute',
          top: 8,
          right: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          bgcolor: 'rgba(0,0,0,0.85)',
          color: '#fff',
          px: 1.5,
          py: 0.5,
          borderRadius: 1,
          border: '1px solid #555',
        }}>
          <IconButton
            size="small"
            onClick={handleBack}
            sx={{ color: '#aaa', p: 0.5, '&:hover': { color: '#fff' } }}
          >
            <Typography sx={{ fontSize: '14px', lineHeight: 1 }}>{'<'}</Typography>
          </IconButton>
          <Typography variant="caption" sx={{ color: '#88ff88', fontSize: '11px' }}>
            {focusedLabel}
          </Typography>
          <Typography variant="caption" sx={{ color: '#666', fontSize: '9px', ml: 0.5 }}>
            (dbl-click to drill, {'<'} to go back)
          </Typography>
        </Box>
      )}

      {/* Fullscreen toggle */}
      <IconButton
        size="small"
        onClick={toggleFullscreen}
        sx={{
          position: 'absolute',
          bottom: 8,
          right: 8,
          color: '#aaa',
          bgcolor: 'rgba(0,0,0,0.6)',
          '&:hover': { color: '#fff', bgcolor: 'rgba(0,0,0,0.85)' },
        }}
      >
        {isFullscreen ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
      </IconButton>

      {/* Tooltip overlay */}
      {hoveredNode && (
        <Box sx={{
          position: 'absolute',
          top: 8,
          left: 8,
          bgcolor: 'rgba(0,0,0,0.8)',
          color: '#fff',
          px: 1.5,
          py: 0.5,
          borderRadius: 1,
          fontSize: '11px',
          pointerEvents: 'none',
          border: '1px solid #444',
        }}>
          <Typography variant="caption" sx={{ color: '#999', fontSize: '9px' }}>
            {hoveredNode.type}
          </Typography>
          <Typography variant="body2" sx={{ fontSize: '12px', fontWeight: 'bold' }}>
            {hoveredNode.label}
          </Typography>
          {hoveredNode.ports.length > 0 && (
            <Typography variant="caption" sx={{ color: '#888', fontSize: '9px' }}>
              ports: {hoveredNode.ports.map(p => p.name).join(', ')}
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
}
