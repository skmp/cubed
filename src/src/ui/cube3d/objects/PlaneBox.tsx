import type { ReactNode } from 'react';
import { Text } from '@react-three/drei';
import type { SceneNode } from '../layoutEngine';

interface PlaneBoxProps {
  node: SceneNode;
  children?: ReactNode;
}

export function PlaneBox({ node, children }: PlaneBoxProps) {
  return (
    <group position={node.position}>
      <mesh renderOrder={0}>
        <boxGeometry args={node.size} />
        <meshStandardMaterial
          color={node.color}
          transparent
          opacity={node.opacity}
          depthWrite={false}
          side={2}
        />
      </mesh>
      <mesh renderOrder={0}>
        <boxGeometry args={node.size} />
        <meshBasicMaterial color={node.color} wireframe opacity={0.4} transparent depthWrite={false} />
      </mesh>
      <Text
        position={[0, node.size[1] / 2 + 0.15, 0]}
        fontSize={0.22}
        color="#aaccaa"
        anchorX="center"
        anchorY="bottom"
      >
        {node.label}
      </Text>
      {/* Render children with inverse offset so their absolute positions remain correct */}
      <group position={[-node.position[0], -node.position[1], -node.position[2]]}>
        {children}
      </group>
    </group>
  );
}
