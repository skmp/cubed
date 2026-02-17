import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { GA144 } from '../core/ga144';
import type { GA144Snapshot, CompileError, CompiledProgram } from '../core/types';
import { ROM_DATA } from '../core/rom-data';
import { compile } from '../core/assembler';
import { compileCube, tokenizeCube, parseCube } from '../core/cube';
import type { CubeProgram, CubeCompileResult } from '../core/cube';
import type { EditorLanguage } from '../ui/editor/CodeEditor';
import { buildBootStream } from '../core/bootstream';

function downloadBootStream(compiled: CompiledProgram): void {
  const { bytes } = buildBootStream(compiled.nodes);
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bootstream.bin';
  a.click();
  URL.revokeObjectURL(url);
}

export function useEmulator() {
  const ga144 = useMemo(() => {
    const chip = new GA144('evb001');
    chip.setRomData(ROM_DATA);
    return chip;
  }, []);
  const [selectedCoord, setSelectedCoord] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<GA144Snapshot | null>(() => {
    return ga144.getSnapshot();
  });
  const [isRunning, setIsRunning] = useState(false);
  const [compileErrors, setCompileErrors] = useState<CompileError[]>([]);
  const [stepsPerFrame, setStepsPerFrame] = useState(1000);
  const [language, setLanguage] = useState<EditorLanguage>('cube');
  const [cubeAst, setCubeAst] = useState<CubeProgram | null>(null);
  const [cubeCompileResult, setCubeCompileResult] = useState<CubeCompileResult | null>(null);
  const [compiledProgram, setCompiledProgram] = useState<CompiledProgram | null>(null);
  const runningRef = useRef(false);
  const animFrameRef = useRef<number>(0);

  // Cleanup
  useEffect(() => {
    return () => {
      runningRef.current = false;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  const updateSnapshot = useCallback(() => {
    setSnapshot(ga144.getSnapshot(selectedCoord ?? undefined));
  }, [ga144, selectedCoord]);

  const step = useCallback(() => {
    ga144.stepProgram();
    updateSnapshot();
  }, [ga144, updateSnapshot]);

  const stepN = useCallback((n: number) => {
    ga144.stepProgramN(n);
    updateSnapshot();
  }, [ga144, updateSnapshot]);

  const run = useCallback(() => {
    runningRef.current = true;
    setIsRunning(true);

    const tick = () => {
      if (!runningRef.current) {
        setIsRunning(false);
        return;
      }
      const hit = ga144.stepProgramN(stepsPerFrame);
      updateSnapshot();
      if (hit) {
        runningRef.current = false;
        setIsRunning(false);
        return;
      }
      animFrameRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, [ga144, stepsPerFrame, updateSnapshot]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setIsRunning(false);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
  }, []);

  const reset = useCallback(() => {
    stop();
    ga144.reset();
    updateSnapshot();
  }, [ga144, stop, updateSnapshot]);

  const compileAndLoad = useCallback((source: string, options?: { download?: boolean }) => {
    stop();
    ga144.reset();

    if (language === 'cube') {
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

    if (language === 'cube') {
      const result = compileCube(source);
      const allDiagnostics = [...result.errors, ...(result.warnings ?? [])];
      setCompileErrors(allDiagnostics);
      setCubeCompileResult(result.errors.length === 0 ? result : null);
      setCompiledProgram(result.errors.length === 0 ? result : null);
      if (result.errors.length === 0) {
        ga144.load(result);
        if (options?.download) downloadBootStream(result);
      }
    } else {
      const result = compile(source);
      setCompileErrors(result.errors);
      setCubeCompileResult(null);
      setCompiledProgram(result.errors.length === 0 ? result : null);
      if (result.errors.length === 0) {
        ga144.load(result);
        if (options?.download) downloadBootStream(result);
      }
    }
    updateSnapshot();
  }, [stop, updateSnapshot, language, ga144]);

  const selectNode = useCallback((coord: number | null) => {
    setSelectedCoord(coord);
    setSnapshot(ga144.getSnapshot(coord ?? undefined));
  }, [ga144]);

  return {
    snapshot,
    selectedCoord,
    isRunning,
    compileErrors,
    stepsPerFrame,
    language,
    cubeAst,
    cubeCompileResult,
    compiledProgram,
    step,
    stepN,
    run,
    stop,
    reset,
    compileAndLoad,
    selectNode,
    setStepsPerFrame,
    setLanguage,
  };
}
