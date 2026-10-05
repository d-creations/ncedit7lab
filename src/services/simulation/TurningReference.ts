import * as THREE from 'three';
import { buildInsertContour } from '../tools/InsertOutline';
import type { DeepReadonly, ProgramToolDefinition } from '../tools/SimulationMetadata';
import { rotationQuaternion } from './SimulationTransforms';

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

/** Shared geometric preview convention; Q is not inferred from insert shape. */
export function getInsertQShift(tool: DeepReadonly<ProgramToolDefinition>): THREE.Vector3 {
  if (tool.Q === undefined) return new THREE.Vector3();
  const vector = TURN_Q_VECTORS[tool.Q];
  if (!vector) return new THREE.Vector3();
  const part = tool.cutting?.find((candidate) => candidate.type === 'insert');
  if (!part || part.type !== 'insert' || part.noseRadius <= 0) return new THREE.Vector3();
  const contour = buildInsertContour(part, tool.turning?.activeCorner);
  if (!contour.radiusCenter) return new THREE.Vector3();
  const centre = new THREE.Vector3(
    contour.radiusCenter[0],
    0,
    contour.radiusCenter[1],
  ).applyQuaternion(rotationQuaternion(part.rotation ?? [0, 0, 0]));
  return new THREE.Vector3(
    vector[0] * part.noseRadius - centre.x,
    0,
    vector[1] * part.noseRadius - centre.z,
  );
}
