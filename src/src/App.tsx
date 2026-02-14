import { useRef, useCallback } from 'react';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { theme } from './ui/theme';
import { MainLayout } from './ui/layout/MainLayout';
import { ChipGrid } from './ui/chip/ChipGrid';
import { NodeDetailPanel } from './ui/detail/NodeDetailPanel';
import { CodeEditor } from './ui/editor/CodeEditor';
import { DebugToolbar } from './ui/toolbar/DebugToolbar';
import { useEmulator } from './hooks/useEmulator';

function App() {
  const {
    snapshot,
    selectedCoord,
    isRunning,
    compileErrors,
    stepsPerFrame,
    language,
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

  const editorSourceRef = useRef<string>('');

  const handleCompileFromEditor = useCallback((source: string) => {
    editorSourceRef.current = source;
    compileAndLoad(source);
  }, [compileAndLoad]);

  const handleCompileButton = useCallback(() => {
    if (editorSourceRef.current) {
      compileAndLoad(editorSourceRef.current);
    }
  }, [compileAndLoad]);

  if (!snapshot) return null;

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <MainLayout
        toolbar={
          <DebugToolbar
            isRunning={isRunning}
            activeCount={snapshot.activeCount}
            totalSteps={snapshot.totalSteps}
            stepsPerFrame={stepsPerFrame}
            language={language}
            onStep={step}
            onStepN={stepN}
            onRun={run}
            onStop={stop}
            onReset={reset}
            onCompile={handleCompileButton}
            onSetStepsPerFrame={setStepsPerFrame}
            onSetLanguage={setLanguage}
          />
        }
        chipGrid={
          <ChipGrid
            nodeStates={snapshot.nodeStates}
            nodeCoords={snapshot.nodeCoords}
            selectedCoord={selectedCoord}
            onNodeClick={selectNode}
          />
        }
        editor={
          <CodeEditor
            language={language}
            onCompile={handleCompileFromEditor}
            errors={compileErrors}
          />
        }
        detailPanel={
          <NodeDetailPanel node={snapshot.selectedNode} />
        }
      />
    </ThemeProvider>
  );
}

export default App;
