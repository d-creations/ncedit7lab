import { ServiceRegistry } from '@core/ServiceRegistry';
import { FILE_MANAGER_SERVICE_TOKEN, EVENT_BUS_TOKEN } from '@core/ServiceTokens';
import { IFileManagerService } from '@services/IFileManagerService';
import { EventBus } from '@services/EventBus';
import { NCProgram } from '@core/types';

export class NCProgramManager extends HTMLElement {
  private fileManager: IFileManagerService;
  private eventBus: EventBus;
  private channelId: string = '';
  private programs: NCProgram[] = [];
  private activeProgramId: string | null = null;

  static get observedAttributes() {
    return ['channel-id'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    const registry = ServiceRegistry.getInstance();
    this.fileManager = registry.get(FILE_MANAGER_SERVICE_TOKEN);
    this.eventBus = registry.get(EVENT_BUS_TOKEN);
  }

  attributeChangedCallback(name: string, _oldValue: string, newValue: string) {
    if (name === 'channel-id') {
      this.channelId = newValue;
      this.refreshPrograms();
    }
  }

  connectedCallback() {
    // 2. Hide when running in VS Code / Theia Desktop Mode
    // @ts-ignore
    if (typeof acquireVsCodeApi !== 'undefined' || window.acquireVsCodeApi !== undefined) {
        this.style.display = 'none';
        return;
    }

    this.render();
    this.setupEventListeners();
    this.refreshPrograms();
    
    this.eventBus.subscribe('program:active_changed', (data: { channelId: string, program: NCProgram | null }) => {
        if (data.channelId === this.channelId) {
            this.activeProgramId = data.program ? data.program.id : null;
            this.updateProgramList();
        }
    });
    
    this.eventBus.subscribe('file:opened', () => this.refreshPrograms());
    this.eventBus.subscribe('program:closed', (data: { channelId: string, programId: string }) => {
        if (data.channelId === this.channelId) {
            this.refreshPrograms();
        }
    });
  }

  private refreshPrograms() {
    if (!this.channelId) return;
    this.programs = this.fileManager.getPrograms(this.channelId);
    const active = this.fileManager.getActiveProgram(this.channelId);
    this.activeProgramId = active ? active.id : null;
    this.updateProgramList();
  }

  private updateProgramList() {
    const list = this.shadowRoot?.getElementById('program-list');
    if (!list) return;

    list.innerHTML = '';
    
    if (this.programs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-message';
        empty.textContent = 'No programs loaded';
        list.appendChild(empty);
        return;
    }

    this.programs.forEach(prog => {
        const item = document.createElement('div');
        item.className = `program-item ${prog.id === this.activeProgramId ? 'active' : ''}`;
        
        const nameSpan = document.createElement('span');
        nameSpan.className = 'program-name';
        nameSpan.textContent = prog.name;
        nameSpan.onclick = () => this.fileManager.setActiveProgram(this.channelId, prog.id);
        
        const actionsPane = document.createElement('div');
        actionsPane.style.display = 'flex';
        actionsPane.style.gap = '4px';

        const renameBtn = document.createElement('span');
        renameBtn.className = 'close-btn'; // Reusing close-btn styles for simple icon button
        renameBtn.textContent = '✎';
        renameBtn.title = 'Rename Program';
        renameBtn.onclick = (e) => {
            e.stopPropagation();
            const newName = prompt('Enter new program name:', prog.name);
            if (newName && newName !== prog.name) {
                this.fileManager.renameProgram(prog.id, newName);
                this.refreshPrograms();
            }
        };
        
        const closeBtn = document.createElement('span');
        closeBtn.className = 'close-btn';
        closeBtn.textContent = '×';
        closeBtn.title = 'Close Program';
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            this.fileManager.closeProgram(prog.id);
        };
        
        actionsPane.appendChild(renameBtn);
        actionsPane.appendChild(closeBtn);
        
        item.appendChild(nameSpan);
        item.appendChild(actionsPane);
        list.appendChild(item);
    });
  }

  private setupEventListeners() {
    const addBtn = this.shadowRoot?.getElementById('add-program-btn');
    addBtn?.addEventListener('click', () => {
        this.fileManager.newProgram(this.channelId, `New Program CH${this.channelId}`);
    });
  }

  private render() {
    if (!this.shadowRoot) return;
    
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: flex;
          flex-direction: column;
          height: 100%;
          background: var(--vscode-sideBar-background, #21252b);
          color: var(--vscode-editor-foreground, #abb2bf);
          overflow: hidden;
        }
        .header {
            padding: 8px;
            background: var(--vscode-editorGroupHeader-tabsBackground, #21252b);
            font-weight: bold;
            font-size: 12px;
            border-bottom: 1px solid var(--vscode-editorGroup-border, #181a1f);
        }
        .program-list {
            flex: 1;
            overflow-y: auto;
            padding: 4px;
        }
        .program-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 8px;
            margin-bottom: 2px;
            cursor: pointer;
            border-radius: 3px;
            font-size: 13px;
            color: var(--vscode-editor-foreground, #abb2bf);
        }
        .program-item:hover {
            background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.05));
        }
        .program-item.active {
            background: var(--vscode-button-background, #61afef);
            color: var(--vscode-button-foreground, #1f2329);
        }
        .program-item.active:hover {
            background: var(--vscode-button-hoverBackground, #70b7ff);
        }
        .program-name {
            flex: 1;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .close-btn {
            padding: 2px 6px;
            margin-left: 8px;
            opacity: 0.6;
            font-weight: bold;
        }
        .close-btn:hover {
            opacity: 1;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 3px;
        }
        .empty-message {
            padding: 10px;
            text-align: center;
          color: var(--vscode-descriptionForeground, #7f848e);
            font-style: italic;
            font-size: 12px;
        }
        .header-actions {
            display: flex;
            align-items: center;
        }
        .add-btn {
            background: none;
            border: none;
          color: var(--vscode-button-secondaryForeground, #abb2bf);
            cursor: pointer;
            font-size: 14px;
            font-weight: bold;
            padding: 0 4px;
            border-radius: 3px;
        }
        .add-btn:hover {
          background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.05));
          color: var(--vscode-editor-foreground, #abb2bf);
        }
      </style>
      <div class="header" style="display: flex; justify-content: space-between;">
        <span>Loaded Programs</span>
        <div class="header-actions">
          <button class="add-btn" id="add-program-btn" title="New Program">+</button>
        </div>
      </div>
      <div class="program-list" id="program-list"></div>
    `;
  }
}

customElements.define('nc-program-manager', NCProgramManager);
