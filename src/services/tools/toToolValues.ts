import type { ToolValue } from '@core/types';
import {
  MetadataValidationError,
  validateCompensation,
  validateToolIdentifier,
} from './SimulationMetadata';
import type { ToolIdentifier } from './SimulationMetadata';

export interface ToolCompensationDefinition {
  readonly toolNumber: ToolIdentifier;
  readonly Q?: number;
  readonly R?: number;
}

/** Pure projection. No catalog, geometry, EventBus or controller-specific default inference. */
export function toToolValues(tools: readonly ToolCompensationDefinition[]): ToolValue[] {
  const seen = new Set<ToolIdentifier>();
  const result: ToolValue[] = [];
  for (const tool of tools) {
    validateToolIdentifier(tool.toolNumber);
    validateCompensation(tool);
    if (seen.has(tool.toolNumber)) throw new MetadataValidationError('Duplicate tool assignment');
    seen.add(tool.toolNumber);
    if (tool.Q === undefined && tool.R === undefined) continue;
    result.push({
      toolNumber: tool.toolNumber,
      ...(tool.Q === undefined ? {} : { qValue: tool.Q }),
      ...(tool.R === undefined ? {} : { rValue: tool.R }),
    });
  }
  return result;
}
