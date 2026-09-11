import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutedProgramService } from '../ExecutedProgramService';
import { BackendGateway } from '../BackendGateway';
import { EventBus, EVENT_NAMES } from '../EventBus';
import type { BackendPlotSegment, PlotResponse, ToolPathMode } from '@core/types';

// Mock the BackendGateway
vi.mock('../BackendGateway');

describe('ExecutedProgramService', () => {
  let service: ExecutedProgramService;
  let mockBackend: BackendGateway;
  let mockEventBus: EventBus;

  beforeEach(() => {
    mockBackend = new BackendGateway();
    mockEventBus = new EventBus();
    service = new ExecutedProgramService(mockBackend, mockEventBus);
  });

  describe('centre-mode request boundary', () => {
    it('passes independent offset records without coercing tool identifiers', async () => {
      vi.mocked(mockBackend.requestPlot).mockResolvedValue({ canal: {} });
      const toolOffsets = [
        { toolNumber: '1', offsetNumber: 2, rValue: 0.4 },
        { toolNumber: '1', offsetNumber: 3, rValue: 0.8 },
        { toolNumber: 1, offsetNumber: 2, rValue: 2 },
      ];
      await service.executeProgram({ channelId: '1', program: 'T="1"\nD2',
        machineName: 'SIEMENS_840DI', toolOffsets });
      expect(vi.mocked(mockBackend.requestPlot).mock.calls[0][0].machinedata[0].toolOffsets)
        .toEqual(toolOffsets);
    });
    it.each([undefined, 'effective', 'center'] as const)(
      'enforces centre mode for single and multi-channel requests with legacy mode %s',
      async (mode: ToolPathMode | undefined) => {
        vi.mocked(mockBackend.requestPlot).mockResolvedValue({ canal: {} });
        const first = {
          channelId: '1' as const,
          program: '(keep comments)\r\nT0\r\nG1 X1',
          machineName: 'SIEMENS_MILL',
          toolValues: [{ toolNumber: 0, qValue: 0, rValue: 0 }],
          customVariables: [{ name: 'R1', value: 0 }],
        };
        const second = { ...first, channelId: '2' as const };

        await service.executeProgram(first, mode);
        await service.executeMultipleChannels([first, second], mode);

        const payload = (canalNr: string) => ({
          canalNr,
          program: '(keep comments)\nT0\nG1 X1',
          machineName: first.machineName,
          toolValues: first.toolValues,
          customVariables: first.customVariables,
        });
        expect(mockBackend.requestPlot).toHaveBeenNthCalledWith(1, {
          toolPathMode: 'center', machinedata: [payload('1')],
        });
        expect(mockBackend.requestPlot).toHaveBeenNthCalledWith(2, {
          toolPathMode: 'center', machinedata: [payload('1'), payload('2')],
        });
      },
    );
  });

  describe('execution metadata', () => {
    const move = (metadata: Partial<BackendPlotSegment> = {}): BackendPlotSegment => ({
      geometry: 'LINEAR',
      traversal: 'FEED',
      lineNumber: 7,
      points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }],
      ...metadata,
    });
    const request = { channelId: '1' as const, program: 'G1 X1', machineName: 'SIEMENS_MILL' };

    it('preserves exact tool identifiers and unavailable values without carrying state forward', async () => {
      const metadata: Partial<BackendPlotSegment>[] = [
        { toolNumber: 0, executionStep: 0 },
        { toolNumber: 1, executionStep: 1 },
        { toolNumber: '1', executionStep: 2 },
        { toolNumber: 'DRILL_8', executionStep: 3 },
        { toolNumber: 'unknown', executionStep: 4 },
        { toolNumber: null, executionStep: null },
        {},
      ];
      vi.mocked(mockBackend.requestPlot).mockResolvedValue({
        canal: { '1': { segments: metadata.map(move) } },
      });

      const result = await service.executeProgram(request);
      const segments = result.plotMetadata!.segments;
      expect(segments).toHaveLength(metadata.length);
      metadata.forEach((entry, index) => {
        expect(segments[index]).toMatchObject({
          toolNumber: entry.toolNumber,
          executionStep: entry.executionStep,
          sourceSegmentIndex: index,
          subsegmentIndex: 0,
          channelId: '1',
        });
      });
      // Deduplicated display points must not collapse repeated execution occurrences.
      expect(result.plotMetadata!.points).toHaveLength(2);

      vi.mocked(mockBackend.requestPlot).mockResolvedValue({ canal: { '1': { segments: [move()] } } });
      const nextRun = await service.executeProgram(request);
      expect(nextRun.plotMetadata!.segments[0].toolNumber).toBeUndefined();
      expect(nextRun.plotMetadata!.segments[0].executionStep).toBeUndefined();
    });

    it('retains response ordinals, cycle steps and every sampled arc pair across combined channels', async () => {
      const completed = vi.fn();
      mockEventBus.subscribe(EVENT_NAMES.EXECUTION_COMPLETED, completed);
      vi.mocked(mockBackend.requestPlot).mockResolvedValue({
        canal: {
          '1': {
            segments: [
              move({ geometry: 'UNSUPPORTED', executionStep: 0 }),
              move({ toolNumber: 0, executionStep: 0 }),
              move({
                geometry: 'ARC_CW', toolNumber: 'FINISH', executionStep: 4,
                points: [
                  { x: 1, y: 0, z: 0 }, { x: 0.7, y: 0.7, z: 0 },
                  { x: 0, y: 1, z: 0 }, { x: -1, y: 0, z: 0 },
                ],
              }),
              move({ toolNumber: 'FINISH', executionStep: 4 }),
              move({ toolNumber: 2, executionStep: 8 }),
            ],
          },
          '2': { segments: [move({ toolNumber: 'DRILL', executionStep: 0 }), move()] },
        },
      });

      const results = await service.executeMultipleChannels([request, { ...request, channelId: '2' }]);
      // This is the same concatenation used by the global plot; channel-local ordinals stay scoped.
      const combined = results.flatMap((result) => result.plotMetadata!.segments);
      expect(combined.map((segment) => [
        segment.channelId, segment.sourceSegmentIndex, segment.subsegmentIndex,
        segment.executionStep, segment.toolNumber,
      ])).toEqual([
        ['1', 1, 0, 0, 0],
        ['1', 2, 0, 4, 'FINISH'],
        ['1', 2, 1, 4, 'FINISH'],
        ['1', 2, 2, 4, 'FINISH'],
        ['1', 3, 0, 4, 'FINISH'],
        ['1', 4, 0, 8, 2],
        ['2', 0, 0, 0, 'DRILL'],
        ['2', 1, 0, undefined, undefined],
      ]);
      expect(combined.slice(1, 4).map((segment) => segment.type)).toEqual(['arc', 'arc', 'arc']);
      expect(combined.every((segment) => segment.endPoint.lineNumber === 7)).toBe(true);
      expect(completed).toHaveBeenCalledTimes(2);
      results.forEach((result, index) => {
        expect(completed).toHaveBeenNthCalledWith(index + 1, { channelId: String(index + 1), result });
      });
    });
  });

  describe('parseExecutionResponse', () => {
    it('should parse canal data with segments correctly', async () => {
      const mockResponse: PlotResponse = {
        canal: {
          '1': {
            segments: [
              {
                geometry: 'LINEAR',
                traversal: 'RAPID',
                lineNumber: 1,
                toolNumber: 1,
                points: [
                  { x: 0, y: 0, z: 0 },
                  { x: 10, y: 10, z: 0 },
                ],
              },
              {
                geometry: 'LINEAR',
                traversal: 'FEED',
                lineNumber: 2,
                toolNumber: 1,
                points: [
                  { x: 10, y: 10, z: 0 },
                  { x: 60, y: 10, z: 0 },
                ],
              },
            ],
            executedLines: [1, 2],
            variables: {},
            timing: [0.1, 0.1],
          },
        },
      };

      vi.mocked(mockBackend.requestPlot).mockResolvedValue(mockResponse);

      const result = await service.executeProgram({
        channelId: '1',
        program: 'G0 X10 Y10\nG1 X60',
        machineName: 'SIEMENS_MILL',
      }, 'center');

      expect(mockBackend.requestPlot).toHaveBeenCalledWith(
        expect.objectContaining({ toolPathMode: 'center' }),
      );

      expect(result.plotMetadata).toBeDefined();
      expect(result.plotMetadata?.segments).toHaveLength(2);

      // Check first segment (rapid)
      expect(result.plotMetadata?.segments[0].type).toBe('rapid');
      expect(result.plotMetadata?.segments[0].startPoint).toEqual({
        x: 0,
        y: 0,
        z: 0,
        lineNumber: 1,
      });
      expect(result.plotMetadata?.segments[0].endPoint).toEqual({
        x: 10,
        y: 10,
        z: 0,
        lineNumber: 1,
      });

      // Check second segment (feed)
      expect(result.plotMetadata?.segments[1].type).toBe('feed');
      expect(result.plotMetadata?.segments[1].startPoint).toEqual({
        x: 10,
        y: 10,
        z: 0,
        lineNumber: 2,
      });

      // Check executed lines
      expect(result.executedLines).toEqual([1, 2]);
    });

    it('should handle empty response gracefully', async () => {
      const mockResponse: PlotResponse = {
        canal: {},
      };

      vi.mocked(mockBackend.requestPlot).mockResolvedValue(mockResponse);

      const result = await service.executeProgram({
        channelId: '1',
        program: '',
        machineName: 'SIEMENS_MILL',
      });

      expect(result.plotMetadata).toBeDefined();
      expect(result.plotMetadata?.segments).toHaveLength(0);
      expect(result.plotMetadata?.points).toHaveLength(0);
    });

    it('should deduplicate points when segments share endpoints', async () => {
      const mockResponse: PlotResponse = {
        canal: {
          '1': {
            segments: [
              {
                geometry: 'LINEAR',
                traversal: 'FEED',
                lineNumber: 1,
                toolNumber: 1,
                points: [
                  { x: 0, y: 0, z: 0 },
                  { x: 10, y: 10, z: 0 },
                ],
              },
              {
                geometry: 'LINEAR',
                traversal: 'FEED',
                lineNumber: 2,
                toolNumber: 1,
                points: [
                  { x: 10, y: 10, z: 0 }, // Same as previous endpoint
                  { x: 20, y: 20, z: 0 },
                ],
              },
            ],
            executedLines: [1, 2],
            variables: {},
            timing: [0.1, 0.1],
          },
        },
      };

      vi.mocked(mockBackend.requestPlot).mockResolvedValue(mockResponse);

      const result = await service.executeProgram({
        channelId: '1',
        program: 'G1 X10 Y10\nG1 X20 Y20',
        machineName: 'SIEMENS_MILL',
      });

      // Should have 2 segments but only 3 unique points (not 4)
      expect(result.plotMetadata?.segments).toHaveLength(2);
      expect(result.plotMetadata?.points).toHaveLength(3);
    });

    it('should ignore legacy-only segment types', async () => {
      const mockResponse: PlotResponse = {
        canal: {
          '1': {
            segments: [
              {
                type: 'G0',
                lineNumber: 1,
                toolNumber: 1,
                points: [
                  { x: 0, y: 0, z: 0 },
                  { x: 10, y: 10, z: 0 },
                ],
              },
              {
                type: 'ARC',
                lineNumber: 2,
                toolNumber: 1,
                points: [
                  { x: 10, y: 10, z: 0 },
                  { x: 20, y: 20, z: 0 },
                ],
              },
            ],
            executedLines: [1, 2],
            variables: {},
            timing: [0.1, 0.1],
          },
        },
      };

      vi.mocked(mockBackend.requestPlot).mockResolvedValue(mockResponse);

      const result = await service.executeProgram({
        channelId: '1',
        program: 'G0 X10 Y10\nG2 X20 Y20 R10',
        machineName: 'SIEMENS_MILL',
      });

      expect(result.plotMetadata?.segments).toHaveLength(0);
    });

    it('should prefer explicit traversal and geometry semantics', async () => {
      const mockResponse: PlotResponse = {
        canal: {
          '1': {
            segments: [
              {
                geometry: 'LINEAR',
                traversal: 'RAPID',
                sourceCode: 'G00',
                lineNumber: 1,
                toolNumber: 1,
                points: [
                  { x: 0, y: 0, z: 0 },
                  { x: 10, y: 0, z: 0 },
                ],
              },
              {
                geometry: 'ARC_CW',
                traversal: 'FEED',
                sourceCode: 'G02',
                lineNumber: 2,
                toolNumber: 1,
                points: [
                  { x: 10, y: 0, z: 0 },
                  { x: 20, y: 10, z: 0 },
                ],
              },
            ],
            executedLines: [1, 2],
            variables: {},
            timing: [1.5, 0],
          },
        },
      };

      vi.mocked(mockBackend.requestPlot).mockResolvedValue(mockResponse);

      const result = await service.executeProgram({
        channelId: '1',
        program: 'G0 X10\nG2 X20 Y10 R10',
        machineName: 'SIEMENS_MILL',
      });

      expect(result.plotMetadata?.segments[0].type).toBe('rapid');
      expect(result.plotMetadata?.segments[1].type).toBe('arc');
    });

    it('should preserve interpolated points within a backend segment', async () => {
      const mockResponse: PlotResponse = {
        canal: {
          '1': {
            segments: [
              {
                geometry: 'LINEAR',
                traversal: 'FEED',
                lineNumber: 4,
                toolNumber: 1,
                points: [
                  { x: 0, y: 50, z: 0 },
                  { x: 35.355, y: 35.355, z: 0 },
                  { x: 50, y: 0, z: 0 },
                ],
              },
            ],
            executedLines: [4],
            variables: {},
            timing: [0.1],
          },
        },
      };

      vi.mocked(mockBackend.requestPlot).mockResolvedValue(mockResponse);

      const result = await service.executeProgram({
        channelId: '1',
        program: 'G1 C180',
        machineName: 'SIEMENS_MILL',
      });

      expect(result.plotMetadata?.points).toHaveLength(3);
      expect(result.plotMetadata?.segments).toHaveLength(2);
      expect(result.plotMetadata?.segments[0].startPoint).toEqual({
        x: 0,
        y: 50,
        z: 0,
        lineNumber: 4,
      });
      expect(result.plotMetadata?.segments[0].endPoint).toEqual({
        x: 35.355,
        y: 35.355,
        z: 0,
        lineNumber: 4,
      });
      expect(result.plotMetadata?.segments[1].startPoint).toEqual({
        x: 35.355,
        y: 35.355,
        z: 0,
        lineNumber: 4,
      });
      expect(result.plotMetadata?.segments[1].endPoint).toEqual({
        x: 50,
        y: 0,
        z: 0,
        lineNumber: 4,
      });
    });

    it('should parse variable snapshots from the backend response', async () => {
      const mockResponse: PlotResponse = {
        canal: {
          '1': {
            segments: [],
            executedLines: [1],
            variables: {
              '1': 4.7,
              '26': 3.1415,
              '100': 1.005,
            },
            timing: [],
          },
        },
      };

      vi.mocked(mockBackend.requestPlot).mockResolvedValue(mockResponse);

      const result = await service.executeProgram({
        channelId: '1',
        program: '#1=4.7\n#26=3.1415',
        machineName: 'FANUC_T',
      });

      expect(result.variableSnapshot.get(1)).toBe(4.7);
      expect(result.variableSnapshot.get(26)).toBe(3.1415);
      expect(result.variableSnapshot.get(100)).toBe(1.005);
    });

    it('should parse Siemens named variables and arrays from the backend response', async () => {
      const mockResponse: PlotResponse = {
        canal: {
          '1': {
            segments: [],
            executedLines: [1],
            variables: {},
            namedVariables: {
              ANGLE_Z: 36.869897,
              'CUSTOM_MC[0]': 20,
              'CUSTOM_MC[3]': 12.5,
            },
            timing: [],
          },
        },
      };

      vi.mocked(mockBackend.requestPlot).mockResolvedValue(mockResponse);

      const result = await service.executeProgram({
        channelId: '1',
        program: 'DEF REAL CUSTOM_MC[4]\nANGLE_Z=36.869897',
        machineName: 'SIEMENS_840DI',
      });

      expect(result.namedVariableSnapshot.get('ANGLE_Z')).toBe(36.869897);
      expect(result.namedVariableSnapshot.get('CUSTOM_MC[0]')).toBe(20);
      expect(result.namedVariableSnapshot.get('CUSTOM_MC[3]')).toBe(12.5);
    });

    it('should map timing to segment line numbers instead of all executed lines', async () => {
      const mockResponse: PlotResponse = {
        canal: {
          '1': {
            segments: [
              {
                geometry: 'LINEAR',
                traversal: 'FEED',
                lineNumber: 2,
                toolNumber: 1,
                points: [
                  { x: 0, y: 0, z: 0 },
                  { x: 1, y: 0, z: 0 },
                ],
              },
            ],
            executedLines: [1, 2],
            variables: {},
            timing: [0.6],
          },
        },
      };

      vi.mocked(mockBackend.requestPlot).mockResolvedValue(mockResponse);

      const result = await service.executeProgram({
        channelId: '1',
        program: 'F100\nG1 X1',
        machineName: 'SIEMENS_MILL',
      });

      expect(result.timingData.get(1)).toBeUndefined();
      expect(result.timingData.get(2)).toBe(0.6);
    });

    it('should execute multiple channels without applying alignment', async () => {
      vi.mocked(mockBackend.requestPlot).mockResolvedValue({ canal: {} });

      await service.executeMultipleChannels(
        [
          { channelId: '1', program: 'N10 G0 X0\nN20 G1 X1', machineName: 'CUSTOM_MACHINE' },
          { channelId: '2', program: 'N10 G0 Z0\nN20 G1 Z1', machineName: 'CUSTOM_MACHINE' },
        ],
        'center',
      );

      expect(mockBackend.getLineAlignmentSyntax).not.toHaveBeenCalled();
      expect(vi.mocked(mockBackend.requestPlot).mock.calls[0][0].toolPathMode).toBe('center');
      expect(vi.mocked(mockBackend.requestPlot).mock.calls[0][0].machinedata).toEqual([
        expect.objectContaining({ program: 'N10 G0 X0\nN20 G1 X1' }),
        expect.objectContaining({ program: 'N10 G0 Z0\nN20 G1 Z1' }),
      ]);
    });
  });
});
