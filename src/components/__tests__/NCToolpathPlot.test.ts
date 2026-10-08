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
import { PlotService } from '@services/PlotService';
import type { PlotMetadata, PlotResponse } from '@core/types';
import { MaterialSimulationSession, type SimulationWorker } from '@services/simulation/MaterialSimulationSession';
import { simulateMaterialRemoval } from '@services/simulation/MaterialRemovalEngine';
import { MaterialReplayEngine, type ReplayFrame } from '@services/simulation/MaterialReplayEngine';
import { MaterialReplaySession, type ReplayWorker } from '@services/simulation/MaterialReplaySession';

// Exercise actual event/action wiring without constructing a browser WebGL renderer.
interface PlotHarness extends HTMLElement {
  initThree(): void;
  updatePlot(metadata: PlotMetadata): void;
  scene?: THREE.Scene;
  highlightObject: THREE.LineSegments | null;
  toolObject: THREE.Group | null;
  plotNCCode(channel?: string): Promise<void>;
  clearPlot(): void;
  plotService: PlotService;
  toggleMaterial(): void;
  toggleAxes(): void;
  createMaterialSimulationSession(runId: string): MaterialSimulationSession;
  createMaterialReplaySession(runId: string): MaterialReplaySession;
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
  let selectedMode: 'effective' | 'center' | 'simulation';
  const syntax = { kind: 'line', prefix: ';' } as const;

  beforeEach(async () => {
    await registry.disposeAll();
    bus = new EventBus();
    tools = new ProgramToolService(new SimulationCommentCodec());
    requestPlot = vi.fn().mockResolvedValue({ canal: { '1': { segments: [] }, '2': { segments: [] } } });
    selectedMode = 'effective';
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
      getState: () => ({
        globalMachine: 'test',
        toolPathMode: selectedMode,
        activeMachine: { machineName: 'test', simulationCommentSyntax: syntax },
      }),
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
    vi.useRealTimers();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    await registry.disposeAll();
  });

