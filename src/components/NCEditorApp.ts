// Root Web Component for NC-Edit7 application

import type { ChannelId } from '@core/types';
import { ServiceRegistry } from '@core/ServiceRegistry';
import { BACKEND_GATEWAY_TOKEN, STATE_SERVICE_TOKEN, MACHINE_SERVICE_TOKEN, EVENT_BUS_TOKEN, FILE_MANAGER_SERVICE_TOKEN, CONFIG_SERVICE_TOKEN } from '@core/ServiceTokens';
import { StateService } from '@services/StateService';
import { MachineService } from '@services/MachineService';
import { EventBus, EVENT_NAMES } from '@services/EventBus';
import type { AppConfiguration, IConfigService } from '@services/config/IConfigService';
import './NCChannelPane';
import './NCSyncControls';
import './NCStatusIndicator';
import './NCMachineSelector';
import './NCToolpathPlot';
import './NCDrawBoardPanel';
import './NCFileManager'; // Keep for global file loading if needed, but removed from template
import './NCFocasTransfer';

// Constants for plot panel sizing
const PLOT_PANEL_MIN_WIDTH = 200;
const PLOT_PANEL_MAX_WIDTH_RATIO = 0.8;

export class NCEditorApp extends HTMLElement {
  private registry: ServiceRegistry;
  private stateService: StateService;
  private machineService: MachineService;
  private eventBus: EventBus;
  private configService: IConfigService;
  private activeMobileView: string = 'channel-1';
  private config?: AppConfiguration;

  constructor() {
    super();
    this.registry = ServiceRegistry.getInstance();

    // Get services from registry
    this.stateService = this.registry.get(STATE_SERVICE_TOKEN);
    this.machineService = this.registry.get(MACHINE_SERVICE_TOKEN);
    this.eventBus = this.registry.get(EVENT_BUS_TOKEN);
    this.configService = this.registry.get(CONFIG_SERVICE_TOKEN);
  }

  async connectedCallback(): Promise<void> {
    await this.render();
    await this.init();
    this.setupIframeListener();
  }

