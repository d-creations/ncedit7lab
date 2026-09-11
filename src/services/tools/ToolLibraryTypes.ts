import type { ProgramToolDefinition, ToolIdentifier } from './SimulationMetadata';

export interface LibraryToolDefinition extends Omit<ProgramToolDefinition, 'toolNumber'> {
  id: string;
  revision: number;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ToolLibraryEnvelope {
  schemaVersion: 1;
  libraryId: string;
  revision: number;
  tools: LibraryToolDefinition[];
}

export interface ToolLibraryFilter {
  query?: string;
  cuttingType?: string;
}

export interface IToolLibraryRepository {
  loadLibrary(): Promise<ToolLibraryEnvelope>;
  saveLibrary(library: ToolLibraryEnvelope, expectedRevision: number): Promise<void>;
}

export class ToolLibraryStorageError extends Error {}

export function toProgramToolDefinition(tool: LibraryToolDefinition, toolNumber: ToolIdentifier = 1): ProgramToolDefinition {
  return {
    toolNumber,
    description: tool.description,
    ...(tool.Q === undefined ? {} : { Q: tool.Q }),
    ...(tool.R === undefined ? {} : { R: tool.R }),
    ...(tool.holder === undefined ? {} : { holder: structuredClone(tool.holder) }),
    ...(tool.cutting === undefined ? {} : { cutting: structuredClone(tool.cutting) }),
    ...(tool.orientation === undefined ? {} : { orientation: structuredClone(tool.orientation) }),
  };
}