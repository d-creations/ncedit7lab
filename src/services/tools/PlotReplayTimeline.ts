import type { ExecutionOccurrence, PlotSegment } from '@core/types';
import type { DeepReadonly } from './SimulationMetadata';
import type { PlotRunSnapshot } from './PlotRunSnapshot';

export interface PlotReplayTimeline {
  occurrences: DeepReadonly<ExecutionOccurrence>[];
  segments: Map<number, DeepReadonly<PlotSegment>>;
  /** Persistent display state, indexed by executed prefix, never by cursor history. */
  toolDisplays: Array<DeepReadonly<PlotSegment> | undefined>;
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
  const occurrences: DeepReadonly<ExecutionOccurrence>[] = complete
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
  let display: DeepReadonly<PlotSegment> | undefined;
  const toolDisplays = occurrences.map((occurrence) => {
    const motion = segments.get(occurrence.executionStep);
    const state = occurrence.toolState;
    if (occurrence.toolSelection &&
      (!state || state.toolNumber !== display?.toolNumber)) display = undefined;
    if (state) {
      if (state.toolNumber === undefined || state.toolNumber === null || state.toolNumber === 'unknown') {
        display = undefined;
      } else if (state.poses?.length) {
        const position = state.poses[state.poses.length - 1].position;
        const point = { x: position[0], y: position[1], z: position[2] };
        display = {
          ...state, type: 'rapid', startPoint: point, endPoint: point,
          channelId, executionStep: occurrence.executionStep,
          subsegmentIndex: Math.max(0, state.poses.length - 2),
        };
      } else if (display && display.toolNumber === state.toolNumber) {
        display = { ...display, motionContext: state.motionContext ?? display.motionContext };
      } else display = undefined;
    }
    if (motion) display = motion.poses?.length ? motion : undefined;
    return display;
  });
  return { occurrences, segments, toolDisplays, complete };
}
