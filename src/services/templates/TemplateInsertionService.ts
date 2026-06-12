import type { ChannelId } from '@core/types';
import { EventBus } from '@services/EventBus';
import type { TemplateCatalogService } from './TemplateCatalogService';
import type { TemplateInsertMode } from './TemplateTypes';

export interface TemplateInsertEventPayload {
  channelId: ChannelId;
  content: string;
  mode: TemplateInsertMode;
  templateId: string;
}

export class TemplateInsertionService {
  constructor(
    private catalogService: TemplateCatalogService,
    private eventBus: EventBus,
  ) {}

  async insertTemplate(templateId: string, channelId: ChannelId, mode?: TemplateInsertMode): Promise<boolean> {
    const template = await this.catalogService.getTemplate(templateId);
    if (!template) {
      return false;
    }

    this.eventBus.publish<TemplateInsertEventPayload>('template:insert_request', {
      channelId,
      content: template.content,
      mode: mode ?? template.insertMode,
      templateId: template.id,
    });

    return true;
  }

  async insertMultiChannelTemplate(templateId: string, mode?: TemplateInsertMode): Promise<boolean> {
    const template = await this.catalogService.getTemplate(templateId);
    if (!template?.multiChannelContent) {
      return false;
    }

    let inserted = false;
    for (const [channelId, content] of Object.entries(template.multiChannelContent)) {
      if (!this.isChannelId(channelId) || !content) {
        continue;
      }

      this.eventBus.publish<TemplateInsertEventPayload>('template:insert_request', {
        channelId,
        content,
        mode: mode ?? template.insertMode,
        templateId: template.id,
      });
      inserted = true;
    }

    return inserted;
  }

  private isChannelId(value: string): value is ChannelId {
    return value === '1' || value === '2' || value === '3';
  }
}