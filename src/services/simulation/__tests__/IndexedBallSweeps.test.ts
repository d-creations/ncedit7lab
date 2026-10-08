import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CuttingToolModel } from '../CuttingToolModel';
import { IndexedBallSweeps, MAX_INDEXED_SWEEPS } from '../IndexedBallSweeps';
import { boxVolume, type ImplicitVolume } from '../ImplicitGeometry';
import {
  MaterialRemovalEngine,
  batchRemovalMotions,
  simulateMaterialRemoval,
} from '../MaterialRemovalEngine';
import {
  boundaryCentreField,
  boundaryEdgeRoot,
  boundaryNormalComponent,
  MAX_CACHED_CORNERS,
  StockModel,
} from '../StockModel';
import { SIMULATION_LIMITS, type RemovalMotion, type SimulationInput } from '../SimulationTypes';
import type { ProgramToolDefinition } from '../../tools/SimulationMetadata';

const tool: ProgramToolDefinition = {
  toolNumber: 1,
  description: '0.7 mm ball',
  cutting: [{ type: 'ballMill', diameter: 0.7, length: 2 }],
};
function setup(motions: RemovalMotion[] = [], spacing = 0.2): SimulationInput {
  return {
    algorithmVersion: 2,
    resolutionMm: spacing,
    stock: { type: 'box', width: 3, height: 3, depth: 3 },
    binding: {
      frameId: 'workpiece:test',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      spindleOrigin: [0, 0, 0],
      spindleAxis: [0, 0, 1],
    },
    motions,
  };
}
function motion(a: THREE.Vector3, b: THREE.Vector3, cuttingTool = tool, step = 0): RemovalMotion {
  const pose = (point: THREE.Vector3) => ({
    position: [point.x, point.y, point.z] as [number, number, number],
    orientation: [0, 0, 0, 1] as [number, number, number, number],
    frameId: 'workpiece:test',
    reference: 'millingTip' as const,
  });
  return { mode: 'milling', tool: cuttingTool, executionStep: step, start: pose(a), end: pose(b) };
}
function raster(rows = 6, segments = 16): RemovalMotion[] {
  const paths: RemovalMotion[] = [];
  for (let row = 0; row < rows; row++) {
    const point = (i: number) =>
      new THREE.Vector3(
        (row % 2 ? 1 : -1) * (-1.1 + (2.2 * i) / segments),
        -0.9 + row * 0.3,
        0.35 + 0.08 * Math.sin((i / segments) * Math.PI * 2),
      );
    for (let i = 0; i < segments; i++)
      paths.push(motion(point(i), point(i + 1), tool, paths.length));
  }
  return paths;
}
function union(sweeps: readonly ImplicitVolume[], test: () => void = () => {}): ImplicitVolume {
  const bounds = new THREE.Box3();
  for (const sweep of sweeps) bounds.union(sweep.bounds);
  const winner = (point: THREE.Vector3) => {
    let best = Infinity,
      index = 0;
    sweeps.forEach((sweep, i) => {
      test();
      const value = sweep.distance(point);
      if (value < best) {
        best = value;
        index = i;
      }
    });
    return { best, index };
  };
  return {
    bounds,
    distance: (point) => winner(point).best,
    normal: (point, target) => sweeps[winner(point).index].normal!(point, target),
  };
}
function volumes(paths: RemovalMotion[]): ImplicitVolume[] {
  const cutter = new CuttingToolModel(tool);
  const pose = (position: readonly number[]) =>
    new THREE.Matrix4().setPosition(new THREE.Vector3(...position));
  return paths.map((path) =>
    cutter.translationSweep(pose(path.start.position), pose(path.end.position))!,
  );
}

