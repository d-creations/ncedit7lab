import * as THREE from 'three';
import { SIMULATION_LIMITS } from './SimulationTypes';
import { CELL_CORNERS, CELL_EDGES, edgeRoot, type ImplicitVolume } from './ImplicitGeometry';

export interface StockLimits {
  cells: number;
  stockBytes: number;
}

interface StockNode {
  x: number;
  y: number;
  z: number;
  span: number;
  state: 'solid' | 'empty' | 'branch' | 'boundary' | 'pristine';
  children?: StockNode[];
  /** Eight corner fields, edge intersection parameters, and a centre field. */
  data?: Float64Array;
  occupied: number;
}

export interface BoundaryCell {
  x: number;
  y: number;
  z: number;
  data: Float64Array;
}

const NODE_BYTES = 128;
const CENTRE = 8 + CELL_EDGES.length;

/** Homogeneous regions stay coarse; only boundary leaves reach the requested spacing. */
export class StockModel {
  readonly dimensions: [number, number, number];
  readonly minimum: THREE.Vector3;
  readonly latticeMinimum: THREE.Vector3;
  readonly dirtyChunks = new Set<number>();
  readonly chunkSize = SIMULATION_LIMITS.chunkSize;
  readonly chunkDimensions: [number, number, number];
  private readonly root: StockNode;
  private readonly boundary = new Map<number, StockNode>();
  private readonly pristine = new Set<StockNode>();
  private readonly latticeSide: number;
  private readonly material: ImplicitVolume;
  private nodeCount = 0;
  private dataBytes = 0;
  private initialCells = 0;
  private peakBytes = 0;
  regionTests = 0;
  bulkRemovedRegions = 0;

  constructor(
    readonly size: readonly [number, number, number],
    readonly resolutionMm: number,
    material: ImplicitVolume,
    private readonly limits: StockLimits = SIMULATION_LIMITS,
  ) {
    if (!Number.isFinite(resolutionMm) || resolutionMm < 0.05 || resolutionMm > 5)
      throw new Error('Voxel resolution must be between 0.05 and 5 mm');
    if (size.some((value) => !Number.isFinite(value) || value <= 0))
      throw new Error('Invalid stock dimensions');
    this.dimensions = size.map((value) => Math.ceil(value / resolutionMm)) as [
      number,
      number,
      number,
    ];
    this.minimum = new THREE.Vector3(...size).multiplyScalar(-0.5);
    this.latticeMinimum = this.minimum.clone().addScalar(-resolutionMm / 2);
    const required = Math.max(...this.dimensions) + 2;
    this.latticeSide = 2 ** Math.ceil(Math.log2(required));
    if (!Number.isSafeInteger(this.latticeSide ** 3))
      throw new Error('Stock exceeds the addressable adaptive cell budget');
    this.chunkDimensions = this.dimensions.map((value) =>
      Math.ceil((value + 2) / this.chunkSize),
    ) as [number, number, number];
    this.material = material;
    this.root = this.createNode(0, 0, 0, this.latticeSide);
    this.initialCells = this.root.occupied;
  }

  get remainingCells(): number {
    return this.root.occupied;
  }
  get removedCells(): number {
    return this.initialCells - this.remainingCells;
  }
  /** Conservative accounting includes node/Map overhead, not just typed arrays. */
  get allocatedBytes(): number {
    return this.nodeCount * NODE_BYTES + this.dataBytes;
  }
  get boundaryCells(): number {
    return this.boundary.size;
  }
  get allocatedNodes(): number {
    return this.nodeCount;
  }
  get peakAllocatedBytes(): number {
    return this.peakBytes;
  }

  private budget(extraBytes = 0): void {
    this.peakBytes = Math.max(this.peakBytes, this.allocatedBytes + extraBytes);
    if (this.nodeCount > this.limits.cells) throw new Error('Adaptive stock cell budget exceeded');
    if (this.allocatedBytes + extraBytes > this.limits.stockBytes)
      throw new Error('Adaptive stock memory budget exceeded; use a coarser boundary spacing');
  }

  private point(x: number, y: number, z: number, target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(x, y, z).multiplyScalar(this.resolutionMm).add(this.latticeMinimum);
  }

  private centreOf(node: StockNode): THREE.Vector3 {
    const half = node.span / 2;
    return this.point(node.x + half, node.y + half, node.z + half);
  }

  private id(x: number, y: number, z: number): number {
    return x + this.latticeSide * (y + this.latticeSide * z);
  }

  chunkId(x: number, y: number, z: number): number {
    const n = this.chunkSize;
    return (
      Math.floor(x / n) +
      this.chunkDimensions[0] * (Math.floor(y / n) + this.chunkDimensions[1] * Math.floor(z / n))
    );
  }

