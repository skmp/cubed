import React from 'react';
import { Box, Tabs, Tab } from '@mui/material';
import ViewInArIcon from '@mui/icons-material/ViewInAr';
import EditIcon from '@mui/icons-material/Edit';
import CodeIcon from '@mui/icons-material/Code';
import MemoryIcon from '@mui/icons-material/Memory';
import OutputIcon from '@mui/icons-material/Terminal';

interface MainLayoutProps {
  toolbar: React.ReactNode;
  wysiwygTab: React.ReactNode;
  editorTab: React.ReactNode;
  arrayforthTab: React.ReactNode;
  emulatorTab: React.ReactNode;
  outputTab: React.ReactNode;
  activeTab: number;
  onTabChange: (tab: number) => void;
}

export const MainLayout: React.FC<MainLayoutProps> = ({
  toolbar, wysiwygTab, editorTab, arrayforthTab, emulatorTab, outputTab, activeTab, onTabChange,
}) => {
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

      {/* Tab bar */}
      <Box sx={{
        borderBottom: '1px solid #333',
        backgroundColor: '#1a1a1a',
        flexShrink: 0,
      }}>
        <Tabs
          value={activeTab}
          onChange={(_, v) => onTabChange(v)}
          sx={{
            minHeight: 32,
            '& .MuiTab-root': {
              minHeight: 32,
              py: 0,
              fontSize: '12px',
              textTransform: 'none',
            },
          }}
        >
          <Tab icon={<ViewInArIcon sx={{ fontSize: 14 }} />} iconPosition="start" label="3D Editor" />
          <Tab icon={<EditIcon sx={{ fontSize: 14 }} />} iconPosition="start" label="Editor" />
          <Tab icon={<CodeIcon sx={{ fontSize: 14 }} />} iconPosition="start" label="arrayForth" />
          <Tab icon={<MemoryIcon sx={{ fontSize: 14 }} />} iconPosition="start" label="Emulator" />
          <Tab icon={<OutputIcon sx={{ fontSize: 14 }} />} iconPosition="start" label="Output" />
        </Tabs>
      </Box>

      {/* Tab content */}
      <Box sx={{ flex: 1, overflow: 'hidden' }}>
        <Box sx={{ display: activeTab === 0 ? 'flex' : 'none', height: '100%' }}>
          {wysiwygTab}
        </Box>
        <Box sx={{ display: activeTab === 1 ? 'flex' : 'none', height: '100%' }}>
          {editorTab}
        </Box>
        <Box sx={{ display: activeTab === 2 ? 'flex' : 'none', height: '100%' }}>
          {arrayforthTab}
        </Box>
        <Box sx={{ display: activeTab === 3 ? 'flex' : 'none', height: '100%' }}>
          {emulatorTab}
        </Box>
        <Box sx={{ display: activeTab === 4 ? 'flex' : 'none', height: '100%' }}>
          {outputTab}
        </Box>
      </Box>
    </Box>
  );
};