describe('spatially indexed ball-sweep batches', () => {
  it('matches the full union at random inside/outside points and normals while pruning primitive evaluations', () => {
    const sweeps = volumes(raster());
    let exact = 0,
      indexed = 0;
    const plain = union(sweeps, () => exact++);
    const bvh = new IndexedBallSweeps(sweeps, () => indexed++);
    let state = 7;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    for (let i = 0; i < 1600; i++) {
      const point = new THREE.Vector3(next() * 6 - 3, next() * 6 - 3, next() * 6 - 2);
      expect(bvh.volume.distance(point)).toBe(plain.distance(point));
      const actual = bvh.volume.normal!(point, new THREE.Vector3());
      const expected = plain.normal!(point, new THREE.Vector3());
      expect(actual.distanceTo(expected)).toBeLessThan(1e-12);
    }
    expect(bvh.primitiveTests).toBeLessThan(exact / 3);
    expect(indexed).toBe(bvh.primitiveTests + 1600);
  });

  it('keeps short finite tops and arbitrarily rotated/transformed cutter bounds conservative', () => {
    const cutter = new CuttingToolModel({
      ...tool,
      cutting: [
        {
          type: 'ballMill',
          diameter: 1,
          length: 0.5,
          rotation: [18, 34, 9],
          position: [0.2, -0.3, 0.4],
        },
      ],
    });
    const rotation = new THREE.Matrix4().makeRotationY(0.43);
    const sweeps = Array.from({ length: 16 }, (_, i) =>
      cutter.translationSweep(
        rotation.clone().setPosition(i * 0.12, Math.sin(i) * 0.2, i * 0.03),
        rotation.clone().setPosition(i * 0.12 + 0.2, Math.sin(i + 1) * 0.2, i * 0.03 - 0.4),
      )!,
    );
    const bvh = new IndexedBallSweeps(sweeps);
    const plain = union(sweeps);
    for (let x = -0.5; x < 3; x += 0.19)
      for (let z = -1; z < 2; z += 0.23) {
        const point = new THREE.Vector3(x, 0.11, z);
        expect(bvh.volume.distance(point)).toBe(plain.distance(point));
      }
  });

  it('reconstructs identical stored intersections and normals to an unpruned continuous union', () => {
    const sweeps = volumes(raster(3, 8));
    const actual = new StockModel([3, 3, 3], 0.2, boxVolume([3, 3, 3]));
    const expected = new StockModel([3, 3, 3], 0.2, boxVolume([3, 3, 3]));
    const bvh = new IndexedBallSweeps(sweeps);
    actual.subtract(bvh.volume, () => {});
    expected.subtract(union(sweeps), () => {});
    expect(actual.removedCells).toBe(expected.removedCells);
    const chunks = (stock: StockModel) => [...stock.getBoundaryChunks()].sort(([a], [b]) => a - b);
    expect(chunks(actual)).toEqual(chunks(expected));
  });

  it('streams identical boundary chunks and releases workspace on completion or early close', () => {
    const stock = new StockModel([3, 3, 3], 0.1, boxVolume([3, 3, 3]));
    stock.subtract(new IndexedBallSweeps(volumes(raster(2, 4))).volume, () => {});
    const expected = [...stock.getBoundaryChunks()];
    const pristineCount = stock.pristineSurfaceCells;
    expect(expected.length).toBeGreaterThan(1);
    expect([...stock.iterateBoundaryChunks()]).toEqual(expected);
    expect(stock.pristineSurfaceCells).toBe(pristineCount);
    const selected = new Set([expected[0][0], expected[expected.length - 1][0]]);
    expect([...stock.iterateBoundaryChunks(selected)]).toEqual(
      expected.filter(([id]) => selected.has(id)),
    );
    const available = SIMULATION_LIMITS.stockBytes - stock.allocatedBytes;
    expect(stock.canAccountSurfaceWorkspace(available)).toBe(true);
    const iterator = stock.iterateBoundaryChunks();
    expect(iterator.next().done).toBe(false);
    expect(stock.canAccountSurfaceWorkspace(available)).toBe(false);
    expect(typeof iterator.return).toBe('function');
    iterator.return?.();
    expect(stock.canAccountSurfaceWorkspace(available)).toBe(true);
  });

  it('accounts streamed grouping before allocation and releases it after a budget failure', () => {
    const limits = { ...SIMULATION_LIMITS };
    const stock = new StockModel([3, 3, 3], 0.1, boxVolume([3, 3, 3]), limits);
    limits.stockBytes = stock.allocatedBytes + 1;
    expect(() => [...stock.iterateBoundaryChunks()]).toThrow('memory budget');
    expect(stock.canAccountSurfaceWorkspace(0)).toBe(true);
  });

  it('includes retained mesh memory while extracting streamed chunks', () => {
    const limits = { ...SIMULATION_LIMITS };
    const stock = new StockModel([3, 3, 3], 0.1, boxVolume([3, 3, 3]), limits);
    const retained = limits.stockBytes - stock.allocatedBytes;
    expect(() => [...stock.iterateBoundaryChunks(undefined, () => retained)]).toThrow(
      'memory budget',
    );
    expect(stock.canAccountSurfaceWorkspace(0)).toBe(true);
  });

  it('preserves reversals, tool changes, rotary fallback, stops and original occurrence progress', () => {
    const paths = raster(2, 4);
    paths.push(motion(new THREE.Vector3(-1, 0, 0.3), new THREE.Vector3(1, 0, 0.3)));
    paths.push(motion(new THREE.Vector3(1, 0, 0.3), new THREE.Vector3(-1, 0, 0.3)));
    const changed = motion(new THREE.Vector3(-1, 0, 0.3), new THREE.Vector3(1, 0, 0.3), {
      ...tool,
      cutting: [{ type: 'ballMill', diameter: 0.6, length: 2 }],
    });
    paths.push(changed);
    const rotary = motion(new THREE.Vector3(0, 0, 0.3), new THREE.Vector3(0.1, 0, 0.3));
    rotary.end.orientation = [0, Math.sin(0.05), 0, Math.cos(0.05)];
    paths.push(rotary);
    const input = setup(paths);
    input.stop = { executionStep: 12, lineNumber: 19, message: 'unverified next motion' };
    const progress: number[] = [];
    const result = simulateMaterialRemoval(input, (processed) => progress.push(processed));
    expect(result.status).toBe('stopped');
    expect(result.stop).toEqual(input.stop);
    expect(result.indexedBatches).toBe(1);
    expect(result.samples).toBeGreaterThan(paths.length);
    expect(progress).toEqual(Array.from({ length: paths.length + 1 }, (_, i) => i));
    const direct = new MaterialRemovalEngine(input);
    direct.applyBatches(batchRemovalMotions(paths), () => {}, false);
    expect(result.removedCells).toBe(direct.stock.removedCells);
  }, 30000);

  it('bounds indexes, reports invalid fields and preserves memory-budget enforcement', () => {
    const sweeps = volumes(raster(2, 4));
    expect(() => new IndexedBallSweeps([sweeps[0]])).toThrow('2..128');
    expect(() => new IndexedBallSweeps(Array(MAX_INDEXED_SWEEPS + 1).fill(sweeps[0]))).toThrow(
      '2..128',
    );
    expect(
      () => new IndexedBallSweeps([sweeps[0], { ...sweeps[1], ballBounds: undefined }]),
    ).toThrow('frame and profile');
    const invalid = new IndexedBallSweeps(
      sweeps.map((sweep) => ({ ...sweep, distance: () => NaN })),
    );
    expect(() => invalid.volume.distance(new THREE.Vector3())).toThrow('Non-finite');
    const stock = new StockModel([3, 3, 3], 0.2, boxVolume([3, 3, 3]));
    expect(() =>
      stock.subtract(
        {
          ...new IndexedBallSweeps(sweeps).volume,
          workspaceBytes: SIMULATION_LIMITS.stockBytes * 2,
        },
        () => {},
      ),
    ).toThrow('memory budget');
  });

  it('compacts only uncrossed cell fields without changing later cuts or allocating useless normals', () => {
    const actual = new StockModel([3, 3, 3], 0.2, boxVolume([3, 3, 3]));
    const expected = new StockModel([3, 3, 3], 0.2, boxVolume([3, 3, 3]), SIMULATION_LIMITS, {
      compactUncrossedFields: false,
    });
    const crossed = (stock: StockModel) =>
      [...stock.getBoundaryChunks()].flatMap(([id, cells]) => {
        const surface = cells.filter((cell) =>
          Array.from({ length: 12 }, (_, edge) => boundaryEdgeRoot(cell, edge)).some(
            Number.isFinite,
          ),
        );
        return surface.length ? [{ id, cells: surface }] : [];
      });
    for (const sweep of volumes(raster(2, 3))) {
      actual.subtract(sweep, () => {});
      expected.subtract(sweep, () => {});
      expect(actual.removedCells).toBe(expected.removedCells);
      expect(crossed(actual)).toEqual(crossed(expected));
    }
    expect(actual.allocatedBytes).toBeLessThan(expected.allocatedBytes);
  }, 30000);

  it('shares identical plane fields losslessly and detaches them before later pocket updates', () => {
    const size: [number, number, number] = [4, 4, 4];
    const actual = new StockModel(size, 0.2, boxVolume(size));
    const plain = new StockModel(size, 0.2, boxVolume(size), SIMULATION_LIMITS, {
      internBoundaryFields: false,
    });
    const plane: ImplicitVolume = {
      bounds: new THREE.Box3(new THREE.Vector3(0.13, -2, -2), new THREE.Vector3(2, 2, 2)),
      distance: (point) => 0.13 - point.x,
      normal: (_point, target) => target.set(-1, 0, 0),
    };
    for (const volume of [
      plane,
      new CuttingToolModel(tool).translationSweep(
        new THREE.Matrix4().makeTranslation(-0.17, 0.13, -0.37),
        new THREE.Matrix4().makeTranslation(-0.17, 0.13, 0.47),
      )!,
    ]) {
      actual.subtract(volume, () => {});
      plain.subtract(volume, () => {});
      expect(actual.removedCells).toBe(plain.removedCells);
      expect([...actual.getBoundaryChunks()]).toEqual([...plain.getBoundaryChunks()]);
    }
    expect(actual.allocatedBytes).toBeLessThan(plain.allocatedBytes);
    expect(actual.peakCornerCacheEntries).toBeLessThanOrEqual(MAX_CACHED_CORNERS);
  }, 30000);

  it('keeps every crossing normal and corner field exact relative to dense unshared storage', () => {
    const actual = new StockModel([3, 3, 3], 0.2, boxVolume([3, 3, 3]), SIMULATION_LIMITS, {
      internBoundaryFields: false,
    });
    const dense = new StockModel([3, 3, 3], 0.2, boxVolume([3, 3, 3]), SIMULATION_LIMITS, {
      compactUncrossedFields: false,
      internBoundaryFields: false,
      sparseBoundaryNormals: false,
      sparseBoundaryRoots: false,
    });
    const surface = (stock: StockModel) =>
      [...stock.getBoundaryChunks()].flatMap(([id, cells]) =>
        cells
          .filter((cell) =>
            Array.from({ length: 12 }, (_, edge) => boundaryEdgeRoot(cell, edge)).some(
              Number.isFinite,
            ),
          )
          .map((cell) => ({
            id,
            x: cell.x,
            y: cell.y,
            z: cell.z,
            corners: cell.data.subarray(0, 8),
            centre: boundaryCentreField(cell),
            roots: Array.from({ length: 12 }, (_, edge) => boundaryEdgeRoot(cell, edge)),
            normals: Array.from({ length: 12 }, (_, edge) =>
              Number.isFinite(boundaryEdgeRoot(cell, edge))
                ? [0, 1, 2].map((component) => boundaryNormalComponent(cell, edge, component))
                : undefined,
            ),
          })),
      );
    for (const sweep of volumes(raster(2, 3))) {
      actual.subtract(sweep, () => {});
      dense.subtract(sweep, () => {});
      expect(actual.removedCells).toBe(dense.removedCells);
    }
    expect(surface(actual)).toEqual(surface(dense));
    expect(actual.allocatedBytes).toBeLessThan(dense.allocatedBytes);
  }, 30000);

  it('reduces work on a non-collinear .05 mm ball raster and reports measured phase costs', () => {
    const input = setup(raster(), 0.05);
    const plain = new MaterialRemovalEngine(input);
    const before = performance.now();
    plain.applyBatches(batchRemovalMotions(input.motions), () => {}, false);
    const sequentialMs = performance.now() - before;
    const indexed = new MaterialRemovalEngine(input);
    const started = performance.now();
    indexed.applyBatches(batchRemovalMotions(input.motions));
    const indexedMs = performance.now() - started;
    expect(indexed.samples).toBe(plain.samples);
    expect(indexed.indexedBatches).toBe(1);
    expect(indexed.stock.removedCells).toBe(plain.stock.removedCells);
    expect(indexed.cellTests).toBeLessThan(plain.cellTests);
    expect(indexed.stock.regionTests).toBeLessThan(plain.stock.regionTests / 3);
    expect(indexed.stock.peakCornerCacheEntries).toBeLessThanOrEqual(MAX_CACHED_CORNERS);
    console.info(
      'indexed ball raster .05',
      JSON.stringify({
        sequential: {
          elapsedMs: sequentialMs,
          evaluations: plain.cellTests,
          regionTests: plain.stock.regionTests,
          removedCells: plain.stock.removedCells,
        },
        indexed: {
          elapsedMs: indexedMs,
          evaluations: indexed.cellTests,
          regionTests: indexed.stock.regionTests,
          primitiveTests: indexed.indexedPrimitiveTests,
          boundTests: indexed.indexedBoundTests,
          removedCells: indexed.stock.removedCells,
        },
        motions: input.motions.length,
        samples: indexed.samples,
      }),
    );
  }, 120000);
});
