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
  PredicateDef, Application, Unification, Term,
} from '../../core/cube/ast';

// ---- Scene graph types ----

export type SceneNodeType =
  | 'definition'
  | 'application'
  | 'holder'
  | 'literal'
  | 'port'
  | 'plane';

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
}

export interface PipeInfo {
  id: string;
  from: [number, number, number];
  to: [number, number, number];
  color: string;
}

export interface SceneGraph {
  nodes: SceneNode[];
  pipes: PipeInfo[];
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
  pipe: '#44dddd',
  plane: '#335533',
  unknown: '#888888',
};

const BUILTINS = new Set(['plus', 'minus', 'times', 'greater', 'not', 'equal']);

function appColor(functor: string): string {
  if (BUILTINS.has(functor)) return COLORS.builtin;
  if (functor.startsWith('f18a.')) return COLORS.f18a;
  if (functor.startsWith('rom.')) return COLORS.rom;
  if (functor === '__node') return COLORS.unknown;
  return COLORS.user;
}

// ---- ID generation ----

let idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${idCounter++}`;
}

// ---- Layout constants ----

const ITEM_SPACING_X = 2.5;
const CLAUSE_SPACING_Y = 2.0;
const DEF_PADDING = 0.5;
const APP_SIZE = 1.0;
const HOLDER_SIZE = 0.5;
const LITERAL_SIZE = 0.6;
const PORT_SIZE = 0.25;

// ---- Main entry point ----

export function layoutAST(program: CubeProgram): SceneGraph {
  idCounter = 0;
  const nodes: SceneNode[] = [];
  const pipes: PipeInfo[] = [];
  const holderPositions = new Map<string, [number, number, number]>();

  layoutConjunction(program.conjunction, [0, 0, 0], nodes, pipes, holderPositions);

  return { nodes, pipes };
}

// ---- Conjunction layout (items along X) ----

function layoutConjunction(
  conj: Conjunction,
  origin: [number, number, number],
  nodes: SceneNode[],
  pipes: PipeInfo[],
  holderPositions: Map<string, [number, number, number]>,
): number {
  let xCursor = origin[0];

  for (const item of conj.items) {
    const width = layoutItem(item, [xCursor, origin[1], origin[2]], nodes, pipes, holderPositions);
    xCursor += width + ITEM_SPACING_X;
  }

  return xCursor - origin[0] - ITEM_SPACING_X;
}

// ---- Single item dispatch ----

function layoutItem(
  item: ConjunctionItem,
  pos: [number, number, number],
  nodes: SceneNode[],
  pipes: PipeInfo[],
  holderPositions: Map<string, [number, number, number]>,
): number {
  switch (item.kind) {
    case 'predicate_def':
      return layoutPredicateDef(item, pos, nodes, pipes, holderPositions);
    case 'application':
      return layoutApplication(item, pos, nodes, pipes, holderPositions);
    case 'unification':
      return layoutUnification(item, pos, nodes, pipes, holderPositions);
    case 'type_def':
      // Type defs are compile-time only; render as a small label
      nodes.push({
        id: nextId('typedef'),
        type: 'definition',
        label: item.name,
        position: pos,
        size: [1.2, 0.6, 0.6],
        color: COLORS.unknown,
        transparent: true,
        opacity: 0.3,
        ports: [],
      });
      return 1.2;
  }
}

// ---- Predicate definition ----

function layoutPredicateDef(
  def: PredicateDef,
  origin: [number, number, number],
  nodes: SceneNode[],
  pipes: PipeInfo[],
  holderPositions: Map<string, [number, number, number]>,
): number {
  const defId = nextId('def');
  const clauseNodes: SceneNode[][] = [];
  const clausePipes: PipeInfo[][] = [];
  let maxClauseWidth = 0;

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

    const width = layoutConjunction(
      def.clauses[i], innerOrigin, clauseSceneNodes, clauseScenePipes, holderPositions,
    );
    maxClauseWidth = Math.max(maxClauseWidth, width);
    clauseNodes.push(clauseSceneNodes);
    clausePipes.push(clauseScenePipes);

    // Plane box for this clause
    const planeId = nextId('plane');
    nodes.push({
      id: planeId,
      type: 'plane',
      label: `clause ${i + 1}`,
      position: [
        innerOrigin[0] + width / 2 - APP_SIZE / 2,
        clauseY,
        origin[2],
      ],
      size: [width + DEF_PADDING, 1.2, 1.2],
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

  // Register param names as holder positions (for pipe inference)
  for (const port of ports) {
    holderPositions.set(port.name, port.worldPos);
  }

  nodes.push({
    id: defId,
    type: 'definition',
    label: def.name,
    position: [
      origin[0] + totalWidth / 2 - APP_SIZE / 2,
      origin[1] - totalHeight / 2 + 0.5,
      origin[2],
    ],
    size: [totalWidth, totalHeight, 1.5],
    color: COLORS.definition,
    transparent: true,
    opacity: 0.2,
    ports,
  });

  // Add all clause nodes and pipes
  for (const cn of clauseNodes) nodes.push(...cn);
  for (const cp of clausePipes) pipes.push(...cp);

  return totalWidth;
}

// ---- Application ----

function layoutApplication(
  app: Application,
  pos: [number, number, number],
  nodes: SceneNode[],
  pipes: PipeInfo[],
  holderPositions: Map<string, [number, number, number]>,
): number {
  if (app.functor === '__node') return 0; // node directive is invisible

  const appId = nextId('app');
  const color = appColor(app.functor);

  // Build ports from args
  const ports: PortInfo[] = app.args.map((arg, i) => {
    const side: 'left' | 'right' = i % 2 === 0 ? 'right' : 'left';
    const row = Math.floor(i / 2);
    const totalRows = Math.ceil(app.args.length / 2);
    const frac = totalRows > 1 ? row / (totalRows - 1) : 0.5;
    const xOff = side === 'right' ? APP_SIZE / 2 + PORT_SIZE : -APP_SIZE / 2 - PORT_SIZE;
    const yOff = (0.5 - frac) * APP_SIZE * 0.8;
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
    type: 'application',
    label: app.functor,
    position: pos,
    size: [APP_SIZE, APP_SIZE, APP_SIZE],
    color,
    transparent: false,
    opacity: 1,
    ports,
  });

  // Layout arg values (holders, literals) and create pipes
  for (let i = 0; i < app.args.length; i++) {
    const arg = app.args[i];
    const port = ports[i];
    layoutTermForPort(arg.value, port, pos, nodes, pipes, holderPositions);
  }

  return APP_SIZE;
}

// ---- Unification ----

function layoutUnification(
  uni: Unification,
  pos: [number, number, number],
  nodes: SceneNode[],
  pipes: PipeInfo[],
  holderPositions: Map<string, [number, number, number]>,
): number {
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
    ports: [],
  });

  holderPositions.set(uni.variable, holderPos);

  // Right side: the term
  const termPos: [number, number, number] = [pos[0] + 1.5, pos[1], pos[2]];
  const termEnd = layoutTerm(uni.term, termPos, nodes, pipes, holderPositions);

  // Pipe from holder to term
  pipes.push({
    id: nextId('pipe'),
    from: holderPos,
    to: termPos,
    color: COLORS.pipe,
  });

  return 1.5 + termEnd;
}

// ---- Term layout (for standalone terms) ----

function layoutTerm(
  term: Term,
  pos: [number, number, number],
  nodes: SceneNode[],
  pipes: PipeInfo[],
  holderPositions: Map<string, [number, number, number]>,
): number {
  switch (term.kind) {
    case 'var': {
      const existing = holderPositions.get(term.name);
      if (existing) {
        // Pipe to existing holder
        pipes.push({ id: nextId('pipe'), from: pos, to: existing, color: COLORS.pipe });
        return 0;
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
        ports: [],
      });
      holderPositions.set(term.name, pos);
      return HOLDER_SIZE;
    }
    case 'literal': {
      nodes.push({
        id: nextId('lit'),
        type: 'literal',
        label: String(term.value),
        position: pos,
        size: [LITERAL_SIZE, LITERAL_SIZE, LITERAL_SIZE],
        color: COLORS.literal,
        transparent: false,
        opacity: 1,
        ports: [],
      });
      return LITERAL_SIZE;
    }
    case 'app_term': {
      // Treat as inline application
      const inlineApp: Application = {
        kind: 'application',
        functor: term.functor,
        args: term.args,
        loc: term.loc,
      };
      return layoutApplication(inlineApp, pos, nodes, pipes, holderPositions);
    }
    case 'rename':
      return 0; // Rename terms are structural, not visual
  }
}

// ---- Layout a term attached to a port (creates pipe) ----

function layoutTermForPort(
  term: Term,
  port: PortInfo,
  parentPos: [number, number, number],
  nodes: SceneNode[],
  pipes: PipeInfo[],
  holderPositions: Map<string, [number, number, number]>,
): void {
  const offset = port.side === 'right' ? 1.2 : -1.2;
  const termPos: [number, number, number] = [
    parentPos[0] + offset,
    port.worldPos[1],
    parentPos[2],
  ];

  switch (term.kind) {
    case 'var': {
      const existing = holderPositions.get(term.name);
      if (existing) {
        // Pipe from port to existing holder
        pipes.push({ id: nextId('pipe'), from: port.worldPos, to: existing, color: COLORS.pipe });
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
          ports: [],
        });
        holderPositions.set(term.name, termPos);
        pipes.push({ id: nextId('pipe'), from: port.worldPos, to: termPos, color: COLORS.pipe });
      }
      break;
    }
    case 'literal': {
      nodes.push({
        id: nextId('lit'),
        type: 'literal',
        label: String(term.value),
        position: termPos,
        size: [LITERAL_SIZE, LITERAL_SIZE, LITERAL_SIZE],
        color: COLORS.literal,
        transparent: false,
        opacity: 1,
        ports: [],
      });
      pipes.push({ id: nextId('pipe'), from: port.worldPos, to: termPos, color: COLORS.pipe });
      break;
    }
    case 'app_term': {
      const inlineApp: Application = {
        kind: 'application',
        functor: term.functor,
        args: term.args,
        loc: term.loc,
      };
      layoutApplication(inlineApp, termPos, nodes, pipes, holderPositions);
      pipes.push({ id: nextId('pipe'), from: port.worldPos, to: termPos, color: COLORS.pipe });
      break;
    }
    case 'rename':
      break;
  }
}
