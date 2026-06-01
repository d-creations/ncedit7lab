import { ServiceRegistry } from '@core/ServiceRegistry';
import { FILE_MANAGER_SERVICE_TOKEN, EVENT_BUS_TOKEN } from '@core/ServiceTokens';
import { IFileManagerService } from '@services/IFileManagerService';
import { EventBus } from '@services/EventBus';
import { NCFile } from '@core/types';

export class NCFileManager extends HTMLElement {
  private fileManager: IFileManagerService;
  private eventBus: EventBus;
  private files: NCFile[] = [];
  private activeFileId: string | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    const registry = ServiceRegistry.getInstance();
    this.fileManager = registry.get(FILE_MANAGER_SERVICE_TOKEN);
    this.eventBus = registry.get(EVENT_BUS_TOKEN);
  }

  connectedCallback() {
    // 2. Hide when running in VS Code
    // @ts-ignore
    if (typeof acquireVsCodeApi !== 'undefined' || window.acquireVsCodeApi !== undefined) {
        this.style.display = 'none';
        return;
    }

    this.render();
    this.setupEventListeners();
    this.refreshFiles();
    
    this.eventBus.subscribe('file:opened', () => this.refreshFiles());
    this.eventBus.subscribe('file:closed', () => this.refreshFiles());
    this.eventBus.subscribe('file:active_changed', () => this.refreshFiles());
  }

  private refreshFiles() {
    this.files = this.fileManager.getFiles();
    const active = this.fileManager.getActiveFile();
    this.activeFileId = active ? active.id : null;
    this.updateFileList();
  }

  private updateFileList() {
    const list = this.shadowRoot?.getElementById('file-list');
    if (!list) return;

    list.innerHTML = '';
    this.files.forEach(file => {
        const item = document.createElement('div');
        item.className = `file-item ${file.id === this.activeFileId ? 'active' : ''}`;
        
        const labelText = document.createElement('span');
        labelText.textContent = file.name;
        item.appendChild(labelText);
        
        item.onclick = () => this.fileManager.selectFile(file.id);
        
        // Double click to rename
        item.ondblclick = (e) => {
            e.stopPropagation();
            const newName = prompt('Enter new file name:', file.name);
            if (newName && newName !== file.name) {
                this.fileManager.renameFile(file.id, newName);
                this.refreshFiles();
            }
        };

        const renameBtn = document.createElement('span');
        renameBtn.className = 'action-btn';
        renameBtn.textContent = '✎';
        renameBtn.title = 'Rename File';
        renameBtn.onclick = (e) => {
            e.stopPropagation();
            const newName = prompt('Enter new file name:', file.name);
            if (newName && newName !== file.name) {
                this.fileManager.renameFile(file.id, newName);
                this.refreshFiles();
            }
        };
        
        const closeBtn = document.createElement('span');
        closeBtn.className = 'action-btn';
        closeBtn.textContent = '×';
        closeBtn.title = 'Close File';
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            this.fileManager.closeFile(file.id);
        };
        
        const actionsPane = document.createElement('div');
        actionsPane.style.display = 'flex';
        actionsPane.style.gap = '4px';
        actionsPane.style.marginLeft = '4px';
        
        actionsPane.appendChild(renameBtn);
        actionsPane.appendChild(closeBtn);
        
        item.appendChild(actionsPane);
        list.appendChild(item);
    });
  }

  private setupEventListeners() {
    const newBtn = this.shadowRoot?.getElementById('new-btn');
    const openBtn = this.shadowRoot?.getElementById('open-btn');
    const fileInput = this.shadowRoot?.getElementById('file-input') as HTMLInputElement;
    const multiCheck = this.shadowRoot?.getElementById('multi-channel-check') as HTMLInputElement;
    const channelSelect = this.shadowRoot?.getElementById('channel-select') as HTMLSelectElement;

    newBtn?.addEventListener('click', () => {
        this.fileManager.newFile("Untitled.mpf");
    });

    openBtn?.addEventListener('click', () => {
        fileInput?.click();
    });

    fileInput?.addEventListener('change', async (e) => {
        const files = (e.target as HTMLInputElement).files;
        if (files && files.length > 0) {
            const file = files[0];
            const text = await file.text();
            
        const isPaFile = /\.pa$/i.test(file.name);
        const isMulti = multiCheck.checked || isPaFile;
            const channel = parseInt(channelSelect.value);
            
            await this.fileManager.openFile(text, file.name, {
                parseMultiChannel: isMulti,
                channel: channel
            });
            
            fileInput.value = ''; // Reset
        }
    });
  }

  private render() {
    if (!this.shadowRoot) return;
    
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          background: #252526;
          color: #cccccc;
          padding: 5px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }
        .toolbar {
            display: flex;
            gap: 10px;
            align-items: center;
            margin-bottom: 5px;
        }
        .file-list {
            display: flex;
            gap: 5px;
            overflow-x: auto;
        }
        .file-item {
            padding: 5px 10px;
            background: #333333;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 5px;
            border-radius: 3px;
            white-space: nowrap;
        }
        .file-item.active {
            background: #007acc;
            color: white;
        }
        .file-item:hover {
            background: #444444;
        }
        .file-item.active:hover {
            background: #0062a3;
        }
        .action-btn {
            font-weight: bold;
            font-size: 14px;
            opacity: 0.5;
            cursor: pointer;
            padding: 0 2px;
        }
        .action-btn:hover {
            opacity: 1;
        }
        button {
            background: #0e639c;
            color: white;
            border: none;
            padding: 4px 8px;
            cursor: pointer;
        }
        select, input[type="checkbox"] {
            background: #3c3c3c;
            color: white;
            border: 1px solid #3e3e42;
        }
      </style>
      <div class="file-manager">
        <div class="toolbar">
          <button id="new-btn" title="Create New File">New</button>
          <button id="open-btn" title="Open File from Disk">Open File</button>
          <input type="file" id="file-input" style="display: none;" />
          <div class="options">
              <label><input type="checkbox" id="multi-channel-check"> Multi-Channel</label>
              <select id="channel-select">
                  <option value="1">Channel 1</option>
                  <option value="2">Channel 2</option>
                  <option value="3">Channel 3</option>
              </select>
          </div>
        </div>
        <div class="file-list" id="file-list"></div>
      </div>
    `;
  }
}

customElements.define('nc-file-manager', NCFileManager);
