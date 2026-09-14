import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutedProgramService } from '../ExecutedProgramService';
import { BackendGateway } from '../BackendGateway';
import { EventBus, EVENT_NAMES } from '../EventBus';
import { ProgramToolService } from '../tools/ProgramToolService';
import { SimulationCommentCodec } from '../tools/SimulationCommentCodec';
import type { PlotRunInput } from '../tools/PlotRunSnapshot';
import type { ChannelId, PlotResponse } from '@core/types';

const syntax = { kind: 'line', prefix: ';' } as const;
const codec = new SimulationCommentCodec();
const tools = new ProgramToolService(codec);
const response: PlotResponse = { canal: Object.fromEntries(['1', '2'].map((channel) => [channel, {
  segments: [{ geometry: 'LINEAR', traversal: 'FEED', toolNumber: 0, executionStep: 0,
    lineNumber: 9, points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] }],
}])) };

function input(channelId: ChannelId = '1'): PlotRunInput {
  const text = codec.encodeTool({ toolNumber: 0, description: 'edge', Q: 0, R: 0,
    cutting: [{ type: 'endMill', diameter: 8, length: 30, cornerRadius: 0.5 }],
  }, syntax, '\r\n') + '\r\n(ordinary comment)\r\nG1 X1';
  const snapshot = tools.captureProgramSnapshot({ documentId: 'doc', programId: `p${channelId}`, channelId }, 0, text, syntax);
  return { snapshot, machineName: 'test', toolValues: tools.getToolValues(snapshot),
    customVariables: [{ name: 'R1', value: 0 }] };
}

