import type { InsertShape } from './SimulationMetadata';
import { getInsertTipAngle } from './InsertOutline';
import type { LibraryToolDefinition } from './ToolLibraryTypes';

const DIAMETERS_MM = Array.from({ length: 40 }, (_, index) => (index + 1) * 0.5);
const TURNING_INSERT_SHAPES: InsertShape[] = ['C', 'D', 'V', 'W', 'T', 'S', 'R', 'E', 'H', 'O', 'P', 'L', 'A', 'B', 'K'];
const FRONT_ORIENTATION: [number, number, number] = [0, 90, 0];
const COUNTER_FACE_ORIENTATION: [number, number, number] = [270, 0, 0];

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
  outline: [number, number][];
  defaultQ: number;
};

// Machine mapping of the tool-local frame; the mount itself is encoded in the local holder/plate geometry.
const TURNING_ORIENTATION: [number, number, number] = [0, 90, 0];
const SHANK_WIDTH = 12;
const SHANK_LENGTH = 40;
const NOSE_WIDTH = 7;
const RIGHT_EDGE_X = -0.5;

// Top view in tool X/Z with the virtual tip at (0,0) and the shank extending toward +Z.
function frontRightOutline(approachAngle: number): [number, number][] {
  const face = 1 + NOSE_WIDTH * Math.tan(((approachAngle - 90) * Math.PI) / 180);
  const stepZ = 9 + (SHANK_WIDTH - NOSE_WIDTH);
  return [
    [RIGHT_EDGE_X, 1],
    [RIGHT_EDGE_X, SHANK_LENGTH],
    [RIGHT_EDGE_X - SHANK_WIDTH, SHANK_LENGTH],
    [RIGHT_EDGE_X - SHANK_WIDTH, stepZ],
    [RIGHT_EDGE_X - NOSE_WIDTH, 9],
    [RIGHT_EDGE_X - NOSE_WIDTH, face],
  ].map(([x, z]) => [roundMillimeters(x), roundMillimeters(z)]);
}

// A back-left tool is the front-right tool turned 180 degrees about Y.
const turnAroundY = (outline: [number, number][]): [number, number][] =>
  outline.map(([x, z]) => [roundMillimeters(-x), roundMillimeters(-z)]);

const TURNING_PRESETS: TurningPreset[] = [
  {
    id: 'front-right', label: 'Front Right', mount: 'front', hand: 'right', approachAngle: 93,
    activeCorner: 'front-right', outline: frontRightOutline(93), defaultQ: 3,
  },
  {
    id: 'back-left', label: 'Back Left', mount: 'back', hand: 'left', approachAngle: 93,
    activeCorner: 'back-left', outline: turnAroundY(frontRightOutline(93)), defaultQ: 2,
  },
  {
    id: 'center', label: 'Center', mount: 'center', hand: 'neutral', approachAngle: 77.5,
    activeCorner: 'center',
    outline: [[-3.5, 1], [3.5, 1], [3.5, 8.5], [6, 11], [6, SHANK_LENGTH], [-6, SHANK_LENGTH], [-6, 11], [-3.5, 8.5]],
    defaultQ: 8,
  },
];

/** Plate turn about Y so its leading edge meets the feed direction at the approach angle. */
function plateTurn(shape: InsertShape, preset: TurningPreset): number {
  const tip = getInsertTipAngle(shape);
  if (preset.mount === 'center' || tip === undefined) return 0;
  const turn = preset.approachAngle + tip / 2 - 180 + (preset.mount === 'back' ? 180 : 0);
  return roundMillimeters(turn > 180 ? turn - 360 : turn <= -180 ? turn + 360 : turn);
}

function createTurningInsert(shape: InsertShape, preset: TurningPreset): LibraryToolDefinition {
  const isOblong = ['L', 'A', 'B', 'K'].includes(shape);
  const baseId = `default-turning-insert-${shape}`;
  const suffix = preset.id === 'front-right' ? '' : `-${preset.id}`;
  const label = preset.id === 'front-right' ? '' : ` ${preset.label}`;
  const turn = plateTurn(shape, preset);
  return {
    ...baseTool(
      `${baseId}${suffix}`,
      `Turning Insert ${shape} 4.8 mm${label}`,
      ['turning', 'insert', shape, preset.id],
    ),
    Q: preset.defaultQ,
    R: 0.2,
    cutting: [{
      type: 'insert', shape, ic: 4.7625, thickness: 1.59, noseRadius: 0.2, clearanceAngle: 7,
      ...(isOblong ? { width: 3, length: 6.25 } : {}),
      zeroVertex: 0,
      ...(turn ? { rotation: [0, turn, 0] as [number, number, number] } : {}),
    }],
    holder: [{
      type: 'turningHolderProfile',
      width: SHANK_WIDTH,
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
    orientation: [...TURNING_ORIENTATION],
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