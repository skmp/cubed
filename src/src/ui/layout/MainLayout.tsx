import React from 'react';
import { Box } from '@mui/material';

interface MainLayoutProps {
  toolbar: React.ReactNode;
  chipGrid: React.ReactNode;
  cubeRenderer?: React.ReactNode;
  editor: React.ReactNode;
  detailPanel: React.ReactNode;
}

export const MainLayout: React.FC<MainLayoutProps> = ({ toolbar, chipGrid, cubeRenderer, editor, detailPanel }) => {
  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <Box sx={{
        borderBottom: '1px solid #333',
        backgroundColor: '#1a1a1a',
        flexShrink: 0,
      }}>
        {toolbar}
      </Box>

      {/* Main content */}
      <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left: Chip grid or CUBE 3D renderer */}
        <Box sx={{
          width: 510,
          flexShrink: 0,
          overflow: cubeRenderer ? 'hidden' : 'auto',
          borderRight: '1px solid #333',
          p: cubeRenderer ? 0 : 1,
        }}>
          {cubeRenderer ?? chipGrid}
        </Box>

        {/* Center: Code editor */}
        <Box sx={{ flex: 1, overflow: 'hidden' }}>
          {editor}
        </Box>

        {/* Right: Detail panel */}
        <Box sx={{
          width: 380,
          flexShrink: 0,
          overflow: 'auto',
          borderLeft: '1px solid #333',
        }}>
          {detailPanel}
        </Box>
      </Box>
    </Box>
  );
};
