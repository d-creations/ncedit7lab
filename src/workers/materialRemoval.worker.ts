/// <reference lib="webworker" />
import { simulateMaterialRemoval } from '../services/simulation/MaterialRemovalEngine';
import type { SimulationInput } from '../services/simulation/SimulationTypes';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<SimulationInput>) => {
  try {
    let lastProgress = 0;
    const result = simulateMaterialRemoval(event.data, (processed, total) => {
      const now = performance.now();
      if (processed === 0 || processed === total || now - lastProgress >= 100) {
        self.postMessage({ type: 'progress', processed, total });
        lastProgress = now;
      }
    });
    self.postMessage(
      { type: 'result', result },
      result.chunks.flatMap((chunk) => [chunk.positions.buffer, chunk.normals.buffer]),
    );
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Material removal failed',
    });
  }
};
