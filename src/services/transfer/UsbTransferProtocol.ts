import { TransferProgram } from '@core/types';
import { BackendGateway } from '../BackendGateway';
import { ITransferProtocol } from './ITransferProtocol';

export class UsbTransferProtocol implements ITransferProtocol {
  constructor(private backend: BackendGateway) {}

  async ping(rootPath: string): Promise<boolean> {
    const res = await this.backend.transferPing(rootPath, 'usb');
    return res.available;
  }

  async connect(rootPath: string): Promise<void> {
    await this.backend.transferConnect(rootPath, 0, 'usb');
  }

  async listPrograms(rootPath: string, pathNo: number): Promise<TransferProgram[]> {
    const res = await this.backend.transferListPrograms(rootPath, pathNo, 0, 'usb');
    return res.programs || [];
  }

  async uploadProgram(rootPath: string, pathNo: number, progNum: number): Promise<string> {
    const res = await this.backend.transferUpload(rootPath, pathNo, progNum, 0, 'usb');
    return res.program_text;
  }

  async downloadProgram(rootPath: string, pathNo: number, programText: string): Promise<void> {
    await this.backend.transferDownload(rootPath, pathNo, programText, 0, 'usb');
  }
}