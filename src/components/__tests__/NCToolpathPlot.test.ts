// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NCToolpathPlot } from '../NCToolpathPlot';
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { GpuDexelStock } from '@services/simulation/GpuDexelStock';
import { SimulationCapabilityError } from '@services/simulation/SimulationTypes';
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
import type { MachineSimulationConfig, PlotMetadata, PlotResponse } from '@core/types';
import { MaterialReplayEngine, type ReplayFrame } from '@services/simulation/MaterialReplayEngine';
import { MaterialReplaySession, type ReplayWorker } from '@services/simulation/MaterialReplaySession';
import { MemoryReplayTraceStore } from '@services/simulation/ReplayTraceStore';

// Exercise actual event/action wiring without constructing a browser WebGL renderer.
interface PlotHarness extends HTMLElement {
  initThree(): void;
  updatePlot(metadata: PlotMetadata): void;
  scene?: THREE.Scene;
  renderer?: THREE.WebGLRenderer | WebGPURenderer;
  gpuDevice?: GPUDevice;
  highlightObject: THREE.LineSegments | null;
  toolObject: THREE.Group | null;
  plotNCCode(channel?: string): Promise<void>;
  clearPlot(): void;
  plotService: PlotService;
  toggleMaterial(): void;
  toggleAxes(): void;
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
  let machineSimulation: MachineSimulationConfig | undefined;
  const syntax = { kind: 'line', prefix: ';' } as const;

  function configureStock(
    frameId: string,
    binding?: NonNullable<MachineSimulationConfig['stockBindings']>[number],
  ): void {
    machineSimulation = {
      schemaVersion: 1, revision: 1, modelId: 'test', displayName: 'test',
      fidelity: 'configured', poseContract: 'workpiece-tool-reference-v1',
      carriers: [{
        id: frameId.slice('workpiece:'.length), role: 'workpiece',
        referenceOrientationDegrees: [0, 0, 0], rotationChain: [],
      }], toolMounts: [], stockBindings: [binding ?? {
        frameId, position: [0, 0, 0], rotation: [0, 0, 0],
        spindleOrigin: [0, 0, 0], spindleAxis: [0, 0, 1],
      }],
    };
  }

