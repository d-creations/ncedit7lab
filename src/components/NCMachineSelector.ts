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
  private machineTypeFilter: 'all' | 'mill' | 'turn' = 'all';
  private controlTypeFilter: 'all' | 'fanuc' | 'siemens' = 'all';

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
        .machine-selector-controls {
          display: flex;
          gap: 4px;
          align-items: center;
        }
        select {
          padding: 4px 8px;
          background: #3c3c3c;
          color: #d4d4d4;
          border: 1px solid #555;
          border-radius: 4px;
          cursor: pointer;
        }
        .machine-type-filter {
          display: flex;
          border: 1px solid #555;
          border-radius: 4px;
          overflow: hidden;
        }
        .control-type-filter {
          display: flex;
          border: 1px solid #555;
          border-radius: 4px;
          overflow: hidden;
        }
        .tool-path-mode {
          padding: 4px 6px;
          border: 1px solid #555;
          border-radius: 4px;
          color: #d4d4d4;
          font-size: 11px;
          white-space: nowrap;
        }
        .control-type-filter button {
          min-width: 36px;
          padding: 4px 6px;
          background: #2d2d2d;
          color: #d4d4d4;
          border: 0;
          border-right: 1px solid #555;
          cursor: pointer;
          font-size: 11px;
        }
        .control-type-filter button:last-child {
          border-right: 0;
        }
        .control-type-filter button.active {
          background: var(--vscode-button-background, #007acc);
          color: var(--vscode-button-foreground, #ffffff);
        }
        .machine-type-filter button {
          min-width: 36px;
          padding: 4px 6px;
          background: #2d2d2d;
          color: #d4d4d4;
          border: 0;
          border-right: 1px solid #555;
          cursor: pointer;
          font-size: 11px;
        }
        .machine-type-filter button:last-child {
          border-right: 0;
        }
        .machine-type-filter button.active {
          background: var(--vscode-button-background, #007acc);
          color: var(--vscode-button-foreground, #ffffff);
        }

        /* Mobile styles - make select bigger */
        @media (max-width: 768px) {
          select {
            padding: 8px 12px;
            font-size: 16px;
            min-height: 40px;
            min-width: 120px;
          }
          .machine-type-filter button,
          .control-type-filter button {
            min-height: 40px;
            padding: 8px;
            font-size: 13px;
          }
        }
      </style>
      <div class="machine-selector-controls">
        <select id="selector">
          <option value="">Select Machine...</option>
        </select>
        <span class="tool-path-mode" title="Plots always request the tool-center path; accuracy depends on backend support">Center path</span>
        <div class="machine-type-filter" role="group" aria-label="Machine type filter">
          <button type="button" data-machine-type="all" class="active" title="Show all machines">All</button>
          <button type="button" data-machine-type="mill" title="Show mill machines">Mill</button>
          <button type="button" data-machine-type="turn" title="Show turn and turn-mill machines">Turn</button>
        </div>
        <div class="control-type-filter" role="group" aria-label="Control type filter">
          <button type="button" data-control-type="all" class="active" title="Show all controls">All</button>
          <button type="button" data-control-type="fanuc" title="Show FANUC controls">Fanuc</button>
          <button type="button" data-control-type="siemens" title="Show Siemens controls">Siemens</button>
        </div>
      </div>
    `;
  }

  private updateOptions() {
    const selector = this.shadowRoot?.getElementById('selector') as HTMLSelectElement;
    if (!selector) return;

    const machines = this.getFilteredMachines();
    const currentState = this.stateService.getState();
    const currentMachine = currentState.globalMachine;

    selector.innerHTML = '<option value="">Select Machine...</option>';

    machines.forEach((machine) => {
      const option = document.createElement('option');
      option.value = machine.machineName;
      option.textContent = machine.machineName;
      selector.appendChild(option);
    });

    const selectedMachine = machines.find((machine) => machine.machineName === currentMachine) ?? machines[0];
    if (selectedMachine) {
      selector.value = selectedMachine.machineName;
      if (selectedMachine.machineName !== currentMachine) {
        this.stateService.setGlobalMachine(selectedMachine.machineName);
      }
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

    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-machine-type]').forEach((button) => {
      button.addEventListener('click', () => {
        this.machineTypeFilter = button.dataset.machineType as 'all' | 'mill' | 'turn';
        this.shadowRoot?.querySelectorAll('[data-machine-type]').forEach((filterButton) => {
          filterButton.classList.toggle('active', filterButton === button);
        });
        this.ensureCompatibleFilters('machine-type');
        this.updateOptions();
      });
    });

    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-control-type]').forEach((button) => {
      button.addEventListener('click', () => {
        this.controlTypeFilter = button.dataset.controlType as 'all' | 'fanuc' | 'siemens';
        this.shadowRoot?.querySelectorAll('[data-control-type]').forEach((filterButton) => {
          filterButton.classList.toggle('active', filterButton === button);
        });
        this.ensureCompatibleFilters('control-type');
        this.updateOptions();
      });
    });
  }

  private matchesMachineTypeFilter(machine: MachineProfile): boolean {
    if (this.machineTypeFilter === 'all') return true;

    const machineType = machine.machineType?.toUpperCase() ?? '';
    return this.machineTypeFilter === 'mill'
      ? machineType === 'MILL'
      : machineType === 'TURN' || machineType === 'TURN_MILL';
  }

  private getFilteredMachines(): MachineProfile[] {
    return this.machineService.getMachines().filter((machine) =>
      this.matchesMachineTypeFilter(machine) && this.matchesControlTypeFilter(machine),
    );
  }

  private ensureCompatibleFilters(lastChanged: 'machine-type' | 'control-type'): void {
    if (this.machineService.getMachines().length === 0 || this.getFilteredMachines().length > 0) return;

    if (lastChanged === 'machine-type') {
      this.controlTypeFilter = 'all';
      this.updateActiveFilterButton('[data-control-type]', 'controlType', 'all');
    } else {
      this.machineTypeFilter = 'all';
      this.updateActiveFilterButton('[data-machine-type]', 'machineType', 'all');
    }
  }

  private updateActiveFilterButton(selector: string, dataKey: 'controlType' | 'machineType', value: string): void {
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>(selector).forEach((button) => {
      button.classList.toggle('active', button.dataset[dataKey] === value);
    });
  }

  private matchesControlTypeFilter(machine: MachineProfile): boolean {
    return this.controlTypeFilter === 'all'
      || machine.controlType?.toUpperCase() === this.controlTypeFilter.toUpperCase();
  }
}

customElements.define('nc-machine-selector', NCMachineSelector);
