import { ITransferProtocol } from './ITransferProtocol';
import { TransferProgram } from '@core/types';
import { BackendGateway } from '../BackendGateway';

export class FocasTransferProtocol implements ITransferProtocol {
  constructor(private backend: BackendGateway, private driverPath?: string) {}

  async ping(ip: string): Promise<boolean> {
    const res = await this.backend.transferPing(ip, 'focas', this.driverPath);
    return res.available;
  }

  async connect(ip: string, port: number = 8193): Promise<void> {
    await this.backend.transferConnect(ip, port, 'focas', this.driverPath);
  }

  async listPrograms(ip: string, pathNo: number, port: number = 8193): Promise<TransferProgram[]> {
    const res = await this.backend.transferListPrograms(ip, pathNo, port, 'focas', this.driverPath);
    return res.programs || [];
  }

  async uploadProgram(ip: string, pathNo: number, progNum: number, port: number = 8193): Promise<string> {
    const res = await this.backend.transferUpload(ip, pathNo, progNum, port, 'focas', this.driverPath);
    return res.program_text;
  }

  async downloadProgram(ip: string, pathNo: number, programText: string, port: number = 8193): Promise<void> {
    await this.backend.transferDownload(ip, pathNo, programText, port, 'focas', this.driverPath);
  }
}
