import * as THREE from 'three';
import { CuttingToolModel } from './CuttingToolModel';
import { buildTurningSweep } from './TurningEnvelope';
import { WorkpieceFactory } from './WorkpieceFactory';
import { StockMeshBuilder } from './StockMeshBuilder';
import {
  SIMULATION_LIMITS,
  type RemovalMotion,
  type RemovalOperationDiagnostic,
  type SimulationInput,
  type SimulationResult,
} from './SimulationTypes';
import type { StockModel } from './StockModel';
import type { DeepReadonly } from '../tools/SimulationMetadata';
import { rotationQuaternion, stockPlacement } from './SimulationTransforms';
import { IndexedBallSweeps, MAX_INDEXED_SWEEPS } from './IndexedBallSweeps';
import type { ImplicitVolume } from './ImplicitGeometry';

export function materialCounters(stock: StockModel) {
  return {
    materialDistanceTests: stock.materialDistanceTests,
    materialNormalTests: stock.materialNormalTests,
    materialPrimitiveTests: stock.materialPrimitiveTests,
  };
}

function counterDelta(after: number | undefined, before: number | undefined): number | undefined {
  return after === undefined || before === undefined ? undefined : after - before;
}

interface RemovalBatch {
  motion: DeepReadonly<RemovalMotion>;
  startIndex: number;
  endIndex: number;
  sourceMotions: DeepReadonly<RemovalMotion[]>;
}

const OPERATION_DIAGNOSTIC_BYTES = 2048;
const MOTION_DIAGNOSTIC_BYTES = 128;

export function batchRemovalMotions(
  motions: DeepReadonly<RemovalMotion[]>,
  reserveWorkspace?: (bytes: number) => void,
): RemovalBatch[] {
  const result: RemovalBatch[] = [];
  const equal = (a: readonly number[], b: readonly number[]): boolean =>
    a.length === b.length &&
    a.every((value, i) => Number.isFinite(value) && Math.abs(value - b[i]) <= 1e-12);
  const compatible = (a: DeepReadonly<RemovalMotion>, b: DeepReadonly<RemovalMotion>): boolean => {
    if (
      a.mode !== b.mode ||
      a.executedQ !== b.executedQ ||
      JSON.stringify(a.tool) !== JSON.stringify(b.tool)
    )
      return false;
    const poses = [a.start, a.end, b.start, b.end];
    if (
      !poses.every(
        (pose) =>
          pose.position.length === 3 &&
          pose.orientation.length === 4 &&
          Math.abs(Math.hypot(...pose.orientation) - 1) <= 1e-6 &&
          pose.frameId === a.start.frameId &&
          pose.reference === a.start.reference &&
          equal(pose.orientation, a.start.orientation) &&
          pose.position.every(Number.isFinite),
      ) ||
      !equal(a.end.position, b.start.position)
    )
      return false;
    const first = new THREE.Vector3(...a.end.position).sub(new THREE.Vector3(...a.start.position));
    const second = new THREE.Vector3(...b.end.position).sub(new THREE.Vector3(...b.start.position));
    if (
      first.lengthSq() === 0 ||
      second.lengthSq() === 0 ||
      first.dot(second) <= 0 ||
      first.clone().cross(second).length() > first.length() * second.length() * 1e-12
    )
      return false;
    if (a.mode === 'turning') return true;
    const part = a.tool.cutting?.length === 1 ? a.tool.cutting[0] : undefined;
    if (!part || part.type === 'insert') return false;
    if (part.type === 'ballMill') return true;
    const orientation = new THREE.Quaternion(...a.start.orientation).multiply(
      rotationQuaternion(part.rotation ?? [0, 0, 0]),
    );
    const direction = first.clone().normalize().applyQuaternion(orientation.invert());
    return (
      Math.hypot(direction.x, direction.y) < 1e-12 ||
      (part.type === 'endMill' && !part.cornerRadius && Math.abs(direction.z) < 1e-12)
    );
  };
  motions.forEach((motion, index) => {
    reserveWorkspace?.((result.length + 2) * 512);
    const previous = result[result.length - 1];
    if (previous && compatible(previous.motion, motion)) {
      result[result.length - 1] = {
        motion: { ...previous.motion, end: motion.end },
        startIndex: previous.startIndex,
        endIndex: index,
        sourceMotions: motions,
      };
    } else result.push({ motion, startIndex: index, endIndex: index, sourceMotions: motions });
  });
  return result;
}

