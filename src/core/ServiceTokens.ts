import { createServiceToken } from './ServiceRegistry';
import { EventBus } from '../services/EventBus';
import { StateService } from '../services/StateService';
import { BackendGateway } from '../services/BackendGateway';
import { MachineService } from '../services/MachineService';
import { ParserService } from '../services/ParserService';
import { DiagnosticsService } from '../services/DiagnosticsService';
import { ExecutedProgramService } from '../services/ExecutedProgramService';
import { PlotService } from '../services/PlotService';
import { IHostBridgeService } from '../services/HostBridgeService';

import { IFileManagerService } from '../services/IFileManagerService';
import { IConfigService } from '../services/config/IConfigService';

export const EVENT_BUS_TOKEN = createServiceToken<EventBus>('EventBus');
export const FILE_MANAGER_SERVICE_TOKEN = createServiceToken<IFileManagerService>('FileManagerService');
export const CONFIG_SERVICE_TOKEN = createServiceToken<IConfigService>('ConfigService');
export const STATE_SERVICE_TOKEN = createServiceToken<StateService>('StateService');
export const BACKEND_GATEWAY_TOKEN = createServiceToken<BackendGateway>('BackendGateway');
export const MACHINE_SERVICE_TOKEN = createServiceToken<MachineService>('MachineService');
export const PARSER_SERVICE_TOKEN = createServiceToken<ParserService>('ParserService');
export const DIAGNOSTICS_SERVICE_TOKEN =
  createServiceToken<DiagnosticsService>('DiagnosticsService');
export const EXECUTED_PROGRAM_SERVICE_TOKEN =
  createServiceToken<ExecutedProgramService>('ExecutedProgramService');
export const PLOT_SERVICE_TOKEN = createServiceToken<PlotService>('PlotService');
export const HOST_BRIDGE_SERVICE_TOKEN = createServiceToken<IHostBridgeService>('HostBridgeService');
