export type HostMode = 'web' | 'vscode-editor' | 'vscode-panel' | 'vscode-templates';

export type TransferPlacement = 'side-panel' | 'bottom-panel' | 'external-panel' | 'disabled';
export type TransferProtocol = 'ftp' | 'focas' | 'smb' | 'usb' | 'none';
export type TemplatesPlacement = 'auto' | 'web-tab' | 'workbench-right' | 'workbench-left' | 'disabled';
export type TemplateStorageMode = 'local' | 'workspace' | 'host';

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
  seedDefaultTemplates: boolean;
  templateStorageMode?: TemplateStorageMode;
  templateSeedUrl?: string;
}

export interface IConfigService {
  /** Gets the full current configuration object */
  getConfig(): Promise<AppConfiguration>;
  
  /** Gets a specific configuration key */
  get<K extends keyof AppConfiguration>(key: K): Promise<AppConfiguration[K]>;

  /** Let listeners know if config loads or changes asynchronously */
  onConfigChanged(callback: (newConfig: AppConfiguration) => void): void;
}
