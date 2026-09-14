// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NCToolpathPlot } from '../NCToolpathPlot';
import * as THREE from 'three';
import { ServiceRegistry } from '@core/ServiceRegistry';
import { EVENT_BUS_TOKEN, EXECUTED_PROGRAM_SERVICE_TOKEN, FILE_MANAGER_SERVICE_TOKEN,
  PLOT_SERVICE_TOKEN, PROGRAM_TOOL_SERVICE_TOKEN, STATE_SERVICE_TOKEN } from '@core/ServiceTokens';
import { EventBus, EVENT_NAMES } from '@services/EventBus';
import { ExecutedProgramService } from '@services/ExecutedProgramService';
import { ProgramToolService, type ProgramSource } from '@services/tools/ProgramToolService';
import { SimulationCommentCodec } from '@services/tools/SimulationCommentCodec';
import type { BackendGateway } from '@services/BackendGateway';
import type { StateService } from '@services/StateService';
import type { IFileManagerService } from '@services/IFileManagerService';
import type { PlotService } from '@services/PlotService';
import type { PlotMetadata, PlotResponse } from '@core/types';

// Exercise actual event/action wiring without constructing a browser WebGL renderer.
interface PlotHarness extends HTMLElement {
  initThree(): void;
  updatePlot(metadata: PlotMetadata): void;
  scene?: THREE.Scene;
  highlightObject: THREE.LineSegments | null;
  toolObject: THREE.Group | null;
  plotNCCode(channel?: string): Promise<void>;
  clearPlot(): void;
}

