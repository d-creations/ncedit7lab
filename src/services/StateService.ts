// StateService for central application state management

import type { ChannelId, ChannelState, MachineProfile, MachineType } from '@core/types';
import { EventBus, EVENT_NAMES } from './EventBus';

export interface AppState {
  machines: MachineProfile[];
  channels: Map<ChannelId, ChannelState>;
  activeMachine?: MachineProfile;
  globalMachine?: MachineType;
  uiSettings: UISettings;
  workbenchSelectedChannel: ChannelId;
  activeFileId?: string | null;
  activeProgramIds: Map<string, string>; // channelId -> programId
}

export interface UISettings {
  timeGutterPosition: 'left' | 'right';
  keywordListPosition: 'left' | 'right';
  variableDrawerOpen: boolean;
  toolOverlayOpen: boolean;
  plotViewerOpen: boolean;
  plotViewerWidth: number;
}

export class StateService {
  private state: AppState;
  private pastStates: string[] = [];
  private futureStates: string[] = [];
  private readonly MAX_HISTORY = 50;

  private eventBus: EventBus;

  constructor(eventBus: EventBus, private useLocalStorage: boolean = true) {
    this.eventBus = eventBus;
    this.state = this.getInitialState();
    if (this.useLocalStorage) {
      this.loadFromStorage();
    }
  }

  private saveStateToHistory(): void {
    // Stringify current state to save a snapshot
    const snapshot = this.serializeState(this.state);
    this.pastStates.push(snapshot);
    if (this.pastStates.length > this.MAX_HISTORY) {
      this.pastStates.shift();
    }
    this.futureStates = []; // clear future on new action
  }

  public undo(): void {
    if (this.pastStates.length === 0) return;
    const currentStateSnapshot = this.serializeState(this.state);
    this.futureStates.push(currentStateSnapshot);
    
    const previousStateSnapshot = this.pastStates.pop()!;
    this.state = this.deserializeState(previousStateSnapshot);
    
    this.persistState();
    this.notifyStateRestored();
  }

  public redo(): void {
    if (this.futureStates.length === 0) return;
    const currentStateSnapshot = this.serializeState(this.state);
    this.pastStates.push(currentStateSnapshot);
    
    const nextStateSnapshot = this.futureStates.pop()!;
    this.state = this.deserializeState(nextStateSnapshot);
    
    this.persistState();
    this.notifyStateRestored();
  }

  private notifyStateRestored(): void {
    this.eventBus.publish(EVENT_NAMES.STATE_CHANGED, { state: this.state });
    if (this.state.activeMachine) {
        this.eventBus.publish(EVENT_NAMES.MACHINE_CHANGED, { machine: this.state.activeMachine });
    }
    // Fire other necessary updates here if needed
  }

  private persistState(): void {
    if (!this.useLocalStorage) return;
    try {
      localStorage.setItem('nc-app-state', this.serializeState(this.state));
    } catch(e) {
      console.error("Failed to persist app state", e);
    }
  }

  private loadFromStorage(): void {
    try {
      const stored = localStorage.getItem('nc-app-state');
      if (stored) {
        this.state = { ...this.state, ...this.deserializeState(stored) };
      }
    } catch(e) {
      console.error("Failed to load app state", e);
    }
  }

  private serializeState(state: AppState): string {
    // Map doesn't serialize natively, convert mappings
    return JSON.stringify({
      ...state,
      channels: Array.from(state.channels.entries()),
      activeProgramIds: Array.from(state.activeProgramIds.entries())
    });
  }

  private deserializeState(jsonStr: string): AppState {
    const raw = JSON.parse(jsonStr);
    return {
      ...raw,
      channels: new Map(raw.channels),
      activeProgramIds: new Map(raw.activeProgramIds || [])
    };
  }

  private getInitialState(): AppState {
    return {
      machines: [],
      channels: new Map([
        ['1', this.createChannelState('1')],
        ['2', this.createChannelState('2', false)],
        ['3', this.createChannelState('3', false)],
      ]),
      activeProgramIds: new Map(),
      workbenchSelectedChannel: '1',
      uiSettings: {
        timeGutterPosition: 'left',
        keywordListPosition: 'left',
        variableDrawerOpen: false,
        toolOverlayOpen: false,
        plotViewerOpen: false,
        plotViewerWidth: 400,
      },
    };
  }

