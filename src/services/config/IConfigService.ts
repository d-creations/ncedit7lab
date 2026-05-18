export type HostMode = 'web' | 'vscode-editor' | 'vscode-panel';

export type FocasPlacement = 'side-panel' | 'bottom-panel' | 'external-panel' | 'disabled';

export interface AppConfiguration {
  focasDefaultIp: string;
  backendPort: number;
  backendBaseUrl: string;
  backendTimeout: number;
  themeMode: 'vscode' | 'one-dark' | 'light';
  hostMode: HostMode;
  focasPlacement: FocasPlacement;
  showDrawPanel: boolean;
  showFocasTransfer: boolean;
}

export interface IConfigService {
  /** Gets the full current configuration object */
  getConfig(): Promise<AppConfiguration>;
  
  /** Gets a specific configuration key */
  get<K extends keyof AppConfiguration>(key: K): Promise<AppConfiguration[K]>;

  /** Let listeners know if config loads or changes asynchronously */
  onConfigChanged(callback: (newConfig: AppConfiguration) => void): void;
}
