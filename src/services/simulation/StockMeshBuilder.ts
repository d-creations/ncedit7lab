import { StockModel } from './StockModel';
import { SIMULATION_LIMITS, type StockSurfaceChunk } from './SimulationTypes';

const FACES = [
  {
    normal: [-1, 0, 0],
    corners: [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ],
  },
  {
    normal: [1, 0, 0],
    corners: [
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
    ],
  },
  {
    normal: [0, -1, 0],
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
  },
  {
    normal: [0, 1, 0],
    corners: [
      [0, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
    ],
  },
  {
    normal: [0, 0, -1],
    corners: [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
    ],
  },
  {
    normal: [0, 0, 1],
    corners: [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
  },
];
const TRIANGLES = [0, 1, 2, 0, 2, 3];

export class StockMeshBuilder {
  private readonly cache = new Map<number, StockSurfaceChunk>();
  private faces = 0;

  constructor(private readonly faceLimit: number = SIMULATION_LIMITS.surfaceFaces) {}

  private visitFaces(
    stock: StockModel,
    id: number,
    visit: (x: number, y: number, z: number, face: (typeof FACES)[number]) => void,
  ): void {
    const [ox, oy, oz] = stock.chunkOrigin(id);
    for (let z = oz; z < Math.min(oz + stock.chunkSize, stock.dimensions[2]); z++) {
      for (let y = oy; y < Math.min(oy + stock.chunkSize, stock.dimensions[1]); y++) {
        for (let x = ox; x < Math.min(ox + stock.chunkSize, stock.dimensions[0]); x++) {
          if (!stock.has(x, y, z)) continue;
          for (const face of FACES) {
            const [dx, dy, dz] = face.normal;
            if (!stock.has(x + dx, y + dy, z + dz)) visit(x, y, z, face);
          }
        }
      }
    }
  }

  buildChanged(stock: StockModel): StockSurfaceChunk[] {
    const changed: StockSurfaceChunk[] = [];
    for (const id of stock.dirtyChunks) {
      let count = 0;
      this.visitFaces(stock, id, () => count++);
      const previous = (this.cache.get(id)?.positions.length ?? 0) / 18;
      if (this.faces - previous + count > this.faceLimit) {
        throw new Error(
          `Stock surface exceeds the ${this.faceLimit.toLocaleString()} face budget; use a coarser resolution`,
        );
      }
      const positions = new Float32Array(count * 18);
      const normals = new Float32Array(count * 18);
      let index = 0;
      this.visitFaces(stock, id, (x, y, z, face) => {
        for (const corner of TRIANGLES) {
          const vertex = face.corners[corner];
          positions[index] = stock.minimum.x + (x + vertex[0]) * stock.resolutionMm;
          positions[index + 1] = stock.minimum.y + (y + vertex[1]) * stock.resolutionMm;
          positions[index + 2] = stock.minimum.z + (z + vertex[2]) * stock.resolutionMm;
          normals.set(face.normal, index);
          index += 3;
        }
      });
      const chunk = { id, positions, normals };
      this.cache.set(id, chunk);
      this.faces += count - previous;
      changed.push(chunk);
    }
    stock.dirtyChunks.clear();
    return changed;
  }

  getChunks(): StockSurfaceChunk[] {
    return [...this.cache.values()].filter((chunk) => chunk.positions.length > 0);
  }
}
