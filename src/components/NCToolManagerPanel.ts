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
  ProgramMaterialChannelReference,
  ProgramMaterialChannelReferences,
  ProgramMaterialDefinition,
  ProgramSetupDefinition,
  ToolIdentifier,
  Vector3,
} from '@services/tools/SimulationMetadata';
import { validateProgramMaterial, validateProgramTool } from '@services/tools/SimulationMetadata';
import {
  channelMaterial,
  getChannelMaterialReference,
  hasDistinctChannelReference,
  pickupChannelMaterialReference,
} from '@services/simulation/shared/SimulationTransforms';
import type { LibraryToolDefinition } from '@services/tools/ToolLibraryTypes';
import { toProgramToolDefinition } from '@services/tools/ToolLibraryTypes';
import {
  buildToolFromTemplateConfig,
  inferToolTemplateConfig,
  MATERIAL_DEFINITION_TEMPLATES,
  QUICK_BLADE_WIDTHS_MM,
  QUICK_BORE_DEPTHS_MM,
  QUICK_BORE_DIAMETERS_MM,
  QUICK_DRILL_DIAMETERS_MM,
  QUICK_MILL_DIAMETERS_MM,
  QUICK_NOSE_RADII_MM,
  QUICK_PLATE_SIZES_MM,
  QUICK_STOCK_DIAMETERS_MM,
  QUICK_STOCK_LENGTHS_MM,
  QUICK_TURNING_SHAPES,
  recommendLibraryToolId,
  TOOL_TEMPLATE_ARCHETYPES,
  type AxialToolMount,
  type BoringWallSide,
  type GrooveOperationKind,
  type MaterialTemplateId,
  type MillCutterKind,
  type ToolTemplateArchetypeId,
  type ToolTemplateConfig,
  type TurningPresetId,
} from '@services/tools/DefaultToolLibrary';
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
  private activeTab: ManagerTab = 'program';
  private channelId: ChannelId = '1';
  private materialReferenceChannel: ChannelId = '1';
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
  private mobileListOpen = false;
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
    this.materialReferenceChannel = this.channelId;
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
        if (data.channelId === this.channelId) {
          this.pendingRequestId = undefined;
          void this.loadProgram();
        }
      }),
      this.eventBus.subscribe('program:content_changed', (data: { channelId: string }) => {
        if (data.channelId === this.channelId) {
          this.pendingRequestId = undefined;
          void this.loadProgram();
        }
      }),
      this.eventBus.subscribe(EVENT_NAMES.MACHINE_CHANGED, () => void this.loadProgram()),
      this.eventBus.subscribe(EVENT_NAMES.PARSE_COMPLETED, (data: { channelId: string; artifacts: ParseArtifacts }) => {
        if (data.channelId !== this.channelId) return;
        this.detectedIdentifiers = this.uniqueIdentifiers([
          ...data.artifacts.toolRegisters.map((tool) => tool.toolNumber),
          ...this.programDefinitions.map((tool) => tool.toolNumber),
        ]);
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
        this.materialReferenceChannel = this.channelId;
        this.selectedProgramKey = undefined;
      }
      this.pendingRequestId = undefined;
      void this.loadProgram();
    };
    window.addEventListener('vscode:files-opened', this.hostChannelListener);

    this.hostMessageListener = (event: MessageEvent) => {
      const data = event.data;
      if (
        data?.type === 'PROGRAM_TOOL_UPDATE_RESULT' ||
        data?.type === 'PROGRAM_OFFSETS_UPDATE_RESULT' ||
        data?.type === 'PROGRAM_SETUP_UPDATE_RESULT' ||
        data?.type === EVENT_NAMES.PROGRAM_TOOL_UPDATE_RESULT ||
        data?.type === EVENT_NAMES.PROGRAM_OFFSETS_UPDATE_RESULT ||
        data?.type === EVENT_NAMES.PROGRAM_SETUP_UPDATE_RESULT
      ) {
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
    this.materialDraft = this.resolveSharedMaterialDraft(machine?.simulationCommentSyntax);
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

  private readProgramSource(channelId: ChannelId = this.channelId): ProgramSource | undefined {
    const pane = document.querySelector(
      `nc-channel-pane[data-channel="${channelId}"] nc-code-pane`,
    ) as (HTMLElement & { getProgramSource(): ProgramSource | undefined }) | null;
    if (pane) {
      return pane.getProgramSource();
    }
    const program = this.fileManager?.getActiveProgram(channelId);
    if (program) {
      return {
        identity: {
          channelId,
          documentId: 'external',
          programId: program.id || program.name || `Channel ${channelId}`,
        },
        revision: 'external',
        text: program.content,
      };
    }
    return undefined;
  }

  private resolveSharedMaterialDraft(
    syntax = this.getSimulationCommentSyntax(),
  ): ProgramMaterialDefinition {
    const byChannel = new Map<ChannelId, ProgramMaterialDefinition>();
    if (this.programSnapshot?.setup?.material) {
      byChannel.set(
        this.channelId,
        structuredClone(this.programSnapshot.setup.material) as ProgramMaterialDefinition,
      );
    }
    if (syntax) {
      for (const ch of CHANNELS) {
        if (byChannel.has(ch)) continue;
        const source = this.readProgramSource(ch);
        if (!source?.text.trim()) continue;
        try {
          const snap = this.programTools.captureProgramSnapshot(
            source.identity,
            source.revision,
            source.text,
            syntax,
          );
          if (snap.valid && snap.setup?.material) {
            byChannel.set(ch, structuredClone(snap.setup.material) as ProgramMaterialDefinition);
          }
        } catch {
          // Ignore invalid snapshots on other channels while resolving draft
        }
      }
    }
    const base =
      byChannel.get(this.channelId) ??
      byChannel.get('1') ??
      byChannel.get('2') ??
      byChannel.get('3');
    if (!base) {
      return { type: 'cylinder', diameter: 20, length: 100, zeroVertex: 1 };
    }
    const primary = byChannel.get('1') ?? base;
    const channelReferences: ProgramMaterialChannelReferences = {
      ...(base.channelReferences ? structuredClone(base.channelReferences) : {}),
    };
    for (const ch of ['2', '3'] as const) {
      if (channelReferences[ch]) continue;
      const candidate = byChannel.get(ch);
      if (!candidate || candidate.type !== primary.type) continue;
      const refCandidate = getChannelMaterialReference(candidate, ch);
      const merged: ProgramMaterialDefinition = {
        ...primary,
        channelReferences: { ...channelReferences, [ch]: refCandidate },
      };
      if (hasDistinctChannelReference(merged, ch)) {
        channelReferences[ch] = refCandidate;
      }
    }
    return {
      ...primary,
      ...(Object.keys(channelReferences).length ? { channelReferences } : {}),
    };
  }

  private hasPersistedMaterial(): boolean {
    if (this.programSnapshot?.setup?.material) return true;
    const syntax = this.getSimulationCommentSyntax();
    if (!syntax) return false;
    for (const ch of CHANNELS) {
      if (ch === this.channelId) continue;
      const source = this.readProgramSource(ch);
      if (!source?.text.trim()) continue;
      try {
        const snap = this.programTools.captureProgramSnapshot(
          source.identity,
          source.revision,
          source.text,
          syntax,
        );
        if (snap.valid && snap.setup?.material) return true;
      } catch {
        // Ignore
      }
    }
    return false;
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
        <div class="manager-topbar">
          <h2 class="sr-only">Tool Manager</h2>
          <nav class="manager-tabs" aria-label="Tool manager views">
            <button class="manager-tab ${this.activeTab === 'program' ? 'active' : ''}" data-manager-tab="program">Program Tools</button>
            <button class="manager-tab ${this.activeTab === 'library' ? 'active' : ''}" data-manager-tab="library">Library</button>
            <button class="manager-tab ${this.activeTab === 'material' ? 'active' : ''}" data-manager-tab="material">Raw Material</button>
            <button class="manager-tab ${this.activeTab === 'offsets' ? 'active' : ''}" data-manager-tab="offsets">Offsets</button>
            <button class="manager-tab ${this.activeTab === 'simulation' ? 'active' : ''}" data-manager-tab="simulation">Simulation</button>
          </nav>
          <div class="channel-control">
            <label for="manager-channel" class="sr-only">Channel</label>
            <select id="manager-channel" title="Active channel">${CHANNELS.map((channel) =>
              `<option value="${channel}" ${channel === this.channelId ? 'selected' : ''}>CH ${channel}</option>`).join('')}</select>
          </div>
        </div>
        <div class="manager-body">
          ${this.activeTab === 'library' ? this.renderLibrary() :
            this.activeTab === 'program' ? this.renderProgram() :
              this.activeTab === 'material' ? this.renderMaterial() :
              this.activeTab === 'offsets' ? this.renderOffsets() : this.renderSimulation()}
        </div>
        <div id="manager-status" class="status ${this.statusKind}" role="status" aria-live="polite" ${!this.status ? 'hidden' : ''}>${this.escape(this.status)}</div>
      </div>
    `;
    this.attachListeners();
    this.mountPreview();
    this.updateGeometryVisibility();
  }

  private renderLibrary(): string {
    const draft = this.libraryDraft;
    return `
      <aside class="tool-list-pane ${this.mobileListOpen ? 'mobile-open' : ''}">
        <div class="list-toolbar">
          <input id="tool-search" type="search" placeholder="Search tools" value="${this.escape(this.search)}">
          <button class="button primary" id="new-library-tool" title="Create tool">+ New</button>
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
          <button class="button" id="reset-defaults" title="Reset standard tools to latest defaults">Reset</button>
          <input id="library-file" type="file" accept="application/json,.json" hidden>
        </div>
      </aside>
      <main class="tool-editor-pane">
        <div class="mobile-drawer-bar">
          <button type="button" class="button" id="toggle-mobile-list" aria-expanded="${this.mobileListOpen}">
            ${this.mobileListOpen ? 'Hide Library List' : `Browse Library (${this.libraryTools.length})`}
          </button>
          <button type="button" class="button primary" id="mobile-new-library-tool">+ New Tool</button>
        </div>
        ${draft ? this.renderToolForm(draft, 'library') : '<div class="empty">Select or create a library tool.</div>'}
      </main>`;
  }

  private renderLibraryOptions(recommendedId?: string): string {
    const groups: { label: string; items: LibraryToolDefinition[] }[] = [
      { label: 'Recommended for Station', items: [] },
      { label: 'Custom / Saved Tools', items: [] },
      { label: 'Turning & Boring Inserts', items: [] },
      { label: 'Cut-Off & Grooving', items: [] },
      { label: 'Drills', items: [] },
      { label: 'End Mills & Ball Mills', items: [] },
      { label: 'Other / Empty', items: [] },
    ];
    for (const tool of this.libraryTools) {
      if (recommendedId && tool.id === recommendedId) {
        groups[0].items.push(tool);
        continue;
      }
      if (!tool.id.startsWith('default-')) {
        groups[1].items.push(tool);
        continue;
      }
      const cutter = tool.cutting?.[0];
      if (!cutter) {
        groups[6].items.push(tool);
      } else if (cutter.type === 'insert') {
        if (cutter.shape === 'L') groups[3].items.push(tool);
        else groups[2].items.push(tool);
      } else if (cutter.type === 'drill') {
        groups[4].items.push(tool);
      } else {
        groups[5].items.push(tool);
      }
    }
    return groups
      .filter((group) => group.items.length > 0)
      .map(
        (group) =>
          `<optgroup label="${this.escape(group.label)}">${group.items
            .map(
              (tool) =>
                `<option value="${this.escape(tool.id)}" ${tool.id === recommendedId ? 'selected' : ''}>${this.escape(tool.description || 'Unnamed tool')}</option>`,
            )
            .join('')}</optgroup>`,
      )
      .join('');
  }

  private renderProgram(): string {
    const syntax = this.getSimulationCommentSyntax();
    const diagnostic = this.programSnapshot?.diagnostics.map((item) => item.message).join('; ');
    const selectedId = this.selectedProgramIdentifier;
    const isAssigned =
      selectedId !== undefined &&
      this.programDefinitions.some((tool) => exactKey(tool.toolNumber) === exactKey(selectedId));
    return `
      <main class="tool-editor-pane program-full-pane">
        <div class="station-header-bar" role="toolbar" aria-label="Program tool stations">
          <div class="station-pills">
            ${this.detectedIdentifiers.length ? this.detectedIdentifiers.map((identifier) => {
              const key = exactKey(identifier);
              const assigned = this.programDefinitions.some((tool) => exactKey(tool.toolNumber) === key);
              return `<button type="button" class="station-pill ${key === this.selectedProgramKey ? 'active' : ''} ${assigned ? 'assigned' : ''}" data-program-key="${this.escape(key)}" title="${assigned ? 'Managed metadata' : 'Detected, not assigned'}">
                <span class="tool-name">${this.escape(this.formatIdentifier(identifier))}</span>
                <span class="station-dot" aria-hidden="true">${assigned ? '✓' : '•'}</span>
              </button>`;
            }).join('') : '<span class="station-empty">No tool calls detected</span>'}
            <button type="button" class="station-pill add-pill" id="new-program-tool" title="Create a new tool assignment">+ New</button>
          </div>
          ${selectedId !== undefined ? `<span class="tool-meta ${isAssigned ? 'complete' : ''}">${isAssigned ? 'Managed metadata' : 'Detected, not assigned'}</span>` : ''}
        </div>
        ${!syntax ? '<div class="notice warning">The selected machine does not advertise a safe simulation-comment syntax. Library editing works, but Apply to Program is disabled.</div>' : ''}
        ${diagnostic ? `<div class="notice error">${this.escape(diagnostic)}</div>` : ''}
        ${this.programDraft ? `
          <div class="assign-bar">
            <select id="assign-library-tool" aria-label="Choose library tool">
              <option value="">Choose library preset...</option>
              ${this.renderLibraryOptions(recommendLibraryToolId(this.programDraft.toolNumber))}
            </select>
            <button class="button" type="button" id="copy-library-tool" title="Copy geometry from library into form">Use Library Geometry</button>
            <button class="button primary" type="button" id="assign-and-apply-tool" ${!this.canApplyProgram ? 'disabled' : ''} title="Copy selected library geometry and apply immediately to the NC program">Assign &amp; Apply</button>
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

  private formatChannelMaterialSummary(
    material: ProgramMaterialDefinition,
    channelId: ChannelId,
  ): string {
    if (channelId !== '1' && !hasDistinctChannelReference(material, channelId)) {
      return 'Same reference as CH 1';
    }
    const ref = getChannelMaterialReference(material, channelId);
    const zeroLabel =
      ref.zeroVertex === undefined
        ? 'Centre'
        : material.type === 'cylinder'
          ? `End ${ref.zeroVertex} (${ref.zeroVertex ? '+Z' : '-Z'} face)`
          : `Corner ${ref.zeroVertex} (${ref.zeroVertex & 1 ? '+X' : '-X'}, ${ref.zeroVertex & 2 ? '+Y' : '-Y'}, ${ref.zeroVertex & 4 ? '+Z' : '-Z'})`;
    const parts = [zeroLabel];
    const pos = ref.position ?? [0, 0, 0];
    if (pos.some((v) => v !== 0)) {
      parts.push(`Pos [${pos.join(', ')}]`);
    }
    const rot = ref.rotation ?? [0, 0, 0];
    if (rot.some((v) => v !== 0)) {
      const rxNorm = ((rot[0] % 360) + 360) % 360;
      const ryNorm = ((rot[1] % 360) + 360) % 360;
      const oppositeZ =
        (Math.abs(rxNorm - 180) < 1e-6 && Math.abs(ryNorm) < 1e-6) ||
        (Math.abs(ryNorm - 180) < 1e-6 && Math.abs(rxNorm) < 1e-6);
      parts.push(`Rot [${rot.join('°, ')}°]${oppositeZ ? ' (Opposite Z)' : ''}`);
    }
    return parts.join(' · ');
  }

  private updateMaterialChannelCards(): void {
    const material = this.materialDraft;
    if (!material || !this.shadowRoot) return;
    for (const ch of CHANNELS) {
      const summary = this.shadowRoot.querySelector<HTMLElement>(`[data-material-summary="${ch}"]`);
      if (summary) {
        summary.textContent = this.formatChannelMaterialSummary(material, ch);
      }
    }
  }

  private isMatchingMaterialTemplate(
    material: ProgramMaterialDefinition,
    candidate: ProgramMaterialDefinition,
  ): boolean {
    if (material.type !== candidate.type) return false;
    if ((material.zeroVertex ?? 1) !== (candidate.zeroVertex ?? 1)) return false;
    const hasCh2 = Boolean(material.channelReferences?.['2']);
    const candHasCh2 = Boolean(candidate.channelReferences?.['2']);
    if (hasCh2 !== candHasCh2) return false;
    if (material.type === 'cylinder' && candidate.type === 'cylinder') {
      return material.diameter === candidate.diameter && material.length === candidate.length;
    }
    if (material.type === 'box' && candidate.type === 'box') {
      return (
        material.width === candidate.width &&
        material.height === candidate.height &&
        material.depth === candidate.depth
      );
    }
    return false;
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
    const activeCh = this.materialReferenceChannel;
    const activeRef = getChannelMaterialReference(material, activeCh);
    const hasPersisted = this.hasPersistedMaterial();
    return `<main class="tool-editor-pane material-editor-pane">
      ${!syntax ? '<div class="notice warning">The selected machine does not advertise a safe simulation-comment syntax. Apply to Program is disabled.</div>' : ''}
      ${diagnostic ? `<div class="notice error">${this.escape(diagnostic)}</div>` : ''}
      <form id="material-form" class="tool-form">
        <div class="form-workspace-grid">
          <div class="form-controls-col">
            <section class="template-configurator-section">
              <div class="section-heading">
                <h3>Material Templates</h3>
                <span>1-tap stock &amp; channel setup</span>
              </div>
              <div class="template-pill-strip" role="group" aria-label="Material definition templates">
                ${MATERIAL_DEFINITION_TEMPLATES.map((tpl) => {
                  const active = this.isMatchingMaterialTemplate(material, tpl.material);
                  return `<button type="button" class="template-pill ${active ? 'active' : ''}" data-material-template="${this.escape(tpl.id)}" title="${this.escape(`${tpl.summary} (${tpl.badge})`)}">
                    <span class="template-card-title">${this.escape(tpl.label)}</span>
                    <span class="template-card-badge">${this.escape(tpl.badge)}</span>
                  </button>`;
                }).join('')}
              </div>
            </section>
            <section>
              <div class="section-heading"><h3>Stock Dimensions</h3><span>Shared workpiece (mm)</span></div>
              <div class="field-grid stock-dims-grid">
                <label>Shape<select id="material-type">${this.option('cylinder', 'Round stock', material.type)}${this.option('box', 'Plate / block', material.type)}</select></label>
                ${dimensions.map(([key, label]) => `<label>${label}<input id="material-${key}" type="number" min="0" step="any" value="${values[key]}"></label>`).join('')}
              </div>
              ${material.type === 'cylinder' ? `
                <div class="quick-config-group">
                  <div class="quick-config-row">
                    <span class="quick-config-label">Ø (mm)</span>
                    <div class="chip-row">
                      ${QUICK_STOCK_DIAMETERS_MM.map((dia) => `<button type="button" class="pill-button ${material.diameter === dia ? 'active' : ''}" data-material-quick-diameter="${dia}">Ø${dia}</button>`).join('')}
                    </div>
                  </div>
                  <div class="quick-config-row">
                    <span class="quick-config-label">Length</span>
                    <div class="chip-row">
                      ${QUICK_STOCK_LENGTHS_MM.map((len) => `<button type="button" class="pill-button ${material.length === len ? 'active' : ''}" data-material-quick-length="${len}">${len}</button>`).join('')}
                    </div>
                  </div>
                </div>
              ` : `
                <div class="quick-config-group">
                  <div class="quick-config-row">
                    <span class="quick-config-label">Size</span>
                    <div class="chip-row">
                      ${QUICK_PLATE_SIZES_MM.map((sz) => {
                        const isCurrent = material.width === sz.width && material.depth === sz.depth && material.height === sz.height;
                        return `<button type="button" class="pill-button ${isCurrent ? 'active' : ''}" data-material-quick-box="${sz.width},${sz.height},${sz.depth}">${this.escape(sz.label)}</button>`;
                      }).join('')}
                    </div>
                  </div>
                </div>
              `}
            </section>
            <section>
              <div class="section-heading"><h3>Channel Reference &amp; Z Direction</h3><span>Zero point per channel</span></div>
              <div class="material-channel-grid" role="tablist" aria-label="Channel coordinate references">
                ${CHANNELS.map((ch) => `
                  <button type="button" class="material-channel-card ${ch === activeCh ? 'active' : ''}" data-material-channel="${ch}" role="tab" aria-selected="${ch === activeCh}">
                    <span class="material-channel-title">CH ${ch}${ch === '1' ? ' (Main)' : ch === '2' ? ' (Sub)' : ''}</span>
                    <span class="material-channel-meta" data-material-summary="${ch}">${this.escape(this.formatChannelMaterialSummary(material, ch))}</span>
                  </button>
                `).join('')}
              </div>
              <div class="material-preset-bar">
                ${activeCh === '1' ? `
                  <button class="button" type="button" id="material-preset-pickup-ch2" title="Set Channel 2 zero to the opposite side of the raw material and rotate 180° so Z looks in the other direction">Set CH 2 Pick-up (Opposite &amp; Flip Z)</button>
                  <button class="button" type="button" id="material-preset-flip-z" title="Rotate CH 1 coordinate system by 180° around X so Z points in the opposite direction">Flip CH 1 Z (180°)</button>
                ` : `
                  <button class="button" type="button" id="material-preset-pickup" title="Set CH ${activeCh} zero to the opposite side of the raw material and rotate 180° so Z looks in the other direction">Opposite Side &amp; Flip Z (Pick-up)</button>
                  <button class="button" type="button" id="material-preset-flip-z" title="Rotate CH ${activeCh} coordinate system by 180° around X so Z points in the opposite direction">Flip Z (180°)</button>
                  <button class="button" type="button" id="material-preset-same-ch1" title="Use the same zero point and orientation as Channel 1">Same as CH 1</button>
                `}
              </div>
              <label>Zero point (CH ${activeCh})<select id="material-zero">
                ${this.option('', 'Centre (legacy placement)', activeRef.zeroVertex === undefined ? '' : String(activeRef.zeroVertex))}
                ${Array.from({ length: material.type === 'cylinder' ? 2 : 8 }, (_, index) => this.option(
                  String(index), material.type === 'cylinder' ? `End ${index}: ${index ? '+Z' : '-Z'} face centre` :
                    `Corner ${index}: ${index & 1 ? '+X' : '-X'}, ${index & 2 ? '+Y' : '-Y'}, ${index & 4 ? '+Z' : '-Z'}`,
                  activeRef.zeroVertex === undefined ? '' : String(activeRef.zeroVertex),
                )).join('')}
              </select></label>
              <details class="form-accordion">
                <summary>Offset position &amp; rotation (CH ${activeCh})</summary>
                <div class="field-grid transform-grid">${['x', 'y', 'z'].map((axis, index) => `<label>Position ${axis.toUpperCase()}<input id="material-p${axis}" type="number" step="any" value="${activeRef.position?.[index] ?? 0}"></label>`).join('')}</div>
                <div class="field-grid transform-grid">${['x', 'y', 'z'].map((axis, index) => `<label>Rotation ${axis.toUpperCase()}<input id="material-r${axis}" type="number" step="any" value="${activeRef.rotation?.[index] ?? 0}"></label>`).join('')}</div>
              </details>
            </section>
          </div>
          <div class="form-preview-col">
            <section class="preview-section">
              <div class="section-heading"><h3>Live Stock Preview</h3><span>Click end-face or corner for CH ${activeCh} zero</span></div>
              <div id="material-preview-slot"></div>
            </section>
            <div class="form-actions">
              <button class="button primary" type="submit" ${!syntax || this.pendingRequestId || diagnostic ? 'disabled' : ''}>Apply Raw Material to Program</button>
              <button class="button" id="remove-material" type="button" ${!syntax || this.pendingRequestId || diagnostic || !hasPersisted ? 'disabled' : ''}>Remove Program Material</button>
            </div>
          </div>
        </div>
      </form>
    </main>`;
  }

  private buildMaterialFromForm(): ProgramMaterialDefinition {
    const input = (key: string) => this.shadowRoot?.querySelector<HTMLInputElement>(`#material-${key}`) ?? null;
    const type = this.shadowRoot?.querySelector<HTMLSelectElement>('#material-type')?.value === 'box'
      ? 'box'
      : 'cylinder';
    const maxZero = type === 'box' ? 7 : 1;
    const normalizeRef = (ref: ProgramMaterialChannelReference | undefined): ProgramMaterialChannelReference => {
      if (!ref) return {};
      const zeroVertex =
        ref.zeroVertex === undefined
          ? undefined
          : Math.min(maxZero, Math.max(0, ref.zeroVertex));
      const pos = ref.position?.some((v) => v !== 0) ? ([...ref.position] as Vector3) : undefined;
      const rot = ref.rotation?.some((v) => v !== 0) ? ([...ref.rotation] as Vector3) : undefined;
      return {
        ...(zeroVertex !== undefined ? { zeroVertex } : {}),
        ...(pos ? { position: pos } : {}),
        ...(rot ? { rotation: rot } : {}),
      };
    };
    const zero = this.shadowRoot?.querySelector<HTMLSelectElement>('#material-zero')?.value;
    const editedRef = normalizeRef({
      ...this.readTransform('material'),
      ...(zero === '' || zero === undefined ? {} : { zeroVertex: Number(zero) }),
    });
    const prev = this.materialDraft;
    const ref1 = this.materialReferenceChannel === '1'
      ? editedRef
      : normalizeRef(prev ? getChannelMaterialReference(prev, '1') : { zeroVertex: type === 'box' ? 0 : 1 });
    const baseDimensions = type === 'box'
      ? {
          type: 'box' as const,
          width: requiredNumber(input('width')),
          height: requiredNumber(input('height')),
          depth: requiredNumber(input('depth')),
        }
      : {
          type: 'cylinder' as const,
          diameter: requiredNumber(input('diameter')),
          length: requiredNumber(input('length')),
        };
    const channelReferences: ProgramMaterialChannelReferences = {};
    for (const ch of ['2', '3'] as const) {
      const candidate = this.materialReferenceChannel === ch
        ? editedRef
        : prev?.channelReferences?.[ch]
          ? normalizeRef(prev.channelReferences[ch])
          : undefined;
      if (!candidate) continue;
      const probe: ProgramMaterialDefinition = {
        ...baseDimensions,
        ...ref1,
        channelReferences: { [ch]: candidate },
      };
      if (hasDistinctChannelReference(probe, ch)) {
        channelReferences[ch] = candidate;
      }
    }
    const material: ProgramMaterialDefinition = {
      ...baseDimensions,
      ...ref1,
      ...(Object.keys(channelReferences).length ? { channelReferences } : {}),
    };
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
      const material = remove ? undefined : this.buildMaterialFromForm();
      const setup: ProgramSetupDefinition = {
        machineName: this.programSnapshot?.setup?.machineName ?? machine?.machineName ?? 'CNC',
        ...(material ? { material } : {}),
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

      for (const otherCh of CHANNELS) {
        if (otherCh === this.channelId) continue;
        const otherSource = this.readProgramSource(otherCh);
        if (!otherSource?.text.trim()) continue;
        try {
          const otherSnap = this.programTools.captureProgramSnapshot(
            otherSource.identity,
            otherSource.revision,
            otherSource.text,
            syntax,
          );
          if (!otherSnap.valid) continue;
          const shouldSync =
            otherSnap.setup?.material !== undefined ||
            (!remove &&
              (material?.channelReferences?.[otherCh] !== undefined || otherCh === '1'));
          if (!shouldSync) continue;
          const otherSetup: ProgramSetupDefinition = {
            machineName: otherSnap.setup?.machineName ?? machine?.machineName ?? 'CNC',
            ...(material ? { material: structuredClone(material) } : {}),
          };
          const otherRequest: ProgramSetupUpdateRequest = {
            requestId: createId(`setup-${otherCh}`),
            channelId: otherCh,
            documentId: otherSource.identity.documentId,
            programId: otherSource.identity.programId,
            expectedRevision: otherSource.revision,
            expectedText: otherSource.text,
            syntax,
            setup: otherSetup,
          };
          this.eventBus.publish(EVENT_NAMES.PROGRAM_SETUP_UPDATE_REQUEST, otherRequest);
          this.relayUpdateRequest('PROGRAM_SETUP_UPDATE_REQUEST', otherRequest);
        } catch {
          // Best-effort sync to secondary channels
        }
      }
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

  private renderToolTemplateConfigurator(
    tool: LibraryToolDefinition | ProgramToolDefinition,
  ): string {
    const config = inferToolTemplateConfig(tool);
    return `
      <section class="template-configurator-section">
        <div class="section-heading">
          <h3>Tool Templates</h3>
          <span>1-tap archetype &amp; quick setup</span>
        </div>
        <div class="template-pill-strip" role="group" aria-label="Tool definition templates">
          ${TOOL_TEMPLATE_ARCHETYPES.map((arch) => {
            const active = config.archetype === arch.id;
            return `<button type="button" class="template-pill ${active ? 'active' : ''}" data-tool-template="${arch.id}" title="${this.escape(arch.summary)}">
              <span class="template-card-title">${this.escape(arch.shortLabel)}</span>
            </button>`;
          }).join('')}
        </div>
        ${this.renderQuickTemplateControls(config)}
      </section>
    `;
  }

  private renderQuickTemplateControls(config: ToolTemplateConfig): string {
    switch (config.archetype) {
      case 'od-turning': {
        const mount = config.turningMount ?? 'front-right';
        const shape = config.insertShape ?? 'V';
        const noseR = config.noseRadius ?? 0.2;
        return `
          <div class="quick-config-group">
            <div class="quick-config-row">
              <span class="quick-config-label">Mount / Hand</span>
              <div class="chip-row">
                <button type="button" class="pill-button ${mount === 'front-right' ? 'active' : ''}" data-template-turning-mount="front-right">Front-Right (Q3)</button>
                <button type="button" class="pill-button ${mount === 'back-left' ? 'active' : ''}" data-template-turning-mount="back-left">Back-Left (Q2)</button>
                <button type="button" class="pill-button ${mount === 'center' ? 'active' : ''}" data-template-turning-mount="center">Center (Q8)</button>
              </div>
            </div>
            <div class="quick-config-row">
              <span class="quick-config-label">ISO Insert Shape</span>
              <div class="chip-row">
                ${QUICK_TURNING_SHAPES.map((item) => `<button type="button" class="pill-button ${shape === item.shape ? 'active' : ''}" data-template-insert-shape="${item.shape}">${this.escape(item.label)}</button>`).join('')}
              </div>
            </div>
            <div class="quick-config-row">
              <span class="quick-config-label">Nose Radius R (mm)</span>
              <div class="chip-row">
                ${QUICK_NOSE_RADII_MM.map((r) => `<button type="button" class="pill-button ${Math.abs(noseR - r) < 1e-4 ? 'active' : ''}" data-template-nose-radius="${r}">R${r}</button>`).join('')}
              </div>
            </div>
          </div>
        `;
      }

      case 'id-boring': {
        const side = config.boringSide ?? 'back-wall';
        const minBore = config.minBoreDiameter ?? 4;
        const maxDepth = config.maxBoreDepth ?? 15;
        const noseR = config.noseRadius ?? 0.1;
        return `
          <div class="quick-config-group">
            <div class="quick-config-row">
              <span class="quick-config-label">Bore Wall / Q</span>
              <div class="chip-row">
                <button type="button" class="pill-button ${side === 'back-wall' ? 'active' : ''}" data-template-boring-side="back-wall">Upper / Back Wall (Q2)</button>
                <button type="button" class="pill-button ${side === 'front-wall' ? 'active' : ''}" data-template-boring-side="front-wall">Lower / Front Wall (Q3)</button>
              </div>
            </div>
            <div class="quick-config-row">
              <span class="quick-config-label">Min Bore Ø Dmin (mm)</span>
              <div class="chip-row">
                ${QUICK_BORE_DIAMETERS_MM.map((d) => `<button type="button" class="pill-button ${Math.abs(minBore - d) < 0.25 ? 'active' : ''}" data-template-bore-dia="${d}">Ø${d}</button>`).join('')}
              </div>
            </div>
            <div class="quick-config-row">
              <span class="quick-config-label">Max Bore Depth Lmax (mm)</span>
              <div class="chip-row">
                ${QUICK_BORE_DEPTHS_MM.map((l) => `<button type="button" class="pill-button ${Math.abs(maxDepth - l) < 0.5 ? 'active' : ''}" data-template-bore-depth="${l}">${l} mm</button>`).join('')}
              </div>
            </div>
            <div class="quick-config-row">
              <span class="quick-config-label">Nose Radius R (mm)</span>
              <div class="chip-row">
                ${QUICK_NOSE_RADII_MM.map((r) => `<button type="button" class="pill-button ${Math.abs(noseR - r) < 1e-4 ? 'active' : ''}" data-template-nose-radius="${r}">R${r}</button>`).join('')}
              </div>
            </div>
          </div>
        `;
      }

      case 'cutoff-groove': {
        const grooveKind = config.grooveKind ?? 'cutoff';
        const mount = config.turningMount === 'back-left' ? 'back-left' : 'front-right';
        const width = config.bladeWidth ?? 3;
        const noseR = config.noseRadius ?? 0.2;
        return `
          <div class="quick-config-group">
            <div class="quick-config-row">
              <span class="quick-config-label">Operation</span>
              <div class="chip-row">
                <button type="button" class="pill-button ${grooveKind === 'cutoff' ? 'active' : ''}" data-template-groove-kind="cutoff">Cut-Off / Parting (Tip 0)</button>
                <button type="button" class="pill-button ${grooveKind === 'grooving' ? 'active' : ''}" data-template-groove-kind="grooving">Grooving / Cut-In (Tip 3)</button>
              </div>
            </div>
            <div class="quick-config-row">
              <span class="quick-config-label">Mount / Hand</span>
              <div class="chip-row">
                <button type="button" class="pill-button ${mount === 'front-right' ? 'active' : ''}" data-template-turning-mount="front-right">Front-Right (Q3)</button>
                <button type="button" class="pill-button ${mount === 'back-left' ? 'active' : ''}" data-template-turning-mount="back-left">Back-Left (Q2)</button>
              </div>
            </div>
            <div class="quick-config-row">
              <span class="quick-config-label">Blade Width (mm)</span>
              <div class="chip-row">
                ${QUICK_BLADE_WIDTHS_MM.map((w) => `<button type="button" class="pill-button ${Math.abs(width - w) < 1e-3 ? 'active' : ''}" data-template-blade-width="${w}">${w} mm</button>`).join('')}
              </div>
            </div>
            <div class="quick-config-row">
              <span class="quick-config-label">Corner Radius R (mm)</span>
              <div class="chip-row">
                ${QUICK_NOSE_RADII_MM.map((r) => `<button type="button" class="pill-button ${Math.abs(noseR - r) < 1e-4 ? 'active' : ''}" data-template-nose-radius="${r}">R${r}</button>`).join('')}
              </div>
            </div>
          </div>
        `;
      }

      case 'drill': {
        const axialMount = config.axialMount ?? 'front';
        const diameter = config.diameter ?? 3;
        const tipAngle = config.tipAngle ?? 118;
        return `
          <div class="quick-config-group">
            <div class="quick-config-row">
              <span class="quick-config-label">Mount Direction</span>
              <div class="chip-row">
                <button type="button" class="pill-button ${axialMount === 'front' ? 'active' : ''}" data-template-axial-mount="front">Front (+Z)</button>
                <button type="button" class="pill-button ${axialMount === 'cross' ? 'active' : ''}" data-template-axial-mount="cross">Cross (X)</button>
                <button type="button" class="pill-button ${axialMount === 'counter-face' ? 'active' : ''}" data-template-axial-mount="counter-face">Counter-Face (-Z)</button>
              </div>
            </div>
            <div class="quick-config-row">
              <span class="quick-config-label">Quick Diameter (mm)</span>
              <div class="chip-row">
                ${QUICK_DRILL_DIAMETERS_MM.map((d) => `<button type="button" class="pill-button ${Math.abs(diameter - d) < 1e-3 ? 'active' : ''}" data-template-diameter="${d}">Ø${d}</button>`).join('')}
              </div>
            </div>
            <div class="quick-config-row">
              <span class="quick-config-label">Tip Angle</span>
              <div class="chip-row">
                ${[118, 135, 140, 90].map((angle) => `<button type="button" class="pill-button ${Math.abs(tipAngle - angle) < 1e-3 ? 'active' : ''}" data-template-tip-angle="${angle}">${angle}°${angle === 90 ? ' (Spot)' : ''}</button>`).join('')}
              </div>
            </div>
          </div>
        `;
      }

      case 'mill': {
        const millKind = config.millKind ?? 'endMill';
        const axialMount = config.axialMount ?? 'cross';
        const diameter = config.diameter ?? 6;
        return `
          <div class="quick-config-group">
            <div class="quick-config-row">
              <span class="quick-config-label">Cutter Style</span>
              <div class="chip-row">
                <button type="button" class="pill-button ${millKind === 'endMill' ? 'active' : ''}" data-template-mill-kind="endMill">Flat End Mill</button>
                <button type="button" class="pill-button ${millKind === 'ballMill' ? 'active' : ''}" data-template-mill-kind="ballMill">Ball Nose Mill</button>
              </div>
            </div>
            <div class="quick-config-row">
              <span class="quick-config-label">Mount Direction</span>
              <div class="chip-row">
                <button type="button" class="pill-button ${axialMount === 'cross' ? 'active' : ''}" data-template-axial-mount="cross">Cross (X)</button>
                <button type="button" class="pill-button ${axialMount === 'front' ? 'active' : ''}" data-template-axial-mount="front">Front (+Z)</button>
                <button type="button" class="pill-button ${axialMount === 'counter-face' ? 'active' : ''}" data-template-axial-mount="counter-face">Counter-Face (-Z)</button>
              </div>
            </div>
            <div class="quick-config-row">
              <span class="quick-config-label">Quick Diameter (mm)</span>
              <div class="chip-row">
                ${QUICK_MILL_DIAMETERS_MM.map((d) => `<button type="button" class="pill-button ${Math.abs(diameter - d) < 1e-3 ? 'active' : ''}" data-template-diameter="${d}">Ø${d}</button>`).join('')}
              </div>
            </div>
          </div>
        `;
      }

      case 'empty':
      default:
        return '';
    }
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
        <div class="form-workspace-grid">
          <div class="form-controls-col">
            ${this.renderToolTemplateConfigurator(tool)}
            <section>
              <div class="section-heading"><h3>General</h3><span>mm / degrees</span></div>
              ${mode === 'program' ? `
                <div class="field-grid four-col-grid">
                  <label>ID Type<select id="identifier-kind"><option value="number" ${typeof programTool?.toolNumber === 'number' ? 'selected' : ''}>Number</option><option value="name" ${typeof programTool?.toolNumber === 'string' ? 'selected' : ''}>Name</option></select></label>
                  <label>Tool ID<input id="tool-identifier" value="${this.escape(String(programTool?.toolNumber ?? 1))}" required></label>
                  <label>Q<input id="tool-q" type="number" step="any" value="${tool.Q ?? ''}" placeholder="Opt"></label>
                  <label>R<input id="tool-r" type="number" step="any" value="${tool.R ?? ''}" placeholder="Opt"></label>
                </div>
                <label>Description<input id="tool-description" value="${this.escape(tool.description)}" placeholder="Drill 8 mm" required></label>
              ` : `
                <div class="field-grid compact">
                  <label>Description<input id="tool-description" value="${this.escape(tool.description)}" placeholder="Drill 8 mm" required></label>
                  <label>Tags<input id="tool-tags" value="${this.escape(tags)}" placeholder="drill, aluminum"></label>
                </div>
                <div class="field-grid compact">
                  <label>Q<input id="tool-q" type="number" step="any" value="${tool.Q ?? ''}" placeholder="Optional"></label>
                  <label>R<input id="tool-r" type="number" step="any" value="${tool.R ?? ''}" placeholder="Optional"></label>
                </div>
              `}
              <details class="form-accordion"><summary>Assembly orientation</summary>
                <div class="field-grid transform-grid">
                  ${['X', 'Y', 'Z'].map((axis, index) => `<label>Rotation ${axis}<input id="tool-orientation-${axis.toLowerCase()}" type="number" step="any" value="${orientation[index]}"></label>`).join('')}
                </div>
              </details>
            </section>

            <section>
              <details class="form-accordion">
                <summary>Cutting Geometry (${this.escape(cutter?.type ?? 'none')})</summary>
                <div class="accordion-body">
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
                    <div class="field-grid four-col-grid">
                      <label>Shape<select id="insert-shape">${INSERT_SHAPES.map((shape) => this.option(shape, shape, cutter?.type === 'insert' ? cutter.shape : 'C')).join('')}</select></label>
                      <label>IC<input id="insert-ic" type="number" min="0" step="any" value="${cutter?.type === 'insert' ? cutter.ic : ''}"></label>
                      <label>Thickness<input id="insert-thickness" type="number" min="0" step="any" value="${cutter?.type === 'insert' ? cutter.thickness : ''}"></label>
                      <label>Nose R<input id="insert-nose-radius" type="number" min="0" step="any" value="${cutter?.type === 'insert' ? cutter.noseRadius : ''}"></label>
                      <label>Clearance<input id="insert-clearance" type="number" step="any" value="${cutter?.type === 'insert' ? cutter.clearanceAngle : 0}"></label>
                      <label>Width<input id="insert-width" type="number" min="0" step="any" value="${cutter?.type === 'insert' ? cutter.width ?? '' : ''}" placeholder="L/A/B/K"></label>
                      <label>Length<input id="insert-length" type="number" min="0" step="any" value="${cutter?.type === 'insert' ? cutter.length ?? '' : ''}" placeholder="L/A/B/K"></label>
                      <label>Zero Pt<input id="insert-zero-vertex" type="number" min="0" max="255" step="1" value="${cutter?.type === 'insert' ? cutter.zeroVertex ?? '' : ''}" placeholder="Auto" title="Plate outline vertex used as tool zero; stored in the NC program. Click a vertex in the preview."></label>
                    </div>
                  </div>
                  ${this.renderTransformFields('cutting', cutterPosition, cutterRotation)}
                </div>
              </details>
            </section>

            <section>
              <details class="form-accordion">
                <summary>Holder Assembly (${this.escape(holder?.type ?? 'none')})</summary>
                <div class="accordion-body">
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
                </div>
              </details>
            </section>
          </div>

          <div class="form-preview-col">
            <section class="preview-section">
              <div class="section-heading"><h3>Live Preview</h3><span>Click vertex for zero point</span></div>
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
          </div>
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
      !this.pendingRequestId && this.programSnapshot?.valid !== false;
  }

  private attachListeners(): void {
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-manager-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        this.activeTab = button.dataset.managerTab as ManagerTab;
        this.pendingRequestId = undefined;
        this.render();
        if (this.activeTab === 'library') {
          void this.loadLibrary(true);
        } else {
          void this.loadProgram(true);
        }
      });
    });
    this.shadowRoot?.querySelector<HTMLSelectElement>('#manager-channel')?.addEventListener('change', (event) => {
      let preservedDraft: ProgramMaterialDefinition | undefined;
      if (this.activeTab === 'material' && this.shadowRoot?.querySelector('#material-form')) {
        try {
          preservedDraft = this.buildMaterialFromForm();
        } catch {
          preservedDraft = this.materialDraft;
        }
      }
      this.channelId = (event.currentTarget as HTMLSelectElement).value as ChannelId;
      this.materialReferenceChannel = this.channelId;
      this.stateService.setWorkbenchSelectedChannel(this.channelId);
      this.selectedProgramKey = undefined;
      this.pendingRequestId = undefined;
      void this.loadProgram(false).then(() => {
        if (preservedDraft) {
          this.materialDraft = preservedDraft;
        }
        this.render();
      });
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
      this.mobileListOpen = false;
      this.render();
    });
    this.shadowRoot?.querySelector<HTMLButtonElement>('#mobile-new-library-tool')?.addEventListener('click', () => {
      this.selectedLibraryId = undefined;
      this.libraryDraft = this.newLibraryTool();
      this.mobileListOpen = false;
      this.render();
    });
    this.shadowRoot?.querySelector<HTMLButtonElement>('#toggle-mobile-list')?.addEventListener('click', () => {
      this.mobileListOpen = !this.mobileListOpen;
      this.render();
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-program-key]').forEach((button) => {
      button.addEventListener('click', () => {
        this.selectedProgramKey = button.dataset.programKey;
        const identifier = this.selectedProgramIdentifier;
        if (identifier !== undefined) {
          this.programDraft = structuredClone(this.programDefinitions.find((tool) => exactKey(tool.toolNumber) === exactKey(identifier)) ?? this.newProgramTool(identifier));
        }
        this.mobileListOpen = false;
        this.render();
      });
    });
    const createNewAssignment = () => {
      this.selectedProgramKey = undefined;
      this.programDraft = this.newProgramTool();
      this.mobileListOpen = false;
      this.render();
    };
    this.shadowRoot?.querySelector<HTMLButtonElement>('#new-program-tool')?.addEventListener('click', createNewAssignment);
    this.shadowRoot?.querySelector<HTMLButtonElement>('#quick-new-program-tool')?.addEventListener('click', createNewAssignment);
    this.shadowRoot?.querySelector<HTMLButtonElement>('#copy-library-tool')?.addEventListener('click', () => this.copyLibraryTool());
    this.shadowRoot?.querySelector<HTMLButtonElement>('#assign-and-apply-tool')?.addEventListener('click', () => this.assignAndApplyLibraryTool());
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-tool-template]').forEach((button) => {
      button.addEventListener('click', () => {
        const archetype = button.dataset.toolTemplate as ToolTemplateArchetypeId | undefined;
        if (archetype) this.applyToolTemplatePatch({ archetype });
      });
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-template-turning-mount]').forEach((button) => {
      button.addEventListener('click', () => {
        const turningMount = button.dataset.templateTurningMount as TurningPresetId | undefined;
        if (turningMount) this.applyToolTemplatePatch({ turningMount });
      });
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-template-insert-shape]').forEach((button) => {
      button.addEventListener('click', () => {
        const insertShape = button.dataset.templateInsertShape as InsertShape | undefined;
        if (insertShape) this.applyToolTemplatePatch({ insertShape });
      });
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-template-nose-radius]').forEach((button) => {
      button.addEventListener('click', () => {
        const noseRadius = Number(button.dataset.templateNoseRadius);
        if (Number.isFinite(noseRadius)) this.applyToolTemplatePatch({ noseRadius });
      });
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-template-boring-side]').forEach((button) => {
      button.addEventListener('click', () => {
        const boringSide = button.dataset.templateBoringSide as BoringWallSide | undefined;
        if (boringSide) this.applyToolTemplatePatch({ boringSide });
      });
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-template-bore-dia]').forEach((button) => {
      button.addEventListener('click', () => {
        const minBoreDiameter = Number(button.dataset.templateBoreDia);
        if (Number.isFinite(minBoreDiameter)) this.applyToolTemplatePatch({ minBoreDiameter });
      });
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-template-bore-depth]').forEach((button) => {
      button.addEventListener('click', () => {
        const maxBoreDepth = Number(button.dataset.templateBoreDepth);
        if (Number.isFinite(maxBoreDepth)) this.applyToolTemplatePatch({ maxBoreDepth });
      });
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-template-groove-kind]').forEach((button) => {
      button.addEventListener('click', () => {
        const grooveKind = button.dataset.templateGrooveKind as GrooveOperationKind | undefined;
        if (grooveKind) this.applyToolTemplatePatch({ grooveKind });
      });
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-template-blade-width]').forEach((button) => {
      button.addEventListener('click', () => {
        const bladeWidth = Number(button.dataset.templateBladeWidth);
        if (Number.isFinite(bladeWidth)) this.applyToolTemplatePatch({ bladeWidth });
      });
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-template-axial-mount]').forEach((button) => {
      button.addEventListener('click', () => {
        const axialMount = button.dataset.templateAxialMount as AxialToolMount | undefined;
        if (axialMount) this.applyToolTemplatePatch({ axialMount });
      });
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-template-diameter]').forEach((button) => {
      button.addEventListener('click', () => {
        const diameter = Number(button.dataset.templateDiameter);
        if (Number.isFinite(diameter)) this.applyToolTemplatePatch({ diameter });
      });
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-template-tip-angle]').forEach((button) => {
      button.addEventListener('click', () => {
        const tipAngle = Number(button.dataset.templateTipAngle);
        if (Number.isFinite(tipAngle)) this.applyToolTemplatePatch({ tipAngle });
      });
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-template-mill-kind]').forEach((button) => {
      button.addEventListener('click', () => {
        const millKind = button.dataset.templateMillKind as MillCutterKind | undefined;
        if (millKind) this.applyToolTemplatePatch({ millKind });
      });
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-material-template]').forEach((button) => {
      button.addEventListener('click', () => {
        const templateId = button.dataset.materialTemplate as MaterialTemplateId | undefined;
        if (templateId) this.applyMaterialTemplate(templateId);
      });
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-material-quick-diameter]').forEach((button) => {
      button.addEventListener('click', () => {
        const diameter = Number(button.dataset.materialQuickDiameter);
        if (!Number.isFinite(diameter)) return;
        const input = this.shadowRoot?.querySelector<HTMLInputElement>('#material-diameter');
        if (input) {
          input.value = String(diameter);
          this.materialDraft = this.buildMaterialFromForm();
          this.render();
        }
      });
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-material-quick-length]').forEach((button) => {
      button.addEventListener('click', () => {
        const length = Number(button.dataset.materialQuickLength);
        if (!Number.isFinite(length)) return;
        const input = this.shadowRoot?.querySelector<HTMLInputElement>('#material-length');
        if (input) {
          input.value = String(length);
          this.materialDraft = this.buildMaterialFromForm();
          this.render();
        }
      });
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-material-quick-box]').forEach((button) => {
      button.addEventListener('click', () => {
        const parts = (button.dataset.materialQuickBox ?? '').split(',').map(Number);
        if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) return;
        const [width, height, depth] = parts;
        const wIn = this.shadowRoot?.querySelector<HTMLInputElement>('#material-width');
        const hIn = this.shadowRoot?.querySelector<HTMLInputElement>('#material-height');
        const dIn = this.shadowRoot?.querySelector<HTMLInputElement>('#material-depth');
        if (wIn && hIn && dIn) {
          wIn.value = String(width);
          hIn.value = String(height);
          dIn.value = String(depth);
          this.materialDraft = this.buildMaterialFromForm();
          this.render();
        }
      });
    });
    const materialForm = this.shadowRoot?.querySelector<HTMLFormElement>('#material-form');
    materialForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.applyProgramMaterial();
    });
    materialForm?.addEventListener('input', () => this.refreshPreview());
    materialForm?.addEventListener('change', () => this.refreshPreview());
    this.shadowRoot?.querySelector<HTMLButtonElement>('#remove-material')?.addEventListener('click', () => this.applyProgramMaterial(true));
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-material-channel]').forEach((button) => {
      button.addEventListener('click', () => {
        const nextChannel = button.dataset.materialChannel as ChannelId | undefined;
        if (!nextChannel || nextChannel === this.materialReferenceChannel) return;
        try {
          this.materialDraft = this.buildMaterialFromForm();
        } catch {
          // Retain last valid draft if current form inputs are incomplete
        }
        this.materialReferenceChannel = nextChannel;
        this.render();
      });
    });
    this.shadowRoot?.querySelector<HTMLButtonElement>('#material-preset-pickup')?.addEventListener('click', () => {
      if (this.materialReferenceChannel === '1') return;
      try {
        const base = this.buildMaterialFromForm();
        const channelReferences: ProgramMaterialChannelReferences = {
          ...(base.channelReferences ? structuredClone(base.channelReferences) : {}),
          [this.materialReferenceChannel]: pickupChannelMaterialReference(base, '1'),
        };
        this.materialDraft = { ...base, channelReferences };
        this.render();
      } catch (cause) {
        this.setStatus(cause instanceof Error ? cause.message : String(cause), 'error');
      }
    });
    this.shadowRoot?.querySelector<HTMLButtonElement>('#material-preset-pickup-ch2')?.addEventListener('click', () => {
      try {
        const base = this.buildMaterialFromForm();
        const channelReferences: ProgramMaterialChannelReferences = {
          ...(base.channelReferences ? structuredClone(base.channelReferences) : {}),
          '2': pickupChannelMaterialReference(base, '1'),
        };
        this.materialDraft = { ...base, channelReferences };
        this.materialReferenceChannel = '2';
        this.render();
      } catch (cause) {
        this.setStatus(cause instanceof Error ? cause.message : String(cause), 'error');
      }
    });
    this.shadowRoot?.querySelector<HTMLButtonElement>('#material-preset-flip-z')?.addEventListener('click', () => {
      try {
        const base = this.buildMaterialFromForm();
        const currentRef = getChannelMaterialReference(base, this.materialReferenceChannel);
        const rot = currentRef.rotation ?? [0, 0, 0];
        const nextRx = (((rot[0] + 180) % 360) + 360) % 360;
        const nextRotation: Vector3 = [nextRx, rot[1], rot[2]];
        if (this.materialReferenceChannel === '1') {
          this.materialDraft = {
            ...base,
            ...(nextRotation.some((v) => v !== 0) ? { rotation: nextRotation } : { rotation: undefined }),
          };
          if (!this.materialDraft.rotation) delete this.materialDraft.rotation;
        } else {
          const channelReferences: ProgramMaterialChannelReferences = {
            ...(base.channelReferences ? structuredClone(base.channelReferences) : {}),
            [this.materialReferenceChannel]: {
              ...currentRef,
              ...(nextRotation.some((v) => v !== 0) ? { rotation: nextRotation } : { rotation: undefined }),
            },
          };
          if (!channelReferences[this.materialReferenceChannel]?.rotation) {
            delete channelReferences[this.materialReferenceChannel]!.rotation;
          }
          this.materialDraft = { ...base, channelReferences };
        }
        this.render();
      } catch (cause) {
        this.setStatus(cause instanceof Error ? cause.message : String(cause), 'error');
      }
    });
    this.shadowRoot?.querySelector<HTMLButtonElement>('#material-preset-same-ch1')?.addEventListener('click', () => {
      if (this.materialReferenceChannel === '1') return;
      try {
        const base = this.buildMaterialFromForm();
        const channelReferences: ProgramMaterialChannelReferences = {
          ...(base.channelReferences ? structuredClone(base.channelReferences) : {}),
        };
        delete channelReferences[this.materialReferenceChannel];
        const next: ProgramMaterialDefinition = { ...base };
        if (Object.keys(channelReferences).length) {
          next.channelReferences = channelReferences;
        } else {
          delete next.channelReferences;
        }
        this.materialDraft = next;
        this.render();
      } catch (cause) {
        this.setStatus(cause instanceof Error ? cause.message : String(cause), 'error');
      }
    });
    this.shadowRoot?.querySelector<HTMLSelectElement>('#material-type')?.addEventListener('change', (event) => {
      try {
        const type = (event.currentTarget as HTMLSelectElement).value === 'box' ? 'box' : 'cylinder';
        const maxZero = type === 'box' ? 7 : 1;
        const clampRef = (
          ref: ProgramMaterialChannelReference | undefined,
          fallbackZero?: number,
        ): ProgramMaterialChannelReference => {
          const zeroVertex =
            ref?.zeroVertex === undefined
              ? fallbackZero
              : Math.min(maxZero, Math.max(0, ref.zeroVertex));
          return {
            ...(zeroVertex !== undefined ? { zeroVertex } : {}),
            ...(ref?.position?.some((v) => v !== 0) ? { position: [...ref.position] as Vector3 } : {}),
            ...(ref?.rotation?.some((v) => v !== 0) ? { rotation: [...ref.rotation] as Vector3 } : {}),
          };
        };
        const transform = this.readTransform('material');
        const prev = this.materialDraft;
        const ref1 = this.materialReferenceChannel === '1'
          ? { zeroVertex: type === 'box' ? 0 : 1, ...transform }
          : clampRef(prev ? getChannelMaterialReference(prev, '1') : undefined, type === 'box' ? 0 : 1);
        const channelReferences: ProgramMaterialChannelReferences = {};
        for (const ch of ['2', '3'] as const) {
          const rawRef = this.materialReferenceChannel === ch
            ? { zeroVertex: type === 'box' ? 0 : 1, ...transform }
            : prev?.channelReferences?.[ch];
          if (!rawRef) continue;
          channelReferences[ch] = clampRef(rawRef);
        }
        this.materialDraft = type === 'box'
          ? {
              type: 'box',
              width: 100,
              height: 20,
              depth: 100,
              ...ref1,
              ...(Object.keys(channelReferences).length ? { channelReferences } : {}),
            }
          : {
              type: 'cylinder',
              diameter: 20,
              length: 100,
              ...ref1,
              ...(Object.keys(channelReferences).length ? { channelReferences } : {}),
            };
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
        this.previewElement.setMaterial(
          channelMaterial(this.materialDraft, this.materialReferenceChannel),
          this.materialDraft,
          this.materialReferenceChannel,
        );
        this.updateMaterialChannelCards();
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

  private applyToolTemplatePatch(patch: Partial<ToolTemplateConfig>): void {
    const activeTool = this.activeTab === 'library' ? this.libraryDraft : this.programDraft;
    const currentConfig = inferToolTemplateConfig(activeTool);
    const nextConfig: ToolTemplateConfig =
      patch.archetype && patch.archetype !== currentConfig.archetype
        ? { archetype: patch.archetype }
        : { ...currentConfig, ...patch };
    let toolNumber: ToolIdentifier = 1;
    if (this.activeTab === 'program') {
      try {
        toolNumber = this.readProgramIdentifier();
      } catch {
        toolNumber = this.programDraft?.toolNumber ?? this.selectedProgramIdentifier ?? 1;
      }
    }
    const generated = buildToolFromTemplateConfig(nextConfig, toolNumber);
    if (this.activeTab === 'library') {
      const base = this.libraryDraft ?? this.newLibraryTool();
      const { toolNumber: _ignore, tags, ...rest } = generated;
      this.libraryDraft = {
        id: base.id,
        revision: base.revision,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
        tags,
        ...rest,
      };
    } else {
      const { tags: _ignore, ...programTool } = generated;
      this.programDraft = programTool;
    }
    this.setStatus(`Configured ${generated.description}`, 'info', false);
    this.render();
  }

  private applyMaterialTemplate(templateId: MaterialTemplateId): void {
    const tpl = MATERIAL_DEFINITION_TEMPLATES.find((item) => item.id === templateId);
    if (!tpl) return;
    this.materialDraft = structuredClone(tpl.material);
    this.setStatus(`Loaded material template: ${tpl.label}`, 'info', false);
    this.render();
  }

  private copyLibraryTool(): boolean {
    const id = this.shadowRoot?.querySelector<HTMLSelectElement>('#assign-library-tool')?.value;
    const selected = this.libraryTools.find((tool) => tool.id === id);
    if (!selected) {
      this.setStatus('Choose a library tool first', 'error');
      return false;
    }
    const toolNumber = this.programDraft?.toolNumber ?? this.selectedProgramIdentifier ?? 1;
    this.programDraft = toProgramToolDefinition(selected, toolNumber);
    this.setStatus('Library geometry copied into the program draft', 'info', false);
    this.render();
    return true;
  }

  private assignAndApplyLibraryTool(): void {
    if (!this.copyLibraryTool()) return;
    this.applyProgramTool();
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
    if (result.success) {
      if (result.updatedText !== undefined && this.programSource?.identity.documentId === 'external') {
        const activeProgram = this.fileManager?.getActiveProgram(this.channelId);
        if (activeProgram) {
          activeProgram.content = result.updatedText;
        }
      }
      await this.loadProgram(false);
    }
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
      .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); border:0; }
      .manager-shell { display:grid; grid-template-rows:auto minmax(0,1fr) auto; height:100%; min-height:0; }
      .manager-topbar { display:flex; justify-content:space-between; align-items:stretch; gap:6px; padding-right:8px; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); background:var(--vscode-editorGroupHeader-tabsBackground,#f6f8fa); }
      h2,h3,p { margin:0; } h2 { font-size:14px; } h3 { font-size:11px; font-weight:600; } p,.section-heading span { color:var(--vscode-descriptionForeground,#57606a); font-size:10px; }
      .channel-control { display:flex; align-items:center; flex-shrink:0; }
      .channel-control select { min-width:72px; padding:3px 6px; font-size:11px; font-weight:600; }
      label { display:flex; flex-direction:column; gap:3px; color:var(--vscode-descriptionForeground,#57606a); font-size:10px; }
      input,select { width:100%; min-width:0; padding:4px 6px; border:1px solid var(--vscode-input-border,#d0d7de); border-radius:3px; color:var(--vscode-input-foreground,#24292f); background:var(--vscode-input-background,#fff); font-size:11px; }
      input:focus,select:focus { outline:1px solid var(--vscode-focusBorder,#0969da); border-color:var(--vscode-focusBorder,#0969da); }
      .manager-tabs { display:flex; flex:1 1 auto; min-width:0; overflow-x:auto; scrollbar-width:thin; -webkit-overflow-scrolling:touch; }
      .manager-tab { flex:0 0 auto; min-height:32px; padding:6px 12px; white-space:nowrap; border:0; border-top:2px solid transparent; background:transparent; color:inherit; font-size:12px; cursor:pointer; }
      .manager-tab.active { border-top-color:var(--vscode-tab-activeBorderTop,#0969da); background:var(--vscode-tab-activeBackground,#fff); font-weight:600; }
      .manager-body { display:grid; grid-template-columns:minmax(135px,24%) minmax(260px,76%); min-height:0; overflow:hidden; }
      .tool-list-pane,.tool-editor-pane { min-height:0; overflow:hidden; display:flex; flex-direction:column; }
      .tool-list-pane { border-right:1px solid var(--vscode-editorGroup-border,#d0d7de); background:var(--vscode-sideBar-background,#f6f8fa); }
      .tool-editor-pane { overflow-y:auto; overflow-x:hidden; container-type:inline-size; }
      .tool-editor-pane > * { flex-shrink:0; }
      .material-editor-pane,.program-full-pane { grid-column:1 / -1; grid-row:1 / -1; }
      .mobile-drawer-bar { display:none; justify-content:space-between; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); background:var(--vscode-editorGroupHeader-tabsBackground,#f6f8fa); }
      .mobile-only-btn { display:none; }
      .station-header-bar { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:5px 8px; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); background:var(--vscode-sideBar-background,#f6f8fa); overflow-x:auto; flex-shrink:0; }
      .station-pills { display:flex; align-items:center; gap:5px; flex-wrap:nowrap; }
      .station-empty { font-size:11px; color:var(--vscode-descriptionForeground,#57606a); }
      .station-pill { display:inline-flex; align-items:center; gap:4px; flex-shrink:0; min-height:24px; padding:2px 8px; border:1px solid var(--vscode-widget-border,#d0d7de); border-radius:999px; background:var(--vscode-editor-background,#fff); color:inherit; font-size:11px; font-weight:600; cursor:pointer; }
      .station-pill.assigned .station-dot { color:#2f8f4e; }
      .station-pill.active { border-color:var(--vscode-focusBorder,#0969da); background:var(--vscode-button-background,#0969da); color:var(--vscode-button-foreground,#fff); }
      .station-pill.active .station-dot { color:inherit; }
      .station-pill.add-pill { border-style:dashed; font-weight:500; }
      .form-workspace-grid { display:grid; grid-template-columns:1fr; align-items:start; min-height:0; }
      .form-controls-col { display:flex; flex-direction:column; min-width:0; }
      .form-preview-col { display:flex; flex-direction:column; min-width:0; background:var(--vscode-editor-background,#fff); }
      @container (min-width: 540px) {
        .form-workspace-grid { grid-template-columns:minmax(250px,1.15fr) minmax(200px,0.85fr); }
        .form-controls-col { border-right:1px solid var(--vscode-editorGroup-border,#d0d7de); }
        .form-preview-col { position:sticky; top:0; }
      }
      .preview-section { border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); }
      .template-configurator-section { background:var(--vscode-sideBar-background,#f6f8fa); }
      .template-pill-strip { display:flex; flex-wrap:wrap; gap:5px; }
      .template-pill { display:inline-flex; align-items:center; gap:5px; min-height:26px; padding:3px 9px; border:1px solid var(--vscode-widget-border,#d0d7de); border-radius:4px; background:var(--vscode-editor-background,#fff); color:inherit; cursor:pointer; transition:border-color .12s,box-shadow .12s; }
      .template-pill:hover { border-color:var(--vscode-focusBorder,#0969da); }
      .template-pill.active { border-color:var(--vscode-focusBorder,#0969da); background:var(--vscode-button-background,#0969da); color:var(--vscode-button-foreground,#fff); }
      .template-pill.active .template-card-badge { color:rgba(255,255,255,.85); }
      .template-card-title { font-size:11px; font-weight:600; line-height:1.2; }
      .template-card-badge { font-size:10px; color:var(--vscode-descriptionForeground,#57606a); line-height:1.2; }
      .quick-config-group { display:grid; gap:5px; padding:6px 8px; border:1px solid var(--vscode-widget-border,#d0d7de); border-radius:4px; background:var(--vscode-editor-background,#fff); }
      .quick-config-row { display:grid; grid-template-columns:88px minmax(0,1fr); align-items:center; gap:6px; }
      .quick-config-label { font-size:10px; font-weight:600; color:var(--vscode-descriptionForeground,#57606a); }
      .chip-row { display:flex; flex-wrap:wrap; gap:4px; }
      .pill-button { min-height:24px; padding:2px 8px; border:1px solid var(--vscode-widget-border,#d0d7de); border-radius:999px; background:var(--vscode-button-secondaryBackground,#eaeef2); color:var(--vscode-button-secondaryForeground,#24292f); font-size:11px; cursor:pointer; }
      .pill-button:hover { border-color:var(--vscode-focusBorder,#0969da); }
      .pill-button.active { border-color:var(--vscode-button-background,#0969da); background:var(--vscode-button-background,#0969da); color:var(--vscode-button-foreground,#fff); font-weight:600; }
      .list-toolbar,.library-actions,.program-source { display:grid; gap:5px; padding:7px; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); flex-shrink:0; }
      .library-actions { grid-template-columns:1fr 1fr; margin-top:auto; border-top:1px solid var(--vscode-editorGroup-border,#d0d7de); border-bottom:0; }
      .program-source { margin-top:auto; color:var(--vscode-descriptionForeground,#57606a); font-size:10px; overflow-wrap:anywhere; }
      .tool-list { overflow:auto; min-height:0; flex:1 1 auto; }
      .tool-row { display:flex; flex-direction:column; gap:2px; width:100%; padding:6px 8px; border:0; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); color:inherit; background:transparent; text-align:left; cursor:pointer; }
      .tool-row:hover { background:var(--vscode-list-hoverBackground,#f3f4f6); }
      .tool-row.active { padding-left:5px; border-left:3px solid var(--vscode-focusBorder,#0969da); background:var(--vscode-tab-activeBackground,#fff); }
      .tool-name { font-size:11px; font-weight:600; overflow-wrap:anywhere; }
      .tool-meta,.section-label { color:var(--vscode-descriptionForeground,#57606a); font-size:10px; }
      .tool-meta.complete { color:#2f8f4e; }
      .tool-form { display:flex; flex-direction:column; gap:0; }
      .offset-editor-pane { grid-column:1 / -1; min-height:0; overflow:auto; display:flex; flex-direction:column; }
      .simulation-pane { grid-column:1 / -1; min-height:0; overflow:auto; }
      .simulation-fields { padding-top:6px; } .simulation-fields div { display:grid; gap:2px; min-width:0; } .simulation-fields span,.simulation-row span { color:var(--vscode-descriptionForeground,#57606a); font-size:11px; } .simulation-fields strong,.simulation-row strong { overflow-wrap:anywhere; font-size:12px; } .available { color:#2f8f4e; } .unavailable { color:#b7791f; }
      .simulation-list { display:grid; gap:1px; border:1px solid var(--vscode-editorGroup-border,#d0d7de); } .simulation-row { display:grid; grid-template-columns:minmax(120px,1fr) minmax(160px,2fr) minmax(140px,2fr); gap:8px; padding:7px; background:var(--vscode-editor-background,#fff); }
      .offset-header { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 10px; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); }
      .offset-table { display:grid; gap:1px; background:var(--vscode-editorGroup-border,#d0d7de); }
      .offset-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(85px,1fr)) 30px; gap:6px; align-items:end; padding:7px; background:var(--vscode-editor-background,#fff); }
      .icon-button { width:28px; height:28px; border:1px solid var(--vscode-widget-border,#d0d7de); border-radius:3px; color:inherit; background:var(--vscode-button-secondaryBackground,#eaeef2); cursor:pointer; font-size:16px; }
      section { display:grid; gap:6px; padding:8px 10px; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); }
      .section-heading { display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:6px; }
      .field-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }
      .four-col-grid { grid-template-columns:repeat(4,minmax(0,1fr)); }
      .stock-dims-grid { grid-template-columns:repeat(auto-fit,minmax(90px,1fr)); }
      .transform-grid { grid-template-columns:repeat(3,minmax(0,1fr)); padding-top:6px; }
      .material-channel-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:5px; }
      .material-channel-card { display:flex; flex-direction:column; gap:2px; padding:5px 7px; border:1px solid var(--vscode-widget-border,#d0d7de); border-radius:4px; color:inherit; background:var(--vscode-editorGroupHeader-tabsBackground,#f6f8fa); text-align:left; cursor:pointer; }
      .material-channel-card.active { border-color:var(--vscode-focusBorder,#0969da); background:var(--vscode-tab-activeBackground,#fff); box-shadow:inset 0 2px 0 var(--vscode-focusBorder,#0969da); }
      .material-channel-title { font-size:11px; font-weight:600; }
      .material-channel-meta { color:var(--vscode-descriptionForeground,#57606a); font-size:10px; line-height:1.25; overflow-wrap:anywhere; }
      .material-preset-bar { display:flex; flex-wrap:wrap; gap:5px; }
      details { color:var(--vscode-descriptionForeground,#57606a); font-size:11px; }
      summary { cursor:pointer; padding:2px 0; font-weight:600; color:var(--vscode-editor-foreground,#24292f); }
      .accordion-body { display:grid; gap:6px; padding-top:6px; }
      [hidden] { display:none !important; }
      .assign-bar { display:flex; flex-wrap:wrap; align-items:center; gap:5px; padding:5px 8px; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); background:var(--vscode-editorGroupHeader-tabsBackground,#f6f8fa); flex-shrink:0; }
      .assign-bar select { flex:1 1 130px; min-width:110px; }
      .button { min-height:26px; padding:3px 8px; border:1px solid var(--vscode-widget-border,#d0d7de); border-radius:4px; color:var(--vscode-button-secondaryForeground,#24292f); background:var(--vscode-button-secondaryBackground,#eaeef2); font-size:11px; white-space:nowrap; cursor:pointer; }
      .button.primary { border-color:var(--vscode-button-background,#0969da); color:var(--vscode-button-foreground,#fff); background:var(--vscode-button-background,#0969da); font-weight:600; }
      .button.danger { color:var(--vscode-inputValidation-errorForeground,#fff); background:var(--vscode-inputValidation-errorBackground,#a40e26); }
      .button:disabled { opacity:.45; cursor:not-allowed; }
      .form-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:6px; padding:6px 8px; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); background:var(--vscode-editorGroupHeader-tabsBackground,#f6f8fa); }
      .notice,.empty { margin:5px 8px; padding:6px 8px; border:1px solid var(--vscode-widget-border,#d0d7de); border-radius:4px; font-size:11px; line-height:1.35; color:var(--vscode-descriptionForeground,#57606a); }
      .notice.warning { border-left:3px solid #b7791f; } .notice.error { border-left:3px solid #cf222e; }
      .status { min-height:22px; padding:3px 8px; border-top:1px solid var(--vscode-editorGroup-border,#d0d7de); color:var(--vscode-descriptionForeground,#57606a); font-size:11px; }
      .status.success { color:#2f8f4e; } .status.error { color:var(--vscode-inputValidation-errorBackground,#cf222e); }
      @media (max-width:720px) {
        .manager-body { grid-template-columns:1fr; grid-template-rows:auto minmax(0,1fr); }
        .tool-list-pane { display:none; max-height:180px; border-right:0; border-bottom:1px solid var(--vscode-editorGroup-border,#d0d7de); }
        .tool-list-pane.mobile-open { display:flex; }
        .mobile-drawer-bar { display:flex; }
        .mobile-only-btn { display:inline-flex; align-items:center; }
        .four-col-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
        .quick-config-row { grid-template-columns:72px minmax(0,1fr); gap:4px; }
        .transform-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
        .material-channel-grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
        .simulation-row { grid-template-columns:1fr; }
        input,select,.button,.pill-button,.station-pill,.template-pill { min-height:30px; font-size:11px; }
        .form-actions .button { flex:1 1 auto; text-align:center; justify-content:center; }
      }
      @media (pointer:coarse) {
        input,select,.button,.pill-button,.station-pill,.template-pill { min-height:30px; }
      }
    `;
  }
}

function optionalField<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: V };
}

customElements.define('nc-tool-manager-panel', NCToolManagerPanel);
