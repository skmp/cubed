/**
 * Layout engine: transforms a CubeProgram AST into a flat list of
 * positioned 3D objects (SceneGraph) for rendering.
 *
 * Spatial semantics from the CUBE spec:
 *   X axis = conjunction (horizontal AND)
 *   Y axis = disjunction (vertical OR)
 *   Z axis = depth (pipe routing)
 */
import type {
  CubeProgram, Conjunction, ConjunctionItem,
  PredicateDef, Application, Unification, Term, TypeDef,
} from '../../core/cube/ast';

// ---- Scene graph types ----

export type SceneNodeType =
  | 'definition'
  | 'application'
  | 'holder'
  | 'literal'
  | 'port'
  | 'plane'
  | 'constructor'
  | 'type_definition';

export interface PortInfo {
  id: string;
  name: string;
  side: 'left' | 'right' | 'front' | 'back';
  offset: number; // fractional position along that side
  worldPos: [number, number, number];
}

export interface SceneNode {
  id: string;
  type: SceneNodeType;
  label: string;
  position: [number, number, number];
  size: [number, number, number];
  color: string;
  transparent: boolean;
  opacity: number;
  parentId?: string;
  ports: PortInfo[];
  /** AST path for stable identity (e.g., "i0", "i2.c1.i0") */
  astPath?: string;
}

export interface PipeInfo {
  id: string;
  from: [number, number, number];
  to: [number, number, number];
  color: string;       // primary color (used for uniform fallback)
  fromColor: string;   // color at the 'from' end
  toColor: string;     // color at the 'to' end
  fromNodeId?: string;
  toNodeId?: string;
}

export interface GridCellInfo {
  col: number;
  row: number;
  x: number;      // cell left edge X
  y: number;      // cell bottom edge Y
  width: number;
  height: number;
}

export interface SceneGraph {
  nodes: SceneNode[];
  pipes: PipeInfo[];
  /** Grid cell positions for multi-node programs (used for placeholder rendering). */
  gridCells?: GridCellInfo[];
}

// ---- Color palette ----

const COLORS = {
  builtin: '#4488cc',
  f18a: '#cc8844',
  rom: '#8844cc',
  user: '#44cc88',
  definition: '#22aa66',
  holder: '#66aadd',
  literal: '#ddaa44',
  pipe: '#44dddd',          // default / bidirectional
  pipe_source: '#44dd88',  // data flowing INTO a builtin (green-ish)
  pipe_sink: '#dd6644',    // data flowing OUT of a builtin (orange-ish)
  pipe_bidi: '#44dddd',    // bidirectional / unification (cyan)
  plane: '#335533',
  constructor: '#cc44aa',
  type_def: '#aa66cc',
  variant: '#9955bb',
  field: '#bb88dd',
  unknown: '#888888',
};

const BUILTINS = new Set([
  'plus', 'minus', 'times', 'greater', 'not', 'equal',
  'band', 'bor', 'bxor', 'bnot', 'shl', 'shr',
  'send', 'recv',
]);

function appColor(functor: string): string {
  if (BUILTINS.has(functor)) return COLORS.builtin;
  if (functor.startsWith('f18a.')) return COLORS.f18a;
  if (functor.startsWith('rom.')) return COLORS.rom;
  if (functor === '__node') return COLORS.unknown;
  return COLORS.user;
}

// ---- Pipe direction (source / sink / bidi) ----

type PipeDirection = 'source' | 'sink' | 'bidi';

/** Determine whether a builtin arg at a given index is an input (source),
 *  output (sink), or bidirectional. Convention:
 *  - 3-arg builtins (plus, band, ...): args 0,1 = source, arg 2 = sink
 *  - bnot: arg 0 = source, arg 1 = sink
 *  - greater, equal: all source (comparison, no output)
 *  - not: bidi (logical negation)
 *  - send: arg 0 (port) = source, arg 1 (value) = source
 *  - recv: arg 0 (port) = source, arg 1 (value) = sink
 *  - shl, shr: args 0,1 = source, arg 2 = sink
 *  - user-defined / unknown: bidi
 */
function argDirection(functor: string, argIndex: number): PipeDirection {
  switch (functor) {
    case 'plus': case 'minus': case 'times':
    case 'band': case 'bor': case 'bxor':
    case 'shl': case 'shr':
      return argIndex < 2 ? 'source' : 'sink';
    case 'bnot':
      return argIndex === 0 ? 'source' : 'sink';
    case 'greater': case 'equal':
    case 'send':
      return 'source';
    case 'recv':
      return argIndex === 0 ? 'source' : 'sink';
    case 'not':
      return 'bidi';
    default:
      return 'bidi';
  }
}

/** Returns [appEndColor, termEndColor] for a pipe connecting an app port to a term.
 *  - source arg: data flows FROM term TO app → term=producer(green), app=consumer(orange)
 *  - sink arg:   data flows FROM app TO term → app=producer(green), term=consumer(orange)
 *  - bidi:       both ends cyan */
