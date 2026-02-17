import React from 'react';
import { Box } from '@mui/material';
import { ChipGrid } from '../chip/ChipGrid';
import { NodeDetailPanel } from '../detail/NodeDetailPanel';
import type { NodeState, NodeSnapshot } from '../../core/types';
import type { SourceMapEntry } from '../../core/cube/emitter';

interface EmulatorPanelProps {
  nodeStates: NodeState[];
  nodeCoords: number[];
  selectedCoord: number | null;
  selectedNode: NodeSnapshot | null;
  sourceMap: SourceMapEntry[] | null;
  onNodeClick: (coord: number) => void;
}

export const EmulatorPanel: React.FC<EmulatorPanelProps> = ({
  nodeStates, nodeCoords, selectedCoord, selectedNode, sourceMap, onNodeClick,
}) => {
  return (
    <Box sx={{ height: '100%', display: 'flex', overflow: 'hidden' }}>
      <Box sx={{
        width: 510,
        flexShrink: 0,
        overflow: 'auto',
        borderRight: '1px solid #333',
        p: 1,
      }}>
        <ChipGrid
          nodeStates={nodeStates}
          nodeCoords={nodeCoords}
          selectedCoord={selectedCoord}
          onNodeClick={onNodeClick}
        />
      </Box>
      <Box sx={{ flex: 1, overflow: 'auto' }}>
        <NodeDetailPanel node={selectedNode} sourceMap={sourceMap} />
      </Box>
    </Box>
  );
};
