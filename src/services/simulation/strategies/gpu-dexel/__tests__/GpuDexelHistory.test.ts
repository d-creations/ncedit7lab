import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { GpuDexelHistory } from '../GpuDexelHistory';
import { subtractDexelInterval } from '../DexelLayout';
import { GPU_SWEEP_STRIDE, type CompiledGpuSweep } from '../GpuSweepCompiler';

function event(ray: number, sweep: number, low: number, high: number, cut = 0): number[] {
  const span = new Uint32Array(new Float32Array([low, high]).buffer);
  return [ray, sweep * 4 + cut, ...span];
}
const sweeps: CompiledGpuSweep[] = [10, 10, 30, 5000000000].map((executionStep, motionIndex) => ({
  executionStep,
  motionIndex,
  data: new Float32Array(GPU_SWEEP_STRIDE),
  bounds: new THREE.Box3(),
}));
function restore(history: GpuDexelHistory, ray: number, step: number): [number, number][] {
  const [start, count] = history.range(ray),
    events = history.events.array;
  let material: [number, number][] = [[-1, 1]];
  const rank = history.rank(step);
  for (let i = 0; i < count; i++) {
    const offset = (start + i) * 4;
    if (events[offset + 1] > rank) break;
    const bits = Uint32Array.from([events[offset + 2], events[offset + 3]]);
    const span = new Float32Array(bits.buffer);
    material = subtractDexelInterval(material, [span[0], span[1]]);
  }
  return material;
}

describe('execution-aware removed-interval history', () => {
  it('places at most three checkpoints by removed intervals with capped early coverage', () => {
    const timeline = Array.from({ length: 96 }, (_, i) => i + 1);
    const records = [2, 20, 90].map((executionStep, motionIndex) => ({
      executionStep,
      motionIndex,
      data: new Float32Array(GPU_SWEEP_STRIDE),
      bounds: new THREE.Box3(),
    }));
    const history = new GpuDexelHistory(
      Uint32Array.from(
        Array.from({ length: 96 }, (_, i) =>
          event(i, i < 6 ? 0 : i < 64 ? 1 : 2, -0.25, 0.25),
        ).flat(),
      ),
      1024,
      records,
    );
    const late = new GpuDexelHistory(Uint32Array.from(event(0, 2, -0.25, 0.25)), 1024, records);
    try {
      expect(history.checkpointPositions(timeline, 96)).toEqual([2, 20]);
      expect(history.checkpointPositions(timeline, 63)).toEqual([]);
      expect(late.checkpointPositions(timeline, 96)).toEqual([12, 90]);
      expect(history.checkpointPositions(timeline, 96).length).toBeLessThanOrEqual(3);
    } finally {
      history.dispose();
      late.dispose();
    }
  });
  it('orders parallel append output by ray and exact cutter order, including repeated steps', () => {
    const raw = Uint32Array.from([
      ...event(2048, 2, -1, 1),
      ...event(0, 2, -0.25, 0.25),
      ...event(0, 1, -0.75, -0.5),
      ...event(0, 0, 0.5, 0.75),
      ...event(0, 3, -1, 1),
    ]);
    const before = raw.slice();
    const history = new GpuDexelHistory(raw, 3072, sweeps);
    try {
      expect(raw).toEqual(before);
      expect(history.steps).toEqual([10, 30, 5000000000]);
      expect([
        history.rank(-1),
        history.rank(10),
        history.rank(29),
        history.rank(30),
        history.rank(Infinity),
      ]).toEqual([0, 1, 1, 2, 3]);
      expect(restore(history, 0, 9)).toEqual([[-1, 1]]);
      expect(restore(history, 0, 10)).toEqual([
        [-1, -0.75],
        [-0.5, 0.5],
        [0.75, 1],
      ]);
      expect(restore(history, 0, 30)).toEqual([
        [-1, -0.75],
        [-0.5, -0.25],
        [0.25, 0.5],
        [0.75, 1],
      ]);
      expect(restore(history, 0, 5000000000)).toEqual([]);
      expect(restore(history, 100, 5000000000)).toEqual([[-1, 1]]);
      expect(history.tiles(9)).toEqual(new Uint32Array());
      expect(history.tiles(10)).toEqual(new Uint32Array([0]));
      expect(history.tiles(30)).toEqual(new Uint32Array([0, 2]));
      expect(history.work(10, 30)).toEqual(new Uint32Array([0, 1, 0, 0, 0, 1]));
      expect(history.work(30, 30)).toEqual(new Uint32Array(6));
      expect(history.work(-1, 10)).toEqual(new Uint32Array([0, 2, 0, 0, 0, 0]));
      expect(history.estimatedBytes).toBeGreaterThan(raw.byteLength * 2);
    } finally {
      history.dispose();
    }
  });
  it('retains earliest removal when later cutter intervals overlap an existing hole', () => {
    const history = new GpuDexelHistory(
      Uint32Array.from([...event(0, 2, -0.5, 0.5), ...event(0, 0, -0.25, 0.25)]),
      1,
      sweeps,
    );
    try {
      expect(restore(history, 0, 10)).toEqual([
        [-1, -0.25],
        [0.25, 1],
      ]);
      expect(restore(history, 0, 30)).toEqual([
        [-1, -0.5],
        [0.5, 1],
      ]);
    } finally {
      history.dispose();
    }
  });
  it('selects only the newly changed tiles when stepping through a long history', () => {
    const sweeps = Array.from({ length: 9853 }, (_, i) => ({
      executionStep: i + 1,
      motionIndex: i,
      data: new Float32Array(GPU_SWEEP_STRIDE),
      bounds: new THREE.Box3(),
    }));
    const raw = Uint32Array.from(
      sweeps.flatMap((_, i) => event(i < 9852 ? 0 : 2048, i, -0.25, 0.25)),
    );
    const history = new GpuDexelHistory(raw, 3072, sweeps);
    try {
      expect(history.work(9852, 9853)).toEqual(new Uint32Array([0, 0, 0, 0, 0, 1]));
      expect(history.work(0, 1)).toEqual(new Uint32Array([0, 1, 0, 0, 0, 0]));
      expect(history.work(-1, 9853)).toEqual(new Uint32Array([0, 9852, 0, 0, 0, 1]));
      expect(() => history.work(2, 1)).toThrow(/reversed/);
    } finally {
      history.dispose();
    }
  });
  it('represents an empty history without allocating a complete mesh or stock snapshot', () => {
    const history = new GpuDexelHistory(new Uint32Array(), 3072, []);
    try {
      expect(history.count).toBe(0);
      expect(history.events.array.length).toBe(4);
      expect(history.rank(100)).toBe(0);
      expect(history.tiles(100)).toHaveLength(0);
    } finally {
      history.dispose();
    }
  });
  it('rejects corrupt ray, cutter and interval records explicitly', () => {
    expect(() => new GpuDexelHistory(Uint32Array.from(event(3072, 0, 0, 1)), 3072, sweeps)).toThrow(
      /invalid ray/,
    );
    expect(() => new GpuDexelHistory(Uint32Array.from(event(0, 9, 0, 1)), 3072, sweeps)).toThrow(
      /invalid ray or cutter/,
    );
    expect(() => new GpuDexelHistory(Uint32Array.from(event(0, 0, 1, 0)), 3072, sweeps)).toThrow(
      /invalid interval/,
    );
    expect(() => new GpuDexelHistory(Uint32Array.from(event(0, 0, NaN, 1)), 3072, sweeps)).toThrow(
      /invalid interval/,
    );
  });
});
