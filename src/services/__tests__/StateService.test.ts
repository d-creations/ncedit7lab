import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateService } from '../StateService';
import { EventBus, EVENT_NAMES } from '../EventBus';

describe('StateService centre-mode normalization', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to centre mode and ignores legacy mode changes without creating history or events', () => {
    const bus = new EventBus();
    const service = new StateService(bus, false);
    const changed = vi.fn();
    bus.subscribe(EVENT_NAMES.STATE_CHANGED, changed);

    expect(service.getState().toolPathMode).toBe('center');
    service.setToolPathMode('effective');
    service.setToolPathMode('center');
    service.undo();
    service.redo();

    expect(service.getState().toolPathMode).toBe('center');
    expect(changed).not.toHaveBeenCalled();
  });

  it.each(['effective', 'center', undefined, 'invalid'])(
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
      expect(service.getState().toolPathMode).toBe('center');
      expect(service.getChannel('1')?.program).toBe('T0\nG1 X1');
      expect(service.getActiveProgramId('1')).toBe('program-a');

      service.updateChannel('1', { program: 'T0\nG1 X2' });
      service.undo();
      expect(service.getChannel('1')?.program).toBe('T0\nG1 X1');
      expect(service.getState().toolPathMode).toBe('center');
      service.redo();
      expect(service.getChannel('1')?.program).toBe('T0\nG1 X2');
      expect(service.getState().toolPathMode).toBe('center');
      expect(JSON.parse(stored).toolPathMode).toBe('center');
    },
  );
});