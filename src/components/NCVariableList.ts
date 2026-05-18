import { ServiceRegistry } from '@core/ServiceRegistry';
import { EVENT_BUS_TOKEN, STATE_SERVICE_TOKEN } from '@core/ServiceTokens';
import { EventBus, EVENT_NAMES } from '@services/EventBus';
import type { ParseArtifacts, NcParseResult, CustomVariable } from '@core/types';
import type { StateService } from '@services/StateService';

interface VariableEntry {
  register: number;
  value: number;
  modified?: boolean;
  isCustom?: boolean;
}

export class NCVariableList extends HTMLElement {
  private eventBus: EventBus;
  private variables = new Map<number, number>();
  private customVariables = new Map<string, number>();
  private channelId: string = '';
  private filterText = '';
  private variablePrefix = '#';
  private stateService?: StateService;

  static get observedAttributes() {
    return ['channel-id'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.eventBus = ServiceRegistry.getInstance().get(EVENT_BUS_TOKEN);
    try {
      this.stateService = ServiceRegistry.getInstance().get(STATE_SERVICE_TOKEN) as StateService;
    } catch (err) {
      // StateService may not be registered yet; ignore
    }
  }

  attributeChangedCallback(name: string, _oldValue: string, newValue: string) {
    if (name === 'channel-id') {
      this.channelId = newValue;
    }
  }

  connectedCallback() {
    this.render();
    this.setupEventListeners();
    this.syncVariablePrefix();
  }

  private setupEventListeners() {
    // Listen for parse results
    this.eventBus.subscribe(
      EVENT_NAMES.PARSE_COMPLETED,
      (data: { channelId: string; result: NcParseResult; artifacts: ParseArtifacts }) => {
        if (data.channelId === this.channelId) {
          this.variables = data.artifacts.variableSnapshot;
          this.updateList();
        }
      },
    );
    this.eventBus.subscribe(EVENT_NAMES.MACHINE_CHANGED, () => {
      this.syncVariablePrefix();
    });
    this.eventBus.subscribe(EVENT_NAMES.STATE_CHANGED, () => {
      this.syncVariablePrefix();
    });

    // Listen for execution results
    this.eventBus.subscribe(EVENT_NAMES.EXECUTION_COMPLETED, (data: unknown) => {
      const execData = data as {
        channelId: string;
        result: { variableSnapshot: Map<number, number> };
      };
      if (execData.channelId === this.channelId && execData.result?.variableSnapshot) {
        if (execData.result.variableSnapshot.size === 0 && this.variables.size > 0) {
          return;
        }

        // Mark modified variables
        const oldVariables = new Map(this.variables);
        this.variables = execData.result.variableSnapshot;

        // Update with modification flags
        this.updateList(oldVariables);
      }
    });
  }

  /**
   * Get custom variables for sending with plot requests
   */
  getCustomVariables(): CustomVariable[] {
    return Array.from(this.customVariables.entries()).map(([name, value]) => ({
      name,
      value,
    }));
  }

  private render() {
    if (!this.shadowRoot) return;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
          overflow: hidden;
          background: var(--vscode-editorWidget-background, #21252b);
          color: var(--vscode-editor-foreground, #abb2bf);
          font-family: monospace;
          font-size: 12px;
        }

        .toolbar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 8px;
          background: var(--vscode-editorGroupHeader-tabsBackground, #21252b);
          border-bottom: 1px solid var(--vscode-editorGroup-border, #181a1f);
        }

        .filter-input {
          flex: 1;
          padding: 2px 8px;
          background: var(--vscode-input-background, #3c3f41);
          color: var(--vscode-input-foreground, #abb2bf);
          border: 1px solid var(--vscode-input-border, #181a1f);
          border-radius: 3px;
          font-size: 11px;
        }

        .add-button {
          padding: 2px 8px;
          background: var(--vscode-button-background, #61afef);
          color: var(--vscode-button-foreground, #1f2329);
          border: 1px solid var(--vscode-button-background, #61afef);
          border-radius: 3px;
          cursor: pointer;
          font-size: 11px;
        }

        .add-button:hover {
          background: var(--vscode-button-hoverBackground, #70b7ff);
        }

        .custom-section {
          padding: 8px;
          background: var(--vscode-editorGroupHeader-tabsBackground, #21252b);
          border-bottom: 1px solid var(--vscode-editorGroup-border, #181a1f);
        }

        .custom-section-title {
          font-weight: bold;
          color: var(--vscode-textLink-foreground, #61afef);
          margin-bottom: 8px;
          font-size: 11px;
        }

        .custom-input-row {
          display: flex;
          gap: 4px;
          align-items: center;
          flex-wrap: wrap;
        }

        .prefix-display {
          padding: 4px 6px;
          background: var(--vscode-button-secondaryBackground, #3a3f4b);
          color: var(--vscode-editor-foreground, #abb2bf);
          border: 1px solid var(--vscode-widget-border, #181a1f);
          border-radius: 3px 0 0 3px;
          font-size: 11px;
          font-family: monospace;
          min-width: 20px;
          text-align: center;
        }

        .custom-input {
          padding: 4px 8px;
          background: var(--vscode-input-background, #3c3f41);
          color: var(--vscode-input-foreground, #abb2bf);
          border: 1px solid var(--vscode-input-border, #181a1f);
          border-radius: 3px;
          font-size: 11px;
          font-family: monospace;
        }

        .custom-input:focus {
          outline: none;
          border-color: var(--vscode-focusBorder, #528bff);
        }

        .custom-input.name {
          width: 60px;
          border-radius: 0 3px 3px 0;
          border-left: none;
        }

        .name-group {
          display: flex;
          align-items: stretch;
        }

        .equals-sign {
          color: var(--vscode-descriptionForeground, #7f848e);
          padding: 0 4px;
        }

        .custom-input.value {
          width: 70px;
        }

        .custom-list {
          margin-top: 8px;
          max-height: 60px;
          overflow-y: auto;
        }

        .custom-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 2px 8px;
          background: var(--vscode-button-secondaryBackground, #3a3f4b);
          border-radius: 3px;
          margin-bottom: 2px;
        }

        .custom-item-info {
          color: var(--vscode-textLink-foreground, #61afef);
        }

        .remove-button {
          background: transparent;
          border: none;
          color: var(--vscode-inputValidation-errorBackground, #e06c75);
          cursor: pointer;
          font-size: 14px;
          padding: 0 4px;
        }

        .remove-button:hover {
          color: var(--vscode-inputValidation-errorBackground, #e06c75);
        }

        .variable-list {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: 4px;
        }

        .variable-item {
          display: flex;
          justify-content: space-between;
          padding: 2px 8px;
          border-bottom: 1px solid var(--vscode-editorGroup-border, #181a1f);
        }

        .variable-item:hover {
          background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.05));
        }

        .variable-item.modified {
          background: color-mix(in srgb, var(--vscode-button-background, #61afef) 14%, var(--vscode-editorWidget-background, #21252b));
        }

        .variable-register {
          color: var(--vscode-editor-foreground, #abb2bf);
          min-width: 60px;
        }

        .variable-value {
          color: var(--vscode-descriptionForeground, #7f848e);
        }

        .empty-message {
          padding: 16px;
          text-align: center;
          color: var(--vscode-descriptionForeground, #7f848e);
        }
        
        .input-hint {
          font-size: 10px;
          color: var(--vscode-descriptionForeground, #7f848e);
          margin-top: 4px;
          width: 100%;
        }
      </style>

      <div class="toolbar">
        <input type="text" class="filter-input" id="filter" placeholder="Filter (e.g., 100-200)">
      </div>
      <div class="custom-section">
        <div class="custom-section-title">Custom Variables</div>
        <div class="custom-input-row">
          <div class="name-group">
            <span class="prefix-display" id="var-prefix">${this.variablePrefix}</span>
            <input type="text" class="custom-input name" id="custom-name" placeholder="100">
          </div>
          <span class="equals-sign">=</span>
          <input type="number" class="custom-input value" id="custom-value" placeholder="Value" step="any">
          <button class="add-button" id="add-custom">+ Add</button>
        </div>
        <div class="input-hint">Enter register number (e.g., 5, 100) or full name (e.g., R5, #100)</div>
        <div class="custom-list" id="custom-list"></div>
      </div>
      <div class="variable-list" id="list"></div>
    `;

    this.attachControlListeners();
    this.updateCustomList();
  }

  private attachControlListeners() {
    const filterInput = this.shadowRoot?.getElementById('filter') as HTMLInputElement;
    filterInput?.addEventListener('input', (e) => {
      this.filterText = (e.target as HTMLInputElement).value;
      this.updateList();
    });

    const addButton = this.shadowRoot?.getElementById('add-custom');
    addButton?.addEventListener('click', () => this.addCustomVariable());

    // Allow adding with Enter key
    const customName = this.shadowRoot?.getElementById('custom-name') as HTMLInputElement;
    const customValue = this.shadowRoot?.getElementById('custom-value') as HTMLInputElement;

    customName?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.addCustomVariable();
    });
    customValue?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.addCustomVariable();
    });
  }

  private addCustomVariable() {
    const nameInput = this.shadowRoot?.getElementById('custom-name') as HTMLInputElement;
    const valueInput = this.shadowRoot?.getElementById('custom-value') as HTMLInputElement;

    if (!nameInput || !valueInput) return;

    let name = nameInput.value.trim();
    const value = parseFloat(valueInput.value);

    if (!name || isNaN(value)) {
      // Show visual feedback for invalid input
      if (!name) {
        nameInput.style.borderColor = '#f14c4c';
        setTimeout(() => {
          nameInput.style.borderColor = '';
        }, 1500);
      }
      if (isNaN(value)) {
        valueInput.style.borderColor = '#f14c4c';
        setTimeout(() => {
          valueInput.style.borderColor = '';
        }, 1500);
      }
      return;
    }

    // If the name is just a number, prepend the current variable prefix
    if (/^\d+$/.test(name)) {
      name = `${this.variablePrefix}${name}`;
    }

    this.customVariables.set(name, value);
    this.updateCustomList();

    // Clear inputs
    nameInput.value = '';
    valueInput.value = '';
    nameInput.focus();
  }

  private removeCustomVariable(name: string) {
    this.customVariables.delete(name);
    this.updateCustomList();
  }

  private updateCustomList() {
    const customList = this.shadowRoot?.getElementById('custom-list');
    if (!customList) return;

    customList.innerHTML = '';

    if (this.customVariables.size === 0) {
      const noVarsDiv = document.createElement('div');
      noVarsDiv.style.color = '#666';
      noVarsDiv.style.fontSize = '10px';
      noVarsDiv.textContent = 'No custom variables';
      customList.appendChild(noVarsDiv);
      return;
    }

    this.customVariables.forEach((value, name) => {
      const item = document.createElement('div');
      item.className = 'custom-item';

      const infoSpan = document.createElement('span');
      infoSpan.className = 'custom-item-info';
      infoSpan.textContent = `${name} = ${value}`;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-button';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => this.removeCustomVariable(name));

      item.appendChild(infoSpan);
      item.appendChild(removeBtn);
      customList.appendChild(item);
    });
  }

  private updateList(oldVariables?: Map<number, number>) {
    const list = this.shadowRoot?.getElementById('list');
    if (!list) return;

    list.innerHTML = '';

    if (this.variables.size === 0) {
      list.innerHTML = '<div class="empty-message">No variables detected</div>';
      return;
    }

    // Convert to sorted array
    const entries: VariableEntry[] = Array.from(this.variables.entries())
      .map(([register, value]) => ({
        register,
        value,
        modified: oldVariables ? oldVariables.get(register) !== value : false,
      }))
      .sort((a, b) => a.register - b.register);

    // Apply filter
    let filtered = entries;
    if (this.filterText) {
      filtered = this.applyFilter(entries, this.filterText);
    }

    // Render items (lazy rendering for large lists)
    const maxVisible = 100;
    const toRender = filtered.slice(0, maxVisible);

    const prefix = this.variablePrefix || '#';

    toRender.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'variable-item';
      if (entry.modified) {
        item.classList.add('modified');
      }

      item.innerHTML = `
        <span class="variable-register">${prefix}${entry.register}</span>
        <span class="variable-value">${entry.value.toFixed(4)}</span>
      `;

      list.appendChild(item);
    });

    if (filtered.length > maxVisible) {
      const moreMessage = document.createElement('div');
      moreMessage.className = 'empty-message';
      moreMessage.textContent = `... and ${filtered.length - maxVisible} more`;
      list.appendChild(moreMessage);
    }
  }

  private syncVariablePrefix() {
    const activeMachine = this.stateService?.getState().activeMachine;
    const derivedPrefix =
      activeMachine?.variablePrefix ??
      this.inferPrefixFromPattern(activeMachine?.regexPatterns?.variables?.pattern);
    if (derivedPrefix && derivedPrefix !== this.variablePrefix) {
      this.variablePrefix = derivedPrefix;
      this.updateList();
      // Update the prefix display in the custom variable input
      const prefixDisplay = this.shadowRoot?.getElementById('var-prefix');
      if (prefixDisplay) {
        prefixDisplay.textContent = this.variablePrefix;
      }
    }
  }

  private inferPrefixFromPattern(pattern?: string): string | undefined {
    if (!pattern) return undefined;

    for (let i = 0; i < pattern.length; i += 1) {
      const char = pattern[i];
      if (char === '\\') {
        i += 1; // skip escaped character
        continue;
      }
      if (/^[A-Za-z#]$/.test(char)) {
        return char;
      }
    }

    return undefined;
  }

  private applyFilter(entries: VariableEntry[], filter: string): VariableEntry[] {
    // Support range filters like "100-200" or exact matches like "100"
    const rangeMatch = filter.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]);
      const end = parseInt(rangeMatch[2]);
      return entries.filter((e) => e.register >= start && e.register <= end);
    }

    const exactMatch = filter.match(/^\d+$/);
    if (exactMatch) {
      const num = parseInt(filter);
      return entries.filter((e) => e.register === num);
    }

    // Text search
    return entries.filter((e) => e.register.toString().includes(filter));
  }
}

customElements.define('nc-variable-list', NCVariableList);
