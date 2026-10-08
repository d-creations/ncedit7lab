/// <reference types="vite/client" />
import { describe, expect, it, vi } from 'vitest';
import type { PlotResponse, ServerMachineListResponse } from '@core/types';
import { BackendGateway } from '../../BackendGateway';
import { ExecutedProgramService } from '../../ExecutedProgramService';
import { EventBus } from '../../EventBus';
import { MachineService } from '../../MachineService';
import { ProgramToolService } from '../../tools/ProgramToolService';
import { SimulationCommentCodec } from '../../tools/SimulationCommentCodec';
import { simulateMaterialRemoval } from '../MaterialRemovalEngine';
import { SIMULATION_LIMITS } from '../SimulationTypes';
import text from './fixtures/star-mixed-removal.nc?raw';

vi.mock('../../BackendGateway');

describe.skipIf(import.meta.env.RUN_STAR_REMOVAL_BENCHMARK !== '1')(
  'live STAR mixed-program benchmark',
  () => {
    it('executes the supplied program in mainSpindle and measures .05 mm removal without changing editor state', async () => {
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
      vi.mocked(backend.requestPlot).mockImplementation(async (request): Promise<PlotResponse> => {
        const response = await fetch(`${base}/cgiserver_import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
          body: JSON.stringify(request),
        });
        if (!response.ok) throw new Error(`Program request failed: ${response.status}`);
        return response.json();
      });
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
        }),
      );
    }, 300000);
  },
);
