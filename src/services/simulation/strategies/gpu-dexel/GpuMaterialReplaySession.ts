import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { DeepReadonly } from '@services/tools/SimulationMetadata';
import type { MaterialReplayStrategy } from '../../replay/MaterialReplayStrategy';
import { compileGpuSweeps, GPU_SWEEP_STRIDE, type CompiledGpuSweep } from './GpuSweepCompiler';
import { recordGpuDiagnostic } from './GpuDiagnostics';
import { GpuDexelHistory } from './GpuDexelHistory';
import { GpuDexelStock } from './GpuDexelStock';
import { RevolvedStock } from './RevolvedStock';
import { RotationalProfile } from '../cpu-hybrid/RotationalProfile';
import { RotationalDexelBase } from './RotationalDexelBase';
import {
  createDexelLayout,
  DEXEL_MEMORY_BYTES,
  DEXEL_BINDING_BYTES,
  dexelIntervalCapacity,
  DEXEL_MAX_INTERVALS,
  GpuDexelIntervalOverflowError,
  indexDexelTiles,
  dexelTilesForBounds,
} from './DexelLayout';
import { materialSize, stockPlacement } from '../../shared/SimulationTransforms';
import {
  SimulationCapabilityError,
  type RemovalStop,
  type SimulationInput,
} from '../../shared/SimulationTypes';

class GpuReplayBudgetError extends SimulationCapabilityError {}

export interface GpuDexelReplayFrame {
  backend: 'webgpu-dexel';
  position: number;
  requestedPosition: number;
  total: number;
  executionStep?: number;
  processedMotions: number;
  newMotions: number;
  reusedPosition?: number;
  stop?: RemovalStop;
  phase: 'coarse' | 'fine';
  pitchMm: number;
  elapsedMs: number;
  estimatedBytes: number;
  cacheHit: boolean;
  stock: GpuDexelStock;
  historyHit?: boolean;
  historyThrough?: number;
  historyUnavailable?: string;
  preparationMs?: number;
  readinessMs?: number;
}

export interface RotationalReplayFrame extends Omit<GpuDexelReplayFrame, 'backend' | 'stock'> {
  backend: 'hybrid-turning';
  stock: RevolvedStock;
}

export type GpuReplayFrame = GpuDexelReplayFrame | RotationalReplayFrame;

export interface GpuReplayOptions {
  finePitchMm: number;
  refinementDelayMs?: number;
  residentBytes?: number;
  memoryLimitBytes?: number;
  onRefined(frame: GpuReplayFrame): void;
  onRefinementError(error: Error): void;
}

interface PendingSeek {
  position: number;
  resolve(frame: GpuReplayFrame): void;
  reject(error: Error): void;
}

/** Navigation always selects an executed prefix; refinement replays that prefix at a new pitch. */
export class GpuMaterialReplaySession implements MaterialReplayStrategy {
  readonly backend = 'hybrid-turning';
  private input?: DeepReadonly<SimulationInput>;
  private steps: readonly number[] = [];
  private safePosition = 0;
  private epoch = 0;
  private cancelled = false;
  private running = false;
  private queued?: PendingSeek;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly coarse = new Map<number, GpuDexelStock>();
  private readonly fine = new Map<number, GpuDexelStock>();
  private readonly owned = new Set<GpuDexelStock>();
  private readonly revolved = new Map<
    string,
    { position: number; motions: number; stock: RevolvedStock }
  >();
  private readonly ownedRevolved = new Set<RevolvedStock>();
  private rotationalThrough = -1;
  private rotationalBase?: RotationalDexelBase;
  private implicitTurning: boolean[] = [];
  private implicitProfile?: { through: number; profile: RotationalProfile };
  private initialSweeps?: { position: number; sweeps: CompiledGpuSweep[] };
  private compiledSweeps: CompiledGpuSweep[] = [];
  private compiledSweepBytes = 0;
  private readonly histories = new Map<
    'coarse' | 'fine',
    { history: GpuDexelHistory; through: number; baseFingerprint?: string }
  >();
  private readonly pinned = new Set<GpuDexelStock>();
  private readonly checkpointStocks = new Set<GpuDexelStock>();
  private readonly memoryLimitBytes: number;
  private progress: (processed: number, total: number) => void = () => {};

