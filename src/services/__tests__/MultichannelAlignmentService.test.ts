import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendGateway } from '../BackendGateway';
import { MultichannelAlignmentService } from '../MultichannelAlignmentService';

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

  it('adds two-space padding lines between API-defined synchronization markers', async () => {
    const result = await service.alignPrograms(
      [
        { channelId: '1', program: 'G0 X0\nSYNC1\nG1 X1\nG1 X2\nSYNC2' },
        { channelId: '2', program: 'G0 Z0\nG1 Z1\nG1 Z2\nSYNC1\nSYNC2' },
      ],
      'CUSTOM',
    );

    expect(getLineAlignmentSyntax).toHaveBeenCalledOnce();
    expect(result.alignmentCount).toBe(2);
    expect(result.programs.map(({ program }) => program)).toEqual([
      'G0 X0\nSYNC1\nG1 X1\nG1 X2\nSYNC2',
      'G0 Z0\nG1 Z1\nG1 Z2\nSYNC1\n  \n  \nSYNC2',
    ]);
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

    expect(result.alignmentCount).toBe(2);
    expect(result.programs.map(({ program }) => program)).toEqual([
      'M200P123\nG1 X1\nM202P123',
      'G1 Z1\nM200P123\n  \nM202P123',
      'M200P123\n  \nM202P123',
    ]);
  });
});