import type { ChannelId, PlotSegment } from '@core/types';
import type { PlotRunSnapshot } from './PlotRunSnapshot';

export interface PlotSourceLocation {
  channelId: ChannelId;
  lineNumber: number;
}

export type PlotSelectionStatus =
  | 'selected'
  | 'execution-metadata-unavailable'
  | 'occurrence-unavailable'
  | 'no-plotted-move';

export interface PlotSelection {
  status: PlotSelectionStatus;
  segment?: PlotSegment;
  fraction: number;
  occurrenceKey?: number | string;
  occurrenceSteps?: readonly number[];
}

/** Resolves an editor source line to one executed segment without re-running the program. */
export function createPlotSelectionResolver(run: PlotRunSnapshot) {
  const index = new Map<string, { incomplete: boolean; steps: Map<number, PlotSegment> }>();
  for (const segment of run.plotMetadata.segments) {
    if (!segment.channelId || segment.endPoint.lineNumber === undefined) continue;
    const key = JSON.stringify([segment.channelId, segment.endPoint.lineNumber]);
    const occurrences = index.get(key) ?? { incomplete: false, steps: new Map<number, PlotSegment>() };
    if (segment.executionStep === undefined || segment.executionStep === null ||
      !Number.isSafeInteger(segment.executionStep) || segment.executionStep < 0) {
      occurrences.incomplete = true;
    } else {
      occurrences.steps.set(segment.executionStep, segment);
    }
    index.set(key, occurrences);
  }
  return (
    location: PlotSourceLocation,
    preferredExecutionStep?: number,
  ): PlotSelection => {
    const occurrences = index.get(JSON.stringify([location.channelId, location.lineNumber]));
    if (!occurrences) return { status: 'no-plotted-move', fraction: 1 };
    if (occurrences.incomplete) return { status: 'execution-metadata-unavailable', fraction: 1 };
    if (preferredExecutionStep !== undefined && !occurrences.steps.has(preferredExecutionStep)) {
      return { status: 'occurrence-unavailable', fraction: 1 };
    }
    const step = preferredExecutionStep ?? occurrences.steps.keys().next().value!;
    return {
      status: 'selected', segment: occurrences.steps.get(step), fraction: 1, occurrenceKey: step,
      occurrenceSteps: [...occurrences.steps.keys()],
    };
  };
}