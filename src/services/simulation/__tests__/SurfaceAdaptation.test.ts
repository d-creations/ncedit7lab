import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { adaptSurface, surfaceAdaptationWorkspaceBound } from '../SurfaceAdaptation';
import { StockMeshBuilder } from '../StockMeshBuilder';
import {
  StockModel,
  boundaryCentreField,
  boundaryEdgeRoot,
  boundaryNormalComponent,
} from '../StockModel';
import { boxVolume, CELL_CORNERS, CELL_EDGES } from '../ImplicitGeometry';
import { MaterialRemovalEngine } from '../MaterialRemovalEngine';
import type { RemovalMotion, SimulationInput, StockSurfaceChunk } from '../SimulationTypes';

function sheet(
  height: (x: number, y: number) => number,
  n = 12,
  width = 0.6,
  offset = 0,
  reverse = false,
): { positions: Float32Array; normals: Float32Array; eligible: Uint8Array } {
  const positions: number[] = [],
    normals: number[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const corner = (dx: number, dy: number): THREE.Vector3 => {
        const u = ((x + dx) / n - 0.5) * width,
          v = ((y + dy) / n - 0.5) * width;
        return new THREE.Vector3(u, v, offset + height(u, v));
      };
      const a = corner(0, 0),
        b = corner(1, 0),
        c = corner(1, 1),
        d = corner(0, 1);
      for (const triangle of [
        [a, b, c],
        [a, c, d],
      ]) {
        if (reverse) triangle.reverse();
        const normal = triangle[1]
          .clone()
          .sub(triangle[0])
          .cross(triangle[2].clone().sub(triangle[0]))
          .normalize();
        for (const point of triangle) {
          positions.push(...point.toArray());
          normals.push(...normal.toArray());
        }
      }
    }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    eligible: new Uint8Array(positions.length / 9).fill(1),
  };
}

function reduce(mesh: ReturnType<typeof sheet>, tolerance = 0.005): Float32Array {
  const selection = adaptSurface(mesh.positions, mesh.normals, mesh.eligible, tolerance, () => {});
  if (!selection) return mesh.positions;
  return Float32Array.from(
    selection.flatMap((source) => Array.from(mesh.positions.subarray(source, source + 3))),
  );
}

function directedEdges(chunks: readonly { positions: Float32Array }[]): Map<string, number> {
  const edges = new Map<string, number>();
  for (const { positions } of chunks)
    for (let t = 0; t < positions.length; t += 9) {
      const ids = [0, 3, 6].map((offset) =>
        Array.from(positions.subarray(t + offset, t + offset + 3)).join(','),
      );
      for (let i = 0; i < 3; i++) {
        const a = ids[i],
          b = ids[(i + 1) % 3];
        if (a === b) throw new Error('Degenerate Float32 edge');
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        edges.set(key, (edges.get(key) ?? 0) + (a < b ? 1 : -1));
      }
    }
  return new Map([...edges].filter(([, balance]) => balance !== 0));
}

function closed(chunks: StockSurfaceChunk[]): void {
  expect(directedEdges(chunks).size).toBe(0);
  const counts = new Map<string, number>();
  for (const chunk of chunks)
    for (let t = 0; t < chunk.positions.length; t += 9) {
      const ids = [0, 3, 6].map((offset) =>
        Array.from(chunk.positions.subarray(t + offset, t + offset + 3)).join(','),
      );
      for (let i = 0; i < 3; i++) {
        const pair = [ids[i], ids[(i + 1) % 3]].sort().join('|');
        counts.set(pair, (counts.get(pair) ?? 0) + 1);
      }
    }
  expect([...counts.values()].every((count) => count === 2)).toBe(true);
}

function triangles(positions: Float32Array): number[][][] {
  const result: number[][][] = [];
  for (let t = 0; t < positions.length; t += 9)
    result.push(
      [0, 3, 6].map((offset) => Array.from(positions.subarray(t + offset, t + offset + 3))),
    );
  return result;
}

