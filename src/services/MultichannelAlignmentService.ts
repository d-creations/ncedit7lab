import type {
  ChannelId,
  LineAlignmentSyntaxDefinition,
  LineAlignmentTemplate,
} from '@core/types';
import { BackendGateway } from './BackendGateway';

export interface ChannelSyncMarker {
  lineNumber: number;
  marker: string;
  code: string;
}

export interface AlignmentProgram {
  channelId: ChannelId;
  program: string;
  syncMarkers?: ChannelSyncMarker[];
  paddedLines?: number[];
}

export interface AlignmentResult {
  programs: AlignmentProgram[];
  alignmentCount: number;
}

export function formatNcLineSpacing(line: string, action: 'add' | 'remove'): string {
  if (line.trim() === '') return line;
  const trimmedStart = line.trimStart();
  if (/^[%&<;(]/.test(trimmedStart)) return line;

  const match = /^(\s*)(.*?)(\s*)$/.exec(line);
  if (!match) return line;
  const [, leadingWs, body, trailingWs] = match;

  const protectedSpans: string[] = [];
  const masked = body.replace(/(\([^)]*\)|;.*$|\[[^\]]*\]|"[^"]*")/g, (span) => {
    const index = protectedSpans.push(span) - 1;
    return `\u0000${index}\u0000`;
  });

  let formatted: string;
  if (action === 'add') {
    formatted = masked
      .replace(/[ \t]+/g, ' ')
      .replace(/([\d.]|\u0000\d+\u0000)\s*(?=[A-Za-z])/g, (_, prev: string) => {
        if (prev.startsWith('\u0000')) {
          const spanIndex = Number(prev.slice(1, -1));
          if (!protectedSpans[spanIndex]?.startsWith('[')) {
            return prev;
          }
        }
        return `${prev} `;
      });
  } else {
    formatted = masked.replace(/[ \t]+/g, '');
  }

  const restored = formatted.replace(
    /\u0000(\d+)\u0000/g,
    (_, index) => protectedSpans[Number(index)],
  );
  return `${leadingWs}${restored}${trailingWs}`;
}

export class MultichannelAlignmentService {
  constructor(private backend: BackendGateway) {}

  async alignPrograms(
    programs: AlignmentProgram[],
    controlType: string,
  ): Promise<AlignmentResult> {
    this.validateChannelCount(programs);
    const definition = await this.getDefinition(controlType);
    const template = this.getTemplate(definition, programs);
    const cleanPrograms = this.removeGeneratedPadding(programs, template.syntax, definition);
    const linesByChannel = cleanPrograms.map(({ program }) => program.split(/\r?\n/));
    const anchorsByChannel = linesByChannel.map((lines) =>
      this.getUniqueSyncAnchors(lines, template.syntax, definition, programs),
    );
    const commonMarkers = [...anchorsByChannel[0].keys()].filter((marker) =>
      anchorsByChannel.every((anchors) => anchors.has(marker)),
    );
    const ordered = anchorsByChannel.every((anchors) =>
      commonMarkers.every(
        (marker, index) =>
          index === 0 || anchors.get(marker)! > anchors.get(commonMarkers[index - 1])!,
      ),
    );
    if (commonMarkers.length === 0 || !ordered) {
      return { programs: cleanPrograms, alignmentCount: 0 };
    }

    const insertedByChannel = linesByChannel.map(() => 0);
    const paddedLinesByChannel = linesByChannel.map(() => [] as number[]);
    const syncMarkersByChannel = linesByChannel.map(() => [] as ChannelSyncMarker[]);
    const matcher = this.createSyncCodeMatcher(template.syntax, programs);
    let insertedLineCount = 0;

    commonMarkers.forEach((marker) => {
      const currentIndexes = anchorsByChannel.map(
        (anchors, channelIndex) => anchors.get(marker)! + insertedByChannel[channelIndex],
      );
      const targetIndex = Math.max(...currentIndexes);
      currentIndexes.forEach((lineIndex, channelIndex) => {
        const paddingCount = targetIndex - lineIndex;
        if (paddingCount > 0) {
          linesByChannel[channelIndex].splice(lineIndex, 0, ...Array(paddingCount).fill('  '));
          for (let offset = 0; offset < paddingCount; offset += 1) {
            paddedLinesByChannel[channelIndex].push(lineIndex + offset + 1);
          }
          insertedByChannel[channelIndex] += paddingCount;
          insertedLineCount += paddingCount;
        }
        const alignedLineText = linesByChannel[channelIndex][targetIndex] ?? '';
        const match = matcher.exec(this.stripComments(alignedLineText, definition.controlType));
        syncMarkersByChannel[channelIndex].push({
          lineNumber: targetIndex + 1,
          marker,
          code: match ? match[0].trim() : marker,
        });
      });
    });

    return {
      programs: cleanPrograms.map((item, channelIndex) => ({
        ...item,
        program: linesByChannel[channelIndex].join('\n'),
        syncMarkers: syncMarkersByChannel[channelIndex],
        paddedLines: paddedLinesByChannel[channelIndex],
      })),
      alignmentCount: insertedLineCount,
    };
  }

