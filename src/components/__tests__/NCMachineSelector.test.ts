// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { NCMachineSelector } from '../NCMachineSelector';
import { ServiceRegistry } from '@core/ServiceRegistry';
import { EVENT_BUS_TOKEN, MACHINE_SERVICE_TOKEN, STATE_SERVICE_TOKEN } from '@core/ServiceTokens';
import { EventBus } from '@services/EventBus';
import { StateService } from '@services/StateService';
import { MachineService } from '@services/MachineService';
import type { BackendGateway } from '@services/BackendGateway';
import type { MachineProfile } from '@core/types';

describe('machine selector program restoration', () => {
  const registry = ServiceRegistry.getInstance();

  afterEach(async () => {
    document.body.replaceChildren();
    await registry.disposeAll();
  });

  it('shows a restored machine even when it was excluded by the current filters', () => {
    const bus = new EventBus();
    const state = new StateService(bus, false);
    const machines: MachineProfile[] = [
      { machineName: 'MILL', machineType: 'MILL', controlType: 'FANUC', axes: [], feedLimits: { min: 0, max: 1 }, defaultTools: [], availableChannels: 1 },
      { machineName: 'TURN', machineType: 'TURN', controlType: 'SIEMENS', axes: [], feedLimits: { min: 0, max: 1 }, defaultTools: [], availableChannels: 2 },
    ];
    const machineService = new MachineService({} as BackendGateway, bus);
    machineService.getMachines = () => machines;
    state.setMachines(machines);
    state.setGlobalMachine('MILL');
    registry.register(EVENT_BUS_TOKEN, () => bus);
    registry.register(STATE_SERVICE_TOKEN, () => state);
    registry.register(MACHINE_SERVICE_TOKEN, () => machineService);
    const selector = new NCMachineSelector();
    document.body.append(selector);
    selector.shadowRoot!.querySelector<HTMLButtonElement>('[data-machine-type="mill"]')!.click();
    state.restoreProgramMachine('; @NCE-SIM:1 BEGIN SETUP\n; machineName="TURN"\n; @NCE-SIM:1 END SETUP');
    expect(state.getState().globalMachine).toBe('TURN');
    expect(selector.shadowRoot!.querySelector<HTMLSelectElement>('#selector')!.value).toBe('TURN');
    expect(selector.shadowRoot!.querySelector('[data-machine-type="all"]')!.classList.contains('active')).toBe(true);
  });
});