// Independent complete overlay check: affine height extrema occur at vertices
// of the intersection polygon of each old/new projected triangle pair.
function maximumOverlayDeviation(fine: Float32Array, coarse: Float32Array): number {
  const cross = (a: number[], b: number[], p: number[]): number =>
    (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const height = (triangle: number[][], p: number[]): number => {
    const [a, b, c] = triangle;
    const determinant = cross(a, b, c);
    return (
      a[2] +
      (cross(a, p, c) / determinant) * (b[2] - a[2]) +
      (cross(a, b, p) / determinant) * (c[2] - a[2])
    );
  };
  let maximum = 0;
  const fineTriangles = triangles(fine);
  for (const coarseTriangle of triangles(coarse))
    for (const fineTriangle of fineTriangles) {
      if (
        [0, 1].some(
          (axis) =>
            Math.min(...fineTriangle.map((p) => p[axis])) >
              Math.max(...coarseTriangle.map((p) => p[axis])) ||
            Math.min(...coarseTriangle.map((p) => p[axis])) >
              Math.max(...fineTriangle.map((p) => p[axis])),
        )
      )
        continue;
      let polygon = fineTriangle;
      for (let i = 0; i < 3 && polygon.length; i++) {
        const a = coarseTriangle[i],
          b = coarseTriangle[(i + 1) % 3];
        const clipped: number[][] = [];
        for (let j = 0; j < polygon.length; j++) {
          const p = polygon[j],
            q = polygon[(j + 1) % polygon.length];
          const hp = cross(a, b, p),
            hq = cross(a, b, q);
          if (hp >= 0) clipped.push(p);
          if ((hp < 0 && hq > 0) || (hp > 0 && hq < 0)) {
            const t = hp / (hp - hq);
            clipped.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
          }
        }
        polygon = clipped;
      }
      for (const point of polygon)
        maximum = Math.max(
          maximum,
          Math.abs(height(fineTriangle, point) - height(coarseTriangle, point)),
        );
    }
  return maximum;
}

function sampledNewTriangleDeviation(
  fine: StockSurfaceChunk[],
  coarse: StockSurfaceChunk[],
  tolerance: number,
): number {
  const signature = (triangle: number[][]) =>
    triangle
      .map((point) => point.join(','))
      .sort()
      .join('|');
  let maximum = 0;
  const closest = new THREE.Vector3();
  for (const chunk of coarse) {
    const original = triangles(fine.find((candidate) => candidate.id === chunk.id)!.positions);
    const unchanged = new Set(original.map(signature));
    const references = original.map((points) => {
      const triangle = new THREE.Triangle(...points.map((point) => new THREE.Vector3(...point)));
      return {
        triangle,
        minimum: [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]))),
        maximum: [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]))),
      };
    });
    for (const triangle of triangles(chunk.positions)) {
      if (unchanged.has(signature(triangle))) continue;
      const samples = [
        ...[0, 1, 2].map((i) =>
          triangle[i].map((value, axis) => (value + triangle[(i + 1) % 3][axis]) / 2),
        ),
        [0, 1, 2].map((axis) => triangle.reduce((sum, point) => sum + point[axis], 0) / 3),
      ];
      for (const coordinates of samples) {
        const sample = new THREE.Vector3(...coordinates);
        let distance = Infinity;
        for (const reference of references) {
          if (
            coordinates.some(
              (value, axis) =>
                value < reference.minimum[axis] - tolerance ||
                value > reference.maximum[axis] + tolerance,
            )
          )
            continue;
          reference.triangle.closestPointToPoint(sample, closest);
          distance = Math.min(distance, closest.distanceTo(sample));
        }
        maximum = Math.max(maximum, distance);
      }
    }
  }
  return maximum;
}

