import { ServiceRegistry } from '@core/ServiceRegistry';
import { EVENT_BUS_TOKEN } from '@core/ServiceTokens';
import { EventBus, EVENT_NAMES } from '@services/EventBus';
import type { ExecutedProgramResult } from '@core/types';

export class NCErrorList extends HTMLElement {
  private eventBus: EventBus;
  private channelId: string = '';
  private errors: Array<{ lineNumber: number; message: string; severity: string }> = [];

  static get observedAttributes() {
    return ['channel-id'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.eventBus = ServiceRegistry.getInstance().get(EVENT_BUS_TOKEN);
  }

  attributeChangedCallback(name: string, _oldValue: string, newValue: string) {
    if (name === 'channel-id') {
      this.channelId = newValue;
    }
  }

  connectedCallback() {
    this.render();
    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.eventBus.subscribe(EVENT_NAMES.EXECUTION_COMPLETED, (data: unknown) => {
      const execData = data as { channelId: string; result: ExecutedProgramResult };
      if (execData.channelId === this.channelId) {
        this.errors = execData.result.errors || [];
        this.render();

        // Always dispatch errors-updated event (including when count is 0 to reset the badge)
        this.dispatchEvent(
          new CustomEvent('errors-updated', {
            detail: { count: this.errors.length },
            bubbles: true,
            composed: true,
          }),
        );
      }
    });

    this.eventBus.subscribe(EVENT_NAMES.EXECUTION_ERROR, (data: unknown) => {
      const errorData = data as { channelId: string; error: unknown };
      if (errorData.channelId === this.channelId) {
        const error = errorData.error as { message?: string };
        this.errors = [
          {
            lineNumber: 0,
            message: error.message || 'Unknown execution error',
            severity: 'error',
          },
        ];
        this.render();

        this.dispatchEvent(
          new CustomEvent('errors-updated', {
            detail: { count: this.errors.length },
            bubbles: true,
            composed: true,
          }),
        );
      }
    });

    this.eventBus.subscribe(EVENT_NAMES.PLOT_CLEARED, () => {
      this.errors = [];
      this.render();

      // Dispatch errors-updated with count 0 to reset the error tab badge
      this.dispatchEvent(
        new CustomEvent('errors-updated', {
          detail: { count: 0 },
          bubbles: true,
          composed: true,
        }),
      );
    });
  }

  private render() {
    if (!this.shadowRoot) return;

    const errorItems = this.errors
      .map(
        (error) => `
      <div class="error-item ${error.severity}">
        <span class="line-number">Line ${error.lineNumber}</span>
        <span class="message">${error.message}</span>
      </div>
    `,
      )
      .join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
          overflow-y: auto;
          box-sizing: border-box;
          background: var(--vscode-editorWidget-background, #21252b);
          color: var(--vscode-editor-foreground, #abb2bf);
          font-family: monospace;
          font-size: 12px;
          padding: 4px;
        }

        .error-item {
          display: flex;
          gap: 8px;
          padding: 4px 8px;
          border-bottom: 1px solid var(--vscode-editorGroup-border, #181a1f);
          cursor: pointer;
        }

        .error-item:hover {
          background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.05));
        }

        .error-item.error {
          color: #f48771;
        }

        .error-item.warning {
          color: #cca700;
        }

        .line-number {
          color: var(--vscode-descriptionForeground, #7f848e);
          min-width: 60px;
        }

        .message {
          flex: 1;
        }

        .empty-message {
          padding: 16px;
          text-align: center;
          color: var(--vscode-descriptionForeground, #7f848e);
        }
      </style>

      ${this.errors.length > 0 ? errorItems : '<div class="empty-message">No errors</div>'}
    `;

    // Add click listeners to jump to line
    const items = this.shadowRoot.querySelectorAll('.error-item');
    items.forEach((item, index) => {
      item.addEventListener('click', () => {
        const error = this.errors[index];
        if (error.lineNumber > 0) {
          this.eventBus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, {
            channelId: this.channelId,
            lineNumber: error.lineNumber,
          });
        }
      });
    });
  }
}

customElements.define('nc-error-list', NCErrorList);
