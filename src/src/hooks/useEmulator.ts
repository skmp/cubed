import { useState, useCallback, useRef, useEffect } from 'react';
import type { GA144Snapshot, CompileError, CompiledProgram } from '../core/types';
import { ROM_DATA } from '../core/rom-data';
import { compile } from '../core/assembler';
import { compileCube, tokenizeCube, parseCube } from '../core/cube';
import type { CubeProgram, CubeCompileResult } from '../core/cube';
import type { EditorLanguage } from '../ui/editor/CodeEditor';
import { buildBootStream } from '../core/bootstream';
import type { MainToWorker, WorkerToMain, WorkerSnapshot } from '../worker/emulatorProtocol';
import { IoWriteBuffer } from '../worker/ioWriteBuffer';

export function useEmulator() {
  const workerRef = useRef<Worker | null>(null);
  const ioBufferRef = useRef(new IoWriteBuffer());
  const workerSnapshotRef = useRef<WorkerSnapshot | null>(null);

  const [snapshot, setSnapshot] = useState<GA144Snapshot | null>(null);
  const [selectedCoord, setSelectedCoord] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [compileErrors, setCompileErrors] = useState<CompileError[]>([]);
  const [language, setLanguage] = useState<EditorLanguage>('cube');
  const [cubeAst, setCubeAst] = useState<CubeProgram | null>(null);
  const [cubeCompileResult, setCubeCompileResult] = useState<CubeCompileResult | null>(null);
  const [compiledProgram, setCompiledProgram] = useState<CompiledProgram | null>(null);
  const [bootStreamBytes, setBootStreamBytes] = useState<Uint8Array | null>(null);
  const [emulatorError, setEmulatorError] = useState<string | null>(null);

  // Compose a GA144Snapshot-compatible object from worker snapshot + IO buffer
  const buildSnapshot = useCallback((): GA144Snapshot | null => {
    const ws = workerSnapshotRef.current;
    if (!ws) return null;
    const io = ioBufferRef.current;
    return {
      nodeStates: ws.nodeStates,
      nodeCoords: ws.nodeCoords,
      activeCount: ws.activeCount,
      totalSteps: ws.totalSteps,
      selectedNode: ws.selectedNode,
      ioWrites: io.writes,
      ioWriteTimestamps: io.timestamps,
      ioWriteJitter: new Float32Array(0), // not used by UI
      ioWriteStart: io.start,
      ioWriteCount: io.count,
      ioWriteSeq: io.seq,
      totalEnergyPJ: ws.totalEnergyPJ,
      chipPowerMW: ws.chipPowerMW,
      totalSimTimeNS: ws.totalSimTimeNS,
    };
  }, []);

  // Initialize worker
  useEffect(() => {
    const worker = new Worker(
      new URL('../worker/emulatorWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'ready':
          break;
        case 'error':
          setEmulatorError(msg.message);
          break;
        case 'snapshot':
          workerSnapshotRef.current = msg.snapshot;
          setSnapshot(buildSnapshot());
          break;
        case 'ioWriteBatch':
          ioBufferRef.current.appendBatch(msg.batch);
          setSnapshot(buildSnapshot());
          break;
        case 'stopped':
          setIsRunning(false);
          break;
      }
    };

    worker.postMessage({ type: 'init', romData: ROM_DATA } satisfies MainToWorker);
    return () => worker.terminate();
  }, [buildSnapshot]);

  const post = useCallback((msg: MainToWorker) => {
    workerRef.current?.postMessage(msg);
  }, []);

  const step = useCallback(() => post({ type: 'step' }), [post]);

  const stepN = useCallback((n: number) => post({ type: 'stepN', count: n }), [post]);

  const run = useCallback(() => {
    setIsRunning(true);
    post({ type: 'run' });
  }, [post]);

  const stop = useCallback(() => {
    post({ type: 'stop' });
  }, [post]);

  const reset = useCallback(() => {
    ioBufferRef.current.reset();
    post({ type: 'reset' });
  }, [post]);

  const compileAndLoad = useCallback((source: string, options?: { asLanguage?: EditorLanguage }) => {
    const effectiveLang = options?.asLanguage ?? language;

    if (effectiveLang === 'cube') {
      // Parse AST for 3D renderer before full compilation
      const { tokens, errors: tokErrors } = tokenizeCube(source);
      if (tokErrors.length === 0) {
        const { ast, errors: parseErrors } = parseCube(tokens);
        setCubeAst(parseErrors.length === 0 ? ast : null);
      } else {
        setCubeAst(null);
      }
    } else {
      setCubeAst(null);
    }

    if (effectiveLang === 'cube') {
      const result = compileCube(source);
      const allDiagnostics = [...result.errors, ...(result.warnings ?? [])];
      setCompileErrors(allDiagnostics);
      setCubeCompileResult(result.errors.length === 0 ? result : null);
      setCompiledProgram(result.errors.length === 0 ? result : null);
      if (result.errors.length === 0) {
        const bytes = buildBootStream(result.nodes).bytes;
        setBootStreamBytes(bytes);
        ioBufferRef.current.reset();
        post({ type: 'loadBootStream', bytes });
      }
    } else {
      const result = compile(source);
      setCompileErrors(result.errors);
      setCubeCompileResult(null);
      setCompiledProgram(result.errors.length === 0 ? result : null);
      if (result.errors.length === 0) {
        const bytes = buildBootStream(result.nodes).bytes;
        setBootStreamBytes(bytes);
        ioBufferRef.current.reset();
        post({ type: 'loadBootStream', bytes });
      }
    }
  }, [language, post]);

  const selectNode = useCallback((coord: number | null) => {
    setSelectedCoord(coord);
    post({ type: 'selectNode', coord });
  }, [post]);

  return {
    snapshot,
    selectedCoord,
    isRunning,
    compileErrors,
    language,
    cubeAst,
    cubeCompileResult,
    compiledProgram,
    bootStreamBytes,
    emulatorError,
    step,
    stepN,
    run,
    stop,
    reset,
    compileAndLoad,
    selectNode,
    setLanguage,
  };
}
