import * as THREE from 'three';
import type { SimulationInput } from './SimulationTypes';
import { materialSize, stockPlacement } from './SimulationTransforms';
import { StockModel } from './StockModel';
import { boxVolume, cylinderVolume } from './ImplicitGeometry';
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
    const stock = new StockModel(
      size,
      input.resolutionMm,
      material.type === 'cylinder'
        ? cylinderVolume(material.diameter / 2, material.length)
        : boxVolume(size),
    );
    if (!stock.remainingCells)
      throw new Error('Stock has no occupied cells at this resolution; choose a finer voxel size');
    return { stock, stockToWorkpiece };
  }
}
