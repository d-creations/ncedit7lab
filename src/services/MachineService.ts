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
      fileExtensions: data.fileExtensions,
    };
  }

  private getDefaultMachines(): MachineProfile[] {
    return [
      {
        machineName: 'FANUC_MILL',
        controlType: 'FANUC',
        axes: ['X', 'Y', 'Z'],
        feedLimits: { min: 0, max: 20000 },
        defaultTools: [],
        availableChannels: 1,
        regexPatterns: this.getFanucRegexPatterns(),
        variablePrefix: '#',
      },
      {
        machineName: 'SIEMENS_840D',
        controlType: 'SIEMENS',
        axes: ['X', 'Y', 'Z'],
        feedLimits: { min: 0, max: 20000 },
        defaultTools: [],
        availableChannels: 1,
        regexPatterns: this.getSiemensRegexPatterns(),
        variablePrefix: 'R',
      }
    ];
  }

  private getFanucRegexPatterns(): MachineRegexPatterns {
    return {
      tools: {
        pattern: 'T([1-9]|[1-9][0-9]{1,3})(?!\\d)',
        description: 'Tools T1-T9999',
        range: { min: 1, max: 9999 },
      },
      variables: {
        pattern: '#(\\d+)',
        description: 'Variables #1 - #9999',
        range: { min: 1, max: 9999 },
      },
      keywords: {
        pattern: '([A-Z])(\\s*[+-]?\\d+(?:\\.\\d+)?)',
        description: 'Standard Fanuc Keywords',
        codes: {
          g_codes: ['G0', 'G1', 'G2', 'G3'],
          program_control: ['M0', 'M1', 'M3', 'M5', 'M30'],
        },
      },
    };
  }

  private getSiemensRegexPatterns(): MachineRegexPatterns {
    return {
      tools: {
        pattern: 'T([1-9]|[1-9][0-9]{1,3})(?!\\d)',
        description: 'Tools T1-T9999',
        range: { min: 1, max: 9999 },
      },
      variables: {
        pattern: 'R(\\d+)',
        description: 'R Parameters',
        range: { min: 0, max: 9999 },
      },
      keywords: {
        pattern: '(?:CYCLE|POCKET|HOLES|SLOT)\\d+|WORKPIECE|([A-Z])(\\s*[+-]?\\d+(?:\\.\\d+)?)',
        description: 'Siemens Keywords and G-codes',
        codes: {
          g_codes: ['G0', 'G1', 'G2', 'G3'],
          program_control: ['M0', 'M1', 'M3', 'M5', 'M30', 'M17'],
        },
      },
    };
  }
}

