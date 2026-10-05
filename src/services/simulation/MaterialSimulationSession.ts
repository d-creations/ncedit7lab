import type { SimulationInput, SimulationResult, SimulationWorkerMessage } from './SimulationTypes';
import type { DeepReadonly } from '../tools/SimulationMetadata';
import { freezeMetadata } from '../tools/SimulationMetadata';

export interface SimulationWorker {
  onmessage: ((event: MessageEvent<SimulationWorkerMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(input: DeepReadonly<SimulationInput>): void;
  terminate(): void;
}

export class MaterialSimulationSession {
  private worker?: SimulationWorker;
  private rejectPending?: (error: Error) => void;
  result?: SimulationResult;
  input?: DeepReadonly<SimulationInput>;

  constructor(
    readonly runId: string,
    private readonly createWorker: () => SimulationWorker = () =>
      new Worker(new URL('../../workers/materialRemoval.worker.ts', import.meta.url), {
        type: 'module',
      }),
  ) {}

  start(
    input: DeepReadonly<SimulationInput>,
    progress: (processed: number, total: number) => void,
  ): Promise<SimulationResult> {
    this.cancel();
    this.result = undefined;
    this.input = freezeMetadata(structuredClone(input));
    return new Promise((resolve, reject) => {
      this.rejectPending = reject;
      let worker: SimulationWorker;
      try {
        worker = this.createWorker();
      } catch (error) {
        this.releaseWorker();
        reject(error);
        return;
      }
      this.worker = worker;
      worker.onmessage = (event: MessageEvent<SimulationWorkerMessage>) => {
        if (this.worker !== worker) return;
        const message = event.data;
        if (message.type === 'progress') {
          progress(message.processed, message.total);
        } else {
          this.releaseWorker();
          if (message.type === 'error') {
            reject(new Error(message.message));
          } else {
            this.result = message.result;
            resolve(message.result);
          }
        }
      };
      worker.onerror = (event) => {
        if (this.worker !== worker) return;
        this.releaseWorker();
        reject(new Error(event.message || 'Material simulation worker failed'));
      };
      worker.onmessageerror = () => {
        if (this.worker !== worker) return;
        this.releaseWorker();
        reject(new Error('Material simulation worker response could not be decoded'));
      };
      try {
        worker.postMessage(this.input!);
      } catch (error) {
        this.releaseWorker();
        reject(error);
      }
    });
  }

  private releaseWorker(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.rejectPending = undefined;
  }

  cancel(): void {
    const reject = this.rejectPending;
    this.releaseWorker();
    this.result = undefined;
    this.input = undefined;
    if (reject) reject(new DOMException('Material simulation cancelled', 'AbortError'));
  }
}
