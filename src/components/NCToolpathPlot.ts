import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { GpuDexelStock } from '@services/simulation/GpuDexelStock';
import { GpuMaterialReplaySession, type GpuReplayFrame } from '@services/simulation/GpuMaterialReplaySession';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ServiceRegistry } from '@core/ServiceRegistry';
import {
  PLOT_SERVICE_TOKEN,
  EVENT_BUS_TOKEN,
  EXECUTED_PROGRAM_SERVICE_TOKEN,
  STATE_SERVICE_TOKEN,
  PROGRAM_TOOL_SERVICE_TOKEN,
  FILE_MANAGER_SERVICE_TOKEN,
} from '@core/ServiceTokens';
import { PlotService } from '@services/PlotService';
import { EventBus, EVENT_NAMES, type EventSubscription } from '@services/EventBus';
import { ExecutedProgramService } from '@services/ExecutedProgramService';
import { StateService } from '@services/StateService';
import type { PlotMetadata, CustomVariable, ChannelId, ParseArtifacts } from '@core/types';
import type { ProgramToolService, ProgramSource } from '@services/tools/ProgramToolService';
import type { ProgramToolSnapshot } from '@services/tools/ProgramToolService';
import { programIdentityKey } from '@services/tools/ProgramToolService';
import type {
  DeepReadonly,
  ProgramMaterialDefinition,
  ToolIdentifier,
  ProgramToolDefinition,
} from '@services/tools/SimulationMetadata';
import { createPlotSelectionResolver, type PlotSourceLocation } from '@services/tools/PlotSelectionResolver';
import type { IFileManagerService } from '@services/IFileManagerService';
import type { PlotRunInput } from '@services/tools/PlotRunSnapshot';
import type { PlotSegment } from '@core/types';
import type { NCBottomPanel } from './NCBottomPanel';
import { ToolGeometryFactory } from './ToolGeometryFactory';
import { prepareMaterialRemoval, type MaterialRemovalPreparation } from '@services/tools/MaterialRemovalPreparation';
import { MaterialReplaySession } from '@services/simulation/MaterialReplaySession';
import type { ReplayFrame } from '@services/simulation/MaterialReplayEngine';
import { createPlotReplayTimeline, type PlotReplayTimeline } from '@services/tools/PlotReplayTimeline';
import type { StockBinding, SimulationInput, SimulationResult } from '@services/simulation/SimulationTypes';
import { rotationQuaternion } from '@services/simulation/SimulationTransforms';