describe('editor Plot actions', () => {
  const registry = ServiceRegistry.getInstance();
  let bus: EventBus;
  let service: ExecutedProgramService;
  let tools: ProgramToolService;
  let plot: PlotHarness;
  let source: ProgramSource;
  let requestPlot: ReturnType<typeof vi.fn>;
  let render: ReturnType<typeof vi.spyOn>;
  const syntax = { kind: 'line', prefix: ';' } as const;

  beforeEach(async () => {
    await registry.disposeAll();
    bus = new EventBus();
    tools = new ProgramToolService(new SimulationCommentCodec());
    requestPlot = vi.fn().mockResolvedValue({ canal: { '1': { segments: [] }, '2': { segments: [] } } });
    service = new ExecutedProgramService({ requestPlot } as unknown as BackendGateway, bus);
    source = { identity: { documentId: 'doc', programId: 'one', channelId: '1' }, revision: 0, text: '' };
    registry.register(EVENT_BUS_TOKEN, () => bus);
    registry.register(EXECUTED_PROGRAM_SERVICE_TOKEN, () => service);
    registry.register(PROGRAM_TOOL_SERVICE_TOKEN, () => tools);
    registry.register(PLOT_SERVICE_TOKEN, () => ({} as PlotService));
    registry.register(FILE_MANAGER_SERVICE_TOKEN, () => ({
      getActiveProgram: () => ({ id: 'one', sourceFileId: 'doc', content: 'STALE FILE TEXT', lastModified: 0 }),
    }) as unknown as IFileManagerService);
    registry.register(STATE_SERVICE_TOKEN, () => ({
      getState: () => ({ globalMachine: 'test', activeMachine: { machineName: 'test', simulationCommentSyntax: syntax } }),
      getActiveChannels: () => [{ id: '1', program: 'STALE STATE TEXT' }, { id: '2', program: 'OTHER' }],
    }) as unknown as StateService);
    for (const channelId of ['1', '2'] as const) {
      const channel = document.createElement('nc-channel-pane');
      channel.dataset.channel = channelId;
      const editor = document.createElement('nc-code-pane') as HTMLElement & { getProgramSource(): ProgramSource };
      editor.getProgramSource = () => channelId === '1' ? source : {
        identity: { documentId: 'doc', programId: 'two', channelId }, revision: 0, text: 'G1 X2',
      };
      channel.append(editor);
      document.body.append(channel);
    }
    vi.spyOn(NCToolpathPlot.prototype as unknown as PlotHarness, 'initThree').mockImplementation(() => {});
    plot = new NCToolpathPlot() as unknown as PlotHarness;
    render = vi.spyOn(plot, 'updatePlot').mockImplementation(() => {});
    document.body.append(plot);
  });

  afterEach(async () => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    await registry.disposeAll();
  });

  it.each(['1', undefined])('renders once from the completed run for channel/global Plot %s', async (channelId) => {
    bus.publish(EVENT_NAMES.PLOT_REQUEST, { channelId });
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    expect(requestPlot).toHaveBeenCalledTimes(1);
    const wire = requestPlot.mock.calls[0][0];
    expect(wire.toolPathMode).toBe('center');
    expect(wire.machinedata).toHaveLength(channelId ? 1 : 2);
    // An empty pending editor must not fall back to stale file/state content.
    expect(wire.machinedata[0].program).toBe('');
  });

  it('loads optional geometry only on Plot and uses shared Q/R without a tool-list DOM element', async () => {
    tools.setTemporaryToolValues(source.identity, [{ toolNumber: 0, qValue: 0 }]);
    source.text = new SimulationCommentCodec().encodeTool({ toolNumber: 'DRILL', description: '8mm',
      cutting: [{ type: 'drill', diameter: 8, length: 45, tipAngle: 118 }],
    }, syntax);
    const capture = vi.spyOn(tools, 'captureProgramSnapshot');
    bus.publish(EVENT_NAMES.PARSE_COMPLETED, {});
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 1, source });
    expect(capture).not.toHaveBeenCalled();
    expect(requestPlot).not.toHaveBeenCalled();
    await plot.plotNCCode('1');
    expect(capture).toHaveBeenCalledTimes(1);
    expect(requestPlot.mock.calls[0][0].machinedata[0].toolValues).toEqual([{ toolNumber: 0, qValue: 0 }]);
    expect(service.getRunTool('plot-1', 'one', '1', 'DRILL')?.cutting?.[0]).toMatchObject({ length: 45, tipAngle: 118 });
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 1, source });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(requestPlot).toHaveBeenCalledTimes(1);
  });

  it('marks edits stale and prevents old-line highlighting without execution', async () => {
    requestPlot.mockResolvedValue({ canal: { '1': { segments: [{
      traversal: 'FEED', geometry: 'LINEAR', lineNumber: 1, executionStep: 0, toolNumber: 1,
      points: [{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }],
    }] } } });
    plot.scene = new THREE.Scene();
    await plot.plotNCCode('1');
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 1, source });
    expect(Array.from(plot.highlightObject!.geometry.getAttribute('position').array)).toEqual([0, 0, 0, 5, 0, 0]);
    const previousGeometry = plot.highlightObject!.geometry;
    const clearDispose = vi.spyOn(previousGeometry, 'dispose');
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 2, source });
    expect(plot.highlightObject).toBeNull();
    expect(clearDispose).toHaveBeenCalledOnce();
    expect(plot.shadowRoot?.getElementById('plot-status')?.textContent).toContain('No plotted move');
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 1, source });
    const dispose = vi.spyOn(plot.highlightObject!.geometry, 'dispose');
    source = { ...source, revision: 1, text: 'G1 X100' };
    bus.publish('program:content_changed', {});
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 1, source });
    expect(plot.highlightObject).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
    expect(plot.shadowRoot?.getElementById('plot-status')?.textContent).toContain('stale');
    expect(requestPlot).toHaveBeenCalledTimes(1);
  });

  it('shows the selected milling tool at its emitted workpiece pose', async () => {
    source.text = new SimulationCommentCodec().encodeTool({ toolNumber: 1, description: '8mm end mill',
      cutting: [{ type: 'endMill', diameter: 8, length: 30 }],
    }, syntax);
    requestPlot.mockResolvedValue({ canal: { '1': { segments: [{
      traversal: 'FEED', geometry: 'LINEAR', lineNumber: 1, executionStep: 0, toolNumber: 1,
      points: [{ x: 0, y: 0, z: 0 }, { x: 5, y: 6, z: 7 }],
      poses: [
        { position: [0, 0, 0], orientation: [0, 0, 0, 1], reference: 'millingTip', frameId: 'workpiece:tableBC' },
        { position: [5, 6, 7], orientation: [0, 0, 1, 0], reference: 'millingTip', frameId: 'workpiece:tableBC' },
      ],
    }] } } });
    plot.scene = new THREE.Scene();

    await plot.plotNCCode('1');
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 1, source });

    expect(plot.toolObject).not.toBeNull();
    expect(plot.toolObject!.position.toArray()).toEqual([5, 6, 7]);
    expect(plot.toolObject!.quaternion.toArray()).toEqual([0, 0, 1, 0]);
  });

  it('does not replace the old plot on invalid metadata or a failed request', async () => {
    await plot.plotNCCode('1');
    source.text = '; @NCE-SIM:99 BEGIN TOOL';
    await plot.plotNCCode('1');
    expect(requestPlot).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    source.text = '';
    requestPlot.mockRejectedValue(new Error('offline'));
    await plot.plotNCCode('1');
    expect(render).toHaveBeenCalledTimes(1);
    expect(plot.shadowRoot?.getElementById('plot-status')?.textContent).toContain('offline');
  });

  it('selects repeated occurrences without execution and retains the choice until source changes', async () => {
    requestPlot.mockResolvedValue({ canal: { '1': { segments: [0, 3].map((executionStep) => ({
      traversal: 'FEED', geometry: 'LINEAR', lineNumber: 1, executionStep, toolNumber: executionStep,
      points: [{ x: 0, y: 0, z: 0 }, { x: executionStep + 1, y: 0, z: 0 }],
    })) } } });
    plot.scene = new THREE.Scene();
    const changed = vi.fn();
    bus.subscribe(EVENT_NAMES.PLOT_SELECTION_CHANGED, changed);
    await plot.plotNCCode('1');
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 1, source });
    const control = plot.shadowRoot!.querySelector<HTMLSelectElement>('#plot-occurrence')!;
    expect(Array.from(control.options, (option) => option.value)).toEqual(['0', '3']);
    expect(control.value).toBe('0');
    control.value = '3';
    control.dispatchEvent(new Event('change'));
    expect(Array.from(plot.highlightObject!.geometry.getAttribute('position').array)).toEqual([0, 0, 0, 4, 0, 0]);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({
      runId: 'plot-1', status: 'selected', executionStep: 3, toolNumber: 3,
      sourceSegmentIndex: 1, subsegmentIndex: 0, toolDefinitionAvailable: false,
    }));
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 1, source });
    expect(control.value).toBe('3');
    expect(requestPlot).toHaveBeenCalledTimes(1);
    source = { ...source, revision: 1 };
    bus.publish('program:content_changed', {});
    expect(control.disabled).toBe(true);
    expect(control.options).toHaveLength(0);
    expect(plot.highlightObject).toBeNull();
  });

  it('clearing cancels a pending render and disconnect releases subscriptions', async () => {
    let finish!: (response: PlotResponse) => void;
    requestPlot.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = plot.plotNCCode('1');
    plot.clearPlot();
    finish({ canal: {} });
    await pending;
    expect(render).not.toHaveBeenCalled();
    plot.remove();
    bus.publish(EVENT_NAMES.PLOT_REQUEST, { channelId: '1' });
    expect(requestPlot).toHaveBeenCalledTimes(1);
  });
});