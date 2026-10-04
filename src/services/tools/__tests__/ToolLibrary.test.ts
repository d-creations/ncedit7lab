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

  it('creates a versioned seeded library and saves validated detached tool data', async () => {
    const seeded = await catalog.getLibrary();
    expect(seeded).toMatchObject({ schemaVersion: 1, revision: 0 });
    expect(seeded.tools).toHaveLength(285);
    expect(seeded.tools.map((entry) => entry.description)).toEqual(expect.arrayContaining([
      'Turning Insert C 4.8 mm', 'Turning Insert D 4.8 mm', 'Turning Insert V 4.8 mm',
      'End Mill 0.5 mm', 'End Mill 20 mm', 'Drill 0.5 mm', 'Drill 20 mm',
      'Front End Mill 0.5 mm', 'Front Drill 20 mm',
      'Counter Face End Mill 0.5 mm', 'Counter Face Drill 20 mm',
    ]));
    expect(seeded.tools.find((entry) => entry.id === 'default-front-endmill-10mm')?.orientation).toEqual([0, 90, 0]);
    expect(seeded.tools.find((entry) => entry.id === 'default-counter-face-drill-10mm')?.orientation).toEqual([270, 0, 0]);
    expect(seeded.tools.find((entry) => entry.id === 'default-turning-insert-C')?.orientation).toEqual([0, 90, 0]);
    expect(seeded.tools.find((entry) => entry.id === 'default-turning-insert-C')?.holder?.[0]).toMatchObject({
      type: 'turningHolderProfile', width: 12, depth: 12, stickOut: 15,
    });
    expect(seeded.tools.find((entry) => entry.id === 'default-turning-insert-C')?.turning).toEqual({
      hand: 'right', mount: 'front', approachAngle: 93,
      activeCorner: 'front-right', reference: 'virtualTip',
    });
    expect(seeded.tools.find((entry) => entry.id === 'default-turning-insert-C')?.cutting?.[0]).toMatchObject({
      type: 'insert', shape: 'C', ic: 4.7625, thickness: 1.59, noseRadius: 0.2, zeroVertex: 0, rotation: [0, -47, 0],
    });
    const turningVariants = ['C', 'D', 'V', 'W', 'T'].flatMap((shape) => [
      seeded.tools.find((entry) => entry.id === `default-turning-insert-${shape}`),
      seeded.tools.find((entry) => entry.id === `default-turning-insert-${shape}-back-left`),
      seeded.tools.find((entry) => entry.id === `default-turning-insert-${shape}-center`),
    ]);
    expect(turningVariants).toHaveLength(15);
    expect(turningVariants.every((entry) => entry?.holder?.[0]?.type === 'turningHolderProfile')).toBe(true);
    expect(turningVariants.map((entry) => entry?.turning?.mount)).toEqual([
      'front', 'back', 'center', 'front', 'back', 'center', 'front', 'back', 'center',
      'front', 'back', 'center', 'front', 'back', 'center',
    ]);
    expect(new Set(turningVariants.map((entry) => JSON.stringify(entry?.holder?.[0]))).size).toBe(3);
    const changed = vi.fn();
    bus.subscribe(EVENT_NAMES.TOOL_LIBRARY_CHANGED, changed);
    const saved = await catalog.saveTool(tool());
    expect(saved).toMatchObject({ revision: 1, description: 'Drill 8 mm' });
    expect(changed).toHaveBeenCalledExactlyOnceWith({ revision: 1 });
    saved.description = 'mutated caller';
    expect((await catalog.getTool('tool-1'))?.description).toBe('Drill 8 mm');
    expect(JSON.parse(storage.getItem(TOOL_LIBRARY_STORAGE_KEY)!).schemaVersion).toBe(1);
  });

  it('adds missing standard tools to an existing library without replacing user entries', async () => {
    const initial = await repository.loadLibrary();
    const customized = structuredClone(initial);
    customized.revision = 7;
    customized.tools = customized.tools.filter((entry) => entry.id !== 'default-drill-20mm');
    customized.tools[0].description = 'My custom turning tool';
    storage.setItem(TOOL_LIBRARY_STORAGE_KEY, JSON.stringify(customized));

    const merged = await repository.loadLibrary();

    expect(merged.revision).toBe(8);
    expect(merged.tools).toHaveLength(285);
    expect(merged.tools.find((entry) => entry.id === 'default-drill-20mm')).toBeTruthy();
    expect(merged.tools[0].description).toBe('My custom turning tool');
    expect(JSON.parse(storage.getItem(TOOL_LIBRARY_STORAGE_KEY)!).revision).toBe(8);
  });

  it('upgrades untouched legacy turning defaults but never edited tools', async () => {
    const initial = await repository.loadLibrary();
    const legacy = structuredClone(initial);
    const stale = legacy.tools.find((entry) => entry.id === 'default-turning-insert-D')!;
    const edited = legacy.tools.find((entry) => entry.id === 'default-turning-insert-V')!;
    for (const entry of [stale, edited]) {
      delete (entry.cutting![0] as { zeroVertex?: number }).zeroVertex;
      entry.cutting![0].rotation = [0, 0, 180];
    }
    edited.revision = 2;
    storage.setItem(TOOL_LIBRARY_STORAGE_KEY, JSON.stringify(legacy));

    const upgraded = await repository.loadLibrary();

    expect(upgraded.revision).toBe(initial.revision + 1);
    expect(upgraded.tools.find((entry) => entry.id === 'default-turning-insert-D')?.cutting?.[0]).toMatchObject({ zeroVertex: 0, rotation: [0, -59.5, 0] });
    expect(upgraded.tools.find((entry) => entry.id === 'default-turning-insert-V')).toMatchObject({
      revision: 2, cutting: [{ rotation: [0, 0, 180] }],
    });
  });

  it('upgrades legacy 12 mm turning defaults to 4.8 mm with turningHolderProfile', async () => {
    const initial = await repository.loadLibrary();
    const legacy = structuredClone(initial);
    const stale12mm = legacy.tools.find((entry) => entry.id === 'default-turning-insert-C')!;
    stale12mm.description = 'Turning Insert C 12 mm';
    stale12mm.holder = [{ type: 'box', width: 20, height: 20, length: 80, stickOut: 30 }];
    stale12mm.cutting = [{ type: 'insert', shape: 'C', ic: 12, thickness: 3.97, noseRadius: 0.4, clearanceAngle: 7 }];
    delete stale12mm.orientation;
    delete stale12mm.turning;
    delete stale12mm.Q;
    delete stale12mm.R;
    storage.setItem(TOOL_LIBRARY_STORAGE_KEY, JSON.stringify(legacy));

    const upgraded = await repository.loadLibrary();

    const toolC = upgraded.tools.find((entry) => entry.id === 'default-turning-insert-C')!;
    expect(toolC.description).toBe('Turning Insert C 4.8 mm');
    expect(toolC.cutting?.[0]).toMatchObject({ ic: 4.7625, thickness: 1.59, zeroVertex: 0 });
    expect(toolC.holder?.[0]).toMatchObject({ type: 'turningHolderProfile', width: 12 });
    expect(toolC.orientation).toEqual([0, 90, 0]);
    expect(toolC.Q).toBe(3);
    expect(toolC.R).toBe(0.2);
  });

  it('resets standard tools to defaults while keeping user-created tools', async () => {
    await catalog.getLibrary();
    await catalog.saveTool(tool({ id: 'my-custom-tool', description: 'Custom Tool' }));
    await catalog.resetDefaults();
    const tools = await catalog.getTools();
    expect(tools.find((t) => t.id === 'my-custom-tool')?.description).toBe('Custom Tool');
    expect(tools.find((t) => t.id === 'default-turning-insert-C')?.description).toBe('Turning Insert C 4.8 mm');
  });

  it('updates by tool revision, filters, deletes and round-trips import/export', async () => {
    await catalog.importLibrary(JSON.stringify({ schemaVersion: 1, libraryId: 'blank', revision: 0, tools: [] }));
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