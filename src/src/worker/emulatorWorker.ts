/**
 * Web Worker for GA144 emulation.
 *
 * Runs the GA144 chip at full speed in a background thread.
 * Communicates with the main thread via postMessage.
 */
import { GA144 } from '../core/ga144';
import type { MainToWorker, WorkerToMain, WorkerSnapshot } from './emulatorProtocol';
import { createVcoClocks } from './vcoClock';

const STEPS_PER_CHUNK = 50_000;
const SNAPSHOT_INTERVAL_MS = 50;  // 20 Hz
const IO_BATCH_INTERVAL_MS = 33; // 30 Hz

let ga144: GA144 | null = null;
let running = false;
let selectedCoord: number | null = null;
let lastIoSeq = 0;
let lastSnapshotTime = 0;
let lastIoBatchTime = 0;

function post(msg: WorkerToMain): void {
  self.postMessage(msg);
}

function sendSnapshot(): void {
  if (!ga144) return;
  const full = ga144.getSnapshot(selectedCoord ?? undefined);
  const snapshot: WorkerSnapshot = {
    nodeStates: full.nodeStates,
    nodeCoords: full.nodeCoords,
    activeCount: full.activeCount,
    totalSteps: full.totalSteps,
    selectedNode: full.selectedNode,
    totalEnergyPJ: full.totalEnergyPJ,
    chipPowerMW: full.chipPowerMW,
    totalSimTimeNS: full.totalSimTimeNS,
  };
  post({ type: 'snapshot', snapshot });
}

function sendIoBatch(): void {
  if (!ga144) return;
  const delta = ga144.getIoWritesDelta(lastIoSeq);
  if (delta.writes.length > 0 || delta.totalSeq !== lastIoSeq) {
    post({
      type: 'ioWriteBatch',
      batch: {
        writes: delta.writes,
        timestamps: delta.timestamps,
        startSeq: delta.startSeq,
        totalSeq: delta.totalSeq,
      },
    });
    lastIoSeq = delta.totalSeq;
  }
}

function runLoop(): void {
  if (!running || !ga144) {
    sendSnapshot();
    sendIoBatch();
    post({ type: 'stopped', reason: 'user' });
    return;
  }

  const hit = ga144.stepProgramN(STEPS_PER_CHUNK);

  const now = performance.now();
  if (now - lastSnapshotTime >= SNAPSHOT_INTERVAL_MS) {
    ga144.flushVcoTemperatures();
    sendSnapshot();
    lastSnapshotTime = now;
  }
  if (now - lastIoBatchTime >= IO_BATCH_INTERVAL_MS) {
    sendIoBatch();
    lastIoBatchTime = now;
  }

  if (hit) {
    running = false;
    sendSnapshot();
    sendIoBatch();
    post({ type: 'stopped', reason: 'breakpoint' });
    return;
  }

  if (ga144.getActiveCount() === 0) {
    // All nodes idle (blocked on ports / suspended). Keep the run loop alive
    // but yield longer — there's no work to do until an external event arrives
    // (serial data, user stop, etc.). Advance guest clock at host wall rate.
    setTimeout(runLoop, 50);
    return;
  }

  // Yield to process incoming messages (stop, selectNode, etc.)
  setTimeout(runLoop, 0);
}

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init': {
      if (typeof SharedArrayBuffer === 'undefined') {
        post({ type: 'error', message: 'SharedArrayBuffer is not available. The page must be served with Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers.' });
        return;
      }
      ga144 = new GA144('evb001');
      ga144.setRomData(msg.romData);
      ga144.reset();
      const vcoState = createVcoClocks();
      ga144.setVcoCounters(vcoState.counters);
      post({ type: 'ready' });
      sendSnapshot();
      break;
    }

    case 'loadBootStream':
      running = false;
      if (ga144) {
        ga144.reset();
        ga144.loadViaBootStream(msg.bytes);
        lastIoSeq = 0;
        sendSnapshot();
        sendIoBatch();
      }
      break;

    case 'run':
      running = true;
      lastSnapshotTime = performance.now();
      lastIoBatchTime = performance.now();
      runLoop();
      break;

    case 'stop':
      running = false;
      // runLoop will send 'stopped' on next iteration
      break;

    case 'step':
      if (ga144) {
        ga144.stepProgram();
        sendSnapshot();
        sendIoBatch();
      }
      break;

    case 'stepN':
      if (ga144) {
        ga144.stepProgramN(msg.count);
        sendSnapshot();
        sendIoBatch();
      }
      break;

    case 'reset':
      running = false;
      if (ga144) {
        ga144.reset();
        lastIoSeq = 0;
        sendSnapshot();
        sendIoBatch();
      }
      break;

    case 'selectNode':
      selectedCoord = msg.coord;
      if (ga144) sendSnapshot();
      break;
  }
};
