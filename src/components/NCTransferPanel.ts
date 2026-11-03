import { ServiceRegistry } from '@core/ServiceRegistry';
import { BACKEND_GATEWAY_TOKEN, FILE_MANAGER_SERVICE_TOKEN, CONFIG_SERVICE_TOKEN, MACHINE_SERVICE_TOKEN, STATE_SERVICE_TOKEN, EVENT_BUS_TOKEN } from '@core/ServiceTokens';
import { ITransferProtocol } from '../services/transfer/ITransferProtocol';
import { TransferProtocolFactory } from '../services/transfer/TransferProtocolFactory';
import { BackendGateway } from '@services/BackendGateway';
import { IFileManagerService } from '@services/IFileManagerService';
import { IConfigService } from '@services/config/IConfigService';
import { MachineService } from '@services/MachineService';
import { StateService } from '@services/StateService';
import { EventBus, EVENT_NAMES } from '@services/EventBus';

import type { TransferProgram, FileExtensionConfig } from '@core/types';

interface GroupedProgram {
  number: number;
  comment: string;
  paths: Record<number, TransferProgram>;
  containerProgram?: TransferProgram;
  isPA: boolean; // Indicates if it exists on multiple paths or is a multipath container
}

export class NCTransferPanel extends HTMLElement {
  private backend: BackendGateway;
  private transferClient!: ITransferProtocol;
  private fileManager: IFileManagerService;
  private configService: IConfigService;
  private machineService: MachineService;
  private stateService: StateService;
  private eventBus: EventBus;
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
    this.machineService = ServiceRegistry.getInstance().get(MACHINE_SERVICE_TOKEN);
    this.stateService = ServiceRegistry.getInstance().get(STATE_SERVICE_TOKEN);
    this.eventBus = ServiceRegistry.getInstance().get(EVENT_BUS_TOKEN);
    
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

    // Re-render when machine selection changes (channels / extensions may change)
    this.eventBus.subscribe(EVENT_NAMES.MACHINE_CHANGED, () => {
      this.render();
      this.attachEventListeners();
    });

