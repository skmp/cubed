> Sources: [DB001-221113-F18A](txt/DB001-221113-F18A.txt), [DB014-190520-EVB002](txt/DB014-190520-EVB002.txt), [PB001-100503-GA144-1-10](txt/PB001-100503-GA144-1-10.txt)

# Architecture Overview

This document describes the high-level architecture of CUBED, with emphasis on the emulator core and the VGA rendering pipeline.

## Major Modules

The project is split into a pure TypeScript core and a React UI.

`src/src/core/` contains the emulation engine and compiler pipelines.
`src/src/ui/` contains the editor, 3D renderer, VGA display, and panels.

## Data Flow

1. Source code is edited in the Monaco editor.
2. The arrayForth or CUBE compiler produces a `CompiledProgram`.
3. The GA144 emulator loads the program and executes nodes.
4. UI panels render snapshots of node state, registers, and IO writes.

## VGA Pipeline

The VGA output path is driven by IO register writes captured in the emulator:

1. `GA144.onIoWrite` appends values into a ring buffer.
2. The ring buffer keeps the most recent full frame window, bounded by VSYNC.
3. `VgaDisplay` detects resolution from HSYNC/VSYNC markers.
4. A WebGL texture is updated incrementally from the IO stream.
5. The texture is drawn on a fullscreen quad to the canvas.

## Frame Buffer Strategy

The IO write stream is stored as a ring buffer with a monotonic sequence counter.
When a new VSYNC arrives, the buffer advances to keep only the most recent frame.
If the UI falls behind and data is overwritten, the display forces a full redraw.

## 3D CUBE Visualization

The CUBE 3D renderer (`src/src/ui/cube3d/`) uses Three.js to display program structure.
For multi-node programs (with `node NNN` directives), node groups are positioned on
a grid matching the GA144's 18x8 physical layout: X = column, Y = row, Z = code depth.
Single-node programs use a flat layout without grid mapping.

## WYSIWYG 3D Editor

The WYSIWYG editor (`src/src/ui/cube3d/WysiwygEditor.tsx`) provides bidirectional
structural editing of CUBE programs. It is the first tab ("3D Editor") in the layout.

**Architecture:**
- A Zustand store (`src/src/stores/editorStore.ts`) holds the canonical AST, source
  text, undo/redo history, selection state, and context menu state.
- The AST serializer (`src/src/core/cube/serializer.ts`) converts AST back to CUBE source.
- AST path system (`src/src/core/cube/ast-path.ts`) provides stable, deterministic
  node identity (e.g., `i0`, `i2.c1.i0`) for mapping between SceneNode IDs and AST nodes.
- Immutable mutation helpers (`src/src/core/cube/ast-mutations.ts`) provide add/remove/
  replace/update operations that never modify the original AST.

**Bidirectional sync:**
1. Text edits (Monaco) → parse → `setAstFromText()` → 3D view updates.
2. 3D edits (context menu, inline editing) → `applyMutation()` → serialize → recompile.
3. A `mutationSource` flag ('text' | '3d') prevents infinite loops.

**Editing capabilities:**
- Right-click context menu: add/delete/duplicate/rename applications, edit values
- Inline text editing via `EditableLabel` (double-click labels in 3D)
- Undo/Redo (Ctrl+Z / Ctrl+Y) with bounded history stack
- Keyboard shortcuts: Delete, F2 (rename), Escape

## Error Handling

WebGL initialization is guarded with compile/link checks.
Context loss is handled by reinitializing the WebGL state and reuploading the texture.

## References

- [DB014 - EVB002 Evaluation Board Reference](txt/DB014-190520-EVB002.txt) — Hardware platform this emulator models
- [PB001 - GA144 Product Brief](txt/PB001-100503-GA144-1-10.txt) — GA144 chip architecture overview
- [DB001 - F18A Technology Reference (2022)](txt/DB001-221113-F18A.txt) — F18A processor specification used as emulation reference
