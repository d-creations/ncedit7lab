import { describe, expect, it } from 'vitest';

import { BackendGateway } from '../BackendGateway';
import { TransferProtocolFactory } from './TransferProtocolFactory';
import { UsbTransferProtocol } from './UsbTransferProtocol';

describe('TransferProtocolFactory', () => {
  it('creates the USB transfer implementation', () => {
    const backend = {} as BackendGateway;

    const protocol = TransferProtocolFactory.create('usb', backend);

    expect(protocol).toBeInstanceOf(UsbTransferProtocol);
  });

  it('rejects unsupported protocols', () => {
    const backend = {} as BackendGateway;

    expect(() => TransferProtocolFactory.create('invalid', backend)).toThrow('Unsupported transfer protocol: invalid');
  });
});