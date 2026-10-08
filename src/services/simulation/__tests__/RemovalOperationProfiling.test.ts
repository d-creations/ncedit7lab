import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { ProgramToolDefinition } from '../../tools/SimulationMetadata';
import {
  batchRemovalMotions,
  MaterialRemovalEngine,
  simulateMaterialRemoval,
} from '../MaterialRemovalEngine';
import { MAX_INDEXED_SWEEPS } from '../IndexedBallSweeps';
import { StockMeshBuilder } from '../StockMeshBuilder';
import { WorkpieceFactory } from '../WorkpieceFactory';
import { StockModel } from '../StockModel';
import { boxVolume } from '../ImplicitGeometry';
import { SIMULATION_LIMITS, type RemovalMotion, type SimulationInput } from '../SimulationTypes';

const mill: ProgramToolDefinition = {
  toolNumber: 1,
  description: 'Profiling mill',
  cutting: [{ type: 'endMill', diameter: 0.8, length: 2 }],
};
const ball: ProgramToolDefinition = {
  ...mill,
  cutting: [{ type: 'ballMill', diameter: 0.8, length: 2 }],
};
const insert: ProgramToolDefinition = {
  toolNumber: 2,
  description: 'Profiling insert',
  cutting: [
    {
      type: 'insert',
      shape: 'S',
      ic: 2,
      thickness: 0.5,
      noseRadius: 0,
      clearanceAngle: 0,
      rotation: [0, 45, 0],
    },
  ],
};
function motion(
  start: [number, number, number],
  end: [number, number, number],
  tool = mill,
  mode: RemovalMotion['mode'] = 'milling',
  executionStep = 0,
): RemovalMotion {
  const pose = (position: [number, number, number]) => ({
    position,
    orientation: [0, 0, 0, 1] as [number, number, number, number],
    frameId: 'workpiece:profile',
    reference: mode === 'turning' ? ('turningVirtualTip' as const) : ('millingTip' as const),
  });
  return {
    mode,
    tool,
    start: pose(start),
    end: pose(end),
    executionStep,
    lineNumber: executionStep + 10,
  };
}
function setup(motions: RemovalMotion[] = []): SimulationInput {
  return {
    algorithmVersion: 2,
    stock: { type: 'box', width: 4, height: 4, depth: 4 },
    binding: {
      frameId: 'workpiece:profile',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      spindleOrigin: [0, 0, 0],
      spindleAxis: [0, 0, 1],
    },
    resolutionMm: 0.5,
    motions,
  };
}

