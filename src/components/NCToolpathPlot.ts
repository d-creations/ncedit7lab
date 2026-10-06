import * as THREE from 'three';
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
import { MaterialSimulationSession } from '@services/simulation/MaterialSimulationSession';
import type { StockBinding, SimulationResult } from '@services/simulation/SimulationTypes';
import { rotationQuaternion } from '@services/simulation/SimulationTransforms';

export class NCToolpathPlot extends HTMLElement {
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private renderer?: THREE.WebGLRenderer;
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
  private materialSimulation?: MaterialSimulationSession;
  private removalSetup?: { binding: StockBinding; resolutionMm: number };
  private removalSetupScope?: string;
  private removalGeneration = 0;

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
    this.initThree();
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
    if (this.renderer) {
      this.renderer.dispose();
    }
  }

  private setupEventListeners() {
    // One render per completed run; per-channel events remain for errors/variables only.
    this.subscriptions.push(this.eventBus.subscribe(EVENT_NAMES.PLOT_RUN_COMPLETED, (data: { runId: string }) => {
      const run = this.executedProgramService.getPlotRun(data.runId);
      if (!run || data.runId === this.displayedRunId) return;
      this.cancelMaterialRemoval();
      this.displayedRunId = run.runId;
      this.simulationEnabled = run.toolPathMode === 'simulation';
      this.clearSelection();
      this.resolveSelection = createPlotSelectionResolver(run);
      this.stale = false;
      const materials = run.materialRemoval?.stock ? [run.materialRemoval.stock] : [];
      this.updatePlot(structuredClone(run.plotMetadata) as PlotMetadata, materials);
      this.updateMaterialRemovalStatus();
      this.updateRemovalSetup();
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
      this.selectOccurrence(sameLocation ? this.selectedExecutionStep : undefined);
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

  private updateRemovalSetup(): void {
    const details = this.shadowRoot?.querySelector<HTMLElement>('#removal-setup');
    const select = this.shadowRoot?.querySelector<HTMLSelectElement>('#removal-frame');
    const run = this.displayedRunId ? this.executedProgramService.getPlotRun(this.displayedRunId) : undefined;
    if (!details || !select) return;
    details.hidden = !this.simulationEnabled || !run?.materialRemoval?.stock;
    select.replaceChildren(new Option('Select stock workpiece frame', ''));
    const frames = new Set(run?.plotMetadata.segments.flatMap((segment) =>
      segment.poses?.map((pose) => pose.frameId) ?? []) ?? []);
    for (const frame of frames) select.add(new Option(frame, frame));
    select.value = this.removalSetup?.binding.frameId ??
      (frames.has('workpiece:tableBC') ? 'workpiece:tableBC' : '');
  }

  private readRemovalSetup(): { binding: StockBinding; resolutionMm: number } {
    const value = (id: string): number => {
      const input = this.shadowRoot?.querySelector<HTMLInputElement>(`#removal-${id}`);
      if (!input?.value.trim() || !Number.isFinite(Number(input.value))) {
        throw new Error(`Removal ${id} must be a finite number`);
      }
      return Number(input.value);
    };
    const vector = (prefix: string): [number, number, number] =>
      [value(`${prefix}-x`), value(`${prefix}-y`), value(`${prefix}-z`)];
    const axis = this.shadowRoot?.querySelector<HTMLSelectElement>('#removal-spindle-axis')?.value;
    if (axis !== 'x' && axis !== 'y' && axis !== 'z') throw new Error('Select a spindle axis');
    return {
      binding: {
        frameId: this.shadowRoot?.querySelector<HTMLSelectElement>('#removal-frame')?.value ?? '',
        position: vector('position'), rotation: vector('rotation'), spindleOrigin: vector('spindle'),
        spindleAxis: [axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0],
      },
      resolutionMm: value('resolution'),
    };
  }

  private async runRemovalFromSetup(): Promise<void> {
    const status = this.shadowRoot?.getElementById('material-removal-status');
    try {
      this.refreshStaleness();
      const run = this.displayedRunId ? this.executedProgramService.getPlotRun(this.displayedRunId) : undefined;
      if (!run || this.stale) throw new Error('Plot the current program before material removal');
      const setup = this.readRemovalSetup();
      const preparation = prepareMaterialRemoval(run.inputs, run.plotMetadata, setup);
      if (preparation.status !== 'ready') {
        throw new Error(preparation.diagnostics.map((diagnostic) => diagnostic.message).join(' '));
      }
      this.removalSetup = setup;
      this.removalSetupScope = this.stockBindingScope(run.inputs[0]);
      await this.startMaterialRemoval(preparation);
    } catch (error) {
      console.error('Material removal setup failed:', error);
      if (status) {
        status.hidden = false;
        status.textContent = `Material removal unavailable: ${error instanceof Error ? error.message : 'Invalid setup'}`;
      }
    }
  }

  private createMaterialSimulationSession(runId: string): MaterialSimulationSession {
    return new MaterialSimulationSession(runId);
  }

  private async startMaterialRemoval(preparation: DeepReadonly<MaterialRemovalPreparation>): Promise<void> {
    if (!preparation.simulation || !this.displayedRunId || !this.scene) return;
    this.cancelMaterialRemoval();
    const generation = this.removalGeneration;
    const session = this.createMaterialSimulationSession(this.displayedRunId);
    this.materialSimulation = session;
    const status = this.shadowRoot?.getElementById('material-removal-status');
    const cancel = this.shadowRoot?.querySelector<HTMLButtonElement>('#cancel-removal');
    if (cancel) cancel.hidden = false;
    const raw = this.toolGeometryFactory.createMaterialMesh(preparation.simulation.stock);
    if (raw) {
      raw.matrixAutoUpdate = false;
      raw.matrix.compose(
        new THREE.Vector3(...preparation.simulation.binding.position),
        rotationQuaternion(preparation.simulation.binding.rotation), new THREE.Vector3(1, 1, 1),
      );
      this.replaceMaterialObject(raw);
    }
    try {
      const result = await session.start(preparation.simulation, (processed, total) => {
        if (generation !== this.removalGeneration || !status) return;
        status.hidden = false;
        status.textContent = `Geometric removal: ${processed}/${total} motions. Feed cutting is assumed; spindle operation is not verified.`;
      });
      if (generation !== this.removalGeneration || this.stale || session.runId !== this.displayedRunId) return;
      this.installStockSurface(result);
      if (status) {
        status.hidden = false;
        const stopped = result.stop
          ? `Stopped before step ${result.stop.executionStep ?? '?'}${result.stop.lineNumber === undefined ? '' : `, line ${result.stop.lineNumber}`}: ${result.stop.message}.`
          : 'Completed.';
        status.textContent = `Geometric removal: ${stopped} ${result.processedMotions} motions; ${result.resolutionMm} mm boundary spacing; ${result.boundaryCells} refined boundary cells; ${result.removedCells} cell-centre samples removed; ${(result.peakStockBytes / 1048576).toFixed(1)} MiB peak estimated stock, ${(result.surfaceBytes / 1048576).toFixed(1)} MiB surface; ${result.elapsedMs.toFixed(0)} ms. Feed cutting is assumed; spindle operation is not verified.`;
      }
    } catch (error) {
      if (generation !== this.removalGeneration) return;
      console.error('Material removal failed:', error);
      if (status) {
        status.hidden = false;
        status.textContent = `Material removal failed: ${error instanceof Error ? error.message : 'Worker failure'}. Initial stock is shown, not a completed result.`;
      }
    } finally {
      if (generation === this.removalGeneration && cancel) cancel.hidden = true;
    }
  }

  private replaceMaterialObject(group: THREE.Group): void {
    if (!this.scene) return;
    if (this.materialObject) this.removeOwnedPlotObject(this.materialObject);
    group.userData.isMaterial = true;
    group.visible = this.materialVisible;
    this.materialObject = group;
    this.scene.add(group);
    this.updateMaterialControl();
  }

  private installStockSurface(result: SimulationResult): void {
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
      group.add(new THREE.Mesh(geometry, material));
    }
    this.replaceMaterialObject(group);
  }

  private cancelMaterialRemoval(): void {
    this.removalGeneration++;
    this.materialSimulation?.cancel();
    this.materialSimulation = undefined;
    const cancel = this.shadowRoot?.querySelector<HTMLButtonElement>('#cancel-removal');
    if (cancel) cancel.hidden = true;
  }

  private stockBindingScope(input: DeepReadonly<PlotRunInput>): string {
    return JSON.stringify([programIdentityKey(input.snapshot.identity), input.machineName, input.machineProfile?.profileRevision]);
  }

  private selectOccurrence(step?: number): void {
    this.refreshStaleness();
    if (this.stale || !this.selectionLocation || !this.displayedRunId) {
      this.clearSelection();
      return;
    }
    const location = this.selectionLocation;
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
          <details id="removal-setup" hidden style="max-height:260px;overflow:auto;background:var(--vscode-editor-background,#282c34);padding:8px">
            <summary>Removal setup (geometric preview)</summary>
            <label>Workpiece frame <select id="removal-frame"><option value="">Select stock workpiece frame</option></select></label>
            <p>Map the initial program stock into this frame. Feed cutting is assumed; no spindle verification.</p>
            ${['position', 'rotation', 'spindle'].map((prefix) => `
              <div>${prefix === 'position' ? 'Program-to-workpiece translation (mm)' : prefix === 'rotation' ? 'Program-to-workpiece rotation (degrees, X/Y/Z)' : 'Spindle origin in workpiece frame (mm)'}</div>
              <div style="display:flex;gap:4px">${['x', 'y', 'z'].map((axis) => `
                <label>${axis.toUpperCase()} <input id="removal-${prefix}-${axis}" type="number" value="0" step="any" style="width:65px"></label>
              `).join('')}</div>
            `).join('')}
            <label>Turning spindle axis <select id="removal-spindle-axis"><option value="z">+Z</option><option value="x">+X</option><option value="y">+Y</option></select></label>
            <label>Boundary spacing (mm) <input id="removal-resolution" type="number" min="0.05" max="5" step="0.05" value="0.5" style="width:65px"></label>
            <button class="plot-button" id="run-removal">Bind stock and run removal</button>
          </details>
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
        </div>
        <div class="orbit-hint">
          🖱️ Left: Rotate | Middle: Pan | Scroll: Zoom
        </div>
      </div>
    `;
    this.attachControlListeners();
  }

  private attachControlListeners() {
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
    this.shadowRoot?.getElementById('run-removal')?.addEventListener('click', () => void this.runRemovalFromSetup());
    this.shadowRoot?.getElementById('cancel-removal')?.addEventListener('click', () => {
      this.cancelMaterialRemoval();
      const status = this.shadowRoot?.getElementById('material-removal-status');
      if (status) status.textContent = 'Material removal cancelled. Initial stock is shown, not a completed result.';
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

  private initThree() {
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

    // Renderer setup — WebGL is unavailable in some browsers/sandboxes/headless hosts.
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (error) {
      console.error('Failed to create a WebGL renderer:', error);
      this.showWebglUnavailable(container);
      return;
    }
    this.renderer.setSize(container.clientWidth, container.clientHeight);
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
    this.renderer.setSize(width, height);
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
    this.resolveSelection = undefined;
    this.stale = false;
    this.simulationEnabled = false;
    this.updateMaterialRemovalStatus();
    this.updateRemovalSetup();
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
