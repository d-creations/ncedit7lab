import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { boundedQef } from '../HermiteQef';
import { boxVolume, cylinderVolume, edgeRoot, surfaceNormal } from '../ImplicitGeometry';
import { StockModel } from '../StockModel';
import { StockMeshBuilder } from '../StockMeshBuilder';
import {
  batchRemovalMotions,
  MaterialRemovalEngine,
  simulateMaterialRemoval,
} from '../MaterialRemovalEngine';
import { buildTurningEnvelope } from '../TurningEnvelope';
import { CuttingToolModel } from '../CuttingToolModel';
import {
  SIMULATION_LIMITS,
  type SimulationInput,
  type RemovalMotion,
  type StockSurfaceChunk,
} from '../SimulationTypes';
import type { ProgramToolDefinition } from '../../tools/SimulationMetadata';

const frameId = 'workpiece:test';
const mill: ProgramToolDefinition = {
  toolNumber: 1,
  description: 'Mill',
  cutting: [{ type: 'endMill', diameter: 1.3, length: 6 }],
};
function motion(
  start: [number, number, number],
  end: [number, number, number],
  tool = mill,
  mode: 'milling' | 'turning' = 'milling',
  orientation: [number, number, number, number] = [0, 0, 0, 1],
): RemovalMotion {
  const reference = mode === 'turning' ? 'turningVirtualTip' : 'millingTip';
  return {
    tool,
    mode,
    executionStep: 0,
    start: { position: start, orientation, reference, frameId },
    end: { position: end, orientation, reference, frameId },
  };
}
function input(): SimulationInput {
  return {
    algorithmVersion: 2,
    resolutionMm: 0.2,
    stock: { type: 'box', width: 4, height: 4, depth: 5 },
    binding: {
      frameId,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      spindleOrigin: [0, 0, 0],
      spindleAxis: [0, 0, 1],
    },
    motions: [],
  };
}
function mesh(stock: StockModel): StockSurfaceChunk[] {
  const builder = new StockMeshBuilder();
  builder.buildChanged(stock);
  return builder.getChunks();
}
function points(chunks: StockSurfaceChunk[]): THREE.Vector3[] {
  return chunks.flatMap((chunk) => {
    const result: THREE.Vector3[] = [];
    for (let i = 0; i < chunk.positions.length; i += 3)
      result.push(new THREE.Vector3().fromArray(chunk.positions, i));
    return result;
  });
}
function closed(chunks: StockSurfaceChunk[]): void {
  const vertices = points(chunks);
  const key = (point: THREE.Vector3): string => point.toArray().join(',');
  const edges = new Map<string, { count: number; direction: number }>();
  for (let i = 0; i < vertices.length; i += 3)
    for (let j = 0; j < 3; j++) {
      const a = key(vertices[i + j]),
        b = key(vertices[i + ((j + 1) % 3)]);
      expect(a).not.toBe(b);
      const id = a < b ? `${a}|${b}` : `${b}|${a}`;
      const edge = edges.get(id) ?? { count: 0, direction: 0 };
      edge.count++;
      edge.direction += a < b ? 1 : -1;
      edges.set(id, edge);
    }
  expect(edges.size).toBeGreaterThan(0);
  const invalid = [...edges].filter(([, edge]) => edge.count !== 2 || edge.direction !== 0);
  expect(invalid, JSON.stringify(invalid.slice(0, 8))).toEqual([]);
}

