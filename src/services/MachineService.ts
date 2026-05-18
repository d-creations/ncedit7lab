// MachineService for managing machine profiles

import type {
  MachineProfile,
  MachineType,
  MachineRegexPatterns,
  ServerMachineData,
} from '@core/types';
import { BackendGateway } from './BackendGateway';
import { EventBus, EVENT_NAMES } from './EventBus';

export class MachineService {
  private machines: MachineProfile[] = [];
  private backend: BackendGateway;
  private eventBus: EventBus;

  constructor(backend: BackendGateway, eventBus: EventBus) {
    this.backend = backend;
    this.eventBus = eventBus;
  }

  async init(): Promise<void> {
    try {
      await this.fetchMachines();
    } catch (error) {
      console.error('Failed to fetch machines:', error);
      // Provide default machines as fallback
      this.machines = this.getDefaultMachines();
      this.eventBus.publish(EVENT_NAMES.ERROR_OCCURRED, {
        message: 'Failed to load machines from server, using defaults',
        error,
      });
    }
  }

  async fetchMachines(): Promise<MachineProfile[]> {
    const response = await this.backend.listMachines();
    this.machines = response.machines.map((data) => this.convertToMachineProfile(data));
    this.eventBus.publish(EVENT_NAMES.STATE_CHANGED, { machines: this.machines });
    return this.machines;
  }

  getMachines(): MachineProfile[] {
    return this.machines;
  }

  getMachine(machineType: MachineType): MachineProfile | undefined {
    return this.machines.find((m) => m.machineName === machineType);
  }

  private convertToMachineProfile(data: ServerMachineData): MachineProfile {
    return {
      machineName: data.machineName,
      controlType: data.controlType,
      axes: ['X', 'Y', 'Z'],
      feedLimits: { min: 0, max: 10000 },
      defaultTools: [],
      availableChannels: 3,
      regexPatterns: data.regexPatterns,
      variablePrefix: data.variablePrefix,
    };
  }

  private getDefaultMachines(): MachineProfile[] {
    const machineTypes: MachineType[] = [
      'FANUC_GENERIC',
      'SIEMENS_GENERIC',
    ];

    return machineTypes.map((machineType) => ({
      machineName: machineType,
      controlType: machineType === 'SIEMENS_GENERIC' ? 'SIEMENS' : 'FANUC',
      axes: ['X', 'Y', 'Z'],
      feedLimits: { min: 0, max: 10000 },
      defaultTools: [],
      availableChannels: 3,
      regexPatterns: this.getDefaultRegexPatterns(),
      variablePrefix: machineType === 'SIEMENS_GENERIC' ? 'R' : '#',
    }));
  }

  private getDefaultRegexPatterns(): MachineRegexPatterns {
    return {
      tools: {
        pattern: 'T([1-9]|[1-9][0-9])(?!\\d)',
        description: 'Tools T1-T99',
        range: { min: 1, max: 99 },
      },
      variables: {
        pattern: '#([1-9]|[1-9][0-9]{1,2})(?!\\d)',
        description: 'Variables #1 - #999',
        range: { min: 1, max: 999 },
      },
      keywords: {
        pattern:
          '(T(100|[1-9][0-9]{2,3})|M(2[0-9]{2}|[3-8][0-8]{2})|M82|M83|M20|G[0-3]|M(0|1|3|5|30))',
        description: 'Keywords: T100-T9999, M200-M888, M82, M83, M20, G0-G3, M0, M1, M3, M5, M30',
        codes: {
          extended_tools: {
            pattern: 'T(100|[1-9][0-9]{2,3})',
            description: 'Extended tools',
            range: { min: 100, max: 9999 },
          },
          m_codes_range: {
            pattern: 'M(2[0-9]{2}|[3-8][0-8]{2})',
            description: 'M codes range',
            range: { min: 200, max: 888 },
          },
          special_m_codes: ['M82', 'M83', 'M20'],
          g_codes: ['G0', 'G1', 'G2', 'G3'],
          program_control: ['M0', 'M1', 'M3', 'M5', 'M30'],
        },
      },
    };
  }
}
