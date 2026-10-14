import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebGPURenderer } from 'three/webgpu';
import type { ReplayFrame } from '../../strategies/cpu-hybrid/MaterialReplayEngine';
import type {
  GpuReplayFrame,
  GpuReplayOptions,
} from '../../strategies/gpu-dexel/GpuMaterialReplaySession';
import { SimulationCapabilityError, type SimulationInput } from '../../shared/SimulationTypes';
import type { MaterialReplayStrategy } from '../MaterialReplayStrategy';
import { createReplayStrategy, type ReplayStrategyOptions } from '../createReplayStrategy';

const lifecycle = vi.hoisted(() => ({
  cpuStart: vi.fn<MaterialReplayStrategy['start']>(),
  cpuSeek: vi.fn<MaterialReplayStrategy['seek']>(),
  cpuCancel: vi.fn(),
  cpuConstruct: vi.fn(),
  gpuStart: vi.fn<MaterialReplayStrategy['start']>(),
  gpuSeek: vi.fn<MaterialReplayStrategy['seek']>(),
  gpuCancel: vi.fn(),
  gpuOptions: vi.fn<(options: GpuReplayOptions) => void>(),
}));

vi.mock('three/webgpu', () => ({ WebGPURenderer: class {} }));
vi.mock('../../strategies/cpu-hybrid/MaterialReplaySession', () => ({
  MaterialReplaySession: class {
    readonly backend = 'cpu-hybrid';
    readonly computing = false;
    constructor(readonly runId: string) {
      lifecycle.cpuConstruct(runId);
    }
    start = lifecycle.cpuStart;
    seek = lifecycle.cpuSeek;
    cancel = lifecycle.cpuCancel;
  },
}));
vi.mock('../../strategies/gpu-dexel/GpuMaterialReplaySession', () => ({
  GpuMaterialReplaySession: class {
    readonly backend = 'hybrid-turning';
    readonly computing = true;
    constructor(
      readonly runId: string,
      _renderer: WebGPURenderer,
      _device: GPUDevice,
      options: GpuReplayOptions,
    ) {
      lifecycle.gpuOptions(options);
    }
    start = lifecycle.gpuStart;
    seek = lifecycle.gpuSeek;
    cancel = lifecycle.gpuCancel;
  },
}));

const input: SimulationInput = {
  algorithmVersion: 2,
  stock: { type: 'box', width: 2, height: 2, depth: 2 },
  binding: {
    frameId: 'workpiece:test',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    spindleOrigin: [0, 0, 0],
    spindleAxis: [0, 0, 1],
  },
  resolutionMm: 0.05,
  motions: [],
};
const cpuFrame: ReplayFrame = {
  backend: 'cpu-hybrid',
  position: 0,
  requestedPosition: 0,
  total: 3,
  replace: true,
  chunks: [],
  stockToWorkpiece: [],
  processedMotions: 0,
  removedCells: 0,
  remainingCells: 0,
  elapsedMs: 0,
  subtractionMs: 0,
  meshingMs: 0,
  appliedMotions: 0,
  checkpointCount: 0,
  checkpointBytes: 0,
  skippedCheckpoints: 0,
  evictedCheckpoints: 0,
  peakStockBytes: 0,
};
const gpuFrame: GpuReplayFrame = {
  backend: 'webgpu-dexel',
  position: 0,
  requestedPosition: 0,
  total: 3,
  processedMotions: 0,
  newMotions: 0,
  phase: 'coarse',
  pitchMm: 0.1,
  elapsedMs: 0,
  estimatedBytes: 0,
  cacheHit: false,
  stock: Object.create(null),
};
const device: GPUDevice = Object.create(null);

function options(): ReplayStrategyOptions {
  return {
    runId: 'run:test',
    gpuEnabled: true,
    renderer: new WebGPURenderer(),
    device,
    finePitchMm: 0.02,
    residentBytes: 123,
    isCurrent: vi.fn().mockReturnValue(true),
    onFallback: vi.fn(),
    onRefined: vi.fn(),
    onRefinementError: vi.fn(),
  };
}

