import type { SimulationCommentSyntax } from '../services/tools/SimulationCommentCodec';

export interface BackendFeatures {
  transfer_enabled: boolean;
  transfer_protocols?: string[];
  cgi_path: string;
}

// Core type definitions for NC-Edit7

export type ChannelId = '1' | '2' | '3';

export type MachineType = string;

/** Application plot modes. Simulation is sent as center mode plus pose metadata. */
export type ToolPathMode = 'effective' | 'center' | 'simulation';

export const WORKPIECE_TOOL_REFERENCE_POSE_CONTRACT = 'workpiece-tool-reference-v1';
export type ToolReference = 'millingTip' | 'turningVirtualTip';

export interface MachineSimulationRotationJoint {
  axisId: string;
  axis: [number, number, number];
  sign: -1 | 1;
  zeroDegrees: number;
}

export interface MachineSimulationCarrier {
  id: string;
  role: 'tool' | 'workpiece';
  referenceOrientationDegrees: [number, number, number];
  rotationChain: MachineSimulationRotationJoint[];
}

export interface MachineSimulationToolMount {
  channelId: ChannelId;
  tools: { kind: 'numericRange'; from: number; to: number } |
    { kind: 'identifiers'; values: Array<number | string> };
  carrierId: string;
  target: { mode: 'fixed'; workpieceCarrierId: string } |
    { mode: 'execution'; allowedWorkpieceCarrierIds: string[] };
}

export interface MachineSimulationConfig {
  schemaVersion: 1;
  revision: number;
  modelId: string;
  displayName: string;
  fidelity: 'demo' | 'configured';
  poseContract: typeof WORKPIECE_TOOL_REFERENCE_POSE_CONTRACT;
  carriers: MachineSimulationCarrier[];
  toolMounts: MachineSimulationToolMount[];
}

export interface SimulationToolInput {
  toolNumber: number | string;
  reference: ToolReference;
  mountingOrientationDegrees: [number, number, number];
}

export interface SimulationChannelInput {
  profileRevision: string;
  tools: SimulationToolInput[];
}

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

export interface ToolSelectionPolicy {
  mode: 'direct' | 'packed' | 'station' | 'star';
  namedTools: boolean;
  offsetScope: 'global' | 'tool';
  offsetAddress?: string;
  toolDigits?: number;
  offsetDigits?: number;
  subtoolCodes?: number[];
}

export interface ServerToolSelectionPolicy {
  mode: ToolSelectionPolicy['mode'];
  named_tools?: boolean;
  offset_scope?: ToolSelectionPolicy['offsetScope'];
  offset_address?: string;
  tool_digits?: number;
  offset_digits?: number;
  subtool_codes?: number[];
}

export interface MachineProfile {
  /** Explicit read capability only; does not authorize header insertion or conversion. */
  simulationCommentSyntax?: SimulationCommentSyntax;
  machineName: MachineType;
  controlType: string;
  machineType?: string;
  axes: string[];
  feedLimits: { min: number; max: number };
  defaultTools: ToolInfo[];
  kinematics?: unknown;
  availableChannels: number;
  profileRevision?: string;
  supportedPoseContracts?: string[];
  simulation?: MachineSimulationConfig;
  regexPatterns?: MachineRegexPatterns;
  toolSelection?: ToolSelectionPolicy;
  variablePrefix?: string;
  fileExtensions?: FileExtensionConfig;
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
  namedVariableSnapshot: Map<string, VariableValue>;
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
  namedVariableSnapshot: Map<string, VariableValue>;
  timingData: Map<number, number>;
  plotMetadata?: PlotMetadata;
  errors?: FaultDetail[];
}

export type VariableValue = number | string | boolean;

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

/** Immutable raw state captured by the engine when a motion primitive is emitted. */
export interface MotionContext {
  channelId: string;
  startAxes: Record<string, number>;
  endAxes: Record<string, number>;
  toolCarrierId?: string;
  targetCarrierId?: string;
  targetAxis?: string;
  toolOffset: {
    number?: number;
    radiusMode?: string;
    radius?: number;
    tipOrientation?: number;
    edgeNumber?: number;
  };
}

export interface PoseSample {
  position: readonly [number, number, number];
  orientation: readonly [number, number, number, number];
  reference: 'millingTip' | 'turningVirtualTip';
  frameId: string;
}