  async removeAlignment(
    programs: AlignmentProgram[],
    controlType: string,
  ): Promise<AlignmentResult> {
    this.validateChannelCount(programs);
    const definition = await this.getDefinition(controlType);
    const template = this.getTemplate(definition, programs);
    const cleaned = this.removeGeneratedPadding(programs, template.syntax, definition);
    const removedLines = programs.reduce((count, item, index) => {
      const before = item.program.split(/\r?\n/).length;
      const after = cleaned[index].program.split(/\r?\n/).length;
      return count + before - after;
    }, 0);

    return {
      programs: cleaned,
      alignmentCount: removedLines,
    };
  }

  private validateChannelCount(programs: AlignmentProgram[]): void {
    if (programs.length < 2 || programs.length > 3) {
      throw new Error('Alignment requires two or three active channels');
    }
  }

  private async getDefinition(controlType: string): Promise<LineAlignmentSyntaxDefinition> {
    const response = await this.backend.getLineAlignmentSyntax();
    const definition = response.lineAlignmentSyntax?.find(
      (item) => item.controlType.toUpperCase() === controlType.toUpperCase(),
    );
    if (!definition) {
      throw new Error(`The server returned no alignment syntax for ${controlType}`);
    }
    return definition;
  }

  private getTemplate(
    definition: LineAlignmentSyntaxDefinition,
    programs: AlignmentProgram[],
  ): LineAlignmentTemplate {
    if (programs.length === 2) {
      const template = definition.twoChannel ??
        (definition.syntax ? { syntax: definition.syntax } : undefined);
      if (template) return template;
    } else if (definition.threeChannel) {
      const selector = `P${programs.map(({ channelId }) => channelId).join('')}`;
      if (!definition.threeChannel.selectors?.includes(selector)) {
        throw new Error(`The server does not support alignment selector ${selector}`);
      }
      return definition.threeChannel;
    }

    throw new Error('The server returned no syntax for the active channel count');
  }

  private getUniqueSyncAnchors(
    lines: string[],
    syntax: string,
    definition: LineAlignmentSyntaxDefinition,
    programs: AlignmentProgram[],
  ): Map<string, number> {
    const indexes = new Map<string, number>();
    const duplicates = new Set<string>();
    const matcher = this.createSyncCodeMatcher(syntax, programs);

    lines.forEach((line, index) => {
      const match = matcher.exec(this.stripComments(line, definition.controlType));
      if (!match) return;
      const marker = match[1];
      const markerNumber = Number(marker);
      if (
        definition.waitCodeRange &&
        (markerNumber < definition.waitCodeRange.min || markerNumber > definition.waitCodeRange.max)
      ) return;
      if (indexes.has(marker)) duplicates.add(marker);
      else indexes.set(marker, index);
    });

    duplicates.forEach((marker) => indexes.delete(marker));
    return indexes;
  }

  private removeGeneratedPadding(
    programs: AlignmentProgram[],
    syntax: string,
    definition: LineAlignmentSyntaxDefinition,
  ): AlignmentProgram[] {
    const linesByChannel = programs.map(({ program }) => program.split(/\r?\n/));
    const anchorsByChannel = linesByChannel.map((lines) =>
      this.getUniqueSyncAnchors(lines, syntax, definition, programs),
    );
    const commonSyncMarkers = new Set(
      [...anchorsByChannel[0].keys()].filter((marker) =>
        anchorsByChannel.every((anchors) => anchors.has(marker)),
      ),
    );
    return programs.map((item) => {
      const lines = item.program.split(/\r?\n/);
      const matcher = this.createSyncCodeMatcher(syntax, programs);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const syncMatch = matcher.exec(this.stripComments(lines[index], definition.controlType));
        if (!syncMatch || !commonSyncMarkers.has(syncMatch[1])) continue;
        while (index > 0 && lines[index - 1] === '  ') {
          lines.splice(index - 1, 1);
          index -= 1;
        }
      }
      return { ...item, program: lines.join('\n') };
    });
  }

  private stripComments(line: string, controlType?: string): string {
    if (controlType?.toUpperCase() === 'SIEMENS') {
      const commentIndex = line.indexOf(';');
      return commentIndex === -1 ? line : line.slice(0, commentIndex);
    }
    return line.replace(/\([^)]*\)/g, ' ');
  }

  private createSyncCodeMatcher(syntax: string, programs: AlignmentProgram[]): RegExp {
    const channelNumbers = programs.map(({ channelId }) => channelId).join('');
    const pattern = syntax
      .split(/(<(?:waitCode|marker|channels)>)/gi)
      .map((part) => {
        if (/^<(?:waitCode|marker)>$/i.test(part)) return '\\s*(\\d+)';
        if (/^<channels>$/i.test(part)) return this.escapeRegExp(channelNumbers);
        return this.escapeRegExp(part).replace(/ /g, '\\s*');
      })
      .join('');
    return new RegExp(`${pattern}(?!\\d)`, 'i');
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}