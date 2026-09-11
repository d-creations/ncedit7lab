import { describe, expect, it } from 'vitest';
import { SimulationCommentCodec } from '../SimulationCommentCodec';
import type { SimulationCommentSyntax } from '../SimulationCommentCodec';
import { METADATA_LIMITS } from '../SimulationMetadata';
import type { ProgramToolDefinition, ProgramSetupDefinition } from '../SimulationMetadata';

const codec = new SimulationCommentCodec();
const semicolon: SimulationCommentSyntax = { kind: 'line', prefix: ';' };
const parentheses: SimulationCommentSyntax = { kind: 'block', open: '(', close: ')' };
const drill: ProgramToolDefinition = {
  toolNumber: 0,
  description: 'Drill 8 mm',
  Q: 0,
  R: 0,
  holder: [{ type: 'cylinder', diameter: 8, length: 35, position: [0, 0, 45], stickOut: 55 }],
  cutting: [{ type: 'drill', diameter: 8, length: 45, tipAngle: 118 }],
};
const block = (records: string[], kind = 'TOOL', version = '1') =>
  [
    `; @NCE-SIM:${version} BEGIN ${kind}`,
    ...records.map((line) => `; ${line}`),
    `; @NCE-SIM:${version} END ${kind}`,
  ].join('\n');

