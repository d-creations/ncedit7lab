import { ServiceRegistry } from '@core/ServiceRegistry';
import { BACKEND_GATEWAY_TOKEN, FILE_MANAGER_SERVICE_TOKEN, CONFIG_SERVICE_TOKEN } from '@core/ServiceTokens';
import { ITransferProtocol } from '../services/transfer/ITransferProtocol';
import { TransferProtocolFactory } from '../services/transfer/TransferProtocolFactory';
import { BackendGateway } from '@services/BackendGateway';
import { IFileManagerService } from '@services/IFileManagerService';
import { IConfigService } from '@services/config/IConfigService';

import { TransferProgram } from '@core/types';

interface GroupedProgram {
  number: number;
  comment: string;
  paths: {
    1?: TransferProgram;
    2?: TransferProgram;
    3?: TransferProgram;
  };
  isPA: boolean; // Indicates if it exists on multiple paths identically
}

export class NCTransferPanel extends HTMLElement {
  private backend: BackendGateway;
  private transferClient!: ITransferProtocol;
  private fileManager: IFileManagerService;
  private configService: IConfigService;
  private fileInput?: HTMLInputElement;
  private pendingUploadPath: string | null = null;
  private transferProtocol = 'none';

  
  private cncPrograms: Map<number, GroupedProgram> = new Map();
  private ipAddress: string = '192.168.1.1';
  private isConnectedToCnc: boolean = false;
  loading: boolean = false;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.backend = ServiceRegistry.getInstance().get(BACKEND_GATEWAY_TOKEN);
    this.fileManager = ServiceRegistry.getInstance().get(FILE_MANAGER_SERVICE_TOKEN);
    this.configService = ServiceRegistry.getInstance().get(CONFIG_SERVICE_TOKEN);
    
    // Asynchronously load the default IP address from our configuration factory
    this.configService.getConfig().then(cfg => {
      this.applyTransferConfig(cfg);
      this.render();
      if (this.isConnectedToCnc) {
        this.attachEventListeners();
        void this.checkPing();
      }
    });

    this.configService.onConfigChanged((cfg) => {
      this.applyTransferConfig(cfg);
      this.render();
      this.attachEventListeners();
      if (this.isConnectedToCnc) {
        void this.checkPing();
      }
    });

