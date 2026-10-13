import * as THREE from 'three';
import { RenderTarget, WebGPURenderer, type NodeBuilder } from 'three/webgpu';
import { DEXEL_PASS_SWEEPS, GpuDexelStock } from '../GpuDexelStock';
import { compileGpuSweeps, evaluateGpuSweep } from '../GpuSweepCompiler';
import { dexelTilesForBounds, originalDexelSpan, type DexelIntervalCapacity } from '../DexelLayout';
import type { RemovalMotion, SimulationInput } from '../../../shared/SimulationTypes';
import { stockPlacement } from '../../../shared/SimulationTransforms';
import type { ProgramToolDefinition } from '@services/tools/SimulationMetadata';

async function assertSameMaterial(
  renderer: WebGPURenderer,
  expected: GpuDexelStock,
  actual: GpuDexelStock,
  cylinder: boolean,
): Promise<void> {
  const snapshots = await Promise.all(
    [expected, actual].map(async (stock) => ({
      counts: new Uint32Array(await renderer.getArrayBufferAsync(stock.countAttribute)),
      intervals: new Float32Array(await renderer.getArrayBufferAsync(stock.intervalAttribute)),
    })),
  );
  for (let ray = 0; ray < expected.layout.rays; ray++) {
    const spans = snapshots.map((snapshot, index) => {
      const stock = index ? actual : expected,
        slot = stock.tileSlots[Math.floor(ray / 1024)];
      if (slot === 0xffffffff) {
        const original = originalDexelSpan(stock.layout, ray, cylinder);
        return original ? [original] : [];
      }
      const storageRay = slot * 1024 + (ray % 1024);
      return Array.from({ length: snapshot.counts[storageRay] }, (_, i) => {
        const start = (storageRay * stock.layout.intervalCapacity + i) * 2;
        return [snapshot.intervals[start], snapshot.intervals[start + 1]] as const;
      });
    });
    if (spans[0].length !== spans[1].length)
      throw new Error(`Sparse/history material count mismatch: ray=${ray}`);
    const implicit =
      expected.tileSlots[Math.floor(ray / 1024)] === 0xffffffff ||
      actual.tileSlots[Math.floor(ray / 1024)] === 0xffffffff;
    const tolerance = implicit ? expected.layout.size.length() * 2e-6 : 0;
    for (let i = 0; i < spans[0].length; i++)
      for (let end = 0; end < 2; end++)
        if (Math.abs(spans[0][i][end] - spans[1][i][end]) > tolerance)
          throw new Error(
            `Sparse/history material endpoint mismatch: ray=${ray}, interval=${i}, endpoint=${end}`,
          );
  }
}

