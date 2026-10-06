import * as THREE from 'three';
import { StockModel, type BoundaryCell } from './StockModel';
import { CELL_CORNERS, CELL_EDGES, CELL_TETRAHEDRA, edgeIndex } from './ImplicitGeometry';
import { SIMULATION_LIMITS, type StockSurfaceChunk } from './SimulationTypes';

const TETRA_EDGES = [
  [0, 1],
  [1, 2],
  [2, 0],
  [0, 3],
  [1, 3],
  [2, 3],
] as const;
const TETRA_TRIANGLES: readonly (readonly number[])[] = [
  [],
  [0, 3, 2],
  [0, 1, 4],
  [1, 4, 2, 2, 4, 3],
  [1, 2, 5],
  [0, 3, 5, 0, 5, 1],
  [0, 4, 5, 0, 5, 2],
  [3, 4, 5],
  [3, 4, 5],
  [0, 4, 5, 0, 5, 2],
  [0, 3, 5, 0, 5, 1],
  [1, 2, 5],
  [1, 4, 2, 2, 4, 3],
  [0, 1, 4],
  [0, 3, 2],
  [],
];
const TETRA_CELL_EDGES = CELL_TETRAHEDRA.map((tetra) =>
  TETRA_EDGES.map(([a, b]) => edgeIndex(tetra[a], tetra[b])),
);

export class StockMeshBuilder {
  private readonly cache = new Map<number, StockSurfaceChunk>();
  private triangles = 0;

  constructor(private readonly faceLimit: number = SIMULATION_LIMITS.surfaceFaces) {}

  private visitTriangles(
    stock: StockModel,
    cells: readonly BoundaryCell[],
    visit: (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, normal: THREE.Vector3) => void,
  ): void {
    for (const cell of cells) {
      const corners = CELL_CORNERS.map(([x, y, z]) =>
        new THREE.Vector3(cell.x + x, cell.y + y, cell.z + z)
          .multiplyScalar(stock.resolutionMm)
          .add(stock.latticeMinimum),
      );
      const intersections = CELL_EDGES.map(([a, b], index) => {
        const t = cell.data[8 + index];
        return Number.isFinite(t) ? corners[a].clone().lerp(corners[b], t) : undefined;
      });
      for (const [tetraIndex, tetra] of CELL_TETRAHEDRA.entries()) {
        const mask = tetra.reduce<number>(
          (value, index, bit) => value | (cell.data[index] < 0 ? 1 << bit : 0),
          0,
        );
        const triangles = TETRA_TRIANGLES[mask];
        if (!triangles.length) continue;
        const inside = tetra.filter((index) => cell.data[index] < 0);
        const outside = tetra.filter((index) => cell.data[index] >= 0);
        const direction = new THREE.Vector3();
        for (const index of outside) direction.addScaledVector(corners[index], 1 / outside.length);
        for (const index of inside) direction.addScaledVector(corners[index], -1 / inside.length);
        for (let i = 0; i < triangles.length; i += 3) {
          const a = intersections[TETRA_CELL_EDGES[tetraIndex][triangles[i]]];
          const b = intersections[TETRA_CELL_EDGES[tetraIndex][triangles[i + 1]]];
          const c = intersections[TETRA_CELL_EDGES[tetraIndex][triangles[i + 2]]];
          if (!a || !b || !c) throw new Error('Missing cutter/stock edge intersection');
          const faceNormal = b.clone().sub(a).cross(c.clone().sub(a));
          if (faceNormal.lengthSq() < 1e-24) continue;
          if (faceNormal.dot(direction) < 0) {
            faceNormal.negate();
            visit(a, c, b, faceNormal.normalize());
          } else {
            visit(a, b, c, faceNormal.normalize());
          }
        }
      }
    }
  }

  buildChanged(stock: StockModel): StockSurfaceChunk[] {
    const changed: StockSurfaceChunk[] = [];
    const chunks = stock.getBoundaryChunks(this.cache.size ? stock.dirtyChunks : undefined);
    const changedIds = new Set([
      ...stock.dirtyChunks,
      ...[...chunks.keys()].filter((id) => !this.cache.has(id)),
    ]);
    for (const id of changedIds) {
      const cells = chunks.get(id) ?? [];
      let count = 0;
      this.visitTriangles(stock, cells, () => {
        count++;
        if (
          this.triangles - (this.cache.get(id)?.positions.length ?? 0) / 9 + count >
          this.faceLimit * 2
        )
          throw new Error(
            `Stock surface exceeds the ${this.faceLimit.toLocaleString()} face budget; use coarser boundary spacing`,
          );
      });
      const previous = (this.cache.get(id)?.positions.length ?? 0) / 9;
      const positions = new Float32Array(count * 9);
      const normals = new Float32Array(count * 9);
      let offset = 0;
      this.visitTriangles(stock, cells, (a, b, c, normal) => {
        for (const point of [a, b, c]) {
          point.toArray(positions, offset);
          normal.toArray(normals, offset);
          offset += 3;
        }
      });
      const chunk = { id, positions, normals };
      this.cache.set(id, chunk);
      this.triangles += count - previous;
      changed.push(chunk);
    }
    stock.dirtyChunks.clear();
    return changed;
  }

  getChunks(): StockSurfaceChunk[] {
    return [...this.cache.values()].filter((chunk) => chunk.positions.length > 0);
  }
}
