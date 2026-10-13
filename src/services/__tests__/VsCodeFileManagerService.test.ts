// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EventBus } from '../EventBus';
import { StateService } from '../StateService';
import { VsCodeFileManagerService } from '../VsCodeFileManagerService';
import { SimulationCommentCodec } from '../tools/SimulationCommentCodec';

describe('VS Code program machine restoration', () => {
  it('restores a host-loaded setup after the backend list arrives, even with a plain second channel', async () => {
    const bus = new EventBus();
    const state = new StateService(bus, false);
    const manager = new VsCodeFileManagerService(bus, state);
    const text = new SimulationCommentCodec().encodeSetup({ machineName: 'SAVED' },
      { kind: 'block', open: '(', close: ')' });
    window.dispatchEvent(new CustomEvent('vscode:files-opened', {
      detail: { type: 'FILES_OPENED', channels: { '1': text, '2': 'G1 X2' } },
    }));
    await Promise.resolve();
    expect(manager.getActiveProgram('1')?.content).toBe(text);
    expect(state.getState().globalMachine).toBeUndefined();
    state.setMachines(['FIRST', 'SAVED'].map(machineName => ({
      machineName, controlType: 'FANUC', axes: [], feedLimits: { min: 0, max: 1 },
      defaultTools: [], availableChannels: 2,
    })));
    expect(state.getState().globalMachine).toBe('SAVED');
    expect(state.getState().activeMachine?.machineName).toBe('SAVED');
  });
});
