import * as THREE from 'three';
import type {
  CuttingPart,
  DeepReadonly,
  HolderPart,
  ProgramMaterialDefinition,
  ProgramToolDefinition,
  TurningActiveCorner,
} from '@services/tools/SimulationMetadata';
import { buildInsertContour } from '@services/tools/InsertOutline';
import { MaterialGeometryFactory } from './MaterialGeometryFactory';

const TOOL_COLOR = 0xf4c542;
const TOOL_MATERIAL = new THREE.MeshStandardMaterial({ color: TOOL_COLOR, metalness: 0.8, roughness: 0.3 });
const CUTTING_MATERIAL = new THREE.MeshStandardMaterial({ color: TOOL_COLOR, metalness: 0.55, roughness: 0.25 });

function normalizeGeometryToLocalTip(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const clone = geometry.clone();
  clone.computeBoundingBox();
  const box = clone.boundingBox;
  if (box && !box.isEmpty()) {
    clone.translate(0, 0, -box.min.z);
  }
  return clone;
}

function buildProfileGeometry(points: ReadonlyArray<readonly [number, number]>): THREE.BufferGeometry {
  const profile = points.map(([z, radius]) => ({ z, radius }));
  if (!profile.length) {
    return new THREE.CylinderGeometry(0.1, 0.1, 1, 16);
  }

  const ordered = [...profile].sort((a, b) => a.z - b.z);
  const geometry = new THREE.LatheGeometry(
    ordered.map((point) => new THREE.Vector2(point.radius, point.z)),
    32,
  );
  return geometry;
}

type InsertPart = DeepReadonly<Extract<CuttingPart, { type: 'insert' }>>;

function insertContour(part: InsertPart, corner?: TurningActiveCorner) {
  return buildInsertContour({
    shape: part.shape, ic: part.ic, noseRadius: part.noseRadius,
    width: part.width, length: part.length, zeroVertex: part.zeroVertex,
  }, corner);
}

function buildInsertGeometry(part: InsertPart, corner?: TurningActiveCorner): THREE.BufferGeometry {
  const thickness = Math.max(0.2, part.thickness);
  const shape = new THREE.Shape(insertContour(part, corner).contour.map(([x, y]) => new THREE.Vector2(x, y)));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  // Outline Y becomes tool Z; the plate thickness is centred on the Y=0 plane.
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, thickness / 2, 0);
  geometry.computeVertexNormals();
  return geometry;
}

export interface InsertPickPoint {
  index: number;
  position: [number, number, number];
  active: boolean;
}

export const TURN_Q_VECTORS: Record<number, readonly [number, number]> = {
  1: [-1, -1],
  2: [1, -1],
  3: [1, 1],
  4: [-1, 1],
  5: [0, -1],
  6: [1, 0],
  7: [0, 1],
  8: [-1, 0],
  9: [0, 0],
  0: [0, 0],
};

export function getInsertQShift(tool: DeepReadonly<ProgramToolDefinition>): THREE.Vector3 {
  if (tool.Q === undefined) return new THREE.Vector3();
  const qVector = TURN_Q_VECTORS[tool.Q];
  if (!qVector) return new THREE.Vector3();

  const part = tool.cutting?.find((candidate): candidate is InsertPart => candidate.type === 'insert');
  if (!part || !part.noseRadius || part.noseRadius <= 0) return new THREE.Vector3();

  const contour = insertContour(part, tool.turning?.activeCorner);
  if (!contour.radiusCenter) return new THREE.Vector3();

  const R = part.noseRadius;
  // Outline (x, y) maps to 3D (x, 0, y) where x is tool X and y is tool Z
  const localM = new THREE.Vector3(contour.radiusCenter[0], 0, contour.radiusCenter[1]);
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(part.rotation?.[0] ?? 0),
    THREE.MathUtils.degToRad(part.rotation?.[1] ?? 0),
    THREE.MathUtils.degToRad(part.rotation?.[2] ?? 0),
    'ZYX',
  );
  const rotatedM = localM.applyEuler(euler);

  const targetX = qVector[0] * R;
  const targetZ = qVector[1] * R;

  return new THREE.Vector3(targetX - rotatedM.x, 0, targetZ - rotatedM.z);
}

/** Sharp outline vertices of the first insert in assembly coordinates (before tool orientation). */
export function getInsertPickPoints(tool: DeepReadonly<ProgramToolDefinition>): InsertPickPoint[] {
  const part = tool.cutting?.find((candidate): candidate is InsertPart => candidate.type === 'insert');
  if (!part) return [];
  const { sharp, zeroIndex } = insertContour(part, tool.turning?.activeCorner);
  const qShift = getInsertQShift(tool);
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(part.rotation?.[0] ?? 0),
    THREE.MathUtils.degToRad(part.rotation?.[1] ?? 0),
    THREE.MathUtils.degToRad(part.rotation?.[2] ?? 0),
    'ZYX',
  );
  const offset = new THREE.Vector3(...(part.position ?? [0, 0, 0])).add(qShift);
  return sharp.map(([x, y], index) => {
    const point = new THREE.Vector3(x, 0, y).applyEuler(euler).add(offset);
    return { index, position: point.toArray() as [number, number, number], active: index === zeroIndex };
  });
}

