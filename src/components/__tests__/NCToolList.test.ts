// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../NCToolList';
import { ServiceRegistry } from '@core/ServiceRegistry';
import {
  EVENT_BUS_TOKEN,
  FILE_MANAGER_SERVICE_TOKEN,
  PROGRAM_TOOL_SERVICE_TOKEN,
  STATE_SERVICE_TOKEN,
} from '@core/ServiceTokens';
import { EventBus, EVENT_NAMES } from '@services/EventBus';
import type { IFileManagerService } from '@services/IFileManagerService';
import type { StateService } from '@services/StateService';
import type { ProgramToolUpdateRequest } from '@services/tools/ProgramMetadataEditService';
import { ProgramToolService, type ProgramSource } from '@services/tools/ProgramToolService';
import { SimulationCommentCodec } from '@services/tools/SimulationCommentCodec';

describe('NCToolList', () => {
  const registry = ServiceRegistry.getInstance();
  const syntax = { kind: 'line', prefix: ';' } as const;
  let bus: EventBus;
  let source: ProgramSource;

  beforeEach(async () => {
    await registry.disposeAll();
    document.body.replaceChildren();
    bus = new EventBus();
    source = {
      identity: { documentId: 'doc', programId: 'program', channelId: '1' },
      revision: 'editor:0',
      text: new SimulationCommentCodec().encodeTool({
        toolNumber: 1,
        description: 'Drill',
        cutting: [{ type: 'drill', diameter: 8, length: 45, tipAngle: 118 }],
      }, syntax),
    };
    registry.register(EVENT_BUS_TOKEN, () => bus);
    registry.register(PROGRAM_TOOL_SERVICE_TOKEN, () => new ProgramToolService(new SimulationCommentCodec(), bus));
    registry.register(FILE_MANAGER_SERVICE_TOKEN, () => ({
      getActiveProgram: () => ({ id: 'program', sourceFileId: 'doc' }),
    }) as unknown as IFileManagerService);
    registry.register(STATE_SERVICE_TOKEN, () => ({
      getState: () => ({ activeMachine: { simulationCommentSyntax: syntax } }),
    }) as StateService);
    const channel = document.createElement('nc-channel-pane');
    channel.dataset.channel = '1';
    const editor = document.createElement('nc-code-pane') as HTMLElement & {
      getProgramSource(): ProgramSource;
    };
    editor.getProgramSource = () => source;
    channel.append(editor);
    document.body.append(channel);
  });

  afterEach(async () => {
    document.body.replaceChildren();
    await registry.disposeAll();
  });

  it('applies edited Q/R to program metadata while preserving existing geometry', async () => {
    const request = vi.fn((payload: ProgramToolUpdateRequest) => {
      bus.publish(EVENT_NAMES.PROGRAM_TOOL_UPDATE_RESULT, {
        requestId: payload.requestId, channelId: '1', success: true, message: 'Applied',
      });
    });
    bus.subscribe(EVENT_NAMES.PROGRAM_TOOL_UPDATE_REQUEST, request);
    const list = document.createElement('nc-tool-list');
    list.setAttribute('channel-id', '1');
    document.body.append(list);
    bus.publish(EVENT_NAMES.PARSE_COMPLETED, {
      channelId: '1', result: {}, artifacts: { toolRegisters: [{ toolNumber: 1 }] },
    });
    const root = list.shadowRoot!;
    const qInput = root.querySelector<HTMLInputElement>('input[data-type="q"]')!;
    qInput.value = '3';
    qInput.dispatchEvent(new Event('change'));
    expect(source.text).not.toContain('; Q=3');
    root.querySelector<HTMLButtonElement>('.apply-button')!.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0][0]).toMatchObject({
      expectedRevision: 'editor:0',
      expectedText: source.text,
      tool: {
        toolNumber: 1,
        description: 'Drill',
        Q: 3,
        cutting: [{ type: 'drill', diameter: 8, length: 45, tipAngle: 118 }],
      },
    });
  });
});