  async function readyReplay(): Promise<{ worker: ReplayWorker; frames: ReplayFrame[] }> {
    const codec = new SimulationCommentCodec();
    source.text = codec.encodeSetup({
      machineName: 'test', material: { type: 'box', width: 4, height: 4, depth: 4 },
    }, syntax) + '\n' + codec.encodeTool({
      toolNumber: 1, description: 'replay mill',
      cutting: [{ type: 'endMill', diameter: 0.8, length: 2 }],
    }, syntax);
    const pose = (position: [number, number, number]) => ({
      position, orientation: [0, 0, 0, 1] as const,
      reference: 'millingTip' as const, frameId: 'workpiece:replay',
    });
    const move = (executionStep: number, lineNumber: number, start: [number, number, number],
      end: [number, number, number], traversal = 'FEED') => ({
      geometry: 'LINEAR', traversal, sourceCode: traversal === 'RAPID' ? 'G0' : 'G1',
      machiningMode: 'milling' as const, toolNumber: 1, lineNumber, executionStep,
      points: [start, end].map(([x, y, z]) => ({ x, y, z })), poses: [pose(start), pose(end)],
    });
    requestPlot.mockResolvedValue({ canal: { '1': {
      executionOccurrences: [
        { executionStep: 0, lineNumber: 1 }, { executionStep: 1, lineNumber: 2 },
        { executionStep: 2, lineNumber: 3 }, { executionStep: 3, lineNumber: 2 },
      ],
      segments: [
        move(1, 2, [-1, 0, -1], [1, 0, -1]),
        move(2, 3, [1, 0, -1], [3, 0, -1], 'RAPID'),
        move(3, 2, [1, -1, -1], [-1, -1, -1]),
      ],
    } } });
    const finalWorker: SimulationWorker = {
      onmessage: null, onerror: null, onmessageerror: null, terminate: vi.fn(),
      postMessage: vi.fn((input) => queueMicrotask(() =>
        finalWorker.onmessage?.(new MessageEvent('message', {
          data: { type: 'result', result: simulateMaterialRemoval(input) },
        })))),
    };
    vi.spyOn(plot, 'createMaterialSimulationSession').mockImplementation((runId) =>
      new MaterialSimulationSession(runId, () => finalWorker));
    const frames: ReplayFrame[] = [];
    let replay: MaterialReplayEngine;
    const worker: ReplayWorker = {
      onmessage: null, onerror: null, onmessageerror: null, terminate: vi.fn(),
      postMessage: vi.fn((request) => queueMicrotask(() => {
        if (request.type === 'initialize') replay = new MaterialReplayEngine(request.input, request.steps);
        const frame = replay.seek(request.type === 'initialize' ? 0 : request.position,
          request.type === 'initialize' || request.forceReplace);
        frames.push(frame);
        worker.onmessage?.(new MessageEvent('message', {
          data: { type: 'frame', requestId: request.requestId, frame },
        }));
      })),
    };
    vi.spyOn(plot, 'createMaterialReplaySession').mockImplementation((runId) =>
      new MaterialReplaySession(runId, () => worker));
    selectedMode = 'simulation';
    plot.scene = new THREE.Scene();
    plot.plotService = new PlotService(bus);
    render.mockRestore();
    await plot.plotNCCode('1');
    const button = plot.shadowRoot!.querySelector<HTMLButtonElement>('#replay-start')!;
    expect(button.disabled).toBe(true);
    plot.shadowRoot!.querySelector<HTMLSelectElement>('#removal-frame')!.value = 'workpiece:replay';
    plot.shadowRoot!.querySelector<HTMLButtonElement>('#run-removal')!.click();
    await vi.waitFor(() => expect(plot.shadowRoot!.getElementById('material-removal-status')!.textContent).toContain('Completed.'));
    expect(button.disabled).toBe(false);
    button.click();
    await vi.waitFor(() => expect(plot.shadowRoot!.getElementById('replay-status')!.textContent).toContain('Initial stock'));
    return { worker, frames };
  }

  async function expectReplayPosition(position: number): Promise<void> {
    await vi.waitFor(() => {
      expect(plot.shadowRoot!.querySelector<HTMLInputElement>('#replay-position')!.value).toBe(String(position));
      expect(plot.shadowRoot!.getElementById('stock-replay')!.getAttribute('aria-busy')).toBe('false');
    });
  }

  it('steps non-motion, cutting and rapid occurrences, keeps unchanged meshes and supports backward seeking', async () => {
    const { worker, frames } = await readyReplay();
    const next = plot.shadowRoot!.querySelector<HTMLButtonElement>('#replay-next')!;
    const previous = plot.shadowRoot!.querySelector<HTMLButtonElement>('#replay-previous')!;
    const initial = plot.scene!.children.find((child) => child.name === 'machined-stock')!;
    next.click();
    await expectReplayPosition(1);
    expect(plot.shadowRoot!.getElementById('plot-status')!.textContent).toContain('non-motion command');
    expect(plot.scene!.children.find((child) => child.name === 'machined-stock')).toBe(initial);
    expect(frames[1].chunks).toEqual([]);
    next.click();
    await expectReplayPosition(2);
    const cutMeshes = [...initial.children];
    const removed = frames[2].removedCells;
    next.click();
    await expectReplayPosition(3);
    expect(plot.shadowRoot!.getElementById('plot-status')!.textContent).toContain('rapid');
    expect(initial.children).toEqual(cutMeshes);
    expect(frames[3].removedCells).toBe(removed);
    previous.click();
    await expectReplayPosition(2);
    expect(frames[4].replace).toBe(true);
    expect(frames[4].removedCells).toBe(removed);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(requestPlot).toHaveBeenCalledOnce();
  });