describe('Hermite feature reconstruction', () => {
  it('solves corners, rank-deficient planes and constrained vertices', () => {
    const bounds = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
    const samples = [
      { point: new THREE.Vector3(0.3, 0.2, 0.2), normal: new THREE.Vector3(1, 0, 0) },
      { point: new THREE.Vector3(0.2, 0.4, 0.2), normal: new THREE.Vector3(0, 1, 0) },
      { point: new THREE.Vector3(0.2, 0.2, 0.5), normal: new THREE.Vector3(0, 0, 1) },
    ];
    expect(boundedQef(samples, bounds).distanceTo(new THREE.Vector3(0.3, 0.4, 0.5))).toBeLessThan(
      1e-7,
    );
    expect(boundedQef(samples.slice(0, 1), bounds).toArray()).toEqual([0.3, 0.2, 0.2]);
    expect(boundedQef([{ ...samples[0], point: new THREE.Vector3(2, 0.2, 0.2) }], bounds).x).toBe(
      1,
    );
    expect(() => boundedQef([], bounds)).toThrow('requires surface samples');
    expect(() => boundedQef([{ ...samples[0], normal: new THREE.Vector3() }], bounds)).toThrow(
      'unit normals',
    );
  });

  it('retains all eight sharp stock corners and flat shading at coarse spacing', () => {
    const size: [number, number, number] = [4.1, 3.7, 4.3];
    const stock = new StockModel(size, 0.5, boxVolume(size));
    const chunks = mesh(stock),
      vertices = points(chunks);
    for (const x of [-1, 1])
      for (const y of [-1, 1])
        for (const z of [-1, 1]) {
          const corner = new THREE.Vector3((x * size[0]) / 2, (y * size[1]) / 2, (z * size[2]) / 2);
          expect(Math.min(...vertices.map((point) => point.distanceTo(corner)))).toBeLessThan(2e-6);
        }
    for (const chunk of chunks)
      for (let i = 0; i < chunk.normals.length; i += 3)
        expect(
          Math.max(...new THREE.Vector3().fromArray(chunk.normals, i).toArray().map(Math.abs)),
        ).toBeGreaterThan(0.99999);
    closed(chunks);
  });

  it('uses radial Hermite normals on smooth cylinder walls, not flat triangle normals', () => {
    const chunks = mesh(new StockModel([4, 4, 5], 0.2, cylinderVolume(2, 5)));
    let wallVertices = 0;
    for (const chunk of chunks)
      for (let i = 0; i < chunk.positions.length; i += 3) {
        const point = new THREE.Vector3().fromArray(chunk.positions, i);
        if (Math.abs(point.z) >= 2.2) continue;
        const normal = new THREE.Vector3().fromArray(chunk.normals, i);
        const radial = point.clone().setZ(0).normalize();
        expect(normal.dot(radial)).toBeGreaterThan(0.99999);
        wallVertices++;
      }
    expect(wallVertices).toBeGreaterThan(100);
  });

  it('preserves a sloped cut meeting two stock faces instead of chamfering the corner', () => {
    const stock = new StockModel([4, 4, 4], 0.4, boxVolume([4, 4, 4]));
    const normal = new THREE.Vector3(0.6, 0, 0.8),
      offset = 0.15;
    stock.subtract(
      {
        bounds: new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5)),
        distance: (point) => offset - normal.dot(point),
        normal: (_, target) => target.copy(normal).negate(),
      },
      () => {},
    );
    const chunks = mesh(stock),
      vertices = points(chunks);
    for (const y of [-2, 2]) {
      const corner = new THREE.Vector3(2, y, (offset - 1.2) / 0.8);
      expect(Math.min(...vertices.map((point) => point.distanceTo(corner)))).toBeLessThan(2e-6);
    }
    expect(
      Math.max(
        ...vertices.map((point) =>
          Math.abs(Math.max(boxVolume([4, 4, 4]).distance(point), normal.dot(point) - offset)),
        ),
      ),
    ).toBeLessThan(2e-6);
    closed(chunks);
  });

  it('closes ambiguous face contours for two nearby diagonal holes', () => {
    const stock = new StockModel([4, 4, 4], 0.5, boxVolume([4, 4, 4]));
    const cutter = cylinderVolume(0.23, 8);
    for (const value of [-0.25, 0.25]) {
      const shift = new THREE.Vector3(value, value, 0);
      stock.subtract(
        {
          bounds: cutter.bounds.clone().translate(shift),
          distance: (point) => cutter.distance(point.clone().sub(shift)),
          normal: (point, target) => cutter.normal!(point.clone().sub(shift), target),
        },
        () => {},
      );
    }
    closed(mesh(stock));
  });

  it('closes a pocket whose floor lies exactly on a lattice face', () => {
    const setup = input();
    setup.resolutionMm = 0.5;
    const engine = new MaterialRemovalEngine(setup);
    engine.applyMotion(motion([0.13, -0.07, 3], [0.13, -0.07, -0.25]));
    closed(mesh(engine.stock));
  });

  it('keeps cached neighbouring chunks closed and equivalent to a fresh mesh after another cut', () => {
    const engine = new MaterialRemovalEngine(input()),
      builder = new StockMeshBuilder();
    builder.buildChanged(engine.stock);
    engine.applyMotion(motion([1.08, 0.07, 3], [1.08, 0.07, -0.37]));
    builder.buildChanged(engine.stock);
    engine.applyMotion(motion([0.83, -0.32, 3], [0.83, -0.32, -1.17]));
    builder.buildChanged(engine.stock);
    const cached = builder.getChunks();
    closed(cached);
    const signature = (chunks: StockSurfaceChunk[]) =>
      points(chunks)
        .map((point) =>
          point
            .toArray()
            .map((value) => Math.round(value * 1e5))
            .join(','),
        )
        .sort();
    expect(signature(cached)).toEqual(signature(mesh(engine.stock)));
  });

  it('retains a closed pocket through turning, milling and another turning cut', () => {
    const setup = input();
    setup.stock = { type: 'cylinder', diameter: 8, length: 8, zeroVertex: 1 };
    setup.resolutionMm = 0.25;
    const insert: ProgramToolDefinition = {
      toolNumber: 100,
      description: 'Square insert',
      cutting: [
        {
          type: 'insert',
          shape: 'S',
          ic: 4,
          thickness: 1,
          noseRadius: 0,
          clearanceAngle: 0,
          rotation: [0, 45, 0],
        },
      ],
    };
    const engine = new MaterialRemovalEngine(setup);
    engine.applyMotion(motion([3.5, 0, -8], [3.5, 0, 0], insert, 'turning'));
    engine.applyMotion(motion([2.25, 0, 0], [2.25, 0, -3]));
    engine.applyMotion(motion([3, 0, -8], [3, 0, 0], insert, 'turning'));
    const local = new THREE.Vector3(2.25, 0.125, -1.25).applyMatrix4(
      engine.stockToWorkpiece.clone().invert(),
    );
    expect(engine.stock.contains(local)).toBe(false);
    closed(mesh(engine.stock));
  });
});

