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

export interface StockStorageOptions {
  compactUncrossedFields?: boolean;
  internBoundaryFields?: boolean;
  sparseBoundaryNormals?: boolean;
  sparseBoundaryRoots?: boolean;
}

interface StockNode {
  x: number;
  y: number;
  z: number;
  span: number;
  state: 'solid' | 'empty' | 'branch' | 'boundary' | 'pristine';
  children?: StockNode[];
  /** Dense or losslessly packed corner/centre fields and edge roots. */
  data?: Float64Array;
  normals?: Float32Array;
  occupied: number;
  shared?: SharedBoundaryData;
  sharedNormals?: SharedNormals;
  normalMask?: number;
  edgeMask?: number;
}

interface SharedNormals {
  hash: number;
  normals: Float32Array;
  references: number;
  owner?: StockNode;
}

interface SharedBoundaryData {
  hash: number;
  data: Float64Array;
  normals?: Float32Array;
  references: number;
  owner?: StockNode;
  edgeMask?: number;
}

export interface BoundaryCell {
  x: number;
  y: number;
  z: number;
  data: Float64Array;
  normals: Float32Array;
  span?: readonly [number, number, number];
  /** Packed normals contain only crossed edges, in ascending edge order. */
  normalMask?: number;
  /** Packed data: eight corners, centre, then finite roots in edge order. */
  edgeMask?: number;
}

export function boundaryEdgeRoot(cell: BoundaryCell, edge: number): number {
  const mask = cell.edgeMask;
  if (mask === undefined) return cell.data[8 + edge];
  const bit = 1 << edge;
  if (!(mask & bit)) return NaN;
  let before = mask & (bit - 1),
    count = 0;
  while (before) {
    before &= before - 1;
    count++;
  }
  return cell.data[9 + count];
}

export function boundaryCentreField(cell: BoundaryCell): number {
  return cell.data[cell.edgeMask === undefined ? 8 + CELL_EDGES.length : 8];
}

export function boundaryNormalComponent(
  cell: BoundaryCell,
  edge: number,
  component: number,
): number {
  const mask = cell.normalMask;
  if (mask === undefined) return cell.normals[edge * 3 + component];
  const bit = 1 << edge;
  if (!(mask & bit)) return 0;
  let before = mask & (bit - 1),
    count = 0;
  while (before) {
    before &= before - 1;
    count++;
  }
  return cell.normals[count * 3 + component];
}

