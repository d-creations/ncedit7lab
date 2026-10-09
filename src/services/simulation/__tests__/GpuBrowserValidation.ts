import * as THREE from 'three';
import { RenderTarget, WebGPURenderer, type NodeBuilder } from 'three/webgpu';
import { GpuDexelStock } from '../GpuDexelStock';
import { compileGpuSweeps, evaluateGpuSweep } from '../GpuSweepCompiler';
import { DEXEL_INTERVALS } from '../DexelLayout';
import type { RemovalMotion, SimulationInput } from '../SimulationTypes';
import { stockPlacement } from '../SimulationTransforms';
import type { ProgramToolDefinition } from '../../tools/SimulationMetadata';

export async function runGpuCylinderShadingValidation(): Promise<object> {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter is unavailable');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const renderer = new WebGPURenderer({ canvas: document.createElement('canvas'), device });
  await renderer.init();
  renderer.setPixelRatio(1);
  renderer.setSize(256, 256);
  const stock = new GpuDexelStock(
    renderer,
    device,
    new THREE.Vector3(2, 2, 2),
    0.02,
    true,
    [],
    new THREE.Matrix4(),
  );
  const target = new RenderTarget(256, 256);
  try {
    await stock.calculate(0);
    const scene = new THREE.Scene();
    scene.add(stock.group);
    const camera = new THREE.PerspectiveCamera((2 * Math.atan(0.3) * 180) / Math.PI, 1, 0.1, 10);
    camera.position.set(4, 0, 0);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 256);
    let linearError = 0,
      srgbError = 0,
      roughness = 0;
    for (let column = 64; column < 192; column++) {
      const projectedY = ((column + 0.5) * 2.4) / 256 - 1.2;
      const a = 16 + projectedY * projectedY;
      const t = (32 - Math.sqrt(64 - 60 * projectedY * projectedY)) / (2 * a);
      const y = projectedY * t;
      const x = 4 * (1 - t);
      const linear = 0.7 * (0.3 + (0.55 * (x + y)) / Math.sqrt(6));
      const srgb = new THREE.Color(linear, 0, 0).convertLinearToSRGB().r;
      const red = pixels[(128 * 256 + column) * 4];
      linearError += (red - 255 * linear) ** 2;
      srgbError += (red - 255 * srgb) ** 2;
      if (column > 64 && column < 191)
        roughness += Math.abs(
          pixels[(128 * 256 + column - 1) * 4] - 2 * red + pixels[(128 * 256 + column + 1) * 4],
        );
    }
    if (errors.length) throw new Error(errors.join('\n'));
    const redRmse = Math.sqrt(Math.min(linearError, srgbError) / 128);
    const meanSecondDifference = roughness / 126;
    if (redRmse > 1 || meanSecondDifference > 1)
      throw new Error(
        `GPU cylinder shading is inaccurate or striped: RMSE=${redRmse}, second difference=${meanSecondDifference}`,
      );
    return {
      passed: true,
      pitchMm: 0.02,
      samples: 128,
      redRmse,
      meanSecondDifference,
      colorSpace: linearError <= srgbError ? 'linear' : 'srgb',
      uncapturedErrors: errors,
    };
  } finally {
    renderer.setRenderTarget(null);
    target.dispose();
    stock.dispose();
    await renderer.dispose();
    device.destroy();
  }
}

