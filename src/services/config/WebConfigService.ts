import { IConfigService, AppConfiguration, DEFAULT_SIMULATION_CONFIG } from './IConfigService';

export class WebConfigService implements IConfigService {
  private config: AppConfiguration = {
    transferDefaultIp: '192.168.1.1',
    backendPort: 8000,
    backendBaseUrl: '',
    themeMode: 'light',
    hostMode: 'web',
    transferPlacement: 'side-panel',
    transferProtocol: 'none',
    showDrawPanel: true,
    showTransferPanel: false,
    showTemplatesPanel: true,
    templatesPlacement: 'web-tab',
    toolsPlacement: 'workbench-right',
    seedDefaultTemplates: true,
    templateStorageMode: 'local',
    templateSeedUrl: '/templates.json',
    backendTimeout: 10000,
    simulation: {
      gpuDefaultEnabled: DEFAULT_SIMULATION_CONFIG.gpuDefaultEnabled,
      gpuPitchMm: { ...DEFAULT_SIMULATION_CONFIG.gpuPitchMm },
      cpuResolutionMm: { ...DEFAULT_SIMULATION_CONFIG.cpuResolutionMm },
      stockMemoryMiB: DEFAULT_SIMULATION_CONFIG.stockMemoryMiB,
      gpuStockPixelBudget: { ...DEFAULT_SIMULATION_CONFIG.gpuStockPixelBudget },
    },
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
        const loaded = (await response.json()) as Partial<AppConfiguration>;
        this.config = {
          ...this.config,
          ...loaded,
          simulation: {
            ...this.config.simulation,
            ...loaded.simulation,
            gpuPitchMm: {
              ...DEFAULT_SIMULATION_CONFIG.gpuPitchMm,
              ...this.config.simulation?.gpuPitchMm,
              ...loaded.simulation?.gpuPitchMm,
            },
            cpuResolutionMm: {
              ...DEFAULT_SIMULATION_CONFIG.cpuResolutionMm,
              ...this.config.simulation?.cpuResolutionMm,
              ...loaded.simulation?.cpuResolutionMm,
            },
            gpuStockPixelBudget: {
              ...DEFAULT_SIMULATION_CONFIG.gpuStockPixelBudget,
              ...this.config.simulation?.gpuStockPixelBudget,
              ...loaded.simulation?.gpuStockPixelBudget,
            },
          },
        };
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
