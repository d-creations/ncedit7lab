import type { DeepReadonly } from '@services/tools/SimulationMetadata';
import type { SimulationInput } from '../shared/SimulationTypes';
import type { ReplayFrame } from '../strategies/cpu-hybrid/MaterialReplayEngine';
import type { GpuReplayFrame } from '../strategies/gpu-dexel/GpuMaterialReplaySession';

export type MaterialReplayFrame = ReplayFrame | GpuReplayFrame;
export type ReplayProgress = (processed: number, total: number) => void;

/** One retained run and executed-prefix lifecycle, independent of its stock representation. */
export interface MaterialReplayStrategy {
  readonly runId: string;
  readonly backend: MaterialReplayFrame['backend'];
  readonly computing: boolean;
  start(
    input: DeepReadonly<SimulationInput>,
    steps: readonly number[],
    progress?: ReplayProgress,
    prepareFinal?: boolean,
  ): Promise<MaterialReplayFrame>;
  seek(position: number): Promise<MaterialReplayFrame>;
  cancel(): void;
}
