import type { InsertShape, ToolIdentifier } from './SimulationMetadata';
import { getInsertTipAngle } from './InsertOutline';
import type { LibraryToolDefinition } from './ToolLibraryTypes';

const DIAMETERS_MM = Array.from({ length: 40 }, (_, index) => (index + 1) * 0.5);
const TURNING_INSERT_SHAPES: InsertShape[] = ['C', 'D', 'V', 'W', 'T', 'S', 'R', 'E', 'H', 'O', 'P', 'L', 'A', 'B', 'K'];
const CROSS_ORIENTATION: [number, number, number] = [0, 90, 0];
const FRONT_ORIENTATION: [number, number, number] = [0, 180, 0];
const COUNTER_FACE_ORIENTATION: [number, number, number] = [0, 90, 0];

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
    idPrefix: 'default', namePrefix: '', tags: [], orientation: CROSS_ORIENTATION,
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
    idPrefix: 'default', namePrefix: '', tags: [], orientation: CROSS_ORIENTATION,
  },
): LibraryToolDefinition {
  const label = formatDiameter(diameter);
  const cuttingLength = roundMillimeters(Math.max(6, diameter * 6));
  return {
    ...baseTool(`${variant.idPrefix}-drill-${label}mm`, `${variant.namePrefix}Drill ${label} mm`, ['drill', `${label} mm`, ...variant.tags]),
    Q: 0,
    R: roundMillimeters(diameter / 2),
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

// Axial boring bar outline in tool X/Z for small inner-turning tools (cutting tip at (0,0), bar extending along -X).
function innerTurningOutline(neckDiameter: number, neckLength: number, shankDiameter: number, shankLength: number): [number, number][] {
  const tipBackZ = 0.25;
  const neckBottomZ = roundMillimeters(tipBackZ - neckDiameter);
  const shankTopZ = roundMillimeters(neckBottomZ / 2 + shankDiameter / 2);
  const shankBottomZ = roundMillimeters(neckBottomZ / 2 - shankDiameter / 2);
  const neckEnd = roundMillimeters(-neckLength);
  const stepEnd = roundMillimeters(-(neckLength + 2));
  const totalEnd = roundMillimeters(-(neckLength + shankLength));
  return [
    [-0.4, tipBackZ],
    [neckEnd, tipBackZ],
    [stepEnd, shankTopZ],
    [totalEnd, shankTopZ],
    [totalEnd, shankBottomZ],
    [stepEnd, shankBottomZ],
    [neckEnd, neckBottomZ],
    [-0.4, neckBottomZ],
  ];
}

// A back-left tool is the front-right tool turned 180 degrees about Y.
const turnAroundY = (outline: [number, number][]): [number, number][] =>
  outline.map(([x, z]) => [roundMillimeters(-x), roundMillimeters(-z)]);

// Flip a boring bar outline across tool Z so the cutting edge points toward -X instead of +X.
const flipInnerZ = (outline: [number, number][]): [number, number][] =>
  outline.map(([x, z]): [number, number] => [roundMillimeters(x), roundMillimeters(-z)]).reverse();

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

const SHAPE_TURN_DEGREES: Partial<Record<InsertShape, number>> = {
  V: 19,
  D: 28,
  C: 47,
  L: -45,
};

const HOLDER_Z_OFFSET: Partial<Record<InsertShape, number>> = {
  V: 3,
  D: 5,
  C: 2,
  L: 10,
  A: 10,
  B: 10,
  K: 10,
};

/** Plate turn about Y so its leading edge meets the feed direction at the approach angle. */
export function plateTurn(shape: InsertShape, preset: Pick<TurningPreset, 'mount' | 'approachAngle'>): number {
  const tip = getInsertTipAngle(shape);
  if (preset.mount === 'center' || tip === undefined) return 0;
  const frontTurn = SHAPE_TURN_DEGREES[shape] ?? roundMillimeters(tip / 2 + (preset.approachAngle - 90));
  const turn = frontTurn + (preset.mount === 'back' ? 180 : 0);
  return roundMillimeters(turn > 180 ? turn - 360 : turn <= -180 ? turn + 360 : turn);
}

export function getDefaultInsertPlacement(
  shape: InsertShape,
  mount: 'front' | 'back' | 'center' = 'front',
  approachAngle = 93,
): {
  cuttingPosition?: [number, number, number];
  cuttingRotation?: [number, number, number];
  holderPosition?: [number, number, number];
} {
  const isOblong = ['L', 'A', 'B', 'K'].includes(shape);
  const turn = plateTurn(shape, { mount, approachAngle });
  const cuttingPosition: [number, number, number] | undefined =
    isOblong || mount === 'center'
      ? undefined
      : mount === 'front'
        ? [-8, 0, 0]
        : [8, 0, 0];
  const holderZ = HOLDER_Z_OFFSET[shape] ?? 3;
  const holderPosition: [number, number, number] | undefined =
    mount === 'center'
      ? undefined
      : [0, 0, mount === 'front' ? holderZ : -holderZ];
  return {
    ...(cuttingPosition ? { cuttingPosition } : {}),
    ...(turn ? { cuttingRotation: [0, turn, 0] } : {}),
    ...(holderPosition ? { holderPosition } : {}),
  };
}

/** Suggests the matching standard library tool ID for a numeric STAR/lathe tool station. */
export function recommendLibraryToolId(toolNumber: ToolIdentifier): string | undefined {
  if (typeof toolNumber !== 'number' || !Number.isFinite(toolNumber)) return undefined;
  if (toolNumber >= 100 && toolNumber < 200) return 'default-cutoff-tool-L-3mm';
  if (toolNumber >= 200 && toolNumber < 1000) return 'default-turning-insert-V';
  if (toolNumber >= 1000 && toolNumber < 1200) return 'default-front-drill-3mm';
  if (toolNumber >= 1200 && toolNumber < 1300) return 'default-inner-turning-V-2mm';
  if (toolNumber >= 1300 && toolNumber <= 1500) return 'default-counter-face-endmill-3mm';
  if (toolNumber >= 2000 && toolNumber < 3000) return 'default-empty-tool';
  if (toolNumber > 1500) return 'default-counter-face-endmill-2mm';
  return undefined;
}

type InnerTurningSize = {
  minBoreMm: number;
  ic: number;
  thickness: number;
  noseRadius: number;
  neckDiameter: number;
  neckLength: number;
  shankDiameter: number;
  shankLength: number;
};

const INNER_TURNING_SHAPES: readonly ('V' | 'D' | 'C')[] = ['V', 'D', 'C'];

const INNER_TURNING_SIZES: readonly InnerTurningSize[] = [
  { minBoreMm: 1.5, ic: 0.4, thickness: 0.5, noseRadius: 0.05, neckDiameter: 1.1, neckLength: 8, shankDiameter: 4, shankLength: 22 },
  { minBoreMm: 2, ic: 0.55, thickness: 0.65, noseRadius: 0.08, neckDiameter: 1.5, neckLength: 10, shankDiameter: 4, shankLength: 22 },
  { minBoreMm: 3, ic: 0.85, thickness: 0.9, noseRadius: 0.1, neckDiameter: 2.3, neckLength: 12, shankDiameter: 4, shankLength: 22 },
  { minBoreMm: 4, ic: 1.15, thickness: 1.1, noseRadius: 0.15, neckDiameter: 3.1, neckLength: 16, shankDiameter: 6, shankLength: 24 },
  { minBoreMm: 6, ic: 1.75, thickness: 1.4, noseRadius: 0.2, neckDiameter: 4.8, neckLength: 20, shankDiameter: 6, shankLength: 24 },
];

type InnerTurningVariant = {
  id: 'upper' | 'lower' | 'counter-upper' | 'counter-lower';
  suffix: string;
  label: string;
  mount: 'back' | 'front';
  hand: 'right' | 'left';
  activeCorner: 'back-left' | 'front-right';
  defaultQ: number;
  counterFace: boolean;
};

const INNER_TURNING_VARIANTS: readonly InnerTurningVariant[] = [
  {
    id: 'upper', suffix: '', label: 'Upper (+X)', mount: 'back', hand: 'right',
    activeCorner: 'back-left', defaultQ: 2, counterFace: false,
  },
  {
    id: 'lower', suffix: '-lower', label: 'Lower (-X)', mount: 'front', hand: 'left',
    activeCorner: 'front-right', defaultQ: 3, counterFace: false,
  },
  {
    id: 'counter-upper', suffix: '-counter-face', label: 'Counter Face (+X)', mount: 'back', hand: 'left',
    activeCorner: 'back-left', defaultQ: 1, counterFace: true,
  },
];

export function innerTurningPlateTurn(
  shape: 'V' | 'D' | 'C',
  mount: 'back' | 'front' = 'back',
  counterFace = false,
  approachAngle = 93,
): number {
  const tip = getInsertTipAngle(shape) ?? 55;
  // With assembly orientation [0,90,0], local -Z maps to machine -X (toward spindle centerline)
  // and local +X maps to machine -Z (into the bore). Rotate so the tip points toward +X (for back/upper)
  // and the body of the insert trails along the boring bar axis (+Z) inside the bore.
  const baseTurn = roundMillimeters(90 + (approachAngle - 90) + tip / 2);
  if (counterFace) {
    return roundMillimeters(-baseTurn);
  }
  return mount === 'back' ? roundMillimeters(baseTurn - 360) : roundMillimeters(180 - baseTurn);
}

function createInnerTurningTool(
  shape: 'V' | 'D' | 'C',
  size: InnerTurningSize,
  variant: InnerTurningVariant,
): LibraryToolDefinition {
  const boreLabel = formatDiameter(size.minBoreMm);
  const approachAngle = 93;
  const turn = innerTurningPlateTurn(shape, variant.mount, variant.counterFace, approachAngle);
  const baseOutline = innerTurningOutline(size.neckDiameter, size.neckLength, size.shankDiameter, size.shankLength);
  const switchedAxisOutline = variant.counterFace
    ? baseOutline.map(([x, z]): [number, number] => [roundMillimeters(-x), roundMillimeters(z)]).reverse()
    : baseOutline;
  const outline = variant.mount === 'front' ? flipInnerZ(switchedAxisOutline) : switchedAxisOutline;
  return {
    ...baseTool(
      `default-inner-turning-${shape}-${boreLabel}mm${variant.suffix}`,
      `Inner Turn ${shape} Ø${boreLabel} mm ${variant.label}`,
      [
        'turning', 'inner', 'boring', 'xs', shape, `${boreLabel} mm`,
        variant.id, ...(variant.counterFace ? ['counterFace'] : ['front']),
      ],
    ),
    Q: variant.defaultQ,
    R: size.noseRadius,
    cutting: [{
      type: 'insert',
      shape,
      ic: size.ic,
      thickness: size.thickness,
      noseRadius: size.noseRadius,
      clearanceAngle: 7,
      zeroVertex: 0,
      rotation: [0, turn, 0],
    }],
    holder: [{
      type: 'turningHolderProfile',
      width: size.shankDiameter,
      depth: size.neckDiameter,
      outline,
      stickOut: size.neckLength,
    }],
    turning: {
      hand: variant.hand,
      mount: variant.mount,
      approachAngle,
      activeCorner: variant.activeCorner,
      reference: 'virtualTip',
    },
    orientation: [...TURNING_ORIENTATION],
  };
}

function createTurningInsert(shape: InsertShape, preset: TurningPreset): LibraryToolDefinition {
  const isOblong = ['L', 'A', 'B', 'K'].includes(shape);
  const baseId = `default-turning-insert-${shape}`;
  const suffix = preset.id === 'front-right' ? '' : `-${preset.id}`;
  const label = preset.id === 'front-right' ? '' : ` ${preset.label}`;
  const { cuttingPosition, cuttingRotation, holderPosition } = getDefaultInsertPlacement(
    shape,
    preset.mount,
    preset.approachAngle,
  );
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
      ...(cuttingPosition ? { position: cuttingPosition } : {}),
      ...(cuttingRotation ? { rotation: cuttingRotation } : {}),
    }],
    holder: [{
      type: 'turningHolderProfile',
      width: SHANK_WIDTH,
      depth: 12,
      outline: preset.outline,
      stickOut: 15,
      ...(holderPosition ? { position: holderPosition } : {}),
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

function createGroovingBladeTool(
  kind: 'cutoff' | 'cutin',
  preset: TurningPreset,
): LibraryToolDefinition {
  const isCutoff = kind === 'cutoff';
  const baseId = isCutoff ? 'default-cutoff-tool-L-3mm' : 'default-cutin-tool-L-3mm';
  const baseName = isCutoff ? 'Cut-Off Tool L 3 mm' : 'Cut-In / Grooving Tool L 3 mm';
  const suffix = preset.id === 'front-right' ? '' : `-${preset.id}`;
  const label = preset.id === 'front-right' ? '' : ` ${preset.label}`;
  const { cuttingPosition, cuttingRotation, holderPosition } = getDefaultInsertPlacement(
    'L',
    preset.mount,
    preset.approachAngle,
  );
  return {
    ...baseTool(
      `${baseId}${suffix}`,
      `${baseName}${label}`,
      ['turning', 'insert', 'L', '3 mm', ...(isCutoff ? ['cutoff', 'parting'] : ['cutin', 'grooving']), preset.id],
    ),
    Q: preset.defaultQ,
    R: 0.2,
    cutting: [{
      type: 'insert',
      shape: 'L',
      ic: 4.7625,
      thickness: 1.59,
      noseRadius: 0.2,
      clearanceAngle: 7,
      width: 3,
      length: 6.25,
      zeroVertex: isCutoff ? 0 : 3,
      ...(cuttingPosition ? { position: cuttingPosition } : {}),
      ...(cuttingRotation ? { rotation: cuttingRotation } : {}),
    }],
    holder: [{
      type: 'turningHolderProfile',
      width: SHANK_WIDTH,
      depth: 12,
      outline: preset.outline,
      stickOut: 15,
      ...(holderPosition ? { position: holderPosition } : {}),
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
  baseTool('default-empty-tool', 'Empty Tool (No Cutter)', ['empty', 'none', 'backside', 'pickup']),
  ...TURNING_PRESETS.flatMap((preset) => TURNING_INSERT_SHAPES.map((shape) => createTurningInsert(shape, preset))),
  ...INNER_TURNING_VARIANTS.flatMap((variant) =>
    INNER_TURNING_SHAPES.flatMap((shape) =>
      INNER_TURNING_SIZES.map((size) => createInnerTurningTool(shape, size, variant)),
    ),
  ),
  ...TURNING_PRESETS.flatMap((preset) => [
    createGroovingBladeTool('cutoff', preset),
    createGroovingBladeTool('cutin', preset),
  ]),
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