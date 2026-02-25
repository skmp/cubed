// 18-bit word representation (stored as standard JS number, masked to 18 bits)
export type Word18 = number;

export const WORD_MASK = 0x3FFFF;  // 18-bit mask
export const XOR_ENCODING = 0x15555;

export const NodeState = {
  RUNNING: 'running',
  BLOCKED_READ: 'blocked_read',
  BLOCKED_WRITE: 'blocked_write',
  SUSPENDED: 'suspended',
} as const;
export type NodeState = typeof NodeState[keyof typeof NodeState];

export const PortIndex = {
  LEFT: 0,
  UP: 1,
  DOWN: 2,
  RIGHT: 3,
} as const;
export type PortIndex = typeof PortIndex[keyof typeof PortIndex];

export interface F18ARegisters {
  P: number;
  I: Word18;
  A: Word18;
  B: number;
  T: Word18;
  S: Word18;
  R: Word18;
  IO: Word18;
}

export interface ThermalSnapshot {
  temperature: number;
  totalEnergy: number;
  simulatedTime: number;
  lastJitteredTime: number;
}

export interface NodeSnapshot {
  coord: number;
  index: number;
  state: NodeState;
  registers: F18ARegisters;
  dstack: Word18[];
  rstack: Word18[];
  ram: Word18[];
  rom: Word18[];
  slotIndex: number;
  stepCount: number;
  thermal: ThermalSnapshot;
  currentReadingPort: string | null;
  currentWritingPort: string | null;
}

export interface GA144Snapshot {
  nodeStates: NodeState[];   // 144 entries
  nodeCoords: number[];      // 144 entries
  activeCount: number;
  totalSteps: number;
  selectedNode: NodeSnapshot | null;
  ioWrites: number[];        // IO register writes (ring buffer)
  ioWriteTimestamps: number[]; // Global step count when each IO write occurred
  ioWriteJitter: Float32Array; // Jittered execution time (ns) at each IO write
  ioWriteStart: number;      // Start index for ring buffer
  ioWriteCount: number;      // Number of valid entries in ring buffer
  ioWriteSeq: number;        // Total writes seen (monotonic sequence)
  totalEnergyPJ: number;     // Cumulative energy dissipated across all nodes (picojoules)
  chipPowerMW: number;       // Instantaneous chip power (milliwatts)
  totalSimTimeNS: number;    // Max simulated time across all nodes (nanoseconds)
}

export interface PortHandler {
  read: () => boolean;
  write: (value: Word18) => void;
}

export interface CompiledNode {
  coord: number;
  mem: (Word18 | null)[];
  len: number;
  a?: number;
  b?: number;
  io?: number;
  p?: number;
  stack?: number[];
  symbols?: Map<string, number>;
}

export interface CompiledProgram {
  nodes: CompiledNode[];
  errors: CompileError[];
}

export interface CompileError {
  line: number;
  col: number;
  message: string;
}
