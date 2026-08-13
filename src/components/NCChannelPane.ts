import './NCCodePane';
import './NCKeywordPanel';
import './NCVariableList';
import './NCToolList';
import './NCExecutedList';
import './NCBottomPanel';
import './NCProgramManager';
import { ServiceRegistry } from '@core/ServiceRegistry';
import { CONFIG_SERVICE_TOKEN, EVENT_BUS_TOKEN, FILE_MANAGER_SERVICE_TOKEN, HOST_BRIDGE_SERVICE_TOKEN, MULTICHANNEL_ALIGNMENT_SERVICE_TOKEN, STATE_SERVICE_TOKEN } from '@core/ServiceTokens';
import { EventBus, EVENT_NAMES, EventSubscription } from '@services/EventBus';
import type { IConfigService } from '@services/config/IConfigService';
import type { IHostBridgeService } from '@services/HostBridgeService';
import type { IFileManagerService } from '@services/IFileManagerService';
import type { MultichannelAlignmentService } from '@services/MultichannelAlignmentService';

export class NCChannelPane extends HTMLElement {
  private channelId: string = '';
  private eventBus: EventBus;
  private stateService: import('@services/StateService').StateService;
  private configService: IConfigService;
  private hostBridge: IHostBridgeService;
  private fileManager: IFileManagerService;
  private alignmentService: MultichannelAlignmentService;
  private scrollSyncSubscription?: EventSubscription;
  private showEmbeddedBottomPanel = true;

  static get observedAttributes() {
    return ['channel-id'];
  }

  constructor() {
    super();
    const registry = ServiceRegistry.getInstance();
    this.eventBus = registry.get(EVENT_BUS_TOKEN);
    this.stateService = registry.get(STATE_SERVICE_TOKEN);
    this.configService = registry.get(CONFIG_SERVICE_TOKEN);
    this.hostBridge = registry.get(HOST_BRIDGE_SERVICE_TOKEN);
    this.fileManager = registry.get(FILE_MANAGER_SERVICE_TOKEN);
    this.alignmentService = registry.get(MULTICHANNEL_ALIGNMENT_SERVICE_TOKEN);
  }

  attributeChangedCallback(name: string, _oldValue: string, newValue: string) {
    if (name === 'channel-id') {
      this.channelId = newValue;
      this.render();
    }
  }

  async connectedCallback() {
    const config = await this.configService.getConfig();
    this.showEmbeddedBottomPanel = config.hostMode !== 'vscode-editor';
    this.render();
    this.setupEventListeners();
    this.scrollSyncSubscription = this.eventBus.subscribe(
      EVENT_NAMES.ALIGNMENT_SCROLL_SYNC_CHANGED,
      (data: unknown) => {
        const { enabled } = data as { enabled: boolean };
        this.querySelector('#align-channels')?.classList.toggle('active', enabled);
      },
    );
  }

  disconnectedCallback() {
    this.scrollSyncSubscription?.unsubscribe();
  }

