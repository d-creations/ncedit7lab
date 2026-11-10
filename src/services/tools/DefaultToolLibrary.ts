import type {
  CuttingPart,
  HolderPart,
  InsertShape,
  ProgramMaterialDefinition,
  ProgramToolDefinition,
  ToolIdentifier,
  TurningDefinition,
  Vector3,
} from './SimulationMetadata';
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
  if (toolNumber >= 1000 && toolNumber < 1300) return 'default-front-drill-3mm';
  if (toolNumber >= 1300 && toolNumber <= 1500) return 'default-counter-face-endmill-3mm';
  if (toolNumber >= 2000 && toolNumber < 3000) return 'default-empty-tool';
  if (toolNumber > 1500) return 'default-counter-face-endmill-2mm';
  return undefined;
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

export type ToolTemplateArchetypeId =
  | 'od-turning'
  | 'id-boring'
  | 'cutoff-groove'
  | 'drill'
  | 'mill'
  | 'empty';

export type AxialToolMount = 'cross' | 'front' | 'counter-face';
export type TurningPresetId = 'front-right' | 'back-left' | 'center';
export type BoringWallSide = 'back-wall' | 'front-wall';
export type GrooveOperationKind = 'cutoff' | 'grooving';
export type MillCutterKind = 'endMill' | 'ballMill';

export interface ToolTemplateConfig {
  archetype: ToolTemplateArchetypeId;
  /** Used by od-turning and cutoff-groove */
  turningMount?: TurningPresetId;
  /** Used by od-turning */
  insertShape?: InsertShape;
  /** Used by od-turning, id-boring, cutoff-groove */
  noseRadius?: number;
  /** Used by od-turning */
  insertIc?: number;
  /** Used by id-boring */
  boringSide?: BoringWallSide;
  /** Used by id-boring: minimum bore diameter (mm) */
  minBoreDiameter?: number;
  /** Used by id-boring: maximum boring depth / stick-out (mm) */
  maxBoreDepth?: number;
  /** Used by cutoff-groove */
  grooveKind?: GrooveOperationKind;
  /** Used by cutoff-groove: blade width (mm) */
  bladeWidth?: number;
  /** Used by drill and mill */
  axialMount?: AxialToolMount;
  /** Used by drill and mill */
  diameter?: number;
  /** Used by drill */
  tipAngle?: number;
  /** Used by mill */
  millKind?: MillCutterKind;
  /** Used by mill */
  cornerRadius?: number;
}

export interface ToolTemplateArchetypeMeta {
  id: ToolTemplateArchetypeId;
  label: string;
  shortLabel: string;
  summary: string;
}

export const TOOL_TEMPLATE_ARCHETYPES: readonly ToolTemplateArchetypeMeta[] = [
  {
    id: 'od-turning',
    label: 'OD Turning Insert',
    shortLabel: 'OD Turn',
    summary: 'External turning with ISO insert (V, D, C, W, T, S, R)',
  },
  {
    id: 'id-boring',
    label: 'ID Boring / XS Inner Turn',
    shortLabel: 'ID Boring',
    summary: 'Internal micro-boring & inner diameter turning bar',
  },
  {
    id: 'cutoff-groove',
    label: 'Cut-Off / Grooving',
    shortLabel: 'Cut-Off / Groove',
    summary: 'Parting off or radial grooving blade (1.5–4 mm)',
  },
  {
    id: 'drill',
    label: 'Drill',
    shortLabel: 'Drill',
    summary: 'Twist or spot drill (Cross X, Front +Z, Counter -Z)',
  },
  {
    id: 'mill',
    label: 'End / Ball Mill',
    shortLabel: 'Mill',
    summary: 'Flat end mill or ball nose cutter',
  },
  {
    id: 'empty',
    label: 'Empty / Q-R Only',
    shortLabel: 'Empty / Q-R',
    summary: 'No 3D cutter or sub-spindle pick-up station',
  },
];

export const QUICK_TURNING_SHAPES: readonly { shape: InsertShape; label: string }[] = [
  { shape: 'V', label: 'V (35°)' },
  { shape: 'D', label: 'D (55°)' },
  { shape: 'C', label: 'C (80°)' },
  { shape: 'W', label: 'W (80°)' },
  { shape: 'T', label: 'T (60°)' },
  { shape: 'S', label: 'S (90°)' },
  { shape: 'R', label: 'R (Round)' },
];