function buildTurningHolderGeometry(
  part: DeepReadonly<Extract<HolderPart, { type: 'turningHolderProfile' }>>,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(part.outline[0][0], part.outline[0][1]);
  part.outline.slice(1).forEach(([x, z]) => shape.lineTo(x, z));
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: part.depth, bevelEnabled: false });
  // Outline is a top view in X/Z; the holder body extends downward from Y=0.
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

function addPart(
  group: THREE.Group,
  part: DeepReadonly<HolderPart | CuttingPart>,
  material: THREE.Material,
  fromTip: boolean,
  activeCorner?: TurningActiveCorner,
  seatY = 0,
  shift?: THREE.Vector3,
): void {
  let geometry: THREE.BufferGeometry;
  let length: number;
  let needsAxisCorrection = false;
  if (part.type === 'turningHolderProfile') {
    geometry = buildTurningHolderGeometry(part);
    length = Math.max(...part.outline.map(([, z]) => z)) - Math.min(...part.outline.map(([, z]) => z));
  } else if (part.type === 'box') {
    geometry = new THREE.BoxGeometry(part.width, part.height, part.length);
    length = part.length;
  } else if (part.type === 'cylinder' || part.type === 'endMill' || part.type === 'ballMill' || part.type === 'drill') {
    geometry = new THREE.CylinderGeometry(part.diameter / 2, part.diameter / 2, part.length, 24);
    length = part.length;
    needsAxisCorrection = true;
  } else if (part.type === 'cone') {
    geometry = new THREE.CylinderGeometry(part.endDiameter / 2, part.startDiameter / 2, part.length, 24);
    length = part.length;
    needsAxisCorrection = true;
  } else if (part.type === 'profile') {
    geometry = buildProfileGeometry(part.points as ReadonlyArray<readonly [number, number]>);
    length = Math.max(...part.points.map(([z]) => z)) - Math.min(...part.points.map(([z]) => z));
    needsAxisCorrection = true;
  } else if (part.type === 'insert') {
    geometry = buildInsertGeometry(part, activeCorner);
    length = Math.max(0.2, part.thickness);
  } else {
    return;
  }

  // Three.js cylinders and lathed profiles use Y as their length axis; persisted tool
  // transforms always use the canonical assembly Z axis.
  if (needsAxisCorrection) geometry.rotateX(Math.PI / 2);
  // Inserts define their own zero vertex; re-normalizing would move the virtual tip.
  if (fromTip && part.type !== 'insert') geometry = normalizeGeometryToLocalTip(geometry);

  const turningHolder = part.type === 'turningHolderProfile';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(
    (part.position?.[0] ?? 0) + (shift?.x ?? 0),
    part.position?.[1] ?? (turningHolder ? seatY : 0),
    (part.position?.[2] ?? (turningHolder || fromTip ? 0 : (('stickOut' in part ? part.stickOut : 0) ?? 0) + length / 2)) + (shift?.z ?? 0),
  );
  if (part.rotation) {
    mesh.rotation.order = 'ZYX';
    mesh.rotation.set(
      THREE.MathUtils.degToRad(part.rotation[0]),
      THREE.MathUtils.degToRad(part.rotation[1]),
      THREE.MathUtils.degToRad(part.rotation[2]),
    );
  }
  group.add(mesh);
}

/** Creates a tool assembly with its cutting reference at the local origin. */
export class ToolGeometryFactory {
  create(tool: DeepReadonly<ProgramToolDefinition>): THREE.Group | undefined {
    const cutting = tool.cutting ?? [];
    if (!cutting.length) return undefined;

    const group = new THREE.Group();
    group.name = `tool-${String(tool.toolNumber)}`;
    const insert = cutting.find((part) => part.type === 'insert');
    // The holder body sits directly below the plate.
    const seatY = insert?.type === 'insert' ? -insert.thickness / 2 : 0;
    const qShift = getInsertQShift(tool);
    cutting.forEach((part) => addPart(group, part, CUTTING_MATERIAL, true, tool.turning?.activeCorner, 0, qShift));
    tool.holder?.forEach((part) => addPart(group, part, TOOL_MATERIAL, false, tool.turning?.activeCorner, seatY, qShift));
    if (tool.orientation) {
      group.rotation.order = 'ZYX';
      group.rotation.set(
        THREE.MathUtils.degToRad(tool.orientation[0]),
        THREE.MathUtils.degToRad(tool.orientation[1]),
        THREE.MathUtils.degToRad(tool.orientation[2]),
      );
    }
    return group;
  }

  createMaterialMesh(material: DeepReadonly<ProgramMaterialDefinition>): THREE.Group | undefined {
    return new MaterialGeometryFactory().create(material);
  }
}