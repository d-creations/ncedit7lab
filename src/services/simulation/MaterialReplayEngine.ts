import type { DeepReadonly } from '../tools/SimulationMetadata';
import {
  batchRemovalMotions,
  MaterialRemovalEngine,
  createMaterialRemovalResult,
  materialCounters,
} from './MaterialRemovalEngine';
import { StockMeshBuilder } from './StockMeshBuilder';
import type { ReplayTraceStore } from './ReplayTraceStore';
import { ReplaySurfaceCache, REPLAY_SURFACE_BYTES } from './ReplaySurfaceCache';
import {
  SIMULATION_LIMITS,
  type RemovalStop,
  type SimulationInput,
  type StockSurfaceChunk,
  type SimulationResult,
} from './SimulationTypes';

export const REPLAY_LIMITS = Object.freeze({
  checkpointBytes: 64 * 1024 * 1024,
  checkpoints: 4,
  checkpointInterval: 32,
  surfaceCacheBytes: REPLAY_SURFACE_BYTES,
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
  historyMode?: 'partial-disk' | 'checkpoint';
  historyBytes?: number;
  historyMs?: number;
  historyWarning?: string;
  finalResult?: SimulationResult;
  surfaceCacheHit?: boolean;
  surfaceCacheBytes?: number;
  surfaceCacheStates?: number;
  surfaceCacheSkipped?: number;
  surfaceCacheEvictions?: number;
  surfaceCacheClears?: number;
  surfaceCacheMissReason?: 'first-visit' | 'evicted-or-cleared' | 'not-retained' | 'disabled';
  extractionMs?: number;
  triangulationMs?: number;
  adaptationMs?: number;
  dirtyChunks?: number;
  remeshedChunks?: number;
  fineTriangles?: number;
  outputTriangles?: number;
  surfaceReconstructed?: boolean;
  surfaceCacheLimitBytes?: number;
  topologyPasses?: number;
  topologyReused?: boolean;
  topologyCachePeakBytes?: number;
}

export interface ReplayOptions {
  checkpointBytes: number;
  checkpoints: number;
  checkpointInterval: number;
  surfaceCacheBytes: number;
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
  private readonly surfaces: ReplaySurfaceCache;
  private readonly surfaceVisits: Uint8Array;
  private traceStore?: ReplayTraceStore;
  private recordedThrough = 0;
  private historyWarning?: string;
  private seekingRecorded = false;
  private cancelled = false;
  private preparingFinal = false;
  private initialMaterialCounters?: ReturnType<typeof materialCounters>;
  private afterSubtractionCounters?: ReturnType<typeof materialCounters>;

  constructor(
    private readonly input: DeepReadonly<SimulationInput>,
    private readonly steps: readonly number[],
    options: Partial<ReplayOptions> = {},
  ) {
    this.options = { ...REPLAY_LIMITS, ...options };
    this.surfaces = new ReplaySurfaceCache(this.options.surfaceCacheBytes);
    this.timelineBytes = 2049 + steps.length * 24 + input.motions.length * 9;
    if (
      !Number.isSafeInteger(this.timelineBytes) ||
      this.timelineBytes > SIMULATION_LIMITS.stockBytes
    )
      throw new Error('Replay timeline exceeds the stock/workspace memory budget');
    this.surfaceVisits = new Uint8Array(input.motions.length + 1);
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
      if (released < required) released += this.surfaces.release(required - released);
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

  private get traceIndexBytes(): number {
    return this.traceStore?.indexBytes ?? 0;
  }

  private reserveWorkspace(extra: number, includeSurface: boolean, retainExtra = false): void {
    const stock = this.engine.stock;
    stock.setReplayWorkspaceBytes(0);
    const surface = includeSurface ? this.surfaceBytes : 0;
    while (
      this.checkpoints.length &&
      !stock.canAccountSurfaceWorkspace(
        this.timelineBytes + this.traceIndexBytes + this.historyBytes + surface + extra,
      )
    ) {
      this.checkpoints.shift();
      this.evictedCheckpoints++;
    }
    while (
      this.surfaces.size &&
      !stock.canAccountSurfaceWorkspace(
        this.timelineBytes +
          this.traceIndexBytes +
          this.historyBytes +
          this.surfaces.bytes +
          surface +
          extra,
      )
    )
      this.surfaces.release(1);
    stock.setReplayWorkspaceBytes(
      this.timelineBytes +
        this.traceIndexBytes +
        this.historyBytes +
        this.surfaces.bytes +
        surface +
        (retainExtra ? extra : 0),
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
    this.engine.applyBatches(
      batches,
      progress,
      true,
      this.preparingFinal,
      this.preparingFinal && end < this.motionEnds[this.safePosition],
      this.motionCount,
    );
    return performance.now() - started;
  }

  async prepareFinal(progress: (processed: number, total: number) => void): Promise<ReplayFrame> {
    if (this.position || this.initializedSurface)
      throw new Error('Prepare final stock before replay starts');
    const started = performance.now();
    this.preparingFinal = true;
    this.initialMaterialCounters = materialCounters(this.engine.stock);
    try {
      const frame = await this.seekRecorded(this.steps.length, true, progress);
      frame.finalResult = createMaterialRemovalResult(
        this.input,
        this.engine,
        this.builder,
        frame.chunks,
        started,
        frame.subtractionMs,
        frame.meshingMs,
        this.initialMaterialCounters,
        this.afterSubtractionCounters ?? materialCounters(this.engine.stock),
      );
      frame.finalResult.processedMotions = frame.processedMotions;
      frame.finalResult.stop = frame.stop;
      frame.finalResult.status = frame.stop ? 'stopped' : 'completed';
      return frame;
    } finally {
      this.preparingFinal = false;
    }
  }

  setTraceStore(store: ReplayTraceStore): void {
    if (this.position || this.traceStore)
      throw new Error('Attach stock history before simulation starts');
    this.traceStore = store;
    this.historyWarning = store.warning;
  }

  async close(): Promise<void> {
    const store = this.traceStore;
    this.traceStore = undefined;
    this.surfaces.clear();
    await store?.close();
  }

  cancel(): void {
    this.cancelled = true;
  }

  private checkCancelled(): void {
    if (this.cancelled) throw new DOMException('Material replay cancelled', 'AbortError');
  }

  /** Partial history changes spatial regions, not full stock copies or cached screen images. */
  async seekRecorded(
    requestedPosition: number,
    forceReplace = false,
    progress: (processed: number, total: number) => void = () => {},
  ): Promise<ReplayFrame> {
    if (this.seekingRecorded)
      throw new Error('Concurrent material history seeks are not supported');
    this.seekingRecorded = true;
    try {
      return await this.seekHistory(requestedPosition, forceReplace, progress);
    } finally {
      this.seekingRecorded = false;
    }
  }

  private historyFrame(frame: ReplayFrame, historyMs = 0): ReplayFrame {
    return {
      ...frame,
      historyMode: this.traceStore?.available ? 'partial-disk' : 'checkpoint',
      historyBytes: this.traceStore?.bytes ?? 0,
      historyWarning: this.historyWarning ?? this.traceStore?.warning,
      historyMs,
    };
  }

  private async disableHistory(message: string): Promise<void> {
    this.historyWarning = message;
    console.warn(message);
    await this.close();
  }

  private async seekHistory(
    requestedPosition: number,
    forceReplace: boolean,
    progress: (processed: number, total: number) => void,
  ): Promise<ReplayFrame> {
    if (
      !Number.isSafeInteger(requestedPosition) ||
      requestedPosition < 0 ||
      requestedPosition > this.steps.length
    )
      throw new Error('Replay position is outside the executed timeline');
    this.checkCancelled();
    if (!this.traceStore?.available)
      return this.historyFrame(this.seek(requestedPosition, forceReplace, progress));
    const started = performance.now();
    const target = Math.min(requestedPosition, this.safePosition);
    let historyMs = 0,
      subtractionMs = 0,
      appliedMotions = 0;
    let restoredPosition: number | undefined;
    this.engine.stock.resetQueryCounters();
    const restoreTarget = Math.min(target, this.recordedThrough);
    if (this.position !== restoreTarget) {
      const restoreStarted = performance.now();
      try {
        for await (const record of this.traceStore.restore(
          this.position,
          restoreTarget,
          // Retain the store's scan/decompression reservation plus decoded tree/install workspace.
          (bytes) => this.reserveWorkspace(bytes * 3, true, true),
        )) {
          this.checkCancelled();
          this.engine.stock.restoreTraceRegion(record.key, record.data);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        console.error('Partial stock history restore failed:', error);
        await this.disableHistory(
          `Partial stock history could not be restored: ${error instanceof Error ? error.message : 'storage failure'}. Reconstructing exact stock from the beginning.`,
        );
        this.engine = new MaterialRemovalEngine(this.input);
        this.position = this.motionCount = this.lastCheckpointMotion = 0;
        this.checkpoints.length = 0;
        this.builder = new StockMeshBuilder();
        this.initializedSurface = false;
        this.attachMemoryPressure();
        return this.historyFrame(
          this.seek(requestedPosition, true, progress),
          performance.now() - restoreStarted,
        );
      }
      this.position = restoreTarget;
      this.motionCount = this.motionEnds[restoreTarget];
      restoredPosition = restoreTarget;
      historyMs += performance.now() - restoreStarted;
    }
    progress(this.motionCount, this.motionEnds[target]);
    while (this.position < target && this.traceStore?.available) {
      this.checkCancelled();
      const next = this.position + 1;
      const end = this.motionEnds[next];
      if (end > this.motionCount) {
        const captureStarted = performance.now();
        this.reserveWorkspace(0, true);
        this.engine.stock.beginTrace();
        historyMs += performance.now() - captureStarted;
        subtractionMs += this.applyPrefix(end, (processed) =>
          progress(this.motionCount + processed, this.motionEnds[target]),
        );
        appliedMotions += end - this.motionCount;
        const encodeStarted = performance.now();
        const updates = this.engine.stock.finishTrace();
        historyMs += performance.now() - encodeStarted;
        this.motionCount = end;
        this.position = next;
        if (!updates) {
          await this.disableHistory(
            this.engine.stock.traceWarning ??
              'Partial stock history could not be captured; using bounded checkpoints and exact recomputation.',
          );
          break;
        }
        const rawBytes = updates.reduce(
          (sum, update) => sum + update.before.byteLength + update.after.byteLength + 256,
          0,
        );
        this.engine.stock.setReplayWorkspaceBytes(0);
        if (
          !this.engine.stock.canAccountSurfaceWorkspace(
            this.timelineBytes + this.traceIndexBytes + this.surfaceBytes + rawBytes * 3,
          )
        ) {
          await this.disableHistory(
            'Partial stock history encoding exceeded available workspace; using bounded checkpoints and exact recomputation.',
          );
          break;
        }
        this.reserveWorkspace(rawBytes * 3, true, true);
        const writeStarted = performance.now();
        if (!(await this.traceStore.write(next, updates))) {
          await this.disableHistory(
            this.traceStore.warning ??
              'Partial stock history storage is unavailable; using bounded checkpoints and exact recomputation.',
          );
          historyMs += performance.now() - writeStarted;
          break;
        }
        historyMs += performance.now() - writeStarted;
      } else this.position = next;
      this.recordedThrough = next;
      this.engine.stock.setReplayWorkspaceBytes(0);
      if (
        !this.engine.stock.canAccountSurfaceWorkspace(
          this.timelineBytes + this.traceIndexBytes + this.surfaceBytes,
        )
      ) {
        await this.disableHistory(
          'Partial stock history index exceeded available workspace; using bounded checkpoints and exact recomputation.',
        );
        break;
      }
      this.reserveWorkspace(0, true);
    }
    if (this.position < target) {
      this.checkCancelled();
      const frame = this.seek(requestedPosition, forceReplace, progress);
      frame.appliedMotions += appliedMotions;
      frame.subtractionMs += subtractionMs;
      frame.elapsedMs = performance.now() - started;
      return this.historyFrame(frame, historyMs);
    }
    return this.historyFrame(
      this.buildFrame(
        requestedPosition,
        started,
        subtractionMs,
        0,
        appliedMotions,
        restoredPosition,
        forceReplace || !this.initializedSurface,
        progress,
      ),
      historyMs,
    );
  }

  private saveCheckpoint(): void {
    // Initial profiling must remain on one engine; fallback replay can checkpoint later.
    if (this.preparingFinal) return;
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
          this.traceIndexBytes +
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
    return this.buildFrame(
      requestedPosition,
      started,
      subtractionMs,
      checkpointMs,
      this.motionCount - initialMotions,
      restoredPosition,
      replace,
      progress,
    );
  }

  private buildFrame(
    requestedPosition: number,
    started: number,
    subtractionMs: number,
    checkpointMs: number,
    appliedMotions: number,
    restoredPosition: number | undefined,
    replace: boolean,
    progress: (processed: number, total: number) => void,
  ): ReplayFrame {
    const target = Math.min(requestedPosition, this.safePosition);
    if (this.preparingFinal) this.afterSubtractionCounters = materialCounters(this.engine.stock);
    const meshingStarted = performance.now();
    const dirtyChunks = this.engine.stock.dirtyChunks.size;
    this.reserveWorkspace(0, false);
    const cached = this.surfaces.get(this.motionCount);
    const visit = this.surfaceVisits[this.motionCount];
    const surfaceCacheMissReason: ReplayFrame['surfaceCacheMissReason'] = cached
      ? undefined
      : !this.options.surfaceCacheBytes
        ? 'disabled'
        : visit === 2
          ? 'evicted-or-cleared'
          : visit === 1
            ? 'not-retained'
            : 'first-visit';
    let reconstructed = false;
    let changed: StockSurfaceChunk[];
    if (cached) {
      if (!this.initializedSurface || replace || dirtyChunks) {
        this.reserveWorkspace(
          cached.reduce(
            (sum, chunk) => sum + chunk.positions.byteLength + chunk.normals.byteLength + 512,
            4096,
          ),
          true,
          true,
        );
        changed = this.builder.restoreChunks(cached);
      } else changed = [];
      this.engine.stock.dirtyChunks.clear();
    } else {
      reconstructed = !this.initializedSurface || replace || !!dirtyChunks;
      changed = reconstructed ? this.builder.buildChanged(this.engine.stock) : [];
    }
    this.initializedSurface = true;
    const meshingMs = performance.now() - meshingStarted;
    if (!cached) {
      const retained = this.surfaces.retain(this.motionCount, this.builder.getChunks(), (bytes) => {
        const stock = this.engine.stock;
        stock.setReplayWorkspaceBytes(0);
        const demand =
          this.timelineBytes + this.traceIndexBytes + this.historyBytes + this.surfaceBytes + bytes;
        if (!stock.canAccountSurfaceWorkspace(demand)) return false;
        stock.setReplayWorkspaceBytes(demand);
        return true;
      });
      this.surfaceVisits[this.motionCount] = retained || visit === 2 ? 2 : 1;
    }
    const meshDiagnostics = reconstructed ? this.builder.chunkDiagnostics : [];
    const meshPhases = meshDiagnostics.reduce(
      (totals, chunk) => {
        totals.triangulationMs += chunk.triangulationMs;
        totals.adaptationMs += chunk.adaptationMs;
        totals.fineTriangles += chunk.fineTriangles;
        totals.outputTriangles += chunk.outputTriangles;
        return totals;
      },
      { triangulationMs: 0, adaptationMs: 0, fineTriangles: 0, outputTriangles: 0 },
    );
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
      appliedMotions,
      restoredPosition,
      checkpointCount: this.checkpoints.length,
      checkpointBytes: this.historyBytes,
      skippedCheckpoints: this.skippedCheckpoints,
      evictedCheckpoints: this.evictedCheckpoints,
      peakStockBytes: this.engine.stock.peakAllocatedBytes,
      surfaceCacheHit: !!cached,
      surfaceCacheBytes: this.surfaces.bytes,
      surfaceCacheStates: this.surfaces.size,
      surfaceCacheSkipped: this.surfaces.skipped,
      surfaceCacheEvictions: this.surfaces.evictions,
      surfaceCacheClears: this.surfaces.clears,
      surfaceCacheMissReason,
      extractionMs: reconstructed ? this.builder.extractionMs : 0,
      ...meshPhases,
      dirtyChunks,
      remeshedChunks: meshDiagnostics.length,
      surfaceReconstructed: reconstructed,
      surfaceCacheLimitBytes: this.options.surfaceCacheBytes,
      topologyPasses: reconstructed ? this.builder.topologyPasses : 0,
      topologyReused: reconstructed && this.builder.topologyReused,
      topologyCachePeakBytes: reconstructed ? this.builder.topologyCachePeakBytes : 0,
    };
  }
}

export type ReplayWorkerRequest =
  | {
      type: 'initialize';
      requestId: number;
      input: DeepReadonly<SimulationInput>;
      steps: number[];
      prepareFinal?: boolean;
    }
  | { type: 'seek'; requestId: number; position: number; forceReplace: boolean }
  | { type: 'close'; requestId: number };

export type ReplayWorkerResponse =
  | { type: 'progress'; requestId: number; processed: number; total: number }
  | { type: 'frame'; requestId: number; frame: ReplayFrame }
  | { type: 'error'; requestId: number; message: string };
