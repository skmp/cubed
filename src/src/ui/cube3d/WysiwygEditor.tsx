/**
 * WYSIWYG 3D structural editor tab for the CUBE language.
 * Wraps CubeRenderer with editing capabilities: context menu, inline editing,
 * selection, drag, and keyboard shortcuts. Subscribes to editorStore for state.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { Box, Typography, IconButton } from '@mui/material';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import DownloadIcon from '@mui/icons-material/Download';
import UndoIcon from '@mui/icons-material/Undo';
import RedoIcon from '@mui/icons-material/Redo';
import { useState } from 'react';
import { useEditorStore, type ContextMenuState } from '../../stores/editorStore';
import type { CubeProgram } from '../../core/cube/ast';
import { layoutAST, filterSceneGraph } from './layoutEngine';
import type { SceneNode, PipeInfo, SceneGraph, GridCellInfo } from './layoutEngine';
import { CubeScene } from './CubeScene';
import { ContextMenu3D } from './ContextMenu3D';
import { sceneGraphToSVG } from './svgExport';
import {
  addConjunctionItem,
  replaceConjunctionItem,
  createApplication,
} from '../../core/cube/ast-mutations';
import { getItemAtPath } from '../../core/cube/ast-path';

/**
 * Add ghost placeholder nodes for empty GA144 grid positions.
 * Uses the gridCells info from the layout engine (size-aware positioning).
 */
function addPlaceholderNodes(sg: SceneGraph, ast: CubeProgram | null): SceneGraph {
  if (!ast || !sg.gridCells || sg.gridCells.length === 0) return sg;

  // Collect occupied GA144 coords from __node directives
  const occupiedCoords = new Set<number>();
  for (const item of ast.conjunction.items) {
    if (item.kind === 'application' && item.functor === '__node') {
      const coordArg = item.args[0]?.value;
      if (coordArg?.kind === 'literal') {
        occupiedCoords.add(coordArg.value);
      }
    }
  }

  if (occupiedCoords.size < 2) return sg;

  // Build lookup for grid cell positions by col/row
  const cellMap = new Map<string, GridCellInfo>();
  for (const cell of sg.gridCells) {
    cellMap.set(`${cell.col},${cell.row}`, cell);
  }

  // Find bounding box of occupied coords to know range for placeholders
  let minCol = 17, maxCol = 0, minRow = 7, maxRow = 0;
  for (const coord of occupiedCoords) {
    const col = coord % 100;
    const row = Math.floor(coord / 100);
    minCol = Math.min(minCol, col);
    maxCol = Math.max(maxCol, col);
    minRow = Math.min(minRow, row);
    maxRow = Math.max(maxRow, row);
  }

  // Expand range by 1 in each direction (clamped)
  minCol = Math.max(0, minCol - 1);
  maxCol = Math.min(17, maxCol + 1);
  minRow = Math.max(0, minRow - 1);
  maxRow = Math.min(7, maxRow + 1);

  const placeholders: SceneNode[] = [];
  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      const coord = row * 100 + col;
      if (occupiedCoords.has(coord)) continue;

      // Use nearest cell position/size from gridCells, or interpolate
      const cell = cellMap.get(`${col},${row}`);
      if (cell) {
        // This cell has a known position from the layout engine
        placeholders.push({
          id: `placeholder_${coord}`,
          type: 'plane',
          label: `node ${coord}`,
          position: [cell.x + cell.width / 2, cell.y + cell.height / 2, 0],
          size: [cell.width * 0.8, cell.height * 0.6, 0.5],
          color: '#333333',
          transparent: true,
          opacity: 0.05,
          ports: [],
        });
      } else {
        // Interpolate position from nearest known column and row
        const nearestColCell = sg.gridCells!.find(c => c.col === col);
        const nearestRowCell = sg.gridCells!.find(c => c.row === row);
        const cx = nearestColCell ? nearestColCell.x + nearestColCell.width / 2 : col * 4.0;
        const cy = nearestRowCell ? nearestRowCell.y + nearestRowCell.height / 2 : row * 3.0;
        const cw = nearestColCell?.width ?? 4.0;
        const ch = nearestRowCell?.height ?? 3.0;

        placeholders.push({
          id: `placeholder_${coord}`,
          type: 'plane',
          label: `node ${coord}`,
          position: [cx, cy, 0],
          size: [cw * 0.8, ch * 0.6, 0.5],
          color: '#333333',
          transparent: true,
          opacity: 0.05,
          ports: [],
        });
      }
    }
  }

  if (placeholders.length === 0) return sg;

  return {
    nodes: [...sg.nodes, ...placeholders],
    pipes: sg.pipes,
    gridCells: sg.gridCells,
  };
}

