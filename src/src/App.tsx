import { useState, useRef, useCallback, useEffect } from 'react';
import { ThemeProvider, CssBaseline, Box } from '@mui/material';
import { theme } from './ui/theme';
import { MainLayout } from './ui/layout/MainLayout';
import { CodeEditor } from './ui/editor/CodeEditor';
import { DebugToolbar } from './ui/toolbar/DebugToolbar';
import { CubeRenderer } from './ui/cube3d/CubeRenderer';
import { EmulatorPanel } from './ui/emulator/EmulatorPanel';
import { CompileOutputPanel } from './ui/output/CompileOutputPanel';
import { useEmulator } from './hooks/useEmulator';
import { readUrlSource, updateUrlSource } from './ui/urlSource';
import { RecursePanel } from './ui/recurse/RecursePanel';

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
    setStepsPerFrame,
    setLanguage,
  } = useEmulator();

  const [activeTab, setActiveTab] = useState(0);
  const [urlSource, setUrlSource] = useState<string | null>(null);
  const editorSourceRef = useRef<string>('');

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

  const handleSourceChange = useCallback((source: string) => {
    editorSourceRef.current = source;
  }, []);

  const handleCompileFromEditor = useCallback((source: string) => {
    editorSourceRef.current = source;
    compileAndLoad(source);
    updateUrlSource(source);
  }, [compileAndLoad]);

  const handleCompileButton = useCallback(() => {
    if (editorSourceRef.current) {
      compileAndLoad(editorSourceRef.current);
      updateUrlSource(editorSourceRef.current);
    }
  }, [compileAndLoad]);

  if (!snapshot) return null;

  const sourceMap = cubeCompileResult?.sourceMap ?? null;

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
              if (lang === 'recurse') setActiveTab(0);
            }}
            onStep={step}
            onStepN={stepN}
            onRun={run}
            onStop={stop}
            onReset={reset}
            onSetStepsPerFrame={setStepsPerFrame}
          />
        }
        editorTab={
          language === 'recurse' ? (
            <RecursePanel />
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
                  initialSource={urlSource}
                />
              </Box>
            </>
          )
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
            ioWriteCount={snapshot.ioWriteCount}
          />
        }
      />
    </ThemeProvider>
  );
}

export default App;
