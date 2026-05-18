export interface BackendFeatures {
  focas_enabled: boolean;
  cgi_path: string;
}

// Core type definitions for NC-Edit7

export type ChannelId = '1' | '2' | '3';

export type MachineType = string;

export interface PatternRange {
  min: number;
  max: number;
}

export interface PatternDefinition {
  pattern: string;
  description: string;
  range?: PatternRange;
}

export interface KeywordCodes {
  extended_tools?: PatternDefinition;
  m_codes_range?: PatternDefinition;
  special_m_codes?: string[];
  g_codes?: string[];
  program_control?: string[];
}

export interface KeywordPatternDefinition extends PatternDefinition {
  codes?: KeywordCodes;
}

export interface MachineRegexPatterns {
  tools: PatternDefinition;
  variables: PatternDefinition;
  keywords: KeywordPatternDefinition;
}

export interface MachineProfile {
  machineName: MachineType;
  controlType: string;
  axes: string[];
  feedLimits: { min: number; max: number };
  defaultTools: ToolInfo[];
  kinematics?: unknown;
  availableChannels: number;
  regexPatterns?: MachineRegexPatterns;
  variablePrefix?: string;
}

export interface ToolInfo {
  toolNumber: number;
  geometry: ToolGeometry;
  usage?: ToolUsage;
}

export interface ToolGeometry {
  diameter: number;
  length: number;
  cornerRadius?: number;
  angle?: number;
}

export interface ToolUsage {
  operationType: string;
  feedRate: number;
  spindleSpeed: number;
}

export interface ToolRegisterEntry {
  toolNumber: number | string;
  qParameter?: number;
  rParameter?: number;
}

export interface ChannelState {
  id: ChannelId;
  active: boolean;
  program: string;
  machineProfile?: MachineProfile;
  timeline?: ChannelTimeline;
  parseResult?: NcParseResult;
  parseArtifacts?: ParseArtifacts;
  executedResult?: ExecutedProgramResult;
}

export interface ChannelTimeline {
  lines: number[];
  syncMarkers: SyncEvent[];
  timingData: Map<number, number>;
}

export interface SyncEvent {
  lineNumber: number;
  code: string;
  channels: ChannelId[];
  timingOffset?: number;
}

export interface NcParseResult {
  faultDetected: boolean;
  faults?: FaultDetail[];
}

export interface FaultDetail {
  lineNumber: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface ParseArtifacts {
  keywords: KeywordEntry[];
  variableSnapshot: Map<number, number>;
  toolRegisters: ToolRegisterEntry[];
  timingMetadata: TimingMetadata[];
}

export interface KeywordEntry {
  keyword: string;
  lineNumber: number;
  description?: string;
}

export interface TimingMetadata {
  lineNumber: number;
  executionTime: number;
}

export interface ExecutedProgramResult {
  executedLines: number[];
  variableSnapshot: Map<number, number>;
  timingData: Map<number, number>;
  plotMetadata?: PlotMetadata;
  errors?: FaultDetail[];
}

export interface PlotMetadata {
  points: PlotPoint[];
  segments: PlotSegment[];
}

export interface PlotPoint {
  x: number;
  y: number;
  z: number;
  lineNumber?: number;
}

export interface PlotSegment {
  startPoint: PlotPoint;
  endPoint: PlotPoint;
  type: 'rapid' | 'feed' | 'arc';
  toolNumber?: number;
  channelId?: ChannelId;
}

export interface ToolValue {
  toolNumber: number | string;
  qValue?: number;
  rValue?: number;
}

export interface CustomVariable {
  name: string;
  value: number;
}

export interface PlotRequest {
  machinedata: Array<{
    program: string;
    machineName: MachineType;
    canalNr: string | number;
    toolValues?: ToolValue[];
    customVariables?: CustomVariable[];
  }>;
}

export interface PlotResponse {
  canal?: unknown;
  message?: string | string[];
  errors?: Array<{
    type: string;
    code: number;
    line: number;
    message: string;
    value: string;
    canal: number;
  }>;
  success?: boolean;
}

export interface ServerMachineListRequest {
  action: 'list_machines' | 'get_machines';
}

export interface ServerMachineData {
  machineName: MachineType;
  controlType: string;
  variablePrefix?: string;
  regexPatterns?: MachineRegexPatterns;
}

export interface ServerMachineListResponse {
  machines: ServerMachineData[];
  success?: boolean;
}

export interface NCFile {
  id: string;
  name: string;
  content: string;
  channels: string[];
  isMultiChannel: boolean;
  lastModified: number;
  machineType?: MachineType | string;
}

export interface NCProgram {
  id: string;
  name: string;
  content: string;
  channelId: string;
  sourceFileId: string;
  lastModified: number;
}

export interface FocasProgram {
  number: number;
  length: number;
  comment: string;
}

export interface FocasListResponse {
  status: string;
  programs: FocasProgram[];
}

export interface FocasPingResponse {
  status: string;
  available: boolean;
  error?: string;
}

export interface FocasUploadResponse {
  status: string;
  program_text: string;
}

export interface FocasDownloadResponse {
  status: string;
  message: string;
}