  private setupIframeListener() {
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (data && typeof data === 'object') {
        if (data.command === 'openFile' || data.type === 'OPEN_NC_FILE') {
            const content = data.content || data.code;
            const name = data.name || 'imported.mpf';
            const options = data.options || { parseMultiChannel: true };
            
            if (content) {
                const fileManager = this.registry.get(FILE_MANAGER_SERVICE_TOKEN);
                fileManager.openFile(content, name, options);
            }
        }
      }
    });
  }

  private async init(): Promise<void> {
    try {
      const config = this.config ?? await this.configService.getConfig();
      this.config = config;

      if (!config.showFocasTransfer || config.focasPlacement === 'external-panel' || config.focasPlacement === 'disabled') {
        this.hideEmbeddedFocas();
      }

      // Check feature flags
      this.registry.get(BACKEND_GATEWAY_TOKEN).getFeatures().then(features => {
        if (!features.focas_enabled) {
          this.hideEmbeddedFocas();
        }
      }).catch(() => { /* Ignore network feature check errors on init */ });

      // Initialize machine service
      await this.machineService.init();

      // Set up initial machine
      const machines = this.machineService.getMachines();
      if (machines.length > 0) {
        this.stateService.setMachines(machines);
        this.stateService.setGlobalMachine(machines[0].machineName);
      }

      // No need to update selector manually, component handles it
    } catch (error) {
      console.error('Failed to initialize app:', error);
      this.showError('Failed to initialize application');
    }
  }

  private hideEmbeddedFocas(): void {
    const focasToggle = this.querySelector('#focas-toggle');
    if (focasToggle) {
      (focasToggle as HTMLElement).style.display = 'none';
    }

    const focasTab = this.querySelector('.side-tab[data-view="focas"]');
    if (focasTab) {
      (focasTab as HTMLElement).style.display = 'none';
    }

    const focasView = this.querySelector('#side-view-focas');
    if (focasView) {
      (focasView as HTMLElement).style.display = 'none';
    }
  }

  private async render(): Promise<void> {
    const config = this.config ?? await this.configService.getConfig();
    this.config = config;
    const showDrawPanel = config.showDrawPanel;
    const showFocasTransfer = config.showFocasTransfer;

    this.innerHTML = `
      <style>
        nc-editor-app {
          display: flex;
          flex-direction: column;
          width: 100%;
          height: 100%;
          background: var(--vscode-editor-background, #282c34);
          color: var(--vscode-editor-foreground, #abb2bf);
          /* CSS custom properties for consistent sizing */
          --bottom-nav-height: 70px;
        }

        .app-header {
          display: flex;
          align-items: center;
          gap: 16px;
          /* Use safe area inset so header content won't be covered by iPhone URL/notch */
          padding: calc(8px + env(safe-area-inset-top, 0px)) 16px 8px 16px;
          background: var(--vscode-titleBar-activeBackground, var(--vscode-editorGroupHeader-tabsBackground, #21252b));
          border-bottom: 1px solid var(--vscode-editorGroup-border, #181a1f);
        }

        .app-title {
          font-size: 18px;
          font-weight: 600;
          color: var(--vscode-textLink-foreground, #61afef);
        }

        .app-channel-controls {
          display: flex;
          gap: 8px;
          margin-left: auto;
        }

        .app-channel-toggle {
          padding: 4px 12px;
          background: var(--vscode-button-background, #61afef);
          color: var(--vscode-button-foreground, #1f2329);
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
        }

        .app-channel-toggle.inactive {
          background: var(--vscode-button-secondaryBackground, #3a3f4b);
          color: var(--vscode-disabledForeground, #7f848e);
        }

        .app-focas-toggle {
          padding: 4px 12px;
          background: var(--vscode-button-secondaryBackground, #3a3f4b);
          color: var(--vscode-button-secondaryForeground, #abb2bf);
          border: 1px solid var(--vscode-widget-border, #181a1f);
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
        }

        .app-focas-toggle.active {
          background: var(--vscode-button-background, #61afef);
          color: var(--vscode-button-foreground, #1f2329);
        }

        .app-plot-toggle {
          padding: 4px 12px;
          background: var(--vscode-button-secondaryBackground, #3a3f4b);
          color: var(--vscode-button-secondaryForeground, #abb2bf);
          border: 1px solid var(--vscode-widget-border, #181a1f);
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
        }

        .app-plot-toggle.active {
          background: var(--vscode-button-background, #61afef);
          color: var(--vscode-button-foreground, #1f2329);
        }

        /* Small open-bar that shows when plot panel is hidden */
        .plot-open-bar {
          /* integrated as a normal flex child between channels and plot container */
          width: 36px;
          height: 100%;
          flex: 0 0 36px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--vscode-button-background, #61afef);
          color: var(--vscode-button-foreground, #1f2329);
          cursor: pointer;
          border-radius: 6px 0 0 6px;
          border: 1px solid var(--vscode-focusBorder, #528bff);
          z-index: 200;
          /* make the label render vertically so it's readable in narrow bar */
          writing-mode: vertical-rl;
          text-orientation: mixed;
          font-weight: 600;
          font-size: 13px;
        }
        .plot-open-bar:hover {
          background: var(--vscode-button-hoverBackground, #70b7ff);
        }
        .plot-open-bar.hidden {
          display: none;
        }

        .app-main-content {
          display: flex;
          flex: 1;
          overflow: hidden;
          position: relative; /* anchor absolute open-bar */
        }

        .app-sidebar {
          width: 250px;
          background: var(--vscode-sideBar-background, #21252b);
          border-right: 1px solid var(--vscode-sideBar-border, var(--vscode-editorGroup-border, #181a1f));
          overflow-y: auto;
        }

        .app-channel-container {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .app-focas-container {
          width: 350px;
          display: none;
          background: var(--vscode-editor-background, #282c34);
        }
        
        .app-main-content.show-focas .app-focas-container {
          display: block;
        }

        .app-plot-container {
          width: 0;
          display: none;
          background: var(--vscode-editor-background, #282c34);
          border-left: 1px solid var(--vscode-editorGroup-border, #181a1f);
          overflow: hidden;
          position: relative;
        }

        .app-plot-container.visible {
          display: flex;
          width: 400px;
          min-width: 200px; /* PLOT_PANEL_MIN_WIDTH */
          max-width: 80%; /* PLOT_PANEL_MAX_WIDTH_RATIO */
        }

        .plot-resize-handle {
          width: 6px;
          cursor: ew-resize;
          background: var(--vscode-editorGroup-border, #181a1f);
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.2s;
        }

        .plot-resize-handle:hover {
          background: var(--vscode-button-background, #61afef);
        }

        .plot-resize-handle::before {
          content: '⋮';
          color: #888;
          font-size: 14px;
        }

        .plot-resize-handle:hover::before {
          color: #fff;
        }

        .plot-content {
          flex: 1;
          overflow: hidden;
        }

        .plot-hide-bar {
          position: absolute;
          top: 50%;
          left: 0;
          transform: translateY(-50%);
          width: 16px;
          height: 40px;
          background: var(--vscode-button-secondaryBackground, #3a3f4b);
          border: 1px solid var(--vscode-widget-border, #181a1f);
          border-left: none;
          border-radius: 0 4px 4px 0;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10;
        }

        .plot-hide-bar:hover {
          background: var(--vscode-button-background, #61afef);
        }

        .plot-hide-bar::before {
          content: '›';
          color: var(--vscode-button-secondaryForeground, #abb2bf);
          font-size: 14px;
          font-weight: bold;
        }

        .app-channels {
          display: flex;
          flex: 1;
          gap: 4px;
          padding: 4px;
          overflow: hidden;
        }

        nc-channel-pane {
          display: none;
        }

        .app-status-bar {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 4px 16px;
          background: var(--vscode-statusBar-background, #21252b);
          color: var(--vscode-statusBar-foreground, #abb2bf);
          font-size: 12px;
        }

        .error-message {
          padding: 16px;
          background: var(--vscode-inputValidation-errorBackground, #e06c75);
          color: var(--vscode-inputValidation-errorForeground, #1f2329);
          margin: 8px;
          border-radius: 4px;
        }

        /* Mobile Styles */
        @media (max-width: 768px) {
          .app-header {
            /* add extra top padding on iOS devices (safe area) */
            padding-top: calc(8px + env(safe-area-inset-top, 0px));
            padding-right: 12px;
            padding-bottom: 8px;
            padding-left: 12px;
            box-sizing: border-box;
          }
          
          .app-channel-controls {
            display: none; /* Hide desktop controls on mobile */
          }

          .mobile-channels-btn {
            display: block !important;
            margin-left: auto;
            padding: 8px 16px !important;
            font-size: 14px !important;
            min-height: 36px !important;
          }

          .app-main-content {
            flex-direction: column;
            padding-bottom: var(--bottom-nav-height);
          }

          .app-channel-container {
            width: 100%;
            height: 100%;
          }

          .app-channels {
            flex-direction: column;
          }

          nc-channel-pane {
            width: 100%;
            height: 100%;
            display: none; /* Controlled by JS */
          }

          .app-plot-container {
            position: absolute;
            /* ensure full-screen mobile plot respects iPhone safe area and bottom nav */
            top: 0;
            left: 0;
            width: 100% !important;
            bottom: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom, 0px));
            height: auto;
            z-index: 100;
            border-left: none;
          }

          .app-plot-container.visible {
            display: flex;
            max-width: 100%;
          }

          .plot-resize-handle, .plot-hide-bar {
            display: none;
          }
          .plot-open-bar {
            display: none;
          }

          .app-bottom-nav {
            display: flex;
            position: fixed;
            bottom: 0;
            left: 0;
            width: 100%;
            height: var(--bottom-nav-height);
            background: var(--vscode-sideBar-background, #21252b);
            border-top: 1px solid var(--vscode-editorGroup-border, #181a1f);
            z-index: 200;
          }

          .nav-item {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            color: var(--vscode-disabledForeground, #7f848e);
            font-size: 14px; /* Increased from 12px */
            cursor: pointer;
            border: none;
            background: transparent;
            padding: 10px; /* Increased from 8px */
            min-height: 60px; /* Increased from 50px */
          }

          .nav-item.active {
            color: var(--vscode-button-background, #61afef);
            background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.05));
          }

          .nav-item.disabled {
            opacity: 0.3;
            pointer-events: none;
          }

          .nav-icon {
            font-size: 24px; /* Increased from 20px */
            margin-bottom: 6px; /* Increased from 4px */
          }
          /* add extra bottom padding for iPhone bottom bar (home indicator) */
          .app-bottom-nav { padding-bottom: env(safe-area-inset-bottom, 0px); }
        }

        @media (min-width: 769px) {
          .app-bottom-nav {
            display: none;
          }
        }
      </style>

      <div class="app-header">
        <span class="app-title">NC-Edit7</span>
        <nc-machine-selector></nc-machine-selector>
        <div class="app-channel-controls">
          <button class="app-channel-toggle" data-channel="1">Channel 1</button>
          <button class="app-channel-toggle" data-channel="2">Channel 2</button>
          <button class="app-channel-toggle" data-channel="3">Channel 3</button>
          ${showFocasTransfer ? '<button class="app-focas-toggle" id="focas-toggle" title="CNC FOCAS Transfer">Transfer</button>' : ''}
          <!-- plot toggle removed from header — small open bar sits beside the plot container when hidden -->
        </div>
        <button class="app-channel-toggle mobile-channels-btn" id="mobile-channels-btn" style="display: none;">Channels</button>
      </div>

      <nc-file-manager style="display: block; border-bottom: 1px solid var(--vscode-editorGroup-border, #181a1f);"></nc-file-manager>

      <div class="app-main-content" id="main-content">
        <div class="app-channel-container">
          <div class="app-channels" id="channels">
            <nc-channel-pane channel-id="1" data-channel="1"></nc-channel-pane>
            <nc-channel-pane channel-id="2" data-channel="2"></nc-channel-pane>
            <nc-channel-pane channel-id="3" data-channel="3"></nc-channel-pane>
          </div>
        </div>
        <!-- small open bar that appears when plot panel is hidden and integrated into layout -->
        <div id="plot-open-bar" class="plot-open-bar hidden" title="Open side panel">📈 Tools</div>
        
        <div class="app-plot-container" id="plot-container">
          <div class="plot-resize-handle" id="plot-resize-handle"></div>
          <div class="plot-content" style="display: flex; flex-direction: column;">
            <div class="side-panel-tabs" style="display: flex; background: var(--vscode-editorGroupHeader-tabsBackground, #2d2d2d); border-bottom: 1px solid var(--vscode-editorGroup-border, #3e3e42);">
              <button class="side-tab active" data-view="plot" style="flex:1; padding: 6px; background: var(--vscode-tab-activeBackground, #1e1e1e); color: var(--vscode-tab-activeForeground, #ffffff); border: none; cursor: pointer; border-top: 2px solid var(--vscode-tab-activeBorderTop, #007fd4);">Plot</button>
              ${showDrawPanel ? '<button class="side-tab" data-view="draw" style="flex:1; padding: 6px; background: var(--vscode-tab-inactiveBackground, #2d2d2d); color: var(--vscode-tab-inactiveForeground, #cccccc); border: none; cursor: pointer; border-top: 2px solid transparent;">Draw</button>' : ''}
              ${showFocasTransfer ? '<button class="side-tab" data-view="focas" style="flex:1; padding: 6px; background: var(--vscode-tab-inactiveBackground, #2d2d2d); color: var(--vscode-tab-inactiveForeground, #cccccc); border: none; cursor: pointer; border-top: 2px solid transparent;">FOCAS</button>' : ''}
            </div>
            <div id="side-view-plot" style="flex: 1; overflow: hidden; display: block;">
              <nc-toolpath-plot></nc-toolpath-plot>
            </div>
            ${showDrawPanel ? '<div id="side-view-draw" style="flex: 1; overflow: hidden; display: none;"><nc-draw-board-panel></nc-draw-board-panel></div>' : ''}
            ${showFocasTransfer ? '<div id="side-view-focas" style="flex: 1; overflow: hidden; display: none;"><nc-focas-transfer></nc-focas-transfer></div>' : ''}
          </div>
          <div class="plot-hide-bar" id="plot-hide-bar" title="Hide side panel"></div>
        </div>

        ${showFocasTransfer ? '<div class="app-focas-container" id="focas-container"><nc-focas-transfer></nc-focas-transfer></div>' : ''}
      </div>

      <div class="app-status-bar">
        <nc-status-indicator></nc-status-indicator>
        <span id="status-details"></span>
      </div>

      <div class="app-bottom-nav">
        <button class="nav-item active" data-view="channel-1">
          <span class="nav-icon">1️⃣</span>
          <span>CH 1</span>
        </button>
        <button class="nav-item" data-view="channel-2">
          <span class="nav-icon">2️⃣</span>
          <span>CH 2</span>
        </button>
        <button class="nav-item" data-view="channel-3">
          <span class="nav-icon">3️⃣</span>
          <span>CH 3</span>
        </button>
        <button class="nav-item" data-view="plot">
          <span class="nav-icon">📈</span>
          <span>Plot</span>
        </button>
        ${showDrawPanel ? '<button class="nav-item" data-view="draw"><span class="nav-icon">✏️</span><span>Draw</span></button>' : ''}
      </div>
    `;

    this.attachEventListeners();

    // Ensure the open-bar / plot panel initial visibility matches saved UI state
    try {
      const visible = this.stateService.getState().uiSettings.plotViewerOpen;
      this.setPlotViewerVisible(visible);
    } catch (e) {
      // ignore if state unavailable
    }
  }

  private attachEventListeners(): void {
    // FOCAS transfer toggle
    const focasToggle = this.querySelector('#focas-toggle') as HTMLButtonElement;
    if (focasToggle) {
      focasToggle.addEventListener('click', () => {
        this.setPlotViewerVisible(true);
        this.switchSidePanelView('focas');
      });
    }

    // Side panel tabs
    const sideTabs = this.querySelectorAll('.side-tab');
    sideTabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        const btn = e.currentTarget as HTMLButtonElement;
        const view = btn.dataset.view;
        if (view) this.switchSidePanelView(view);
      });
    });

    // Channel toggles
    const toggles = this.querySelectorAll('.app-channel-toggle');
    toggles?.forEach((toggle) => {
      const button = toggle as HTMLButtonElement;
      const channelId = button.dataset.channel as ChannelId;
      const channel = this.stateService.getChannel(channelId);

      // Set initial button state based on channel's active state
      if (!channel?.active) {
        button.classList.add('inactive');
      }

      toggle.addEventListener('click', (e) => {
        const button = e.target as HTMLButtonElement;
        const channelId = button.dataset.channel as ChannelId;
        const channel = this.stateService.getChannel(channelId);

        if (channel?.active) {
          this.stateService.deactivateChannel(channelId);
          button.classList.add('inactive');
        } else {
          this.stateService.activateChannel(channelId);
          button.classList.remove('inactive');
        }

        this.updateChannelDisplay();
      });
    });

    // Initialize channel display on load
    this.updateChannelDisplay();

    // Header plot toggle removed — handle the new open-bar element instead
    const plotOpenBar = this.querySelector('#plot-open-bar');
    plotOpenBar?.addEventListener('click', () => {
      this.setPlotViewerVisible(true);
      this.switchSidePanelView('plot');
    });

    const plotRequest = this.querySelector('#plot-request');
    plotRequest?.addEventListener('click', () => {
      this.setPlotViewerVisible(true);
      this.eventBus.publish(EVENT_NAMES.PLOT_REQUEST, undefined);
    });

    // Listen for plot requests — open the plot viewer on desktop and switch mobile view
    this.eventBus.subscribe(EVENT_NAMES.PLOT_REQUEST, () => {
      // Always open the plot viewer (so channel plot opens the panel on desktop too)
      this.setPlotViewerVisible(true);

      // On mobile, also switch to the dedicated plot view
      if (window.innerWidth <= 768) {
        this.switchMobileView('plot');
      }
    });

    // Hide bar to close the plot panel
    const plotHideBar = this.querySelector('#plot-hide-bar');
    plotHideBar?.addEventListener('click', () => {
      this.setPlotViewerVisible(false);
    });

    // Resize handle for plot panel
    this.setupResizeHandle();

    // Window resize listener
    window.addEventListener('resize', () => {
      this.updateChannelDisplay();
    });

    // Mobile Bottom Nav
    const navItems = this.querySelectorAll('.nav-item');
    navItems?.forEach((item) => {
      item.addEventListener('click', (e) => {
        const button = e.currentTarget as HTMLElement;
        const view = button.dataset.view;
        if (view) {
          this.switchMobileView(view);
        }
      });
    });

    // Mobile Channels Button
    const mobileChannelsBtn = this.querySelector('#mobile-channels-btn');
    mobileChannelsBtn?.addEventListener('click', () => {
      this.showMobileChannelDialog();
    });
  }

  private showMobileChannelDialog(): void {
    // Simple dialog to toggle channels
    const dialog = document.createElement('div');
    dialog.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.8);
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    const content = document.createElement('div');
    content.style.cssText = `
      background: var(--vscode-editorWidget-background, #21252b);
      padding: 20px;
      border-radius: 8px;
      width: 80%;
      max-width: 300px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    `;

    const title = document.createElement('h3');
    title.textContent = 'Active Channels';
    title.style.margin = '0 0 10px 0';
    content.appendChild(title);

    ['1', '2', '3'].forEach((id) => {
      const channelId = id as ChannelId;
      const channel = this.stateService.getChannel(channelId);

      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.justifyContent = 'space-between';

      const label = document.createElement('span');
      label.textContent = `Channel ${id}`;

      const toggle = document.createElement('button');
      toggle.textContent = channel?.active ? 'ON' : 'OFF';
      toggle.style.cssText = `
        padding: 8px 16px;
        background: ${channel?.active ? 'var(--vscode-button-background, #61afef)' : 'var(--vscode-button-secondaryBackground, #3a3f4b)'};
        color: ${channel?.active ? 'var(--vscode-button-foreground, #1f2329)' : 'var(--vscode-button-secondaryForeground, #abb2bf)'};
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
        min-width: 60px;
        min-height: 36px;
      `;

      toggle.addEventListener('click', () => {
        if (channel?.active) {
          this.stateService.deactivateChannel(channelId);
          toggle.textContent = 'OFF';
          toggle.style.background = 'var(--vscode-button-secondaryBackground, #3a3f4b)';
          toggle.style.color = 'var(--vscode-button-secondaryForeground, #abb2bf)';
        } else {
          this.stateService.activateChannel(channelId);
          toggle.textContent = 'ON';
          toggle.style.background = 'var(--vscode-button-background, #61afef)';
          toggle.style.color = 'var(--vscode-button-foreground, #1f2329)';
        }
        this.updateChannelDisplay();
      });

      row.appendChild(label);
      row.appendChild(toggle);
      content.appendChild(row);
    });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = `
      margin-top: 10px;
      padding: 10px 20px;
      background: var(--vscode-button-secondaryBackground, #3a3f4b);
      color: var(--vscode-button-secondaryForeground, #abb2bf);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      min-height: 40px;
      width: 100%;
    `;
    closeBtn.addEventListener('click', () => {
      document.body.removeChild(dialog);
    });
    content.appendChild(closeBtn);

    dialog.appendChild(content);
    document.body.appendChild(dialog);
  }

  private switchMobileView(view: string): void {
    this.activeMobileView = view;

    // Update nav items
    const navItems = this.querySelectorAll('.nav-item');
    navItems?.forEach((item) => {
      if ((item as HTMLElement).dataset.view === view) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    if (view === 'plot') {
      this.setPlotViewerVisible(true);
    } else if (view.startsWith('channel-')) {
      this.setPlotViewerVisible(false);

      // Ensure the channel is active in state service if needed
      // For now, we just assume we want to see it.
      // But we should probably activate it if it's not active?
      // Or just show it. Let's just show it.

      this.updateChannelDisplay();
    }
  }

  private setupResizeHandle(): void {
    const resizeHandle = this.querySelector('#plot-resize-handle');
    const plotContainer = this.querySelector('#plot-container') as HTMLElement | null;
    if (!resizeHandle || !plotContainer) return;

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const deltaX = startX - e.clientX;
      const newWidth = Math.max(
        PLOT_PANEL_MIN_WIDTH,
        Math.min(startWidth + deltaX, window.innerWidth * PLOT_PANEL_MAX_WIDTH_RATIO),
      );
      plotContainer.style.width = `${newWidth}px`;
    };

    const onMouseUp = () => {
      isResizing = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    resizeHandle.addEventListener('mousedown', (e: Event) => {
      const mouseEvent = e as MouseEvent;
      isResizing = true;
      startX = mouseEvent.clientX;
      startWidth = plotContainer.offsetWidth;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    });
  }

  private switchSidePanelView(view: string): void {
    const tabs = this.querySelectorAll('.side-tab');
    const plotView = this.querySelector('#side-view-plot') as HTMLElement;
    const drawView = this.querySelector('#side-view-draw') as HTMLElement;
    const focasView = this.querySelector('#side-view-focas') as HTMLElement;
    
    tabs.forEach(t => {
      const btn = t as HTMLButtonElement;
      if (btn.dataset.view === view) {
        btn.style.background = 'var(--vscode-tab-activeBackground, #1e1e1e)';
        btn.style.color = 'var(--vscode-tab-activeForeground, #ffffff)';
        btn.style.borderTop = '2px solid var(--vscode-tab-activeBorderTop, #007fd4)';
      } else {
        btn.style.background = 'var(--vscode-tab-inactiveBackground, #2d2d2d)';
        btn.style.color = 'var(--vscode-tab-inactiveForeground, #cccccc)';
        btn.style.borderTop = '2px solid transparent';
      }
    });

    if (view === 'plot') {
      if (plotView) plotView.style.display = 'block';
      if (drawView) drawView.style.display = 'none';
      if (focasView) focasView.style.display = 'none';
      const focasToggle = this.querySelector('#focas-toggle') as HTMLButtonElement;
      if (focasToggle) focasToggle.classList.remove('active');
    } else if (view === 'draw') {
      if (plotView) plotView.style.display = 'none';
      if (drawView) drawView.style.display = 'block';
      if (focasView) focasView.style.display = 'none';
      const focasToggle = this.querySelector('#focas-toggle') as HTMLButtonElement;
      if (focasToggle) focasToggle.classList.remove('active');
    } else if (view === 'focas') {
      if (plotView) plotView.style.display = 'none';
      if (drawView) drawView.style.display = 'none';
      if (focasView) focasView.style.display = 'block';
      const focasToggle = this.querySelector('#focas-toggle') as HTMLButtonElement;
      if (focasToggle) focasToggle.classList.add('active');
    }
  }

  private setPlotViewerVisible(visible: boolean): void {
    const plotContainer = this.querySelector('#plot-container');
    const plotToggle = this.querySelector('#plot-toggle') as HTMLElement | null;
    const plotOpenBar = this.querySelector('#plot-open-bar');
    if (!plotContainer) return;

    if (visible) {
      plotContainer.classList.add('visible');
      // hide the small open bar when the panel is visible
      plotOpenBar?.classList.add('hidden');
      plotToggle?.classList.add('active');
    } else {
      plotContainer.classList.remove('visible');
      // show the small open bar so user has a clickable open affordance
      plotOpenBar?.classList.remove('hidden');
      plotToggle?.classList.remove('active');
      
      const focasToggle = this.querySelector('#focas-toggle') as HTMLButtonElement | null;
      if(focasToggle) focasToggle.classList.remove('active');
    }

    this.stateService.updateUISettings({ plotViewerOpen: visible });
  }

  private updateChannelDisplay(): void {
    const channelsContainer = this.querySelector('#channels');
    if (!channelsContainer) return;

    const activeChannels = this.stateService.getActiveChannels();
    const isMobile = window.innerWidth <= 768;

    // Hide all channel panes first
    const panes = this.querySelectorAll('nc-channel-pane');
    panes?.forEach((pane) => {
      (pane as HTMLElement).style.display = 'none';
    });

    if (isMobile) {
      // Update nav items state based on active channels
      const navItems = this.querySelectorAll('.nav-item');
      navItems?.forEach((item) => {
        const view = (item as HTMLElement).dataset.view;
        if (view && view.startsWith('channel-')) {
          const channelId = view.split('-')[1] as ChannelId;
          const channel = this.stateService.getChannel(channelId);

          if (channel?.active) {
            item.classList.remove('disabled');
          } else {
            item.classList.add('disabled');
          }
        }
      });

      // Check if current view is valid (active)
      let currentViewValid = true;
      if (this.activeMobileView.startsWith('channel-')) {
        const channelId = this.activeMobileView.split('-')[1] as ChannelId;
        const channel = this.stateService.getChannel(channelId);
        if (!channel?.active) {
          currentViewValid = false;
        }
      }

      if (!currentViewValid) {
        // Switch to first active channel or plot
        if (activeChannels.length > 0) {
          this.activeMobileView = `channel-${activeChannels[0].id}`;
        } else {
          this.activeMobileView = 'plot';
        }

        // Update nav items active state
        navItems?.forEach((item) => {
          if ((item as HTMLElement).dataset.view === this.activeMobileView) {
            item.classList.add('active');
          } else {
            item.classList.remove('active');
          }
        });
      }

      // On mobile, only show the active mobile view channel
      if (this.activeMobileView.startsWith('channel-')) {
        const channelId = this.activeMobileView.split('-')[1];
        const pane = this.querySelector(`nc-channel-pane[data-channel="${channelId}"]`);
        if (pane) {
          (pane as HTMLElement).style.display = 'flex';
        }

        // Ensure plot is hidden
        const plotContainer = this.querySelector('#plot-container');
        if (plotContainer?.classList.contains('visible')) {
          this.setPlotViewerVisible(false);
        }
      } else if (this.activeMobileView === 'plot') {
        // Ensure plot is visible
        const plotContainer = this.querySelector('#plot-container');
        if (plotContainer && !plotContainer.classList.contains('visible')) {
          this.setPlotViewerVisible(true);
        }
      }
    } else {
      // Show active channels
      activeChannels.forEach((channel) => {
        const pane = this.querySelector(`nc-channel-pane[data-channel="${channel.id}"]`);
        if (pane) {
          (pane as HTMLElement).style.display = 'flex';
        }
      });
    }
  }

  private showError(message: string): void {
    const mainContent = this.querySelector('.app-main-content');
    if (!mainContent) return;

    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = message;
    mainContent.prepend(errorDiv);
  }
}

customElements.define('nc-editor-app', NCEditorApp);