export class MaterialRemovalEngine {
  readonly stock: StockModel;
  readonly stockToWorkpiece: THREE.Matrix4;
  private readonly workpieceToStock: THREE.Matrix4;
  private readonly spindleOrigin: THREE.Vector3;
  private readonly spindleAxis: THREE.Vector3;
  private readonly cutters = new Map<string, CuttingToolModel>();
  cellTests = 0;
  samples = 0;
  indexedBatches = 0;
  indexedPrimitiveTests = 0;
  indexedBoundTests = 0;
  private readonly observation = { active: false, fields: 0, normals: 0 };
  get fieldEvaluations(): number { return this.observation.fields; }
  get normalEvaluations(): number { return this.observation.normals; }
  rotationalFastPathSubtractions = 0;
  readonly operationDiagnostics: RemovalOperationDiagnostic[] = [];
  private activeOperation?: RemovalOperationDiagnostic;
  private operationHasSubtraction = false;
  private operationKey?: string;
  private operationBefore?: ReturnType<MaterialRemovalEngine['snapshot']>;

  private observedVolume<T extends ImplicitVolume>(volume: T): T {
    const observation = this.observation;
    return {
      ...volume,
      distance: (point) => {
        if (observation.active) observation.fields++;
        return volume.distance(point);
      },
      normal: volume.normal
        ? (point, target) => {
            if (observation.active) observation.normals++;
            return volume.normal!(point, target);
          }
        : undefined,
    };
  }

  private subtract(
    volume: ImplicitVolume,
    path: 'adaptive' | 'turning' | 'indexed-ball' = 'adaptive',
  ): void {
    const started = performance.now();
    this.observation.active = true;
    let rotational = false;
    try {
      if (path === 'turning') {
        rotational = this.stock.subtractTurning(volume, this.testCell);
        if (rotational) this.rotationalFastPathSubtractions++;
      } else this.stock.subtract(volume, this.testCell);
    } finally {
      this.observation.active = false;
      if (this.activeOperation) {
        this.activeOperation.elapsedMs += performance.now() - started;
        this.activeOperation.rotationalFastPath ||= rotational;
        const usedPath = rotational ? 'rotational' : path === 'indexed-ball' ? path : 'adaptive';
        if (!this.operationHasSubtraction || this.activeOperation.fastPath === usedPath)
          this.activeOperation.fastPath = usedPath;
        else if (this.activeOperation.fastPath !== 'mixed') this.activeOperation.fastPath = 'mixed';
        this.operationHasSubtraction = true;
      }
    }
  }

  constructor(private readonly input: DeepReadonly<SimulationInput>, restoredStock?: StockModel) {
    if (input.algorithmVersion !== 2)
      throw new Error('Unsupported material removal algorithm version');
    const workpiece = restoredStock
      ? { stock: restoredStock, stockToWorkpiece: stockPlacement(input.stock, input.binding) }
      : new WorkpieceFactory().create(input);
    this.stock = workpiece.stock;
    this.stockToWorkpiece = workpiece.stockToWorkpiece;
    this.workpieceToStock = this.stockToWorkpiece.clone().invert();
    this.spindleOrigin = new THREE.Vector3(...input.binding.spindleOrigin).applyMatrix4(
      this.workpieceToStock,
    );
    this.spindleAxis = new THREE.Vector3(...input.binding.spindleAxis).transformDirection(
      this.workpieceToStock,
    );
  }

