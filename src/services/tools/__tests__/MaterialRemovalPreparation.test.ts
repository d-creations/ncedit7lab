import { describe, expect, it } from 'vitest';
import type { ChannelId, PlotMetadata, PlotSegment } from '@core/types';
import type { PlotRunInput } from '../PlotRunSnapshot';
import type { ProgramMaterialDefinition } from '../SimulationMetadata';
import { SimulationCommentCodec } from '../SimulationCommentCodec';
import { ProgramToolService } from '../ProgramToolService';
import { prepareMaterialRemoval } from '../MaterialRemovalPreparation';

const syntax = { kind: 'line', prefix: ';' } as const;
const codec = new SimulationCommentCodec();
const tools = new ProgramToolService(codec);
const stock: ProgramMaterialDefinition = { type: 'cylinder', diameter: 20, length: 40, zeroVertex: 1 };

function input(channelId: ChannelId = '1', material?: ProgramMaterialDefinition): PlotRunInput {
  const text = [
    codec.encodeSetup({ machineName: 'test', material }, syntax),
    codec.encodeTool({ toolNumber: '1', description: 'mill',
      cutting: [{ type: 'endMill', diameter: 2, length: 10 }],
    }, syntax),
  ].join('\n');
  return {
    snapshot: tools.captureProgramSnapshot({ channelId, documentId: 'doc', programId: channelId }, 0, text, syntax),
    machineName: 'test', toolValues: [], customVariables: [],
  };
}

function move(overrides: Partial<PlotSegment> = {}): PlotSegment {
  return {
    type: 'feed', channelId: '1', toolNumber: '1', machiningMode: 'milling',
    executionStep: 0, sourceSegmentIndex: 0, subsegmentIndex: 0,
    startPoint: { x: 10, y: 0, z: 0 }, endPoint: { x: 9, y: 0, z: 0 },
    poses: [
      { position: [10, 0, 0], orientation: [0, 0, 0, 1], reference: 'millingTip', frameId: 'workpiece:mainSpindle' },
      { position: [9, 0, 0], orientation: [0, 0, 0, 1], reference: 'millingTip', frameId: 'workpiece:mainSpindle' },
    ],
    ...overrides,
  };
}

function metadata(...segments: PlotSegment[]): PlotMetadata {
  return { points: [], segments };
}

describe('material removal prerequisites', () => {
  it('does not guess stock for metadata-free programs', () => {
    expect(prepareMaterialRemoval([input()], metadata(move()))).toEqual({
      status: 'not-configured', channelIds: ['1'], diagnostics: [],
    });
  });

  it('deduplicates equal stock including omitted default transforms, but does not infer channel timing', () => {
    const result = prepareMaterialRemoval([
      input('1', stock), input('2', { ...stock, position: [0, 0, 0], rotation: [0, 0, 0] }),
    ], metadata(move()));
    expect(result.stock).toEqual(stock);
    expect(result.channelIds).toEqual(['1', '2']);
    expect(result.frameId).toBe('workpiece:mainSpindle');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code))
      .toEqual(['stock-frame-unresolved', 'spindle-state-unavailable', 'channel-order-unavailable']);
  });

  it.each([
    { ...stock, diameter: 21 },
    { ...stock, position: [1, 0, 0] as [number, number, number] },
    { ...stock, zeroVertex: 0 },
    { type: 'cylinder' as const, diameter: 20, length: 40 },
  ])('does not render conflicting channel stocks as separate workpieces: %j', (other) => {
    const result = prepareMaterialRemoval([input('1', stock), input('2', other)], metadata());
    expect(result.status).toBe('blocked');
    expect(result.stock).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['stock-conflict']);
  });

  it('does not invent a stock-frame transform or spindle state from a valid milling pose', () => {
    const result = prepareMaterialRemoval([input('1', stock)], metadata(move()));
    expect(result.status).toBe('blocked');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code))
      .toEqual(['stock-frame-unresolved', 'spindle-state-unavailable']);
  });

  it('flags missing mode, exact tool identity and aligned poses without borrowing prior motion state', () => {
    const result = prepareMaterialRemoval([input('1', stock)], metadata(
      move(), move({ machiningMode: 'unknown', toolNumber: 1, poses: undefined }),
    ));
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'stock-frame-unresolved', 'spindle-state-unavailable',
      'motion-mode-unavailable', 'tool-geometry-unavailable', 'tool-pose-unavailable',
    ]);
  });

  it('ignores rapid traversal for cutting prerequisites, even when the mode is turning', () => {
    const result = prepareMaterialRemoval([input('1', stock)], metadata(
      move({ type: 'rapid', machiningMode: 'turning', toolNumber: undefined, poses: undefined }),
    ));
    expect(result.diagnostics.map((diagnostic) => diagnostic.code))
      .toEqual(['stock-frame-unresolved', 'spindle-state-unavailable']);
  });

  it('keeps turning references and workpiece transfer explicitly unresolved', () => {
    const turning = move({ machiningMode: 'turning' });
    const other = move({ poses: move().poses!.map((pose) => ({ ...pose, frameId: 'workpiece:subSpindle' })) });
    const result = prepareMaterialRemoval([input('1', stock)], metadata(turning, other));
    expect(result.frameId).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('turning-reference-unverified');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('multiple-workpiece-frames');
  });

  it.each([
    { position: [NaN, 0, 0] as const },
    { orientation: [0, 0, 0, 0] as const },
    { frameId: '' },
  ])('does not accept an invalid pose as a resolved stock frame: %j', (override) => {
    const segment = move({ poses: move().poses!.map((pose) => ({ ...pose, ...override })) });
    const result = prepareMaterialRemoval([input('1', stock)], metadata(segment));
    expect(result.frameId).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('tool-pose-unavailable');
  });
});