const NODE_BYTES = 128;
const CENTRE = 8 + CELL_EDGES.length;
export const MAX_CACHED_CORNERS = 16_384;

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
  private readonly sharedFields = new Map<number, SharedBoundaryData[]>();
  private readonly fieldCandidates = new Map<SharedBoundaryData, StockNode>();
  private readonly normalFields = new Map<number, SharedNormals[]>();
  private readonly normalCandidates = new Map<SharedNormals, StockNode>();
  regionTests = 0;
  bulkRemovedRegions = 0;
  coveredRegions = 0;
  pristineSurfaceCells = 0;
  peakCornerCacheEntries = 0;

  constructor(
    readonly size: readonly [number, number, number],
    readonly resolutionMm: number,
    material: ImplicitVolume,
    private readonly limits: StockLimits = SIMULATION_LIMITS,
    private readonly storage: StockStorageOptions = {},
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
      this.coverage.length * 2304 +
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
      throw new Error(
        `Adaptive stock memory budget exceeded; use a coarser boundary spacing ` +
          `(retained ${(this.allocatedBytes / 1048576).toFixed(1)} MiB, workspace ${((this.subtractionWorkspaceBytes + extraBytes) / 1048576).toFixed(1)} MiB; ${this.nodeCount} nodes, ${this.boundary.size} refined cells)`,
      );
  }

  accountSurfaceWorkspace(bytes: number): void {
    this.budget(this.surfaceDataBytes + bytes);
  }

  canAccountSurfaceWorkspace(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error('Invalid surface workspace estimate');
    return (
      this.nodeCount <= this.limits.cells &&
      this.allocatedBytes + this.subtractionWorkspaceBytes + this.surfaceDataBytes + bytes <=
        this.limits.stockBytes
    );
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

  private fieldBytes(node: { data?: Float64Array; normals?: Float32Array }): number {
    return node.data?.byteLength ?? 0;
  }

  private forgetNormals(shared: SharedNormals): void {
    this.normalCandidates.delete(shared);
    const bucket = this.normalFields.get(shared.hash);
    const index = bucket?.indexOf(shared) ?? -1;
    if (!bucket || index < 0) throw new Error('Inconsistent shared normal field');
    bucket.splice(index, 1);
    if (!bucket.length) this.normalFields.delete(shared.hash);
    this.dataBytes -= 96;
  }

  private detachNormals(node: StockNode): void {
    const shared = node.sharedNormals;
    if (!shared) return;
    if (shared.owner === node) shared.owner = undefined;
    if (--shared.references === 0) this.forgetNormals(shared);
    else {
      node.normals = shared.normals.slice();
      this.dataBytes += node.normals.byteLength;
    }
    node.sharedNormals = undefined;
  }

  private shareNormals(node: StockNode): void {
    if (this.storage.internBoundaryFields === false || !node.normals) return;
    const normals = node.normals;
    let hash = 2166136261;
    const words = new Uint32Array(normals.buffer, normals.byteOffset, normals.byteLength / 4);
    for (const word of words) hash = Math.imul(hash ^ word, 16777619) >>> 0;
    const bucket = this.normalFields.get(hash) ?? [];
    const existing = bucket.find(
      (entry) =>
        entry.normals.length === normals.length &&
        entry.normals.every((value, index) => Object.is(value, normals[index])),
    );
    if (existing) {
      this.dataBytes -= normals.byteLength;
      node.normals = existing.normals;
      node.sharedNormals = existing;
      existing.references++;
      this.normalCandidates.delete(existing);
    } else {
      if (this.normalCandidates.size === 4096) {
        const oldest = this.normalCandidates.entries().next();
        if (oldest.done) throw new Error('Inconsistent normal field cache');
        const [entry, owner] = oldest.value;
        if (entry.references !== 1 || owner.sharedNormals !== entry)
          throw new Error('Inconsistent normal field ownership');
        owner.sharedNormals = undefined;
        this.forgetNormals(entry);
      }
      const shared = { hash, normals, references: 1, owner: node };
      bucket.push(shared);
      this.normalFields.set(hash, bucket);
      node.sharedNormals = shared;
      this.normalCandidates.set(shared, node);
      this.dataBytes += 96;
    }
  }

  private forgetShared(shared: SharedBoundaryData): void {
    this.fieldCandidates.delete(shared);
    const bucket = this.sharedFields.get(shared.hash);
    if (!bucket) throw new Error('Missing shared boundary field');
    const index = bucket.indexOf(shared);
    if (index < 0) throw new Error('Inconsistent shared boundary field');
    bucket.splice(index, 1);
    if (!bucket.length) this.sharedFields.delete(shared.hash);
    this.dataBytes -= 128;
  }

  private detachFields(node: StockNode): void {
    const shared = node.shared;
    if (!shared) return;
    if (shared.owner === node) shared.owner = undefined;
    if (--shared.references === 0) this.forgetShared(shared);
    else {
      node.data = shared.data.slice();
      this.dataBytes += this.fieldBytes(node);
      this.budget();
    }
    node.shared = undefined;
  }

  private shareFields(node: StockNode): void {
    if (this.storage.internBoundaryFields === false || !node.data) return;
    let hash = 2166136261;
    const fold = (array: Float64Array | Float32Array): void => {
      const words = new Uint32Array(array.buffer, array.byteOffset, array.byteLength / 4);
      for (const word of words) hash = Math.imul(hash ^ word, 16777619) >>> 0;
    };
    fold(node.data);
    if (node.normals) fold(node.normals);
    const bucket = this.sharedFields.get(hash) ?? [];
    const equal = (a: Float64Array | Float32Array, b: Float64Array | Float32Array): boolean =>
      a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
    const existing = bucket.find(
      (field) =>
        field.edgeMask === node.edgeMask &&
        equal(field.data, node.data!) &&
        (field.normals === undefined
          ? node.normals === undefined
          : node.normals !== undefined && equal(field.normals, node.normals)),
    );
    if (existing) {
      this.dataBytes -= this.fieldBytes(node);
      node.data = existing.data;
      node.shared = existing;
      existing.references++;
      this.fieldCandidates.delete(existing);
    } else {
      if (this.fieldCandidates.size === 4096) {
        const oldest = this.fieldCandidates.entries().next();
        if (oldest.done) throw new Error('Inconsistent boundary field cache');
        const [entry, owner] = oldest.value;
        if (entry.references !== 1 || owner.shared !== entry)
          throw new Error('Inconsistent boundary field ownership');
        owner.shared = undefined;
        this.forgetShared(entry);
      }
      const shared = {
        hash,
        data: node.data,
        normals: node.normals,
        references: 1,
        owner: node,
        edgeMask: node.edgeMask,
      };
      bucket.push(shared);
      this.sharedFields.set(hash, bucket);
      node.shared = shared;
      this.fieldCandidates.set(shared, node);
      this.dataBytes += 128;
    }
    this.budget();
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
      this.dataBytes -= 96;
      if (node.shared) {
        if (node.shared.owner === node) node.shared.owner = undefined;
        if (--node.shared.references === 0) {
          this.dataBytes -= this.fieldBytes(node);
          this.forgetShared(node.shared);
        }
      } else this.dataBytes -= this.fieldBytes(node);
      if (node.sharedNormals) {
        if (node.sharedNormals.owner === node) node.sharedNormals.owner = undefined;
        if (--node.sharedNormals.references === 0) {
          this.dataBytes -= node.sharedNormals.normals.byteLength;
          this.forgetNormals(node.sharedNormals);
        }
      } else this.dataBytes -= node.normals?.byteLength ?? 0;
      this.boundary.delete(this.id(node.x, node.y, node.z));
      this.dirtyChunks.add(this.chunkId(node.x, node.y, node.z));
    }
    if (!retain) this.nodeCount--;
    node.children = undefined;
    node.data = undefined;
    node.normals = undefined;
    node.shared = undefined;
    node.sharedNormals = undefined;
    node.normalMask = undefined;
    node.edgeMask = undefined;
    node.state = 'empty';
    node.occupied = 0;
  }

  subtract(volume: ImplicitVolume, test: () => void): void {
    if (volume.identity && this.completedVolumes.includes(volume.identity)) {
      this.coveredRegions++;
      return;
    }
    const workspace = volume.workspaceBytes ?? 0;
    if (!Number.isSafeInteger(workspace) || workspace < 0)
      throw new Error('Invalid cutter workspace estimate');
    this.subtractionWorkspaceBytes = workspace;
    try {
      this.budget();
    } catch (error) {
      this.subtractionWorkspaceBytes = 0;
      throw error;
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
        if (corners.size === MAX_CACHED_CORNERS) {
          const oldest = corners.keys().next();
          if (oldest.done) throw new Error('Inconsistent subtraction corner cache');
          corners.delete(oldest.value);
        }
        corners.set(key, distance);
        this.peakCornerCacheEntries = Math.max(this.peakCornerCacheEntries, corners.size);
        this.subtractionWorkspaceBytes = workspace + corners.size * 64;
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
      const certificate = volume.axialCoverage ?? volume.sweepCoverage;
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
          if (certificate.partial === false) return false;
          if (certificate.projected && low >= previous.lower && high <= previous.upper) return true;
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
      this.detachNormals(node);
      this.detachFields(node);
      if (node.data!.length === 9) {
        const compact = node.data!;
        const data = new Float64Array(CENTRE + 1);
        data.fill(NaN, 8, CENTRE);
        data.set(compact.subarray(0, 8));
        data[CENTRE] = compact[8];
        node.data = data;
        node.normals = new Float32Array(CELL_EDGES.length * 3);
        node.edgeMask = undefined;
        this.dataBytes += data.byteLength + node.normals.byteLength - compact.byteLength;
        this.budget();
      }
      if (node.edgeMask !== undefined) {
        const mask = node.edgeMask;
        const packed = node.data!;
        const data = new Float64Array(CENTRE + 1);
        data.set(packed.subarray(0, 8));
        data[CENTRE] = packed[8];
        data.fill(NaN, 8, CENTRE);
        let offset = 9;
        for (let edge = 0; edge < CELL_EDGES.length; edge++)
          if (mask & (1 << edge)) data[8 + edge] = packed[offset++];
        this.dataBytes += data.byteLength - packed.byteLength;
        node.data = data;
        node.edgeMask = undefined;
        this.budget();
      }
      if (node.normalMask !== undefined) {
        const mask = node.normalMask;
        const packed = node.normals!;
        const normals = new Float32Array(CELL_EDGES.length * 3);
        let offset = 0;
        for (let edge = 0; edge < CELL_EDGES.length; edge++)
          if (mask & (1 << edge)) {
            normals.set(packed.subarray(offset, offset + 3), edge * 3);
            offset += 3;
          }
        this.dataBytes += normals.byteLength - packed.byteLength;
        node.normals = normals;
        node.normalMask = undefined;
        this.budget();
      }
      this.updateBoundary(node, checked, cornerDistance);
      if (node.data![CENTRE] >= 0 && node.data!.subarray(0, 8).every((value) => value >= 0)) {
        this.release(node, true);
        return;
      }
      if (
        this.storage.compactUncrossedFields !== false &&
        CELL_EDGES.every((_, index) => !Number.isFinite(node.data![8 + index]))
      ) {
        const data = node.data!;
        const compact = new Float64Array(9);
        compact.set(data.subarray(0, 8));
        compact[8] = data[CENTRE];
        this.dataBytes -= data.byteLength + node.normals!.byteLength - compact.byteLength;
        node.data = compact;
        node.normals = undefined;
      }
      if (node.normals && this.storage.sparseBoundaryNormals !== false) {
        let mask = 0,
          count = 0;
        for (let edge = 0; edge < CELL_EDGES.length; edge++)
          if (Number.isFinite(node.data![8 + edge])) {
            mask |= 1 << edge;
            count++;
          }
        const normals = new Float32Array(count * 3);
        let offset = 0;
        for (let edge = 0; edge < CELL_EDGES.length; edge++)
          if (mask & (1 << edge)) {
            normals.set(node.normals.subarray(edge * 3, edge * 3 + 3), offset);
            offset += 3;
          }
        this.dataBytes -= node.normals.byteLength - normals.byteLength;
        node.normals = normals;
        node.normalMask = mask;
      }
      if (node.data!.length === CENTRE + 1 && this.storage.sparseBoundaryRoots !== false) {
        const full = node.data!;
        let mask = 0,
          count = 0;
        for (let edge = 0; edge < CELL_EDGES.length; edge++)
          if (Number.isFinite(full[8 + edge])) {
            mask |= 1 << edge;
            count++;
          }
        const data = new Float64Array(9 + count);
        data.set(full.subarray(0, 8));
        data[8] = full[CENTRE];
        let offset = 9;
        for (let edge = 0; edge < CELL_EDGES.length; edge++)
          if (mask & (1 << edge)) data[offset++] = full[8 + edge];
        this.dataBytes -= full.byteLength - data.byteLength;
        node.data = data;
        node.edgeMask = mask;
      }
      this.shareNormals(node);
      this.shareFields(node);
    };
    try {
      update(this.root);
      const certificate = volume.axialCoverage ?? volume.sweepCoverage;
      if (certificate && certificate.key.length <= 1024) {
        if (this.coverage.length === 128) this.coverage.shift();
        this.coverage.push(certificate);
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
    this.pristineSurfaceCells = 0;
    return this.collectBoundaryChunks(this.boundary.values(), this.pristine, onlyChunks);
  }

  *iterateBoundaryChunks(
    onlyChunks?: ReadonlySet<number>,
    retainedWorkspace: () => number = () => 0,
  ): IterableIterator<readonly [number, BoundaryCell[]]> {
    const groups = new Map<number, { boundary: StockNode[]; pristine: StockNode[] }>();
    let groupBytes = 0;
    this.pristineSurfaceCells = 0;
    this.surfaceDataBytes = 0;
    try {
      const add = (node: StockNode, kind: 'boundary' | 'pristine'): void => {
        const id = this.chunkId(node.x, node.y, node.z);
        if (onlyChunks && !onlyChunks.has(id)) return;
        let group = groups.get(id);
        groupBytes += 16 + (group ? 0 : 320);
        this.budget(groupBytes + retainedWorkspace());
        if (!group) {
          group = { boundary: [], pristine: [] };
          groups.set(id, group);
        }
        group[kind].push(node);
      };
      for (const node of this.boundary.values()) if (node.data!.length !== 9) add(node, 'boundary');
      for (const node of this.pristine) add(node, 'pristine');
      for (const [id, group] of groups) {
        this.surfaceDataBytes = groupBytes;
        const cells = this.collectBoundaryChunks(
          group.boundary,
          group.pristine,
          undefined,
          groupBytes,
          retainedWorkspace,
          true,
        ).get(id);
        if (cells?.length) yield [id, cells];
        groups.delete(id);
        groupBytes -= 320 + 16 * (group.boundary.length + group.pristine.length);
        this.surfaceDataBytes = groupBytes;
      }
    } finally {
      this.surfaceDataBytes = 0;
    }
  }

  private collectBoundaryChunks(
    boundary: Iterable<StockNode>,
    pristine: Iterable<StockNode>,
    onlyChunks?: ReadonlySet<number>,
    retainedWorkspace = 0,
    externalWorkspace: () => number = () => 0,
    accountWrappers = false,
  ): Map<number, BoundaryCell[]> {
    const chunks = new Map<number, BoundaryCell[]>();
    let temporaryBytes = 0;
    const add = (cell: BoundaryCell): void => {
      const id = this.chunkId(cell.x, cell.y, cell.z);
      const cells = chunks.get(id) ?? [];
      cells.push(cell);
      chunks.set(id, cells);
    };
    for (const node of boundary) {
      if (onlyChunks && !onlyChunks.has(this.chunkId(node.x, node.y, node.z))) continue;
      if (node.data!.length === 9) continue;
      if (accountWrappers) {
        temporaryBytes += 160;
        this.budget(retainedWorkspace + temporaryBytes + externalWorkspace());
      }
      add({
        x: node.x,
        y: node.y,
        z: node.z,
        data: node.data!,
        normals: node.normals!,
        normalMask: node.normalMask,
        edgeMask: node.edgeMask,
      });
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
      this.budget(retainedWorkspace + temporaryBytes + externalWorkspace());
      add(cell);
      this.pristineSurfaceCells++;
    };
    for (const node of pristine) {
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
              this.budget(retainedWorkspace + temporaryBytes + externalWorkspace());
              this.pristineSurfaceCells++;
              add(cell);
            }
      } else visitPristine(node.x, node.y, node.z, node.span);
    }
    this.surfaceDataBytes = retainedWorkspace + temporaryBytes;
    return chunks;
  }
}