describe('completed plot runs', () => {
  let backend: BackendGateway;
  let bus: EventBus;
  let service: ExecutedProgramService;
  beforeEach(() => {
    backend = { requestPlot: vi.fn().mockResolvedValue(structuredClone(response)) } as unknown as BackendGateway;
    bus = new EventBus();
    service = new ExecutedProgramService(backend, bus);
  });

  it.each([true, false])('stores one complete run before publishing, single=%s', async (single) => {
    const completed = vi.fn(({ runId }: { runId: string }) => expect(service.getPlotRun(runId)).toBeDefined());
    const channelCompleted = vi.fn();
    bus.subscribe(EVENT_NAMES.PLOT_RUN_COMPLETED, completed);
    bus.subscribe(EVENT_NAMES.EXECUTION_COMPLETED, channelCompleted);
    const run = await service.executePlotRun(single ? [input()] : [input(), input('2')], single);
    expect(completed).toHaveBeenCalledExactlyOnceWith({ runId: run.runId });
    expect(channelCompleted).toHaveBeenCalledTimes(single ? 1 : 2);
    expect(run.plotMetadata.segments.map((segment) => segment.channelId)).toEqual(single ? ['1'] : ['1', '2']);
    expect(run.plotMetadata.segments[0]).toMatchObject({ toolNumber: 0, executionStep: 0, sourceSegmentIndex: 0, subsegmentIndex: 0 });
  });

  it('captures optional length/edge data and variables before await without adding wire fields', async () => {
    let finish!: (value: PlotResponse) => void;
    vi.mocked(backend.requestPlot).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const original = input();
    const text = original.snapshot.text;
    const pending = service.executePlotRun([original], true);
    original.toolValues[0].rValue = 99;
    original.customVariables[0].value = 99;
    original.snapshot = input('2').snapshot;
    finish(response);
    const run = await pending;
    expect(run.inputs[0].snapshot.text).toBe(text);
    expect(run.inputs[0].toolValues[0].rValue).toBe(0);
    expect(run.inputs[0].customVariables[0].value).toBe(0);
    expect(service.getRunTool(run.runId, 'p1', '1', 0)?.cutting?.[0]).toMatchObject({ length: 30, cornerRadius: 0.5 });
    expect(Object.isFrozen(run.inputs[0].snapshot.tools[0].cutting?.[0])).toBe(true);
    expect(() => Object.assign(run.plotMetadata.segments[0].endPoint, { x: 999 })).toThrow();
    const wire = vi.mocked(backend.requestPlot).mock.calls[0][0];
    expect(Object.keys(wire)).toEqual(['toolPathMode', 'machinedata']);
    expect(wire.toolPathMode).toBe('center');
    expect(Object.keys(wire.machinedata[0])).toEqual(['program', 'machineName', 'canalNr', 'toolValues', 'customVariables']);
    expect(wire.machinedata[0].program).not.toContain('@NCE-SIM');
    expect(wire.machinedata[0].program).toContain('(ordinary comment)\nG1 X1');
    expect(wire.machinedata[0].program.split('\n')).toHaveLength(text.split('\n').length);
  });

  it('sends complete simulation machine data only for an advertised pose contract', async () => {
    const first = input();
    first.machineProfile = {
      machineName: 'FANUC_MILL_DEMO', controlType: 'FANUC', axes: ['X', 'Y', 'Z', 'B', 'C'],
      feedLimits: { min: 0, max: 1000 }, defaultTools: [], availableChannels: 1,
      profileRevision: 'sha256:demo', supportedPoseContracts: ['workpiece-tool-reference-v1'],
      simulation: {
        schemaVersion: 1, revision: 1, modelId: 'MILL_DEMO', displayName: 'MILL DEMO', fidelity: 'demo',
        poseContract: 'workpiece-tool-reference-v1', carriers: [], toolMounts: [],
      },
    };
    await service.executePlotRun([first], true);
    expect(vi.mocked(backend.requestPlot).mock.calls[0][0]).toMatchObject({
      toolPathMode: 'center', poseContract: 'workpiece-tool-reference-v1',
      machinedata: [{ simulation: {
        profileRevision: 'sha256:demo',
        tools: [{ toolNumber: 0, reference: 'millingTip', mountingOrientationDegrees: [0, 0, 0] }],
      } }],
    });
  });

  it('isolates exact tool IDs and never resolves unavailable tools or other programs', async () => {
    const first = input();
    const text = [0, 1, '1', 'DRILL'].map((toolNumber) => codec.encodeTool({ toolNumber, description: String(toolNumber) }, syntax)).join('\n');
    first.snapshot = tools.captureProgramSnapshot(first.snapshot.identity, 1, text, syntax);
    const run = await service.executePlotRun([first, input('2')]);
    for (const id of [0, 1, '1', 'DRILL']) expect(service.getRunTool(run.runId, 'p1', '1', id)?.toolNumber).toBe(id);
    for (const id of ['unknown', null, undefined]) expect(service.getRunTool(run.runId, 'p1', '1', id)).toBeUndefined();
    expect(service.getRunTool(run.runId, 'p1', '2', 0)).toBeUndefined();
    expect(service.getRunTool(run.runId, 'p2', '2', 0)?.description).toBe('edge');
  });

  it('rejects invalid metadata and conflicting setup without sending any request', async () => {
    const first = input();
    first.snapshot = tools.captureProgramSnapshot(first.snapshot.identity, 1, first.snapshot.text);
    await expect(service.executePlotRun([first])).rejects.toThrow('metadata');
    first.snapshot = tools.captureProgramSnapshot(first.snapshot.identity, 2,
      codec.encodeSetup({ machineName: 'different' }, syntax), syntax);
    await expect(service.executePlotRun([first])).rejects.toThrow('conflicts');
    expect(backend.requestPlot).not.toHaveBeenCalled();
  });

  it('supports ordinary empty programs and Q/R-only tools without geometry', async () => {
    const first = input();
    first.snapshot = tools.captureProgramSnapshot(first.snapshot.identity, 1, '');
    const run = await service.executePlotRun([first]);
    expect(run.inputs[0].snapshot.tools).toEqual([]);
    expect(vi.mocked(backend.requestPlot).mock.calls[0][0].machinedata[0].program).toBe('');
    first.snapshot = tools.captureProgramSnapshot(first.snapshot.identity, 2,
      codec.encodeTool({ toolNumber: 1, description: '', R: 0 }, syntax), syntax);
    const qrRun = await service.executePlotRun([first]);
    expect(qrRun.inputs[0].snapshot.geometry[0].status).toBe('missing');
  });

  it('ignores late completion and cancellation, retaining the last completed run after failure', async () => {
    const pending: Array<(value: PlotResponse) => void> = [];
    vi.mocked(backend.requestPlot).mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const completed = vi.fn();
    bus.subscribe(EVENT_NAMES.PLOT_RUN_COMPLETED, completed);
    const executed = vi.fn();
    bus.subscribe(EVENT_NAMES.EXECUTION_COMPLETED, executed);
    const first = service.executePlotRun([input()]);
    const second = service.executePlotRun([input('2')]);
    pending[1](response);
    const latest = await second;
    pending[0](response);
    const old = await first;
    expect(service.getPlotRun(old.runId)).toBeUndefined();
    expect(completed).toHaveBeenCalledExactlyOnceWith({ runId: latest.runId });
    const cancelled = service.executePlotRun([input()]);
    service.cancelPendingPlot();
    pending[2](response);
    expect(service.getPlotRun((await cancelled).runId)).toBeUndefined();
    vi.mocked(backend.requestPlot).mockRejectedValue(new Error('offline'));
    await expect(service.executePlotRun([input()])).rejects.toThrow('offline');
    expect(service.getPlotRun(latest.runId)).toBe(latest);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(executed).toHaveBeenCalledTimes(1);
  });

  it('bounds retained runs and supports explicit release', async () => {
    const first = await service.executePlotRun([input()]);
    for (let index = 0; index < 5; index++) await service.executePlotRun([input()]);
    expect(service.getPlotRun(first.runId)).toBeUndefined();
    const latest = await service.executePlotRun([input()]);
    service.discardPlotRun(latest.runId);
    expect(service.getPlotRun(latest.runId)).toBeUndefined();
  });
});