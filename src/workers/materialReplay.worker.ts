/// <reference lib="webworker" />
import {
  MaterialReplayEngine,
  type ReplayWorkerRequest,
} from '../services/simulation/MaterialReplayEngine';

declare const self: DedicatedWorkerGlobalScope;

let replay: MaterialReplayEngine | undefined;
self.onmessage = (event: MessageEvent<ReplayWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'initialize') {
      replay = new MaterialReplayEngine(request.input, request.steps);
    }
    if (!replay) throw new Error('Material replay has not been initialized');
    let lastProgress = 0;
    const frame = replay.seek(
      request.type === 'initialize' ? 0 : request.position,
      request.type === 'initialize' || request.forceReplace,
      (processed, total) => {
        const now = performance.now();
        if (processed === 0 || processed === total || now - lastProgress >= 100) {
          self.postMessage({ type: 'progress', requestId: request.requestId, processed, total });
          lastProgress = now;
        }
      },
    );
    self.postMessage(
      { type: 'frame', requestId: request.requestId, frame },
      frame.chunks.flatMap((chunk) => [chunk.positions.buffer, chunk.normals.buffer]),
    );
  } catch (error) {
    replay = undefined;
    self.postMessage({
      type: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : 'Material replay failed',
    });
  }
};