describe('executed-operation subtraction diagnostics', () => {
  it.each(['operation', 'provenance'] as const)(
    'rejects insufficient %s history capacity before uncharged allocation or cutting',
    (stage) => {
      const motions = [
        motion([20, 0, 0], [21, 0, 0], mill, 'milling', 1),
        motion([21, 0, 0], [22, 0, 0], mill, 'milling', 2),
      ];
      const input = setup(motions);
      const workpiece = new WorkpieceFactory().create(input);
      const limits = { ...SIMULATION_LIMITS };
      const stock = new StockModel([4, 4, 4], input.resolutionMm, boxVolume([4, 4, 4]), limits);
      const initialBytes = stock.allocatedBytes;
      const first = motions[0];
      const operationBytes =
        2048 +
        2 *
          JSON.stringify([
            first.mode,
            first.tool,
            first.executedQ,
            first.start.frameId,
            first.start.reference,
            first.end.frameId,
            first.end.reference,
          ]).length;
      limits.stockBytes =
        initialBytes + (stage === 'operation' ? operationBytes - 1 : operationBytes + 255);
      const factory = vi
        .spyOn(WorkpieceFactory.prototype, 'create')
        .mockReturnValue({ ...workpiece, stock });
      try {
        const engine = new MaterialRemovalEngine(input);
        const reserve = vi.spyOn(stock, 'reserveDiagnosticBytes');
        const apply = vi.spyOn(engine, 'applyMotion');
        const progress = vi.fn();
        const batches = batchRemovalMotions(motions);
        expect(batches).toHaveLength(1);
        expect(batches[0].sourceMotions).toBe(motions);
        expect(() => engine.applyBatches(batches, progress)).toThrow('memory budget');
        expect(engine.operationDiagnostics).toEqual([]);
        expect(apply).not.toHaveBeenCalled();
        expect(progress).not.toHaveBeenCalled();
        expect(reserve.mock.calls.map(([bytes]) => bytes)).toEqual(
          stage === 'operation' ? [operationBytes] : [operationBytes, 256],
        );
        expect(stock.allocatedBytes).toBe(
          initialBytes + (stage === 'operation' ? 0 : operationBytes),
        );
      } finally {
        factory.mockRestore();
      }
    },
  );

  it('charges merged original-motion provenance and includes history in allocation snapshots', () => {
    const motions = [
      motion([20, 0, 0], [21, 0, 0], mill, 'milling', 1),
      motion([21, 0, 0], [22, 0, 0], mill, 'milling', 2),
    ];
    const engine = new MaterialRemovalEngine(setup(motions));
    const initialBytes = engine.stock.allocatedBytes;
    const reserve = vi.spyOn(engine.stock, 'reserveDiagnosticBytes');
    const subtract = vi.spyOn(engine.stock, 'subtract').mockImplementation(() => {});
    try {
      engine.applyBatches(batchRemovalMotions(motions));
      const [operationBytes, provenanceBytes] = reserve.mock.calls.map(([bytes]) => bytes);
      expect(operationBytes).toBeGreaterThan(2048);
      expect(provenanceBytes).toBe(256);
      const [operation] = engine.operationDiagnostics;
      expect(operation.stockBytesBefore).toBe(initialBytes);
      expect(operation.stockBytesAfter).toBe(initialBytes + operationBytes + provenanceBytes);
      expect(engine.stock.allocatedBytes).toBe(operation.stockBytesAfter);
      expect(engine.stock.peakAllocatedBytes).toBeGreaterThanOrEqual(operation.stockBytesAfter);
      expect(operation.motions).toEqual([
        { motionIndex: 0, executionStep: 1, lineNumber: 11 },
        { motionIndex: 1, executionStep: 2, lineNumber: 12 },
      ]);
    } finally {
      reserve.mockRestore();
      subtract.mockRestore();
    }
  });

  it('keeps real chunk diagnostics final-only and separates material-field phases', () => {
    const input = setup();
    const workpiece = new WorkpieceFactory().create(input);
    let distances = 10;
    let normals = 3;
    let primitives = 100;
    Object.defineProperties(workpiece.stock, {
      materialDistanceTests: { get: () => distances, configurable: true },
      materialNormalTests: { get: () => normals, configurable: true },
      materialPrimitiveTests: { get: () => primitives, configurable: true },
    });
    const factory = vi.spyOn(WorkpieceFactory.prototype, 'create').mockReturnValue(workpiece);
    const chunkDiagnostics = [
      {
        id: 0,
        elapsedMs: 2,
        cells: 3,
        analyticalPanels: 1,
        fineTriangles: 12,
        outputTriangles: 8,
        triangulationMs: 0.75,
        adaptationMs: 1.25,
      },
    ];
    const builder = vi
      .spyOn(StockMeshBuilder.prototype, 'buildChanged')
      .mockImplementation(function (this: StockMeshBuilder) {
        distances += 7;
        normals += 2;
        primitives += 21;
        this.extractionMs = 0.5;
        Object.defineProperty(this, 'chunkDiagnostics', { value: chunkDiagnostics });
        return [];
      });
    try {
      const result = simulateMaterialRemoval(input);
      expect(result.meshingDiagnostics).toEqual(chunkDiagnostics);
      expect(result.operationDiagnostics).toEqual([]);
      expect(result.meshingAttribution).toBe('final-only');
      expect(result).toMatchObject({
        materialDistanceTests: 17,
        materialNormalTests: 5,
        materialPrimitiveTests: 121,
        subtractionMaterialDistanceTests: 0,
        subtractionMaterialNormalTests: 0,
        subtractionMaterialPrimitiveTests: 0,
        meshingMaterialDistanceTests: 7,
        meshingMaterialNormalTests: 2,
        meshingMaterialPrimitiveTests: 21,
        extractionMs: 0.5,
        triangulationMs: 0.75,
        adaptationMs: 1.25,
        meshedCells: 3,
        analyticalPanels: 1,
        fineTriangles: 12,
        outputTriangles: 8,
      });
      expect(structuredClone(result).meshingDiagnostics).toEqual(chunkDiagnostics);
    } finally {
      factory.mockRestore();
      builder.mockRestore();
    }
  });

  it('reports no fictitious operation for an empty stopped prefix and clones worker results', () => {
    const input = setup();
    input.stop = { message: 'First cut is unverified', executionStep: 0 };
    const progress: number[] = [];
    const result = simulateMaterialRemoval(input, (processed) => progress.push(processed));
    expect(result.operationDiagnostics).toEqual([]);
    expect(result.processedMotions).toBe(0);
    expect(result.status).toBe('stopped');
    expect(progress).toEqual([0]);
    expect(result.meshingAttribution).toBe('final-only');
    const clone = structuredClone(result);
    expect(clone.operationDiagnostics).toEqual([]);
    expect(clone.chunks).toHaveLength(result.chunks.length);
    expect(clone.chunks[0].positions).toBeInstanceOf(Float32Array);
    expect(clone.chunks[0].positions).not.toBe(result.chunks[0].positions);
  });

  it('preserves turning -> milling -> turning provenance, counters and stopped-prefix progress', () => {
    const input = setup([
      motion([1.6, 0, -4], [1.6, 0, -2], insert, 'turning', 3),
      motion([1.6, 0, -2], [1.6, 0, 0], insert, 'turning', 4),
      motion([0.5, 0, 0], [0.5, 0, -1], mill, 'milling', 6),
      motion([1.3, 0, -4], [1.3, 0, 0], insert, 'turning', 9),
    ]);
    input.stock = { type: 'cylinder', diameter: 4, length: 4, zeroVertex: 1 };
    input.stop = { message: 'Next motion is unverified', executionStep: 12, lineNumber: 22 };
    const progress: number[] = [];
    const result = simulateMaterialRemoval(input, (processed, total) => {
      expect(total).toBe(4);
      progress.push(processed);
    });
    const operations = result.operationDiagnostics!;
    expect(progress).toEqual([0, 1, 2, 3, 4]);
    expect(result.status).toBe('stopped');
    expect(result.stop).toEqual(input.stop);
    expect(operations.map((operation) => operation.mode)).toEqual([
      'turning',
      'milling',
      'turning',
    ]);
    expect(
      operations.map((operation) => [
        operation.firstMotionIndex,
        operation.lastMotionIndex,
        operation.motionCount,
      ]),
    ).toEqual([
      [0, 1, 2],
      [2, 2, 1],
      [3, 3, 1],
    ]);
    expect(operations.flatMap((operation) => operation.motions)).toEqual(
      input.motions.map((motion, motionIndex) => ({
        motionIndex,
        executionStep: motion.executionStep,
        lineNumber: motion.lineNumber,
      })),
    );
    expect(operations.map((operation) => operation.operationIndex)).toEqual([0, 1, 2]);
    for (const [index, operation] of operations.entries()) {
      expect(operation.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(operation.fieldEvaluations).toBeGreaterThan(0);
      expect(operation.regionTests).toBeGreaterThan(0);
      expect(operation.boundaryCellsDelta).toBe(
        operation.boundaryCellsAfter - operation.boundaryCellsBefore,
      );
      expect(operation.allocatedNodesDelta).toBe(
        operation.allocatedNodesAfter - operation.allocatedNodesBefore,
      );
      if (index) {
        expect(operation.stockBytesBefore).toBe(operations[index - 1].stockBytesAfter);
        expect(operation.boundaryCellsBefore).toBe(operations[index - 1].boundaryCellsAfter);
        expect(operation.allocatedNodesBefore).toBe(operations[index - 1].allocatedNodesAfter);
      }
      expect(operation).not.toHaveProperty('meshingMs');
    }
    for (const key of [
      'cellTests',
      'regionTests',
      'samples',
      'removedCells',
      'indexedBatches',
    ] as const) {
      expect(operations.reduce((sum, operation) => sum + operation[key], 0)).toBe(result[key]);
    }
    expect(operations.reduce((sum, operation) => sum + operation.elapsedMs, 0)).toBeLessThanOrEqual(
      result.subtractionMs!,
    );
    expect(result.meshingAttribution).toBe('final-only');
    expect(result.meshingMs).toBeGreaterThanOrEqual(0);
    expect(
      operations.reduce((sum, operation) => sum + (operation.materialDistanceTests ?? 0), 0),
    ).toBe(result.subtractionMaterialDistanceTests);
    expect(
      operations.reduce((sum, operation) => sum + (operation.materialNormalTests ?? 0), 0),
    ).toBe(result.subtractionMaterialNormalTests);
    expect(
      operations.reduce((sum, operation) => sum + (operation.materialPrimitiveTests ?? 0), 0),
    ).toBe(result.subtractionMaterialPrimitiveTests);
    expect(structuredClone(operations)).toEqual(operations);
  });

  it('flushes indexed ball unions at operation changes and keeps merged occurrences', () => {
    const motions = [
      motion([-1, -0.4, -0.4], [0, -0.4, -0.4], ball, 'milling', 1),
      motion([0, -0.4, -0.4], [1, -0.4, -0.4], ball, 'milling', 2),
      motion([1, -0.4, -0.4], [1, 0.4, -0.4], ball, 'milling', 3),
      motion([1, 0.4, -0.4], [-1, 0.4, -0.4], ball, 'milling', 4),
      motion(
        [-1, 0.4, -0.4],
        [-1, -0.4, -0.4],
        { ...ball, description: 'Changed full tool' },
        'milling',
        5,
      ),
    ];
    const batches = batchRemovalMotions(motions);
    expect(batches).toHaveLength(4);
    expect([batches[0].startIndex, batches[0].endIndex]).toEqual([0, 1]);
    expect(batches[0].sourceMotions).toBe(motions);
    const progress: number[] = [];
    const engine = new MaterialRemovalEngine(setup(motions));
    engine.applyBatches(batches, (processed) => progress.push(processed));
    expect(progress).toEqual([1, 2, 3, 4, 5]);
    const [first, second] = engine.operationDiagnostics;
    expect(first.motionCount).toBe(4);
    expect(first.indexedBatches).toBe(1);
    expect(first.fastPath).toBe('indexed-ball');
    expect(first.indexedPrimitiveTests).toBeGreaterThan(0);
    expect(first.fieldEvaluations).toBe(first.indexedPrimitiveTests);
    expect(first.indexedBoundTests).toBeGreaterThan(first.indexedPrimitiveTests);
    expect(second.motionCount).toBe(1);
    expect(second.indexedBatches).toBe(0);
    expect(second.fastPath).toBe('adaptive');
    const direct = new MaterialRemovalEngine(setup(motions));
    direct.applyBatches(batches, () => {}, false);
    expect(direct.stock.removedCells).toBe(engine.stock.removedCells);
    expect(direct.operationDiagnostics.map((operation) => operation.motions)).toEqual(
      engine.operationDiagnostics.map((operation) => operation.motions),
    );
  });

  it('does not split operations at the bounded index limit or lose deferred provenance', () => {
    const motions = Array.from({ length: MAX_INDEXED_SWEEPS + 1 }, (_, index) =>
      motion([20, index, 0], [21, index, 0], ball, 'milling', index),
    );
    const engine = new MaterialRemovalEngine(setup());
    const progress: number[] = [];
    engine.applyBatches(batchRemovalMotions(motions), (processed) => progress.push(processed));
    const [operation] = engine.operationDiagnostics;
    expect(engine.operationDiagnostics).toHaveLength(1);
    expect(operation.motionCount).toBe(motions.length);
    expect(operation.motions.map((occurrence) => occurrence.executionStep)).toEqual(
      motions.map((motion) => motion.executionStep),
    );
    expect(progress).toEqual(motions.map((_, index) => index + 1));
    expect(operation.indexedBatches).toBe(1);
    expect(operation.fastPath).toBe('mixed');
    expect(operation.fieldEvaluations).toBe(0);
  });

  it('groups by full tool, executed Q and pose reference, not orientation or direction', () => {
    const motions = [
      motion([-1, 0, 0], [0, 0, 0]),
      motion([0, 0, 0], [-1, 0, 0]),
      motion([-1, 0, 0], [0, 0, 0], {
        ...mill,
        holder: [{ type: 'box', width: 1, height: 1, length: 1 }],
      }),
      { ...motion([0, 0, 0], [1, 0, 0]), executedQ: 1 },
      motion([1, 0, 0], [0, 0, 0]),
    ];
    motions[4].start.reference = 'turningVirtualTip';
    motions[4].end.reference = 'turningVirtualTip';
    const engine = new MaterialRemovalEngine(setup(motions));
    engine.applyBatches(batchRemovalMotions(motions));
    expect(engine.operationDiagnostics.map((operation) => operation.motionCount)).toEqual([
      2, 1, 1, 1,
    ]);
    expect(engine.operationDiagnostics[2].executedQ).toBe(1);
    expect(engine.operationDiagnostics[3].reference).toBe('turningVirtualTip');
  });

  it('counts actual distance/normal calls, measures only subtraction and reports the turning hook', () => {
    const motions = [
      motion([1.6, 0, -4], [1.6, 0, 0], insert, 'turning'),
      motion([-1, 0, 0], [1, 0, 0]),
    ];
    const engine = new MaterialRemovalEngine(setup(motions));
    let updates = 0;
    let materialDistances = 20;
    let materialNormals = 10;
    let materialPrimitives = 50;
    Object.defineProperties(engine.stock, {
      materialDistanceTests: { get: () => materialDistances, configurable: true },
      materialNormalTests: { get: () => materialNormals, configurable: true },
      materialPrimitiveTests: { get: () => materialPrimitives, configurable: true },
    });
    const profileUpdates = vi
      .spyOn(engine.stock, 'rotationalProfileUpdates', 'get')
      .mockImplementation(() => updates);
    const turn = vi.spyOn(engine.stock, 'subtractTurning').mockImplementation((volume, test) => {
      updates++;
      materialDistances += 3;
      materialNormals += 2;
      materialPrimitives += 9;
      for (let index = 0; index < 5; index++) test();
      volume.distance(new THREE.Vector3());
      volume.normal?.(new THREE.Vector3(), new THREE.Vector3());
      return true;
    });
    const millSubtract = vi.spyOn(engine.stock, 'subtract').mockImplementation((volume, test) => {
      materialDistances += 4;
      materialNormals++;
      materialPrimitives += 11;
      for (let index = 0; index < 5; index++) test();
      volume.distance(new THREE.Vector3());
      volume.distance(new THREE.Vector3());
    });
    const clock = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(103)
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(207);
    engine.applyBatches(batchRemovalMotions(motions));
    clock.mockRestore();
    expect(turn).toHaveBeenCalledTimes(1);
    expect(millSubtract).toHaveBeenCalledTimes(1);
    expect(engine.operationDiagnostics[0]).toMatchObject({
      fieldEvaluations: 1,
      normalEvaluations: 1,
      elapsedMs: 3,
      fastPath: 'rotational',
      rotationalFastPath: true,
      rotationalFastPathSubtractions: 1,
      rotationalProfileUpdates: 1,
      cellTests: 5,
      materialDistanceTests: 3,
      materialNormalTests: 2,
      materialPrimitiveTests: 9,
    });
    expect(engine.operationDiagnostics[1]).toMatchObject({
      fieldEvaluations: 2,
      normalEvaluations: 0,
      elapsedMs: 7,
      fastPath: 'adaptive',
      rotationalFastPath: false,
      rotationalFastPathSubtractions: 0,
      rotationalProfileUpdates: 0,
      cellTests: 5,
      materialDistanceTests: 4,
      materialNormalTests: 1,
      materialPrimitiveTests: 11,
    });
    turn.mockRestore();
    millSubtract.mockRestore();
    profileUpdates.mockRestore();
  });
});
