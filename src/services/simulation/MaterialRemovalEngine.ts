import * as THREE from 'three';
import { CuttingToolModel } from './CuttingToolModel';
import { buildTurningSweep } from './TurningEnvelope';
import { WorkpieceFactory } from './WorkpieceFactory';
import { StockMeshBuilder } from './StockMeshBuilder';
import {
  SIMULATION_LIMITS,
  type RemovalMotion,
  type SimulationInput,
  type SimulationResult,
} from './SimulationTypes';
import type { StockModel } from './StockModel';
import type { DeepReadonly } from '../tools/SimulationMetadata';
import { rotationQuaternion } from './SimulationTransforms';
import { IndexedBallSweeps, MAX_INDEXED_SWEEPS } from './IndexedBallSweeps';
import type { ImplicitVolume } from './ImplicitGeometry';

interface RemovalBatch {
  motion: DeepReadonly<RemovalMotion>;
  endIndex: number;
}

export function batchRemovalMotions(motions: DeepReadonly<RemovalMotion[]>): RemovalBatch[] {
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
    const previous = result[result.length - 1];
    if (previous && compatible(previous.motion, motion))
      result[result.length - 1] = {
        motion: { ...previous.motion, end: motion.end },
        endIndex: index,
      };
    else result.push({ motion, endIndex: index });
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

  constructor(private readonly input: DeepReadonly<SimulationInput>) {
    if (input.algorithmVersion !== 2)
      throw new Error('Unsupported material removal algorithm version');
    const workpiece = new WorkpieceFactory().create(input);
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
      const sweep = buildTurningSweep(
        cutter,
        this.poseMatrix(start, qStart),
        this.poseMatrix(end, qEnd),
        this.spindleOrigin,
        this.spindleAxis,
      );
      this.samples++;
      this.stock.subtract(sweep, this.testCell);
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
        if (acceptBallSweep && sweep.ballBounds) acceptBallSweep(sweep);
        else this.stock.subtract(sweep, this.testCell);
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
      this.stock.subtract(cutter.volume(matrix), this.testCell);
    }
  }

  applyBatches(
    batches: readonly RemovalBatch[],
    progress: (processed: number) => void = () => {},
    indexed = true,
  ): void {
    let pending: ImplicitVolume[] = [];
    let pendingKey: string | undefined;
    let pendingEnd = -1;
    let processed = 0;
    const advance = (end: number): void => {
      while (processed <= end) progress(++processed);
    };
    const flush = (): void => {
      if (pending.length === 1) this.stock.subtract(pending[0], this.testCell);
      else if (pending.length > 1) {
        const batch = new IndexedBallSweeps(pending, this.testCell, () => {
          if (++this.indexedBoundTests > SIMULATION_LIMITS.cellTests * 8)
            throw new Error('Indexed sweep traversal budget exceeded; use a smaller program');
        });
        this.stock.subtract(batch.volume, this.testCell);
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
  }
}

export function simulateMaterialRemoval(
  input: DeepReadonly<SimulationInput>,
  progress: (processed: number, total: number) => void = () => {},
): SimulationResult {
  const started = performance.now();
  const engine = new MaterialRemovalEngine(input);
  progress(0, input.motions.length);
  engine.applyBatches(batchRemovalMotions(input.motions), (processed) =>
    progress(processed, input.motions.length),
  );
  const subtractionMs = performance.now() - started;
  const builder = new StockMeshBuilder();
  builder.buildChanged(engine.stock);
  const chunks = builder.getChunks();
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
    meshingMs: performance.now() - started - subtractionMs,
    indexedBatches: engine.indexedBatches,
    indexedPrimitiveTests: engine.indexedPrimitiveTests,
    indexedBoundTests: engine.indexedBoundTests,
    surfaceToleranceMm: input.resolutionMm * 0.1,
    surfaceAdaptationSkippedChunks: builder.skippedChunks,
    peakSurfaceIntersectionCacheEntries: builder.peakIntersectionCacheEntries,
    peakSubtractionCornerCacheEntries: engine.stock.peakCornerCacheEntries,
  };
}
