import type { ChannelId, MachineType } from '@core/types';

export type TemplateSource = 'bundled' | 'workspace' | 'user';

export type TemplateInsertMode =
  | 'insertAtCursor'
  | 'replaceSelection'
  | 'appendToDocument'
  | 'replaceDocument'
  | 'newProgram';

export interface TemplateMachineMatcher {
  machineNames?: MachineType[];
  controlTypes?: string[];
}

export interface TemplateDefinition {
  id: string;
  name: string;
  description?: string;
  category: string;
  content: string;
  multiChannelContent?: Partial<Record<ChannelId, string>>;
  tags: string[];
  machineMatchers?: TemplateMachineMatcher;
  channelScope?: ChannelId[] | 'any';
  insertMode: TemplateInsertMode;
  source: TemplateSource;
  readonly?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TemplateMachinePreset {
  id: string;
  name: string;
  machineName?: MachineType;
  controlType?: string;
  defaultTemplateIds: string[];
  tags: string[];
}

export interface TemplateLibrary {
  templates: TemplateDefinition[];
  presets: TemplateMachinePreset[];
}

export interface TemplateFilter {
  machineName?: MachineType;
  controlType?: string;
  channelId?: ChannelId;
  category?: string;
  tag?: string;
  query?: string;
}

export interface TemplateInsertRequest {
  templateId: string;
  channelId: ChannelId;
  mode?: TemplateInsertMode;
}
