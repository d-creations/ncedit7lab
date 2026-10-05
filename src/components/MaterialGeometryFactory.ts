import * as THREE from 'three';
import type { DeepReadonly, ProgramMaterialDefinition } from '@services/tools/SimulationMetadata';
import { materialPlacement } from '@services/simulation/SimulationTransforms';

const STOCK_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xd9c7a6, metalness: 0.25, roughness: 0.8 });

export interface MaterialPickPoint {
  index: number;
  position: [number, number, number];
  active: boolean;
}

function localPoints(material: DeepReadonly<ProgramMaterialDefinition>): THREE.Vector3[] {
  if (material.type === 'cylinder') {
    return [new THREE.Vector3(0, 0, -material.length / 2), new THREE.Vector3(0, 0, material.length / 2)];
  }
  return Array.from({ length: 8 }, (_, index) => new THREE.Vector3(
    (index & 1 ? 1 : -1) * material.width / 2,
    (index & 2 ? 1 : -1) * material.height / 2,
    (index & 4 ? 1 : -1) * material.depth / 2,
  ));
}

export function getMaterialPickPoints(material: DeepReadonly<ProgramMaterialDefinition>): MaterialPickPoint[] {
  const matrix = materialPlacement(material);
  return localPoints(material).map((point, index) => ({
    index, position: point.applyMatrix4(matrix).toArray(), active: index === material.zeroVertex,
  }));
}

/** Stock dimensions follow the existing material convention: width X, height Y, depth/length Z. */
export class MaterialGeometryFactory {
  create(material: DeepReadonly<ProgramMaterialDefinition>): THREE.Group {
    const matrix = materialPlacement(material);
    const geometry = material.type === 'box'
      ? new THREE.BoxGeometry(material.width, material.height, material.depth)
      : new THREE.CylinderGeometry(material.diameter / 2, material.diameter / 2, material.length, 32);
    if (material.type === 'cylinder') geometry.rotateX(Math.PI / 2);
    geometry.applyMatrix4(matrix);
    const group = new THREE.Group();
    group.name = 'raw-material';
    group.add(new THREE.Mesh(geometry, STOCK_MATERIAL.clone()));
    return group;
  }
}
