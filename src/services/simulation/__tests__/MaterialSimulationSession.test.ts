// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { MaterialSimulationSession, type SimulationWorker } from '../MaterialSimulationSession';
import { simulateMaterialRemoval } from '../MaterialRemovalEngine';
import type { SimulationInput, SimulationWorkerMessage } from '../SimulationTypes';

function input(): SimulationInput {
  return {
    algorithmVersion: 1,
    stock: { type: 'box', width: 2, height: 2, depth: 2 },
    resolutionMm: 0.5,
    motions: [],
    binding: {
      frameId: 'workpiece:test',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      spindleOrigin: [0, 0, 0],
      spindleAxis: [0, 0, 1],
    },
  };
}
function worker(): SimulationWorker {
  return {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
  };
}
function send(target: SimulationWorker, data: SimulationWorkerMessage): void {
  target.onmessage?.(new MessageEvent('message', { data }));
}

describe('run-owned material simulation session', () => {
  it('reports progress, retains the result for its run and releases the worker', async () => {
    const fake = worker();
    const session = new MaterialSimulationSession('run-1', () => fake);
    const progress = vi.fn();
    const pending = session.start(input(), progress);
    send(fake, { type: 'progress', processed: 0, total: 1 });
    expect(progress).toHaveBeenCalledExactlyOnceWith(0, 1);
    const result = simulateMaterialRemoval(input());
    send(fake, { type: 'result', result });
    expect(await pending).toBe(result);
    expect(session.result).toBe(result);
    expect(session.runId).toBe('run-1');
    expect(fake.terminate).toHaveBeenCalledOnce();
    session.cancel();
    expect(session.result).toBeUndefined();
  });

  it('cancels by terminating the worker immediately and ignores late results', async () => {
    const fake = worker();
    const session = new MaterialSimulationSession('run-1', () => fake);
    const pending = session.start(input(), vi.fn());
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const started = performance.now();
    session.cancel();
    expect(performance.now() - started).toBeLessThan(100);
    expect(fake.terminate).toHaveBeenCalledOnce();
    send(fake, { type: 'result', result: simulateMaterialRemoval(input()) });
    await rejection;
    expect(session.result).toBeUndefined();
  });

  it('supersedes an earlier worker without allowing its response to replace a newer result', async () => {
    const first = worker(),
      second = worker();
    const create = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const session = new MaterialSimulationSession('run-1', create);
    const old = session.start(input(), vi.fn());
    const rejection = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    const latest = session.start(input(), vi.fn());
    send(first, { type: 'result', result: simulateMaterialRemoval(input()) });
    expect(session.result).toBeUndefined();
    const result = simulateMaterialRemoval(input());
    send(second, { type: 'result', result });
    expect(await latest).toBe(result);
    await rejection;
  });

  it.each(['reported', 'event', 'decode', 'post'])(
    'surfaces worker failure: %s',
    async (failure) => {
      const fake = worker();
      if (failure === 'post')
        fake.postMessage = () => {
          throw new Error('post failed');
        };
      const session = new MaterialSimulationSession('run-1', () => fake);
      const pending = session.start(input(), vi.fn());
      const rejection = expect(pending).rejects.toThrow();
      if (failure === 'reported') send(fake, { type: 'error', message: 'budget exceeded' });
      if (failure === 'event')
        fake.onerror?.(new ErrorEvent('error', { message: 'worker failed' }));
      if (failure === 'decode') fake.onmessageerror?.(new MessageEvent('messageerror'));
      await rejection;
      expect(fake.terminate).toHaveBeenCalledOnce();
      expect(session.result).toBeUndefined();
    },
  );

  it('surfaces worker construction failure without leaving a pending session', async () => {
    const session = new MaterialSimulationSession('run-1', () => {
      throw new Error('Worker unavailable');
    });
    await expect(session.start(input(), vi.fn())).rejects.toThrow('Worker unavailable');
    session.cancel();
  });
});
