import { Text } from '@react-three/drei';
import type { SceneNode } from '../layoutEngine';

interface ApplicationCubeProps {
  node: SceneNode;
  selected: boolean;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
}

export function ApplicationCube({ node, selected, onHover, onClick }: ApplicationCubeProps) {
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
          roughness={0.4}
          metalness={0.2}
        />
      </mesh>
      {selected && (
        <mesh>
          <boxGeometry args={node.size.map(s => s + 0.05) as [number, number, number]} />
          <meshBasicMaterial color="#ffff00" wireframe />
        </mesh>
      )}
      <Text
        position={[0, node.size[1] / 2 + 0.15, 0]}
        fontSize={0.2}
        color="#ffffff"
        anchorX="center"
        anchorY="bottom"
      >
        {node.label}
      </Text>
      {/* Port nubs */}
      {node.ports.map(port => {
        const localPos: [number, number, number] = [
          port.worldPos[0] - node.position[0],
          port.worldPos[1] - node.position[1],
          port.worldPos[2] - node.position[2],
        ];
        return (
          <group key={port.id} position={localPos}>
            <mesh>
              <boxGeometry args={[0.15, 0.15, 0.15]} />
              <meshStandardMaterial color="#aaaaaa" />
            </mesh>
            <Text
              position={[port.side === 'right' ? 0.2 : -0.2, 0, 0]}
              fontSize={0.1}
              color="#cccccc"
              anchorX={port.side === 'right' ? 'left' : 'right'}
              anchorY="middle"
            >
              {port.name}
            </Text>
          </group>
        );
      })}
    </group>
  );
}
