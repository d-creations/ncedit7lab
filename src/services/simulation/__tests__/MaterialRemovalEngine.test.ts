import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { PoseSample } from '@core/types';
import type { ProgramToolDefinition } from '../../tools/SimulationMetadata';
import { MaterialRemovalEngine, simulateMaterialRemoval } from '../MaterialRemovalEngine';
import { CuttingToolModel } from '../CuttingToolModel';
import { StockModel } from '../StockModel';
import { StockMeshBuilder } from '../StockMeshBuilder';
import { WorkpieceFactory } from '../WorkpieceFactory';
import { getInsertQShift, TURN_Q_VECTORS } from '../TurningReference';
import { buildInsertContour } from '../../tools/InsertOutline';
import { SIMULATION_LIMITS, type SimulationInput, type RemovalMotion } from '../SimulationTypes';
import { boxVolume } from '../ImplicitGeometry';

const mill: ProgramToolDefinition = {
  toolNumber: 'mill',
  description: '2 mm mill',
  cutting: [{ type: 'endMill', diameter: 2, length: 6 }],
  holder: [{ type: 'box', width: 20, height: 20, length: 20 }],
};
const insert: ProgramToolDefinition = {
  toolNumber: 1,
  description: 'Square external turning insert',
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

function pose(position: [number, number, number], turning = false): PoseSample {
  return {
    position,
    orientation: [0, 0, 0, 1],
    reference: turning ? 'turningVirtualTip' : 'millingTip',
    frameId: 'workpiece:test',
  };
}
function motion(
  start: [number, number, number],
  end: [number, number, number],
  tool = mill,
  mode: 'milling' | 'turning' = 'milling',
): RemovalMotion {
  return {
    mode,
    tool,
    start: pose(start, mode === 'turning'),
    end: pose(end, mode === 'turning'),
    executionStep: 0,
  };
}
function input(): SimulationInput {
  return {
    algorithmVersion: 2,
    stock: { type: 'box', width: 12, height: 8, depth: 6 },
    binding: {
      frameId: 'workpiece:test',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      spindleOrigin: [0, 0, 0],
      spindleAxis: [0, 0, 1],
    },
    resolutionMm: 0.25,
    motions: [],
  };
}
function occupied(engine: MaterialRemovalEngine, point: [number, number, number]): boolean {
  const local = new THREE.Vector3(...point)
    .applyMatrix4(engine.stockToWorkpiece.clone().invert())
    .sub(engine.stock.minimum)
    .divideScalar(engine.stock.resolutionMm)
    .floor();
  return engine.stock.has(local.x, local.y, local.z);
}

describe('bounded geometric material subtraction', () => {
  it('cuts an entire milling slot, including the middle, without subtracting the holder', () => {
    const engine = new MaterialRemovalEngine(input());
    engine.applyMotion(motion([-4, 0, -1], [4, 0, -1]));
    for (const x of [-4, -2, 0, 2, 4]) expect(occupied(engine, [x, 0.125, 0])).toBe(false);
    expect(occupied(engine, [0, 1.375, 0])).toBe(true);
    expect(occupied(engine, [0, 0.125, -1.375])).toBe(true);
    const removed: THREE.Vector3[] = [];
    const point = new THREE.Vector3();
    for (let y = 0; y < engine.stock.dimensions[1]; y++) {
      for (let z = 0; z < engine.stock.dimensions[2]; z++) {
        const x = engine.stock.dimensions[0] / 2;
        if (!engine.stock.has(x, y, z)) removed.push(engine.stock.centre(x, y, z, point).clone());
      }
    }
    const box = new THREE.Box3().setFromPoints(removed);
    const width = box.max.y - box.min.y + engine.stock.resolutionMm;
    const depth = box.max.z - box.min.z + engine.stock.resolutionMm;
    expect(Math.abs(width - 2)).toBeLessThanOrEqual(engine.stock.resolutionMm);
    expect(Math.abs(depth - 4)).toBeLessThanOrEqual(engine.stock.resolutionMm);
  });

  it('cuts a drilled hole with a conical point and physical-mm stock dimensions', () => {
    const setup = input();
    setup.stock = { type: 'cylinder', diameter: 8, length: 8, zeroVertex: 1 };
    const drill: ProgramToolDefinition = {
      toolNumber: 2,
      description: '2 mm drill',
      cutting: [{ type: 'drill', diameter: 2, length: 8, tipAngle: 90 }],
    };
    const engine = new MaterialRemovalEngine(setup);
    engine.applyMotion(motion([0, 0, 1], [0, 0, -4], drill));
    expect(occupied(engine, [0.125, 0.125, -3])).toBe(false);
    expect(occupied(engine, [0.625, 0.125, -3.875])).toBe(true);
    expect(occupied(engine, [1.375, 0.125, -2])).toBe(true);
    expect(occupied(engine, [0.125, 0.125, -4.375])).toBe(true);
    const removedX: number[] = [];
    const local = new THREE.Vector3();
    for (let x = 0; x < engine.stock.dimensions[0]; x++) {
      engine.stock.centre(x, 16, 24, local);
      if (Math.abs(local.x) < 2 && !engine.stock.has(x, 16, 24)) removedX.push(local.x);
    }
    expect(
      Math.abs(Math.max(...removedX) - Math.min(...removedX) + setup.resolutionMm - 2),
    ).toBeLessThanOrEqual(setup.resolutionMm);
  });

  it('reduces a turning diameter and faces the front without changing to a 2D stock', () => {
    const setup = input();
    setup.stock = { type: 'cylinder', diameter: 8, length: 8, zeroVertex: 1 };
    const engine = new MaterialRemovalEngine(setup);
    engine.applyMotion(motion([3, 0, -8], [3, 0, 0], insert, 'turning'));
    expect(occupied(engine, [3.375, 0.125, -4])).toBe(false);
    expect(occupied(engine, [2.625, 0.125, -4])).toBe(true);
    const points: THREE.Vector3[] = [];
    const centre = new THREE.Vector3();
    for (let y = 0; y < engine.stock.dimensions[1]; y++) {
      for (let x = 0; x < engine.stock.dimensions[0]; x++) {
        if (engine.stock.has(x, y, 16)) points.push(engine.stock.centre(x, y, 16, centre).clone());
      }
    }
    const radius = Math.max(...points.map((point) => Math.hypot(point.x, point.y)));
    expect(Math.abs(radius * 2 - 6)).toBeLessThanOrEqual(2 * setup.resolutionMm);
    engine.applyMotion(motion([0, 0, -2], [4, 0, -2], insert, 'turning'));
    expect(occupied(engine, [0.125, 0.125, -1.375])).toBe(false);
    expect(occupied(engine, [0.125, 0.125, -2.375])).toBe(true);
    const remainingZ: number[] = [];
    for (let z = 0; z < engine.stock.dimensions[2]; z++) {
      if (engine.stock.has(16, 16, z))
        remainingZ.push(
          engine.stock.centre(16, 16, z, centre).applyMatrix4(engine.stockToWorkpiece).z,
        );
    }
    expect(Math.abs(Math.max(...remainingZ) + setup.resolutionMm / 2 + 2)).toBeLessThanOrEqual(
      setup.resolutionMm,
    );
  });

  it('preserves a milling pocket through turning -> milling -> turning', () => {
    const setup = input();
    setup.stock = { type: 'cylinder', diameter: 8, length: 8, zeroVertex: 1 };
    const engine = new MaterialRemovalEngine(setup);
    engine.applyMotion(motion([3.5, 0, -8], [3.5, 0, 0], insert, 'turning'));
    const afterTurning = engine.stock.remainingCells;
    const smallMill: ProgramToolDefinition = {
      toolNumber: 'pocket',
      description: '1 mm mill',
      cutting: [{ type: 'endMill', diameter: 1, length: 4 }],
    };
    engine.applyMotion(motion([2.25, 0, 0], [2.25, 0, -3], smallMill));
    expect(occupied(engine, [2.25, 0.125, -1.25])).toBe(false);
    expect(engine.stock.remainingCells).toBeLessThan(afterTurning);
    const afterMilling = engine.stock.remainingCells;
    engine.applyMotion(motion([3, 0, -8], [3, 0, 0], insert, 'turning'));
    expect(engine.stock.remainingCells).toBeLessThan(afterMilling);
    expect(occupied(engine, [2.25, 0.125, -1.25])).toBe(false);
    expect(occupied(engine, [1, 0.125, -1.25])).toBe(true);
  });

  it('samples rotary motion instead of subtracting only endpoint orientations', () => {
    const setup = input();
    const engine = new MaterialRemovalEngine(setup);
    const rotary = motion([0, 0, 0], [0, 0, 0]);
    const quarterTurn = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 2,
    );
    rotary.end = {
      ...rotary.end,
      orientation: [quarterTurn.x, quarterTurn.y, quarterTurn.z, quarterTurn.w],
    };
    engine.applyMotion(rotary);
    expect(occupied(engine, [2.125, 0.125, 2.125])).toBe(false);
    expect(engine.samples).toBeGreaterThan(2);
  });

  it('composes rotated stock, zero references and explicit frame binding once', () => {
    const setup = input();
    setup.stock = {
      type: 'box',
      width: 4,
      height: 6,
      depth: 8,
      zeroVertex: 7,
      rotation: [0, 0, 90],
      position: [2, 3, 4],
    };
    setup.binding = { ...setup.binding, position: [10, 20, 30], rotation: [90, 0, 0] };
    const { stockToWorkpiece } = new WorkpieceFactory().create(setup);
    const chosenCorner = new THREE.Vector3(2, 3, 4).applyMatrix4(stockToWorkpiece);
    const expected = new THREE.Vector3(2, 3, 4)
      .applyAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
      .add(new THREE.Vector3(10, 20, 30));
    expect(chosenCorner.distanceTo(expected)).toBeLessThan(1e-9);
    const unrotated = input();
    unrotated.stock = { type: 'cylinder', diameter: 8, length: 8 };
    const baseline = new MaterialRemovalEngine(unrotated);
    baseline.applyMotion(motion([-2, 0, -1], [2, 0, -1]));
    const transformed = input();
    transformed.stock = unrotated.stock;
    transformed.binding = { ...transformed.binding, position: [10, 20, 30], rotation: [90, 0, 0] };
    const rotated = motion([8, 21, 30], [12, 21, 30]);
    const quarterTurn = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI / 2,
    );
    rotated.start = {
      ...rotated.start,
      orientation: [quarterTurn.x, quarterTurn.y, quarterTurn.z, quarterTurn.w],
    };
    rotated.end = { ...rotated.end, orientation: rotated.start.orientation };
    const equivalent = new MaterialRemovalEngine(transformed);
    equivalent.applyMotion(rotated);
    expect(equivalent.stock.remainingCells).toBe(baseline.stock.remainingCells);
  });

  it('reports final preview statistics and a stopped prefix, never a completed unsupported result', () => {
    const setup = input();
    setup.motions = [motion([-4, 0, -1], [4, 0, -1])];
    setup.stop = { executionStep: 1, message: 'Unsupported threading' };
    const result = simulateMaterialRemoval(setup);
    expect(result.status).toBe('stopped');
    expect(result.processedMotions).toBe(1);
    expect(result.removedCells).toBeGreaterThan(0);
    expect(result.allocatedStockBytes).toBeLessThanOrEqual(SIMULATION_LIMITS.stockBytes);
    expect(result.surfaceBytes).toBeLessThanOrEqual(SIMULATION_LIMITS.surfaceFaces * 144);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.elapsedMs).toBeLessThan(5000);
  });

  it('rejects unbounded grids, excessive sampling and surface allocations explicitly', () => {
    expect(() => new StockModel([1e8, 1e8, 1e8], 0.05, boxVolume([1e8, 1e8, 1e8]))).toThrow(
      'cell budget',
    );
    expect(
      () => new StockModel([1, 1, 1], 0.25, boxVolume([1, 1, 1]), { cells: 1000, stockBytes: 1 }),
    ).toThrow('memory budget');
    const engine = new MaterialRemovalEngine(input());
    const excessive = motion([0, 0, 0], [100000, 0, 0]);
    excessive.end.orientation = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    expect(() => engine.applyMotion(excessive)).toThrow('sampling budget');
    expect(engine.stock.removedCells).toBe(0);
    expect(() => new StockMeshBuilder(1).buildChanged(engine.stock)).toThrow('face budget');
  });

  it('rebuilds dirty surface chunks and their boundary neighbours, not unchanged chunks', () => {
    const stock = new StockModel([12, 4, 4], 0.5, boxVolume([12, 4, 4]));
    const builder = new StockMeshBuilder();
    const first = builder.buildChanged(stock);
    expect(first).toHaveLength(2);
    expect(builder.buildChanged(stock)).toHaveLength(0);
    const volume = boxVolume([1, 6, 6]);
    stock.subtract(
      {
        bounds: volume.bounds.clone().translate(new THREE.Vector3(2, 0, 0)),
        distance: (point) => volume.distance(point.clone().sub(new THREE.Vector3(2, 0, 0))),
      },
      () => {},
    );
    expect(builder.buildChanged(stock)).toHaveLength(2);
    const positions = builder.getChunks()[0].positions;
    const normals = builder.getChunks()[0].normals;
    const a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      c = new THREE.Vector3();
    a.fromArray(positions, 0);
    b.fromArray(positions, 3);
    c.fromArray(positions, 6);
    const normal = b.sub(a).cross(c.sub(a)).normalize();
    expect(normal.dot(new THREE.Vector3().fromArray(normals, 0))).toBeCloseTo(1);
  });
});