export interface PlotSegment {
  startPoint: PlotPoint;
  endPoint: PlotPoint;
  type: 'rapid' | 'feed' | 'arc';
  /** Active tool captured by execution; "unknown", null and missing mean unavailable. */
  toolNumber?: number | string | null;
  /** Executed-command occurrence within the channel, shared by generated cycle moves. */
  executionStep?: number | null;
  /** Original backend segment ordinal within the channel, before motion filtering. */
  sourceSegmentIndex?: number;
  /** Adjacent-point-pair ordinal within the original backend segment. */
  subsegmentIndex?: number;
  channelId?: ChannelId;
  motionContext?: MotionContext;
  /** Pose samples emitted for the originating backend primitive. */
  poses?: readonly PoseSample[];
}

export interface ToolValue {
  toolNumber: number | string;
  qValue?: number;
  rValue?: number;
  lengthValue?: number;
  edgeNumber?: number;
}

export interface ToolOffsetValue {
  offsetNumber: number;
  toolNumber?: number | string;
  qValue?: number;
  rValue?: number;
  lengthValue?: number;
  edgeNumber?: number;
}

export interface CustomVariable {
  name: string;
  value: number;
}

export interface PlotRequest {
  toolPathMode: 'effective' | 'center';
  poseContract?: typeof WORKPIECE_TOOL_REFERENCE_POSE_CONTRACT;
  machinedata: Array<{
    program: string;
    machineName: MachineType;
    canalNr: string | number;
    toolValues?: ToolValue[];
    toolOffsets?: ToolOffsetValue[];
    customVariables?: CustomVariable[];
    simulation?: SimulationChannelInput;
  }>;
}

/** Raw motion metadata from the backend; identifiers must not be inferred from NC text. */
export interface BackendPlotSegment {
  geometry?: string;
  traversal?: string;
  sourceCode?: string;
  lineNumber?: number;
  toolNumber?: number | string | null;
  executionStep?: number | null;
  motionContext?: MotionContext;
  poses?: readonly PoseSample[];
  points?: Array<{ x: number; y: number; z: number }>;
  /** Legacy classification is retained for compatibility, not used to infer motion semantics. */
  type?: string;
}

export interface BackendPlotChannel {
  segments?: BackendPlotSegment[];
  executedLines?: number[];
  variables?: Record<string, number>;
  namedVariables?: Record<string, VariableValue>;
  timing?: number[];
  errors?: PlotResponse['errors'];
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

export interface FileExtensionConfig {
  /** Whether this machine uses multi-file / multi-channel programs (PA concept). */
  multifile: boolean;
  /** File extensions for main programs, e.g. [".PA", ".txt", ""]. */
  main: string[];
  /** File extensions for subprograms, e.g. [".SPF"]. */
  subprogram: string[];
  /** Per-channel file extensions keyed by channel number string, e.g. {"1": [".PA",".P1"], "2": [".P2"]}. */
  channels: Record<string, string[]>;
}

export interface ServerMachineData {
  simulationCommentSyntax?: SimulationCommentSyntax;
  machineName: MachineType;
  controlType: string;
  machineType?: string;
  axes: string[];
  availableChannels: number;
  profileRevision: string;
  supportedPoseContracts: string[];
  simulation?: MachineSimulationConfig;
  variablePrefix?: string;
  regexPatterns?: MachineRegexPatterns;
  toolSelection?: ServerToolSelectionPolicy;
  fileExtensions?: FileExtensionConfig;
}

export interface ServerMachineListResponse {
  machines: ServerMachineData[];
  success?: boolean;
}

export interface LineAlignmentTemplate {
  syntax: string;
  selectors?: string[];
  example?: Record<string, string>;
}

export interface LineAlignmentSyntaxDefinition {
  controlType: string;
  waitCodeRange?: PatternRange;
  twoChannel?: LineAlignmentTemplate;
  threeChannel?: LineAlignmentTemplate;
  syntax?: string;
  example?: Record<string, string>;
}

export interface LineAlignmentSyntaxResponse {
  lineAlignmentSyntax: LineAlignmentSyntaxDefinition[];
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

export interface TransferProgram {
  number: number;
  length: number;
  comment: string;
  file_extension?: string;
}

export interface TransferListResponse {
  status: string;
  programs: TransferProgram[];
}

export interface TransferPingResponse {
  status: string;
  available: boolean;
  error?: string;
}

export interface TransferUploadResponse {
  status: string;
  program_text: string;
}

export interface TransferDownloadResponse {
  status: string;
  message: string;
}