  forkForReplay(): MaterialRemovalEngine {
    if (this.operationDiagnostics.length)
      throw new Error('Replay checkpoints require replay-only operation execution');
    const copy = new MaterialRemovalEngine(this.input, this.stock.fork());
    copy.cellTests = this.cellTests;
    copy.samples = this.samples;
    copy.indexedBatches = this.indexedBatches;
    copy.indexedPrimitiveTests = this.indexedPrimitiveTests;
    copy.indexedBoundTests = this.indexedBoundTests;
    copy.observation.fields = this.observation.fields;
    copy.observation.normals = this.observation.normals;
    copy.rotationalFastPathSubtractions = this.rotationalFastPathSubtractions;
    return copy;
  }

  private testCell = (): void => {
    if (++this.cellTests > SIMULATION_LIMITS.cellTests) {
      throw new Error(
        'Removal cell-test budget exceeded; use a coarser resolution or a smaller program',
      );
    }
  };

  private poseMatrix(position: THREE.Vector3, orientation: THREE.Quaternion): THREE.Matrix4 {
    return this.workpieceToStock
      .clone()
      .multiply(new THREE.Matrix4().compose(position, orientation, new THREE.Vector3(1, 1, 1)));
  }

  applyMotion(
    motion: DeepReadonly<RemovalMotion>,
    acceptBallSweep?: (sweep: ImplicitVolume) => void,
  ): void {
    if (
      [motion.start, motion.end].some(
        (pose) =>
          pose.position.length !== 3 ||
          !pose.position.every(Number.isFinite) ||
          pose.orientation.length !== 4 ||
          !pose.orientation.every(Number.isFinite) ||
          Math.abs(Math.hypot(...pose.orientation) - 1) > 1e-6,
      )
    ) {
      throw new Error('Cutting poses must contain finite positions and unit quaternions');
    }
    if (motion.mode !== 'turning' && motion.mode !== 'milling')
      throw new Error('Unknown machining mode');
    if (
      motion.start.frameId !== this.input.binding.frameId ||
      motion.end.frameId !== this.input.binding.frameId
    ) {
      throw new Error('Cutting pose is not in the explicitly bound stock frame');
    }
    const key = JSON.stringify([motion.tool, motion.executedQ]);
    let cutter = this.cutters.get(key);
    if (!cutter) {
      cutter = new CuttingToolModel(motion.tool, motion.executedQ);
      this.cutters.set(key, cutter);
    }
    const start = new THREE.Vector3(...motion.start.position);
    const end = new THREE.Vector3(...motion.end.position);
    const qStart = new THREE.Quaternion(...motion.start.orientation).normalize();
    const qEnd = new THREE.Quaternion(...motion.end.orientation).normalize();
    if (qStart.dot(qEnd) < 0) qEnd.set(-qEnd.x, -qEnd.y, -qEnd.z, -qEnd.w);
    const angle =
      4 *
      Math.atan2(
        Math.hypot(qStart.x - qEnd.x, qStart.y - qEnd.y, qStart.z - qEnd.z, qStart.w - qEnd.w),
        Math.hypot(qStart.x + qEnd.x, qStart.y + qEnd.y, qStart.z + qEnd.z, qStart.w + qEnd.w),
      );
    if (motion.mode === 'turning') {
      if (angle > 1e-6)
        throw new Error('Changing insert orientation during turning is not supported');
    } else if (cutter.part.type === 'insert') {
      throw new Error('Insert milling is not supported');
    }
    const divisions = Math.max(
      1,
      Math.ceil(
        (start.distanceTo(end) + angle * cutter.sweepRadius) / (this.stock.resolutionMm / 3),
      ),
    );
    if (motion.mode === 'turning') {
      if (this.samples + 1 > SIMULATION_LIMITS.samples)
        throw new Error('Removal sampling budget exceeded');
      const sweep = this.observedVolume(
        buildTurningSweep(
          cutter,
          this.poseMatrix(start, qStart),
          this.poseMatrix(end, qEnd),
          this.spindleOrigin,
          this.spindleAxis,
        ),
      );
      this.samples++;
      this.subtract(sweep, 'turning');
      return;
    }
    if (motion.mode === 'milling' && angle < 1e-9) {
      const sweep = cutter.translationSweep(
        this.poseMatrix(start, qStart),
        this.poseMatrix(end, qEnd),
      );
      if (sweep) {
        if (this.samples + 1 > SIMULATION_LIMITS.samples)
          throw new Error('Removal sampling budget exceeded');
        this.samples++;
        const observed = this.observedVolume(sweep);
        if (acceptBallSweep && observed.ballBounds) acceptBallSweep(observed);
        else this.subtract(observed);
        return;
      }
    }
    if (this.samples + divisions + 1 > SIMULATION_LIMITS.samples) {
      throw new Error(
        'Removal sampling budget exceeded; use a coarser resolution or a smaller program',
      );
    }
    const position = new THREE.Vector3();
    const orientation = new THREE.Quaternion();
    for (let step = 0; step <= divisions; step++) {
      this.samples++;
      position.copy(start).lerp(end, step / divisions);
      orientation.copy(qStart).slerp(qEnd, step / divisions);
      const matrix = this.poseMatrix(position, orientation);
      this.subtract(this.observedVolume(cutter.volume(matrix)));
    }
  }

