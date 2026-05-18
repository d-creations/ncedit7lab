import { ServiceRegistry } from '@core/ServiceRegistry';
import { EVENT_BUS_TOKEN } from '@core/ServiceTokens';
import { EventBus, EVENT_NAMES } from '@services/EventBus';
import type { ParseArtifacts, NcParseResult, KeywordEntry } from '@core/types';

export class NCKeywordPanel extends HTMLElement {
  private eventBus: EventBus;
  private keywords: KeywordEntry[] = [];
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
    this.eventBus.subscribe(
      EVENT_NAMES.PARSE_COMPLETED,
      (data: { channelId: string; result: NcParseResult; artifacts: ParseArtifacts }) => {
        if (data.channelId === this.channelId) {
          this.keywords = data.artifacts.keywords;
          this.updateList();
        }
      },
    );
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
          font-size: 11px;
        }
        .keyword-item {
          padding: 2px 6px;
          cursor: pointer;
          border-bottom: 1px solid var(--vscode-editorGroup-border, #181a1f);
          white-space: nowrap;
        }
        .keyword-item:hover {
          background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.05));
        }
        .line-number {
          color: var(--vscode-descriptionForeground, #7f848e);
          margin-right: 4px;
          font-size: 10px;
        }
        .keyword {
          color: var(--vscode-textLink-foreground, #61afef);
          font-weight: bold;
        }
      </style>
      <div id="list"></div>
    `;
  }

  private updateList() {
    const list = this.shadowRoot?.getElementById('list');
    if (!list) return;

    list.innerHTML = '';
    // Render all keywords that the parser produced (do not filter out G-codes here).
    this.keywords.forEach((k) => {
      const item = document.createElement('div');
      item.className = 'keyword-item';
      item.innerHTML = `
        <span class="line-number">${k.lineNumber}</span>
        <span class="keyword">${k.keyword}</span>
      `;
      item.addEventListener('click', () => {
        this.dispatchEvent(
          new CustomEvent('keyword-click', {
            detail: { lineNumber: k.lineNumber },
            bubbles: true,
            composed: true,
          }),
        );
      });
      list.appendChild(item);
    });
  }
}

customElements.define('nc-keyword-panel', NCKeywordPanel);
