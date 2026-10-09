// @vitest-environment jsdom
import * as THREE from 'three';
import { ComputeNode, WebGPURenderer, WGSLNodeBuilder } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { DEXEL_DISPATCH_RAYS, GpuDexelStock } from '../GpuDexelStock';

function fixture(size = 10) {
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
    [],
    new THREE.Matrix4(),
  );
  return { renderer, device, stock, compute, read, complete, loseDevice };
}

describe('bounded GPU dexel submissions', () => {
  it('generates globally bound compute WGSL without storage-pointer parameters', async () => {
    const f = fixture(1);
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
