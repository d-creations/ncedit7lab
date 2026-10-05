import type { PoseSample } from '@core/types';
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
  algorithmVersion: 1;
  stock: DeepReadonly<ProgramMaterialDefinition>;
  binding: DeepReadonly<StockBinding>;
  resolutionMm: number;
  motions: RemovalMotion[];
  stop?: RemovalStop;
}

export const SIMULATION_LIMITS = Object.freeze({
  cells: 4_000_000,
  stockBytes: 16 * 1024 * 1024,
  surfaceFaces: 200_000,
  samples: 100_000,
  cellTests: 50_000_000,
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

export interface SimulationResult {
  algorithmVersion: 1;
  status: 'completed' | 'stopped';
  stop?: RemovalStop;
  chunks: StockSurfaceChunk[];
  stockToWorkpiece: number[];
  resolutionMm: number;
  processedMotions: number;
  removedCells: number;
  remainingCells: number;
  allocatedStockBytes: number;
  surfaceBytes: number;
  cellTests: number;
  samples: number;
  elapsedMs: number;
}

export type SimulationWorkerMessage =
  | { type: 'progress'; processed: number; total: number }
  | { type: 'result'; result: SimulationResult }
  | { type: 'error'; message: string };
