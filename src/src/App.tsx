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
    step,
    stepN,
    run,
    stop,
    reset,
    compileAndLoad,
    selectNode,
    setStepsPerFrame,
  } = useEmulator();

  const editorSourceRef = useRef<string>('');

  const handleCompileFromEditor = useCallback((source: string) => {
    editorSourceRef.current = source;
    compileAndLoad(source);
  }, [compileAndLoad]);

  const handleCompileButton = useCallback(() => {
    // Trigger compile from the current editor contents
    // The editor stores its latest source via onCompile callback
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
            onStep={step}
            onStepN={stepN}
            onRun={run}
            onStop={stop}
            onReset={reset}
            onCompile={handleCompileButton}
            onSetStepsPerFrame={setStepsPerFrame}
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
