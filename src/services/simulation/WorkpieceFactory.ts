import * as THREE from 'three';
import type { SimulationInput } from './SimulationTypes';
import { materialSize, stockPlacement } from './SimulationTransforms';
import { StockModel } from './StockModel';
import { boxVolume, cylinderVolume } from './ImplicitGeometry';
import { validateProgramMaterial } from '../tools/SimulationMetadata';
import type { DeepReadonly } from '../tools/SimulationMetadata';
import { RotationalProfile } from './RotationalProfile';

export class WorkpieceFactory {
  create(input: DeepReadonly<SimulationInput>): {
    stock: StockModel;
    stockToWorkpiece: THREE.Matrix4;
  } {
    const material = input.stock;
    validateProgramMaterial(material);
    const stockToWorkpiece = stockPlacement(material, input.binding);
    const size = materialSize(material);
    const inverse = stockToWorkpiece.clone().invert();
    const origin = new THREE.Vector3(...input.binding.spindleOrigin).applyMatrix4(inverse);
    const axis = new THREE.Vector3(...input.binding.spindleAxis).transformDirection(inverse);
    const epsilon = 64 * Number.EPSILON * Math.max(1, ...size);
    const profile =
      input.rotationalProfile !== false &&
      material.type === 'cylinder' &&
      Math.abs(origin.x) <= epsilon &&
      Math.abs(origin.y) <= epsilon &&
      Math.abs(axis.x) <= 64 * Number.EPSILON &&
      Math.abs(axis.y) <= 64 * Number.EPSILON &&
      Math.abs(Math.abs(axis.z) - 1) <= 64 * Number.EPSILON
        ? new RotationalProfile(material.diameter / 2, material.length)
        : undefined;
    const stock = new StockModel(
      size,
      input.resolutionMm,
      profile?.volume ??
        (material.type === 'cylinder'
          ? cylinderVolume(material.diameter / 2, material.length)
          : boxVolume(size)),
      undefined,
      undefined,
      profile,
    );
    if (!stock.remainingCells)
      throw new Error('Stock has no occupied cells at this resolution; choose a finer voxel size');
    return { stock, stockToWorkpiece };
  }
}
