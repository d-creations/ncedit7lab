import { describe, expect, it, vi } from 'vitest';
import { MachineService } from '../MachineService';
import { EventBus } from '../EventBus';
import type { BackendGateway } from '../BackendGateway';

describe('machine simulation metadata read capability', () => {
  it('transports explicit syntax but never infers it from a name, control type or tool regex', async () => {
    const syntax = { kind: 'block', open: '(', close: ')', maxLineLength: 80 } as const;
    const backend = { listMachines: vi.fn().mockResolvedValue({ machines: [
      {
        machineName: 'EXPLICIT', controlType: 'TEST', simulationCommentSyntax: syntax,
        axes: ['X', 'Z'], availableChannels: 2, profileRevision: 'sha256:explicit',
        supportedPoseContracts: [], simulation: { modelId: 'demo' },
      },
      {
        machineName: 'SIEMENS_MILL', controlType: 'SIEMENS', axes: ['X', 'Y', 'Z'],
        availableChannels: 1, profileRevision: 'sha256:siemens', supportedPoseContracts: [],
      },
    ] }) } as unknown as BackendGateway;
    const service = new MachineService(backend, new EventBus());
    const profiles = await service.fetchMachines();
    expect(profiles[0].simulationCommentSyntax).toEqual(syntax);
    expect(profiles[1].simulationCommentSyntax).toBeUndefined();
    expect(profiles[0]).toMatchObject({
      axes: ['X', 'Z'], availableChannels: 2, profileRevision: 'sha256:explicit',
      supportedPoseContracts: [], simulation: { modelId: 'demo' },
    });
  });
});