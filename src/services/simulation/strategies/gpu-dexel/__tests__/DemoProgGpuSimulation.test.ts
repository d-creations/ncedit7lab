/// <reference types="vite/client" />
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { ComputeNode, WebGPURenderer, WGSLNodeBuilder } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import type { PlotResponse } from '@core/types';
import { BackendGateway } from '@services/BackendGateway';
import { EventBus } from '@services/EventBus';
import { ExecutedProgramService } from '@services/ExecutedProgramService';
import { FileManagerService } from '@services/FileManagerService';
import { createPlotReplayTimeline } from '@services/tools/PlotReplayTimeline';
import { ProgramToolService } from '@services/tools/ProgramToolService';
import { SimulationCommentCodec } from '@services/tools/SimulationCommentCodec';
import {
  compileGpuSweeps,
  evaluateGpuSweepRayCuts,
  usesAnalyticalFlatRayCuts,
  usesAnalyticalProfileRayCuts,
} from '../GpuSweepCompiler';
import { GpuMaterialReplaySession, type GpuReplayFrame } from '../GpuMaterialReplaySession';
import { indexDexelTiles } from '../DexelLayout';

const testDir = dirname(fileURLToPath(import.meta.url));
const paText = readFileSync(resolve(testDir, 'DEMOPARTSR20RIV.PA'), 'utf-8');
const backendResponse = JSON.parse(
  readFileSync(resolve(testDir, 'demoprog.json'), 'utf-8'),
) as PlotResponse;

