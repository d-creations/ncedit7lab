import type { ITemplateRepository } from './ITemplateRepository';
import type { TemplateLibrary } from './TemplateTypes';

const TEMPLATE_STORAGE_KEY = 'nc-edit7:template-library';

const EMPTY_LIBRARY: TemplateLibrary = {
  templates: [],
  presets: [],
};

export class WebTemplateRepository implements ITemplateRepository {
  constructor(private seedUrl: string = '/templates.json') {}

  async loadLibrary(): Promise<TemplateLibrary> {
    const storedLibrary = this.loadStoredLibrary();
    const bundledLibrary = await this.loadBundledLibrary();
    const library = storedLibrary
      ? this.mergeLibraries(bundledLibrary, storedLibrary)
      : bundledLibrary;

    if (library.templates.length > 0 || library.presets.length > 0) {
      await this.saveLibrary(library);
    }

    return library;
  }

  async saveLibrary(library: TemplateLibrary): Promise<void> {
    localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(library));
  }

  private async loadBundledLibrary(): Promise<TemplateLibrary> {
    try {
      const response = await fetch(this.seedUrl);
      if (!response.ok) {
        return EMPTY_LIBRARY;
      }

      const data = await response.json();
      return this.normalizeLibrary(data);
    } catch {
      return EMPTY_LIBRARY;
    }
  }

  private loadStoredLibrary(): TemplateLibrary | null {
    try {
      const raw = localStorage.getItem(TEMPLATE_STORAGE_KEY);
      if (!raw) {
        return null;
      }

      const library = this.normalizeLibrary(JSON.parse(raw));
      return library.templates.length > 0 || library.presets.length > 0 ? library : null;
    } catch {
      return null;
    }
  }

  private normalizeLibrary(input: unknown): TemplateLibrary {
    if (!input || typeof input !== 'object') {
      return EMPTY_LIBRARY;
    }

    const library = input as Partial<TemplateLibrary>;
    return {
      templates: Array.isArray(library.templates) ? library.templates : [],
      presets: Array.isArray(library.presets) ? library.presets : [],
    };
  }

  private mergeLibraries(bundled: TemplateLibrary, stored: TemplateLibrary): TemplateLibrary {
    const templates = new Map<string, TemplateLibrary['templates'][number]>();
    const presets = new Map<string, TemplateLibrary['presets'][number]>();

    bundled.templates.forEach((template) => templates.set(template.id, template));
    stored.templates.forEach((template) => {
      const bundledTemplate = templates.get(template.id);
      if (bundledTemplate?.source === 'bundled' && (template.source === 'bundled' || template.readonly)) {
        return;
      }

      templates.set(template.id, template);
    });
    bundled.presets.forEach((preset) => presets.set(preset.id, preset));
    stored.presets.forEach((preset) => {
      if (!presets.has(preset.id)) {
        presets.set(preset.id, preset);
      }
    });

    return {
      templates: Array.from(templates.values()).sort((left, right) => left.name.localeCompare(right.name)),
      presets: Array.from(presets.values()).sort((left, right) => left.name.localeCompare(right.name)),
    };
  }
}