export const QUICK_NOSE_RADII_MM: readonly number[] = [0.05, 0.1, 0.2, 0.4, 0.8];
export const QUICK_BLADE_WIDTHS_MM: readonly number[] = [1.5, 2, 2.5, 3, 4];
export const QUICK_DRILL_DIAMETERS_MM: readonly number[] = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12];
export const QUICK_MILL_DIAMETERS_MM: readonly number[] = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16];
export const QUICK_BORE_DIAMETERS_MM: readonly number[] = [2, 3, 4, 5, 6, 8, 10, 12];
export const QUICK_BORE_DEPTHS_MM: readonly number[] = [8, 12, 15, 20, 30];

export function inferToolTemplateConfig(
  tool?: Partial<ProgramToolDefinition | LibraryToolDefinition>,
): ToolTemplateConfig {
  const cutter = tool?.cutting?.[0];
  const holder = tool?.holder?.[0];
  const tags = tool && 'tags' in tool && Array.isArray(tool.tags) ? tool.tags : [];
  const desc = (tool?.description ?? '').toLowerCase();

  if (!cutter) {
    return { archetype: 'empty' };
  }

  if (cutter.type === 'drill') {
    const orientation = tool?.orientation ?? CROSS_ORIENTATION;
    const isFront = Math.abs((orientation[1] ?? 0) - 180) < 1e-3;
    const isCounter = tags.includes('counterFace') || desc.includes('counter');
    return {
      archetype: 'drill',
      axialMount: isFront ? 'front' : isCounter ? 'counter-face' : 'cross',
      diameter: cutter.diameter,
      tipAngle: cutter.tipAngle ?? 118,
    };
  }

  if (cutter.type === 'endMill' || cutter.type === 'ballMill') {
    const orientation = tool?.orientation ?? CROSS_ORIENTATION;
    const isFront = Math.abs((orientation[1] ?? 0) - 180) < 1e-3;
    const isCounter = tags.includes('counterFace') || desc.includes('counter');
    return {
      archetype: 'mill',
      millKind: cutter.type,
      axialMount: isFront ? 'front' : isCounter ? 'counter-face' : 'cross',
      diameter: cutter.diameter,
      cornerRadius: cutter.type === 'endMill' ? cutter.cornerRadius : undefined,
    };
  }

  if (cutter.type === 'insert') {
    if (cutter.shape === 'L') {
      const mount = tool?.turning?.mount === 'back' ? 'back-left' : 'front-right';
      const grooveKind: GrooveOperationKind =
        cutter.zeroVertex === 3 || desc.includes('groov') || desc.includes('cut-in')
          ? 'grooving'
          : 'cutoff';
      return {
        archetype: 'cutoff-groove',
        grooveKind,
        turningMount: mount,
        bladeWidth: cutter.width ?? 3,
        noseRadius: cutter.noseRadius ?? 0.2,
      };
    }

    const isBoring =
      holder?.type === 'cylinder' ||
      tags.includes('boring') ||
      tags.includes('inner') ||
      desc.includes('boring') ||
      desc.includes('inner') ||
      desc.includes('xs');
    if (isBoring) {
      const boringSide: BoringWallSide = tool?.Q === 3 ? 'front-wall' : 'back-wall';
      const minBore = holder?.type === 'cylinder' ? roundMillimeters(holder.diameter / 0.8) : 4;
      const maxDepth = holder?.stickOut ?? (holder?.type === 'cylinder' ? holder.length : 15);
      return {
        archetype: 'id-boring',
        boringSide,
        minBoreDiameter: minBore,
        maxBoreDepth: maxDepth,
        noseRadius: cutter.noseRadius ?? 0.1,
      };
    }

    const mount: TurningPresetId =
      tool?.turning?.mount === 'back'
        ? 'back-left'
        : tool?.turning?.mount === 'center'
          ? 'center'
          : 'front-right';
    return {
      archetype: 'od-turning',
      turningMount: mount,
      insertShape: cutter.shape,
      noseRadius: cutter.noseRadius ?? 0.2,
      insertIc: cutter.ic ?? 4.7625,
    };
  }

  return { archetype: 'od-turning', turningMount: 'front-right', insertShape: 'V', noseRadius: 0.2 };
}

