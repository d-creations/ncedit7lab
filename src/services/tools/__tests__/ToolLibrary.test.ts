import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, EVENT_NAMES } from '../../EventBus';
import { ToolCatalogService } from '../ToolCatalogService';
import { TOOL_LIBRARY_STORAGE_KEY, WebToolLibraryRepository } from '../WebToolLibraryRepository';
import type { LibraryToolDefinition } from '../ToolLibraryTypes';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const tool = (overrides: Partial<LibraryToolDefinition> = {}): LibraryToolDefinition => ({
  id: 'tool-1', revision: 0, description: 'Drill 8 mm', tags: ['drill'],
  createdAt: 0, updatedAt: 0,
  cutting: [{ type: 'drill', diameter: 8, length: 45, tipAngle: 118 }],
  holder: [{ type: 'cylinder', diameter: 8, length: 35, stickOut: 55 }],
  ...overrides,
});

describe('web tool library', () => {
  let storage: MemoryStorage;
  let repository: WebToolLibraryRepository;
  let bus: EventBus;
  let catalog: ToolCatalogService;

  beforeEach(() => {
    storage = new MemoryStorage();
    repository = new WebToolLibraryRepository(storage);
    bus = new EventBus();
    catalog = new ToolCatalogService(repository, bus);
  });

  it('creates a versioned empty library and saves validated detached tool data', async () => {
    const empty = await catalog.getLibrary();
    expect(empty).toMatchObject({ schemaVersion: 1, revision: 0, tools: [] });
    const changed = vi.fn();
    bus.subscribe(EVENT_NAMES.TOOL_LIBRARY_CHANGED, changed);
    const saved = await catalog.saveTool(tool());
    expect(saved).toMatchObject({ revision: 1, description: 'Drill 8 mm' });
    expect(changed).toHaveBeenCalledExactlyOnceWith({ revision: 1 });
    saved.description = 'mutated caller';
    expect((await catalog.getTool('tool-1'))?.description).toBe('Drill 8 mm');
    expect(JSON.parse(storage.getItem(TOOL_LIBRARY_STORAGE_KEY)!).schemaVersion).toBe(1);
  });

  it('updates by tool revision, filters, deletes and round-trips import/export', async () => {
    const first = await catalog.saveTool(tool());
    await catalog.saveTool({ ...first, description: 'Precision drill', tags: ['precision'] });
    expect((await catalog.getTools({ query: 'precision' }))).toHaveLength(1);
    expect((await catalog.getTools({ cuttingType: 'insert' }))).toHaveLength(0);
    await expect(catalog.saveTool({ ...first, description: 'stale' })).rejects.toThrow('reload');
    const exported = await catalog.exportLibrary();
    await catalog.deleteTool(first.id);
    expect(await catalog.getTools()).toEqual([]);
    await catalog.importLibrary(exported);
    expect((await catalog.getTools())[0].description).toBe('Precision drill');
  });

  it('preserves malformed/newer stored JSON and rejects stale envelope writes', async () => {
    storage.setItem(TOOL_LIBRARY_STORAGE_KEY, '{bad json');
    await expect(repository.loadLibrary()).rejects.toThrow('preserved');
    expect(storage.getItem(TOOL_LIBRARY_STORAGE_KEY)).toBe('{bad json');
    storage.setItem(TOOL_LIBRARY_STORAGE_KEY, JSON.stringify({ schemaVersion: 2, libraryId: 'future', revision: 2, tools: [] }));
    await expect(repository.loadLibrary()).rejects.toThrow('Unsupported');
    expect(JSON.parse(storage.getItem(TOOL_LIBRARY_STORAGE_KEY)!).schemaVersion).toBe(2);
    storage.clear();
    const current = await repository.loadLibrary();
    await repository.saveLibrary({ ...current, revision: 1 }, 0);
    await expect(repository.saveLibrary({ ...current, revision: 2 }, 0)).rejects.toThrow('changed');
  });

  it('rejects invalid geometry and reports blocked/quota storage errors', async () => {
    await expect(catalog.saveTool(tool({ cutting: [{ type: 'drill', diameter: -1, length: 1, tipAngle: 118 }] }))).rejects.toThrow();
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    await expect(catalog.saveTool(tool())).rejects.toThrow('could not be saved');
  });
});