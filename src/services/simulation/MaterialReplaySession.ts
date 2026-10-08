import type { DeepReadonly } from '../tools/SimulationMetadata';
import { freezeMetadata } from '../tools/SimulationMetadata';
import type { SimulationInput } from './SimulationTypes';
import type {
  ReplayFrame,
  ReplayWorkerRequest,
  ReplayWorkerResponse,
} from './MaterialReplayEngine';

export interface ReplayWorker {
  onmessage: ((event: MessageEvent<ReplayWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(request: ReplayWorkerRequest): void;
  terminate(): void;
}

interface PendingSeek {
  request: ReplayWorkerRequest;
  resolve(frame: ReplayFrame): void;
  reject(error: Error): void;
}

export class MaterialReplaySession {
  private worker?: ReplayWorker;
  private active?: PendingSeek;
  private queued?: PendingSeek;
  private requestId = 0;
  private total = 0;
  private progress: (processed: number, total: number) => void = () => {};

  constructor(
    readonly runId: string,
    private readonly createWorker: () => ReplayWorker = () =>
      new Worker(new URL('../../workers/materialReplay.worker.ts', import.meta.url), {
        type: 'module',
      }),
  ) {}

  start(
    input: DeepReadonly<SimulationInput>,
    steps: readonly number[],
    progress: (processed: number, total: number) => void = () => {},
  ): Promise<ReplayFrame> {
    this.cancel();
    this.total = steps.length;
    this.progress = progress;
    try {
      const worker = this.createWorker();
      this.worker = worker;
      worker.onmessage = (event) => {
        if (this.worker !== worker || event.data.requestId !== this.active?.request.requestId)
          return;
        const message = event.data;
        if (message.type === 'progress') {
          this.progress(message.processed, message.total);
          return;
        }
        if (message.type === 'error') {
          this.fail(new Error(message.message));
          return;
        }
        const active = this.active!;
        this.active = undefined;
        active.resolve(message.frame);
        const queued = this.queued;
        this.queued = undefined;
        if (queued) this.send(queued);
      };
      worker.onerror = (event) => {
        if (this.worker === worker)
          this.fail(new Error(event.message || 'Material replay worker failed'));
      };
      worker.onmessageerror = () => {
        if (this.worker === worker)
          this.fail(new Error('Material replay worker response could not be decoded'));
      };
      const captured = freezeMetadata(structuredClone(input));
      return this.enqueue({
        type: 'initialize',
        requestId: ++this.requestId,
        input: captured,
        steps: [...steps],
      });
    } catch (error) {
      this.cancel();
      return Promise.reject(error);
    }
  }

  seek(position: number): Promise<ReplayFrame> {
    if (!this.worker) return Promise.reject(new Error('Start material replay before seeking'));
    if (!Number.isSafeInteger(position) || position < 0 || position > this.total)
      return Promise.reject(new Error('Replay position is outside the executed timeline'));
    return this.enqueue({
      type: 'seek',
      requestId: ++this.requestId,
      position,
      forceReplace: Boolean(this.active),
    });
  }

  private enqueue(request: ReplayWorkerRequest): Promise<ReplayFrame> {
    return new Promise((resolve, reject) => {
      const pending = { request, resolve, reject };
      if (this.active) {
        this.queued?.reject(new DOMException('Replay seek superseded', 'AbortError'));
        this.queued = pending;
      } else this.send(pending);
    });
  }

  private send(pending: PendingSeek): void {
    this.active = pending;
    try {
      this.worker!.postMessage(pending.request);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Material replay request failed'));
    }
  }

  private fail(error: Error): void {
    const active = this.active;
    const queued = this.queued;
    this.worker?.terminate();
    this.worker = undefined;
    this.active = undefined;
    this.queued = undefined;
    active?.reject(error);
    queued?.reject(error);
  }

  cancel(): void {
    this.fail(new DOMException('Material replay cancelled', 'AbortError'));
  }
}
