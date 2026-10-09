import { describe, expect, it } from 'vitest';
import type { ChannelId, PlotMetadata, PlotSegment } from '@core/types';
import type { PlotRunInput } from '../PlotRunSnapshot';
import type { ProgramMaterialDefinition } from '../SimulationMetadata';
import { SimulationCommentCodec } from '../SimulationCommentCodec';
import { ProgramToolService } from '../ProgramToolService';
import { prepareMaterialRemoval } from '../MaterialRemovalPreparation';
import type { ProgramToolDefinition } from '../SimulationMetadata';
import type { StockBinding } from '../../simulation/SimulationTypes';

const syntax = { kind: 'line', prefix: ';' } as const;
const codec = new SimulationCommentCodec();
const tools = new ProgramToolService(codec);
const stock: ProgramMaterialDefinition = { type: 'cylinder', diameter: 20, length: 40, zeroVertex: 1 };
const setup = {
  binding: {
    frameId: 'workpiece:mainSpindle', position: [0, 0, 0], rotation: [0, 0, 0],
    spindleOrigin: [0, 0, 0], spindleAxis: [0, 0, 1],
  },
  resolutionMm: 0.5,
} satisfies NonNullable<PlotRunInput['materialSimulation']>;

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

function machineInput(bindings: StockBinding[] = [setup.binding]): PlotRunInput {
  return {
    ...input('1', stock),
    machineProfile: {
      machineName: 'test', controlType: 'test', axes: ['C1'], availableChannels: 1,
      defaultTools: [], feedLimits: { min: 0, max: 10000 },
      simulation: {
        schemaVersion: 1, revision: 1, modelId: 'test', displayName: 'test',
        fidelity: 'configured', poseContract: 'workpiece-tool-reference-v1',
        carriers: ['mainSpindle', 'subSpindle'].map((id) => ({
          id, role: 'workpiece', referenceOrientationDegrees: [0, 0, 0], rotationChain: [],
        })),
        toolMounts: [], stockBindings: structuredClone(bindings),
      },
    },
  };
}

