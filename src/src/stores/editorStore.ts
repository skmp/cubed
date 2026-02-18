/**
 * Zustand store for the WYSIWYG 3D editor.
 * Manages AST state, undo/redo, selection, and bidirectional sync.
 */
import { create } from 'zustand';
import type { CubeProgram } from '../core/cube/ast';
import { serializeCube } from '../core/cube/serializer';

const MAX_HISTORY = 50;

export interface ContextMenuState {
  visible: boolean;
  screenPosition: [number, number];
  targetAstPath: string | null;
  targetType: 'application' | 'definition' | 'literal' | 'holder' | 'pipe' | 'port' | 'empty' | 'type_definition';
}

export interface PipeDrawingState {
  fromAstPath: string;
  fromPortName: string;
  fromPosition: [number, number, number];
}

export interface EditorState {
  // Core state
  ast: CubeProgram | null;
  source: string;
  mutationSource: 'text' | '3d' | null;

  // History
  undoStack: CubeProgram[];
  redoStack: CubeProgram[];

  // Selection
  selectedAstPath: string | null;
  hoveredAstPath: string | null;
  editingAstPath: string | null;

  // Position overrides (from drag)
  positionOverrides: Map<string, [number, number, number]>;

  // Pipe drawing
  drawingPipe: PipeDrawingState | null;

  // Context menu
  contextMenu: ContextMenuState | null;

  // Actions
  /** Apply a mutation from the 3D editor. Pushes undo, serializes, updates source. */
  applyMutation: (fn: (ast: CubeProgram) => CubeProgram) => void;

  /** Set AST from text editor (Monaco). No undo push — Monaco has its own undo. */
  setAstFromText: (ast: CubeProgram, source: string) => void;

  /** Undo last 3D mutation. */
  undo: () => void;

  /** Redo last undone 3D mutation. */
  redo: () => void;

  /** Selection actions. */
  setSelectedNode: (path: string | null) => void;
  setHoveredNode: (path: string | null) => void;

  /** Inline editing actions. */
  startEditing: (path: string) => void;
  stopEditing: () => void;

  /** Position override actions. */
  setPositionOverride: (astPath: string, position: [number, number, number]) => void;
  clearPositionOverride: (astPath: string) => void;

  /** Pipe drawing actions. */
  startPipeDrawing: (state: PipeDrawingState) => void;
  cancelPipeDrawing: () => void;

  /** Context menu actions. */
  showContextMenu: (state: ContextMenuState) => void;
  hideContextMenu: () => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  ast: null,
  source: '',
  mutationSource: null,
  undoStack: [],
  redoStack: [],
  selectedAstPath: null,
  hoveredAstPath: null,
  editingAstPath: null,
  positionOverrides: new Map(),
  drawingPipe: null,
  contextMenu: null,

  applyMutation: (fn) => {
    const { ast, undoStack } = get();
    if (!ast) return;

    const newAst = fn(ast);
    const newSource = serializeCube(newAst);

    // Keep undo stack bounded
    const newUndo = [...undoStack, ast];
    if (newUndo.length > MAX_HISTORY) newUndo.shift();

    set({
      ast: newAst,
      source: newSource,
      mutationSource: '3d',
      undoStack: newUndo,
      redoStack: [],
    });
  },

  setAstFromText: (ast, source) => {
    set({
      ast,
      source,
      mutationSource: 'text',
    });
  },

  undo: () => {
    const { undoStack, ast, redoStack } = get();
    if (undoStack.length === 0 || !ast) return;

    const prev = undoStack[undoStack.length - 1];
    const newUndo = undoStack.slice(0, -1);
    const newSource = serializeCube(prev);

    set({
      ast: prev,
      source: newSource,
      mutationSource: '3d',
      undoStack: newUndo,
      redoStack: [...redoStack, ast],
    });
  },

  redo: () => {
    const { redoStack, ast, undoStack } = get();
    if (redoStack.length === 0 || !ast) return;

    const next = redoStack[redoStack.length - 1];
    const newRedo = redoStack.slice(0, -1);
    const newSource = serializeCube(next);

    set({
      ast: next,
      source: newSource,
      mutationSource: '3d',
      undoStack: [...undoStack, ast!],
      redoStack: newRedo,
    });
  },

  setSelectedNode: (path) => set({ selectedAstPath: path }),
  setHoveredNode: (path) => set({ hoveredAstPath: path }),

  startEditing: (path) => set({ editingAstPath: path }),
  stopEditing: () => set({ editingAstPath: null }),

  setPositionOverride: (astPath, position) => {
    const overrides = new Map(get().positionOverrides);
    overrides.set(astPath, position);
    set({ positionOverrides: overrides });
  },
  clearPositionOverride: (astPath) => {
    const overrides = new Map(get().positionOverrides);
    overrides.delete(astPath);
    set({ positionOverrides: overrides });
  },

  startPipeDrawing: (state) => set({ drawingPipe: state }),
  cancelPipeDrawing: () => set({ drawingPipe: null }),

  showContextMenu: (state) => set({ contextMenu: state }),
  hideContextMenu: () => set({ contextMenu: null }),
}));
