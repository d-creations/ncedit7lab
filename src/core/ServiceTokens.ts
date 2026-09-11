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
import type { ITemplateRepository } from '../services/templates/ITemplateRepository';
import { TemplateCatalogService } from '../services/templates/TemplateCatalogService';
import { TemplateInsertionService } from '../services/templates/TemplateInsertionService';
import { MultichannelAlignmentService } from '../services/MultichannelAlignmentService';
import { SimulationCommentCodec } from '../services/tools/SimulationCommentCodec';
import { ProgramToolService } from '../services/tools/ProgramToolService';
import type { IToolLibraryRepository } from '../services/tools/ToolLibraryTypes';
import { ToolCatalogService } from '../services/tools/ToolCatalogService';
import { ProgramMetadataEditService } from '../services/tools/ProgramMetadataEditService';

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
export const TEMPLATE_REPOSITORY_TOKEN = createServiceToken<ITemplateRepository>('TemplateRepository');
export const TEMPLATE_CATALOG_SERVICE_TOKEN = createServiceToken<TemplateCatalogService>('TemplateCatalogService');
export const TEMPLATE_INSERTION_SERVICE_TOKEN = createServiceToken<TemplateInsertionService>('TemplateInsertionService');
export const MULTICHANNEL_ALIGNMENT_SERVICE_TOKEN =
  createServiceToken<MultichannelAlignmentService>('MultichannelAlignmentService');
export const SIMULATION_COMMENT_CODEC_TOKEN = createServiceToken<SimulationCommentCodec>('SimulationCommentCodec');
export const PROGRAM_TOOL_SERVICE_TOKEN = createServiceToken<ProgramToolService>('ProgramToolService');
export const TOOL_LIBRARY_REPOSITORY_TOKEN = createServiceToken<IToolLibraryRepository>('ToolLibraryRepository');
export const TOOL_CATALOG_SERVICE_TOKEN = createServiceToken<ToolCatalogService>('ToolCatalogService');
export const PROGRAM_METADATA_EDIT_SERVICE_TOKEN = createServiceToken<ProgramMetadataEditService>('ProgramMetadataEditService');
