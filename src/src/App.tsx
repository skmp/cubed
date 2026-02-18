import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { ThemeProvider, CssBaseline, Box } from '@mui/material';
import { theme } from './ui/theme';
import { MainLayout } from './ui/layout/MainLayout';
import { CodeEditor } from './ui/editor/CodeEditor';
import { DebugToolbar } from './ui/toolbar/DebugToolbar';
import { CubeRenderer } from './ui/cube3d/CubeRenderer';
import { WysiwygEditor } from './ui/cube3d/WysiwygEditor';
import { EmulatorPanel } from './ui/emulator/EmulatorPanel';
import { CompileOutputPanel } from './ui/output/CompileOutputPanel';
import { useEmulator } from './hooks/useEmulator';
import { readUrlSource, updateUrlSource } from './ui/urlSource';
import { RecursePanel } from './ui/recurse/RecursePanel';
import { BootStreamModal } from './ui/toolbar/BootStreamModal';
import { ArrayForthViewer } from './ui/arrayforth/ArrayForthViewer';
import { decompile } from './core/decompiler';
import { useEditorStore } from './stores/editorStore';

function App() {
  const {
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
    clearBootStream,
    bootStreamBytes,
    setStepsPerFrame,
    setLanguage,
  } = useEmulator();

  const [activeTab, setActiveTab] = useState(1); // Default to Editor tab (index 1 now)
  const [urlSource, setUrlSource] = useState<string | null>(null);
  const editorSourceRef = useRef<string>('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync cubeAst to editorStore when text changes produce a new AST
  const editorStoreSource = useEditorStore(s => s.source);
  const editorStoreMutationSource = useEditorStore(s => s.mutationSource);

  useEffect(() => {
    if (cubeAst && language === 'cube') {
      // Only update store from text if the mutation didn't originate from 3D
      if (editorStoreMutationSource !== '3d') {
        useEditorStore.getState().setAstFromText(cubeAst, editorSourceRef.current);
      }
    }
  }, [cubeAst, language, editorStoreMutationSource]);

  // When 3D editor mutates the AST, recompile
  useEffect(() => {
    if (editorStoreMutationSource === '3d' && editorStoreSource) {
      compileAndLoad(editorStoreSource, { asLanguage: 'cube' });
      editorSourceRef.current = editorStoreSource;
      updateUrlSource(editorStoreSource);
    }
  }, [editorStoreSource, editorStoreMutationSource, compileAndLoad]);

  // Load source from URL ?src= on mount
  useEffect(() => {
    readUrlSource().then(source => {
      if (source) {
        setUrlSource(source);
        editorSourceRef.current = source;
        compileAndLoad(source);
      }
    });
  }, [compileAndLoad]);

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleSourceChange = useCallback((source: string) => {
    editorSourceRef.current = source;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      compileAndLoad(source);
      updateUrlSource(source);
    }, 500);
  }, [compileAndLoad]);

  const handleCompileFromEditor = useCallback((source: string) => {
    editorSourceRef.current = source;
    compileAndLoad(source, { download: true });
    updateUrlSource(source);
  }, [compileAndLoad]);

  const handleCompileButton = useCallback(() => {
    if (editorSourceRef.current) {
      compileAndLoad(editorSourceRef.current, { download: true });
      updateUrlSource(editorSourceRef.current);
    }
  }, [compileAndLoad]);

  const handleRecurseOutput = useCallback((output: string) => {
    compileAndLoad(output, { asLanguage: 'cube' });
  }, [compileAndLoad]);

  if (!snapshot) return null;

  const sourceMap = cubeCompileResult?.sourceMap ?? null;
  const arrayforthSource = useMemo(
    () => compiledProgram?.nodes ? decompile(compiledProgram.nodes) : '( no compiled program )',
    [compiledProgram]
  );

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <MainLayout
        activeTab={activeTab}
        onTabChange={setActiveTab}
        toolbar={
          <DebugToolbar
            activeCount={snapshot.activeCount}
            totalSteps={snapshot.totalSteps}
            language={language}
            isRunning={isRunning}
            stepsPerFrame={stepsPerFrame}
            onCompile={handleCompileButton}
            onSetLanguage={(lang) => {
              setLanguage(lang);
              if (lang === 'recurse') setActiveTab(1);
            }}
            onStep={step}
            onStepN={stepN}
            onRun={run}
            onStop={stop}
            onReset={reset}
            onSetStepsPerFrame={setStepsPerFrame}
          />
        }
        wysiwygTab={
          <WysiwygEditor />
        }
        editorTab={
          language === 'recurse' ? (
            <RecursePanel onOutputChange={handleRecurseOutput} />
          ) : (
            <>
              {language === 'cube' && (
                <Box sx={{
                  width: 510,
                  flexShrink: 0,
                  overflow: 'hidden',
                  borderRight: '1px solid #333',
                }}>
                  <CubeRenderer ast={cubeAst} />
                </Box>
              )}
              <Box sx={{ flex: 1, overflow: 'hidden' }}>
                <CodeEditor
                  language={language}
                  onCompile={handleCompileFromEditor}
                  onSourceChange={handleSourceChange}
                  errors={compileErrors}
                  compiledNodes={compiledProgram?.nodes}
                  initialSource={urlSource}
                />
              </Box>
            </>
          )
        }
        arrayforthTab={
          <ArrayForthViewer source={arrayforthSource} />
        }
        emulatorTab={
          <EmulatorPanel
            nodeStates={snapshot.nodeStates}
            nodeCoords={snapshot.nodeCoords}
            selectedCoord={selectedCoord}
            selectedNode={snapshot.selectedNode}
            sourceMap={sourceMap}
            onNodeClick={selectNode}
          />
        }
        outputTab={
          <CompileOutputPanel
            cubeResult={cubeCompileResult}
            compiledProgram={compiledProgram}
            language={language}
            ioWrites={snapshot.ioWrites}
            ioWriteTimestamps={snapshot.ioWriteTimestamps}
            ioWriteCount={snapshot.ioWriteCount}
            ioWriteStart={snapshot.ioWriteStart}
            ioWriteSeq={snapshot.ioWriteSeq}
          />
        }
      />
      <BootStreamModal bytes={bootStreamBytes} onClose={clearBootStream} />
    </ThemeProvider>
  );
}

export default App;
