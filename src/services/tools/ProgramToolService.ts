import type { ChannelId, ToolOffsetValue, ToolSelectionPolicy, ToolValue } from '@core/types';
import { SimulationCommentCodec } from './SimulationCommentCodec';
import type {
  SimulationCommentSyntax,
  SimulationMetadataParseResult,
} from './SimulationCommentCodec';
import { freezeMetadata, MetadataValidationError, METADATA_LIMITS, validateToolIdentifier } from './SimulationMetadata';
import type { DeepReadonly, ToolIdentifier } from './SimulationMetadata';
import { toToolValues } from './toToolValues';
import type { EventBus, EventSubscription } from '../EventBus';

export interface ProgramIdentity {
  documentId: string;
  programId: string;
  channelId: ChannelId;
}
export interface ProgramSource {
  identity: ProgramIdentity;
  /** Editor-instance revision, not a host document edit/acknowledgment token. */
  revision: string | number;
  text: string;
}

export function programIdentityKey(identity: ProgramIdentity): string {
  return JSON.stringify([identity.documentId, identity.programId, identity.channelId]);
}
export interface ProgramGeometryStatus {
  toolNumber: ToolIdentifier;
  /** single-cutter means schema-supported, not verified reference-point/kinematic accuracy. */
  status: 'missing' | 'single-cutter' | 'unsupported-multi-cutter';
}
export type ProgramToolSnapshot = DeepReadonly<
  SimulationMetadataParseResult & {
    identity: ProgramIdentity;
    revision: string | number;
    text: string;
    valid: boolean;
    geometry: ProgramGeometryStatus[];
  }
>;

/** Read-only capture of the exact supplied revision. No parse cache, catalog, document writer or network. */
export class ProgramToolService {
  private temporaryValues = new Map<string, ToolValue[]>();
  private temporaryOffsets = new Map<string, ToolOffsetValue[]>();
  private closeSubscription?: EventSubscription;

  constructor(private readonly codec: SimulationCommentCodec, eventBus?: EventBus) {
    this.closeSubscription = eventBus?.subscribe('program:closed', (data: { programId: string }) => {
      for (const key of this.temporaryValues.keys()) {
        if (JSON.parse(key)[1] === data.programId) this.temporaryValues.delete(key);
      }
      for (const key of this.temporaryOffsets.keys()) {
        if (JSON.parse(key)[1] === data.programId) this.temporaryOffsets.delete(key);
      }
    });
  }

  dispose(): void {
    this.closeSubscription?.unsubscribe();
    this.temporaryValues.clear();
    this.temporaryOffsets.clear();
  }

  /** Transitional Q/R inputs are program-scoped, never persisted as geometry or comments. */
  setTemporaryToolValues(identity: ProgramIdentity, values: ToolValue[]): void {
    const projected = toToolValues(values.map((value) => ({
      toolNumber: value.toolNumber,
      description: '',
      Q: value.qValue,
      R: value.rValue,
    })));
    const key = programIdentityKey(identity);
    if (projected.length) this.temporaryValues.set(key, projected);
    else this.temporaryValues.delete(key);
  }

  getTemporaryToolValues(identity: ProgramIdentity): ToolValue[] {
    return (this.temporaryValues.get(programIdentityKey(identity)) ?? []).map((value) => ({ ...value }));
  }

  /** Offset registers are independent from physical tool defaults and remain program-scoped. */
  setTemporaryToolOffsets(
    identity: ProgramIdentity,
    policy: ToolSelectionPolicy,
    offsets: ToolOffsetValue[],
  ): void {
    const validated = this.validateToolOffsets(policy, offsets);
    const key = programIdentityKey(identity);
    if (validated.length) this.temporaryOffsets.set(key, validated);
    else this.temporaryOffsets.delete(key);
  }

  getTemporaryToolOffsets(identity: ProgramIdentity): ToolOffsetValue[] {
    return structuredClone(this.temporaryOffsets.get(programIdentityKey(identity)) ?? []);
  }

  getExecutionToolOffsets(
    identity: ProgramIdentity,
    policy?: ToolSelectionPolicy,
  ): ToolOffsetValue[] | undefined {
    const offsets = this.getTemporaryToolOffsets(identity);
    if (!offsets.length) return undefined;
    if (!policy) throw new MetadataValidationError('Selected machine has no tool-offset policy');
    return this.validateToolOffsets(policy, offsets);
  }

