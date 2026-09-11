import { describe, expect, it } from 'vitest';
import { ProgramToolService } from '../ProgramToolService';
import { SimulationCommentCodec } from '../SimulationCommentCodec';
import { toToolValues } from '../toToolValues';
import { EventBus } from '../../EventBus';

const codec = new SimulationCommentCodec();
const service = new ProgramToolService(codec);
const syntax = { kind: 'line', prefix: ';' } as const;
const identity = { documentId: 'doc-a', programId: 'program-a', channelId: '1' } as const;

describe('ProgramToolService', () => {
  it('releases temporary values when their program closes', () => {
    const bus = new EventBus();
    const scoped = new ProgramToolService(codec, bus);
    scoped.setTemporaryToolValues(identity, [{ toolNumber: 0, qValue: 0 }]);
    bus.publish('program:closed', { programId: identity.programId });
    expect(scoped.getTemporaryToolValues(identity)).toEqual([]);
    scoped.dispose();
  });
  it('preserves temporary Q/R by exact program identity but gives managed records precedence', () => {
    const scoped = new ProgramToolService(codec);
    const other = { ...identity, programId: 'other' };
    scoped.setTemporaryToolValues(identity, [{ toolNumber: 0, qValue: 0 }, { toolNumber: '0', rValue: 2 }]);
    scoped.setTemporaryToolValues(other, [{ toolNumber: 0, rValue: 9 }]);
    const plain = scoped.captureProgramSnapshot(identity, 0, 'T0');
    expect(scoped.getExecutionToolValues(plain)).toEqual([{ toolNumber: 0, qValue: 0 }, { toolNumber: '0', rValue: 2 }]);
    const managed = scoped.captureProgramSnapshot(identity, 1,
      codec.encodeTool({ toolNumber: 0, description: '', R: 0 }, syntax), syntax);
    expect(scoped.getExecutionToolValues(managed)).toEqual([{ toolNumber: '0', rValue: 2 }, { toolNumber: 0, rValue: 0 }]);
    expect(scoped.getTemporaryToolValues(other)).toEqual([{ toolNumber: 0, rValue: 9 }]);
    scoped.getTemporaryToolValues(other)[0].rValue = 99;
    expect(scoped.getTemporaryToolValues(other)[0].rValue).toBe(9);
    expect(() => scoped.setTemporaryToolValues(identity, [{ toolNumber: 1, rValue: NaN }])).toThrow();
  });
  it('captures exact text/revision and deeply freezes detached state without catalog access', () => {
    const mutableIdentity = { ...identity };
    const tool = {
      toolNumber: 1,
      description: 'original',
      Q: 0,
      holder: [{ type: 'cylinder' as const, diameter: 8, length: 20 }],
      cutting: [{ type: 'endMill' as const, diameter: 8, length: 30 }],
    };
    const source = codec.encodeTool(tool, syntax);
    const first = service.captureProgramSnapshot(mutableIdentity, 0, source, syntax);
    tool.description = 'changed';
    tool.holder[0].diameter = 100;
    Object.assign(mutableIdentity, { programId: 'other-program' });
    const second = service.captureProgramSnapshot(
      identity,
      1,
      codec.encodeTool(tool, syntax),
      syntax,
    );

    expect(first.text).toBe(source);
    expect(first.revision).toBe(0);
    expect(first.identity.programId).toBe('program-a');
    expect(first.tools[0].description).toBe('original');
    expect(first.tools[0].holder?.[0]).toMatchObject({ diameter: 8 });
    expect(second.tools[0].description).toBe('changed');
    expect(Object.isFrozen(first.tools[0].holder?.[0])).toBe(true);
    expect(Object.isFrozen(first.tools)).toBe(true);
    expect(() => Object.assign(first.tools[0], { description: 'mutated' })).toThrow();
    expect(first.geometry[0].status).toBe('single-cutter');
    const overrides = service.getToolValues(first);
    overrides[0].qValue = 999;
    expect(service.getToolValues(first)).toEqual([{ toolNumber: 1, qValue: 0 }]);
  });

  it('isolates program/channel snapshots and supports Q/R-only and multi-cutter definitions', () => {
    const tool = { toolNumber: 'DRILL', description: '', R: 0 };
    const first = service.captureProgramSnapshot(
      identity,
      'a',
      codec.encodeTool(tool, syntax),
      syntax,
    );
    const other = service.captureProgramSnapshot(
      { ...identity, programId: 'other', channelId: '2' },
      'a',
      codec.encodeTool(
        {
          ...tool,
          R: 2,
          cutting: [
            { type: 'endMill', diameter: 4, length: 20 },
            { type: 'endMill', diameter: 8, length: 20 },
          ],
        },
        syntax,
      ),
      syntax,
    );
    expect(first.geometry[0].status).toBe('missing');
    expect(other.geometry[0].status).toBe('unsupported-multi-cutter');
    expect(service.getToolValues(first)).toEqual([{ toolNumber: 'DRILL', rValue: 0 }]);
    expect(service.getToolValues(other)).toEqual([{ toolNumber: 'DRILL', rValue: 2 }]);
  });

  it('accepts metadata-free programs but never guesses a dialect or projects invalid partial snapshots', () => {
    const plain = service.captureProgramSnapshot(identity, 1, 'T1\nG0 X1');
    expect(plain.valid).toBe(true);
    expect(service.getToolValues(plain)).toEqual([]);
    const text = codec.encodeTool({ toolNumber: 1, description: '', Q: 0 }, syntax);
    const missingSyntax = service.captureProgramSnapshot(identity, 2, text);
    expect(missingSyntax.valid).toBe(false);
    expect(missingSyntax.text).toBe(text);
    expect(() => service.getToolValues(missingSyntax)).toThrow();
    const duplicate = service.captureProgramSnapshot(identity, 3, `${text}\n${text}`, syntax);
    expect(duplicate.valid).toBe(false);
    expect(() => service.getToolValues(duplicate)).toThrow();
  });

  it('uses persisted offsets from the exact snapshot without opening the Tool Manager', () => {
    const text = codec.encodeOffsets({
      offsetScope: 'tool',
      offsets: [
        { toolNumber: 1, offsetNumber: 2, rValue: 0.4 },
        { toolNumber: '1', offsetNumber: 2, rValue: 0.8 },
      ],
    }, syntax);
    const snapshot = service.captureProgramSnapshot(identity, 4, text, syntax);
    expect(service.getExecutionToolOffsets(snapshot, {
      mode: 'direct', namedTools: true, offsetScope: 'tool',
    })).toEqual([
      { toolNumber: 1, offsetNumber: 2, rValue: 0.4 },
      { toolNumber: '1', offsetNumber: 2, rValue: 0.8 },
    ]);
    expect(() => service.getExecutionToolOffsets(snapshot, {
      mode: 'packed', namedTools: false, offsetScope: 'global',
    })).toThrow('scope does not match');
  });

  it('requires document identity and revision rather than addressing by channel alone', () => {
    expect(() => service.captureProgramSnapshot({ ...identity, documentId: '' }, 1, '')).toThrow();
    expect(() => service.captureProgramSnapshot(identity, NaN, '')).toThrow();
    expect(() => service.captureProgramSnapshot(identity, '', '')).toThrow();
  });
});

