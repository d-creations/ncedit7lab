/** Schema v1: distances in mm; extrinsic X/Y/Z rotations in degrees. No renderer types. */
export type Vector3 = [number, number, number];
export type ToolIdentifier = number | string;
export interface PartTransform {
  position?: Vector3;
  rotation?: Vector3;
}
export type TurningHand = 'right' | 'left' | 'neutral';
export type TurningMount = 'front' | 'back' | 'center';
export type TurningActiveCorner = 'front-right' | 'front-left' | 'back-right' | 'back-left' | 'center';
export interface TurningDefinition {
  hand: TurningHand;
  mount: TurningMount;
  approachAngle: number;
  activeCorner: TurningActiveCorner;
  reference: 'virtualTip';
}
export type HolderPart = PartTransform & { stickOut?: number } & (
    | { type: 'box'; width: number; height: number; length: number }
    | { type: 'cylinder'; diameter: number; length: number }
    | { type: 'cone'; startDiameter: number; endDiameter: number; length: number }
    | { type: 'profile'; points: [number, number][] }
    | { type: 'turningHolderProfile'; width: number; depth: number; outline: [number, number][] }
  );
export type InsertShape =
  'C' | 'D' | 'V' | 'W' | 'T' | 'S' | 'R' | 'E' | 'H' | 'O' | 'P' | 'L' | 'A' | 'B' | 'K';
export type CuttingPart = PartTransform &
  (
    | { type: 'drill'; diameter: number; length: number; tipAngle: number }
    | { type: 'endMill'; diameter: number; length: number; cornerRadius?: number }
    | { type: 'ballMill'; diameter: number; length: number }
    | {
        type: 'insert';
        shape: InsertShape;
        ic: number;
        thickness: number;
        noseRadius: number;
        clearanceAngle: number;
        width?: number;
        length?: number;
      }
  );
export interface ProgramToolDefinition {
  toolNumber: ToolIdentifier;
  description: string;
  Q?: number;
  R?: number;
  holder?: HolderPart[];
  cutting?: CuttingPart[];
  orientation?: Vector3;
  turning?: TurningDefinition;
}
export interface ProgramToolOffsetDefinition {
  offsetNumber: number;
  toolNumber?: ToolIdentifier;
  qValue?: number;
  rValue?: number;
  lengthValue?: number;
  edgeNumber?: number;
}
export interface ProgramOffsetsDefinition {
  offsetScope: 'global' | 'tool';
  offsets: ProgramToolOffsetDefinition[];
}
/** Material position is its centre in the initial program work-coordinate system. */
export type ProgramMaterialDefinition = PartTransform &
  (
    | { type: 'box'; width: number; depth: number; height: number }
    | { type: 'cylinder'; diameter: number; length: number }
  );
export interface ProgramSetupDefinition {
  machineName: string;
  material?: ProgramMaterialDefinition;
}
export type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

export const METADATA_LIMITS = Object.freeze({
  document: 4 * 1024 * 1024,
  block: 128 * 1024,
  value: 32 * 1024,
  depth: 16,
  parts: 64,
  blocks: 1024,
  dimension: 1_000_000,
});

