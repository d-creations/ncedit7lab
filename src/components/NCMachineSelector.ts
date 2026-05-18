import { ServiceRegistry } from '@core/ServiceRegistry';
import { MACHINE_SERVICE_TOKEN, STATE_SERVICE_TOKEN, EVENT_BUS_TOKEN } from '@core/ServiceTokens';
import { MachineService } from '@services/MachineService';
import { StateService } from '@services/StateService';
import { EventBus, EVENT_NAMES } from '@services/EventBus';
import type { MachineType, MachineProfile } from '@core/types';

export class NCMachineSelector extends HTMLElement {
  private machineService: MachineService;
  private stateService: StateService;
  private eventBus: EventBus;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.machineService = ServiceRegistry.getInstance().get(MACHINE_SERVICE_TOKEN);
    this.stateService = ServiceRegistry.getInstance().get(STATE_SERVICE_TOKEN);
    this.eventBus = ServiceRegistry.getInstance().get(EVENT_BUS_TOKEN);
  }

  connectedCallback() {
    this.render();
    this.updateOptions();
    this.attachEventListeners();

    // Listen for state changes to update the machine list when machines are fetched
    this.eventBus.subscribe(EVENT_NAMES.STATE_CHANGED, (data: { machines?: MachineProfile[] }) => {
      if (data.machines) {
        this.updateOptions();
      }
    });

    this.eventBus.subscribe(EVENT_NAMES.MACHINE_CHANGED, (data: { machine: MachineProfile }) => {
        this.updateSelection(data.machine.machineName);
    });

    const currentState = this.stateService.getState();
    if (currentState.globalMachine) {
        this.updateSelection(currentState.globalMachine);
    }
  }

  private updateSelection(machineName: string) {
      if (!this.shadowRoot) return;
      const selector = this.shadowRoot.getElementById('selector') as HTMLSelectElement;
      if (selector) {
          selector.value = machineName;
      }
  }

  private render() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-block;
        }
        select {
          padding: 4px 8px;
          background: #3c3c3c;
          color: #d4d4d4;
          border: 1px solid #555;
          border-radius: 4px;
          cursor: pointer;
        }

        /* Mobile styles - make select bigger */
        @media (max-width: 768px) {
          select {
            padding: 8px 12px;
            font-size: 16px;
            min-height: 40px;
            min-width: 120px;
          }
        }
      </style>
      <select id="selector">
        <option value="">Select Machine...</option>
      </select>
    `;
  }

  private updateOptions() {
    const selector = this.shadowRoot?.getElementById('selector') as HTMLSelectElement;
    if (!selector) return;

    const machines = this.machineService.getMachines();
    const currentState = this.stateService.getState();
    const currentMachine = currentState.globalMachine;

    selector.innerHTML = '<option value="">Select Machine...</option>';

    machines.forEach((machine) => {
      const option = document.createElement('option');
      option.value = machine.machineName;
      option.textContent = machine.machineName;
      selector.appendChild(option);
    });

    if (currentMachine) {
        selector.value = currentMachine;
    }
  }

  private attachEventListeners() {
    const selector = this.shadowRoot?.getElementById('selector') as HTMLSelectElement;
    selector?.addEventListener('change', (e) => {
      const target = e.target as HTMLSelectElement;
      const machineType = target.value as MachineType;
      if (machineType) {
        this.stateService.setGlobalMachine(machineType);
      }
    });
  }
}

customElements.define('nc-machine-selector', NCMachineSelector);
