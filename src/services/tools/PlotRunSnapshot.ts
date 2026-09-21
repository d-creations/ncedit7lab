import type { CustomVariable, MachineProfile, PlotMetadata, ToolPathMode, ToolValue, ToolOffsetValue } from '@core/types';
import type { ProgramToolSnapshot } from './ProgramToolService';
import type { DeepReadonly } from './SimulationMetadata';

export interface PlotRunInput {
  snapshot: ProgramToolSnapshot;
  machineName: string;
  machineProfile?: MachineProfile;
  toolValues: ToolValue[];
  toolOffsets?: ToolOffsetValue[];
  customVariables: CustomVariable[];
}

/** Blank only validated managed blocks in the execution copy, preserving every source line. */
export function executionProgram(snapshot: ProgramToolSnapshot): string {
  let text = snapshot.text;
  for (const block of [...snapshot.blocks].sort((a, b) => b.startOffset - a.startOffset)) {
    text = text.slice(0, block.startOffset) +
      text.slice(block.startOffset, block.endOffset).replace(/[^\r\n]/g, '') +
      text.slice(block.endOffset);
  }
  return text;
}

/** Client-owned context. Geometry, source text and profile never enter the wire request. */
export type PlotRunSnapshot = DeepReadonly<{
  runId: string;
  toolPathMode: ToolPathMode;
  inputs: PlotRunInput[];
  plotMetadata: PlotMetadata;
}>;