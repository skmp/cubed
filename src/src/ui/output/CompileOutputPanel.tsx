import React from 'react';
import {
  Box, Paper, Typography, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Tabs, Tab, Chip,
} from '@mui/material';
import type { CubeCompileResult } from '../../core/cube/compiler';
import type { CompiledProgram, CompiledNode } from '../../core/types';
import type { SourceMapEntry } from '../../core/cube/emitter';
import type { EditorLanguage } from '../editor/CodeEditor';
import { OPCODES } from '../../core/constants';
import { XOR_ENCODING } from '../../core/types';
import { VgaDisplay } from '../emulator/VgaDisplay';

interface CompileOutputPanelProps {
  cubeResult: CubeCompileResult | null;
  compiledProgram: CompiledProgram | null;
  language: EditorLanguage;
  ioWrites: number[];
  ioWriteCount: number;
}

const cellSx = { fontSize: '11px', py: 0.5, px: 1, fontFamily: 'monospace' };
const headerSx = { ...cellSx, fontWeight: 'bold', color: '#aaa' };

export const CompileOutputPanel: React.FC<CompileOutputPanelProps> = ({ cubeResult, compiledProgram, language, ioWrites, ioWriteCount }) => {
  const [tab, setTab] = React.useState(0);

  if (language === 'recurse') {
    return (
      <Paper elevation={2} sx={{ p: 2, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Typography variant="body2" sx={{ color: '#666' }}>
          Recurse mode has no compile output
        </Typography>
      </Paper>
    );
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Box sx={{ flexShrink: 0, borderBottom: '1px solid #333', maxHeight: '50%', overflow: 'auto' }}>
        <VgaDisplay ioWrites={ioWrites} ioWriteCount={ioWriteCount} />
      </Box>
      <Box sx={{ flex: 1, overflow: 'hidden' }}>
        {language === 'cube'
          ? <CubeOutputView result={cubeResult} tab={tab} setTab={setTab} />
          : <ArrayForthOutputView result={compiledProgram} tab={tab} setTab={setTab} />
        }
      </Box>
    </Box>
  );
};

// ---- arrayForth Disassembly View ----

function ArrayForthOutputView({ result, tab, setTab }: {
  result: CompiledProgram | null;
  tab: number;
  setTab: (t: number) => void;
}) {
  if (!result) {
    return (
      <Paper elevation={2} sx={{ p: 2, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Typography variant="body2" sx={{ color: '#666' }}>
          Compile an arrayForth program to see disassembly
        </Typography>
      </Paper>
    );
  }

  const { nodes, errors } = result;
  const totalWords = nodes.reduce((sum, n) => sum + n.len, 0);

  // Clamp tab to valid range
  const maxTab = errors.length > 0 ? 2 : 1;
  const safeTab = Math.min(tab, maxTab);

  return (
    <Paper elevation={2} sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Box sx={{ px: 1, pt: 0.5, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Chip label={`${nodes.length} node(s)`} size="small" sx={{ fontSize: '10px', height: 20 }} />
        <Chip label={`${totalWords} total words`} size="small" variant="outlined" sx={{ fontSize: '10px', height: 20 }} />
        {errors.length > 0 && (
          <Chip label={`${errors.length} error(s)`} size="small" color="error" sx={{ fontSize: '10px', height: 20 }} />
        )}
      </Box>

      <Tabs
        value={safeTab}
        onChange={(_, v) => setTab(v)}
        sx={{ minHeight: 28, px: 1, '& .MuiTab-root': { minHeight: 28, py: 0, fontSize: '11px', textTransform: 'none' } }}
      >
        <Tab label="Disassembly" />
        <Tab label="Symbols" />
        {errors.length > 0 && <Tab label="Errors" />}
      </Tabs>

      <Box sx={{ flex: 1, overflow: 'auto', p: 1 }}>
        {safeTab === 0 && <DisassemblyTab nodes={nodes} />}
        {safeTab === 1 && <NodeSymbolsTab nodes={nodes} />}
        {safeTab === 2 && <WarningsTab errors={errors} />}
      </Box>
    </Paper>
  );
}

function DisassemblyTab({ nodes }: { nodes: CompiledNode[] }) {
  if (nodes.length === 0) {
    return <Typography variant="body2" sx={{ color: '#666' }}>No compiled nodes</Typography>;
  }

  return (
    <Box>
      {nodes.map((node, ni) => {
        // Build reverse symbol lookup: addr -> label name
        const addrLabels = new Map<number, string>();
        if (node.symbols) {
          for (const [name, addr] of node.symbols) {
            addrLabels.set(addr, name);
          }
        }

        return (
          <Box key={ni} sx={{ mb: 3 }}>
            <Typography variant="caption" sx={{ color: '#ff9800', fontWeight: 'bold', fontSize: '11px' }}>
              Node {node.coord.toString().padStart(3, '0')} ({node.len} words)
            </Typography>
            {node.p !== undefined && (
              <Typography variant="caption" sx={{ color: '#888', fontSize: '10px', ml: 1 }}>
                P={`0x${node.p.toString(16)}`}
              </Typography>
            )}
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={headerSx}>Addr</TableCell>
                    <TableCell sx={headerSx}>Label</TableCell>
                    <TableCell sx={headerSx}>Hex</TableCell>
                    <TableCell sx={headerSx}>Disassembly</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {node.mem.slice(0, node.len).map((word, addr) => {
                    const label = addrLabels.get(addr);
                    return (
                      <TableRow key={addr} sx={label ? { borderTop: '1px solid #444' } : undefined}>
                        <TableCell sx={cellSx}>
                          {`0x${addr.toString(16).padStart(2, '0')}`}
                        </TableCell>
                        <TableCell sx={{ ...cellSx, color: '#ff9800' }}>
                          {label ?? ''}
                        </TableCell>
                        <TableCell sx={{ ...cellSx, color: '#ffcc88' }}>
                          {word !== null ? `0x${(word & 0x3FFFF).toString(16).padStart(5, '0')}` : '-'}
                        </TableCell>
                        <TableCell sx={{ ...cellSx, color: '#ccc' }}>
                          {word !== null ? decodeWord(word) : '-'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        );
      })}
    </Box>
  );
}

function NodeSymbolsTab({ nodes }: { nodes: CompiledNode[] }) {
  const nodesWithSymbols = nodes.filter(n => n.symbols && n.symbols.size > 0);
  if (nodesWithSymbols.length === 0) {
    return <Typography variant="body2" sx={{ color: '#666' }}>No symbols defined</Typography>;
  }

  return (
    <Box>
      {nodesWithSymbols.map((node, ni) => (
        <Box key={ni} sx={{ mb: 2 }}>
          <Typography variant="caption" sx={{ color: '#ff9800', fontWeight: 'bold', fontSize: '10px' }}>
            Node {node.coord.toString().padStart(3, '0')}
          </Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={headerSx}>Symbol</TableCell>
                  <TableCell sx={headerSx}>Address</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {[...(node.symbols ?? new Map())].map(([name, addr]) => (
                  <TableRow key={name}>
                    <TableCell sx={{ ...cellSx, color: '#88ff88' }}>{name}</TableCell>
                    <TableCell sx={cellSx}>{`0x${addr.toString(16).padStart(2, '0')}`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      ))}
    </Box>
  );
}

// ---- CUBE Output View ----

function CubeOutputView({ result, tab, setTab }: {
  result: CubeCompileResult | null;
  tab: number;
  setTab: (t: number) => void;
}) {
  if (!result) {
    return (
      <Paper elevation={2} sx={{ p: 2, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Typography variant="body2" sx={{ color: '#666' }}>
          Compile a CUBE program to see output
        </Typography>
      </Paper>
    );
  }

  const { symbols, variables, sourceMap, nodes, errors, nodeCoord } = result;
  const maxTab = errors.length > 0 ? 4 : 3;
  const safeTab = Math.min(tab, maxTab);

  return (
    <Paper elevation={2} sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Box sx={{ px: 1, pt: 0.5, display: 'flex', alignItems: 'center', gap: 1 }}>
        {nodeCoord !== undefined && (
          <Chip label={`Node ${nodeCoord}`} size="small" sx={{ fontSize: '10px', height: 20 }} />
        )}
        {nodes.length > 0 && (
          <Chip label={`${nodes[0].len} words`} size="small" variant="outlined" sx={{ fontSize: '10px', height: 20 }} />
        )}
        {errors.length > 0 && (
          <Chip label={`${errors.length} warning(s)`} size="small" color="warning" sx={{ fontSize: '10px', height: 20 }} />
        )}
      </Box>

      <Tabs
        value={safeTab}
        onChange={(_, v) => setTab(v)}
        sx={{ minHeight: 28, px: 1, '& .MuiTab-root': { minHeight: 28, py: 0, fontSize: '11px', textTransform: 'none' } }}
      >
        <Tab label="Symbols" />
        <Tab label="Variables" />
        <Tab label="Generated Code" />
        <Tab label="Source Map" />
        {errors.length > 0 && <Tab label="Warnings" />}
      </Tabs>

      <Box sx={{ flex: 1, overflow: 'auto', p: 1 }}>
        {safeTab === 0 && <SymbolsTab symbols={symbols} />}
        {safeTab === 1 && <VariablesTab variables={variables} />}
        {safeTab === 2 && <GeneratedCodeTab nodes={nodes} />}
        {safeTab === 3 && <SourceMapTab sourceMap={sourceMap} />}
        {safeTab === 4 && <WarningsTab errors={errors} />}
      </Box>
    </Paper>
  );
}

// ---- Shared Components ----

function SymbolsTab({ symbols }: { symbols?: Map<string, { kind: string; name: string; opcode?: number; romAddr?: number; params?: string[] }> }) {
  if (!symbols || symbols.size === 0) {
    return <Typography variant="body2" sx={{ color: '#666' }}>No symbols</Typography>;
  }

  const grouped = new Map<string, Array<{ name: string; detail: string }>>();
  for (const [, sym] of symbols) {
    const kind = sym.kind;
    if (!grouped.has(kind)) grouped.set(kind, []);
    let detail = '';
    if (sym.opcode !== undefined) detail = `opcode ${sym.opcode}`;
    else if (sym.romAddr !== undefined) detail = `0x${sym.romAddr.toString(16)}`;
    else if (sym.params) detail = `(${sym.params.join(', ')})`;
    grouped.get(kind)!.push({ name: sym.name, detail });
  }

  return (
    <Box>
      {[...grouped.entries()].map(([kind, syms]) => (
        <Box key={kind} sx={{ mb: 2 }}>
          <Typography variant="caption" sx={{ color: '#888', fontWeight: 'bold', textTransform: 'uppercase', fontSize: '10px' }}>
            {kind.replace('_', ' ')}
          </Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={headerSx}>Name</TableCell>
                  <TableCell sx={headerSx}>Detail</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {syms.map((s, i) => (
                  <TableRow key={i}>
                    <TableCell sx={{ ...cellSx, color: '#88ff88' }}>{s.name}</TableCell>
                    <TableCell sx={cellSx}>{s.detail}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      ))}
    </Box>
  );
}

function VariablesTab({ variables }: { variables?: { vars: Map<string, { location: string; ramAddr?: number }> } }) {
  if (!variables || variables.vars.size === 0) {
    return <Typography variant="body2" sx={{ color: '#666' }}>No variables</Typography>;
  }

  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={headerSx}>Variable</TableCell>
            <TableCell sx={headerSx}>Location</TableCell>
            <TableCell sx={headerSx}>Address</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {[...variables.vars.entries()].map(([name, mapping]) => (
            <TableRow key={name}>
              <TableCell sx={{ ...cellSx, color: '#88ccff' }}>{name}</TableCell>
              <TableCell sx={cellSx}>{mapping.location}</TableCell>
              <TableCell sx={cellSx}>
                {mapping.ramAddr !== undefined ? `0x${mapping.ramAddr.toString(16).padStart(2, '0')}` : '-'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function decodeWord(encoded: number): string {
  const raw = (encoded ^ XOR_ENCODING) & 0x3FFFF;
  const slot0 = (raw >> 13) & 0x1F;
  const slot1 = (raw >> 8) & 0x1F;
  const slot2 = (raw >> 3) & 0x1F;
  const slot3 = ((raw & 0x7) << 1);
  const ops = [slot0, slot1, slot2, slot3].map(op => OPCODES[op] ?? '?');
  return ops.join(' ');
}

function GeneratedCodeTab({ nodes }: { nodes: Array<{ coord: number; mem: (number | null)[]; len: number }> }) {
  if (nodes.length === 0) {
    return <Typography variant="body2" sx={{ color: '#666' }}>No generated code</Typography>;
  }

  return (
    <Box>
      {nodes.map((node, ni) => (
        <Box key={ni} sx={{ mb: 2 }}>
          <Typography variant="caption" sx={{ color: '#888', fontWeight: 'bold', fontSize: '10px' }}>
            Node {node.coord} ({node.len} words)
          </Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={headerSx}>Addr</TableCell>
                  <TableCell sx={headerSx}>Hex</TableCell>
                  <TableCell sx={headerSx}>Decoded</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {node.mem.slice(0, node.len).map((word, addr) => (
                  <TableRow key={addr}>
                    <TableCell sx={cellSx}>
                      {`0x${addr.toString(16).padStart(2, '0')}`}
                    </TableCell>
                    <TableCell sx={{ ...cellSx, color: '#ffcc88' }}>
                      {word !== null ? `0x${(word & 0x3FFFF).toString(16).padStart(5, '0')}` : '-'}
                    </TableCell>
                    <TableCell sx={{ ...cellSx, color: '#ccc' }}>
                      {word !== null ? decodeWord(word) : '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      ))}
    </Box>
  );
}

function SourceMapTab({ sourceMap }: { sourceMap?: SourceMapEntry[] }) {
  if (!sourceMap || sourceMap.length === 0) {
    return <Typography variant="body2" sx={{ color: '#666' }}>No source map</Typography>;
  }

  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={headerSx}>Addr</TableCell>
            <TableCell sx={headerSx}>Line:Col</TableCell>
            <TableCell sx={headerSx}>CUBE Source</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {sourceMap.map((entry, i) => (
            <TableRow key={i}>
              <TableCell sx={cellSx}>
                {`0x${entry.addr.toString(16).padStart(2, '0')}`}
              </TableCell>
              <TableCell sx={cellSx}>{entry.line}:{entry.col}</TableCell>
              <TableCell sx={{ ...cellSx, color: '#88ff88' }}>{entry.label}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function WarningsTab({ errors }: { errors: Array<{ line: number; col: number; message: string }> }) {
  return (
    <Box>
      {errors.map((err, i) => (
        <Box key={i} sx={{ mb: 0.5, display: 'flex', gap: 1 }}>
          <Typography variant="caption" sx={{ color: '#ff9800', fontFamily: 'monospace', fontSize: '11px' }}>
            {err.line}:{err.col}
          </Typography>
          <Typography variant="caption" sx={{ color: '#ccc', fontFamily: 'monospace', fontSize: '11px' }}>
            {err.message}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}
