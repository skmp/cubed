import { useMemo } from 'react';
import * as THREE from 'three';
import type { PipeInfo } from '../layoutEngine';

interface PipeProps {
  pipe: PipeInfo;
}

export function Pipe({ pipe }: PipeProps) {
  const geometry = useMemo(() => {
    const from = new THREE.Vector3(...pipe.from);
    const to = new THREE.Vector3(...pipe.to);
    const mid = from.clone().lerp(to, 0.5);
    // Add slight curve upward for visual clarity
    mid.y += 0.3;

    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    return new THREE.TubeGeometry(curve, 16, 0.04, 8, false);
  }, [pipe.from, pipe.to]);

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        color={pipe.color}
        transparent
        opacity={0.7}
        emissive={pipe.color}
        emissiveIntensity={0.3}
      />
    </mesh>
  );
}
