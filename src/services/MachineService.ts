// MachineService for managing machine profiles

import type {
  MachineProfile,
  MachineType,
  ServerMachineData,
  ServerToolSelectionPolicy,
  ToolSelectionPolicy,
} from '@core/types';
import { BackendGateway } from './BackendGateway';
import { EventBus, EVENT_NAMES } from './EventBus';

function toToolSelectionPolicy(
  source?: ServerToolSelectionPolicy,
): ToolSelectionPolicy | undefined {
  if (!source) return undefined;

  return {
    mode: source.mode,
    namedTools: source.named_tools ?? false,
    offsetScope: source.offset_scope ?? 'global',
    offsetAddress: source.offset_address,
    offsetDigits: source.offset_digits,
    subtoolCodes: source.subtool_codes,
  };
}

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
      machineType: data.machineType,
      axes: ['X', 'Y', 'Z'],
      feedLimits: { min: 0, max: 10000 },
      defaultTools: [],
      availableChannels: 3,
      regexPatterns: data.regexPatterns,
      toolSelection: toToolSelectionPolicy(data.toolSelection),
      variablePrefix: data.variablePrefix,
      fileExtensions: data.fileExtensions,
      simulationCommentSyntax: data.simulationCommentSyntax,
    };
  }

  private getDefaultMachines(): MachineProfile[] {
    return [
    ];
  }
}

