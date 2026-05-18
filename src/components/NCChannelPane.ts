import './NCCodePane';
import './NCKeywordPanel';
import './NCVariableList';
import './NCToolList';
import './NCExecutedList';
import './NCBottomPanel';
import './NCProgramManager';
import { ServiceRegistry } from '@core/ServiceRegistry';
import { CONFIG_SERVICE_TOKEN, EVENT_BUS_TOKEN, HOST_BRIDGE_SERVICE_TOKEN, STATE_SERVICE_TOKEN } from '@core/ServiceTokens';
import { EventBus, EVENT_NAMES } from '@services/EventBus';
import type { IConfigService } from '@services/config/IConfigService';
import type { IHostBridgeService } from '@services/HostBridgeService';

export class NCChannelPane extends HTMLElement {
  private channelId: string = '';
  private eventBus: EventBus;
  private stateService: import('@services/StateService').StateService;
  private configService: IConfigService;
  private hostBridge: IHostBridgeService;
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
  }

  private setupEventListeners() {
    const sidebar = this.querySelector('#channel-sidebar');
    const overlay = this.querySelector('#sidebar-overlay');
    const sidebarToggle = this.querySelector('#sidebar-toggle');
    const programsToggle = this.querySelector('#programs-toggle');
    
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
        }
      </style>
      <div class="channel-header">
        <span>Channel ${this.channelId}</span>
        <div class="channel-controls">
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
