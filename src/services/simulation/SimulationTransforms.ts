import * as THREE from 'three';
import type { DeepReadonly, ProgramMaterialDefinition, Vector3 } from '../tools/SimulationMetadata';
import { validateProgramMaterial } from '../tools/SimulationMetadata';
import type { StockBinding } from './SimulationTypes';

export function rotationQuaternion(rotation: readonly number[]): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...(rotation.map(THREE.MathUtils.degToRad) as [number, number, number]), 'ZYX'),
  );
}

export function materialSize(material: DeepReadonly<ProgramMaterialDefinition>): Vector3 {
  return material.type === 'box'
    ? [material.width, material.height, material.depth]
    : [material.diameter, material.diameter, material.length];
}

export function materialPlacement(
  material: DeepReadonly<ProgramMaterialDefinition>,
): THREE.Matrix4 {
  validateProgramMaterial(material);
  const size = materialSize(material);
  const origin = new THREE.Vector3();
  if (material.zeroVertex !== undefined) {
    if (material.type === 'cylinder') {
      origin.z = ((material.zeroVertex === 0 ? -1 : 1) * material.length) / 2;
    } else {
      origin.set(
        ...(size.map(
          (length, axis) => ((material.zeroVertex! & (1 << axis) ? 1 : -1) * length) / 2,
        ) as Vector3),
      );
    }
  }
  const orientation = rotationQuaternion(material.rotation ?? [0, 0, 0]);
  const centre = new THREE.Vector3(...(material.position ?? [0, 0, 0])).sub(
    origin.applyQuaternion(orientation),
  );
  return new THREE.Matrix4().compose(centre, orientation, new THREE.Vector3(1, 1, 1));
}

export function validateStockBinding(binding: DeepReadonly<StockBinding>): void {
  if (typeof binding.frameId !== 'string' || !binding.frameId.trim()) {
    throw new Error('Select the workpiece frame for the stock');
  }
  for (const vector of [
    binding.position,
    binding.rotation,
    binding.spindleOrigin,
    binding.spindleAxis,
  ]) {
    if (
      !Array.isArray(vector) ||
      vector.length !== 3 ||
      vector.some((value) => !Number.isFinite(value) || Math.abs(value) > 1_000_000)
    ) {
      throw new Error('Stock binding requires finite, bounded XYZ vectors');
    }
  }
  if (Math.abs(Math.hypot(...binding.spindleAxis) - 1) > 1e-6) {
    throw new Error('Stock spindle axis must be a unit direction');
  }
}

export function stockPlacement(
  material: DeepReadonly<ProgramMaterialDefinition>,
  binding: DeepReadonly<StockBinding>,
): THREE.Matrix4 {
  validateStockBinding(binding);
  const programToWorkpiece = new THREE.Matrix4().compose(
    new THREE.Vector3(...binding.position),
    rotationQuaternion(binding.rotation),
    new THREE.Vector3(1, 1, 1),
  );
  return programToWorkpiece.multiply(materialPlacement(material));
}
