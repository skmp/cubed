import { Text } from '@react-three/drei';
import type { SceneNode } from '../layoutEngine';

interface HolderCubeProps {
  node: SceneNode;
  selected: boolean;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
}

export function HolderCube({ node, selected, onHover, onClick }: HolderCubeProps) {
  return (
    <group position={node.position}>
      <mesh
        onPointerOver={() => onHover(node.id)}
        onPointerOut={() => onHover(null)}
        onClick={() => onClick(node.id)}
      >
        <boxGeometry args={node.size} />
        <meshStandardMaterial
          color={node.color}
          transparent
          opacity={0.4}
          wireframe
        />
      </mesh>
      {selected && (
        <mesh>
          <boxGeometry args={node.size.map(s => s + 0.05) as [number, number, number]} />
          <meshBasicMaterial color="#ffff00" wireframe />
        </mesh>
      )}
      <Text
        position={[0, node.size[1] / 2 + 0.1, 0]}
        fontSize={0.12}
        color="#aaddff"
        anchorX="center"
        anchorY="bottom"
      >
        {node.label}
      </Text>
    </group>
  );
}
