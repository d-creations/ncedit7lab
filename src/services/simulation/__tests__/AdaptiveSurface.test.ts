import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { StockModel } from '../StockModel';
import { StockMeshBuilder } from '../StockMeshBuilder';
import { boxVolume, cylinderVolume } from '../ImplicitGeometry';
import { MaterialRemovalEngine, simulateMaterialRemoval } from '../MaterialRemovalEngine';
import { CuttingToolModel } from '../CuttingToolModel';
import { SIMULATION_LIMITS, type SimulationInput, type RemovalMotion } from '../SimulationTypes';

function setup(resolutionMm = 0.2): SimulationInput {
  return {
    algorithmVersion: 2,
    stock: { type: 'box', width: 4, height: 4, depth: 5 },
    binding: {
      frameId: 'workpiece:test',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      spindleOrigin: [0, 0, 0],
      spindleAxis: [0, 0, 1],
    },
    resolutionMm,
    motions: [],
  };
}

function hole(): RemovalMotion {
  const pose = (z: number) => ({
    position: [0.13, -0.07, z] as [number, number, number],
    orientation: [0, 0, 0, 1] as [number, number, number, number],
    frameId: 'workpiece:test',
    reference: 'millingTip' as const,
  });
  return {
    mode: 'milling',
    start: pose(3),
    end: pose(-3),
    executionStep: 0,
    tool: {
      toolNumber: 1,
      description: '1.3 mm mill',
      cutting: [{ type: 'endMill', diameter: 1.3, length: 6 }],
    },
  };
}

function vertices(stock: StockModel): THREE.Vector3[] {
  const builder = new StockMeshBuilder();
  builder.buildChanged(stock);
  return builder.getChunks().flatMap((chunk) => {
    const result: THREE.Vector3[] = [];
    for (let i = 0; i < chunk.positions.length; i += 3)
      result.push(new THREE.Vector3().fromArray(chunk.positions, i));
    return result;
  });
}

function assertClosed(points: THREE.Vector3[]): void {
  const key = (point: THREE.Vector3): string =>
    point
      .toArray()
      .map((value) => Math.round(value * 1e5))
      .join(',');
  const edges = new Map<string, { count: number; orientation: number }>();
  let collapsed = 0;
  for (let i = 0; i < points.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const a = key(points[i + j]),
        b = key(points[i + ((j + 1) % 3)]);
      if (a === b) collapsed++;
      const id = a < b ? `${a}|${b}` : `${b}|${a}`;
      const entry = edges.get(id) ?? { count: 0, orientation: 0 };
      entry.count++;
      entry.orientation += a < b ? 1 : -1;
      edges.set(id, entry);
    }
  }
  expect(edges.size).toBeGreaterThan(0);
  expect(collapsed).toBe(0);
  const bad = [...edges.values()].filter((edge) => edge.count !== 2 || edge.orientation !== 0);
  expect(bad.length, JSON.stringify(bad.slice(0, 3))).toBe(0);
}

