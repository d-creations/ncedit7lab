import * as THREE from 'three';
import { CuttingToolModel } from './CuttingToolModel';
import { buildTurningEnvelope, buildTurningSweep } from './TurningEnvelope';
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

export class MaterialRemovalEngine {
  readonly stock: StockModel;
  readonly stockToWorkpiece: THREE.Matrix4;
  private readonly workpieceToStock: THREE.Matrix4;
  private readonly spindleOrigin: THREE.Vector3;
  private readonly spindleAxis: THREE.Vector3;
  private readonly cutters = new Map<string, CuttingToolModel>();
  cellTests = 0;
  samples = 0;

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

  private turningEnvelope(cutter: CuttingToolModel, matrix: THREE.Matrix4) {
    return buildTurningEnvelope(cutter, matrix, this.spindleOrigin, this.spindleAxis);
  }

  applyMotion(motion: DeepReadonly<RemovalMotion>): void {
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
    const key = JSON.stringify([
      typeof motion.tool.toolNumber,
      motion.tool.toolNumber,
      motion.executedQ,
    ]);
    let cutter = this.cutters.get(key);
    if (!cutter) {
      cutter = new CuttingToolModel(motion.tool, motion.executedQ);
      this.cutters.set(key, cutter);
    }
    const start = new THREE.Vector3(...motion.start.position);
    const end = new THREE.Vector3(...motion.end.position);
    const qStart = new THREE.Quaternion(...motion.start.orientation);
    const qEnd = new THREE.Quaternion(...motion.end.orientation);
    const angle = qStart.angleTo(qEnd);
    if (motion.mode === 'turning') {
      if (angle > 1e-6)
        throw new Error('Changing insert orientation during turning is not supported');
      this.turningEnvelope(cutter, this.poseMatrix(start, qStart));
      this.turningEnvelope(cutter, this.poseMatrix(end, qEnd));
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
        this.stock.subtract(sweep, this.testCell);
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
}

export function simulateMaterialRemoval(
  input: DeepReadonly<SimulationInput>,
  progress: (processed: number, total: number) => void = () => {},
): SimulationResult {
  const started = performance.now();
  const engine = new MaterialRemovalEngine(input);
  progress(0, input.motions.length);
  input.motions.forEach((motion, index) => {
    engine.applyMotion(motion);
    progress(index + 1, input.motions.length);
  });
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
  };
}
