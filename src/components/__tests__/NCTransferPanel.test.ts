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

  it('lists every USB file as its own separate item with its exact extension', async () => {
    mockBackend.transferListPrograms.mockResolvedValue({
      status: 'success',
      programs: [
        { number: 1000, length: 120, comment: 'CONTAINER PA', file_extension: '.PA', is_multipath: true, channels: [1, 2, 3, 4] },
        { number: 1000, length: 50, comment: 'SAME NUM NC', file_extension: '.NC' },
        { number: 2000, length: 50, comment: 'SPLIT P1', file_extension: '.P1' },
        { number: 2000, length: 50, comment: 'SPLIT P2', file_extension: '.p-2' },
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

    const programsMap = (panel as any).cncPrograms as Map<number | string, any>;
    expect(programsMap.get('1000:.pa')?.isPA).toBe(true);
    expect(programsMap.get('1000:.nc')?.isPA).toBe(false);
    expect(programsMap.get('2000:.p1')?.paths[1]?.file_extension).toBe('.P1');
    expect(programsMap.get('2000:.p-2')?.paths[2]?.file_extension).toBe('.p-2');
    expect(programsMap.get('2000:.p4')?.paths[4]?.file_extension).toBe('.P4');
    expect(programsMap.get('3000:.m')?.paths[1]?.file_extension).toBe('.M');
    expect(programsMap.get('3000:.s')?.paths[2]?.file_extension).toBe('.S');
    expect(programsMap.get('4000:')?.paths[1]?.file_extension).toBe('');

    const html = panel.shadowRoot?.innerHTML || '';
    expect(html).toContain('O1000.PA');
    expect(html).toContain('O1000.NC');
    expect(html).toContain('PA Program (P1, P2, P3, P4) [.PA]');
    expect(html).toContain('P2 (.p-2)');
    expect(html).toContain('P1 (no ext)');

    document.body.removeChild(panel);
  });

  it('allows selecting export extensions (.M, .N, .NC, .cnc, .PA, no ext) when pushing files', async () => {
    mockMachineService.getMachine.mockReturnValue({
      fileExtensions: {
        multifile: true,
        main: ['.M'],
        subprogram: [],
        channels: {
          '1': ['.', ''],
          '2': ['.p-2', '.P-2'],
        },
      },
    });
    mockStateService.getState.mockReturnValue({ globalMachine: 'SR-20RIV-TYPE-A' });

    const panel = document.createElement('nc-transfer-panel') as NCTransferPanel;
    document.body.appendChild(panel);
    await new Promise(resolve => setTimeout(resolve, 20));
    await (panel as any).handleConnect('D:\\');

    // Default PA extension should always be .PA (even if main has .M), and '.' in channels['1'] normalizes to ''
    expect((panel as any).getPAFileExtension()).toBe('.PA');
    expect((panel as any).getChannelFileExtension(1)).toBe('');
    expect((panel as any).getChannelFileExtension(2)).toBe('.p-2');

    const paOptions = (panel as any).getExportExtensionOptions('PA');
    expect(paOptions).toEqual(expect.arrayContaining(['.PA', '.M', '.NC', '.cnc', '.N', '']));

    // Select .cnc for Channel 1 and push
    const p1Select = panel.shadowRoot?.querySelector('select[data-ext-target="1"]') as HTMLSelectElement;
    expect(p1Select).toBeTruthy();
    p1Select.value = '.cnc';
    p1Select.dispatchEvent(new Event('change'));

    await (panel as any).uploadDroppedFile('O1234\nG0 X10\nM30', '1');
    expect(mockBackend.transferDownload).toHaveBeenCalledWith(
      'D:\\',
      1,
      '\nO1234\nG0 X10\nM30\n%',
      0,
      'usb',
      undefined,
      '.cnc'
    );

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

  it('formats multi-channel PA exports with %, &F=/OXXXX/, and <OXXXX.Pn> whether % is present or not', async () => {
    const panel = document.createElement('nc-transfer-panel') as NCTransferPanel;
    document.body.appendChild(panel);
    await new Promise(resolve => setTimeout(resolve, 20));
    await (panel as any).handleConnect('D:\\');

    // Case 1: Input without outer % or &F= header, and with inner % and O1612 lines in channels
    const unformattedPA = [
      '<O1612.P1>',
      '%',
      'O1612',
      '(SCP TRAINING SUS304 D=20.0)',
      '(PATH 1)',
      'M99P99',
      '%',
      '',
      '<O1612.P2>',
      'O1612',
      '(SCP TRAINING SUS304 D=20.0)',
      'G130',
      'M99P99',
    ].join('\n');

    await (panel as any).uploadDroppedFile(unformattedPA, 'PA');

    const expectedPA = [
      '%',
      '&F=/O1612/',
      '<O1612.P1>',
      '(SCP TRAINING SUS304 D=20.0)',
      '(PATH 1)',
      'M99P99',
      '<O1612.P2>',
      '(SCP TRAINING SUS304 D=20.0)',
      'G130',
      'M99P99',
      '%',
    ].join('\n');

    expect(mockBackend.transferDownload).toHaveBeenCalledWith(
      'D:\\',
      0,
      expectedPA,
      0,
      'usb',
      undefined,
      '.PA'
    );

    mockBackend.transferDownload.mockClear();

    // Case 2: Input already containing % and &F=/O1612(COMMENT)/
    const withPercentPA = `%\n&F=/O1612(SCP TRAINING)/\n<O1612.P1>\n(SCP TRAINING SUS304 D=20.0)\n(PATH 1)\nM99P99\n<O1612.P2>\n(SCP TRAINING SUS304 D=20.0)\nG130\nM99P99\n%`;
    await (panel as any).uploadDroppedFile(withPercentPA, 'PA');

    expect(mockBackend.transferDownload).toHaveBeenCalledWith(
      'D:\\',
      0,
      expectedPA,
      0,
      'usb',
      undefined,
      '.PA'
    );

    document.body.removeChild(panel);
  });

  it('combines split USB P1/P2 files into standard PA format without comment in &F=/OXXXX/', async () => {
    const postMessageSpy = vi.fn();
    (window as any).vscodeApi = { postMessage: postMessageSpy };

    mockBackend.transferListPrograms.mockResolvedValue({
      status: 'success',
      programs: [
        { number: 1612, length: 50, comment: 'SCP TRAINING SUS304 D=20.0', file_extension: '.P1' },
        { number: 1612, length: 50, comment: 'SCP TRAINING SUS304 D=20.0', file_extension: '.P2' },
      ],
    });
    mockBackend.transferUpload
      .mockResolvedValueOnce({
        status: 'success',
        program_text: '%\nO1612\n(SCP TRAINING SUS304 D=20.0)\n(PATH 1)\nM99P99\n%\n',
      })
      .mockResolvedValueOnce({
        status: 'success',
        program_text: 'O1612\n(SCP TRAINING SUS304 D=20.0)\nG130\nM99P99\n',
      });

    const panel = document.createElement('nc-transfer-panel') as NCTransferPanel;
    document.body.appendChild(panel);
    await new Promise(resolve => setTimeout(resolve, 20));
    await (panel as any).handleConnect('D:\\');

    await (panel as any).handleUpload(1612, 'PA');

    expect(postMessageSpy).toHaveBeenCalledWith({
      type: 'SAVE_TRANSFER_FILE',
      fileName: 'O1612.PA',
      content: [
        '%',
        '&F=/O1612/',
        '<O1612.P1>',
        '(SCP TRAINING SUS304 D=20.0)',
        '(PATH 1)',
        'M99P99',
        '<O1612.P2>',
        '(SCP TRAINING SUS304 D=20.0)',
        'G130',
        'M99P99',
        '%',
        '',
      ].join('\n'),
    });

    delete (window as any).vscodeApi;
    document.body.removeChild(panel);
  });
});
