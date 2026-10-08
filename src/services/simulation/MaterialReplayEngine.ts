import type { DeepReadonly } from '../tools/SimulationMetadata';
import { batchRemovalMotions, MaterialRemovalEngine } from './MaterialRemovalEngine';
import { StockMeshBuilder } from './StockMeshBuilder';
import {
  SIMULATION_LIMITS,
  type RemovalStop,
  type SimulationInput,
  type StockSurfaceChunk,
} from './SimulationTypes';

export const REPLAY_LIMITS = Object.freeze({
  checkpointBytes: 64 * 1024 * 1024,
  checkpoints: 4,
  checkpointInterval: 32,
});

export interface ReplayFrame {
  position: number;
  requestedPosition: number;
  total: number;
  executionStep?: number;
  replace: boolean;
  chunks: StockSurfaceChunk[];
  stockToWorkpiece: number[];
  processedMotions: number;
  removedCells: number;
  remainingCells: number;
  stop?: RemovalStop;
  elapsedMs: number;
  subtractionMs: number;
  meshingMs: number;
  checkpointMs?: number;
  appliedMotions: number;
  restoredPosition?: number;
  checkpointCount: number;
  checkpointBytes: number;
  skippedCheckpoints: number;
  evictedCheckpoints: number;
  peakStockBytes: number;
}

export interface ReplayOptions {
  checkpointBytes: number;
  checkpoints: number;
  checkpointInterval: number;
}

interface Checkpoint {
  position: number;
  motionCount: number;
  engine: MaterialRemovalEngine;
}

/** A position is the number of completed executed occurrences; zero is raw stock. */
export class MaterialReplayEngine {
  private engine: MaterialRemovalEngine;
  private builder = new StockMeshBuilder();
  private readonly motionEnds: number[] = [0];
  private readonly checkpoints: Checkpoint[] = [];
  private position = 0;
  private motionCount = 0;
  private lastCheckpointMotion = 0;
  private skippedCheckpoints = 0;
  private evictedCheckpoints = 0;
  private initializedSurface = false;
  private readonly safePosition: number;
  private readonly options: ReplayOptions;
  private readonly timelineBytes: number;

  constructor(
    private readonly input: DeepReadonly<SimulationInput>,
    private readonly steps: readonly number[],
    options: Partial<ReplayOptions> = {},
  ) {
    this.options = { ...REPLAY_LIMITS, ...options };
    this.timelineBytes = 2048 + steps.length * 24 + input.motions.length * 8;
    if (
      !Number.isSafeInteger(this.timelineBytes) ||
      this.timelineBytes > SIMULATION_LIMITS.stockBytes
    )
      throw new Error('Replay timeline exceeds the stock/workspace memory budget');
    for (const [name, value] of Object.entries(this.options)) {
      if (!Number.isSafeInteger(value) || value < (name === 'checkpointInterval' ? 1 : 0))
        throw new Error(`Invalid replay ${name}`);
    }
    if (
      this.options.checkpointBytes > REPLAY_LIMITS.checkpointBytes ||
      this.options.checkpoints > REPLAY_LIMITS.checkpoints
    )
      throw new Error('Replay history exceeds the supported memory bounds');
    let previous = -1;
    for (const step of steps) {
      if (!Number.isSafeInteger(step) || step <= previous)
        throw new Error('Replay steps must be strictly increasing nonnegative integers');
      previous = step;
    }
    const known = new Set(steps);
    previous = -1;
    for (const motion of input.motions) {
      if (!known.has(motion.executionStep) || motion.executionStep < previous)
        throw new Error('Removal motion is absent from the ordered replay timeline');
      previous = motion.executionStep;
    }
    let index = 0;
    for (const step of steps) {
      while (index < input.motions.length && input.motions[index].executionStep <= step) index++;
      this.motionEnds.push(index);
    }
    const stopStep = input.stop?.executionStep;
    if (stopStep !== undefined && (!Number.isSafeInteger(stopStep) || stopStep < 0))
      throw new Error('Invalid replay stop execution occurrence');
    this.safePosition = input.stop
      ? stopStep !== undefined
        ? steps.filter((step) => step < stopStep).length
        : input.motions.length
          ? steps.filter((step) => step <= input.motions[input.motions.length - 1].executionStep)
              .length
          : 0
      : steps.length;
    this.engine = new MaterialRemovalEngine(input);
    this.engine.stock.setReplayWorkspaceBytes(this.timelineBytes);
    this.attachMemoryPressure();
  }

