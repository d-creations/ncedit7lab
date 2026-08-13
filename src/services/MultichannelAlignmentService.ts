import type {
  ChannelId,
  LineAlignmentSyntaxDefinition,
  LineAlignmentTemplate,
} from '@core/types';
import { BackendGateway } from './BackendGateway';

export interface AlignmentProgram {
  channelId: ChannelId;
  program: string;
}

export interface AlignmentResult {
  programs: AlignmentProgram[];
  alignmentCount: number;
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
    const firstAnchorIndexes = anchorsByChannel.map(
      (anchors) => anchors.get(commonMarkers[0])!,
    );
    let insertedLineCount = 0;
    commonMarkers.slice(1).forEach((marker) => {
      const currentIndexes = anchorsByChannel.map(
        (anchors, channelIndex) => anchors.get(marker)! + insertedByChannel[channelIndex],
      );
      const relativeIndexes = currentIndexes.map(
        (lineIndex, channelIndex) => lineIndex - firstAnchorIndexes[channelIndex],
      );
      const targetIndex = Math.max(...relativeIndexes);
      currentIndexes.forEach((lineIndex, channelIndex) => {
        const paddingCount = targetIndex - relativeIndexes[channelIndex];
        if (paddingCount === 0) return;
        linesByChannel[channelIndex].splice(lineIndex, 0, ...Array(paddingCount).fill('  '));
        insertedByChannel[channelIndex] += paddingCount;
        insertedLineCount += paddingCount;
      });
    });

    return {
      programs: cleanPrograms.map((item, channelIndex) => ({
        ...item,
        program: linesByChannel[channelIndex].join('\n'),
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
      const match = matcher.exec(line);
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
        const syncMatch = matcher.exec(lines[index]);
        if (!syncMatch || !commonSyncMarkers.has(syncMatch[1])) continue;
        while (index > 0 && lines[index - 1] === '  ') {
          lines.splice(index - 1, 1);
          index -= 1;
        }
      }
      return { ...item, program: lines.join('\n') };
    });
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