function pipeColorsForDirection(dir: PipeDirection): [string, string] {
  switch (dir) {
    case 'source': return [COLORS.pipe_sink, COLORS.pipe_source];   // app consumes, term produces
    case 'sink':   return [COLORS.pipe_source, COLORS.pipe_sink];   // app produces, term consumes
    case 'bidi':   return [COLORS.pipe_bidi, COLORS.pipe_bidi];
  }
}

// ---- ID generation ----

let idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${idCounter++}`;
}

// ---- Scene graph filtering (for focus/drill-down) ----

/** Collect all descendant node IDs of a given node (recursive via parentId) */
export function getDescendantIds(nodes: SceneNode[], rootId: string): Set<string> {
  const ids = new Set<string>();
  ids.add(rootId);
  let added = true;
  while (added) {
    added = false;
    for (const node of nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        added = true;
      }
    }
  }
  return ids;
}

/** Filter a scene graph to only include a node and its descendants + connected pipes */
export function filterSceneGraph(sg: SceneGraph, focusId: string): SceneGraph {
  const nodeIds = getDescendantIds(sg.nodes, focusId);

  const filteredNodes = sg.nodes.filter(n => nodeIds.has(n.id));
  const filteredPipes = sg.pipes.filter(p =>
    (p.fromNodeId && nodeIds.has(p.fromNodeId)) ||
    (p.toNodeId && nodeIds.has(p.toNodeId))
  );

  // Re-center around the focused node's position
  const focusNode = sg.nodes.find(n => n.id === focusId);
  if (focusNode) {
    const [ox, oy, oz] = focusNode.position;
    return {
      nodes: filteredNodes.map(n => ({
        ...n,
        position: [n.position[0] - ox, n.position[1] - oy, n.position[2] - oz] as [number, number, number],
        ports: n.ports.map(p => ({
          ...p,
          worldPos: [p.worldPos[0] - ox, p.worldPos[1] - oy, p.worldPos[2] - oz] as [number, number, number],
        })),
      })),
      pipes: filteredPipes.map(p => ({
        ...p,
        from: [p.from[0] - ox, p.from[1] - oy, p.from[2] - oz] as [number, number, number],
        to: [p.to[0] - ox, p.to[1] - oy, p.to[2] - oz] as [number, number, number],
      })),
    };
  }

  return { nodes: filteredNodes, pipes: filteredPipes };
}

// ---- Layout extent (returned by all layout functions) ----

interface LayoutExtent {
  width: number;  // X extent
  depth: number;  // Z extent
}

// ---- Layout constants ----

const ITEM_SPACING_X = 2.5;
const ITEM_SPACING_Z = 1.0;  // gap between items in Z within a nested conjunction
const TOP_LEVEL_SPACING_Z = 1.5; // extra gap between top-level items
const CLAUSE_SPACING_Y = 2.0;
const DEF_PADDING = 0.5;
const DEF_DEPTH_PAD = 0.5; // Z padding around content inside containers
const APP_SIZE = 1.0;
const HOLDER_SIZE = 0.5;
const LITERAL_SIZE = 0.6;
const PORT_SIZE = 0.25;

// ---- Main entry point ----

// GA144 grid layout: node groups positioned by chip coordinate (YXX)
const GRID_GAP = 1.0; // gap between grid cells
const MIN_CELL_X = 4.0; // minimum horizontal cell size
const MIN_CELL_Y = 3.0; // minimum vertical cell size

/** Compute bounding box for a set of scene nodes. */
function computeBounds(groupNodes: SceneNode[]): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const n of groupNodes) {
    const [px, py, pz] = n.position;
    const [sx, sy, sz] = n.size;
    minX = Math.min(minX, px - sx / 2);
    maxX = Math.max(maxX, px + sx / 2);
    minY = Math.min(minY, py - sy / 2);
    maxY = Math.max(maxY, py + sy / 2);
    minZ = Math.min(minZ, pz - sz / 2);
    maxZ = Math.max(maxZ, pz + sz / 2);
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/** Translate scene nodes and pipes by an offset vector. */
function translateGroup(groupNodes: SceneNode[], groupPipes: PipeInfo[], dx: number, dy: number, dz: number) {
  for (const n of groupNodes) {
    n.position = [n.position[0] + dx, n.position[1] + dy, n.position[2] + dz];
    for (const p of n.ports) {
      p.worldPos = [p.worldPos[0] + dx, p.worldPos[1] + dy, p.worldPos[2] + dz];
    }
  }
  for (const p of groupPipes) {
    p.from = [p.from[0] + dx, p.from[1] + dy, p.from[2] + dz];
    p.to = [p.to[0] + dx, p.to[1] + dy, p.to[2] + dz];
  }
}

export function layoutAST(program: CubeProgram): SceneGraph {
  idCounter = 0;
  const nodes: SceneNode[] = [];
  const pipes: PipeInfo[] = [];
  const holderPositions = new Map<string, [number, number, number]>();
  const holderNodeIds = new Map<string, string>(); // variable name → node id

  // Collect constructor names from type definitions for coloring
  const constructorNames = new Set<string>();
  for (const item of program.conjunction.items) {
    if (item.kind === 'type_def') {
      for (const variant of item.variants) {
        constructorNames.add(variant.name);
      }
    }
  }

  // Split top-level items into groups by __node directives.
  // Items before the first __node go into an unnamed group.
  // Each __node starts a new group with that node number as label.
  const groups: { label: string | null; coord: number | null; items: ConjunctionItem[] }[] = [];
  let currentGroup: { label: string | null; coord: number | null; items: ConjunctionItem[] } = { label: null, coord: null, items: [] };

  for (const item of program.conjunction.items) {
    if (item.kind === 'application' && item.functor === '__node') {
      // Start a new group
      if (currentGroup.items.length > 0 || currentGroup.label !== null) {
        groups.push(currentGroup);
      }
      const coordVal = item.args[0]?.value.kind === 'literal' ? item.args[0].value.value : null;
      const nodeNum = coordVal !== null ? String(coordVal) : '?';
      currentGroup = { label: `node ${nodeNum}`, coord: coordVal, items: [] };
    } else {
      currentGroup.items.push(item);
    }
  }
  if (currentGroup.items.length > 0 || currentGroup.label !== null) {
    groups.push(currentGroup);
  }

  // If there's only one group (no node directives, or just one node),
  // lay out flat as before
  if (groups.length <= 1) {
    const conj: Conjunction = { kind: 'conjunction', items: groups[0]?.items ?? program.conjunction.items, loc: program.conjunction.loc };
    layoutConjunction(conj, [0, 0, 0], nodes, pipes, holderPositions, holderNodeIds, undefined, constructorNames, true);
    return { nodes, pipes };
  }

  // --- Two-pass layout for multi-node programs ---
  //
  // Pass 1: Lay out each group at the origin to measure actual size.
  // Pass 2: Compute per-column widths and per-row heights from actual
  //          bounding boxes, then position groups on the grid.

  interface LayoutResult {
    group: typeof groups[0];
    col: number;
    row: number;
    groupId: string;
    groupNodes: SceneNode[];
    groupPipes: PipeInfo[];
    bounds: ReturnType<typeof computeBounds>;
    width: number;  // padded width
    height: number; // padded height
  }

  const pad = 0.8;
  const layoutResults: LayoutResult[] = [];

  for (const group of groups) {
    if (group.items.length === 0) continue;

    let col = 0, row = -1; // default for unnamed group
    if (group.coord !== null) {
      col = group.coord % 100;
      row = Math.floor(group.coord / 100);
    }

    const groupId = nextId('nodegroup');
    const groupNodes: SceneNode[] = [];
    const groupPipes: PipeInfo[] = [];
    const conj: Conjunction = { kind: 'conjunction', items: group.items, loc: program.conjunction.loc };

    // Layout at origin (0,0,0) — we'll translate later
    layoutConjunction(conj, [0, 0, 0], groupNodes, groupPipes, holderPositions, holderNodeIds, groupId, constructorNames, true);

    const bounds = computeBounds(groupNodes);
    const width = Math.max((bounds.maxX - bounds.minX) + pad * 2, MIN_CELL_X);
    const height = Math.max((bounds.maxY - bounds.minY) + pad * 2, MIN_CELL_Y);

    layoutResults.push({ group, col, row, groupId, groupNodes, groupPipes, bounds, width, height });
  }

  // Compute per-column widths and per-row heights
  const colWidths = new Map<number, number>();
  const rowHeights = new Map<number, number>();

  for (const r of layoutResults) {
    colWidths.set(r.col, Math.max(colWidths.get(r.col) ?? MIN_CELL_X, r.width));
    rowHeights.set(r.row, Math.max(rowHeights.get(r.row) ?? MIN_CELL_Y, r.height));
  }

  // Sort columns and rows to build cumulative offsets
  const sortedCols = [...colWidths.keys()].sort((a, b) => a - b);
  const sortedRows = [...rowHeights.keys()].sort((a, b) => a - b);

  // Build cumulative X positions: each column starts after the previous one ends
  const colStart = new Map<number, number>();
  let xCursor = 0;
  for (const c of sortedCols) {
    colStart.set(c, xCursor);
    xCursor += colWidths.get(c)! + GRID_GAP;
  }

  // Build cumulative Y positions: each row starts after the previous one ends
  const rowStart = new Map<number, number>();
  let yCursor = 0;
  for (const r of sortedRows) {
    rowStart.set(r, yCursor);
    yCursor += rowHeights.get(r)! + GRID_GAP;
  }

  // Pass 2: translate each group to its grid cell and build containers
  for (const r of layoutResults) {
    const cellX = colStart.get(r.col) ?? 0;
    const cellY = rowStart.get(r.row) ?? 0;
    const cellW = colWidths.get(r.col) ?? MIN_CELL_X;
    const cellH = rowHeights.get(r.row) ?? MIN_CELL_Y;

    // Center the group content within its cell.
    // Content was laid out at origin — shift it so its bbox center aligns with cell center.
    const contentCenterX = (r.bounds.minX + r.bounds.maxX) / 2;
    const contentCenterY = (r.bounds.minY + r.bounds.maxY) / 2;
    const contentCenterZ = (r.bounds.minZ + r.bounds.maxZ) / 2;
    const targetCenterX = cellX + cellW / 2;
    const targetCenterY = cellY + cellH / 2;

    const dx = targetCenterX - contentCenterX;
    const dy = targetCenterY - contentCenterY;
    const dz = -contentCenterZ; // center Z at 0

    translateGroup(r.groupNodes, r.groupPipes, dx, dy, dz);

    // Recompute bounds after translation
    const finalBounds = computeBounds(r.groupNodes);
    const gw = (finalBounds.maxX - finalBounds.minX) + pad * 2;
    const gh = (finalBounds.maxY - finalBounds.minY) + pad * 2;
    const gd = (finalBounds.maxZ - finalBounds.minZ) + pad * 2;

    // Node group container
    nodes.push({
      id: r.groupId,
      type: 'plane',
      label: r.group.label ?? 'global',
      position: [
        (finalBounds.minX + finalBounds.maxX) / 2,
        (finalBounds.minY + finalBounds.maxY) / 2,
        (finalBounds.minZ + finalBounds.maxZ) / 2,
      ],
      size: [gw, gh, gd],
      color: '#224444',
      transparent: true,
      opacity: 0.08,
      ports: [],
    });

    nodes.push(...r.groupNodes);
    pipes.push(...r.groupPipes);
  }

  // Build grid cell info for placeholder rendering
  const gridCells: GridCellInfo[] = [];
  for (const [col, x] of colStart) {
    for (const [row, y] of rowStart) {
      gridCells.push({
        col, row,
        x, y,
        width: colWidths.get(col) ?? MIN_CELL_X,
        height: rowHeights.get(row) ?? MIN_CELL_Y,
      });
    }
  }

  return { nodes, pipes, gridCells };
}

// ---- Conjunction layout ----
// Top-level: items along Z (depth), each definition gets its own row.
// Nested (inside a predicate clause): items along X (horizontal AND),
// with each item offset in Z by the cumulative depth of prior items.

function layoutConjunction(
  conj: Conjunction,
  origin: [number, number, number],
  nodes: SceneNode[],
  pipes: PipeInfo[],
  holderPositions: Map<string, [number, number, number]>,
  holderNodeIds: Map<string, string>,
  parentId?: string,
  constructorNames?: Set<string>,
  topLevel: boolean = false,
): LayoutExtent {
  if (topLevel) {
    // Top-level: definitions (predicate_def, type_def) each get their own Z row.
    // Consecutive invocations (application, unification) are grouped along X.
    let zCursor = origin[2];

    let i = 0;
    while (i < conj.items.length) {
      const item = conj.items[i];

      if (item.kind === 'predicate_def' || item.kind === 'type_def') {
        // Definition: own Z row
        const ext = layoutItem(item, [origin[0], origin[1], zCursor], nodes, pipes, holderPositions, holderNodeIds, parentId, constructorNames);
        zCursor += ext.depth + TOP_LEVEL_SPACING_Z;
        i++;
      } else {
        // Invocation run: collect consecutive applications/unifications
        // and lay them out along X on the same Z row
        const runStart = i;
        while (i < conj.items.length && conj.items[i].kind !== 'predicate_def' && conj.items[i].kind !== 'type_def') {
          i++;
        }
        const runItems = conj.items.slice(runStart, i);
        const runConj: Conjunction = { kind: 'conjunction', items: runItems, loc: conj.loc };
        // Lay out this run as a nested conjunction (along X with Z zigzag)
        const ext = layoutConjunction(runConj, [origin[0], origin[1], zCursor], nodes, pipes, holderPositions, holderNodeIds, parentId, constructorNames, false);
        zCursor += ext.depth + TOP_LEVEL_SPACING_Z;
      }
    }

    return { width: 0, depth: zCursor - origin[2] };
  }

  // Nested: lay items in a grid — along X, wrapping to a new Z row
  // after MAX_ROW_ITEMS to avoid excessively wide layouts.
  const MAX_ROW_ITEMS = 4;
  let xCursor = origin[0];
  let zCursor = origin[2];
  let rowMaxDepth = 0;
  let totalWidth = 0;
  let totalDepth = 0;
  let rowItemCount = 0;

  for (let i = 0; i < conj.items.length; i++) {
    const item = conj.items[i];
    // Alternate Z within a row for pipe routing
    const zOff = (rowItemCount % 2 === 1) ? ITEM_SPACING_Z : 0;
    const ext = layoutItem(item, [xCursor, origin[1], zCursor + zOff], nodes, pipes, holderPositions, holderNodeIds, parentId, constructorNames);
    xCursor += ext.width + ITEM_SPACING_X;
    rowMaxDepth = Math.max(rowMaxDepth, zOff + ext.depth);
    rowItemCount++;

    // Wrap to next row if we've hit the limit (unless last item)
    if (rowItemCount >= MAX_ROW_ITEMS && i < conj.items.length - 1) {
      totalWidth = Math.max(totalWidth, xCursor - origin[0] - ITEM_SPACING_X);
      zCursor += rowMaxDepth + ITEM_SPACING_Z;
      totalDepth = zCursor - origin[2];
      xCursor = origin[0];
      rowMaxDepth = 0;
      rowItemCount = 0;
    }
  }

  totalWidth = Math.max(totalWidth, xCursor - origin[0] - ITEM_SPACING_X);
  totalDepth = Math.max(totalDepth, (zCursor - origin[2]) + rowMaxDepth);

  return {
    width: totalWidth,
    depth: totalDepth,
  };
}

// ---- Single item dispatch ----

function layoutItem(
  item: ConjunctionItem,
  pos: [number, number, number],
  nodes: SceneNode[],
  pipes: PipeInfo[],
  holderPositions: Map<string, [number, number, number]>,
  holderNodeIds: Map<string, string>,
  parentId?: string,
  constructorNames?: Set<string>,
): LayoutExtent {
  switch (item.kind) {
    case 'predicate_def':
      return layoutPredicateDef(item, pos, nodes, pipes, holderPositions, holderNodeIds, parentId, constructorNames);
    case 'application':
      return layoutApplication(item, pos, nodes, pipes, holderPositions, holderNodeIds, parentId, constructorNames);
    case 'unification':
      return layoutUnification(item, pos, nodes, pipes, holderPositions, holderNodeIds, parentId, constructorNames);
    case 'type_def':
      return layoutTypeDef(item, pos, nodes, parentId);
  }
}

// ---- Predicate definition ----

function layoutPredicateDef(
  def: PredicateDef,
  origin: [number, number, number],
  nodes: SceneNode[],
  pipes: PipeInfo[],
  _holderPositions: Map<string, [number, number, number]>,
  _holderNodeIds: Map<string, string>,
  parentId?: string,
  constructorNames?: Set<string>,
): LayoutExtent {
  const defId = nextId('def');
  const clauseNodes: SceneNode[][] = [];
  const clausePipes: PipeInfo[][] = [];
  let maxClauseWidth = 0;
  let maxClauseDepth = 0;

  // Each predicate def gets its own scoped variable maps
  // so variables don't leak between sibling definitions
  const localHolderPositions = new Map<string, [number, number, number]>();
  const localHolderNodeIds = new Map<string, string>();

  // Layout each clause (disjunction stacked on Y)
  for (let i = 0; i < def.clauses.length; i++) {
    const clauseSceneNodes: SceneNode[] = [];
    const clauseScenePipes: PipeInfo[] = [];
    const clauseY = origin[1] - i * CLAUSE_SPACING_Y;
    const innerOrigin: [number, number, number] = [
      origin[0] + DEF_PADDING,
      clauseY,
      origin[2],
    ];

    const ext = layoutConjunction(
      def.clauses[i], innerOrigin, clauseSceneNodes, clauseScenePipes, localHolderPositions, localHolderNodeIds, defId, constructorNames,
    );
    maxClauseWidth = Math.max(maxClauseWidth, ext.width);
    maxClauseDepth = Math.max(maxClauseDepth, ext.depth);
    clauseNodes.push(clauseSceneNodes);
    clausePipes.push(clauseScenePipes);

    // Plane box for this clause (Z sized to content depth)
    const planeId = nextId('plane');
    const planeDepth = ext.depth + DEF_DEPTH_PAD;
    nodes.push({
      id: planeId,
      type: 'plane',
      label: `clause ${i + 1}`,
      position: [
        innerOrigin[0] + ext.width / 2 - APP_SIZE / 2,
        clauseY,
        origin[2] + planeDepth / 2,
      ],
      size: [ext.width + DEF_PADDING, 1.2, planeDepth + APP_SIZE],
      color: COLORS.plane,
      transparent: true,
      opacity: 0.15,
      parentId: defId,
      ports: [],
    });
  }

  // Outer definition box
  const totalWidth = maxClauseWidth + DEF_PADDING * 2;
  const totalHeight = def.clauses.length * CLAUSE_SPACING_Y + DEF_PADDING;
  const contentDepth = maxClauseDepth + DEF_DEPTH_PAD * 2;

  // Build ports from params
  const ports: PortInfo[] = def.params.map((p, i) => {
    const frac = def.params.length > 1 ? i / (def.params.length - 1) : 0.5;
    const portWorldPos: [number, number, number] = [
      origin[0] - PORT_SIZE,
      origin[1] - frac * (totalHeight - 1),
      origin[2],
    ];
    return {
      id: nextId('port'),
      name: p.name,
      side: 'left' as const,
      offset: frac,
      worldPos: portWorldPos,
    };
  });

  // Register param names as holder positions (for pipe inference within this def)
  for (const port of ports) {
    localHolderPositions.set(port.name, port.worldPos);
  }

  nodes.push({
    id: defId,
    type: 'definition',
    label: def.name,
    position: [
      origin[0] + totalWidth / 2 - APP_SIZE / 2,
      origin[1] - totalHeight / 2 + 0.5,
      origin[2] + contentDepth / 2,
    ],
    size: [totalWidth, totalHeight, contentDepth + APP_SIZE],
    color: COLORS.definition,
    transparent: true,
    opacity: 0.2,
    parentId,
    ports,
  });

  // Add all clause nodes and pipes
  for (const cn of clauseNodes) nodes.push(...cn);
  for (const cp of clausePipes) pipes.push(...cp);

  return { width: totalWidth, depth: contentDepth + APP_SIZE };
}

// ---- Type Definition ----

const VARIANT_SIZE = 0.8;
const FIELD_SIZE = 0.5;
const VARIANT_SPACING_Y = 1.4;
const FIELD_SPACING_X = 1.2;

function layoutTypeDef(
  typeDef: TypeDef,
  origin: [number, number, number],
  nodes: SceneNode[],
  parentId?: string,
): LayoutExtent {
  const defId = nextId('typedef');
  let maxVariantWidth = 0;

  // Layout each variant stacked on Y (sum type = disjunction)
  for (let vi = 0; vi < typeDef.variants.length; vi++) {
    const variant = typeDef.variants[vi];
    const variantY = origin[1] - vi * VARIANT_SPACING_Y;
    const isNullary = variant.fields.length === 0;

    // Variant constructor node
    const variantId = nextId('variant');
    const variantPos: [number, number, number] = [
      origin[0] + DEF_PADDING,
      variantY,
      origin[2],
    ];

    nodes.push({
      id: variantId,
      type: 'constructor',
      label: variant.name,
      position: variantPos,
      size: [VARIANT_SIZE, VARIANT_SIZE, VARIANT_SIZE],
      color: COLORS.constructor,
      transparent: isNullary,
      opacity: isNullary ? 0.7 : 1,
      parentId: defId,
      ports: [],
    });

    let variantWidth = VARIANT_SIZE;

    // Layout fields horizontally (product type = conjunction)
    for (let fi = 0; fi < variant.fields.length; fi++) {
      const field = variant.fields[fi];
      const fieldPos: [number, number, number] = [
        origin[0] + DEF_PADDING + VARIANT_SIZE / 2 + FIELD_SPACING_X * (fi + 1),
        variantY,
        origin[2],
      ];
      const fieldId = nextId('field');

      const typeLabel = field.type.kind === 'type_var' ? field.type.name
        : field.type.kind === 'type_app' ? field.type.constructor
        : '?';

      nodes.push({
        id: fieldId,
        type: 'holder',
        label: `${field.name}: ${typeLabel}`,
        position: fieldPos,
        size: [FIELD_SIZE, FIELD_SIZE, FIELD_SIZE],
        color: COLORS.field,
        transparent: true,
        opacity: 0.6,
        parentId: defId,
        ports: [],
      });

      variantWidth = FIELD_SPACING_X * (fi + 1) + FIELD_SIZE;
    }

    maxVariantWidth = Math.max(maxVariantWidth, variantWidth);
  }

  // Outer type definition box
  const totalWidth = maxVariantWidth + DEF_PADDING * 2;
  const totalHeight = Math.max(typeDef.variants.length * VARIANT_SPACING_Y, 1.0);

  const typeDefDepth = 1.2;
  nodes.push({
    id: defId,
    type: 'type_definition',
    label: typeDef.name,
    position: [
      origin[0] + totalWidth / 2 - APP_SIZE / 2,
      origin[1] - totalHeight / 2 + VARIANT_SPACING_Y / 2,
      origin[2],
    ],
    size: [totalWidth, totalHeight, typeDefDepth],
    color: COLORS.type_def,
    transparent: true,
    opacity: 0.15,
    parentId,
    ports: [],
  });

  return { width: totalWidth, depth: typeDefDepth };
}

// ---- Application ----

function layoutApplication(
  app: Application,
  pos: [number, number, number],
  nodes: SceneNode[],
  pipes: PipeInfo[],
  holderPositions: Map<string, [number, number, number]>,
  holderNodeIds: Map<string, string>,
  parentId?: string,
  constructorNames?: Set<string>,
): LayoutExtent {
  if (app.functor === '__node') return { width: 0, depth: 0 }; // node directive is invisible

  const isConstructor = constructorNames?.has(app.functor) ?? false;
  const appId = nextId(isConstructor ? 'ctor' : 'app');
  const color = isConstructor ? COLORS.constructor : appColor(app.functor);

  // Scale the cube height based on arg count so ports don't overlap
  const totalRows = Math.ceil(app.args.length / 2);
  const ARG_ROW_SPACING = 0.7; // vertical space per arg row
  const appHeight = Math.max(APP_SIZE, totalRows * ARG_ROW_SPACING);

  // Build ports from args
  const ports: PortInfo[] = app.args.map((arg, i) => {
    const side: 'left' | 'right' = i % 2 === 0 ? 'right' : 'left';
    const row = Math.floor(i / 2);
    const frac = totalRows > 1 ? row / (totalRows - 1) : 0.5;
    const xOff = side === 'right' ? APP_SIZE / 2 + PORT_SIZE : -APP_SIZE / 2 - PORT_SIZE;
    const yOff = (0.5 - frac) * (appHeight - ARG_ROW_SPACING * 0.5);
    const portPos: [number, number, number] = [
      pos[0] + xOff,
      pos[1] + yOff,
      pos[2],
    ];
    return {
      id: nextId('port'),
      name: arg.name,
      side,
      offset: frac,
      worldPos: portPos,
    };
  });

  nodes.push({
    id: appId,
    type: isConstructor ? 'constructor' : 'application',
    label: app.functor,
    position: pos,
    size: [APP_SIZE, appHeight, APP_SIZE],
    color,
    transparent: false,
    opacity: 1,
    parentId,
    ports,
  });

  // Layout arg values (holders, literals) and create pipes
  // Use appId as parent so arg terms become children of this application
  for (let i = 0; i < app.args.length; i++) {
    const arg = app.args[i];
    const port = ports[i];
    const dir = argDirection(app.functor, i);
    const [appEndColor, termEndColor] = pipeColorsForDirection(dir);
    layoutTermForPort(arg.value, port, appId, pos, nodes, pipes, holderPositions, holderNodeIds, appId, constructorNames, appEndColor, termEndColor);
  }

  return { width: APP_SIZE, depth: APP_SIZE };
}

// ---- Unification ----

function layoutUnification(
  uni: Unification,
  pos: [number, number, number],
  nodes: SceneNode[],
  pipes: PipeInfo[],
  holderPositions: Map<string, [number, number, number]>,
  holderNodeIds: Map<string, string>,
  parentId?: string,
  constructorNames?: Set<string>,
): LayoutExtent {
  // Left holder for the variable
  const holderId = nextId('holder');
  const holderPos: [number, number, number] = [pos[0], pos[1], pos[2]];

  nodes.push({
    id: holderId,
    type: 'holder',
    label: uni.variable,
    position: holderPos,
    size: [HOLDER_SIZE, HOLDER_SIZE, HOLDER_SIZE],
    color: COLORS.holder,
    transparent: true,
    opacity: 0.5,
    parentId,
    ports: [],
  });

  holderPositions.set(uni.variable, holderPos);
  holderNodeIds.set(uni.variable, holderId);

  // Right side: the term
  const termPos: [number, number, number] = [pos[0] + 1.5, pos[1], pos[2]];
  const termNodeId = layoutTerm(uni.term, termPos, nodes, pipes, holderPositions, holderNodeIds, parentId, constructorNames);

  // Pipe from holder to term (unification = bidirectional)
  pipes.push({
    id: nextId('pipe'),
    from: holderPos,
    to: termPos,
    color: COLORS.pipe_bidi,
    fromColor: COLORS.pipe_bidi,
    toColor: COLORS.pipe_bidi,
    fromNodeId: holderId,
    toNodeId: termNodeId ?? undefined,
  });

  return { width: 1.5 + HOLDER_SIZE, depth: HOLDER_SIZE };
}

// ---- Term layout (for standalone terms) ----

/** Returns the node ID of the created node (or null if no node was created) */
function layoutTerm(
  term: Term,
  pos: [number, number, number],
  nodes: SceneNode[],
  pipes: PipeInfo[],
  holderPositions: Map<string, [number, number, number]>,
  holderNodeIds: Map<string, string>,
  parentId?: string,
  constructorNames?: Set<string>,
): string | null {
  switch (term.kind) {
    case 'var': {
      // Check if this is a nullary constructor (e.g. `true`, `nil`)
      if (constructorNames?.has(term.name)) {
        const ctorId = nextId('ctor');
        nodes.push({
          id: ctorId,
          type: 'constructor',
          label: term.name,
          position: pos,
          size: [LITERAL_SIZE, LITERAL_SIZE, LITERAL_SIZE],
          color: COLORS.constructor,
          transparent: false,
          opacity: 1,
          parentId,
          ports: [],
        });
        return ctorId;
      }
      const existing = holderPositions.get(term.name);
      if (existing) {
        // Pipe to existing holder
        const existingNodeId = holderNodeIds.get(term.name);
        pipes.push({ id: nextId('pipe'), from: pos, to: existing, color: COLORS.pipe_bidi, fromColor: COLORS.pipe_bidi, toColor: COLORS.pipe_bidi, toNodeId: existingNodeId });
        return existingNodeId ?? null;
      }
      // New holder
      const holderId = nextId('holder');
      nodes.push({
        id: holderId,
        type: 'holder',
        label: term.name,
        position: pos,
        size: [HOLDER_SIZE, HOLDER_SIZE, HOLDER_SIZE],
        color: COLORS.holder,
        transparent: true,
        opacity: 0.5,
        parentId,
        ports: [],
      });
      holderPositions.set(term.name, pos);
      holderNodeIds.set(term.name, holderId);
      return holderId;
    }
    case 'literal': {
      const litId = nextId('lit');
      nodes.push({
        id: litId,
        type: 'literal',
        label: String(term.value),
        position: pos,
        size: [LITERAL_SIZE, LITERAL_SIZE, LITERAL_SIZE],
        color: COLORS.literal,
        transparent: false,
        opacity: 1,
        parentId,
        ports: [],
      });
      return litId;
    }
    case 'app_term': {
      // Treat as inline application
      const inlineApp: Application = {
        kind: 'application',
        functor: term.functor,
        args: term.args,
        loc: term.loc,
      };
      layoutApplication(inlineApp, pos, nodes, pipes, holderPositions, holderNodeIds, parentId, constructorNames);
      // The application node was just added as the last node
      return nodes[nodes.length - 1]?.id ?? null;
    }
    case 'rename':
      return null; // Rename terms are structural, not visual
  }
}

// ---- Layout a term attached to a port (creates pipe) ----

function layoutTermForPort(
  term: Term,
  port: PortInfo,
  appNodeId: string,
  parentPos: [number, number, number],
  nodes: SceneNode[],
  pipes: PipeInfo[],
  holderPositions: Map<string, [number, number, number]>,
  holderNodeIds: Map<string, string>,
  parentId?: string,
  constructorNames?: Set<string>,
  appEndColor: string = COLORS.pipe_bidi,
  termEndColor: string = COLORS.pipe_bidi,
): void {
  const offset = port.side === 'right' ? 1.2 : -1.2;
  const termPos: [number, number, number] = [
    parentPos[0] + offset,
    port.worldPos[1],
    parentPos[2],
  ];

  switch (term.kind) {
    case 'var': {
      // Check if this is a nullary constructor
      if (constructorNames?.has(term.name)) {
        const ctorId = nextId('ctor');
        nodes.push({
          id: ctorId,
          type: 'constructor',
          label: term.name,
          position: termPos,
          size: [LITERAL_SIZE, LITERAL_SIZE, LITERAL_SIZE],
          color: COLORS.constructor,
          transparent: false,
          opacity: 1,
          parentId,
          ports: [],
        });
        pipes.push({ id: nextId('pipe'), from: port.worldPos, to: termPos, color: appEndColor, fromColor: appEndColor, toColor: termEndColor, fromNodeId: appNodeId, toNodeId: ctorId });
        break;
      }
      const existing = holderPositions.get(term.name);
      if (existing) {
        // Pipe from port to existing holder
        const existingNodeId = holderNodeIds.get(term.name);
        pipes.push({ id: nextId('pipe'), from: port.worldPos, to: existing, color: appEndColor, fromColor: appEndColor, toColor: termEndColor, fromNodeId: appNodeId, toNodeId: existingNodeId });
      } else {
        // New holder
        const holderId = nextId('holder');
        nodes.push({
          id: holderId,
          type: 'holder',
          label: term.name,
          position: termPos,
          size: [HOLDER_SIZE, HOLDER_SIZE, HOLDER_SIZE],
          color: COLORS.holder,
          transparent: true,
          opacity: 0.5,
          parentId,
          ports: [],
        });
        holderPositions.set(term.name, termPos);
        holderNodeIds.set(term.name, holderId);
        pipes.push({ id: nextId('pipe'), from: port.worldPos, to: termPos, color: appEndColor, fromColor: appEndColor, toColor: termEndColor, fromNodeId: appNodeId, toNodeId: holderId });
      }
      break;
    }
    case 'literal': {
      const litId = nextId('lit');
      nodes.push({
        id: litId,
        type: 'literal',
        label: String(term.value),
        position: termPos,
        size: [LITERAL_SIZE, LITERAL_SIZE, LITERAL_SIZE],
        color: COLORS.literal,
        transparent: false,
        opacity: 1,
        parentId,
        ports: [],
      });
      pipes.push({ id: nextId('pipe'), from: port.worldPos, to: termPos, color: appEndColor, fromColor: appEndColor, toColor: termEndColor, fromNodeId: appNodeId, toNodeId: litId });
      break;
    }
    case 'app_term': {
      const inlineApp: Application = {
        kind: 'application',
        functor: term.functor,
        args: term.args,
        loc: term.loc,
      };
      layoutApplication(inlineApp, termPos, nodes, pipes, holderPositions, holderNodeIds, parentId, constructorNames);
      const inlineAppNodeId = nodes[nodes.length - 1]?.id;
      pipes.push({ id: nextId('pipe'), from: port.worldPos, to: termPos, color: appEndColor, fromColor: appEndColor, toColor: termEndColor, fromNodeId: appNodeId, toNodeId: inlineAppNodeId });
      break;
    }
    case 'rename':
      break;
  }
}