  constructor(
    readonly runId: string,
    private readonly renderer: WebGPURenderer,
    private readonly device: GPUDevice,
    private readonly options: GpuReplayOptions,
  ) {
    this.memoryLimitBytes = options.memoryLimitBytes ?? DEXEL_MEMORY_BYTES;
    if (
      !Number.isFinite(options.finePitchMm) ||
      options.finePitchMm < 0.001 ||
      options.finePitchMm > 5 ||
      !Number.isSafeInteger(options.refinementDelayMs ?? 350) ||
      (options.refinementDelayMs ?? 350) < 0 ||
      !Number.isSafeInteger(this.memoryLimitBytes) ||
      this.memoryLimitBytes < 16 * 1024 * 1024 ||
      !Number.isSafeInteger(options.residentBytes ?? 0) ||
      (options.residentBytes ?? 0) < 0 ||
      (options.residentBytes ?? 0) > this.memoryLimitBytes
    ) {
      throw new SimulationCapabilityError(
        'GPU fine pitch must be between 0.001 and 5 mm and the idle delay must be nonnegative',
      );
    }
  }

  get computing(): boolean {
    return this.running && !this.cancelled;
  }

  start(
    input: DeepReadonly<SimulationInput>,
    steps: readonly number[],
    progress: (processed: number, total: number) => void = () => {},
    prepareFinal = false,
  ): Promise<GpuReplayFrame> {
    if (this.input) return Promise.reject(new Error('GPU replay has already started'));
    this.input = input;
    this.steps = [...steps];
    this.progress = progress;
    try {
      let previous = -1;
      for (const step of steps) {
        if (!Number.isSafeInteger(step) || step <= previous)
          throw new Error('GPU replay steps must be strictly increasing nonnegative integers');
        previous = step;
      }
      const known = new Set(steps);
      previous = -1;
      for (const motion of input.motions) {
        if (!known.has(motion.executionStep) || motion.executionStep < previous)
          throw new Error('GPU cutter motion is absent from the executed replay timeline');
        previous = motion.executionStep;
      }
      if (
        input.stop?.executionStep !== undefined &&
        (!Number.isSafeInteger(input.stop.executionStep) || input.stop.executionStep < 0)
      )
        throw new Error('Invalid GPU replay stop occurrence');
      this.safePosition = input.stop
        ? input.stop.executionStep !== undefined
          ? steps.filter((step) => step < input.stop!.executionStep!).length
          : input.motions.length
            ? steps.filter((step) => step <= input.motions[input.motions.length - 1].executionStep)
                .length
            : 0
        : steps.length;
      if (input.motions.length * (GPU_SWEEP_STRIDE * 4 + 256) > 32 * 1024 * 1024)
        throw new SimulationCapabilityError(
          'GPU cutter compilation exceeds its 32 MiB staging budget; use CPU simulation',
        );
      const preparationStarted = performance.now();
      this.compiledSweeps = compileGpuSweeps(input);
      this.compiledSweepBytes = this.compiledSweeps.reduce(
        (bytes, sweep) =>
          bytes +
          sweep.data.byteLength +
          256 +
          (sweep.turningVolume?.rotationalSection?.polygon.length ?? 0) * 256,
        0,
      );
      if (this.compiledSweepBytes > 32 * 1024 * 1024)
        throw new SimulationCapabilityError(
          'Hybrid cutter compilation exceeds its 32 MiB staging budget',
        );
      if (input.stock.type === 'cylinder' && input.rotationalProfile !== false) {
        const profile = new RotationalProfile(input.stock.diameter / 2, input.stock.length);
        this.implicitTurning = this.compiledSweeps.map(
          (sweep) => !!sweep.turningVolume && profile.canApply(sweep.turningVolume),
        );
        this.rotationalThrough = 0;
        for (const sweep of this.compiledSweeps) {
          if (!sweep.turningVolume || !profile.canApply(sweep.turningVolume)) break;
          this.rotationalThrough++;
        }
        if (this.rotationalThrough < this.compiledSweeps.length) {
          // Build the base in the cancellable, yielding seek path, not synchronously in start().
          this.implicitProfile = { through: 0, profile };
          this.makeRoom(0);
        }
      }
      if (prepareFinal && !input.stop) {
        this.initialSweeps = {
          position: steps.length,
          sweeps: this.compiledSweeps,
        };
      }
      recordGpuDiagnostic(this.device, 'replay-preparation', {
        motions: input.motions.length,
        compiledSweeps: this.initialSweeps?.sweeps.length ?? input.motions.length,
        elapsedMs: Math.round(performance.now() - preparationStarted),
      });
      return this.seek(prepareFinal ? steps.length : 0);
    } catch (error) {
      this.initialSweeps = undefined;
      this.compiledSweeps = [];
      this.compiledSweepBytes = 0;
      return Promise.reject(error);
    }
  }

