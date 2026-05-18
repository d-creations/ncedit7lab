import { ServiceRegistry } from '@core/ServiceRegistry';
import { DIAGNOSTICS_SERVICE_TOKEN, EVENT_BUS_TOKEN } from '@core/ServiceTokens';
import { DiagnosticsService } from '@services/DiagnosticsService';
import { EventBus, EVENT_NAMES } from '@services/EventBus';

export class NCStatusIndicator extends HTMLElement {
  private diagnosticsService: DiagnosticsService;
  private eventBus: EventBus;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    const registry = ServiceRegistry.getInstance();
    this.diagnosticsService = registry.get(DIAGNOSTICS_SERVICE_TOKEN);
    this.eventBus = registry.get(EVENT_BUS_TOKEN);
  }

  connectedCallback() {
    this.render();
    this.setupEventListeners();
  }

  private setupEventListeners() {
    // Update on state changes
    this.eventBus.subscribe(EVENT_NAMES.STATE_CHANGED, () => {
      this.updateStatus();
    });

    // Update on errors
    this.eventBus.subscribe(EVENT_NAMES.ERROR_OCCURRED, () => {
      this.updateStatus();
    });
  }

  private updateStatus() {
    const errorCount = this.diagnosticsService.getErrorCount();
    const warningCount = this.diagnosticsService.getWarningCount();

    const statusSpan = this.shadowRoot?.querySelector('.status');
    if (!statusSpan) return;

    if (errorCount > 0) {
      statusSpan.textContent = `${errorCount} Error${errorCount !== 1 ? 's' : ''}`;
      statusSpan.className = 'status error';
    } else if (warningCount > 0) {
      statusSpan.textContent = `${warningCount} Warning${warningCount !== 1 ? 's' : ''}`;
      statusSpan.className = 'status warning';
    } else {
      statusSpan.textContent = 'Ready';
      statusSpan.className = 'status ready';
    }
  }

  private render() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-block;
        }
        .status {
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
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
      </style>
      <span class="status ready">Ready</span>
    `;
    this.updateStatus();
  }
}

customElements.define('nc-status-indicator', NCStatusIndicator);