describe('material removal prerequisites', () => {
  it('uses the matching backend stock binding with 0.05 mm detail and captures a copy', () => {
    const source = machineInput([setup.binding, { ...setup.binding, frameId: 'workpiece:subSpindle' }]);
    const result = prepareMaterialRemoval([source], metadata(move()));
    expect(result.status).toBe('ready');
    expect(result.simulation?.resolutionMm).toBe(0.05);
    expect(result.simulation?.binding).toEqual(setup.binding);
    expect(result.simulation?.binding).not.toBe(source.machineProfile?.simulation?.stockBindings?.[0]);
  });

  it('prefers program overrides, and then explicit setup, over backend defaults', () => {
    const source = machineInput();
    source.materialSimulation = {
      binding: { ...setup.binding, position: [1, 0, 0] }, resolutionMm: 0.1,
    };
    expect(prepareMaterialRemoval([source], metadata(move())).simulation).toMatchObject(source.materialSimulation);
    expect(prepareMaterialRemoval([source], metadata(move()), setup).simulation).toMatchObject(setup);
  });

  it('requires manual binding for unmatched or multiple executed workpiece frames', () => {
    const source = machineInput([{ ...setup.binding, frameId: 'workpiece:subSpindle' }]);
    expect(prepareMaterialRemoval([source], metadata(move())).status).toBe('blocked');
    const other = move({ poses: move().poses?.map((pose) => ({ ...pose, frameId: 'workpiece:subSpindle' })) });
    expect(prepareMaterialRemoval([machineInput()], metadata(move(), other)).status).toBe('blocked');
  });

  it.each([
    [{ ...setup.binding, spindleAxis: [0, 0, 0] }],
    [{ ...setup.binding, frameId: 'workpiece:unknown' }],
    [setup.binding, setup.binding],
    [{ ...setup.binding, position: [Infinity, 0, 0] }],
  ] satisfies StockBinding[][])('rejects invalid backend binding defaults: %j', (...bindings) => {
    expect(() => prepareMaterialRemoval([machineInput(bindings)], metadata(move()))).toThrow();
  });

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
      .toEqual(['spindle-state-unavailable', 'channel-order-unavailable', 'stock-frame-unresolved']);
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
      .toEqual(['spindle-state-unavailable', 'stock-frame-unresolved']);
  });

  it.each([
    ['motion-mode-unavailable', { machiningMode: 'unknown' as const }],
    ['tool-geometry-unavailable', { toolNumber: 1 }],
    ['tool-pose-unavailable', { poses: undefined }],
  ])('stops at %s without borrowing prior motion state', (code, override) => {
    const result = prepareMaterialRemoval([input('1', stock)], metadata(
      move(), move(override),
    ), setup);
    expect(result.status).toBe('ready');
    expect(result.simulation?.motions).toHaveLength(1);
    expect(result.simulation?.stop).toBeDefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
  });

  it('ignores rapid traversal for cutting prerequisites, even when the mode is turning', () => {
    const result = prepareMaterialRemoval([input('1', stock)], metadata(
      move({ type: 'rapid', machiningMode: 'turning', toolNumber: undefined, poses: undefined }),
    ), setup);
    expect(result.status).toBe('ready');
    expect(result.simulation?.motions).toHaveLength(0);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code))
      .toEqual(['spindle-state-unavailable']);
  });

  it('rejects inconsistent turning references before cutting and stops on a different workpiece target', () => {
    const turning = move({ machiningMode: 'turning' });
    const other = move({ poses: move().poses!.map((pose) => ({ ...pose, frameId: 'workpiece:subSpindle' })) });
    const result = prepareMaterialRemoval([input('1', stock)], metadata(turning), setup);
    expect(result.simulation?.motions).toHaveLength(0);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('turning-reference-unverified');
    const transfer = prepareMaterialRemoval([input('1', stock)], metadata(move(), other), setup);
    expect(transfer.simulation?.motions).toHaveLength(1);
    expect(transfer.diagnostics.map((diagnostic) => diagnostic.code)).toContain('multiple-workpiece-frames');
  });

  it.each([
    { position: [NaN, 0, 0] as const },
    { orientation: [0, 0, 0, 0] as const },
    { frameId: '' },
  ])('does not accept an invalid pose as a resolved stock frame: %j', (override) => {
    const segment = move({ poses: move().poses!.map((pose) => ({ ...pose, ...override })) });
    const result = prepareMaterialRemoval([input('1', stock)], metadata(segment), setup);
    expect(result.simulation?.motions).toHaveLength(0);
    expect(result.simulation?.stop).toBeDefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('tool-pose-unavailable');
  });

  it('prepares ordinary milling when the stock transform is explicit, with spindle absence only a warning', () => {
    const result = prepareMaterialRemoval([input('1', stock)], metadata(move()), setup);
    expect(result.status).toBe('ready');
    expect(result.simulation?.motions).toHaveLength(1);
    expect(result.simulation?.binding).toEqual(setup.binding);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: 'spindle-state-unavailable', severity: 'warning',
    })]);
  });

  it('does not skip unsupported motions discarded by path display conversion', () => {
    const result = prepareMaterialRemoval([input('1', stock)], {
      ...metadata(move({ sourceSegmentIndex: 0 }), move({ sourceSegmentIndex: 2 })),
      removalStops: [{ channelId: '1', sourceSegmentIndex: 1, executionStep: 7,
        message: 'Unknown compound motion', lineNumber: 20 }],
    }, setup);
    expect(result.simulation?.motions).toHaveLength(1);
    expect(result.simulation?.stop).toMatchObject({ executionStep: 7, lineNumber: 20 });
  });

  it.each(['G76', 'G92', 'G36', 'G161'])('stops at unsupported special operation %s', (sourceCode) => {
    const result = prepareMaterialRemoval([input('1', stock)], metadata(move(), move({ sourceCode })), setup);
    expect(result.simulation?.motions).toHaveLength(1);
    expect(result.simulation?.stop?.message).toContain(sourceCode);
  });

  it('does not use synthetic default preview tools as physical cutting definitions', () => {
    const original = input('1', stock);
    original.snapshot = { ...original.snapshot, geometry: [] };
    const result = prepareMaterialRemoval([original], metadata(move()), setup);
    expect(result.simulation?.motions).toHaveLength(0);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('tool-geometry-unavailable');
  });

  it('rejects invalid explicit stock transforms rather than using identity', () => {
    expect(() => prepareMaterialRemoval([input('1', stock)], metadata(move()), {
      ...setup, binding: { ...setup.binding, spindleAxis: [0, 0, 0] },
    })).toThrow('unit direction');
  });

  it('prepares a conventional rounded insert using executed Q instead of the stored default', () => {
    const original = input('1', stock);
    const tool: ProgramToolDefinition = {
      toolNumber: '1', description: 'turning', Q: 1,
      cutting: [{ type: 'insert', shape: 'C', ic: 6, thickness: 2,
        noseRadius: 0.2, clearanceAngle: 7, rotation: [0, 45, 0] }],
    };
    original.snapshot = tools.captureProgramSnapshot(original.snapshot.identity, 1,
      codec.encodeSetup({ machineName: 'test', material: stock }, syntax) + '\n' + codec.encodeTool(tool, syntax), syntax);
    const turning = move({
      machiningMode: 'turning', sourceCode: 'G1',
      motionContext: { channelId: '1', startAxes: {}, endAxes: {}, toolOffset: { radiusMode: 'OFF', tipOrientation: 3 } },
      poses: move().poses!.map((pose) => ({ ...pose, reference: 'turningVirtualTip' })),
    });
    const result = prepareMaterialRemoval([original], metadata(turning), setup);
    expect(result.status).toBe('ready');
    expect(result.simulation?.stop).toBeUndefined();
    expect(result.simulation?.motions[0].executedQ).toBe(3);
    expect(result.simulation?.motions[0].tool.Q).toBe(1);
    const compensated = prepareMaterialRemoval([original], metadata({
      ...turning, motionContext: { ...turning.motionContext!, toolOffset: { radiusMode: 'G41', tipOrientation: 3 } },
    }), setup);
    expect(compensated.simulation?.motions).toHaveLength(0);
    expect(compensated.simulation?.stop?.message).toContain('Compensated turning');
  });

  it('rejects undersampled full-turn rotations rather than interpreting equal quaternions as no motion', () => {
    const result = prepareMaterialRemoval([input('1', stock)], metadata(move({
      motionContext: { channelId: '1', startAxes: { C: 0 }, endAxes: { C: 360 }, toolOffset: { radiusMode: 'OFF' } },
    })), setup);
    expect(result.simulation?.motions).toHaveLength(0);
    expect(result.simulation?.stop?.message).toContain('not sufficiently sampled');
  });
});
