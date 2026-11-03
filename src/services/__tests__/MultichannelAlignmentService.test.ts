import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendGateway } from '../BackendGateway';
import { formatNcLineSpacing, MultichannelAlignmentService } from '../MultichannelAlignmentService';

describe('MultichannelAlignmentService', () => {
  const getLineAlignmentSyntax = vi.fn();
  let service: MultichannelAlignmentService;

  beforeEach(() => {
    getLineAlignmentSyntax.mockReset();
    service = new MultichannelAlignmentService({ getLineAlignmentSyntax } as unknown as BackendGateway);
    getLineAlignmentSyntax.mockResolvedValue({
      lineAlignmentSyntax: [
        {
          controlType: 'CUSTOM',
          syntax: 'SYNC<marker>',
        },
      ],
      success: true,
    });
  });

  it('adds two-space padding lines before the first and subsequent synchronization markers', async () => {
    const result = await service.alignPrograms(
      [
        { channelId: '1', program: 'G0 X0\nSYNC1\nG1 X1\nG1 X2\nSYNC2' },
        { channelId: '2', program: 'G0 Z0\nG1 Z1\nG1 Z2\nSYNC1\nSYNC2' },
      ],
      'CUSTOM',
    );

    expect(getLineAlignmentSyntax).toHaveBeenCalledOnce();
    expect(result.alignmentCount).toBe(4);
    expect(result.programs.map(({ program }) => program)).toEqual([
      'G0 X0\n  \n  \nSYNC1\nG1 X1\nG1 X2\nSYNC2',
      'G0 Z0\nG1 Z1\nG1 Z2\nSYNC1\n  \n  \nSYNC2',
    ]);
    expect(result.programs.map(({ syncMarkers }) => syncMarkers)).toEqual([
      [
        { lineNumber: 4, marker: '1', code: 'SYNC1' },
        { lineNumber: 7, marker: '2', code: 'SYNC2' },
      ],
      [
        { lineNumber: 4, marker: '1', code: 'SYNC1' },
        { lineNumber: 7, marker: '2', code: 'SYNC2' },
      ],
    ]);
    expect(result.programs.map(({ paddedLines }) => paddedLines)).toEqual([
      [2, 3],
      [5, 6],
    ]);
  });

  it('ignores commented sync codes when aligning channels', async () => {
    getLineAlignmentSyntax.mockResolvedValue({
      lineAlignmentSyntax: [
        {
          controlType: 'FANUC',
          waitCodeRange: { min: 200, max: 899},
          twoChannel: { syntax: 'M<waitCode>' },
        },
      ],
      success: true,
    });

    const result = await service.alignPrograms(
      [
        { channelId: '1', program: '(WAIT M200)\nG0 X0\nG0 Z0\nM200\nM201' },
        { channelId: '2', program: 'M200\nG1 Z1\nM201' },
      ],
      'FANUC',
    );

    expect(result.programs.map(({ program }) => program)).toEqual([
      '(WAIT M200)\nG0 X0\nG0 Z0\nM200\n  \nM201',
      '  \n  \n  \nM200\nG1 Z1\nM201',
    ]);
    expect(result.programs[0].syncMarkers?.map((m) => m.lineNumber)).toEqual([4, 6]);
    expect(result.programs[1].syncMarkers?.map((m) => m.lineNumber)).toEqual([4, 6]);
  });

  it('removes only two-space padding directly before shared anchors', async () => {
    const result = await service.removeAlignment(
      [
        { channelId: '1', program: '  \n  \nSYNC1\nG0 X0\nSYNC2\n  ' },
        { channelId: '2', program: 'G0 Z0\nSYNC1\n  \nSYNC2' },
      ],
      'CUSTOM',
    );

    expect(getLineAlignmentSyntax).toHaveBeenCalledOnce();
    expect(result.alignmentCount).toBe(3);
    expect(result.programs.map(({ program }) => program)).toEqual([
      'SYNC1\nG0 X0\nSYNC2\n  ',
      'G0 Z0\nSYNC1\nSYNC2',
    ]);
  });

  it('does not add padding when channels have no common anchor', async () => {
    const programs = [
      { channelId: '1' as const, program: 'N10 G0 X0' },
      { channelId: '2' as const, program: 'N20 G0 Z0' },
    ];

    const result = await service.alignPrograms(programs, 'CUSTOM');

    expect(result.alignmentCount).toBe(0);
    expect(result.programs).toEqual(programs);
  });

  it('aligns compact FANUC three-channel wait-code selectors', async () => {
    getLineAlignmentSyntax.mockResolvedValue({
      lineAlignmentSyntax: [
        {
          controlType: 'FANUC',
          waitCodeRange: { min: 200, max: 899 },
          threeChannel: {
            syntax: 'M<waitCode> P<channels>',
            selectors: ['P123'],
          },
        },
      ],
      success: true,
    });

    const result = await service.alignPrograms(
      [
        { channelId: '1', program: 'M200P123\nG1 X1\nM202P123' },
        { channelId: '2', program: 'G1 Z1\nM200P123\nM202P123' },
        { channelId: '3', program: 'M200P123\nM202P123' },
      ],
      'FANUC',
    );

    expect(result.alignmentCount).toBe(4);
    expect(result.programs.map(({ program }) => program)).toEqual([
      '  \nM200P123\nG1 X1\nM202P123',
      'G1 Z1\nM200P123\n  \nM202P123',
      '  \nM200P123\n  \nM202P123',
    ]);
  });

  it('adds and removes spaces between NC words while preserving comments, brackets, and alignment padding', () => {
    const compactBlock = [
      '/G161X6.0Z0.5A3.0D2.0F0.03 ',
      '/G161X10.0Z15.0F0.03 ',
      '/G161Z18.0A3.0D2.0F0.03',
      '/G163X16.0Z21.0R3.0A3.0D2.0F0.03 ',
      '/G161X17.0A3.0D2.0F0.03',
      '/G161X19.0Z22.0A3.0D2.0F0.03',
      'G266A[#531]W[#530]S[#529](SETUP COMMENT)',
      '  ',
    ];

    const spacedBlock = [
      '/G161 X6.0 Z0.5 A3.0 D2.0 F0.03 ',
      '/G161 X10.0 Z15.0 F0.03 ',
      '/G161 Z18.0 A3.0 D2.0 F0.03',
      '/G163 X16.0 Z21.0 R3.0 A3.0 D2.0 F0.03 ',
      '/G161 X17.0 A3.0 D2.0 F0.03',
      '/G161 X19.0 Z22.0 A3.0 D2.0 F0.03',
      'G266 A[#531] W[#530] S[#529](SETUP COMMENT)',
      '  ',
    ];

    expect(compactBlock.map((line) => formatNcLineSpacing(line, 'add'))).toEqual(spacedBlock);
    expect(spacedBlock.map((line) => formatNcLineSpacing(line, 'remove'))).toEqual(compactBlock);
  });
});