  beforeEach(async () => {
    await registry.disposeAll();
    bus = new EventBus();
    tools = new ProgramToolService(new SimulationCommentCodec());
    requestPlot = vi.fn().mockResolvedValue({ canal: { '1': { segments: [] }, '2': { segments: [] } } });
    selectedMode = 'effective';
    machineSimulation = undefined;
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
        activeMachine: { machineName: 'test', simulationCommentSyntax: syntax, simulation: machineSimulation },
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

  function replayWorker(frames: ReplayFrame[] = []): ReplayWorker {
    let replay: MaterialReplayEngine;
    const worker: ReplayWorker = {
      onmessage: null, onerror: null, onmessageerror: null, terminate: vi.fn(),
      postMessage: vi.fn((request) => queueMicrotask(async () => {
        if (request.type === 'close') { await replay?.close(); return; }
        if (request.type === 'initialize') {
          replay = new MaterialReplayEngine(request.input, request.steps);
          replay.setTraceStore(new MemoryReplayTraceStore());
        }
        const frame = request.type === 'initialize' && request.prepareFinal
          ? await replay.prepareFinal(() => {})
          : await replay.seekRecorded(request.type === 'initialize' ? 0 : request.position,
            request.type === 'initialize' || request.forceReplace);
        frames.push(frame);
        worker.onmessage?.(new MessageEvent('message', {
          data: { type: 'frame', requestId: request.requestId, frame },
        }));
      })),
    };
    return worker;
  }

  async function readyReplay(gpu = false): Promise<{ worker: ReplayWorker; frames: ReplayFrame[] }> {
    if (gpu) {
      plot.renderer = new WebGPURenderer();
      vi.spyOn(plot.renderer, 'render').mockImplementation(() => {});
      vi.spyOn(plot.renderer, 'dispose').mockResolvedValue();
      const device: Partial<GPUDevice> = { destroy: vi.fn() };
      plot.gpuDevice = device as GPUDevice;
    }
    configureStock('workpiece:replay');
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
    const frames: ReplayFrame[] = [];
    const worker = replayWorker(frames);
    vi.spyOn(plot, 'createMaterialReplaySession').mockImplementation((runId) =>
      new MaterialReplaySession(runId, () => worker));
    selectedMode = 'simulation';
    plot.scene = new THREE.Scene();
    plot.plotService = new PlotService(bus);
    render.mockRestore();
    await plot.plotNCCode('1');
    const button = plot.shadowRoot!.querySelector<HTMLButtonElement>('#replay-start')!;
    if (gpu) {
      await vi.waitFor(() => expect(plot.shadowRoot!.getElementById('material-removal-status')!.textContent).toContain('GPU tri-dexel coarse'));
      expect(button.disabled).toBe(false);
      return { worker, frames };
    }
    await vi.waitFor(() => expect(plot.shadowRoot!.getElementById('material-removal-status')!.textContent).toContain('Completed.'));
    expect(button.disabled).toBe(false);
    expect(frames[0].finalResult).toBeDefined();
    expect(worker.postMessage).toHaveBeenCalledOnce();
    frames.length = 0;
    button.click();
    await vi.waitFor(() => expect(plot.shadowRoot!.getElementById('replay-status')!.textContent).toContain('Initial stock'));
    return { worker, frames };
  }

  async function expectReplayPosition(position: number): Promise<void> {
    await vi.waitFor(() => {
      expect(plot.shadowRoot!.getElementById('replay-status')!.textContent)
        .toMatch(position ? new RegExp(`^${position}/`) : /^Initial stock/);
      expect(plot.shadowRoot!.getElementById('stock-replay')!.getAttribute('aria-busy')).toBe('false');
    });
  }

  it('uses the GPU path for the complete coarse part, then installs fine stock after idle', async () => {
    vi.useFakeTimers();
    const calculate = vi.spyOn(GpuDexelStock.prototype, 'calculate').mockResolvedValue(5);
    const { worker } = await readyReplay(true);
    expect(worker.postMessage).not.toHaveBeenCalled();
    const status = plot.shadowRoot!.getElementById('material-removal-status')!;
    expect(status.textContent).toContain('0.1 mm ray pitch');
    expect(status.textContent).toContain('4/4');
    expect(plot.scene!.children.some((child) => child.name === 'gpu-dexel-stock')).toBe(true);
    await vi.advanceTimersByTimeAsync(350);
    expect(status.textContent).toContain('GPU tri-dexel fine');
    expect(status.textContent).toContain('0.02 mm ray pitch');
    expect(calculate).toHaveBeenCalledTimes(2);
  });

  it('falls back explicitly to CPU replay when a GPU seek cannot represent a cut', async () => {
    vi.useFakeTimers();
    const calculate = vi.spyOn(GpuDexelStock.prototype, 'calculate').mockResolvedValue(5);
    const { worker } = await readyReplay(true);
    calculate.mockRejectedValueOnce(new SimulationCapabilityError('GPU interval overflow'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    plot.shadowRoot!.querySelector<HTMLButtonElement>('#replay-start')!.click();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(plot.shadowRoot!.getElementById('replay-status')!.textContent).toContain('Using CPU simulation'));
    expect(plot.shadowRoot!.getElementById('replay-status')!.textContent).toContain('GPU interval overflow');
    expect(worker.postMessage).toHaveBeenCalled();
    expect(plot.scene!.children.some((child) => child.name === 'machined-stock')).toBe(true);
    log.mockRestore();
  });

  it('shows mesh phases and first-visit/cache-hit diagnostics without stale timings', async () => {
    await readyReplay();
    const status = plot.shadowRoot!.getElementById('replay-status')!;
    expect(status.textContent).toContain('first visit');
    expect(status.textContent).toContain('extraction/triangulation/adaptation');
    expect(status.textContent).toContain('rebuilt chunks');
    expect(status.textContent).toContain('/64.0 MiB shared surface history');
    expect(status.textContent).toContain('retained states');
    plot.shadowRoot!.querySelector<HTMLButtonElement>('#replay-next')!.click();
    await expectReplayPosition(1);
    expect(status.textContent).toContain('Cached exact surfaces');
    expect(status.textContent).toContain('0/0/0 ms extraction/triangulation/adaptation');
    expect(status.textContent).not.toContain('first visit');
  });

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
    expect(frames[4].replace).toBe(false);
    expect(frames[4].removedCells).toBe(removed);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(requestPlot).toHaveBeenCalledOnce();
  });

  it('always follows the cursor and seeks chosen repeated-line occurrences including state-only commands', async () => {
    await readyReplay();
    expect(plot.shadowRoot!.querySelector('#replay-follow')).toBeNull();
    expect(plot.shadowRoot!.querySelector('#replay-position')).toBeNull();
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 2, source });
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
    expect(plot.shadowRoot!.getElementById('replay-status')!.textContent).toMatch(/^1\//);
    play.click();
    expect(play.textContent).toBe('Play');
    await vi.advanceTimersByTimeAsync(5000);
    expect(worker.postMessage).toHaveBeenCalledTimes(3);
  });