    // Listen for file drops fetched via Extension
    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'DO_TRANSFER_UPLOAD') {
            this.uploadDroppedFile(message.content, message.pathId);
        } else if (message.type === 'USB_DIRECTORY_SELECTED') {
            this.ipAddress = message.path;
            const ipInput = this.shadowRoot?.getElementById('ip-address') as HTMLInputElement;
            if (ipInput) {
                ipInput.value = message.path;
            }
            void this.handleConnect(message.path);
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
    const configuredIp = cfg.transferDefaultIp || (String(this.transferProtocol).toLowerCase() === 'usb' ? '' : '192.168.1.1');
    if (configuredIp || !this.ipAddress) {
      this.ipAddress = configuredIp;
    }
  }

  private async handleConnect(addressOverride?: string) {
    const ipInput = this.shadowRoot?.getElementById('ip-address') as HTMLInputElement;
    if (typeof addressOverride === 'string' && addressOverride.trim()) {
      this.ipAddress = addressOverride;
    } else if (ipInput) {
      this.ipAddress = ipInput.value;
    }

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

  private getSupportedPaths(): number[] {
    return this.getSupportedChannels();
  }

  // --- Machine file-extension helpers ---

  /** Returns the FileExtensionConfig for the currently selected machine, or undefined.
   * Returns undefined if no machine has been selected yet — callers fall back to
   * sensible defaults (e.g. [1,2,3] for USB). */
  private getCurrentMachineFileExtensions(): FileExtensionConfig | undefined {
    const { globalMachine } = this.stateService.getState();
    if (!globalMachine) return undefined;
    const ext = this.machineService.getMachine(globalMachine)?.fileExtensions;
    if (!ext || typeof ext.multifile !== 'boolean' || !ext.channels || typeof ext.channels !== 'object') {
      return undefined;
    }
    return ext;
  }

  /**
   * Returns the sorted channel numbers supported by the current machine.
   * Falls back to [1,2,3] for USB or [1,2] for FOCAS when no machine config is available.
   */
  private getSupportedChannels(): number[] {
    const ext = this.getCurrentMachineFileExtensions();
    if (!ext) {
      return this.transferProtocol === 'usb' ? [1, 2, 3] : [1, 2];
    }
    if (!ext.multifile) {
      // Single-file machine (e.g. Siemens): only one "channel"
      return [1];
    }
    const channels = Object.keys(ext.channels)
      .map(Number)
      .filter(n => !isNaN(n))
      .sort((a, b) => a - b);
    return channels.length > 0 ? channels : [1];
  }

  /** Returns true when the current machine supports PA / multi-channel assembly files. */
  private isMultifileSupported(): boolean {
    const ext = this.getCurrentMachineFileExtensions();
    if (ext === undefined) return true; // default: assume multifile
    return ext.multifile;
  }

  /**
   * Returns the preferred file extension for a given channel number.
   * Uses the first non-empty extension from machine config, falling back to `.P{n}`.
   */
  private getChannelFileExtension(channelNo: number): string {
    const ext = this.getCurrentMachineFileExtensions();
    if (!ext) return `.P${channelNo}`;
    const channelExts = ext.channels?.[channelNo.toString()];
    if (!channelExts || channelExts.length === 0) return ext.main?.[0] ?? '';
    // Prefer non-empty extension; "" means no extension (bare filename)
    return channelExts.find(e => e !== '') ?? channelExts[0] ?? '';
  }

  private getChannelFileExtensions(channelNo: number): string[] | undefined {
    return this.getCurrentMachineFileExtensions()?.channels?.[channelNo.toString()];
  }

  /** Returns the file extension used for PA (multi-channel assembly) programs. */
  private getPAFileExtension(): string {
    const ext = this.getCurrentMachineFileExtensions();
    return ext?.main?.[0] ?? '.PA';
  }

  /**
   * Returns a channel-first label so filename conventions do not obscure the CNC path.
   * e.g. ".M" -> "P1 Main (.M)", ".S" -> "P2 Sub (.S)", ".p-2" -> "P2 (.p-2)".
   */
  private getChannelLabel(channelNo: number, sourceExtension?: string): string {
    const extension = sourceExtension !== undefined ? sourceExtension : this.getChannelFileExtension(channelNo);
    const channelLabel = `P${channelNo}`;
    if (extension.toLowerCase() === `.p${channelNo}`) return channelLabel;

    const config = this.getCurrentMachineFileExtensions();
    const normalizedExtension = extension.toLowerCase();
    const isMain = config?.main?.some(item => item.toLowerCase() === normalizedExtension) || normalizedExtension === '.m';
    const isSub = config?.subprogram?.some(item => item.toLowerCase() === normalizedExtension) || normalizedExtension === '.s';
    const role = isMain ? ' Main' : isSub ? ' Sub' : '';
    const extensionLabel = extension || 'no ext';
    return `${channelLabel}${role} (${extensionLabel})`;
  }

  /** Build a save-file name for a channel program, preserving its USB source extension when available. */
  private buildChannelFileName(progNum: number, channelNo: number, sourceExtension?: string): string {
    const ext = sourceExtension !== undefined ? sourceExtension : this.getChannelFileExtension(channelNo);
    return `O${progNum.toString().padStart(4, '0')}${ext}`;
  }

  /** Build a save-file name for a PA program, e.g. "O0001.PA". */
  private buildPAFileName(progNum: number, sourceExtension?: string): string {
    const ext = sourceExtension !== undefined ? sourceExtension : this.getPAFileExtension();
    return `O${progNum.toString().padStart(4, '0')}${ext}`;
  }

  /** Maps a USB program entry and its file extension to a channel number (or 0 for multipath container). */
  private resolveUsbProgramChannel(prog: TransferProgram, existingPaths: Record<number, TransferProgram>): number {
    const ext = (prog.file_extension ?? '').toLowerCase();
    if (prog.is_multipath || ext === '.pa') {
      return 0;
    }

    const pathMatch = ext.match(/^\.p-?(\d+)$/i);
    if (pathMatch) {
      return parseInt(pathMatch[1], 10);
    }

    const machineExts = this.getCurrentMachineFileExtensions();
    if (machineExts?.channels) {
      for (const [chKey, chExts] of Object.entries(machineExts.channels)) {
        const chNum = parseInt(chKey, 10);
        if (!isNaN(chNum) && chExts.some(item => item.toLowerCase() === ext)) {
          return chNum;
        }
      }
    }

    if (ext === '.m') return 1;
    if (ext === '.s') return 2;

    if (!existingPaths[1]) return 1;
    const maxCh = Math.max(1, ...Object.keys(existingPaths).map(Number));
    return maxCh + 1;
  }

  private getGroupChannels(prog: GroupedProgram): number[] {
    return Object.keys(prog.paths)
      .map(Number)
      .filter(n => !isNaN(n) && n > 0)
      .sort((a, b) => a - b);
  }

  private splitMultipathChannels(content: string): Record<number, string> {
    const tagRegex = /<\s*(?:(O[A-Za-z0-9_]+)\.)?P(\d+)\s*>/gi;
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    let lastPath = -1;
    let lastProgramName = '';
    const pathContents: Record<number, string> = {};

    while ((match = tagRegex.exec(content)) !== null) {
      if (lastPath !== -1) {
        pathContents[lastPath] = this.normalizeExtractedChannelBlock(lastProgramName, content.substring(lastIndex, match.index));
      }
      lastProgramName = match[1] || '';
      lastPath = parseInt(match[2], 10);
      lastIndex = tagRegex.lastIndex;
    }
    if (lastPath !== -1) {
      pathContents[lastPath] = this.normalizeExtractedChannelBlock(lastProgramName, content.substring(lastIndex));
    }
    return pathContents;
  }

  private normalizeExtractedChannelBlock(programName: string, rawBlock: string): string {
    let clean = rawBlock.trim();
    if (clean.endsWith('%')) clean = clean.slice(0, -1).trimEnd();
    if (clean.startsWith('%')) clean = clean.slice(1).trimStart();
    if (programName && !new RegExp(`^${programName}\\b`, 'i').test(clean)) {
      clean = `${programName}\n${clean}`.trimEnd();
    }
    return `%\n${clean}\n%\n`;
  }

  private async fetchPrograms() {
    const paths = this.getSupportedPaths();
    const multifile = this.isMultifileSupported();
    const isUsb = String(this.transferProtocol).toLowerCase() === 'usb';
    this.cncPrograms.clear();

    if (isUsb) {
      try {
        const response = await this.transferClient.listPrograms(this.ipAddress, 0);
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
          const channelNo = this.resolveUsbProgramChannel(prog, group.paths);
          if (channelNo === 0) {
            group.containerProgram = prog;
            group.isPA = true;
            for (const ch of prog.channels ?? []) {
              if (!group.paths[ch]) {
                group.paths[ch] = prog;
              }
            }
          } else {
            group.paths[channelNo] = prog;
            if (Object.keys(group.paths).length > 1) {
              group.isPA = true;
            }
          }

          if (!group.comment && prog.comment) {
            group.comment = prog.comment;
          }
        }
      } catch (e) {
        console.warn('Failed to list programs on USB storage', e);
      }
      return;
    }

    for (const path of paths) {
      try {
        const response = await this.transferClient.listPrograms(this.ipAddress, path, undefined, this.getChannelFileExtensions(path));
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
          group.paths[path] = prog;
          
          // A pull is combined when the program exists in multiple channels.
          group.isPA = multifile && Object.keys(group.paths).length > 1;
          if (!group.comment && prog.comment) {
            group.comment = prog.comment;
          }
        }
      } catch (e) {
        console.warn(`Failed to list programs on path ${path}`, e);
      }
    }
  }

  private getUploadExtensionsForProgram(progNum: number, pathNo: number): string[] | undefined {
    if (String(this.transferProtocol).toLowerCase() === 'usb') {
      const group = this.cncPrograms.get(progNum);
      const entry = pathNo === 0 ? group?.containerProgram : group?.paths[pathNo];
      if (entry && entry.file_extension !== undefined) {
        return [entry.file_extension];
      }
    }
    return pathNo > 0 ? this.getChannelFileExtensions(pathNo) : undefined;
  }

  private formatPAProgram(content: string): string {
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const tagRegex = /<\s*(?:(O[A-Za-z0-9_]+)\.)?P(\d+)\s*>/gi;
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    let lastPath = -1;
    let lastProgramName = '';
    const sections: Array<{ path: number; programName: string; body: string }> = [];

    while ((match = tagRegex.exec(normalized)) !== null) {
      if (lastPath !== -1) {
        sections.push({
          path: lastPath,
          programName: lastProgramName,
          body: normalized.substring(lastIndex, match.index),
        });
      }
      lastProgramName = match[1] || '';
      lastPath = parseInt(match[2], 10);
      lastIndex = tagRegex.lastIndex;
    }
    if (lastPath !== -1) {
      sections.push({
        path: lastPath,
        programName: lastProgramName,
        body: normalized.substring(lastIndex),
      });
    }

    const nonEmptySections = sections.filter(section => {
      const stripped = section.body.replace(/%/g, '').trim();
      return stripped.length > 0;
    });

    if (nonEmptySections.length === 0) {
      let clean = normalized.trim();
      if (clean.startsWith('%')) clean = clean.slice(1).trimStart();
      if (clean.endsWith('%')) clean = clean.slice(0, -1).trimEnd();
      return `%\n${clean}\n%`;
    }

    let rawProgramName = nonEmptySections.find(s => s.programName)?.programName || '';
    if (!rawProgramName) {
      const assignMatch = normalized.match(/&F=\/\s*(O[A-Za-z0-9_]+)/i);
      if (assignMatch) {
        rawProgramName = assignMatch[1];
      }
    }
    if (!rawProgramName) {
      for (const section of nonEmptySections) {
        const bodyMatch = section.body.match(/(?:^|\n)\s*(O\d+)\b/i);
        if (bodyMatch) {
          rawProgramName = bodyMatch[1];
          break;
        }
      }
    }

    const numMatch = rawProgramName.match(/^O(\d+)$/i);
    const formattedProgName = numMatch
      ? `O${parseInt(numMatch[1], 10).toString().padStart(4, '0')}`
      : (rawProgramName ? rawProgramName.toUpperCase() : 'O0001');

    const formattedBlocks: string[] = [];
    for (const section of nonEmptySections) {
      let cleanBody = section.body.trim();
      while (cleanBody.startsWith('%')) {
        cleanBody = cleanBody.slice(1).trimStart();
      }
      while (cleanBody.endsWith('%')) {
        cleanBody = cleanBody.slice(0, -1).trimEnd();
      }

      const lines = cleanBody.split('\n');
      const firstLine = lines[0]?.trim() || '';
      if (/^O\d+\b/i.test(firstLine)) {
        const remainder = firstLine.replace(/^O\d+\s*/i, '').trim();
        if (remainder) {
          lines[0] = remainder;
        } else {
          lines.shift();
        }
        cleanBody = lines.join('\n').trim();
      }

      formattedBlocks.push(`<${formattedProgName}.P${section.path}>\n${cleanBody}`);
    }

    return `%\n&F=/${formattedProgName}/\n${formattedBlocks.join('\n')}\n%`;
  }

  private async handleUpload(progNum: number, pathNo: string) {
    try {
      const isUsb = String(this.transferProtocol).toLowerCase() === 'usb';
      if (pathNo === 'PA') {
        const prog = this.cncPrograms.get(progNum);
        if (!prog) return;

        // If this is a single multipath container file on USB (e.g. .PA or extensionless with <O1234.P1> tags)
        if (isUsb && prog.containerProgram && Object.keys(prog.paths).every(ch => prog.paths[Number(ch)] === prog.containerProgram)) {
          const containerExt = prog.containerProgram.file_extension;
          const resp = await this.transferClient.uploadProgram(
            this.ipAddress,
            0,
            progNum,
            undefined,
            containerExt !== undefined ? [containerExt] : undefined
          );
          const splitBlocks = this.splitMultipathChannels(resp);
          const channelNums = Object.keys(splitBlocks).map(Number).sort((a, b) => a - b);
          if (channelNums.length > 0) {
            for (const ch of channelNums) {
              this.fileManager.updateActiveProgramContent(ch.toString(), splitBlocks[ch]);
            }
          } else {
            this.fileManager.updateActiveProgramContent('1', resp);
          }

          const formattedPA = `${this.formatPAProgram(resp)}\n`;
          const fileName = this.buildPAFileName(progNum, containerExt);
          if ((window as any).vscodeApi) {
            (window as any).vscodeApi.postMessage({
              type: 'SAVE_TRANSFER_FILE',
              fileName: fileName,
              content: formattedPA
            });
          }
          alert(`Program O${progNum} (PA) uploaded successfully to workspace!`);
          return;
        }

        const progHeader = `O${progNum.toString().padStart(4, '0')}`;
        let combinedContent = `%\n&F=/${progHeader}/\n`;

        const channelsToPull = isUsb ? this.getGroupChannels(prog) : this.getSupportedPaths();
        for (const p of channelsToPull) {
            if (prog.paths[p]) {
                const resp = await this.transferClient.uploadProgram(this.ipAddress, p, progNum, undefined, this.getUploadExtensionsForProgram(progNum, p));
                this.fileManager.updateActiveProgramContent(p.toString(), resp);
                combinedContent += `<${progHeader}.P${p}>\n${resp}\n`;
            }
        }
        
        const formattedPA = `${this.formatPAProgram(combinedContent)}\n`;

        const fileName = this.buildPAFileName(progNum);
        if ((window as any).vscodeApi) {
          (window as any).vscodeApi.postMessage({
                type: 'SAVE_TRANSFER_FILE',
                fileName: fileName,
                content: formattedPA
            });
        }
        alert(`Program O${progNum} (PA) uploaded successfully to workspace!`);

      } else {
        const pNum = parseInt(pathNo, 10);
        const resp = await this.transferClient.uploadProgram(this.ipAddress, pNum, progNum, undefined, this.getUploadExtensionsForProgram(progNum, pNum));
        
        // If the single file pulled from USB actually contains multipath <...P1>/<...P2> blocks, populate each channel
        const splitBlocks = isUsb ? this.splitMultipathChannels(resp) : {};
        const splitChannelNums = Object.keys(splitBlocks).map(Number).sort((a, b) => a - b);
        if (splitChannelNums.length > 1) {
          for (const ch of splitChannelNums) {
            this.fileManager.updateActiveProgramContent(ch.toString(), splitBlocks[ch]);
          }
        } else {
          const channelId = pNum.toString();
          this.fileManager.updateActiveProgramContent(channelId, resp);
        }
        
        const sourceExtension = isUsb
          ? this.cncPrograms.get(progNum)?.paths[pNum]?.file_extension
          : undefined;
        const fileName = this.buildChannelFileName(progNum, pNum, sourceExtension);
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
      const isUsb = String(this.transferProtocol).toLowerCase() === 'usb';
      if (pathNo === 'PA') {
        const prog = this.cncPrograms.get(progNum);
        if (!prog) return;

        if (isUsb && prog.containerProgram && Object.keys(prog.paths).every(ch => prog.paths[Number(ch)] === prog.containerProgram)) {
          const containerExt = prog.containerProgram.file_extension;
          const resp = await this.transferClient.uploadProgram(
            this.ipAddress,
            0,
            progNum,
            undefined,
            containerExt !== undefined ? [containerExt] : undefined
          );
          const formattedPA = `${this.formatPAProgram(resp)}\n`;
          const fileName = this.buildPAFileName(progNum, containerExt);
          if ((window as any).vscodeApi) {
            (window as any).vscodeApi.postMessage({
              type: 'COMPARE_TRANSFER_FILE',
              fileName: fileName,
              content: formattedPA
            });
          }
          return;
        }

        const progHeader = `O${progNum.toString().padStart(4, '0')}`;
        let combinedContent = `%\n&F=/${progHeader}/\n`;

        const channelsToCompare = isUsb ? this.getGroupChannels(prog) : this.getSupportedPaths();
        for (const p of channelsToCompare) {
            if (prog.paths[p]) {
                const resp = await this.transferClient.uploadProgram(this.ipAddress, p, progNum, undefined, this.getUploadExtensionsForProgram(progNum, p));
                combinedContent += `<${progHeader}.P${p}>\n${resp}\n`;
            }
        }
        
        const formattedPA = `${this.formatPAProgram(combinedContent)}\n`;

        const fileName = this.buildPAFileName(progNum);
        if ((window as any).vscodeApi) {
          (window as any).vscodeApi.postMessage({
                type: 'COMPARE_TRANSFER_FILE',
                fileName: fileName,
                content: formattedPA
            });
        }

      } else {
        const pNum = parseInt(pathNo, 10);
        const prog = this.cncPrograms.get(progNum);
        if (isUsb && prog?.containerProgram && prog.paths[pNum] === prog.containerProgram) {
          const containerExt = prog.containerProgram.file_extension;
          const resp = await this.transferClient.uploadProgram(
            this.ipAddress,
            0,
            progNum,
            undefined,
            containerExt !== undefined ? [containerExt] : undefined
          );
          const splitBlocks = this.splitMultipathChannels(resp);
          const channelContent = splitBlocks[pNum] ?? resp;
          const fileName = this.buildChannelFileName(progNum, pNum);
          if ((window as any).vscodeApi) {
            (window as any).vscodeApi.postMessage({
              type: 'COMPARE_TRANSFER_FILE',
              fileName: fileName,
              content: channelContent
            });
          }
          return;
        }

        const resp = await this.transferClient.uploadProgram(this.ipAddress, pNum, progNum, undefined, this.getUploadExtensionsForProgram(progNum, pNum));
        const sourceExtension = isUsb ? prog?.paths[pNum]?.file_extension : undefined;
        const fileName = this.buildChannelFileName(progNum, pNum, sourceExtension);
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
    const multifileSupported = this.isMultifileSupported();
    const isUsbTransfer = String(this.transferProtocol).toLowerCase() === 'usb';
    const locationLabel = isUsbTransfer ? 'USB Storage' : 'CNC Memory';
    const addressPlaceholder = isUsbTransfer ? 'Local folder path (e.g. D:\\)' : 'CNC IP';
    const connectButtonLabel = this.loading ? '...' : (this.isConnectedToCnc ? (isUsbTransfer ? 'Reload' : 'Reconnect') : (isUsbTransfer ? 'Open' : 'Connect'));
    const emptyStateText = isUsbTransfer
      ? 'Enter a local folder path (like a USB drive) and click Open.'
      : 'Please connect to a machine to browse and transfer programs.';
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
          ${Array.from(this.cncPrograms.values()).sort((a,b)=>a.number-b.number).map(prog => {
            const progChannels = isUsbTransfer
              ? this.getGroupChannels(prog)
              : supportedPaths.filter(p => prog.paths[p]);
            const showAsPA = isUsbTransfer ? prog.isPA : (prog.isPA && multifileSupported);
            const badgeHtml = showAsPA
              ? `<span class="pa-badge">PA Program${progChannels.length > 0 ? ` (${progChannels.map(p => `P${p}`).join(', ')})` : ''}</span>`
              : `<span class="single-badge">${progChannels.map(p => this.getChannelLabel(p, isUsbTransfer ? prog.paths[p]?.file_extension : undefined)).join(', ')}</span>`;
            const pullPath = showAsPA ? 'PA' : (progChannels[0] ?? 1);
            return `
            <div class="prog-item" draggable="true" data-drag-prog="${prog.number}" data-drag-pa="${showAsPA ? 'true' : 'false'}">
              <div class="prog-info">
                <div>
                  <span class="prog-num">O${prog.number.toString().padStart(4, '0')}</span>
                  ${badgeHtml}
                </div>
                <small>${prog.comment}</small>
              </div>
              <div class="actions">
                <button class="btn-upl" data-path="${pullPath}" data-prog="${prog.number}">Pull</button>
                ${progChannels.map(path =>
                  `${(window as any).vscodeApi ? `<button class="btn-cmp" data-path="${path}" data-prog="${prog.number}">Compare ${this.getChannelLabel(path, isUsbTransfer && prog.paths[path] !== prog.containerProgram ? prog.paths[path]?.file_extension : undefined)}</button>` : ''}`
                ).join('')}
              </div>
            </div>
          `;
          }).join('')}
          ${this.cncPrograms.size === 0 ? '<p>No programs found on machine.</p>' : ''}
        </div>

        <div class="download-panel">
          <div class="push-active-bar">
             <span style="align-self: center; font-size: 0.9em; flex: 1;"><strong>Push Open File:</strong></span>
             ${multifileSupported ? `<button class="btn-push-active" data-path="PA">PA</button>` : ''}
             ${supportedPaths.map(path => `<button class="btn-push-active" data-path="${path}">${this.getChannelLabel(path)}</button>`).join('')}
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
           if (!path) return;
           if ((window as any).vscodeApi) {
               (window as any).vscodeApi.postMessage({
                   type: 'REQUEST_ACTIVE_PROGRAM_FOR_UPLOAD',
                   pathId: path
               });
           } else {
               const content = this.buildActiveProgramContentForPush(path);
               if (content) {
                   void this.uploadDroppedFile(content, path);
               } else {
                   alert('No active NC program content is available to push.');
               }
           }
        });
      });

    }
  }

  private buildActiveProgramContentForPush(targetPath: string): string | null {
    if (targetPath === 'PA') {
      const channels = this.getSupportedChannels();
      let progName = '';
      const channelBlocks: Array<{ ch: number; content: string }> = [];

      for (const ch of channels) {
        const prog = this.fileManager.getActiveProgram(ch.toString());
        const text = prog?.content?.trim();
        if (text) {
          channelBlocks.push({ ch, content: text });
          if (!progName) {
            const match = text.match(/(?:^|\n)\s*(O\d+)\b/i);
            if (match) progName = match[1].toUpperCase();
          }
        }
      }

      if (channelBlocks.length === 0) return null;
      const numMatch = progName.match(/^O(\d+)$/i);
      const formattedName = numMatch
        ? `O${parseInt(numMatch[1], 10).toString().padStart(4, '0')}`
        : (progName || 'O0001');

      const rawCombined = channelBlocks
        .map(({ ch, content }) => `<${formattedName}.P${ch}>\n${content}`)
        .join('\n');
      return this.formatPAProgram(rawCombined);
    }

    const pathNo = parseInt(targetPath.replace('path', ''), 10);
    if (isNaN(pathNo)) return null;
    const prog = this.fileManager.getActiveProgram(pathNo.toString());
    return prog?.content?.trim() ? prog.content : null;
  }

  private async uploadDroppedFile(content: string, targetPath: string | null) {
    if (!targetPath) return;

    try {
      this.loading = true;
      this.render();
      if (targetPath === 'PA') {
        if (String(this.transferProtocol).toLowerCase() === 'usb') {
          const finalContent = this.formatPAProgram(content);
          await this.transferClient.downloadProgram(this.ipAddress, 0, finalContent, undefined, this.getPAFileExtension());
          alert('PA file pushed successfully as one .PA file.');
          return;
        }

        const tagRegex = /<\s*(?:(O[A-Za-z0-9_]+)\.)?P(\d+)\s*>/gi;
        let match;
        let lastIndex = 0;
        let lastPath = -1;
        let lastProgramName = '';
        const pathContents: Record<number, { programName: string; content: string }> = {};

        while ((match = tagRegex.exec(content)) !== null) {
          if (lastPath !== -1) {
            pathContents[lastPath] = { programName: lastProgramName, content: content.substring(lastIndex, match.index).trim() };
          }
          lastProgramName = match[1];
          lastPath = parseInt(match[2], 10);
          lastIndex = tagRegex.lastIndex;
        }
        if (lastPath !== -1) {
          pathContents[lastPath] = { programName: lastProgramName, content: content.substring(lastIndex).trim() };
        }

        if (Object.keys(pathContents).length === 0) {
          alert('Could not find PA format tags (e.g., <O1234.P1>) in the file. Uploading aborted.');
          return;
        }

        const uploadedPaths: number[] = [];
        const errors: string[] = [];
        
        for (const [pStr, part] of Object.entries(pathContents)) {
          const p = parseInt(pStr, 10);
          
          let cleanContent = String(part.content).trim();
          if (cleanContent.startsWith('%')) cleanContent = cleanContent.slice(1).trimStart();
          if (cleanContent.endsWith('%')) cleanContent = cleanContent.slice(0, -1).trimEnd();
          if (part.programName && !new RegExp(`^${part.programName}\\b`, 'i').test(cleanContent)) {
            cleanContent = `${part.programName}\n${cleanContent}`.trimEnd();
          }
          
          // Transfer format: Must start with LF and end with % (no leading %)
          const finalContent = `\n${cleanContent}\n%`;
          
          try {
            await this.transferClient.downloadProgram(this.ipAddress, p, finalContent, undefined, this.getChannelFileExtension(p));
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
        const pathNo = parseInt(targetPath.replace('path', ''), 10);
        let cleanContent = content.trim();
        if (cleanContent.startsWith('%')) cleanContent = cleanContent.slice(1).trimStart();
        if (cleanContent.endsWith('%')) cleanContent = cleanContent.slice(0, -1).trimEnd();
        const finalContent = `\n${cleanContent}\n%`;
        
        await this.transferClient.downloadProgram(this.ipAddress, pathNo, finalContent, undefined, this.getChannelFileExtension(pathNo));
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
