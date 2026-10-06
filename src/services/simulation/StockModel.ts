import * as THREE from 'three';
import { SIMULATION_LIMITS } from './SimulationTypes';
import {
  CELL_CORNERS,
  CELL_EDGES,
  edgeRoot,
  surfaceNormal,
  type ImplicitVolume,
} from './ImplicitGeometry';

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
  normals?: Float32Array;
  occupied: number;
}

export interface BoundaryCell {
  x: number;
  y: number;
  z: number;
  data: Float64Array;
  normals: Float32Array;
  span?: readonly [number, number, number];
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
  private readonly intersectionTolerance: number;
  private nodeCount = 0;
  private dataBytes = 0;
  private initialCells = 0;
  private peakBytes = 0;
  private surfaceDataBytes = 0;
  private subtractionWorkspaceBytes = 0;
  private readonly coverage: NonNullable<ImplicitVolume['axialCoverage']>[] = [];
  private readonly completedVolumes: string[] = [];
  regionTests = 0;
  bulkRemovedRegions = 0;
  coveredRegions = 0;
  pristineSurfaceCells = 0;

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
    this.intersectionTolerance = Math.min(resolutionMm * 2 ** -24, 1e-7);
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
    return (
      this.nodeCount * NODE_BYTES +
      this.dataBytes +
      this.coverage.length * 1024 +
      this.completedVolumes.length * 2176
    );
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
    const bytes = this.allocatedBytes + this.subtractionWorkspaceBytes + extraBytes;
    this.peakBytes = Math.max(this.peakBytes, bytes);
    if (this.nodeCount > this.limits.cells) throw new Error('Adaptive stock cell budget exceeded');
    if (bytes > this.limits.stockBytes)
      throw new Error('Adaptive stock memory budget exceeded; use a coarser boundary spacing');
  }

  accountSurfaceWorkspace(bytes: number): void {
    this.budget(this.surfaceDataBytes + bytes);
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
    const cell = this.boundaryData(node.x, node.y, node.z);
    node.data = cell.data;
    node.normals = cell.normals;
    this.dataBytes += node.data.byteLength + node.normals.byteLength + 96;
    this.budget();
    node.state = 'boundary';
    node.occupied = node.data[CENTRE] < 0 ? 1 : 0;
    this.boundary.set(this.id(node.x, node.y, node.z), node);
    this.dirtyChunks.add(this.chunkId(node.x, node.y, node.z));
  }

  private boundaryData(
    x: number,
    y: number,
    z: number,
    span: readonly [number, number, number] = [1, 1, 1],
  ): BoundaryCell {
    const data = new Float64Array(CENTRE + 1);
    const normals = new Float32Array(CELL_EDGES.length * 3);
    data.fill(NaN, 8, CENTRE);
    const corners = CELL_CORNERS.map(([dx, dy, dz]) =>
      this.point(x + dx * span[0], y + dy * span[1], z + dz * span[2]),
    );
    corners.forEach((point, index) => {
      data[index] = this.material.distance(point);
    });
    for (const [index, [a, b]] of CELL_EDGES.entries()) {
      if (data[a] < 0 === data[b] < 0) continue;
      const point = new THREE.Vector3();
      data[8 + index] = edgeRoot(
        data[a],
        data[b],
        (t) => this.material.distance(point.copy(corners[a]).lerp(corners[b], t)),
        this.intersectionTolerance / corners[a].distanceTo(corners[b]),
      );
      point.copy(corners[a]).lerp(corners[b], data[8 + index]);
      surfaceNormal(this.material, point, this.resolutionMm * 1e-4).toArray(normals, index * 3);
    }
    data[CENTRE] = this.material.distance(
      this.point(x + span[0] / 2, y + span[1] / 2, z + span[2] / 2),
    );
    return { x, y, z, data, normals, span };
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
      this.dataBytes -= node.data.byteLength + (node.normals?.byteLength ?? 0) + 96;
      this.boundary.delete(this.id(node.x, node.y, node.z));
      this.dirtyChunks.add(this.chunkId(node.x, node.y, node.z));
    }
    if (!retain) this.nodeCount--;
    node.children = undefined;
    node.data = undefined;
    node.normals = undefined;
    node.state = 'empty';
    node.occupied = 0;
  }

  subtract(volume: ImplicitVolume, test: () => void): void {
    if (volume.identity && this.completedVolumes.includes(volume.identity)) {
      this.coveredRegions++;
      return;
    }
    const checked: ImplicitVolume = {
      ...volume,
      distance: (point) => {
        test();
        const distance = volume.distance(point);
        if (!Number.isFinite(distance)) throw new Error('Non-finite cutter distance field');
        return distance;
      },
      normal: volume.normal
        ? (point, target) => {
            test();
            return volume.normal!(point, target);
          }
        : undefined,
    };
    const corners = new Map<number, number>();
    const side = this.latticeSide + 1;
    const cornerDistance = (x: number, y: number, z: number, point: THREE.Vector3): number => {
      const key = x + side * (y + side * z);
      let distance = corners.get(key);
      if (distance === undefined) {
        distance = checked.distance(point);
        corners.set(key, distance);
        this.subtractionWorkspaceBytes = corners.size * 64;
        this.budget();
      }
      return distance;
    };
    const region = new THREE.Box3();
    const update = (node: StockNode): void => {
      if (node.state === 'empty') return;
      region.min.copy(this.point(node.x, node.y, node.z));
      region.max.copy(this.point(node.x + node.span, node.y + node.span, node.z + node.span));
      if (!region.intersectsBox(volume.bounds)) return;
      const certificate = volume.axialCoverage;
      if (certificate) {
        const half = (node.span * this.resolutionMm) / 2;
        const axis = certificate.axis;
        const axial = axis.dot(this.centreOf(node));
        const extent = half * (Math.abs(axis.x) + Math.abs(axis.y) + Math.abs(axis.z));
        const roundoff = 64 * Number.EPSILON * Math.max(1, Math.abs(axial), extent);
        const low = axial - extent - roundoff,
          high = axial + extent + roundoff;
        const dominated = this.coverage.some((previous) => {
          if (previous.key !== certificate.key) return false;
          if (previous.lower <= certificate.lower && previous.upper >= certificate.upper)
            return true;
          if (previous.lower <= certificate.lower)
            return high <= (certificate.lower + previous.upper) / 2;
          if (previous.upper >= certificate.upper)
            return low >= (previous.lower + certificate.upper) / 2;
          return false;
        });
        if (dominated) {
          this.coveredRegions++;
          return;
        }
      }
      this.regionTests++;
      const distance = checked.distance(this.centreOf(node));
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
      this.updateBoundary(node, checked, cornerDistance);
    };
    try {
      update(this.root);
      if (volume.axialCoverage) {
        if (this.coverage.length === 128) this.coverage.shift();
        this.coverage.push(volume.axialCoverage);
        this.budget();
      }
      if (volume.identity && volume.identity.length <= 1024) {
        if (this.completedVolumes.length === 32) this.completedVolumes.shift();
        this.completedVolumes.push(volume.identity);
        this.budget();
      }
    } finally {
      this.subtractionWorkspaceBytes = 0;
    }
  }

  private updateBoundary(
    node: StockNode,
    volume: ImplicitVolume,
    cornerDistance: (x: number, y: number, z: number, point: THREE.Vector3) => number,
  ): void {
    const data = node.data!;
    const old = data.slice();
    const corners = CELL_CORNERS.map(([x, y, z]) => this.point(node.x + x, node.y + y, node.z + z));
    let changed = false;
    corners.forEach((point, i) => {
      const [x, y, z] = CELL_CORNERS[i];
      data[i] = Math.max(old[i], -cornerDistance(node.x + x, node.y + y, node.z + z, point));
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
        if (
          volume.distance(point.copy(corners[a]).lerp(corners[b], previous)) >=
          -this.intersectionTolerance
        )
          continue;
      }
      const oldField = (t: number): number => {
        if (!Number.isFinite(previous) || previous <= 0 || previous >= 1)
          return old[a] + (old[b] - old[a]) * t;
        return t <= previous
          ? old[a] * (1 - t / previous)
          : old[b] * ((t - previous) / (1 - previous));
      };
      data[8 + index] = edgeRoot(
        data[a],
        data[b],
        (t) => {
          return Math.max(
            oldField(t),
            -volume.distance(point.copy(corners[a]).lerp(corners[b], t)),
          );
        },
        this.intersectionTolerance / corners[a].distanceTo(corners[b]),
      );
      point.copy(corners[a]).lerp(corners[b], data[8 + index]);
      if (-volume.distance(point) >= oldField(data[8 + index]) - this.intersectionTolerance) {
        surfaceNormal(volume, point, this.resolutionMm * 1e-4)
          .negate()
          .toArray(node.normals!, index * 3);
      }
    }
    this.dirtyChunks.add(this.chunkId(node.x, node.y, node.z));
  }

  getBoundaryChunks(onlyChunks?: ReadonlySet<number>): Map<number, BoundaryCell[]> {
    const chunks = new Map<number, BoundaryCell[]>();
    this.pristineSurfaceCells = 0;
    let temporaryBytes = 0;
    const add = (cell: BoundaryCell): void => {
      const id = this.chunkId(cell.x, cell.y, cell.z);
      const cells = chunks.get(id) ?? [];
      cells.push(cell);
      chunks.set(id, cells);
    };
    for (const node of this.boundary.values()) {
      if (onlyChunks && !onlyChunks.has(this.chunkId(node.x, node.y, node.z))) continue;
      add({ x: node.x, y: node.y, z: node.z, data: node.data!, normals: node.normals! });
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
      const cell = this.boundaryData(x, y, z);
      if (CELL_EDGES.every((_, index) => !Number.isFinite(cell.data[8 + index]))) return;
      temporaryBytes += cell.data.byteLength + cell.normals.byteLength + 160;
      this.budget(temporaryBytes);
      add(cell);
      this.pristineSurfaceCells++;
    };
    for (const node of this.pristine) {
      if (onlyChunks && !onlyChunks.has(this.chunkId(node.x, node.y, node.z))) continue;
      const low = this.point(node.x, node.y, node.z);
      const high = this.point(node.x + node.span, node.y + node.span, node.z + node.span);
      const extrusion = this.material.extrusion?.find(
        ({ axis, minimum, maximum }) =>
          low.getComponent(axis) > minimum && high.getComponent(axis) < maximum,
      );
      const extrusionAxis =
        extrusion?.axis ?? this.material.planarExtrusionAxis?.(new THREE.Box3(low, high));
      if (extrusionAxis !== undefined && node.span > 1) {
        // Preserve the fine cross-section contour; extrusion adds zero chord error.
        const span: [number, number, number] = [1, 1, 1];
        span[extrusionAxis] = node.span;
        for (let z = node.z; z < node.z + node.span; z += span[2])
          for (let y = node.y; y < node.y + node.span; y += span[1])
            for (let x = node.x; x < node.x + node.span; x += span[0]) {
              const centre = this.point(x + span[0] / 2, y + span[1] / 2, z + span[2] / 2);
              if (Math.abs(this.material.distance(centre)) > Math.SQRT1_2 * this.resolutionMm)
                continue;
              const cell = this.boundaryData(x, y, z, span);
              if (CELL_EDGES.every((_, index) => !Number.isFinite(cell.data[8 + index]))) continue;
              temporaryBytes += cell.data.byteLength + cell.normals.byteLength + 160;
              this.budget(temporaryBytes);
              this.pristineSurfaceCells++;
              add(cell);
            }
      } else visitPristine(node.x, node.y, node.z, node.span);
    }
    this.surfaceDataBytes = temporaryBytes;
    return chunks;
  }
}