describe('computational cutter references', () => {
  it('models drill, ball and corner-radius tips rather than display cylinders', () => {
    const model = (part: NonNullable<ProgramToolDefinition['cutting']>[number]) =>
      new CuttingToolModel({ toolNumber: 1, description: 'test', cutting: [part] });
    const drill = model({ type: 'drill', diameter: 4, length: 8, tipAngle: 90 });
    expect(drill.containsAssembly(new THREE.Vector3(0.4, 0, 0.5))).toBe(true);
    expect(drill.containsAssembly(new THREE.Vector3(0.6, 0, 0.5))).toBe(false);
    const ball = model({ type: 'ballMill', diameter: 4, length: 8 });
    expect(ball.containsAssembly(new THREE.Vector3(0.8, 0, 0.25))).toBe(true);
    expect(ball.containsAssembly(new THREE.Vector3(1.1, 0, 0.25))).toBe(false);
    const corner = model({ type: 'endMill', diameter: 4, length: 8, cornerRadius: 0.5 });
    expect(corner.containsAssembly(new THREE.Vector3(1.4, 0, 0))).toBe(true);
    expect(corner.containsAssembly(new THREE.Vector3(1.6, 0, 0))).toBe(false);
    expect(corner.containsAssembly(new THREE.Vector3(1.9, 0, 0.5))).toBe(true);
  });

  it('respects individual cutter transforms and ignores the stored tool mounting already resolved in poses', () => {
    const model = new CuttingToolModel({
      ...mill,
      orientation: [90, 0, 0],
      cutting: [
        { type: 'endMill', diameter: 2, length: 4, rotation: [0, 90, 0], position: [2, 0, 0] },
      ],
    });
    expect(model.containsAssembly(new THREE.Vector3(4, 0, 0))).toBe(true);
    expect(model.containsAssembly(new THREE.Vector3(0, 0, 2))).toBe(false);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 0])(
    'aligns a rounded insert nose to the declared Q=%s reference',
    (q) => {
      const part = {
        type: 'insert',
        shape: 'C',
        ic: 8,
        thickness: 2,
        noseRadius: 0.4,
        clearanceAngle: 7,
        rotation: [0, 45, 0],
      } as const;
      const tool: ProgramToolDefinition = {
        toolNumber: 1,
        description: 'insert',
        Q: q,
        cutting: [{ ...part, rotation: [0, 45, 0] }],
      };
      const contour = buildInsertContour(part);
      const centre = new THREE.Vector3(contour.radiusCenter![0], 0, contour.radiusCenter![1])
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4)
        .add(getInsertQShift(tool));
      expect(centre.x).toBeCloseTo(TURN_Q_VECTORS[q][0] * part.noseRadius);
      expect(centre.z).toBeCloseTo(TURN_Q_VECTORS[q][1] * part.noseRadius);
      expect(new CuttingToolModel(tool).insertSection).toHaveLength(contour.contour.length);
    },
  );
});
