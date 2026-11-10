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
import { ProgramMetadataEditService } from '@services/tools/ProgramMetadataEditService';
import type { NCToolPreview } from '../NCToolPreview';
import { ToolCatalogService } from '@services/tools/ToolCatalogService';
import { WebToolLibraryRepository } from '@services/tools/WebToolLibraryRepository';
import type {
  ProgramOffsetsUpdateRequest,
  ProgramSetupUpdateRequest,
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

  it('creates, picks, applies and reloads program-owned round and plate material', async () => {
    const codec = new SimulationCommentCodec();
    const edits = new ProgramMetadataEditService(codec);
    const requests: ProgramSetupUpdateRequest[] = [];
    eventBus.subscribe(EVENT_NAMES.PROGRAM_SETUP_UPDATE_REQUEST, (request: ProgramSetupUpdateRequest) => {
      requests.push(request);
      expect(request.expectedText).toBe(source.text);
      expect(request.expectedRevision).toBe(source.revision);
      const edit = edits.planSetupUpdate(source.text, request.setup, request.syntax);
      source = { ...source, revision: `editor:${requests.length}`,
        text: source.text.slice(0, edit.startOffset) + edit.text + source.text.slice(edit.endOffset) };
      eventBus.publish(EVENT_NAMES.PROGRAM_SETUP_UPDATE_RESULT, {
        requestId: request.requestId, channelId: '1', success: true, message: 'Material applied',
      });
    });
    const field = <T extends HTMLElement>(selector: string) => panel.shadowRoot!.querySelector<T>(selector)!;
    const set = (selector: string, value: string) => {
      field<HTMLInputElement | HTMLSelectElement>(selector).value = value;
      field(selector).dispatchEvent(new Event('change', { bubbles: true }));
    };
    field<HTMLButtonElement>('[data-manager-tab="material"]').click();
    expect(source.text).toBe('T1\nG1 X10');
    set('#material-diameter', '32');
    field<NCToolPreview>('nc-tool-preview').pickVertex(0);
    expect(field<HTMLSelectElement>('#material-zero').value).toBe('0');
    expect(field<NCToolPreview>('nc-tool-preview').getMaterial()).toMatchObject({ diameter: 32, zeroVertex: 0 });
    field<HTMLFormElement>('#material-form').requestSubmit();
    await vi.waitFor(() => expect(panel.shadowRoot?.textContent).toContain('Material applied'));
    expect(codec.parse(source.text, syntax).setup).toEqual({
      machineName: 'FANUC_TEST', material: { type: 'cylinder', diameter: 32, length: 100, zeroVertex: 0 },
    });
    expect(field<HTMLInputElement>('#material-diameter').value).toBe('32');

    set('#material-type', 'box');
    set('#material-height', '12');
    set('#material-width', '80');
    field<NCToolPreview>('nc-tool-preview').pickVertex(7);
    expect(field<HTMLSelectElement>('#material-zero').options).toHaveLength(9);
    set('#material-pz', '5');
    field<HTMLFormElement>('#material-form').requestSubmit();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await vi.waitFor(() => expect(field<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false));
    expect(codec.parse(source.text, syntax).setup?.material).toEqual({
      type: 'box', width: 80, height: 12, depth: 100, zeroVertex: 7, position: [0, 0, 5],
    });
    expect(source.text.match(/BEGIN SETUP/g)).toHaveLength(1);
    expect(source.text.startsWith('T1\nG1 X10\n')).toBe(true);

    field<HTMLButtonElement>('[data-manager-tab="program"]').click();
    field<HTMLButtonElement>('[data-manager-tab="material"]').click();
    expect(field<HTMLSelectElement>('#material-zero').value).toBe('7');
    expect(field<HTMLInputElement>('#material-height').value).toBe('12');
    field<HTMLButtonElement>('#remove-material').click();
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(codec.parse(source.text, syntax).setup).toEqual({ machineName: 'FANUC_TEST' });
  });

  it('configures shared raw material with channel 2 pick-up (opposite side & flipped Z) and channel 3 zero reference', async () => {
    const codec = new SimulationCommentCodec();
    const edits = new ProgramMetadataEditService(codec);
    const requests: ProgramSetupUpdateRequest[] = [];
    eventBus.subscribe(EVENT_NAMES.PROGRAM_SETUP_UPDATE_REQUEST, (request: ProgramSetupUpdateRequest) => {
      requests.push(request);
      const edit = edits.planSetupUpdate(source.text, request.setup, request.syntax);
      source = {
        ...source,
        revision: `editor:${requests.length}`,
        text: source.text.slice(0, edit.startOffset) + edit.text + source.text.slice(edit.endOffset),
      };
      eventBus.publish(EVENT_NAMES.PROGRAM_SETUP_UPDATE_RESULT, {
        requestId: request.requestId, channelId: request.channelId, success: true, message: 'Material applied',
      });
    });
    const field = <T extends HTMLElement>(selector: string) => panel.shadowRoot!.querySelector<T>(selector)!;
    const set = (selector: string, value: string) => {
      field<HTMLInputElement | HTMLSelectElement>(selector).value = value;
      field(selector).dispatchEvent(new Event('change', { bubbles: true }));
    };

    field<HTMLButtonElement>('[data-manager-tab="material"]').click();
    set('#material-diameter', '20');
    set('#material-length', '80');
    field<NCToolPreview>('nc-tool-preview').pickVertex(0);
    expect(field<HTMLSelectElement>('#material-zero').value).toBe('0');

    // One-click CH 2 pick-up preset switches to CH 2, selects opposite end (1) and rotates 180° around X
    field<HTMLButtonElement>('#material-preset-pickup-ch2').click();
    expect(field<HTMLButtonElement>('[data-material-channel="2"]').classList.contains('active')).toBe(true);
    expect(field<HTMLSelectElement>('#material-zero').value).toBe('1');
    expect(field<HTMLInputElement>('#material-rx').value).toBe('180');
    expect(field<NCToolPreview>('nc-tool-preview').getMaterial()).toMatchObject({
      type: 'cylinder',
      diameter: 20,
      length: 80,
      zeroVertex: 1,
      rotation: [180, 0, 0],
    });

    // Configure CH 3 zero & offset on the same shared raw material
    field<HTMLButtonElement>('[data-material-channel="3"]').click();
    expect(field<HTMLButtonElement>('[data-material-channel="3"]').classList.contains('active')).toBe(true);
    field<HTMLButtonElement>('#material-preset-pickup').click();
    set('#material-pz', '-5');

    field<HTMLFormElement>('#material-form').requestSubmit();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(codec.parse(source.text, syntax).setup).toEqual({
      machineName: 'FANUC_TEST',
      material: {
        type: 'cylinder',
        diameter: 20,
        length: 80,
        zeroVertex: 0,
        channelReferences: {
          '2': { zeroVertex: 1, rotation: [180, 0, 0] },
          '3': { zeroVertex: 1, position: [0, 0, -5], rotation: [180, 0, 0] },
        },
      },
    });
  });

  it('does not publish material requests with invalid dimensions', () => {
    (panel.shadowRoot!.querySelector('[data-manager-tab="material"]') as HTMLButtonElement).click();
    const request = vi.fn();
    eventBus.subscribe(EVENT_NAMES.PROGRAM_SETUP_UPDATE_REQUEST, request);
    const diameter = panel.shadowRoot!.querySelector<HTMLInputElement>('#material-diameter')!;
    diameter.value = '0';
    diameter.dispatchEvent(new Event('input', { bubbles: true }));
    expect(panel.shadowRoot!.querySelector('nc-tool-preview')?.shadowRoot?.textContent).toContain('Invalid diameter');
    panel.shadowRoot!.querySelector<HTMLFormElement>('#material-form')!.requestSubmit();
    expect(request).not.toHaveBeenCalled();
    expect(panel.shadowRoot!.querySelector('#manager-status')?.textContent).toContain('Invalid diameter');
  });

  it('shows Library and Program Tools and persists a concrete tool form', async () => {
    expect(panel.shadowRoot?.textContent).toContain('Tool Manager');
    expect(panel.shadowRoot?.textContent).toContain('Library');
    expect(panel.shadowRoot?.textContent).toContain('Program Tools');
    expect(panel.shadowRoot?.querySelector('[data-manager-tab="program"]')?.classList.contains('active')).toBe(true);
    (panel.shadowRoot?.querySelector('[data-manager-tab="library"]') as HTMLButtonElement).click();
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
    (panel.shadowRoot?.querySelector('[data-manager-tab="library"]') as HTMLButtonElement).click();
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
    (panel.shadowRoot?.querySelector('[data-manager-tab="library"]') as HTMLButtonElement).click();
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

  it('keeps Raw Material selectable in VS Code cross-webview mode after changing tools', async () => {
    document.querySelector('nc-channel-pane')?.remove();
    let hostProgramContent = 'T1\nG1 X10';
    const activeProgram = { id: 'ch1', name: 'Channel 1', content: hostProgramContent, channelId: '1', sourceFileId: 'vscode', lastModified: 1 };
    const fileManager = {
      getActiveProgram: (ch: string) => (ch === '1' ? activeProgram : null),
    };
    const { FILE_MANAGER_SERVICE_TOKEN } = await import('@core/ServiceTokens');
    registry.register(FILE_MANAGER_SERVICE_TOKEN, () => fileManager as never);

    panel.remove();
    panel = document.createElement('nc-tool-manager-panel');
    document.body.append(panel);
    await vi.waitFor(() => expect(panel.shadowRoot?.textContent).toContain('T1'));

    const postedMessages: Array<{ type: string; payload: unknown }> = [];
    (window as unknown as { vscodeApi: { postMessage: (msg: { type: string; payload: unknown }) => void } }).vscodeApi = {
      postMessage: (msg) => postedMessages.push(msg),
    };

    (panel.shadowRoot?.querySelector('#tool-description') as HTMLInputElement).value = 'Turning Tool';
    (panel.shadowRoot?.querySelector('#tool-q') as HTMLInputElement).value = '2';
    (panel.shadowRoot?.querySelector('#tool-form') as HTMLFormElement).requestSubmit();

    expect(postedMessages).toHaveLength(1);
    const toolReq = postedMessages[0].payload as ProgramToolUpdateRequest;
    expect(toolReq.documentId).toBe('external');

    const codec = new SimulationCommentCodec();
    const edits = new ProgramMetadataEditService(codec);
    const toolEdit = edits.planToolUpdate(hostProgramContent, toolReq.tool, toolReq.syntax);
    hostProgramContent = hostProgramContent.slice(0, toolEdit.startOffset) + toolEdit.text + hostProgramContent.slice(toolEdit.endOffset);

    // Simulate VS Code host delivering the result message back to the Tools webview
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: EVENT_NAMES.PROGRAM_TOOL_UPDATE_RESULT,
        payload: {
          requestId: toolReq.requestId,
          channelId: '1',
          success: true,
          message: 'Applied tool 1 to the program',
          updatedText: hostProgramContent,
        },
      },
    }));

    await vi.waitFor(() => expect(panel.shadowRoot?.textContent).toContain('Applied tool 1'));

    // Switch to Raw Material tab and verify buttons are enabled and material can be applied
    (panel.shadowRoot?.querySelector('[data-manager-tab="material"]') as HTMLButtonElement).click();
    const submitBtn = panel.shadowRoot?.querySelector<HTMLButtonElement>('#material-form button[type="submit"]')!;
    expect(submitBtn.disabled).toBe(false);

    (panel.shadowRoot?.querySelector<HTMLFormElement>('#material-form'))!.requestSubmit();
    expect(postedMessages).toHaveLength(2);
    const setupReq = postedMessages[1].payload as ProgramSetupUpdateRequest;
    expect(setupReq.expectedText).toBe(hostProgramContent);

    const setupEdit = edits.planSetupUpdate(hostProgramContent, setupReq.setup, setupReq.syntax);
    hostProgramContent = hostProgramContent.slice(0, setupEdit.startOffset) + setupEdit.text + hostProgramContent.slice(setupEdit.endOffset);

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'PROGRAM_SETUP_UPDATE_RESULT',
        payload: {
          requestId: setupReq.requestId,
          channelId: '1',
          success: true,
          message: 'Applied machine and material setup to the program',
          updatedText: hostProgramContent,
        },
      },
    }));

    await vi.waitFor(() => expect(panel.shadowRoot?.textContent).toContain('Applied machine and material setup'));
    expect((panel.shadowRoot?.querySelector<HTMLButtonElement>('#material-form button[type="submit"]'))?.disabled).toBe(false);
    expect((panel.shadowRoot?.querySelector<HTMLButtonElement>('#remove-material'))?.disabled).toBe(false);
    delete (window as unknown as { vscodeApi?: unknown }).vscodeApi;
  });

  it('configures tools via quick Tool Definition Templates and 1-click Assign & Apply', async () => {
    const requests: ProgramToolUpdateRequest[] = [];
    eventBus.subscribe(EVENT_NAMES.PROGRAM_TOOL_UPDATE_REQUEST, (req: ProgramToolUpdateRequest) => {
      requests.push(req);
      eventBus.publish(EVENT_NAMES.PROGRAM_TOOL_UPDATE_RESULT, {
        requestId: req.requestId,
        channelId: req.channelId,
        success: true,
        message: 'Applied',
      });
    });

    (panel.shadowRoot?.querySelector('[data-manager-tab="program"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(panel.shadowRoot?.querySelector('[data-tool-template="id-boring"]')).toBeTruthy());

    // Select ID Boring XS template and customize via quick pills
    (panel.shadowRoot!.querySelector('[data-tool-template="id-boring"]') as HTMLButtonElement).click();
    expect((panel.shadowRoot!.querySelector('#tool-description') as HTMLInputElement).value).toContain('ID Boring XS');
    (panel.shadowRoot!.querySelector('[data-template-bore-dia="6"]') as HTMLButtonElement).click();
    (panel.shadowRoot!.querySelector('[data-template-boring-side="front-wall"]') as HTMLButtonElement).click();
    expect((panel.shadowRoot!.querySelector('#tool-q') as HTMLInputElement).value).toBe('3');
    expect((panel.shadowRoot!.querySelector('#tool-description') as HTMLInputElement).value).toContain('Dmin 6 mm');

    // Switch to Cut-Off / Grooving template
    (panel.shadowRoot!.querySelector('[data-tool-template="cutoff-groove"]') as HTMLButtonElement).click();
    (panel.shadowRoot!.querySelector('[data-template-groove-kind="grooving"]') as HTMLButtonElement).click();
    (panel.shadowRoot!.querySelector('[data-template-blade-width="2"]') as HTMLButtonElement).click();
    expect((panel.shadowRoot!.querySelector('#insert-width') as HTMLInputElement).value).toBe('2');
    expect((panel.shadowRoot!.querySelector('#insert-zero-vertex') as HTMLInputElement).value).toBe('3');

    // Test 1-click Assign & Apply from library dropdown
    const select = panel.shadowRoot!.querySelector<HTMLSelectElement>('#assign-library-tool')!;
    select.value = 'default-drill-5mm';
    (panel.shadowRoot!.querySelector('#assign-and-apply-tool') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].tool).toMatchObject({
      toolNumber: 1,
      description: 'Drill 5 mm',
      cutting: [{ type: 'drill', diameter: 5 }],
    });
  });

  it('applies Material Definition Templates and quick stock dimension chips', async () => {
    const requests: ProgramSetupUpdateRequest[] = [];
    eventBus.subscribe(EVENT_NAMES.PROGRAM_SETUP_UPDATE_REQUEST, (req: ProgramSetupUpdateRequest) => {
      requests.push(req);
      eventBus.publish(EVENT_NAMES.PROGRAM_SETUP_UPDATE_RESULT, {
        requestId: req.requestId,
        channelId: req.channelId,
        success: true,
        message: 'Material applied',
      });
    });

    (panel.shadowRoot?.querySelector('[data-manager-tab="material"]') as HTMLButtonElement).click();
    (panel.shadowRoot!.querySelector('[data-material-template="swiss-bar-main-sub"]') as HTMLButtonElement).click();
    (panel.shadowRoot!.querySelector('[data-material-quick-diameter="16"]') as HTMLButtonElement).click();
    (panel.shadowRoot!.querySelector('[data-material-quick-length="80"]') as HTMLButtonElement).click();

    expect((panel.shadowRoot!.querySelector('#material-diameter') as HTMLInputElement).value).toBe('16');
    expect((panel.shadowRoot!.querySelector('#material-length') as HTMLInputElement).value).toBe('80');

    (panel.shadowRoot!.querySelector('#material-form') as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].setup.material).toMatchObject({
      type: 'cylinder',
      diameter: 16,
      length: 80,
      zeroVertex: 1,
      channelReferences: {
        '2': { zeroVertex: 0, rotation: [180, 0, 0] },
      },
    });
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
