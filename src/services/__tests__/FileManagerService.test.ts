import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileManagerService } from '../FileManagerService';
import { EventBus, EVENT_NAMES } from '../EventBus';
import { StateService } from '../StateService';
import { SimulationCommentCodec } from '../tools/SimulationCommentCodec';
import type { MachineProfile } from '@core/types';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    clear: () => {
      store = {};
    },
    removeItem: (key: string) => {
      delete store[key];
    }
  };
})();

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock
});

describe('FileManagerService', () => {
  let service: FileManagerService;
  let mockEventBus: EventBus;
  let mockState: { activeFileId: string | null; globalMachine: undefined; activeProgramIds: Map<string, string> };
  let mockStateService: {
    getState: ReturnType<typeof vi.fn>;
    setActiveFileId: ReturnType<typeof vi.fn>;
    getActiveProgramId: ReturnType<typeof vi.fn>;
    setActiveProgramId: ReturnType<typeof vi.fn>;
    activateChannel: ReturnType<typeof vi.fn>;
    deactivateChannel: ReturnType<typeof vi.fn>;
    setGlobalMachine: ReturnType<typeof vi.fn>;
    getWorkbenchSelectedChannel: ReturnType<typeof vi.fn>;
    restoreProgramMachine: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    // Clear localStorage before creating service
    localStorage.clear();
    
    mockEventBus = new EventBus();
    // Mock the publish method
    mockEventBus.publish = vi.fn();
    mockState = {
      activeFileId: null,
      globalMachine: undefined,
      activeProgramIds: new Map(),
    };
    mockStateService = {
      getState: vi.fn(() => mockState),
      setActiveFileId: vi.fn((fileId: string | null) => {
        mockState.activeFileId = fileId;
      }),
      getActiveProgramId: vi.fn((channelId: string) => mockState.activeProgramIds.get(channelId)),
      setActiveProgramId: vi.fn((channelId: string, programId: string) => {
        mockState.activeProgramIds.set(channelId, programId);
      }),
      activateChannel: vi.fn(),
      deactivateChannel: vi.fn(),
      setGlobalMachine: vi.fn(),
      getWorkbenchSelectedChannel: vi.fn(() => '1'),
      restoreProgramMachine: vi.fn(),
    };
    service = new FileManagerService(mockEventBus, mockStateService as any, false);
  });

  describe('program machine restoration', () => {
    const machines: MachineProfile[] = ['FIRST', 'SAVED'].map(machineName => ({
      machineName, controlType: 'FANUC', axes: [], feedLimits: { min: 0, max: 1 },
      defaultTools: [], availableChannels: 3,
    }));
    const codec = new SimulationCommentCodec();
    const syntax = { kind: 'line', prefix: ';' } as const;

    beforeEach(() => localStorage.clear());

    it('waits for the backend list before restoring a program opened during startup', async () => {
      const bus = new EventBus();
      const state = new StateService(bus, false);
      const manager = new FileManagerService(bus, state, false);
      const content = `G1 X1\n${codec.encodeSetup({ machineName: 'SAVED' }, syntax)}`;
      await manager.openFile(content, 'saved.nc', { parseMultiChannel: false });
      expect(state.getState().globalMachine).toBeUndefined();
      state.setMachines(machines);
      expect(state.getState().globalMachine).toBe('SAVED');
      expect(manager.getActiveProgram('1')?.content).toBe(content);
    });

    it('restores the active program after reloading browser storage, not the stale persisted machine list', async () => {
      const bus = new EventBus();
      const state = new StateService(bus);
      const manager = new FileManagerService(bus, state);
      await manager.openFile(codec.encodeSetup({ machineName: 'SAVED' }, syntax), 'saved.nc', { parseMultiChannel: false });
      state.setMachines([machines[0]]);
      expect(state.getState().globalMachine).toBe('FIRST');

      const reloadedBus = new EventBus();
      const reloadedState = new StateService(reloadedBus);
      new FileManagerService(reloadedBus, reloadedState);
      expect(reloadedState.getState().globalMachine).toBe('FIRST');
      reloadedState.setMachines(machines);
      expect(reloadedState.getState().globalMachine).toBe('SAVED');
    });

    it('selects the first machine and emits a notification if the saved machine is unavailable', async () => {
      const bus = new EventBus();
      const state = new StateService(bus, false);
      const manager = new FileManagerService(bus, state, false);
      const errors = vi.fn();
      bus.subscribe(EVENT_NAMES.ERROR_OCCURRED, errors);
      state.setMachines(machines);
      state.setGlobalMachine('SAVED');
      const content = codec.encodeSetup({ machineName: 'MISSING' }, syntax);
      await manager.openFile(content, 'missing.nc', { parseMultiChannel: false });
      expect(state.getState().globalMachine).toBe('FIRST');
      expect(errors).toHaveBeenCalledWith({ message: expect.stringContaining('MISSING') });
      expect(manager.getActiveProgram('1')?.content).toBe(content);
    });

    it('restores the setup from edited program text when switching files or loaded programs', async () => {
      const bus = new EventBus();
      const state = new StateService(bus, false);
      const manager = new FileManagerService(bus, state, false);
      state.setMachines(machines);
      const first = await manager.openFile('G1 X1', 'first.nc', { parseMultiChannel: false });
      const firstProgram = manager.getActiveProgram('1')!;
      manager.updateActiveProgramContent('1', codec.encodeSetup({ machineName: 'SAVED' }, syntax));
      await manager.openFile(codec.encodeSetup({ machineName: 'FIRST' }, syntax), 'second.nc', { parseMultiChannel: false });
      expect(state.getState().globalMachine).toBe('FIRST');
      manager.selectFile(first.id);
      expect(state.getState().globalMachine).toBe('SAVED');
      state.setGlobalMachine('FIRST');
      manager.setActiveProgram('1', firstProgram.id);
      expect(state.getState().globalMachine).toBe('SAVED');
    });

    it.each([
      { kind: 'line', prefix: ';' } as const,
      { kind: 'line', prefix: '//' } as const,
      { kind: 'block', open: '(', close: ')' } as const,
    ])('reads the saved comment envelope independently of the current machine: %o', async (commentSyntax) => {
      const state = new StateService(new EventBus(), false);
      const manager = new FileManagerService(new EventBus(), state, false);
      state.setMachines(machines);
      state.setGlobalMachine('FIRST');
      await manager.openFile(codec.encodeSetup({ machineName: 'SAVED' }, commentSyntax), 'saved.nc', { parseMultiChannel: false });
      expect(state.getState().globalMachine).toBe('SAVED');
    });

    it('leaves the current machine unchanged for plain programs and rejects conflicting setups', () => {
      const bus = new EventBus();
      const state = new StateService(bus, false);
      const errors = vi.fn();
      bus.subscribe(EVENT_NAMES.ERROR_OCCURRED, errors);
      state.setMachines(machines);
      state.setGlobalMachine('SAVED');
      state.restoreProgramMachine('G1 X1');
      expect(state.getState().globalMachine).toBe('SAVED');
      const block = codec.encodeSetup({ machineName: 'FIRST' }, syntax);
      state.restoreProgramMachine(`${block}\n${block}`);
      expect(state.getState().globalMachine).toBe('SAVED');
      expect(errors).toHaveBeenCalledOnce();
    });

    it('does not restore a stale pending machine after a blank program replaces it during startup', async () => {
      const bus = new EventBus();
      const state = new StateService(bus, false);
      const manager = new FileManagerService(bus, state, false);
      await manager.openFile(codec.encodeSetup({ machineName: 'SAVED' }, syntax), 'saved.nc', { parseMultiChannel: false });
      manager.newFile();
      state.setMachines(machines);
      expect(state.getState().globalMachine).toBeUndefined();
    });

    it('retains a setup from an earlier channel when later channels have no setup', async () => {
      const bus = new EventBus();
      const state = new StateService(bus, false);
      const manager = new FileManagerService(bus, state, false);
      await manager.openFile(`<CH1.MPF>\n${codec.encodeSetup({ machineName: 'SAVED' }, syntax)}\n<CH2.MPF>\nG1 X2`,
        'multi.nc', { parseMultiChannel: true });
      state.setMachines(machines);
      expect(state.getState().globalMachine).toBe('SAVED');
    });
  });

  describe('openFile', () => {
    it('should open a single channel file correctly', async () => {
      const content = 'G0 X0 Y0';
      const name = 'test.mpf';
      
      const file = await service.openFile(content, name, { parseMultiChannel: false });
      
      expect(file.name).toBe(name);
      expect(file.content).toBe(content);
      expect(file.channels).toHaveLength(1);
      expect(file.channels[0]).toBe(content);
      expect(file.isMultiChannel).toBe(false);
      expect(mockEventBus.publish).toHaveBeenCalledWith('file:opened', file);
      expect(mockEventBus.publish).toHaveBeenCalledWith('file:active_changed', file);
    });

    it('should parse multi-channel files correctly', async () => {
      // Simulating the format expected by the parser
      // The parser splits by "<", then takes the header (before .) as name, and content after >
      const content = `
<HEAD1.
G0 X0
>
<HEAD2.
G0 Y0
>
`;
      const name = 'multi.mpf';
      
      const file = await service.openFile(content, name, { parseMultiChannel: true });
      
      expect(file.isMultiChannel).toBe(true);
      expect(file.channels.length).toBeGreaterThan(0);
      // Based on the logic: 
      // split("<") -> ["", "HEAD1.\nG0 X0\n>\n", "HEAD2.\nG0 Y0\n>\n"]
      // shift() removes empty first
      // Loop 1: "HEAD1.\nG0 X0\n>\n" -> name "HEAD1", content "G0 X0\n>\n".replace(/.*>/, "") -> "\n" (if regex matches greedy)
      // Let's check the regex in the service: .replace(/.*>/, "")
      // If content is "HEAD1.\nG0 X0\n>\n", the > is at the end. 
      // Wait, the user's logic was: programs[programNr].replace(/.*>/, "")
      // If the file structure is <NAME.EXT\nCONTENT>, then split gives NAME.EXT\nCONTENT>
      // It seems the user's logic expects the > to be somewhere.
      
      // Let's try to match the user's logic exactly with a test case that fits their likely format.
      // Usually multi-channel files in this context might look like:
      // <CHANNEL1.MPF>
      // M30
      // <CHANNEL2.MPF>
      // M30
      
      const multiContent = `<CHANNEL1.MPF>
G0 X10
<CHANNEL2.MPF>
G0 Y20`;

      const file2 = await service.openFile(multiContent, 'multi.mpf', { parseMultiChannel: true });
      expect(file2.channels).toHaveLength(2);
      expect(file2.channels[0]).toContain('G0 X10');
      expect(file2.channels[1]).toContain('G0 Y20');
    });

    it('should handle specific channel selection (channel 2)', async () => {
      const content = 'M30';
      const file = await service.openFile(content, 'test.mpf', { parseMultiChannel: false, channel: 2 });
      
      expect(file.channels).toHaveLength(2);
      expect(file.channels[0]).toBe('');
      expect(file.channels[1]).toBe(content);
    });

    it('should only sync channel activation for explicit multi-channel opens', async () => {
      await service.openFile('G0 X0', 'single.mpf', { parseMultiChannel: false });

      expect(mockStateService.activateChannel).not.toHaveBeenCalled();
      expect(mockStateService.deactivateChannel).not.toHaveBeenCalled();

      await service.openFile('<CHANNEL1.MPF>\nG0 X10\n<CHANNEL2.MPF>\nG0 Y20', 'multi.mpf', { parseMultiChannel: true });

      expect(mockStateService.activateChannel).toHaveBeenCalledWith('1');
      expect(mockStateService.activateChannel).toHaveBeenCalledWith('2');
      expect(mockStateService.deactivateChannel).toHaveBeenCalledWith('3');
    });

    it('should activate the selected target channel when opening a single channel into channel 2', async () => {
      await service.openFile('M30', 'channel2.mpf', { parseMultiChannel: false, channel: 2 });

      expect(mockStateService.activateChannel).toHaveBeenCalledWith('2');
      expect(mockStateService.deactivateChannel).toHaveBeenCalledWith('1');
      expect(mockStateService.deactivateChannel).toHaveBeenCalledWith('3');
    });
  });

  describe('newFile', () => {
    it('creates an active, independently editable program in every channel', () => {
      service.newFile();

      const file = service.getActiveFile();
      expect(file).toMatchObject({
        name: 'Untitled.mpf',
        content: '',
        channels: ['', '', ''],
        isMultiChannel: true,
      });
      const programs = ['1', '2', '3'].map(channelId => service.getActiveProgram(channelId));
      expect(new Set(programs.map(program => program?.id)).size).toBe(3);
      programs.forEach((program, index) => {
        const channelId = String(index + 1);
        expect(program).toMatchObject({
          channelId,
          sourceFileId: file?.id,
          name: `Untitled.mpf (CH${channelId})`,
          content: '',
        });
        expect(service.getPrograms(channelId)).toEqual([program]);
        expect(mockEventBus.publish).toHaveBeenCalledWith('program:active_changed', { channelId, program });
        service.updateActiveProgramContent(channelId, `G1 X${index + 1}`);
      });
      expect(programs.map(program => program?.content)).toEqual(['G1 X1', 'G1 X2', 'G1 X3']);
      expect(mockStateService.activateChannel).not.toHaveBeenCalled();
      expect(mockStateService.deactivateChannel).not.toHaveBeenCalled();
    });

    it('switches every channel to the new file without discarding previous programs', () => {
      service.newFile('first.mpf');
      const previous = ['1', '2', '3'].map(channelId => service.getActiveProgram(channelId));
      service.updateActiveProgramContent('2', 'G1 X20');
      service.newFile('second.mpf');

      ['1', '2', '3'].forEach((channelId, index) => {
        expect(service.getActiveProgram(channelId)?.id).not.toBe(previous[index]?.id);
        expect(service.getActiveProgram(channelId)?.content).toBe('');
        expect(service.getPrograms(channelId)).toHaveLength(2);
      });
      expect(previous[1]?.content).toBe('G1 X20');
    });

    it('keeps blank-file programs selectable without deactivating the channels', async () => {
      service.newFile('blank.mpf');
      const blank = service.getActiveFile();
      const programs = ['1', '2', '3'].map(channelId => service.getActiveProgram(channelId));
      await service.openFile('G1 X10', 'other.mpf', { parseMultiChannel: false });
      vi.clearAllMocks();

      service.selectFile(blank!.id);

      ['1', '2', '3'].forEach((channelId, index) => {
        expect(service.getActiveProgram(channelId)).toBe(programs[index]);
      });
      expect(mockStateService.activateChannel).not.toHaveBeenCalled();
      expect(mockStateService.deactivateChannel).not.toHaveBeenCalled();
    });

    it('persists each channel program and its content for browser reloads', () => {
      const persistentService = new FileManagerService(mockEventBus, mockStateService as any);
      persistentService.newFile('saved.mpf');
      ['1', '2', '3'].forEach(channelId => {
        persistentService.updateActiveProgramContent(channelId, `G1 X${channelId}0`);
      });

      const restoredService = new FileManagerService(mockEventBus, mockStateService as any);
      ['1', '2', '3'].forEach(channelId => {
        expect(restoredService.getActiveProgram(channelId)).toEqual(persistentService.getActiveProgram(channelId));
        expect(restoredService.getActiveProgram(channelId)?.content).toBe(`G1 X${channelId}0`);
      });
    });
  });

  describe('selectFile', () => {
    it('should sync channels from a stored multi-channel file when selected', async () => {
      const file = await service.openFile('<CHANNEL1.MPF>\nG0 X10\n<CHANNEL2.MPF>\nG0 Y20', 'multi.mpf', { parseMultiChannel: true });

      vi.clearAllMocks();
      mockState.activeFileId = file.id;

      service.selectFile(file.id);

      expect(mockStateService.activateChannel).toHaveBeenCalledWith('1');
      expect(mockStateService.activateChannel).toHaveBeenCalledWith('2');
      expect(mockStateService.deactivateChannel).toHaveBeenCalledWith('3');
    });
  });

  describe('updateActiveProgramContent', () => {
    it('should publish a content change so editors receive programmatic updates', async () => {
      await service.openFile('N10 G0 X0', 'aligned.mpf', { parseMultiChannel: false });
      vi.clearAllMocks();

      service.updateActiveProgramContent('1', '  M200\nN10 G0 X0');

      expect(mockEventBus.publish).toHaveBeenCalledWith(
        'program:content_changed',
        expect.objectContaining({
          channelId: '1',
          program: expect.objectContaining({ content: '  M200\nN10 G0 X0' }),
        }),
      );
    });
  });

  describe('browser persistence', () => {
    it('should restore stored files and the active program when StateService is provided', () => {
      const file = {
        id: 'persisted-file',
        name: 'saved.mpf',
        content: 'G0 X10',
        channels: ['G0 X10'],
        isMultiChannel: false,
        lastModified: 123,
      };
      const program = {
        id: 'persisted-program',
        name: 'saved.mpf',
        content: 'G0 X10',
        channelId: '1',
        sourceFileId: file.id,
        lastModified: 123,
      };
      localStorage.setItem('nc-files', JSON.stringify([file]));
      localStorage.setItem('nc-programs', JSON.stringify([program]));
      mockState.activeFileId = file.id;
      mockState.activeProgramIds.set('1', program.id);

      const restoredService = new FileManagerService(mockEventBus, mockStateService as any);

      expect(restoredService.getFiles()).toEqual([file]);
      expect(restoredService.getActiveFile()).toEqual(file);
      expect(restoredService.getActiveProgram('1')).toEqual(program);
    });
  });

  describe('closeFile', () => {
    it('should close a file and update active file', async () => {
      const file1 = await service.openFile('c1', 'f1', { parseMultiChannel: false });
      const file2 = await service.openFile('c2', 'f2', { parseMultiChannel: false });
      
      expect(service.getFiles()).toHaveLength(2);
      expect(service.getActiveFile()?.id).toBe(file2.id);
      
      service.closeFile(file2.id);
      
      expect(service.getFiles()).toHaveLength(1);
      expect(service.getActiveFile()?.id).toBe(file1.id);
      expect(mockEventBus.publish).toHaveBeenCalledWith('file:closed', file2.id);
    });
  });
});
