import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateService } from '../StateService';
import { EventBus, EVENT_NAMES } from '../EventBus';

describe('StateService toolpath mode', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preserves each selectable mode and emits changes', () => {
    const bus = new EventBus();
    const service = new StateService(bus, false);
    const changed = vi.fn();
    bus.subscribe(EVENT_NAMES.STATE_CHANGED, changed);

    expect(service.getState().toolPathMode).toBe('center');
    service.setToolPathMode('effective');
    expect(service.getState().toolPathMode).toBe('effective');
    service.setToolPathMode('simulation');
    expect(service.getState().toolPathMode).toBe('simulation');
    service.setToolPathMode('center');

    expect(service.getState().toolPathMode).toBe('center');
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it.each(['effective', 'center', 'simulation', undefined, 'invalid'])(
    'normalizes persisted mode %s while preserving channel content and undo/redo',
    (toolPathMode) => {
      const initial = new StateService(new EventBus(), false).getState();
      let stored = JSON.stringify({
        ...initial,
        toolPathMode,
        channels: [['1', { id: '1', active: true, program: 'T0\nG1 X1' }]],
        activeProgramIds: [['1', 'program-a']],
      });
      vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => stored),
        setItem: vi.fn((_key: string, value: string) => { stored = value; }),
      });

      const service = new StateService(new EventBus());
      const expectedMode = toolPathMode === 'effective' || toolPathMode === 'simulation'
        ? toolPathMode : 'center';
      expect(service.getState().toolPathMode).toBe(expectedMode);
      expect(service.getChannel('1')?.program).toBe('T0\nG1 X1');
      expect(service.getActiveProgramId('1')).toBe('program-a');

      service.updateChannel('1', { program: 'T0\nG1 X2' });
      service.undo();
      expect(service.getChannel('1')?.program).toBe('T0\nG1 X1');
      expect(service.getState().toolPathMode).toBe(expectedMode);
      service.redo();
      expect(service.getChannel('1')?.program).toBe('T0\nG1 X2');
      expect(service.getState().toolPathMode).toBe(expectedMode);
      expect(JSON.parse(stored).toolPathMode).toBe(expectedMode);
    },
  );

  it('activates only the selected machine channels and rejects unavailable channels', () => {
    const service = new StateService(new EventBus(), false);
    service.setMachines([
      { machineName: 'SR', controlType: 'FANUC', axes: [], feedLimits: { min: 0, max: 1 }, defaultTools: [], availableChannels: 2 },
      { machineName: 'SV', controlType: 'FANUC', axes: [], feedLimits: { min: 0, max: 1 }, defaultTools: [], availableChannels: 3 },
    ]);

    service.setGlobalMachine('SR');
    expect(service.getActiveChannels().map((channel) => channel.id)).toEqual(['1', '2']);
    service.activateChannel('3');
    expect(service.getActiveChannels().map((channel) => channel.id)).toEqual(['1', '2']);

    service.setGlobalMachine('SV');
    expect(service.getActiveChannels().map((channel) => channel.id)).toEqual(['1', '2', '3']);
  });
});