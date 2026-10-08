import type { PoseSample } from '@core/types';
import type { StockChunkMeshDiagnostics } from './StockMeshBuilder';
import type {
  DeepReadonly,
  ProgramMaterialDefinition,
  ProgramToolDefinition,
  Vector3,
} from '../tools/SimulationMetadata';

export interface StockBinding {
  frameId: string;
  /** Explicit initial program-coordinate to workpiece-frame transform. */
  position: Vector3;
  rotation: Vector3;
  spindleOrigin: Vector3;
  spindleAxis: Vector3;
}

export interface RemovalMotion {
  mode: 'turning' | 'milling';
  start: PoseSample;
  end: PoseSample;
  tool: DeepReadonly<ProgramToolDefinition>;
  executedQ?: number;
  executionStep: number;
  lineNumber?: number;
}

export interface RemovalStop {
  message: string;
  executionStep?: number;
  lineNumber?: number;
}

export interface SimulationInput {
  algorithmVersion: 2;
  stock: DeepReadonly<ProgramMaterialDefinition>;
  binding: DeepReadonly<StockBinding>;
  resolutionMm: number;
  motions: RemovalMotion[];
  stop?: RemovalStop;
  /** Defaults to true; false forces the regular 3D stock for controlled comparisons. */
  rotationalProfile?: boolean;
}

export const SIMULATION_LIMITS = Object.freeze({
  cells: 16_000_000,
  stockBytes: 256 * 1024 * 1024,
  surfaceFaces: 1_200_000,
  samples: 400_000,
  cellTests: 500_000_000,
  chunkSize: 16,
});

export class SimulationCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulationCapabilityError';
  }
}

export interface StockSurfaceChunk {
  id: number;
  positions: Float32Array;
  normals: Float32Array;
}

export interface RemovalOperationMotion {
  motionIndex: number;
  executionStep: number;
  lineNumber?: number;
}

/** One contiguous executed cutting operation, independent of geometric batching. */
export interface RemovalOperationDiagnostic {
  operationIndex: number;
  mode: RemovalMotion['mode'];
  tool: DeepReadonly<ProgramToolDefinition>;
  executedQ?: number;
  frameId: PoseSample['frameId'];
  reference: PoseSample['reference'];
  endFrameId: PoseSample['frameId'];
  endReference: PoseSample['reference'];
  firstMotionIndex: number;
  lastMotionIndex: number;
  motionCount: number;
  motions: RemovalOperationMotion[];
  /** Measured time inside stock subtraction only; excludes tool setup and final meshing. */
  elapsedMs: number;
  /** Observed cutter-volume distance calls, including retained cuts invoked during subtraction. */
  fieldEvaluations: number;
  /** Observed cutter-volume normal calls; excludes final meshing. */
  normalEvaluations: number;
  /** Budget callback invocations, including profile internal work, normals and BVH dispatch. */
  cellTests: number;
  /** Instrumented stock material-field calls, including initial material and retained cuts. */
  materialDistanceTests?: number;
  materialNormalTests?: number;
  materialPrimitiveTests?: number;
  regionTests: number;
  samples: number;
  removedCells: number;
  boundaryCellsBefore: number;
  boundaryCellsAfter: number;
  boundaryCellsDelta: number;
  allocatedNodesBefore: number;
  allocatedNodesAfter: number;
  allocatedNodesDelta: number;
  /** Conservative stock-memory estimates including reserved diagnostics, not process heap. */
  stockBytesBefore: number;
  stockBytesAfter: number;
  fastPath: 'adaptive' | 'rotational' | 'indexed-ball' | 'mixed';
  rotationalFastPath: boolean;
  rotationalFastPathSubtractions: number;
  rotationalProfileUpdates: number;
  indexedBatches: number;
  indexedPrimitiveTests: number;
  indexedBoundTests: number;
}

export interface SimulationResult {
  algorithmVersion: 2;
  status: 'completed' | 'stopped';
  stop?: RemovalStop;
  chunks: StockSurfaceChunk[];
  stockToWorkpiece: number[];
  resolutionMm: number;
  processedMotions: number;
  removedCells: number;
  remainingCells: number;
  allocatedStockBytes: number;
  peakStockBytes: number;
  surfaceBytes: number;
  cellTests: number;
  samples: number;
  elapsedMs: number;
  boundaryCells: number;
  allocatedNodes: number;
  regionTests: number;
  bulkRemovedRegions: number;
  subtractionMs?: number;
  meshingMs?: number;
  indexedBatches?: number;
  indexedPrimitiveTests?: number;
  indexedBoundTests?: number;
  surfaceToleranceMm?: number;
  surfaceAdaptationSkippedChunks?: number;
  peakSurfaceIntersectionCacheEntries?: number;
  peakSubtractionCornerCacheEntries?: number;
  operationDiagnostics?: RemovalOperationDiagnostic[];
  /** meshingMs is a single final build, never apportioned to cutting operations. */
  meshingAttribution?: 'final-only';
  rotationalFastPathSubtractions?: number;
  rotationalProfileUpdates?: number;
  /** Actual final-build chunk records; never attributed or divided among cutting operations. */
  meshingDiagnostics?: readonly StockChunkMeshDiagnostics[];
  extractionMs?: number;
  triangulationMs?: number;
  adaptationMs?: number;
  meshedCells?: number;
  analyticalPanels?: number;
  fineTriangles?: number;
  outputTriangles?: number;
  /** Cumulative instrumented material-field calls, including initialization and final mesh. */
  materialDistanceTests?: number;
  materialNormalTests?: number;
  materialPrimitiveTests?: number;
  subtractionMaterialDistanceTests?: number;
  subtractionMaterialNormalTests?: number;
  subtractionMaterialPrimitiveTests?: number;
  meshingMaterialDistanceTests?: number;
  meshingMaterialNormalTests?: number;
  meshingMaterialPrimitiveTests?: number;
}

export type SimulationWorkerMessage =
  | { type: 'progress'; processed: number; total: number }
  | { type: 'result'; result: SimulationResult }
  | { type: 'error'; message: string };
