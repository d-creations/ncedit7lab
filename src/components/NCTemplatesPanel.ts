import type { ChannelId } from '@core/types';
import { ServiceRegistry } from '@core/ServiceRegistry';
import {
  STATE_SERVICE_TOKEN,
  TEMPLATE_CATALOG_SERVICE_TOKEN,
  TEMPLATE_INSERTION_SERVICE_TOKEN,
} from '@core/ServiceTokens';
import { StateService } from '@services/StateService';
import { TemplateCatalogService } from '@services/templates/TemplateCatalogService';
import { TemplateInsertionService } from '@services/templates/TemplateInsertionService';
import type { TemplateDefinition, TemplateInsertMode } from '@services/templates/TemplateTypes';

const DEFAULT_CHANNEL: ChannelId = '1';

export class NCTemplatesPanel extends HTMLElement {
  private stateService: StateService;
  private catalogService: TemplateCatalogService;
  private insertionService: TemplateInsertionService;
  private templates: TemplateDefinition[] = [];
  private selectedTemplateId?: string;
  private query = '';
  private category = '';
  private channelId: ChannelId = DEFAULT_CHANNEL;

  constructor() {
    super();
    const registry = ServiceRegistry.getInstance();
    this.stateService = registry.get(STATE_SERVICE_TOKEN);
    this.catalogService = registry.get(TEMPLATE_CATALOG_SERVICE_TOKEN);
    this.insertionService = registry.get(TEMPLATE_INSERTION_SERVICE_TOKEN);
    this.attachShadow({ mode: 'open' });
  }

  async connectedCallback(): Promise<void> {
    this.channelId = this.getInitialChannel();
    await this.loadTemplates();
    this.render();
  }

  private getInitialChannel(): ChannelId {
    const selected = this.stateService.getWorkbenchSelectedChannel();
    if (['1', '2', '3'].includes(selected)) {
      return selected;
    }

    const active = this.stateService.getActiveChannels()[0]?.id;
    return active ?? DEFAULT_CHANNEL;
  }

  private async loadTemplates(): Promise<void> {
    const activeMachine = this.stateService.getState().activeMachine;
    this.templates = await this.catalogService.getTemplates({
      machineName: activeMachine?.machineName,
      controlType: activeMachine?.controlType,
      category: this.category || undefined,
      query: this.query || undefined,
    });

    if (!this.selectedTemplateId || !this.templates.some((template) => template.id === this.selectedTemplateId)) {
      this.selectedTemplateId = this.templates[0]?.id;
    }
  }

  private get categories(): string[] {
    return Array.from(new Set(this.templates.map((template) => template.category))).sort((left, right) => left.localeCompare(right));
  }

  private get selectedTemplate(): TemplateDefinition | undefined {
    return this.templates.find((template) => template.id === this.selectedTemplateId);
  }

