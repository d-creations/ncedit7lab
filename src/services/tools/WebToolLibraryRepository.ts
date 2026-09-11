import { freezeMetadata, validateProgramTool } from './SimulationMetadata';
import type { LibraryToolDefinition, IToolLibraryRepository, ToolLibraryEnvelope } from './ToolLibraryTypes';
import { toProgramToolDefinition } from './ToolLibraryTypes';
import { ToolLibraryStorageError } from './ToolLibraryTypes';

export const TOOL_LIBRARY_STORAGE_KEY = 'nc-edit7:tool-library';

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `library-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeTool(input: unknown): LibraryToolDefinition {
  if (!input || typeof input !== 'object') throw new ToolLibraryStorageError('Invalid tool entry');
  const tool = structuredClone(input) as LibraryToolDefinition;
  if (!tool.id?.trim() || !Number.isSafeInteger(tool.revision) || tool.revision < 1 ||
    !Number.isFinite(tool.createdAt) || !Number.isFinite(tool.updatedAt) ||
    !Array.isArray(tool.tags) || tool.tags.some((tag) => typeof tag !== 'string')) {
    throw new ToolLibraryStorageError('Invalid tool identity or revision');
  }
  validateProgramTool(toProgramToolDefinition(tool));
  return tool;
}

export function parseToolLibrary(input: unknown): ToolLibraryEnvelope {
  if (!input || typeof input !== 'object') throw new ToolLibraryStorageError('Invalid tool library');
  const library = input as Partial<ToolLibraryEnvelope>;
  if (library.schemaVersion !== 1) throw new ToolLibraryStorageError('Unsupported tool library version');
  if (!library.libraryId?.trim() || !Number.isSafeInteger(library.revision) || library.revision! < 0 ||
    !Array.isArray(library.tools)) throw new ToolLibraryStorageError('Invalid tool library envelope');
  const tools = library.tools.map(normalizeTool);
  if (new Set(tools.map((tool) => tool.id)).size !== tools.length) {
    throw new ToolLibraryStorageError('Duplicate tool library ID');
  }
  return freezeMetadata({
    schemaVersion: 1 as const,
    libraryId: library.libraryId,
    revision: library.revision,
    tools,
  }) as unknown as ToolLibraryEnvelope;
}

export class WebToolLibraryRepository implements IToolLibraryRepository {
  constructor(private readonly storage: Storage = localStorage) {}

  async loadLibrary(): Promise<ToolLibraryEnvelope> {
    const raw = this.storage.getItem(TOOL_LIBRARY_STORAGE_KEY);
    if (!raw) return { schemaVersion: 1, libraryId: createId(), revision: 0, tools: [] };
    try {
      return parseToolLibrary(JSON.parse(raw));
    } catch (cause) {
      throw new ToolLibraryStorageError(`Stored tool library was preserved: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async saveLibrary(library: ToolLibraryEnvelope, expectedRevision: number): Promise<void> {
    const validated = parseToolLibrary(library);
    const raw = this.storage.getItem(TOOL_LIBRARY_STORAGE_KEY);
    if (raw) {
      let current: ToolLibraryEnvelope;
      try {
        current = parseToolLibrary(JSON.parse(raw));
      } catch (cause) {
        throw new ToolLibraryStorageError(`Stored tool library was preserved: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      if (current.libraryId !== validated.libraryId || current.revision !== expectedRevision) {
        throw new ToolLibraryStorageError('Tool library changed in another view; reload before saving');
      }
    } else if (expectedRevision !== 0) {
      throw new ToolLibraryStorageError('Tool library was removed; reload before saving');
    }
    try {
      this.storage.setItem(TOOL_LIBRARY_STORAGE_KEY, JSON.stringify(validated));
    } catch (cause) {
      throw new ToolLibraryStorageError(`Tool library could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
}