describe('toToolValues', () => {
  it('preserves exact numeric/named/zero identifiers and zero overrides; omits undefined fields', () => {
    expect(
      toToolValues([
        { toolNumber: 0, Q: 0, R: 0 },
        { toolNumber: 1, R: 0.4 },
        { toolNumber: '1', Q: 3 },
        { toolNumber: 'DRILL' },
      ]),
    ).toEqual([
      { toolNumber: 0, qValue: 0, rValue: 0 },
      { toolNumber: 1, rValue: 0.4 },
      { toolNumber: '1', qValue: 3 },
    ]);
  });
  it.each([
    [{ toolNumber: 'unknown', Q: 1 }],
    [{ toolNumber: 1, Q: NaN }],
    [{ toolNumber: 1, R: Infinity }],
    [{ toolNumber: '', R: 1 }],
    [{ toolNumber: 1 }, { toolNumber: 1, Q: 1 }],
  ])('rejects invalid or duplicate overrides: %j', (...tools) => {
    expect(() => toToolValues(tools)).toThrow();
  });
  it('does not invent controller-specific compensation ranges', () => {
    expect(toToolValues([{ toolNumber: 1, Q: -1, R: -0.4 }])).toEqual([
      { toolNumber: 1, qValue: -1, rValue: -0.4 },
    ]);
  });
});