  seek(position: number): Promise<GpuReplayFrame> {
    if (this.cancelled)
      return Promise.reject(new DOMException('GPU replay cancelled', 'AbortError'));
    if (
      !this.input ||
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position > this.steps.length
    )
      return Promise.reject(new Error('GPU replay position is outside the executed timeline'));
    this.epoch++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    return new Promise((resolve, reject) => {
      const pending = { position, resolve, reject };
      if (this.running) {
        this.queued?.reject(new DOMException('GPU replay seek superseded', 'AbortError'));
        this.queued = pending;
      } else void this.run(pending);
    });
  }

  private async run(pending: PendingSeek): Promise<void> {
    this.running = true;
    const epoch = this.epoch;
    try {
      const target = Math.min(pending.position, this.safePosition);
      const preparedFine =
        this.fine.has(target) ||
        this.revolved.has(`fine:${target}`) ||
        (this.histories.get('fine')?.through ?? -1) >= target;
      const frame = await this.frame(pending.position, preparedFine ? 'fine' : 'coarse');
      if (this.cancelled || epoch !== this.epoch)
        throw new DOMException('GPU replay seek superseded', 'AbortError');
      pending.resolve(frame);
      if (frame.phase === 'coarse') this.scheduleRefinement(pending.position, epoch);
    } catch (error) {
      pending.reject(
        error instanceof Error || error instanceof DOMException ? error : new Error(String(error)),
      );
    } finally {
      this.running = false;
      this.advance();
    }
  }

  private advance(): void {
    const next = this.queued;
    this.queued = undefined;
    if (next && !this.cancelled) void this.run(next);
    if (this.cancelled) this.releaseUnattached();
  }

