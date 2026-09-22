import * as THREE from 'three';
import type {
  CuttingPart,
  DeepReadonly,
  HolderPart,
  ProgramMaterialDefinition,
  ProgramToolDefinition,
} from '@services/tools/SimulationMetadata';

const TOOL_COLOR = 0xf4c542;
const TOOL_MATERIAL = new THREE.MeshStandardMaterial({ color: TOOL_COLOR, metalness: 0.8, roughness: 0.3 });
const CUTTING_MATERIAL = new THREE.MeshStandardMaterial({ color: TOOL_COLOR, metalness: 0.55, roughness: 0.25 });
const MATERIAL_MESH_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xd9c7a6, metalness: 0.25, roughness: 0.8 });

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

export function getInsertOutline(shape: DeepReadonly<Extract<CuttingPart, { type: 'insert' }>>['shape'], radius: number): Array<[number, number]> {
  const pointsByType: Record<string, Array<[number, number]>> = {
    C: [[0, -radius], [0.68 * radius, -0.28 * radius], [radius, 0], [0.68 * radius, 0.28 * radius], [0, radius], [-0.68 * radius, 0.28 * radius], [-radius, 0], [-0.68 * radius, -0.28 * radius]],
    D: [[0, -radius], [radius, -0.22 * radius], [radius, 0.22 * radius], [0, radius], [-radius, 0.22 * radius], [-radius, -0.22 * radius]],
    V: [[0, -radius], [radius, -0.62 * radius], [radius * 0.68, 0], [0, radius], [-radius * 0.68, 0], [-radius, -0.62 * radius]],
    W: [[0, -radius], [0.8 * radius, -0.75 * radius], [radius, -0.12 * radius], [0.62 * radius, 0.42 * radius], [-0.62 * radius, 0.42 * radius], [-radius, -0.12 * radius], [-0.8 * radius, -0.75 * radius]],
    T: [[0, -radius], [radius, -0.7 * radius], [0.56 * radius, radius], [-0.56 * radius, radius], [-radius, -0.7 * radius]],
    S: [[0, -radius], [radius, -0.92 * radius], [radius, 0.92 * radius], [-radius, 0.92 * radius], [-radius, -0.92 * radius]],
    E: [[0, -radius], [0.9 * radius, -0.28 * radius], [radius, -0.12 * radius], [0.68 * radius, radius], [-0.68 * radius, radius], [-radius, -0.12 * radius], [-0.9 * radius, -0.28 * radius]],
    H: [[0, -radius], [0.82 * radius, -0.66 * radius], [radius, -0.18 * radius], [0.7 * radius, radius], [-0.7 * radius, radius], [-radius, -0.18 * radius], [-0.82 * radius, -0.66 * radius]],
    O: [[0, -radius], [0.92 * radius, -0.72 * radius], [radius, -0.26 * radius], [radius, 0.26 * radius], [0.92 * radius, 0.72 * radius], [0, radius], [-0.92 * radius, 0.72 * radius], [-radius, 0.26 * radius], [-radius, -0.26 * radius], [-0.92 * radius, -0.72 * radius]],
    P: [[0, -radius], [0.8 * radius, -0.72 * radius], [radius, -0.24 * radius], [0.72 * radius, radius], [-0.72 * radius, radius], [-radius, -0.24 * radius], [-0.8 * radius, -0.72 * radius]],
    L: [[0, -radius], [radius, -radius], [radius, radius], [-radius, radius], [-radius, -0.22 * radius]],
    A: [[0, -radius], [0.84 * radius, -0.74 * radius], [radius * 0.2, radius], [-radius * 0.2, radius], [-0.84 * radius, -0.74 * radius]],
    B: [[0, -radius], [0.8 * radius, -0.74 * radius], [radius * 0.24, radius], [-radius * 0.24, radius], [-0.8 * radius, -0.74 * radius]],
    K: [[0, -radius], [0.82 * radius, -0.74 * radius], [radius, 0.2 * radius], [-radius, 0.2 * radius], [-0.82 * radius, -0.74 * radius]],
  };
  return pointsByType[shape] ?? pointsByType.D;
}

