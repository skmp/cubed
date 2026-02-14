import { useState, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { Box, Typography } from '@mui/material';
import type { CubeProgram } from '../../core/cube/ast';
import { layoutAST } from './layoutEngine';
import type { SceneNode } from './layoutEngine';
import { CubeScene } from './CubeScene';

interface CubeRendererProps {
  ast: CubeProgram | null;
}

export function CubeRenderer({ ast }: CubeRendererProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const sceneGraph = useMemo(() => {
    if (!ast) return { nodes: [], pipes: [] };
    const sg = layoutAST(ast);
    console.log('[CubeRenderer] layoutAST produced', sg.nodes.length, 'nodes,', sg.pipes.length, 'pipes');
    return sg;
  }, [ast]);

  const hoveredNode: SceneNode | undefined = hoveredId
    ? sceneGraph.nodes.find(n => n.id === hoveredId)
    : undefined;

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
    <Box sx={{ height: '100%', position: 'relative', bgcolor: '#121212' }}>
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
        />
      </Canvas>

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
