import * as THREE from 'three';
import {
  StockModel,
  boundaryEdgeRoot,
  boundaryNormalComponent,
  type BoundaryCell,
  type BoundaryCoordinates,
  type BoundaryTopology,
} from './StockModel';
import { CELL_CORNERS, CELL_EDGES, edgeIndex } from './ImplicitGeometry';
import { boundedQef, type HermiteSample } from './HermiteQef';
import { SIMULATION_LIMITS, type StockSurfaceChunk } from './SimulationTypes';
import { adaptSurface, surfaceAdaptationWorkspaceBound } from './SurfaceAdaptation';

export const MAX_TOPOLOGY_CACHE_BYTES = 32 * 1024 * 1024;
const TOPOLOGY_WORDS = 7;

const FACES = [
  { axis: 0, side: 0, corners: [0, 2, 6, 4] },
  { axis: 0, side: 1, corners: [1, 3, 7, 5] },
  { axis: 1, side: 0, corners: [0, 1, 5, 4] },
  { axis: 1, side: 1, corners: [2, 3, 7, 6] },
  { axis: 2, side: 0, corners: [0, 1, 3, 2] },
  { axis: 2, side: 1, corners: [4, 5, 7, 6] },
].map((face) => ({
  ...face,
  edges: face.corners.map((a, i) => edgeIndex(a, face.corners[(i + 1) % 4])),
}));

interface Segment {
  a: number;
  b: number;
  axis: number;
  side: number;
}

interface SurfaceVertex {
  point: THREE.Vector3;
  samples: readonly HermiteSample[];
}

export interface StockChunkMeshDiagnostics {
  id: number;
  cells: number;
  analyticalPanels: number;
  fineTriangles: number;
  outputTriangles: number;
  triangulationMs: number;
  adaptationMs: number;
  elapsedMs: number;
}

const PLANE_EDGES = [
  [0, 1, 3, 2],
  [4, 5, 7, 6],
  [8, 9, 11, 10],
] as const;

function seamKey(cell: BoundaryCoordinates, axis: number, side: number, direction: number): string {
  const coordinates = [cell.x, cell.y, cell.z];
  const other = 3 - axis - direction;
  return `${axis}:${coordinates[axis] + side * (cell.span?.[axis] ?? 1)}:${coordinates[other]}:${direction}`;
}

function triangleCapacity(
  cell: BoundaryCell,
  seams: ReadonlyMap<string, ReadonlySet<number>>,
): number {
  const span = Math.max(...(cell.span ?? [1, 1, 1]));
  if (span === 1 && planarEdges(cell)) return 2;
  let segments = 0;
  const direction = cell.span?.findIndex((size) => size > 1) ?? -1;
  for (const face of FACES) {
    let crossings = 0;
    for (const edge of face.edges) if (Number.isFinite(boundaryEdgeRoot(cell, edge))) crossings++;
    segments += crossings;
    if (crossings && direction >= 0 && face.axis !== direction) {
      const start = [cell.x, cell.y, cell.z][direction];
      for (const level of seams.get(seamKey(cell, face.axis, face.side, direction)) ?? [])
        if (level > start && level < start + span) segments++;
    }
  }
  return segments;
}

function planarEdges(cell: BoundaryCell): readonly number[] | undefined {
  let mask = 0;
  for (let i = 0; i < CELL_EDGES.length; i++)
    if (Number.isFinite(boundaryEdgeRoot(cell, i))) mask |= 1 << i;
  const axis = [15, 240, 3840].indexOf(mask);
  if (axis < 0) return undefined;
  const edges = PLANE_EDGES[axis];
  const sign = cell.data[CELL_EDGES[edges[0]][0]] < 0 ? 1 : -1;
  if (
    edges.some((edge) =>
      [0, 1, 2].some(
        (component) =>
          boundaryNormalComponent(cell, edge, component) !== (component === axis ? sign : 0),
      ),
    )
  )
    return undefined;
  return sign * (axis === 1 ? -1 : 1) > 0 ? edges : [...edges].reverse();
}

