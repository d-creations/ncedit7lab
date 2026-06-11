import './NCVariablesPanelContent';
import './NCErrorsPanelContent';
import './NCTransferPanel';
import { ServiceRegistry } from '@core/ServiceRegistry';
import { EVENT_BUS_TOKEN, STATE_SERVICE_TOKEN, PARSER_SERVICE_TOKEN, FILE_MANAGER_SERVICE_TOKEN, CONFIG_SERVICE_TOKEN } from '@core/ServiceTokens';
import type { ChannelId, ExecutedProgramResult, VariableValue } from '@core/types';
import { EventBus, EVENT_NAMES, type EventSubscription } from '@services/EventBus';
import { ParserService } from '@services/ParserService';
import type { IFileManagerService } from '@services/IFileManagerService';
import { StateService } from '@services/StateService';
import type { IConfigService } from '@services/config/IConfigService';
import type { WorkbenchTab } from '@services/HostBridgeService';

export class NCWorkbenchPanelApp extends HTMLElement {
  private stateService: StateService;
  private eventBus: EventBus;
  private parserService: ParserService;
  private fileManager: IFileManagerService;
  private configService: IConfigService;
  private activeTab: WorkbenchTab = 'variables';
  private showTransferPanel = true;
  private subscriptions: EventSubscription[] = [];
  private fileSyncListener?: EventListener;
  private bridgeListener?: EventListener;
  private panelCommandListener?: EventListener;

  constructor() {
    super();
    const registry = ServiceRegistry.getInstance();
    this.stateService = registry.get(STATE_SERVICE_TOKEN);
    this.eventBus = registry.get(EVENT_BUS_TOKEN);
    this.parserService = registry.get(PARSER_SERVICE_TOKEN);
    this.fileManager = registry.get(FILE_MANAGER_SERVICE_TOKEN);
    this.configService = registry.get(CONFIG_SERVICE_TOKEN);
    this.attachShadow({ mode: 'open' });
  }

  async connectedCallback(): Promise<void> {
    const config = await this.configService.getConfig();
    this.showTransferPanel = config.showTransferPanel;
    if (!this.showTransferPanel && this.activeTab === 'transfer') {
      this.activeTab = 'variables';
    }

    this.render();
    this.attachEventListeners();
    this.subscribeToState();
    this.attachHostListeners();
  }

  disconnectedCallback() {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
    this.subscriptions = [];
    if (this.fileSyncListener) {
      window.removeEventListener('vscode:files-opened', this.fileSyncListener);
    }
    if (this.bridgeListener) {
      window.removeEventListener('vscode:workbench-bridge', this.bridgeListener);
    }
    if (this.panelCommandListener) {
      window.removeEventListener('message', this.panelCommandListener);
    }
  }

  private subscribeToState() {
    this.subscriptions.push(
      this.eventBus.subscribe(EVENT_NAMES.STATE_CHANGED, () => {
        this.syncFromState();
      }),
    );

    this.subscriptions.push(
      this.eventBus.subscribe(EVENT_NAMES.CHANNEL_ACTIVATED, () => {
        this.syncFromState();
      }),
    );

    this.subscriptions.push(
      this.eventBus.subscribe(EVENT_NAMES.CHANNEL_DEACTIVATED, () => {
        this.syncFromState();
      }),
    );
  }

  private attachEventListeners() {
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('.channel-button').forEach((button) => {
      button.addEventListener('click', () => {
        const channelId = button.dataset.channel as ChannelId | undefined;
        if (channelId) {
          this.stateService.setWorkbenchSelectedChannel(channelId);
        }
      });
    });

    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('.tab-button').forEach((button) => {
      button.addEventListener('click', () => {
        const tab = button.dataset.tab as WorkbenchTab | undefined;
        if (!tab || tab === this.activeTab) return;
        this.activeTab = tab;
        this.syncTabState();
      });
    });
  }