export class MetadataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetadataValidationError';
  }
}
function fail(message: string): never {
  throw new MetadataValidationError(message);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('Expected a plain object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`Unsupported field: ${key}`);
}
function finite(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} must be finite`);
}
function size(value: unknown, name: string, zero = false): void {
  finite(value, name);
  if ((zero ? value < 0 : value <= 0) || value > METADATA_LIMITS.dimension) fail(`Invalid ${name}`);
}
function text(value: unknown, name: string, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length > max) fail(`Invalid ${name}`);
}
function vector(value: unknown, name: string): void {
  if (!Array.isArray(value) || value.length !== 3) fail(`${name} requires three coordinates`);
  value.forEach((item) => {
    finite(item, name);
    if (Math.abs(item) > METADATA_LIMITS.dimension) fail(`${name} exceeds bounds`);
  });
}
function transform(value: Record<string, unknown>): void {
  if (value.position !== undefined) vector(value.position, 'position');
  if (value.rotation !== undefined) vector(value.rotation, 'rotation');
}
export function validateToolIdentifier(value: unknown): asserts value is ToolIdentifier {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0)
      fail('Tool number must be a nonnegative safe integer');
  } else if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    value === 'unknown'
  ) {
    fail('Invalid or unavailable tool identifier');
  }
}
/** Q/R are backend overrides, not geometry-derived defaults or universal orientation codes. */
export function validateCompensation(value: { Q?: unknown; R?: unknown }): void {
  if (value.Q !== undefined) finite(value.Q, 'Q');
  if (value.R !== undefined) finite(value.R, 'R');
}
export function validateProgramOffsets(value: unknown): ProgramOffsetsDefinition {
  const definition = record(value);
  keys(definition, ['offsetScope', 'offsets']);
  if (definition.offsetScope !== 'global' && definition.offsetScope !== 'tool') {
    fail('Offset scope must be global or tool');
  }
  if (!Array.isArray(definition.offsets) || definition.offsets.length > METADATA_LIMITS.blocks) {
    fail('Invalid offset table');
  }
  const seen = new Set<string>();
  const offsets = definition.offsets.map((candidate) => {
    const offset = record(candidate);
    keys(offset, ['offsetNumber', 'toolNumber', 'qValue', 'rValue', 'lengthValue', 'edgeNumber']);
    if (!Number.isSafeInteger(offset.offsetNumber) || (offset.offsetNumber as number) < 0) {
      fail('Offset number must be a nonnegative safe integer');
    }
    if (definition.offsetScope === 'tool') {
      validateToolIdentifier(offset.toolNumber);
    } else if (offset.toolNumber !== undefined) {
      fail('Global offsets must not include a tool identifier');
    }
    for (const [name, field] of [
      ['Q', offset.qValue], ['R', offset.rValue], ['length', offset.lengthValue],
    ] as const) {
      if (field !== undefined) finite(field, `${name} offset`);
    }
    if (offset.edgeNumber !== undefined &&
      (!Number.isSafeInteger(offset.edgeNumber) || (offset.edgeNumber as number) < 0)) {
      fail('Edge number must be a nonnegative safe integer');
    }
    if (offset.qValue === undefined && offset.rValue === undefined &&
      offset.lengthValue === undefined && offset.edgeNumber === undefined) {
      fail('An offset record needs Q, R, length or edge data');
    }
    const duplicateKey = JSON.stringify([
      definition.offsetScope === 'tool' ? typeof offset.toolNumber : 'global',
      definition.offsetScope === 'tool' ? offset.toolNumber : null,
      offset.offsetNumber,
    ]);
    if (seen.has(duplicateKey)) fail('Duplicate tool-offset assignment');
    seen.add(duplicateKey);
    return offset as unknown as ProgramToolOffsetDefinition;
  });
  return { offsetScope: definition.offsetScope, offsets };
}
function validateHolder(value: unknown, index: number): void {
  const part = record(value);
  transform(part);
  const common = ['type', 'position', 'rotation', 'stickOut'];
  if (part.stickOut !== undefined) {
    if (index !== 0) fail('stickOut belongs only to the first holder part');
    size(part.stickOut, 'stickOut', true);
  }
  switch (part.type) {
    case 'box':
      keys(part, [...common, 'width', 'height', 'length']);
      for (const key of ['width', 'height', 'length']) size(part[key], key);
      break;
    case 'cylinder':
      keys(part, [...common, 'diameter', 'length']);
      size(part.diameter, 'diameter');
      size(part.length, 'length');
      break;
    case 'cone':
      keys(part, [...common, 'startDiameter', 'endDiameter', 'length']);
      size(part.startDiameter, 'startDiameter', true);
      size(part.endDiameter, 'endDiameter', true);
      size(part.length, 'length');
      if (part.startDiameter === 0 && part.endDiameter === 0) fail('Cone needs a nonzero diameter');
      break;
    case 'profile': {
      keys(part, [...common, 'points']);
      if (!Array.isArray(part.points) || part.points.length < 2 || part.points.length > 512)
        fail('Invalid profile points');
      let lastZ = -Infinity;
      let hasRadius = false;
      part.points.forEach((point) => {
        if (!Array.isArray(point) || point.length !== 2) fail('Profile points require [z,radius]');
        size(point[0], 'profile z', true);
        size(point[1], 'profile radius', true);
        if (point[0] < lastZ) fail('Profile z coordinates must be ordered');
        lastZ = point[0];
        hasRadius ||= point[1] > 0;
      });
      if (!hasRadius || part.points[0][0] === lastZ) fail('Profile needs axial and radial extent');
      break;
    }
    case 'turningHolderProfile': {
      keys(part, [...common, 'width', 'depth', 'outline']);
      size(part.width, 'width');
      size(part.depth, 'depth');
      if (!Array.isArray(part.outline) || part.outline.length < 3 || part.outline.length > 128)
        fail('Invalid turning holder outline');
      part.outline.forEach((point) => {
        if (!Array.isArray(point) || point.length !== 2) fail('Holder outline points require [x,z]');
        finite(point[0], 'holder outline x');
        finite(point[1], 'holder outline z');
      });
      break;
    }
    default:
      fail(`Unsupported holder type: ${String(part.type)}`);
  }
}
const insertShapes: InsertShape[] = [
  'C',
  'D',
  'V',
  'W',
  'T',
  'S',
  'R',
  'E',
  'H',
  'O',
  'P',
  'L',
  'A',
  'B',
  'K',
];
function validateCutting(value: unknown): void {
  const part = record(value);
  transform(part);
  const common = ['type', 'position', 'rotation'];
  switch (part.type) {
    case 'drill':
    case 'endMill':
    case 'ballMill': {
      const extra =
        part.type === 'drill' ? ['tipAngle'] : part.type === 'endMill' ? ['cornerRadius'] : [];
      keys(part, [...common, 'diameter', 'length', ...extra]);
      size(part.diameter, 'diameter');
      size(part.length, 'length');
      if (part.type === 'drill') {
        finite(part.tipAngle, 'tipAngle');
        if (part.tipAngle <= 0 || part.tipAngle >= 180) fail('Invalid drill tip angle');
        const tipLength =
          (part.diameter as number) / (2 * Math.tan((part.tipAngle * Math.PI) / 360));
        if ((part.length as number) < tipLength) fail('Drill length must include its point');
      }
      if (part.type === 'ballMill' && (part.length as number) < (part.diameter as number) / 2)
        fail('Ball mill length must include its hemisphere');
      if (part.cornerRadius !== undefined) {
        size(part.cornerRadius, 'cornerRadius', true);
        if ((part.cornerRadius as number) > (part.diameter as number) / 2)
          fail('Corner radius exceeds cutter radius');
      }
      break;
    }
    case 'insert':
      keys(part, [
        ...common,
        'shape',
        'ic',
        'thickness',
        'noseRadius',
        'clearanceAngle',
        'width',
        'length',
      ]);
      if (!insertShapes.includes(part.shape as InsertShape))
        fail('Unsupported insert shape; explicit supplier geometry required');
      size(part.ic, 'ic');
      size(part.thickness, 'thickness');
      size(part.noseRadius, 'noseRadius', true);
      finite(part.clearanceAngle, 'clearanceAngle');
      if (part.clearanceAngle < 0 || part.clearanceAngle >= 90) fail('Invalid clearance angle');
      if ((part.noseRadius as number) > (part.ic as number) / 2)
        fail('Nose radius exceeds IC radius');
      for (const key of ['width', 'length']) {
        if (['L', 'A', 'B', 'K'].includes(part.shape as string) || part[key] !== undefined)
          size(part[key], key);
      }
      break;
    default:
      fail(`Unsupported cutting type: ${String(part.type)}`);
  }
}

export function validateProgramTool(value: unknown): ProgramToolDefinition {
  const tool = record(value);
  keys(tool, ['toolNumber', 'description', 'Q', 'R', 'holder', 'cutting', 'orientation', 'turning']);
  validateToolIdentifier(tool.toolNumber);
  text(tool.description, 'description', 4096);
  validateCompensation(tool);
  if (tool.orientation !== undefined) vector(tool.orientation, 'orientation');
  if (tool.turning !== undefined) {
    const turning = record(tool.turning);
    keys(turning, ['hand', 'mount', 'approachAngle', 'activeCorner', 'reference']);
    if (!['right', 'left', 'neutral'].includes(turning.hand as string)) fail('Invalid turning hand');
    if (!['front', 'back', 'center'].includes(turning.mount as string)) fail('Invalid turning mount');
    finite(turning.approachAngle, 'approach angle');
    if (turning.approachAngle <= 0 || turning.approachAngle >= 180) fail('Invalid approach angle');
    if (!['front-right', 'front-left', 'back-right', 'back-left', 'center'].includes(turning.activeCorner as string))
      fail('Invalid turning active corner');
    if (turning.reference !== 'virtualTip') fail('Turning reference must be virtualTip');
  }
  for (const key of ['holder', 'cutting'] as const) {
    const parts = tool[key];
    if (parts === undefined) continue; // Q/R-only definitions remain useful without invented geometry.
    if (!Array.isArray(parts) || parts.length > METADATA_LIMITS.parts) fail(`Invalid ${key} parts`);
    if (key === 'holder') parts.forEach(validateHolder);
    else parts.forEach(validateCutting);
  }
  return tool as unknown as ProgramToolDefinition;
}
export function validateProgramSetup(value: unknown): ProgramSetupDefinition {
  const setup = record(value);
  keys(setup, ['machineName', 'material']);
  text(setup.machineName, 'machineName', 256);
  if (!setup.machineName.trim()) fail('machineName is required');
  if (setup.material !== undefined) {
    const material = record(setup.material);
    transform(material);
    const dimensions =
      material.type === 'box'
        ? ['width', 'depth', 'height']
        : material.type === 'cylinder'
          ? ['diameter', 'length']
          : fail('Unsupported material type');
    keys(material, ['type', 'position', 'rotation', ...dimensions]);
    dimensions.forEach((key) => size(material[key], key));
  }
  return setup as unknown as ProgramSetupDefinition;
}

/** Freeze owned JSON values, including nested geometry arrays (readonly types alone are insufficient). */
export function freezeMetadata<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeMetadata);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
