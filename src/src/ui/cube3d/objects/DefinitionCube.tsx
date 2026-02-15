import { Text } from '@react-three/drei';
import type { SceneNode } from '../layoutEngine';

interface DefinitionCubeProps {
  node: SceneNode;
  selected: boolean;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
  onDoubleClick: (id: string) => void;
}

export function DefinitionCube({ node, selected, onHover, onClick, onDoubleClick }: DefinitionCubeProps) {
  return (
    <group position={node.position}>
      <mesh
        renderOrder={1}
        onPointerOver={() => onHover(node.id)}
        onPointerOut={() => onHover(null)}
        onClick={() => onClick(node.id)}
        onDoubleClick={() => onDoubleClick(node.id)}
      >
        <boxGeometry args={node.size} />
        <meshPhysicalMaterial
          color={node.color}
          transparent
          opacity={node.opacity}
          depthWrite={false}
          roughness={0.3}
          metalness={0.1}
          side={2}
        />
      </mesh>
      {selected && (
        <mesh>
          <boxGeometry args={node.size.map(s => s + 0.05) as [number, number, number]} />
          <meshBasicMaterial color="#ffff00" wireframe />
        </mesh>
      )}
      <Text
        position={[0, node.size[1] / 2 + 0.2, 0]}
        fontSize={0.25}
        color="#88ff88"
        anchorX="center"
        anchorY="bottom"
      >
        {node.label}
      </Text>
    </group>
  );
}
