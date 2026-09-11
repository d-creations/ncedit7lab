import type { ProgramToolDefinition, ToolIdentifier } from './SimulationMetadata';
import { MetadataValidationError } from './SimulationMetadata';
import { SimulationCommentCodec } from './SimulationCommentCodec';
import type { SimulationCommentSyntax } from './SimulationCommentCodec';

export interface ProgramTextEdit {
  startOffset: number;
  endOffset: number;
  text: string;
}

export interface ProgramToolUpdateRequest {
  requestId: string;
  channelId: string;
  documentId: string;
  programId: string;
  expectedRevision: string | number;
  expectedText: string;
  syntax: SimulationCommentSyntax;
  tool: ProgramToolDefinition;
}

export interface ProgramToolUpdateResult {
  requestId: string;
  channelId: string;
  success: boolean;
  message: string;
}

function sameIdentifier(left: ToolIdentifier, right: ToolIdentifier): boolean {
  return typeof left === typeof right && left === right;
}

export class ProgramMetadataEditService {
  constructor(private readonly codec: SimulationCommentCodec) {}

  planToolUpdate(text: string, tool: ProgramToolDefinition, syntax: SimulationCommentSyntax): ProgramTextEdit {
    const parsed = this.codec.parse(text, syntax);
    if (parsed.diagnostics.length) {
      throw new MetadataValidationError(parsed.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
    }
    const matches = parsed.blocks.filter((block) => block.kind === 'TOOL' && block.value &&
      'toolNumber' in block.value && sameIdentifier(block.value.toolNumber, tool.toolNumber));
    if (matches.length > 1) throw new MetadataValidationError('Conflicting managed tool blocks');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const encoded = this.codec.encodeTool(tool, syntax, eol);
    const existing = matches[0];
    if (existing) {
      const trailingEol = /\r\n$/.test(existing.raw) ? '\r\n' : /[\r\n]$/.test(existing.raw) ? '\n' : '';
      return { startOffset: existing.startOffset, endOffset: existing.endOffset, text: encoded + trailingEol };
    }
    const separator = text.length === 0 || /(?:\r\n|\n|\r)$/.test(text) ? '' : eol;
    return { startOffset: text.length, endOffset: text.length, text: `${separator}${encoded}${eol}` };
  }
}