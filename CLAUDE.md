# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

CUBED is a GA144/EVB002 emulator + CUBE 3D visual logic programming language, running in the browser. The GA144 chip has 144 F18A 18-bit Forth processors in an 8x18 mesh, communicating via blocking ports.

## Commands

All commands run from `src/`:

```bash
cd src
npm run dev          # Vite dev server (localhost:5173)
npm run build        # tsc -b + vite build → src/dist/
npm run test         # vitest run (all tests)
npm run lint         # eslint
npx vitest src/src/core/f18a.test.ts          # single test file
npx vitest --reporter=verbose -t "test name"  # single test by name
node extract-rom.mjs                          # re-extract ROM from reference/ga144/
```

## Architecture

### Core Engine (`src/src/core/`) — Pure TypeScript, no DOM

- **f18a.ts**: Single F18A node emulation — registers (P, A, B, T, S, R, IO), 8-element circular stacks, 64-word RAM + 64-word ROM, 4 LUDR ports, step-based execution
- **ga144.ts**: Chip controller for 144 nodes — O(1) active-list suspend/resume, boot stream protocol, IO write ring buffer (2M capacity for VGA)
- **types.ts**: `WORD_MASK` (0x3FFFF), `XOR_ENCODING` (0x15555), `PortIndex` enum
- **constants.ts**: `OPCODES`, port addresses, direction mapping functions
- **bootstream.ts**: UART wire format for loading programs
- **thermal.ts**: Power/heat simulation model

### CUBE Compiler Pipeline (`src/src/core/cube/`)

```
Source → tokenizer.ts → parser.ts → resolver.ts → inference.ts → allocator.ts → emitter.ts → F18A binary
```

- **parser.ts**: Recursive descent → AST (CubeProgram/Conjunction/PredicateDef/Application)
- **resolver.ts**: Symbol resolution — builtins, user predicates, F18A ops, ROM functions
- **inference.ts**: Hindley-Milner type inference with unification
- **builtins.ts** (~1800 LOC): Code generation for all builtin predicates (fill, loop, send, relay, shor15, asynctx, etc.)
- **emitter.ts**: Walks resolved AST, generates F18A code via CodeBuilder, manages fail labels
- **compiler.ts**: Orchestrates the pipeline; splits by node directives, compiles each node independently

### Code Generation (`src/src/core/codegen/`)

- **builder.ts** (CodeBuilder): Packs F18A instructions into 4 slots/word (5+5+5+3 bits), handles XOR encoding, forward references, label resolution

### arrayForth Assembler (`src/src/core/assembler/`)

- **compiler.ts**: Compiles arrayForth source to binary; uses same CodeBuilder as CUBE

### React UI (`src/src/ui/`)

- **App.tsx**: Tab layout — 3D Editor, Code Editor, Emulator, Compile Output
- **useEmulator.ts**: Central hook managing GA144 instance, compilation, step/run
- **CodeEditor.tsx**: Monaco editor with CUBE/arrayForth syntax highlighting
- **VgaDisplay.tsx**: WebGL VGA output with HSYNC/VSYNC resolution detection
- **cube3d/**: Three.js 3D CUBE visualization + WYSIWYG structural editor
- **editorStore.ts** (Zustand): Canonical AST state, undo/redo, selection, bidirectional text↔3D sync

## Critical Domain Knowledge

### LUDR Port Mapping (parity-dependent)

Port addresses are LUDR-relative (Left/Up/Down/Right), NOT compass-relative. Mapping depends on node coordinate parity:

- Even-x nodes: east→RIGHT(0x1D5), west→LEFT(0x175)
- Odd-x nodes: east→LEFT(0x175), west→RIGHT(0x1D5) — **SWAPPED**
- Even-y nodes: south→UP(0x145), north→DOWN(0x115)
- Odd-y nodes: north→UP(0x145), south→DOWN(0x115) — **SWAPPED**

Both sides of a connection use the SAME PortIndex. Use `getDirectionAddress(coord, dir)`.

### Node Addressing

YXX format: node 117 = row 1, col 17. Use `coordToIndex()`/`indexToCoord()` for conversion. The chip is 8 rows × 18 columns (coords 000–717).

### F18A Instruction Packing

- 4 slots/word: slot 0-2 are 5-bit, slot 3 is 3-bit (only even opcodes 0-14)
- Instructions are XOR-encoded with 0x15555; data words are raw
- `@p` (literal fetch) + jump + data MUST be in same instruction word. If `@p` lands at slot 2+, CodeBuilder flushes first

### CUBE Syntax Rules

- Every predicate/builtin MUST be separated by `/\` — consecutive blocks without `/\` causes the parser to silently stop, dropping all subsequent code
- If ANY node compilation fails (>64 words), `compileCube()` returns `nodes: []` for ALL nodes
- Compilation errors are silent in the UI — always check the `errors` array
- Each node has only 64 words of RAM; complex patterns (~5 loops + fills + setb) hit the limit

### ROM Functions

`divmod` available on most nodes at address 0x2d6 (not on nodes 300, 708, 705). Look up via `rom-functions.ts`.

## Key Pitfalls

- `emitLiteral` (@p + jump + data): the @p and jump must share an instruction word — if @p lands late in a word, flush first
- Feeder-relay architecture: feeder node (col 16) → relay node (col 17) via port write — each link costs instruction words
- IO write ring buffer (2M entries) discards oldest data when full — affects VGA rendering of long-running programs
- `CircularStack` silently overflows at 8 elements (matches real F18A hardware behavior)
