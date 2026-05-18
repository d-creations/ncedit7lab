import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutedProgramService } from '../ExecutedProgramService';
import { BackendGateway } from '../BackendGateway';
import { EventBus } from '../EventBus';
import type { PlotResponse } from '@core/types';

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

  describe('parseExecutionResponse', () => {
    it('should parse canal data with segments correctly', async () => {
      const mockResponse: PlotResponse = {
        canal: {
          '1': {
            segments: [
              {
                type: 'RAPID',
                lineNumber: 1,
                toolNumber: 1,
                points: [
                  { x: 0, y: 0, z: 0 },
                  { x: 10, y: 10, z: 0 },
                ],
              },
              {
                type: 'LINEAR',
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
      });

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
                type: 'LINEAR',
                lineNumber: 1,
                toolNumber: 1,
                points: [
                  { x: 0, y: 0, z: 0 },
                  { x: 10, y: 10, z: 0 },
                ],
              },
              {
                type: 'LINEAR',
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

    it('should map segment types correctly', async () => {
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

      expect(result.plotMetadata?.segments[0].type).toBe('rapid');
      expect(result.plotMetadata?.segments[1].type).toBe('arc');
    });

    it('should preserve interpolated points within a backend segment', async () => {
      const mockResponse: PlotResponse = {
        canal: {
          '1': {
            segments: [
              {
                type: 'LINEAR',
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

    it('should map timing to segment line numbers instead of all executed lines', async () => {
      const mockResponse: PlotResponse = {
        canal: {
          '1': {
            segments: [
              {
                type: 'LINEAR',
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
  });
});
