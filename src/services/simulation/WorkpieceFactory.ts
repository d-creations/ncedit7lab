import * as THREE from 'three';
import type { SimulationInput } from './SimulationTypes';
import { materialSize, stockPlacement } from './SimulationTransforms';
import { StockModel } from './StockModel';
import { validateProgramMaterial } from '../tools/SimulationMetadata';
import type { DeepReadonly } from '../tools/SimulationMetadata';

export class WorkpieceFactory {
  create(input: DeepReadonly<SimulationInput>): {
    stock: StockModel;
    stockToWorkpiece: THREE.Matrix4;
  } {
    const material = input.stock;
    validateProgramMaterial(material);
    const stockToWorkpiece = stockPlacement(material, input.binding);
    const size = materialSize(material);
    const radius = material.type === 'cylinder' ? material.diameter / 2 : undefined;
    const stock = new StockModel(
      size,
      input.resolutionMm,
      (point) =>
        Math.abs(point.z) <= size[2] / 2 &&
        (radius === undefined
          ? Math.abs(point.x) <= size[0] / 2 && Math.abs(point.y) <= size[1] / 2
          : point.x ** 2 + point.y ** 2 <= radius ** 2),
    );
    if (!stock.remainingCells)
      throw new Error('Stock has no occupied cells at this resolution; choose a finer voxel size');
    return { stock, stockToWorkpiece };
  }
}
