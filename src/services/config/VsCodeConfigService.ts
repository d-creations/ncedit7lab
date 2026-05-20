import { IConfigService, AppConfiguration } from './IConfigService';

export class VsCodeConfigService implements IConfigService {
  private config: AppConfiguration = {
    transferDefaultIp: '192.168.1.1',
    backendPort: 8000,
    backendBaseUrl: '',
    backendTimeout: 60000,
    themeMode: 'vscode',
    hostMode: 'vscode-editor',
    transferPlacement: 'external-panel',
    transferProtocol: 'focas',
    showDrawPanel: true,
    showTransferPanel: true,
  }; // Defaults
  private listeners: ((cfg: AppConfiguration) => void)[] = [];

  constructor() {
    // Check for direct window properties first
    if ((window as any).backendPort) {
      this.config.backendPort = (window as any).backendPort;
    }
    if ((window as any).transferDefaultIp) {
      this.config.transferDefaultIp = (window as any).transferDefaultIp;
    }
    
    // VS Code passes some settings initially via the webview HTML
    if ((window as any).vscodeConfig) {
      this.config = { ...this.config, ...(window as any).vscodeConfig };
    }

    // We can also listen for live config updates from the extension
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'UPDATE_CONFIG') {
        this.config = { ...this.config, ...message.config };
        this.notifyListeners();
      }
    });
  }

  async getConfig(): Promise<AppConfiguration> {
    return this.config;
  }

  async get<K extends keyof AppConfiguration>(key: K): Promise<AppConfiguration[K]> {
    return this.config[key];
  }

  onConfigChanged(callback: (newConfig: AppConfiguration) => void): void {
    this.listeners.push(callback);
  }

  private notifyListeners() {
    this.listeners.forEach(cb => cb(this.config));
  }
}
