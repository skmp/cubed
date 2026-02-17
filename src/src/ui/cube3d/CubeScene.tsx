import { useEffect, useRef, useMemo, type ReactNode } from 'react';
import { useThree } from '@react-three/fiber';
import { OrbitControls, Grid } from '@react-three/drei';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SceneGraph, SceneNode } from './layoutEngine';
import { DefinitionCube } from './objects/DefinitionCube';
import { ApplicationCube } from './objects/ApplicationCube';
import { HolderCube } from './objects/HolderCube';
import { LiteralCube } from './objects/LiteralCube';
import { PlaneBox } from './objects/PlaneBox';
import { ConstructorCube } from './objects/ConstructorCube';
import { TypeDefCube } from './objects/TypeDefCube';
import { Pipe } from './objects/Pipe';

/** Resets camera to frame the current scene graph whenever resetKey changes */
function CameraReset({ sceneGraph, resetKey }: { sceneGraph: SceneGraph; resetKey: number }) {
  const { camera, controls } = useThree();
  const initialReset = useRef(true);

  useEffect(() => {
    if (sceneGraph.nodes.length === 0) return;

    // Compute bounding box of all nodes
    const box = new THREE.Box3();
    for (const node of sceneGraph.nodes) {
      const [x, y, z] = node.position;
      const [w, h, d] = node.size;
      box.expandByPoint(new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2));
      box.expandByPoint(new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2));
    }

    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z, 2);
    const dist = maxDim * 1.5;

    // Position camera looking at center from a 45-degree angle
    camera.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist * 0.7);
    camera.lookAt(center);

    // Update orbit controls target
    const orbit = controls as OrbitControlsImpl | undefined;
    if (orbit) {
      orbit.target.copy(center);
      orbit.update();
    }

    initialReset.current = false;
  }, [resetKey, sceneGraph, camera, controls]);

  return null;
}

interface CubeSceneProps {
  sceneGraph: SceneGraph;
  selectedId: string | null;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
  onDoubleClick: (id: string) => void;
  resetKey: number;
  hoveredPipeId: string | null;
  onPipeHover: (id: string | null) => void;
  pipeHighlightIds: Set<string>;
}

/** Build a map from parentId → direct children */
function buildChildrenMap(nodes: SceneNode[]): Map<string | undefined, SceneNode[]> {
  const map = new Map<string | undefined, SceneNode[]>();
  for (const node of nodes) {
    const key = node.parentId;
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    list.push(node);
  }
  return map;
}

export function CubeScene({ sceneGraph, selectedId, hoveredId, onHover, onClick, onDoubleClick, resetKey, hoveredPipeId, onPipeHover, pipeHighlightIds }: CubeSceneProps) {
  const activeId = hoveredId ?? selectedId;

  const childrenMap = useMemo(() => buildChildrenMap(sceneGraph.nodes), [sceneGraph.nodes]);

  function isNodeHighlighted(id: string): boolean {
    return id === activeId || pipeHighlightIds.has(id);
  }

  function renderNode(node: SceneNode): ReactNode {
    const children = childrenMap.get(node.id);
    const renderedChildren = children?.map(child => renderNode(child));

    switch (node.type) {
      case 'definition':
        return (
          <DefinitionCube
            key={node.id}
            node={node}
            selected={isNodeHighlighted(node.id)}
            onHover={onHover}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
          >
            {renderedChildren}
          </DefinitionCube>
        );
      case 'application':
        return (
          <ApplicationCube
            key={node.id}
            node={node}
            selected={isNodeHighlighted(node.id)}
            onHover={onHover}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
          >
            {renderedChildren}
          </ApplicationCube>
        );
      case 'holder':
        return (
          <HolderCube
            key={node.id}
            node={node}
            selected={isNodeHighlighted(node.id)}
            onHover={onHover}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
          />
        );
      case 'literal':
        return (
          <LiteralCube
            key={node.id}
            node={node}
            selected={isNodeHighlighted(node.id)}
            onHover={onHover}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
          />
        );
      case 'plane':
        return (
          <PlaneBox key={node.id} node={node}>
            {renderedChildren}
          </PlaneBox>
        );
      case 'constructor':
        return (
          <ConstructorCube
            key={node.id}
            node={node}
            selected={isNodeHighlighted(node.id)}
            onHover={onHover}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
          >
            {renderedChildren}
          </ConstructorCube>
        );
      case 'type_definition':
        return (
          <TypeDefCube
            key={node.id}
            node={node}
            selected={isNodeHighlighted(node.id)}
            onHover={onHover}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
          >
            {renderedChildren}
          </TypeDefCube>
        );
      default:
        return null;
    }
  }

  // Render only root-level nodes (no parentId); children are rendered recursively
  const rootNodes = childrenMap.get(undefined) ?? [];

  return (
    <>
      {/* Camera and controls */}
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.1}
        minDistance={2}
        maxDistance={100}
      />
      <CameraReset sceneGraph={sceneGraph} resetKey={resetKey} />

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

      {/* Scene nodes (recursive from roots) */}
      {rootNodes.map(node => renderNode(node))}

      {/* Pipes */}
      {sceneGraph.pipes.map(pipe => (
        <Pipe
          key={pipe.id}
          pipe={pipe}
          highlighted={pipe.id === hoveredPipeId}
          onHover={onPipeHover}
        />
      ))}
    </>
  );
}
