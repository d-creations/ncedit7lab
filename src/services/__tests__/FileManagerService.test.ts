import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileManagerService } from '../FileManagerService';
import { EventBus } from '../EventBus';

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
    };
    service = new FileManagerService(mockEventBus, mockStateService as any, false);
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
