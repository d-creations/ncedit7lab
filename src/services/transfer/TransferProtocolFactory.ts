import { ITransferProtocol } from './ITransferProtocol';
import { FocasTransferProtocol } from './FocasTransferProtocol';
import { BackendGateway } from '../BackendGateway';

export class TransferProtocolFactory {
  static create(protocol: string, backend: BackendGateway, driverPath?: string): ITransferProtocol {
    switch (protocol.toLowerCase()) {
      case 'focas':
        return new FocasTransferProtocol(backend, driverPath);
      // case 'ftp': return new FtpTransferProtocol(backend);
      default:
        throw new Error(`Unsupported transfer protocol: ${protocol}`);
    }
  }
}
