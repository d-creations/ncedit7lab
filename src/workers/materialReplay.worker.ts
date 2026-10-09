/// <reference lib="webworker" />
import {
  MaterialReplayEngine,
  type ReplayWorkerRequest,
} from '../services/simulation/MaterialReplayEngine';
import { openReplayTraceStore } from '../services/simulation/ReplayTraceStore';

declare const self: DedicatedWorkerGlobalScope;

let replay: MaterialReplayEngine | undefined;
let queue: Promise<void> = Promise.resolve();
let closing = false;

async function handle(request: ReplayWorkerRequest): Promise<void> {
  try {
    if (request.type === 'close') {
      await replay?.close();
      self.close();
      return;
    }
    if (closing) return;
    if (request.type === 'initialize') {
      await replay?.close();
      replay = new MaterialReplayEngine(request.input, request.steps);
      replay.setTraceStore(await openReplayTraceStore());
    }
    if (!replay) throw new Error('Material replay has not been initialized');
    let lastProgress = 0;
    const progress = (processed: number, total: number) => {
        const now = performance.now();
        if (processed === 0 || processed === total || now - lastProgress >= 100) {
          self.postMessage({ type: 'progress', requestId: request.requestId, processed, total });
          lastProgress = now;
        }
      };
    const frame = request.type === 'initialize' && request.prepareFinal
      ? await replay.prepareFinal(progress)
      : await replay.seekRecorded(request.type === 'initialize' ? 0 : request.position,
        request.type === 'initialize' || request.forceReplace, progress);
    self.postMessage(
      { type: 'frame', requestId: request.requestId, frame },
      frame.chunks.flatMap((chunk) => [chunk.positions.buffer, chunk.normals.buffer]),
    );
  } catch (error) {
    try {
      await replay?.close();
    } catch (cleanupError) {
      console.error('Material replay cache cleanup failed:', cleanupError);
    }
    replay = undefined;
    if (closing) {
      self.close();
      return;
    }
    self.postMessage({
      type: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : 'Material replay failed',
    });
  }
}

self.onmessage = (event: MessageEvent<ReplayWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'close') {
    closing = true;
    replay?.cancel();
  }
  queue = queue.then(() => handle(request));
};
