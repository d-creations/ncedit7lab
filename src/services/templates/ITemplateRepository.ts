import type { TemplateLibrary } from './TemplateTypes';

export interface ITemplateRepository {
  loadLibrary(): Promise<TemplateLibrary>;
  saveLibrary(library: TemplateLibrary): Promise<void>;
}
