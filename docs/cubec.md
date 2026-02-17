# cubec CLI

`cubec` is a command-line compiler for the CUBE language that targets GA144 nodes.

## Quick Start

1. `cd src`
2. `npm install`
3. `./cubec samples/blue-rectangle.cube`

## Options

| Flag | Description |
| --- | --- |
| `--verbose` | Print symbols, variables, and source map. |
| `--disasm` | Print per-node disassembly. |
| `--json` | Emit JSON output (errors, nodes, symbols). |
| `--quiet` | Only print a success line or errors. |

## Examples

```bash
./cubec samples/blue-rectangle.cube
./cubec samples/md5-hash.cube --verbose
./cubec samples/sha256.cube --disasm
./cubec samples/feature-demo.cube --json > build/feature-demo.json
```

## Notes

`./cubec` is a small wrapper that bundles `cubec.ts` with esbuild and runs it with Node. It expects `node_modules` to be installed in `src/`.