  private attachMemoryPressure(): void {
    this.engine.stock.releaseReplayHistory = (required) => {
      let released = 0;
      while (this.checkpoints.length && released < required) {
        const checkpoint = this.checkpoints.shift()!;
        released += checkpoint.engine.stock.allocatedBytes + 256;
        this.evictedCheckpoints++;
      }
      return released;
    };
  }

  private get historyBytes(): number {
    return this.checkpoints.reduce(
      (sum, checkpoint) => sum + checkpoint.engine.stock.allocatedBytes + 256,
      0,
    );
  }

  private get surfaceBytes(): number {
    return (
      this.builder.chunkDiagnostics.length * 256 +
      this.builder
        .getChunks()
        .reduce(
          (sum, chunk) => sum + chunk.positions.byteLength + chunk.normals.byteLength + 128,
          0,
        )
    );
  }

  private reserveWorkspace(extra: number, includeSurface: boolean, retainExtra = false): void {
    const stock = this.engine.stock;
    stock.setReplayWorkspaceBytes(0);
    const surface = includeSurface ? this.surfaceBytes : 0;
    while (
      this.checkpoints.length &&
      !stock.canAccountSurfaceWorkspace(this.timelineBytes + this.historyBytes + surface + extra)
    ) {
      this.checkpoints.shift();
      this.evictedCheckpoints++;
    }
    stock.setReplayWorkspaceBytes(
      this.timelineBytes + this.historyBytes + surface + (retainExtra ? extra : 0),
    );
    stock.accountSurfaceWorkspace(retainExtra ? 0 : extra);
  }

  private applyPrefix(end: number, progress: (processed: number) => void): number {
    const sliceBytes = (end - this.motionCount) * 8;
    this.reserveWorkspace(sliceBytes, true, true);
    const motions = this.input.motions.slice(this.motionCount, end);
    const batches = batchRemovalMotions(motions, (bytes) =>
      this.reserveWorkspace(sliceBytes + bytes, true, true),
    );
    const started = performance.now();
    this.engine.applyBatches(batches, progress, true, false);
    return performance.now() - started;
  }

  private saveCheckpoint(): void {
    if (
      !this.options.checkpoints ||
      !this.options.checkpointBytes ||
      this.motionCount === this.lastCheckpointMotion
    )
      return;
    const stock = this.engine.stock;
    const bytes = stock.allocatedBytes + 256;
    if (bytes > this.options.checkpointBytes) {
      this.skippedCheckpoints++;
      this.lastCheckpointMotion = this.motionCount;
      return;
    }
    while (
      this.checkpoints.length &&
      (this.checkpoints.length >= this.options.checkpoints ||
        this.historyBytes + bytes > this.options.checkpointBytes)
    ) {
      this.checkpoints.shift();
      this.evictedCheckpoints++;
    }
    stock.setReplayWorkspaceBytes(0);
    if (
      !stock.canAccountSurfaceWorkspace(
        this.timelineBytes +
          this.historyBytes +
          this.surfaceBytes +
          stock.checkpointWorkspaceBytes +
          256,
      )
    ) {
      this.skippedCheckpoints++;
      this.lastCheckpointMotion = this.motionCount;
      return;
    }
    this.reserveWorkspace(stock.checkpointWorkspaceBytes + 256, true);
    this.checkpoints.push({
      position: this.position,
      motionCount: this.motionCount,
      engine: this.engine.forkForReplay(),
    });
    this.lastCheckpointMotion = this.motionCount;
    this.reserveWorkspace(0, true);
  }

