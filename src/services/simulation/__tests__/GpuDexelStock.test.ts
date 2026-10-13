// @vitest-environment jsdom
import * as THREE from 'three';
import { ComputeNode, WebGPURenderer, WGSLNodeBuilder } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import {
  DEXEL_DISPATCH_RAYS,
  DEXEL_PASS_SWEEPS,
  dexelDispatchRays,
  dexelDispatchRanges,
  GpuDexelStock,
} from '../GpuDexelStock';
import { GPU_SWEEP_STRIDE, type CompiledGpuSweep } from '../GpuSweepCompiler';
import { GpuDexelIntervalOverflowError, type DexelIntervalCapacity } from '../DexelLayout';
import { GpuDexelHistory } from '../GpuDexelHistory';

function fixture(
  size = 10,
  sweeps: readonly CompiledGpuSweep[] = [],
  capacity: DexelIntervalCapacity = 16,
  sparse?: ConstructorParameters<typeof GpuDexelStock>[8],
) {
  const renderer = new WebGPURenderer();
  const compute = vi.spyOn(renderer, 'compute').mockReturnValue(undefined);
  const read = vi
    .spyOn(renderer, 'getArrayBufferAsync')
    .mockResolvedValue(new Uint32Array(4).buffer);
  const complete = vi.fn().mockResolvedValue(undefined);
  let loseDevice!: (info: GPUDeviceLostInfo) => void;
  const device = {
    lost: new Promise<GPUDeviceLostInfo>((resolve) => {
      loseDevice = resolve;
    }),
    queue: { onSubmittedWorkDone: complete },
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn().mockResolvedValue(null),
    createShaderModule: vi.fn(),
  };
  const stock = new GpuDexelStock(
    renderer,
    device,
    new THREE.Vector3(size, size, size),
    0.1,
    false,
    sweeps,
    new THREE.Matrix4(),
    capacity,
    sparse,
  );
  return { renderer, device, stock, compute, read, complete, loseDevice };
}

function generateShader(
  builder: WGSLNodeBuilder,
  stage: 'computeShader' | 'fragmentShader',
): string {
  if (!('build' in builder) || typeof builder.build !== 'function')
    throw new Error('Shader builder cannot generate WGSL');
  builder.build();
  const shader: unknown = Reflect.get(builder, stage);
  if (typeof shader !== 'string') throw new Error(`Shader builder did not generate ${stage}`);
  return shader;
}