export class NCToolpathPlot extends HTMLElement {
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private renderer?: THREE.WebGLRenderer | WebGPURenderer;
  private rendererReady?: Promise<void>;
  private gpuDevice?: GPUDevice;
  private gpuFallbackReason = '';
  private gpuWarmupStock?: GpuDexelStock;
  private gpuComputeError?: string;
  private controls?: OrbitControls;
  private plotService: PlotService;
  private eventBus: EventBus;
  private executedProgramService: ExecutedProgramService;
  private stateService: StateService;
  private animationFrameId?: number;
  private isVisible = false;
  private resizeObserver?: ResizeObserver;
  private isPlotting = false;
  private highlightObject: THREE.Object3D | null = null;
  private toolObject: THREE.Group | null = null;
  private readonly toolGeometryFactory = new ToolGeometryFactory();
  private simulationEnabled = false;
  private selectedSegment?: PlotSegment;
  private selectedTool?: ReturnType<ExecutedProgramService['getRunTool']>;
  private themeObserver?: MutationObserver;
  private programTools: ProgramToolService;
  private fileManager: IFileManagerService;
  private materialVisible = true;
  private materialObject: THREE.Group | null = null;
  private subscriptions: EventSubscription[] = [];
  private displayedRunId?: string;
  private resolveSelection?: ReturnType<typeof createPlotSelectionResolver>;
  private selectionLocation?: PlotSourceLocation;
  private selectedExecutionStep?: number;
  private requestGeneration = 0;
  private stale = false;
  private readonly detectedToolsByChannel = new Map<string, ToolIdentifier[]>();
  private removalSetup?: { binding: StockBinding; resolutionMm: number };
  private removalSetupScope?: string;
  private removalGeneration = 0;
  private removalPreparation?: DeepReadonly<MaterialRemovalPreparation>;
  private materialReplay?: MaterialReplaySession | GpuMaterialReplaySession;
  private replayTimeline?: PlotReplayTimeline;
  private replayPosition = 0;
  private replayRequestedPosition = 0;
  private replayGeneration = 0;
  private replayBusy = false;
  private replayPlaying = false;
  private replayTimer?: ReturnType<typeof setTimeout>;
  private cursorReplayTimer?: ReturnType<typeof setTimeout>;
  private replayPrepared = false;
  private readonly stockMeshes = new Map<number, THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>>();

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    const registry = ServiceRegistry.getInstance();
    this.plotService = registry.get(PLOT_SERVICE_TOKEN);
    this.eventBus = registry.get(EVENT_BUS_TOKEN);
    this.executedProgramService = registry.get(EXECUTED_PROGRAM_SERVICE_TOKEN);
    this.stateService = registry.get(STATE_SERVICE_TOKEN);
    this.programTools = registry.get(PROGRAM_TOOL_SERVICE_TOKEN);
    this.fileManager = registry.get(FILE_MANAGER_SERVICE_TOKEN);
  }

  connectedCallback() {
    this.render();
    this.rendererReady = this.initThree();
    this.setupEventListeners();
  }

  disconnectedCallback() {
    this.clearPlot();
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
    this.subscriptions = [];
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.themeObserver) {
      this.themeObserver.disconnect();
    }
    if (this.controls) {
      this.controls.dispose();
    }
    if (this.materialObject?.userData.releaseGpuStock) {
      this.removeOwnedPlotObject(this.materialObject);
      this.materialObject = null;
    }
    this.gpuWarmupStock?.dispose();
    this.gpuWarmupStock = undefined;
    if (this.renderer) {
      const device = this.gpuDevice;
      this.gpuDevice = undefined;
      void Promise.resolve(this.renderer.dispose()).catch((error: unknown) => {
        console.error('Plot renderer shutdown failed:', error);
      }).finally(() => device?.destroy());
      this.renderer = undefined;
    }
  }

  private setupEventListeners() {
    // One render per completed run; per-channel events remain for errors/variables only.
    this.subscriptions.push(this.eventBus.subscribe(EVENT_NAMES.PLOT_RUN_COMPLETED, (data: { runId: string }) => {
      const run = this.executedProgramService.getPlotRun(data.runId);
      if (!run || data.runId === this.displayedRunId) return;
      this.cancelMaterialRemoval();
      this.displayedRunId = run.runId;
      this.removalPreparation = run.materialRemoval;
      this.simulationEnabled = run.toolPathMode === 'simulation';
      this.clearSelection();
      this.resolveSelection = createPlotSelectionResolver(run);
      this.stale = false;
      const materials = run.materialRemoval?.stock ? [run.materialRemoval.stock] : [];
      this.updatePlot(structuredClone(run.plotMetadata) as PlotMetadata, materials);
      this.updateMaterialRemovalStatus();
      this.updateRemovalResolution();
      this.updateReplayControls();
      this.refreshStaleness();
      if (!this.stale && run.materialRemoval?.status === 'ready') {
        void this.startMaterialRemoval(run.materialRemoval);
      }
    }));

    // Allow external UI elements to request a plot
    this.subscriptions.push(this.eventBus.subscribe(EVENT_NAMES.PLOT_REQUEST, (data: unknown) => {
      const requestData = data as { channelId?: string } | undefined;
      this.plotNCCode(requestData?.channelId);
    }));

    // Listen for plot toggle
    this.subscriptions.push(this.eventBus.subscribe(EVENT_NAMES.STATE_CHANGED, (data: unknown) => {
      const stateData = data as { uiSettings?: { plotViewerOpen?: boolean } };
      if (stateData.uiSettings?.plotViewerOpen !== undefined) {
        this.isVisible = stateData.uiSettings.plotViewerOpen;
        this.updateVisibility();
      }
      this.refreshStaleness();
    }));
    for (const name of ['program:content_changed', 'program:active_changed', EVENT_NAMES.MACHINE_CHANGED,
      EVENT_NAMES.PROGRAM_TOOL_VALUES_CHANGED, EVENT_NAMES.PROGRAM_TOOL_OFFSETS_CHANGED,
      EVENT_NAMES.CUSTOM_VARIABLES_CHANGED, EVENT_NAMES.PARSE_COMPLETED]) {
      this.subscriptions.push(this.eventBus.subscribe(name, () => this.refreshStaleness()));
    }

    // Cache detected tool numbers per channel so Plot can check completeness without reparsing.
    this.subscriptions.push(this.eventBus.subscribe(
      EVENT_NAMES.PARSE_COMPLETED,
      (data: { channelId?: string; artifacts?: ParseArtifacts }) => {
        if (!data.channelId || !data.artifacts) return;
        this.detectedToolsByChannel.set(data.channelId, data.artifacts.toolRegisters.map((tool) => tool.toolNumber));
      },
    ));

    // Listen for cursor movement to highlight segments
    this.subscriptions.push(this.eventBus.subscribe(EVENT_NAMES.EDITOR_CURSOR_MOVED, (data: unknown) => {
      const cursorData = data as { channelId: string; lineNumber: number; source?: ProgramSource };
      this.refreshStaleness();
      if (this.stale || !cursorData.source) {
        this.clearSelection();
        return;
      }
      const run = this.displayedRunId ? this.executedProgramService.getPlotRun(this.displayedRunId) : undefined;
      const snapshot = run?.inputs.find((input) => input.snapshot.identity.channelId === cursorData.channelId)?.snapshot;
      if (!snapshot || snapshot.revision !== cursorData.source.revision ||
        programIdentityKey(snapshot.identity) !== programIdentityKey(cursorData.source.identity)) {
        this.clearSelection();
        return;
      }
      if (!run) return;
      const location: PlotSourceLocation = {
        channelId: cursorData.channelId as ChannelId,
        lineNumber: cursorData.lineNumber,
      };
      const sameLocation = this.selectionLocation?.channelId === location.channelId &&
        this.selectionLocation.lineNumber === location.lineNumber;
      this.selectionLocation = location;
      this.selectOccurrence(sameLocation ? this.selectedExecutionStep : undefined, true);
    }));
  }

  private clearSelection(): void {
    this.selectedSegment = undefined;
    this.selectedTool = undefined;
    this.highlightSegment();
    this.updateToolMesh();
    this.selectionLocation = undefined;
    this.selectedExecutionStep = undefined;
    const control = this.shadowRoot?.querySelector<HTMLSelectElement>('#plot-occurrence');
    if (control) {
      control.replaceChildren();
      control.disabled = true;
    }
    this.eventBus.publish(EVENT_NAMES.PLOT_SELECTION_CHANGED, { runId: this.displayedRunId, status: 'cleared' });
  }

  private updateMaterialRemovalStatus(): void {
    const element = this.shadowRoot?.getElementById('material-removal-status');
    if (!element) return;
    const preparation = this.displayedRunId
      ? this.executedProgramService.getPlotRun(this.displayedRunId)?.materialRemoval
      : undefined;
    element.hidden = !preparation || preparation.status === 'not-configured';
    element.textContent = preparation?.diagnostics.map((diagnostic) => diagnostic.message).join(' ') ?? '';
  }

  private updateRemovalResolution(): void {
    const resolution = this.shadowRoot?.querySelector<HTMLInputElement>('#removal-resolution');
    const run = this.displayedRunId ? this.executedProgramService.getPlotRun(this.displayedRunId) : undefined;
    if (!resolution) return;
    const input = run?.inputs[0];
    const manual = input && this.stockBindingScope(input) === this.removalSetupScope
      ? this.removalSetup : input?.materialSimulation;
    resolution.value = String(manual?.resolutionMm ?? run?.materialRemoval?.simulation?.resolutionMm ?? 0.05);
  }

  private async changeRemovalResolution(): Promise<void> {
    const status = this.shadowRoot?.getElementById('material-removal-status');
    try {
      this.refreshStaleness();
      const run = this.displayedRunId ? this.executedProgramService.getPlotRun(this.displayedRunId) : undefined;
      if (!run || this.stale) throw new Error('Plot the current program before material removal');
      const field = this.shadowRoot?.querySelector<HTMLInputElement>('#removal-resolution');
      if (!field?.value.trim() || !Number.isFinite(field.valueAsNumber))
        throw new Error('Removal resolution must be a finite number');
      const binding = this.removalPreparation?.simulation?.binding;
      if (!binding) throw new Error('Configure a matching stock binding in the backend machine definition');
      const setup: { binding: StockBinding; resolutionMm: number } = {
        binding: {
          frameId: binding.frameId,
          position: [...binding.position], rotation: [...binding.rotation],
          spindleOrigin: [...binding.spindleOrigin], spindleAxis: [...binding.spindleAxis],
        },
        resolutionMm: field.valueAsNumber,
      };
      const preparation = prepareMaterialRemoval(run.inputs, run.plotMetadata, setup);
      if (preparation.status !== 'ready') {
        throw new Error(preparation.diagnostics.map((diagnostic) => diagnostic.message).join(' '));
      }
      this.removalSetup = setup;
      this.removalSetupScope = this.stockBindingScope(run.inputs[0]);
      await this.startMaterialRemoval(preparation);
    } catch (error) {
      console.error('Material removal resolution change failed:', error);
      if (status) {
        status.hidden = false;
        status.textContent = `Material removal unavailable: ${error instanceof Error ? error.message : 'Invalid resolution'}`;
      }
    }
  }

  private async createReplaySession(runId: string): Promise<MaterialReplaySession | GpuMaterialReplaySession> {
    await this.rendererReady;
    const enabled = this.shadowRoot?.querySelector<HTMLInputElement>('#gpu-stock')?.checked;
    this.gpuFallbackReason = '';
    if (enabled && this.renderer instanceof WebGPURenderer && this.gpuDevice && !this.gpuComputeError) {
      const field = this.shadowRoot?.querySelector<HTMLInputElement>('#gpu-fine-resolution');
      const session = new GpuMaterialReplaySession(runId, this.renderer, this.gpuDevice, {
        finePitchMm: field?.valueAsNumber ?? 0.02,
        residentBytes: this.gpuWarmupStock?.estimatedBytes ?? 0,
        onRefined: (frame) => {
          if (this.materialReplay === session && !this.stale && this.replayPrepared && this.replayRequestedPosition === frame.requestedPosition) this.installReplayFrame(frame);
        },
        onRefinementError: (error) => {
          if (this.materialReplay !== session || this.stale) return;
          this.replayStatus(`GPU fine refinement unavailable: ${error.message}. Coarse stock is retained; change fine pitch or switch to CPU simulation.`);
          const status = this.shadowRoot?.getElementById('material-removal-status');
          if (status) status.textContent = `GPU fine refinement failed: ${error.message}. Displayed stock remains coarse, not the requested fine result.`;
        },
      });
      return session;
    }
    if (enabled) this.gpuFallbackReason = this.gpuComputeError ?? 'WebGPU compute is not available in this view';
    return this.createMaterialReplaySession(runId);
  }

  private async startSelectedSession(session: MaterialReplaySession | GpuMaterialReplaySession,
    input: DeepReadonly<SimulationInput>, steps: readonly number[],
    progress: (processed: number, total: number) => void, prepareFinal = false): Promise<ReplayFrame | GpuReplayFrame> {
    try { return await session.start(input, steps, progress, prepareFinal); }
    catch (error) {
      if (!(session instanceof GpuMaterialReplaySession) || this.materialReplay !== session ||
          (error instanceof DOMException && error.name === 'AbortError')) throw error;
      console.warn('GPU stock unavailable; using CPU simulation:', error);
      this.gpuFallbackReason = error instanceof Error ? error.message : 'GPU stock initialization failed';
      session.cancel();
      const cpu = this.createMaterialReplaySession(session.runId);
      this.materialReplay = cpu;
      return cpu.start(input, steps, progress, prepareFinal);
    }
  }

  private async startMaterialRemoval(preparation: DeepReadonly<MaterialRemovalPreparation>): Promise<void> {
    if (!preparation.simulation || !this.displayedRunId || !this.scene) return;
    this.cancelMaterialRemoval();
    this.removalPreparation = preparation;
    this.updateReplayControls();
    const generation = this.removalGeneration;
    const status = this.shadowRoot?.getElementById('material-removal-status');
    const cancel = this.shadowRoot?.querySelector<HTMLButtonElement>('#cancel-removal');
    if (cancel) cancel.hidden = false;
    try {
      const run = this.executedProgramService.getPlotRun(this.displayedRunId);
      if (!run) throw new Error('Material removal requires a retained executed run');
      const timeline = createPlotReplayTimeline(run);
      const session = await this.createReplaySession(this.displayedRunId);
      if (generation !== this.removalGeneration) { session.cancel(); return; }
      this.materialReplay = session;
      this.replayTimeline = timeline;
      this.replayBusy = true;
      this.updateReplayControls();
      this.showInitialStock(preparation.simulation);
      const frame = await this.startSelectedSession(session, preparation.simulation,
        timeline.occurrences.map((occurrence) => occurrence.executionStep), (processed, total) => {
        if (generation !== this.removalGeneration || !status) return;
        status.hidden = false;
        status.textContent = `Geometric removal: ${processed}/${total} motions. Feed cutting is assumed; spindle operation is not verified.`;
      }, true);
      if (generation !== this.removalGeneration || this.stale || session.runId !== this.displayedRunId) return;
      if ('backend' in frame) {
        this.replayPrepared = true;
        this.installReplayFrame(frame);
        return;
      }
      if (!frame.finalResult) throw new Error('Prepared stock response is missing final diagnostics');
      const result = frame.finalResult;
      this.installStockSurface(result);
      this.replayPosition = this.replayRequestedPosition = frame.position;
      this.replayPrepared = true;
      this.replayStatus(`Final stock prepared with ${frame.historyMode === 'partial-disk' ? 'partial disk history' : 'bounded checkpoint fallback'}; ${((frame.historyBytes ?? 0) / 1048576).toFixed(1)} MiB history.${frame.historyWarning ? ` ${frame.historyWarning}` : ''}`);
      if (status) {
        status.hidden = false;
        const stopped = result.stop
          ? `Stopped before step ${result.stop.executionStep ?? '?'}${result.stop.lineNumber === undefined ? '' : `, line ${result.stop.lineNumber}`}: ${result.stop.message}.`
          : 'Completed.';
        const phases = result.subtractionMs !== undefined && result.meshingMs !== undefined
          ? ` (${result.subtractionMs.toFixed(0)} ms subtraction, ${result.meshingMs.toFixed(0)} ms ${result.meshingAttribution === 'final-only' ? 'final ' : ''}meshing)`
          : '';
        const meshPhases = result.extractionMs !== undefined && result.triangulationMs !== undefined && result.adaptationMs !== undefined
          ? ` [${result.extractionMs.toFixed(0)}/${result.triangulationMs.toFixed(0)}/${result.adaptationMs.toFixed(0)} ms extraction/triangulation/adaptation]`
          : '';
        const operations = result.operationDiagnostics;
        const operationTotals = operations?.reduce(
          (totals, operation) => {
            totals[operation.mode]++;
            totals[`${operation.mode}Ms`] += operation.elapsedMs;
            totals.rotational += operation.rotationalFastPathSubtractions;
            totals.indexed += operation.indexedBatches;
            return totals;
          },
          { turning: 0, milling: 0, turningMs: 0, millingMs: 0, rotational: 0, indexed: 0 },
        );
        const operationSummary = operationTotals
          ? ` ${operationTotals.turning} turning (${operationTotals.turningMs.toFixed(0)} ms) / ${operationTotals.milling} milling (${operationTotals.millingMs.toFixed(0)} ms) operations; ${operationTotals.rotational} rotational-fast subtractions; ${operationTotals.indexed} indexed batches.`
          : '';
        const retainedFine = result.surfaceAdaptationSkippedChunks
          ? ` ${result.surfaceAdaptationSkippedChunks} surface chunks retained at fine detail because optional reduction workspace would exceed the budget.`
          : '';
        status.textContent = `Geometric removal: ${stopped} ${result.processedMotions} motions; ${result.resolutionMm} mm boundary spacing; ${result.boundaryCells} refined boundary cells; ${result.removedCells} cell-centre samples removed; ${(result.peakStockBytes / 1048576).toFixed(1)} MiB peak estimated stock, ${(result.surfaceBytes / 1048576).toFixed(1)} MiB surface; ${result.elapsedMs.toFixed(0)} ms${phases}${meshPhases}.${operationSummary}${retainedFine} Feed cutting is assumed; spindle operation is not verified.`;
      }
    } catch (error) {
      if (generation !== this.removalGeneration) return;
      this.cancelReplay();
      console.error('Material removal failed:', error);
      if (status) {
        status.hidden = false;
        status.textContent = `Material removal failed: ${error instanceof Error ? error.message : 'Worker failure'}. Initial stock is shown, not a completed result.`;
      }
    } finally {
      if (generation === this.removalGeneration) {
        this.replayBusy = false;
        if (cancel) cancel.hidden = true;
        this.updateReplayControls();
      }
    }
  }

  private showInitialStock(input: DeepReadonly<SimulationInput>): void {
    const raw = this.toolGeometryFactory.createMaterialMesh(input.stock);
    if (raw) {
      raw.matrixAutoUpdate = false;
      raw.matrix.compose(
        new THREE.Vector3(...input.binding.position),
        rotationQuaternion(input.binding.rotation), new THREE.Vector3(1, 1, 1),
      );
      this.replaceMaterialObject(raw);
    }
  }

  private replaceMaterialObject(group: THREE.Group): void {
    if (!this.scene) return;
    if (this.materialObject) this.removeOwnedPlotObject(this.materialObject);
    group.userData.isMaterial = true;
    group.visible = this.materialVisible;
    this.materialObject = group;
    this.stockMeshes.clear();
    this.scene.add(group);
    this.updateMaterialControl();
  }

  private installStockSurface(result: Pick<SimulationResult, 'chunks' | 'stockToWorkpiece'>): void {
    const group = new THREE.Group();
    group.name = 'machined-stock';
    group.matrixAutoUpdate = false;
    group.matrix.fromArray(result.stockToWorkpiece);
    const material = result.chunks.length ? new THREE.MeshStandardMaterial({
      color: 0xd9c7a6, metalness: 0.25, roughness: 0.8,
    }) : undefined;
    for (const chunk of result.chunks) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(chunk.normals, 3));
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.stockChunkId = chunk.id;
      group.add(mesh);
    }
    this.replaceMaterialObject(group);
    for (const mesh of group.children) {
      if (mesh instanceof THREE.Mesh && mesh.material instanceof THREE.MeshStandardMaterial)
        this.stockMeshes.set(mesh.userData.stockChunkId, mesh);
    }
  }

  private cancelMaterialRemoval(): void {
    this.removalGeneration++;
    this.cancelReplay();
    const cancel = this.shadowRoot?.querySelector<HTMLButtonElement>('#cancel-removal');
    if (cancel) cancel.hidden = true;
  }

  private stockBindingScope(input: DeepReadonly<PlotRunInput>): string {
    return JSON.stringify([programIdentityKey(input.snapshot.identity), input.machineName, input.machineProfile?.profileRevision]);
  }

  private selectOccurrence(step?: number, debounce = false): void {
    if (this.cursorReplayTimer !== undefined) clearTimeout(this.cursorReplayTimer);
    this.cursorReplayTimer = undefined;
    this.refreshStaleness();
    if (this.stale || !this.selectionLocation || !this.displayedRunId) {
      this.clearSelection();
      return;
    }
    const location = this.selectionLocation;
    if (this.materialReplay && this.replayPrepared) {
      const index = this.replayTimeline?.occurrences.findIndex((occurrence) =>
        occurrence.channelId === location.channelId && occurrence.lineNumber === location.lineNumber &&
        (step === undefined || occurrence.executionStep === step));
      if (index !== undefined && index >= 0) {
        if (debounce) {
          this.cursorReplayTimer = setTimeout(() => {
            this.cursorReplayTimer = undefined;
            void this.seekReplay(index + 1);
          }, 120);
        } else void this.seekReplay(index + 1);
      } else {
        this.clearSelection();
        const status = this.shadowRoot?.getElementById('plot-status');
        if (status) status.textContent = 'No executed occurrence for this location; replay stock is unchanged.';
      }
      return;
    }
    const selection = this.resolveSelection?.(location, step);
    this.highlightSegment(selection?.segment);
    const control = this.shadowRoot?.querySelector<HTMLSelectElement>('#plot-occurrence');
    if (control) {
      control.replaceChildren();
      control.disabled = selection?.status !== 'selected';
      for (const [index, executionStep] of (selection?.occurrenceSteps ?? []).entries()) {
        control.add(new Option(`${index + 1} / ${selection!.occurrenceSteps!.length} (step ${executionStep})`, String(executionStep)));
      }
    }
    const status = this.shadowRoot?.getElementById('plot-status');
    if (selection?.status !== 'selected' || !selection.segment) {
      this.selectedExecutionStep = undefined;
      if (status) status.textContent = selection?.status === 'no-plotted-move'
        ? 'No plotted move for this location' : 'Execution occurrence unavailable';
      this.eventBus.publish(EVENT_NAMES.PLOT_SELECTION_CHANGED, {
        runId: this.displayedRunId, status: selection?.status ?? 'cleared', location,
      });
      return;
    }
    this.selectedExecutionStep = selection.segment.executionStep!;
    if (control) control.value = String(this.selectedExecutionStep);
    const run = this.executedProgramService.getPlotRun(this.displayedRunId);
    const source = run?.inputs.find((input) => input.snapshot.identity.channelId === location.channelId)?.snapshot;
    const tool = source && this.executedProgramService.getRunTool(
      this.displayedRunId, source.identity.programId, location.channelId, selection.segment.toolNumber,
    );
    this.updateToolMesh(selection.segment, tool);
    if (status) status.textContent = `Execution step ${this.selectedExecutionStep}; mode: ${selection.segment.machiningMode ?? 'unknown'}; ${tool ? tool.description : 'tool definition unavailable'}`;
    this.eventBus.publish(EVENT_NAMES.PLOT_SELECTION_CHANGED, {
      runId: this.displayedRunId, status: 'selected', source: source?.identity, location,
      executionStep: this.selectedExecutionStep, fraction: selection.fraction,
      sourceSegmentIndex: selection.segment.sourceSegmentIndex,
      subsegmentIndex: selection.segment.subsegmentIndex,
      toolNumber: selection.segment.toolNumber, toolDefinitionAvailable: Boolean(tool),
      machiningMode: selection.segment.machiningMode ?? 'unknown',
    });
  }

  private createMaterialReplaySession(runId: string): MaterialReplaySession {
    return new MaterialReplaySession(runId);
  }

  private updateReplayControls(): void {
    const controls = this.shadowRoot?.getElementById('stock-replay');
    if (!controls) return;
    const available = Boolean(this.simulationEnabled && this.removalPreparation?.simulation &&
      this.displayedRunId && !this.stale);
    controls.hidden = !this.simulationEnabled || !this.removalPreparation?.stock;
    const active = Boolean(this.materialReplay && this.replayTimeline);
    const button = (id: string) => this.shadowRoot?.querySelector<HTMLButtonElement>(`#replay-${id}`);
    const start = button('start');
    if (start) {
      start.disabled = !available || (this.replayBusy && !this.replayPrepared);
      start.textContent = 'Replay';
    }
    const play = button('play');
    if (play) {
      play.disabled = !active || !this.replayPrepared || this.stale;
      play.textContent = this.replayPlaying ? 'Pause' : 'Play';
      play.setAttribute('aria-pressed', String(this.replayPlaying));
    }
    const previous = button('previous');
    if (previous) previous.disabled = !active || !this.replayPrepared || this.stale || this.replayRequestedPosition <= 0;
    const next = button('next');
    if (next) next.disabled = !active || !this.replayPrepared || this.stale ||
      this.replayRequestedPosition >= (this.replayTimeline?.occurrences.length ?? 0);
    const final = button('final');
    if (final) final.disabled = !available || !active || !this.replayPrepared;
    const resolution = this.shadowRoot?.querySelector<HTMLInputElement>('#removal-resolution');
    if (resolution) resolution.disabled = !available || this.replayBusy;
    const status = this.shadowRoot?.getElementById('replay-status');
    if (status) status.hidden = controls.hidden;
    const hint = this.shadowRoot?.querySelector<HTMLElement>('.orbit-hint');
    if (hint) hint.hidden = !controls.hidden;
    controls.setAttribute('aria-busy', String(this.replayBusy));
    const cancel = this.shadowRoot?.querySelector<HTMLButtonElement>('#cancel-removal');
    if (cancel && active) cancel.hidden = false;
  }

  private pauseReplay(): void {
    this.replayPlaying = false;
    if (this.replayTimer !== undefined) clearTimeout(this.replayTimer);
    this.replayTimer = undefined;
    this.updateReplayControls();
  }

  private cancelReplay(): void {
    const active = Boolean(this.materialReplay);
    this.replayGeneration++;
    this.pauseReplay();
    this.materialReplay?.cancel();
    this.materialReplay = undefined;
    this.replayTimeline = undefined;
    this.replayBusy = false;
    this.replayPosition = 0;
    this.replayRequestedPosition = 0;
    this.replayPrepared = false;
    if (this.cursorReplayTimer !== undefined) clearTimeout(this.cursorReplayTimer);
    this.cursorReplayTimer = undefined;
    const cancel = this.shadowRoot?.querySelector<HTMLButtonElement>('#cancel-removal');
    if (cancel) cancel.hidden = true;
    if (active) this.replayStatus('Replay stopped. Last displayed stock is retained; no further cuts are applied.');
    this.updateReplayControls();
  }

  private replayStatus(text: string): void {
    const status = this.shadowRoot?.getElementById('replay-status');
    if (status) status.textContent = `${text}${this.gpuFallbackReason ? ` GPU unavailable: ${this.gpuFallbackReason}. Using CPU simulation.` : ''}`;
  }

  private async startReplay(): Promise<void> {
    this.refreshStaleness();
    const run = this.displayedRunId ? this.executedProgramService.getPlotRun(this.displayedRunId) : undefined;
    const input = this.removalPreparation?.simulation;
    if (!run || !input || this.stale) {
      this.replayStatus('Plot the current program with a configured backend stock binding before starting replay.');
      return;
    }
    if (this.materialReplay && this.replayPrepared) {
      await this.seekReplay(0);
      return;
    }
    let generation = this.replayGeneration;
    try {
      const timeline = createPlotReplayTimeline(run);
      this.cancelMaterialRemoval();
      generation = this.replayGeneration;
      const session = await this.createReplaySession(run.runId);
      if (generation !== this.replayGeneration) { session.cancel(); return; }
      this.materialReplay = session;
      this.replayTimeline = timeline;
      this.replayBusy = true;
      this.clearSelection();
      this.showInitialStock(input);
      this.updateReplayControls();
      this.replayStatus('Preparing initial stock for replay...');
      const status = this.shadowRoot?.getElementById('material-removal-status');
      if (status) {
        status.hidden = false;
        status.textContent = 'Line replay: stock is shown after completed execution occurrences. Feed cutting is assumed; spindle operation is not verified.';
      }
      const frame = await this.startSelectedSession(session, input, timeline.occurrences.map((occurrence) => occurrence.executionStep),
        (processed, total) => {
          if (this.materialReplay === session && !this.stale)
            this.replayStatus(`Updating replay stock: ${processed}/${total} cutting motions...`);
        });
      if (generation !== this.replayGeneration || this.stale || session.runId !== this.displayedRunId) return;
      this.replayPrepared = true;
      this.installReplayFrame(frame);
    } catch (error) {
      if (generation !== this.replayGeneration || (error instanceof DOMException && error.name === 'AbortError')) return;
      console.error('Material replay failed:', error);
      this.cancelReplay();
      this.replayStatus(`Replay unavailable: ${error instanceof Error ? error.message : 'Worker failure'}. Stock is not a completed result.`);
    } finally {
      if (generation === this.replayGeneration) {
        this.replayBusy = false;
        this.updateReplayControls();
      }
    }
  }

  private async seekReplay(position: number, playback = false): Promise<void> {
    let session = this.materialReplay;
    if (!session || this.stale) return;
    if (this.cursorReplayTimer !== undefined) clearTimeout(this.cursorReplayTimer);
    this.cursorReplayTimer = undefined;
    if (!playback) this.pauseReplay();
    const generation = ++this.replayGeneration;
    this.replayBusy = true;
    this.replayRequestedPosition = position;
    this.updateReplayControls();
    this.replayStatus(`Seeking executed occurrence ${position}...`);
    try {
      let frame: ReplayFrame | GpuReplayFrame;
      try { frame = await session.seek(position); }
      catch (error) {
        if (!(session instanceof GpuMaterialReplaySession) || (error instanceof DOMException && error.name === 'AbortError')) throw error;
        if (generation !== this.replayGeneration || session !== this.materialReplay || this.stale) return;
        console.error('GPU replay failed; switching to CPU:', error);
        this.gpuFallbackReason = error instanceof Error ? error.message : 'GPU replay failure';
        session.cancel();
        const input = this.removalPreparation?.simulation;
        if (!input || !this.replayTimeline) throw error;
        session = this.createMaterialReplaySession(session.runId);
        this.materialReplay = session;
        await session.start(input, this.replayTimeline.occurrences.map((entry) => entry.executionStep));
        frame = await session.seek(position);
      }
      if (generation !== this.replayGeneration || this.stale || session !== this.materialReplay) return;
      this.installReplayFrame(frame);
      if (frame.stop || frame.position === frame.total) this.pauseReplay();
    } catch (error) {
      if (generation !== this.replayGeneration || (error instanceof DOMException && error.name === 'AbortError')) return;
      console.error('Material replay seek failed:', error);
      this.cancelReplay();
      this.replayStatus(`Replay failed: ${error instanceof Error ? error.message : 'Worker failure'}. Last displayed stock is retained; it is not a completed result.`);
    } finally {
      if (generation === this.replayGeneration) {
        this.replayBusy = false;
        this.updateReplayControls();
        if (this.replayPlaying) this.scheduleReplayStep();
      }
    }
  }

  private scheduleReplayStep(): void {
    if (this.replayTimer !== undefined) clearTimeout(this.replayTimer);
    this.replayTimer = setTimeout(() => {
      this.replayTimer = undefined;
      if (this.replayPlaying && !this.replayBusy && this.replayTimeline)
        void this.seekReplay(Math.min(this.replayPosition + 1, this.replayTimeline.occurrences.length), true);
    }, 150);
  }

  private installReplayFrame(frame: ReplayFrame | GpuReplayFrame): void {
    if ('backend' in frame) {
      if (this.materialObject !== frame.stock.group) this.replaceMaterialObject(frame.stock.group);
      this.replayPosition = frame.position;
      this.replayRequestedPosition = frame.requestedPosition;
      this.selectReplayFrame(frame);
      const occurrence = this.replayTimeline?.occurrences[frame.position - 1];
      const stopped = frame.stop ? ` Stopped before unsupported step ${frame.stop.executionStep ?? '?'}: ${frame.stop.message}.` : '';
      const text = `GPU tri-dexel ${frame.phase}: ${frame.pitchMm} mm ray pitch, ${frame.position}/${frame.total}, line ${occurrence?.lineNumber ?? '?'}; ${frame.processedMotions} completed cutting motions; ${frame.cacheHit ? 'cached GPU state' : `${frame.elapsedMs.toFixed(0)} ms compute/readiness`}; ${(frame.estimatedBytes / 1048576).toFixed(1)} MiB estimated CPU/GPU buffers.${stopped} Sampling pitch is not a certified surface tolerance. Magenta pixels indicate a display traversal limit; increase pitch. Feed cutting is assumed; spindle operation is not verified.`;
      this.replayStatus(text);
      const status = this.shadowRoot?.getElementById('material-removal-status');
      if (status) { status.hidden = false; status.textContent = text; }
      this.updateReplayControls();
      return;
    }
    if (frame.replace || !this.materialObject || this.materialObject.name !== 'machined-stock') {
      this.installStockSurface(frame);
    } else {
      const group = this.materialObject;
      let material = this.stockMeshes.values().next().value?.material;
      for (const chunk of frame.chunks) {
        const previous = this.stockMeshes.get(chunk.id);
        if (previous) {
          group.remove(previous);
          previous.geometry.dispose();
          this.stockMeshes.delete(chunk.id);
        }
        if (!chunk.positions.length) continue;
        material ??= new THREE.MeshStandardMaterial({ color: 0xd9c7a6, metalness: 0.25, roughness: 0.8 });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(chunk.normals, 3));
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.stockChunkId = chunk.id;
        group.add(mesh);
        this.stockMeshes.set(chunk.id, mesh);
      }
      if (!this.stockMeshes.size) material?.dispose();
    }
    this.replayPosition = frame.position;
    this.replayRequestedPosition = frame.position;
    this.selectReplayFrame(frame);
    const occurrence = this.replayTimeline?.occurrences[frame.position - 1];
    const prefix = frame.position
      ? `${frame.position}/${frame.total}, step ${frame.executionStep}, line ${occurrence?.lineNumber ?? '?'}`
      : `Initial stock (0/${frame.total})`;
    const stopped = frame.stop ? ` Stopped before unsupported step ${frame.stop.executionStep ?? '?'}: ${frame.stop.message}.` : '';
    const incomplete = this.replayTimeline?.complete ? '' : ' Motion occurrences only: backend command history is unavailable.';
    const history = frame.historyMode === 'partial-disk'
      ? ` Partial history: ${((frame.historyBytes ?? 0) / 1048576).toFixed(1)} MiB disk, ${(frame.historyMs ?? 0).toFixed(0)} ms history encoding/storage/restore; ${frame.appliedMotions} new cutting motions.`
      : ` Checkpoints: ${frame.checkpointCount}, ${(frame.checkpointBytes / 1048576).toFixed(1)} MiB${frame.skippedCheckpoints ? `; ${frame.skippedCheckpoints} skipped for memory` : ''}${frame.evictedCheckpoints ? `; ${frame.evictedCheckpoints} evicted` : ''}.`;
    const missReason = {
      'first-visit': 'first visit',
      'evicted-or-cleared': 'previous surfaces evicted or cleared',
      'not-retained': 'previous visit not retained',
      disabled: 'surface cache disabled',
    };
    const surfaceMode = frame.surfaceCacheHit ? 'Cached exact surfaces'
      : frame.surfaceReconstructed === false ? 'Unchanged surfaces' : 'Surface reconstruction';
    const meshPhases = frame.extractionMs !== undefined && frame.triangulationMs !== undefined && frame.adaptationMs !== undefined
      ? ` [${frame.extractionMs.toFixed(0)}/${frame.triangulationMs.toFixed(0)}/${frame.adaptationMs.toFixed(0)} ms extraction/triangulation/adaptation; ${frame.dirtyChunks ?? 0} dirty, ${frame.remeshedChunks ?? 0} rebuilt chunks; ${frame.fineTriangles ?? 0} fine -> ${frame.outputTriangles ?? 0} output rebuilt triangles]`
      : '';
    const cacheLimit = frame.surfaceCacheLimitBytes === undefined ? ''
      : `/${(frame.surfaceCacheLimitBytes / 1048576).toFixed(1)}`;
    const topology = frame.topologyPasses === undefined ? ''
      : `; ${frame.topologyPasses} topology passes${frame.topologyReused ? ' (reused)' : ''}; ${((frame.topologyCachePeakBytes ?? 0) / 1048576).toFixed(1)} MiB temporary topology`;
    const surfaces = ` ${surfaceMode}${frame.surfaceCacheMissReason ? ` (${missReason[frame.surfaceCacheMissReason]})` : ''}${meshPhases}${topology}; ${((frame.surfaceCacheBytes ?? 0) / 1048576).toFixed(1)}${cacheLimit} MiB shared surface history; ${frame.surfaceCacheStates ?? 0} retained states${frame.surfaceCacheEvictions ? `; ${frame.surfaceCacheEvictions} evicted` : ''}${frame.surfaceCacheClears ? `; ${frame.surfaceCacheClears} cleared` : ''}${frame.surfaceCacheSkipped ? `; ${frame.surfaceCacheSkipped} states not retained for memory` : ''}.`;
    this.replayStatus(`${prefix}. ${frame.processedMotions} cutting motions; ${frame.subtractionMs.toFixed(0)} ms subtraction, ${frame.meshingMs.toFixed(0)} ms meshing${frame.checkpointMs ? `, ${frame.checkpointMs.toFixed(0)} ms checkpoints` : ''}.${history}${surfaces}${frame.historyWarning ? ` ${frame.historyWarning}` : ''}${stopped}${incomplete}`);
    this.updateReplayControls();
  }

  private selectReplayFrame(frame: Pick<ReplayFrame, 'position' | 'executionStep'>): void {
    const occurrence = this.replayTimeline?.occurrences[frame.position - 1];
    if (!occurrence) {
      this.clearSelection();
      const status = this.shadowRoot?.getElementById('plot-status');
      if (status) status.textContent = 'Replay: initial stock';
      return;
    }
    this.selectedExecutionStep = occurrence.executionStep;
    this.selectionLocation = occurrence.lineNumber === undefined ? undefined : {
      channelId: occurrence.channelId, lineNumber: occurrence.lineNumber,
    };
    const control = this.shadowRoot?.querySelector<HTMLSelectElement>('#plot-occurrence');
    if (control) {
      const occurrences = this.replayTimeline!.occurrences.filter((entry) =>
        entry.channelId === occurrence.channelId && entry.lineNumber === occurrence.lineNumber);
      control.replaceChildren(...occurrences.map((entry, index) =>
        new Option(`${index + 1} / ${occurrences.length} (step ${entry.executionStep})`, String(entry.executionStep))));
      control.disabled = false;
      control.value = String(occurrence.executionStep);
    }
    const segment = this.replayTimeline?.segments.get(occurrence.executionStep);
    const run = this.displayedRunId ? this.executedProgramService.getPlotRun(this.displayedRunId) : undefined;
    const source = run?.inputs[0]?.snapshot;
    const tool = source && segment && this.executedProgramService.getRunTool(
      run!.runId, source.identity.programId, occurrence.channelId, segment.toolNumber);
    this.highlightSegment(segment ? structuredClone(segment) : undefined);
    if (segment) this.updateToolMesh(structuredClone(segment), tool);
    else {
      this.selectedSegment = undefined;
      this.selectedTool = undefined;
      this.updateToolMesh();
    }
    const status = this.shadowRoot?.getElementById('plot-status');
    if (status) status.textContent = `Replay step ${occurrence.executionStep}, line ${occurrence.lineNumber ?? '?'}: ${segment ? segment.type : 'non-motion command (no stock removal)'}`;
    this.eventBus.publish(EVENT_NAMES.PLOT_SELECTION_CHANGED, {
      runId: this.displayedRunId, status: 'selected', source: source?.identity,
      location: this.selectionLocation, executionStep: occurrence.executionStep, fraction: 1,
      sourceSegmentIndex: segment?.sourceSegmentIndex, subsegmentIndex: segment?.subsegmentIndex,
      toolNumber: segment?.toolNumber, toolDefinitionAvailable: Boolean(tool),
      machiningMode: segment?.machiningMode ?? 'unknown',
    });
  }

  private render() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          height: 100%;
          background: var(--vscode-editor-background, #282c34);
          position: relative;
        }
        :host([hidden]) {
          display: none;
        }
        #plot-container {
          width: 100%;
          height: 100%;
          position: relative;
        }
        .plot-controls {
          position: absolute;
          top: 8px;
          right: 8px;
          display: flex;
          gap: 4px;
          z-index: 10;
          flex-wrap: wrap;
        }
        .plot-button {
          padding: 4px 8px;
          background: var(--vscode-button-secondaryBackground, #3a3f4b);
          color: var(--vscode-button-secondaryForeground, #abb2bf);
          border: 1px solid var(--vscode-widget-border, #181a1f);
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
        }
        .plot-button:hover {
          background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.05));
        }
        .plot-button.primary {
          background: var(--vscode-button-background, #61afef);
          color: var(--vscode-button-foreground, #1f2329);
          border: 1px solid var(--vscode-button-background, #61afef);
        }
        .plot-button.primary:hover {
          background: var(--vscode-button-hoverBackground, #70b7ff);
        }
        .plot-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .plot-button.active {
          background: var(--vscode-button-background, #61afef);
          color: var(--vscode-button-foreground, #1f2329);
        }
        .view-controls {
          position: absolute;
          top: 8px;
          left: 8px;
          display: flex;
          gap: 4px;
          z-index: 10;
        }
        .axis-controls {
          position: absolute;
          top: 44px;
          left: 8px;
          display: flex;
          gap: 4px;
          z-index: 10;
        }
        #toggle-mobile-menu {
          display: none;
        }
        #plot-menu-content {
          display: contents;
        }
        .zoom-controls {
          position: absolute;
          top: 40px;
          right: 8px;
          display: flex;
          flex-direction: column;
          gap: 4px;
          z-index: 10;
        }
        .zoom-button {
          width: 32px;
          height: 32px;
          padding: 0;
          background: var(--vscode-button-secondaryBackground, #3a3f4b);
          color: var(--vscode-button-secondaryForeground, #abb2bf);
          border: 1px solid var(--vscode-widget-border, #181a1f);
          border-radius: 4px;
          cursor: pointer;
          font-size: 18px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .zoom-button:hover {
          background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.05));
        }
        .plot-info {
          position: absolute;
          bottom: 8px;
          left: 8px;
          color: var(--vscode-editor-foreground, #abb2bf);
          font-size: 12px;
          background: color-mix(in srgb, var(--vscode-editor-background, #282c34) 80%, transparent);
          padding: 4px 8px;
          border-radius: 4px;
          max-width: calc(100% - 16px);
          box-sizing: border-box;
        }
        .simulation-controls {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 4px;
          margin-top: 6px;
        }
        .simulation-controls[hidden] {
          display: none;
        }
        .simulation-controls label {
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        .orbit-hint {
          position: absolute;
          bottom: 8px;
          right: 8px;
          color: var(--vscode-descriptionForeground, #7f848e);
          font-size: 10px;
          background: color-mix(in srgb, var(--vscode-editor-background, #282c34) 80%, transparent);
          padding: 4px 8px;
          border-radius: 4px;
        }

        /* Mobile Styles */
        @media (max-width: 768px) {
          #toggle-mobile-menu {
            display: block;
            position: absolute;
            top: 8px;
            right: 8px;
            z-index: 20;
          }

          #plot-menu-content {
            display: none;
            position: absolute;
            top: 40px;
            right: 8px;
            left: 8px;
            background: color-mix(in srgb, var(--vscode-editorWidget-background, #21252b) 92%, transparent);
            border: 1px solid var(--vscode-widget-border, #181a1f);
            border-radius: 4px;
            padding: 8px;
            z-index: 20;
            flex-direction: column;
            gap: 12px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.5);
          }

          #plot-menu-content.show {
            display: flex;
          }

          .plot-controls, .view-controls, .axis-controls, .zoom-controls {
            position: static;
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            justify-content: center;
            width: 100%;
          }

          .zoom-controls {
            flex-direction: row;
          }

          .plot-button {
            padding: 4px 6px;
            font-size: 11px;
            flex: 1;
            min-height: 32px;
          }

          .zoom-button {
            font-size: 16px;
            flex: 1;
            height: 32px;
            max-width: auto;
          }

          .plot-info {
            bottom: 30px;
            left: 8px;
            right: 8px;
            text-align: center;
            font-size: 11px;
          }

          .orbit-hint {
            display: none; /* Hide orbit hint on mobile to save space */
          }
        }
      </style>
      <div id="plot-container">
        <button class="plot-button" id="toggle-mobile-menu">☰ Plot Options ▼</button>
        <div id="plot-menu-content">
          <div class="plot-controls">
            <button class="plot-button" id="clear-plot">🗑️ Clear Plot</button>
            <button class="plot-button" id="reset-camera">Reset View</button>
            <button class="plot-button" id="toggle-axes">Axes</button>
            <button class="plot-button active" id="toggle-orbit">🔄 Orbit</button>
            <button class="plot-button active" id="toggle-material" aria-pressed="true" hidden>Hide Material</button>
            <button class="plot-button" id="cancel-removal" hidden>Cancel Removal</button>
          </div>
          <div class="view-controls">
            <button class="plot-button" id="view-xy">X-Y</button>
            <button class="plot-button" id="view-xz">X-Z</button>
            <button class="plot-button" id="view-yz">Y-Z</button>
          </div>
          <div class="axis-controls">
            <button class="plot-button" id="rotate-x" title="Rotate around X axis">Rot X</button>
            <button class="plot-button" id="rotate-y" title="Rotate around Y axis">Rot Y</button>
            <button class="plot-button" id="rotate-z" title="Rotate around Z axis">Rot Z</button>
          </div>
          <div class="zoom-controls">
            <button class="zoom-button" id="zoom-in" title="Zoom In">+</button>
            <button class="zoom-button" id="zoom-out" title="Zoom Out">−</button>
            <button class="zoom-button" id="zoom-fit" title="Fit View">⊡</button>
          </div>
        </div>
        <div class="plot-info">
          <div id="plot-status">No plot data</div>
          <div id="material-removal-status" role="status" style="max-height:60px;overflow:auto" hidden></div>
          <label for="plot-occurrence">Occurrence</label>
          <select id="plot-occurrence" disabled style="max-width:100%;width:180px;height:28px"></select>
          <div id="replay-status" role="status" style="max-height:60px;overflow:auto;margin-top:6px" hidden>Cursor following is automatic. Repeated source lines are separate executed occurrences.</div>
          <div id="stock-replay" class="simulation-controls" role="group" aria-label="Stock simulation controls" hidden>
            <label title="Experimental GPU simulation; unsupported operations explicitly fall back to CPU"><input id="gpu-stock" type="checkbox" checked> GPU progressive</label>
            <label>GPU fine pitch (mm) <input id="gpu-fine-resolution" type="number" min="0.001" max="5" step="0.001" value="0.02" style="width:65px"></label>
            <label>CPU resolution (mm) <input id="removal-resolution" type="number" min="0.05" max="5" step="0.05" value="0.05" style="width:65px" disabled></label>
            <button class="plot-button" id="replay-start" disabled title="Return to initial stock">Replay</button>
            <button class="plot-button" id="replay-previous" disabled>Previous</button>
            <button class="plot-button" id="replay-play" aria-pressed="false" disabled>Play</button>
            <button class="plot-button" id="replay-next" disabled>Next</button>
            <button class="plot-button" id="replay-final" disabled title="Seek the retained final stock history">Final Stock</button>
          </div>
        </div>
        <div class="orbit-hint">
          🖱️ Left: Rotate | Middle: Pan | Scroll: Zoom
        </div>
      </div>
    `;
    this.attachControlListeners();
  }

  private attachControlListeners() {
    this.shadowRoot?.getElementById('replay-start')?.addEventListener('click', () => void this.startReplay());
    this.shadowRoot?.getElementById('replay-previous')?.addEventListener('click', () =>
      void this.seekReplay(this.replayRequestedPosition - 1));
    this.shadowRoot?.getElementById('replay-next')?.addEventListener('click', () =>
      void this.seekReplay(this.replayRequestedPosition + 1));
    this.shadowRoot?.getElementById('replay-play')?.addEventListener('click', () => {
      if (this.replayPlaying) this.pauseReplay();
      else {
        this.replayPlaying = true;
        this.updateReplayControls();
        if (!this.replayBusy) {
          if (this.replayPosition === this.replayTimeline?.occurrences.length) void this.seekReplay(0, true);
          else this.scheduleReplayStep();
        }
      }
    });
    this.shadowRoot?.getElementById('replay-final')?.addEventListener('click', () => {
      if (this.replayTimeline) void this.seekReplay(this.replayTimeline.occurrences.length);
    });
    this.shadowRoot?.querySelector<HTMLSelectElement>('#plot-occurrence')?.addEventListener('change', (event) => {
      const control = event.currentTarget as HTMLSelectElement;
      this.selectOccurrence(Number(control.value));
    });
    const clearButton = this.shadowRoot?.getElementById('clear-plot');
    clearButton?.addEventListener('click', () => this.clearPlot());

    const resetButton = this.shadowRoot?.getElementById('reset-camera');
    resetButton?.addEventListener('click', () => this.zoomToFit());

    const axesButton = this.shadowRoot?.getElementById('toggle-axes');
    axesButton?.addEventListener('click', () => this.toggleAxes());

    const materialButton = this.shadowRoot?.getElementById('toggle-material');
    materialButton?.addEventListener('click', () => this.toggleMaterial());
    this.shadowRoot?.getElementById('removal-resolution')?.addEventListener('change', () => void this.changeRemovalResolution());
    for (const id of ['gpu-stock', 'gpu-fine-resolution']) this.shadowRoot?.getElementById(id)?.addEventListener('change', () => {
      const preparation = this.removalPreparation;
      if (preparation && !this.stale) void this.startMaterialRemoval(preparation);
    });
    this.shadowRoot?.getElementById('cancel-removal')?.addEventListener('click', () => {
      const replay = Boolean(this.materialReplay);
      this.cancelMaterialRemoval();
      const status = this.shadowRoot?.getElementById('material-removal-status');
      if (status) status.textContent = replay
        ? 'Replay cancelled. Last displayed stock is retained; it is not the final result.'
        : 'Material removal cancelled. Initial stock is shown, not a completed result.';
    });

    const orbitButton = this.shadowRoot?.getElementById('toggle-orbit');
    orbitButton?.addEventListener('click', () => this.toggleOrbit());

    const zoomInButton = this.shadowRoot?.getElementById('zoom-in');
    zoomInButton?.addEventListener('click', () => this.zoomIn());

    const zoomOutButton = this.shadowRoot?.getElementById('zoom-out');
    zoomOutButton?.addEventListener('click', () => this.zoomOut());

    const zoomFitButton = this.shadowRoot?.getElementById('zoom-fit');
    zoomFitButton?.addEventListener('click', () => this.zoomToFit());

    // View selection buttons
    const viewXYButton = this.shadowRoot?.getElementById('view-xy');
    viewXYButton?.addEventListener('click', () => this.setViewXY());

    const viewXZButton = this.shadowRoot?.getElementById('view-xz');
    viewXZButton?.addEventListener('click', () => this.setViewXZ());

    const viewYZButton = this.shadowRoot?.getElementById('view-yz');
    viewYZButton?.addEventListener('click', () => this.setViewYZ());

    const toggleMobileMenu = this.shadowRoot?.getElementById('toggle-mobile-menu');
    const plotMenuContent = this.shadowRoot?.getElementById('plot-menu-content');
    toggleMobileMenu?.addEventListener('click', () => {
      plotMenuContent?.classList.toggle('show');
      if (plotMenuContent?.classList.contains('show')) {
        toggleMobileMenu.textContent = '☰ Plot Options ▲';
      } else {
        toggleMobileMenu.textContent = '☰ Plot Options ▼';
      }
    });

    const rotateXButton = this.shadowRoot?.getElementById('rotate-x');
    rotateXButton?.addEventListener('click', () => this.rotateAroundAxis('x'));

    const rotateYButton = this.shadowRoot?.getElementById('rotate-y');
    rotateYButton?.addEventListener('click', () => this.rotateAroundAxis('y'));

    const rotateZButton = this.shadowRoot?.getElementById('rotate-z');
    rotateZButton?.addEventListener('click', () => this.rotateAroundAxis('z'));
  }

  private async plotNCCode(targetChannelId?: string) {
    if (this.isPlotting) return;

    const statusElement = this.shadowRoot?.getElementById('plot-status');
    const generation = ++this.requestGeneration;

    try {
      this.isPlotting = true;
      if (statusElement) {
        statusElement.textContent = 'Generating plot...';
      }

      // Get all active channels and their NC code
      const activeChannels = this.stateService.getActiveChannels();
      const state = this.stateService.getState();
      const machineName = state.globalMachine;
      if (!machineName) throw new Error('Select a machine before plotting');

      if (activeChannels.length === 0) {
        throw new Error('No active channels');
      }

      // Filter channels if a specific target was requested
      const channelsToPlot = targetChannelId
        ? activeChannels.filter((c) => c.id === targetChannelId)
        : activeChannels;

      if (channelsToPlot.length === 0 && targetChannelId) {
        // If target channel is not active, maybe we should activate it or just plot it anyway?
        // For now, let's try to find it even if not active
        const channel = this.stateService.getChannel(targetChannelId as ChannelId);
        if (channel) {
          channelsToPlot.push(channel);
        }
      }

      if (channelsToPlot.length === 0) {
        throw new Error('No channels to plot');
      }

      const channelChecks = channelsToPlot.map((channel) => {
        const source = this.readProgramSource(channel.id);
        if (!source) throw new Error(`No source program for channel ${channel.id}`);
        const snapshot = this.programTools.captureProgramSnapshot(
          source.identity, source.revision, source.text, state.activeMachine?.simulationCommentSyntax,
        );
        if (!snapshot.valid) {
          throw new Error(`Channel ${channel.id}: ${snapshot.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`);
        }
        return { channel, source, snapshot };
      });

      const inputs: PlotRunInput[] = channelChecks.map(({ channel, snapshot }) => ({
        snapshot: this.withDefaultTools(channel.id, snapshot),
        machineName,
        machineProfile: state.activeMachine,
        toolValues: this.programTools.getExecutionToolValues(snapshot),
        toolOffsets: this.programTools.getExecutionToolOffsets(
          snapshot,
          state.activeMachine?.toolSelection,
        ),
        customVariables: this.readCustomVariables(channel.id),
      }));
      if (state.toolPathMode === 'simulation' && inputs.length === 1 &&
        this.stockBindingScope(inputs[0]) === this.removalSetupScope) {
        inputs[0].materialSimulation = this.removalSetup;
      }
      // Optional holder/cutting lengths and edge geometry are captured here, never fetched per cursor move.
      // The run event owns rendering; the promise handles busy/failure state only.
      await this.executedProgramService.executePlotRun(
        inputs, targetChannelId !== undefined, state.toolPathMode,
      );
    } catch (error) {
      console.error('Failed to plot NC code:', error);
      if (statusElement && generation === this.requestGeneration) {
        statusElement.textContent = `Error: ${error instanceof Error ? error.message : 'Plot failed'}`;
      }
    } finally {
      if (generation === this.requestGeneration) this.isPlotting = false;
    }
  }

  private withDefaultTools(channelId: ChannelId, snapshot: ProgramToolSnapshot): ProgramToolSnapshot {
    const missing = this.findUndefinedTools(channelId, snapshot);
    if (!missing.length) return snapshot;

    const tools = structuredClone(snapshot.tools) as ProgramToolDefinition[];
    for (const toolNumber of missing) {
      tools.push({
        toolNumber,
        description: 'Default end mill',
        cutting: [{ type: 'endMill', diameter: 10, length: 30 }],
      });
    }
    return { ...snapshot, tools } as ProgramToolSnapshot;
  }

  private readProgramSource(channelId: ChannelId): ProgramSource | undefined {
    const codePane = document.querySelector(
      `nc-channel-pane[data-channel="${channelId}"] nc-code-pane`,
    ) as (HTMLElement & { getProgramSource(): ProgramSource | undefined }) | null;
    if (codePane) return codePane.getProgramSource();
    const program = this.fileManager.getActiveProgram(channelId);
    return program ? {
      identity: { documentId: program.sourceFileId, programId: program.id, channelId },
      revision: program.lastModified,
      text: program.content,
    } : undefined;
  }

  /** Tool calls detected in the code without a managed definition or Q/R value block Plot. */
  private findUndefinedTools(channelId: ChannelId, snapshot: ProgramToolSnapshot): ToolIdentifier[] {
    const detected = this.detectedToolsByChannel.get(channelId);
    if (!detected?.length) return [];
    const definedKeys = new Set<string>([
      ...snapshot.tools.map((tool) => this.toolKey(tool.toolNumber)),
      ...this.programTools.getExecutionToolValues(snapshot).map((value) => this.toolKey(value.toolNumber)),
    ]);
    const missing: ToolIdentifier[] = [];
    const seen = new Set<string>();
    for (const toolNumber of detected) {
      const key = this.toolKey(toolNumber);
      if (definedKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      missing.push(toolNumber);
    }
    return missing;
  }

  private toolKey(id: ToolIdentifier): string {
    return JSON.stringify([typeof id, id]);
  }

  private readCustomVariables(channelId: ChannelId): CustomVariable[] {
    const panel = document.querySelector(
      `nc-channel-pane[data-channel="${channelId}"] nc-bottom-panel`,
    ) as NCBottomPanel | null;
    return structuredClone(panel?.getCustomVariables() ?? []);
  }

  private refreshStaleness(): void {
    const run = this.displayedRunId ? this.executedProgramService.getPlotRun(this.displayedRunId) : undefined;
    if (!run || this.stale) return;
    const state = this.stateService.getState();
    this.stale = run.inputs.some((input) => {
      const snapshot = input.snapshot;
      const source = this.readProgramSource(snapshot.identity.channelId);
      return !source || source.revision !== snapshot.revision || source.text !== snapshot.text ||
        programIdentityKey(source.identity) !== programIdentityKey(snapshot.identity) ||
        state.globalMachine !== input.machineName ||
        JSON.stringify(state.activeMachine) !== JSON.stringify(input.machineProfile) ||
        JSON.stringify(this.programTools.getExecutionToolValues(snapshot)) !== JSON.stringify(input.toolValues) ||
        JSON.stringify(this.programTools.getExecutionToolOffsets(
          snapshot,
          state.activeMachine?.toolSelection,
        )) !== JSON.stringify(input.toolOffsets) ||
        JSON.stringify(this.readCustomVariables(snapshot.identity.channelId)) !== JSON.stringify(input.customVariables);
    });
    if (this.stale) {
      this.cancelMaterialRemoval();
      this.clearSelection();
      if (this.highlightObject) {
        this.removeOwnedPlotObject(this.highlightObject);
        this.highlightObject = null;
      }
      const status = this.shadowRoot?.getElementById('plot-status');
      if (status) status.textContent = 'Plot is stale — input changed. Plot again to follow the editor.';
    }
  }

  private async initThree(): Promise<void> {
    const container = this.shadowRoot?.getElementById('plot-container');
    if (!container) return;

    // Scene setup
    this.scene = new THREE.Scene();
    this.applyThemeToScene();

    // Camera setup
    const aspect = container.clientWidth / container.clientHeight || 1;
    this.camera = new THREE.PerspectiveCamera(75, aspect, 0.1, 10000);
    this.camera.position.set(50, 50, 50);
    this.camera.lookAt(0, 0, 0);

    if (navigator.gpu) {
      try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) throw new Error('No WebGPU adapter');
        const device = await adapter.requestDevice();
        const renderer = new WebGPURenderer({ antialias: true, device });
        try { await renderer.init(); }
        catch (error) { await renderer.dispose(); device.destroy(); throw error; }
        if (!this.isConnected) { await renderer.dispose(); device.destroy(); return; }
        this.gpuDevice = device;
        this.renderer = renderer;
        device.addEventListener('uncapturederror', (event) => {
          console.error('WebGPU device error:', event.error.message);
          this.replayStatus(`WebGPU error: ${event.error.message}. Switch to CPU simulation or reload the view.`);
        });
        void device.lost.then((info) => {
          if (info.reason === 'destroyed' || this.gpuDevice !== device || !this.isConnected) return;
          console.error('WebGPU device lost:', info.message);
          this.gpuComputeError = `WebGPU device lost: ${info.message || info.reason}`;
          this.cancelMaterialRemoval();
          const gpuControl = this.shadowRoot?.querySelector<HTMLInputElement>('#gpu-stock');
          if (gpuControl) gpuControl.disabled = true;
          this.replayStatus(`WebGPU device lost: ${info.message}. Reload the view to restore rendering.`);
        });
      } catch (error) {
        console.warn('WebGPU renderer unavailable; using WebGL and CPU simulation:', error);
        this.gpuFallbackReason = error instanceof Error ? error.message : 'WebGPU initialization failed';
      }
    }
    if (!this.renderer) {
      try { this.renderer = new THREE.WebGLRenderer({ antialias: true }); }
      catch (error) {
        console.error('Failed to create a WebGL renderer:', error);
        this.showWebglUnavailable(container);
        return;
      }
    }
    this.renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    // OrbitControls setup for rotation/pan/zoom
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.1;
    this.controls.maxDistance = 5000;
    this.controls.target.set(50, 25, 0);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.4);
    directionalLight.position.set(10, 10, 10);
    this.scene.add(directionalLight);

    // Add machine coordinate system
    const machineGeometry = this.plotService.createMachineGeometry();
    this.scene.add(machineGeometry);

    // Resize observer
    this.resizeObserver = new ResizeObserver(() => {
      this.onResize();
    });
    this.resizeObserver.observe(container);

    this.setupThemeObserver();

    if (this.renderer instanceof WebGPURenderer && this.gpuDevice) {
      const warmup = new GpuDexelStock(this.renderer, this.gpuDevice, new THREE.Vector3(1, 1, 1), 0.1, false, [], new THREE.Matrix4());
      this.gpuWarmupStock = warmup;
      try {
        await warmup.calculate(0);
        const scene = new THREE.Scene();
        scene.add(warmup.group);
        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
        camera.position.set(0, 0, 3);
        await this.renderer.compileAsync(scene, camera);
        scene.remove(warmup.group);
      } catch (error) {
        console.error('GPU stock shader preparation failed:', error);
        this.gpuComputeError = error instanceof Error ? error.message : 'GPU shader preparation failed';
        warmup.dispose();
        this.gpuWarmupStock = undefined;
      }
      if (!this.isConnected) return;
    }

    // Start animation loop
    this.animateScene();
  }

  /** Leaves Plot status/controls usable; only the 3D view is unavailable. */
  private showWebglUnavailable(container: HTMLElement): void {
    const notice = document.createElement('div');
    notice.style.cssText =
      'display:flex; align-items:center; justify-content:center; height:100%; padding:16px; ' +
      'text-align:center; color:var(--vscode-descriptionForeground,#7f848e); font-size:12px;';
    notice.textContent =
      '3D view unavailable: this browser/environment could not create a WebGL context.';
    container.appendChild(notice);
    const statusElement = this.shadowRoot?.getElementById('plot-status');
    if (statusElement) statusElement.textContent = '3D view unavailable (no WebGL context)';
  }

  private setupThemeObserver() {
    if (this.themeObserver) {
      this.themeObserver.disconnect();
    }

    const observerTargetAttributes = ['style', 'class', 'data-theme-mode', 'data-themeMode'];
    this.themeObserver = new MutationObserver(() => {
      this.applyThemeToScene();
    });

    const body = document.body;
    const root = document.documentElement;

    if (body) {
      this.themeObserver.observe(body, { attributes: true, attributeFilter: observerTargetAttributes });
    }

    if (root) {
      this.themeObserver.observe(root, { attributes: true, attributeFilter: observerTargetAttributes });
    }
  }

  private applyThemeToScene() {
    if (!this.scene) return;

    const backgroundColor = this.resolveThemeColor('--vscode-editor-background', '#282c34');
    this.scene.background = new THREE.Color(backgroundColor);

    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  private resolveThemeColor(cssVariable: string, fallback: string): string {
    const rootStyles = getComputedStyle(document.documentElement);
    const bodyStyles = getComputedStyle(document.body);
    const value = rootStyles.getPropertyValue(cssVariable).trim() || bodyStyles.getPropertyValue(cssVariable).trim();
    return value || fallback;
  }

  private animateScene() {
    this.animationFrameId = requestAnimationFrame(() => this.animateScene());

    // Update orbit controls
    if (this.controls) {
      this.controls.update();
    }

    if (this.scene && this.camera && this.renderer) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  private onResize() {
    const container = this.shadowRoot?.getElementById('plot-container');
    if (!container || !this.camera || !this.renderer) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    if (width === 0 || height === 0) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(Math.max(1, width), Math.max(1, height));
  }

  private updatePlot(
    plotMetadata: PlotMetadata,
    materials: readonly DeepReadonly<ProgramMaterialDefinition>[] = [],
  ) {
    if (!this.scene) return;

    // Clear existing plot-owned objects (keep axes).
    const toRemove: THREE.Object3D[] = [];
    this.scene.children.forEach((child) => {
      if (child.userData.isToolpath || child.userData.isMaterial) {
        toRemove.push(child);
      }
    });
    toRemove.forEach((obj) => this.removeOwnedPlotObject(obj));
    this.materialObject = null;
    this.materialVisible = true;
    this.stockMeshes.clear();

    // Remove highlight object if exists
    if (this.highlightObject) {
      this.removeOwnedPlotObject(this.highlightObject);
      this.highlightObject = null;
    }

    // Add new plot
    const plotGroup = this.plotService.createSegmentedToolpath(plotMetadata);
    plotGroup.userData.isToolpath = true;
    this.scene.add(plotGroup);

    if (this.simulationEnabled && materials.length) {
      const materialGroup = new THREE.Group();
      materialGroup.name = 'simulation-materials';
      materialGroup.userData.isMaterial = true;
      materials.forEach((material) => {
        const mesh = this.toolGeometryFactory.createMaterialMesh(material);
        if (mesh) materialGroup.add(mesh);
      });
      if (materialGroup.children.length) {
        this.materialObject = materialGroup;
        this.scene.add(materialGroup);
      }
    }
    this.updateMaterialControl();

    // Update status
    const statusElement = this.shadowRoot?.getElementById('plot-status');
    if (statusElement) {
      statusElement.textContent = `Points: ${plotMetadata.points.length}, Segments: ${plotMetadata.segments.length}`;
    }

    // Auto-fit camera to the new plot
    this.zoomToFit();
  }

  private highlightSegment(selectedSegment?: PlotSegment) {

    // Remove previous highlight
    if (this.highlightObject) {
      this.removeOwnedPlotObject(this.highlightObject);
      this.highlightObject = null;
    }

    if (!this.scene || !selectedSegment) return;
    const vertices = [
      selectedSegment.startPoint.x,
      selectedSegment.startPoint.y,
      selectedSegment.startPoint.z,
      selectedSegment.endPoint.x,
      selectedSegment.endPoint.y,
      selectedSegment.endPoint.z,
    ];

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

    // Create a bright material for highlighting (e.g., yellow)
    // We use LineSegments because we might have multiple disconnected segments
    const material = new THREE.LineBasicMaterial({
      color: 0xffff00, // Yellow
      depthTest: false, // Make it visible on top of other lines
      linewidth: 3, // Note: might not work in all browsers
    });

    this.highlightObject = new THREE.LineSegments(geometry, material);
    // Ensure it renders on top
    this.highlightObject.renderOrder = 999;

    this.scene.add(this.highlightObject);

    // Force a re-render if not animating
    if (!this.animationFrameId && this.renderer && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  private updateToolMesh(segment?: PlotSegment, tool?: ReturnType<ExecutedProgramService['getRunTool']>): void {
    if (segment !== undefined) {
      this.selectedSegment = segment;
      this.selectedTool = tool;
    }
    if (this.toolObject) {
      this.removeOwnedPlotObject(this.toolObject);
      this.toolObject = null;
    }
    if (!this.simulationEnabled) return;
    segment = segment ?? this.selectedSegment;
    tool = tool ?? this.selectedTool;
    if (!this.scene || !segment || !tool || !segment.poses?.length) return;

    const poseIndex = Math.min((segment.subsegmentIndex ?? 0) + 1, segment.poses.length - 1);
    const pose = segment.poses[poseIndex];
    const executedQ = segment.motionContext?.toolOffset?.tipOrientation;
    const mesh = this.toolGeometryFactory.create(executedQ === undefined ? tool : { ...tool, Q: executedQ });
    if (!mesh) return;

    mesh.position.fromArray(pose.position);
    mesh.quaternion.fromArray(pose.orientation);
    mesh.userData.isToolMesh = true;
    mesh.renderOrder = 1000;
    this.toolObject = mesh;
    this.scene.add(mesh);
  }

  private resetCamera() {
    if (!this.camera || !this.controls) return;
    this.camera.position.set(50, 50, 50);
    this.controls.target.set(50, 25, 0);
    this.controls.update();
  }

  private getSceneCenter(): THREE.Vector3 | null {
    if (!this.scene) return null;
    const box = new THREE.Box3();
    let hasContent = false;
    this.scene.children.forEach((child) => {
      if (child.userData.isToolpath || (child.userData.isMaterial && child.visible)) {
        box.expandByObject(child);
        hasContent = true;
      }
    });
    if (!hasContent || box.isEmpty()) return null;
    const center = new THREE.Vector3();
    box.getCenter(center);
    return center;
  }

  // View from top (X-Y plane, looking down Z axis)
  private setViewXY() {
    if (!this.camera || !this.controls) return;
    const center = this.getSceneCenter();
    if (center) this.controls.target.copy(center);
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.camera.position.set(
      this.controls.target.x,
      this.controls.target.y,
      this.controls.target.z + distance,
    );
    this.camera.up.set(0, 1, 0);
    this.controls.update();
  }

  // View from front (X-Z plane, looking along Y axis)
  private setViewXZ() {
    if (!this.camera || !this.controls) return;
    const center = this.getSceneCenter();
    if (center) this.controls.target.copy(center);
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.camera.position.set(
      this.controls.target.x,
      this.controls.target.y - distance,
      this.controls.target.z,
    );
    this.camera.up.set(0, 0, 1);
    this.controls.update();
  }

  // View from side (Y-Z plane, looking along X axis)
  private setViewYZ() {
    if (!this.camera || !this.controls) return;
    const center = this.getSceneCenter();
    if (center) this.controls.target.copy(center);
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.camera.position.set(
      this.controls.target.x + distance,
      this.controls.target.y,
      this.controls.target.z,
    );
    this.camera.up.set(0, 0, 1);
    this.controls.update();
  }

  private rotateAroundAxis(axis: 'x' | 'y' | 'z') {
    if (!this.camera || !this.controls) return;

    const rotationAxis =
      axis === 'x'
        ? new THREE.Vector3(1, 0, 0)
        : axis === 'y'
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(0, 0, 1);

    const offset = this.camera.position.clone().sub(this.controls.target);
    const up = this.camera.up.clone();
    const rotationAngle = Math.PI / 12;

    offset.applyAxisAngle(rotationAxis, rotationAngle);
    up.applyAxisAngle(rotationAxis, rotationAngle);

    this.camera.position.copy(this.controls.target).add(offset);
    this.camera.up.copy(up.normalize());
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  private toggleAxes() {
    if (!this.scene) return;
    // Toggle visibility of axes
    this.scene.children.forEach((child) => {
      if (child instanceof THREE.Group && !child.userData.isToolpath && !child.userData.isMaterial) {
        child.visible = !child.visible;
      }
    });
  }

  private toggleMaterial() {
    if (!this.materialObject) return;
    this.materialVisible = !this.materialVisible;
    this.materialObject.visible = this.materialVisible;
    this.updateMaterialControl();
  }

  private updateMaterialControl() {
    const button = this.shadowRoot?.querySelector<HTMLButtonElement>('#toggle-material');
    if (!button) return;
    const available = this.simulationEnabled && this.materialObject !== null;
    button.hidden = !available;
    button.disabled = !available;
    button.textContent = this.materialVisible ? 'Hide Material' : 'Show Material';
    button.classList.toggle('active', this.materialVisible);
    button.setAttribute('aria-pressed', String(this.materialVisible));
  }

  private toggleOrbit() {
    if (!this.controls) return;
    this.controls.enabled = !this.controls.enabled;

    const orbitButton = this.shadowRoot?.getElementById('toggle-orbit');
    if (orbitButton) {
      orbitButton.classList.toggle('active', this.controls.enabled);
    }
  }

  private clearPlot() {
    this.cancelMaterialRemoval();
    this.clearSelection();
    this.requestGeneration++;
    this.isPlotting = false;
    this.executedProgramService.cancelPendingPlot();
    if (this.displayedRunId) this.executedProgramService.discardPlotRun(this.displayedRunId);
    this.displayedRunId = undefined;
    this.removalPreparation = undefined;
    this.resolveSelection = undefined;
    this.stale = false;
    this.simulationEnabled = false;
    this.updateMaterialRemovalStatus();
    this.updateRemovalResolution();
    this.updateReplayControls();
    this.materialVisible = true;
    this.updateMaterialControl();
    if (!this.scene) return;

    // Remove highlight object if exists
    if (this.highlightObject) {
      this.removeOwnedPlotObject(this.highlightObject);
      this.highlightObject = null;
    }

    // Clear all toolpath objects from the scene
    const toRemove: THREE.Object3D[] = [];
    this.scene.children.forEach((child) => {
      if (child.userData.isToolpath || child.userData.isMaterial) {
        toRemove.push(child);
      }
    });
    toRemove.forEach((obj) => this.removeOwnedPlotObject(obj));
    this.materialObject = null;
    this.stockMeshes.clear();

    // Update status
    const statusElement = this.shadowRoot?.getElementById('plot-status');
    if (statusElement) {
      statusElement.textContent = 'No plot data';
    }

    // Notify other components (e.g., NCCodePane) that the plot was cleared
    this.eventBus.publish(EVENT_NAMES.PLOT_CLEARED, undefined);
  }

  /** Segmented paths and highlights own their resources; never dispose shared axes/cache here. */
  private removeOwnedPlotObject(object: THREE.Object3D): void {
    this.scene?.remove(object);
    const releaseGpuStock: unknown = object.userData.releaseGpuStock;
    if (typeof releaseGpuStock === 'function') { releaseGpuStock(); return; }
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    object.traverse((child) => {
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
        geometries.add(child.geometry);
        const owned = Array.isArray(child.material) ? child.material : [child.material];
        owned.forEach((material) => materials.add(material));
      }
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
  }

  private zoomIn() {
    if (!this.camera || !this.controls) return;
    // Move camera closer to target
    const direction = new THREE.Vector3();
    direction.subVectors(this.camera.position, this.controls.target);
    direction.multiplyScalar(0.8); // Zoom in by 20%
    this.camera.position.copy(this.controls.target).add(direction);
    this.controls.update();
  }

  private zoomOut() {
    if (!this.camera || !this.controls) return;
    // Move camera further from target
    const direction = new THREE.Vector3();
    direction.subVectors(this.camera.position, this.controls.target);
    direction.multiplyScalar(1.25); // Zoom out by 25%
    this.camera.position.copy(this.controls.target).add(direction);
    this.controls.update();
  }

  private zoomToFit() {
    if (!this.scene || !this.camera || !this.controls) return;

    // Calculate bounding box of all toolpath objects
    const box = new THREE.Box3();
    let hasToolpath = false;

    this.scene.children.forEach((child) => {
      if (child.userData.isToolpath || (child.userData.isMaterial && child.visible)) {
        box.expandByObject(child);
        hasToolpath = true;
      }
    });

    // If no toolpath, use the axes
    if (!hasToolpath) {
      this.scene.children.forEach((child) => {
        if (child instanceof THREE.Group) {
          box.expandByObject(child);
        }
      });
    }

    // Check if bounding box is valid (not empty/infinite)
    if (box.isEmpty()) {
      // Reset to default view if nothing to fit
      this.resetCamera();
      return;
    }

    // Get the center and size of the bounding box
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);

    // Calculate the distance to fit the object
    const maxDim = Math.max(size.x, size.y, size.z);

    // Handle edge case where maxDim is 0 or very small
    if (maxDim < 0.001) {
      this.resetCamera();
      return;
    }

    // Validate FOV is within valid range (not 0 or 180 degrees)
    const fov = this.camera.fov * (Math.PI / 180);
    if (fov <= 0 || fov >= Math.PI) {
      this.resetCamera();
      return;
    }

    let cameraDistance = maxDim / (2 * Math.tan(fov / 2));
    cameraDistance *= 1.5; // Add some padding

    // Ensure camera distance is within valid range
    cameraDistance = Math.max(
      this.controls.minDistance,
      Math.min(cameraDistance, this.controls.maxDistance),
    );

    // Position camera
    const direction = new THREE.Vector3(1, 1, 1).normalize();
    this.camera.position.copy(center).add(direction.multiplyScalar(cameraDistance));
    this.controls.target.copy(center);
    this.controls.update();
  }

  private updateVisibility() {
    if (this.isVisible) {
      this.removeAttribute('hidden');
    } else {
      this.setAttribute('hidden', '');
    }
  }
}

customElements.define('nc-toolpath-plot', NCToolpathPlot);
