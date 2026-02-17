import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { Box, Typography, IconButton } from '@mui/material';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import type { CubeProgram } from '../../core/cube/ast';
import { layoutAST, filterSceneGraph } from './layoutEngine';
import type { SceneNode, PipeInfo } from './layoutEngine';
import { CubeScene } from './CubeScene';
import { sceneGraphToSVG } from './svgExport';

interface CubeRendererProps {
  ast: CubeProgram | null;
}

export function CubeRenderer({ ast }: CubeRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoveredPipeId, setHoveredPipeId] = useState<string | null>(null);
  const [focusStack, setFocusStack] = useState<string[]>([]);

  const fullSceneGraph = useMemo(() => {
    if (!ast) return { nodes: [], pipes: [] };
    return layoutAST(ast);
  }, [ast]);

  const focusStackSafe = useMemo(() => {
    if (focusStack.length === 0) return focusStack;
    const ids = new Set(fullSceneGraph.nodes.map(n => n.id));
    return focusStack.filter(id => ids.has(id));
  }, [focusStack, fullSceneGraph]);

  const focusId = focusStackSafe.length > 0 ? focusStackSafe[focusStackSafe.length - 1] : null;

  // Apply focus filtering
  const sceneGraph = useMemo(() => {
    if (!focusId) return fullSceneGraph;
    return filterSceneGraph(fullSceneGraph, focusId);
  }, [fullSceneGraph, focusId]);

  const focusedLabel = useMemo(() => {
    if (!focusId) return null;
    const node = fullSceneGraph.nodes.find(n => n.id === focusId);
    return node?.label ?? focusId;
  }, [fullSceneGraph, focusId]);

  const safeSelectedId = selectedId && fullSceneGraph.nodes.some(n => n.id === selectedId) ? selectedId : null;
  const safeHoveredId = hoveredId && fullSceneGraph.nodes.some(n => n.id === hoveredId) ? hoveredId : null;

  const hoveredNode: SceneNode | undefined = safeHoveredId
    ? sceneGraph.nodes.find(n => n.id === safeHoveredId)
    : undefined;

  const hoveredPipe: PipeInfo | undefined = hoveredPipeId
    ? sceneGraph.pipes.find(p => p.id === hoveredPipeId)
    : undefined;

  // Node IDs highlighted via pipe hover (the two endpoints)
  const pipeHighlightIds = useMemo(() => {
    if (!hoveredPipe) return new Set<string>();
    const ids = new Set<string>();
    if (hoveredPipe.fromNodeId) ids.add(hoveredPipe.fromNodeId);
    if (hoveredPipe.toNodeId) ids.add(hoveredPipe.toNodeId);
    return ids;
  }, [hoveredPipe]);

  const cameraResetKey = useMemo(() => {
    const key = `${focusId ?? 'root'}:${fullSceneGraph.nodes.length}:${fullSceneGraph.pipes.length}`;
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) | 0;
    }
    return hash;
  }, [focusId, fullSceneGraph.nodes.length, fullSceneGraph.pipes.length]);

  const handleDoubleClick = useCallback((id: string) => {
    // Check if the node has children in the full scene graph
    const hasChildren = fullSceneGraph.nodes.some(n => n.parentId === id);
    if (hasChildren) {
      setFocusStack(prev => {
        const ids = new Set(fullSceneGraph.nodes.map(n => n.id));
        const cleaned = prev.filter(p => ids.has(p));
        return [...cleaned, id];
      });
      setSelectedId(null);
      setHoveredId(null);
    }
  }, [fullSceneGraph]);

  const handleBack = useCallback(() => {
    setFocusStack(prev => {
      const ids = new Set(fullSceneGraph.nodes.map(n => n.id));
      const cleaned = prev.filter(p => ids.has(p));
      return cleaned.slice(0, -1);
    });
    setSelectedId(null);
    setHoveredId(null);
  }, [fullSceneGraph]);

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

  const svgContent = useMemo(() => sceneGraphToSVG(sceneGraph), [sceneGraph]);

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
    <Box ref={containerRef} sx={{ height: '100%', position: 'relative', bgcolor: '#121212', display: 'flex', flexDirection: 'column' }}>
      {/* SVG isometric view */}
      {svgContent && (
        <Box
          sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}
          dangerouslySetInnerHTML={{ __html: svgContent }}
        />
      )}
      <Canvas
        camera={{ position: [6, 4, 6], fov: 50 }}
        style={{ background: '#121212' }}
      >
        <CubeScene
          sceneGraph={sceneGraph}
          selectedId={safeSelectedId}
          hoveredId={safeHoveredId}
          onHover={setHoveredId}
          onClick={setSelectedId}
          onDoubleClick={handleDoubleClick}
          resetKey={cameraResetKey}
          hoveredPipeId={hoveredPipeId}
          onPipeHover={setHoveredPipeId}
          pipeHighlightIds={pipeHighlightIds}
        />
      </Canvas>

      {/* Focus breadcrumb / back button */}
      {focusStackSafe.length > 0 && (
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
      {(hoveredNode || hoveredPipe) && (
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
          {hoveredNode && (
            <>
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
            </>
          )}
          {hoveredPipe && !hoveredNode && (() => {
            const fromNode = hoveredPipe.fromNodeId ? sceneGraph.nodes.find(n => n.id === hoveredPipe.fromNodeId) : undefined;
            const toNode = hoveredPipe.toNodeId ? sceneGraph.nodes.find(n => n.id === hoveredPipe.toNodeId) : undefined;
            return (
              <>
                <Typography variant="caption" sx={{ color: '#999', fontSize: '9px' }}>
                  pipe
                </Typography>
                <Typography variant="body2" sx={{ fontSize: '12px', fontWeight: 'bold' }}>
                  {fromNode?.label ?? '?'} → {toNode?.label ?? '?'}
                </Typography>
              </>
            );
          })()}
        </Box>
      )}
    </Box>
  );
}
