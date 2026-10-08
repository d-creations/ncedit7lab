import type { ExecutionOccurrence, PlotSegment } from '@core/types';
import type { DeepReadonly } from './SimulationMetadata';
import type { PlotRunSnapshot } from './PlotRunSnapshot';

export interface PlotReplayTimeline {
  occurrences: DeepReadonly<ExecutionOccurrence>[];
  segments: Map<number, DeepReadonly<PlotSegment>>;
  complete: boolean;
}

export function createPlotReplayTimeline(run: PlotRunSnapshot): PlotReplayTimeline {
  if (run.inputs.length !== 1) throw new Error('Stock replay requires one executed channel');
  const channelId = run.inputs[0].snapshot.identity.channelId;
  const segments = new Map<number, DeepReadonly<PlotSegment>>();
  let previous = -1;
  for (const segment of run.plotMetadata.segments) {
    if (segment.channelId !== channelId) continue;
    const step = segment.executionStep;
    if (
      !Number.isSafeInteger(step) ||
      step === undefined ||
      step === null ||
      step < 0 ||
      step < previous
    )
      throw new Error('Stock replay requires ordered execution occurrences on every motion');
    previous = step;
    segments.set(step, segment);
  }
  const captured = run.plotMetadata.executionOccurrences?.filter(
    (occurrence) => occurrence.channelId === channelId,
  );
  const complete = captured !== undefined;
  const occurrences = complete
    ? [...captured!]
    : [...segments].map(([executionStep, segment]) => ({
        channelId,
        executionStep,
        lineNumber: segment.endPoint.lineNumber,
      }));
  previous = -1;
  const steps = new Map<number, DeepReadonly<ExecutionOccurrence>>();
  for (const occurrence of occurrences) {
    if (
      !Number.isSafeInteger(occurrence.executionStep) ||
      occurrence.executionStep <= previous ||
      (occurrence.lineNumber !== undefined &&
        (!Number.isSafeInteger(occurrence.lineNumber) || occurrence.lineNumber < 1))
    )
      throw new Error('Invalid executed-command replay timeline');
    previous = occurrence.executionStep;
    steps.set(previous, occurrence);
  }
  for (const [step, segment] of segments) {
    const occurrence = steps.get(step);
    if (
      !occurrence ||
      (occurrence.lineNumber !== undefined && occurrence.lineNumber !== segment.endPoint.lineNumber)
    )
      throw new Error('Executed-command history does not match the plotted motion');
  }
  return { occurrences, segments, complete };
}
