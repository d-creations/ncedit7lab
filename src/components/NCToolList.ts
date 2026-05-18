import { ServiceRegistry } from '@core/ServiceRegistry';
import { EVENT_BUS_TOKEN } from '@core/ServiceTokens';
import { EventBus, EVENT_NAMES } from '@services/EventBus';
import type { ParseArtifacts, NcParseResult, ToolRegisterEntry, ToolValue } from '@core/types';

interface ToolWithValues extends ToolRegisterEntry {
  qValue?: number;
  rValue?: number;
}

export class NCToolList extends HTMLElement {
  private eventBus: EventBus;
  private tools: ToolWithValues[] = [];
  private channelId: string = '';

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
    // Listen for parse results
    this.eventBus.subscribe(
      EVENT_NAMES.PARSE_COMPLETED,
      (data: { channelId: string; result: NcParseResult; artifacts: ParseArtifacts }) => {
        if (data.channelId === this.channelId) {
          // Preserve existing Q and R values for tools that still exist
          const existingToolValues = new Map<number | string, { qValue?: number; rValue?: number }>();
          this.tools.forEach((tool) => {
            if (tool.qValue !== undefined || tool.rValue !== undefined) {
              existingToolValues.set(tool.toolNumber, {
                qValue: tool.qValue,
                rValue: tool.rValue,
              });
            }
          });

          // Update tools list with new data, preserving user-set values
          this.tools = data.artifacts.toolRegisters.map((tool) => {
            const existing = existingToolValues.get(tool.toolNumber);
            return {
              ...tool,
              qValue: existing?.qValue,
              rValue: existing?.rValue,
            };
          });
          this.updateList();
        }
      },
    );
  }

  /**
   * Get tool values for sending with plot requests
   */
  getToolValues(): ToolValue[] {
    return this.tools
      .filter((tool) => tool.qValue !== undefined || tool.rValue !== undefined)
      .map((tool) => ({
        toolNumber: tool.toolNumber,
        qValue: tool.qValue,
        rValue: tool.rValue,
      }));
  }

  private render() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          height: 100%;
          overflow-y: auto;
          background: var(--vscode-sideBar-background, #21252b);
          color: var(--vscode-editor-foreground, #abb2bf);
          font-family: monospace;
          font-size: 12px;
        }

        .tool-header {
          padding: 4px 8px;
          background: var(--vscode-editorGroupHeader-tabsBackground, #21252b);
          border-bottom: 1px solid var(--vscode-editorGroup-border, #181a1f);
          font-weight: bold;
          color: var(--vscode-textLink-foreground, #61afef);
        }

        .tool-list {
          padding: 4px;
        }

        .tool-item {
          padding: 4px 8px;
          border-bottom: 1px solid var(--vscode-editorGroup-border, #181a1f);
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .tool-item:hover {
          background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.05));
        }

        .tool-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .tool-number {
          color: var(--vscode-editor-foreground, #abb2bf);
          font-weight: bold;
        }

        .tool-params {
          display: flex;
          gap: 8px;
          font-size: 11px;
        }

        .tool-param {
          color: var(--vscode-descriptionForeground, #7f848e);
        }

        .tool-inputs {
          display: flex;
          gap: 8px;
          align-items: center;
        }

        .input-group {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .input-group label {
          color: var(--vscode-textLink-foreground, #61afef);
          font-size: 11px;
        }

        .input-group input {
          width: 50px;
          padding: 2px 4px;
          background: var(--vscode-input-background, #3c3f41);
          color: var(--vscode-input-foreground, #abb2bf);
          border: 1px solid var(--vscode-input-border, #181a1f);
          border-radius: 3px;
          font-size: 11px;
          font-family: monospace;
        }

        .input-group input:focus {
          outline: none;
          border-color: var(--vscode-focusBorder, #528bff);
        }

        .input-group input::placeholder {
          color: var(--vscode-descriptionForeground, #7f848e);
        }

        .empty-message {
          padding: 16px;
          text-align: center;
          color: var(--vscode-descriptionForeground, #7f848e);
          font-size: 11px;
        }
      </style>

      <div class="tool-header">Tools (Q/R Values)</div>
      <div class="tool-list" id="list"></div>
    `;
  }

  private updateList() {
    const list = this.shadowRoot?.getElementById('list');
    if (!list) return;

    list.innerHTML = '';

    if (this.tools.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'empty-message';
      emptyMsg.textContent = 'No tools detected';
      list.appendChild(emptyMsg);
      return;
    }

    this.tools.forEach((tool, index) => {
      const item = document.createElement('div');
      item.className = 'tool-item';

      // Create tool row
      const toolRow = document.createElement('div');
      toolRow.className = 'tool-row';

      const toolNumber = document.createElement('span');
      toolNumber.className = 'tool-number';
      toolNumber.textContent = `T${tool.toolNumber}`;

      const toolParams = document.createElement('div');
      toolParams.className = 'tool-params';

      if (tool.qParameter !== undefined) {
        const qParam = document.createElement('span');
        qParam.className = 'tool-param';
        qParam.textContent = `Q: ${tool.qParameter}`;
        toolParams.appendChild(qParam);
      }
      if (tool.rParameter !== undefined) {
        const rParam = document.createElement('span');
        rParam.className = 'tool-param';
        rParam.textContent = `R: ${tool.rParameter}`;
        toolParams.appendChild(rParam);
      }
      if (toolParams.children.length === 0) {
        const noParam = document.createElement('span');
        noParam.className = 'tool-param';
        noParam.textContent = '-';
        toolParams.appendChild(noParam);
      }

      toolRow.appendChild(toolNumber);
      toolRow.appendChild(toolParams);

      // Create tool inputs
      const toolInputs = document.createElement('div');
      toolInputs.className = 'tool-inputs';

      // Q input group
      const qGroup = document.createElement('div');
      qGroup.className = 'input-group';
      const qLabel = document.createElement('label');
      qLabel.textContent = 'Q:';
      const qInput = document.createElement('input');
      qInput.type = 'number';
      qInput.dataset.tool = String(index);
      qInput.dataset.type = 'q';
      qInput.value = tool.qValue !== undefined ? String(tool.qValue) : '';
      qInput.placeholder = 'Q value';
      qInput.step = 'any';
      qInput.addEventListener('change', (e) => this.handleInputChange(e));
      qGroup.appendChild(qLabel);
      qGroup.appendChild(qInput);

      // R input group
      const rGroup = document.createElement('div');
      rGroup.className = 'input-group';
      const rLabel = document.createElement('label');
      rLabel.textContent = 'R:';
      const rInput = document.createElement('input');
      rInput.type = 'number';
      rInput.dataset.tool = String(index);
      rInput.dataset.type = 'r';
      rInput.value = tool.rValue !== undefined ? String(tool.rValue) : '';
      rInput.placeholder = 'R value';
      rInput.step = 'any';
      rInput.addEventListener('change', (e) => this.handleInputChange(e));
      rGroup.appendChild(rLabel);
      rGroup.appendChild(rInput);

      toolInputs.appendChild(qGroup);
      toolInputs.appendChild(rGroup);

      item.appendChild(toolRow);
      item.appendChild(toolInputs);
      list.appendChild(item);
    });
  }

  private handleInputChange(e: Event) {
    const target = e.target as HTMLInputElement;
    const toolIndex = parseInt(target.dataset.tool || '0', 10);
    const type = target.dataset.type;
    const value = target.value ? parseFloat(target.value) : undefined;

    if (toolIndex >= 0 && toolIndex < this.tools.length) {
      if (type === 'q') {
        this.tools[toolIndex].qValue = value;
      } else if (type === 'r') {
        this.tools[toolIndex].rValue = value;
      }
    }
  }
}

customElements.define('nc-tool-list', NCToolList);
