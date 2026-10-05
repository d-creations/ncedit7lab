import * as THREE from 'three';
import type { CuttingPart, DeepReadonly } from '@services/tools/SimulationMetadata';
import { cuttingRadiusAt } from '@services/simulation/CuttingToolModel';

export function createMillingCutterGeometry(
  part: DeepReadonly<Exclude<CuttingPart, { type: 'insert' }>>,
): THREE.BufferGeometry {
  const radius = part.diameter / 2;
  const tipLength =
    part.type === 'drill'
      ? radius / Math.tan(THREE.MathUtils.degToRad(part.tipAngle / 2))
      : part.type === 'ballMill'
        ? radius
        : (part.cornerRadius ?? 0);
  const profile = [new THREE.Vector2(0, 0), new THREE.Vector2(cuttingRadiusAt(part, 0), 0)];
  if (tipLength > 0) {
    for (let step = 1; step <= 24; step++) {
      const z = (tipLength * step) / 24;
      profile.push(new THREE.Vector2(cuttingRadiusAt(part, z), z));
    }
  }
  profile.push(new THREE.Vector2(radius, part.length), new THREE.Vector2(0, part.length));
  return new THREE.LatheGeometry(profile, 32);
}
