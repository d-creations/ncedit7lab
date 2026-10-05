import * as THREE from 'three';
import { SIMULATION_LIMITS } from './SimulationTypes';

export interface StockLimits {
  cells: number;
  stockBytes: number;
}

/** Sparse occupied chunks; empty cells are never rendered as individual objects. */
export class StockModel {
  readonly chunks = new Map<number, Uint8Array>();
  readonly dirtyChunks = new Set<number>();
  readonly dimensions: [number, number, number];
  readonly chunkDimensions: [number, number, number];
  readonly minimum: THREE.Vector3;
  readonly chunkSize = SIMULATION_LIMITS.chunkSize;
  remainingCells = 0;
  removedCells = 0;
  allocatedBytes = 0;

  constructor(
    readonly size: readonly [number, number, number],
    readonly resolutionMm: number,
    inside: (point: THREE.Vector3) => boolean,
    limits: StockLimits = SIMULATION_LIMITS,
  ) {
    if (!Number.isFinite(resolutionMm) || resolutionMm < 0.05 || resolutionMm > 5) {
      throw new Error('Voxel resolution must be between 0.05 and 5 mm');
    }
    if (size.some((value) => !Number.isFinite(value) || value <= 0))
      throw new Error('Invalid stock dimensions');
    this.dimensions = size.map((value) => Math.ceil(value / resolutionMm)) as [
      number,
      number,
      number,
    ];
    const cells = this.dimensions.reduce((product, value) => product * value, 1);
    if (!Number.isSafeInteger(cells) || cells > limits.cells) {
      throw new Error(
        `Stock exceeds the ${limits.cells.toLocaleString()} cell budget; use a coarser resolution`,
      );
    }
    this.chunkDimensions = this.dimensions.map((value) => Math.ceil(value / this.chunkSize)) as [
      number,
      number,
      number,
    ];
    this.minimum = new THREE.Vector3(...size).multiplyScalar(-0.5);
    const point = new THREE.Vector3();
    for (let z = 0; z < this.dimensions[2]; z++) {
      for (let y = 0; y < this.dimensions[1]; y++) {
        for (let x = 0; x < this.dimensions[0]; x++) {
          this.centre(x, y, z, point);
          if (!inside(point)) continue;
          const id = this.chunkId(x, y, z);
          let chunk = this.chunks.get(id);
          if (!chunk) {
            const bytes = this.chunkSize ** 3;
            if (this.allocatedBytes + bytes > limits.stockBytes)
              throw new Error('Stock chunk memory budget exceeded');
            chunk = new Uint8Array(bytes);
            this.chunks.set(id, chunk);
            this.allocatedBytes += bytes;
            this.dirtyChunks.add(id);
          }
          chunk[this.cellIndex(x, y, z)] = 1;
          this.remainingCells++;
        }
      }
    }
  }

  private chunkId(x: number, y: number, z: number): number {
    const n = this.chunkSize;
    return (
      Math.floor(x / n) +
      this.chunkDimensions[0] * (Math.floor(y / n) + this.chunkDimensions[1] * Math.floor(z / n))
    );
  }

  private cellIndex(x: number, y: number, z: number): number {
    const n = this.chunkSize;
    return (x % n) + n * ((y % n) + n * (z % n));
  }

  has(x: number, y: number, z: number): boolean {
    if (
      x < 0 ||
      y < 0 ||
      z < 0 ||
      x >= this.dimensions[0] ||
      y >= this.dimensions[1] ||
      z >= this.dimensions[2]
    )
      return false;
    return this.chunks.get(this.chunkId(x, y, z))?.[this.cellIndex(x, y, z)] === 1;
  }

  centre(x: number, y: number, z: number, target: THREE.Vector3): THREE.Vector3 {
    return target
      .set(x + 0.5, y + 0.5, z + 0.5)
      .multiplyScalar(this.resolutionMm)
      .add(this.minimum);
  }

  chunkOrigin(id: number): [number, number, number] {
    const [nx, ny] = this.chunkDimensions;
    return [id % nx, Math.floor(id / nx) % ny, Math.floor(id / (nx * ny))].map(
      (value) => value * this.chunkSize,
    ) as [number, number, number];
  }

  removeWhere(
    bounds: THREE.Box3,
    inside: (point: THREE.Vector3) => boolean,
    test: () => void,
  ): void {
    const min = bounds.min.clone().sub(this.minimum).divideScalar(this.resolutionMm).floor();
    const max = bounds.max.clone().sub(this.minimum).divideScalar(this.resolutionMm).floor();
    min.max(new THREE.Vector3(0, 0, 0));
    max.min(new THREE.Vector3(...this.dimensions).addScalar(-1));
    const point = new THREE.Vector3();
    for (let z = min.z; z <= max.z; z++) {
      for (let y = min.y; y <= max.y; y++) {
        for (let x = min.x; x <= max.x; x++) {
          test();
          if (!this.has(x, y, z) || !inside(this.centre(x, y, z, point))) continue;
          const id = this.chunkId(x, y, z);
          this.chunks.get(id)![this.cellIndex(x, y, z)] = 0;
          this.remainingCells--;
          this.removedCells++;
          this.dirtyChunks.add(id);
          for (const [dx, dy, dz] of [
            [-1, 0, 0],
            [1, 0, 0],
            [0, -1, 0],
            [0, 1, 0],
            [0, 0, -1],
            [0, 0, 1],
          ]) {
            const adjacent = [x + dx, y + dy, z + dz];
            if (this.has(adjacent[0], adjacent[1], adjacent[2])) {
              this.dirtyChunks.add(this.chunkId(adjacent[0], adjacent[1], adjacent[2]));
            }
          }
        }
      }
    }
  }
}
