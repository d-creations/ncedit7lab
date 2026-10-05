import * as THREE from 'three';
import { CuttingToolModel, pointInPolygon } from './CuttingToolModel';
import { SimulationCapabilityError } from './SimulationTypes';

export function buildTurningEnvelope(
  cutter: CuttingToolModel,
  matrix: THREE.Matrix4,
  spindleOrigin: THREE.Vector3,
  spindleAxis: THREE.Vector3,
): { bounds: THREE.Box3; inside: (point: THREE.Vector3) => boolean } {
  if (!cutter.insertSection)
    throw new SimulationCapabilityError('Turning requires an insert cutting section');
  const vertices = cutter.insertSection.map((point) => point.clone().applyMatrix4(matrix));
  const radial = new THREE.Vector3();
  for (const vertex of vertices) {
    radial.copy(vertex).sub(spindleOrigin);
    radial.addScaledVector(spindleAxis, -radial.dot(spindleAxis));
    if (radial.length() > 1e-8) break;
  }
  if (radial.length() <= 1e-8)
    throw new SimulationCapabilityError('Turning insert has no resolvable radial section');
  radial.normalize();
  const tangent = spindleAxis.clone().cross(radial).normalize();
  const polygon = vertices.map((vertex) => {
    const relative = vertex.sub(spindleOrigin);
    if (Math.abs(relative.dot(tangent)) > 1e-6) {
      throw new SimulationCapabilityError(
        'Only conventional turning with an insert section in the spindle meridian is supported',
      );
    }
    return new THREE.Vector2(relative.dot(radial), relative.dot(spindleAxis));
  });
  const radius = Math.max(...polygon.map((point) => Math.abs(point.x)));
  const zMin = Math.min(...polygon.map((point) => point.y));
  const zMax = Math.max(...polygon.map((point) => point.y));
  const centre = spindleOrigin.clone().addScaledVector(spindleAxis, (zMin + zMax) / 2);
  const extent = new THREE.Vector3(
    ...spindleAxis
      .toArray()
      .map(
        (component) =>
          (Math.abs(component) * (zMax - zMin)) / 2 +
          Math.sqrt(Math.max(0, 1 - component ** 2)) * radius,
      ),
  );
  const bounds = new THREE.Box3(centre.clone().sub(extent), centre.clone().add(extent));
  const relative = new THREE.Vector3();
  return {
    bounds,
    inside: (point) => {
      relative.copy(point).sub(spindleOrigin);
      const axial = relative.dot(spindleAxis);
      const radiusAtPoint = Math.sqrt(Math.max(0, relative.lengthSq() - axial ** 2));
      return (
        pointInPolygon(radiusAtPoint, axial, polygon) ||
        pointInPolygon(-radiusAtPoint, axial, polygon)
      );
    },
  };
}
