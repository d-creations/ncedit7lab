import { describe, expect, it } from 'vitest';
import type { ExecutionOccurrence, PlotSegment } from '@core/types';
import { createPlotReplayTimeline } from '../PlotReplayTimeline';
import { ProgramToolService } from '../ProgramToolService';
import { SimulationCommentCodec } from '../SimulationCommentCodec';
import type { PlotRunSnapshot } from '../PlotRunSnapshot';

const segment = (executionStep: number, type: PlotSegment['type'] = 'feed'): PlotSegment => ({
  channelId: '1',
  type,
  executionStep,
  sourceSegmentIndex: executionStep,
  subsegmentIndex: 0,
  startPoint: { x: 0, y: 0, z: 0, lineNumber: 2 },
  endPoint: { x: 1, y: 0, z: 0, lineNumber: 2 },
});
function run(
  segments: PlotSegment[],
  executionOccurrences?: ExecutionOccurrence[],
): PlotRunSnapshot {
  const service = new ProgramToolService(new SimulationCommentCodec());
  const snapshot = service.captureProgramSnapshot(
    {
      documentId: 'doc',
      programId: 'one',
      channelId: '1',
    },
    0,
    'T1\nG1X1',
  );
  return {
    runId: 'test',
    toolPathMode: 'simulation',
    inputs: [
      {
        snapshot,
        machineName: 'test',
        toolValues: [],
        customVariables: [],
      },
    ],
    plotMetadata: { points: [], segments, executionOccurrences },
  };
}
describe('executed replay timeline', () => {
  it('includes non-motion commands and rapids, retains repeated lines and selects the last submove', () => {
    const first = segment(1),
      last = { ...first, subsegmentIndex: 1 };
    const timeline = createPlotReplayTimeline(
      run(
        [first, last, segment(2, 'rapid'), segment(3)],
        [
          { channelId: '1', executionStep: 0, lineNumber: 1 },
          ...[1, 2, 3].map((executionStep) => ({
            channelId: '1' as const,
            executionStep,
            lineNumber: 2,
          })),
        ],
      ),
    );
    expect(timeline.complete).toBe(true);
    expect(timeline.occurrences.map((entry) => entry.executionStep)).toEqual([0, 1, 2, 3]);
    expect(timeline.segments.get(1)).toBe(last);
    expect(timeline.segments.get(2)?.type).toBe('rapid');
  });
  it('explicitly identifies older backend timelines as motion-only without inventing missing commands', () => {
    const timeline = createPlotReplayTimeline(run([segment(1), segment(7)]));
    expect(timeline.complete).toBe(false);
    expect(timeline.occurrences.map((entry) => entry.executionStep)).toEqual([1, 7]);
  });
  it('does not treat an empty authoritative timeline as absent metadata', () => {
    expect(createPlotReplayTimeline(run([], [])).complete).toBe(true);
    expect(() => createPlotReplayTimeline(run([segment(1)], []))).toThrow('does not match');
  });
  it.each([null, undefined, -1, NaN])(
    'rejects unavailable motion occurrence %s',
    (executionStep) => {
      expect(() => createPlotReplayTimeline(run([{ ...segment(0), executionStep }]))).toThrow(
        'ordered',
      );
    },
  );
  it('rejects mismatched, unordered and multiple-channel histories', () => {
    expect(() => createPlotReplayTimeline(run([segment(2), segment(1)]))).toThrow('ordered');
    expect(() =>
      createPlotReplayTimeline(
        run(
          [segment(1)],
          [
            {
              channelId: '1',
              executionStep: 1,
              lineNumber: 3,
            },
          ],
        ),
      ),
    ).toThrow('does not match');
    const single = run([]);
    expect(() =>
      createPlotReplayTimeline({ ...single, inputs: [...single.inputs, ...single.inputs] }),
    ).toThrow('one executed channel');
  });
});
