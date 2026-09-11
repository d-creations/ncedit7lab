import { describe, expect, it } from 'vitest';
import { ProgramMetadataEditService } from '../ProgramMetadataEditService';
import { SimulationCommentCodec } from '../SimulationCommentCodec';

const codec = new SimulationCommentCodec();
const service = new ProgramMetadataEditService(codec);
const semicolon = { kind: 'line', prefix: ';' } as const;

function apply(source: string, edit: ReturnType<ProgramMetadataEditService['planToolUpdate']>): string {
  return source.slice(0, edit.startOffset) + edit.text + source.slice(edit.endOffset);
}

describe('ProgramMetadataEditService', () => {
  it('appends one managed block without rewriting NC code and preserves CRLF', () => {
    const source = '%\r\nT1\r\nG1 X1\r\nM30\r\n';
    const edit = service.planToolUpdate(source, { toolNumber: 1, description: 'Drill', Q: 0, R: 0 }, semicolon);
    const result = apply(source, edit);
    expect(result.startsWith(source)).toBe(true);
    expect(result).toContain('; Q=0\r\n; R=0\r\n');
    expect(result.split('\r\n').filter((line) => line === 'G1 X1')).toHaveLength(1);
    expect(codec.parse(result, semicolon).tools).toHaveLength(1);
  });

  it('replaces only the exact typed identifier block', () => {
    const numeric = codec.encodeTool({ toolNumber: 1, description: 'numeric' }, semicolon);
    const named = codec.encodeTool({ toolNumber: '1', description: 'named' }, semicolon);
    const source = `${numeric}\nT1\n${named}\nordinary`;
    const edit = service.planToolUpdate(source, { toolNumber: 1, description: 'updated', R: 0.4 }, semicolon);
    const result = apply(source, edit);
    const parsed = codec.parse(result, semicolon);
    expect(parsed.tools.find((tool) => tool.toolNumber === 1)?.description).toBe('updated');
    expect(parsed.tools.find((tool) => tool.toolNumber === '1')?.description).toBe('named');
    expect(result).toContain('T1\n');
    expect(result).toContain('ordinary');
  });

  it('rejects malformed, unsupported and conflicting managed metadata', () => {
    expect(() => service.planToolUpdate('; @NCE-SIM:99 BEGIN TOOL\n; x=1\n; @NCE-SIM:99 END TOOL',
      { toolNumber: 1, description: '' }, semicolon)).toThrow('Unsupported');
    const block = codec.encodeTool({ toolNumber: 1, description: '' }, semicolon);
    expect(() => service.planToolUpdate(`${block}\n${block}`, { toolNumber: 1, description: 'next' }, semicolon)).toThrow();
  });

  it('requires explicit valid syntax and validates geometry before editing', () => {
    expect(() => service.planToolUpdate('T1', { toolNumber: 1, description: '' },
      undefined as never)).toThrow();
    expect(() => service.planToolUpdate('T1', {
      toolNumber: 1, description: '', cutting: [{ type: 'endMill', diameter: 0, length: 10 }],
    }, semicolon)).toThrow();
  });

  it('appends and replaces one managed offset table without changing NC code', () => {
    const source = 'T1\r\nG1 X1\r\n';
    const first = service.planOffsetsUpdate(source, {
      offsetScope: 'global', offsets: [{ offsetNumber: 2, rValue: 0.4 }],
    }, semicolon);
    const withOffsets = apply(source, first);
    expect(withOffsets.startsWith(source)).toBe(true);
    expect(withOffsets).toContain('; @NCE-SIM:1 BEGIN OFFSETS\r\n');
    const second = service.planOffsetsUpdate(withOffsets, {
      offsetScope: 'global', offsets: [{ offsetNumber: 3, lengthValue: 12 }],
    }, semicolon);
    const updated = apply(withOffsets, second);
    expect(updated.match(/BEGIN OFFSETS/g)).toHaveLength(1);
    expect(codec.parse(updated, semicolon).offsets).toEqual({
      offsetScope: 'global', offsets: [{ offsetNumber: 3, lengthValue: 12 }],
    });
    expect(updated).toContain('T1\r\nG1 X1\r\n');
  });
});