describe('subtraction update efficiency', () => {
  it('uses fewer evaluations than fixed bisection while retaining bracket accuracy', () => {
    let tests = 0;
    expect(
      edgeRoot(-0.37, 0.63, (t) => {
        tests++;
        return t - 0.37;
      }),
    ).toBeCloseTo(0.37, 8);
    expect(tests).toBeLessThan(4);
    expect(edgeRoot(-0.37e-13, 0.63e-13, (t) => 1e-13 * (t - 0.37))).toBeCloseTo(0.37, 8);
    expect(() => edgeRoot(-1, 1, (t) => t - 0.5, 1e-30)).toThrow('tolerance');
    tests = 0;
    const root = edgeRoot(-0.23, 0.77, (t) => {
      tests++;
      return t * t - 0.23;
    });
    expect(Math.abs(root - Math.sqrt(0.23))).toBeLessThan(1e-7);
    expect(tests).toBeLessThan(24);
    expect(() => edgeRoot(-1, 1, () => NaN)).toThrow('Non-finite');
  });

  it('batches only contiguous, fixed-orientation, same-tool analytical sweeps', () => {
    const a = motion([0.13, -0.07, 3], [0.13, -0.07, 0]);
    const b = motion([0.13, -0.07, 0], [0.13, -0.07, -3]);
    expect(batchRemovalMotions([a, b])).toHaveLength(1);
    const direct = new MaterialRemovalEngine(input());
    direct.applyMotion(a);
    direct.applyMotion(b);
    const batched = new MaterialRemovalEngine(input());
    for (const batch of batchRemovalMotions([a, b])) batched.applyMotion(batch.motion);
    expect(batched.samples).toBe(1);
    expect(batched.stock.remainingCells).toBe(direct.stock.remainingCells);
    for (let z = -2; z <= 2; z += 0.1)
      expect(batched.stock.contains(new THREE.Vector3(0.13, -0.07, z))).toBe(
        direct.stock.contains(new THREE.Vector3(0.13, -0.07, z)),
      );
    for (let x = -1; x < 1; x += 0.13)
      for (let y = -1; y < 1; y += 0.17)
        for (let z = -2; z < 2; z += 0.41) {
          const point = new THREE.Vector3(x, y, z);
          expect(batched.stock.contains(point)).toBe(direct.stock.contains(point));
        }
    const variants = [
      { ...b, mode: 'turning' as const },
      { ...b, executedQ: 3 },
      { ...b, tool: { ...mill, cutting: [{ type: 'endMill' as const, diameter: 2, length: 6 }] } },
      { ...b, end: { ...b.end, position: [0.3, -0.07, -3] as [number, number, number] } },
      { ...b, start: { ...b.start, frameId: 'other' } },
      {
        ...b,
        end: {
          ...b.end,
          orientation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] as [number, number, number, number],
        },
      },
      { ...b, end: { ...b.end, position: a.start.position } },
    ];
    for (const variant of variants) expect(batchRemovalMotions([a, variant])).toHaveLength(2);
    const diagonal = [motion([0, 0, 3], [1, 0, 2]), motion([1, 0, 2], [2, 0, 1])];
    expect(batchRemovalMotions(diagonal)).toHaveLength(2);
    const invalid = motion([0.13, -0.07, 0], [0.13, -0.07, -3]);
    Reflect.set(invalid.start, 'position', [...invalid.start.position, 1]);
    expect(() => simulateMaterialRemoval({ ...input(), motions: [a, invalid] })).toThrow(
      'finite positions',
    );
  });

  it('retains original progress counts and stopped-prefix metadata after batching', () => {
    const setup = input();
    setup.motions = [
      motion([0.13, -0.07, 3], [0.13, -0.07, 0]),
      motion([0.13, -0.07, 0], [0.13, -0.07, -3]),
    ];
    setup.stop = { message: 'Unsupported next motion', executionStep: 3, lineNumber: 7 };
    const progress: number[] = [];
    const result = simulateMaterialRemoval(setup, (processed) => progress.push(processed));
    expect(progress).toEqual([0, 1, 2]);
    expect(result.processedMotions).toBe(2);
    expect(result.samples).toBe(1);
    expect(result.status).toBe('stopped');
    expect(result.stop).toEqual(setup.stop);
  });

  it('keeps turning fields sign-correct, 1-Lipschitz and outward-normal oriented', () => {
    const tool: ProgramToolDefinition = {
      toolNumber: 100,
      description: 'Insert',
      cutting: [
        {
          type: 'insert',
          shape: 'S',
          ic: 4,
          thickness: 1,
          noseRadius: 0,
          clearanceAngle: 0,
          rotation: [0, 45, 0],
        },
      ],
    };
    const cutter = new CuttingToolModel(tool);
    for (const radius of [-3, 3]) {
      const field = buildTurningEnvelope(
        cutter,
        new THREE.Matrix4().makeTranslation(radius, 0, -2),
        new THREE.Vector3(),
        new THREE.Vector3(0, 0, 1),
      );
      for (let x = 0.13; x < 8; x += 0.29)
        for (let z = -5.13; z < 3; z += 0.31) {
          const point = new THREE.Vector3(x, 0, z),
            distance = field.distance(point);
          if (Math.abs(distance) > 1e-8) expect(distance < 0).toBe(field.inside(point));
          const next = point.clone().add(new THREE.Vector3(0.03, 0.02, 0.01));
          expect(Math.abs(field.distance(next) - distance)).toBeLessThanOrEqual(
            point.distanceTo(next) + 1e-10,
          );
          const normal = surfaceNormal(field, point, 1e-5);
          expect(
            field.distance(point.clone().addScaledVector(normal, 1e-5)),
          ).toBeGreaterThanOrEqual(distance - 1e-10);
        }
    }
  });

  it('bounds a STAR-style 20 mm mixed turning/milling fixture at 0.2 mm', () => {
    const setup = input();
    setup.stock = { type: 'cylinder', diameter: 20, length: 20, zeroVertex: 0 };
    const tool: ProgramToolDefinition = {
      toolNumber: 100,
      description: 'Turning Insert V 4.8 mm',
      Q: 3,
      R: 0.2,
      cutting: [
        {
          type: 'insert',
          shape: 'V',
          ic: 4.7625,
          thickness: 1.59,
          noseRadius: 0.2,
          clearanceAngle: 7,
          zeroVertex: 0,
          rotation: [0, 18, 0],
        },
      ],
      turning: {
        hand: 'right',
        mount: 'front',
        approachAngle: 93,
        activeCorner: 'front-right',
        reference: 'virtualTip',
      },
    };
    const orientation: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    const turning = [
      [5, 0, 0],
      [0, 0, 0],
      [4.5, 0, 0],
      [5, 0, 0.5],
      [5, 0, 5],
      [7.5, 0, 5],
      [8, 0, 5.5],
      [8, 0, 10],
    ];
    const divisions = [6, 6, 6, 8, 6, 6, 8];
    const append = (
      a: number[],
      b: number[],
      count: number,
      cutter: ProgramToolDefinition,
      mode: 'turning' | 'milling',
    ) => {
      const start = new THREE.Vector3(...a),
        end = new THREE.Vector3(...b);
      for (let i = 0; i < count; i++)
        setup.motions.push(
          motion(
            start
              .clone()
              .lerp(end, i / count)
              .toArray(),
            start
              .clone()
              .lerp(end, (i + 1) / count)
              .toArray(),
            cutter,
            mode,
            orientation,
          ),
        );
    };
    for (let i = 0; i < divisions.length; i++)
      append(turning[i], turning[i + 1], divisions[i], tool, 'turning');
    const radialMill: ProgramToolDefinition = {
      toolNumber: 3200,
      description: 'End Mill 2 mm',
      cutting: [{ type: 'endMill', diameter: 2, length: 6 }],
    };
    append([10, 0, 10], [0, 0, 10], 20, radialMill, 'milling');
    append([0, 0, 10], [10, 0, 10], 20, radialMill, 'milling');
    expect(setup.motions).toHaveLength(86);
    expect(batchRemovalMotions(setup.motions)).toHaveLength(9);
    const result = simulateMaterialRemoval(setup);
    expect(result.status).toBe('completed');
    expect(result.samples).toBe(9);
    expect(result.removedCells).toBeGreaterThan(0);
    expect(result.cellTests).toBeLessThan(10_000_000);
    expect(result.peakStockBytes).toBeLessThanOrEqual(SIMULATION_LIMITS.stockBytes);
    expect(result.surfaceBytes).toBeLessThanOrEqual(SIMULATION_LIMITS.surfaceFaces * 144);
    expect(result.elapsedMs).toBeLessThan(20000);
    closed(result.chunks);
    console.info('Hermite STAR-style 20x20 mm / 0.2 mm benchmark', {
      elapsedMs: result.elapsedMs,
      cellTests: result.cellTests,
      samples: result.samples,
      peakStockBytes: result.peakStockBytes,
      surfaceBytes: result.surfaceBytes,
    });
  }, 30000);
});
