import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { DeepReadonly } from '../tools/SimulationMetadata';
import { compileGpuSweeps, GPU_SWEEP_STRIDE } from './GpuSweepCompiler';
import { batchRemovalMotions } from './MaterialRemovalEngine';
import { GpuDexelStock } from './GpuDexelStock';
import { createDexelLayout, DEXEL_MEMORY_BYTES } from './DexelLayout';
import { materialSize, stockPlacement } from './SimulationTransforms';
import {
  SimulationCapabilityError,
  type RemovalStop,
  type SimulationInput,
} from './SimulationTypes';

export interface GpuReplayFrame {
  backend: 'webgpu-dexel';
  position: number;
  requestedPosition: number;
  total: number;
  executionStep?: number;
  processedMotions: number;
  stop?: RemovalStop;
  phase: 'coarse' | 'fine';
  pitchMm: number;
  elapsedMs: number;
  estimatedBytes: number;
  cacheHit: boolean;
  stock: GpuDexelStock;
}

export interface GpuReplayOptions {
  finePitchMm: number;
  refinementDelayMs?: number;
  residentBytes?: number;
  onRefined(frame: GpuReplayFrame): void;
  onRefinementError(error: Error): void;
}

interface PendingSeek {
  position: number;
  resolve(frame: GpuReplayFrame): void;
  reject(error: Error): void;
}

/** Navigation always selects an executed prefix; refinement replays that prefix at a new pitch. */
export class GpuMaterialReplaySession {
  readonly backend = 'webgpu-dexel';
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
  private progress: (processed: number, total: number) => void = () => {};

  constructor(
    readonly runId: string,
    private readonly renderer: WebGPURenderer,
    private readonly device: GPUDevice,
    private readonly options: GpuReplayOptions,
  ) {
    if (
      !Number.isFinite(options.finePitchMm) ||
      options.finePitchMm < 0.001 ||
      options.finePitchMm > 5 ||
      !Number.isSafeInteger(options.refinementDelayMs ?? 350) ||
      (options.refinementDelayMs ?? 350) < 0 ||
      !Number.isSafeInteger(options.residentBytes ?? 0) ||
      (options.residentBytes ?? 0) < 0 ||
      (options.residentBytes ?? 0) > DEXEL_MEMORY_BYTES
    ) {
      throw new SimulationCapabilityError(
        'GPU fine pitch must be between 0.001 and 5 mm and the idle delay must be nonnegative',
      );
    }
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
      compileGpuSweeps(input);
      createDexelLayout(
        new THREE.Vector3(...materialSize(input.stock)),
        Math.max(0.1, this.options.finePitchMm),
      );
      return this.seek(prepareFinal ? steps.length : 0);
    } catch (error) {
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
      const frame = await this.frame(pending.position, this.fine.has(target) ? 'fine' : 'coarse');
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
  ): Promise<GpuReplayFrame> {
    const input = this.input!;
    const position = Math.min(requestedPosition, this.safePosition);
    const step = position ? this.steps[position - 1] : -1;
    const motionCount = input.motions.filter((motion) => motion.executionStep <= step).length;
    const pitch =
      phase === 'fine' ? this.options.finePitchMm : Math.max(0.1, this.options.finePitchMm);
    const cache = phase === 'fine' ? this.fine : this.coarse;
    let stock = cache.get(position),
      elapsedMs = 0;
    const cacheHit = !!stock;
    if (!stock) {
      const motions = input.motions.filter((motion) => motion.executionStep <= step);
      const merged = batchRemovalMotions(motions).map((batch) => batch.motion);
      const sweeps = compileGpuSweeps({ ...input, motions: merged });
      const size = new THREE.Vector3(...materialSize(input.stock));
      const layout = createDexelLayout(size, pitch);
      const indexEntries = Math.max(1, layout.tiles * sweeps.length);
      const staging = layout.tiles * 96 + indexEntries * 16;
      const records = sweeps.length * (GPU_SWEEP_STRIDE * 12 + 320);
      this.makeRoom(layout.estimatedBytes + staging + records + 4096);
      stock = new GpuDexelStock(
        this.renderer,
        this.device,
        size,
        pitch,
        input.stock.type === 'cylinder',
        sweeps,
        stockPlacement(input.stock, input.binding),
      );
      try {
        this.makeRoom(stock.estimatedBytes);
        this.owned.add(stock);
        this.progress(0, motionCount);
        const calculationEpoch = this.epoch;
        elapsedMs = await stock.calculate(
          sweeps.length,
          () => this.cancelled || calculationEpoch !== this.epoch,
        );
        if (this.cancelled) throw new DOMException('GPU replay cancelled', 'AbortError');
        this.progress(motionCount, motionCount);
        cache.set(position, stock);
        stock.group.userData.releaseGpuStock = () => {
          if (this.cancelled) {
            cache.delete(position);
            this.owned.delete(stock!);
            stock!.dispose();
          }
        };
      } catch (error) {
        this.owned.delete(stock);
        stock.dispose();
        throw error;
      }
    } else {
      cache.delete(position);
      cache.set(position, stock);
    }
    return {
      backend: 'webgpu-dexel',
      position,
      requestedPosition,
      total: this.steps.length,
      executionStep: position ? step : undefined,
      processedMotions: motionCount,
      stop:
        requestedPosition > this.safePosition || position === this.steps.length
          ? input.stop
          : undefined,
      phase,
      pitchMm: pitch,
      elapsedMs,
      cacheHit,
      stock,
      estimatedBytes: [...this.owned].reduce(
        (sum, entry) => sum + entry.estimatedBytes,
        this.options.residentBytes ?? 0,
      ),
    };
  }

  private makeRoom(extra: number): void {
    let bytes = [...this.owned].reduce(
      (sum, stock) => sum + stock.estimatedBytes,
      this.options.residentBytes ?? 0,
    );
    for (const cache of [this.fine, this.coarse]) {
      for (const [position, stock] of cache) {
        if (bytes + extra <= DEXEL_MEMORY_BYTES && cache.size < (cache === this.fine ? 1 : 4))
          break;
        if (stock.group.parent) continue;
        cache.delete(position);
        this.owned.delete(stock);
        bytes -= stock.estimatedBytes;
        stock.dispose();
      }
    }
    if (bytes + extra > DEXEL_MEMORY_BYTES)
      throw new SimulationCapabilityError(
        'GPU replay/refinement cannot coexist with displayed stock within the 256 MiB CPU/GPU buffer estimate. Coarse stock is retained; choose a larger fine pitch.',
      );
  }

  cancel(): void {
    this.cancelled = true;
    this.epoch++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.queued?.reject(new DOMException('GPU replay cancelled', 'AbortError'));
    this.queued = undefined;
    if (!this.running) this.releaseUnattached();
  }

  private releaseUnattached(): void {
    for (const stock of this.owned)
      if (!stock.group.parent) {
        this.owned.delete(stock);
        stock.dispose();
      }
    this.coarse.clear();
    this.fine.clear();
  }
}
