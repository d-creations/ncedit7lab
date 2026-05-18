// BackendGateway for server communication

import type {
  PlotRequest,
  PlotResponse,
  ServerMachineListRequest,
  ServerMachineListResponse,
  FocasListResponse,
  FocasUploadResponse,
  FocasDownloadResponse,
} from '@core/types';
import { ServiceRegistry } from '@core/ServiceRegistry';
import { CONFIG_SERVICE_TOKEN } from '@core/ServiceTokens';
import { IConfigService } from './config/IConfigService';

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
    
    this.config = {
      baseUrl: `http://127.0.0.1:8000/cgiserver_import`,
      timeout: 30000,
      retries: 3,
      ...config,
    };
  }

  private async getPort(): Promise<number> {
    return await this.configService.get('backendPort');
  }

  private async getBaseUrl(): Promise<string> {
    const port = await this.getPort();
    return `http://127.0.0.1:${port}/cgiserver_import`;
  }

  // --- FOCAS API Methods ---
  
  async getFeatures(): Promise<import('@core/types').BackendFeatures> {
    const port = await this.getPort();
    const response = await fetch(`http://127.0.0.1:${port}/api/features`);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  private async getFocasUrl(path: string): Promise<string> {
    const port = await this.getPort();
    return `http://127.0.0.1:${port}/api/focas/${path}`;
  }

  async focasPing(ip: string): Promise<import('@core/types').FocasPingResponse> {
    const url = await this.getFocasUrl('ping');
    const response = await fetch(`${url}?ip_address=${ip}`);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  async focasConnect(ip: string, port: number = 8193): Promise<{status: string, message: string}> {
    const url = await this.getFocasUrl('connect');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip_address: ip, port, timeout: 10 })
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  async focasListPrograms(ip: string, pathNo: number, port: number = 8193): Promise<FocasListResponse> {
    const url = await this.getFocasUrl(`programs/${pathNo}`);
    const response = await fetch(`${url}?ip_address=${ip}&port=${port}`);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  async focasUpload(ip: string, pathNo: number, progNum: number, port: number = 8193): Promise<FocasUploadResponse> {
    const url = await this.getFocasUrl(`upload/${pathNo}/${progNum}`);
    const response = await fetch(`${url}?ip_address=${ip}&port=${port}`);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  async focasDownload(ip: string, pathNo: number, programText: string, port: number = 8193): Promise<FocasDownloadResponse> {
    const url = await this.getFocasUrl(`download/${pathNo}`);
    const response = await fetch(`${url}?ip_address=${ip}&port=${port}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ program_text: programText })
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  // --- CGI API Methods ---

  async listMachines(): Promise<ServerMachineListResponse> {
    const port = await this.getPort();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/machines`);
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

    for (let attempt = 0; attempt < this.config.retries; attempt++) {
      try {
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

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


