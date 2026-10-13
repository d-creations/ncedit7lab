import type { WebGLRenderer } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import type { DeepReadonly } from '@services/tools/SimulationMetadata';
import type { SimulationInput } from '../shared/SimulationTypes';
import {
  MaterialReplaySession,
  type ReplayWorker,
} from '../strategies/cpu-hybrid/MaterialReplaySession';
import {
  GpuMaterialReplaySession,
  type GpuReplayFrame,
} from '../strategies/gpu-dexel/GpuMaterialReplaySession';
import type { MaterialReplayStrategy, ReplayProgress } from './MaterialReplayStrategy';

export interface ReplayStrategyOptions {
  runId: string;
  gpuEnabled: boolean;
  renderer?: WebGLRenderer | WebGPURenderer;
  device?: GPUDevice;
  gpuUnavailableReason?: string;
  finePitchMm: number;
  residentBytes: number;
  isCurrent(strategy: MaterialReplayStrategy): boolean;
  onFallback(reason: string): void;
  onRefined(frame: GpuReplayFrame, strategy: MaterialReplayStrategy): void;
  onRefinementError(error: Error, strategy: MaterialReplayStrategy): void;
  createWorker?: () => ReplayWorker;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Owns backend replacement so the view retains one identity across a GPU-to-CPU fallback. */
export function createReplayStrategy(options: ReplayStrategyOptions): MaterialReplayStrategy {
  const createCpu = () => new MaterialReplaySession(options.runId, options.createWorker);
  let selected: MaterialReplayStrategy;
  let cancelled = false;
  let request = 0;
  let input: DeepReadonly<SimulationInput> | undefined;
  let steps: readonly number[] = [];
  const current = () => !cancelled && options.isCurrent(strategy);
  const fallback = (error: unknown, operation: 'start' | 'seek', token: number) => {
    if (selected.backend !== 'webgpu-dexel' || isAbort(error) || !current() || token !== request)
      throw error;
    const reason =
      error instanceof Error
        ? error.message
        : operation === 'start'
          ? 'GPU stock initialization failed'
          : 'GPU replay failure';
    if (operation === 'start') console.warn('GPU stock unavailable; using CPU simulation:', error);
    else console.error('GPU replay failed; switching to CPU:', error);
    selected.cancel();
    selected = createCpu();
    options.onFallback(reason);
  };
  const strategy: MaterialReplayStrategy = {
    runId: options.runId,
    get backend() {
      return selected.backend;
    },
    get computing() {
      return selected.computing;
    },
    async start(captured, timeline, progress: ReplayProgress = () => {}, prepareFinal = false) {
      if (cancelled) throw new DOMException('Material replay cancelled', 'AbortError');
      input = captured;
      steps = [...timeline];
      const token = ++request;
      try {
        return await selected.start(captured, steps, progress, prepareFinal);
      } catch (error) {
        fallback(error, 'start', token);
        return selected.start(captured, steps, progress, prepareFinal);
      }
    },
    async seek(position) {
      if (cancelled) throw new DOMException('Material replay cancelled', 'AbortError');
      const token = ++request;
      try {
        return await selected.seek(position);
      } catch (error) {
        if (!input) throw error;
        fallback(error, 'seek', token);
        await selected.start(input, steps);
        if (!current() || token !== request)
          throw new DOMException('Replay seek superseded', 'AbortError');
        return selected.seek(position);
      }
    },
    cancel() {
      cancelled = true;
      request++;
      selected.cancel();
    },
  };
  if (
    options.gpuEnabled &&
    options.renderer instanceof WebGPURenderer &&
    options.device &&
    !options.gpuUnavailableReason
  ) {
    const gpu = new GpuMaterialReplaySession(options.runId, options.renderer, options.device, {
      finePitchMm: options.finePitchMm,
      residentBytes: options.residentBytes,
      onRefined: (frame) => {
        if (selected === gpu && current()) options.onRefined(frame, strategy);
      },
      onRefinementError: (error) => {
        if (selected === gpu && current()) options.onRefinementError(error, strategy);
      },
    });
    selected = gpu;
  } else {
    if (options.gpuEnabled)
      options.onFallback(
        options.gpuUnavailableReason ?? 'WebGPU compute is not available in this view',
      );
    selected = createCpu();
  }
  return strategy;
}