  private attachHostListeners() {
    this.fileSyncListener = ((event: Event) => {
      const detail = (event as CustomEvent).detail as { activeChannel?: string } | undefined;
      if (detail?.activeChannel && ['1', '2', '3'].includes(detail.activeChannel)) {
        this.stateService.setWorkbenchSelectedChannel(detail.activeChannel as ChannelId);
      }

      void this.parseAvailableChannels();
    }) as EventListener;
    window.addEventListener('vscode:files-opened', this.fileSyncListener);

    this.bridgeListener = ((event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { type: 'WORKBENCH_BRIDGE'; eventType: 'EXECUTION_COMPLETED'; payload: { channelId: string; result: { variableSnapshotEntries: Array<[number, number]>; namedVariableSnapshotEntries?: Array<[string, VariableValue]>; errors: unknown[] } } }
        | { type: 'WORKBENCH_BRIDGE'; eventType: 'EXECUTION_ERROR'; payload: { channelId: string; error: { message: string } } }
        | { type: 'WORKBENCH_BRIDGE'; eventType: 'PLOT_CLEARED'; payload: Record<string, never> };

      if (!detail || detail.type !== 'WORKBENCH_BRIDGE') return;

      if (detail.eventType === 'EXECUTION_COMPLETED') {
        if (['1', '2', '3'].includes(detail.payload.channelId)) {
          this.stateService.setWorkbenchSelectedChannel(detail.payload.channelId as ChannelId);
        }

        const result: ExecutedProgramResult = {
          executedLines: [],
          variableSnapshot: new Map(detail.payload.result.variableSnapshotEntries),
          namedVariableSnapshot: new Map(detail.payload.result.namedVariableSnapshotEntries || []),
          timingData: new Map(),
          plotMetadata: { points: [], segments: [] },
          errors: detail.payload.result.errors as ExecutedProgramResult['errors'],
        };

        const hasErrors = Array.isArray(result.errors) && result.errors.length > 0;
        this.activeTab = hasErrors ? 'errors' : 'variables';
        this.syncTabState();

        this.eventBus.publish(EVENT_NAMES.EXECUTION_COMPLETED, {
          channelId: detail.payload.channelId,
          result,
        });
      }

      if (detail.eventType === 'EXECUTION_ERROR') {
        if (['1', '2', '3'].includes(detail.payload.channelId)) {
          this.stateService.setWorkbenchSelectedChannel(detail.payload.channelId as ChannelId);
        }

        this.activeTab = 'errors';
        this.syncTabState();

        this.eventBus.publish(EVENT_NAMES.EXECUTION_ERROR, {
          channelId: detail.payload.channelId,
          error: detail.payload.error,
        });
      }

      if (detail.eventType === 'PLOT_CLEARED') {
        this.eventBus.publish(EVENT_NAMES.PLOT_CLEARED, undefined);
      }
    }) as EventListener;
    window.addEventListener('vscode:workbench-bridge', this.bridgeListener);

    this.panelCommandListener = ((event: Event) => {
      const detail = (event as CustomEvent).detail as { tab?: WorkbenchTab } | undefined;
      if (!detail) return;

      if (detail.tab && detail.tab !== this.activeTab) {
        this.activeTab = detail.tab;
      }

      this.syncTabState();
    }) as EventListener;
    window.addEventListener('vscode:workbench-panel-command', this.panelCommandListener);
  }

  private syncFromState() {
    const selectedChannel = this.stateService.getWorkbenchSelectedChannel();
    const activeChannels = this.stateService.getActiveChannels().map((channel) => channel.id);

    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('.channel-button').forEach((button) => {
      const channelId = button.dataset.channel as ChannelId | undefined;
      if (!channelId) return;

      button.classList.toggle('active', channelId === selectedChannel);
      button.disabled = !activeChannels.includes(channelId);
    });

    const variablesView = this.shadowRoot?.querySelector('nc-variables-panel-content');
    if (variablesView) {
      variablesView.setAttribute('channel-id', selectedChannel);
    }

    const errorsView = this.shadowRoot?.querySelector('nc-errors-panel-content');
    if (errorsView) {
      errorsView.setAttribute('channel-id', selectedChannel);
    }
  }

