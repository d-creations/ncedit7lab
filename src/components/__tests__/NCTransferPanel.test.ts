// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ServiceRegistry } from '@core/ServiceRegistry';
import {
  BACKEND_GATEWAY_TOKEN,
  FILE_MANAGER_SERVICE_TOKEN,
  CONFIG_SERVICE_TOKEN,
  MACHINE_SERVICE_TOKEN,
  STATE_SERVICE_TOKEN,
  EVENT_BUS_TOKEN,
} from '@core/ServiceTokens';
import { EventBus } from '../../services/EventBus';
import '../NCTransferPanel';
import { NCTransferPanel } from '../NCTransferPanel';

describe('NCTransferPanel USB import', () => {
  let mockBackend: any;
  let mockFileManager: any;
  let mockConfigService: any;
  let mockMachineService: any;
  let mockStateService: any;
  let eventBus: EventBus;
  const registry = ServiceRegistry.getInstance();

  beforeEach(async () => {
    await registry.disposeAll();
    eventBus = new EventBus();

    mockBackend = {
      transferConnect: vi.fn().mockResolvedValue({ status: 'success', message: 'Connected' }),
      transferListPrograms: vi.fn().mockResolvedValue({ status: 'success', programs: [] }),
      transferUpload: vi.fn().mockResolvedValue({ status: 'success', program_text: '' }),
      transferDownload: vi.fn().mockResolvedValue({ status: 'success', message: 'OK' }),
      transferPing: vi.fn().mockResolvedValue({ status: 'success', available: true }),
    };

    mockFileManager = {
      updateActiveProgramContent: vi.fn(),
    };

    mockConfigService = {
      getConfig: vi.fn().mockResolvedValue({
        transferProtocol: 'usb',
        transferDefaultIp: 'D:\\',
      }),
      onConfigChanged: vi.fn(),
    };

    mockMachineService = {
      getMachine: vi.fn().mockReturnValue(undefined),
    };

    mockStateService = {
      getState: vi.fn().mockReturnValue({ globalMachine: undefined }),
    };

    registry.register(BACKEND_GATEWAY_TOKEN, () => mockBackend);
    registry.register(FILE_MANAGER_SERVICE_TOKEN, () => mockFileManager);
    registry.register(CONFIG_SERVICE_TOKEN, () => mockConfigService);
    registry.register(MACHINE_SERVICE_TOKEN, () => mockMachineService);
    registry.register(STATE_SERVICE_TOKEN, () => mockStateService);
    registry.register(EVENT_BUS_TOKEN, () => eventBus);

    vi.stubGlobal('alert', vi.fn());
  });

  afterEach(async () => {
    document.body.replaceChildren();
    await registry.disposeAll();
  });

  it('lists and groups PA containers, P1-P4 split files, .M/.S pairs, and extensionless files', async () => {
    mockBackend.transferListPrograms.mockResolvedValue({
      status: 'success',
      programs: [
        { number: 1000, length: 120, comment: 'CONTAINER PA', file_extension: '.PA', is_multipath: true, channels: [1, 2, 3, 4] },
        { number: 2000, length: 50, comment: 'SPLIT P1', file_extension: '.P1' },
        { number: 2000, length: 50, comment: 'SPLIT P2', file_extension: '.P2' },
        { number: 2000, length: 50, comment: 'SPLIT P4', file_extension: '.P4' },
        { number: 3000, length: 40, comment: 'MAIN M', file_extension: '.M' },
        { number: 3000, length: 40, comment: 'SUB S', file_extension: '.S' },
        { number: 4000, length: 30, comment: 'NO EXT FILE', file_extension: '' },
      ],
    });

    const panel = document.createElement('nc-transfer-panel') as NCTransferPanel;
    document.body.appendChild(panel);
    await new Promise(resolve => setTimeout(resolve, 20));

    await (panel as any).handleConnect('D:\\');

    // USB scans once with pathNo = 0 and no extension filter
    expect(mockBackend.transferListPrograms).toHaveBeenCalledTimes(1);
    expect(mockBackend.transferListPrograms).toHaveBeenCalledWith('D:\\', 0, 0, 'usb', undefined, undefined);

    const programsMap = (panel as any).cncPrograms as Map<number, any>;
    expect(programsMap.get(1000)?.isPA).toBe(true);
    expect(programsMap.get(2000)?.isPA).toBe(true);
    expect(Object.keys(programsMap.get(2000)?.paths).map(Number)).toEqual([1, 2, 4]);
    expect(programsMap.get(3000)?.isPA).toBe(true);
    expect(programsMap.get(3000)?.paths[1]?.file_extension).toBe('.M');
    expect(programsMap.get(3000)?.paths[2]?.file_extension).toBe('.S');
    expect(programsMap.get(4000)?.isPA).toBe(false);
    expect(programsMap.get(4000)?.paths[1]?.file_extension).toBe('');

    const html = panel.shadowRoot?.innerHTML || '';
    expect(html).toContain('PA Program (P1, P2, P3, P4)');
    expect(html).toContain('PA Program (P1, P2, P4)');
    expect(html).toContain('P1 (no ext)');

    document.body.removeChild(panel);
  });

  it('splits a multipath container into individual channels when pulled', async () => {
    mockBackend.transferListPrograms.mockResolvedValue({
      status: 'success',
      programs: [
        { number: 1000, length: 120, comment: 'CONTAINER PA', file_extension: '.PA', is_multipath: true, channels: [1, 2, 3] },
      ],
    });
    mockBackend.transferUpload.mockResolvedValue({
      status: 'success',
      program_text: '%\n&F=/O1000/\n<O1000.P1>\n(CH1 CODE)\nG0 X10\nM99\n<O1000.P2>\n(CH2 CODE)\nG0 Z20\nM99\n<O1000.P3>\n(CH3 CODE)\nM30\n%\n',
    });

    const panel = document.createElement('nc-transfer-panel') as NCTransferPanel;
    document.body.appendChild(panel);
    await new Promise(resolve => setTimeout(resolve, 20));
    await (panel as any).handleConnect('D:\\');

    await (panel as any).handleUpload(1000, 'PA');

    expect(mockBackend.transferUpload).toHaveBeenCalledWith('D:\\', 0, 1000, 0, 'usb', undefined, ['.PA']);
    expect(mockFileManager.updateActiveProgramContent).toHaveBeenCalledWith('1', expect.stringContaining('(CH1 CODE)'));
    expect(mockFileManager.updateActiveProgramContent).toHaveBeenCalledWith('2', expect.stringContaining('(CH2 CODE)'));
    expect(mockFileManager.updateActiveProgramContent).toHaveBeenCalledWith('3', expect.stringContaining('(CH3 CODE)'));

    document.body.removeChild(panel);
  });
});
