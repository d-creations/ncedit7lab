// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { MaterialReplaySession, type ReplayWorker } from '../MaterialReplaySession';
import type {
  ReplayFrame,
  ReplayWorkerRequest,
  ReplayWorkerResponse,
} from '../MaterialReplayEngine';
import type { SimulationInput } from '../SimulationTypes';

function input(): SimulationInput {
  return {
    algorithmVersion: 2,
    stock: { type: 'box', width: 2, height: 2, depth: 2 },
    resolutionMm: 0.5,
    motions: [],
    binding: {
      frameId: 'workpiece:replay',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      spindleOrigin: [0, 0, 0],
      spindleAxis: [0, 0, 1],
    },
  };
}
function frame(position = 0): ReplayFrame {
  return {
    position,
    requestedPosition: position,
    total: 3,
    replace: true,
    chunks: [],
    stockToWorkpiece: [],
    processedMotions: 0,
    removedCells: 0,
    remainingCells: 64,
    elapsedMs: 0,
    subtractionMs: 0,
    meshingMs: 0,
    appliedMotions: 0,
    checkpointCount: 0,
    checkpointBytes: 0,
    skippedCheckpoints: 0,
    evictedCheckpoints: 0,
    peakStockBytes: 0,
  };
}
function worker(): ReplayWorker {
  return {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: vi.fn<(request: ReplayWorkerRequest) => void>(),
    terminate: vi.fn(),
  };
}
function send(worker: ReplayWorker, data: ReplayWorkerResponse): void {
  worker.onmessage?.(new MessageEvent('message', { data }));
}

describe('persistent material replay session', () => {
  it('captures immutable input and keeps one worker alive across forward and backward requests', async () => {
    const fake = worker(),
      create = vi.fn(() => fake);
    const session = new MaterialReplaySession('run-1', create);
    const source = input(),
      progress = vi.fn();
    const start = session.start(source, [0, 1, 2], progress);
    source.resolutionMm = 2;
    const request = vi.mocked(fake.postMessage).mock.calls[0][0];
    expect(request.type).toBe('initialize');
    if (request.type === 'initialize') {
      expect(request.input.resolutionMm).toBe(0.5);
      expect(Object.isFrozen(request.input)).toBe(true);
    }
    send(fake, { type: 'progress', requestId: 1, processed: 0, total: 0 });
    expect(progress).toHaveBeenCalledExactlyOnceWith(0, 0);
    send(fake, { type: 'frame', requestId: 1, frame: frame() });
    await start;
    for (const [index, position] of [2, 0].entries()) {
      const pending = session.seek(position);
      send(fake, { type: 'frame', requestId: index + 2, frame: frame(position) });
      expect((await pending).position).toBe(position);
    }
    expect(create).toHaveBeenCalledOnce();
    expect(fake.terminate).not.toHaveBeenCalled();
    session.cancel();
    expect(fake.postMessage).toHaveBeenLastCalledWith({ type: 'close', requestId: 0 });
    expect(fake.terminate).not.toHaveBeenCalled();
  });

  it('coalesces rapid seeks and requires a full replacement after a potentially discarded delta', async () => {
    const fake = worker(),
      session = new MaterialReplaySession('run', () => fake);
    const start = session.start(input(), [0, 1, 2]);
    send(fake, { type: 'frame', requestId: 1, frame: frame() });
    await start;
    const first = session.seek(1);
    const discarded = session.seek(2);
    const rejection = expect(discarded).rejects.toMatchObject({ name: 'AbortError' });
    const latest = session.seek(0);
    expect(fake.postMessage).toHaveBeenCalledTimes(2);
    send(fake, { type: 'frame', requestId: 2, frame: frame(1) });
    await first;
    await rejection;
    expect(vi.mocked(fake.postMessage).mock.calls[2][0]).toEqual({
      type: 'seek',
      requestId: 4,
      position: 0,
      forceReplace: true,
    });
    send(fake, { type: 'error', requestId: 3, message: 'obsolete' });
    send(fake, { type: 'frame', requestId: 4, frame: frame() });
    expect((await latest).position).toBe(0);
    expect(fake.terminate).not.toHaveBeenCalled();
    session.cancel();
  });

  it('cancels active and queued seeks immediately, ignoring obsolete workers', async () => {
    const a = worker(),
      b = worker(),
      create = vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(b);
    const session = new MaterialReplaySession('run', create);
    const active = session.start(input(), [0, 1, 2]);
    const queued = session.seek(2);
    const activeRejection = expect(active).rejects.toMatchObject({ name: 'AbortError' });
    const queuedRejection = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    const latest = session.start(input(), [0, 1, 2]);
    send(a, { type: 'frame', requestId: 1, frame: frame(2) });
    send(b, { type: 'frame', requestId: 3, frame: frame() });
    await Promise.all([activeRejection, queuedRejection, latest]);
    expect(a.postMessage).toHaveBeenLastCalledWith({ type: 'close', requestId: 0 });
    expect(a.terminate).not.toHaveBeenCalled();
    session.cancel();
  });

  it.each(['reported', 'event', 'decode', 'post', 'construction'])(
    'surfaces %s failures without leaving a usable worker',
    async (failure) => {
      const fake = worker();
      const create = () => {
        if (failure === 'construction') throw new Error('Worker unavailable');
        return fake;
      };
      if (failure === 'post')
        fake.postMessage = () => {
          throw new Error('post failed');
        };
      const session = new MaterialReplaySession('run', create);
      const pending = session.start(input(), [0, 1, 2]);
      const rejection = expect(pending).rejects.toThrow();
      if (failure === 'reported')
        send(fake, { type: 'error', requestId: 1, message: 'budget exceeded' });
      if (failure === 'event')
        fake.onerror?.(new ErrorEvent('error', { message: 'worker failed' }));
      if (failure === 'decode') fake.onmessageerror?.(new MessageEvent('messageerror'));
      await rejection;
      await expect(session.seek(0)).rejects.toThrow('Start material replay');
    },
  );

  it('rejects invalid seeks without posting a request', async () => {
    const fake = worker(),
      session = new MaterialReplaySession('run', () => fake);
    const pending = session.start(input(), [0]);
    send(fake, { type: 'frame', requestId: 1, frame: frame() });
    await pending;
    for (const position of [-1, 2, NaN])
      await expect(session.seek(position)).rejects.toThrow('outside');
    expect(fake.postMessage).toHaveBeenCalledOnce();
    session.cancel();
  });
});