describe('bounded GPU dexel submissions', () => {
  it('compacts only touched tiles and excludes tiles with no remaining cutter entries', () => {
    const ranges = new Uint32Array([0, 0, 0, 4, 4, 1, 5, 0, 5, 300]);
    expect(dexelDispatchRanges(ranges, 0)).toEqual([
      [1024, 2048],
      [4096, 1024],
    ]);
    expect(dexelDispatchRanges(ranges, 256)).toEqual([[4096, 1024]]);
    expect(dexelDispatchRanges(ranges, 300)).toEqual([]);
  });
  it('reduces dispatch size for expensive tile cutter lists, on workgroup boundaries', () => {
    expect(dexelDispatchRays(new Uint32Array([0, 1]))).toBe(DEXEL_DISPATCH_RAYS);
    const count = dexelDispatchRays(new Uint32Array([0, 1, 1, 162]));
    expect(count).toBe(384);
    expect(count * 162).toBeLessThanOrEqual(65536);
    expect(count % 64).toBe(0);
    expect(dexelDispatchRays(new Uint32Array([0, 10000]))).toBe(256);
  });

  describe('sparse GPU intervals and recorded history', () => {
    const sweep: CompiledGpuSweep = {
      bounds: new THREE.Box3(new THREE.Vector3(-0.1, -0.1, -0.1), new THREE.Vector3(0.1, 0.1, 0.1)),
      data: new Float32Array(GPU_SWEEP_STRIDE),
      motionIndex: 0,
      executionStep: 10,
    };
    it('preserves sparse slots through copy and dispatches a resumed cut only on touched tiles', async () => {
      const f = fixture(20, [], 16, {});
      const next = new GpuDexelStock(
        f.renderer,
        f.device,
        f.stock.layout.size.clone(),
        0.1,
        false,
        [sweep],
        new THREE.Matrix4(),
        16,
        { retainedTiles: f.stock.layout.storedTiles },
      );
      try {
        await f.stock.calculate(0);
        await next.copyFrom(f.stock);
        f.compute.mockClear();
        const count = next.layout.storedTiles.length * 1024;
        await next.calculate(1);
        expect(f.compute.mock.calls.reduce((sum, [, rays]) => sum + Number(rays), 0)).toBe(count);
        expect(count).toBeLessThan(next.layout.rays / 10);
        expect(next.intervalAttribute.array.length).toBe(next.layout.storageRays * 16 * 2);
        expect(f.stock.intervalAttribute.array.length).toBe(16 * 2);
      } finally {
        next.dispose();
        f.stock.dispose();
      }
    });
    it('captures append output once, preserves original execution steps and transfers ownership', async () => {
      const f = fixture(1, [sweep], 16, { historyEvents: 8 });
      const span = new Uint32Array(new Float32Array([-0.25, 0.25]).buffer);
      const raw = new Uint32Array([0, 0, ...span, 1024, 0, ...span]);
      try {
        f.read.mockImplementation(async (attribute) =>
          attribute === Reflect.get(f.stock, 'captureAttribute')
            ? raw.buffer
            : new Uint32Array([0, 0, 2, 0]).buffer,
        );
        await f.stock.calculate(1);
        const history = f.stock.takeHistory()!;
        expect(history.count).toBe(2);
        expect(history.steps).toEqual([10]);
        expect(history.stockKey).toBe(f.stock.historyKey);
        expect(f.stock.takeHistory()).toBeUndefined();
        history.dispose();
      } finally {
        f.stock.dispose();
      }
    });
    it('keeps calculated stock valid but explicitly disables incomplete history on overflow', async () => {
      const f = fixture(1, [sweep], 16, { historyEvents: 1 });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        f.read.mockResolvedValue(new Uint32Array([0, 0, 2, 1]).buffer);
        await f.stock.calculate(1);
        expect(f.stock.history).toBeUndefined();
        expect(f.stock.historyUnavailable).toContain('capacity exhausted');
        expect(warn).toHaveBeenCalledOnce();
        expect(Reflect.get(f.stock, 'calculated')).toBe(true);
        expect(f.read).toHaveBeenCalledOnce();
      } finally {
        warn.mockRestore();
        f.stock.dispose();
      }
    });
    it('drains the bounded capture buffer between passes and retains a history larger than that buffer', async () => {
      const sweeps = Array.from({ length: DEXEL_PASS_SWEEPS + 1 }, (_, i) => ({
        ...sweep,
        motionIndex: i,
        executionStep: i,
      }));
      const f = fixture(1, sweeps, 16, { historyEvents: 4, historyLimit: 4 });
      const span = new Uint32Array(new Float32Array([-0.25, 0.25]).buffer);
      const chunks = [
        new Uint32Array([0, 0, ...span, 1024, 4, ...span]),
        new Uint32Array([0, 1024, ...span, 1024, 1025, ...span]),
      ];
      let read = 0;
      try {
        f.read.mockImplementation(async (attribute) =>
          attribute === Reflect.get(f.stock, 'captureAttribute')
            ? chunks[read++].buffer
            : new Uint32Array([0, 0, 2, 0]).buffer,
        );
        await f.stock.calculate(sweeps.length);
        const history = f.stock.takeHistory()!;
        expect(history.count).toBe(4);
        expect(history.range(0)[1]).toBe(2);
        expect(history.range(1024)[1]).toBe(2);
        expect(Array.from(history.events.array).filter((_, i) => i % 4 === 1)).toEqual([
          1, 257, 2, 257,
        ]);
        expect(f.read).toHaveBeenCalledTimes(4);
        history.dispose();
      } finally {
        f.stock.dispose();
      }
    });
    it('reports a retention-budget limit rather than publishing a truncated streamed history', async () => {
      const sweeps = Array.from({ length: DEXEL_PASS_SWEEPS + 1 }, (_, i) => ({
        ...sweep,
        motionIndex: i,
        executionStep: i,
      }));
      const f = fixture(1, sweeps, 16, { historyEvents: 2, historyLimit: 3 });
      const span = new Uint32Array(new Float32Array([-0.25, 0.25]).buffer);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        f.read.mockImplementation(async (attribute) =>
          attribute === Reflect.get(f.stock, 'captureAttribute')
            ? new Uint32Array([0, 0, ...span, 1024, 0, ...span]).buffer
            : new Uint32Array([0, 0, 2, 0]).buffer,
        );
        await f.stock.calculate(sweeps.length);
        expect(f.stock.takeHistory()).toBeUndefined();
        expect(f.stock.historyUnavailable).toContain('retention budget exhausted');
        expect(Reflect.get(f.stock, 'calculated')).toBe(true);
        expect(warn).toHaveBeenCalledOnce();
      } finally {
        warn.mockRestore();
        f.stock.dispose();
      }
    });
    it('releases calculation-only buffers while retaining immutable copyable and renderable stock', async () => {
      const sweeps = Array.from({ length: 200 }, (_, i) => ({ ...sweep, executionStep: i }));
      const f = fixture(1, sweeps);
      const next = new GpuDexelStock(
        f.renderer,
        f.device,
        f.stock.layout.size.clone(),
        0.1,
        false,
        [],
        new THREE.Matrix4(),
      );
      const intervals = vi.spyOn(f.stock.intervalAttribute, 'dispose');
      const counts = vi.spyOn(f.stock.countAttribute, 'dispose');
      try {
        await f.stock.calculate(sweeps.length);
        const bytes = f.stock.estimatedBytes;
        f.stock.releasePreparation();
        expect(f.stock.estimatedBytes).toBeLessThan(bytes - 200 * GPU_SWEEP_STRIDE * 8);
        const retained = f.stock.estimatedBytes;
        f.stock.releasePreparation();
        expect(f.stock.estimatedBytes).toBe(retained);
        expect(intervals).not.toHaveBeenCalled();
        expect(counts).not.toHaveBeenCalled();
        await next.copyFrom(f.stock);
        await expect(f.stock.calculate(1)).rejects.toThrow(/immutable/);
        await expect(f.stock.copyFrom(next)).rejects.toThrow(/immutable/);
        vi.spyOn(f.renderer, 'hasFeature').mockReturnValue(false);
        const builder = new WGSLNodeBuilder(f.stock.group.children[0], f.renderer);
        Reflect.set(builder, 'camera', new THREE.PerspectiveCamera());
        expect(generateShader(builder, 'fragmentShader')).toContain('gpuDexelSpan');
      } finally {
        next.dispose();
        f.stock.dispose();
      }
    });
    it('generates a portable history restoration kernel without cutter intersections and validates the grid', async () => {
      const f = fixture(1, [], 16, { retainedTiles: new Uint32Array([0]) });
      const span = new Uint32Array(new Float32Array([-0.25, 0.25]).buffer);
      const history = new GpuDexelHistory(
        new Uint32Array([0, 0, ...span]),
        f.stock.layout.rays,
        [sweep],
        f.stock.historyKey,
      );
      const other = new GpuDexelHistory(
        new Uint32Array(),
        f.stock.layout.rays,
        [],
        'different pitch',
      );
      try {
        vi.spyOn(f.renderer, 'hasFeature').mockReturnValue(false);
        f.compute.mockImplementation((node) => {
          if (!(node instanceof ComputeNode)) throw new Error('Expected one compute node');
          const builder = new WGSLNodeBuilder(new THREE.Object3D(), f.renderer);
          builder.compute = node;
          const shader = generateShader(builder, 'computeShader');
          expect(shader).toContain('fn gpuRestoreHistory');
          expect(shader).toContain('event.y > through');
          expect(shader).toContain('gpuOriginalSpan');
          expect(shader).not.toContain('gpuSweepRayCuts');
          expect(shader).not.toMatch(/ptr\s*<\s*storage\b/);
          return undefined;
        });
        await f.stock.restoreHistory(history, 10);
        expect(Reflect.get(f.stock, 'calculated')).toBe(true);
        expect(f.read).toHaveBeenCalledOnce();
        f.compute.mockClear();
        await f.stock.restoreHistory(history, 10, () => false, 10);
        expect(f.compute.mock.calls.reduce((sum, [, count]) => sum + Number(count), 0)).toBe(1);
        await expect(f.stock.restoreHistory(other, 10)).rejects.toThrow(/compatible ray grid/);
        await expect(f.stock.restoreHistory(history, 9, () => false, 10)).rejects.toThrow(
          /compatible ray grid/,
        );
      } finally {
        other.dispose();
        history.dispose();
        f.stock.dispose();
      }
    });
    it('does not publish a cancelled or capacity-overflowed history restore', async () => {
      const f = fixture(1);
      const history = new GpuDexelHistory(
        new Uint32Array(),
        f.stock.layout.rays,
        [],
        f.stock.historyKey,
      );
      try {
        f.compute.mockClear();
        await expect(
          f.stock.restoreHistory(history, 0, () => f.compute.mock.calls.length > 0),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(Reflect.get(f.stock, 'calculated')).toBe(false);
        f.read.mockResolvedValueOnce(new Uint32Array([1, 0, 0, 0]).buffer);
        await expect(f.stock.restoreHistory(history, 0)).rejects.toBeInstanceOf(
          GpuDexelIntervalOverflowError,
        );
        expect(Reflect.get(f.stock, 'calculated')).toBe(false);
      } finally {
        history.dispose();
        f.stock.dispose();
      }
    });
  });
  it.each([4, 8, 16, 32, 64] as DexelIntervalCapacity[])(
    'generates portable compute WGSL with matching %i-interval storage',
    async (capacity) => {
      const f = fixture(1, [], capacity);
      try {
        vi.spyOn(f.renderer, 'hasFeature').mockReturnValue(false);
        f.compute.mockImplementation((node) => {
          if (!(node instanceof ComputeNode)) throw new Error('Expected one compute node');
          const builder = new WGSLNodeBuilder(new THREE.Object3D(), f.renderer);
          builder.compute = node;
          if (!('build' in builder) || typeof builder.build !== 'function')
            throw new Error('Shader builder cannot generate WGSL');
          builder.build();
          const shader: unknown = Reflect.get(builder, 'computeShader');
          expect(typeof shader).toBe('string');
          expect(shader).not.toMatch(/ptr\s*<\s*storage\b/);
          expect(shader).toContain(`entryOffset + ${DEXEL_PASS_SWEEPS}u`);
          expect(shader).toContain('if (entryOffset > 0u || resume != 0u)');
          expect(shader).toContain('if (entryOffset == 0u && resume == 0u)');
          expect(shader).toContain('if (!touchesMaterial)');
          expect(shader).toContain('array<vec2f, 64>');
          expect(shader).toContain('storageRay * capacity + i');
          expect(shader).toContain('n >= capacity');
          expect(shader).toContain('dexelCapacity');
          expect(f.stock.intervalAttribute.array.length).toBe(f.stock.layout.rays * capacity * 2);
          for (const binding of [
            'dexelRecords',
            'dexelBounds',
            'dexelTileRanges',
            'dexelTileSweeps',
            'dexelIntervals',
            'dexelCounts',
            'dexelErrors',
          ]) {
            expect(shader).toContain(`${binding}Struct`);
            expect(shader).toContain(`${binding}.value`);
          }
          return undefined;
        });

        await f.stock.calculate(0);
      } finally {
        f.stock.dispose();
      }
    },
  );
  it('generates identical shader programs across capacity changes and uses runtime storage stride for display', async () => {
    const shaders: string[] = [];
    const fragments: string[] = [];
    for (const capacity of [4, 8, 16, 32, 64] as DexelIntervalCapacity[]) {
      const f = fixture(1, [], capacity);
      try {
        vi.spyOn(f.renderer, 'hasFeature').mockReturnValue(false);
        f.compute.mockImplementation((node) => {
          if (!(node instanceof ComputeNode)) throw new Error('Expected one compute node');
          const builder = new WGSLNodeBuilder(new THREE.Object3D(), f.renderer);
          builder.compute = node;
          shaders.push(generateShader(builder, 'computeShader'));
          return undefined;
        });
        await f.stock.calculate(0);
        const mesh = f.stock.group.children[0];
        const builder = new WGSLNodeBuilder(mesh, f.renderer);
        Reflect.set(builder, 'camera', new THREE.PerspectiveCamera());
        const fragment = generateShader(builder, 'fragmentShader');
        fragments.push(fragment);
        expect(fragment).toContain('gpuDexelSpan(ray, i, size, dims, capacity, cylinder)');
        expect(fragment).toContain('gpuDexelNormal(p, size, dims, capacity, cylinder)');
        expect(fragment).not.toMatch(/ptr\s*<\s*storage\b/);
      } finally {
        f.stock.dispose();
      }
    }
    expect(new Set(shaders).size).toBe(1);
    expect(new Set(fragments).size).toBe(1);
  });
  it('reports overflow before submitting further cutter passes', async () => {
    const sweeps = Array.from({ length: DEXEL_PASS_SWEEPS + 1 }, (_, i) => ({
      executionStep: i,
      motionIndex: i,
      bounds: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
      data: new Float32Array(GPU_SWEEP_STRIDE),
    }));
    const f = fixture(1, sweeps, 8);
    try {
      f.read.mockResolvedValue(new Uint32Array([1, 0, 0, 0]).buffer);
      await expect(f.stock.calculate(sweeps.length)).rejects.toBeInstanceOf(
        GpuDexelIntervalOverflowError,
      );
      expect(f.compute).toHaveBeenCalledTimes(f.stock.layout.rays / 256);
      expect(f.read).toHaveBeenCalledOnce();
    } finally {
      f.stock.dispose();
    }
  });

  it('splits dense cutter lists into ordered passes, resetting each new calculation', async () => {
    const sweeps = Array.from({ length: DEXEL_PASS_SWEEPS + 1 }, (_, i) => ({
      executionStep: i,
      motionIndex: i,
      bounds: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
      data: new Float32Array(GPU_SWEEP_STRIDE),
    }));
    const f = fixture(1, sweeps);
    try {
      const batches: { entryOffset: number; rayOffset: number; count: number }[] = [];
      f.compute.mockImplementation((_node, count) => {
        if (typeof count !== 'number') throw new Error('Expected a numeric dispatch count');
        batches.push({
          entryOffset: Reflect.get(f.stock, 'entryOffset').value,
          rayOffset: Reflect.get(f.stock, 'rayOffset').value,
          count,
        });
        return undefined;
      });
      await f.stock.calculate(sweeps.length);
      const perPass = f.stock.layout.rays / 256;
      expect(batches).toHaveLength(perPass * 2);
      for (const [pass, entryOffset] of [0, DEXEL_PASS_SWEEPS].entries()) {
        const slice = batches.slice(pass * perPass, (pass + 1) * perPass);
        expect(slice.map((batch) => batch.rayOffset)).toEqual(
          Array.from({ length: perPass }, (_, i) => i * 256),
        );
        expect(slice.every((batch) => batch.entryOffset === entryOffset)).toBe(true);
        expect(slice.every((batch) => batch.count * DEXEL_PASS_SWEEPS <= 65536)).toBe(true);
      }
      batches.length = 0;
      await f.stock.calculate(1);
      expect(batches).toHaveLength(perPass);
      expect(batches.every((batch) => batch.entryOffset === 0)).toBe(true);
    } finally {
      f.stock.dispose();
    }
  });
  it('bounds every dispatch and waits for completion before submitting the next', async () => {
    const f = fixture();
    try {
      let completed = 0;
      f.compute.mockImplementation(() => {
        expect(f.compute.mock.calls.length).toBe(completed + 1);
        return undefined;
      });
      f.complete.mockImplementation(async () => {
        completed++;
      });
      await f.stock.calculate(0);
      const sizes = f.compute.mock.calls.map((call) => {
        if (typeof call[1] !== 'number') throw new Error('Expected a numeric dispatch count');
        return call[1];
      });
      expect(sizes.length).toBeGreaterThan(1);
      expect(sizes.every((size) => size > 0 && size <= DEXEL_DISPATCH_RAYS)).toBe(true);
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(f.stock.layout.rays);
      expect(completed).toBe(sizes.length);
      expect(f.read).toHaveBeenCalledOnce();
    } finally {
      f.stock.dispose();
    }
  });

  it('stops obsolete work between submissions without reading disposed buffers', async () => {
    const f = fixture();
    try {
      let cancelled = false;
      f.complete.mockImplementation(async () => {
        cancelled = true;
      });
      await expect(f.stock.calculate(0, () => cancelled)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(f.compute).toHaveBeenCalledOnce();
      expect(f.read).not.toHaveBeenCalled();
      expect(f.device.popErrorScope).toHaveBeenCalledOnce();
    } finally {
      f.stock.dispose();
    }
  });

  it('reports device loss before attempting to read a missing GPU buffer', async () => {
    const f = fixture();
    try {
      f.complete.mockImplementation(() => new Promise<void>(() => {}));
      const calculation = f.stock.calculate(0);
      f.loseDevice({
        __brand: 'GPUDeviceLostInfo',
        reason: 'unknown',
        message: 'DXGI_ERROR_DEVICE_HUNG',
      });
      await expect(calculation).rejects.toThrow('WebGPU device lost: DXGI_ERROR_DEVICE_HUNG');
      expect(f.read).not.toHaveBeenCalled();
    } finally {
      f.stock.dispose();
    }
  });

  it('preserves shader validation errors instead of masking them with buffer read failures', async () => {
    const f = fixture(1);
    try {
      f.read.mockRejectedValue(
        new TypeError("Cannot read properties of undefined (reading 'size')"),
      );
      vi.mocked(f.device.popErrorScope).mockResolvedValue({
        message: 'Shader validation error',
      } as GPUValidationError);
      await expect(f.stock.calculate(0)).rejects.toThrow(
        'GPU stock shader validation failed: Shader validation error',
      );
    } finally {
      f.stock.dispose();
    }
  });

  it('prioritizes an already-lost device over a completed queue', async () => {
    const f = fixture();
    try {
      f.loseDevice({
        __brand: 'GPUDeviceLostInfo',
        reason: 'unknown',
        message: 'Device already removed',
      });
      await expect(f.stock.calculate(0)).rejects.toThrow(
        'WebGPU device lost: Device already removed',
      );
      expect(f.read).not.toHaveBeenCalled();
    } finally {
      f.stock.dispose();
    }
  });

  it('reports WGSL source locations and restores an existing shader-builder callback', async () => {
    const f = fixture(1);
    const previous = vi.fn();
    f.renderer.debug.onNodeBuilderCreated = previous;
    try {
      f.compute.mockImplementation((node) => {
        if (Array.isArray(node)) throw new Error('Expected one compute node');
        const builder = new WGSLNodeBuilder(new THREE.Object3D(), f.renderer);
        Object.assign(builder, { computeShader: 'invalid WGSL fixture' });
        f.renderer.debug.onNodeBuilderCreated?.(builder, node);
        return undefined;
      });
      vi.mocked(f.device.popErrorScope).mockResolvedValueOnce({
        message: 'Shader validation error',
      } as GPUValidationError);
      f.device.createShaderModule.mockReturnValue({
        getCompilationInfo: vi.fn().mockResolvedValue({
          messages: [{ type: 'error', lineNum: 7, linePos: 3, message: 'Invalid pointer' }],
        }),
      });
      await expect(f.stock.calculate(0)).rejects.toThrow('WGSL 7:3: Invalid pointer');
      expect(previous).toHaveBeenCalledOnce();
      expect(f.renderer.debug.onNodeBuilderCreated).toBe(previous);
    } finally {
      f.stock.dispose();
    }
  });
});