  private render(): void {
    if (!this.shadowRoot) return;

    const selectedTemplate = this.selectedTemplate;
    const categories = this.categories;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: flex;
          width: 100%;
          height: 100%;
          min-height: 0;
          background: var(--vscode-editor-background, #1e1e1e);
          color: var(--vscode-editor-foreground, #cccccc);
          font-family: var(--vscode-font-family, monospace);
        }

        .shell {
          display: grid;
          grid-template-columns: minmax(160px, 42%) minmax(180px, 58%);
          width: 100%;
          height: 100%;
          min-height: 0;
        }

        .list-pane,
        .detail-pane {
          display: flex;
          flex-direction: column;
          min-height: 0;
          overflow: hidden;
        }

        .list-pane {
          border-right: 1px solid var(--vscode-editorGroup-border, #3c3c3c);
        }

        .toolbar {
          display: grid;
          grid-template-columns: 1fr;
          gap: 6px;
          padding: 8px;
          border-bottom: 1px solid var(--vscode-editorGroup-border, #3c3c3c);
          background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
        }

        input,
        select,
        textarea {
          box-sizing: border-box;
          width: 100%;
          border: 1px solid var(--vscode-input-border, #3c3c3c);
          background: var(--vscode-input-background, #3c3c3c);
          color: var(--vscode-input-foreground, #cccccc);
          border-radius: 4px;
          padding: 6px 8px;
          font: inherit;
          font-size: 12px;
        }

        .template-list {
          overflow: auto;
          min-height: 0;
        }

        .template-button {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 9px 10px;
          border: 0;
          border-bottom: 1px solid var(--vscode-editorGroup-border, #333333);
          background: transparent;
          color: inherit;
          text-align: left;
          cursor: pointer;
        }

        .template-button:hover {
          background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.06));
        }

        .template-button.active {
          background: var(--vscode-tab-activeBackground, #1e1e1e);
          border-left: 3px solid var(--vscode-tab-activeBorderTop, #007fd4);
          padding-left: 7px;
        }

        .template-name {
          font-size: 12px;
          font-weight: 700;
        }

        .template-meta,
        .empty {
          color: var(--vscode-descriptionForeground, #9d9d9d);
          font-size: 11px;
          line-height: 1.4;
        }

        .detail-header {
          display: flex;
          flex-direction: column;
          gap: 5px;
          padding: 10px;
          border-bottom: 1px solid var(--vscode-editorGroup-border, #3c3c3c);
          background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
        }

        .detail-title {
          margin: 0;
          font-size: 14px;
          line-height: 1.3;
        }

        .actions {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 6px;
          padding: 8px 10px;
          border-bottom: 1px solid var(--vscode-editorGroup-border, #3c3c3c);
        }

        button.action {
          border: 1px solid var(--vscode-widget-border, #454545);
          background: var(--vscode-button-secondaryBackground, #3a3d41);
          color: var(--vscode-button-secondaryForeground, #cccccc);
          border-radius: 4px;
          padding: 6px 8px;
          cursor: pointer;
          font: inherit;
          font-size: 12px;
        }

        button.action.primary {
          background: var(--vscode-button-background, #0e639c);
          color: var(--vscode-button-foreground, #ffffff);
          border-color: var(--vscode-button-background, #0e639c);
        }

        button.action.danger {
          color: var(--vscode-inputValidation-errorForeground, #ffffff);
          background: var(--vscode-inputValidation-errorBackground, #7f1d1d);
        }

        button.action:disabled {
          opacity: 0.5;
          cursor: default;
        }

        pre {
          flex: 1;
          min-height: 0;
          margin: 0;
          padding: 10px;
          overflow: auto;
          white-space: pre-wrap;
          color: var(--vscode-editor-foreground, #cccccc);
          background: var(--vscode-editor-background, #1e1e1e);
          font-size: 12px;
          line-height: 1.45;
        }

        .empty {
          padding: 12px;
        }

        .editor-form {
          display: none;
          flex-direction: column;
          gap: 7px;
          padding: 10px;
          border-top: 1px solid var(--vscode-editorGroup-border, #3c3c3c);
          background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
        }

        .editor-form.open {
          display: flex;
        }

        textarea {
          min-height: 140px;
          resize: vertical;
          line-height: 1.45;
        }

        @media (max-width: 640px) {
          .shell {
            grid-template-columns: 1fr;
            grid-template-rows: minmax(160px, 40%) minmax(180px, 60%);
          }

          .list-pane {
            border-right: 0;
            border-bottom: 1px solid var(--vscode-editorGroup-border, #3c3c3c);
          }
        }
      </style>

      <div class="shell">
        <section class="list-pane">
          <div class="toolbar">
            <input id="template-search" type="search" placeholder="Search templates" value="${this.escapeAttr(this.query)}">
            <select id="template-category">
              <option value="">All categories</option>
              ${categories.map((category) => `<option value="${this.escapeAttr(category)}" ${category === this.category ? 'selected' : ''}>${this.escapeHtml(category)}</option>`).join('')}
            </select>
            <div class="template-meta">Selected channel to apply the template.</div>
            <select id="template-channel">
              ${(['1', '2', '3'] as ChannelId[]).map((channel) => `<option value="${channel}" ${channel === this.channelId ? 'selected' : ''}>Channel ${channel}</option>`).join('')}
            </select>
            <button class="action" id="new-template">New Template</button>
          </div>
          <div class="template-list">
            ${this.templates.length > 0 ? this.templates.map((template) => this.renderTemplateButton(template)).join('') : '<div class="empty">No templates match the current filter.</div>'}
          </div>
        </section>
        <section class="detail-pane">
          ${selectedTemplate ? this.renderDetail(selectedTemplate) : '<div class="empty">Select or create a template.</div>'}
          ${this.renderEditorForm(selectedTemplate)}
        </section>
      </div>
    `;

    this.attachEventListeners();
  }

  private renderTemplateButton(template: TemplateDefinition): string {
    const activeClass = template.id === this.selectedTemplateId ? ' active' : '';
    const readonlyLabel = template.readonly ? 'Bundled' : 'User';

    return `
      <button class="template-button${activeClass}" data-template-id="${this.escapeAttr(template.id)}">
        <span class="template-name">${this.escapeHtml(template.name)}</span>
        <span class="template-meta">${this.escapeHtml(template.category)} · ${readonlyLabel}</span>
      </button>
    `;
  }

  private renderDetail(template: TemplateDefinition): string {
    const description = template.description ? `<div class="template-meta">${this.escapeHtml(template.description)}</div>` : '';
    const tags = template.tags.length > 0 ? `<div class="template-meta">${template.tags.map((tag) => `#${this.escapeHtml(tag)}`).join(' ')}</div>` : '';
    const isMultiChannel = !!template.multiChannelContent && Object.keys(template.multiChannelContent).length > 0;

    return `
      <div class="detail-header">
        <h3 class="detail-title">${this.escapeHtml(template.name)}</h3>
        ${description}
        ${tags}
        ${isMultiChannel ? '<div class="template-meta">Multi-channel template</div>' : ''}
      </div>
      <div class="actions">
        <button class="action primary" data-insert-mode="insertAtCursor">Insert</button>
        <button class="action" data-insert-mode="replaceSelection">Replace Selection</button>
        <button class="action" data-insert-mode="appendToDocument">Append</button>
        <button class="action" data-insert-mode="newProgram">New Program</button>
        ${isMultiChannel ? '<button class="action primary" id="apply-multi-template">Apply Multi-Channel</button>' : ''}
        <button class="action" id="edit-template" ${template.readonly ? 'disabled title="Bundled templates are read-only. Duplicate by creating a new template."' : ''}>Edit</button>
        <button class="action danger" id="delete-template" ${template.readonly ? 'disabled title="Bundled templates cannot be deleted."' : ''}>Delete</button>
      </div>
      <pre>${this.escapeHtml(template.content)}</pre>
    `;
  }

  private renderEditorForm(template?: TemplateDefinition): string {
    const editableTemplate = template && !template.readonly ? template : undefined;
    return `
      <form class="editor-form" id="template-form">
        <input id="form-name" placeholder="Template name" value="${this.escapeAttr(editableTemplate?.name ?? '')}" required>
        <input id="form-category" placeholder="Category" value="${this.escapeAttr(editableTemplate?.category ?? 'User')}">
        <input id="form-tags" placeholder="Tags, comma separated" value="${this.escapeAttr(editableTemplate?.tags.join(', ') ?? '')}">
        <textarea id="form-content" placeholder="Template content" required>${this.escapeHtml(editableTemplate?.content ?? '')}</textarea>
        <div class="actions" style="padding: 0; border-bottom: 0;">
          <button class="action primary" type="submit">Save</button>
          <button class="action" type="button" id="cancel-template-form">Cancel</button>
        </div>
      </form>
    `;
  }

  private attachEventListeners(): void {
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('.template-button').forEach((button) => {
      button.addEventListener('click', () => {
        this.selectedTemplateId = button.dataset.templateId;
        this.render();
      });
    });

    this.shadowRoot?.querySelector<HTMLInputElement>('#template-search')?.addEventListener('input', async (event) => {
      this.query = (event.currentTarget as HTMLInputElement).value;
      await this.loadTemplates();
      this.render();
    });

    this.shadowRoot?.querySelector<HTMLSelectElement>('#template-category')?.addEventListener('change', async (event) => {
      this.category = (event.currentTarget as HTMLSelectElement).value;
      await this.loadTemplates();
      this.render();
    });

    this.shadowRoot?.querySelector<HTMLSelectElement>('#template-channel')?.addEventListener('change', async (event) => {
      this.channelId = (event.currentTarget as HTMLSelectElement).value as ChannelId;
      this.render();
    });

    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-insert-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        const mode = button.dataset.insertMode as TemplateInsertMode | undefined;
        if (this.selectedTemplateId && mode) {
          void this.insertionService.insertTemplate(this.selectedTemplateId, this.channelId, mode);
        }
      });
    });

    this.shadowRoot?.querySelector<HTMLButtonElement>('#apply-multi-template')?.addEventListener('click', () => {
      if (this.selectedTemplateId) {
        void this.insertionService.insertMultiChannelTemplate(this.selectedTemplateId, 'replaceDocument');
      }
    });

    this.shadowRoot?.querySelector<HTMLButtonElement>('#new-template')?.addEventListener('click', () => {
      this.selectedTemplateId = undefined;
      this.render();
      this.openForm();
    });

    this.shadowRoot?.querySelector<HTMLButtonElement>('#edit-template')?.addEventListener('click', () => {
      this.openForm();
    });

    this.shadowRoot?.querySelector<HTMLButtonElement>('#delete-template')?.addEventListener('click', async () => {
      const template = this.selectedTemplate;
      if (!template || template.readonly) return;
      await this.catalogService.deleteTemplate(template.id);
      this.selectedTemplateId = undefined;
      await this.loadTemplates();
      this.render();
    });

    this.shadowRoot?.querySelector<HTMLButtonElement>('#cancel-template-form')?.addEventListener('click', () => {
      this.closeForm();
    });

    this.shadowRoot?.querySelector<HTMLFormElement>('#template-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      await this.saveForm();
    });
  }

  private openForm(): void {
    this.shadowRoot?.querySelector('#template-form')?.classList.add('open');
  }

  private closeForm(): void {
    this.shadowRoot?.querySelector('#template-form')?.classList.remove('open');
  }

  private async saveForm(): Promise<void> {
    const nameInput = this.shadowRoot?.querySelector<HTMLInputElement>('#form-name');
    const categoryInput = this.shadowRoot?.querySelector<HTMLInputElement>('#form-category');
    const tagsInput = this.shadowRoot?.querySelector<HTMLInputElement>('#form-tags');
    const contentInput = this.shadowRoot?.querySelector<HTMLTextAreaElement>('#form-content');

    const name = nameInput?.value.trim();
    const content = contentInput?.value ?? '';
    if (!name || !content.trim()) {
      return;
    }

    const now = Date.now();
    const existing = this.selectedTemplate && !this.selectedTemplate.readonly ? this.selectedTemplate : undefined;
    const template: TemplateDefinition = {
      id: existing?.id ?? this.createId(),
      name,
      category: categoryInput?.value.trim() || 'User',
      content,
      tags: (tagsInput?.value ?? '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      channelScope: 'any',
      insertMode: 'insertAtCursor',
      source: 'user',
      readonly: false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.catalogService.saveTemplate(template);
    this.selectedTemplateId = template.id;
    await this.loadTemplates();
    this.render();
  }

  private createId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }

    return `template-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private escapeAttr(value: string): string {
    return this.escapeHtml(value);
  }
}

customElements.define('nc-templates-panel', NCTemplatesPanel);