function segments(cell: BoundaryCell, orient = true): Segment[] {
  const result: Segment[] = [];
  for (const face of FACES) {
    const crossing = face.edges.filter((edge) => Number.isFinite(boundaryEdgeRoot(cell, edge)));
    const add = (a: number, b: number): void => {
      if (orient) {
        const axes = [0, 1, 2].filter((axis) => axis !== face.axis);
        const position = (edge: number, axis: number): number => {
          const [start, end] = CELL_EDGES[edge];
          // Symbolic half-edge positions orient coincident zero-field crossings consistently.
          return (CELL_CORNERS[start][axis] + CELL_CORNERS[end][axis]) / 2;
        };
        const au = position(a, axes[0]),
          av = position(a, axes[1]);
        const bu = position(b, axes[0]),
          bv = position(b, axes[1]);
        const u = (au + bu) / 2,
          v = (av + bv) / 2;
        const [f0, f1, f2, f3] = face.corners.map((corner) => (cell.data[corner] < 0 ? -1 : 1));
        const du = (f1 - f0) * (1 - v) + (f2 - f3) * v;
        const dv = (f3 - f0) * (1 - u) + (f2 - f1) * u;
        const sign = (face.side ? 1 : -1) * (face.axis === 1 ? -1 : 1);
        if (((bu - au) * dv - (bv - av) * du) * sign < 0) [a, b] = [b, a];
      }
      result.push({ a, b, axis: face.axis, side: face.side });
    };
    if (crossing.length === 2) add(crossing[0], crossing[1]);
    else if (crossing.length === 4) {
      const [a, b, c, d] = face.corners.map((corner) => cell.data[corner]);
      const denominator = a + c - b - d;
      const saddle = denominator ? (a * c - b * d) / denominator : (a + b + c + d) / 4;
      // The same bilinear face decider is used by both cells, including exact-zero ties.
      if (saddle < 0 === a < 0) {
        add(crossing[0], crossing[1]);
        add(crossing[2], crossing[3]);
      } else {
        add(crossing[3], crossing[0]);
        add(crossing[1], crossing[2]);
      }
    } else if (crossing.length !== 0) throw new Error('Inconsistent Hermite face intersections');
  }
  return result;
}

function patchNormal(samples: readonly HermiteSample[], reference: THREE.Vector3): THREE.Vector3 {
  if (samples.length === 1 && samples[0].normal.dot(reference) > 0.85) return samples[0].normal;
  const result = new THREE.Vector3();
  for (const sample of samples) if (sample.normal.dot(reference) > 0.85) result.add(sample.normal);
  if (result.lengthSq() < 1e-20) return reference.clone();
  return result.normalize();
}

function triangulateContour(projected: THREE.Vector2[]): number[][] | undefined {
  const triangles = THREE.ShapeUtils.triangulateShape(projected, []);
  const used = new Set(triangles.flat());
  for (let i = 0; i < triangles.length; i++) {
    const triangle = triangles[i];
    for (let edge = 0; edge < 3; edge++) {
      const a = triangle[edge],
        b = triangle[(edge + 1) % 3],
        c = triangle[(edge + 2) % 3];
      let chain: number[] | undefined;
      for (const direction of [1, -1]) {
        const path = [a];
        let index = (a + direction + projected.length) % projected.length;
        while (index !== b && !used.has(index)) {
          path.push(index);
          index = (index + direction + projected.length) % projected.length;
        }
        if (index === b && path.length > 1) {
          chain = [...path, b];
          break;
        }
      }
      if (!chain) continue;
      // Earcut drops projected-collinear vertices. Retain them: their 3D positions
      // can form a crease and neighbouring cells still use these boundary edges.
      const split = chain.slice(0, -1).map((index, j) => [index, chain![j + 1], c]);
      triangles.splice(i, 1, ...split);
      for (const index of chain) used.add(index);
      i--;
      break;
    }
  }
  if (triangles.length !== projected.length - 2) return undefined;
  let orientation = 0;
  for (const triangle of triangles)
    for (let i = 0; i < 3 && !orientation; i++) {
      const a = triangle[i],
        b = triangle[(i + 1) % 3];
      if ((a + 1) % projected.length === b) orientation = 1;
      else if ((b + 1) % projected.length === a) orientation = -1;
    }
  if (!orientation) return undefined;
  if (orientation < 0)
    for (const triangle of triangles) [triangle[1], triangle[2]] = [triangle[2], triangle[1]];
  const edges = new Map<string, { count: number; balance: number }>();
  for (const triangle of triangles)
    for (let i = 0; i < 3; i++) {
      const a = triangle[i],
        b = triangle[(i + 1) % 3];
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      const edge = edges.get(key) ?? { count: 0, balance: 0 };
      edge.count++;
      edge.balance += a < b ? 1 : -1;
      edges.set(key, edge);
    }
  for (let a = 0; a < projected.length; a++) {
    const b = (a + 1) % projected.length;
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    const edge = edges.get(key);
    if (!edge || edge.count !== 1 || edge.balance !== (a < b ? 1 : -1)) return undefined;
    edges.delete(key);
  }
  if ([...edges.values()].some((edge) => edge.count !== 2 || edge.balance !== 0)) return undefined;
  return triangles;
}

