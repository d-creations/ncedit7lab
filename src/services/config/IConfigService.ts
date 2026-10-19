export type HostMode = 'web' | 'vscode-editor' | 'vscode-panel' | 'vscode-templates' | 'vscode-tools';

export type TransferPlacement = 'side-panel' | 'bottom-panel' | 'external-panel' | 'disabled';
export type TransferProtocol = 'ftp' | 'focas' | 'smb' | 'usb' | 'none';
export type TemplatesPlacement = 'auto' | 'web-tab' | 'workbench-right' | 'workbench-left' | 'disabled';
export type ToolsPlacement = 'auto' | 'workbench-right' | 'workbench-left' | 'disabled';
export type TemplateStorageMode = 'local' | 'workspace' | 'host';

export interface SimulationPixelBudgetConfig {
  min: number;
  max: number;
  default: number;
  nativeSharpness?: boolean;
}

export interface SimulationConfiguration {
  gpuDefaultEnabled: boolean;
  gpuPitchMm: { min: number; max: number; default: number };
  cpuResolutionMm: { min: number; max: number; default: number };
  stockMemoryMiB: number;
  gpuStockPixelBudget: SimulationPixelBudgetConfig;
}

export interface AppConfiguration {
  transferDefaultIp: string;
  backendPort: number;
  backendBaseUrl: string;
  backendTimeout: number;
  themeMode: 'vscode' | 'one-dark' | 'light';
  hostMode: HostMode;
  transferPlacement: TransferPlacement;
  transferProtocol: TransferProtocol;
  transferDriverPath?: string;
  showDrawPanel: boolean;
  showTransferPanel: boolean;
  showTemplatesPanel: boolean;
  templatesPlacement: TemplatesPlacement;
  toolsPlacement?: ToolsPlacement;
  seedDefaultTemplates: boolean;
  templateStorageMode?: TemplateStorageMode;
  templateSeedUrl?: string;
  simulation?: Partial<SimulationConfiguration>;
}

export const DEFAULT_SIMULATION_CONFIG: SimulationConfiguration = {
  gpuDefaultEnabled: true,
  gpuPitchMm: { min: 0.001, max: 5, default: 0.02 },
  cpuResolutionMm: { min: 0.05, max: 5, default: 0.05 },
  stockMemoryMiB: 256,
  gpuStockPixelBudget: {
    min: 250_000,
    max: 1_500_000,
    default: 800_000,
    nativeSharpness: false,
  },
};

export interface IConfigService {
  /** Gets the full current configuration object */
  getConfig(): Promise<AppConfiguration>;
  
  /** Gets a specific configuration key */
  get<K extends keyof AppConfiguration>(key: K): Promise<AppConfiguration[K]>;

  /** Let listeners know if config loads or changes asynchronously */
  onConfigChanged(callback: (newConfig: AppConfiguration) => void): void;
}
