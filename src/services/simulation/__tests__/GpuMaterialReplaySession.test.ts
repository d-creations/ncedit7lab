// @vitest-environment jsdom
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GpuMaterialReplaySession } from '../GpuMaterialReplaySession';
import * as sweepCompiler from '../GpuSweepCompiler';
import {
  createDexelLayout,
  GpuDexelIntervalOverflowError,
  type DexelIntervalCapacity,
} from '../DexelLayout';
import type { SimulationInput } from '../SimulationTypes';
import { GpuDexelHistory } from '../GpuDexelHistory';

const { calculate, copyFrom, restoreHistory, takeHistory, created } = vi.hoisted(() => ({
  calculate: vi.fn(),
  copyFrom: vi.fn(),
  restoreHistory: vi.fn(),
  takeHistory: vi.fn(),
  created: [] as {
    group: THREE.Group;
    dispose: ReturnType<typeof vi.fn>;
    pitch: number;
    intervalCapacity: DexelIntervalCapacity;
  }[],
}));
vi.mock('../GpuDexelStock', async () => {
  const THREE = await import('three');
  const { createDexelLayout } = await import('../DexelLayout');
  return {
    GpuDexelStock: class {
      group = new THREE.Group();
      estimatedBytes: number;
      layout: ReturnType<typeof createDexelLayout>;
      tileSlots: Uint32Array;
      dispose = vi.fn();
      calculate = calculate;
      copyFrom = copyFrom;
      restoreHistory = restoreHistory;
      takeHistory = takeHistory;
      releasePreparation = vi.fn();
      constructor(
        _renderer: unknown,
        _device: unknown,
        size: THREE.Vector3,
        public pitch: number,
        _cylinder: boolean,
        _sweeps: readonly sweepCompiler.CompiledGpuSweep[],
        _placement: THREE.Matrix4,
        public intervalCapacity: DexelIntervalCapacity = 16,
        sparse?: { retainedTiles?: Uint32Array },
      ) {
        this.layout = createDexelLayout(
          size,
          pitch,
          intervalCapacity,
          sparse
            ? { bounds: _sweeps.map((sweep) => sweep.bounds), retainedTiles: sparse.retainedTiles }
            : undefined,
        );
        this.estimatedBytes = this.layout.estimatedBytes;
        this.tileSlots = new Uint32Array(this.layout.tiles).fill(0xffffffff);
        this.layout.storedTiles.forEach((tile, slot) => {
          this.tileSlots[tile] = slot;
        });
        created.push(this);
      }
    },
  };
});

const input: SimulationInput = {
  algorithmVersion: 2,
  stock: { type: 'box', width: 2, height: 2, depth: 2 },
  resolutionMm: 0.05,
  binding: {
    frameId: 'workpiece:test',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    spindleOrigin: [0, 0, 0],
    spindleAxis: [0, 0, 1],
  },
  motions: [],
};