export class StockMeshBuilder {
  readonly chunkDiagnostics: StockChunkMeshDiagnostics[] = [];
  extractionMs = 0;
  private readonly cache = new Map<number, StockSurfaceChunk>();
  private triangles = 0;
  private readonly surfaceToleranceRatio: number;
  private skippedAdaptationChunks = 0;
  private intersectionCachePeak = 0;
  private readonly topologyCacheBytes: number;
  private warnedTopologyCache = false;
  topologyPasses = 0;
  topologyReused = false;
  topologyCachePeakBytes = 0;

  /** Cumulative chunk rebuilds retaining fine geometry due to optional workspace. */
  get skippedChunks(): number {
    return this.skippedAdaptationChunks;
  }

  get peakIntersectionCacheEntries(): number {
    return this.intersectionCachePeak;
  }

  private surfaceCacheBytes(): number {
    return this.triangles * 72 + this.cache.size * 256;
  }

  constructor(
    private readonly faceLimit: number = SIMULATION_LIMITS.surfaceFaces,
    options: { surfaceToleranceRatio?: number; topologyCacheBytes?: number } = {},
  ) {
    this.topologyCacheBytes = options.topologyCacheBytes ?? MAX_TOPOLOGY_CACHE_BYTES;
    if (!Number.isSafeInteger(this.topologyCacheBytes) || this.topologyCacheBytes < 0 ||
      this.topologyCacheBytes > MAX_TOPOLOGY_CACHE_BYTES)
      throw new Error('Invalid bounded topology cache capacity');
    this.surfaceToleranceRatio = options.surfaceToleranceRatio ?? 0.1;
    if (
      !Number.isFinite(this.surfaceToleranceRatio) ||
      this.surfaceToleranceRatio < 0 ||
      this.surfaceToleranceRatio > 0.1
    )
      throw new Error('Surface tolerance ratio must be finite and between 0 and 0.1');
  }

