// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { NCCodePane } from '../NCCodePane';
import { EventBus, EVENT_NAMES } from '@services/EventBus';
import { ProgramMetadataEditService, type ProgramToolUpdateRequest } from '@services/tools/ProgramMetadataEditService';
import { SimulationCommentCodec } from '@services/tools/SimulationCommentCodec';

const syntax = { kind: 'line', prefix: ';' } as const;

function harness(text = 'T1\nG1 X10', revision: string | number = 'editor:0') {
  const eventBus = new EventBus();
  const setValue = vi.fn();
  const syncEditorValue = vi.fn();
  const pane = Object.create(NCCodePane.prototype) as NCCodePane & Record<string, unknown>;
  Object.assign(pane, {
    channelId: '1', eventBus, metadataEdits: new ProgramMetadataEditService(new SimulationCommentCodec()),
    getProgramSource: () => ({
      identity: { documentId: 'doc', programId: 'program', channelId: '1' }, revision, text,
    }),
    setValue, syncEditorValue,
  });
  return { pane, eventBus, setValue, syncEditorValue };
}

function request(overrides: Partial<ProgramToolUpdateRequest> = {}): ProgramToolUpdateRequest {
  return {
    requestId: 'request-1', channelId: '1', documentId: 'doc', programId: 'program',
    expectedRevision: 'editor:0', expectedText: 'T1\nG1 X10', syntax,
    tool: { toolNumber: 1, description: 'Drill', Q: 0 }, ...overrides,
  };
}

describe('NCCodePane program tool updates', () => {
  it('applies one planned text update through the normal editor synchronization route', () => {
    const { pane, eventBus, setValue, syncEditorValue } = harness();
    const result = vi.fn();
    eventBus.subscribe(EVENT_NAMES.PROGRAM_TOOL_UPDATE_RESULT, result);
    (pane as unknown as { applyProgramToolUpdate(value: ProgramToolUpdateRequest): void }).applyProgramToolUpdate(request());
    expect(setValue).toHaveBeenCalledTimes(1);
    expect(syncEditorValue).toHaveBeenCalledTimes(1);
    const nextText = setValue.mock.calls[0][0] as string;
    expect(syncEditorValue).toHaveBeenCalledWith(nextText);
    expect(nextText).toContain('; @NCE-SIM:1 BEGIN TOOL');
    expect(nextText).toContain('; Q=0');
    expect(result).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ success: true, requestId: 'request-1' }));
  });

  it.each([
    { expectedRevision: 'editor:1' },
    { expectedText: 'changed' },
    { documentId: 'other' },
    { programId: 'other' },
  ])('rejects stale or wrongly routed requests without changing text: %o', (overrides) => {
    const { pane, eventBus, setValue, syncEditorValue } = harness();
    const result = vi.fn();
    eventBus.subscribe(EVENT_NAMES.PROGRAM_TOOL_UPDATE_RESULT, result);
    (pane as unknown as { applyProgramToolUpdate(value: ProgramToolUpdateRequest): void })
      .applyProgramToolUpdate(request(overrides));
    expect(setValue).not.toHaveBeenCalled();
    expect(syncEditorValue).not.toHaveBeenCalled();
    expect(result).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ success: false, message: expect.stringContaining('changed') }));
  });

  it('ignores requests owned by another channel', () => {
    const { pane, eventBus, setValue } = harness();
    const result = vi.fn();
    eventBus.subscribe(EVENT_NAMES.PROGRAM_TOOL_UPDATE_RESULT, result);
    (pane as unknown as { applyProgramToolUpdate(value: ProgramToolUpdateRequest): void })
      .applyProgramToolUpdate(request({ channelId: '2' }));
    expect(setValue).not.toHaveBeenCalled();
    expect(result).not.toHaveBeenCalled();
  });
});