function activeCornerOffset(
  polygon: Array<[number, number]>,
  corner: 'front-right' | 'front-left' | 'back-right' | 'back-left' | 'center' | undefined,
): [number, number] {
  if (!corner || corner === 'center') return [0, 0];
  const x = corner.endsWith('right') ? Math.max(...polygon.map(([value]) => value)) : Math.min(...polygon.map(([value]) => value));
  const y = corner.startsWith('front') ? Math.min(...polygon.map(([, value]) => value)) : Math.max(...polygon.map(([, value]) => value));
  return [x, y];
}

function buildInsertGeometry(
  part: DeepReadonly<Extract<CuttingPart, { type: 'insert' }>>,
  activeCorner?: 'front-right' | 'front-left' | 'back-right' | 'back-left' | 'center',
): THREE.BufferGeometry {
  const thickness = Math.max(0.2, part.thickness);
  const radius = Math.max(0.1, part.ic / 2);

  if (part.shape === 'R') {
    const geometry = new THREE.CylinderGeometry(radius, radius, thickness, 32);
    geometry.rotateX(Math.PI / 2);
    return normalizeGeometryToLocalTip(geometry);
  }

  const polygon = getInsertOutline(part.shape, radius);
  if (part.width !== undefined && part.length !== undefined && ['A', 'B', 'K', 'L'].includes(part.shape)) {
    const widthScale = part.width / (2 * radius);
    const lengthScale = part.length / (2 * radius);
    polygon.forEach((point) => { point[0] *= widthScale; point[1] *= lengthScale; });
  }
  const [offsetX, offsetY] = activeCornerOffset(polygon, activeCorner);
  polygon.forEach((point) => { point[0] -= offsetX; point[1] -= offsetY; });
  const shape = new THREE.Shape();
  shape.moveTo(polygon[0][0], polygon[0][1]);
  for (let i = 1; i < polygon.length; i++) {
    shape.lineTo(polygon[i][0], polygon[i][1]);
  }
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: part.noseRadius > 0,
    bevelSegments: 3,
    bevelSize: Math.min(part.noseRadius, thickness / 3),
    bevelThickness: Math.min(part.noseRadius, thickness / 3),
  });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, -0.5 * thickness);
  geometry.computeVertexNormals();
  return normalizeGeometryToLocalTip(geometry);
}

function buildTurningHolderGeometry(
  part: DeepReadonly<Extract<HolderPart, { type: 'turningHolderProfile' }>>,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(part.outline[0][0], part.outline[0][1]);
  part.outline.slice(1).forEach(([x, z]) => shape.lineTo(x, z));
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: part.depth, bevelEnabled: false });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, part.depth / 2, 0);
  return geometry;
}

function addPart(
  group: THREE.Group,
  part: DeepReadonly<HolderPart | CuttingPart>,
  material: THREE.Material,
  fromTip: boolean,
  activeCorner?: 'front-right' | 'front-left' | 'back-right' | 'back-left' | 'center',
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
  if (fromTip) geometry = normalizeGeometryToLocalTip(geometry);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(
    part.position?.[0] ?? 0,
    part.position?.[1] ?? 0,
    part.position?.[2] ?? (fromTip ? 0 : (('stickOut' in part ? part.stickOut : 0) ?? 0) + length / 2),
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
    cutting.forEach((part) => addPart(group, part, CUTTING_MATERIAL, true, tool.turning?.activeCorner));
    tool.holder?.forEach((part) => addPart(group, part, TOOL_MATERIAL, false, tool.turning?.activeCorner));
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
    const group = new THREE.Group();
    const position = material.position ?? [0, 0, 0];

    if (material.type === 'box') {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(material.width, material.height, material.depth), MATERIAL_MESH_MATERIAL);
      mesh.position.set(position[0], position[1], position[2]);
      group.add(mesh);
    } else if (material.type === 'cylinder') {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(material.diameter / 2, material.diameter / 2, material.length, 32), MATERIAL_MESH_MATERIAL);
      mesh.position.set(position[0], position[1], position[2]);
      mesh.rotation.x = Math.PI / 2;
      group.add(mesh);
    } else {
      return undefined;
    }

    return group;
  }
}