  private validateToolOffsets(
    policy: ToolSelectionPolicy,
    offsets: ToolOffsetValue[],
  ): ToolOffsetValue[] {
    const seen = new Set<string>();
    return offsets.map((offset) => {
      if (!Number.isSafeInteger(offset.offsetNumber) || offset.offsetNumber < 0) {
        throw new MetadataValidationError('Offset number must be a nonnegative integer');
      }
      if (policy.offsetScope === 'tool') {
        if (offset.toolNumber === undefined) {
          throw new MetadataValidationError('This machine requires a tool identifier for each offset');
        }
        validateToolIdentifier(offset.toolNumber);
      } else if (offset.toolNumber !== undefined) {
        throw new MetadataValidationError('Global offsets must not include a tool identifier');
      }
      for (const [name, value] of Object.entries({
        Q: offset.qValue,
        R: offset.rValue,
        length: offset.lengthValue,
      })) {
        if (value !== undefined && !Number.isFinite(value)) {
          throw new MetadataValidationError(`${name} offset must be finite`);
        }
      }
      if (offset.edgeNumber !== undefined &&
        (!Number.isSafeInteger(offset.edgeNumber) || offset.edgeNumber < 0)) {
        throw new MetadataValidationError('Edge number must be a nonnegative integer');
      }
      if (offset.qValue === undefined && offset.rValue === undefined &&
        offset.lengthValue === undefined && offset.edgeNumber === undefined) {
        throw new MetadataValidationError('An offset record needs Q, R, length or edge data');
      }
      const key = JSON.stringify([
        policy.offsetScope === 'tool' ? typeof offset.toolNumber : 'global',
        policy.offsetScope === 'tool' ? offset.toolNumber : null,
        offset.offsetNumber,
      ]);
      if (seen.has(key)) throw new MetadataValidationError('Duplicate tool-offset assignment');
      seen.add(key);
      return { ...offset };
    });
  }

  /** A managed assignment owns its entire Q/R record; no hidden temporary fallback for it. */
  getExecutionToolValues(snapshot: ProgramToolSnapshot): ToolValue[] {
    const metadataValues = this.getToolValues(snapshot);
    const managedIds = new Set(snapshot.tools.map((tool) => tool.toolNumber));
    return [
      ...this.getTemporaryToolValues(snapshot.identity).filter((value) => !managedIds.has(value.toolNumber)),
      ...metadataValues,
    ];
  }

  captureProgramSnapshot(
    identity: ProgramIdentity,
    revision: string | number,
    text: string,
    syntax?: SimulationCommentSyntax,
  ): ProgramToolSnapshot {
    if (
      !identity.documentId?.trim() ||
      !identity.programId?.trim() ||
      !['1', '2', '3'].includes(identity.channelId)
    ) {
      throw new MetadataValidationError(
        'Explicit document, program and channel identity is required',
      );
    }
    if (
      (typeof revision === 'number' && (!Number.isSafeInteger(revision) || revision < 0)) ||
      (typeof revision === 'string' && !revision.trim()) ||
      !['string', 'number'].includes(typeof revision)
    ) {
      throw new MetadataValidationError('A valid document revision is required');
    }
    if (text.length > METADATA_LIMITS.document)
      throw new MetadataValidationError('Program exceeds snapshot limit');
    let parsed: SimulationMetadataParseResult;
    if (syntax) parsed = this.codec.parse(text, syntax);
    else {
      // Ordinary metadata-free programs need no guessed dialect. A marker requires verified capabilities.
      parsed = {
        tools: [],
        blocks: [],
        diagnostics: text.includes('@NCE-SIM:')
          ? [
              {
                code: 'syntax',
                message: 'Cannot read simulation metadata without explicit comment syntax',
              },
            ]
          : [],
      };
    }
    const geometry: ProgramGeometryStatus[] = parsed.tools.map((tool) => ({
      toolNumber: tool.toolNumber,
      status: !tool.cutting?.length
        ? 'missing'
        : tool.cutting.length === 1
          ? 'single-cutter'
          : 'unsupported-multi-cutter',
    }));
    return freezeMetadata({
      ...parsed,
      identity: {
        documentId: identity.documentId,
        programId: identity.programId,
        channelId: identity.channelId,
      },
      revision,
      text,
      valid: parsed.diagnostics.length === 0,
      geometry,
    });
  }

  /** Never project a partial parse after a conflict, unsupported version or malformed block. */
  getToolValues(snapshot: ProgramToolSnapshot): ToolValue[] {
    if (!snapshot.valid)
      throw new MetadataValidationError(
        'Program metadata must be resolved before applying overrides',
      );
    return toToolValues(snapshot.tools);
  }
}
