import { describe, expect, it } from 'vitest';
import type { PlotSegment } from '@core/types';
import { createPlotSelectionResolver } from '../PlotSelectionResolver';

const segment = (overrides: Partial<PlotSegment> = {}): PlotSegment => ({
  type: 'feed', channelId: '1', executionStep: 0, sourceSegmentIndex: 0, subsegmentIndex: 0,
  startPoint: { x: 0, y: 0, z: 0, lineNumber: 1 },
  endPoint: { x: 1, y: 0, z: 0, lineNumber: 1 }, ...overrides,
});
const resolver = (segments: PlotSegment[]) => createPlotSelectionResolver({
  runId: 'test', toolPathMode: 'center', inputs: [], plotMetadata: { points: [], segments },
});
const location = { channelId: '1', lineNumber: 1 } as const;

describe('plot selection', () => {
  it('selects the last subsegment of the first occurrence or the preferred occurrence', () => {
    const first = segment();
    const last = segment({ subsegmentIndex: 1 });
    const repeated = segment({ executionStep: 3, sourceSegmentIndex: 1 });
    const select = resolver([first, last, repeated]);
    expect(select(location)).toMatchObject({ segment: last, occurrenceKey: 0, fraction: 1 });
    expect(select(location, 3).segment).toBe(repeated);
    expect(select(location).occurrenceSteps).toEqual([0, 3]);
    expect(select(location, 99)).toEqual({ status: 'occurrence-unavailable', fraction: 1 });
  });

  it.each([undefined, null, -1, NaN])('does not guess incomplete execution data: %s', (executionStep) => {
    expect(resolver([segment(), segment({ executionStep })])(location)).toEqual({
      status: 'execution-metadata-unavailable', fraction: 1,
    });
  });

  it('isolates channels and runs, and rejects absent channels and unexecuted lines', () => {
    const select = resolver([segment({ channelId: '2' }), segment({ channelId: undefined })]);
    expect(select(location).status).toBe('no-plotted-move');
    expect(resolver([])(location).status).toBe('no-plotted-move');
    expect(resolver([segment()])({ ...location, lineNumber: 2 }).status).toBe('no-plotted-move');
  });
});