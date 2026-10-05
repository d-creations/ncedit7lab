import type { ChannelId, MachineType, ParseArtifacts, ToolOffsetValue } from '@core/types';
import { ServiceRegistry } from '@core/ServiceRegistry';
import {
  EVENT_BUS_TOKEN,
  FILE_MANAGER_SERVICE_TOKEN,
  MACHINE_SERVICE_TOKEN,
  PARSER_SERVICE_TOKEN,
  PROGRAM_TOOL_SERVICE_TOKEN,
  STATE_SERVICE_TOKEN,
  TOOL_CATALOG_SERVICE_TOKEN,
} from '@core/ServiceTokens';
import { EventBus, EVENT_NAMES, type EventSubscription } from '@services/EventBus';
import type { IFileManagerService } from '@services/IFileManagerService';
import type { MachineService } from '@services/MachineService';
import { ParserService } from '@services/ParserService';
import { StateService } from '@services/StateService';
import type { SimulationCommentSyntax } from '@services/tools/SimulationCommentCodec';
import type { ProgramSource, ProgramToolSnapshot } from '@services/tools/ProgramToolService';
import { ProgramToolService } from '@services/tools/ProgramToolService';
import type {
  CuttingPart,
  HolderPart,
  InsertShape,
  ProgramToolDefinition,
  ProgramMaterialDefinition,
  ProgramSetupDefinition,
  ToolIdentifier,
  Vector3,
} from '@services/tools/SimulationMetadata';
import { validateProgramMaterial, validateProgramTool } from '@services/tools/SimulationMetadata';
import type { LibraryToolDefinition } from '@services/tools/ToolLibraryTypes';
import { toProgramToolDefinition } from '@services/tools/ToolLibraryTypes';
import { ToolCatalogService } from '@services/tools/ToolCatalogService';
import type {
  ProgramOffsetsUpdateRequest,
  ProgramSetupUpdateRequest,
  ProgramToolUpdateRequest,
  ProgramToolUpdateResult,
} from '@services/tools/ProgramMetadataEditService';
import './NCToolPreview';
import type { NCToolPreview } from './NCToolPreview';

const CHANNELS: ChannelId[] = ['1', '2', '3'];
const INSERT_SHAPES: InsertShape[] = ['C', 'D', 'V', 'W', 'T', 'S', 'R', 'E', 'H', 'O', 'P', 'L', 'A', 'B', 'K'];

type ManagerTab = 'library' | 'program' | 'material' | 'offsets' | 'simulation';

function exactKey(value: ToolIdentifier): string {
  return JSON.stringify([typeof value, value]);
}

function createId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function optionalNumber(input: HTMLInputElement | null): number | undefined {
  if (!input || input.value.trim() === '') return undefined;
  const value = Number(input.value);
  if (!Number.isFinite(value)) throw new Error(`${input.labels?.[0]?.textContent ?? input.name} must be a finite number`);
  return value;
}

function requiredNumber(input: HTMLInputElement | null): number {
  const value = optionalNumber(input);
  if (value === undefined) throw new Error(`${input?.labels?.[0]?.textContent ?? 'Value'} is required`);
  return value;
}

export class NCToolManagerPanel extends HTMLElement {
  private readonly eventBus: EventBus;
  private readonly stateService: StateService;
  private readonly parserService: ParserService;
  private readonly programTools: ProgramToolService;
  private readonly catalog: ToolCatalogService;
  private readonly fileManager?: IFileManagerService;
  private readonly machineService?: MachineService;
  private pendingMachineName?: string;
  private subscriptions: EventSubscription[] = [];
  private hostChannelListener?: (event: Event) => void;
  private hostMessageListener?: (event: MessageEvent) => void;
  private bridgeListener?: (event: Event) => void;
  private activeTab: ManagerTab = 'library';
  private channelId: ChannelId = '1';
  private libraryTools: LibraryToolDefinition[] = [];
  private selectedLibraryId?: string;
  private libraryDraft?: LibraryToolDefinition;
  private search = '';
  private programSource?: ProgramSource;
  private programSnapshot?: ProgramToolSnapshot;
  private programDefinitions: ProgramToolDefinition[] = [];
  private detectedIdentifiers: ToolIdentifier[] = [];
  private selectedProgramKey?: string;
  private programDraft?: ProgramToolDefinition;
  private materialDraft?: ProgramMaterialDefinition;
  private offsetDrafts: ToolOffsetValue[] = [];
  private pendingRequestId?: string;
  private previewElement?: NCToolPreview;
  private status = '';
  private statusKind: 'info' | 'success' | 'error' = 'info';

  constructor() {
    super();
    const registry = ServiceRegistry.getInstance();
    this.eventBus = registry.get(EVENT_BUS_TOKEN);
    this.stateService = registry.get(STATE_SERVICE_TOKEN);
    this.parserService = registry.get(PARSER_SERVICE_TOKEN);
    this.programTools = registry.get(PROGRAM_TOOL_SERVICE_TOKEN);
    this.catalog = registry.get(TOOL_CATALOG_SERVICE_TOKEN);
    this.fileManager = registry.has(FILE_MANAGER_SERVICE_TOKEN) ? registry.get(FILE_MANAGER_SERVICE_TOKEN) : undefined;
    this.machineService = registry.has(MACHINE_SERVICE_TOKEN) ? registry.get(MACHINE_SERVICE_TOKEN) : undefined;
    this.attachShadow({ mode: 'open' });
  }