  applyBatches(
    batches: readonly RemovalBatch[],
    progress: (processed: number) => void = () => {},
    indexed = true,
    profileOperations = true,
    retainOperation = false,
    motionOffset = 0,
  ): void {
    let pending: ImplicitVolume[] = [];
    let pendingKey: string | undefined;
    let pendingEnd = -1;
    let processed = 0;
    let operationKey = profileOperations ? this.operationKey : undefined;
    let before = profileOperations ? this.operationBefore : undefined;
    const finishOperation = (): void => {
      const operation = this.activeOperation;
      if (!operation || !before) return;
      const after = this.snapshot();
      operation.fieldEvaluations = after.fieldEvaluations - before.fieldEvaluations;
      operation.normalEvaluations = after.normalEvaluations - before.normalEvaluations;
      operation.cellTests = after.cellTests - before.cellTests;
      operation.materialDistanceTests = counterDelta(
        after.materialDistanceTests,
        before.materialDistanceTests,
      );
      operation.materialNormalTests = counterDelta(
        after.materialNormalTests,
        before.materialNormalTests,
      );
      operation.materialPrimitiveTests = counterDelta(
        after.materialPrimitiveTests,
        before.materialPrimitiveTests,
      );
      operation.regionTests = after.regionTests - before.regionTests;
      operation.samples = after.samples - before.samples;
      operation.removedCells = after.removedCells - before.removedCells;
      operation.boundaryCellsAfter = after.boundaryCells;
      operation.boundaryCellsDelta = after.boundaryCells - before.boundaryCells;
      operation.allocatedNodesAfter = after.allocatedNodes;
      operation.allocatedNodesDelta = after.allocatedNodes - before.allocatedNodes;
      operation.stockBytesAfter = after.stockBytes;
      operation.rotationalFastPathSubtractions =
        after.rotationalFastPathSubtractions - before.rotationalFastPathSubtractions;
      operation.rotationalProfileUpdates =
        after.rotationalProfileUpdates - before.rotationalProfileUpdates;
      operation.indexedBatches = after.indexedBatches - before.indexedBatches;
      operation.indexedPrimitiveTests = after.indexedPrimitiveTests - before.indexedPrimitiveTests;
      operation.indexedBoundTests = after.indexedBoundTests - before.indexedBoundTests;
      this.operationDiagnostics.push(operation);
      this.activeOperation = undefined;
    };
    const advance = (end: number): void => {
      while (processed <= end) progress(++processed);
    };
    const flush = (): void => {
      if (pending.length === 1) this.subtract(pending[0]);
      else if (pending.length > 1) {
        const batch = new IndexedBallSweeps(pending, this.testCell, () => {
          if (++this.indexedBoundTests > SIMULATION_LIMITS.cellTests * 8)
            throw new Error('Indexed sweep traversal budget exceeded; use a smaller program');
        });
        this.subtract(batch.volume, 'indexed-ball');
        this.indexedBatches++;
        this.indexedPrimitiveTests += batch.primitiveTests;
      }
      if (pending.length) advance(pendingEnd);
      pending = [];
      pendingKey = undefined;
    };
    const key = (motion: DeepReadonly<RemovalMotion>): string | undefined => {
      if (
        !indexed ||
        motion.mode !== 'milling' ||
        motion.tool.cutting?.length !== 1 ||
        motion.tool.cutting[0].type !== 'ballMill' ||
        motion.start.frameId !== motion.end.frameId ||
        motion.start.reference !== motion.end.reference ||
        !motion.start.orientation.every(Number.isFinite) ||
        !motion.end.orientation.every(Number.isFinite)
      )
        return undefined;
      const start = new THREE.Quaternion(...motion.start.orientation).normalize();
      const end = new THREE.Quaternion(...motion.end.orientation).normalize();
      if (start.dot(end) < 0) end.set(-end.x, -end.y, -end.z, -end.w);
      if (!start.equals(end)) return undefined;
      if (
        start.w < 0 ||
        (start.w === 0 &&
          (start.x < 0 || (start.x === 0 && (start.y < 0 || (start.y === 0 && start.z < 0)))))
      )
        start.set(-start.x, -start.y, -start.z, -start.w);
      return JSON.stringify([
        motion.tool,
        motion.executedQ,
        motion.start.frameId,
        motion.start.reference,
        start.toArray(),
      ]);
    };
    for (const batch of batches) {
      const motion = batch.motion;
      const nextOperationKey = JSON.stringify([
        motion.mode,
        motion.tool,
        motion.executedQ,
        motion.start.frameId,
        motion.start.reference,
        motion.end.frameId,
        motion.end.reference,
      ]);
      if (profileOperations && operationKey !== nextOperationKey) {
        flush();
        finishOperation();
        before = this.snapshot();
        this.stock.reserveDiagnosticBytes(OPERATION_DIAGNOSTIC_BYTES + nextOperationKey.length * 2);
        operationKey = nextOperationKey;
        this.operationHasSubtraction = false;
        this.activeOperation = {
          operationIndex: this.operationDiagnostics.length,
          mode: motion.mode,
          tool: motion.tool,
          executedQ: motion.executedQ,
          frameId: motion.start.frameId,
          reference: motion.start.reference,
          endFrameId: motion.end.frameId,
          endReference: motion.end.reference,
          firstMotionIndex: batch.startIndex + motionOffset,
          lastMotionIndex: batch.endIndex + motionOffset,
          motionCount: 0,
          motions: [],
          elapsedMs: 0,
          fieldEvaluations: 0,
          normalEvaluations: 0,
          cellTests: 0,
          regionTests: 0,
          samples: 0,
          removedCells: 0,
          boundaryCellsBefore: before.boundaryCells,
          boundaryCellsAfter: before.boundaryCells,
          boundaryCellsDelta: 0,
          allocatedNodesBefore: before.allocatedNodes,
          allocatedNodesAfter: before.allocatedNodes,
          allocatedNodesDelta: 0,
          stockBytesBefore: before.stockBytes,
          stockBytesAfter: before.stockBytes,
          fastPath: 'adaptive',
          rotationalFastPath: false,
          rotationalFastPathSubtractions: 0,
          rotationalProfileUpdates: 0,
          indexedBatches: 0,
          indexedPrimitiveTests: 0,
          indexedBoundTests: 0,
        };
      }
      if (profileOperations) {
        const operation = this.activeOperation!;
        this.stock.reserveDiagnosticBytes(
          (batch.endIndex - batch.startIndex + 1) * MOTION_DIAGNOSTIC_BYTES,
        );
        operation.lastMotionIndex = batch.endIndex + motionOffset;
        for (let index = batch.startIndex; index <= batch.endIndex; index++) {
          const source = batch.sourceMotions[index];
          operation.motions.push({
            motionIndex: index + motionOffset,
            executionStep: source.executionStep,
            lineNumber: source.lineNumber,
          });
          operation.motionCount++;
        }
      }
      const currentKey = key(batch.motion);
      if (
        currentKey === undefined ||
        currentKey !== pendingKey ||
        pending.length === MAX_INDEXED_SWEEPS
      )
        flush();
      if (currentKey === undefined) {
        this.applyMotion(batch.motion);
        advance(batch.endIndex);
      } else {
        this.applyMotion(batch.motion, (sweep) => {
          if (pending.length && !pending[0].ballBounds!.frame.equals(sweep.ballBounds!.frame))
            flush();
          const certificate = sweep.sweepCoverage;
          const covered =
            certificate &&
            pending.some((previous) => {
              const interval = previous.sweepCoverage;
              return (
                interval?.key === certificate.key &&
                interval.lower <= certificate.lower &&
                interval.upper >= certificate.upper
              );
            });
          if (!covered) pending.push(sweep);
          pendingKey = currentKey;
          pendingEnd = batch.endIndex;
        });
      }
    }
    flush();
    if (!retainOperation) finishOperation();
    this.operationKey = retainOperation ? operationKey : undefined;
    this.operationBefore = retainOperation ? before : undefined;
  }

