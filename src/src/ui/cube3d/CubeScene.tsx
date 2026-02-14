import { OrbitControls, Grid } from '@react-three/drei';
import type { SceneGraph } from './layoutEngine';
import { DefinitionCube } from './objects/DefinitionCube';
import { ApplicationCube } from './objects/ApplicationCube';
import { HolderCube } from './objects/HolderCube';
import { LiteralCube } from './objects/LiteralCube';
import { PlaneBox } from './objects/PlaneBox';
import { Pipe } from './objects/Pipe';

interface CubeSceneProps {
  sceneGraph: SceneGraph;
  selectedId: string | null;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
}

export function CubeScene({ sceneGraph, selectedId, hoveredId, onHover, onClick }: CubeSceneProps) {
  const activeId = hoveredId ?? selectedId;

  return (
    <>
      {/* Camera and controls */}
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.1}
        minDistance={2}
        maxDistance={30}
      />

      {/* Lighting */}
      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 10, 5]} intensity={0.8} />
      <directionalLight position={[-3, 5, -3]} intensity={0.3} />

      {/* Ground grid */}
      <Grid
        position={[0, -1, 0]}
        cellSize={1}
        cellColor="#333333"
        sectionSize={5}
        sectionColor="#555555"
        fadeDistance={25}
        fadeStrength={1}
        infiniteGrid
      />

      {/* Scene nodes */}
      {sceneGraph.nodes.map(node => {
        switch (node.type) {
          case 'definition':
            return (
              <DefinitionCube
                key={node.id}
                node={node}
                selected={node.id === activeId}
                onHover={onHover}
                onClick={onClick}
              />
            );
          case 'application':
            return (
              <ApplicationCube
                key={node.id}
                node={node}
                selected={node.id === activeId}
                onHover={onHover}
                onClick={onClick}
              />
            );
          case 'holder':
            return (
              <HolderCube
                key={node.id}
                node={node}
                selected={node.id === activeId}
                onHover={onHover}
                onClick={onClick}
              />
            );
          case 'literal':
            return (
              <LiteralCube
                key={node.id}
                node={node}
                selected={node.id === activeId}
                onHover={onHover}
                onClick={onClick}
              />
            );
          case 'plane':
            return <PlaneBox key={node.id} node={node} />;
          default:
            return null;
        }
      })}

      {/* Pipes */}
      {sceneGraph.pipes.map(pipe => (
        <Pipe key={pipe.id} pipe={pipe} />
      ))}
    </>
  );
}