  private setupEventListeners() {
    const sidebar = this.querySelector('#channel-sidebar');
    const overlay = this.querySelector('#sidebar-overlay');
    const sidebarToggle = this.querySelector('#sidebar-toggle');
    const programsToggle = this.querySelector('#programs-toggle');
    const alignButton = this.querySelector('#align-channels') as HTMLButtonElement | null;
    const removeAlignmentButton = this.querySelector('#remove-alignment') as HTMLButtonElement | null;
    const addSpacesButton = this.querySelector('#add-spaces') as HTMLButtonElement | null;
    const removeSpacesButton = this.querySelector('#remove-spaces') as HTMLButtonElement | null;
    
    const keywordPanel = this.querySelector('nc-keyword-panel') as HTMLElement;
    const toolsPanel = this.querySelector('.channel-tools-panel') as HTMLElement;
    const programManager = this.querySelector('nc-program-manager') as HTMLElement;

    const showSidebar = (mode: 'tools' | 'programs') => {
        sidebar?.classList.add('visible');
        overlay?.classList.add('visible');
        
        if (mode === 'tools') {
            keywordPanel.style.display = 'block';
            toolsPanel.style.display = 'block';
            programManager.style.display = 'none';
            sidebarToggle?.classList.add('active');
            programsToggle?.classList.remove('active');
        } else {
            keywordPanel.style.display = 'none';
            toolsPanel.style.display = 'none';
            programManager.style.display = 'flex';
            sidebarToggle?.classList.remove('active');
            programsToggle?.classList.add('active');
        }
    };

    const hideSidebar = () => {
        sidebar?.classList.remove('visible');
        overlay?.classList.remove('visible');
        sidebarToggle?.classList.remove('active');
        programsToggle?.classList.remove('active');
        // Revert to default view (tools) when hiding on mobile or toggling off on desktop
        keywordPanel.style.display = 'block';
        toolsPanel.style.display = 'block';
        programManager.style.display = 'none';
    };

    const toggleTools = () => {
        if (sidebarToggle?.classList.contains('active')) {
            hideSidebar();
        } else {
            showSidebar('tools');
        }
    };

    const togglePrograms = () => {
        if (programsToggle?.classList.contains('active')) {
            hideSidebar();
        } else {
            showSidebar('programs');
        }
    };

    sidebarToggle?.addEventListener('click', toggleTools);
    programsToggle?.addEventListener('click', togglePrograms);
    overlay?.addEventListener('click', hideSidebar);
    alignButton?.addEventListener('click', () => this.updateChannelAlignment('align'));
    removeAlignmentButton?.addEventListener('click', () => this.updateChannelAlignment('remove'));
    addSpacesButton?.addEventListener('click', () => this.updateChannelSpacing('add'));
    removeSpacesButton?.addEventListener('click', () => this.updateChannelSpacing('remove'));

    // Plot button
    const plotButton = this.querySelector('#plot-channel-btn');
    plotButton?.addEventListener('click', () => {
      try {
        // Ensure the plot viewer is opened (same UX as mobile)
        this.stateService.updateUISettings({ plotViewerOpen: true });
      } catch (e) {
        console.warn('StateService unavailable when opening plot viewer from channel', e);
      }

      this.eventBus.publish(EVENT_NAMES.PLOT_REQUEST, { channelId: this.channelId });

      // When Plot is pressed, also surface the variables pane so the user can
      // inspect the resulting state immediately in either host.
      this.hostBridge.openWorkbenchPanel('variables');

      const bottomPanel = this.querySelector('#bottom-panel') as
        | (HTMLElement & { open?: (tabName?: 'variables' | 'errors') => void })
        | null;
      bottomPanel?.open?.('variables');
    });

    // Forward keyword-click events to the code pane
    this.addEventListener('keyword-click', ((e: CustomEvent) => {
      const codePaneElement = this.querySelector('nc-code-pane');
      if (codePaneElement) {
        codePaneElement.dispatchEvent(
          new CustomEvent('keyword-click', {
            detail: e.detail,
            bubbles: false,
          }),
        );
      }

      // On mobile, close sidebar after selection
      if (window.innerWidth <= 768) {
        sidebar?.classList.remove('visible');
        overlay?.classList.remove('visible');
        sidebarToggle?.classList.remove('active');
      }
    }) as EventListener);
  }

  private async updateChannelAlignment(action: 'align' | 'remove'): Promise<void> {
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('#align-channels, #remove-alignment'),
    );

