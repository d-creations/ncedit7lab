import { IConfigService, AppConfiguration } from './IConfigService';

export class WebConfigService implements IConfigService {
  private config: AppConfiguration = {
    focasDefaultIp: '192.168.1.1',
    backendPort: 8000,
    backendBaseUrl: '',
    themeMode: 'light',
    hostMode: 'web',
    focasPlacement: 'side-panel',
    showDrawPanel: true,
    showFocasTransfer: false,
    backendTimeout: 10000,
  }; // Defaults
  private listeners: ((cfg: AppConfiguration) => void)[] = [];
  private loadPromise: Promise<AppConfiguration>;

  constructor() {
    this.loadPromise = this.fetchConfig();
  }

  private async fetchConfig(): Promise<AppConfiguration> {
    try {
      const response = await fetch('/config.json');
      if (response.ok) {
        const loaded = await response.json();
        this.config = { ...this.config, ...loaded };
        this.notifyListeners();
      }
    } catch (e) {
      console.warn('Could not fetch config.json, using defaults', e);
    }
    return this.config;
  }

  async getConfig(): Promise<AppConfiguration> {
    return this.loadPromise;
  }

  async get<K extends keyof AppConfiguration>(key: K): Promise<AppConfiguration[K]> {
    await this.loadPromise;
    return this.config[key];
  }

  onConfigChanged(callback: (newConfig: AppConfiguration) => void): void {
    this.listeners.push(callback);
  }

  private notifyListeners() {
    this.listeners.forEach(cb => cb(this.config));
  }
}