export async function runGpuBrowserValidation(partSizeMm = 2): Promise<object> {
  if (!Number.isFinite(partSizeMm) || partSizeMm <= 0)
    throw new Error('Invalid GPU validation stock size');
  const scale = partSizeMm / 2;
  if (!navigator.gpu) throw new Error('WebGPU is unavailable');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter is unavailable');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const canvas = document.createElement('canvas');
  const renderer = new WebGPURenderer({ canvas, device });
  await renderer.init();
  const builders: NodeBuilder[] = [];
  renderer.debug.onNodeBuilderCreated = (builder) => builders.push(builder);
  renderer.setSize(96, 96);
  renderer.setPixelRatio(1);
  const mill: ProgramToolDefinition = {
    toolNumber: 1,
    description: 'GPU regression mill',
    cutting: [{ type: 'endMill', diameter: 0.6 * scale, length: 3 * scale }],
  };
  const insert: ProgramToolDefinition = {
    toolNumber: 2,
    description: 'GPU regression insert',
    cutting: [
      {
        type: 'insert',
        shape: 'S',
        ic: 0.8 * scale,
        thickness: 0.3 * scale,
        noseRadius: 0,
        clearanceAngle: 0,
        rotation: [0, 45, 0],
      },
    ],
  };
  const motion = (
    start: [number, number, number],
    end: [number, number, number],
    executionStep: number,
    turning = false,
  ): RemovalMotion => ({
    mode: turning ? 'turning' : 'milling',
    tool: turning ? insert : mill,
    executionStep,
    start: {
      position: [start[0] * scale, start[1] * scale, start[2] * scale],
      orientation: [0, 0, 0, 1],
      frameId: 'workpiece:gpu-test',
      reference: turning ? 'turningVirtualTip' : 'millingTip',
    },
    end: {
      position: [end[0] * scale, end[1] * scale, end[2] * scale],
      orientation: [0, 0, 0, 1],
      frameId: 'workpiece:gpu-test',
      reference: turning ? 'turningVirtualTip' : 'millingTip',
    },
  });
  const setup = (mixed: boolean): SimulationInput => ({
    algorithmVersion: 2,
    stock: mixed
      ? { type: 'cylinder', diameter: partSizeMm, length: partSizeMm }
      : { type: 'box', width: partSizeMm, height: partSizeMm, depth: partSizeMm },
    binding: {
      frameId: 'workpiece:gpu-test',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      spindleOrigin: [0, 0, 0],
      spindleAxis: [0, 0, 1],
    },
    resolutionMm: 0.05,
    motions: mixed
      ? [
          motion([0.8, 0, -1], [0.8, 0, 1], 1, true),
          motion([0, 0, -1.2], [0, 0, -1.2], 2),
          motion([0.7, 0, -1], [0.7, 0, 1], 3, true),
        ]
      : [motion([-0.6, 0, -1.2], [0.6, 0, -1.2], 1)],
  });
  const measurements: object[] = [];
  const stocks: GpuDexelStock[] = [];
  try {
    for (const mixed of [false, true]) {
      const input = setup(mixed),
        sweeps = compileGpuSweeps(input);
      for (const pitch of [0.1, 0.02]) {
        const stock = new GpuDexelStock(
          renderer,
          device,
          new THREE.Vector3(partSizeMm, partSizeMm, partSizeMm),
          pitch,
          mixed,
          sweeps,
          stockPlacement(input.stock, input.binding),
        );
        stocks.push(stock);
        const ms = await stock.calculate(sweeps.length);
        const warmMs = await stock.calculate(sweeps.length);
        const counts = new Uint32Array(await renderer.getArrayBufferAsync(stock.countAttribute));
        const intervals = new Float32Array(
          await renderer.getArrayBufferAsync(stock.intervalAttribute),
        );
        const dims = stock.layout.dimensions.toArray(),
          size = [partSizeMm, partSizeMm, partSizeMm];
        let checked = 0,
          base = 0;
        for (let axis = 0; axis < 3; axis++) {
          const u = axis === 0 ? 1 : 0,
            v = axis === 2 ? 1 : 2;
          const tilesU = Math.ceil(dims[u] / 32);
          for (let a = 0; a < dims[u]; a += Math.max(1, Math.floor(dims[u] / 12))) {
            for (let b = 0; b < dims[v]; b += Math.max(1, Math.floor(dims[v] / 12))) {
              const ray =
                base +
                (Math.floor(a / 32) + tilesU * Math.floor(b / 32)) * 1024 +
                (a % 32) +
                32 * (b % 32);
              if (counts[ray] > DEXEL_INTERVALS) throw new Error('Invalid GPU interval count');
              const point = new THREE.Vector3();
              point.setComponent(u, -scale + ((a + 0.5) * size[u]) / dims[u]);
              point.setComponent(v, -scale + ((b + 0.5) * size[v]) / dims[v]);
              for (let sample = 0; sample < 41; sample++) {
                point.setComponent(axis, (-0.975 + sample * 0.04875) * scale);
                const field = Math.min(...sweeps.map((sweep) => evaluateGpuSweep(sweep, point)));
                const stockField = mixed
                  ? Math.max(Math.hypot(point.x, point.y) - scale, Math.abs(point.z) - scale)
                  : Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z)) - scale;
                if (Math.abs(field) < pitch * 0.002 || Math.abs(stockField) < pitch * 0.002)
                  continue;
                const expected = stockField < 0 && field >= 0;
                let actual = false;
                for (let i = 0; i < counts[ray]; i++) {
                  const offset = (ray * DEXEL_INTERVALS + i) * 2;
                  actual ||=
                    point.getComponent(axis) >= intervals[offset] &&
                    point.getComponent(axis) <= intervals[offset + 1];
                }
                if (actual !== expected)
                  throw new Error(
                    `GPU/reference occupancy mismatch: mixed=${mixed}, pitch=${pitch}, axis=${axis}, point=${point.toArray()}, field=${field}`,
                  );
                checked++;
              }
            }
          }
          base += stock.layout.rayCounts[axis];
        }
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x000000);
        scene.add(stock.group);
        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20 * scale);
        camera.position.set(3 * scale, 3 * scale, 4 * scale);
        camera.lookAt(0, 0, 0);
        const target = new RenderTarget(96, 96);
        const renderStarted = performance.now();
        try {
          device.pushErrorScope('validation');
          renderer.setRenderTarget(target);
          renderer.render(scene, camera);
          const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 96, 96);
          const error = await device.popErrorScope();
          if (error) throw new Error(`GPU rendering validation failed: ${error.message}`);
          let visible = 0;
          for (let i = 0; i < pixels.length; i += 4)
            if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 0) visible++;
          if (visible < 100) throw new Error(`GPU stock did not render: ${visible} visible pixels`);
          measurements.push({
            mixed,
            stockSizeMm: partSizeMm,
            renderMs: Math.round(performance.now() - renderStarted),
            pitchMm: pitch,
            computeMs: Math.round(ms),
            warmComputeMs: Math.round(warmMs),
            checked,
            visiblePixels: visible,
            estimatedMiB: +(stock.estimatedBytes / 1048576).toFixed(2),
          });
        } finally {
          renderer.setRenderTarget(null);
          target.dispose();
          scene.remove(stock.group);
        }
        if (pitch < 0.1) stock.dispose();
      }
    }
    const raw = new GpuDexelStock(
      renderer,
      device,
      new THREE.Vector3(2, 2, 2),
      0.1,
      false,
      [],
      new THREE.Matrix4(),
    );
    stocks.push(raw);
    await raw.calculate(0);
    const depthScene = new THREE.Scene();
    depthScene.add(raw.group);
    const tool = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.4, 0.4),
      new THREE.MeshBasicMaterial({ color: 0x0000ff }),
    );
    depthScene.add(tool);
    const depthCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 20);
    depthCamera.position.set(0, 0, 4);
    depthCamera.lookAt(0, 0, 0);
    const depthTarget = new RenderTarget(96, 96);
    const occlusion: boolean[] = [];
    try {
      renderer.setRenderTarget(depthTarget);
      for (const z of [2, -2]) {
        tool.position.z = z;
        renderer.render(depthScene, depthCamera);
        const pixels = await renderer.readRenderTargetPixelsAsync(depthTarget, 48, 48, 1, 1);
        const blue = pixels[2] > pixels[0] * 2;
        if (blue !== z > 0)
          throw new Error(
            `GPU stock depth does not correctly occlude ordinary Three.js geometry at z=${z}`,
          );
        occlusion.push(true);
      }
    } finally {
      renderer.setRenderTarget(null);
      depthTarget.dispose();
      tool.geometry.dispose();
      tool.material.dispose();
      depthScene.remove(raw.group);
    }
    if (errors.length) throw new Error(errors.join('\n'));
    const shaders = builders.flatMap((builder) =>
      ['computeShader', 'vertexShader', 'fragmentShader'].flatMap((key) => {
        const value: unknown = Reflect.get(builder, key);
        return typeof value === 'string' && value.length ? [value] : [];
      }),
    );
    if (shaders.length < 3 || shaders.some((shader) => /ptr\s*<\s*storage\b/.test(shader)))
      throw new Error('GPU shaders require optional WGSL storage-pointer function parameters');
    return {
      passed: true,
      portableShaderCount: shaders.length,
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      },
      measurements,
      occlusion,
      uncapturedErrors: errors,
    };
  } finally {
    for (const stock of stocks) stock.dispose();
    await renderer.dispose();
    device.destroy();
  }
}