  private visitTriangles(
    stock: StockModel,
    cells: readonly BoundaryCell[],
    intersections: Map<string, HermiteSample>,
    seams: ReadonlyMap<string, ReadonlySet<number>>,
    workspaceBytes: number,
    visit: (
      points: readonly THREE.Vector3[],
      normals: readonly THREE.Vector3[],
      adaptable: boolean,
    ) => void,
  ): void {
    const rounded = (point: THREE.Vector3): THREE.Vector3 =>
      point.set(Math.fround(point.x), Math.fround(point.y), Math.fround(point.z));
    const vertices: THREE.Vector3[] = [];
    const directions: THREE.Vector3[] = [];
    const direction = new THREE.Vector3();
    const secondEdge = new THREE.Vector3();
    let adaptable = false;
    const emit = (points: readonly SurfaceVertex[]): void => {
      for (let i = 0; i < 3; i++) vertices[i] = points[i].point;
      direction
        .copy(vertices[1])
        .sub(vertices[0])
        .cross(secondEdge.copy(vertices[2]).sub(vertices[0]));
      if (direction.lengthSq() === 0) return;
      direction.normalize();
      for (let i = 0; i < 3; i++) directions[i] = patchNormal(points[i].samples, direction);
      visit(vertices, directions, adaptable);
    };
    for (const cell of cells) {
      adaptable = cell.span === undefined;
      const span = cell.span ?? [1, 1, 1];
      const extrusionAxis = span.findIndex((size) => size > 1);
      const samples = CELL_EDGES.map(([a, b], index): HermiteSample | undefined => {
        const t = boundaryEdgeRoot(cell, index);
        if (!Number.isFinite(t)) return undefined;
        const first = CELL_CORNERS[a],
          last = CELL_CORNERS[b];
        const edgeAxis = first.findIndex((coordinate, axis) => coordinate !== last[axis]);
        const key = `${cell.x + first[0] * span[0]},${cell.y + first[1] * span[1]},${cell.z + first[2] * span[2]}:${b - a}:${span[edgeAxis]}`;
        let sample = intersections.get(key);
        if (!sample) {
          const point = new THREE.Vector3(
            cell.x + first[0] * span[0],
            cell.y + first[1] * span[1],
            cell.z + first[2] * span[2],
          )
            .lerp(
              new THREE.Vector3(
                cell.x + last[0] * span[0],
                cell.y + last[1] * span[1],
                cell.z + last[2] * span[2],
              ),
              t,
            )
            .multiplyScalar(stock.resolutionMm)
            .add(stock.latticeMinimum);
          const normal = new THREE.Vector3(
            boundaryNormalComponent(cell, index, 0),
            boundaryNormalComponent(cell, index, 1),
            boundaryNormalComponent(cell, index, 2),
          );
          if (!Number.isFinite(normal.lengthSq()) || normal.lengthSq() < 0.5)
            throw new Error('Missing Hermite surface normal');
          sample = { point: rounded(point), normal: normal.normalize() };
          intersections.set(key, sample);
          this.intersectionCachePeak = Math.max(this.intersectionCachePeak, intersections.size);
        }
        return sample;
      });
      const plane = planarEdges(cell);
      if (plane && extrusionAxis < 0) {
        const vertices = plane.map((index) => samples[index]!);
        const normal = vertices[0].normal;
        visit(
          [vertices[0].point, vertices[1].point, vertices[2].point],
          [normal, normal, normal],
          adaptable,
        );
        visit(
          [vertices[0].point, vertices[2].point, vertices[3].point],
          [normal, normal, normal],
          adaptable,
        );
        stock.accountSurfaceWorkspace(workspaceBytes + intersections.size * 256 + 8192);
        continue;
      }
      const minimum = new THREE.Vector3(cell.x, cell.y, cell.z)
        .multiplyScalar(stock.resolutionMm)
        .add(stock.latticeMinimum);
      const bounds = new THREE.Box3(
        minimum,
        minimum.clone().add(new THREE.Vector3(...span).multiplyScalar(stock.resolutionMm)),
      );
      const contour = segments(cell);
      const parent = CELL_EDGES.map((_, i) => i);
      const root = (i: number): number => {
        while (parent[i] !== i) i = parent[i];
        return i;
      };
      for (const segment of contour) parent[root(segment.a)] = root(segment.b);
      const patches = new Map<number, HermiteSample[]>();
      samples.forEach((sample, i) => {
        if (!sample) return;
        const id = root(i),
          patch = patches.get(id) ?? [];
        patch.push(sample);
        patches.set(id, patch);
      });
      for (const [id, patch] of patches) {
        const sharp = patch.some((a) => patch.some((b) => a.normal.dot(b.normal) <= 0.85));
        const edges = contour.filter((segment) => root(segment.a) === id);
        const polygon: SurfaceVertex[] = [];
        const first = edges[0].a;
        let previous: Segment | undefined,
          current = first,
          steps = 0;
        do {
          polygon.push({ point: samples[current]!.point, samples: [samples[current]!] });
          const next = edges.find((edge) => edge !== previous && edge.a === current);
          if (!next) throw new Error('Open Hermite cell contour');
          const a = samples[next.a]!,
            b = samples[next.b]!;
          if (a.normal.dot(b.normal) <= 0.85) {
            const faceBounds = bounds.clone();
            const coordinate =
              ([cell.x, cell.y, cell.z][next.axis] + next.side * span[next.axis]) *
                stock.resolutionMm +
              stock.latticeMinimum.getComponent(next.axis);
            faceBounds.min.setComponent(next.axis, coordinate);
            faceBounds.max.setComponent(next.axis, coordinate);
            polygon.push({ point: rounded(boundedQef([a, b], faceBounds)), samples: [a, b] });
          }
          if (
            extrusionAxis >= 0 &&
            next.axis !== extrusionAxis &&
            a.point.getComponent(extrusionAxis) !== b.point.getComponent(extrusionAxis)
          ) {
            const start = [cell.x, cell.y, cell.z][extrusionAxis];
            const levels = [
              ...(seams.get(seamKey(cell, next.axis, next.side, extrusionAxis)) ?? []),
            ]
              .filter((level) => level > start && level < start + span[extrusionAxis])
              .sort((u, v) =>
                a.point.getComponent(extrusionAxis) < b.point.getComponent(extrusionAxis)
                  ? u - v
                  : v - u,
              );
            for (const level of levels) {
              const point = a.point.clone();
              point.setComponent(
                extrusionAxis,
                Math.fround(
                  level * stock.resolutionMm + stock.latticeMinimum.getComponent(extrusionAxis),
                ),
              );
              polygon.push({ point, samples: [a] });
            }
          }
          previous = next;
          current = next.a === current ? next.b : next.a;
          if (++steps > edges.length) throw new Error('Invalid Hermite cell contour cycle');
        } while (current !== first);
        for (let i = polygon.length - 1; i >= 0; i--) {
          const next = (i + 1) % polygon.length;
          if (polygon.length > 1 && polygon[i].point.equals(polygon[next].point)) {
            polygon[next].samples = [...polygon[next].samples, ...polygon[i].samples];
            polygon.splice(i, 1);
          }
        }
        if (polygon.length < 3) continue;
        if (!sharp) {
          const normal = patch
            .reduce((sum, sample) => sum.add(sample.normal), new THREE.Vector3())
            .normalize();
          const vertex = polygon[0].point;
          const visible = polygon.every((a, i) => {
            const b = polygon[(i + 1) % polygon.length];
            const area = b.point
              .clone()
              .sub(a.point)
              .cross(vertex.clone().sub(a.point))
              .dot(normal);
            return i === 0 || i === polygon.length - 1 ? area >= 0 : area > 0;
          });
          if (visible) {
            for (let i = 1; i < polygon.length - 1; i++)
              emit([polygon[0], polygon[i], polygon[i + 1]]);
            continue;
          }
        }
        const anchor = polygon[0].point;
        const normal = new THREE.Vector3();
        for (let i = 0; i < polygon.length; i++)
          normal.add(
            polygon[i].point
              .clone()
              .sub(anchor)
              .cross(polygon[(i + 1) % polygon.length].point.clone().sub(anchor)),
          );
        if (normal.lengthSq() < 1e-24) throw new Error('Cannot resolve Hermite patch orientation');
        normal.normalize();
        const components = normal.toArray().map(Math.abs);
        const axis = components.indexOf(Math.min(...components));
        const u = new THREE.Vector3().setComponent(axis, 1).cross(normal).normalize();
        const v = normal.clone().cross(u).normalize();
        const projected = polygon.map(
          (sample) =>
            new THREE.Vector2(
              sample.point.clone().sub(anchor).dot(u),
              sample.point.clone().sub(anchor).dot(v),
            ),
        );
        let area = 0;
        for (let i = 0; i < projected.length; i++)
          area += projected[i].cross(projected[(i + 1) % projected.length]);
        if (area < 0) {
          polygon.reverse();
          projected.reverse();
        }
        if (sharp) {
          const vertex = rounded(boundedQef(patch, bounds));
          const position = new THREE.Vector2(
            vertex.clone().sub(anchor).dot(u),
            vertex.clone().sub(anchor).dot(v),
          );
          // A bounded QEF can still lie outside a concave contour's visibility kernel.
          const visible = projected.every(
            (a, i) =>
              projected[(i + 1) % projected.length].clone().sub(a).cross(position.clone().sub(a)) >
              stock.resolutionMm ** 2 * 1e-12,
          );
          if (visible) {
            const centre = { point: vertex, samples: patch };
            for (let i = 0; i < polygon.length; i++)
              emit([centre, polygon[i], polygon[(i + 1) % polygon.length]]);
            continue;
          }
        }
        const triangles = triangulateContour(projected);
        if (triangles) {
          for (const triangle of triangles) emit(triangle.map((index) => polygon[index]));
        } else {
          // A folded patch has no single planar chart. Cone its directed cell-face
          // contour to an interior point rather than dropping intersecting ears.
          const centre = { point: rounded(bounds.getCenter(new THREE.Vector3())), samples: patch };
          for (let i = 0; i < polygon.length; i++)
            emit([centre, polygon[i], polygon[(i + 1) % polygon.length]]);
        }
      }
      stock.accountSurfaceWorkspace(workspaceBytes + intersections.size * 256 + 8192);
    }
  }