  private createChannelState(id: ChannelId, active = true): ChannelState {
    return {
      id,
      active: active,
      program: '',
    };
  }

  getState(): Readonly<AppState> {
    return this.state;
  }

  getChannel(id: ChannelId): ChannelState | undefined {
    return this.state.channels.get(id);
  }

  updateChannel(id: ChannelId, updates: Partial<ChannelState>): void {
    this.saveStateToHistory();
    const channel = this.state.channels.get(id);
    if (!channel) return;

    const updatedChannel = { ...channel, ...updates };
    this.state.channels.set(id, updatedChannel);
    this.persistState();
    this.eventBus.publish(EVENT_NAMES.STATE_CHANGED, { channel: updatedChannel });
  }

  activateChannel(id: ChannelId): void {
    const channel = this.state.channels.get(id);
    if (!channel || channel.active) return;

    this.updateChannel(id, { active: true });
    this.eventBus.publish(EVENT_NAMES.CHANNEL_ACTIVATED, { channelId: id });
  }

  deactivateChannel(id: ChannelId): void {
    const channel = this.state.channels.get(id);
    if (!channel || !channel.active) return;

    this.updateChannel(id, { active: false });

    if (this.state.workbenchSelectedChannel === id) {
      const nextActiveChannel = this.getActiveChannels().find((activeChannel) => activeChannel.id !== id);
      if (nextActiveChannel) {
        this.setWorkbenchSelectedChannel(nextActiveChannel.id);
      }
    }

    this.eventBus.publish(EVENT_NAMES.CHANNEL_DEACTIVATED, { channelId: id });
  }

  setMachines(machines: MachineProfile[]): void {
    this.state.machines = machines;
    this.persistState();
    this.eventBus.publish(EVENT_NAMES.STATE_CHANGED, { machines });
  }

  setGlobalMachine(machineType: MachineType): void {
    this.saveStateToHistory();
    this.state.globalMachine = machineType;
    const machine = this.state.machines.find((m) => m.machineName === machineType);
    if (machine) {
      this.state.activeMachine = machine;
      this.persistState();
      this.eventBus.publish(EVENT_NAMES.MACHINE_CHANGED, { machine });
    }
  }

  updateUISettings(settings: Partial<UISettings>): void {
    this.saveStateToHistory();
    this.state.uiSettings = { ...this.state.uiSettings, ...settings };
    this.persistState();
    this.eventBus.publish(EVENT_NAMES.STATE_CHANGED, { uiSettings: this.state.uiSettings });
  }

  getActiveChannels(): ChannelState[] {
    return Array.from(this.state.channels.values()).filter((ch) => ch.active);
  }

  getWorkbenchSelectedChannel(): ChannelId {
    return this.state.workbenchSelectedChannel;
  }

  setWorkbenchSelectedChannel(channelId: ChannelId): void {
    if (this.state.workbenchSelectedChannel === channelId) return;

    this.saveStateToHistory();
    this.state.workbenchSelectedChannel = channelId;
    this.persistState();
    this.eventBus.publish(EVENT_NAMES.STATE_CHANGED, { workbenchSelectedChannel: channelId });
  }
  
  setActiveProgramId(channelId: string, programId: string): void {
    this.saveStateToHistory();
    this.state.activeProgramIds.set(channelId, programId);
    this.persistState();
    this.eventBus.publish(EVENT_NAMES.STATE_CHANGED, { activeProgramIds: this.state.activeProgramIds });
  }

  getActiveProgramId(channelId: string): string | undefined {
    return this.state.activeProgramIds.get(channelId);
  }

  setActiveFileId(fileId: string | null): void {
    this.saveStateToHistory();
    this.state.activeFileId = fileId;
    this.persistState();
    this.eventBus.publish(EVENT_NAMES.STATE_CHANGED, { activeFileId: this.state.activeFileId });
  }
}