  it('keeps cursor following opt-in and seeks the chosen repeated-line occurrence including state-only commands', async () => {
    const { worker } = await readyReplay();
    const timeline = plot.shadowRoot!.querySelector<HTMLInputElement>('#replay-position')!;
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 2, source });
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(timeline.value).toBe('0');
    const follow = plot.shadowRoot!.querySelector<HTMLInputElement>('#replay-follow')!;
    follow.checked = true;
    follow.dispatchEvent(new Event('change'));
    await expectReplayPosition(2);
    const occurrence = plot.shadowRoot!.querySelector<HTMLSelectElement>('#plot-occurrence')!;
    expect(Array.from(occurrence.options, (option) => option.value)).toEqual(['1', '3']);
    occurrence.value = '3';
    occurrence.dispatchEvent(new Event('change'));
    await expectReplayPosition(4);
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 1, source });
    await expectReplayPosition(1);
    expect(plot.toolObject).toBeNull();
    expect(plot.shadowRoot!.getElementById('plot-status')!.textContent).toContain('step 0');
    expect(requestPlot).toHaveBeenCalledOnce();
  });

  it('plays only after each stock update completes and pauses without applying later occurrences', async () => {
    const { worker } = await readyReplay();
    vi.useFakeTimers();
    const play = plot.shadowRoot!.querySelector<HTMLButtonElement>('#replay-play')!;
    play.click();
    expect(play.textContent).toBe('Pause');
    await vi.advanceTimersByTimeAsync(150);
    expect(plot.shadowRoot!.querySelector<HTMLInputElement>('#replay-position')!.value).toBe('1');
    play.click();
    expect(play.textContent).toBe('Play');
    await vi.advanceTimersByTimeAsync(5000);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
  });

  it.each(['edit', 'clear', 'disconnect'])('cancels replay and ignores late responses after %s', async (reason) => {
    const { worker, frames } = await readyReplay();
    worker.postMessage = vi.fn();
    plot.shadowRoot!.querySelector<HTMLButtonElement>('#replay-next')!.click();
    if (reason === 'edit') {
      source = { ...source, revision: 1, text: source.text + '\nG1 X2' };
      bus.publish('program:content_changed', {});
    } else if (reason === 'clear') plot.clearPlot();
    else plot.remove();
    expect(worker.terminate).toHaveBeenCalledOnce();
    worker.onmessage?.(new MessageEvent('message', {
      data: { type: 'frame', requestId: 2, frame: frames[0] },
    }));
    expect(plot.shadowRoot!.querySelector<HTMLInputElement>('#replay-position')!.disabled).toBe(true);
    expect(plot.highlightObject).toBeNull();
  });

  it('reports replay worker failure and retains only the last successfully displayed stock', async () => {
    const { worker } = await readyReplay();
    const stock = plot.scene!.children.find((child) => child.name === 'machined-stock')!;
    worker.postMessage = vi.fn();
    plot.shadowRoot!.querySelector<HTMLButtonElement>('#replay-next')!.click();
    worker.onerror?.(new ErrorEvent('error', { message: 'Replay budget exceeded' }));
    await vi.waitFor(() => expect(plot.shadowRoot!.getElementById('replay-status')!.textContent)
      .toContain('Replay budget exceeded'));
    expect(plot.scene!.children.find((child) => child.name === 'machined-stock')).toBe(stock);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(plot.shadowRoot!.querySelector<HTMLInputElement>('#replay-position')!.disabled).toBe(true);
  });

  it('leaves replay explicitly and computes final stock without reexecuting the program', async () => {
    const { worker } = await readyReplay();
    plot.shadowRoot!.querySelector<HTMLButtonElement>('#replay-final')!.click();
    await vi.waitFor(() => expect(plot.shadowRoot!.getElementById('material-removal-status')!.textContent).toContain('Completed.'));
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(plot.shadowRoot!.querySelector<HTMLInputElement>('#replay-position')!.disabled).toBe(true);
    expect(requestPlot).toHaveBeenCalledOnce();
  });

  it('plots with default end-mill geometry for undefined tools', async () => {
    source.text = 'T5\nG1 X1';
    bus.publish(EVENT_NAMES.PARSE_COMPLETED, { channelId: '1', artifacts: { toolRegisters: [{ toolNumber: 5 }] } });
    await plot.plotNCCode('1');

    expect(requestPlot).toHaveBeenCalledTimes(1);
    expect(service.getPlotRun('plot-1')?.inputs[0].snapshot.tools).toContainEqual(
      expect.objectContaining({
        toolNumber: 5,
        cutting: [{ type: 'endMill', diameter: 10, length: 30 }],
      }),
    );
  });

  it('plots normally once the missing tool gets a Q/R value', async () => {
    source.text = 'T5\nG1 X1';
    bus.publish(EVENT_NAMES.PARSE_COMPLETED, { channelId: '1', artifacts: { toolRegisters: [{ toolNumber: 5 }] } });
    tools.setTemporaryToolValues(source.identity, [{ toolNumber: 5, rValue: 2 }]);

    await plot.plotNCCode('1');

    expect(requestPlot).toHaveBeenCalledTimes(1);
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
    selectedMode = 'simulation';

    await plot.plotNCCode('1');
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 1, source });

    expect(plot.toolObject).not.toBeNull();
    expect(plot.toolObject!.position.toArray()).toEqual([5, 6, 7]);
    expect(plot.toolObject!.quaternion.toArray()).toEqual([0, 0, 1, 0]);
  });

  it('shows and hides captured material in simulation plots', async () => {
    source.text = new SimulationCommentCodec().encodeSetup({
      machineName: 'test',
      material: { type: 'box', width: 100, height: 20, depth: 60 },
    }, syntax);
    selectedMode = 'simulation';
    plot.scene = new THREE.Scene();
    plot.plotService = new PlotService(bus);
    render.mockRestore();

    await plot.plotNCCode('1');

    const material = plot.scene.children.find((child) => child.userData.isMaterial)!;
    const toggle = plot.shadowRoot!.querySelector<HTMLButtonElement>('#toggle-material')!;
    expect(material.visible).toBe(true);
    expect(toggle.hidden).toBe(false);
    expect(toggle.textContent).toBe('Hide Material');
    const diagnostics = plot.shadowRoot!.querySelector<HTMLElement>('#material-removal-status')!;
    expect(diagnostics.hidden).toBe(false);
    expect(diagnostics.textContent).toContain('program-coordinate preview');
    expect(diagnostics.textContent).toContain('spindle operation is not verified');
    plot.toggleAxes();
    expect(material.visible).toBe(true);

    toggle.click();
    expect(material.visible).toBe(false);
    expect(toggle.textContent).toBe('Show Material');

    toggle.click();
    expect(material.visible).toBe(true);
    expect(toggle.textContent).toBe('Hide Material');
    plot.clearPlot();
    expect(diagnostics.hidden).toBe(true);
  });

  it('shows a turning tool at a turning virtual-tip endpoint pose', async () => {
    source.text = new SimulationCommentCodec().encodeTool({ toolNumber: 2, description: 'D turning insert',
      cutting: [{ type: 'insert', shape: 'D', ic: 9.525, thickness: 3.97, noseRadius: 0.4, clearanceAngle: 7 }],
    }, syntax);
    requestPlot.mockResolvedValue({ canal: { '1': { segments: [{
      traversal: 'FEED', geometry: 'LINEAR', lineNumber: 1, executionStep: 0, toolNumber: 2,
      points: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }],
      poses: [
        { position: [1, 2, 3], orientation: [0, 0, 0, 1], reference: 'turningVirtualTip', frameId: 'workpiece:tableBC' },
        { position: [4, 5, 6], orientation: [0, 0, 0, 1], reference: 'turningVirtualTip', frameId: 'workpiece:tableBC' },
      ],
    }] } } });
    plot.scene = new THREE.Scene();
    selectedMode = 'simulation';

    await plot.plotNCCode('1');
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 1, source });

    expect(plot.toolObject).not.toBeNull();
    expect(plot.toolObject!.position.toArray()).toEqual([4, 5, 6]);
  });

  it.each(['workpiece:test', 'workpiece:tableBC'])(
    'defaults only tableBC and runs explicit binding without rerunning on cursor movement (%s)', async (frameId) => {
    const codec = new SimulationCommentCodec();
    source.text = codec.encodeSetup({
      machineName: 'test', material: { type: 'box', width: 6, height: 4, depth: 4 },
    }, syntax) + '\n' + codec.encodeTool({
      toolNumber: 1, description: 'mill', cutting: [{ type: 'endMill', diameter: 2, length: 4 }],
    }, syntax);
    requestPlot.mockResolvedValue({ canal: { '1': { segments: [{
      geometry: 'LINEAR', traversal: 'FEED', sourceCode: 'G1', machiningMode: 'milling',
      toolNumber: 1, lineNumber: 1, executionStep: 0,
      points: [{ x: -1, y: 0, z: -1 }, { x: 1, y: 0, z: -1 }],
      poses: [
        { position: [-1, 0, -1], orientation: [0, 0, 0, 1], reference: 'millingTip', frameId },
        { position: [1, 0, -1], orientation: [0, 0, 0, 1], reference: 'millingTip', frameId },
      ],
    }] } } });
    const worker: SimulationWorker = {
      onmessage: null, onerror: null, onmessageerror: null, terminate: vi.fn(),
      postMessage: vi.fn((input) => {
        queueMicrotask(() => worker.onmessage?.(new MessageEvent('message', {
          data: { type: 'result', result: simulateMaterialRemoval(input) },
        })));
      }),
    };
    vi.spyOn(plot, 'createMaterialSimulationSession').mockImplementation((runId) =>
      new MaterialSimulationSession(runId, () => worker));
    selectedMode = 'simulation';
    plot.scene = new THREE.Scene();
    plot.plotService = new PlotService(bus);
    render.mockRestore();
    await plot.plotNCCode('1');
    expect(worker.postMessage).not.toHaveBeenCalled();
    const frameSelect = plot.shadowRoot!.querySelector<HTMLSelectElement>('#removal-frame')!;
    expect(frameSelect.value).toBe(frameId === 'workpiece:tableBC' ? frameId : '');
    const raw = plot.scene.children.find((child) => child.userData.isMaterial)!;
    const dispose = vi.spyOn((raw.children[0].children[0] as THREE.Mesh).geometry, 'dispose');
    frameSelect.value = frameId;
    plot.shadowRoot!.querySelector<HTMLButtonElement>('#run-removal')!.click();
    await vi.waitFor(() => expect(plot.scene!.children.some((child) => child.name === 'machined-stock')).toBe(true));
    expect(dispose).toHaveBeenCalledOnce();
    expect(plot.shadowRoot!.getElementById('material-removal-status')!.textContent).toContain('Completed.');
    expect(worker.terminate).toHaveBeenCalledOnce();
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 1, source });
    expect(requestPlot).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    const mesh = plot.scene.children.find((child) => child.name === 'machined-stock')!.children[0] as THREE.Mesh;
    const meshDispose = vi.spyOn(mesh.geometry, 'dispose');
    plot.clearPlot();
    expect(meshDispose).toHaveBeenCalledOnce();
  });

  it('keeps stock raw and surfaces an invalid frame binding instead of starting a worker', async () => {
    source.text = new SimulationCommentCodec().encodeSetup({
      machineName: 'test', material: { type: 'box', width: 4, height: 4, depth: 4 },
    }, syntax);
    selectedMode = 'simulation';
    plot.scene = new THREE.Scene();
    plot.plotService = new PlotService(bus);
    render.mockRestore();
    const create = vi.spyOn(plot, 'createMaterialSimulationSession');
    await plot.plotNCCode('1');
    plot.shadowRoot!.querySelector<HTMLButtonElement>('#run-removal')!.click();
    await vi.waitFor(() => expect(plot.shadowRoot!.getElementById('material-removal-status')!.textContent)
      .toContain('Select the workpiece frame'));
    expect(create).not.toHaveBeenCalled();
  });

  it.each([true, false])('renders one shared stock or reports a conflict across channels, equal=%s', async (equal) => {
    const firstText = new SimulationCommentCodec().encodeSetup({
      machineName: 'test', material: { type: 'cylinder', diameter: 20, length: 40, zeroVertex: 1 },
    }, syntax);
    source.text = firstText;
    const editor = document.querySelector<HTMLElement & { getProgramSource(): ProgramSource }>(
      'nc-channel-pane[data-channel="2"] nc-code-pane',
    )!;
    editor.getProgramSource = () => ({
      identity: { documentId: 'doc', programId: 'two', channelId: '2' }, revision: 0,
      text: equal ? firstText : new SimulationCommentCodec().encodeSetup({
        machineName: 'test', material: { type: 'cylinder', diameter: 21, length: 40, zeroVertex: 1 },
      }, syntax),
    });
    selectedMode = 'simulation';
    plot.scene = new THREE.Scene();
    plot.plotService = new PlotService(bus);
    render.mockRestore();

    await plot.plotNCCode();

    const materials = plot.scene.children.filter((child) => child.userData.isMaterial);
    expect(materials).toHaveLength(equal ? 1 : 0);
    if (equal) expect(materials[0].children).toHaveLength(1);
    expect(plot.shadowRoot!.getElementById('material-removal-status')!.textContent)
      .toContain(equal ? 'shared cutting order' : 'definitions conflict');
    expect(requestPlot).toHaveBeenCalledTimes(1);
  });

  it('applies the emitted pose orientation directly without double-applying tool mounting orientation', async () => {
    source.text = new SimulationCommentCodec().encodeTool({
      toolNumber: 3,
      description: 'Oriented turning insert',
      orientation: [90, 90, 0],
      cutting: [{ type: 'insert', shape: 'C', ic: 9.525, thickness: 3.18, noseRadius: 0.4, clearanceAngle: 7 }],
    }, syntax);
    requestPlot.mockResolvedValue({ canal: { '1': { segments: [{
      traversal: 'FEED', geometry: 'LINEAR', lineNumber: 1, executionStep: 0, toolNumber: 3,
      points: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }],
      poses: [
        { position: [1, 2, 3], orientation: [0.5, 0.5, -0.5, 0.5], reference: 'turningVirtualTip', frameId: 'workpiece:mainSpindle' },
        { position: [4, 5, 6], orientation: [0.5, 0.5, -0.5, 0.5], reference: 'turningVirtualTip', frameId: 'workpiece:mainSpindle' },
      ],
    }] } } });
    plot.scene = new THREE.Scene();
    selectedMode = 'simulation';

    await plot.plotNCCode('1');
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 1, source });

    expect(plot.toolObject).not.toBeNull();
    expect(plot.toolObject!.quaternion.x).toBeCloseTo(0.5);
    expect(plot.toolObject!.quaternion.y).toBeCloseTo(0.5);
    expect(plot.toolObject!.quaternion.z).toBeCloseTo(-0.5);
    expect(plot.toolObject!.quaternion.w).toBeCloseTo(0.5);
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
      machiningMode: executionStep === 0 ? 'turning' : 'milling',
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
      machiningMode: 'milling',
    }));
    expect(plot.shadowRoot!.getElementById('plot-status')!.textContent).toContain('mode: milling');
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