// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../NCToolManagerPanel';
import { ServiceRegistry } from '@core/ServiceRegistry';
import {
  EVENT_BUS_TOKEN,
  PARSER_SERVICE_TOKEN,
  PROGRAM_TOOL_SERVICE_TOKEN,
  STATE_SERVICE_TOKEN,
  TOOL_CATALOG_SERVICE_TOKEN,
} from '@core/ServiceTokens';
import { EventBus, EVENT_NAMES } from '@services/EventBus';
import { ParserService } from '@services/ParserService';
import { StateService } from '@services/StateService';
import { ProgramToolService, type ProgramSource } from '@services/tools/ProgramToolService';
import { SimulationCommentCodec } from '@services/tools/SimulationCommentCodec';
import { ToolCatalogService } from '@services/tools/ToolCatalogService';
import { WebToolLibraryRepository } from '@services/tools/WebToolLibraryRepository';
import type {
  ProgramOffsetsUpdateRequest,
  ProgramToolUpdateRequest,
} from '@services/tools/ProgramMetadataEditService';

const syntax = { kind: 'block', open: '(', close: ')' } as const;

// jsdom has no canvas; the live preview then falls back to its no-WebGL notice.
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('NCToolManagerPanel', () => {
  const registry = ServiceRegistry.getInstance();
  let eventBus: EventBus;
  let catalog: ToolCatalogService;
  let panel: HTMLElement;
  let source: ProgramSource;

  beforeEach(async () => {
    await registry.disposeAll();
    localStorage.clear();
    document.body.replaceChildren();
    eventBus = new EventBus();
    const state = new StateService(eventBus, false);
    state.setMachines([{ machineName: 'FANUC_TEST', controlType: 'FANUC', axes: ['X', 'Y', 'Z'],
      feedLimits: { min: 0, max: 1000 }, defaultTools: [], availableChannels: 1,
      simulationCommentSyntax: syntax,
      profileRevision: 'sha256:test', supportedPoseContracts: [],
      simulation: {
        schemaVersion: 1, revision: 1, modelId: 'MILL_DEMO', displayName: 'Mill demo', fidelity: 'demo',
        poseContract: 'workpiece-tool-reference-v1', carriers: [{ id: 'spindle', role: 'tool', referenceOrientationDegrees: [0, 0, 0], rotationChain: [] }],
        toolMounts: [{ channelId: '1', tools: { kind: 'numericRange', from: 1, to: 99 }, carrierId: 'spindle', target: { mode: 'fixed', workpieceCarrierId: 'table' } }],
      },
      toolSelection: { mode: 'packed', namedTools: false, offsetScope: 'global', offsetAddress: 'D' },
    }]);
    state.setGlobalMachine('FANUC_TEST');
    state.activateChannel('1');
    source = {
      identity: { documentId: 'doc', programId: 'program', channelId: '1' },
      revision: 'editor:0',
      text: 'T1\nG1 X10',
    };
    const channel = document.createElement('nc-channel-pane');
    channel.dataset.channel = '1';
    const codePane = document.createElement('nc-code-pane') as HTMLElement & { getProgramSource(): ProgramSource };
    codePane.getProgramSource = () => source;
    channel.append(codePane);
    document.body.append(channel);
    catalog = new ToolCatalogService(new WebToolLibraryRepository(localStorage), eventBus);
    registry.register(EVENT_BUS_TOKEN, () => eventBus);
    registry.register(STATE_SERVICE_TOKEN, () => state);
    registry.register(PARSER_SERVICE_TOKEN, () => new ParserService(eventBus));
    registry.register(PROGRAM_TOOL_SERVICE_TOKEN, () => new ProgramToolService(new SimulationCommentCodec(), eventBus));
    registry.register(TOOL_CATALOG_SERVICE_TOKEN, () => catalog);
    panel = document.createElement('nc-tool-manager-panel');
    document.body.append(panel);
    await vi.waitFor(() => expect(panel.shadowRoot?.querySelector('[data-manager-tab="library"]')).toBeTruthy());
  });

  afterEach(async () => {
    document.body.replaceChildren();
    await registry.disposeAll();
    localStorage.clear();
  });

  it('shows Library and Program Tools and persists a concrete tool form', async () => {
    expect(panel.shadowRoot?.textContent).toContain('Tool Manager');
    expect(panel.shadowRoot?.textContent).toContain('Library');
    expect(panel.shadowRoot?.textContent).toContain('Program Tools');
    (panel.shadowRoot?.querySelector('#new-library-tool') as HTMLButtonElement).click();
    (panel.shadowRoot?.querySelector('#tool-description') as HTMLInputElement).value = 'Finisher 10';
    (panel.shadowRoot?.querySelector('#tool-q') as HTMLInputElement).value = '3';
    (panel.shadowRoot?.querySelector('#tool-form') as HTMLFormElement).requestSubmit();
    await vi.waitFor(async () => expect((await catalog.getTools()).map((tool) => tool.description)).toContain('Finisher 10'));
    const stored = JSON.parse(localStorage.getItem('nc-edit7:tool-library')!);
    expect(stored).toMatchObject({ schemaVersion: 1, revision: 1 });
    const storedTool = stored.tools.find((entry: { description?: string }) => entry.description === 'Finisher 10');
    expect(storedTool).toMatchObject({ description: 'Finisher 10', Q: 3 });
    expect(storedTool.cutting[0]).toMatchObject({ type: 'endMill', diameter: 10, length: 30 });
  });

  it('drives the live preview from the form and stores a picked zero vertex with the tool', async () => {
    (panel.shadowRoot?.querySelector('#new-library-tool') as HTMLButtonElement).click();
    const field = <T extends HTMLElement>(selector: string) => panel.shadowRoot!.querySelector(selector) as T;
    const change = (element: HTMLElement) => element.dispatchEvent(new Event('change', { bubbles: true }));
    const set = (selector: string, value: string) => {
      field<HTMLInputElement>(selector).value = value;
      change(field(selector));
    };
    set('#tool-description', 'V plate');
    set('#cutting-type', 'insert');
    set('#insert-ic', '10');
    set('#insert-thickness', '4');
    set('#insert-nose-radius', '0.4');
    set('#insert-clearance', '7');
    set('#insert-shape', 'V');

    const preview = field<HTMLElement & { getTool(): { cutting?: Array<Record<string, unknown>> } | undefined; pickVertex(index: number): void }>('nc-tool-preview');
    expect(preview.getTool()?.cutting?.[0]).toMatchObject({ type: 'insert', shape: 'V', ic: 10 });
    set('#insert-shape', 'W');
    expect(preview.getTool()?.cutting?.[0]).toMatchObject({ shape: 'W' });

    preview.pickVertex(2);
    expect(field<HTMLInputElement>('#insert-zero-vertex').value).toBe('2');
    expect(preview.getTool()?.cutting?.[0]).toMatchObject({ zeroVertex: 2 });

    field<HTMLFormElement>('#tool-form').requestSubmit();
    await vi.waitFor(async () => expect((await catalog.getTools()).map((tool) => tool.description)).toContain('V plate'));
    const saved = (await catalog.getTools()).find((tool) => tool.description === 'V plate');
    expect(saved?.cutting?.[0]).toMatchObject({ type: 'insert', shape: 'W', zeroVertex: 2 });
  });

  it('keeps turning metadata and the holder profile when a library tool is saved', async () => {
    await vi.waitFor(() => expect(panel.shadowRoot?.querySelector('[data-library-id="default-turning-insert-A"]')).toBeTruthy());
    (panel.shadowRoot!.querySelector('[data-library-id="default-turning-insert-A"]') as HTMLButtonElement).click();
    (panel.shadowRoot!.querySelector('#tool-form') as HTMLFormElement).requestSubmit();
    await vi.waitFor(async () => expect((await catalog.getTool('default-turning-insert-A'))?.revision).toBe(2));
    expect(await catalog.getTool('default-turning-insert-A')).toMatchObject({
      turning: { mount: 'front', approachAngle: 93 },
      holder: [{ type: 'turningHolderProfile' }],
      cutting: [{ type: 'insert', shape: 'A', zeroVertex: 0 }],
    });
  });

  it('shows the selected machine simulation data without claiming unavailable pose output', async () => {
    (panel.shadowRoot?.querySelector('[data-manager-tab="simulation"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(panel.shadowRoot?.textContent).toContain('Mill demo'));
    expect(panel.shadowRoot?.textContent).toContain('MILL_DEMO');
    expect(panel.shadowRoot?.textContent).toContain('Not installed');
    expect(panel.shadowRoot?.textContent).toContain('Tools 1-99');
  });

  it('detects a program tool and publishes an explicit revision-checked Apply request', async () => {
    const request = vi.fn((payload: ProgramToolUpdateRequest) => {
      eventBus.publish(EVENT_NAMES.PROGRAM_TOOL_UPDATE_RESULT, {
        requestId: payload.requestId,
        channelId: payload.channelId,
        success: true,
        message: 'Applied',
      });
    });
    eventBus.subscribe(EVENT_NAMES.PROGRAM_TOOL_UPDATE_REQUEST, request);
    (panel.shadowRoot?.querySelector('[data-manager-tab="program"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(panel.shadowRoot?.textContent).toContain('T1'));
    expect(panel.shadowRoot?.textContent).toContain('Detected, not assigned');
    (panel.shadowRoot?.querySelector('#tool-description') as HTMLInputElement).value = 'Program drill';
    (panel.shadowRoot?.querySelector('#tool-q') as HTMLInputElement).value = '0';
    (panel.shadowRoot?.querySelector('#tool-form') as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0][0]).toMatchObject({
      channelId: '1', documentId: 'doc', programId: 'program',
      expectedRevision: 'editor:0', expectedText: 'T1\nG1 X10', syntax,
      tool: { toolNumber: 1, description: 'Program drill', Q: 0 },
    });
    await vi.waitFor(() => expect(panel.shadowRoot?.textContent).toContain('Applied'));
  });

  it('publishes an explicit revision-checked offset update request', async () => {
    const request = vi.fn((payload: ProgramOffsetsUpdateRequest) => {
      eventBus.publish(EVENT_NAMES.PROGRAM_OFFSETS_UPDATE_RESULT, {
        requestId: payload.requestId, channelId: payload.channelId, success: true, message: 'Applied offsets',
      });
    });
    eventBus.subscribe(EVENT_NAMES.PROGRAM_OFFSETS_UPDATE_REQUEST, request);
    (panel.shadowRoot?.querySelector('[data-manager-tab="offsets"]') as HTMLButtonElement).click();
    (panel.shadowRoot?.querySelector('#add-offset') as HTMLButtonElement).click();
    const row = panel.shadowRoot?.querySelector('[data-offset-row]') as HTMLElement;
    (row.querySelector('[data-offset-field="number"]') as HTMLInputElement).value = '2';
    (row.querySelector('[data-offset-field="r"]') as HTMLInputElement).value = '0.4';
    (panel.shadowRoot?.querySelector('#save-offsets') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0][0]).toMatchObject({
      channelId: '1', documentId: 'doc', programId: 'program',
      expectedRevision: 'editor:0', expectedText: 'T1\nG1 X10', syntax,
      offsets: { offsetScope: 'global', offsets: [{ offsetNumber: 2, rValue: 0.4 }] },
    });
  });

  it('keeps Program Apply disabled when the selected machine has no explicit capability', async () => {
    const state = registry.get(STATE_SERVICE_TOKEN);
    state.setMachines([{ machineName: 'UNKNOWN', controlType: 'UNKNOWN', axes: ['X'],
      feedLimits: { min: 0, max: 1 }, defaultTools: [], availableChannels: 1 }]);
    state.setGlobalMachine('UNKNOWN');
    (panel.shadowRoot?.querySelector('[data-manager-tab="program"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(panel.shadowRoot?.textContent).toContain('does not advertise'));
    expect((panel.shadowRoot?.querySelector('#tool-form button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows stored-data failures instead of replacing corrupt local data', async () => {
    panel.remove();
    await registry.disposeAll();
    localStorage.setItem('nc-edit7:tool-library', '{future');
    registry.register(EVENT_BUS_TOKEN, () => eventBus);
    registry.register(STATE_SERVICE_TOKEN, () => new StateService(eventBus, false));
    registry.register(PARSER_SERVICE_TOKEN, () => new ParserService(eventBus));
    registry.register(PROGRAM_TOOL_SERVICE_TOKEN, () => new ProgramToolService(new SimulationCommentCodec(), eventBus));
    registry.register(TOOL_CATALOG_SERVICE_TOKEN, () => new ToolCatalogService(new WebToolLibraryRepository(localStorage), eventBus));
    panel = document.createElement('nc-tool-manager-panel');
    document.body.append(panel);
    await vi.waitFor(() => expect(panel.shadowRoot?.textContent).toContain('preserved'));
    expect(localStorage.getItem('nc-edit7:tool-library')).toBe('{future');
  });
});
