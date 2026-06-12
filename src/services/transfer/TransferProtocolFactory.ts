import { ITransferProtocol } from './ITransferProtocol';
import { FocasTransferProtocol } from './FocasTransferProtocol';
import { BackendGateway } from '../BackendGateway';
import { UsbTransferProtocol } from './UsbTransferProtocol';

export class TransferProtocolFactory {
  static create(protocol: string, backend: BackendGateway, driverPath?: string): ITransferProtocol {
    switch (protocol.toLowerCase()) {
      case 'focas':
        return new FocasTransferProtocol(backend, driverPath);
      case 'usb':
        return new UsbTransferProtocol(backend);
      // case 'ftp': return new FtpTransferProtocol(backend);
      default:
        throw new Error(`Unsupported transfer protocol: ${protocol}`);
    }
  }
}
