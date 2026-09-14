import * as THREE from 'three';
import type { CuttingPart, DeepReadonly, HolderPart, ProgramToolDefinition } from '@services/tools/SimulationMetadata';

const TOOL_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xb9c2cb, metalness: 0.8, roughness: 0.3 });
const CUTTING_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x5fd2a2, metalness: 0.55, roughness: 0.25 });

function addPart(group: THREE.Group, part: DeepReadonly<HolderPart | CuttingPart>, material: THREE.Material, fromTip: boolean): void {
  let geometry: THREE.BufferGeometry;
  let length: number;
  if (part.type === 'box') {
    geometry = new THREE.BoxGeometry(part.width, part.height, part.length);
    length = part.length;
  } else if (part.type === 'cylinder' || part.type === 'endMill' || part.type === 'ballMill') {
    geometry = new THREE.CylinderGeometry(part.diameter / 2, part.diameter / 2, part.length, 24);
    length = part.length;
  } else if (part.type === 'cone') {
    geometry = new THREE.CylinderGeometry(part.endDiameter / 2, part.startDiameter / 2, part.length, 24);
    length = part.length;
  } else if (part.type === 'drill') {
    geometry = new THREE.CylinderGeometry(part.diameter / 2, part.diameter / 2, part.length, 24);
    length = part.length;
  } else {
    return;
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(part.position?.[0] ?? 0, part.position?.[1] ?? 0,
    part.position?.[2] ?? (fromTip ? length / 2 : (('stickOut' in part ? part.stickOut : 0) ?? 0) + length / 2));
  if (part.rotation) mesh.rotation.set(
    THREE.MathUtils.degToRad(part.rotation[0]) + Math.PI / 2,
    THREE.MathUtils.degToRad(part.rotation[1]),
    THREE.MathUtils.degToRad(part.rotation[2]),
  );
  group.add(mesh);
}

/** Creates a milling tool where local origin is the cutting reference (tip). */
export class ToolGeometryFactory {
  create(tool: DeepReadonly<ProgramToolDefinition>): THREE.Group | undefined {
    const cutting = tool.cutting?.filter((part) =>
      part.type === 'endMill' || part.type === 'ballMill' || part.type === 'drill') ?? [];
    if (!cutting.length) return undefined;

    const group = new THREE.Group();
    group.name = `tool-${String(tool.toolNumber)}`;
    cutting.forEach((part) => addPart(group, part, CUTTING_MATERIAL, true));
    tool.holder?.forEach((part) => addPart(group, part, TOOL_MATERIAL, false));
    return group;
  }
}