describe('replay strategy selection and fallback ownership', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    lifecycle.cpuStart.mockResolvedValue(cpuFrame);
    lifecycle.cpuSeek.mockResolvedValue(cpuFrame);
    lifecycle.gpuStart.mockResolvedValue(gpuFrame);
    lifecycle.gpuSeek.mockResolvedValue(gpuFrame);
  });

  it('selects CPU explicitly without a GPU failure notice', async () => {
    const config = { ...options(), gpuEnabled: false };
    const strategy = createReplayStrategy(config);
    expect(strategy.runId).toBe(config.runId);
    expect(strategy.backend).toBe('cpu-hybrid');
    expect(await strategy.start(input, [0, 1, 2])).toBe(cpuFrame);
    expect(config.onFallback).not.toHaveBeenCalled();
    expect(lifecycle.gpuOptions).not.toHaveBeenCalled();
  });

  it.each(['renderer', 'device', 'loss'])('reports unavailable GPU compute (%s)', (reason) => {
    const config = options();
    if (reason === 'renderer') config.renderer = undefined;
    if (reason === 'device') config.device = undefined;
    if (reason === 'loss') config.gpuUnavailableReason = 'GPU device lost';
    const strategy = createReplayStrategy(config);
    expect(strategy.backend).toBe('cpu-hybrid');
    expect(config.onFallback).toHaveBeenCalledWith(
      reason === 'loss' ? 'GPU device lost' : 'WebGPU compute is not available in this view',
    );
  });

  it('preserves GPU pitch, resident budget, refinement, progress and final preparation', async () => {
    const config = options();
    const strategy = createReplayStrategy(config);
    const progress = vi.fn();
    expect(strategy.computing).toBe(true);
    expect(await strategy.start(input, [0, 1, 2], progress, true)).toBe(gpuFrame);
    expect(lifecycle.gpuStart).toHaveBeenCalledWith(input, [0, 1, 2], progress, true);
    const hooks = lifecycle.gpuOptions.mock.calls[0][0];
    expect(hooks.finePitchMm).toBe(0.02);
    expect(hooks.residentBytes).toBe(123);
    hooks.onRefined(gpuFrame);
    const failure = new Error('fine refinement unavailable');
    hooks.onRefinementError(failure);
    expect(config.onRefined).toHaveBeenCalledWith(gpuFrame, strategy);
    expect(config.onRefinementError).toHaveBeenCalledWith(failure, strategy);
    expect(config.onFallback).not.toHaveBeenCalled();
  });

  it('replaces failed GPU startup inside the retained lifecycle identity', async () => {
    const config = { ...options(), finePitchMm: 0.1 };
    const failure = new SimulationCapabilityError('GPU capacity exceeded');
    lifecycle.gpuStart.mockRejectedValue(failure);
    const strategy = createReplayStrategy(config);
    const progress = vi.fn();
    await expect(strategy.start(input, [0, 1, 2], progress, true)).resolves.toBe(cpuFrame);
    expect(strategy.backend).toBe('cpu-hybrid');
    expect(strategy.computing).toBe(false);
    expect(config.onFallback).toHaveBeenCalledWith(failure.message);
    expect(lifecycle.gpuCancel).toHaveBeenCalledOnce();
    expect(lifecycle.cpuStart).toHaveBeenCalledWith(input, [0, 1, 2], progress, true);
  });

  it('initializes CPU from the original run then seeks after GPU/device failure', async () => {
    const config = { ...options(), finePitchMm: 0.1 };
    const strategy = createReplayStrategy(config);
    await strategy.start(input, [0, 1, 2], vi.fn(), true);
    lifecycle.gpuSeek.mockRejectedValue(new SimulationCapabilityError('GPU device lost'));
    await expect(strategy.seek(2)).resolves.toBe(cpuFrame);
    expect(lifecycle.cpuConstruct).toHaveBeenCalledWith(config.runId);
    expect(lifecycle.cpuStart).toHaveBeenCalledWith(input, [0, 1, 2]);
    expect(lifecycle.cpuSeek).toHaveBeenCalledWith(2);
    expect(config.onFallback).toHaveBeenCalledWith('GPU device lost');
    expect(strategy.backend).toBe('cpu-hybrid');
    const hooks = lifecycle.gpuOptions.mock.calls[0][0];
    hooks.onRefined(gpuFrame);
    hooks.onRefinementError(new Error('late refinement'));
    expect(config.onRefined).not.toHaveBeenCalled();
    expect(config.onRefinementError).not.toHaveBeenCalled();
  });

  it.each(['start', 'seek'] as const)(
    'does not fall back on %s cancellation',
    async (operation) => {
      const config = options();
      const strategy = createReplayStrategy(config);
      const failure = new DOMException('cancelled', 'AbortError');
      if (operation === 'seek') {
        await strategy.start(input, [0, 1, 2]);
        lifecycle.gpuSeek.mockRejectedValue(failure);
      } else lifecycle.gpuStart.mockRejectedValue(failure);
      await expect(
        operation === 'start' ? strategy.start(input, [0, 1, 2]) : strategy.seek(1),
      ).rejects.toBe(failure);
      expect(config.onFallback).not.toHaveBeenCalled();
      expect(lifecycle.cpuConstruct).not.toHaveBeenCalled();
    },
  );

  it('ignores stale-run failures and refinement callbacks', async () => {
    const config = options();
    config.isCurrent = () => false;
    const strategy = createReplayStrategy(config);
    const failure = new Error('obsolete GPU work');
    lifecycle.gpuStart.mockRejectedValue(failure);
    await expect(strategy.start(input, [0, 1, 2])).rejects.toBe(failure);
    const hooks = lifecycle.gpuOptions.mock.calls[0][0];
    hooks.onRefined(gpuFrame);
    hooks.onRefinementError(failure);
    expect(config.onFallback).not.toHaveBeenCalled();
    expect(config.onRefined).not.toHaveBeenCalled();
    expect(config.onRefinementError).not.toHaveBeenCalled();
  });

  it('does not replace a newer seek for an obsolete GPU failure', async () => {
    const config = options();
    const strategy = createReplayStrategy(config);
    await strategy.start(input, [0, 1, 2]);
    let fail: (error: Error) => void = () => {};
    lifecycle.gpuSeek.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const old = strategy.seek(1);
    const failure = new Error('obsolete seek failure');
    const rejected = expect(old).rejects.toBe(failure);
    await strategy.seek(2);
    fail(failure);
    await rejected;
    expect(config.onFallback).not.toHaveBeenCalled();
    expect(lifecycle.cpuConstruct).not.toHaveBeenCalled();
  });

  it('cancels pending work and suppresses fallback and late refinement', async () => {
    const config = options();
    const strategy = createReplayStrategy(config);
    let fail: (error: Error) => void = () => {};
    lifecycle.gpuStart.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const pending = strategy.start(input, [0, 1, 2]);
    const failure = new Error('late GPU failure');
    const rejected = expect(pending).rejects.toBe(failure);
    strategy.cancel();
    fail(failure);
    await rejected;
    lifecycle.gpuOptions.mock.calls[0][0].onRefined(gpuFrame);
    expect(lifecycle.gpuCancel).toHaveBeenCalledOnce();
    expect(config.onFallback).not.toHaveBeenCalled();
    expect(config.onRefined).not.toHaveBeenCalled();
    await expect(strategy.seek(1)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(strategy.start(input, [0, 1, 2])).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not install an obsolete target after CPU fallback initialization', async () => {
    const strategy = createReplayStrategy({ ...options(), finePitchMm: 0.1 });
    await strategy.start(input, [0, 1, 2]);
    lifecycle.gpuSeek.mockRejectedValue(new SimulationCapabilityError('GPU device lost'));
    let finish: (frame: ReplayFrame) => void = () => {};
    lifecycle.cpuStart.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = strategy.seek(1);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(lifecycle.cpuStart).toHaveBeenCalledOnce());
    await strategy.seek(2);
    finish(cpuFrame);
    await rejected;
    expect(lifecycle.cpuSeek).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('propagates CPU errors without recursive fallback', async () => {
    const config = { ...options(), gpuEnabled: false };
    const strategy = createReplayStrategy(config);
    const failure = new Error('CPU worker unavailable');
    lifecycle.cpuStart.mockRejectedValue(failure);
    await expect(strategy.start(input, [0, 1, 2])).rejects.toBe(failure);
    expect(config.onFallback).not.toHaveBeenCalled();
    expect(lifecycle.cpuConstruct).toHaveBeenCalledOnce();
  });

  it.each(['start', 'seek'] as const)(
    'never reduces requested detail on %s failure',
    async (operation) => {
      const config = options();
      const strategy = createReplayStrategy(config);
      const failure = new SimulationCapabilityError('3D transition exceeds memory');
      if (operation === 'seek') {
        await strategy.start(input, [0, 1, 2]);
        lifecycle.gpuSeek.mockRejectedValue(failure);
      } else lifecycle.gpuStart.mockRejectedValue(failure);
      await expect(
        operation === 'start' ? strategy.start(input, [0, 1, 2]) : strategy.seek(2),
      ).rejects.toBe(failure);
      expect(lifecycle.cpuConstruct).not.toHaveBeenCalled();
      expect(config.onFallback).not.toHaveBeenCalled();
    },
  );

  it('reports unavailable fine detail instead of starting a coarser CPU run', async () => {
    const config = { ...options(), device: undefined };
    const strategy = createReplayStrategy(config);
    await expect(strategy.start(input, [0])).rejects.toThrow('requested detail is not reduced');
    expect(lifecycle.cpuStart).not.toHaveBeenCalled();
  });

  it('does not hide unexpected programming errors behind CPU fallback', async () => {
    const config = { ...options(), finePitchMm: 0.1 };
    lifecycle.gpuStart.mockRejectedValue(new TypeError('broken lifecycle'));
    const strategy = createReplayStrategy(config);
    await expect(strategy.start(input, [0])).rejects.toThrow('broken lifecycle');
    expect(config.onFallback).not.toHaveBeenCalled();
    expect(lifecycle.cpuConstruct).not.toHaveBeenCalled();
  });
});
