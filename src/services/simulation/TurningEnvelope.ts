import * as THREE from 'three';
import { CuttingToolModel, pointInPolygon } from './CuttingToolModel';
import { SimulationCapabilityError } from './SimulationTypes';
import type { ImplicitVolume } from './ImplicitGeometry';

function polygonDistance(x: number, y: number, polygon: readonly THREE.Vector2[]): number {
  let squared = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t =
      length === 0 ? 0 : THREE.MathUtils.clamp(((x - a.x) * dx + (y - a.y) * dy) / length, 0, 1);
    squared = Math.min(squared, (x - a.x - t * dx) ** 2 + (y - a.y - t * dy) ** 2);
  }

  return Math.sqrt(squared) * (pointInPolygon(x, y, polygon) ? -1 : 1);
}

function convexHull(points: THREE.Vector2[]): THREE.Vector2[] {
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2): number =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (vertices: THREE.Vector2[]): THREE.Vector2[] => {
    const result: THREE.Vector2[] = [];
    for (const vertex of vertices) {
      while (
        result.length >= 2 &&
        cross(result[result.length - 2], result[result.length - 1], vertex) <= 0
      )
        result.pop();
      result.push(vertex);
    }
    result.pop();
    return result;
  };
  return [...half(sorted), ...half(sorted.slice().reverse())];
}

function convexField(polygon: readonly THREE.Vector2[]) {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    area += a.x * b.y - b.x * a.y;
  }
  const winding = Math.sign(area);
  if (Math.abs(area) < 1e-12)
    throw new SimulationCapabilityError('Degenerate turning envelope section');
  const edges = polygon.map((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    const length = a.distanceTo(b);
    if (length < 1e-12) throw new SimulationCapabilityError('Degenerate turning envelope edge');
    const x = (winding * (b.y - a.y)) / length;
    const y = (winding * (a.x - b.x)) / length;
    return { x, y, offset: -(x * a.x + y * a.y) };
  });
  // Only convex sections admit a sign-correct maximum of supporting planes.
  const convex = polygon.every((point) =>
    edges.every((edge) => edge.x * point.x + edge.y * point.y + edge.offset <= 1e-8),
  );
  const activeEdge = (x: number, y: number): number => {
    let distance = -Infinity,
      index = 0;
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      const value = edge.x * x + edge.y * y + edge.offset;
      if (value > distance) {
        distance = value;
        index = i;
      }
    }
    return index;
  };
  return {
    normal: convex ? (x: number, y: number) => edges[activeEdge(x, y)] : undefined,
    distance: (x: number, y: number): number => {
      if (!convex) return polygonDistance(x, y, polygon);
      let distance = -Infinity;
      for (const edge of edges) {
        const value = edge.x * x + edge.y * y + edge.offset;
        if (value > distance) distance = value;
      }
      return distance;
    },
  };
}

export function buildTurningSweep(
  cutter: CuttingToolModel,
  start: THREE.Matrix4,
  end: THREE.Matrix4,
  spindleOrigin: THREE.Vector3,
  spindleAxis: THREE.Vector3,
): ImplicitVolume {
  const section = cutter.insertSection;
  if (!section) throw new SimulationCapabilityError('Turning requires an insert cutting section');
  let normal: THREE.Vector3 | undefined;
  for (let i = 0; i < section.length; i++) {
    const cross = section[(i + 1) % section.length]
      .clone()
      .sub(section[i])
      .cross(section[(i + 2) % section.length].clone().sub(section[(i + 1) % section.length]));
    if (cross.lengthSq() < 1e-20) continue;
    if (normal && normal.dot(cross) < -1e-12)
      throw new SimulationCapabilityError('Turning sweep requires a convex insert section');
    normal ??= cross.clone().normalize();
  }
  // A convex insert's translational sweep is the hull of both endpoint sections.
  return buildTurningEnvelope(cutter, start, spindleOrigin, spindleAxis, end);
}

export function buildTurningEnvelope(
  cutter: CuttingToolModel,
  matrix: THREE.Matrix4,
  spindleOrigin: THREE.Vector3,
  spindleAxis: THREE.Vector3,
  endMatrix?: THREE.Matrix4,
): ImplicitVolume & { inside: (point: THREE.Vector3) => boolean } {
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
  const projected = [
    ...vertices,
    ...(endMatrix
      ? cutter.insertSection.map((point) => point.clone().applyMatrix4(endMatrix))
      : []),
  ].map((vertex) => {
    const relative = vertex.sub(spindleOrigin);
    if (Math.abs(relative.dot(tangent)) > 1e-6) {
      throw new SimulationCapabilityError(
        'Only conventional turning with an insert section in the spindle meridian is supported',
      );
    }
    return new THREE.Vector2(relative.dot(radial), relative.dot(spindleAxis));
  });
  const polygon = endMatrix ? convexHull(projected) : projected;
  const field = convexField(polygon);
  const minimumRadial = Math.min(...polygon.map((point) => point.x));
  const maximumRadial = Math.max(...polygon.map((point) => point.x));
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
  let axial = 0,
    radialLength = 0,
    reflected = false;
  const evaluate = (point: THREE.Vector3): number => {
    relative.copy(point).sub(spindleOrigin);
    axial = relative.dot(spindleAxis);
    radialLength = Math.sqrt(Math.max(0, relative.lengthSq() - axial ** 2));
    const positive = maximumRadial >= 0 ? field.distance(radialLength, axial) : Infinity;
    const negative = minimumRadial <= 0 ? field.distance(-radialLength, axial) : Infinity;
    reflected = negative < positive;
    return Math.min(positive, negative);
  };
  return {
    bounds,
    identity: JSON.stringify(['turning', spindleOrigin.toArray(), spindleAxis.toArray(), polygon]),
    distance: evaluate,
    normal: field.normal
      ? (point, target) => {
          evaluate(point);
          const edge = field.normal!(reflected ? -radialLength : radialLength, axial);
          if (radialLength > 1e-12)
            target.copy(relative).addScaledVector(spindleAxis, -axial).divideScalar(radialLength);
          else target.copy(radial);
          return target
            .multiplyScalar(edge.x * (reflected ? -1 : 1))
            .addScaledVector(spindleAxis, edge.y)
            .normalize();
        }
      : undefined,
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