describe('adaptive stock and intersection surfaces', () => {
  it('keeps interiors coarse and refines only a boundary layer', () => {
    const stock = new StockModel([8, 8, 8], 0.1, boxVolume([8, 8, 8]));
    const denseCells = 80 ** 3;
    expect(stock.allocatedNodes).toBeLessThan(denseCells / 2);
    expect(stock.boundaryCells).toBeLessThan(denseCells / 4);
    expect(stock.boundaryCells).toBe(0);
    expect(stock.allocatedBytes).toBeLessThanOrEqual(SIMULATION_LIMITS.stockBytes);
    expect(stock.contains(new THREE.Vector3())).toBe(true);
  });

  it('removes fully covered regions in bulk and skips a disjoint cutter', () => {
    const stock = new StockModel([8, 8, 8], 0.2, boxVolume([8, 8, 8]));
    const nodesBefore = stock.allocatedNodes;
    const all = boxVolume([20, 20, 20]);
    stock.subtract(all, () => {});
    expect(stock.remainingCells).toBe(0);
    expect(stock.boundaryCells).toBe(0);
    expect(stock.allocatedNodes).toBe(1);
    expect(stock.bulkRemovedRegions).toBeGreaterThan(0);
    expect(stock.bulkRemovedRegions).toBeLessThan(stock.regionTests);
    expect(nodesBefore).toBeGreaterThan(1);
    const fresh = new StockModel([8, 8, 8], 0.2, boxVolume([8, 8, 8]));
    let tests = 0;
    fresh.subtract(
      {
        bounds: all.bounds.clone().translate(new THREE.Vector3(100, 0, 0)),
        distance: (point) => all.distance(point.clone().sub(new THREE.Vector3(100, 0, 0))),
      },
      () => tests++,
    );
    expect(tests).toBe(0);
    expect(fresh.removedCells).toBe(0);
  });

  it('puts cylindrical stock vertices on the real surface instead of the voxel grid', () => {
    const stock = new StockModel([4, 4, 5], 0.2, cylinderVolume(2, 5));
    const wall = vertices(stock).filter((point) => Math.abs(point.z) < 2.2);
    expect(wall.length).toBeGreaterThan(100);
    const error = Math.max(...wall.map((point) => Math.abs(Math.hypot(point.x, point.y) - 2)));
    expect(error).toBeLessThan(2e-6);
  });

  it('cuts a dimensionally accurate hole in one axial sweep, without endpoint gaps', () => {
    const engine = new MaterialRemovalEngine(setup());
    engine.applyMotion(hole());
    expect(engine.samples).toBe(1);
    expect(engine.stock.contains(new THREE.Vector3(0.13, -0.07, 0))).toBe(false);
    const points = vertices(engine.stock);
    const wall = points.filter(
      (point) => Math.abs(point.z) < 2 && Math.hypot(point.x - 0.13, point.y + 0.07) < 0.8,
    );
    expect(wall.length).toBeGreaterThan(100);
    const radialErrors = wall.map((point) =>
      Math.abs(Math.hypot(point.x - 0.13, point.y + 0.07) - 0.65),
    );
    expect(Math.max(...radialErrors)).toBeLessThan(2e-6);
    assertClosed(points);
  });

  it('reduces actual curved-facet error when boundary spacing is refined', () => {
    const deviation = (spacing: number): number => {
      const stock = new StockModel([4, 4, 5], spacing, cylinderVolume(2, 5));
      const points = vertices(stock);
      let error = 0;
      let triangles = 0;
      for (let i = 0; i < points.length; i += 3) {
        const triangle = points.slice(i, i + 3);
        if (
          !triangle.every(
            (point) => Math.abs(point.z) < 2 && Math.abs(Math.hypot(point.x, point.y) - 2) < 2e-6,
          )
        )
          continue;
        const centre = triangle
          .reduce((sum, point) => sum.add(point), new THREE.Vector3())
          .divideScalar(3);
        error = Math.max(error, Math.abs(Math.hypot(centre.x, centre.y) - 2));
        triangles++;
      }
      expect(triangles).toBeGreaterThan(100);
      return error;
    };
    const coarse = deviation(0.4),
      fine = deviation(0.1);
    expect(fine).toBeLessThan(coarse * 0.5);
    expect(fine).toBeLessThan(0.002);
  });

  it('keeps uncut faces flat and closes chunk seams and internal pocket surfaces', () => {
    const engine = new MaterialRemovalEngine(setup());
    const cut = hole();
    cut.end = { ...cut.end, position: [0.13, -0.07, -0.37] };
    engine.applyMotion(cut);
    const points = vertices(engine.stock);
    const floor = points.filter(
      (point) => point.z < 0 && point.z > -0.6 && Math.hypot(point.x - 0.13, point.y + 0.07) < 0.5,
    );
    expect(floor.length).toBeGreaterThan(20);
    expect(Math.max(...floor.map((point) => Math.abs(point.z + 0.37)))).toBeLessThan(2e-6);
    const top = points.filter(
      (point) =>
        point.z > 2.3 &&
        Math.hypot(point.x - 0.13, point.y + 0.07) > 1 &&
        Math.abs(point.x) < 1.8 &&
        Math.abs(point.y) < 1.8,
    );
    expect(Math.max(...top.map((point) => Math.abs(point.z - 2.5)))).toBeLessThan(2e-6);
    assertClosed(points);
  });

  it('retains previous cut intersections and is idempotent when a cut is repeated', () => {
    const engine = new MaterialRemovalEngine(setup());
    engine.applyMotion(hole());
    const signature = (points: THREE.Vector3[]): string =>
      points
        .map((point) =>
          point
            .toArray()
            .map((value) => Math.round(value * 1e5))
            .join(','),
        )
        .sort()
        .join('|');
    const first = signature(vertices(engine.stock));
    const removed = engine.stock.removedCells;
    engine.applyMotion(hole());
    expect(engine.stock.removedCells).toBe(removed);
    const repeated = vertices(engine.stock);
    expect(signature(repeated) === first).toBe(true);
    const next = hole();
    next.start.position = [-1, 0, 3];
    next.end.position = [-1, 0, -0.5];
    engine.applyMotion(next);
    const preserved = vertices(engine.stock).filter(
      (point) =>
        Math.abs(point.z) < 2 && point.x > 0 && Math.hypot(point.x - 0.13, point.y + 0.07) < 0.8,
    );
    expect(preserved.length).toBeGreaterThan(20);
    expect(
      Math.max(
        ...preserved.map((point) => Math.abs(Math.hypot(point.x - 0.13, point.y + 0.07) - 0.65)),
      ),
    ).toBeLessThan(2e-6);
  });

  it('bounds 0.05 mm computation and surface memory for a small workpiece', () => {
    const input = setup(0.05);
    input.motions = [hole()];
    const result = simulateMaterialRemoval(input);
    expect(result.algorithmVersion).toBe(2);
    expect(result.status).toBe('completed');
    expect(result.removedCells).toBeGreaterThan(0);
    expect(result.allocatedStockBytes).toBeLessThanOrEqual(SIMULATION_LIMITS.stockBytes);
    expect(result.peakStockBytes).toBeLessThanOrEqual(SIMULATION_LIMITS.stockBytes);
    expect(result.surfaceBytes).toBeLessThanOrEqual(SIMULATION_LIMITS.surfaceFaces * 144);
    expect(result.cellTests).toBeLessThan(SIMULATION_LIMITS.cellTests);
    expect(result.elapsedMs).toBeLessThan(15000);
    console.info('adaptive 4x4x5 mm / 0.05 mm benchmark', {
      elapsedMs: result.elapsedMs,
      stockBytes: result.allocatedStockBytes,
      peakStockBytes: result.peakStockBytes,
      surfaceBytes: result.surfaceBytes,
      nodes: result.allocatedNodes,
      boundaryCells: result.boundaryCells,
      cellTests: result.cellTests,
    });
  }, 20000);

  it.each([
    { type: 'endMill', diameter: 2, length: 4, cornerRadius: 0.3 },
    { type: 'ballMill', diameter: 2, length: 4 },
    { type: 'drill', diameter: 2, length: 4, tipAngle: 90 },
  ] as const)('uses sign-correct conservative cutter fields for $type', (part) => {
    const cutter = new CuttingToolModel({ toolNumber: 1, description: 'test', cutting: [part] });
    const field = cutter.volume(new THREE.Matrix4());
    for (let z = -0.2; z <= 4.2; z += 0.137) {
      for (let x = 0.037; x <= 1.2; x += 0.117) {
        const point = new THREE.Vector3(x, 0, z);
        if (Math.abs(field.distance(point)) > 1e-10)
          expect(field.distance(point) < 0).toBe(cutter.containsAssembly(point));
        const next = point.clone().add(new THREE.Vector3(0.03, 0.02, 0.01));
        expect(Math.abs(field.distance(point) - field.distance(next))).toBeLessThanOrEqual(
          point.distanceTo(next) + 1e-10,
        );
      }
    }
  });
});