describe('immutable GPU stock copying', () => {
  function fork(f: ReturnType<typeof fixture>, changedTiles: number[], source = f.stock) {
    return new GpuDexelStock(
      f.renderer,
      f.device,
      source.layout.size.clone(),
      source.layout.pitchMm,
      false,
      [],
      new THREE.Matrix4(),
      source.layout.intervalCapacity,
      {
        retainedTiles: source.layout.storedTiles,
        source,
        changedTiles: Uint32Array.from(changedTiles),
      },
    );
  }

  it('shares real unchanged material, copies only private tiles and keeps stable eight-buffer bindings', async () => {
    const f = fixture(1, [], 16, { retainedTiles: new Uint32Array([0, 1, 2]), arenaTiles: 9 });
    await f.stock.calculate(0);
    f.stock.releasePreparation();
    f.stock.countAttribute.array[1024] = 1;
    f.stock.intervalAttribute.array.set([-0.5, 0.25], 1024 * 16 * 2);
    const next = fork(f, [0]);
    const disposeIntervals = vi.spyOn(f.stock.intervalAttribute, 'dispose');
    try {
      expect(next.intervalAttribute).toBe(f.stock.intervalAttribute);
      expect(next.countAttribute).toBe(f.stock.countAttribute);
      expect(next.tileSlots[1]).toBe(f.stock.tileSlots[1]);
      expect(next.tileSlots[0]).not.toBe(f.stock.tileSlots[0]);
      f.compute.mockClear();
      vi.spyOn(f.renderer, 'hasFeature').mockReturnValue(false);
      f.compute.mockImplementation((node, count) => {
        if (!(node instanceof ComputeNode)) throw new Error('Expected one compute node');
        const builder = new WGSLNodeBuilder(new THREE.Object3D(), f.renderer);
        builder.compute = node;
        const shader = generateShader(builder, 'computeShader');
        expect(count).toBe(1024);
        expect(shader).not.toContain('copySourceIntervals');
        expect(shader).not.toContain('copySourceCounts');
        expect(shader).toContain('copyTargetIntervals.value[(sourceSlot * 1024u');
        return undefined;
      });
      await next.copyFrom(f.stock);
      expect(f.compute).toHaveBeenCalledOnce();
      const ray = next.tileSlots[1] * 1024;
      expect(next.countAttribute.array[ray]).toBe(1);
      expect(Array.from(next.intervalAttribute.array.slice(ray * 32, ray * 32 + 2))).toEqual([
        -0.5, 0.25,
      ]);
      next.countAttribute.array[next.tileSlots[0] * 1024] = 2;
      expect(f.stock.countAttribute.array[f.stock.tileSlots[0] * 1024]).toBe(0);
      next.releasePreparation();
      const chain = fork(f, [], next);
      try {
        f.compute.mockClear();
        await chain.copyFrom(next);
        expect(f.compute).not.toHaveBeenCalled();
        f.stock.dispose();
        next.dispose();
        expect(disposeIntervals).not.toHaveBeenCalled();
        expect(chain.countAttribute.array[chain.tileSlots[1] * 1024]).toBe(1);
      } finally {
        chain.dispose();
      }
      expect(disposeIntervals).toHaveBeenCalledOnce();
    } finally {
      next.dispose();
      f.stock.dispose();
    }
  });

  it('rejects history writes to a tile omitted from the copy-on-write set', async () => {
    const f = fixture(1, [], 16, { retainedTiles: new Uint32Array([0, 1, 2]), arenaTiles: 6 });
    await f.stock.calculate(0);
    f.stock.releasePreparation();
    const next = fork(f, []);
    const span = new Uint32Array(new Float32Array([-0.25, 0.25]).buffer);
    const history = new GpuDexelHistory(
      new Uint32Array([0, 0, ...span]),
      f.stock.layout.rays,
      [
        {
          executionStep: 2,
          motionIndex: 0,
          bounds: new THREE.Box3(),
          data: new Float32Array(GPU_SWEEP_STRIDE),
        },
      ],
      f.stock.historyKey,
    );
    try {
      await next.copyFrom(f.stock);
      f.compute.mockClear();
      await expect(next.restoreHistory(history, 2, () => false, 1)).rejects.toThrow(
        /shared immutable tile/,
      );
      expect(f.compute).not.toHaveBeenCalled();
    } finally {
      history.dispose();
      next.dispose();
      f.stock.dispose();
    }
  });

  it('falls back to a full independent copy when the bounded arena has no private slot', async () => {
    const f = fixture(1, [], 16, { retainedTiles: new Uint32Array([0, 1, 2]) });
    await f.stock.calculate(0);
    f.stock.releasePreparation();
    const next = fork(f, [0]);
    try {
      expect(next.intervalAttribute).not.toBe(f.stock.intervalAttribute);
      f.compute.mockClear();
      await next.copyFrom(f.stock);
      expect(f.compute.mock.calls.reduce((sum, [, rays]) => sum + Number(rays), 0)).toBe(3072);
    } finally {
      next.dispose();
      f.stock.dispose();
    }
  });

  it('defers source and target arena disposal until an outstanding copy has settled', async () => {
    const f = fixture(1, [], 16, { retainedTiles: new Uint32Array([0, 1, 2]), arenaTiles: 6 });
    await f.stock.calculate(0);
    f.stock.releasePreparation();
    const next = fork(f, [0]);
    const dispose = vi.spyOn(f.stock.intervalAttribute, 'dispose');
    let complete!: () => void;
    f.complete.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const copying = next.copyFrom(f.stock);
    const failure = expect(copying).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    f.stock.dispose();
    next.dispose();
    expect(dispose).not.toHaveBeenCalled();
    complete();
    await failure;
    expect(dispose).toHaveBeenCalledOnce();
  });

  function target(f: ReturnType<typeof fixture>, capacity: DexelIntervalCapacity = 32) {
    return new GpuDexelStock(
      f.renderer,
      f.device,
      f.stock.layout.size.clone(),
      f.stock.layout.pitchMm,
      false,
      [],
      f.stock.group.matrix.clone(),
      capacity,
    );
  }
  it('generates portable stride-aware copy WGSL, bounds submissions and resumes without CPU uploads', async () => {
    const f = fixture();
    const next = target(f);
    try {
      await f.stock.calculate(0);
      f.compute.mockClear();
      f.complete.mockClear();
      f.read.mockClear();
      vi.spyOn(f.renderer, 'hasFeature').mockReturnValue(false);
      const shaders: string[] = [];
      const dispose = vi.fn();
      f.compute.mockImplementation((node, count) => {
        if (!(node instanceof ComputeNode) || typeof count !== 'number')
          throw new Error('Expected one bounded compute node');
        node.addEventListener('dispose', dispose);
        const builder = new WGSLNodeBuilder(new THREE.Object3D(), f.renderer);
        builder.compute = node;
        shaders.push(generateShader(builder, 'computeShader'));
        expect(count * f.stock.layout.intervalCapacity).toBeLessThanOrEqual(65536);
        return undefined;
      });
      const versions = [next.countAttribute.version, next.intervalAttribute.version];
      await next.copyFrom(f.stock);
      expect(f.compute).toHaveBeenCalledTimes(Math.ceil(f.stock.layout.rays / 4096));
      expect(f.complete).toHaveBeenCalledTimes(f.compute.mock.calls.length);
      expect(f.read).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
      expect(shaders[0]).not.toMatch(/ptr\s*<\s*storage\b/);
      expect(shaders[0]).toContain(
        'copySourceIntervals.value[(sourceSlot * 1024u + id % 1024u) * sourceCapacity + i]',
      );
      expect(shaders[0]).toContain(
        'copyTargetIntervals.value[(targetSlot * 1024u + id % 1024u) * targetCapacity + i]',
      );
      expect(shaders[0]).toContain(
        'copyTargetCounts.value[targetSlot * 1024u + id % 1024u] = count',
      );
      expect(shaders[0]).toContain('dexelCopyOffset');
      expect(Reflect.get(next, 'resume').value).toBe(1);
      f.compute.mockReturnValue(undefined);
      await next.calculate(0);
      expect([next.countAttribute.version, next.intervalAttribute.version]).toEqual(versions);
      expect(next.countAttribute.usage).toBe(THREE.StaticDrawUsage);
      expect(next.intervalAttribute.usage).toBe(THREE.StaticDrawUsage);
      expect(Reflect.get(next, 'resume').value).toBe(1);
    } finally {
      next.dispose();
      f.stock.dispose();
    }
  });
  it('requires a completed source and rejects incompatible capacity, layout and renderer', async () => {
    const f = fixture(1);
    const next = target(f);
    const smaller = target(f, 8);
    const other = fixture(1);
    try {
      await expect(next.copyFrom(f.stock)).rejects.toThrow(/completed compatible stock/);
      await f.stock.calculate(0);
      await expect(smaller.copyFrom(f.stock)).rejects.toThrow(/interval capacity/);
      await expect(other.stock.copyFrom(f.stock)).rejects.toThrow(/compatible stock/);
      next.group.matrix.makeTranslation(1, 0, 0);
      await expect(next.copyFrom(f.stock)).rejects.toThrow(/compatible stock/);
      next.group.matrix.identity();
      next.layout.pitchMm = 0.2;
      await expect(next.copyFrom(f.stock)).rejects.toThrow(/same pitch/);
      expect(f.compute).toHaveBeenCalledOnce();
    } finally {
      next.dispose();
      smaller.dispose();
      other.stock.dispose();
      f.stock.dispose();
    }
  });
  it('cancels between bounded copies and cannot reuse an incomplete target as a source', async () => {
    const f = fixture();
    const next = target(f);
    const later = target(f);
    try {
      await f.stock.calculate(0);
      f.compute.mockClear();
      f.compute.mockImplementation(() => undefined);
      await expect(
        next.copyFrom(f.stock, () => f.compute.mock.calls.length > 0),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(f.compute).toHaveBeenCalledOnce();
      await expect(later.copyFrom(next)).rejects.toThrow(/completed compatible stock/);
    } finally {
      later.dispose();
      next.dispose();
      f.stock.dispose();
    }
  });
  it('surfaces validation errors and disposes the temporary node on failure', async () => {
    const f = fixture(1);
    const next = target(f);
    const dispose = vi.fn();
    try {
      await f.stock.calculate(0);
      f.compute.mockImplementation((node) => {
        if (!(node instanceof ComputeNode)) throw new Error('Expected a compute node');
        node.addEventListener('dispose', dispose);
        return undefined;
      });
      f.device.popErrorScope.mockResolvedValueOnce({ message: 'Invalid copy kernel' });
      await expect(next.copyFrom(f.stock)).rejects.toThrow(
        /copy validation failed: Invalid copy kernel/,
      );
      expect(dispose).toHaveBeenCalledOnce();
      expect(Reflect.get(next, 'resume').value).toBe(0);
    } finally {
      next.dispose();
      f.stock.dispose();
    }
  });
  it('reports device loss without stock readback or marking the target complete', async () => {
    const f = fixture(1);
    const next = target(f);
    try {
      await f.stock.calculate(0);
      f.read.mockClear();
      f.complete.mockImplementation(() => new Promise<void>(() => {}));
      const copying = next.copyFrom(f.stock);
      f.loseDevice({
        __brand: 'GPUDeviceLostInfo',
        reason: 'unknown',
        message: 'Copy device lost',
      });
      await expect(copying).rejects.toThrow('WebGPU device lost: Copy device lost');
      expect(f.read).not.toHaveBeenCalled();
      expect(Reflect.get(next, 'resume').value).toBe(0);
    } finally {
      next.dispose();
      f.stock.dispose();
    }
  });
  it('does not pop an error scope when pushing it fails', async () => {
    const f = fixture(1);
    const next = target(f);
    try {
      await f.stock.calculate(0);
      f.device.popErrorScope.mockClear();
      f.device.pushErrorScope.mockImplementationOnce(() => {
        throw new Error('Cannot push scope');
      });
      await expect(next.copyFrom(f.stock)).rejects.toThrow('Cannot push scope');
      expect(f.device.popErrorScope).not.toHaveBeenCalled();
    } finally {
      next.dispose();
      f.stock.dispose();
    }
  });
});