  private scheduleRefinement(position: number, epoch: number): void {
    if (this.options.finePitchMm >= 0.1) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.cancelled || epoch !== this.epoch || this.running) return;
      this.running = true;
      void this.frame(position, 'fine')
        .then((frame) => {
          if (!this.cancelled && epoch === this.epoch) this.options.onRefined(frame);
        })
        .catch((error: unknown) => {
          if (!this.cancelled && epoch === this.epoch) {
            const failure = error instanceof Error ? error : new Error(String(error));
            console.error('GPU stock refinement failed:', failure);
            this.options.onRefinementError(failure);
          }
        })
        .finally(() => {
          this.running = false;
          this.advance();
        });
    }, this.options.refinementDelayMs ?? 350);
  }

  private async frame(
    requestedPosition: number,
    phase: 'coarse' | 'fine',
    checkpoint = false,
  ): Promise<GpuReplayFrame> {
    const readinessStarted = performance.now();
    const input = this.input!;
    const position = Math.min(requestedPosition, this.safePosition);
    const step = position ? this.steps[position - 1] : -1;
    const motionCount = input.motions.filter((motion) => motion.executionStep <= step).length;
    // Eligibility is an executed-prefix frontier, never a property of the latest displayed stock.
    // Turning-only material and asymmetric removals are intersected, never re-revolved.
    if (motionCount <= this.rotationalThrough)
      return this.rotationalFrame(requestedPosition, phase, motionCount);
    const pitch =
      phase === 'fine' ? this.options.finePitchMm : Math.max(0.1, this.options.finePitchMm);
    const cache = phase === 'fine' ? this.fine : this.coarse;
    let stock = cache.get(position),
      elapsedMs = 0;
    const rotationalBase =
      stock?.rotationalBase ??
      (this.implicitProfile ? await this.baseForPrefix(motionCount) : undefined);
    const cacheHit = !!stock;
    let newMotions = 0;
    let reusedPosition: number | undefined;
    let preparationMs = 0;
    let retainedHistory = this.histories.get(phase);
    if (retainedHistory?.baseFingerprint !== rotationalBase?.fingerprint && retainedHistory) {
      retainedHistory.history.dispose();
      this.histories.delete(phase);
      retainedHistory = undefined;
    }
    const history =
      retainedHistory && position <= retainedHistory.through ? retainedHistory.history : undefined;
    let capturedHistory = false;
    if (!stock) {
      let source: GpuDexelStock | undefined;
      for (const [candidatePosition, candidate] of cache) {
        if (
          candidatePosition < position &&
          (reusedPosition === undefined || candidatePosition > reusedPosition)
        ) {
          reusedPosition = candidatePosition;
          source = candidate;
        }
      }
      const sourceStep =
        reusedPosition !== undefined && reusedPosition > 0 ? this.steps[reusedPosition - 1] : -1;
      const motions = input.motions.filter(
        (motion) => motion.executionStep <= step && (!source || motion.executionStep > sourceStep),
      );
      const baseStep =
        this.rotationalThrough > 0
          ? this.compiledSweeps[this.rotationalThrough - 1].executionStep
          : -1;
      newMotions = history ? 0 : motions.filter((motion) => motion.executionStep > baseStep).length;
      const preparationStarted = performance.now();
      const prepared =
        !source && this.initialSweeps?.position === position
          ? this.initialSweeps.sweeps
          : undefined;
      this.initialSweeps = undefined;
      const sweeps = history
        ? []
        : (prepared ?? this.compiledSweeps)
            .filter(
              (sweep) =>
                sweep.executionStep > baseStep &&
                sweep.executionStep <= step &&
                !this.implicitTurning[sweep.motionIndex] &&
                (!source || sweep.executionStep > sourceStep),
            )
            .map((sweep) =>
              rotationalBase
                ? { ...sweep, bounds: rotationalBase.materialBounds(sweep.bounds) }
                : sweep,
            )
            .filter((sweep) => !sweep.bounds.isEmpty());
      preparationMs = performance.now() - preparationStarted;
      recordGpuDiagnostic(this.device, 'frame-preparation', {
        position,
        phase,
        reusedInitialSweeps: prepared !== undefined,
        motions: motionCount,
        newMotions,
        reusedPosition: reusedPosition ?? -1,
        compiledSweeps: sweeps.length,
        elapsedMs: Math.round(performance.now() - preparationStarted),
      });
      const size = new THREE.Vector3(...materialSize(input.stock));
      const calculationEpoch = this.epoch;
      let intervalCapacity = dexelIntervalCapacity(
        Math.max(source?.layout.intervalCapacity ?? 0, rotationalBase?.maxIntervals ?? 0),
      );
      let retry: boolean;
      do {
        retry = false;
        if (this.cancelled || calculationEpoch !== this.epoch)
          throw new DOMException('GPU replay cancelled', 'AbortError');
        const updateBase =
          !!source?.rotationalBase &&
          !!rotationalBase &&
          source.rotationalBase.fingerprint !== rotationalBase.fingerprint;
        const retainedTiles = history
          ? Uint32Array.from(
              new Set([...history.tiles(step), ...(source?.layout.storedTiles ?? [])]),
            )
          : source?.layout.storedTiles;
        const layout = createDexelLayout(size, pitch, intervalCapacity, {
          bounds: sweeps.map((sweep) => sweep.bounds),
          retainedTiles,
          memoryLimitBytes: this.memoryLimitBytes,
        });
        const index = indexDexelTiles(layout, sweeps, this.memoryLimitBytes);
        const staging = layout.tiles * 96 + index.sweeps.length * 16;
        const records = sweeps.length * (GPU_SWEEP_STRIDE * 12 + 320);
        const cutTiles = history
          ? Uint32Array.from(
              history.work(source ? sourceStep : -1, step).reduce<number[]>((tiles, count, i) => {
                if (i % 2 && count) tiles.push(Math.floor(i / 2));
                return tiles;
              }, []),
            )
          : Uint32Array.from(
              new Set(sweeps.flatMap((sweep) => dexelTilesForBounds(layout, sweep.bounds))),
            );
        const changedTiles = updateBase
          ? Uint32Array.from(new Set([...cutTiles, ...source!.layout.storedTiles]))
          : cutTiles;
        const arenaProvider =
          source?.layout.intervalCapacity === intervalCapacity
            ? source
            : [...cache.values()].find(
                (candidate) => candidate.layout.intervalCapacity === intervalCapacity,
              );
        const privateTiles =
          source && source.layout.intervalCapacity === intervalCapacity
            ? new Set([
                ...changedTiles,
                ...layout.storedTiles.filter((tile) => source!.tileSlots[tile] === 0xffffffff),
              ]).size
            : layout.storedTiles.length;
        const arena =
          arenaProvider?.tileArena && arenaProvider.tileArena.available >= privateTiles
            ? arenaProvider.tileArena
            : undefined;
        const baseBytes =
          layout.estimatedBytes +
          staging +
          records +
          (rotationalBase?.estimatedBytes ?? 0) * 2 +
          4096 -
          (arena ? 2 * (layout.intervalBytes + Math.max(1, layout.storageRays) * 4) : 0);
        this.makeRoom(baseBytes, source ?? (arena ? arenaProvider : undefined));
        const capture = !history && (!source || reusedPosition === 0) && motionCount > 0;
        const tileBytes = 2 * 1024 * (intervalCapacity * 8 + 4) + 12;
        const spare = Math.max(0, this.memoryLimitBytes - this.residentBytes() - baseBytes);
        // Reserve a bounded atlas, leaving most spare memory for streamed history.
        const arenaTiles = !arena
          ? Math.min(
              layout.storedTiles.length * 4,
              layout.storedTiles.length + Math.floor(spare / 3 / tileBytes),
              Math.floor(DEXEL_BINDING_BYTES / (1024 * intervalCapacity * 8)),
            )
          : layout.storedTiles.length;
        const arenaExtra = !arena ? (arenaTiles - layout.storedTiles.length) * tileBytes : 0;
        const available = spare - arenaExtra;
        // Reserve capture, sorted upload, ray index and temporary sorting/readback storage together.
        const historyLimit = capture
          ? Math.max(
              0,
              Math.min(
                4194304,
                index.sweeps.length * 4096,
                Math.floor((available - layout.storageRays * 24 - layout.tiles * 24) / 96),
              ),
            )
          : 0;
        const historyEvents = Math.min(1048576, historyLimit);
        stock = new GpuDexelStock(
          this.renderer,
          this.device,
          size,
          pitch,
          input.stock.type === 'cylinder',
          sweeps,
          stockPlacement(input.stock, input.binding),
          intervalCapacity,
          {
            retainedTiles,
            historyEvents,
            historyLimit,
            source,
            arena,
            arenaTiles,
            changedTiles,
            rotationalBase,
            updateBase,
            memoryLimitBytes: this.memoryLimitBytes,
          },
        );
        const attemptStarted = performance.now();
        try {
          this.owned.add(stock);
          this.pinned.add(stock);
          try {
            this.makeRoom(0, source);
          } finally {
            this.pinned.delete(stock);
          }
          const cancelled = () => this.cancelled || calculationEpoch !== this.epoch;
          if (!checkpoint) this.progress(motionCount - newMotions, motionCount);
          const copyMs = source ? await stock.copyFrom(source, cancelled) : 0;
          const computeMs = history
            ? await stock.restoreHistory(history, step, cancelled, source ? sourceStep : -1)
            : sweeps.length || !source
              ? await stock.calculate(sweeps.length, cancelled)
              : 0;
          elapsedMs += copyMs + computeMs;
          if (this.cancelled || calculationEpoch !== this.epoch)
            throw new DOMException('GPU replay cancelled', 'AbortError');
          if (!checkpoint) this.progress(motionCount, motionCount);
          cache.set(position, stock);
          if (checkpoint) this.checkpointStocks.add(stock);
          const recorded = stock.takeHistory();
          stock.releasePreparation();
          if (recorded) {
            if (this.residentBytes() + recorded.estimatedBytes <= this.memoryLimitBytes) {
              this.histories.get(phase)?.history.dispose();
              this.histories.set(phase, {
                history: recorded,
                through: position,
                baseFingerprint: rotationalBase?.fingerprint,
              });
              capturedHistory = true;
            } else {
              recorded.dispose();
              stock.historyUnavailable =
                'Removal history exceeds the replay memory budget; uncached jumps use geometric replay.';
              console.warn('[NC-Edit7 GPU] ' + stock.historyUnavailable);
            }
          } else if (capture && !historyEvents) {
            stock.historyUnavailable =
              'No memory available for removal history; uncached jumps use geometric replay.';
            console.warn('[NC-Edit7 GPU] ' + stock.historyUnavailable);
          }
          stock.group.userData.releaseGpuStock = () => {
            if (this.cancelled) {
              cache.delete(position);
              this.owned.delete(stock!);
              stock!.dispose();
            }
          };
          break;
        } catch (error) {
          this.owned.delete(stock);
          stock.dispose();
          if (source && !this.owned.has(source)) {
            source = undefined;
            reusedPosition = undefined;
          }
          if (
            !(error instanceof GpuDexelIntervalOverflowError) ||
            intervalCapacity === DEXEL_MAX_INTERVALS
          )
            throw error;
          elapsedMs += performance.now() - attemptStarted;
          const nextCapacity = dexelIntervalCapacity(intervalCapacity + 1);
          recordGpuDiagnostic(this.device, 'interval-capacity-retry', {
            position,
            phase,
            pitchMm: pitch,
            from: intervalCapacity,
            to: nextCapacity,
          });
          console.info(
            '[NC-Edit7 GPU] Retrying interval capacity ' +
              JSON.stringify({
                position,
                phase,
                pitchMm: pitch,
                from: intervalCapacity,
                to: nextCapacity,
              }),
          );
          intervalCapacity = nextCapacity;
          retry = true;
        }
      } while (retry);
    } else {
      cache.delete(position);
      cache.set(position, stock);
    }
    if (capturedHistory && position >= 64) {
      this.pinned.add(stock);
      try {
        for (const checkpoint of this.histories
          .get(phase)!
          .history.checkpointPositions(this.steps, position)) {
          if (cache.has(checkpoint)) continue;
          const checkpointStep = this.steps[checkpoint - 1];
          if (
            this.compiledSweeps.some(
              (sweep) =>
                this.implicitTurning[sweep.motionIndex] &&
                sweep.executionStep > checkpointStep &&
                sweep.executionStep <= step,
            )
          )
            continue;
          if (
            this.residentBytes() + stock.estimatedBytes - (stock.tileArena?.estimatedBytes ?? 0) >
            this.memoryLimitBytes
          )
            break;
          try {
            await this.frame(checkpoint, phase, true);
          } catch (error) {
            if (!(error instanceof GpuReplayBudgetError)) throw error;
            break;
          }
        }
      } finally {
        this.pinned.delete(stock);
      }
    }
    if (!cacheHit)
      console.info(
        '[NC-Edit7 GPU] Replay stock ready ' +
          JSON.stringify({
            position,
            requestedPosition,
            phase,
            pitchMm: pitch,
            intervalCapacity: stock.layout.intervalCapacity,
            analyticalFlatSweeps: stock.analyticalFlatSweeps,
            analyticalProfileSweeps: stock.analyticalProfileSweeps,
            checkpoint,
            motions: motionCount,
            newMotions,
            reusedPosition,
            elapsedMs: Math.round(elapsedMs),
            preparationMs: Math.round(preparationMs),
            readinessMs: Math.round(performance.now() - readinessStarted),
            historyHit: !!history && !cacheHit,
            historyThrough: this.histories.get(phase)?.through,
            historyUnavailable: stock.historyUnavailable,
            storedTiles: stock.layout.storedTiles.length,
            totalTiles: stock.layout.tiles,
            copyMs: Math.round(stock.timings?.copyMs ?? 0),
            copiedTiles: stock.timings?.copiedTiles ?? 0,
            sharedTiles: stock.timings?.sharedTiles ?? 0,
            computeMs: Math.round(stock.timings?.computeMs ?? 0),
            submittedRays: stock.timings?.submittedRays ?? 0,
            submissions: stock.timings?.submissions ?? 0,
            estimatedMiB: Math.round(stock.estimatedBytes / 1048576),
          }),
      );
    return {
      backend: 'webgpu-dexel',
      position,
      requestedPosition,
      total: this.steps.length,
      executionStep: position ? step : undefined,
      processedMotions: motionCount,
      newMotions,
      reusedPosition,
      stop:
        requestedPosition > this.safePosition || position === this.steps.length
          ? input.stop
          : undefined,
      phase,
      pitchMm: pitch,
      elapsedMs,
      cacheHit,
      stock,
      historyHit: !!history && !cacheHit,
      historyThrough: this.histories.get(phase)?.through,
      historyUnavailable: stock.historyUnavailable,
      preparationMs,
      readinessMs: performance.now() - readinessStarted,
      estimatedBytes: this.residentBytes(),
    };
  }

  private async baseForPrefix(motionCount: number): Promise<RotationalDexelBase | undefined> {
    const current = this.implicitProfile;
    if (!current) return undefined;
    const from = current.through <= motionCount ? current.through : 0;
    const changes = this.implicitTurning.slice(from, motionCount).some(Boolean);
    if (from === current.through && !changes && this.rotationalBase) {
      current.through = motionCount;
      return this.rotationalBase;
    }
    const input = this.input!;
    if (input.stock.type !== 'cylinder') throw new Error('Implicit turning requires a cylinder');
    this.makeRoom(current.profile.allocatedBytes);
    const profile = from
      ? current.profile.fork()
      : new RotationalProfile(input.stock.diameter / 2, input.stock.length);
    const epoch = this.epoch;
    const reserve = (bytes: number) => {
      if (this.cancelled || epoch !== this.epoch)
        throw new DOMException('Turning replay superseded', 'AbortError');
      this.makeRoom(bytes);
    };
    this.progress(0, motionCount);
    for (let i = from; i < motionCount; i++) {
      if (i > from && (i - from) % 16 === 0)
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (!this.implicitTurning[i]) continue;
      reserve(profile.allocatedBytes);
      profile.apply(this.compiledSweeps[i].turningVolume!, reserve);
      this.progress(Math.min(i + 1, this.rotationalThrough), motionCount);
    }
    reserve(profile.allocatedBytes * 2);
    const base = new RotationalDexelBase(profile);
    this.implicitProfile = { through: motionCount, profile };
    this.rotationalBase = base;
    this.makeRoom(0);
    return base;
  }

  private async rotationalFrame(
    requestedPosition: number,
    phase: 'coarse' | 'fine',
    motionCount: number,
  ): Promise<RotationalReplayFrame> {
    const started = performance.now();
    const input = this.input!;
    if (input.stock.type !== 'cylinder') throw new Error('Rotational stock requires a cylinder');
    const position = Math.min(requestedPosition, this.safePosition);
    const key = `${phase}:${position}`;
    const pitch =
      phase === 'fine' ? this.options.finePitchMm : Math.max(0.1, this.options.finePitchMm);
    const epoch = this.epoch;
    let entry = this.revolved.get(key);
    const cacheHit = !!entry;
    let reusedPosition: number | undefined;
    let newMotions = 0;
    if (!entry) {
      // Profiles are pitch-independent and immutable once a display frame owns them.
      let source: { position: number; motions: number; stock: RevolvedStock } | undefined;
      for (const candidate of this.revolved.values())
        if (candidate.position <= position && (!source || candidate.position > source.position))
          source = candidate;
      if (source) this.makeRoom(source.stock.profile.allocatedBytes, source.stock);
      const profile = source
        ? source.stock.profile.fork()
        : new RotationalProfile(input.stock.diameter / 2, input.stock.length);
      const from = source?.motions ?? 0;
      reusedPosition = source?.position;
      source = undefined;
      newMotions = motionCount - from;
      const reserve = (bytes: number) => {
        if (this.cancelled || epoch !== this.epoch)
          throw new DOMException('Turning replay superseded', 'AbortError');
        this.makeRoom(bytes);
      };
      this.progress(from, motionCount);
      for (let i = from; i < motionCount; i++) {
        if (i > from && (i - from) % 16 === 0)
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        reserve(profile.allocatedBytes);
        profile.apply(this.compiledSweeps[i].turningVolume!, reserve);
        this.progress(i + 1, motionCount);
      }
      reserve(profile.allocatedBytes);
      const stock = new RevolvedStock(
        profile,
        pitch,
        stockPlacement(input.stock, input.binding),
        reserve,
      );
      entry = { position, motions: motionCount, stock };
      this.ownedRevolved.add(stock);
      this.revolved.set(key, entry);
      stock.group.userData.releaseGpuStock = () => {
        if (this.cancelled) {
          this.revolved.delete(key);
          this.ownedRevolved.delete(stock);
          stock.dispose();
        }
      };
      try {
        this.makeRoom(0, stock);
      } catch (error) {
        this.revolved.delete(key);
        this.ownedRevolved.delete(stock);
        stock.dispose();
        throw error;
      }
      console.info(
        '[NC-Edit7 simulation] Rotational stock ready ' +
          JSON.stringify({
            position,
            phase,
            pitchMm: pitch,
            motions: motionCount,
            newMotions,
            reusedPosition,
            slabs: profile.meridianSlabs.length,
            elapsedMs: Math.round(performance.now() - started),
            estimatedMiB: Math.round(this.residentBytes() / 1048576),
          }),
      );
    }
    return {
      backend: 'hybrid-turning',
      position,
      requestedPosition,
      total: this.steps.length,
      executionStep: position ? this.steps[position - 1] : undefined,
      processedMotions: motionCount,
      newMotions,
      reusedPosition,
      stop:
        requestedPosition > this.safePosition || position === this.steps.length
          ? input.stop
          : undefined,
      phase,
      pitchMm: pitch,
      elapsedMs: performance.now() - started,
      estimatedBytes: this.residentBytes(),
      cacheHit,
      stock: entry.stock,
      readinessMs: performance.now() - started,
    };
  }

  private makeRoom(extra: number, protectedStock?: GpuDexelStock | RevolvedStock): void {
    let bytes = this.residentBytes();
    if (
      bytes + extra <= this.memoryLimitBytes &&
      this.revolved.size < 4 &&
      this.coarse.size < 4 &&
      this.fine.size < 4
    )
      return;
    for (const [key, entry] of this.revolved) {
      if (bytes + extra <= this.memoryLimitBytes && this.revolved.size < 4) break;
      if (entry.stock.group.parent || entry.stock === protectedStock) continue;
      this.revolved.delete(key);
      this.ownedRevolved.delete(entry.stock);
      entry.stock.dispose();
      bytes = this.residentBytes();
    }
    for (const cache of [this.fine, this.coarse]) {
      const candidates = [...cache].sort(([aPosition, a], [bPosition, b]) => {
        const aCheckpoint = this.checkpointStocks.has(a),
          bCheckpoint = this.checkpointStocks.has(b);
        return (
          Number(aCheckpoint) - Number(bCheckpoint) || (aCheckpoint ? bPosition - aPosition : 0)
        );
      });
      for (const [position, stock] of candidates) {
        if (bytes + extra <= this.memoryLimitBytes && cache.size < 4) break;
        if (stock.group.parent || stock === protectedStock || this.pinned.has(stock)) continue;
        cache.delete(position);
        this.owned.delete(stock);
        this.checkpointStocks.delete(stock);
        stock.dispose();
        bytes = this.residentBytes();
      }
    }
    if (bytes + extra > this.memoryLimitBytes)
      throw new GpuReplayBudgetError(
        `Hybrid replay/refinement exceeds the ${Math.round(this.memoryLimitBytes / 1048576)} MiB CPU/GPU buffer budget alongside displayed stock. Requested pitch is not reduced.`,
      );
  }

  cancel(): void {
    this.cancelled = true;
    this.initialSweeps = undefined;
    this.epoch++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.queued?.reject(new DOMException('GPU replay cancelled', 'AbortError'));
    this.queued = undefined;
    if (!this.running) this.releaseUnattached();
  }

  private residentBytes(): number {
    const arenas = new Set([...this.owned].map((stock) => stock.tileArena).filter(Boolean));
    return (
      [...this.owned].reduce(
        (sum, stock) => sum + stock.estimatedBytes - (stock.tileArena?.estimatedBytes ?? 0),
        this.options.residentBytes ?? 0,
      ) +
      [...arenas].reduce((sum, arena) => sum + arena.estimatedBytes, 0) +
      [...this.histories.values()].reduce((sum, entry) => sum + entry.history.estimatedBytes, 0) +
      [...this.ownedRevolved].reduce((sum, stock) => sum + stock.estimatedBytes, 0) +
      this.compiledSweepBytes +
      (this.rotationalBase?.estimatedBytes ?? 0) +
      (this.implicitProfile?.profile.allocatedBytes ?? 0)
    );
  }

  private releaseUnattached(): void {
    for (const stock of this.owned)
      if (!stock.group.parent) {
        this.owned.delete(stock);
        stock.dispose();
      }
    this.coarse.clear();
    this.fine.clear();
    this.checkpointStocks.clear();
    for (const stock of this.ownedRevolved)
      if (!stock.group.parent) {
        this.ownedRevolved.delete(stock);
        stock.dispose();
      }
    this.revolved.clear();
    for (const entry of this.histories.values()) entry.history.dispose();
    this.histories.clear();
    this.compiledSweeps = [];
    this.compiledSweepBytes = 0;
    this.rotationalBase = undefined;
    this.implicitProfile = undefined;
    this.implicitTurning = [];
    this.input = undefined;
    this.steps = [];
    this.progress = () => {};
  }
}
