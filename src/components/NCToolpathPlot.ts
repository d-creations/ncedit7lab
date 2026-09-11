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
import type { PlotMetadata, CustomVariable, ChannelId } from '@core/types';
import type { ProgramToolService, ProgramSource } from '@services/tools/ProgramToolService';
import { programIdentityKey } from '@services/tools/ProgramToolService';
import type { IFileManagerService } from '@services/IFileManagerService';
import type { PlotRunInput } from '@services/tools/PlotRunSnapshot';
import type { NCBottomPanel } from './NCBottomPanel';

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
  private currentPlotMetadata: PlotMetadata | null = null;
  private highlightObject: THREE.Object3D | null = null;
  private themeObserver?: MutationObserver;
  private programTools: ProgramToolService;
  private fileManager: IFileManagerService;
  private subscriptions: EventSubscription[] = [];
  private displayedRunId?: string;
  private requestGeneration = 0;
  private stale = false;

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
      this.displayedRunId = run.runId;
      this.stale = false;
      this.updatePlot(structuredClone(run.plotMetadata) as PlotMetadata);
      this.refreshStaleness();
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

    // Listen for cursor movement to highlight segments
    this.subscriptions.push(this.eventBus.subscribe(EVENT_NAMES.EDITOR_CURSOR_MOVED, (data: unknown) => {
      const cursorData = data as { channelId: string; lineNumber: number; source?: ProgramSource };
      this.refreshStaleness();
      if (this.stale || !cursorData.source) return;
      const run = this.displayedRunId ? this.executedProgramService.getPlotRun(this.displayedRunId) : undefined;
      const snapshot = run?.inputs.find((input) => input.snapshot.identity.channelId === cursorData.channelId)?.snapshot;
      if (!snapshot || snapshot.revision !== cursorData.source.revision ||
        programIdentityKey(snapshot.identity) !== programIdentityKey(cursorData.source.identity)) return;
      this.highlightSegment(cursorData.channelId, cursorData.lineNumber);
    }));
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
        </div>
        <div class="orbit-hint">
          🖱️ Left: Rotate | Middle: Pan | Scroll: Zoom
        </div>
      </div>
    `;
    this.attachControlListeners();
  }

  private attachControlListeners() {
    const clearButton = this.shadowRoot?.getElementById('clear-plot');
    clearButton?.addEventListener('click', () => this.clearPlot());

    const resetButton = this.shadowRoot?.getElementById('reset-camera');
    resetButton?.addEventListener('click', () => this.zoomToFit());

    const axesButton = this.shadowRoot?.getElementById('toggle-axes');
    axesButton?.addEventListener('click', () => this.toggleAxes());

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

      const inputs: PlotRunInput[] = channelsToPlot.map((channel) => {
        const source = this.readProgramSource(channel.id);
        if (!source) throw new Error(`No source program for channel ${channel.id}`);
        const snapshot = this.programTools.captureProgramSnapshot(
          source.identity, source.revision, source.text, state.activeMachine?.simulationCommentSyntax,
        );
        if (!snapshot.valid) {
          throw new Error(`Channel ${channel.id}: ${snapshot.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`);
        }
        return {
          snapshot,
          machineName,
          machineProfile: state.activeMachine,
          toolValues: this.programTools.getExecutionToolValues(snapshot),
          toolOffsets: this.programTools.getExecutionToolOffsets(
            snapshot,
            state.activeMachine?.toolSelection,
          ),
          customVariables: this.readCustomVariables(channel.id),
        };
      });
      // Optional holder/cutting lengths and edge geometry are captured here, never fetched per cursor move.
      // The run event owns rendering; the promise handles busy/failure state only.
      await this.executedProgramService.executePlotRun(inputs, targetChannelId !== undefined);
    } catch (error) {
      console.error('Failed to plot NC code:', error);
      if (statusElement && generation === this.requestGeneration) {
        statusElement.textContent = `Error: ${error instanceof Error ? error.message : 'Plot failed'}`;
      }
    } finally {
      if (generation === this.requestGeneration) this.isPlotting = false;
    }
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

    // Renderer setup
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
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

  private updatePlot(plotMetadata: PlotMetadata) {
    if (!this.scene) return;

    this.currentPlotMetadata = plotMetadata;

    // Clear existing plot lines (keep axes)
    const toRemove: THREE.Object3D[] = [];
    this.scene.children.forEach((child) => {
      if (child.userData.isToolpath) {
        toRemove.push(child);
      }
    });
    toRemove.forEach((obj) => this.removeOwnedPlotObject(obj));

    // Remove highlight object if exists
    if (this.highlightObject) {
      this.removeOwnedPlotObject(this.highlightObject);
      this.highlightObject = null;
    }

    // Add new plot
    const plotGroup = this.plotService.createSegmentedToolpath(plotMetadata);
    plotGroup.userData.isToolpath = true;
    this.scene.add(plotGroup);

    // Update status
    const statusElement = this.shadowRoot?.getElementById('plot-status');
    if (statusElement) {
      statusElement.textContent = `Points: ${plotMetadata.points.length}, Segments: ${plotMetadata.segments.length}`;
    }

    // Auto-fit camera to the new plot
    this.zoomToFit();
  }

  private highlightSegment(channelId: string, lineNumber: number) {
    if (!this.scene || !this.currentPlotMetadata) return;

    // Remove previous highlight
    if (this.highlightObject) {
      this.removeOwnedPlotObject(this.highlightObject);
      this.highlightObject = null;
    }

    // Find segments corresponding to this line number
    // We check endPoint.lineNumber as it represents the move to that point
    const segments = this.currentPlotMetadata.segments.filter(
      (s) =>
        (!s.channelId || s.channelId === channelId) &&
        (s.endPoint.lineNumber === lineNumber || s.startPoint.lineNumber === lineNumber),
    );

    if (segments.length === 0) return;

    // Create geometry for highlighted segments
    const vertices: number[] = [];
    segments.forEach((segment) => {
      vertices.push(
        segment.startPoint.x,
        segment.startPoint.y,
        segment.startPoint.z,
        segment.endPoint.x,
        segment.endPoint.y,
        segment.endPoint.z,
      );
    });

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
      if (child.userData.isToolpath) {
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
      if (child instanceof THREE.Group && !child.userData.isToolpath) {
        child.visible = !child.visible;
      }
    });
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
    this.requestGeneration++;
    this.isPlotting = false;
    this.executedProgramService.cancelPendingPlot();
    if (this.displayedRunId) this.executedProgramService.discardPlotRun(this.displayedRunId);
    this.displayedRunId = undefined;
    this.stale = false;
    this.currentPlotMetadata = null;
    if (!this.scene) return;

    // Remove highlight object if exists
    if (this.highlightObject) {
      this.removeOwnedPlotObject(this.highlightObject);
      this.highlightObject = null;
    }

    // Clear all toolpath objects from the scene
    const toRemove: THREE.Object3D[] = [];
    this.scene.children.forEach((child) => {
      if (child.userData.isToolpath) {
        toRemove.push(child);
      }
    });
    toRemove.forEach((obj) => this.removeOwnedPlotObject(obj));

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
    object.traverse((child) => {
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => material.dispose());
      }
    });
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
      if (child.userData.isToolpath) {
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