  it('pauses playback when automatic cursor following seeks another occurrence', async () => {
    const { worker } = await readyReplay();
    vi.useFakeTimers();
    const play = plot.shadowRoot!.querySelector<HTMLButtonElement>('#replay-play')!;
    play.click();
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 2, source });
    await vi.advanceTimersByTimeAsync(120);
    expect(play.textContent).toBe('Play');
    expect(plot.shadowRoot!.getElementById('replay-status')!.textContent).toMatch(/^2\//);
    const calls = vi.mocked(worker.postMessage).mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(worker.postMessage).toHaveBeenCalledTimes(calls);
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
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'close', requestId: 0 });
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.onmessage?.(new MessageEvent('message', {
      data: { type: 'frame', requestId: 2, frame: frames[0] },
    }));
    expect(plot.shadowRoot!.querySelector<HTMLButtonElement>('#replay-play')!.disabled).toBe(true);
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
    expect(plot.shadowRoot!.querySelector<HTMLButtonElement>('#replay-play')!.disabled).toBe(true);
  });

  it('seeks retained final history without another initialization or cutting update', async () => {
    const { worker, frames } = await readyReplay();
    plot.shadowRoot!.querySelector<HTMLButtonElement>('#replay-final')!.click();
    await expectReplayPosition(4);
    expect(frames[frames.length - 1].appliedMotions).toBe(0);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(vi.mocked(worker.postMessage).mock.calls.filter(([request]) => request.type === 'initialize')).toHaveLength(1);
    expect(plot.shadowRoot!.querySelector<HTMLButtonElement>('#replay-play')!.disabled).toBe(false);
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
    'uses backend bindings at fine default resolution without rerunning the backend on cursor movement (%s)', async (frameId) => {
    configureStock(frameId);
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
    const worker = replayWorker();
    vi.spyOn(plot, 'createMaterialReplaySession').mockImplementation((runId) =>
      new MaterialReplaySession(runId, () => worker));
    selectedMode = 'simulation';
    plot.scene = new THREE.Scene();
    plot.plotService = new PlotService(bus);
    render.mockRestore();
    await plot.plotNCCode('1');
    expect(plot.shadowRoot!.querySelector('#removal-setup')).toBeNull();
    expect(plot.shadowRoot!.querySelector('#removal-frame')).toBeNull();
    expect(plot.shadowRoot!.querySelector<HTMLInputElement>('#removal-resolution')!.value).toBe('0.05');
    await vi.waitFor(() => expect(plot.scene!.children.some((child) => child.name === 'machined-stock')).toBe(true));
    expect(plot.shadowRoot!.getElementById('material-removal-status')!.textContent).toContain('Completed.');
    expect(worker.terminate).not.toHaveBeenCalled();
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 1, source });
    expect(requestPlot).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'initialize',
      input: expect.objectContaining({ resolutionMm: 0.05 }),
    }));
    const mesh = plot.scene.children.find((child) => child.name === 'machined-stock')!.children[0] as THREE.Mesh;
    const meshDispose = vi.spyOn(mesh.geometry, 'dispose');
    plot.clearPlot();
    expect(meshDispose).toHaveBeenCalledOnce();
  });

  it('keeps backend binding directions and persists resolution changes without backend reexecution', async () => {
    const binding = {
      frameId: 'workpiece:mainSpindle', position: [1, 2, 3], rotation: [0, 0, 90],
      spindleOrigin: [4, 5, 6], spindleAxis: [-1, 0, 0],
    } satisfies NonNullable<MachineSimulationConfig['stockBindings']>[number];
    configureStock(binding.frameId, binding);
    source.text = new SimulationCommentCodec().encodeSetup({
      machineName: 'test', material: { type: 'box', width: 2, height: 2, depth: 2 },
    }, syntax);
    const pose = {
      position: [0, 0, 0], orientation: [0, 0, 0, 1], reference: 'millingTip', frameId: binding.frameId,
    };
    requestPlot.mockResolvedValue({ canal: { '1': { segments: [{
      geometry: 'LINEAR', traversal: 'RAPID', sourceCode: 'G0', lineNumber: 1, executionStep: 0,
      points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], poses: [pose, pose],
    }] } } });
    const worker = replayWorker();
    vi.spyOn(plot, 'createMaterialReplaySession').mockImplementation((runId) =>
      new MaterialReplaySession(runId, () => worker));
    selectedMode = 'simulation';
    plot.scene = new THREE.Scene();
    plot.plotService = new PlotService(bus);
    render.mockRestore();
    await plot.plotNCCode('1');
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'initialize', input: expect.objectContaining({ binding, resolutionMm: 0.05 }),
    }));
    expect(plot.shadowRoot!.querySelector('#removal-position-x')).toBeNull();
    expect(plot.shadowRoot!.querySelector('#removal-spindle-axis')).toBeNull();
    const resolution = plot.shadowRoot!.querySelector<HTMLInputElement>('#removal-resolution')!;
    await vi.waitFor(() => expect(resolution.disabled).toBe(false));
    resolution.value = '0.1';
    resolution.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'initialize',
      input: expect.objectContaining({ binding, resolutionMm: 0.1 }),
    })));
    expect(requestPlot).toHaveBeenCalledOnce();
    vi.mocked(worker.postMessage).mockClear();
    await plot.plotNCCode('1');
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'initialize',
      input: expect.objectContaining({ binding, resolutionMm: 0.1 }),
    })));
    expect(plot.shadowRoot!.querySelector<HTMLInputElement>('#removal-resolution')!.value).toBe('0.1');
    const requestsBeforeCursor = requestPlot.mock.calls.length;
    bus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, { channelId: '1', lineNumber: 1, source });
    expect(requestPlot).toHaveBeenCalledTimes(requestsBeforeCursor);
  });

  it('keeps stock raw and reports a missing backend binding without exposing debug setup', async () => {
    source.text = new SimulationCommentCodec().encodeSetup({
      machineName: 'test', material: { type: 'box', width: 4, height: 4, depth: 4 },
    }, syntax);
    selectedMode = 'simulation';
    plot.scene = new THREE.Scene();
    plot.plotService = new PlotService(bus);
    render.mockRestore();
    const create = vi.spyOn(plot, 'createMaterialReplaySession');
    await plot.plotNCCode('1');
    await vi.waitFor(() => expect(plot.shadowRoot!.getElementById('material-removal-status')!.textContent)
      .toContain('Configure stockBindings in the backend'));
    expect(plot.shadowRoot!.querySelector('#removal-setup')).toBeNull();
    expect(plot.shadowRoot!.querySelector<HTMLButtonElement>('#replay-start')!.disabled).toBe(true);
    expect(plot.shadowRoot!.querySelector<HTMLInputElement>('#removal-resolution')!.disabled).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('places resolution and replay actions together in compact bottom controls', () => {
    const controls = plot.shadowRoot!.getElementById('stock-replay')!;
    expect(controls.closest('.plot-info')).not.toBeNull();
    expect(controls.querySelector<HTMLInputElement>('#removal-resolution')!.value).toBe('0.05');
    expect(controls.querySelector('#replay-start')!.textContent).toBe('Replay');
    expect(controls.querySelector('#replay-play')!.textContent).toBe('Play');
    expect(plot.shadowRoot!.querySelector('details')).toBeNull();
  });

  it.each(['', '0.01', '6'])('reports invalid resolution %j without replacing the completed stock', async (value) => {
    const { worker } = await readyReplay();
    const stock = plot.scene!.children.find((child) => child.name === 'machined-stock');
    const calls = vi.mocked(worker.postMessage).mock.calls.length;
    const resolution = plot.shadowRoot!.querySelector<HTMLInputElement>('#removal-resolution')!;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    resolution.value = value;
    resolution.dispatchEvent(new Event('change'));
    expect(plot.shadowRoot!.getElementById('material-removal-status')!.textContent)
      .toContain('Material removal unavailable');
    expect(error).toHaveBeenCalled();
    expect(plot.scene!.children.find((child) => child.name === 'machined-stock')).toBe(stock);
    expect(worker.postMessage).toHaveBeenCalledTimes(calls);
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