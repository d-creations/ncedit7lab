import { describe, expect, it } from 'vitest';
import type { MachineRegexPatterns } from '@core/types';
import { EventBus } from '@services/EventBus';
import { ParserService } from '@services/ParserService';

const sharedPatterns = {
  variables: { pattern: '#(\\d+)', description: 'Variables' },
  keywords: { pattern: '\\bM30\\b', description: 'Keywords' },
};

describe('ParserService tool detection', () => {
  it('distinguishes FANUC turning tool selection from the trailing offset', async () => {
    const patterns: MachineRegexPatterns = {
      ...sharedPatterns,
      tools: {
        pattern: '(?:T(0*[1-9]\\d{0,3})\\d{2}(?!\\d)|T0*\\d{1,2}(?!\\d))',
        description: 'Packed tool and two-digit offset or offset only',
      },
    };

    const parse = await new ParserService(new EventBus()).parse(
      'T0102\nT0100\nT02', '1', { regexPatterns: patterns });

    expect(parse.artifacts.toolRegisters).toEqual([{ toolNumber: 1 }]);
  });

  it('detects Siemens numeric and named tools', async () => {
    const patterns: MachineRegexPatterns = {
      ...sharedPatterns,
      tools: {
        pattern: '(?:T(\\d{1,4})(?!\\d)|T="[^"]+")',
        description: 'Numeric or named tools',
      },
    };

    const parse = await new ParserService(new EventBus()).parse(
      'T="sff"\nT0012\nT="12"', '1', { regexPatterns: patterns });

    expect(parse.artifacts.toolRegisters).toEqual([
      { toolNumber: 'sff' },
      { toolNumber: 12 },
      { toolNumber: '12' },
    ]);
  });

  it('uses the complete numeric word for non-packed FANUC tools', async () => {
    const patterns: MachineRegexPatterns = {
      ...sharedPatterns,
      tools: { pattern: 'T(\\d{1,4})(?!\\d)', description: 'Tools T0-T9999' },
    };

    const parse = await new ParserService(new EventBus()).parse(
      'T0102', '1', { regexPatterns: patterns });

    expect(parse.artifacts.toolRegisters).toEqual([{ toolNumber: 102 }]);
  });

  it.each(['T\\d+', '(T)(\\d+)'])(
    'ignores numeric matches without a numeric group 1: %s', async (pattern) => {
      const parse = await new ParserService(new EventBus()).parse('T12', '1', {
        regexPatterns: { ...sharedPatterns, tools: { pattern, description: 'Unsupported extraction' } },
      });

      expect(parse.artifacts.toolRegisters).toEqual([]);
    },
  );

  it('keeps the default numeric pattern including zero', async () => {
    const parse = await new ParserService(new EventBus()).parse('T0\nT12', '1');

    expect(parse.artifacts.toolRegisters).toEqual([{ toolNumber: 0 }, { toolNumber: 12 }]);
  });
});