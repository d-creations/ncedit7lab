// BackendGateway for server communication

import type {
  PlotRequest,
  PlotResponse,
  ServerMachineListRequest,
  ServerMachineListResponse,
  TransferListResponse,
  TransferUploadResponse,
  TransferDownloadResponse,
} from '@core/types';
import { ServiceRegistry } from '@core/ServiceRegistry';
import { CONFIG_SERVICE_TOKEN } from '@core/ServiceTokens';
import { IConfigService } from './config/IConfigService';
import { buildBackendUrl } from './BackendUrl';

// Simple API Key for basic security
const API_KEY = 'nc-edit7-secret-key';

export interface BackendConfig {
  baseUrl: string;
  timeout: number;
  retries: number;
}

export class BackendGateway {
  private config: BackendConfig;
  private abortControllers = new Map<string, AbortController>();
  private configService: IConfigService;

  constructor(config?: Partial<BackendConfig>) {
    this.configService = ServiceRegistry.getInstance().get(CONFIG_SERVICE_TOKEN);
    
    // Default to relative paths so packaged/deployed frontend talks to same origin.
    // Preserve legacy local-dev behavior when `window.backendPort`/backendPort config is provided.
    this.config = {
      baseUrl: "/cgiserver_import",
      timeout: 30000,
      retries: 3,
      ...config,
    };
  }

  private async getBaseUrl(): Promise<string> {
    return buildBackendUrl('/cgiserver_import', this.configService);
  }

  // --- Transfer API Methods ---
  
  async getFeatures(): Promise<import('@core/types').BackendFeatures> {
    const response = await fetch(await buildBackendUrl('/api/features', this.configService));
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  private async getTransferUrl(path: string): Promise<string> {
    return buildBackendUrl(`/api/transfer/${path}`, this.configService);
  }

  private buildQuery(params: Record<string, any>): string {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        q.append(key, String(value));
      }
    }
    return q.toString();
  }

  async transferPing(ip: string): Promise<import('@core/types').TransferPingResponse> {
    const url = await this.getTransferUrl('ping');
    const response = await fetch(`${url}?ip_address=${ip}`);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  async transferConnect(ip: string, port: number, protocol: string, driverPath?: string): Promise<{status: string, message: string}> {
    const url = await this.getTransferUrl('connect');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip_address: ip, port, timeout: 10, protocol, driver_path: driverPath })
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  async transferListPrograms(ip: string, pathNo: number, port: number, protocol: string, driverPath?: string): Promise<TransferListResponse> {
    const url = await this.getTransferUrl(`programs/${pathNo}`);
    const qs = this.buildQuery({ ip_address: ip, port, protocol, driver_path: driverPath });
    const response = await fetch(`${url}?${qs}`);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  async transferUpload(ip: string, pathNo: number, progNum: number, port: number, protocol: string, driverPath?: string): Promise<TransferUploadResponse> {
    const url = await this.getTransferUrl(`upload/${pathNo}/${progNum}`);
    const qs = this.buildQuery({ ip_address: ip, port, protocol, driver_path: driverPath });
    const response = await fetch(`${url}?${qs}`);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  async transferDownload(ip: string, pathNo: number, programText: string, port: number, protocol: string, driverPath?: string): Promise<TransferDownloadResponse> {
    const url = await this.getTransferUrl(`download/${pathNo}`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip_address: ip, port, program_text: programText, protocol, driver_path: driverPath })
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  // --- CGI API Methods ---

  async listMachines(): Promise<ServerMachineListResponse> {
    try {
      const response = await fetch(await buildBackendUrl('/api/machines', this.configService));
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return response.json();
    } catch (error) {
      console.warn('Direct machines endpoint unavailable, falling back to CGI bridge', error);

      const request: ServerMachineListRequest = {
        action: 'list_machines',
      };

      return this.post<ServerMachineListResponse>(request);
    }
  }

  async requestPlot(plotRequest: PlotRequest): Promise<PlotResponse> {
    return this.post<PlotResponse>(plotRequest);
  }

  async post<T>(data: unknown, requestId?: string): Promise<T> {
    const controller = new AbortController();
    if (requestId) {
      this.abortControllers.set(requestId, controller);
    }

    let lastError: Error | undefined;

    const dynamicTimeout = await this.configService.get('backendTimeout').catch(() => undefined) ?? this.config.timeout;

    for (let attempt = 0; attempt < this.config.retries; attempt++) {
      try {
        const timeoutId = setTimeout(() => controller.abort(), dynamicTimeout);

        const baseUrl = await this.getBaseUrl();
        const response = await fetch(baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': API_KEY,
          },
          body: JSON.stringify(data),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();

        if (requestId) {
          this.abortControllers.delete(requestId);
        }

        return result as T;
      } catch (error) {
        lastError = error as Error;

        if (error instanceof Error && error.name === 'AbortError') {
          // Convert timeout to more descriptive error
          if (requestId) {
            this.abortControllers.delete(requestId);
          }
          throw new Error('Request timeout - server may be offline or unreachable');
        }

        // Check for network errors
        if (
          error instanceof TypeError &&
          (error.message.includes('fetch') || error.message.includes('NetworkError'))
        ) {
          console.warn(`Network error on attempt ${attempt + 1}: Server may be offline`);
        }

        // Wait before retry using bit shifting for efficiency
        if (attempt < this.config.retries - 1) {
          await this.sleep((1 << attempt) * 1000);
        }
      }
    }

    if (requestId) {
      this.abortControllers.delete(requestId);
    }

    // Throw a more descriptive error
    if (lastError instanceof TypeError) {
      throw new Error('Server is offline or unreachable. Please check your connection.');
    }

    throw lastError || new Error('Request failed after multiple retries');
  }

  cancel(requestId: string): void {
    const controller = this.abortControllers.get(requestId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(requestId);
    }
  }

  cancelAll(): void {
    this.abortControllers.forEach((controller) => controller.abort());
    this.abortControllers.clear();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}