describe('SimulationCommentCodec', () => {
  it.each([semicolon, parentheses, { kind: 'line', prefix: '//' } as const])(
    'round-trips complete geometry and centred material with explicit syntax %j',
    (syntax) => {
      const setup: ProgramSetupDefinition = {
        machineName: 'SIEMENS_MILL',
        material: {
          type: 'box',
          width: 100,
          depth: 60,
          height: 20,
          position: [50, 30, -10],
          rotation: [0, 0, 90],
        },
      };
      const encoded = `${codec.encodeSetup(setup, syntax)}\n${codec.encodeTool(drill, syntax)}\nT0\nG1 X2`;
      const parsed = codec.parse(encoded, syntax);
      expect(parsed.diagnostics).toEqual([]);
      expect(parsed.setup).toEqual(setup);
      expect(parsed.tools).toEqual([drill]);
      expect(parsed.blocks).toHaveLength(2);
      expect(encoded).not.toMatch(/units=|frame=|channelId=/);
    },
  );

  it.each([semicolon, parentheses])(
    'escapes injection, Unicode, surrogate pairs and continuations (%j)',
    (style) => {
      const syntax = { ...style, maxLineLength: 58 };
      const tool = {
        ...drill,
        description: ' ) G0 X999 ( ; % <>& " \\ \r\n café 工具 🛠 '.repeat(8),
      };
      const encoded = codec.encodeTool(tool, syntax, '\r\n');
      expect(encoded.split('\r\n').every((line) => line.length <= 58)).toBe(true);
      expect(encoded).toMatch(/description@1\/[0-9]+=/);
      expect(encoded).not.toContain('工具');
      for (const line of encoded.split('\r\n')) {
        if (style.kind === 'block') expect(line.match(/[()]/g)).toEqual(['(', ')']);
        else expect(line.startsWith('; ')).toBe(true);
        const fragment = line.replace(/\)$/, '').split(/=(.*)/s)[1];
        if (fragment) expect(fragment).not.toMatch(/(?<!\\)\\u[0-9a-f]{0,3}$/i);
      }
      const parsed = codec.parse(encoded, syntax);
      expect(parsed.diagnostics).toEqual([]);
      expect(parsed.tools).toEqual([tool]);
      expect(codec.encodeTool(parsed.tools[0], syntax, '\r\n')).toBe(encoded);
    },
  );

  it('preserves exact source spans and mixed LF/CRLF endings without rewriting unrelated code', () => {
    const raw = codec.encodeTool(drill, semicolon, '\r\n');
    const prefix = '%\r\nO1234\n; ordinary comment\r\n';
    const source = `${prefix}${raw}\r\nT0\nG1 X10\r\n`;
    const parsed = codec.parse(source, semicolon);
    const span = parsed.blocks[0];
    expect(span.startOffset).toBe(prefix.length);
    expect(span.startLine).toBe(4);
    expect(span.raw).toBe(`${raw}\r\n`);
    expect(source.slice(span.startOffset, span.endOffset)).toBe(span.raw);
    expect(source.slice(span.endOffset)).toBe('T0\nG1 X10\r\n');
  });

  it('round-trips cylinder material and absent material without inventing a workpiece', () => {
    for (const setup of [
      {
        machineName: 'TURN',
        material: {
          type: 'cylinder' as const,
          diameter: 40,
          length: 100,
          position: [0, 0, -50] as [number, number, number],
        },
      },
      { machineName: 'TURN' },
    ]) {
      expect(codec.parse(codec.encodeSetup(setup, semicolon), semicolon).setup).toEqual(setup);
    }
  });

  it('round-trips one exact typed offset table independently from tool geometry', () => {
    const offsets = {
      offsetScope: 'tool' as const,
      offsets: [
        { toolNumber: 1, offsetNumber: 2, rValue: 0.4 },
        { toolNumber: '1', offsetNumber: 2, qValue: 0, lengthValue: 12, edgeNumber: 3 },
      ],
    };
    const encoded = codec.encodeOffsets(offsets, semicolon);
    const parsed = codec.parse(`${codec.encodeTool(drill, semicolon)}\n${encoded}`, semicolon);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.offsets).toEqual(offsets);
    expect(parsed.tools).toEqual([drill]);
  });

  it('preserves unsupported versions and geometry verbatim with diagnostics', () => {
    for (const raw of [
      block(['toolNumber=1', 'description="future"'], 'TOOL', '2'),
      block([
        'toolNumber=1',
        'description="special"',
        'cutting=[{"type":"threading","profile":"custom"}]',
      ]),
      block(['payload="future"'], 'FIXTURE'),
    ]) {
      const parsed = codec.parse(raw, semicolon);
      expect(parsed.diagnostics).not.toHaveLength(0);
      expect(parsed.tools).toEqual([]);
      expect(parsed.blocks[0].raw).toBe(raw);
      expect(parsed.blocks[0].value).toBeUndefined();
    }
  });

  it.each([
    ['toolNumber=1', 'toolNumber=2', 'description="duplicate"'],
    ['toolNumber=1', 'description="bad"', 'Q=1e999'],
    ['toolNumber=1', 'description="bad"', 'units="inch"'],
    ['toolNumber=1', 'description="bad"', 'constructor={"prototype":{"polluted":true}}'],
    [
      'toolNumber=1',
      'description="bad"',
      'cutting=[{"type":"drill","__proto__":{"polluted":true}}]',
    ],
    ['toolNumber=1', 'description="bad"', 'R=globalThis.hacked()'],
    ['toolNumber=1', 'description@2/2="bad"'],
    ['toolNumber=1', 'description@1/2="bad', 'description@2/3="'],
    ['toolNumber=1', 'description@1/1="bad"'],
    ['toolNumber=1', 'description@1/2="bad', 'Q=0'],
  ])('rejects malformed/unsafe records: %j', (...records) => {
    const raw = block(records);
    const parsed = codec.parse(raw, semicolon);
    expect(parsed.diagnostics).not.toHaveLength(0);
    expect(parsed.tools).toEqual([]);
    expect(parsed.blocks[0].raw).toBe(raw);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('rejects unterminated/injected blocks and recovers the next valid block for inspection', () => {
    const incomplete = '; @NCE-SIM:1 BEGIN TOOL\n; toolNumber=7\n';
    const parsed = codec.parse(incomplete + codec.encodeTool(drill, semicolon), semicolon);
    expect(parsed.diagnostics).not.toHaveLength(0);
    expect(parsed.blocks[0].raw).toBe(incomplete);
    expect(parsed.tools).toEqual([drill]);
    const injected =
      '( @NCE-SIM:1 BEGIN TOOL )\n(description="oops") G0 X99 ("bad")\n(@NCE-SIM:1 END TOOL)';
    expect(codec.parse(injected, parentheses).tools).toEqual([]);
    expect(codec.parse(injected, parentheses).diagnostics).not.toHaveLength(0);
  });

  it('diagnoses duplicate definitions while keeping numeric 1 distinct from named "1"', () => {
    const number = codec.encodeTool({ toolNumber: 1, description: 'numeric' }, semicolon);
    const named = codec.encodeTool({ toolNumber: '1', description: 'named' }, semicolon);
    expect(codec.parse(`${number}\n${named}`, semicolon).tools).toHaveLength(2);
    expect(codec.parse(`${number}\n${number}`, semicolon).diagnostics).not.toHaveLength(0);
    const setup = codec.encodeSetup({ machineName: 'A' }, semicolon);
    expect(codec.parse(`${setup}\n${setup}`, semicolon).diagnostics).not.toHaveLength(0);
  });

  it('does not recognize inline mentions or executable parentheses as managed records', () => {
    const parsed = codec.parse(
      'G1 X(SIN(30))\n; mentions T1 and @NCE-SIM:1 BEGIN TOOL\nT1 ; @NCE-SIM:1 BEGIN TOOL',
      semicolon,
    );
    expect(parsed).toEqual({ tools: [], blocks: [], diagnostics: [] });
    expect(
      codec.parse(codec.encodeTool(drill, parentheses), semicolon).diagnostics,
    ).not.toHaveLength(0);
  });

  it('bounds input size, decoded value size, nesting and controller line length', () => {
    expect(
      codec.parse(' '.repeat(METADATA_LIMITS.document + 1), semicolon).diagnostics[0].code,
    ).toBe('limit');
    const nested = '['.repeat(17) + '0' + ']'.repeat(17);
    expect(
      codec.parse(block(['toolNumber=1', 'description="x"', `cutting=${nested}`]), semicolon)
        .diagnostics,
    ).not.toHaveLength(0);
    expect(
      codec.parse(
        block(['toolNumber=1', `description="${'x'.repeat(METADATA_LIMITS.value)}"`]),
        semicolon,
      ).diagnostics,
    ).not.toHaveLength(0);
    expect(() => codec.encodeTool(drill, { ...semicolon, maxLineLength: 10 })).toThrow();
    expect(
      codec.parse(codec.encodeTool(drill, semicolon), { ...semicolon, maxLineLength: 30 })
        .diagnostics,
    ).not.toHaveLength(0);
  });
});