function createMockGpuDeviceAndRenderer() {
  const renderer = new WebGPURenderer();
  vi.spyOn(renderer, 'hasFeature').mockReturnValue(false);
  let computeShader: string | undefined;
  const compute = vi.spyOn(renderer, 'compute').mockImplementation((node) => {
    if (!computeShader && node instanceof ComputeNode) {
      const builder = new WGSLNodeBuilder(new THREE.Object3D(), renderer);
      builder.compute = node;
      computeShader = generateShader(builder, 'computeShader');
    }
    return undefined;
  });
  const read = vi
    .spyOn(renderer, 'getArrayBufferAsync')
    .mockResolvedValue(new Uint32Array(4).buffer);
  const complete = vi.fn().mockResolvedValue(undefined);
  const device = {
    lost: new Promise<GPUDeviceLostInfo>(() => {}),
    queue: { onSubmittedWorkDone: complete },
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn().mockResolvedValue(null),
    createShaderModule: vi.fn(),
  } as unknown as GPUDevice;
  return { renderer, device, compute, read, complete, getComputeShader: () => computeShader };
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

describe('DEMOPARTSR20RIV GPU simulation integration & timing', () => {
  it('prepares material removal, compiles GPU sweeps, verifies WGSL + ray cuts, and runs GPU replay within time budgets', async () => {
    const t0 = performance.now();
    const bus = new EventBus();
    const fileManager = new FileManagerService(bus, undefined, false);
    const ncFile = await fileManager.openFile(paText, 'DEMOPARTSR20RIV.PA', {
      parseMultiChannel: true,
    });

    const tools = new ProgramToolService(new SimulationCommentCodec());
    const channel1Text = ncFile.channels[0];
    const snapshot1 = tools.captureProgramSnapshot(
      { documentId: ncFile.id, programId: 'O1234.P1', channelId: '1' },
      0,
      channel1Text,
      { kind: 'block', open: '(', close: ')' },
    );

    expect(snapshot1.valid).toBe(true);
    expect(snapshot1.diagnostics).toEqual([]);
    expect(snapshot1.tools.map((t) => t.toolNumber)).toEqual([100, 200, 1100, 1200, 3100, 1300]);

    const backend = {
      requestPlot: vi.fn().mockResolvedValue(backendResponse),
    } as unknown as BackendGateway;
    const executedService = new ExecutedProgramService(backend, bus);

    const tRunStart = performance.now();
    const run = await executedService.executePlotRun(
      [
        {
          snapshot: snapshot1,
          machineName: 'FANUC_STAR_SR20R_IV_B',
          toolValues: tools.getToolValues(snapshot1),
          customVariables: [],
          materialSimulation: {
            binding: {
              frameId: 'workpiece:mainSpindle',
              position: [0, 0, 0],
              rotation: [0, 0, 0],
              spindleOrigin: [0, 0, 0],
              spindleAxis: [0, 0, 1],
            },
            resolutionMm: 0.05,
          },
        },
      ],
      true,
      'simulation',
    );
    const executePlotRunMs = performance.now() - tRunStart;

    expect(run.materialRemoval?.status).toBe('ready');
    expect(run.materialRemoval?.simulation?.stop).toBeUndefined();
    expect(run.plotMetadata.segments.length).toBe(7084);
    const simulation = run.materialRemoval!.simulation!;
    expect(simulation.motions.length).toBe(6463);

    const byToolAndMode = new Map<string, number>();
    for (const m of simulation.motions) {
      const k = `T${m.tool.toolNumber}:${m.mode}:${m.tool.cutting?.[0]?.type}`;
      byToolAndMode.set(k, (byToolAndMode.get(k) ?? 0) + 1);
    }
    expect(Object.fromEntries(byToolAndMode)).toEqual({
      'T200:turning:insert': 100,
      'T1100:milling:drill': 60,
      'T1200:milling:drill': 60,
      'T3100:milling:endMill': 6200,
      'T1300:turning:insert': 20,
      'T100:turning:insert': 23,
    });

    const tCompileStart = performance.now();
    const sweeps = compileGpuSweeps(simulation);
    const compileSweepsMs = performance.now() - tCompileStart;
    expect(sweeps.length).toBe(6463);

    const timeline = createPlotReplayTimeline(run);
    const steps = timeline.occurrences.map((occ) => occ.executionStep);
    expect(steps.length).toBe(624);

    const { renderer, device, compute, getComputeShader } = createMockGpuDeviceAndRenderer();
    let refinedFrame: GpuReplayFrame | undefined;
    let refineError: Error | undefined;
    const session = new GpuMaterialReplaySession('demo-run', renderer, device, {
      finePitchMm: 0.02,
      refinementDelayMs: 0,
      onRefined: (frame) => {
        refinedFrame = frame;
      },
      onRefinementError: (err) => {
        refineError = err;
      },
    });

    try {
      const tReplayStart = performance.now();
      const frame = await session.start(simulation, steps, undefined, true);
      const coarseStartMs = performance.now() - tReplayStart;

      expect(frame.backend).toBe('webgpu-dexel');
      expect(frame.position).toBe(624);
      expect(frame.processedMotions).toBe(6463);
      expect(frame.phase).toBe('coarse');
      expect(frame.pitchMm).toBe(0.1);
      expect(frame.stop).toBeUndefined();
      expect(compute.mock.calls.length).toBeGreaterThan(0);
      expect(compute.mock.calls.length).toBeLessThanOrEqual(145);

      if (frame.backend !== 'webgpu-dexel') throw new Error('Expected webgpu-dexel frame');
      const coarseStock = frame.stock;
      const base = coarseStock.rotationalBase!;
      expect(base).toBeDefined();
      expect(base.maxIntervals).toBeLessThanOrEqual(16);

      // Verify WGSL shader generation for both compute and fragment stages
      expect(getComputeShader()).toContain('gpuBuildDexels');
      const meshBuilder = new WGSLNodeBuilder(coarseStock.group.children[0], renderer);
      Reflect.set(meshBuilder, 'camera', new THREE.PerspectiveCamera());
      expect(generateShader(meshBuilder, 'fragmentShader')).toContain('gpuStockMatcap');

      const coarseSubmits = compute.mock.calls.length;
      const tFineStart = performance.now();
      await new Promise((r) => setTimeout(r, 10));
      while (session.computing) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const fineRefinementMs = performance.now() - tFineStart;
      const fineSubmits = compute.mock.calls.length - coarseSubmits;
      if (refineError) throw refineError;
      expect(refinedFrame).toBeDefined();
      expect(refinedFrame!.phase).toBe('fine');
      expect(refinedFrame!.pitchMm).toBe(0.02);
      expect(refinedFrame!.estimatedBytes).toBeLessThanOrEqual(256 * 1024 * 1024);
      // Batched analytical dispatches reduce 0.02 mm fine submissions by ~7-10x (from 1,076 down to < 200)
      expect(fineSubmits).toBeLessThan(200);

      // Verify 100% analytical fast-path coverage for all active 3D sweeps
      const activeSweeps = sweeps
        .filter((s) => s.data[0] !== 5)
        .map((s) => ({ ...s, bounds: base.materialBounds(s.bounds) }))
        .filter((s) => !s.bounds.isEmpty());
      expect(activeSweeps.length).toBeGreaterThan(3000);
      expect(activeSweeps.length).toBeLessThanOrEqual(4268);
      const flatCount = activeSweeps.filter(usesAnalyticalFlatRayCuts).length;
      const profileCount = activeSweeps.filter(usesAnalyticalProfileRayCuts).length;
      expect(flatCount + profileCount).toBe(activeSweeps.length);

      // Verify coarse stock retained clean unmutated tileRanges after preparedIndex sharing
      const stockRanges = Reflect.get(coarseStock, 'tileRanges') as Uint32Array;
      const expectedHeaderOffset =
        coarseStock.layout.tiles + (coarseStock.rotationalBase?.words.length ?? 1);
      for (let t = 0; t < coarseStock.layout.tiles; t++) {
        if (stockRanges[t * 2 + 1] > 0) {
          expect(stockRanges[t * 2]).toBeGreaterThanOrEqual(expectedHeaderOffset);
          expect(stockRanges[t * 2] + stockRanges[t * 2 + 1]).toBeLessThanOrEqual(
            expectedHeaderOffset + activeSweeps.length * 64,
          );
        }
      }

      // Verify GPU ray-cut kernel across all stored tiles (maxIntervalsObserved = 5 <= 8)
      const tKernel0 = performance.now();
      const layout = coarseStock.layout;
      const tileIndex = indexDexelTiles(layout, activeSweeps, undefined, true);
      const minSpan = Math.max(
        1e-7,
        Math.min(
          layout.size.x / layout.dimensions.x,
          layout.size.y / layout.dimensions.y,
          layout.size.z / layout.dimensions.z,
        ) * 0.0005,
      );
      let evaluatedRays = 0;
      let modifiedRays = 0;
      let maxIntervalsObserved = 0;
      const origin = new THREE.Vector3();
      const direction = new THREE.Vector3();

      for (const tile of layout.storedTiles) {
        const rangeOffset = tileIndex.ranges[tile * 2];
        const rangeCount = tileIndex.ranges[tile * 2 + 1];
        if (rangeCount === 0) continue;
        let axis = 0;
        let localTile = tile;
        while (localTile >= layout.tileCounts[axis]) {
          localTile -= layout.tileCounts[axis];
          axis++;
        }
        const u = axis === 0 ? 1 : 0;
        const v = axis === 2 ? 1 : 2;
        const tilesU = Math.ceil(layout.dimensions.getComponent(u) / 32);
        direction.set(0, 0, 0).setComponent(axis, 1);

        for (let localRay = 0; localRay < 1024; localRay += 64) {
          const a = (localTile % tilesU) * 32 + (localRay % 32);
          const b = Math.floor(localTile / tilesU) * 32 + Math.floor(localRay / 32);
          if (a >= layout.dimensions.getComponent(u) || b >= layout.dimensions.getComponent(v))
            continue;
          origin.set(0, 0, 0);
          origin.setComponent(
            u,
            -layout.size.getComponent(u) * 0.5 +
              ((a + 0.5) * layout.size.getComponent(u)) / layout.dimensions.getComponent(u),
          );
          origin.setComponent(
            v,
            -layout.size.getComponent(v) * 0.5 +
              ((b + 0.5) * layout.size.getComponent(v)) / layout.dimensions.getComponent(v),
          );
          let segments = base.intervals(axis, origin);
          if (segments.length === 0) continue;
          const initialCount = segments.length;
          const initialFirst = segments[0][0];
          const initialLast = segments[segments.length - 1][1];
          evaluatedRays++;
          maxIntervalsObserved = Math.max(maxIntervalsObserved, segments.length);

          let lo = -layout.size.getComponent(axis) * 0.5;
          let hi = layout.size.getComponent(axis) * 0.5;
          if (axis !== 2) {
            const radius = layout.size.x * 0.5;
            const other = origin.getComponent(1 - axis);
            const sq = radius * radius - other * other;
            if (sq <= 0) continue;
            lo = -Math.sqrt(sq);
            hi = -lo;
          }

          for (let e = 0; e < rangeCount; e++) {
            if (segments.length === 0) break;
            const sweepIdx = tileIndex.sweeps[rangeOffset + e];
            const sweep = activeSweeps[sweepIdx];
            const min = sweep.bounds.min;
            const max = sweep.bounds.max;
            if (
              origin.getComponent(u) < min.getComponent(u) ||
              origin.getComponent(u) > max.getComponent(u) ||
              origin.getComponent(v) < min.getComponent(v) ||
              origin.getComponent(v) > max.getComponent(v)
            )
              continue;
            const end = Math.min(hi, max.getComponent(axis) + minSpan);
            const t = Math.max(lo, min.getComponent(axis) - minSpan);
            if (t >= end) continue;
            let touches = false;
            for (let i = 0; i < segments.length; i++) {
              if (t < segments[i][1] && end > segments[i][0]) {
                touches = true;
                break;
              }
            }
            if (!touches) continue;
            const cuts = evaluateGpuSweepRayCuts(sweep, origin, direction, [t, end]);
            expect(cuts).not.toBe(99);
            if (cuts === 99) continue;
            for (const [cutLo, cutHi] of cuts) {
              if (cutLo >= cutHi) continue;
              const next: [number, number][] = [];
              for (const [segLo, segHi] of segments) {
                if (cutHi <= segLo || cutLo >= segHi) {
                  next.push([segLo, segHi]);
                } else {
                  if (segLo + minSpan < cutLo) next.push([segLo, cutLo]);
                  if (segHi - minSpan > cutHi) next.push([cutHi, segHi]);
                }
              }
              segments = next;
              maxIntervalsObserved = Math.max(maxIntervalsObserved, segments.length);
              expect(segments.length).toBeLessThanOrEqual(8);
            }
          }
          if (
            segments.length !== initialCount ||
            segments[0]?.[0] !== initialFirst ||
            segments[segments.length - 1]?.[1] !== initialLast
          ) {
            modifiedRays++;
          }
        }
      }
      const kernelVerifyMs = performance.now() - tKernel0;

      // Verify seeking to turning-only prefix (step 40, after T200 front turning) uses revolved stock
      const turningOnlyFrame = await session.seek(40);
      expect(turningOnlyFrame.backend).toBe('hybrid-turning');
      expect(turningOnlyFrame.processedMotions).toBe(100);

      console.info('[DEMOPARTSR20RIV GPU Simulation Summary]', {
        totalElapsedMs: Math.round(performance.now() - t0),
        executePlotRunMs: Math.round(executePlotRunMs),
        compileSweepsMs: Math.round(compileSweepsMs),
        coarseStartMs: Math.round(coarseStartMs),
        fineRefinementMs: Math.round(fineRefinementMs),
        kernelVerifyMs: Math.round(kernelVerifyMs),
        coarseSubmits,
        fineSubmits,
        compiledSweepMiB: +(Reflect.get(session, 'compiledSweepBytes') / 1048576).toFixed(2),
        coarseIntervalCapacity: coarseStock.layout.intervalCapacity,
        coarseEstimatedMiB: +(frame.estimatedBytes / 1048576).toFixed(2),
        fineIntervalCapacity:
          refinedFrame!.backend === 'webgpu-dexel'
            ? refinedFrame!.stock.layout.intervalCapacity
            : 0,
        fineEstimatedMiB: +(refinedFrame!.estimatedBytes / 1048576).toFixed(2),
      });

      expect(evaluatedRays).toBeGreaterThan(500);
      expect(modifiedRays).toBeGreaterThan(100);
      expect(maxIntervalsObserved).toBeLessThanOrEqual(8);
      expect(refinedFrame!.estimatedBytes).toBeLessThan(128 * 1024 * 1024);
      expect(executePlotRunMs).toBeLessThan(1500);
      expect(compileSweepsMs).toBeLessThan(600);
      expect(coarseStartMs).toBeLessThan(1500);
    } finally {
      session.cancel();
    }
  }, 30000);
});
