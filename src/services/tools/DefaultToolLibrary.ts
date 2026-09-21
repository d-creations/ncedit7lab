import type { InsertShape } from './SimulationMetadata';
import type { LibraryToolDefinition } from './ToolLibraryTypes';

const DIAMETERS_MM = Array.from({ length: 40 }, (_, index) => (index + 1) * 0.5);
const TURNING_INSERT_SHAPES: InsertShape[] = ['C', 'D', 'V', 'W', 'T', 'S', 'R', 'E', 'H', 'O', 'P', 'L', 'A', 'B', 'K'];
const FRONT_ORIENTATION: [number, number, number] = [0, 270, 0];
const COUNTER_FACE_ORIENTATION: [number, number, number] = [90, 0, 0];

function formatDiameter(diameter: number): string {
  return Number.isInteger(diameter) ? String(diameter) : diameter.toFixed(1);
}

function roundMillimeters(value: number): number {
  return Number(value.toFixed(3));
}

function baseTool(id: string, description: string, tags: string[]): Omit<LibraryToolDefinition, 'cutting' | 'holder'> {
  return { id, revision: 1, description, tags, createdAt: 0, updatedAt: 0 };
}

function createEndMill(
  diameter: number,
  variant: { idPrefix: string; namePrefix: string; tags: readonly string[]; orientation?: readonly [number, number, number] } = {
    idPrefix: 'default', namePrefix: '', tags: [],
  },
): LibraryToolDefinition {
  const label = formatDiameter(diameter);
  const cuttingLength = roundMillimeters(Math.max(3, diameter * 3));
  return {
    ...baseTool(`${variant.idPrefix}-endmill-${label}mm`, `${variant.namePrefix}End Mill ${label} mm`, ['endMill', 'mill', `${label} mm`, ...variant.tags]),
    cutting: [{ type: 'endMill', diameter, length: cuttingLength }],
    holder: [{ type: 'cylinder', diameter, length: roundMillimeters(Math.max(12, diameter * 4)), stickOut: cuttingLength }],
    ...(variant.orientation ? { orientation: [...variant.orientation] as [number, number, number] } : {}),
  };
}

function createDrill(
  diameter: number,
  variant: { idPrefix: string; namePrefix: string; tags: readonly string[]; orientation?: readonly [number, number, number] } = {
    idPrefix: 'default', namePrefix: '', tags: [],
  },
): LibraryToolDefinition {
  const label = formatDiameter(diameter);
  const cuttingLength = roundMillimeters(Math.max(6, diameter * 6));
  return {
    ...baseTool(`${variant.idPrefix}-drill-${label}mm`, `${variant.namePrefix}Drill ${label} mm`, ['drill', `${label} mm`, ...variant.tags]),
    cutting: [{ type: 'drill', diameter, length: cuttingLength, tipAngle: 118 }],
    holder: [{ type: 'cylinder', diameter, length: roundMillimeters(Math.max(12, diameter * 4)), stickOut: cuttingLength }],
    ...(variant.orientation ? { orientation: [...variant.orientation] as [number, number, number] } : {}),
  };
}

const FRONT_TOOL_VARIANT = { idPrefix: 'default-front', namePrefix: 'Front ', tags: ['front'], orientation: FRONT_ORIENTATION } as const;
const COUNTER_FACE_TOOL_VARIANT = { idPrefix: 'default-counter-face', namePrefix: 'Counter Face ', tags: ['counterFace'], orientation: COUNTER_FACE_ORIENTATION } as const;

function createTurningInsert(shape: InsertShape): LibraryToolDefinition {
  const isOblong = ['L', 'A', 'B', 'K'].includes(shape);
  return {
    ...baseTool(`default-turning-insert-${shape}`, `Turning Insert ${shape} 9.5 mm`, ['turning', 'insert', shape]),
    cutting: [{
      type: 'insert', shape, ic: 9.525, thickness: 3.18, noseRadius: 0.4, clearanceAngle: 7,
      ...(isOblong ? { width: 6, length: 12.5 } : {}),
    }],
    holder: [{ type: 'box', width: 12, height: 12, length: 40, stickOut: 15 }],
  };
}

const DEFAULT_TOOL_LIBRARY_TOOLS: LibraryToolDefinition[] = [
  ...TURNING_INSERT_SHAPES.map(createTurningInsert),
  ...DIAMETERS_MM.map((diameter) => createEndMill(diameter)),
  ...DIAMETERS_MM.map((diameter) => createDrill(diameter)),
  ...DIAMETERS_MM.map((diameter) => createEndMill(diameter, FRONT_TOOL_VARIANT)),
  ...DIAMETERS_MM.map((diameter) => createDrill(diameter, FRONT_TOOL_VARIANT)),
  ...DIAMETERS_MM.map((diameter) => createEndMill(diameter, COUNTER_FACE_TOOL_VARIANT)),
  ...DIAMETERS_MM.map((diameter) => createDrill(diameter, COUNTER_FACE_TOOL_VARIANT)),
];

export function getDefaultToolLibraryTools(): LibraryToolDefinition[] {
  return structuredClone(DEFAULT_TOOL_LIBRARY_TOOLS);
}