import { Text } from '@react-three/drei';
import type { SceneNode } from '../layoutEngine';

interface LiteralCubeProps {
  node: SceneNode;
  selected: boolean;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
}

export function LiteralCube({ node, selected, onHover, onClick }: LiteralCubeProps) {
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
          roughness={0.3}
          metalness={0.3}
        />
      </mesh>
      {selected && (
        <mesh>
          <boxGeometry args={node.size.map(s => s + 0.05) as [number, number, number]} />
          <meshBasicMaterial color="#ffff00" wireframe />
        </mesh>
      )}
      <Text
        position={[0, 0, node.size[2] / 2 + 0.01]}
        fontSize={0.2}
        color="#ffffff"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.02}
        outlineColor="#000000"
      >
        {node.label}
      </Text>
    </group>
  );
}