function input(): SimulationInput {
  return {
    algorithmVersion: 2,
    resolutionMm: 0.05,
    stock: { type: 'box', width: 2, height: 2, depth: 2 },
    binding: {
      frameId: 'workpiece:test',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      spindleOrigin: [0, 0, 0],
      spindleAxis: [0, 0, 1],
    },
    motions: [],
  };
}

function ballCut(y = 0): RemovalMotion {
  const pose = (x: number) => ({
    position: [x, y, 0.35] as [number, number, number],
    orientation: [0, 0, 0, 1] as [number, number, number, number],
    reference: 'millingTip' as const,
    frameId: 'workpiece:test',
  });
  return {
    mode: 'milling',
    start: pose(-0.65),
    end: pose(0.65),
    tool: {
      toolNumber: 1,
      description: 'Ball',
      cutting: [{ type: 'ballMill', diameter: 1.2, length: 3 }],
    },
    executionStep: 0,
  };
}

function budgetStock(stockBytes = 256 * 1024 * 1024) {
  const limits = { cells: 100000, stockBytes };
  const stock = new StockModel([1, 1, 1], 0.1, boxVolume([1, 1, 1]), limits);
  const centre = new THREE.Vector3(0, 0, 0.3);
  stock.subtract(
    {
      bounds: new THREE.Box3(centre.clone().addScalar(-0.35), centre.clone().addScalar(0.35)),
      distance: (point) => point.distanceTo(centre) - 0.35,
      normal: (point, target) => target.copy(point).sub(centre).normalize(),
    },
    () => {},
  );
  return { stock, limits };
}

function canonicalChunkEdges(stock: StockModel): { maximum: number; total: number } {
  const shared = new Map<string, { chunk: number; bits: Uint32Array }>();
  let crossChunkDuplicates = 0,
    maximum = 0;
  for (const [chunk, cells] of stock.getBoundaryChunks()) {
    const local = new Set<string>();
    for (const cell of cells) {
      const span = cell.span ?? [1, 1, 1];
      CELL_EDGES.forEach(([a, b], edge) => {
        const t = boundaryEdgeRoot(cell, edge);
        if (!Number.isFinite(t)) return;
        const first = CELL_CORNERS[a],
          last = CELL_CORNERS[b];
        const axis = first.findIndex((coordinate, index) => coordinate !== last[index]);
        const start = [cell.x, cell.y, cell.z].map(
          (coordinate, index) => coordinate + first[index] * span[index],
        );
        const end = [cell.x, cell.y, cell.z].map(
          (coordinate, index) => coordinate + last[index] * span[index],
        );
        const key = `${start.join(',')}:${b - a}:${span[axis]}`;
        const point = new THREE.Vector3(...start)
          .lerp(new THREE.Vector3(...end), t)
          .multiplyScalar(stock.resolutionMm)
          .add(stock.latticeMinimum);
        const values = Float32Array.from([
          ...point.toArray(),
          ...[0, 1, 2].map((component) => boundaryNormalComponent(cell, edge, component)),
        ]);
        const bits = new Uint32Array(values.buffer);
        const previous = shared.get(key);
        if (previous) {
          if (!bits.every((value, index) => value === previous.bits[index]))
            throw new Error(`Noncanonical shared Float32 edge/normal: ${key}`);
          if (previous.chunk !== chunk) crossChunkDuplicates++;
        } else shared.set(key, { chunk, bits });
        local.add(key);
      });
    }
    maximum = Math.max(maximum, local.size);
  }
  expect(crossChunkDuplicates).toBeGreaterThan(0);
  return { maximum, total: shared.size };
}