export function buildToolFromTemplateConfig(
  config: ToolTemplateConfig,
  toolNumber: ToolIdentifier = 1,
): ProgramToolDefinition & { tags: string[] } {
  switch (config.archetype) {
    case 'empty': {
      return {
        toolNumber,
        description: 'Empty Tool (No Cutter)',
        tags: ['empty', 'none', 'pickup'],
      };
    }

    case 'drill': {
      const diameter = Math.max(0.1, roundMillimeters(config.diameter ?? 3));
      const tipAngle = roundMillimeters(config.tipAngle ?? 118);
      const axialMount = config.axialMount ?? 'front';
      const cuttingLength = roundMillimeters(Math.max(6, diameter * 6));
      const holderLength = roundMillimeters(Math.max(12, diameter * 4));
      const orientation: Vector3 =
        axialMount === 'front' ? [...FRONT_ORIENTATION] : [...CROSS_ORIENTATION];
      const prefix =
        axialMount === 'front'
          ? 'Front '
          : axialMount === 'counter-face'
            ? 'Counter Face '
            : '';
      const label = formatDiameter(diameter);
      return {
        toolNumber,
        description: `${prefix}Drill ${label} mm`,
        tags: [
          'drill',
          `${label} mm`,
          ...(axialMount === 'front' ? ['front'] : axialMount === 'counter-face' ? ['counterFace'] : ['cross']),
        ],
        cutting: [{ type: 'drill', diameter, length: cuttingLength, tipAngle }],
        holder: [{ type: 'cylinder', diameter, length: holderLength, stickOut: cuttingLength }],
        orientation,
      };
    }

    case 'mill': {
      const diameter = Math.max(0.1, roundMillimeters(config.diameter ?? 6));
      const millKind = config.millKind ?? 'endMill';
      const axialMount = config.axialMount ?? 'cross';
      const cuttingLength = roundMillimeters(Math.max(3, diameter * 3));
      const holderLength = roundMillimeters(Math.max(12, diameter * 4));
      const orientation: Vector3 =
        axialMount === 'front' ? [...FRONT_ORIENTATION] : [...CROSS_ORIENTATION];
      const prefix =
        axialMount === 'front'
          ? 'Front '
          : axialMount === 'counter-face'
            ? 'Counter Face '
            : '';
      const typeName = millKind === 'ballMill' ? 'Ball Mill' : 'End Mill';
      const label = formatDiameter(diameter);
      const cuttingPart: CuttingPart =
        millKind === 'ballMill'
          ? { type: 'ballMill', diameter, length: cuttingLength }
          : {
              type: 'endMill',
              diameter,
              length: cuttingLength,
              ...(config.cornerRadius && config.cornerRadius > 0
                ? { cornerRadius: roundMillimeters(config.cornerRadius) }
                : {}),
            };
      return {
        toolNumber,
        description: `${prefix}${typeName} ${label} mm`,
        tags: [
          millKind,
          'mill',
          `${label} mm`,
          ...(axialMount === 'front' ? ['front'] : axialMount === 'counter-face' ? ['counterFace'] : ['cross']),
        ],
        cutting: [cuttingPart],
        holder: [{ type: 'cylinder', diameter, length: holderLength, stickOut: cuttingLength }],
        orientation,
      };
    }

    case 'cutoff-groove': {
      const grooveKind = config.grooveKind ?? 'cutoff';
      const presetId = config.turningMount === 'back-left' ? 'back-left' : 'front-right';
      const preset = TURNING_PRESETS.find((item) => item.id === presetId) ?? TURNING_PRESETS[0];
      const width = Math.max(0.3, roundMillimeters(config.bladeWidth ?? 3));
      const length = roundMillimeters(Math.max(4, width * 2.1));
      const noseRadius = Math.max(0, roundMillimeters(config.noseRadius ?? 0.2));
      const isCutoff = grooveKind === 'cutoff';
      const { cuttingPosition, cuttingRotation, holderPosition } = getDefaultInsertPlacement(
        'L',
        preset.mount,
        preset.approachAngle,
      );
      const mountLabel = preset.id === 'front-right' ? '' : ` ${preset.label}`;
      const baseName = isCutoff
        ? `Cut-Off Tool L ${formatDiameter(width)} mm`
        : `Grooving Tool L ${formatDiameter(width)} mm`;
      return {
        toolNumber,
        description: `${baseName}${mountLabel}`,
        tags: [
          'turning',
          'insert',
          'L',
          `${formatDiameter(width)} mm`,
          isCutoff ? 'cutoff' : 'grooving',
          preset.id,
        ],
        Q: preset.defaultQ,
        R: noseRadius,
        cutting: [
          {
            type: 'insert',
            shape: 'L',
            ic: 4.7625,
            thickness: 1.59,
            noseRadius,
            clearanceAngle: 7,
            width,
            length,
            zeroVertex: isCutoff ? 0 : 3,
            ...(cuttingPosition ? { position: cuttingPosition } : {}),
            ...(cuttingRotation ? { rotation: cuttingRotation } : {}),
          },
        ],
        holder: [
          {
            type: 'turningHolderProfile',
            width: SHANK_WIDTH,
            depth: 12,
            outline: structuredClone(preset.outline),
            stickOut: 15,
            ...(holderPosition ? { position: holderPosition } : {}),
          },
        ],
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

    case 'id-boring': {
      const boringSide = config.boringSide ?? 'back-wall';
      const minBore = Math.max(1, roundMillimeters(config.minBoreDiameter ?? 4));
      const maxDepth = Math.max(4, roundMillimeters(config.maxBoreDepth ?? 15));
      const noseRadius = Math.max(0.02, roundMillimeters(config.noseRadius ?? 0.1));
      const neckDiameter = roundMillimeters(Math.max(0.8, minBore * 0.8));
      const tipIc = roundMillimeters(Math.max(1.2, Math.min(4.7625, minBore * 0.55)));
      const thickness = roundMillimeters(Math.max(0.6, Math.min(1.59, neckDiameter * 0.45)));
      const isBackWall = boringSide === 'back-wall';
      const Q = isBackWall ? 2 : 3;
      const mount = isBackWall ? 'back' : 'front';
      const hand = isBackWall ? 'left' : 'right';
      const activeCorner = isBackWall ? 'back-left' : 'front-right';
      const turn = plateTurn('V', { mount, approachAngle: 93 });
      const sideLabel = isBackWall ? 'Q2 Upper/Back' : 'Q3 Lower/Front';
      const holderPart: HolderPart = {
        type: 'cylinder',
        diameter: neckDiameter,
        length: maxDepth,
        stickOut: maxDepth,
        position: [isBackWall ? 0.35 * neckDiameter : -0.35 * neckDiameter, 0, maxDepth / 2],
      };
      const cuttingPart: CuttingPart = {
        type: 'insert',
        shape: 'V',
        ic: tipIc,
        thickness,
        noseRadius,
        clearanceAngle: 7,
        zeroVertex: 0,
        rotation: [0, turn, 0],
      };
      const turning: TurningDefinition = {
        hand,
        mount,
        approachAngle: 93,
        activeCorner,
        reference: 'virtualTip',
      };
      return {
        toolNumber,
        description: `ID Boring XS Dmin ${formatDiameter(minBore)} mm L${formatDiameter(maxDepth)} (${sideLabel})`,
        tags: ['turning', 'boring', 'inner', 'xs', `Dmin ${formatDiameter(minBore)} mm`],
        Q,
        R: noseRadius,
        cutting: [cuttingPart],
        holder: [holderPart],
        turning,
        orientation: [...TURNING_ORIENTATION],
      };
    }

    case 'od-turning':
    default: {
      const shape = config.insertShape ?? 'V';
      const presetId = config.turningMount ?? 'front-right';
      const preset = TURNING_PRESETS.find((item) => item.id === presetId) ?? TURNING_PRESETS[0];
      const noseRadius = Math.max(0, roundMillimeters(config.noseRadius ?? 0.2));
      const ic = Math.max(1, roundMillimeters(config.insertIc ?? 4.7625));
      const isOblong = ['L', 'A', 'B', 'K'].includes(shape);
      const { cuttingPosition, cuttingRotation, holderPosition } = getDefaultInsertPlacement(
        shape,
        preset.mount,
        preset.approachAngle,
      );
      const mountLabel = preset.id === 'front-right' ? '' : ` ${preset.label}`;
      return {
        toolNumber,
        description: `Turning Insert ${shape} ${formatDiameter(roundMillimeters(ic))} mm${mountLabel}`,
        tags: ['turning', 'insert', shape, preset.id],
        Q: preset.defaultQ,
        R: noseRadius,
        cutting: [
          {
            type: 'insert',
            shape,
            ic,
            thickness: 1.59,
            noseRadius,
            clearanceAngle: 7,
            ...(isOblong ? { width: 3, length: 6.25 } : {}),
            zeroVertex: 0,
            ...(cuttingPosition ? { position: cuttingPosition } : {}),
            ...(cuttingRotation ? { rotation: cuttingRotation } : {}),
          },
        ],
        holder: [
          {
            type: 'turningHolderProfile',
            width: SHANK_WIDTH,
            depth: 12,
            outline: structuredClone(preset.outline),
            stickOut: 15,
            ...(holderPosition ? { position: holderPosition } : {}),
          },
        ],
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
  }
}

export type MaterialTemplateId =
  | 'swiss-bar-main-sub'
  | 'round-bar-standard'
  | 'micro-swiss-bar'
  | 'chuck-billet'
  | 'mill-plate'
  | 'mill-cube';

export interface MaterialTemplateMeta {
  id: MaterialTemplateId;
  label: string;
  badge: string;
  summary: string;
  material: ProgramMaterialDefinition;
}

export const MATERIAL_DEFINITION_TEMPLATES: readonly MaterialTemplateMeta[] = [
  {
    id: 'swiss-bar-main-sub',
    label: 'Swiss Bar (CH1 + CH2 Pick-up)',
    badge: 'Ø20 × 100 · Dual Z',
    summary: 'Round bar with CH1 front zero (+Z) and CH2 opposite face & flipped 180° Z',
    material: {
      type: 'cylinder',
      diameter: 20,
      length: 100,
      zeroVertex: 1,
      channelReferences: {
        '2': { zeroVertex: 0, rotation: [180, 0, 0] },
      },
    },
  },
  {
    id: 'round-bar-standard',
    label: 'Standard Round Bar',
    badge: 'Ø20 × 100 · CH1 Front',
    summary: 'Single-reference round stock with zero at the +Z front end-face centre',
    material: {
      type: 'cylinder',
      diameter: 20,
      length: 100,
      zeroVertex: 1,
    },
  },
  {
    id: 'micro-swiss-bar',
    label: 'Micro Swiss Bar',
    badge: 'Ø8 × 60 · Dual Z',
    summary: 'Small Swiss lathe bar stock with CH1 main and CH2 sub-spindle pick-up zero',
    material: {
      type: 'cylinder',
      diameter: 8,
      length: 60,
      zeroVertex: 1,
      channelReferences: {
        '2': { zeroVertex: 0, rotation: [180, 0, 0] },
      },
    },
  },
  {
    id: 'chuck-billet',
    label: 'Short Chuck Blank',
    badge: 'Ø40 × 45 · Billet',
    summary: 'Short chucked lathe blank with front face centre zero',
    material: {
      type: 'cylinder',
      diameter: 40,
      length: 45,
      zeroVertex: 1,
    },
  },
  {
    id: 'mill-plate',
    label: 'Milling Plate',
    badge: '100 × 80 × 20 · Plate',
    summary: 'Rectangular plate stock with top corner reference for 3-axis milling',
    material: {
      type: 'box',
      width: 100,
      height: 20,
      depth: 80,
      zeroVertex: 6,
    },
  },
  {
    id: 'mill-cube',
    label: 'Fixture Block',
    badge: '60 × 60 × 40 · Block',
    summary: 'Compact prismatic block for 3/5-axis milling setups',
    material: {
      type: 'box',
      width: 60,
      height: 40,
      depth: 60,
      zeroVertex: 6,
    },
  },
];

export const QUICK_STOCK_DIAMETERS_MM: readonly number[] = [4, 6, 8, 10, 12, 16, 20, 25, 32, 40];
export const QUICK_STOCK_LENGTHS_MM: readonly number[] = [30, 45, 60, 80, 100, 150];
export const QUICK_PLATE_SIZES_MM: readonly { label: string; width: number; depth: number; height: number }[] = [
  { label: '50 × 50 × 15', width: 50, depth: 50, height: 15 },
  { label: '80 × 60 × 20', width: 80, depth: 60, height: 20 },
  { label: '100 × 80 × 20', width: 100, depth: 80, height: 20 },
  { label: '150 × 100 × 30', width: 150, depth: 100, height: 30 },
];
