import type { IConfigService } from './config/IConfigService';

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function getWindowBackendBaseUrl(): string {
  const value = (window as Window & { backendBaseUrl?: unknown }).backendBaseUrl;
  return typeof value === 'string' && value.trim() ? normalizeBaseUrl(value) : '';
}

function getWindowBackendPort(): number | undefined {
  const value = (window as Window & { backendPort?: unknown }).backendPort;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function localhostOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function resolveBackendOriginSync(fallbackPort?: number): string {
  const explicitBaseUrl = getWindowBackendBaseUrl();
  if (explicitBaseUrl) {
    return explicitBaseUrl;
  }

  const port = getWindowBackendPort() ?? fallbackPort;
  if (port) {
    return localhostOrigin(port);
  }

  return '';
}

export async function resolveBackendOrigin(configService?: IConfigService): Promise<string> {
  const windowOrigin = resolveBackendOriginSync();
  if (windowOrigin) {
    return windowOrigin;
  }

  if (!configService) {
    return '';
  }

  const configuredBaseUrl = normalizeBaseUrl(await configService.get('backendBaseUrl'));
  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }

  const hostMode = await configService.get('hostMode');
  if (hostMode === 'web') {
    return '';
  }

  const port = await configService.get('backendPort');
  return port ? localhostOrigin(port) : '';
}

export function buildBackendUrlSync(path: string, fallbackPort?: number): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${resolveBackendOriginSync(fallbackPort)}${normalizedPath}`;
}

export async function buildBackendUrl(path: string, configService?: IConfigService): Promise<string> {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${await resolveBackendOrigin(configService)}${normalizedPath}`;
}