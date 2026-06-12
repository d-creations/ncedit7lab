import type { ITemplateRepository } from './ITemplateRepository';
import type {
  TemplateDefinition,
  TemplateFilter,
  TemplateLibrary,
  TemplateMachinePreset,
} from './TemplateTypes';

export class TemplateCatalogService {
  private library: TemplateLibrary = { templates: [], presets: [] };
  private loaded = false;

  constructor(private repository: ITemplateRepository) {}

  async load(): Promise<TemplateLibrary> {
    this.library = await this.repository.loadLibrary();
    this.loaded = true;
    return this.library;
  }

  async getLibrary(): Promise<TemplateLibrary> {
    if (!this.loaded) {
      await this.load();
    }

    return this.library;
  }

  async getTemplates(filter?: TemplateFilter): Promise<TemplateDefinition[]> {
    const library = await this.getLibrary();
    return library.templates.filter((template) => this.matchesFilter(template, filter));
  }

  async getTemplate(templateId: string): Promise<TemplateDefinition | undefined> {
    const library = await this.getLibrary();
    return library.templates.find((template) => template.id === templateId);
  }

  async saveTemplate(template: TemplateDefinition): Promise<void> {
    const library = await this.getLibrary();
    const nextTemplates = library.templates.filter((entry) => entry.id !== template.id);
    nextTemplates.push(template);
    nextTemplates.sort((left, right) => left.name.localeCompare(right.name));

    this.library = {
      ...library,
      templates: nextTemplates,
    };

    await this.repository.saveLibrary(this.library);
  }

  async deleteTemplate(templateId: string): Promise<void> {
    const library = await this.getLibrary();
    this.library = {
      ...library,
      templates: library.templates.filter((template) => template.id !== templateId),
      presets: library.presets.map((preset) => ({
        ...preset,
        defaultTemplateIds: preset.defaultTemplateIds.filter((id) => id !== templateId),
      })),
    };

    await this.repository.saveLibrary(this.library);
  }

  async getPresets(): Promise<TemplateMachinePreset[]> {
    const library = await this.getLibrary();
    return library.presets;
  }

  async savePreset(preset: TemplateMachinePreset): Promise<void> {
    const library = await this.getLibrary();
    const nextPresets = library.presets.filter((entry) => entry.id !== preset.id);
    nextPresets.push(preset);
    nextPresets.sort((left, right) => left.name.localeCompare(right.name));

    this.library = {
      ...library,
      presets: nextPresets,
    };

    await this.repository.saveLibrary(this.library);
  }

  private matchesFilter(template: TemplateDefinition, filter?: TemplateFilter): boolean {
    if (!filter) {
      return true;
    }

    if (filter.category && template.category !== filter.category) {
      return false;
    }

    if (filter.tag && !template.tags.includes(filter.tag)) {
      return false;
    }

    if (filter.channelId && template.channelScope !== 'any') {
      const allowedChannels = template.channelScope ?? 'any';
      if (allowedChannels !== 'any' && !allowedChannels.includes(filter.channelId)) {
        return false;
      }
    }

    if (filter.machineName) {
      const machineNames = template.machineMatchers?.machineNames;
      if (machineNames && machineNames.length > 0 && !machineNames.includes(filter.machineName)) {
        return false;
      }
    }

    if (filter.controlType) {
      const controlTypes = template.machineMatchers?.controlTypes;
      if (controlTypes && controlTypes.length > 0 && !controlTypes.includes(filter.controlType)) {
        return false;
      }
    }

    if (filter.query) {
      const query = filter.query.trim().toLowerCase();
      if (query.length > 0) {
        const haystack = [template.name, template.description ?? '', template.category, ...template.tags]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(query)) {
          return false;
        }
      }
    }

    return true;
  }
}
