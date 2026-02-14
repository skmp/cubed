import React from 'react';
import { Box, Paper, Typography, Tabs, Tab, Chip } from '@mui/material';
import type { NodeSnapshot } from '../../core/types';
import { RegisterView } from './RegisterView';
import { StackView } from './StackView';
import { MemoryView } from './MemoryView';
import { NODE_COLORS } from '../theme';

interface NodeDetailPanelProps {
  node: NodeSnapshot | null;
}

export const NodeDetailPanel: React.FC<NodeDetailPanelProps> = ({ node }) => {
  const [tab, setTab] = React.useState(0);

  if (!node) {
    return (
      <Paper elevation={2} sx={{ p: 2, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Typography variant="body2" sx={{ color: '#666' }}>
          Click a node to inspect
        </Typography>
      </Paper>
    );
  }

  const stateColor = NODE_COLORS[node.state] || NODE_COLORS.suspended;

  return (
    <Paper elevation={2} sx={{ p: 1, height: '100%', overflow: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
          Node {node.coord.toString().padStart(3, '0')}
        </Typography>
        <Chip
          label={node.state.replace('_', ' ')}
          size="small"
          sx={{ backgroundColor: stateColor, color: '#fff', fontSize: '10px', height: 20 }}
        />
        {node.currentReadingPort && (
          <Chip label={`reading ${node.currentReadingPort}`} size="small" variant="outlined" sx={{ fontSize: '9px', height: 18 }} />
        )}
        {node.currentWritingPort && (
          <Chip label={`writing ${node.currentWritingPort}`} size="small" variant="outlined" sx={{ fontSize: '9px', height: 18 }} />
        )}
        <Typography variant="caption" sx={{ color: '#666', ml: 'auto' }}>
          steps: {node.stepCount}
        </Typography>
      </Box>

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        sx={{ minHeight: 28, mb: 1, '& .MuiTab-root': { minHeight: 28, py: 0, fontSize: '11px' } }}
      >
        <Tab label="Registers" />
        <Tab label="Stacks" />
        <Tab label="Memory" />
      </Tabs>

      {tab === 0 && <RegisterView registers={node.registers} slotIndex={node.slotIndex} />}
      {tab === 1 && <StackView dstack={node.dstack} rstack={node.rstack} />}
      {tab === 2 && <MemoryView ram={node.ram} rom={node.rom} pc={node.registers.P} />}
    </Paper>
  );
};
