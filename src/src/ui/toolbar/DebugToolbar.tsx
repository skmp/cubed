import React from 'react';
import {
  Box, Button, Chip, ToggleButtonGroup, ToggleButton,
} from '@mui/material';
import BuildIcon from '@mui/icons-material/Build';
import type { EditorLanguage } from '../editor/CodeEditor';

interface DebugToolbarProps {
  activeCount: number;
  totalSteps: number;
  language: EditorLanguage;
  onCompile: () => void;
  onSetLanguage: (lang: EditorLanguage) => void;
}

export const DebugToolbar: React.FC<DebugToolbarProps> = ({
  activeCount, totalSteps, language,
  onCompile, onSetLanguage,
}) => {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, height: 40 }}>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={language}
        onChange={(_, val) => { if (val) onSetLanguage(val); }}
        sx={{ height: 26 }}
      >
        <ToggleButton value="arrayforth" sx={{ textTransform: 'none', fontSize: '10px', px: 1 }}>
          arrayForth
        </ToggleButton>
        <ToggleButton value="recurse" sx={{ textTransform: 'none', fontSize: '10px', px: 1 }}>
          Recurse
        </ToggleButton>
        <ToggleButton value="cube" sx={{ textTransform: 'none', fontSize: '10px', px: 1 }}>
          CUBE
        </ToggleButton>
      </ToggleButtonGroup>

      <Button
        size="small"
        variant="contained"
        color="success"
        startIcon={<BuildIcon />}
        onClick={onCompile}
        sx={{ textTransform: 'none', fontSize: '11px' }}
      >
        Compile
      </Button>

      <Box sx={{ ml: 'auto', display: 'flex', gap: 1 }}>
        <Chip
          size="small"
          label={`Active: ${activeCount}/144`}
          sx={{ fontSize: '10px', height: 20 }}
        />
        <Chip
          size="small"
          label={`Steps: ${totalSteps}`}
          variant="outlined"
          sx={{ fontSize: '10px', height: 20 }}
        />
      </Box>
    </Box>
  );
};
