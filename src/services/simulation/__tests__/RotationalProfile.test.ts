import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { RotationalProfile } from '../RotationalProfile';
import { StockModel, boundaryEdgeRoot } from '../StockModel';
import { StockMeshBuilder } from '../StockMeshBuilder';
import { CuttingToolModel } from '../CuttingToolModel';
import { cylinderVolume, type ImplicitVolume } from '../ImplicitGeometry';
import { SIMULATION_LIMITS, type StockSurfaceChunk } from '../SimulationTypes';
import { WorkpieceFactory } from '../WorkpieceFactory';
import { buildTurningSweep } from '../TurningEnvelope';

function section(points: readonly (readonly [number, number])[]): ImplicitVolume {
  const polygon = points.map((point) => new THREE.Vector2(...point));
  const planes = polygon.map((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    const length = a.distanceTo(b);
    const x = (b.y - a.y) / length,
      z = (a.x - b.x) / length;
    return { x, z, offset: -x * a.x - z * a.y };
  });
  const field = (r: number, z: number): number =>
    Math.max(...planes.map((p) => p.x * r + p.z * z + p.offset));
  const radius = Math.max(...polygon.map((p) => Math.abs(p.x)));
  return {
    bounds: new THREE.Box3(
      new THREE.Vector3(-radius, -radius, Math.min(...polygon.map((p) => p.y))),
      new THREE.Vector3(radius, radius, Math.max(...polygon.map((p) => p.y))),
    ),
    rotationalSection: {
      spindleOrigin: new THREE.Vector3(),
      spindleAxis: new THREE.Vector3(0, 0, 1),
      polygon,
    },
    distance: (p) => Math.min(field(Math.hypot(p.x, p.y), p.z), field(-Math.hypot(p.x, p.y), p.z)),
    normal: (p, target) => {
      const r = Math.hypot(p.x, p.y);
      const sign = field(-r, p.z) < field(r, p.z) ? -1 : 1;
      const plane = planes.reduce((best, next) =>
        next.x * r * sign + next.z * p.z + next.offset >
        best.x * r * sign + best.z * p.z + best.offset
          ? next
          : best,
      );
      return target
        .set(r ? (plane.x * sign * p.x) / r : 0, r ? (plane.x * sign * p.y) / r : 0, plane.z)
        .normalize();
    },
  };
}
function rectangle(low: number, high: number, a: number, b: number): ImplicitVolume {
  return section([
    [low, a],
    [high, a],
    [high, b],
    [low, b],
  ]);
}
function stock(
  radius = 2,
  length = 4,
  spacing = 0.1,
): { stock: StockModel; profile: RotationalProfile } {
  const profile = new RotationalProfile(radius, length);
  return {
    profile,
    stock: new StockModel(
      [radius * 2, radius * 2, length],
      spacing,
      profile.volume,
      undefined,
      undefined,
      profile,
    ),
  };
}
function closed(chunks: StockSurfaceChunk[]): void {
  const edges = new Map<string, { count: number; balance: number }>();
  for (const chunk of chunks) {
    const key = (i: number): string => chunk.positions.subarray(i, i + 3).join(',');
    for (let i = 0; i < chunk.positions.length; i += 9)
      for (let j = 0; j < 3; j++) {
        const a = key(i + j * 3),
          b = key(i + ((j + 1) % 3) * 3);
        expect(a).not.toBe(b);
        const id = a < b ? `${a}|${b}` : `${b}|${a}`;
        const entry = edges.get(id) ?? { count: 0, balance: 0 };
        entry.count++;
        entry.balance += a < b ? 1 : -1;
        edges.set(id, entry);
      }
  }
  expect(edges.size).toBeGreaterThan(0);
  const bad = [...edges].filter(([, e]) => e.count !== 2 || e.balance !== 0);
  expect(bad.slice(0, 6)).toEqual([]);
}
function bruteCount(volume: ImplicitVolume, first: THREE.Vector3, span: number, h: number): number {
  let result = 0;
  const point = new THREE.Vector3();
  for (let z = 0; z < span; z++)
    for (let y = 0; y < span; y++)
      for (let x = 0; x < span; x++) {
        point.copy(first).add(new THREE.Vector3(x * h, y * h, z * h));
        if (volume.distance(point) < 0) result++;
      }
  return result;
}

