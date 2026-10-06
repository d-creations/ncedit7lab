import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BallMillSweep } from '../BallMillSweep';
import { CuttingToolModel } from '../CuttingToolModel';
import { boxVolume, surfaceNormal } from '../ImplicitGeometry';
import {
  batchRemovalMotions,
  MaterialRemovalEngine,
  simulateMaterialRemoval,
} from '../MaterialRemovalEngine';
import { StockModel } from '../StockModel';
import { StockMeshBuilder } from '../StockMeshBuilder';
import type { RemovalMotion, SimulationInput, StockSurfaceChunk } from '../SimulationTypes';
import type { ProgramToolDefinition } from '../../tools/SimulationMetadata';

const ball: ProgramToolDefinition = {
  toolNumber: 1,
  description: 'Ball mill',
  cutting: [{ type: 'ballMill', diameter: 1.4, length: 3 }],
};
const frameId = 'workpiece:test';
function motion(start: [number, number, number], end: [number, number, number]): RemovalMotion {
  const pose = (position: [number, number, number]) => ({
    position,
    orientation: [0, 0, 0, 1] as [number, number, number, number],
    frameId,
    reference: 'millingTip' as const,
  });
  return { tool: ball, mode: 'milling', executionStep: 0, start: pose(start), end: pose(end) };
}
function input(motions: RemovalMotion[] = []): SimulationInput {
  return {
    algorithmVersion: 2,
    stock: { type: 'box', width: 4, height: 4, depth: 4 },
    binding: {
      frameId,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      spindleOrigin: [0, 0, 0],
      spindleAxis: [0, 0, 1],
    },
    resolutionMm: 0.2,
    motions,
  };
}
function random(): () => number {
  let state = 271828;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
function reference(
  point: THREE.Vector3,
  radius: number,
  length: number,
  travel: THREE.Vector3,
): number {
  const value = (t: number) =>
    Math.max(
      Math.hypot(
        point.x - t * travel.x,
        point.y - t * travel.y,
        Math.min(point.z - t * travel.z - radius, 0),
      ) - radius,
      point.z - t * travel.z - length,
    );
  let low = 0,
    high = 1;
  for (let i = 0; i < 90; i++) {
    const a = low + (high - low) / 3,
      b = high - (high - low) / 3;
    if (value(a) <= value(b)) high = b;
    else low = a;
  }
  return Math.min(value(0), value(1), value((low + high) / 2));
}
function mesh(stock: StockModel): StockSurfaceChunk[] {
  const builder = new StockMeshBuilder();
  builder.buildChanged(stock);
  return builder.getChunks().sort((a, b) => a.id - b.id);
}
function closed(chunks: StockSurfaceChunk[]): void {
  const edges = new Map<string, { count: number; balance: number }>();
  for (const chunk of chunks) {
    const p = chunk.positions;
    for (let i = 0; i < p.length; i += 9) {
      const vertices = [0, 3, 6].map(
        (offset) => `${p[i + offset]},${p[i + offset + 1]},${p[i + offset + 2]}`,
      );
      for (let j = 0; j < 3; j++) {
        const a = vertices[j],
          b = vertices[(j + 1) % 3];
        expect(a).not.toBe(b);
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const edge = edges.get(key) ?? { count: 0, balance: 0 };
        edge.count++;
        edge.balance += a < b ? 1 : -1;
        edges.set(key, edge);
      }
    }
  }
  expect(edges.size).toBeGreaterThan(0);
  const invalid = [...edges].filter(([, edge]) => edge.count !== 2 || edge.balance !== 0);
  expect(invalid.length, JSON.stringify(invalid.slice(0, 4))).toBe(0);
}

describe('continuous finite ball-mill removal', () => {
  it('matches independent convex minimization for lateral, diagonal, axial and very short sweeps', () => {
    const next = random();
    const travels = [
      new THREE.Vector3(),
      new THREE.Vector3(2, 0, 0),
      new THREE.Vector3(-1, 2, 0),
      new THREE.Vector3(2, 1, 3),
      new THREE.Vector3(-2, 1, -3),
      new THREE.Vector3(0, 0, 2),
      new THREE.Vector3(0, 0, -2),
      new THREE.Vector3(1e-9, -2e-9, 3e-9),
      new THREE.Vector3(1, 0, 1),
    ];
    for (const length of [0.6, 0.61, 0.9, 1.2, 3]) {
      for (const travel of travels) {
        const field = new BallMillSweep(0.6, length, travel);
        for (let i = 0; i < 120; i++) {
          const p = new THREE.Vector3(next() * 8 - 4, next() * 6 - 3, next() * 10 - 4);
          const expected = reference(p, 0.6, length, travel);
          expect(
            Math.abs(field.evaluate(p) - expected),
            JSON.stringify({ p: p.toArray(), length, travel: travel.toArray() }),
          ).toBeLessThan(2e-10);
          const offset = new THREE.Vector3(next() - 0.5, next() - 0.5, next() - 0.5);
          expect(
            Math.abs(field.evaluate(p.clone().add(offset)) - field.evaluate(p)),
          ).toBeLessThanOrEqual(offset.length() + 1e-10);
        }
      }
    }
  });

  it('keeps the finite top and cylindrical cutting body, rather than subtracting only a capsule', () => {
    const field = new BallMillSweep(1, 1.2, new THREE.Vector3(2, 0, 0));
    expect(field.evaluate(new THREE.Vector3(1, 0, 1.8))).toBeCloseTo(0.6, 12);
    expect(field.evaluate(new THREE.Vector3(1, 0, 1.1))).toBeLessThan(0);
    const long = new BallMillSweep(1, 4, new THREE.Vector3(2, 0, 0));
    expect(long.evaluate(new THREE.Vector3(1, 0.5, 3.5))).toBeLessThan(0);
    expect(long.evaluate(new THREE.Vector3(1, 0, -0.1))).toBeGreaterThan(0);
    const diagonal = new BallMillSweep(1, 1.2, new THREE.Vector3(2, 0, 2));
    expect(diagonal.evaluate(new THREE.Vector3(-0.7, 0, 1.65))).toBeGreaterThan(0);
    expect(new THREE.Vector3(-0.7, 0, 0.65).length()).toBeLessThan(1);
    expect(diagonal.evaluate(new THREE.Vector3(2, 0, 3.3))).toBeGreaterThan(0);
  });

  it('has no artificial zero-field plane inside the ball/cylinder equator', () => {
    const cutter = new CuttingToolModel(ball);
    const volume = cutter.volume(new THREE.Matrix4());
    expect(volume.distance(new THREE.Vector3(0, 0, 0.7))).toBeCloseTo(-0.7, 12);
    expect(volume.distance(new THREE.Vector3(0.3, 0, 0.7))).toBeCloseTo(-0.4, 12);
    const hemisphere = new CuttingToolModel({
      ...ball,
      cutting: [{ type: 'ballMill', diameter: 1.4, length: 0.7 }],
    });
    expect(hemisphere.volume(new THREE.Matrix4()).distance(new THREE.Vector3(0, 0, 0.7))).toBe(0);
  });

  it('returns analytical pole, spherical, cylindrical and top normals in the transformed part frame', () => {
    const cutter = new CuttingToolModel({
      ...ball,
      cutting: [
        {
          type: 'ballMill',
          diameter: 2,
          length: 3,
          position: [0.3, 0.1, -0.2],
          rotation: [0, 90, 0],
        },
      ],
    });
    const pose = new THREE.Matrix4().makeRotationZ(0.3).setPosition(2, -1, 0.5);
    const transform = pose.clone().multiply(cutter.partToAssembly);
    const volume = cutter.volume(pose);
    const cases = [
      { p: [0, 0, 0], n: [0, 0, -1] },
      { p: [0.6, 0, 0.2], n: [0.6, 0, -0.8] },
      { p: [1, 0, 1], n: [1, 0, 0] },
      { p: [1, 0, 2], n: [1, 0, 0] },
      { p: [0, 0, 3], n: [0, 0, 1] },
    ];
    for (const { p, n } of cases) {
      let calls = 0;
      const normal = surfaceNormal(
        volume,
        new THREE.Vector3(...p).applyMatrix4(transform),
        1e-6,
        new THREE.Vector3(),
        () => calls++,
      );
      expect(calls).toBe(1);
      expect(normal.distanceTo(new THREE.Vector3(...n).transformDirection(transform))).toBeLessThan(
        1e-10,
      );
    }
  });

  it('matches analytical swept normals to field gradients, including the diagonal finite-rim envelope', () => {
    const next = random();
    for (const length of [0.7, 1, 3]) {
      const field = new BallMillSweep(0.7, length, new THREE.Vector3(2, -0.5, 1.3));
      for (let i = 0; i < 180; i++) {
        const p = new THREE.Vector3(next() * 6 - 2, next() * 4 - 2, next() * 6 - 1);
        if (field.evaluate(p) < 1e-4) continue;
        const normal = new THREE.Vector3(),
          gradient = new THREE.Vector3();
        field.evaluate(p, normal);
        for (let axis = 0; axis < 3; axis++) {
          const a = p.clone(),
            b = p.clone();
          a.setComponent(axis, a.getComponent(axis) + 1e-5);
          b.setComponent(axis, b.getComponent(axis) - 1e-5);
          gradient.setComponent(axis, field.evaluate(a) - field.evaluate(b));
        }
        expect(normal.length()).toBeCloseTo(1, 12);
        expect(normal.dot(gradient.normalize())).toBeGreaterThan(1 - 1e-7);
      }
    }
  });

  it('uses one sweep for diagonal ball travel while preserving the rotary sampling path', () => {
    const engine = new MaterialRemovalEngine(input());
    engine.applyMotion(motion([-1, 0, -1], [1, 0.5, -0.2]));
    expect(engine.samples).toBe(1);
    const rotary = motion([0, 0, -1], [0.1, 0, -1]);
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.1);
    rotary.end.orientation = [rotation.x, rotation.y, rotation.z, rotation.w];
    const other = new MaterialRemovalEngine(input());
    other.applyMotion(rotary);
    expect(other.samples).toBeGreaterThan(1);
    const rounded = motion([-1, 0, -1], [1, 0.5, -0.2]);
    rounded.start.orientation = [0, 0.70710678, 0, 0.70710678];
    rounded.end.orientation = rounded.start.orientation;
    const fixed = new MaterialRemovalEngine(input());
    fixed.applyMotion(rounded);
    expect(fixed.samples).toBe(1);
  });

  it('processes a 10,015-pair fixed-orientation program without exhausting the work budget', () => {
    const count = 10015;
    const paths = Array.from({ length: count }, (_, i) => {
      const path = motion(
        [-1 + (2 * i) / count, 0.13, -0.37],
        [-1 + (2 * (i + 1)) / count, 0.13, -0.37],
      );
      path.start.orientation = [0, 0.70710678, 0, 0.70710678];
      path.end.orientation = path.start.orientation;
      path.executionStep = i;
      return path;
    });
    const setup = input(paths);
    setup.resolutionMm = 0.05;
    const result = simulateMaterialRemoval(setup);
    expect(result.status).toBe('completed');
    expect(result.processedMotions).toBe(count);
    expect(result.samples).toBe(1);
    expect(result.cellTests).toBeLessThan(1000000);
    console.info(
      'ball 10015-pair fixture',
      JSON.stringify({
        elapsedMs: result.elapsedMs,
        cellTests: result.cellTests,
        samples: result.samples,
        processedMotions: result.processedMotions,
      }),
    );
  }, 30000);

  it('batches only contiguous collinear ball sweeps with matching tools, references and orientations', () => {
    const a = motion([-1, 0, -1], [0, 0, 0]);
    const b = motion([0, 0, 0], [1, 0, 1]);
    expect(batchRemovalMotions([a, b])).toHaveLength(1);
    const variants = [
      motion([0, 0, 0], [-1, 0, -1]),
      motion([0, 0, 0], [1, 0.1, 1]),
      { ...b, executedQ: 3 },
      { ...b, tool: { ...ball, cutting: [{ type: 'ballMill' as const, diameter: 1, length: 3 }] } },
      { ...b, start: { ...b.start, frameId: 'workpiece:other' } },
      { ...b, start: { ...b.start, reference: 'turningVirtualTip' as const } },
      {
        ...b,
        end: {
          ...b.end,
          orientation: [0, 0.1, 0, Math.sqrt(0.99)] as [number, number, number, number],
        },
      },
      motion([0.01, 0, 0], [1, 0, 1]),
    ];
    for (const variant of variants) expect(batchRemovalMotions([a, variant])).toHaveLength(2);
    const setup = input([a, b]);
    setup.stop = { executionStep: 2, lineNumber: 3, message: 'unsupported next motion' };
    const progress: number[] = [];
    const result = simulateMaterialRemoval(setup, (processed) => progress.push(processed));
    expect(result.processedMotions).toBe(2);
    expect(result.samples).toBe(1);
    expect(result.stop).toEqual(setup.stop);
    expect(progress).toContain(2);
  });

  it('does not reuse a previous cutting radius when the definition changes under the same tool number', () => {
    const engine = new MaterialRemovalEngine(input());
    engine.applyMotion(motion([-1.3, 0, -0.5], [-1.3, 0, -0.5]));
    const smaller = motion([1.1, 0, -0.5], [1.1, 0, -0.5]);
    smaller.tool = { ...ball, cutting: [{ type: 'ballMill', diameter: 0.8, length: 3 }] };
    engine.applyMotion(smaller);
    expect(engine.stock.contains(new THREE.Vector3(1.1, 0.5, 0.9))).toBe(true);
    expect(engine.stock.contains(new THREE.Vector3(1.1, 0.1, 0.9))).toBe(false);
  });

  it('reuses only certified lateral overlap and contained diagonal intervals, preserving exact output', () => {
    const size: [number, number, number] = [8, 4, 6];
    const accelerated = new StockModel(size, 0.2, boxVolume(size));
    const plain = new StockModel(size, 0.2, boxVolume(size));
    const cutter = new CuttingToolModel(ball);
    let acceleratedChecks = 0,
      plainChecks = 0;
    const paths: [number[], number[]][] = [
      [
        [-3, 0.11, -0.37],
        [-0.5, 0.11, -0.37],
      ],
      [
        [-1.5, 0.11, -0.37],
        [1.5, 0.11, -0.37],
      ],
      [
        [0, 0.11, -0.37],
        [3, 0.11, -0.37],
      ],
      [
        [3, 0.11, -0.37],
        [-3, 0.11, -0.37],
      ],
      [
        [-1, -1, -1],
        [1, -1, 1],
      ],
      [
        [0, -1, 0],
        [0.5, -1, 0.5],
      ],
      [
        [-1, -0.9, -1],
        [1, -0.9, 1],
      ],
      [
        [0.5, -1, 0.5],
        [2, -1, 2],
      ],
    ];
    for (const [start, end] of paths) {
      const pose = (values: number[]) =>
        new THREE.Matrix4().setPosition(new THREE.Vector3(...values));
      const sweep = cutter.translationSweep(pose(start), pose(end))!;
      accelerated.subtract(sweep, () => acceleratedChecks++);
      plain.subtract(
        { ...sweep, identity: undefined, sweepCoverage: undefined },
        () => plainChecks++,
      );
      expect(accelerated.removedCells).toBe(plain.removedCells);
    }
    expect(accelerated.coveredRegions).toBeGreaterThan(0);
    expect(acceleratedChecks).toBeLessThan(plainChecks);
    const actual = mesh(accelerated),
      expected = mesh(plain);
    closed(actual);
    expect(actual.map((chunk) => chunk.positions)).toEqual(
      expected.map((chunk) => chunk.positions),
    );
    expect(actual.map((chunk) => chunk.normals)).toEqual(expected.map((chunk) => chunk.normals));
    console.info(
      'ball overlap checks',
      JSON.stringify({
        acceleratedChecks,
        plainChecks,
        coveredRegions: accelerated.coveredRegions,
      }),
    );
  }, 30000);

  it('skips a contained diagonal return sweep without skipping a parallel offset path', () => {
    const stock = new StockModel([4, 4, 4], 0.2, boxVolume([4, 4, 4]));
    const cutter = new CuttingToolModel(ball);
    const pose = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
    let checks = 0;
    stock.subtract(cutter.translationSweep(pose(-1, -1, -1), pose(1, -1, 1))!, () => checks++);
    const before = checks;
    stock.subtract(cutter.translationSweep(pose(0.5, -1, 0.5), pose(0, -1, 0))!, () => checks++);
    expect(checks).toBe(before);
    stock.subtract(
      cutter.translationSweep(pose(0, -0.9, 0), pose(0.5, -0.9, 0.5))!,
      () => checks++,
    );
    expect(checks).toBeGreaterThan(before);
  });

  it('reduces .05 mm lateral/diagonal work against sampled cutters without changing the finite profile', () => {
    const setup = input();
    setup.resolutionMm = 0.05;
    const path = motion([-0.8, 0.13, -0.5], [0.8, 0.33, -0.1]);
    const engine = new MaterialRemovalEngine(setup);
    const started = performance.now();
    engine.applyMotion(path);
    const elapsedMs = performance.now() - started;
    const sampled = new StockModel([4, 4, 4], 0.05, boxVolume([4, 4, 4]));
    const cutter = new CuttingToolModel(ball);
    let sampledChecks = 0;
    const start = new THREE.Vector3(...path.start.position),
      end = new THREE.Vector3(...path.end.position);
    const divisions = Math.ceil(start.distanceTo(end) / (0.05 / 3));
    const sampledStarted = performance.now();
    for (let i = 0; i <= divisions; i++)
      sampled.subtract(
        cutter.volume(new THREE.Matrix4().setPosition(start.clone().lerp(end, i / divisions))),
        () => sampledChecks++,
      );
    const sampledMs = performance.now() - sampledStarted;
    expect(engine.samples).toBe(1);
    expect(engine.cellTests).toBeLessThan(sampledChecks / 3);
    expect(engine.stock.removedCells).toBe(63866);
    expect(engine.stock.removedCells).toBe(sampled.removedCells);
    const actual = mesh(engine.stock);
    closed(actual);
    console.info(
      'ball .05 fixture',
      JSON.stringify({
        continuous: {
          elapsedMs,
          cellTests: engine.cellTests,
          samples: engine.samples,
          removedCells: engine.stock.removedCells,
        },
        sampled: {
          elapsedMs: sampledMs,
          cellTests: sampledChecks,
          samples: divisions + 1,
          removedCells: sampled.removedCells,
        },
      }),
    );
  }, 120000);
});