  private syncTabState() {
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('.tab-button').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === this.activeTab);
    });

    this.shadowRoot?.querySelectorAll<HTMLElement>('.tab-panel').forEach((panel) => {
      panel.style.display = panel.dataset.tabPanel === this.activeTab ? 'flex' : 'none';
    });
  }

  private async parseAvailableChannels() {
    const regexPatterns = this.stateService.getState().activeMachine?.regexPatterns;
    const activeChannels = this.stateService.getActiveChannels();

    for (const channel of activeChannels) {
      const activeProgram = this.fileManager.getActiveProgram(channel.id);
      if (!activeProgram) continue;

      await this.parserService.parse(activeProgram.content, channel.id, { regexPatterns });
    }
  }

  private render() {
    if (!this.shadowRoot) return;

    const selectedChannel = this.stateService.getWorkbenchSelectedChannel();
    const activeChannels = this.stateService.getActiveChannels().map((channel) => channel.id);

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: flex;
          flex-direction: column;
          width: 100%;
          height: 100%;
          min-height: 0;
          overflow: hidden;
          background: var(--vscode-editor-background, #1e1e1e);
          color: var(--vscode-editor-foreground, #cccccc);
          font-family: var(--vscode-font-family, monospace);
        }

        .header {
          display: flex;
          flex-direction: column;
          flex: 0 0 auto;
          gap: 8px;
          padding: 10px;
          border-bottom: 1px solid var(--vscode-editorGroup-border, #3c3c3c);
          background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
        }

        .title-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .tab-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: nowrap;
        }

        .title {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--vscode-descriptionForeground, #9d9d9d);
        }

        .channel-switcher {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }

        .channel-button,
        .tab-button {
          padding: 4px 10px;
          border-radius: 4px;
          border: 1px solid var(--vscode-widget-border, #454545);
          background: var(--vscode-button-secondaryBackground, #3a3d41);
          color: var(--vscode-button-secondaryForeground, #cccccc);
          cursor: pointer;
          font-size: 12px;
        }

        .tabs,
        .channel-switcher {
          flex-wrap: nowrap;
        }

        .tabs {
          display: flex;
          gap: 6px;
          flex: 1 1 auto;
        }

        .channel-switcher {
          margin-left: auto;
        }

        .channel-button.active,
        .tab-button.active {
          background: var(--vscode-button-background, #0e639c);
          color: var(--vscode-button-foreground, #ffffff);
          border-color: var(--vscode-button-background, #0e639c);
        }

        .channel-button:disabled {
          opacity: 0.45;
          cursor: default;
        }

        .tabs {
          display: flex;
          gap: 6px;
        }

        .tab-panels {
          display: flex;
          flex-direction: column;
          flex: 1;
          min-height: 0;
          overflow: hidden;
        }

        .tab-panel {
          display: none;
          height: 100%;
          min-height: 0;
          overflow: hidden;
        }

        .tab-panel.active {
          display: flex;
          flex-direction: column;
        }

        nc-variables-panel-content,
        nc-errors-panel-content,
        nc-transfer-panel {
          display: block;
          flex: 1;
          min-height: 0;
          height: 100%;
        }
      </style>

      <div class="header">
        <div class="title-row">
        </div>
        <div class="tab-row">
          <div class="tabs">
            <button class="tab-button ${this.activeTab === 'variables' ? 'active' : ''}" data-tab="variables">Variables</button>
            <button class="tab-button ${this.activeTab === 'errors' ? 'active' : ''}" data-tab="errors">Errors</button>
            ${this.showTransferPanel ? `<button class="tab-button ${this.activeTab === 'transfer' ? 'active' : ''}" data-tab="transfer">Transfer</button>` : ''}
          </div>
          <div class="channel-switcher">
            <button class="channel-button ${selectedChannel === '1' ? 'active' : ''}" data-channel="1" ${activeChannels.includes('1') ? '' : 'disabled'}>CH 1</button>
            <button class="channel-button ${selectedChannel === '2' ? 'active' : ''}" data-channel="2" ${activeChannels.includes('2') ? '' : 'disabled'}>CH 2</button>
            <button class="channel-button ${selectedChannel === '3' ? 'active' : ''}" data-channel="3" ${activeChannels.includes('3') ? '' : 'disabled'}>CH 3</button>
          </div>
        </div>
      </div>

      <div class="tab-panels">
        <div class="tab-panel ${this.activeTab === 'variables' ? 'active' : ''}" data-tab-panel="variables">
          <nc-variables-panel-content channel-id="${selectedChannel}"></nc-variables-panel-content>
        </div>
        <div class="tab-panel ${this.activeTab === 'errors' ? 'active' : ''}" data-tab-panel="errors">
          <nc-errors-panel-content channel-id="${selectedChannel}"></nc-errors-panel-content>
        </div>
        ${this.showTransferPanel ? `<div class="tab-panel ${this.activeTab === 'transfer' ? 'active' : ''}" data-tab-panel="transfer"><nc-transfer-panel></nc-transfer-panel></div>` : ''}
      </div>
    `;
  }
}

customElements.define('nc-workbench-panel-app', NCWorkbenchPanelApp);