/// <reference types="vite/client" />
import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { PlotResponse, ServerMachineListResponse } from '@core/types';
import { BackendGateway } from '../../BackendGateway';
import { ExecutedProgramService } from '../../ExecutedProgramService';
import { EventBus } from '../../EventBus';
import { MachineService } from '../../MachineService';
import { ProgramToolService } from '../../tools/ProgramToolService';
import { SimulationCommentCodec } from '../../tools/SimulationCommentCodec';
import {
  simulateMaterialRemoval,
  MaterialRemovalEngine,
  batchRemovalMotions,
} from '../MaterialRemovalEngine';
import { StockMeshBuilder } from '../StockMeshBuilder';
import { SIMULATION_LIMITS } from '../SimulationTypes';
import { MaterialReplayEngine, REPLAY_LIMITS, type ReplayFrame } from '../MaterialReplayEngine';
import { MemoryReplayTraceStore } from '../ReplayTraceStore';
import { createPlotReplayTimeline } from '../../tools/PlotReplayTimeline';
import text from './fixtures/star-mixed-removal.nc?raw';

vi.mock('../../BackendGateway');

describe.skipIf(import.meta.env.RUN_STAR_REMOVAL_BENCHMARK !== '1')(
  'live STAR mixed-program benchmark',
  () => {
    it(
      'executes the supplied program in mainSpindle and measures .05 mm removal without changing editor state',
      async () => {
        const base = import.meta.env.NC_EDIT_BENCHMARK_URL ?? 'http://localhost:8000';
        const key = import.meta.env.NC_EDIT_BENCHMARK_API_KEY;
        if (!key) throw new Error('Set NC_EDIT_BENCHMARK_API_KEY for the existing local backend');
        const machinesResponse = await fetch(`${base}/api/machines`);
        if (!machinesResponse.ok)
          throw new Error(`Machine request failed: ${machinesResponse.status}`);
        const machines: ServerMachineListResponse = await machinesResponse.json();
        const backend = new BackendGateway();
        vi.mocked(backend.listMachines).mockResolvedValue(machines);
        const profiles = new MachineService(backend, new EventBus());
        await profiles.fetchMachines();
        const machine = profiles.getMachine('FANUC_STAR_SR20R_IV_B');
        if (!machine) throw new Error('Configured STAR SR-20R IV profile is unavailable');
        const tools = new ProgramToolService(new SimulationCommentCodec());
        const snapshot = tools.captureProgramSnapshot(
          { documentId: 'benchmark', programId: 'O0001', channelId: '1' },
          0,
          text,
          { kind: 'block', open: '(', close: ')' },
        );
        expect(snapshot.valid).toBe(true);
        vi.mocked(backend.requestPlot).mockImplementation(
          async (request): Promise<PlotResponse> => {
            const response = await fetch(`${base}/cgiserver_import`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
              body: JSON.stringify(request),
            });
            if (!response.ok) throw new Error(`Program request failed: ${response.status}`);
            return response.json();
          },
        );
        const service = new ExecutedProgramService(backend, new EventBus());
        const run = await service.executePlotRun(
          [
            {
              snapshot,
              machineName: machine.machineName,
              machineProfile: machine,
              toolValues: tools.getToolValues(snapshot),
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
        const simulation = run.materialRemoval?.simulation;
        if (!simulation)
          throw new Error(
            `Removal preparation failed: ${JSON.stringify(run.materialRemoval?.diagnostics)}`,
          );
        const baseline =
          import.meta.env.COMPARE_STAR_REMOVAL_BENCHMARK === '1'
            ? simulateMaterialRemoval({ ...simulation, rotationalProfile: false })
            : undefined;
        const result = simulateMaterialRemoval(simulation);
        expect(result.status).toBe('completed');
        expect(result.stop).toBeUndefined();
        expect(simulation.motions.length).toBe(162);
        expect(result.processedMotions).toBe(simulation.motions.length);
        expect(result.samples).toBe(16);
        expect(result.chunks.length).toBeGreaterThan(0);
        expect(SIMULATION_LIMITS.stockBytes).toBe(256 * 1024 * 1024);
        expect(result.peakStockBytes).toBeLessThanOrEqual(SIMULATION_LIMITS.stockBytes);
        expect(result.removedCells).toBe(15891836);
        const operations = result.operationDiagnostics;
        if (!operations) throw new Error('Expected measured machining operations');
        expect(operations.map((operation) => operation.mode)).toEqual([
          'turning',
          'milling',
          'turning',
          'milling',
        ]);
        expect(operations.map((operation) => operation.fastPath)).toEqual([
          'rotational',
          'adaptive',
          'rotational',
          'adaptive',
        ]);
        expect(operations.reduce((count, operation) => count + operation.motionCount, 0)).toBe(162);
        expect(result.analyticalPanels).toBeGreaterThan(0);
        expect(result.meshingAttribution).toBe('final-only');
        expect(
          result.meshingDiagnostics?.reduce((count, chunk) => count + chunk.outputTriangles, 0),
        ).toBe(result.outputTriangles);
        if (baseline) {
          expect(result.removedCells).toBe(baseline.removedCells);
          expect(result.boundaryCells).toBeLessThan(baseline.boundaryCells / 3);
          expect(result.allocatedNodes).toBeLessThan(baseline.allocatedNodes / 3);
          expect(result.surfaceBytes).toBeLessThan(baseline.surfaceBytes);
        }
        if (import.meta.env.RUN_STAR_TOPOLOGY_BENCHMARK === '1') {
          const measurements = [];
          for (const count of [30, 161]) {
            for (const order of ['streamed-first', 'reused-first'] as const) {
              const input = { ...simulation, motions: simulation.motions.slice(0, count) };
              const streamedEngine = new MaterialRemovalEngine(input);
              streamedEngine.applyBatches(batchRemovalMotions(input.motions));
              const reusedEngine = new MaterialRemovalEngine(input);
              reusedEngine.applyBatches(batchRemovalMotions(input.motions));
              const streamed = new StockMeshBuilder(undefined, { topologyCacheBytes: 0 });
              const reused = new StockMeshBuilder();
              const surfaceBytes = (builder: StockMeshBuilder): number =>
                builder
                  .getChunks()
                  .reduce(
                    (sum, chunk) =>
                      sum + chunk.positions.byteLength + chunk.normals.byteLength + 512,
                    0,
                  );
              const measure = (
                engine: MaterialRemovalEngine,
                builder: StockMeshBuilder,
                peer: MaterialRemovalEngine,
                retainedSurfaceBytes: number,
              ): number => {
                engine.stock.setReplayWorkspaceBytes(
                  peer.stock.allocatedBytes + result.surfaceBytes + retainedSurfaceBytes,
                );
                const started = performance.now();
                builder.buildChanged(engine.stock);
                return performance.now() - started;
              };
              let streamedMs: number;
              let reusedMs: number;
              if (order === 'streamed-first') {
                streamedMs = measure(streamedEngine, streamed, reusedEngine, 0);
                reusedMs = measure(reusedEngine, reused, streamedEngine, surfaceBytes(streamed));
              } else {
                reusedMs = measure(reusedEngine, reused, streamedEngine, 0);
                streamedMs = measure(streamedEngine, streamed, reusedEngine, surfaceBytes(reused));
              }
              const expected = new Map(streamed.getChunks().map((chunk) => [chunk.id, chunk]));
              expect(reused.getChunks().length).toBe(expected.size);
              for (const chunk of reused.getChunks()) {
                const reference = expected.get(chunk.id);
                if (!reference) throw new Error(`Missing reference chunk ${chunk.id}`);
                for (const key of ['positions', 'normals'] as const) {
                  const actual = new Uint32Array(
                    chunk[key].buffer,
                    chunk[key].byteOffset,
                    chunk[key].length,
                  );
                  const original = new Uint32Array(
                    reference[key].buffer,
                    reference[key].byteOffset,
                    reference[key].length,
                  );
                  expect(actual.length, `${count} motions, chunk ${chunk.id}, ${key}`).toBe(
                    original.length,
                  );
                  expect(
                    actual.every((word, index) => word === original[index]),
                    `${count} motions, chunk ${chunk.id}, ${key}`,
                  ).toBe(true);
                }
              }
              expect(reusedEngine.stock.removedCells).toBe(streamedEngine.stock.removedCells);
              expect(reusedEngine.stock.peakAllocatedBytes).toBeLessThanOrEqual(
                SIMULATION_LIMITS.stockBytes,
              );
              expect(reused.topologyPasses).toBe(1);
              const measurement = {
                count,
                order,
                streamedMs,
                reusedMs,
                streamedExtractionMs: streamed.extractionMs,
                reusedExtractionMs: reused.extractionMs,
                topologyMiB: reused.topologyCachePeakBytes / 1048576,
                peakMiB: reusedEngine.stock.peakAllocatedBytes / 1048576,
                exactGeometryAndNormals: true,
              };
              measurements.push(measurement);
              console.info('live STAR topology reuse benchmark', JSON.stringify(measurement));
            }
          }
          if (process.env.NC_EDIT_BENCHMARK_RESULTS_FILE)
            writeFileSync(
              process.env.NC_EDIT_BENCHMARK_RESULTS_FILE,
              JSON.stringify(measurements, null, 2),
            );
        }
        if (import.meta.env.RUN_STAR_PARTIAL_REPLAY_BENCHMARK === '1') {
          const timeline = createPlotReplayTimeline(run);
          const steps = timeline.occurrences.map((occurrence) => occurrence.executionStep);
          const replay = new MaterialReplayEngine(simulation, steps);
          replay.setTraceStore(new MemoryReplayTraceStore());
          const records: object[] = [];
          try {
            const prepared = await replay.prepareFinal(() => {});
            expect(prepared.removedCells).toBe(result.removedCells);
            expect(prepared.processedMotions).toBe(162);
            expect(prepared.historyMode).toBe('partial-disk');
            expect(
              prepared.finalResult?.operationDiagnostics?.map((operation) => operation.mode),
            ).toEqual(['turning', 'milling', 'turning', 'milling']);
            const firstMilling = simulation.motions.find((motion) => motion.mode === 'milling');
            if (!firstMilling) throw new Error('Mixed replay fixture requires milling');
            const millingPosition = steps.indexOf(firstMilling.executionStep) + 1;
            const visited = new Set([steps.length]);
            for (const position of [
              millingPosition - 1,
              millingPosition,
              steps.length,
              millingPosition - 1,
              millingPosition,
              0,
              steps.length,
              0,
              steps.length,
            ]) {
              const frame = await replay.seekRecorded(position);
              expect(frame.historyMode).toBe('partial-disk');
              expect(frame.appliedMotions).toBe(0);
              if (visited.has(position)) expect(frame.surfaceCacheHit).toBe(true);
              visited.add(position);
              expect(frame.surfaceCacheBytes).toBeLessThanOrEqual(REPLAY_LIMITS.surfaceCacheBytes);
              expect(frame.peakStockBytes).toBeLessThanOrEqual(SIMULATION_LIMITS.stockBytes);
              if (position === steps.length) expect(frame.removedCells).toBe(result.removedCells);
              records.push({
                position,
                removedCells: frame.removedCells,
                elapsedMs: frame.elapsedMs,
                meshingMs: frame.meshingMs,
                historyMs: frame.historyMs,
                historyBytes: frame.historyBytes,
                peakBytes: frame.peakStockBytes,
                appliedMotions: frame.appliedMotions,
                surfaceCacheHit: frame.surfaceCacheHit,
                surfaceCacheBytes: frame.surfaceCacheBytes,
                surfaceCacheMissReason: frame.surfaceCacheMissReason,
                surfaceCacheEvictions: frame.surfaceCacheEvictions,
                extractionMs: frame.extractionMs,
                triangulationMs: frame.triangulationMs,
                adaptationMs: frame.adaptationMs,
                dirtyChunks: frame.dirtyChunks,
                remeshedChunks: frame.remeshedChunks,
              });
            }
            console.info(
              'live STAR partial history (uncompressed deterministic store)',
              JSON.stringify({ preparationMs: prepared.elapsedMs, records }),
            );
          } finally {
            await replay.close();
          }
        }
        if (import.meta.env.RUN_STAR_REPLAY_BENCHMARK === '1') {
          const timeline = createPlotReplayTimeline(run);
          const steps = timeline.occurrences.map((occurrence) => occurrence.executionStep);
          const firstMilling = simulation.motions.find((motion) => motion.mode === 'milling');
          if (!firstMilling) throw new Error('Mixed replay fixture requires milling');
          const millingPosition = steps.indexOf(firstMilling.executionStep) + 1;
          const replay = new MaterialReplayEngine(simulation, steps, { checkpointInterval: 1 });
          const records: object[] = [];
          const record = (frame: ReplayFrame) => {
            expect(frame.peakStockBytes).toBeLessThanOrEqual(SIMULATION_LIMITS.stockBytes);
            expect(frame.checkpointBytes).toBeLessThanOrEqual(REPLAY_LIMITS.checkpointBytes);
            expect(frame.checkpointCount).toBeLessThanOrEqual(REPLAY_LIMITS.checkpoints);
            records.push({
              position: frame.position,
              processedMotions: frame.processedMotions,
              appliedMotions: frame.appliedMotions,
              restoredPosition: frame.restoredPosition,
              elapsedMs: frame.elapsedMs,
              subtractionMs: frame.subtractionMs,
              meshingMs: frame.meshingMs,
              checkpointMs: frame.checkpointMs,
              removedCells: frame.removedCells,
              peakBytes: frame.peakStockBytes,
              checkpointBytes: frame.checkpointBytes,
              checkpointCount: frame.checkpointCount,
              skippedCheckpoints: frame.skippedCheckpoints,
              evictedCheckpoints: frame.evictedCheckpoints,
              replace: frame.replace,
              changedChunks: frame.chunks.length,
            });
            structuredClone(
              {},
              {
                transfer: frame.chunks.flatMap((chunk) => [
                  chunk.positions.buffer,
                  chunk.normals.buffer,
                ]),
              },
            );
          };
          record(replay.seek(0));
          record(replay.seek(millingPosition - 1));
          const milled = replay.seek(millingPosition);
          record(milled);
          const end = replay.seek(steps.length);
          expect(end.processedMotions).toBe(162);
          expect(end.removedCells).toBe(result.removedCells);
          expect(end.stop).toBeUndefined();
          record(end);
          const back = replay.seek(millingPosition);
          expect(back.removedCells).toBe(milled.removedCells);
          expect(back.remainingCells).toBe(milled.remainingCells);
          record(back);
          const resumed = replay.seek(steps.length);
          expect(resumed.removedCells).toBe(result.removedCells);
          expect(resumed.appliedMotions).toBeLessThan(simulation.motions.length);
          record(resumed);
          console.info(
            'live STAR .05 replay benchmark',
            JSON.stringify({
              completeTimeline: timeline.complete,
              occurrences: steps.length,
              records,
            }),
          );
        }
        console.info(
          'live STAR .05 benchmark',
          JSON.stringify({
            frameId: simulation.binding.frameId,
            status: result.status,
            stop: result.stop,
            processedMotions: result.processedMotions,
            samples: result.samples,
            elapsedMs: result.elapsedMs,
            subtractionMs: result.subtractionMs,
            meshingMs: result.meshingMs,
            peakBytes: result.peakStockBytes,
            retainedBytes: result.allocatedStockBytes,
            surfaceBytes: result.surfaceBytes,
            evaluations: result.cellTests,
            refinedCells: result.boundaryCells,
            allocatedNodes: result.allocatedNodes,
            removedCells: result.removedCells,
            adaptationSkippedChunks: result.surfaceAdaptationSkippedChunks,
            peakIntersectionCacheEntries: result.peakSurfaceIntersectionCacheEntries,
            peakCornerCacheEntries: result.peakSubtractionCornerCacheEntries,
            extractionMs: result.extractionMs,
            triangulationMs: result.triangulationMs,
            adaptationMs: result.adaptationMs,
            analyticalPanels: result.analyticalPanels,
            fineTriangles: result.fineTriangles,
            outputTriangles: result.outputTriangles,
            meshingMaterialDistanceTests: result.meshingMaterialDistanceTests,
            meshingMaterialPrimitiveTests: result.meshingMaterialPrimitiveTests,
            operations: result.operationDiagnostics?.map((op) => ({
              mode: op.mode,
              toolNumber: op.tool.toolNumber,
              motions: op.motionCount,
              elapsedMs: op.elapsedMs,
              cellTests: op.cellTests,
              materialPrimitiveTests: op.materialPrimitiveTests,
              boundaryCellsDelta: op.boundaryCellsDelta,
              allocatedNodesDelta: op.allocatedNodesDelta,
              fastPath: op.fastPath,
            })),
            baseline: baseline
              ? {
                  elapsedMs: baseline.elapsedMs,
                  subtractionMs: baseline.subtractionMs,
                  meshingMs: baseline.meshingMs,
                  peakBytes: baseline.peakStockBytes,
                  allocatedNodes: baseline.allocatedNodes,
                  refinedCells: baseline.boundaryCells,
                  surfaceBytes: baseline.surfaceBytes,
                  operations: baseline.operationDiagnostics?.map((op) => ({
                    mode: op.mode,
                    toolNumber: op.tool.toolNumber,
                    elapsedMs: op.elapsedMs,
                    cellTests: op.cellTests,
                    fastPath: op.fastPath,
                  })),
                }
              : undefined,
          }),
        );
      },
      import.meta.env.RUN_STAR_REPLAY_BENCHMARK === '1' ||
        import.meta.env.RUN_STAR_PARTIAL_REPLAY_BENCHMARK === '1' ||
        import.meta.env.RUN_STAR_TOPOLOGY_BENCHMARK === '1'
        ? 600000
        : 300000,
    );
  },
);