export function WysiwygEditor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoveredPipeId, setHoveredPipeId] = useState<string | null>(null);
  const [focusStack, setFocusStack] = useState<string[]>([]);

  const ast = useEditorStore(s => s.ast);
  const contextMenu = useEditorStore(s => s.contextMenu);
  const selectedAstPath = useEditorStore(s => s.selectedAstPath);
  const undoStack = useEditorStore(s => s.undoStack);
  const redoStack = useEditorStore(s => s.redoStack);

  const {
    applyMutation,
    undo,
    redo,
    showContextMenu,
    hideContextMenu,
    setSelectedNode,
    startEditing,
  } = useEditorStore.getState();

  const fullSceneGraph = useMemo(() => {
    if (!ast) return { nodes: [], pipes: [] };
    const sg = layoutAST(ast);
    return addPlaceholderNodes(sg, ast);
  }, [ast]);

  const focusStackSafe = useMemo(() => {
    if (focusStack.length === 0) return focusStack;
    const ids = new Set(fullSceneGraph.nodes.map(n => n.id));
    return focusStack.filter(id => ids.has(id));
  }, [focusStack, fullSceneGraph]);

  const focusId = focusStackSafe.length > 0 ? focusStackSafe[focusStackSafe.length - 1] : null;

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
    const node = fullSceneGraph.nodes.find(n => n.id === id);
    if (!node) return;

    const hasChildren = fullSceneGraph.nodes.some(n => n.parentId === id);
    if (hasChildren) {
      // Drill into node with children
      setFocusStack(prev => {
        const ids = new Set(fullSceneGraph.nodes.map(n => n.id));
        const cleaned = prev.filter(p => ids.has(p));
        return [...cleaned, id];
      });
      setSelectedId(null);
      setHoveredId(null);
    } else if (node.astPath) {
      // Leaf node: start inline editing of name/value
      setSelectedId(id);
      setSelectedNode(node.astPath);
      startEditing(node.astPath);
    }
  }, [fullSceneGraph, setSelectedNode, startEditing]);

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

  const handleDownloadSVG = useCallback(() => {
    const svg = sceneGraphToSVG(sceneGraph);
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cube-scene.svg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [sceneGraph]);

  // Map SceneNode type to context menu target type
  const getContextMenuType = useCallback((nodeId: string | null): ContextMenuState['targetType'] => {
    if (!nodeId) return 'empty';
    const node = sceneGraph.nodes.find(n => n.id === nodeId);
    if (!node) return 'empty';
    switch (node.type) {
      case 'application': return 'application';
      case 'definition': return 'definition';
      case 'literal': return 'literal';
      case 'holder': return 'holder';
      case 'constructor': return 'application';
      case 'type_definition': return 'type_definition';
      case 'plane': return 'empty';
      default: return 'empty';
    }
  }, [sceneGraph]);

  // Handle right-click — context sensitive based on selection
  const handleCanvasContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const targetType = getContextMenuType(safeSelectedId);
    const node = safeSelectedId ? sceneGraph.nodes.find(n => n.id === safeSelectedId) : null;
    showContextMenu({
      visible: true,
      screenPosition: [e.clientX, e.clientY],
      targetAstPath: node?.astPath ?? null,
      targetType,
    });
  }, [showContextMenu, safeSelectedId, sceneGraph, getContextMenuType]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'z') {
        e.preventDefault();
        undo();
      } else if (e.ctrlKey && e.key === 'y') {
        e.preventDefault();
        redo();
      } else if (e.key === 'Delete' && selectedAstPath) {
        e.preventDefault();
        // Replace with empty default instead of removing entirely
        applyMutation(ast => replaceConjunctionItem(ast, selectedAstPath, createApplication('_empty')));
        setSelectedNode(null);
      } else if (e.key === 'F2' && selectedAstPath) {
        e.preventDefault();
        startEditing(selectedAstPath);
      } else if (e.key === 'Escape') {
        hideContextMenu();
        setSelectedNode(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedAstPath, undo, redo, applyMutation, setSelectedNode, startEditing, hideContextMenu]);

  // Fullscreen change listener
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Context menu handlers
  const handleAddApplication = useCallback(() => {
    applyMutation(ast => addConjunctionItem(ast, '', createApplication('new_app')));
  }, [applyMutation]);

  const handleAddNode = useCallback(() => {
    applyMutation(ast => addConjunctionItem(ast, '', createApplication('__node', [
      { name: 'coord', value: { kind: 'literal', value: 0, loc: { line: 0, col: 0 } }, loc: { line: 0, col: 0 } },
    ])));
  }, [applyMutation]);

  const handleDelete = useCallback(() => {
    if (!contextMenu?.targetAstPath) return;
    // Replace with empty default instead of removing entirely
    applyMutation(ast => replaceConjunctionItem(ast, contextMenu.targetAstPath!, createApplication('_empty')));
    setSelectedNode(null);
  }, [applyMutation, contextMenu, setSelectedNode]);

  const handleRename = useCallback(() => {
    if (selectedAstPath) startEditing(selectedAstPath);
  }, [selectedAstPath, startEditing]);

  const handleDuplicate = useCallback(() => {
    if (!selectedAstPath || !ast) return;
    const item = getItemAtPath(ast, selectedAstPath);
    if (item) {
      applyMutation(a => addConjunctionItem(a, '', JSON.parse(JSON.stringify(item))));
    }
  }, [applyMutation, ast, selectedAstPath]);

  const handleEditValue = useCallback(() => {
    if (selectedAstPath) startEditing(selectedAstPath);
  }, [selectedAstPath, startEditing]);

  const handleDisconnect = useCallback(() => {
    // Pipe disconnection - future phase
  }, []);

  const svgContent = useMemo(() => sceneGraphToSVG(sceneGraph), [sceneGraph]);

  if (!ast) {
    return (
      <Box sx={{
        width: '100%',
        height: '100%',
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#666',
      }}>
        <Typography variant="body2">
          Compile a CUBE program to see the 3D editor
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      ref={containerRef}
      sx={{ width: '100%', height: '100%', flex: 1, position: 'relative', bgcolor: '#121212', display: 'flex', flexDirection: 'column' }}
      onContextMenu={handleCanvasContextMenu}
    >
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
          onClick={(id) => {
            setSelectedId(id);
            // Map scene node ID to AST path via the node's astPath field
            const node = sceneGraph.nodes.find(n => n.id === id);
            setSelectedNode(node?.astPath ?? null);
          }}
          onDoubleClick={handleDoubleClick}
          resetKey={cameraResetKey}
          hoveredPipeId={hoveredPipeId}
          onPipeHover={setHoveredPipeId}
          pipeHighlightIds={pipeHighlightIds}
        />
      </Canvas>

      {/* Undo/Redo toolbar */}
      <Box sx={{
        position: 'absolute',
        top: 8,
        left: 8,
        display: 'flex',
        gap: 0.5,
        bgcolor: 'rgba(0,0,0,0.85)',
        borderRadius: 1,
        border: '1px solid #444',
        px: 0.5,
        py: 0.25,
      }}>
        <IconButton
          size="small"
          onClick={undo}
          disabled={undoStack.length === 0}
          title="Undo (Ctrl+Z)"
          sx={{ color: undoStack.length > 0 ? '#aaa' : '#444', p: 0.5, '&:hover': { color: '#fff' } }}
        >
          <UndoIcon sx={{ fontSize: 16 }} />
        </IconButton>
        <IconButton
          size="small"
          onClick={redo}
          disabled={redoStack.length === 0}
          title="Redo (Ctrl+Y)"
          sx={{ color: redoStack.length > 0 ? '#aaa' : '#444', p: 0.5, '&:hover': { color: '#fff' } }}
        >
          <RedoIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>

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

      {/* Fullscreen toggle and SVG download */}
      <Box sx={{
        position: 'absolute',
        bottom: 8,
        right: 8,
        display: 'flex',
        gap: 1,
      }}>
        <IconButton
          size="small"
          onClick={handleDownloadSVG}
          title="Download as SVG"
          sx={{
            color: '#aaa',
            bgcolor: 'rgba(0,0,0,0.6)',
            '&:hover': { color: '#fff', bgcolor: 'rgba(0,0,0,0.85)' },
          }}
        >
          <DownloadIcon fontSize="small" />
        </IconButton>
        <IconButton
          size="small"
          onClick={toggleFullscreen}
          title="Toggle fullscreen"
          sx={{
            color: '#aaa',
            bgcolor: 'rgba(0,0,0,0.6)',
            '&:hover': { color: '#fff', bgcolor: 'rgba(0,0,0,0.85)' },
          }}
        >
          {isFullscreen ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
        </IconButton>
      </Box>

      {/* Tooltip overlay */}
      {(hoveredNode || hoveredPipe) && (
        <Box sx={{
          position: 'absolute',
          top: 48,
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

      {/* Context menu */}
      <ContextMenu3D
        state={contextMenu}
        onClose={hideContextMenu}
        onAddApplication={handleAddApplication}
        onAddNode={handleAddNode}
        onDelete={handleDelete}
        onRename={handleRename}
        onDuplicate={handleDuplicate}
        onEditValue={handleEditValue}
        onDisconnect={handleDisconnect}
      />
    </Box>
  );
}
