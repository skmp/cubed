# CUBED

An open-source emulator for the [GreenArrays GA144](https://www.greenarraychips.com/home/products/) multi-computer chip and EVB001 evaluation board, paired with an experimental implementation of the **CUBE** 3D visual logic programming language.

The GA144 packs 144 tiny 18-bit Forth processors into a single chip, communicating through a mesh of blocking ports. CUBED lets you write, visualize, and step through programs for this unusual architecture right in your browser.

## Features

- **GA144 Emulator** &mdash; cycle-level emulation of all 144 F18A nodes, inter-node communication, I/O ports, and ROM
- **arrayForth Assembler** &mdash; in-browser compiler for the Forth dialect used by GreenArrays, with instruction packing and multi-node support
- **CUBE Compiler** &mdash; experimental compiler for the CUBE 3D visual logic language, targeting F18A nodes with Hindley-Milner type inference
- **3D Visualization** &mdash; interactive Three.js rendering of CUBE programs as spatial structures (containers, pipes, diamonds)
- **Node Inspector** &mdash; real-time view of registers, stacks, RAM, and execution state for all 144 nodes
- **VGA Output Viewer** &mdash; WebGL-backed VGA display with resolution detection
- **Recurse Panel** &mdash; recursive text/DSL playground for code generation
- **cubec CLI** &mdash; command-line compiler for CUBE programs

## Quick Start

```bash
cd src
npm install
npm run dev
```

This starts the Vite dev server. Open the URL it prints (usually `http://localhost:5173`).

## Build

```bash
cd src
npm run build
```

Output goes to `src/dist/`. The build includes TypeScript type checking (`tsc -b`) followed by the Vite production bundle.

## Tests

```bash
cd src
npm run test
```

## Project Structure

```
cubed/
  src/                  Vite + React + TypeScript application
    src/
      core/             Emulation engine (pure TypeScript, no DOM)
        f18a.ts         F18A processor emulation
        ga144.ts        GA144 chip (144 nodes + routing)
        compiler.ts     arrayForth assembler
        cube/           CUBE language compiler pipeline
          parser.ts     Tokenizer + parser
          resolver.ts   Name resolution + scope analysis
          inference.ts  Hindley-Milner type inference
          builtins.ts   Built-in predicate code generation
          codegen.ts    F18A code emission
      ui/               React UI components
        editor/         Monaco-based code editor
        cube3d/         Three.js 3D visualization
  docs/                 Markdown documentation
    index.html          Documentation hub
  reference/            Reference materials
    ga144/              Racket reference implementation (git submodule)
```

## Documentation

Browse the docs at [`docs/index.html`](docs/index.html) or read them directly:

- [CUBE Language Spec](docs/cube-language.md) &mdash; syntax, semantics, type system
- [F18A Architecture](docs/f18a-architecture.md) &mdash; registers, memory, stacks
- [F18A Instruction Set](docs/f18a-instruction-set.md) &mdash; opcode reference
- [GA144 Node Map](docs/ga144-node-map.md) &mdash; 8x18 mesh topology
- [GA144 I/O](docs/ga144-io.md) &mdash; ports, GPIO, analog
- [GA144 Boot Process](docs/ga144-boot.md) &mdash; boot sequences and wire protocol
- [Application Notes](docs/ga144-application-notes.md) &mdash; AN001-AN012
- [arrayForth Compiler](docs/arrayforth-compiler.md) &mdash; compiler internals
- [Programming Patterns](docs/programming-patterns.md) &mdash; idiomatic F18A techniques
- [cubec CLI](docs/cubec.md) &mdash; command-line compiler usage
- [Architecture Overview](docs/architecture.md) &mdash; emulator and VGA pipeline
- [VGA Profiling](docs/vga-profiling.md) &mdash; performance measurement guide

## CLI Compiler (cubec)

The CLI compiler lives in `src/` and wraps `cubec.ts`:

```bash
cd src
./cubec samples/blue-rectangle.cube
./cubec samples/md5-hash.cube --verbose
```

## Samples

Sample programs live under `src/samples/`. See `src/samples/README.md` for descriptions and suggested difficulty.

## Contributing

This is an early-stage research project. Contributions are very welcome &mdash; whether that's improving emulation accuracy, extending the CUBE compiler, building new samples, writing docs, or just filing bugs.

Areas where help is especially useful:

- **Emulation fidelity** &mdash; verifying behavior against real hardware or the Racket reference
- **CUBE language** &mdash; type inference, code generation, new builtins
- **Samples** &mdash; interesting multi-node programs demonstrating GA144 patterns
- **Documentation** &mdash; anything from typo fixes to new guides

If massively parallel stack machines or 3D visual languages sound interesting to you, come help out!

## Community

- [GitHub](https://github.com/skmp/cubed) &mdash; source code, issues, and pull requests
- [Twitter / X](https://x.com/poiitidis) &mdash; project updates
- [Discord](https://discord.gg/emudev) &mdash; emudev community

## License

See individual files for license information.
