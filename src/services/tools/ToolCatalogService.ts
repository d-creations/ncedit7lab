import type { EventBus } from '../EventBus';
import { EVENT_NAMES } from '../EventBus';
import { freezeMetadata, validateProgramTool } from './SimulationMetadata';
import type { IToolLibraryRepository, LibraryToolDefinition, ToolLibraryEnvelope, ToolLibraryFilter } from './ToolLibraryTypes';
import { toProgramToolDefinition } from './ToolLibraryTypes';
import { parseToolLibrary } from './WebToolLibraryRepository';

function detached<T>(value: T): T {
  return structuredClone(value);
}

export class ToolCatalogService {
  private library?: ToolLibraryEnvelope;

  constructor(private readonly repository: IToolLibraryRepository, private readonly eventBus: EventBus) {}

  async getLibrary(reload = false): Promise<ToolLibraryEnvelope> {
    if (!this.library || reload) this.library = await this.repository.loadLibrary();
    return detached(this.library);
  }

  async getTools(filter?: ToolLibraryFilter): Promise<LibraryToolDefinition[]> {
    const library = await this.getLibrary();
    const query = filter?.query?.trim().toLowerCase();
    return library.tools.filter((tool) => {
      if (filter?.cuttingType && !tool.cutting?.some((part) => part.type === filter.cuttingType)) return false;
      if (!query) return true;
      return [tool.description, ...tool.tags].join(' ').toLowerCase().includes(query);
    }).sort((left, right) => left.description.localeCompare(right.description));
  }

  async getTool(id: string): Promise<LibraryToolDefinition | undefined> {
    return (await this.getLibrary()).tools.find((tool) => tool.id === id);
  }

  async saveTool(tool: LibraryToolDefinition): Promise<LibraryToolDefinition> {
    validateProgramTool(toProgramToolDefinition(tool));
    const current = await this.getLibrary();
    const existing = current.tools.find((entry) => entry.id === tool.id);
    if (existing && tool.revision !== existing.revision) throw new Error('Tool changed; reload before saving');
    const now = Date.now();
    const saved = freezeMetadata({
      ...detached(tool),
      revision: existing ? existing.revision + 1 : 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      tags: [...tool.tags],
    }) as unknown as LibraryToolDefinition;
    const next = parseToolLibrary({
      ...current,
      revision: current.revision + 1,
      tools: [...current.tools.filter((entry) => entry.id !== tool.id), saved],
    });
    await this.repository.saveLibrary(next, current.revision);
    this.library = next;
    this.eventBus.publish(EVENT_NAMES.TOOL_LIBRARY_CHANGED, { revision: next.revision });
    return detached(saved);
  }

  async deleteTool(id: string): Promise<void> {
    const current = await this.getLibrary();
    if (!current.tools.some((tool) => tool.id === id)) return;
    const next = parseToolLibrary({ ...current, revision: current.revision + 1,
      tools: current.tools.filter((tool) => tool.id !== id) });
    await this.repository.saveLibrary(next, current.revision);
    this.library = next;
    this.eventBus.publish(EVENT_NAMES.TOOL_LIBRARY_CHANGED, { revision: next.revision });
  }

  async importLibrary(json: string): Promise<void> {
    const imported = parseToolLibrary(JSON.parse(json));
    const current = await this.getLibrary();
    const next = parseToolLibrary({ ...imported, libraryId: current.libraryId, revision: current.revision + 1 });
    await this.repository.saveLibrary(next, current.revision);
    this.library = next;
    this.eventBus.publish(EVENT_NAMES.TOOL_LIBRARY_CHANGED, { revision: next.revision });
  }

  async exportLibrary(): Promise<string> {
    return JSON.stringify(await this.getLibrary(), null, 2);
  }
}