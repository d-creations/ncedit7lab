// ParserService for client-side NC code parsing

import type {
  NcParseResult,
  ParseArtifacts,
  KeywordEntry,
  ToolRegisterEntry,
  TimingMetadata,
  MachineRegexPatterns,
} from '@core/types';
import { EventBus, EVENT_NAMES } from './EventBus';

export interface ParseOptions {
  regexPatterns?: MachineRegexPatterns;
  controlType?: string;
}

/**
 * Blanks out comment text so tool/keyword/variable detection never matches inside it.
 * FANUC-family controls use parenthesized comments; Siemens uses `;` to end of line.
 * Length is preserved (replaced with spaces) so unrelated column-based logic is unaffected.
 */
function stripCommentsForDetection(line: string, controlType?: string): string {
  if (controlType?.toUpperCase() === 'SIEMENS') {
    const index = line.indexOf(';');
    return index === -1 ? line : line.slice(0, index) + ' '.repeat(line.length - index);
  }
  return line.replace(/\([^)]*\)/g, (match) => ' '.repeat(match.length));
}

export class ParserService {
  private eventBus: EventBus;
  private worker?: Worker;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  async init(): Promise<void> {
    // In a real implementation, we'd initialize a Web Worker here
    // For now, we'll do basic parsing on the main thread
  }

  async parse(
    program: string,
    channelId: string,
    options?: ParseOptions,
  ): Promise<{ result: NcParseResult; artifacts: ParseArtifacts }> {
    try {
      // Basic parsing logic - in production this would be in a worker
      const lines = program.split('\n');
      const keywords: KeywordEntry[] = [];
      const toolRegisters: ToolRegisterEntry[] = [];
      const timingMetadata: TimingMetadata[] = [];
      const variableSnapshot = new Map<number, number>();
      const faults: Array<{ lineNumber: number; message: string; severity: 'error' | 'warning' }> =
        [];

      // Use server-provided patterns or defaults
      const patterns = options?.regexPatterns;
      const toolPatternStr = patterns?.tools?.pattern ?? 'T(\\d+)';
      const keywordPatternStr = patterns?.keywords?.pattern ?? '\\b(M30|M0|M1)\\b';
      const variablePatternStr = patterns?.variables?.pattern ?? '#(\\d+)';

      // Create regex patterns safely (catching errors for invalid patterns)
      let toolPattern: RegExp;
      let keywordPattern: RegExp;
      let variablePattern: RegExp;

      try {
        toolPattern = new RegExp(toolPatternStr, 'gi');
      } catch {
        toolPattern = /T(\d+)/gi;
      }

      try {
        keywordPattern = new RegExp(keywordPatternStr, 'gi');
      } catch (e) {
        console.error("Failed to compile keyword pattern", keywordPatternStr, e);
        keywordPattern = /\b(M30|M0)\b/gi;
      }

      try {
        variablePattern = new RegExp(variablePatternStr, 'g');
      } catch {
        variablePattern = /#(\d+)/g;
      }

      lines.forEach((line, index) => {
        const lineNumber = index + 1;
        const codeOnlyLine = stripCommentsForDetection(line, options?.controlType);

        // Reset regex lastIndex for each line to avoid state issues
        keywordPattern.lastIndex = 0;
        let match;
        while ((match = keywordPattern.exec(codeOnlyLine)) !== null) {
          keywords.push({
            keyword: match[0].toUpperCase(),
            lineNumber,
          });
        }

        // Find tool changes - reset lastIndex
        toolPattern.lastIndex = 0;
        const toolMatch = toolPattern.exec(codeOnlyLine);
        if (toolMatch) {
          let toolVal: number | string | null = null;

          const capturedIdentifier = toolMatch[1];
          const quotedIdentifier = /^T\s*=\s*"([^"]+)"$/i.exec(toolMatch[0]);
          if (quotedIdentifier) {
            toolVal = quotedIdentifier[1];
          } else if (capturedIdentifier !== undefined && /^\d+$/.test(capturedIdentifier)) {
            toolVal = Number.parseInt(capturedIdentifier, 10);
          }

          if (toolVal !== null && !toolRegisters.find((t) => t.toolNumber === toolVal)) {
            toolRegisters.push({ toolNumber: toolVal });
          }
        }

        // Find variables
        variablePattern.lastIndex = 0;
        let varMatch;
        while ((varMatch = variablePattern.exec(codeOnlyLine)) !== null) {
          if (varMatch[1]) {
            const varNumber = parseInt(varMatch[1]);
            if (!isNaN(varNumber) && !variableSnapshot.has(varNumber)) {
              variableSnapshot.set(varNumber, 0); // Initialize with default value
            }
          }
        }

        // Basic timing estimate (simplified)
        timingMetadata.push({
          lineNumber,
          executionTime: 0.1, // Placeholder
        });
      });

      const result: NcParseResult = {
        faultDetected: faults.length > 0,
        faults,
      };

      const artifacts: ParseArtifacts = {
        keywords,
        variableSnapshot,
        namedVariableSnapshot: new Map(),
        toolRegisters,
        timingMetadata,
      };

      this.eventBus.publish(EVENT_NAMES.PARSE_COMPLETED, { channelId, result, artifacts });

      return { result, artifacts };
    } catch (error) {
      const errorResult: NcParseResult = {
        faultDetected: true,
        faults: [
          {
            lineNumber: 0,
            message: error instanceof Error ? error.message : 'Parse error',
            severity: 'error',
          },
        ],
      };

      this.eventBus.publish(EVENT_NAMES.PARSE_ERROR, { channelId, error });

      return {
        result: errorResult,
        artifacts: {
          keywords: [],
          variableSnapshot: new Map(),
          namedVariableSnapshot: new Map(),
          toolRegisters: [],
          timingMetadata: [],
        },
      };
    }
  }

  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
    }
  }
}