describe('progressive GPU replay lifecycle', () => {
  const sessions: GpuMaterialReplaySession[] = [];
  const refined = vi.fn(),
    failed = vi.fn();
  function session(): GpuMaterialReplaySession {
    const result = new GpuMaterialReplaySession('run', new WebGPURenderer(), {} as GPUDevice, {
      finePitchMm: 0.02,
      onRefined: refined,
      onRefinementError: failed,
    });
    sessions.push(result);
    return result;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    calculate.mockReset().mockResolvedValue(5);
    copyFrom.mockReset().mockResolvedValue(3);
    restoreHistory.mockReset().mockResolvedValue(2);
    takeHistory.mockReset();
    created.length = 0;
    refined.mockClear();
    failed.mockClear();
  });
  afterEach(() => {
    sessions.forEach((entry) => entry.cancel());
    sessions.length = 0;
    vi.useRealTimers();
  });

  it('shows coarse completed stock first and recalculates fine stock after idle', async () => {
    const replay = session();
    const first = await replay.start(input, [0, 1, 2], () => {}, true);
    expect(first.phase).toBe('coarse');
    expect(first.position).toBe(3);
    expect(first.pitchMm).toBe(0.1);
    expect(created[0].intervalCapacity).toBe(16);
    expect(calculate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(350);
    expect(refined).toHaveBeenCalledOnce();
    expect(refined.mock.calls[0][0]).toMatchObject({ phase: 'fine', pitchMm: 0.02, position: 3 });
    expect(calculate).toHaveBeenCalledTimes(2);
  });
  it('cancels an obsolete idle refinement when the requested occurrence changes', async () => {
    const replay = session();
    await replay.start(input, [0, 1, 2], () => {}, true);
    await vi.advanceTimersByTimeAsync(200);
    await replay.seek(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(refined).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(refined.mock.calls[0][0].position).toBe(1);
  });
  it('restores a cached GPU prefix without subtraction or stock readback', async () => {
    const replay = session();
    const final = await replay.start(input, [0, 1], () => {}, true);
    await replay.seek(0);
    const back = await replay.seek(2);
    expect(back.stock).toBe(final.stock);
    expect(back.cacheHit).toBe(true);
    expect(calculate).toHaveBeenCalledTimes(2);
  });
  it('keeps coarse stock and surfaces a fine allocation failure without reducing requested detail', async () => {
    const replay = session();
    const huge = {
      ...input,
      stock: { type: 'box' as const, width: 1000, height: 1000, depth: 1000 },
    };
    expect(() =>
      createDexelLayout(new THREE.Vector3(1000, 1000, 1000), 0.02, 16, { bounds: [] }),
    ).toThrow();
    await replay.start(huge, [0], () => {}, true);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(350);
    expect(failed).toHaveBeenCalledOnce();
    expect(refined).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it('retains displayed stock on cancellation and releases it when the plot removes it', async () => {
    const replay = session();
    const frame = await replay.start(input, [0], () => {}, true);
    const scene = new THREE.Scene();
    scene.add(frame.stock.group);
    expect(calculate.mock.calls[0][1]()).toBe(false);
    replay.cancel();
    expect(calculate.mock.calls[0][1]()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refined).not.toHaveBeenCalled();
    expect(created[0].dispose).not.toHaveBeenCalled();
    scene.remove(frame.stock.group);
    frame.stock.group.userData.releaseGpuStock();
    expect(created[0].dispose).toHaveBeenCalledOnce();
    await expect(replay.seek(0)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('never applies occurrences at or after an unsupported stop', async () => {
    const replay = session();
    const stopped = { ...input, stop: { executionStep: 2, message: 'unsupported command' } };
    const frame = await replay.start(stopped, [0, 1, 2, 3], () => {}, true);
    expect(frame.position).toBe(2);
    expect(frame.requestedPosition).toBe(4);
    expect(frame.stop?.message).toBe('unsupported command');
  });
  it('coalesces queued navigation and ignores an obsolete in-flight result', async () => {
    let finish!: (ms: number) => void;
    calculate.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    const replay = session();
    const initial = replay.start(input, [0, 1, 2], () => {}, true);
    expect(calculate.mock.calls[0][1]()).toBe(false);
    const initialFailure = expect(initial).rejects.toMatchObject({ name: 'AbortError' });
    const first = replay.seek(1);
    expect(calculate.mock.calls[0][1]()).toBe(true);
    const firstFailure = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const latest = replay.seek(2);
    finish(5);
    await initialFailure;
    await firstFailure;
    expect((await latest).position).toBe(2);
    expect(calculate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(350);
    expect(refined.mock.calls[0][0].position).toBe(2);
  });
  it('never publishes fine work that completed after a newer navigation request', async () => {
    const replay = session();
    await replay.start(input, [0, 1, 2], () => {}, true);
    let finish!: (ms: number) => void;
    calculate.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(350);
    const latest = replay.seek(1);
    finish(5);
    expect((await latest).position).toBe(1);
    expect(refined).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(350);
    expect(refined.mock.calls[0][0].position).toBe(1);
  });
  it('reuses compiled sweeps while preserving every execution boundary and excluding future cuts', async () => {
    const compile = vi.spyOn(sweepCompiler, 'compileGpuSweeps');
    const pose = (z: number) => ({
      position: [0, 0, z] as const,
      orientation: [0, 0, 0, 1] as const,
      frameId: 'workpiece:test',
      reference: 'millingTip' as const,
    });
    const tool = {
      toolNumber: 1,
      description: 'Axial flat mill',
      cutting: [{ type: 'endMill' as const, diameter: 0.5, length: 1 }],
    };
    const setup: SimulationInput = {
      ...input,
      motions: [
        { mode: 'milling', tool, start: pose(-1), end: pose(0), executionStep: 1 },
        { mode: 'milling', tool, start: pose(0), end: pose(1), executionStep: 2 },
      ],
    };
    const replay = session();
    const final = await replay.start(setup, [1, 2], () => {}, true);
    expect(final.processedMotions).toBe(2);
    expect(calculate.mock.calls[0][0]).toBe(2);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile.mock.calls[0][0].motions).toHaveLength(2);
    const first = await replay.seek(1);
    expect(first.processedMotions).toBe(1);
    expect(first.executionStep).toBe(1);
    expect(calculate.mock.calls[1][0]).toBe(1);
    expect(compile).toHaveBeenCalledTimes(1);
    compile.mockRestore();
  });
  it('immediately reuses a retained fine state rather than downgrading it on a warm jump', async () => {
    const replay = session();
    await replay.start(input, [0, 1], () => {}, true);
    await vi.advanceTimersByTimeAsync(350);
    const fine = refined.mock.calls[0][0];
    const back = await replay.seek(2);
    expect(back.phase).toBe('fine');
    expect(back.stock).toBe(fine.stock);
    expect(back.cacheHit).toBe(true);
    expect(calculate).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid timeline positions', async () => {
    const replay = session();
    await replay.start(input, [0, 1]);
    await expect(replay.seek(-1)).rejects.toThrow(/timeline/);
    await expect(replay.seek(3)).rejects.toThrow(/timeline/);
  });
  function cuttingInput(): SimulationInput {
    const tool = {
      toolNumber: 1,
      description: 'Replay mill',
      cutting: [{ type: 'endMill' as const, diameter: 0.5, length: 1 }],
    };
    const pose = (x: number) => ({
      position: [x, 0, -1] as const,
      orientation: [0, 0, 0, 1] as const,
      frameId: 'workpiece:test',
      reference: 'millingTip' as const,
    });
    return {
      ...input,
      motions: [1, 2, 3].map((executionStep) => ({
        executionStep,
        tool,
        mode: 'milling',
        start: pose(-0.5),
        end: pose(executionStep * 0.1),
      })),
    };
  }
  function recordedHistory(pitch = 0.1): GpuDexelHistory {
    const spans = new Uint32Array(new Float32Array([-0.25, 0.25]).buffer);
    const sweeps = sweepCompiler.compileGpuSweeps(cuttingInput());
    const layout = createDexelLayout(new THREE.Vector3(2, 2, 2), pitch);
    return new GpuDexelHistory(
      new Uint32Array([0, 0, ...spans, 1024, 4, ...spans]),
      layout.rays,
      sweeps,
    );
  }
  it('captures history with final stock and restores an uncached backward prefix without cutter calculation', async () => {
    const replay = session();
    const history = recordedHistory();
    takeHistory.mockReturnValueOnce(history);
    const final = await replay.start(cuttingInput(), [1, 2, 3], () => {}, true);
    expect(final.historyThrough).toBe(3);
    const backward = await replay.seek(1);
    expect(backward).toMatchObject({ historyHit: true, newMotions: 0, historyThrough: 3 });
    expect(calculate).toHaveBeenCalledOnce();
    expect(copyFrom).not.toHaveBeenCalled();
    expect(restoreHistory.mock.calls[0]).toEqual([history, 1, expect.any(Function), -1]);
    const forward = await replay.seek(2);
    expect(forward).toMatchObject({ historyHit: true, reusedPosition: 1, newMotions: 0 });
    expect(restoreHistory.mock.calls[1][3]).toBe(1);
    expect(calculate).toHaveBeenCalledOnce();
    replay.cancel();
  });
  it('prepares removal-work checkpoints including early positions without cutter work or progress resets', async () => {
    const replay = session();
    const progress = vi.fn();
    const history = recordedHistory();
    takeHistory.mockReturnValueOnce(history);
    const final = await replay.start(
      cuttingInput(),
      Array.from({ length: 96 }, (_, i) => i + 1),
      progress,
      true,
    );
    expect(final.position).toBe(96);
    expect(calculate).toHaveBeenCalledOnce();
    expect(restoreHistory).toHaveBeenCalledTimes(2);
    expect(restoreHistory.mock.calls.map(([, step]) => step)).toEqual([1, 2]);
    expect(progress.mock.calls).toEqual([
      [0, 3],
      [3, 3],
    ]);
    expect((await replay.seek(1)).cacheHit).toBe(true);
    expect((await replay.seek(2)).cacheHit).toBe(true);
    const dispose = vi.spyOn(history, 'dispose');
    replay.cancel();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('counts a shared reserved arena only once across resident stocks', async () => {
    const replay = session();
    const first = await replay.start(input, [1, 2], () => {}, true);
    const second = await replay.seek(0);
    const resident = Reflect.get(replay, 'residentBytes') as () => number;
    const before = resident.call(replay);
    const arena = { estimatedBytes: 16384 };
    for (const stock of [first.stock, second.stock]) {
      Reflect.set(stock, 'tileArena', arena);
      stock.estimatedBytes += arena.estimatedBytes;
    }
    expect(resident.call(replay)).toBe(before + arena.estimatedBytes);
  });
  it('prefers retaining an early workload checkpoint over ordinary frames and later checkpoints', async () => {
    const replay = session();
    takeHistory.mockReturnValueOnce(recordedHistory());
    const final = await replay.start(
      cuttingInput(),
      Array.from({ length: 96 }, (_, i) => i + 1),
      () => {},
      true,
    );
    const scene = new THREE.Group();
    scene.add(final.stock.group);
    try {
      await replay.seek(30);
      await replay.seek(40);
      await replay.seek(50);
      const early = await replay.seek(1);
      expect(early.cacheHit).toBe(true);
      expect(final.stock.dispose).not.toHaveBeenCalled();
    } finally {
      scene.remove(final.stock.group);
    }
  });
  it('keeps fine history independent from coarse history and restores at the requested fine pitch', async () => {
    const replay = session();
    const coarseHistory = recordedHistory();
    takeHistory.mockReturnValueOnce(coarseHistory);
    await replay.start(cuttingInput(), [1, 2, 3], () => {}, true);
    const fineHistory = recordedHistory(0.02);
    takeHistory.mockReturnValueOnce(fineHistory);
    await vi.advanceTimersByTimeAsync(350);
    const frame = await replay.seek(1);
    await vi.advanceTimersByTimeAsync(350);
    expect(restoreHistory.mock.calls.map(([history]) => history)).toEqual([fineHistory]);
    expect(frame).toMatchObject({
      phase: 'fine',
      position: 1,
      pitchMm: 0.02,
      historyHit: true,
      newMotions: 0,
    });
    expect(refined).toHaveBeenCalledOnce();
    expect(calculate).toHaveBeenCalledTimes(2);
  });
  it('rejects obsolete history restoration without damaging its retained history', async () => {
    const replay = session();
    const history = recordedHistory();
    const dispose = vi.spyOn(history, 'dispose');
    takeHistory.mockReturnValueOnce(history);
    await replay.start(cuttingInput(), [1, 2, 3], () => {}, true);
    let complete!: (ms: number) => void;
    restoreHistory.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          complete = resolve;
        }),
    );
    const earlier = replay.seek(1);
    const rejection = expect(earlier).rejects.toMatchObject({ name: 'AbortError' });
    const latest = replay.seek(2);
    complete(2);
    await rejection;
    expect((await latest).historyHit).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
    replay.cancel();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('copies the nearest earlier coarse stock and compiles only newly executed motions', async () => {
    const compile = vi.spyOn(sweepCompiler, 'compileGpuSweeps');
    try {
      const replay = session();
      await replay.start(cuttingInput(), [1, 2, 3]);
      const first = await replay.seek(1);
      const second = await replay.seek(2);
      expect(second).toMatchObject({ processedMotions: 2, newMotions: 1, reusedPosition: 1 });
      expect(second.stock).not.toBe(first.stock);
      expect(copyFrom.mock.calls.at(-1)?.[0]).toBe(first.stock);
      expect(calculate.mock.calls.at(-1)?.[0]).toBe(1);
      const third = await replay.seek(3);
      expect(third).toMatchObject({ processedMotions: 3, newMotions: 1, reusedPosition: 2 });
      expect(copyFrom.mock.calls.at(-1)?.[0]).toBe(second.stock);
      expect(calculate.mock.calls.at(-1)?.[0]).toBe(1);
      expect(compile).toHaveBeenCalledOnce();
    } finally {
      compile.mockRestore();
    }
  });
  it('does not replay thousands of old cuts for one adjacent forward step', async () => {
    const setup = cuttingInput();
    const template = setup.motions[0];
    setup.motions = Array.from({ length: 9853 }, (_, index) => ({
      ...template,
      executionStep: index + 1,
      start: { ...template.start, position: [index * 0.00001, 0, -1] },
      end: { ...template.end, position: [(index + 1) * 0.00001, 0, -1] },
    }));
    const compile = vi.spyOn(sweepCompiler, 'compileGpuSweeps');
    try {
      const replay = session();
      await replay.start(
        setup,
        setup.motions.map((motion) => motion.executionStep),
        () => {},
        true,
      );
      await replay.seek(6787);
      const next = await replay.seek(6788);
      expect(next).toMatchObject({ processedMotions: 6788, reusedPosition: 6787, newMotions: 1 });
      expect(calculate.mock.calls.at(-1)?.[0]).toBe(1);
      expect(compile).toHaveBeenCalledOnce();
      expect(copyFrom).toHaveBeenCalledOnce();
    } finally {
      compile.mockRestore();
    }
  });
  it('incrementally refines from fine stock without copying coarse stock or replaying old cuts', async () => {
    const replay = session();
    await replay.start(cuttingInput(), [1, 2, 3]);
    await replay.seek(1);
    await vi.advanceTimersByTimeAsync(350);
    const fine = refined.mock.calls.at(-1)?.[0];
    const copyStart = copyFrom.mock.calls.length;
    await replay.seek(2);
    await vi.advanceTimersByTimeAsync(350);
    const nextFine = refined.mock.calls.at(-1)?.[0];
    expect(nextFine).toMatchObject({
      phase: 'fine',
      pitchMm: 0.02,
      newMotions: 1,
      reusedPosition: 1,
    });
    expect(copyFrom.mock.calls.slice(copyStart).map(([source]) => source.pitch)).toEqual([
      0.1, 0.02,
    ]);
    expect(copyFrom.mock.calls.at(-1)?.[0]).toBe(fine.stock);
  });
  it('does not copy a future stock into a backward cold seek and restores a cached fine state', async () => {
    const replay = session();
    await replay.start(cuttingInput(), [1, 2, 3], () => {}, true);
    await replay.seek(2);
    expect(copyFrom).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(350);
    const earlierFine = refined.mock.calls.at(-1)?.[0];
    await replay.seek(3);
    await vi.advanceTimersByTimeAsync(350);
    const copies = copyFrom.mock.calls.length;
    const restored = await replay.seek(2);
    expect(restored.stock).toBe(earlierFine.stock);
    expect(restored.cacheHit).toBe(true);
    expect(copyFrom).toHaveBeenCalledTimes(copies);
  });
  it('copies non-cutting occurrences without resubtracting or resurrecting stock', async () => {
    const replay = session();
    await replay.start(cuttingInput(), [1, 2, 3, 4]);
    await replay.seek(3);
    const calculations = calculate.mock.calls.length;
    const next = await replay.seek(4);
    expect(next).toMatchObject({ processedMotions: 3, newMotions: 0, reusedPosition: 3 });
    expect(calculate).toHaveBeenCalledTimes(calculations);
    expect(copyFrom).toHaveBeenCalled();
  });
  it('disposes an obsolete copied target while retaining its displayed source', async () => {
    const replay = session();
    await replay.start(cuttingInput(), [1, 2, 3]);
    const source = await replay.seek(1);
    new THREE.Scene().add(source.stock.group);
    copyFrom.mockImplementationOnce(async () => {
      replay.cancel();
      return 1;
    });
    await expect(replay.seek(2)).rejects.toMatchObject({ name: 'AbortError' });
    expect(created[1].dispose).not.toHaveBeenCalled();
    expect(created[2].dispose).toHaveBeenCalledOnce();
  });
  it('restarts an overflowing delta from the immutable source at larger capacity and counts copy time once', async () => {
    const replay = session();
    await replay.start(cuttingInput(), [1, 2, 3]);
    const source = await replay.seek(1);
    copyFrom.mockClear().mockImplementation(async () => {
      vi.advanceTimersByTime(3);
      return 3;
    });
    calculate.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(20);
      throw new GpuDexelIntervalOverflowError(16);
    });
    const next = await replay.seek(2);
    expect(next).toMatchObject({ reusedPosition: 1, newMotions: 1, elapsedMs: 31 });
    expect(copyFrom.mock.calls.map(([stock]) => stock)).toEqual([source.stock, source.stock]);
    expect(created.slice(-2).map((stock) => stock.intervalCapacity)).toEqual([16, 32]);
    expect(created.at(-2)?.dispose).toHaveBeenCalledOnce();
    expect(created[1].dispose).not.toHaveBeenCalled();
  });
  it('retries only interval overflow, releases rejected stocks and caches the successful capacity', async () => {
    calculate
      .mockRejectedValueOnce(new GpuDexelIntervalOverflowError(16))
      .mockRejectedValueOnce(new GpuDexelIntervalOverflowError(32));
    const replay = session();
    const frame = await replay.start(input, [0], () => {}, true);
    expect(created.map((stock) => stock.intervalCapacity)).toEqual([16, 32, 64]);
    expect(created.map((stock) => stock.pitch)).toEqual([0.1, 0.1, 0.1]);
    expect(created[0].dispose).toHaveBeenCalledOnce();
    expect(created[1].dispose).toHaveBeenCalledOnce();
    expect(created[2].dispose).not.toHaveBeenCalled();
    expect(frame.stock).toBe(created[2]);
    expect((await replay.seek(1)).stock).toBe(frame.stock);
    expect(calculate).toHaveBeenCalledTimes(3);
  });
  it('stops at 64 intervals and propagates the capacity failure', async () => {
    calculate.mockRejectedValue(new GpuDexelIntervalOverflowError(64));
    await expect(session().start(input, [0], () => {}, true)).rejects.toThrow(
      /64 material intervals/,
    );
    expect(created.map((stock) => stock.intervalCapacity)).toEqual([16, 32, 64]);
    expect(created.every((stock) => stock.dispose.mock.calls.length === 1)).toBe(true);
  });
  it('adapts fine stock to 32 intervals while preserving displayed coarse stock and fine pitch', async () => {
    const replay = session();
    const coarse = await replay.start(input, [0], () => {}, true);
    new THREE.Scene().add(coarse.stock.group);
    calculate.mockRejectedValueOnce(new GpuDexelIntervalOverflowError(16));
    await vi.advanceTimersByTimeAsync(350);
    expect(created.map((stock) => [stock.pitch, stock.intervalCapacity])).toEqual([
      [0.1, 16],
      [0.02, 16],
      [0.02, 32],
    ]);
    expect(created[0].dispose).not.toHaveBeenCalled();
    expect(created[1].dispose).toHaveBeenCalledOnce();
    expect(refined).toHaveBeenCalledOnce();
    expect(refined.mock.calls[0][0].stock).toBe(created[2]);
    expect(failed).not.toHaveBeenCalled();
  });
  it('does not retry device or cutter errors as interval overflow', async () => {
    calculate.mockRejectedValueOnce(new Error('WebGPU device lost'));
    await expect(session().start(input, [0], () => {}, true)).rejects.toThrow('WebGPU device lost');
    expect(calculate).toHaveBeenCalledOnce();
    expect(created).toHaveLength(1);
    expect(created[0].dispose).toHaveBeenCalledOnce();
  });
  it('reports successful readiness at Info level including elapsed retries, without repeating cache hits', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      calculate
        .mockImplementationOnce(async () => {
          vi.advanceTimersByTime(20);
          throw new GpuDexelIntervalOverflowError(16);
        })
        .mockImplementationOnce(async () => {
          vi.advanceTimersByTime(30);
          throw new GpuDexelIntervalOverflowError(32);
        });
      const replay = session();
      await replay.start(input, [0], () => {}, true);
      const reports = () =>
        log.mock.calls
          .map(([message]) => String(message))
          .filter((message) => message.startsWith('[NC-Edit7 GPU] Replay stock ready '));
      expect(reports()).toHaveLength(1);
      const report = JSON.parse(reports()[0].slice('[NC-Edit7 GPU] Replay stock ready '.length));
      expect(report).toMatchObject({
        position: 1,
        requestedPosition: 1,
        phase: 'coarse',
        pitchMm: 0.1,
        intervalCapacity: 64,
        motions: 0,
        elapsedMs: 55,
      });
      await replay.seek(1);
      expect(reports()).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });
  it('does not allocate a larger capacity after cancellation', async () => {
    const replay = session();
    calculate.mockImplementationOnce(async () => {
      replay.cancel();
      throw new GpuDexelIntervalOverflowError(16);
    });
    await expect(replay.start(input, [0], () => {}, true)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(created).toHaveLength(1);
    expect(created[0].dispose).toHaveBeenCalledOnce();
  });
  it('enforces the memory budget before an adaptive retry allocation', async () => {
    const replay = session();
    const large: SimulationInput = {
      ...cuttingInput(),
      stock: { type: 'box', width: 56, height: 56, depth: 56 },
    };
    large.motions = [
      {
        ...large.motions[0],
        executionStep: 0,
        tool: {
          toolNumber: 1,
          description: 'Full stock cutter',
          cutting: [{ type: 'endMill', diameter: 120, length: 120 }],
        },
        start: { ...large.motions[0].start, position: [0, 0, -60] },
        end: { ...large.motions[0].end, position: [0, 0, -60] },
      },
    ];
    calculate.mockRejectedValueOnce(new GpuDexelIntervalOverflowError(16));
    await expect(replay.start(large, [0], () => {}, true)).rejects.toThrow(/larger pitch|256 MiB/);
    expect(created).toHaveLength(1);
    expect(created[0].dispose).toHaveBeenCalledOnce();
  });
});
