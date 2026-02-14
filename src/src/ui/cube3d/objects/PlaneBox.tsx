import type { SceneNode } from '../layoutEngine';

interface PlaneBoxProps {
  node: SceneNode;
}

export function PlaneBox({ node }: PlaneBoxProps) {
  return (
    <group position={node.position}>
      <mesh>
        <boxGeometry args={node.size} />
        <meshStandardMaterial
          color={node.color}
          transparent
          opacity={node.opacity}
          side={2}
        />
      </mesh>
      <mesh>
        <boxGeometry args={node.size} />
        <meshBasicMaterial color={node.color} wireframe opacity={0.4} transparent />
      </mesh>
    </group>
  );
}