describe('hybrid rotational base and local 3D removal', () => {
  it.each([
    [0, 1],
    [1.17, 1],
    [1.17, -1],
  ])(
    'prunes production insert fields and normals exactly with origin %s and axis %s',
    (originZ, axisZ) => {
      const profile = new RotationalProfile(2, 4);
      const initial = cylinderVolume(2, 4);
      const cutter = new CuttingToolModel({
        toolNumber: 1,
        description: 'V insert',
        Q: 3,
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
      });
      const cuts = [1.7, 1.5, 1.3].map((r) =>
        buildTurningSweep(
          cutter,
          new THREE.Matrix4().makeTranslation(r, 0, -1.5),
          new THREE.Matrix4().makeTranslation(r, 0, 1.5),
          new THREE.Vector3(0, 0, originZ),
          new THREE.Vector3(0, 0, axisZ),
        ),
      );
      for (const cut of cuts) profile.apply(cut, () => {});
      let state = 7;
      const random = (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2 ** 32;
      };
      for (let i = 0; i < 1600; i++) {
        const point = new THREE.Vector3(random() * 6 - 3, random() * 6 - 3, random() * 6 - 3);
        let field = initial.distance(point);
        let active: ImplicitVolume | undefined;
        for (const cut of cuts) {
          const next = -cut.distance(point);
          if (next > field) {
            field = next;
            active = cut;
          }
        }
        expect(profile.volume.distance(point)).toBe(field);
        const expected = active
          ? active.normal!(point, new THREE.Vector3()).negate()
          : initial.normal!(point, new THREE.Vector3());
        expect(profile.volume.normal!(point, new THREE.Vector3()).toArray()).toEqual(
          expected.toArray(),
        );
      }
      const full =
        1600 * 2 * cuts.reduce((sum, cut) => sum + cut.rotationalSection!.planes!.length, 0);
      expect(profile.planeTests).toBeLessThan(full * 0.75);
    },
  );

  it('counts profile cells against direct fields through shoulders, cones, bores and reflected cuts', () => {
    const profile = new RotationalProfile(2, 4);
    const first = new THREE.Vector3(-2, -2, -2);
    const cuts = [
      rectangle(1.5, 3, -1, 3),
      section([
        [0.8, -1.7],
        [3, -1.7],
        [3, -0.3],
        [1.3, -0.3],
      ]),
      rectangle(-0.4, 0.4, -3, 3),
      rectangle(-3, -1.1, -0.4, 0.3),
      rectangle(0.9, 1.2, -0.7, 0.2),
    ];
    for (const cut of cuts) {
      profile.apply(cut, () => {});
      expect(profile.volume.countCentres!(first, 20, 0.2)).toBe(
        bruteCount(profile.volume, first, 20, 0.2),
      );
    }
    expect(profile.radialIntervals(-3)).toEqual([]);
  });

  it('keeps turned boundaries coarse without changing centre samples or material membership', () => {
    const { stock: hybrid, profile } = stock(2.013, 4, 0.05);
    const reference = new StockModel([4.026, 4.026, 4], 0.05, cylinderVolume(2.013, 4));
    expect(hybrid.remainingCells).toBe(reference.remainingCells);
    let fastTests = 0,
      fineTests = 0;
    for (const cut of [rectangle(1.403, 3, -1.507, 3), rectangle(1.107, 3, 0.307, 3)]) {
      expect(hybrid.subtractTurning(cut, () => fastTests++)).toBe(true);
      reference.subtract(cut, () => fineTests++);
      const canonical = profile.countRegion(0, 0, 0, 84, 0.05, hybrid.latticeMinimum, () => {});
      expect(hybrid.remainingCells).toBe(canonical);
      expect(hybrid.removedCells).toBe(reference.removedCells);
    }
    expect(hybrid.boundaryCells).toBe(0);
    expect(hybrid.allocatedNodes).toBeLessThan(reference.allocatedNodes / 4);
    expect(fastTests).toBeLessThan(fineTests / 4);
    for (let z = -1.91; z < 1.91; z += 0.19)
      for (let r = 0.07; r < 2; r += 0.13) {
        const p = new THREE.Vector3(r, 0, z);
        expect(hybrid.contains(p)).toBe(reference.contains(p));
      }
    const builder = new StockMeshBuilder(undefined, { surfaceToleranceRatio: 0 });
    builder.buildChanged(hybrid);
    closed(builder.getChunks());
    const contour = [
      [0, -2],
      [2.013, -2],
      [2.013, -1.507],
      [1.403, -1.507],
      [1.403, 0.307],
      [1.107, 0.307],
      [1.107, 2],
      [0, 2],
    ].map(([r, z]) => new THREE.Vector2(r, z));
    let maximumDeviation = 0;
    const measure = (point: THREE.Vector3): void => {
      const p = new THREE.Vector2(Math.hypot(point.x, point.y), point.z);
      let distance = Infinity;
      for (let i = 1; i < contour.length; i++) {
        const a = contour[i - 1],
          b = contour[i];
        const direction = b.clone().sub(a);
        const t = THREE.MathUtils.clamp(
          p.clone().sub(a).dot(direction) / direction.lengthSq(),
          0,
          1,
        );
        distance = Math.min(distance, p.distanceTo(a.clone().addScaledVector(direction, t)));
      }
      maximumDeviation = Math.max(maximumDeviation, distance);
    };
    const measureChunks = (chunks: StockSurfaceChunk[]): void => {
      for (const chunk of chunks)
        for (let i = 0; i < chunk.positions.length; i += 9) {
          const vertices = [0, 3, 6].map((offset) =>
            new THREE.Vector3().fromArray(chunk.positions, i + offset),
          );
          vertices.forEach(measure);
          measure(
            vertices[0]
              .clone()
              .add(vertices[1])
              .add(vertices[2])
              .multiplyScalar(1 / 3),
          );
        }
    };
    measureChunks(builder.getChunks());
    const hybridDeviation = maximumDeviation;
    maximumDeviation = 0;
    const fineBuilder = new StockMeshBuilder(undefined, { surfaceToleranceRatio: 0 });
    fineBuilder.buildChanged(reference);
    measureChunks(fineBuilder.getChunks());
    expect(hybridDeviation).toBeLessThanOrEqual(maximumDeviation + 1e-6);
    expect(
      [...hybrid.getBoundaryChunks().values()].flat().some((c) => (c.span?.[2] ?? 1) > 1),
    ).toBe(true);
  }, 30000);

  it('uses the canonical lattice and direct signed fields for exact-grid contacts', () => {
    const { stock: hybrid, profile } = stock(2, 4, 0.2);
    hybrid.subtractTurning(rectangle(1.4, 3, -1.4, 3), () => {});
    let count = 0;
    const point = new THREE.Vector3();
    for (let z = 0; z < 22; z++)
      for (let y = 0; y < 22; y++)
        for (let x = 0; x < 22; x++) {
          point
            .set(x + 0.5, y + 0.5, z + 0.5)
            .multiplyScalar(0.2)
            .add(hybrid.latticeMinimum);
          if (profile.volume.distance(point) < 0) count++;
        }
    expect(hybrid.remainingCells).toBe(count);
  });

  it('extracts exact seam topology without repeating Hermite roots and normals', () => {
    const hybrid = stock().stock;
    hybrid.subtractTurning(rectangle(1.613, 3, -1.307, 3), () => {});
    const beforeNormals = hybrid.materialNormalTests;
    const beforeDistance = hybrid.materialDistanceTests;
    const topology = [...hybrid.iterateBoundaryTopology()];
    const topologyDistances = hybrid.materialDistanceTests - beforeDistance;
    expect(hybrid.materialNormalTests).toBe(beforeNormals);
    const beforeFull = hybrid.materialDistanceTests;
    const full = [...hybrid.iterateBoundaryChunks()];
    const referenceProfile = new RotationalProfile(2, 4);
    const reference = new StockModel(
      [4, 4, 4],
      0.1,
      referenceProfile.volume,
      undefined,
      { cachePristineHermite: false },
      referenceProfile,
    );
    reference.subtractTurning(rectangle(1.613, 3, -1.307, 3), () => {});
    const referenceBefore = reference.materialDistanceTests;
    expect(full).toEqual([...reference.iterateBoundaryChunks()]);
    expect(hybrid.materialDistanceTests - beforeFull).toBeLessThan(
      reference.materialDistanceTests - referenceBefore,
    );
    expect(hybrid.peakPristineHermiteCacheEntries).toBeLessThanOrEqual(4096);
    expect(topologyDistances).toBeLessThan(reference.materialDistanceTests - referenceBefore);
    expect(
      topology.map(([id, cells]) => [
        id,
        cells.map((cell) => ({
          x: cell.x,
          y: cell.y,
          z: cell.z,
          span: cell.span,
          crossedEdges: cell.crossedEdges,
        })),
      ]),
    ).toEqual(
      full.map(([id, cells]) => [
        id,
        cells.map((cell) => {
          let crossedEdges = 0;
          for (let edge = 0; edge < 12; edge++)
            if (Number.isFinite(boundaryEdgeRoot(cell, edge))) crossedEdges |= 1 << edge;
          return { x: cell.x, y: cell.y, z: cell.z, span: cell.span, crossedEdges };
        }),
      ]),
    );
  });

  it('preserves milling holes and pockets when turning resumes and stitches analytical panels to 3D cuts', () => {
    const hybrid = stock().stock;
    const reference = new StockModel([4, 4, 4], 0.1, cylinderVolume(2, 4));
    const builder = new StockMeshBuilder(undefined, { surfaceToleranceRatio: 0 });
    const initialTurn = rectangle(1.6, 3, -1.3, 3);
    hybrid.subtractTurning(initialTurn, () => {});
    reference.subtract(initialTurn, () => {});
    builder.buildChanged(hybrid);
    closed(builder.getChunks());
    const mill = new CuttingToolModel({
      toolNumber: 2,
      description: 'Hole',
      cutting: [{ type: 'endMill', diameter: 0.6, length: 5 }],
    });
    for (const point of [new THREE.Vector3(0.37, 0.13, -3), new THREE.Vector3(1.4, 0.17, -0.3)]) {
      const cut = mill.volume(new THREE.Matrix4().setPosition(point));
      hybrid.subtract(cut, () => {});
      reference.subtract(cut, () => {});
    }
    const resumed = rectangle(1.2, 3, 0.3, 3);
    hybrid.subtractTurning(resumed, () => {});
    reference.subtract(resumed, () => {});
    expect(hybrid.removedCells).toBe(reference.removedCells);
    expect(hybrid.contains(new THREE.Vector3(0.37, 0.13, 0))).toBe(false);
    expect(hybrid.contains(new THREE.Vector3(1.4, 0.17, 0))).toBe(false);
    expect(hybrid.contains(new THREE.Vector3(0.8, 0, 0))).toBe(true);
    builder.buildChanged(hybrid);
    closed(builder.getChunks());
    const rebuilt = new StockMeshBuilder(undefined, { surfaceToleranceRatio: 0 });
    rebuilt.buildChanged(hybrid);
    expect(builder.getChunks().sort((a, b) => a.id - b.id)).toEqual(
      rebuilt.getChunks().sort((a, b) => a.id - b.id),
    );
  }, 30000);

  it('gates misaligned stock, retains the 3D fallback and propagates profile capacity errors', () => {
    const { stock: hybrid } = stock();
    const unsupported = rectangle(1, 3, -3, 3);
    unsupported.rotationalSection!.spindleAxis.set(0.1, 0, Math.sqrt(0.99));
    expect(hybrid.subtractTurning(unsupported, () => {})).toBe(false);
    expect(hybrid.rotationalProfileUpdates).toBe(0);
    const profile = new RotationalProfile(2, 4);
    expect(() =>
      profile.apply(rectangle(1, 3, -3, 3), () => {
        throw new Error('profile memory budget');
      }),
    ).toThrow('profile memory budget');
    expect(profile.updates).toBe(0);
    const limits = { ...SIMULATION_LIMITS };
    const budgetStock = new StockModel([4, 4, 4], 0.1, profile.volume, limits, undefined, profile);
    limits.stockBytes = budgetStock.allocatedBytes;
    expect(() => budgetStock.subtractTurning(rectangle(1, 3, -3, 3), () => {})).toThrow(
      'memory budget',
    );
    const built = new WorkpieceFactory().create({
      algorithmVersion: 2,
      resolutionMm: 0.2,
      stock: { type: 'cylinder', diameter: 4, length: 4 },
      motions: [],
      binding: {
        frameId: 'workpiece:test',
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        spindleOrigin: [0.1, 0, 0],
        spindleAxis: [0, 0, 1],
      },
    });
    expect(built.stock.subtractTurning(rectangle(1, 3, -3, 3), () => {})).toBe(false);
    const disabled = new WorkpieceFactory().create({
      algorithmVersion: 2,
      rotationalProfile: false,
      resolutionMm: 0.2,
      stock: { type: 'cylinder', diameter: 4, length: 4 },
      motions: [],
      binding: {
        frameId: 'workpiece:test',
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        spindleOrigin: [0, 0, 0],
        spindleAxis: [0, 0, 1],
      },
    });
    expect(disabled.stock.subtractTurning(rectangle(1, 3, -3, 3), () => {})).toBe(false);
  });

  it('rejects excessive profile work and material queries explicitly', () => {
    const { stock: hybrid, profile } = stock();
    const cut = rectangle(1, 3, -3, 3);
    profile.arrangementTests = SIMULATION_LIMITS.cellTests;
    expect(() => hybrid.subtractTurning(cut, () => {})).toThrow('profile update budget');
    expect(profile.updates).toBe(0);
    profile.distancePrimitiveTests = SIMULATION_LIMITS.cellTests;
    expect(() => hybrid.contains(new THREE.Vector3(1.9, 0, 0))).toThrow(
      'Stock field evaluation budget',
    );
    expect(() => hybrid.reserveDiagnosticBytes(-1)).toThrow('Invalid operation diagnostic');
  });
});