  async connectedCallback(): Promise<void> {
    this.channelId = this.stateService.getWorkbenchSelectedChannel() ?? '1';
    this.subscriptions.push(
      this.eventBus.subscribe(EVENT_NAMES.TOOL_LIBRARY_CHANGED, () => void this.loadLibrary()),
      this.eventBus.subscribe(EVENT_NAMES.PROGRAM_TOOL_UPDATE_RESULT, (data: unknown) => {
        void this.handleUpdateResult(data as ProgramToolUpdateResult);
      }),
      this.eventBus.subscribe(EVENT_NAMES.PROGRAM_OFFSETS_UPDATE_RESULT, (data: unknown) => {
        void this.handleUpdateResult(data as ProgramToolUpdateResult);
      }),
      this.eventBus.subscribe(EVENT_NAMES.PROGRAM_SETUP_UPDATE_RESULT, (data: unknown) => {
        void this.handleUpdateResult(data as ProgramToolUpdateResult);
      }),
      this.eventBus.subscribe('program:active_changed', (data: { channelId: string }) => {
        if (data.channelId === this.channelId) void this.loadProgram();
      }),
      this.eventBus.subscribe('program:content_changed', (data: { channelId: string }) => {
        if (data.channelId === this.channelId && !this.pendingRequestId) void this.loadProgram();
      }),
      this.eventBus.subscribe(EVENT_NAMES.MACHINE_CHANGED, () => void this.loadProgram()),
      this.eventBus.subscribe(EVENT_NAMES.PARSE_COMPLETED, (data: { channelId: string; artifacts: ParseArtifacts }) => {
        if (data.channelId !== this.channelId) return;
        this.detectedIdentifiers = this.uniqueIdentifiers(data.artifacts.toolRegisters.map((tool) => tool.toolNumber));
      }),
      this.eventBus.subscribe(
        EVENT_NAMES.TOOL_MANAGER_OPEN_REQUEST,
        (data: { channelId: ChannelId; missing: ToolIdentifier[] }) => void this.handleToolManagerOpenRequest(data),
      ),
    );

    this.hostChannelListener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.activeChannel && ['1', '2', '3'].includes(detail.activeChannel)) {
        this.channelId = detail.activeChannel as ChannelId;
        this.selectedProgramKey = undefined;
        void this.loadProgram();
      }
    };
    window.addEventListener('vscode:files-opened', this.hostChannelListener);

    this.hostMessageListener = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === 'PROGRAM_TOOL_UPDATE_RESULT') {
        void this.handleUpdateResult(data.payload as ProgramToolUpdateResult);
      }
    };
    window.addEventListener('message', this.hostMessageListener);

    this.bridgeListener = ((event: Event) => {
      const detail = (event as CustomEvent).detail as any;
      if (!detail || detail.type !== 'WORKBENCH_BRIDGE') return;
      if (detail.eventType === 'MACHINE_CHANGED') {
        const { machineName } = detail.payload;
        if (machineName) {
          const machines = this.stateService.getState().machines;
          if (machines.find(m => m.machineName === machineName)) {
            this.stateService.setGlobalMachine(machineName as MachineType);
          } else {
            this.pendingMachineName = machineName;
          }
          void this.loadProgram();
        }
      }
    }) as EventListener;
    window.addEventListener('vscode:workbench-bridge', this.bridgeListener);

    if (this.machineService) {
      this.machineService.init().then(() => {
        const machines = this.machineService!.getMachines();
        if (machines.length > 0) {
          this.stateService.setMachines(machines);
          if (this.pendingMachineName) {
            this.stateService.setGlobalMachine(this.pendingMachineName as MachineType);
            this.pendingMachineName = undefined;
          } else if (!this.stateService.getState().activeMachine) {
            this.stateService.setGlobalMachine(machines[0].machineName);
          }
        }
        void this.loadProgram();
      }).catch(() => {});
    }

    await Promise.all([this.loadLibrary(false), this.loadProgram(false)]);
    this.render();
  }

  disconnectedCallback(): void {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
    this.subscriptions = [];
    if (this.hostChannelListener) {
      window.removeEventListener('vscode:files-opened', this.hostChannelListener);
    }
    if (this.hostMessageListener) {
      window.removeEventListener('message', this.hostMessageListener);
    }
    if (this.bridgeListener) {
      window.removeEventListener('vscode:workbench-bridge', this.bridgeListener);
    }
  }

  private async loadLibrary(render = true): Promise<void> {
    try {
      this.libraryTools = await this.catalog.getTools({ query: this.search || undefined });
      if (this.selectedLibraryId) {
        this.libraryDraft = this.libraryTools.find((tool) => tool.id === this.selectedLibraryId);
      }
      if (!this.libraryDraft && this.libraryTools.length) {
        this.selectedLibraryId = this.libraryTools[0].id;
        this.libraryDraft = structuredClone(this.libraryTools[0]);
      }
    } catch (cause) {
      this.setStatus(cause instanceof Error ? cause.message : String(cause), 'error', false);
    }
    if (render) this.render();
  }

  private async loadProgram(render = true): Promise<void> {
    this.programSource = this.readProgramSource();
    this.programSnapshot = undefined;
    this.programDefinitions = [];
    this.materialDraft = undefined;
    if (!this.programSource) {
      this.setStatus(`No active program for channel ${this.channelId}`, 'error', false);
      if (render) this.render();
      return;
    }
    const machine = this.stateService.getState().activeMachine;
    this.programSnapshot = this.programTools.captureProgramSnapshot(
      this.programSource.identity,
      this.programSource.revision,
      this.programSource.text,
      machine?.simulationCommentSyntax,
    );
    this.programDefinitions = structuredClone(this.programSnapshot.tools) as ProgramToolDefinition[];
    this.materialDraft = this.programSnapshot.setup?.material
      ? structuredClone(this.programSnapshot.setup.material) as ProgramMaterialDefinition
      : { type: 'cylinder', diameter: 20, length: 100, zeroVertex: 1 };
    this.offsetDrafts = this.programTools.getTemporaryToolOffsets(this.programSource.identity);
    const persistedOffsets = this.programSnapshot.offsets;
    const policy = machine?.toolSelection;
    if (!this.offsetDrafts.length && persistedOffsets && policy &&
      persistedOffsets.offsetScope === policy.offsetScope) {
      this.programTools.setTemporaryToolOffsets(
        this.programSource.identity,
        policy,
        persistedOffsets.offsets.map((offset) => ({ ...offset })),
      );
      this.offsetDrafts = this.programTools.getTemporaryToolOffsets(this.programSource.identity);
    }
    const parse = await this.parserService.parse(this.programSource.text, this.channelId, {
      regexPatterns: machine?.regexPatterns,
      controlType: machine?.controlType,
    });
    this.detectedIdentifiers = this.uniqueIdentifiers([
      ...parse.artifacts.toolRegisters.map((tool) => tool.toolNumber),
      ...this.programDefinitions.map((tool) => tool.toolNumber),
    ]);
    if (this.selectedProgramKey && !this.detectedIdentifiers.some((id) => exactKey(id) === this.selectedProgramKey)) {
      this.selectedProgramKey = undefined;
    }
    if (!this.selectedProgramKey && this.detectedIdentifiers.length) {
      this.selectedProgramKey = exactKey(this.detectedIdentifiers[0]);
    }
    const selectedId = this.selectedProgramIdentifier;
    if (selectedId !== undefined) {
      this.programDraft = structuredClone(
        this.programDefinitions.find((tool) => exactKey(tool.toolNumber) === exactKey(selectedId)) ??
        this.newProgramTool(selectedId),
      );
    }
    if (render) this.render();
  }

  private get selectedProgramIdentifier(): ToolIdentifier | undefined {
    return this.detectedIdentifiers.find((id) => exactKey(id) === this.selectedProgramKey);
  }

  /** A blocked Plot request lands here: switch to the missing tool so it can be filled in immediately. */
  private async handleToolManagerOpenRequest(data: { channelId: ChannelId; missing: ToolIdentifier[] }): Promise<void> {
    this.channelId = data.channelId;
    this.stateService.setWorkbenchSelectedChannel(this.channelId);
    this.activeTab = 'program';
    await this.loadProgram(false);
    const first = data.missing[0];
    if (first !== undefined) {
      this.selectedProgramKey = exactKey(first);
      this.programDraft = structuredClone(
        this.programDefinitions.find((tool) => exactKey(tool.toolNumber) === this.selectedProgramKey) ??
        this.newProgramTool(first),
      );
    }
    const names = data.missing.map((id) => (typeof id === 'number' ? `T${id}` : id)).join(', ');
    this.setStatus(
      `Plot needs Q/R or geometry for tool${data.missing.length > 1 ? 's' : ''} ${names} on channel ${this.channelId}`,
      'error', false,
    );
    this.render();
  }

  private uniqueIdentifiers(values: ToolIdentifier[]): ToolIdentifier[] {
    const seen = new Set<string>();
    return values.filter((value) => {
      const key = exactKey(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private readProgramSource(): ProgramSource | undefined {
    const pane = document.querySelector(
      `nc-channel-pane[data-channel="${this.channelId}"] nc-code-pane`,
    ) as (HTMLElement & { getProgramSource(): ProgramSource | undefined }) | null;
    if (pane) {
      return pane.getProgramSource();
    }
    const program = this.fileManager?.getActiveProgram(this.channelId);
    if (program) {
      return {
        identity: {
          channelId: this.channelId,
          documentId: 'external',
          programId: program.id || program.name || `Channel ${this.channelId}`,
        },
        revision: 'external',
        text: program.content,
      };
    }
    return undefined;
  }

  private getSimulationCommentSyntax(): SimulationCommentSyntax | undefined {
    const machine = this.stateService.getState().activeMachine;
    if (machine) {
      if (machine.simulationCommentSyntax) {
        return machine.simulationCommentSyntax;
      }
      const controlType = machine.controlType?.toUpperCase();
      if (controlType === 'SIEMENS') {
        return { kind: 'line', prefix: ';' };
      }
      if (controlType === 'FANUC') {
        return { kind: 'block', open: '(', close: ')' };
      }
      return undefined;
    }

    const text = this.programSource?.text;
    if (text && text.includes(';') && !text.includes('(')) {
      return { kind: 'line', prefix: ';' };
    }
    if (text) {
      return { kind: 'block', open: '(', close: ')' };
    }

    return undefined;
  }

  private newProgramTool(toolNumber: ToolIdentifier = 1): ProgramToolDefinition {
    return { toolNumber, description: '' };
  }

  private newLibraryTool(): LibraryToolDefinition {
    const now = Date.now();
    return {
      id: createId('tool'), revision: 0, description: '', tags: [], createdAt: now, updatedAt: now,
      cutting: [{ type: 'endMill', diameter: 10, length: 30 }],
      holder: [{ type: 'cylinder', diameter: 10, length: 40 }],
    };
  }

  private render(): void {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>${this.styles}</style>
      <div class="manager-shell">
        <header class="manager-header">
          <div>
            <h2>Tool Manager</h2>
            <p>Reusable definitions and program-owned simulation metadata</p>
          </div>
          <div class="channel-control">
            <label for="manager-channel">Channel</label>
            <select id="manager-channel">${CHANNELS.map((channel) =>
              `<option value="${channel}" ${channel === this.channelId ? 'selected' : ''}>CH ${channel}</option>`).join('')}</select>
          </div>
        </header>
        <nav class="manager-tabs" aria-label="Tool manager views">
          <button class="manager-tab ${this.activeTab === 'library' ? 'active' : ''}" data-manager-tab="library">Library</button>
          <button class="manager-tab ${this.activeTab === 'program' ? 'active' : ''}" data-manager-tab="program">Program Tools</button>
          <button class="manager-tab ${this.activeTab === 'material' ? 'active' : ''}" data-manager-tab="material">Raw Material</button>
          <button class="manager-tab ${this.activeTab === 'offsets' ? 'active' : ''}" data-manager-tab="offsets">Offsets</button>
          <button class="manager-tab ${this.activeTab === 'simulation' ? 'active' : ''}" data-manager-tab="simulation">Simulation</button>
        </nav>
        <div class="manager-body">
          ${this.activeTab === 'library' ? this.renderLibrary() :
            this.activeTab === 'program' ? this.renderProgram() :
              this.activeTab === 'material' ? this.renderMaterial() :
              this.activeTab === 'offsets' ? this.renderOffsets() : this.renderSimulation()}
        </div>
        <div id="manager-status" class="status ${this.statusKind}" role="status" aria-live="polite">${this.escape(this.status)}</div>
      </div>
    `;
    this.attachListeners();
    this.mountPreview();
    this.updateGeometryVisibility();
  }

  private renderLibrary(): string {
    const draft = this.libraryDraft;
    return `
      <aside class="tool-list-pane">
        <div class="list-toolbar">
          <input id="tool-search" type="search" placeholder="Search tools" value="${this.escape(this.search)}">
          <button class="button primary" id="new-library-tool" title="Create tool">+ New Tool</button>
        </div>
        <div class="tool-list">
          ${this.libraryTools.length ? this.libraryTools.map((tool) => `
            <button class="tool-row ${tool.id === this.selectedLibraryId ? 'active' : ''}" data-library-id="${this.escape(tool.id)}">
              <span class="tool-name">${this.escape(tool.description || 'Unnamed tool')}</span>
              <span class="tool-meta">${this.escape(this.toolSummary(tool))}</span>
            </button>`).join('') : '<div class="empty">No saved tools. Create the first local tool definition.</div>'}
        </div>
        <div class="library-actions">
          <button class="button" id="import-library">Import</button>
          <button class="button" id="export-library">Export</button>
          <button class="button" id="reset-defaults" title="Reset standard tools to latest defaults">Reset Defaults</button>
          <input id="library-file" type="file" accept="application/json,.json" hidden>
        </div>
      </aside>
      <main class="tool-editor-pane">
        ${draft ? this.renderToolForm(draft, 'library') : '<div class="empty">Select or create a library tool.</div>'}
      </main>`;
  }

  private renderProgram(): string {
    const syntax = this.getSimulationCommentSyntax();
    const diagnostic = this.programSnapshot?.diagnostics.map((item) => item.message).join('; ');
    return `
      <aside class="tool-list-pane">
        <div class="list-toolbar">
          <div class="section-label">Program assignments</div>
          <button class="button" id="new-program-tool">+ New Assignment</button>
        </div>
        <div class="tool-list">
          ${this.detectedIdentifiers.length ? this.detectedIdentifiers.map((identifier) => {
            const assigned = this.programDefinitions.some((tool) => exactKey(tool.toolNumber) === exactKey(identifier));
            return `<button class="tool-row ${exactKey(identifier) === this.selectedProgramKey ? 'active' : ''}" data-program-key="${this.escape(exactKey(identifier))}">
              <span class="tool-name">${this.escape(this.formatIdentifier(identifier))}</span>
              <span class="tool-meta ${assigned ? 'complete' : ''}">${assigned ? 'Managed metadata' : 'Detected, not assigned'}</span>
            </button>`;
          }).join('') : '<div class="empty">No tool calls detected. Create an assignment manually.</div>'}
        </div>
        <div class="program-source">
          <span>${this.escape(this.programSource?.identity.programId ?? 'No program')}</span>
          <span>Revision ${this.escape(String(this.programSource?.revision ?? '-'))}</span>
        </div>
      </aside>
      <main class="tool-editor-pane">
        ${!syntax ? '<div class="notice warning">The selected machine does not advertise a safe simulation-comment syntax. Library editing works, but Apply to Program is disabled.</div>' : ''}
        ${diagnostic ? `<div class="notice error">${this.escape(diagnostic)}</div>` : ''}
        ${this.programDraft ? `
          <div class="assign-bar">
            <select id="assign-library-tool">
              <option value="">Choose library tool...</option>
              ${this.libraryTools.map((tool) => `<option value="${this.escape(tool.id)}">${this.escape(tool.description || 'Unnamed tool')}</option>`).join('')}
            </select>
            <button class="button" id="copy-library-tool">Use Library Geometry</button>
          </div>
          ${this.renderToolForm(this.programDraft, 'program')}
          ${this.renderProgramOffsetSettings()}
        ` : '<div class="empty">Select a detected tool or create an assignment.</div>'}
      </main>`;
  }

  private renderProgramOffsetSettings(): string {
    const policy = this.stateService.getState().activeMachine?.toolSelection;
    if (!policy || policy.offsetScope !== 'global') return '';
    const address = policy.offsetAddress ?? 'offset';
    return `
      <section class="inline-offsets">
        <div class="section-heading"><h3>Channel Offset Q/R</h3><span>${this.escape(address)} registers are shared by this channel</span></div>
        <div class="offset-table" role="table" aria-label="Channel Q/R offsets">
          ${this.offsetDrafts.length ? this.offsetDrafts.map((offset, index) => `
            <div class="offset-row inline-offset-row" data-offset-row="${index}" role="row">
              <label>Offset<input data-offset-field="number" type="number" min="0" step="1" value="${offset.offsetNumber}"></label>
              <label>Q<input data-offset-field="q" type="number" step="any" value="${offset.qValue ?? ''}" placeholder="Tool default"></label>
              <label>R<input data-offset-field="r" type="number" step="any" value="${offset.rValue ?? ''}" placeholder="Tool default"></label>
              <button class="icon-button" data-remove-offset="${index}" type="button" title="Remove offset" aria-label="Remove offset">×</button>
            </div>`).join('') : '<div class="empty">No explicit offsets. Tool-level Q/R defaults are used.</div>'}
        </div>
        <div class="form-actions"><button class="button" id="add-offset" type="button">+ Add Offset</button><button class="button primary" id="save-offsets" type="button">Apply Offset Q/R</button></div>
      </section>`;
  }

  private renderOffsets(): string {
    const policy = this.stateService.getState().activeMachine?.toolSelection;
    if (!this.programSource) {
      return '<main class="offset-editor-pane"><div class="empty">Open a program before editing offsets.</div></main>';
    }
    if (!policy) {
      return '<main class="offset-editor-pane"><div class="notice warning">The selected machine does not advertise a tool-offset policy. Offset editing is disabled.</div></main>';
    }
    const address = policy.offsetAddress ?? 'offset';
    const scopeText = policy.offsetScope === 'tool'
      ? `${address} records are keyed by exact tool identifier and offset number.`
      : `${address} records are shared by this channel and do not contain a tool identifier.`;
    return `<main class="offset-editor-pane">
      <div class="offset-header">
        <div><h3>Program Offset Table</h3><p>${this.escape(scopeText)}</p></div>
        <button class="button" id="add-offset" type="button">+ Add Offset</button>
      </div>
      <div class="offset-table" role="table" aria-label="Program offsets">
        ${this.offsetDrafts.length ? this.offsetDrafts.map((offset, index) =>
          this.renderOffsetRow(offset, index, policy.offsetScope === 'tool')).join('') :
          '<div class="empty">No explicit offsets. Tool defaults remain available until an offset table is saved.</div>'}
      </div>
      <div class="notice">Offsets are program-owned compensation records. Applying writes a managed simulation-comment block without changing executable NC commands.</div>
      <div class="form-actions"><button class="button primary" id="save-offsets" type="button">Apply Offsets to Program</button></div>
    </main>`;
  }

  private renderSimulation(): string {
    const machine = this.stateService.getState().activeMachine;
    const simulation = machine?.simulation;
    if (!machine) return '<main class="simulation-pane"><div class="empty">Select a machine to inspect its simulation profile.</div></main>';
    if (!simulation) return `<main class="simulation-pane"><div class="notice warning">${this.escape(machine.machineName)} does not provide simulation machine data.</div></main>`;
    const supported = machine.supportedPoseContracts?.includes(simulation.poseContract) ?? false;
    return `<main class="simulation-pane">
      <section><div class="section-heading"><h3>${this.escape(simulation.displayName)}</h3><span>${this.escape(simulation.fidelity)} profile</span></div>
        <div class="field-grid simulation-fields"><div><span>Machine</span><strong>${this.escape(machine.machineName)}</strong></div><div><span>Model</span><strong>${this.escape(simulation.modelId)}</strong></div><div><span>Axes</span><strong>${this.escape(machine.axes.join(', ') || 'None')}</strong></div><div><span>Channels</span><strong>${machine.availableChannels}</strong></div><div><span>Profile revision</span><strong>${this.escape(machine.profileRevision ?? 'Unavailable')}</strong></div><div><span>Pose output</span><strong class="${supported ? 'available' : 'unavailable'}">${supported ? 'Available' : 'Not installed'}</strong></div></div>
      </section>
      <section><div class="section-heading"><h3>Carriers</h3><span>Reference orientation and rotary chains</span></div>
        <div class="simulation-list">${simulation.carriers.map((carrier) => `<div class="simulation-row"><strong>${this.escape(carrier.id)}</strong><span>${carrier.role} · [${carrier.referenceOrientationDegrees.join(', ')}]</span><span>${carrier.rotationChain.length ? carrier.rotationChain.map((joint) => `${this.escape(joint.axisId)} ${joint.sign > 0 ? '+' : '-'} (${joint.axis.join(', ')})`).join('; ') : 'Fixed'}</span></div>`).join('')}</div>
      </section>
      <section><div class="section-heading"><h3>Tool mappings</h3><span>Static profile assignments</span></div>
        <div class="simulation-list">${simulation.toolMounts.map((mount) => `<div class="simulation-row"><strong>CH ${this.escape(mount.channelId)}</strong><span>${this.escape(mount.carrierId)} → ${this.escape(mount.target.mode === 'fixed' ? mount.target.workpieceCarrierId : mount.target.allowedWorkpieceCarrierIds.join(', '))}</span><span>${mount.tools.kind === 'numericRange' ? `Tools ${mount.tools.from}-${mount.tools.to}` : mount.tools.values.map(String).join(', ')}</span></div>`).join('')}</div>
      </section>
    </main>`;
  }

  private renderMaterial(): string {
    const material = this.materialDraft;
    if (!material) return '<main class="tool-editor-pane material-editor-pane"><div class="empty">Select an active program to define raw material.</div></main>';
    const syntax = this.getSimulationCommentSyntax();
    const diagnostic = this.programSnapshot?.diagnostics.map((item) => item.message).join('; ');
    const dimensions = material.type === 'cylinder'
      ? [['diameter', 'Diameter'], ['length', 'Length (Z)']] as const
      : [['width', 'Width (X)'], ['height', 'Height (Y)'], ['depth', 'Depth (Z)']] as const;
    const values: Record<string, number> = material.type === 'cylinder'
      ? { diameter: material.diameter, length: material.length }
      : { width: material.width, height: material.height, depth: material.depth };
    return `<main class="tool-editor-pane material-editor-pane">
      ${!syntax ? '<div class="notice warning">The selected machine does not advertise a safe simulation-comment syntax. Apply to Program is disabled.</div>' : ''}
      ${diagnostic ? `<div class="notice error">${this.escape(diagnostic)}</div>` : ''}
      <form id="material-form" class="tool-form">
        <section><div class="section-heading"><h3>Raw Material</h3><span>Distances in mm</span></div>
          <label>Shape<select id="material-type">${this.option('cylinder', 'Round stock', material.type)}${this.option('box', 'Plate / rectangular stock', material.type)}</select></label>
          <div class="field-grid compact">${dimensions.map(([key, label]) => `<label>${label}<input id="material-${key}" type="number" min="0" step="any" value="${values[key]}"></label>`).join('')}</div>
          <label>Zero point<select id="material-zero">
            ${this.option('', 'Centre (legacy placement)', material.zeroVertex === undefined ? '' : String(material.zeroVertex))}
            ${Array.from({ length: material.type === 'cylinder' ? 2 : 8 }, (_, index) => this.option(
              String(index), material.type === 'cylinder' ? `End ${index}: ${index ? '+Z' : '-Z'} face centre` :
                `Corner ${index}: ${index & 1 ? '+X' : '-X'}, ${index & 2 ? '+Y' : '-Y'}, ${index & 4 ? '+Z' : '-Z'}`,
              String(material.zeroVertex),
            )).join('')}
          </select></label>
          <div class="notice">Click an end-face centre or one of the eight corners in the preview to select the material zero.</div>
          <div id="material-preview-slot"></div>
        </section>
        <section><div class="section-heading"><h3>Placement</h3><span>Initial program work coordinates</span></div>
          <p>Position locates the selected zero point. Rotation is about that point.</p>
          <div class="field-grid transform-grid">${['x', 'y', 'z'].map((axis, index) => `<label>Position ${axis.toUpperCase()}<input id="material-p${axis}" type="number" step="any" value="${material.position?.[index] ?? 0}"></label>`).join('')}</div>
          <div class="field-grid transform-grid">${['x', 'y', 'z'].map((axis, index) => `<label>Rotation ${axis.toUpperCase()}<input id="material-r${axis}" type="number" step="any" value="${material.rotation?.[index] ?? 0}"></label>`).join('')}</div>
        </section>
        <div class="form-actions">
          <button class="button primary" type="submit" ${!syntax || this.pendingRequestId || diagnostic ? 'disabled' : ''}>Apply Raw Material to Program</button>
          <button class="button" id="remove-material" type="button" ${!syntax || this.pendingRequestId || diagnostic || !this.programSnapshot?.setup?.material ? 'disabled' : ''}>Remove Program Material</button>
        </div>
        <div class="notice">Stored in the program's managed SETUP comments; executable NC commands are unchanged.</div>
      </form>
    </main>`;
  }

  private buildMaterialFromForm(): ProgramMaterialDefinition {
    const input = (key: string) => this.shadowRoot?.querySelector<HTMLInputElement>(`#material-${key}`) ?? null;
    const zero = this.shadowRoot?.querySelector<HTMLSelectElement>('#material-zero')?.value;
    const common = {
      ...this.readTransform('material'),
      ...(zero === '' || zero === undefined ? {} : { zeroVertex: Number(zero) }),
    };
    const material: ProgramMaterialDefinition = this.shadowRoot?.querySelector<HTMLSelectElement>('#material-type')?.value === 'box'
      ? { type: 'box', width: requiredNumber(input('width')), height: requiredNumber(input('height')),
        depth: requiredNumber(input('depth')), ...common }
      : { type: 'cylinder', diameter: requiredNumber(input('diameter')), length: requiredNumber(input('length')), ...common };
    validateProgramMaterial(material);
    return material;
  }

  private applyProgramMaterial(remove = false): void {
    try {
      if (this.pendingRequestId) throw new Error('A program update is already pending');
      const syntax = this.getSimulationCommentSyntax();
      if (!this.programSource || !syntax) {
        throw new Error('An active program and a safe simulation-comment syntax are required');
      }
      const machine = this.stateService.getState().activeMachine;
      const setup: ProgramSetupDefinition = {
        machineName: this.programSnapshot?.setup?.machineName ?? machine?.machineName ?? 'CNC',
        ...(remove ? {} : { material: this.buildMaterialFromForm() }),
      };
      const request: ProgramSetupUpdateRequest = {
        requestId: createId('setup'), channelId: this.channelId,
        documentId: this.programSource.identity.documentId, programId: this.programSource.identity.programId,
        expectedRevision: this.programSource.revision, expectedText: this.programSource.text,
        syntax, setup,
      };
      this.pendingRequestId = request.requestId;
      this.setStatus('Applying raw material metadata...', 'info');
      this.eventBus.publish(EVENT_NAMES.PROGRAM_SETUP_UPDATE_REQUEST, request);
      this.relayUpdateRequest('PROGRAM_SETUP_UPDATE_REQUEST', request);
    } catch (cause) {
      this.setStatus(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  }

  private renderOffsetRow(offset: ToolOffsetValue, index: number, toolScoped: boolean): string {
    return `<div class="offset-row" data-offset-row="${index}" role="row">
      ${toolScoped ? `<label>Identifier type<select data-offset-field="tool-kind">
        <option value="number" ${typeof offset.toolNumber === 'number' ? 'selected' : ''}>Number</option>
        <option value="name" ${typeof offset.toolNumber === 'string' ? 'selected' : ''}>Name</option>
      </select></label><label>Tool<input data-offset-field="tool" value="${this.escape(String(offset.toolNumber ?? ''))}"></label>` : ''}
      <label>Offset<input data-offset-field="number" type="number" min="0" step="1" value="${offset.offsetNumber}"></label>
      <label>Q<input data-offset-field="q" type="number" step="any" value="${offset.qValue ?? ''}" placeholder="Optional"></label>
      <label>R<input data-offset-field="r" type="number" step="any" value="${offset.rValue ?? ''}" placeholder="Optional"></label>
      <label>Length<input data-offset-field="length" type="number" step="any" value="${offset.lengthValue ?? ''}" placeholder="Optional"></label>
      <label>Edge<input data-offset-field="edge" type="number" min="0" step="1" value="${offset.edgeNumber ?? ''}" placeholder="Optional"></label>
      <button class="icon-button" data-remove-offset="${index}" type="button" title="Remove offset" aria-label="Remove offset">×</button>
    </div>`;
  }

  private renderToolForm(tool: LibraryToolDefinition | ProgramToolDefinition, mode: ManagerTab): string {
    const holder = tool.holder?.[0];
    const cutter = tool.cutting?.[0];
    const tags = 'tags' in tool ? tool.tags.join(', ') : '';
    const orientation = tool.orientation ?? [0, 0, 0];
    const holderPosition = holder?.position ?? [0, 0, 0];
    const holderRotation = holder?.rotation ?? [0, 0, 0];
    const cutterPosition = cutter?.position ?? [0, 0, 0];
    const cutterRotation = cutter?.rotation ?? [0, 0, 0];
    const programTool = mode === 'program' ? tool as ProgramToolDefinition : undefined;
    return `
      <form id="tool-form" class="tool-form" data-mode="${mode}">
        <section>
          <div class="section-heading"><h3>General</h3><span>Distances in mm, rotations in degrees</span></div>
          ${mode === 'program' ? `
            <div class="field-grid compact">
              <label>Identifier type<select id="identifier-kind"><option value="number" ${typeof programTool?.toolNumber === 'number' ? 'selected' : ''}>Number</option><option value="name" ${typeof programTool?.toolNumber === 'string' ? 'selected' : ''}>Name</option></select></label>
              <label>Tool identifier<input id="tool-identifier" value="${this.escape(String(programTool?.toolNumber ?? 1))}" required></label>
            </div>` : ''}
          <label>Description<input id="tool-description" value="${this.escape(tool.description)}" placeholder="Drill 8 mm" required></label>
          ${mode === 'library' ? `<label>Tags<input id="tool-tags" value="${this.escape(tags)}" placeholder="drill, aluminum"></label>` : ''}
          <div class="field-grid compact">
            <label>Q<input id="tool-q" type="number" step="any" value="${tool.Q ?? ''}" placeholder="Optional"></label>
            <label>R<input id="tool-r" type="number" step="any" value="${tool.R ?? ''}" placeholder="Optional"></label>
          </div>
          <details><summary>Assembly orientation</summary>
            <div class="field-grid transform-grid">
              ${['X', 'Y', 'Z'].map((axis, index) => `<label>Rotation ${axis}<input id="tool-orientation-${axis.toLowerCase()}" type="number" step="any" value="${orientation[index]}"></label>`).join('')}
            </div>
          </details>
        </section>

        <section>
          <div class="section-heading"><h3>Holder</h3><span>Non-cutting assembly</span></div>
          <label>Holder type<select id="holder-type">
            ${this.option('none', 'None', holder?.type ?? 'none')}
            ${this.option('cylinder', 'Cylinder', holder?.type)}
            ${this.option('box', 'Box', holder?.type)}
            ${this.option('cone', 'Cone', holder?.type)}
            ${this.option('profile', 'Axial Profile (preserved)', holder?.type)}
            ${this.option('turningHolderProfile', 'Turning Holder Profile (preserved)', holder?.type)}
          </select></label>
          ${holder?.type === 'profile' ? '<div class="notice warning">Axial profile points are preserved but are not editable in this first form.</div>' : ''}
          ${(tool.holder?.length ?? 0) > 1 ? `<div class="notice warning">${tool.holder!.length - 1} additional holder part(s) are preserved unchanged.</div>` : ''}
          <div data-holder-fields="cylinder cone box" class="field-grid compact">
            <label>Length<input id="holder-length" type="number" min="0" step="any" value="${holder && 'length' in holder ? holder.length : ''}"></label>
            <label>Stick-out<input id="holder-stickout" type="number" min="0" step="any" value="${holder?.stickOut ?? ''}" placeholder="Optional"></label>
          </div>
          <div data-holder-fields="cylinder" class="field-grid compact"><label>Diameter<input id="holder-diameter" type="number" min="0" step="any" value="${holder?.type === 'cylinder' ? holder.diameter : ''}"></label></div>
          <div data-holder-fields="box" class="field-grid compact">
            <label>Width<input id="holder-width" type="number" min="0" step="any" value="${holder?.type === 'box' ? holder.width : ''}"></label>
            <label>Height<input id="holder-height" type="number" min="0" step="any" value="${holder?.type === 'box' ? holder.height : ''}"></label>
          </div>
          <div data-holder-fields="cone" class="field-grid compact">
            <label>Start diameter<input id="holder-start-diameter" type="number" min="0" step="any" value="${holder?.type === 'cone' ? holder.startDiameter : ''}"></label>
            <label>End diameter<input id="holder-end-diameter" type="number" min="0" step="any" value="${holder?.type === 'cone' ? holder.endDiameter : ''}"></label>
          </div>
          ${this.renderTransformFields('holder', holderPosition, holderRotation)}
        </section>

        <section>
          <div class="section-heading"><h3>Cutting Geometry</h3><span>One active cutter</span></div>
          <label>Cutter type<select id="cutting-type">
            ${this.option('none', 'None / Q-R only', cutter?.type ?? 'none')}
            ${this.option('drill', 'Drill', cutter?.type)}
            ${this.option('endMill', 'End Mill', cutter?.type)}
            ${this.option('ballMill', 'Ball Mill', cutter?.type)}
            ${this.option('insert', 'Turning Insert', cutter?.type)}
          </select></label>
          ${(tool.cutting?.length ?? 0) > 1 ? `<div class="notice warning">${tool.cutting!.length - 1} additional cutter(s) are preserved unchanged and remain unsupported for execution.</div>` : ''}
          <div data-cutting-fields="drill endMill ballMill" class="field-grid compact">
            <label>Diameter<input id="cutting-diameter" type="number" min="0" step="any" value="${cutter && 'diameter' in cutter ? cutter.diameter : ''}"></label>
            <label>Cutting length<input id="cutting-length" type="number" min="0" step="any" value="${cutter && 'diameter' in cutter && 'length' in cutter ? cutter.length : ''}"></label>
          </div>
          <div data-cutting-fields="drill" class="field-grid compact"><label>Tip angle<input id="cutting-tip-angle" type="number" step="any" value="${cutter?.type === 'drill' ? cutter.tipAngle : 118}"></label></div>
          <div data-cutting-fields="endMill" class="field-grid compact"><label>Corner radius<input id="cutting-corner-radius" type="number" min="0" step="any" value="${cutter?.type === 'endMill' ? cutter.cornerRadius ?? '' : ''}" placeholder="Optional"></label></div>
          <div data-cutting-fields="insert">
            <div class="field-grid compact">
              <label>Shape<select id="insert-shape">${INSERT_SHAPES.map((shape) => this.option(shape, shape, cutter?.type === 'insert' ? cutter.shape : 'C')).join('')}</select></label>
              <label>IC<input id="insert-ic" type="number" min="0" step="any" value="${cutter?.type === 'insert' ? cutter.ic : ''}"></label>
              <label>Thickness<input id="insert-thickness" type="number" min="0" step="any" value="${cutter?.type === 'insert' ? cutter.thickness : ''}"></label>
              <label>Nose radius<input id="insert-nose-radius" type="number" min="0" step="any" value="${cutter?.type === 'insert' ? cutter.noseRadius : ''}"></label>
              <label>Clearance angle<input id="insert-clearance" type="number" step="any" value="${cutter?.type === 'insert' ? cutter.clearanceAngle : 0}"></label>
              <label>Width<input id="insert-width" type="number" min="0" step="any" value="${cutter?.type === 'insert' ? cutter.width ?? '' : ''}" placeholder="L/A/B/K"></label>
              <label>Length<input id="insert-length" type="number" min="0" step="any" value="${cutter?.type === 'insert' ? cutter.length ?? '' : ''}" placeholder="L/A/B/K"></label>
              <label>Zero vertex<input id="insert-zero-vertex" type="number" min="0" max="255" step="1" value="${cutter?.type === 'insert' ? cutter.zeroVertex ?? '' : ''}" placeholder="Auto" title="Plate outline vertex used as tool zero; stored in the NC program. Click a vertex in the preview."></label>
            </div>
          </div>
          ${this.renderTransformFields('cutting', cutterPosition, cutterRotation)}
        </section>

        <section>
          <div class="section-heading"><h3>Preview</h3><span>Live setup preview, not collision geometry</span></div>
          <div id="tool-preview-slot"></div>
        </section>

        <div class="form-actions">
          ${mode === 'library' ? `
            <button class="button danger" type="button" id="delete-library-tool" ${(tool as LibraryToolDefinition).revision === 0 ? 'disabled' : ''}>Delete</button>
            <button class="button primary" type="submit">Save Tool</button>
          ` : `
            <button class="button" type="button" id="save-program-to-library">Save Copy to Library</button>
            <button class="button primary" type="submit" ${!this.canApplyProgram ? 'disabled' : ''}>Apply to Program</button>
          `}
        </div>
      </form>`;
  }

  private renderTransformFields(prefix: string, position: Vector3, rotation: Vector3): string {
    return `<details><summary>Position and rotation</summary>
      <div class="field-grid transform-grid">
        ${['X', 'Y', 'Z'].map((axis, index) => `<label>Position ${axis}<input id="${prefix}-p${axis.toLowerCase()}" type="number" step="any" value="${position[index]}"></label>`).join('')}
        ${['X', 'Y', 'Z'].map((axis, index) => `<label>Rotation ${axis}<input id="${prefix}-r${axis.toLowerCase()}" type="number" step="any" value="${rotation[index]}"></label>`).join('')}
      </div></details>`;
  }

  private get canApplyProgram(): boolean {
    return !!this.programSource && !!this.getSimulationCommentSyntax() &&
      this.programSnapshot?.valid !== false;
  }

  private attachListeners(): void {
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-manager-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        this.activeTab = button.dataset.managerTab as ManagerTab;
        this.render();
        if (this.activeTab === 'library') {
          void this.loadLibrary(true);
        } else {
          void this.loadProgram(true);
        }
      });
    });
    this.shadowRoot?.querySelector<HTMLSelectElement>('#manager-channel')?.addEventListener('change', (event) => {
      this.channelId = (event.currentTarget as HTMLSelectElement).value as ChannelId;
      this.stateService.setWorkbenchSelectedChannel(this.channelId);
      this.selectedProgramKey = undefined;
      void this.loadProgram();
    });
    this.shadowRoot?.querySelector<HTMLInputElement>('#tool-search')?.addEventListener('input', (event) => {
      this.search = (event.currentTarget as HTMLInputElement).value;
      void this.loadLibrary();
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-library-id]').forEach((button) => {
      button.addEventListener('click', () => {
        this.selectedLibraryId = button.dataset.libraryId;
        this.libraryDraft = structuredClone(this.libraryTools.find((tool) => tool.id === this.selectedLibraryId));
        this.render();
      });
    });
    this.shadowRoot?.querySelector<HTMLButtonElement>('#new-library-tool')?.addEventListener('click', () => {
      this.selectedLibraryId = undefined;
      this.libraryDraft = this.newLibraryTool();
      this.render();
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-program-key]').forEach((button) => {
      button.addEventListener('click', () => {
        this.selectedProgramKey = button.dataset.programKey;
        const identifier = this.selectedProgramIdentifier;
        if (identifier !== undefined) {
          this.programDraft = structuredClone(this.programDefinitions.find((tool) => exactKey(tool.toolNumber) === exactKey(identifier)) ?? this.newProgramTool(identifier));
        }
        this.render();
      });
    });
    this.shadowRoot?.querySelector<HTMLButtonElement>('#new-program-tool')?.addEventListener('click', () => {
      this.selectedProgramKey = undefined;
      this.programDraft = this.newProgramTool();
      this.render();
    });
    this.shadowRoot?.querySelector<HTMLButtonElement>('#copy-library-tool')?.addEventListener('click', () => this.copyLibraryTool());
    const materialForm = this.shadowRoot?.querySelector<HTMLFormElement>('#material-form');
    materialForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.applyProgramMaterial();
    });
    materialForm?.addEventListener('input', () => this.refreshPreview());
    materialForm?.addEventListener('change', () => this.refreshPreview());
    this.shadowRoot?.querySelector<HTMLButtonElement>('#remove-material')?.addEventListener('click', () => this.applyProgramMaterial(true));
    this.shadowRoot?.querySelector<HTMLSelectElement>('#material-type')?.addEventListener('change', (event) => {
      try {
        const type = (event.currentTarget as HTMLSelectElement).value;
        const transform = this.readTransform('material');
        this.materialDraft = type === 'box'
          ? { type: 'box', width: 100, height: 20, depth: 100, zeroVertex: 0, ...transform }
          : { type: 'cylinder', diameter: 20, length: 100, zeroVertex: 1, ...transform };
        this.render();
      } catch (cause) {
        this.setStatus(cause instanceof Error ? cause.message : String(cause), 'error');
      }
    });
    this.shadowRoot?.querySelector<HTMLFormElement>('#tool-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.activeTab === 'library') void this.saveLibraryTool();
      else this.applyProgramTool();
    });
    this.shadowRoot?.querySelector<HTMLButtonElement>('#delete-library-tool')?.addEventListener('click', () => void this.deleteLibraryTool());
    this.shadowRoot?.querySelector<HTMLButtonElement>('#save-program-to-library')?.addEventListener('click', () => void this.saveProgramCopy());
    this.shadowRoot?.querySelector<HTMLSelectElement>('#holder-type')?.addEventListener('change', () => this.updateGeometryVisibility());
    this.shadowRoot?.querySelector<HTMLSelectElement>('#cutting-type')?.addEventListener('change', () => this.updateGeometryVisibility());
    this.shadowRoot?.querySelector<HTMLSelectElement>('#insert-shape')?.addEventListener('change', () => this.updateGeometryVisibility());
    this.shadowRoot?.querySelector<HTMLInputElement>('#insert-ic')?.addEventListener('input', () => this.updateGeometryVisibility());
    this.shadowRoot?.querySelector<HTMLFormElement>('#tool-form')?.addEventListener('input', () => this.refreshPreview());
    this.shadowRoot?.querySelector<HTMLFormElement>('#tool-form')?.addEventListener('change', () => this.refreshPreview());
    this.shadowRoot?.querySelector<HTMLButtonElement>('#export-library')?.addEventListener('click', () => void this.exportLibrary());
    this.shadowRoot?.querySelector<HTMLButtonElement>('#reset-defaults')?.addEventListener('click', () => void this.resetDefaults());
    this.shadowRoot?.querySelector<HTMLButtonElement>('#add-offset')?.addEventListener('click', () => {
      this.offsetDrafts.push(this.newOffset());
      this.render();
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-remove-offset]').forEach((button) => {
      button.addEventListener('click', () => {
        this.offsetDrafts.splice(Number(button.dataset.removeOffset), 1);
        this.render();
      });
    });
    this.shadowRoot?.querySelector<HTMLButtonElement>('#save-offsets')?.addEventListener('click', () => this.saveOffsets());
    const fileInput = this.shadowRoot?.querySelector<HTMLInputElement>('#library-file');
    this.shadowRoot?.querySelector<HTMLButtonElement>('#import-library')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => void this.importLibrary(fileInput));
  }

  private updateGeometryVisibility(): void {
    const holderType = this.shadowRoot?.querySelector<HTMLSelectElement>('#holder-type')?.value ?? 'none';
    const cutterType = this.shadowRoot?.querySelector<HTMLSelectElement>('#cutting-type')?.value ?? 'none';
    this.shadowRoot?.querySelectorAll<HTMLElement>('[data-holder-fields]').forEach((element) => {
      element.hidden = !element.dataset.holderFields?.split(' ').includes(holderType);
    });
    this.shadowRoot?.querySelectorAll<HTMLElement>('[data-cutting-fields]').forEach((element) => {
      element.hidden = !element.dataset.cuttingFields?.split(' ').includes(cutterType);
    });
  }

  /** The preview element survives re-renders so its WebGL context is not recreated. */
  private mountPreview(): void {
    const slot = this.shadowRoot?.querySelector<HTMLElement>('#tool-preview-slot, #material-preview-slot');
    if (!slot) {
      this.previewElement = undefined;
      return;
    }
    if (!this.previewElement) {
      this.previewElement = document.createElement('nc-tool-preview') as NCToolPreview;
      this.previewElement.addEventListener('zero-vertex-pick', (event) => {
        const index = (event as CustomEvent<{ index: number }>).detail.index;
        const input = this.shadowRoot?.querySelector<HTMLInputElement | HTMLSelectElement>('#insert-zero-vertex, #material-zero');
        if (!input) return;
        input.value = String(index);
        this.refreshPreview();
      });
    }
    slot.replaceWith(this.previewElement);
    const wasMaterial = Boolean(this.previewElement.getMaterial());
    this.refreshPreview();
    if (!wasMaterial && this.previewElement.getMaterial()) this.previewElement.setView('3d');
  }

  private refreshPreview(): void {
    if (this.previewElement && this.shadowRoot?.querySelector('#material-form')) {
      try {
        this.materialDraft = this.buildMaterialFromForm();
        this.previewElement.setMaterial(this.materialDraft);
      } catch (cause) {
        this.previewElement.setMessage(cause instanceof Error ? cause.message : String(cause), true);
      }
      return;
    }
    if (!this.previewElement || !this.shadowRoot?.querySelector('#tool-form')) return;
    try {
      this.previewElement.setTool(this.buildToolFromForm(1));
    } catch (cause) {
      this.previewElement.setMessage(cause instanceof Error ? cause.message : String(cause), true);
    }
  }

  private buildToolFromForm(toolNumber: ToolIdentifier): ProgramToolDefinition {
    const query = <T extends HTMLElement>(selector: string) => this.shadowRoot?.querySelector<T>(selector) ?? null;
    const description = query<HTMLInputElement>('#tool-description')?.value.trim() ?? '';
    const Q = optionalNumber(query<HTMLInputElement>('#tool-q'));
    const R = optionalNumber(query<HTMLInputElement>('#tool-r'));
    const holderType = query<HTMLSelectElement>('#holder-type')?.value ?? 'none';
    const cuttingType = query<HTMLSelectElement>('#cutting-type')?.value ?? 'none';
    const holderTransform = this.readTransform('holder');
    const cuttingTransform = this.readTransform('cutting');
    const holder: HolderPart[] = [];
    const sourceTool = this.activeTab === 'library' ? this.libraryDraft : this.programDraft;
    if (holderType === 'cylinder') holder.push({ type: 'cylinder', diameter: requiredNumber(query('#holder-diameter')),
      length: requiredNumber(query('#holder-length')), ...holderTransform });
    if (holderType === 'box') holder.push({ type: 'box', width: requiredNumber(query('#holder-width')),
      height: requiredNumber(query('#holder-height')), length: requiredNumber(query('#holder-length')), ...holderTransform });
    if (holderType === 'cone') holder.push({ type: 'cone', startDiameter: requiredNumber(query('#holder-start-diameter')),
      endDiameter: requiredNumber(query('#holder-end-diameter')), length: requiredNumber(query('#holder-length')), ...holderTransform });
    if (holderType === 'profile' && sourceTool?.holder?.[0]?.type === 'profile') {
      holder.push(structuredClone(sourceTool.holder[0]));
    }
    if (holderType === 'turningHolderProfile' && sourceTool?.holder?.[0]?.type === 'turningHolderProfile') {
      const part = structuredClone(sourceTool.holder[0]) as HolderPart;
      delete part.position;
      delete part.rotation;
      holder.push({ ...part, ...holderTransform });
    }
    const stickOut = optionalNumber(query<HTMLInputElement>('#holder-stickout'));
    if (holder.length && stickOut !== undefined) holder[0].stickOut = stickOut;
    if (holderType !== 'none' && sourceTool?.holder && sourceTool.holder.length > 1) {
      holder.push(...structuredClone(sourceTool.holder.slice(1)));
    }
    const cutting: CuttingPart[] = [];
    if (cuttingType === 'drill') cutting.push({ type: 'drill', diameter: requiredNumber(query('#cutting-diameter')),
      length: requiredNumber(query('#cutting-length')), tipAngle: requiredNumber(query('#cutting-tip-angle')), ...cuttingTransform });
    if (cuttingType === 'endMill') cutting.push({ type: 'endMill', diameter: requiredNumber(query('#cutting-diameter')),
      length: requiredNumber(query('#cutting-length')), ...optionalField('cornerRadius', optionalNumber(query('#cutting-corner-radius'))), ...cuttingTransform });
    if (cuttingType === 'ballMill') cutting.push({ type: 'ballMill', diameter: requiredNumber(query('#cutting-diameter')),
      length: requiredNumber(query('#cutting-length')), ...cuttingTransform });
    if (cuttingType === 'insert') cutting.push({ type: 'insert', shape: query<HTMLSelectElement>('#insert-shape')!.value as InsertShape,
      ic: requiredNumber(query('#insert-ic')), thickness: requiredNumber(query('#insert-thickness')),
      noseRadius: requiredNumber(query('#insert-nose-radius')), clearanceAngle: requiredNumber(query('#insert-clearance')),
      ...optionalField('width', optionalNumber(query('#insert-width'))), ...optionalField('length', optionalNumber(query('#insert-length'))),
      ...optionalField('zeroVertex', optionalNumber(query('#insert-zero-vertex'))), ...cuttingTransform });
    if (cuttingType !== 'none' && sourceTool?.cutting && sourceTool.cutting.length > 1) {
      cutting.push(...structuredClone(sourceTool.cutting.slice(1)));
    }
    const orientation = this.readVector('tool-orientation-');
    const definition: ProgramToolDefinition = {
      toolNumber,
      description,
      ...optionalField('Q', Q),
      ...optionalField('R', R),
      ...(holder.length ? { holder } : {}),
      ...(cutting.length ? { cutting } : {}),
      ...(orientation.some((value) => value !== 0) ? { orientation } : {}),
      ...(sourceTool?.turning ? { turning: structuredClone(sourceTool.turning) } : {}),
    };
    validateProgramTool(definition);
    return definition;
  }

  private readTransform(prefix: string): { position?: Vector3; rotation?: Vector3 } {
    const position = this.readVector(`${prefix}-p`);
    const rotation = this.readVector(`${prefix}-r`);
    return {
      ...(position.some((value) => value !== 0) ? { position } : {}),
      ...(rotation.some((value) => value !== 0) ? { rotation } : {}),
    };
  }

  private readVector(prefix: string): Vector3 {
    return (['x', 'y', 'z'].map((axis) => optionalNumber(
      this.shadowRoot?.querySelector<HTMLInputElement>(`#${prefix}${axis}`) ?? null,
    ) ?? 0) as Vector3);
  }

  private readProgramIdentifier(): ToolIdentifier {
    const kind = this.shadowRoot?.querySelector<HTMLSelectElement>('#identifier-kind')?.value;
    const raw = this.shadowRoot?.querySelector<HTMLInputElement>('#tool-identifier')?.value.trim() ?? '';
    if (!raw) throw new Error('Tool identifier is required');
    if (kind === 'number') {
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Numeric tool identifier must be a nonnegative integer');
      return value;
    }
    return raw;
  }

  private async saveLibraryTool(): Promise<void> {
    try {
      const base = this.libraryDraft ?? this.newLibraryTool();
      const definition = this.buildToolFromForm(1);
      const tags = (this.shadowRoot?.querySelector<HTMLInputElement>('#tool-tags')?.value ?? '')
        .split(',').map((tag) => tag.trim()).filter(Boolean);
      const saved = await this.catalog.saveTool({
        id: base.id, revision: base.revision, description: definition.description, tags,
        createdAt: base.createdAt, updatedAt: base.updatedAt,
        ...optionalField('Q', definition.Q), ...optionalField('R', definition.R),
        ...(definition.holder ? { holder: definition.holder } : {}),
        ...(definition.cutting ? { cutting: definition.cutting } : {}),
        ...(definition.orientation ? { orientation: definition.orientation } : {}),
        ...(definition.turning ? { turning: definition.turning } : {}),
      });
      this.selectedLibraryId = saved.id;
      this.libraryDraft = saved;
      this.setStatus('Tool saved locally', 'success', false);
      await this.loadLibrary();
    } catch (cause) {
      this.setStatus(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  }

  private async deleteLibraryTool(): Promise<void> {
    if (!this.libraryDraft || this.libraryDraft.revision === 0) return;
    if (!window.confirm(`Delete ${this.libraryDraft.description || 'this tool'} from the local library?`)) return;
    try {
      await this.catalog.deleteTool(this.libraryDraft.id);
      this.selectedLibraryId = undefined;
      this.libraryDraft = undefined;
      this.setStatus('Tool deleted', 'success', false);
      await this.loadLibrary();
    } catch (cause) {
      this.setStatus(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  }

  private copyLibraryTool(): void {
    const id = this.shadowRoot?.querySelector<HTMLSelectElement>('#assign-library-tool')?.value;
    const selected = this.libraryTools.find((tool) => tool.id === id);
    if (!selected) {
      this.setStatus('Choose a library tool first', 'error');
      return;
    }
    const toolNumber = this.programDraft?.toolNumber ?? this.selectedProgramIdentifier ?? 1;
    this.programDraft = toProgramToolDefinition(selected, toolNumber);
    this.setStatus('Library geometry copied into the program draft', 'info', false);
    this.render();
  }

  private applyProgramTool(): void {
    try {
      if (!this.programSource) throw new Error('No active editor owns this program');
      const syntax = this.getSimulationCommentSyntax();
      if (!syntax) throw new Error('Selected machine has no safe simulation-comment capability');
      const tool = this.buildToolFromForm(this.readProgramIdentifier());
      const requestId = createId('tool-update');
      this.pendingRequestId = requestId;
      const request: ProgramToolUpdateRequest = {
        requestId,
        channelId: this.channelId,
        documentId: this.programSource.identity.documentId,
        programId: this.programSource.identity.programId,
        expectedRevision: this.programSource.revision,
        expectedText: this.programSource.text,
        syntax,
        tool,
      };
      this.setStatus('Applying tool metadata...', 'info');
      this.eventBus.publish(EVENT_NAMES.PROGRAM_TOOL_UPDATE_REQUEST, request);
      this.relayUpdateRequest('PROGRAM_TOOL_UPDATE_REQUEST', request);
    } catch (cause) {
      this.setStatus(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  }

  private async handleUpdateResult(result: ProgramToolUpdateResult): Promise<void> {
    if (!this.pendingRequestId || result.requestId !== this.pendingRequestId) return;
    this.pendingRequestId = undefined;
    this.setStatus(result.message, result.success ? 'success' : 'error', false);
    if (result.success) await this.loadProgram(false);
    this.render();
  }

  private async saveProgramCopy(): Promise<void> {
    try {
      const definition = this.buildToolFromForm(this.readProgramIdentifier());
      const now = Date.now();
      const saved = await this.catalog.saveTool({
        id: createId('tool'), revision: 0, description: definition.description,
        tags: ['from-program'], createdAt: now, updatedAt: now,
        ...optionalField('Q', definition.Q), ...optionalField('R', definition.R),
        ...(definition.holder ? { holder: definition.holder } : {}),
        ...(definition.cutting ? { cutting: definition.cutting } : {}),
        ...(definition.orientation ? { orientation: definition.orientation } : {}),
        ...(definition.turning ? { turning: definition.turning } : {}),
      });
      this.selectedLibraryId = saved.id;
      this.setStatus('Program tool copied to the local library', 'success', false);
      await this.loadLibrary(false);
      this.render();
    } catch (cause) {
      this.setStatus(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  }

  private async exportLibrary(): Promise<void> {
    try {
      const blob = new Blob([await this.catalog.exportLibrary()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'nc-edit7-tool-library.json';
      link.click();
      URL.revokeObjectURL(url);
      this.setStatus('Tool library exported', 'success');
    } catch (cause) {
      this.setStatus(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  }

  private async resetDefaults(): Promise<void> {
    if (!window.confirm('Reset all standard tools to default definitions? Your custom tools will be kept.')) return;
    try {
      await this.catalog.resetDefaults();
      this.selectedLibraryId = undefined;
      this.libraryDraft = undefined;
      this.setStatus('Standard tools reset to defaults', 'success', false);
      await this.loadLibrary();
    } catch (cause) {
      this.setStatus(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  }

  private async importLibrary(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    try {
      await this.catalog.importLibrary(await file.text());
      this.selectedLibraryId = undefined;
      this.libraryDraft = undefined;
      this.setStatus('Tool library imported', 'success', false);
      await this.loadLibrary();
    } catch (cause) {
      this.setStatus(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      input.value = '';
    }
  }

  private newOffset(): ToolOffsetValue {
    const used = new Set(this.offsetDrafts.map((offset) => offset.offsetNumber));
    let offsetNumber = 1;
    while (used.has(offsetNumber)) offsetNumber++;
    const policy = this.stateService.getState().activeMachine?.toolSelection;
    return {
      offsetNumber,
      ...(policy?.offsetScope === 'tool'
        ? { toolNumber: this.selectedProgramIdentifier ?? this.detectedIdentifiers[0] ?? 1 }
        : {}),
      rValue: 0,
    };
  }

  private readOffsets(): ToolOffsetValue[] {
    const policy = this.stateService.getState().activeMachine?.toolSelection;
    if (!policy) throw new Error('Selected machine has no tool-offset policy');
    return Array.from(this.shadowRoot?.querySelectorAll<HTMLElement>('[data-offset-row]') ?? []).map((row) => {
      const input = (field: string) => row.querySelector<HTMLInputElement>(`[data-offset-field="${field}"]`);
      const offsetNumber = requiredNumber(input('number'));
      const qValue = optionalNumber(input('q'));
      const rValue = optionalNumber(input('r'));
      const lengthValue = optionalNumber(input('length'));
      const edgeNumber = optionalNumber(input('edge'));
      let toolNumber: ToolIdentifier | undefined;
      if (policy.offsetScope === 'tool') {
        const raw = input('tool')?.value.trim() ?? '';
        if (!raw) throw new Error('Tool identifier is required for this machine');
        const kind = row.querySelector<HTMLSelectElement>('[data-offset-field="tool-kind"]')?.value;
        if (kind === 'number') {
          const numeric = Number(raw);
          if (!Number.isSafeInteger(numeric) || numeric < 0) {
            throw new Error('Numeric tool identifier must be a nonnegative integer');
          }
          toolNumber = numeric;
        } else toolNumber = raw;
      }
      return {
        offsetNumber,
        ...(toolNumber === undefined ? {} : { toolNumber }),
        ...optionalField('qValue', qValue),
        ...optionalField('rValue', rValue),
        ...optionalField('lengthValue', lengthValue),
        ...optionalField('edgeNumber', edgeNumber),
      };
    });
  }

  private saveOffsets(): void {
    try {
      if (!this.programSource) throw new Error('No active program owns this offset table');
      const machine = this.stateService.getState().activeMachine;
      const policy = machine?.toolSelection;
      if (!policy) throw new Error('Selected machine has no tool-offset policy');
      if (!machine.simulationCommentSyntax) {
        throw new Error('Selected machine has no safe simulation-comment capability');
      }
      const syntax = this.getSimulationCommentSyntax();
      if (!syntax) {
        throw new Error('Selected machine has no safe simulation-comment capability');
      }
      const offsets = this.readOffsets();
      this.programTools.setTemporaryToolOffsets(this.programSource.identity, policy, offsets);
      this.offsetDrafts = this.programTools.getTemporaryToolOffsets(this.programSource.identity);
      this.eventBus.publish(EVENT_NAMES.PROGRAM_TOOL_OFFSETS_CHANGED, {
        identity: this.programSource.identity,
        offsets: structuredClone(this.offsetDrafts),
      });
      const requestId = createId('offset-update');
      this.pendingRequestId = requestId;
      const request: ProgramOffsetsUpdateRequest = {
        requestId,
        channelId: this.channelId,
        documentId: this.programSource.identity.documentId,
        programId: this.programSource.identity.programId,
        expectedRevision: this.programSource.revision,
        expectedText: this.programSource.text,
        syntax,
        offsets: { offsetScope: policy.offsetScope, offsets: structuredClone(this.offsetDrafts) },
      };
      this.setStatus('Applying offset metadata...', 'info');
      this.eventBus.publish(EVENT_NAMES.PROGRAM_OFFSETS_UPDATE_REQUEST, request);
      this.relayUpdateRequest('PROGRAM_OFFSETS_UPDATE_REQUEST', request);
    } catch (cause) {
      this.setStatus(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  }

  private relayUpdateRequest(type: string, payload: unknown): void {
    const win = window as any;
    if (win.vscodeApi && typeof win.vscodeApi.postMessage === 'function') {
      win.vscodeApi.postMessage({ type, payload });
    }
  }

  private setStatus(message: string, kind: 'info' | 'success' | 'error', render = true): void {
    this.status = message;
    this.statusKind = kind;
    if (render) this.render();
  }

  private toolSummary(tool: LibraryToolDefinition): string {
    const cutter = tool.cutting?.[0];
    if (!cutter) return 'Q/R only';
    if ('diameter' in cutter) return `${cutter.type} - diameter ${cutter.diameter} mm`;
    return `${cutter.type} ${cutter.shape} - IC ${cutter.ic} mm`;
  }

  private formatIdentifier(identifier: ToolIdentifier): string {
    return typeof identifier === 'number' ? `T${identifier}` : `Named: ${identifier}`;
  }

  private option(value: string, label: string, selected?: string): string {
    return `<option value="${this.escape(value)}" ${value === selected ? 'selected' : ''}>${this.escape(label)}</option>`;
  }

  private escape(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  private get styles(): string {
    return `
      :host { display:block; width:100%; height:100%; min-height:0; color:var(--vscode-editor-foreground,#24292f); background:var(--vscode-editor-background,#fff); font-family:var(--vscode-font-family,"Segoe UI",sans-serif); }
      * { box-sizing:border-box; }
      button,input,select,summary { font:inherit; letter-spacing:0; }
      .manager-shell { display:grid; grid-template-rows:auto auto minmax(0,1fr) auto; height:100%; min-height:0; }
      .manager-header { display:flex; justify-content:space-between; gap:12px; align-items:center; padding:12px; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); background:var(--vscode-editorGroupHeader-tabsBackground,#f6f8fa); }
      h2,h3,p { margin:0; } h2 { font-size:16px; } h3 { font-size:12px; } p,.section-heading span { margin-top:3px; color:var(--vscode-descriptionForeground,#57606a); font-size:11px; }
      .channel-control { min-width:90px; }
      label { display:flex; flex-direction:column; gap:4px; color:var(--vscode-descriptionForeground,#57606a); font-size:11px; }
      input,select { width:100%; min-width:0; padding:6px 7px; border:1px solid var(--vscode-input-border,#d0d7de); border-radius:3px; color:var(--vscode-input-foreground,#24292f); background:var(--vscode-input-background,#fff); }
      input:focus,select:focus { outline:1px solid var(--vscode-focusBorder,#0969da); border-color:var(--vscode-focusBorder,#0969da); }
      .manager-tabs { display:flex; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); background:var(--vscode-editorGroupHeader-tabsBackground,#f6f8fa); }
      .manager-tab { flex:1; padding:9px; border:0; border-top:2px solid transparent; background:transparent; color:inherit; cursor:pointer; }
      .manager-tab.active { border-top-color:var(--vscode-tab-activeBorderTop,#0969da); background:var(--vscode-tab-activeBackground,#fff); font-weight:600; }
      .manager-body { display:grid; grid-template-columns:minmax(145px,35%) minmax(220px,65%); min-height:0; overflow:hidden; }
      .tool-list-pane,.tool-editor-pane { min-height:0; overflow:hidden; display:flex; flex-direction:column; }
      .tool-list-pane { border-right:1px solid var(--vscode-editorGroup-border,#d0d7de); background:var(--vscode-sideBar-background,#f6f8fa); }
      .tool-editor-pane { overflow:auto; }
      .material-editor-pane { grid-column:1 / -1; grid-row:1 / -1; }
      .list-toolbar,.library-actions,.program-source { display:grid; gap:7px; padding:9px; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); }
      .library-actions { grid-template-columns:1fr 1fr; margin-top:auto; border-top:1px solid var(--vscode-editorGroup-border,#d0d7de); border-bottom:0; }
      .program-source { margin-top:auto; color:var(--vscode-descriptionForeground,#57606a); font-size:10px; overflow-wrap:anywhere; }
      .tool-list { overflow:auto; min-height:0; }
      .tool-row { display:flex; flex-direction:column; gap:3px; width:100%; padding:9px; border:0; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); color:inherit; background:transparent; text-align:left; cursor:pointer; }
      .tool-row:hover { background:var(--vscode-list-hoverBackground,#f3f4f6); }
      .tool-row.active { padding-left:6px; border-left:3px solid var(--vscode-focusBorder,#0969da); background:var(--vscode-tab-activeBackground,#fff); }
      .tool-name { font-size:12px; font-weight:600; overflow-wrap:anywhere; }
      .tool-meta,.section-label { color:var(--vscode-descriptionForeground,#57606a); font-size:10px; }
      .tool-meta.complete { color:#2f8f4e; }
      .tool-form { display:flex; flex-direction:column; gap:0; }
      .offset-editor-pane { grid-column:1 / -1; min-height:0; overflow:auto; display:flex; flex-direction:column; }
      .simulation-pane { grid-column:1 / -1; min-height:0; overflow:auto; }
      .simulation-fields { padding-top:8px; } .simulation-fields div { display:grid; gap:3px; min-width:0; } .simulation-fields span,.simulation-row span { color:var(--vscode-descriptionForeground,#57606a); font-size:11px; } .simulation-fields strong,.simulation-row strong { overflow-wrap:anywhere; font-size:12px; } .available { color:#2f8f4e; } .unavailable { color:#b7791f; }
      .simulation-list { display:grid; gap:1px; border:1px solid var(--vscode-editorGroup-border,#d0d7de); } .simulation-row { display:grid; grid-template-columns:minmax(120px,1fr) minmax(160px,2fr) minmax(140px,2fr); gap:8px; padding:8px; background:var(--vscode-editor-background,#fff); }
      .offset-header { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:12px; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); }
      .offset-table { display:grid; gap:1px; background:var(--vscode-editorGroup-border,#d0d7de); }
      .offset-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(90px,1fr)) 32px; gap:8px; align-items:end; padding:9px; background:var(--vscode-editor-background,#fff); }
      .icon-button { width:30px; height:30px; border:1px solid var(--vscode-widget-border,#d0d7de); border-radius:3px; color:inherit; background:var(--vscode-button-secondaryBackground,#eaeef2); cursor:pointer; font-size:18px; }
      section { display:grid; gap:9px; padding:12px; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); }
      .section-heading { display:flex; justify-content:space-between; align-items:baseline; gap:8px; }
      .field-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
      .transform-grid { grid-template-columns:repeat(3,minmax(0,1fr)); padding-top:8px; }
      details { color:var(--vscode-descriptionForeground,#57606a); font-size:11px; }
      summary { cursor:pointer; }
      [hidden] { display:none !important; }
      .assign-bar { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:7px; padding:9px; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); background:var(--vscode-editorGroupHeader-tabsBackground,#f6f8fa); }
      .button { min-height:30px; padding:6px 9px; border:1px solid var(--vscode-widget-border,#d0d7de); border-radius:3px; color:var(--vscode-button-secondaryForeground,#24292f); background:var(--vscode-button-secondaryBackground,#eaeef2); cursor:pointer; }
      .button.primary { border-color:var(--vscode-button-background,#0969da); color:var(--vscode-button-foreground,#fff); background:var(--vscode-button-background,#0969da); }
      .button.danger { color:var(--vscode-inputValidation-errorForeground,#fff); background:var(--vscode-inputValidation-errorBackground,#a40e26); }
      .button:disabled { opacity:.45; cursor:not-allowed; }
      .form-actions { display:flex; justify-content:flex-end; gap:8px; padding:10px 12px; position:sticky; bottom:0; border-top:1px solid var(--vscode-editorGroup-border,#d0d7de); background:var(--vscode-editorGroupHeader-tabsBackground,#f6f8fa); }
      .notice,.empty { margin:10px; padding:10px; border:1px solid var(--vscode-widget-border,#d0d7de); font-size:11px; line-height:1.45; color:var(--vscode-descriptionForeground,#57606a); }
      .notice.warning { border-left:3px solid #b7791f; } .notice.error { border-left:3px solid #cf222e; }
      .status { min-height:30px; padding:7px 10px; border-top:1px solid var(--vscode-editorGroup-border,#d0d7de); color:var(--vscode-descriptionForeground,#57606a); font-size:11px; }
      .status.success { color:#2f8f4e; } .status.error { color:var(--vscode-inputValidation-errorBackground,#cf222e); }
      @media (max-width:700px) { .manager-body { grid-template-columns:1fr; grid-template-rows:minmax(145px,32%) minmax(0,68%); } .tool-list-pane { border-right:0; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); } .manager-header { padding:9px; } .manager-header p { display:none; } .transform-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    `;
  }
}

function optionalField<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: V };
}

customElements.define('nc-tool-manager-panel', NCToolManagerPanel);