  buildChanged(stock: StockModel): StockSurfaceChunk[] {
    const extractionBefore = stock.boundaryExtractionMs;
    this.chunkDiagnostics.length = 0;
    this.extractionMs = 0;
    this.topologyPasses = 0;
    this.topologyReused = false;
    this.topologyCachePeakBytes = 0;
    const changed: StockSurfaceChunk[] = [];
    const requested = new Set<number>();
    const [nx, ny, nz] = stock.chunkDimensions;
    for (const id of stock.dirtyChunks) {
      const x = id % nx,
        y = Math.floor(id / nx) % ny,
        z = Math.floor(id / (nx * ny));
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const a = x + dx,
              b = y + dy,
              c = z + dz;
            if (a >= 0 && a < nx && b >= 0 && b < ny && c >= 0 && c < nz)
              requested.add(a + nx * (b + ny * c));
          }
    }
    const context = new Set(requested);
    // The rebuilt ring needs the unchanged ring beyond it to retain its exact
    // coarse/fine seam breakpoints. Context cells are not themselves rebuilt.
    if (this.cache.size)
      for (const id of requested) {
        const x = id % nx,
          y = Math.floor(id / nx) % ny,
          z = Math.floor(id / (nx * ny));
        for (let dz = -1; dz <= 1; dz++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const a = x + dx,
                b = y + dy,
                c = z + dz;
              if (a >= 0 && a < nx && b >= 0 && b < ny && c >= 0 && c < nz)
                context.add(a + nx * (b + ny * c));
            }
      }
    const extractionContext = this.cache.size ? context : undefined;
    const chunkIds = new Set<number>();
    const intersections = new Map<string, HermiteSample>();
    const seams = new Map<string, Set<number>>();
    let seamBytes = 0;
    const topology = new Map<number, Uint32Array>();
    let topologyBytes = 0;
    let cachingTopology = this.topologyCacheBytes > 0;
    const abandonTopology = (): void => {
      topology.clear();
      topologyBytes = 0;
      cachingTopology = false;
      if (!this.warnedTopologyCache) {
        console.warn('Temporary seam topology reuse cannot fit available workspace; using streamed extraction at unchanged detail.');
        this.warnedTopologyCache = true;
      }
    };
    const retainedWorkspace = (): number => {
      const base = this.surfaceCacheBytes() + seamBytes + this.chunkDiagnostics.length * 256;
      return base + topologyBytes;
    };
    const previousRelease = stock.releaseSurfaceWorkspace;
    stock.releaseSurfaceWorkspace = (required) => {
      const released = topologyBytes;
      if (released) abandonTopology();
      return released + (released < required ? (previousRelease?.(required - released) ?? 0) : 0);
    };
    try {
      // Discover coarse seam keys before collecting fine breakpoints. Each pass
      // retains only one chunk's extracted cells, not the whole fine surface.
      this.topologyPasses++;
      for (const [id, cells] of stock.iterateBoundaryTopology(
        extractionContext,
        retainedWorkspace,
      )) {
        chunkIds.add(id);
        if (cachingTopology) {
          const bytes = cells.length * TOPOLOGY_WORDS * 4 + 320;
          const encodable = cells.every((cell) =>
            [cell.x, cell.y, cell.z, ...(cell.span ?? [0, 0, 0]), cell.crossedEdges].every(
              (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
            ),
          );
          if (
            !encodable ||
            topologyBytes + bytes > this.topologyCacheBytes ||
            !stock.canAccountSurfaceWorkspace(retainedWorkspace() + bytes)
          ) {
            abandonTopology();
          } else if (cachingTopology) {
            topologyBytes += bytes;
            stock.accountSurfaceWorkspace(retainedWorkspace());
            const packed = new Uint32Array(cells.length * TOPOLOGY_WORDS);
            cells.forEach((cell, index) => {
              const offset = index * TOPOLOGY_WORDS;
              packed.set(
                [cell.x, cell.y, cell.z, ...(cell.span ?? [0, 0, 0]), cell.crossedEdges],
                offset,
              );
            });
            topology.set(id, packed);
            this.topologyCachePeakBytes = Math.max(this.topologyCachePeakBytes, topologyBytes);
          }
        }
        for (const cell of cells) {
          const direction = cell.span?.findIndex((size) => size > 1) ?? -1;
          if (direction < 0) continue;
          for (const face of FACES) {
            if (face.axis === direction) continue;
            if (!face.edges.some((edge) => cell.crossedEdges & (1 << edge))) continue;
            const key = seamKey(cell, face.axis, face.side, direction);
            if (!seams.has(key)) {
              seams.set(key, new Set());
              seamBytes += 192;
              stock.accountSurfaceWorkspace(retainedWorkspace());
            }
          }
        }
      }
      const changedIds = new Set([
        ...requested,
        ...[...chunkIds].filter((id) => !this.cache.has(id)),
      ]);
      const collectBreakpoints = (cell: BoundaryTopology): void => {
        for (const face of FACES) {
          if (!face.edges.some((edge) => cell.crossedEdges & (1 << edge))) continue;
          for (const direction of [0, 1, 2]) {
            if (face.axis === direction) continue;
            const key = seamKey(cell, face.axis, face.side, direction);
            const levels = seams.get(key);
            if (!levels) continue;
            const coordinate = [cell.x, cell.y, cell.z][direction];
            const previous = levels.size;
            levels.add(coordinate);
            levels.add(coordinate + (cell.span?.[direction] ?? 1));
            seamBytes += (levels.size - previous) * 32;
          }
          stock.accountSurfaceWorkspace(retainedWorkspace());
        }
      };
      if (cachingTopology) {
        cachedTopology: for (const packed of topology.values()) {
          for (let offset = 0; offset < packed.length; offset += TOPOLOGY_WORDS) {
            collectBreakpoints({
              x: packed[offset],
              y: packed[offset + 1],
              z: packed[offset + 2],
              span: packed[offset + 3]
                ? [packed[offset + 3], packed[offset + 4], packed[offset + 5]]
                : undefined,
              crossedEdges: packed[offset + 6],
            });
            if (!cachingTopology) break cachedTopology;
          }
        }
        this.topologyReused = cachingTopology;
      }
      if (!cachingTopology) {
        this.topologyPasses++;
        for (const [, cells] of stock.iterateBoundaryTopology(extractionContext, retainedWorkspace))
          for (const cell of cells) collectBreakpoints(cell);
      }
      topology.clear();
      topologyBytes = 0;
      stock.accountSurfaceWorkspace(retainedWorkspace());
      for (const id of changedIds)
        if (!chunkIds.has(id)) {
          const previous = this.cache.get(id);
          if (!previous) continue;
          this.triangles -= previous.positions.length / 9;
          this.cache.delete(id);
          changed.push({ id, positions: new Float32Array(), normals: new Float32Array() });
        }
      for (const [id, cells] of stock.iterateBoundaryChunks(changedIds, retainedWorkspace)) {
        const chunkStarted = performance.now();
        // Shared edges use the same ascending lattice endpoints, stored root and
        // Float32 calculation in either chunk. Memoization need not retain samples
        // from completed chunks; face-QEF inputs remain exactly canonical.
        intersections.clear();
        const count = cells.reduce((sum, cell) => sum + triangleCapacity(cell, seams), 0);
        const previous = (this.cache.get(id)?.positions.length ?? 0) / 9;
        const workspaceBytes = retainedWorkspace() + count * 73;
        stock.accountSurfaceWorkspace(workspaceBytes + intersections.size * 256);
        const positions = new Float32Array(count * 9),
          normals = new Float32Array(count * 9);
        const eligible = new Uint8Array(count);
        let offset = 0;
        this.visitTriangles(
          stock,
          cells,
          intersections,
          seams,
          workspaceBytes,
          (points, directions, adaptable) => {
            eligible[offset / 9] = adaptable ? 1 : 0;
            for (let i = 0; i < 3; i++) {
              points[i].toArray(positions, offset);
              directions[i].toArray(normals, offset);
              offset += 3;
            }
          },
        );
        const baseBytes = workspaceBytes + intersections.size * 256;
        const triangulationMs = performance.now() - chunkStarted;
        // Fine staging is budgeted independently; the actual reduced triangle
        // count is checked before allocating its final output buffers.
        const x = id % nx,
          y = Math.floor(id / nx) % ny,
          z = Math.floor(id / (nx * ny));
        const minimum = new THREE.Vector3(x, y, z)
          .multiplyScalar(stock.chunkSize * stock.resolutionMm)
          .add(stock.latticeMinimum);
        let adaptationBytes = 0;
        const adaptable =
          this.surfaceToleranceRatio > 0 && eligible.subarray(0, offset / 9).some(Boolean);
        const canAdapt =
          adaptable &&
          stock.canAccountSurfaceWorkspace(
            baseBytes + surfaceAdaptationWorkspaceBound(offset / 9) + offset * 8,
          );
        // Deliberately retain the fine mesh (zero added deviation) when optional
        // worst-case work plus final output cannot fit. Core budget errors above
        // and below still propagate; this is not an exception fallback.
        if (adaptable && !canAdapt) this.skippedAdaptationChunks++;
        const adaptationStarted = performance.now();
        const selection = canAdapt
          ? adaptSurface(
              positions.subarray(0, offset),
              normals.subarray(0, offset),
              eligible.subarray(0, offset / 9),
              stock.resolutionMm * this.surfaceToleranceRatio,
              (bytes) => {
                adaptationBytes = bytes;
                stock.accountSurfaceWorkspace(baseBytes + bytes);
              },
              new THREE.Box3(
                minimum,
                minimum.clone().addScalar(stock.chunkSize * stock.resolutionMm),
              ),
            )
          : undefined;
        const adaptationMs = performance.now() - adaptationStarted;
        const outputTriangles = selection ? selection.length / 3 : offset / 9;
        if (this.triangles - previous + outputTriangles > this.faceLimit * 2)
          throw new Error(
            `Stock surface exceeds the ${this.faceLimit.toLocaleString()} face budget; use coarser boundary spacing`,
          );
        let outputPositions = positions,
          outputNormals = normals;
        if (selection) {
          stock.accountSurfaceWorkspace(baseBytes + adaptationBytes + outputTriangles * 72);
          outputPositions = new Float32Array(outputTriangles * 9);
          outputNormals = new Float32Array(outputTriangles * 9);
          selection.forEach((source, index) => {
            for (let axis = 0; axis < 3; axis++) {
              outputPositions[index * 3 + axis] = positions[source + axis];
              outputNormals[index * 3 + axis] = normals[source + axis];
            }
          });
        } else if (offset !== positions.length) {
          stock.accountSurfaceWorkspace(baseBytes + offset * 8);
          outputPositions = positions.slice(0, offset);
          outputNormals = normals.slice(0, offset);
        }
        const chunk = {
          id,
          positions: outputPositions,
          normals: outputNormals,
        };
        this.cache.set(id, chunk);
        this.triangles += outputTriangles - previous;
        changed.push(chunk);
        stock.accountSurfaceWorkspace(retainedWorkspace() + 256);
        this.chunkDiagnostics.push({
          id,
          cells: cells.length,
          analyticalPanels: cells.filter((cell) => cell.span?.some((span) => span > 1)).length,
          fineTriangles: offset / 9,
          outputTriangles,
          triangulationMs,
          adaptationMs,
          elapsedMs: performance.now() - chunkStarted,
        });
      }
      stock.dirtyChunks.clear();
      stock.accountSurfaceWorkspace(0);
      this.extractionMs = stock.boundaryExtractionMs - extractionBefore;
      return changed;
    } finally {
      topology.clear();
      stock.releaseSurfaceWorkspace = previousRelease;
    }
  }

  getChunks(): StockSurfaceChunk[] {
    return [...this.cache.values()].filter((chunk) => chunk.positions.length > 0);
  }

  restoreChunks(chunks: readonly StockSurfaceChunk[]): StockSurfaceChunk[] {
    const target = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const triangles = chunks.reduce((sum, chunk) => sum + chunk.positions.length / 9, 0);
    if (target.size !== chunks.length || triangles > this.faceLimit * 2 ||
      chunks.some((chunk) => chunk.positions.length % 9 ||
        chunk.normals.length !== chunk.positions.length))
      throw new Error('Invalid cached stock surface');
    const changed: StockSurfaceChunk[] = [];
    for (const id of this.cache.keys())
      if (!target.has(id))
        changed.push({ id, positions: new Float32Array(), normals: new Float32Array() });
    for (const chunk of chunks)
      if (this.cache.get(chunk.id) !== chunk) changed.push(chunk);
    this.cache.clear();
    for (const chunk of chunks) this.cache.set(chunk.id, chunk);
    this.triangles = triangles;
    this.chunkDiagnostics.length = 0;
    this.extractionMs = 0;
    return changed;
  }
}