  private snapshot() {
    return {
      ...materialCounters(this.stock),
      fieldEvaluations: this.fieldEvaluations,
      normalEvaluations: this.normalEvaluations,
      cellTests: this.cellTests,
      samples: this.samples,
      regionTests: this.stock.regionTests,
      removedCells: this.stock.removedCells,
      boundaryCells: this.stock.boundaryCells,
      allocatedNodes: this.stock.allocatedNodes,
      stockBytes: this.stock.allocatedBytes,
      rotationalFastPathSubtractions: this.rotationalFastPathSubtractions,
      rotationalProfileUpdates: this.stock.rotationalProfileUpdates,
      indexedBatches: this.indexedBatches,
      indexedPrimitiveTests: this.indexedPrimitiveTests,
      indexedBoundTests: this.indexedBoundTests,
    };
  }
}

export function simulateMaterialRemoval(
  input: DeepReadonly<SimulationInput>,
  progress: (processed: number, total: number) => void = () => {},
): SimulationResult {
  const started = performance.now();
  const engine = new MaterialRemovalEngine(input);
  const initialMaterialCounters = materialCounters(engine.stock);
  progress(0, input.motions.length);
  engine.applyBatches(batchRemovalMotions(input.motions), (processed) =>
    progress(processed, input.motions.length),
  );
  const subtractionMs = performance.now() - started;
  const afterSubtractionMaterialCounters = materialCounters(engine.stock);
  const builder = new StockMeshBuilder();
  const meshingStarted = performance.now();
  builder.buildChanged(engine.stock);
  const chunks = builder.getChunks();
  const meshingMs = performance.now() - meshingStarted;
  const finalMaterialCounters = materialCounters(engine.stock);
  return createMaterialRemovalResult(input, engine, builder, chunks, started, subtractionMs,
    meshingMs, initialMaterialCounters, afterSubtractionMaterialCounters, finalMaterialCounters);
}