export async function runGpuCylinderShadingValidation(drilled = false): Promise<object> {
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
  const sweeps = drilled
    ? compileGpuSweeps({
        algorithmVersion: 2,
        stock: { type: 'cylinder', diameter: 2, length: 2 },
        binding: {
          frameId: 'workpiece:matcap-test',
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          spindleOrigin: [0, 0, 0],
          spindleAxis: [0, 0, 1],
        },
        resolutionMm: 0.02,
        motions: [
          {
            executionStep: 1,
            mode: 'milling',
            tool: {
              toolNumber: 1,
              description: 'Axial bore',
              cutting: [{ type: 'endMill', diameter: 0.5, length: 4 }],
            },
            start: {
              position: [0, 0, -2],
              orientation: [0, 0, 0, 1],
              frameId: 'workpiece:matcap-test',
              reference: 'millingTip',
            },
            end: {
              position: [0, 0, -2],
              orientation: [0, 0, 0, 1],
              frameId: 'workpiece:matcap-test',
              reference: 'millingTip',
            },
          },
        ],
      })
    : [];
  const stock = new GpuDexelStock(
    renderer,
    device,
    new THREE.Vector3(2, 2, 2),
    0.02,
    true,
    sweeps,
    new THREE.Matrix4(),
  );
  const target = new RenderTarget(256, 256);
  try {
    await stock.calculate(sweeps.length);
    if (drilled) {
      const counts = new Uint32Array(await renderer.getArrayBufferAsync(stock.countAttribute));
      if (!counts.includes(1) || !counts.includes(2))
        throw new Error('Drilled shading fixture must contain both intact and split material rays');
    }
    const scene = new THREE.Scene();
    scene.add(stock.group);
    const camera = new THREE.PerspectiveCamera((2 * Math.atan(0.3) * 180) / Math.PI, 1, 0.1, 10);
    camera.position.set(4, 0, 0);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
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
      const z = 0.0046875 * t;
      const normal = new THREE.Vector3(x, y, 0)
        .normalize()
        .transformDirection(camera.matrixWorldInverse);
      const view = new THREE.Vector3(x, y, z)
        .applyMatrix4(camera.matrixWorldInverse)
        .negate()
        .normalize();
      const right = new THREE.Vector3(view.z, 0, -view.x).normalize();
      const up = new THREE.Vector3().crossVectors(view, right);
      const u = right.dot(normal),
        v = up.dot(normal);
      const highlight = Math.exp(-3 * ((u + 0.35) ** 2 + (v - 0.4) ** 2));
      const fill = Math.exp(-2 * ((u - 0.55) ** 2 + v * v));
      const linear = 0.93 * (0.46 + 0.1 * v + 0.25 * highlight + 0.1 * fill);
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
        `GPU cylinder MatCap is inaccurate or striped: RMSE=${redRmse}, second difference=${meanSecondDifference}`,
      );
    return {
      passed: true,
      drilled,
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

export async function runGpuBrowserValidation(
  partSizeMm = 2,
  denseCutters = false,
  intervalCapacity: DexelIntervalCapacity = 16,
): Promise<object> {
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
        referenceSweeps = compileGpuSweeps(input),
        sweeps = denseCutters
          ? [
              ...Array.from({ length: DEXEL_PASS_SWEEPS }, () => referenceSweeps[0]),
              ...referenceSweeps,
            ]
          : referenceSweeps;
      for (const pitch of [0.1, 0.02]) {
        const stock = new GpuDexelStock(
          renderer,
          device,
          new THREE.Vector3(partSizeMm, partSizeMm, partSizeMm),
          pitch,
          mixed,
          sweeps,
          stockPlacement(input.stock, input.binding),
          intervalCapacity,
        );
        stocks.push(stock);
        const ms = await stock.calculate(sweeps.length);
        const warmMs = await stock.calculate(sweeps.length);
        const sparse = new GpuDexelStock(
          renderer,
          device,
          stock.layout.size.clone(),
          pitch,
          mixed,
          sweeps,
          stockPlacement(input.stock, input.binding),
          intervalCapacity,
          { historyEvents: 1048576 },
        );
        stocks.push(sparse);
        const sparseStarted = performance.now();
        let sparseMs = 0,
          historyEvents = 0;
        const jumpMeasurements: object[] = [];
        try {
          sparseMs = await sparse.calculate(sweeps.length);
          await assertSameMaterial(renderer, stock, sparse, mixed);
          const history = sparse.takeHistory();
          if (!history)
            throw new Error(sparse.historyUnavailable ?? 'GPU history was not captured');
          historyEvents = history.count;
          try {
            for (const step of [
              0,
              ...new Set(referenceSweeps.map((sweep) => sweep.executionStep)),
            ]) {
              const prefixSweeps = sweeps.filter((sweep) => sweep.executionStep <= step);
              const reference = new GpuDexelStock(
                renderer,
                device,
                stock.layout.size.clone(),
                pitch,
                mixed,
                prefixSweeps,
                stockPlacement(input.stock, input.binding),
                intervalCapacity,
              );
              stocks.push(reference);
              let target: RenderTarget | undefined;
              try {
                await reference.calculate(prefixSweeps.length);
                const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20 * scale);
                camera.position.set(3 * scale, 3 * scale, 4 * scale);
                camera.lookAt(0, 0, 0);
                target = new RenderTarget(96, 96);
                const scene = new THREE.Scene();
                scene.add(reference.group);
                renderer.setRenderTarget(target);
                renderer.render(scene, camera);
                const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 96, 96);
                scene.remove(reference.group);
                const start = performance.now();
                const restored = new GpuDexelStock(
                  renderer,
                  device,
                  stock.layout.size.clone(),
                  pitch,
                  mixed,
                  [],
                  stockPlacement(input.stock, input.binding),
                  intervalCapacity < 32 ? 32 : 64,
                  { retainedTiles: history.tiles(step) },
                );
                stocks.push(restored);
                try {
                  await restored.restoreHistory(history, step);
                  scene.add(restored.group);
                  renderer.render(scene, camera);
                  await device.queue.onSubmittedWorkDone();
                  const readinessMs = performance.now() - start;
                  const restoredPixels = await renderer.readRenderTargetPixelsAsync(
                    target,
                    0,
                    0,
                    96,
                    96,
                  );
                  if (
                    restoredPixels.length !== pixels.length ||
                    restoredPixels.some((value, i) => Math.abs(value - pixels[i]) > 1)
                  )
                    throw new Error(
                      `Sparse/history rendering changed at execution step ${step}, pitch=${pitch}, cylinder=${mixed}`,
                    );
                  await assertSameMaterial(renderer, reference, restored, mixed);
                  jumpMeasurements.push({
                    step,
                    readinessMs: Math.round(readinessMs),
                    targetMs: 1000,
                    belowTarget: readinessMs < 1000,
                  });
                } finally {
                  scene.remove(restored.group);
                  renderer.setRenderTarget(null);
                  restored.dispose();
                }
              } finally {
                renderer.setRenderTarget(null);
                target?.dispose();
                reference.dispose();
              }
            }
          } finally {
            history.dispose();
          }
        } finally {
          sparse.dispose();
        }
        const counts = new Uint32Array(await renderer.getArrayBufferAsync(stock.countAttribute));
        const intervals = new Float32Array(
          await renderer.getArrayBufferAsync(stock.intervalAttribute),
        );
        const copyCapacity: DexelIntervalCapacity =
          intervalCapacity < 16 ? 16 : intervalCapacity < 32 ? 32 : 64;
        const prefix = new GpuDexelStock(
          renderer,
          device,
          stock.layout.size.clone(),
          pitch,
          mixed,
          sweeps.slice(0, 1),
          stockPlacement(input.stock, input.binding),
          intervalCapacity,
          {
            retainedTiles: stock.layout.storedTiles,
            arenaTiles: stock.layout.storedTiles.length * 2,
          },
        );
        stocks.push(prefix);
        const continued = new GpuDexelStock(
          renderer,
          device,
          stock.layout.size.clone(),
          pitch,
          mixed,
          sweeps.slice(1),
          stockPlacement(input.stock, input.binding),
          copyCapacity,
        );
        stocks.push(continued);
        let copyMs = 0,
          deltaMs = 0;
        try {
          await prefix.calculate(1);
          prefix.releasePreparation();
          const beforeCounts = new Uint32Array(
            await renderer.getArrayBufferAsync(prefix.countAttribute),
          );
          const beforeIntervals = new Float32Array(
            await renderer.getArrayBufferAsync(prefix.intervalAttribute),
          );
          const shared = new GpuDexelStock(
            renderer,
            device,
            stock.layout.size.clone(),
            pitch,
            mixed,
            sweeps.slice(1),
            stockPlacement(input.stock, input.binding),
            intervalCapacity,
            {
              retainedTiles: prefix.layout.storedTiles,
              source: prefix,
              changedTiles: Uint32Array.from(
                new Set(
                  sweeps
                    .slice(1)
                    .flatMap((sweep) => dexelTilesForBounds(prefix.layout, sweep.bounds)),
                ),
              ),
            },
          );
          stocks.push(shared);
          try {
            if (shared.tileArena !== prefix.tileArena)
              throw new Error('GPU sharing fixture fell back to copying');
            await shared.copyFrom(prefix);
            await shared.calculate(sweeps.length - 1);
            await assertSameMaterial(renderer, stock, shared, mixed);
            const afterCounts = new Uint32Array(
              await renderer.getArrayBufferAsync(prefix.countAttribute),
            );
            const afterIntervals = new Float32Array(
              await renderer.getArrayBufferAsync(prefix.intervalAttribute),
            );
            for (const tile of prefix.layout.storedTiles) {
              const slot = prefix.tileSlots[tile];
              for (let ray = slot * 1024; ray < (slot + 1) * 1024; ray++) {
                if (beforeCounts[ray] !== afterCounts[ray])
                  throw new Error('Copy-on-write changed source count');
                for (let i = 0; i < beforeCounts[ray] * 2; i++)
                  if (
                    beforeIntervals[ray * intervalCapacity * 2 + i] !==
                    afterIntervals[ray * intervalCapacity * 2 + i]
                  )
                    throw new Error('Copy-on-write changed source interval');
              }
            }
          } finally {
            shared.dispose();
          }
          copyMs = await continued.copyFrom(prefix);
          deltaMs = await continued.calculate(sweeps.length - 1);
          const copiedCounts = new Uint32Array(
            await renderer.getArrayBufferAsync(continued.countAttribute),
          );
          const copiedIntervals = new Float32Array(
            await renderer.getArrayBufferAsync(continued.intervalAttribute),
          );
          for (let ray = 0; ray < stock.layout.rays; ray++) {
            if (copiedCounts[ray] !== counts[ray])
              throw new Error(
                `GPU copy/delta changed interval count: ray=${ray}, pitch=${pitch}, mixed=${mixed}`,
              );
            for (let i = 0; i < counts[ray] * 2; i++) {
              if (
                copiedIntervals[ray * copyCapacity * 2 + i] !==
                intervals[ray * intervalCapacity * 2 + i]
              )
                throw new Error(
                  `GPU copy/delta changed material endpoint: ray=${ray}, endpoint=${i}, pitch=${pitch}, mixed=${mixed}`,
                );
            }
          }
        } finally {
          continued.dispose();
          prefix.dispose();
        }
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
              if (counts[ray] > intervalCapacity) throw new Error('Invalid GPU interval count');
              const point = new THREE.Vector3();
              point.setComponent(u, -scale + ((a + 0.5) * size[u]) / dims[u]);
              point.setComponent(v, -scale + ((b + 0.5) * size[v]) / dims[v]);
              for (let sample = 0; sample < 41; sample++) {
                point.setComponent(axis, (-0.975 + sample * 0.04875) * scale);
                const field = Math.min(
                  ...referenceSweeps.map((sweep) => evaluateGpuSweep(sweep, point)),
                );
                const stockField = mixed
                  ? Math.max(Math.hypot(point.x, point.y) - scale, Math.abs(point.z) - scale)
                  : Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z)) - scale;
                if (Math.abs(field) < pitch * 0.002 || Math.abs(stockField) < pitch * 0.002)
                  continue;
                const expected = stockField < 0 && field >= 0;
                let actual = false;
                for (let i = 0; i < counts[ray]; i++) {
                  const offset = (ray * intervalCapacity + i) * 2;
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
            copyMs: Math.round(copyMs),
            deltaComputeMs: Math.round(deltaMs),
            copiedIntervalCapacity: copyCapacity,
            incrementalRaysChecked: stock.layout.rays,
            checked,
            visiblePixels: visible,
            estimatedMiB: +(stock.estimatedBytes / 1048576).toFixed(2),
            intervalCapacity,
            denseCutters,
            sparseComputeMs: Math.round(sparseMs),
            sparseValidationMs: Math.round(performance.now() - sparseStarted),
            storedTiles: sparse.layout.storedTiles.length,
            totalTiles: sparse.layout.tiles,
            historyEvents,
            historyJumps: jumpMeasurements,
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
