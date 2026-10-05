import * as THREE from 'three';
import type { DeepReadonly, ProgramMaterialDefinition } from '@services/tools/SimulationMetadata';
import { validateProgramMaterial } from '@services/tools/SimulationMetadata';

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

function placement(material: DeepReadonly<ProgramMaterialDefinition>): THREE.Matrix4 {
  validateProgramMaterial(material);
  const [rx, ry, rz] = material.rotation ?? [0, 0, 0];
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(rx), THREE.MathUtils.degToRad(ry), THREE.MathUtils.degToRad(rz),
    'ZYX',
  ));
  const origin = material.zeroVertex === undefined
    ? new THREE.Vector3()
    : localPoints(material)[material.zeroVertex];
  const centre = new THREE.Vector3(...(material.position ?? [0, 0, 0]))
    .sub(origin.clone().applyQuaternion(rotation));
  return new THREE.Matrix4().compose(centre, rotation, new THREE.Vector3(1, 1, 1));
}

export function getMaterialPickPoints(material: DeepReadonly<ProgramMaterialDefinition>): MaterialPickPoint[] {
  const matrix = placement(material);
  return localPoints(material).map((point, index) => ({
    index, position: point.applyMatrix4(matrix).toArray(), active: index === material.zeroVertex,
  }));
}

/** Stock dimensions follow the existing material convention: width X, height Y, depth/length Z. */
export class MaterialGeometryFactory {
  create(material: DeepReadonly<ProgramMaterialDefinition>): THREE.Group {
    const matrix = placement(material);
    const geometry = material.type === 'box'
      ? new THREE.BoxGeometry(material.width, material.height, material.depth)
      : new THREE.CylinderGeometry(material.diameter / 2, material.diameter / 2, material.length, 32);
    if (material.type === 'cylinder') geometry.rotateX(Math.PI / 2);
    geometry.applyMatrix4(matrix);
    const group = new THREE.Group();
    group.name = 'raw-material';
    group.add(new THREE.Mesh(geometry, STOCK_MATERIAL));
    return group;
  }
}