  seek(
    requestedPosition: number,
    forceReplace = false,
    progress: (processed: number, total: number) => void = () => {},
  ): ReplayFrame {
    if (
      !Number.isSafeInteger(requestedPosition) ||
      requestedPosition < 0 ||
      requestedPosition > this.steps.length
    )
      throw new Error('Replay position is outside the executed timeline');
    const started = performance.now();
    const target = Math.min(requestedPosition, this.safePosition);
    let checkpointMs = 0;
    let subtractionMs = 0;
    let replace = forceReplace || !this.initializedSurface;
    let restoredPosition: number | undefined;
    const eligible = this.checkpoints.filter((checkpoint) => checkpoint.position <= target);
    const checkpoint = eligible.reduce<Checkpoint | undefined>(
      (best, entry) => (!best || entry.position > best.position ? entry : best),
      undefined,
    );
    if (target < this.position || (checkpoint && checkpoint.position > this.position)) {
      const restored = performance.now();
      if (checkpoint) {
        this.checkpoints.splice(this.checkpoints.indexOf(checkpoint), 1);
        this.engine = checkpoint.engine;
        this.position = checkpoint.position;
        this.motionCount = checkpoint.motionCount;
      } else {
        this.engine = new MaterialRemovalEngine(this.input);
        this.position = 0;
        this.motionCount = 0;
      }
      this.lastCheckpointMotion = this.motionCount;
      this.builder = new StockMeshBuilder();
      this.attachMemoryPressure();
      restoredPosition = this.position;
      replace = true;
      checkpointMs += performance.now() - restored;
    }
    this.engine.stock.resetQueryCounters();
    const initialMotions = this.motionCount;
    progress(this.motionCount, this.motionEnds[target]);
    while (this.position < target) {
      const next = Math.min(target, this.position + this.options.checkpointInterval);
      const end = this.motionEnds[next];
      subtractionMs += this.applyPrefix(end, (processed) =>
        progress(this.motionCount + processed, this.motionEnds[target]),
      );
      this.motionCount = end;
      this.position = next;
      if (this.motionCount - this.lastCheckpointMotion >= this.options.checkpointInterval) {
        const saved = performance.now();
        this.saveCheckpoint();
        checkpointMs += performance.now() - saved;
      }
    }
    const meshingStarted = performance.now();
    this.reserveWorkspace(0, false);
    const changed =
      !this.initializedSurface || replace || this.engine.stock.dirtyChunks.size
        ? this.builder.buildChanged(this.engine.stock)
        : [];
    this.initializedSurface = true;
    const meshingMs = performance.now() - meshingStarted;
    const source = replace ? this.builder.getChunks() : changed;
    const transferBytes = source.reduce(
      (sum, chunk) => sum + chunk.positions.byteLength + chunk.normals.byteLength + 128,
      0,
    );
    this.reserveWorkspace(transferBytes, true);
    // Transfer copies: detaching the builder's buffers would corrupt the next incremental build.
    const chunks = source.map((chunk) => ({
      id: chunk.id,
      positions: chunk.positions.slice(),
      normals: chunk.normals.slice(),
    }));
    progress(this.motionCount, this.motionEnds[target]);
    return {
      position: this.position,
      requestedPosition,
      total: this.steps.length,
      executionStep: this.position ? this.steps[this.position - 1] : undefined,
      replace,
      chunks,
      stockToWorkpiece: this.engine.stockToWorkpiece.toArray(),
      processedMotions: this.motionCount,
      removedCells: this.engine.stock.removedCells,
      remainingCells: this.engine.stock.remainingCells,
      stop:
        requestedPosition > this.safePosition || this.position === this.steps.length
          ? this.input.stop
          : undefined,
      elapsedMs: performance.now() - started,
      subtractionMs,
      meshingMs,
      checkpointMs,
      appliedMotions: this.motionCount - initialMotions,
      restoredPosition,
      checkpointCount: this.checkpoints.length,
      checkpointBytes: this.historyBytes,
      skippedCheckpoints: this.skippedCheckpoints,
      evictedCheckpoints: this.evictedCheckpoints,
      peakStockBytes: this.engine.stock.peakAllocatedBytes,
    };
  }
}

export type ReplayWorkerRequest =
  | { type: 'initialize'; requestId: number; input: DeepReadonly<SimulationInput>; steps: number[] }
  | { type: 'seek'; requestId: number; position: number; forceReplace: boolean };

export type ReplayWorkerResponse =
  | { type: 'progress'; requestId: number; processed: number; total: number }
  | { type: 'frame'; requestId: number; frame: ReplayFrame }
  | { type: 'error'; requestId: number; message: string };
