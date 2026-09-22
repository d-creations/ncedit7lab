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

type TurningPreset = {
  id: string;
  label: string;
  mount: 'front' | 'back' | 'center';
  hand: 'right' | 'left' | 'neutral';
  approachAngle: number;
  activeCorner: 'front-right' | 'back-left' | 'center';
  orientation: [number, number, number];
  outline: [number, number][];
};

const TURNING_PRESETS: TurningPreset[] = [
  {
    id: 'front-right', label: 'Front Right', mount: 'front', hand: 'right', approachAngle: 93,
    activeCorner: 'front-right', orientation: [90, 90, 0],
    outline: [[0, 0], [40, 0], [40, 12], [19, 12], [12, 8], [0, 5]],
  },
  {
    id: 'back-left', label: 'Back Left', mount: 'back', hand: 'left', approachAngle: 93,
    activeCorner: 'back-left', orientation: [-90, 90, 180],
    outline: [[0, 0], [40, 0], [40, 12], [0, 12], [7, 7], [15, 5]],
  },
  {
    id: 'center', label: 'Center', mount: 'center', hand: 'neutral', approachAngle: 77.5,
    activeCorner: 'center', orientation: [0, 90, 0],
    outline: [[0, 0], [40, 0], [40, 12], [27, 12], [20, 7], [13, 12], [0, 12]],
  },
];

function createTurningInsert(shape: InsertShape, preset: TurningPreset): LibraryToolDefinition {
  const isOblong = ['L', 'A', 'B', 'K'].includes(shape);
  const baseId = `default-turning-insert-${shape}`;
  const suffix = preset.id === 'front-right' ? '' : `-${preset.id}`;
  const label = preset.id === 'front-right' ? '' : ` ${preset.label}`;
  return {
    ...baseTool(
      `${baseId}${suffix}`,
      `Turning Insert ${shape} 9.5 mm${label}`,
      ['turning', 'insert', shape, preset.id],
    ),
    cutting: [{
      type: 'insert', shape, ic: 9.525, thickness: 3.18, noseRadius: 0.4, clearanceAngle: 7,
      ...(isOblong ? { width: 6, length: 12.5 } : {}),
    }],
    holder: [{
      type: 'turningHolderProfile',
      width: 12,
      depth: 12,
      outline: preset.outline,
      stickOut: 15,
    }],
    turning: {
      hand: preset.hand,
      mount: preset.mount,
      approachAngle: preset.approachAngle,
      activeCorner: preset.activeCorner,
      reference: 'virtualTip',
    },
    orientation: preset.orientation,
  };
}

const DEFAULT_TOOL_LIBRARY_TOOLS: LibraryToolDefinition[] = [
  ...TURNING_PRESETS.flatMap((preset) => TURNING_INSERT_SHAPES.map((shape) => createTurningInsert(shape, preset))),
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