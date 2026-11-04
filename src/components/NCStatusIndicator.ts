import { ServiceRegistry } from '@core/ServiceRegistry';
import { DIAGNOSTICS_SERVICE_TOKEN, EVENT_BUS_TOKEN, HOST_BRIDGE_SERVICE_TOKEN } from '@core/ServiceTokens';
import { DiagnosticsService } from '@services/DiagnosticsService';
import { EventBus, EVENT_NAMES, type EventSubscription } from '@services/EventBus';
import type { IHostBridgeService } from '@services/HostBridgeService';

export class NCStatusIndicator extends HTMLElement {
  private diagnosticsService: DiagnosticsService;
  private eventBus: EventBus;
  private hostBridge?: IHostBridgeService;
  private subscriptions: EventSubscription[] = [];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    const registry = ServiceRegistry.getInstance();
    this.diagnosticsService = registry.get(DIAGNOSTICS_SERVICE_TOKEN);
    this.eventBus = registry.get(EVENT_BUS_TOKEN);
    if (registry.has(HOST_BRIDGE_SERVICE_TOKEN)) {
      this.hostBridge = registry.get(HOST_BRIDGE_SERVICE_TOKEN);
    }
  }

  connectedCallback() {
    this.render();
    this.setupEventListeners();
  }

  disconnectedCallback() {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
    this.subscriptions = [];
  }

  private setupEventListeners() {
    this.subscriptions.push(
      this.eventBus.subscribe(EVENT_NAMES.STATE_CHANGED, () => {
        this.updateStatus();
      }),
    );

    this.subscriptions.push(
      this.eventBus.subscribe(EVENT_NAMES.ERROR_OCCURRED, () => {
        this.updateStatus();
      }),
    );
  }

  private openErrorsView() {
    const diagnostics = this.diagnosticsService.getDiagnostics();
    const targetChannelId = diagnostics.find((d) => d.channelId)?.channelId;

    this.hostBridge?.openWorkbenchPanel('errors');

    const selector = targetChannelId
      ? `nc-channel-pane[data-channel="${targetChannelId}"] #bottom-panel`
      : 'nc-channel-pane #bottom-panel';
    const bottomPanel = document.querySelector(selector) as
      | (HTMLElement & { open?: (tabName?: 'variables' | 'errors') => void })
      | null;
    bottomPanel?.open?.('errors');
  }

  private updateStatus() {
    const errorCount = this.diagnosticsService.getErrorCount();
    const warningCount = this.diagnosticsService.getWarningCount();
    const diagnostics = this.diagnosticsService.getDiagnostics();

    const statusSpan = this.shadowRoot?.querySelector<HTMLElement>('.status');
    const messageSpan = this.shadowRoot?.querySelector<HTMLElement>('.status-message');
    if (!statusSpan) return;

    const latestIssue =
      diagnostics.find((d) => d.severity === 'error') ??
      diagnostics.find((d) => d.severity === 'warning');
    const tooltip = diagnostics
      .slice(0, 5)
      .map((d) => (d.channelId ? `[Ch ${d.channelId}] ${d.message}` : d.message))
      .join('\n');

    if (errorCount > 0) {
      statusSpan.textContent = `${errorCount} Error${errorCount !== 1 ? 's' : ''}`;
      statusSpan.className = 'status error clickable';
      statusSpan.title = tooltip;
    } else if (warningCount > 0) {
      statusSpan.textContent = `${warningCount} Warning${warningCount !== 1 ? 's' : ''}`;
      statusSpan.className = 'status warning clickable';
      statusSpan.title = tooltip;
    } else {
      statusSpan.textContent = 'Ready';
      statusSpan.className = 'status ready';
      statusSpan.title = 'Ready';
    }

    if (messageSpan) {
      if (latestIssue) {
        const prefix = latestIssue.channelId ? `Ch ${latestIssue.channelId}: ` : '';
        messageSpan.textContent = `${prefix}${latestIssue.message}`;
        messageSpan.title = tooltip;
        messageSpan.hidden = false;
      } else {
        messageSpan.textContent = '';
        messageSpan.title = '';
        messageSpan.hidden = true;
      }
    }
  }

  private render() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          max-width: 100%;
          overflow: hidden;
        }
        .status {
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
          flex-shrink: 0;
        }
        .status.clickable {
          cursor: pointer;
        }
        .status.ready {
          background: #007acc;
          color: white;
        }
        .status.warning {
          background: #ffcc00;
          color: #1e1e1e;
        }
        .status.error {
          background: #f48771;
          color: white;
        }
        .status-message {
          font-size: 12px;
          color: var(--vscode-statusBar-foreground, #abb2bf);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          cursor: pointer;
        }
      </style>
      <span class="status ready">Ready</span>
      <span class="status-message" hidden></span>
    `;
    this.shadowRoot.querySelector('.status')?.addEventListener('click', () => {
      if (this.diagnosticsService.getErrorCount() > 0 || this.diagnosticsService.getWarningCount() > 0) {
        this.openErrorsView();
      }
    });
    this.shadowRoot.querySelector('.status-message')?.addEventListener('click', () => {
      this.openErrorsView();
    });
    this.updateStatus();
  }
}

customElements.define('nc-status-indicator', NCStatusIndicator);