  private createNode(x: number, y: number, z: number, span: number): StockNode {
    const node: StockNode = { x, y, z, span, state: 'empty', occupied: 0 };
    this.nodeCount++;
    this.budget();
    const distance = this.material.distance(this.centreOf(node));
    const radius = (Math.sqrt(3) * span * this.resolutionMm) / 2;
    if (distance > radius) return node;
    if (distance < -radius) {
      node.state = 'solid';
      node.occupied = span ** 3;
    } else if (span <= this.chunkSize) {
      node.state = 'pristine';
      const first = this.point(x + 0.5, y + 0.5, z + 0.5);
      if (!this.material.countCentres)
        throw new Error('Initial stock requires an analytical cell-centre counter');
      node.occupied = this.material.countCentres(first, span, this.resolutionMm);
      this.pristine.add(node);
      this.dirtyChunks.add(this.chunkId(x, y, z));
    } else {
      this.split(node);
    }
    return node;
  }

  private split(node: StockNode): void {
    this.pristine.delete(node);
    const half = node.span / 2;
    node.children = CELL_CORNERS.map(([x, y, z]) =>
      this.createNode(node.x + x * half, node.y + y * half, node.z + z * half, half),
    );
    node.state = 'branch';
    node.occupied = node.children.reduce((count, child) => count + child.occupied, 0);
  }

  private makeBoundary(node: StockNode): void {
    this.pristine.delete(node);
    node.data = this.boundaryData(node.x, node.y, node.z);
    this.dataBytes += node.data.byteLength + 64;
    this.budget();
    node.state = 'boundary';
    node.occupied = node.data[CENTRE] < 0 ? 1 : 0;
    this.boundary.set(this.id(node.x, node.y, node.z), node);
    this.dirtyChunks.add(this.chunkId(node.x, node.y, node.z));
  }

  private boundaryData(x: number, y: number, z: number): Float64Array {
    const data = new Float64Array(CENTRE + 1);
    data.fill(NaN, 8, CENTRE);
    const corners = CELL_CORNERS.map(([dx, dy, dz]) => this.point(x + dx, y + dy, z + dz));
    corners.forEach((point, index) => {
      data[index] = this.material.distance(point);
    });
    for (const [index, [a, b]] of CELL_EDGES.entries()) {
      if (data[a] < 0 === data[b] < 0) continue;
      const point = new THREE.Vector3();
      data[8 + index] = edgeRoot(data[a], data[b], (t) =>
        this.material.distance(point.copy(corners[a]).lerp(corners[b], t)),
      );
    }
    data[CENTRE] = this.material.distance(this.point(x + 0.5, y + 0.5, z + 0.5));
    return data;
  }

  centre(x: number, y: number, z: number, target: THREE.Vector3): THREE.Vector3 {
    return target
      .set(x + 0.5, y + 0.5, z + 0.5)
      .multiplyScalar(this.resolutionMm)
      .add(this.minimum);
  }

