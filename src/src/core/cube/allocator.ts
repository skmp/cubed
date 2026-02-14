/**
 * Node allocator for CUBE programs.
 * Maps CUBE program structure to GA144 nodes.
 *
 * Phase 1: Single-node allocation only.
 * - All code goes to one node (default 408, center of grid).
 * - The `node N` directive overrides the target.
 * - Multi-node allocation (disjunction → multiple nodes) deferred.
 */
import type { ResolvedProgram } from './resolver';

export interface AllocationPlan {
  /** Primary node coordinate for this program */
  nodeCoord: number;
}

export function allocateNodes(resolved: ResolvedProgram): AllocationPlan {
  return {
    nodeCoord: resolved.nodeCoord,
  };
}
