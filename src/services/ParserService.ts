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
      } catch {
        keywordPattern = /\b(M30|M0)\b/gi;
      }

      try {
        variablePattern = new RegExp(variablePatternStr, 'g');
      } catch {
        variablePattern = /#(\d+)/g;
      }

      lines.forEach((line, index) => {
        const lineNumber = index + 1;

        // Reset regex lastIndex for each line to avoid state issues
        keywordPattern.lastIndex = 0;
        let match;
        while ((match = keywordPattern.exec(line)) !== null) {
          keywords.push({
            keyword: match[0].toUpperCase(),
            lineNumber,
          });
        }

        // Find tool changes - reset lastIndex
        toolPattern.lastIndex = 0;
        const toolMatch = toolPattern.exec(line);
        if (toolMatch) {
          // Check for named tool (group 2) or numeric tool (group 1)
          // Regex: (?:T([1-9][0-9]*)(?!\d)|T="([^"]+)")
          // If group 1 is present, it's a number. If group 2 is present (or just the match), handle it.
          
          let toolVal: number | string | null = null;
          
          // Try to parse as integer first if it looks like one
          if (toolMatch[1]) {
             const tNum = parseInt(toolMatch[1]);
             if (!isNaN(tNum)) {
                 toolVal = tNum;
             }
          } else if (toolMatch[0]) {
             // Fallback or named tool
             // If the match is T="...", extract the name
             const strMatch = toolMatch[0];
             if (strMatch.includes('="')) {
                 toolVal = strMatch.slice(3, -1);
             } else if (strMatch.startsWith('T')) {
                 // Simple T123 case that might have been caught here
                 const tNum = parseInt(strMatch.substring(1));
                 if (!isNaN(tNum)) toolVal = tNum;
             }
          }

          if (toolVal !== null && !toolRegisters.find((t) => t.toolNumber === toolVal)) {
            toolRegisters.push({ toolNumber: toolVal });
          }
        }

        // Find variables
        variablePattern.lastIndex = 0;
        let varMatch;
        while ((varMatch = variablePattern.exec(line)) !== null) {
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
