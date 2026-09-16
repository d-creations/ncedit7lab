import type { InsertShape } from './SimulationMetadata';
import type { LibraryToolDefinition } from './ToolLibraryTypes';

const DIAMETERS_MM = Array.from({ length: 40 }, (_, index) => (index + 1) * 0.5);
const TURNING_INSERT_SHAPES: InsertShape[] = ['C', 'D', 'V', 'W', 'T', 'S', 'R', 'E', 'H', 'O', 'P', 'L', 'A', 'B', 'K'];

function formatDiameter(diameter: number): string {
  return Number.isInteger(diameter) ? String(diameter) : diameter.toFixed(1);
}

function roundMillimeters(value: number): number {
  return Number(value.toFixed(3));
}

function baseTool(id: string, description: string, tags: string[]): Omit<LibraryToolDefinition, 'cutting' | 'holder'> {
  return { id, revision: 1, description, tags, createdAt: 0, updatedAt: 0 };
}

function createEndMill(diameter: number): LibraryToolDefinition {
  const label = formatDiameter(diameter);
  const cuttingLength = roundMillimeters(Math.max(3, diameter * 3));
  return {
    ...baseTool(`default-endmill-${label}mm`, `End Mill ${label} mm`, ['endMill', 'mill', `${label} mm`]),
    cutting: [{ type: 'endMill', diameter, length: cuttingLength }],
    holder: [{ type: 'cylinder', diameter, length: roundMillimeters(Math.max(12, diameter * 4)), stickOut: cuttingLength }],
  };
}

function createDrill(diameter: number): LibraryToolDefinition {
  const label = formatDiameter(diameter);
  const cuttingLength = roundMillimeters(Math.max(6, diameter * 6));
  return {
    ...baseTool(`default-drill-${label}mm`, `Drill ${label} mm`, ['drill', `${label} mm`]),
    cutting: [{ type: 'drill', diameter, length: cuttingLength, tipAngle: 118 }],
    holder: [{ type: 'cylinder', diameter, length: roundMillimeters(Math.max(12, diameter * 4)), stickOut: cuttingLength }],
  };
}

function createTurningInsert(shape: InsertShape): LibraryToolDefinition {
  const isOblong = ['L', 'A', 'B', 'K'].includes(shape);
  return {
    ...baseTool(`default-turning-insert-${shape}`, `Turning Insert ${shape} 12 mm`, ['turning', 'insert', shape]),
    cutting: [{
      type: 'insert', shape, ic: 12, thickness: 3.97, noseRadius: 0.4, clearanceAngle: 7,
      ...(isOblong ? { width: 8, length: 16 } : {}),
    }],
    holder: [{ type: 'box', width: 20, height: 20, length: 80, stickOut: 30 }],
  };
}

const DEFAULT_TOOL_LIBRARY_TOOLS: LibraryToolDefinition[] = [
  ...TURNING_INSERT_SHAPES.map(createTurningInsert),
  ...DIAMETERS_MM.map(createEndMill),
  ...DIAMETERS_MM.map(createDrill),
];

export function getDefaultToolLibraryTools(): LibraryToolDefinition[] {
  return structuredClone(DEFAULT_TOOL_LIBRARY_TOOLS);
}