export function createMaterialRemovalResult(
  input: DeepReadonly<SimulationInput>, engine: MaterialRemovalEngine, builder: StockMeshBuilder,
  chunks: SimulationResult['chunks'], started: number, subtractionMs: number, meshingMs: number,
  initialMaterialCounters: ReturnType<typeof materialCounters>,
  afterSubtractionMaterialCounters: ReturnType<typeof materialCounters>,
  finalMaterialCounters = materialCounters(engine.stock),
): SimulationResult {
  const meshingDiagnostics = builder.chunkDiagnostics;
  const meshingTotals = meshingDiagnostics.reduce(
    (totals, chunk) => {
      totals.meshedCells += chunk.cells;
      totals.analyticalPanels += chunk.analyticalPanels;
      totals.fineTriangles += chunk.fineTriangles;
      totals.outputTriangles += chunk.outputTriangles;
      totals.triangulationMs += chunk.triangulationMs;
      totals.adaptationMs += chunk.adaptationMs;
      return totals;
    },
    {
      meshedCells: 0,
      analyticalPanels: 0,
      fineTriangles: 0,
      outputTriangles: 0,
      triangulationMs: 0,
      adaptationMs: 0,
    },
  );
  return {
    algorithmVersion: 2,
    status: input.stop ? 'stopped' : 'completed',
    stop: input.stop,
    chunks,
    stockToWorkpiece: engine.stockToWorkpiece.toArray(),
    resolutionMm: input.resolutionMm,
    processedMotions: input.motions.length,
    removedCells: engine.stock.removedCells,
    remainingCells: engine.stock.remainingCells,
    allocatedStockBytes: engine.stock.allocatedBytes,
    peakStockBytes: engine.stock.peakAllocatedBytes,
    surfaceBytes: chunks.reduce(
      (bytes, chunk) => bytes + chunk.positions.byteLength + chunk.normals.byteLength,
      0,
    ),
    cellTests: engine.cellTests,
    samples: engine.samples,
    elapsedMs: performance.now() - started,
    boundaryCells: engine.stock.boundaryCells,
    allocatedNodes: engine.stock.allocatedNodes,
    regionTests: engine.stock.regionTests,
    bulkRemovedRegions: engine.stock.bulkRemovedRegions,
    subtractionMs,
    meshingMs,
    meshingAttribution: 'final-only',
    operationDiagnostics: engine.operationDiagnostics,
    meshingDiagnostics,
    extractionMs: builder.extractionMs,
    ...meshingTotals,
    ...finalMaterialCounters,
    subtractionMaterialDistanceTests: counterDelta(
      afterSubtractionMaterialCounters.materialDistanceTests,
      initialMaterialCounters.materialDistanceTests,
    ),
    subtractionMaterialNormalTests: counterDelta(
      afterSubtractionMaterialCounters.materialNormalTests,
      initialMaterialCounters.materialNormalTests,
    ),
    subtractionMaterialPrimitiveTests: counterDelta(
      afterSubtractionMaterialCounters.materialPrimitiveTests,
      initialMaterialCounters.materialPrimitiveTests,
    ),
    meshingMaterialDistanceTests: counterDelta(
      finalMaterialCounters.materialDistanceTests,
      afterSubtractionMaterialCounters.materialDistanceTests,
    ),
    meshingMaterialNormalTests: counterDelta(
      finalMaterialCounters.materialNormalTests,
      afterSubtractionMaterialCounters.materialNormalTests,
    ),
    meshingMaterialPrimitiveTests: counterDelta(
      finalMaterialCounters.materialPrimitiveTests,
      afterSubtractionMaterialCounters.materialPrimitiveTests,
    ),
    rotationalFastPathSubtractions: engine.rotationalFastPathSubtractions,
    rotationalProfileUpdates: engine.stock.rotationalProfileUpdates,
    indexedBatches: engine.indexedBatches,
    indexedPrimitiveTests: engine.indexedPrimitiveTests,
    indexedBoundTests: engine.indexedBoundTests,
    surfaceToleranceMm: input.resolutionMm * 0.1,
    surfaceAdaptationSkippedChunks: builder.skippedChunks,
    peakSurfaceIntersectionCacheEntries: builder.peakIntersectionCacheEntries,
    peakSubtractionCornerCacheEntries: engine.stock.peakCornerCacheEntries,
  };
}