describe('error-controlled reconstructed surface adaptation', () => {
  it('bounds the complete overlay, reduces a smooth patch, and retains exact Float32 boundary edges', () => {
    const mesh = sheet((x, y) => 0.5 * (x * x + y * y));
    const coarse = reduce(mesh);
    expect(coarse.length).toBeLessThan(mesh.positions.length * 0.9);
    const maximum = maximumOverlayDeviation(mesh.positions, coarse);
    expect(maximum).toBeGreaterThan(0);
    expect(maximum).toBeLessThanOrEqual(0.005);
    expect(directedEdges([{ positions: coarse }])).toEqual(directedEdges([mesh]));
    const original = new Set(
      triangles(mesh.positions)
        .flat()
        .map((p) => p.join(',')),
    );
    expect(
      triangles(coarse)
        .flat()
        .every((p) => original.has(p.join(','))),
    ).toBe(true);
  });

  it('does not accumulate error by feeding replacement triangles into subsequent stars', () => {
    const mesh = sheet((x, y) => 3 * (x * x + y * y), 18, 0.9);
    const coarse = reduce(mesh, 0.001);
    expect(maximumOverlayDeviation(mesh.positions, coarse)).toBeLessThanOrEqual(0.001);
    expect(reduce(mesh, 0)).toBe(mesh.positions);
  });

  it('rejects thin overlapping sheets and projection-ambiguous folded stars', () => {
    const a = sheet((x, y) => 0.5 * (x * x + y * y));
    const b = sheet((x, y) => 0.5 * (x * x + y * y), 12, 0.6, 0.001, true);
    const thin = {
      positions: Float32Array.from([...a.positions, ...b.positions]),
      normals: Float32Array.from([...a.normals, ...b.normals]),
      eligible: new Uint8Array(a.eligible.length + b.eligible.length).fill(1),
    };
    expect(reduce(thin)).toBe(thin.positions);
    const folded = sheet((x) => 0.1 * Math.cos((x / 0.05) * Math.PI));
    expect(reduce(folded)).toBe(folded.positions);
  });

  it('locks sharp creases, exact corners, pristine triangles and uncertain arithmetic', () => {
    const crease = sheet((x) => Math.abs(x), 12);
    const coarse = reduce(crease);
    const creaseEdges = (p: Float32Array) =>
      triangles(p)
        .flatMap((triangle) =>
          triangle.flatMap((a, i) => {
            const b = triangle[(i + 1) % 3];
            return a[0] === 0 && b[0] === 0 ? [[a.join(','), b.join(',')].sort().join('|')] : [];
          }),
        )
        .sort();
    expect(creaseEdges(coarse)).toEqual(creaseEdges(crease.positions));
    const pristine = sheet(() => 0);
    pristine.eligible.fill(0);
    expect(reduce(pristine)).toBe(pristine.positions);
    const uncertain = sheet(() => 0);
    for (let i = 0; i < uncertain.positions.length; i += 3) uncertain.positions[i] *= 1e-12;
    expect(reduce(uncertain)).toBe(uncertain.positions);
  });

  it('charges adaptation before staging work and propagates workspace failures', () => {
    const mesh = sheet(() => 0);
    expect(() =>
      adaptSurface(mesh.positions, mesh.normals, mesh.eligible, 0.005, (bytes) => {
        expect(bytes).toBeGreaterThan(mesh.positions.byteLength + mesh.normals.byteLength);
        throw new Error('workspace budget');
      }),
    ).toThrow('workspace budget');
  });

  it('accounts shared vertices and edges instead of charging disconnected-triangle worst cases', () => {
    const mesh = sheet(() => 0);
    let peak = 0;
    const selection = adaptSurface(mesh.positions, mesh.normals, mesh.eligible, 0.005, (bytes) => {
      peak = Math.max(peak, bytes);
    });
    expect(selection).toBeDefined();
    expect(peak).toBeGreaterThan(mesh.positions.byteLength + mesh.normals.byteLength);
    expect(peak).toBeLessThan(mesh.eligible.length * 4096 * 0.55);
    expect(peak).toBeLessThanOrEqual(surfaceAdaptationWorkspaceBound(mesh.eligible.length));
  });

  it('intentionally retains exact fine geometry and reports skipped chunks under a tight budget', () => {
    const referenceStock = budgetStock().stock;
    const reference = new StockMeshBuilder(undefined, { surfaceToleranceRatio: 0 });
    reference.buildChanged(referenceStock);
    const { stock, limits } = budgetStock(Math.ceil(referenceStock.peakAllocatedBytes * 1.05));
    const builder = new StockMeshBuilder();
    builder.buildChanged(stock);
    expect(builder.skippedChunks).toBeGreaterThan(0);
    expect(reference.skippedChunks).toBe(0);
    expect(builder.getChunks()).toEqual(reference.getChunks());
    closed(builder.getChunks());
    expect(stock.peakAllocatedBytes).toBeLessThanOrEqual(limits.stockBytes);

    // Cached fine surfaces still belong to the core budget, not the optional
    // adaptation choice. A later insufficient budget must remain an error.
    limits.stockBytes = stock.allocatedBytes + 1;
    for (const chunk of builder.getChunks()) stock.dirtyChunks.add(chunk.id);
    expect(() => builder.buildChanged(stock)).toThrow('Adaptive stock memory budget exceeded');
  });

  it('does not hide fine staging, normal reconstruction or actual triangle-limit failures', () => {
    const { stock, limits } = budgetStock();
    limits.stockBytes = stock.allocatedBytes + 1;
    expect(() => new StockMeshBuilder().buildChanged(stock)).toThrow(
      'Adaptive stock memory budget exceeded',
    );
    const normalStock = budgetStock().stock;
    const cell = [...normalStock.getBoundaryChunks().values()]
      .flat()
      .find(
        (candidate) =>
          candidate.span === undefined &&
          CELL_EDGES.some((_, edge) => Number.isFinite(boundaryEdgeRoot(candidate, edge))),
      )!;
    cell.normals.fill(0);
    expect(() => new StockMeshBuilder().buildChanged(normalStock)).toThrow(
      'Missing Hermite surface normal',
    );
    expect(() => new StockMeshBuilder(1).buildChanged(budgetStock().stock)).toThrow('face budget');
  });

  it('reconstructs packed Hermite roots and normals bit-identically to dense curved and planar fields', () => {
    for (const stock of [
      budgetStock().stock,
      new StockModel([1, 1, 1], 0.1, boxVolume([1, 1, 1])),
    ]) {
      stock.subtract(boxVolume([0.5, 0.5, 0.7]), () => {});
      const original = stock.getBoundaryChunks.bind(stock);
      expect([...original().values()].flat().some((cell) => cell.normalMask !== undefined)).toBe(
        true,
      );
      expect([...original().values()].flat().some((cell) => cell.edgeMask !== undefined)).toBe(
        true,
      );
      const packed = new StockMeshBuilder();
      packed.buildChanged(stock);
      const spy = vi.spyOn(stock, 'getBoundaryChunks').mockImplementation(
        (requested) =>
          new Map(
            [...original(requested)].map(([id, cells]) => [
              id,
              cells.map((cell) => ({
                ...cell,
                data: Float64Array.from([
                  ...cell.data.subarray(0, 8),
                  ...CELL_EDGES.map((_, edge) => boundaryEdgeRoot(cell, edge)),
                  boundaryCentreField(cell),
                ]),
                normals: Float32Array.from(
                  CELL_EDGES.flatMap((_, edge) =>
                    [0, 1, 2].map((component) => boundaryNormalComponent(cell, edge, component)),
                  ),
                ),
                normalMask: undefined,
                edgeMask: undefined,
              })),
            ]),
          ),
      );
      const dense = new StockMeshBuilder();
      dense.buildChanged(stock);
      spy.mockRestore();
      expect(packed.getChunks()).toEqual(dense.getChunks());
      closed(packed.getChunks());
    }
  });

  it('validates constructor tolerance without changing the original face-limit parameter', () => {
    for (const ratio of [-0.01, 0.11, NaN, Infinity])
      expect(() => new StockMeshBuilder(1000, { surfaceToleranceRatio: ratio })).toThrow(
        'Surface tolerance ratio',
      );
    expect(() => new StockMeshBuilder(1000, { surfaceToleranceRatio: 0 })).not.toThrow();
    expect(() => new StockMeshBuilder(1000, { surfaceToleranceRatio: 0.1 })).not.toThrow();
  });

  it('meaningfully reduces a smooth ball cut within 0.005 mm without refining subtraction cells', () => {
    const engine = new MaterialRemovalEngine(input());
    engine.applyMotion(ballCut());
    const canonical = canonicalChunkEdges(engine.stock);
    const fine = new StockMeshBuilder(undefined, { surfaceToleranceRatio: 0 });
    fine.buildChanged(engine.stock);
    const builder = new StockMeshBuilder();
    builder.buildChanged(engine.stock);
    expect(builder.peakIntersectionCacheEntries).toBeLessThanOrEqual(canonical.maximum);
    expect(builder.peakIntersectionCacheEntries).toBeLessThan(canonical.total / 2);
    const count = (chunks: StockSurfaceChunk[]) =>
      chunks.reduce((sum, chunk) => sum + chunk.positions.length / 9, 0);
    expect(count(builder.getChunks())).toBeLessThan(count(fine.getChunks()) * 0.97);
    const deviation = sampledNewTriangleDeviation(fine.getChunks(), builder.getChunks(), 0.005);
    expect(deviation).toBeGreaterThan(0);
    expect(deviation).toBeLessThanOrEqual(0.005);
    closed(builder.getChunks());
    const boundaryCells = engine.stock.boundaryCells;
    const limited = new StockMeshBuilder(Math.ceil(count(builder.getChunks()) / 2));
    limited.buildChanged(engine.stock);
    expect(count(limited.getChunks())).toBe(count(builder.getChunks()));
    expect(engine.stock.boundaryCells).toBe(boundaryCells);
    expect(engine.stock.peakAllocatedBytes).toBeGreaterThan(engine.stock.allocatedBytes);
  }, 30000);

  it('closes cached/fresh coarse-fine seams while preserving untouched cached chunks', () => {
    const engine = new MaterialRemovalEngine({
      ...input(),
      resolutionMm: 0.1,
      stock: { type: 'box', width: 10, height: 2, depth: 2 },
    });
    engine.applyMotion(ballCut());
    const canonical = canonicalChunkEdges(engine.stock);
    const builder = new StockMeshBuilder();
    builder.buildChanged(engine.stock);
    expect(builder.peakIntersectionCacheEntries).toBeLessThanOrEqual(canonical.maximum);
    expect(builder.peakIntersectionCacheEntries).toBeLessThan(canonical.total / 2);
    closed(builder.getChunks());
    const cached = new Map(builder.getChunks().map((chunk) => [chunk.id, chunk.positions]));
    engine.applyMotion(ballCut(0.35));
    builder.buildChanged(engine.stock);
    expect(builder.getChunks().some((chunk) => cached.get(chunk.id) === chunk.positions)).toBe(
      true,
    );
    closed(builder.getChunks());
    const fresh = new StockMeshBuilder();
    fresh.buildChanged(engine.stock);
    closed(fresh.getChunks());
    const sorted = (chunks: StockSurfaceChunk[]) => chunks.sort((a, b) => a.id - b.id);
    const actual = sorted(builder.getChunks()),
      expected = sorted(fresh.getChunks());
    expect(actual.map((chunk) => chunk.id)).toEqual(expected.map((chunk) => chunk.id));
    actual.forEach((chunk, index) => {
      for (const field of ['positions', 'normals'] as const) {
        const a = chunk[field],
          b = expected[index][field];
        expect(a.length).toBe(b.length);
        const bits = new Uint32Array(a.buffer, a.byteOffset, a.length);
        const reference = new Uint32Array(b.buffer, b.byteOffset, b.length);
        expect(
          bits.every((value, i) => value === reference[i]),
          `${chunk.id}:${field}`,
        ).toBe(true);
      }
    });
  }, 30000);
});
