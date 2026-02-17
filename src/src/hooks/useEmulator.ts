import { useState, useCallback, useRef, useEffect } from 'react';
import { GA144 } from '../core/ga144';
import type { GA144Snapshot, CompileError, CompiledProgram } from '../core/types';
import { ROM_DATA } from '../core/rom-data';
import { compile } from '../core/assembler';
import { compileCube, tokenizeCube, parseCube } from '../core/cube';
import type { CubeProgram, CubeCompileResult } from '../core/cube';
import type { EditorLanguage } from '../ui/editor/CodeEditor';

export function useEmulator() {
  const ga144Ref = useRef<GA144 | null>(null);
  const [selectedCoord, setSelectedCoord] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<GA144Snapshot | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [compileErrors, setCompileErrors] = useState<CompileError[]>([]);
  const [stepsPerFrame, setStepsPerFrame] = useState(1000);
  const [language, setLanguage] = useState<EditorLanguage>('cube');
  const [cubeAst, setCubeAst] = useState<CubeProgram | null>(null);
  const [cubeCompileResult, setCubeCompileResult] = useState<CubeCompileResult | null>(null);
  const [compiledProgram, setCompiledProgram] = useState<CompiledProgram | null>(null);
  const runningRef = useRef(false);
  const animFrameRef = useRef<number>(0);

  // Initialize
  useEffect(() => {
    const chip = new GA144('evb001');
    chip.setRomData(ROM_DATA);
    ga144Ref.current = chip;
    setSnapshot(chip.getSnapshot(selectedCoord ?? undefined));
    return () => {
      runningRef.current = false;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  const updateSnapshot = useCallback(() => {
    if (ga144Ref.current) {
      setSnapshot(ga144Ref.current.getSnapshot(selectedCoord ?? undefined));
    }
  }, [selectedCoord]);

  const step = useCallback(() => {
    if (ga144Ref.current) {
      ga144Ref.current.stepProgram();
      updateSnapshot();
    }
  }, [updateSnapshot]);

  const stepN = useCallback((n: number) => {
    if (ga144Ref.current) {
      ga144Ref.current.stepProgramN(n);
      updateSnapshot();
    }
  }, [updateSnapshot]);

  const run = useCallback(() => {
    if (!ga144Ref.current) return;
    runningRef.current = true;
    setIsRunning(true);

    const tick = () => {
      if (!runningRef.current || !ga144Ref.current) {
        setIsRunning(false);
        return;
      }
      const hit = ga144Ref.current.stepProgramN(stepsPerFrame);
      updateSnapshot();
      if (hit) {
        runningRef.current = false;
        setIsRunning(false);
        return;
      }
      animFrameRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, [stepsPerFrame, updateSnapshot]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setIsRunning(false);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
  }, []);

  const reset = useCallback(() => {
    stop();
    if (ga144Ref.current) {
      ga144Ref.current.reset();
      updateSnapshot();
    }
  }, [stop, updateSnapshot]);

  const compileAndLoad = useCallback((source: string) => {
    if (!ga144Ref.current) return;
    stop();
    ga144Ref.current.reset();

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
        ga144Ref.current.load(result);
      }
    } else {
      const result = compile(source);
      setCompileErrors(result.errors);
      setCubeCompileResult(null);
      setCompiledProgram(result.errors.length === 0 ? result : null);
      if (result.errors.length === 0) {
        ga144Ref.current.load(result);
      }
    }
    updateSnapshot();
  }, [stop, updateSnapshot, language]);

  const selectNode = useCallback((coord: number | null) => {
    setSelectedCoord(coord);
    if (ga144Ref.current) {
      setSnapshot(ga144Ref.current.getSnapshot(coord ?? undefined));
    }
  }, []);

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