    // Listen for file drops fetched via Extension
    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'DO_TRANSFER_UPLOAD') {
            this.uploadDroppedFile(message.content, message.pathId);
        } else if (message.type === 'USB_DIRECTORY_SELECTED') {
            const ipInput = this.shadowRoot?.getElementById('ip-address') as HTMLInputElement;
            if (ipInput) {
                ipInput.value = message.path;
                this.ipAddress = message.path;
            }
            this.handleConnect();
        }
    });
  }

  connectedCallback() {
    this.render();
    this.attachEventListeners();
    setTimeout(() => this.checkPing(), 100);
  }

  private applyTransferConfig(cfg: Awaited<ReturnType<IConfigService['getConfig']>>) {
    this.transferClient = TransferProtocolFactory.create(cfg.transferProtocol || 'none', this.backend, cfg.transferDriverPath);
    this.transferProtocol = cfg.transferProtocol || 'none';
    this.ipAddress = cfg.transferDefaultIp || (String(this.transferProtocol).toLowerCase() === 'usb' ? '' : '192.168.1.1');
  }

  private async handleConnect() {
    const ipInput = this.shadowRoot?.getElementById('ip-address') as HTMLInputElement;
    if (ipInput) this.ipAddress = ipInput.value;

    try {
      this.loading = true;
      this.render();
      await this.transferClient.connect(this.ipAddress);
      this.isConnectedToCnc = true;
      await this.fetchPrograms();
    } catch (e) {
      alert("Failed to connect to transfer: " + e);
      this.isConnectedToCnc = false;
    } finally {
      this.loading = false;
      this.render();
      this.attachEventListeners();
    }
  }

  private async checkPing() {
    if (String(this.transferProtocol).toLowerCase() === 'usb') return;
    const ipInput = this.shadowRoot?.querySelector('#ip-address') as HTMLInputElement;
    if (!ipInput || !ipInput.value) return;
    
    // Update local state without full reload
    this.ipAddress = ipInput.value;
    
    const pingIndicator = this.shadowRoot?.querySelector('#ping-indicator') as HTMLElement;
    if (pingIndicator) {
      pingIndicator.style.background = 'gray'; // pending
    }
    
    try {
      const available = await this.transferClient.ping(this.ipAddress);
      if (pingIndicator) {
        pingIndicator.style.background = available ? '#89d185' : '#f48771';
        pingIndicator.title = available ? 'Machine Reachable (Ping OK)' : 'Machine Unreachable';
      }
    } catch(e) {
      if (pingIndicator) {
        pingIndicator.style.background = '#f48771';
        pingIndicator.title = 'Ping Failed';
      }
    }
  }

  private getSupportedPaths(): Array<1 | 2 | 3> {
    const configuredPaths = (window as { ncedit7labSupportedTransferPaths?: unknown }).ncedit7labSupportedTransferPaths;
    if (Array.isArray(configuredPaths)) {
      const paths = configuredPaths.filter((path): path is 1 | 2 | 3 => path === 1 || path === 2 || path === 3);
      if (paths.length > 0) {
        return Array.from(new Set(paths));
      }
    }

    if (this.transferProtocol === 'usb') {
      return [1, 2, 3];
    }

    return [1, 2];
  }

  private async fetchPrograms() {
    const paths = this.getSupportedPaths();
    this.cncPrograms.clear();

    for (const path of paths) {
      try {
        const response = await this.transferClient.listPrograms(this.ipAddress, path);
        for (const prog of response) {
          if (!this.cncPrograms.has(prog.number)) {
            this.cncPrograms.set(prog.number, {
              number: prog.number,
              comment: prog.comment,
              paths: {},
              isPA: false
            });
          }
          
          const group = this.cncPrograms.get(prog.number)!;
          // @ts-ignore
          group.paths[path as keyof typeof group.paths] = prog;
          
          // Check if PA (common across at least paths 1 & 2)
          group.isPA = !!(group.paths[1] && group.paths[2]);
          if (!group.comment && prog.comment) {
            group.comment = prog.comment; // Inherit comment if missing
          }
        }
      } catch (e) {
        console.warn(`Failed to list programs on path ${path}`, e);
      }
    }
  }

  private async handleUpload(progNum: number, pathNo: string) {
    try {
      if (pathNo === 'PA') {
        const prog = this.cncPrograms.get(progNum);
        if (!prog) return;

        let combinedContent = "%\n";
        
        // Include header information (assuming prog.comment is available)
        combinedContent += `&F=/O${progNum.toString().padStart(4, '0')}(${prog.comment || 'PA_PROG'})/\n`;

        for (const p of this.getSupportedPaths()) {
            if (prog.paths[p]) {
                const resp = await this.transferClient.uploadProgram(this.ipAddress, p, progNum);
                this.fileManager.updateActiveProgramContent(p.toString(), resp);
                
                // Format block with <> XML-like tags matching the specified standard
                combinedContent += `<O${progNum.toString().padStart(4, '0')}.P${p}>\n`;
                
                // Remove trailing % or whitespace from individual blocks if present, to prevent mid-file terminations
                let cleanText = resp.trim();
                if (cleanText.endsWith('%')) {
                   cleanText = cleanText.slice(0, -1).trimEnd();
                }
                if (cleanText.startsWith('%')) {
                   cleanText = cleanText.slice(1).trimStart();
                }
                // Also strip the `OXXXX` header if it's there
                const firstNewLine = cleanText.indexOf('\n');
                if (cleanText.startsWith('O') && firstNewLine > -1 && firstNewLine < 15) {
                    cleanText = cleanText.slice(firstNewLine + 1).trimStart();
                }
                
                combinedContent += `${cleanText}\n \n`;
            }
        }
        
        combinedContent += "%\n";

        const fileName = `O${progNum.toString().padStart(4, '0')}.PA`;
        if ((window as any).vscodeApi) {
          (window as any).vscodeApi.postMessage({
                type: 'SAVE_TRANSFER_FILE',
                fileName: fileName,
                content: combinedContent
            });
        }
        alert(`Program O${progNum} (PA) uploaded successfully to workspace!`);

      } else {
        const pNum = parseInt(pathNo, 10);
        const resp = await this.transferClient.uploadProgram(this.ipAddress, pNum, progNum);
        
        // Load into matching local channel
        const channelId = pNum.toString();
        this.fileManager.updateActiveProgramContent(channelId, resp);
        
        const fileName = `O${progNum.toString().padStart(4, '0')}.P${pNum}`;
        if ((window as any).vscodeApi) {
          (window as any).vscodeApi.postMessage({
                type: 'SAVE_TRANSFER_FILE',
                fileName: fileName,
                content: resp
            });
        }

        alert(`Program O${progNum} from Path ${pNum} uploaded successfully to workspace!`);
      }
    } catch (e) {
      alert("Upload failed: " + e);
    }
  }

  private async handleCompare(progNum: number, pathNo: string) {
    try {
      if (pathNo === 'PA') {
        const prog = this.cncPrograms.get(progNum);
        if (!prog) return;

        let combinedContent = "%\n";
        
        // Include header information
        combinedContent += `&F=/O${progNum.toString().padStart(4, '0')}(${prog.comment || 'PA_PROG'})/\n`;

        for (const p of this.getSupportedPaths()) {
            if (prog.paths[p]) {
                const resp = await this.transferClient.uploadProgram(this.ipAddress, p, progNum);
                
                // Format block with <> XML-like tags matching the specified standard
                combinedContent += `<O${progNum.toString().padStart(4, '0')}.P${p}>\n`;
                
                let cleanText = resp.trim();
                if (cleanText.endsWith('%')) {
                   cleanText = cleanText.slice(0, -1).trimEnd();
                }
                if (cleanText.startsWith('%')) {
                   cleanText = cleanText.slice(1).trimStart();
                }
                // Also strip the `OXXXX` header if it's there
                const firstNewLine = cleanText.indexOf('\n');
                if (cleanText.startsWith('O') && firstNewLine > -1 && firstNewLine < 15) {
                    cleanText = cleanText.slice(firstNewLine + 1).trimStart();
                }
                
                combinedContent += `${cleanText}\n \n`;
            }
        }
        
        combinedContent += "%\n";

        const fileName = `O${progNum.toString().padStart(4, '0')}.PA`;
        if ((window as any).vscodeApi) {
          (window as any).vscodeApi.postMessage({
                type: 'COMPARE_TRANSFER_FILE',
                fileName: fileName,
                content: combinedContent
            });
        }

      } else {
        const pNum = parseInt(pathNo, 10);
        const resp = await this.transferClient.uploadProgram(this.ipAddress, pNum, progNum);
        
        const fileName = `O${progNum.toString().padStart(4, '0')}.P${pNum}`;
        if ((window as any).vscodeApi) {
          (window as any).vscodeApi.postMessage({
                type: 'COMPARE_TRANSFER_FILE',
                fileName: fileName,
                content: resp
            });
        }
      }
    } catch (e) {
      alert("Compare failed: " + e);
    }
  }

  private render() {
    if (!this.shadowRoot) return;

    const supportedPaths = this.getSupportedPaths();
    const isUsbTransfer = String(this.transferProtocol).toLowerCase() === 'usb';
    const locationLabel = isUsbTransfer ? 'USB Storage' : 'CNC Memory';
    const addressPlaceholder = isUsbTransfer ? 'Local folder path (e.g. D:\\)' : 'CNC IP';
    const connectButtonLabel = this.loading ? '...' : (this.isConnectedToCnc ? (isUsbTransfer ? 'Reload' : 'Reconnect') : (isUsbTransfer ? 'Open' : 'Connect'));
    const emptyStateText = isUsbTransfer
      ? 'Enter a local folder path (like a USB drive) and click Open.'
      : 'Please connect to a machine to browse and transfer programs.';
    const pushHeading = isUsbTransfer ? 'Store Local File to USB' : 'Push Local File to CNC';
    const pushHelpText = isUsbTransfer
      ? 'Click a button to select a file and store it to the USB path:'
      : 'Click a button to select a file from your computer:';

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          box-sizing: border-box;
          background: var(--vscode-editor-background, #1e1e1e);
          color: var(--vscode-editor-foreground, #d4d4d4);
          font-family: var(--vscode-font-family, sans-serif);
          padding: 10px;
          border-left: 1px solid var(--vscode-widget-border, #444);
        }
        .header {
          display: flex;
          gap: 10px;
          margin-bottom: 15px;
          align-items: center;
          flex-shrink: 0;
        }
        input {
          background: var(--vscode-input-background, #3c3c3c);
          color: var(--vscode-input-foreground, #cccccc);
          border: 1px solid var(--vscode-input-border, #3c3c3c);
          padding: 4px 8px;
        }
        button {
          background: var(--vscode-button-background, #0e639c);
          color: var(--vscode-button-foreground, #ffffff);
          border: none;
          padding: 4px 12px;
          cursor: pointer;
        }
        button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
        .list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .prog-item {
          background: var(--vscode-editorWidget-background, #252526);
          border: 1px solid var(--vscode-widget-border, #444);
          padding: 8px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .prog-info {
          display: flex;
          flex-direction: column;
        }
        .prog-num { font-weight: bold; color: var(--vscode-symbolIcon-keywordForeground, #007acc); }
        .pa-badge { background: #d7ba7d; color: #000; padding: 2px 6px; border-radius: 4px; font-size: 0.8em; margin-left: 5px; }
        .single-badge { border: 1px solid var(--vscode-button-background, #0e639c); color: var(--vscode-foreground, #d4d4d4); padding: 1px 5px; border-radius: 4px; font-size: 0.8em; margin-left: 5px; }
        .actions {
          display: flex;
          gap: 5px;
        }
        .actions button {
          font-size: 0.85em;
          background: var(--vscode-button-secondaryBackground, #3a3d41);
        }
        .actions button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
        
        .download-panel {
          margin-top: 15px;
          padding-top: 15px;
          border-top: 1px solid var(--vscode-widget-border, #444);
        }
        .drop-panels {
          display: flex;
          gap: 10px;
          margin-top: 10px;
        }
        .drop-zone {
          flex: 1;
          border: 2px dashed var(--vscode-widget-border, #444);
          border-radius: 4px;
          text-align: center;
          padding: 20px 5px;
          color: var(--vscode-descriptionForeground, #cccccc);
          transition: all 0.2s ease-in-out;
          font-weight: bold;
        }
        .drop-zone.drag-over {
          border-color: var(--vscode-focusBorder, #007fd4);
          background: var(--vscode-list-hoverBackground, #2a2d2e);
          color: var(--vscode-focusBorder, #007fd4);
        }
        .push-active-bar {
          display: flex;
          gap: 10px;
          margin-top: 10px;
          margin-bottom: 5px;
        }
      </style>
      
      <div class="header">
        <strong>Transfer</strong>
        ${isUsbTransfer ? '' : '<span id="ping-indicator" title="Ping Status" style="display:inline-block; width:10px; height:10px; border-radius:50%; background:gray; margin-left:8px; cursor:help;"></span>'}
        <input type="text" id="ip-address" value="${this.ipAddress === 'DEMO' && isUsbTransfer ? '' : this.ipAddress}" placeholder="${addressPlaceholder}" style="${isUsbTransfer ? 'flex: 1;' : ''}" title="${isUsbTransfer ? 'Enter full local path e.g. D:\\' : 'IP Address'}" />
        ${isUsbTransfer && (window as any).vscodeApi ? '<button id="browse-btn" title="Browse for folder">Browse</button>' : ''}
        <button id="connect-btn">${connectButtonLabel}</button>
      </div>

      ${this.isConnectedToCnc ? `
        <div class="list">
          <h3>${locationLabel}</h3>
          ${Array.from(this.cncPrograms.values()).sort((a,b)=>a.number-b.number).map(prog => `
            <div class="prog-item" draggable="true" data-drag-prog="${prog.number}" data-drag-pa="${prog.isPA ? 'true' : 'false'}">
              <div class="prog-info">
                <div>
                  <span class="prog-num">O${prog.number.toString().padStart(4, '0')}</span>
                  ${prog.isPA 
                    ? '<span class="pa-badge">PA Program</span>' 
                    : `<span class="single-badge">Path ${supportedPaths.filter(p => prog.paths[p]).join(', ')}</span>`
                  }
                </div>
                <small>${prog.comment}</small>
              </div>
              <div class="actions">
                ${prog.isPA ? 
                  `${(window as any).vscodeApi ? `<button class="btn-cmp" data-path="PA" data-prog="${prog.number}">Cmp PA</button>` : ''}
                   <button class="btn-upl" data-path="PA" data-prog="${prog.number}">Pull PA</button>` : 
                  ''
                }
                ${supportedPaths.map(path => prog.paths[path] ? 
                  `${(window as any).vscodeApi ? `<button class="btn-cmp" data-path="${path}" data-prog="${prog.number}">Cmp P${path}</button>` : ''}
                   <button class="btn-upl" data-path="${path}" data-prog="${prog.number}">Pull P${path}</button>` : 
                  ''
                ).join('')}
              </div>
            </div>
          `).join('')}
          ${this.cncPrograms.size === 0 ? '<p>No programs found on machine.</p>' : ''}
        </div>

        <div class="download-panel">
          <h3>${pushHeading}</h3>
          <div class="push-active-bar">
             <span style="align-self: center; font-size: 0.9em; flex: 1;"><strong>Push Open File:</strong></span>
             <button class="btn-push-active" data-path="PA">PA</button>
             ${supportedPaths.map(path => `<button class="btn-push-active" data-path="${path}">P${path}</button>`).join('')}
          </div>
          <span>${pushHelpText}</span>
          <div class="drop-panels">
            <div class="drop-zone upload-zone" data-path="PA" style="cursor:pointer">Upload PA</div>
            ${supportedPaths.map(path => `<div class="drop-zone upload-zone" data-path="${path}" style="cursor:pointer">Upload P${path}</div>`).join('')}
          </div>
        </div>
      ` : `
        <div class="list">
          <p>${emptyStateText}</p>
        </div>
      `}
    `;
  }

  private attachEventListeners() {
    this.shadowRoot?.getElementById('connect-btn')?.addEventListener('click', () => this.handleConnect());
    
    this.shadowRoot?.getElementById('browse-btn')?.addEventListener('click', () => {
      if ((window as any).vscodeApi) {
        (window as any).vscodeApi.postMessage({ type: 'SELECT_USB_DIRECTORY' });
      }
    });
    
    const ipInput = this.shadowRoot?.getElementById('ip-address') as HTMLInputElement;
    if (ipInput && String(this.transferProtocol).toLowerCase() !== 'usb') {
      ipInput.addEventListener('change', () => this.checkPing());
      ipInput.addEventListener('blur', () => this.checkPing());
    }
    
    if (this.isConnectedToCnc) {
      const uplButtons = this.shadowRoot?.querySelectorAll('.btn-upl');
      uplButtons?.forEach(btn => {
        btn.addEventListener('click', (e) => {
          const target = e.target as HTMLElement;
          const prog = parseInt(target.getAttribute('data-prog') || '0', 10);
          const path = target.getAttribute('data-path') || '1';
          if(prog) this.handleUpload(prog, path);
        });
      });

      const cmpButtons = this.shadowRoot?.querySelectorAll('.btn-cmp');
      cmpButtons?.forEach(btn => {
        btn.addEventListener('click', (e) => {
          const target = e.target as HTMLElement;
          const prog = parseInt(target.getAttribute('data-prog') || '0', 10);
          const path = target.getAttribute('data-path') || '1';
          if(prog) this.handleCompare(prog, path);
        });
      });

      const progItems = this.shadowRoot?.querySelectorAll('.prog-item');
      progItems?.forEach(item => {
        item.addEventListener('dragstart', (e) => {
          const dragEvent = e as DragEvent;
          if (dragEvent.dataTransfer) {
            const progNum = item.getAttribute('data-drag-prog') || '';
            const isPA = item.getAttribute('data-drag-pa') === 'true';
            
            // Set text payload so it can at least be dropped into text editors
            dragEvent.dataTransfer.setData('text/plain', `Transfer Program O${progNum.padStart(4, '0')} (${isPA ? 'PA' : 'Multi-path'})`);
            dragEvent.dataTransfer.effectAllowed = 'copy';
          }
        });
      });

      const pushActiveBtns = this.shadowRoot?.querySelectorAll('.btn-push-active');
      pushActiveBtns?.forEach(btn => {
        btn.addEventListener('click', (e) => {
           const target = e.target as HTMLElement;
           const path = target.getAttribute('data-path');
           if (path && (window as any).vscodeApi) {
               (window as any).vscodeApi.postMessage({
                   type: 'REQUEST_ACTIVE_PROGRAM_FOR_UPLOAD',
                   pathId: path
               });
           }
        });
      });

      this.attachFilePickerListeners();
    }
  }

  private attachFilePickerListeners() {
    const zones = this.shadowRoot?.querySelectorAll('.upload-zone');
    
    if (!this.fileInput || !this.shadowRoot?.contains(this.fileInput)) {
      this.fileInput = document.createElement('input');
      this.fileInput.type = 'file';
      this.fileInput.id = 'hidden-file-input';
      this.fileInput.style.display = 'none';
      this.fileInput.addEventListener('change', async (e: Event) => {
        const target = e.target as HTMLInputElement;
        const selectedPath = this.pendingUploadPath;

        try {
          if (target.files && target.files.length > 0 && selectedPath) {
            const file = target.files[0];
            const content = await file.text();
            await this.uploadDroppedFile(content, selectedPath);
          }
        } catch (err) {
          alert("Could not read file: " + err);
        } finally {
          target.value = '';
          this.pendingUploadPath = null;
        }
      });
      this.shadowRoot?.appendChild(this.fileInput);
    }

    zones?.forEach(zone => {
      // Keep hover effects
      zone.addEventListener('mouseenter', () => zone.classList.add('drag-over'));
      zone.addEventListener('mouseleave', () => zone.classList.remove('drag-over'));
      
      zone.addEventListener('click', () => {
        this.pendingUploadPath = (zone as HTMLElement).getAttribute('data-path');
        this.fileInput?.click();
      });
    });
  }

  private async uploadDroppedFile(content: string, targetPath: string | null) {
    if (!targetPath) return;

    try {
      this.loading = true;
      this.render();
      if (targetPath === 'PA') {
        const pathContents: Record<number, string> = {};
        const tagRegex = /<[^>]*P(\d+)>/g;
        let match;
        let lastIndex = 0;
        let lastPath = -1;

        while ((match = tagRegex.exec(content)) !== null) {
          if (lastPath !== -1) {
            pathContents[lastPath] = content.substring(lastIndex, match.index).trim();
          }
          lastPath = parseInt(match[1], 10);
          lastIndex = tagRegex.lastIndex;
        }
        if (lastPath !== -1) {
          pathContents[lastPath] = content.substring(lastIndex).trim();
        }

        if (Object.keys(pathContents).length === 0) {
          alert('Could not find PA format tags (e.g., <O1234.P1>) in the file. Uploading aborted.');
          return;
        }

        const uploadedPaths: number[] = [];
        const errors: string[] = [];
        
        for (const [pStr, partContent] of Object.entries(pathContents)) {
          const p = parseInt(pStr, 10);
          
          let cleanContent = partContent.trim();
          if (cleanContent.startsWith('%')) cleanContent = cleanContent.slice(1).trimStart();
          if (cleanContent.endsWith('%')) cleanContent = cleanContent.slice(0, -1).trimEnd();
          
          // Transfer format: Must start with LF and end with % (no leading %)
          const finalContent = `\n${cleanContent}\n%`;
          
          try {
            await this.transferClient.downloadProgram(this.ipAddress, p, finalContent);
            uploadedPaths.push(p);
          } catch(e) {
            console.warn(`Failed to push to Path ${p}`, e);
            errors.push(`P${p}: ${e}`);
          }
        }
        
        if (errors.length > 0 && uploadedPaths.length === 0) {
          alert(`Failed to push PA file:\\n${errors.join('\\n')}`);
        } else if (errors.length > 0) {
          alert(`File pushed to Paths ${uploadedPaths.join(', ')}.\\nErrors:\\n${errors.join('\\n')}`);
        } else {
          alert(`PA File pushed to Paths ${uploadedPaths.join(', ')} successfully!`);
        }
      } else {
        const pathNo = parseInt(targetPath, 10);
        
        let cleanContent = content.trim();
        if (cleanContent.startsWith('%')) cleanContent = cleanContent.slice(1).trimStart();
        if (cleanContent.endsWith('%')) cleanContent = cleanContent.slice(0, -1).trimEnd();
        
        const finalContent = `\n${cleanContent}\n%`;
        
        await this.transferClient.downloadProgram(this.ipAddress, pathNo, finalContent);
        alert(`File pushed to Path ${pathNo} successfully!`);
      }
    } catch(e) {
      alert("Push failed: " + e);
    } finally {
      await this.fetchPrograms();
      this.loading = false;
      this.render();
      this.attachEventListeners();
    }
  }

}

customElements.define('nc-transfer-panel', NCTransferPanel);
