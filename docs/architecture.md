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

## Error Handling

WebGL initialization is guarded with compile/link checks.
Context loss is handled by reinitializing the WebGL state and reuploading the texture.
