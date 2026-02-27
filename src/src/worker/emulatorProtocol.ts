/**
 * Message protocol between main thread and emulator Web Worker.
 */
import type { NodeState, NodeSnapshot } from '../core/types';

// ============================================================================
// Main → Worker messages
// ============================================================================

export type MainToWorker =
  | { type: 'init'; romData: Record<number, number[]> }
  | { type: 'loadBootStream'; bytes: Uint8Array }
  | { type: 'run' }
  | { type: 'stop' }
  | { type: 'step' }
  | { type: 'stepN'; count: number }
  | { type: 'reset' }
  | { type: 'selectNode'; coord: number | null }
  | { type: 'sendSerialInput'; bytes: number[]; baud: number };

// ============================================================================
// Worker → Main messages
// ============================================================================

/** Snapshot of chip state (excludes IO write arrays — those go via IoWriteBatch). */
export interface WorkerSnapshot {
  nodeStates: NodeState[];
  nodeCoords: number[];
  activeCount: number;
  totalSteps: number;
  selectedNode: NodeSnapshot | null;
  totalEnergyPJ: number;
  chipPowerMW: number;
  totalSimTimeNS: number;
}

/** Delta batch of IO writes since the last batch. */
export interface IoWriteBatch {
  writes: number[];
  timestamps: number[];
  startSeq: number;
  totalSeq: number;
}

export type WorkerToMain =
  | { type: 'snapshot'; snapshot: WorkerSnapshot }
  | { type: 'ioWriteBatch'; batch: IoWriteBatch }
  | { type: 'stopped'; reason: 'user' | 'breakpoint' | 'allSuspended' }
  | { type: 'ready' }
  | { type: 'error'; message: string };