    try {
      buttons.forEach((button) => { button.disabled = true; });
      const state = this.stateService.getState();
      const controlType = state.activeMachine?.controlType;
      if (!controlType) throw new Error('Select a machine before aligning channels');

      const programs = this.stateService.getActiveChannels().map((channel) => ({
        channelId: channel.id,
        program: this.fileManager.getActiveProgram(channel.id)?.content ?? channel.program,
      }));
      const result = action === 'align'
        ? await this.alignmentService.alignPrograms(programs, controlType)
        : await this.alignmentService.removeAlignment(programs, controlType);

      result.programs.forEach(({ channelId, program }) => {
        this.fileManager.updateActiveProgramContent(channelId, program);
      });
      this.eventBus.publish(EVENT_NAMES.ALIGNMENT_SCROLL_SYNC_CHANGED, {
        enabled: action === 'align',
        sourceChannelId: this.channelId,
      });
    } catch (error) {
      console.error('Channel alignment failed:', error);
      const clickedButton = action === 'align'
        ? this.querySelector('#align-channels')
        : this.querySelector('#remove-alignment');
      if (clickedButton && error instanceof Error) clickedButton.setAttribute('title', error.message);
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  private updateChannelSpacing(action: 'add' | 'remove'): void {
    const activeProgram = this.fileManager.getActiveProgram(this.channelId);
    if (!activeProgram) return;

    const content = activeProgram.content.replace(/\r\n/g, '\n');
    const updatedContent = action === 'add'
      ? content.split('\n').map((line) => `  ${line}`).join('\n')
      : content.split('\n').map((line) => line.startsWith('  ') ? line.slice(2) : line).join('\n');

    this.fileManager.updateActiveProgramContent(this.channelId, updatedContent);
  }

  private render() {
    this.innerHTML = `
      <style>
        nc-channel-pane {
          display: flex;
          flex: 1;
          flex-direction: column;
          height: 100%;
          overflow: hidden;
          border: 1px solid var(--vscode-editorGroup-border, #181a1f);
        }
        .channel-header {
          padding: 8px;
          background: var(--vscode-editorGroupHeader-tabsBackground, #21252b);
          border-bottom: 1px solid var(--vscode-editorGroup-border, #181a1f);
          font-weight: bold;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .channel-controls {
          display: flex;
          gap: 4px;
        }
        .channel-button {
          padding: 2px 8px;
          background: var(--vscode-button-secondaryBackground, #3a3f4b);
          color: var(--vscode-button-secondaryForeground, #abb2bf);
          border: 1px solid var(--vscode-widget-border, #181a1f);
          border-radius: 3px;
          cursor: pointer;
          font-size: 11px;
        }
        .channel-button:hover {
          background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.05));
        }
        .channel-button.active {
          background: var(--vscode-button-background, #61afef);
          color: var(--vscode-button-foreground, #1f2329);
        }
        .alignment-button {
          width: 26px;
          min-width: 26px;
          padding: 2px;
          font-family: 'Consolas', monospace;
          font-size: 13px;
          font-weight: 700;
          white-space: nowrap;
        }
        .channel-content {
          display: flex;
          flex: 1;
          overflow: hidden;
        }
        .channel-sidebar {
          width: auto;
          min-width: 60px;
          max-width: 120px;
          background: var(--vscode-sideBar-background, #21252b);
          border-right: 1px solid var(--vscode-editorGroup-border, #181a1f);
          display: flex;
          flex-direction: column;
        }
        .channel-editor-area {
          flex: 1;
          display: flex;
          flex-direction: column;
          position: relative;
        }
        .channel-editor-wrapper {
          flex: 1;
          overflow: hidden;
        }
        .channel-tools-panel {
          height: 150px;
          border-top: 1px solid var(--vscode-editorGroup-border, #181a1f);
        }
        .mobile-sidebar-toggle {
          display: none;
        }

        /* Mobile Styles */
        @media (max-width: 768px) {
          .channel-sidebar {
            display: none;
            position: absolute;
            top: 45px; /* Increased from 35px to account for taller buttons */
            left: 0;
            height: calc(100% - 45px); /* Updated to match new top position */
            width: 85%;
            max-width: 300px;
            background: var(--vscode-editorWidget-background, #21252b);
            z-index: 50;
            border-right: 1px solid var(--vscode-editorGroup-border, #181a1f);
            box-shadow: 2px 0 10px rgba(0,0,0,0.5);
          }
          
          .channel-sidebar.visible {
            display: flex;
          }

          .mobile-sidebar-toggle {
            display: block !important;
          }
          
          .sidebar-overlay {
            display: none;
            position: absolute;
            top: 45px; /* Updated to match sidebar top position */
            left: 0;
            width: 100%;
            height: calc(100% - 45px); /* Updated to match sidebar height */
            background: rgba(0,0,0,0.5);
            z-index: 40;
          }
          
          .sidebar-overlay.visible {
            display: block;
          }

          .mobile-sidebar-toggle {
            display: block !important;
            padding: 8px 16px !important;
            font-size: 14px !important;
            min-height: 36px !important;
          }

          .channel-button {
            padding: 6px 12px !important;
            font-size: 13px !important;
            min-height: 32px !important;
          }
          .alignment-button {
            padding: 2px !important;
          }
        }
      </style>
      <div class="channel-header">
        <span>Channel ${this.channelId}</span>
        <div class="channel-controls">
          <button class="channel-button alignment-button" id="align-channels" title="Align active channels and synchronize scrolling" aria-label="Align active channels">=</button>
          <button class="channel-button alignment-button" id="remove-alignment" title="Remove channel alignment and stop synchronized scrolling" aria-label="Remove channel alignment">/=</button>
          <button class="channel-button alignment-button" id="add-spaces" title="Add two leading spaces to every line in this channel" aria-label="Add spaces to every line">||</button>
          <button class="channel-button alignment-button" id="remove-spaces" title="Remove two leading spaces from every line in this channel" aria-label="Remove spaces from every line">| |</button>
          <button class="channel-button" id="programs-toggle">Programs</button>
          <button class="channel-button" id="plot-channel-btn">▶️ Plot</button>
          <button class="channel-button mobile-sidebar-toggle" id="sidebar-toggle">Tools & Keywords</button>
        </div>
      </div>
      <div class="channel-content">
        <div class="sidebar-overlay" id="sidebar-overlay"></div>
        <div class="channel-sidebar" id="channel-sidebar">
          <nc-program-manager channel-id="${this.channelId}" style="display: none; flex: 1;"></nc-program-manager>
          <nc-keyword-panel channel-id="${this.channelId}" style="flex: 1;"></nc-keyword-panel>
          <div class="channel-tools-panel">
            <nc-tool-list channel-id="${this.channelId}"></nc-tool-list>
          </div>
        </div>
        <div class="channel-editor-area">
          <div class="channel-editor-wrapper">
            <nc-code-pane channel-id="${this.channelId}"></nc-code-pane>
          </div>
          ${this.showEmbeddedBottomPanel ? `<nc-bottom-panel channel-id="${this.channelId}" id="bottom-panel"></nc-bottom-panel>` : ''}
        </div>
      </div>
    `;

    // variable drawer is self-contained (toggle/resize handled inside component)
  }
}

customElements.define('nc-channel-pane', NCChannelPane);
