// @vitest-environment jsdom
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GpuMaterialReplaySession } from '../GpuMaterialReplaySession';
import { createDexelLayout } from '../DexelLayout';
import type { SimulationInput } from '../SimulationTypes';

const { calculate, created } = vi.hoisted(() => ({
  calculate: vi.fn(),
  created: [] as { group: THREE.Group; dispose: ReturnType<typeof vi.fn>; pitch: number }[],
}));
vi.mock('../GpuDexelStock', async () => {
  const THREE = await import('three');
  const { createDexelLayout } = await import('../DexelLayout');
  return {
    GpuDexelStock: class {
      group = new THREE.Group();
      estimatedBytes: number;
      dispose = vi.fn();
      calculate = calculate;
      constructor(
        _renderer: unknown,
        _device: unknown,
        size: THREE.Vector3,
        public pitch: number,
      ) {
        this.estimatedBytes = createDexelLayout(size, pitch).estimatedBytes;
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
    const huge = { ...input, stock: { type: 'box' as const, width: 100, height: 100, depth: 100 } };
    expect(() => createDexelLayout(new THREE.Vector3(100, 100, 100), 0.02)).toThrow();
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
  it('uses certified sweep batches without including a future occurrence', async () => {
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
    expect(calculate.mock.calls[0][0]).toBe(1);
    const first = await replay.seek(1);
    expect(first.processedMotions).toBe(1);
    expect(first.executionStep).toBe(1);
    expect(calculate.mock.calls[1][0]).toBe(1);
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
});