  has(x: number, y: number, z: number): boolean {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      !Number.isInteger(z) ||
      x < 0 ||
      y < 0 ||
      z < 0 ||
      x >= this.dimensions[0] ||
      y >= this.dimensions[1] ||
      z >= this.dimensions[2]
    )
      return false;
    // Occupancy statistics use adaptive-cell centres; this query samples the legacy cell centre.
    const p = this.centre(x, y, z, new THREE.Vector3());
    return this.contains(p);
  }

  contains(point: THREE.Vector3): boolean {
    const grid = point.clone().sub(this.latticeMinimum).divideScalar(this.resolutionMm);
    if (grid.toArray().some((value) => value < 0 || value >= this.latticeSide)) return false;
    let node = this.root;
    while (node.children) {
      const half = node.span / 2;
      const index =
        (grid.x >= node.x + half ? 1 : 0) |
        (grid.y >= node.y + half ? 2 : 0) |
        (grid.z >= node.z + half ? 4 : 0);
      node = node.children[index];
    }
    if (node.state === 'solid') return true;
    if (node.state === 'pristine') return this.material.distance(point) < 0;
    if (!node.data) return false;
    const dx = grid.x - node.x,
      dy = grid.y - node.y,
      dz = grid.z - node.z;
    let field = 0;
    CELL_CORNERS.forEach(([x, y, z], i) => {
      field += node.data![i] * (x ? dx : 1 - dx) * (y ? dy : 1 - dy) * (z ? dz : 1 - dz);
    });
    return field < 0;
  }

  private release(node: StockNode, retain = false): void {
    if (node.state === 'pristine') {
      this.pristine.delete(node);
      this.dirtyChunks.add(this.chunkId(node.x, node.y, node.z));
    }
    if (node.children) for (const child of node.children) this.release(child);
    if (node.data) {
      this.dataBytes -= node.data.byteLength + 64;
      this.boundary.delete(this.id(node.x, node.y, node.z));
      this.dirtyChunks.add(this.chunkId(node.x, node.y, node.z));
    }
    if (!retain) this.nodeCount--;
    node.children = undefined;
    node.data = undefined;
    node.state = 'empty';
    node.occupied = 0;
  }

  subtract(volume: ImplicitVolume, test: () => void): void {
    const region = new THREE.Box3();
    const update = (node: StockNode): void => {
      if (node.state === 'empty') return;
      region.min.copy(this.point(node.x, node.y, node.z));
      region.max.copy(this.point(node.x + node.span, node.y + node.span, node.z + node.span));
      if (!region.intersectsBox(volume.bounds)) return;
      test();
      this.regionTests++;
      const distance = volume.distance(this.centreOf(node));
      const radius = (Math.sqrt(3) * node.span * this.resolutionMm) / 2;
      if (distance > radius) return;
      if (distance < -radius) {
        this.release(node, true);
        this.bulkRemovedRegions++;
        return;
      }
      if (node.span > 1) {
        if (!node.children) this.split(node);
        for (const child of node.children!) update(child);
        node.occupied = node.children!.reduce((count, child) => count + child.occupied, 0);
        if (node.children!.every((child) => child.state === 'empty')) this.release(node, true);
        return;
      }
      if (!node.data) this.makeBoundary(node);
      this.updateBoundary(node, volume, test);
    };
    update(this.root);
  }

  private updateBoundary(node: StockNode, volume: ImplicitVolume, test: () => void): void {
    const data = node.data!;
    const old = data.slice();
    const corners = CELL_CORNERS.map(([x, y, z]) => this.point(node.x + x, node.y + y, node.z + z));
    let changed = false;
    corners.forEach((point, i) => {
      test();
      data[i] = Math.max(old[i], -volume.distance(point));
      changed ||= data[i] !== old[i];
    });
    const centre = Math.max(old[CENTRE], -volume.distance(this.centreOf(node)));
    changed ||= centre !== old[CENTRE];
    data[CENTRE] = centre;
    node.occupied = centre < 0 ? 1 : 0;
    if (!changed) return;
    const point = new THREE.Vector3();
    for (const [index, [a, b]] of CELL_EDGES.entries()) {
      if (data[a] < 0 === data[b] < 0) {
        data[8 + index] = NaN;
        continue;
      }
      const previous = old[8 + index];
      if (Number.isFinite(previous) && data[a] < 0 === old[a] < 0) {
        test();
        const rootTolerance = Math.sqrt(3) * this.resolutionMm * 2 ** -24;
        if (volume.distance(point.copy(corners[a]).lerp(corners[b], previous)) >= -rootTolerance)
          continue;
      }
      const oldField = (t: number): number => {
        if (!Number.isFinite(previous) || previous <= 0 || previous >= 1)
          return old[a] + (old[b] - old[a]) * t;
        return t <= previous
          ? old[a] * (1 - t / previous)
          : old[b] * ((t - previous) / (1 - previous));
      };
      data[8 + index] = edgeRoot(data[a], data[b], (t) => {
        test();
        return Math.max(oldField(t), -volume.distance(point.copy(corners[a]).lerp(corners[b], t)));
      });
    }
    this.dirtyChunks.add(this.chunkId(node.x, node.y, node.z));
  }

  getBoundaryChunks(onlyChunks?: ReadonlySet<number>): Map<number, BoundaryCell[]> {
    const chunks = new Map<number, BoundaryCell[]>();
    let temporaryBytes = 0;
    const add = (cell: BoundaryCell): void => {
      const id = this.chunkId(cell.x, cell.y, cell.z);
      const cells = chunks.get(id) ?? [];
      cells.push(cell);
      chunks.set(id, cells);
    };
    for (const node of this.boundary.values()) {
      if (onlyChunks && !onlyChunks.has(this.chunkId(node.x, node.y, node.z))) continue;
      add({ x: node.x, y: node.y, z: node.z, data: node.data! });
    }
    const visitPristine = (x: number, y: number, z: number, span: number): void => {
      const half = span / 2;
      const distance = this.material.distance(this.point(x + half, y + half, z + half));
      if (Math.abs(distance) > (Math.sqrt(3) * span * this.resolutionMm) / 2) return;
      if (span > 1) {
        for (const [dx, dy, dz] of CELL_CORNERS)
          visitPristine(x + dx * half, y + dy * half, z + dz * half, half);
        return;
      }
      const data = this.boundaryData(x, y, z);
      if (CELL_EDGES.every((_, index) => !Number.isFinite(data[8 + index]))) return;
      temporaryBytes += data.byteLength + 128;
      this.budget(temporaryBytes);
      add({ x, y, z, data });
    };
    for (const node of this.pristine) {
      if (onlyChunks && !onlyChunks.has(this.chunkId(node.x, node.y, node.z))) continue;
      visitPristine(node.x, node.y, node.z, node.span);
    }
    return chunks;
  }
}
