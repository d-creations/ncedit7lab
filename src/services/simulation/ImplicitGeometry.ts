import * as THREE from 'three';

export interface IntervalCoverage {
  key: string;
  axis: THREE.Vector3;
  lower: number;
  upper: number;
  /** False permits whole-interval containment only, not regional dominance. */
  partial?: boolean;
  /** The field is monotone in distance to this projected interval. */
  projected?: boolean;
}

/** Negative inside; fields must be 1-Lipschitz for conservative region classification. */
export interface ImplicitVolume {
  bounds: THREE.Box3;
  /** Axial extrusion interval of the stock's unchanged cross section. */
  extrusion?: readonly { axis: number; minimum: number; maximum: number }[];
  planarExtrusionAxis?(bounds: THREE.Box3): number | undefined;
  /** Exact max(radial field, lower - axial, axial - upper) sweep certificate. */
  axialCoverage?: IntervalCoverage;
  /** Same collinear ball-cutter family; lateral fields also admit regional dominance. */
  sweepCoverage?: IntervalCoverage;
  /** Equality of this key certifies equality of the complete distance field. */
  identity?: string;
  distance(point: THREE.Vector3): number;
  normal?(point: THREE.Vector3, target: THREE.Vector3): THREE.Vector3;
  countCentres?(first: THREE.Vector3, span: number, spacing: number): number;
}

function intervalCount(first: number, span: number, spacing: number, half: number): number {
  const low = Math.max(0, Math.floor((-half - first) / spacing) + 1);
  const high = Math.min(span - 1, Math.ceil((half - first) / spacing) - 1);
  return Math.max(0, high - low + 1);
}

export const CELL_CORNERS = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
] as const;

export const CELL_EDGES = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
] as const;

export function edgeIndex(a: number, b: number): number {
  const index = CELL_EDGES.findIndex(([u, v]) => u === Math.min(a, b) && v === Math.max(a, b));
  if (index < 0) throw new Error('Invalid surface edge');
  return index;
}

export function edgeRoot(
  a: number,
  b: number,
  field: (t: number) => number,
  tolerance = 2 ** -24,
): number {
  if (![a, b, tolerance].every(Number.isFinite) || tolerance < Number.EPSILON || tolerance >= 1)
    throw new Error('Invalid surface intersection bracket or tolerance');
  if (a === 0) return 0;
  if (b === 0) return 1;
  if (a < 0 === b < 0) throw new Error('Surface edge has no bracketed intersection');
  let low = 0,
    high = 1;
  let left = a,
    right = b,
    previousSide = 0;
  for (let iteration = 0; high - low > tolerance; iteration++) {
    // Illinois interpolation resolves planes immediately; bisection bounds the worst case.
    let middle = iteration < 12 ? (low * right - high * left) / (right - left) : (low + high) / 2;
    if (!(middle > low && middle < high)) middle = (low + high) / 2;
    const value = field(middle);
    if (!Number.isFinite(value)) throw new Error('Non-finite surface intersection field');
    if (value === 0) return middle;
    if (value < 0 === a < 0) {
      low = middle;
      left = value;
      if (previousSide === 1) right *= 0.5;
      previousSide = 1;
    } else {
      high = middle;
      right = value;
      if (previousSide === -1) left *= 0.5;
      previousSide = -1;
    }
  }
  return (low + high) / 2;
}

export function surfaceNormal(
  volume: ImplicitVolume,
  point: THREE.Vector3,
  epsilon: number,
  target = new THREE.Vector3(),
  test: () => void = () => {},
): THREE.Vector3 {
  if (volume.normal) {
    test();
    volume.normal(point, target);
  } else {
    const sample = point.clone();
    for (let axis = 0; axis < 3; axis++) {
      sample.copy(point).setComponent(axis, point.getComponent(axis) + epsilon);
      test();
      const high = volume.distance(sample);
      sample.setComponent(axis, point.getComponent(axis) - epsilon);
      test();
      target.setComponent(axis, high - volume.distance(sample));
    }
  }
  if (!Number.isFinite(target.lengthSq()) || target.lengthSq() < 1e-24)
    throw new Error('Cannot resolve stock/cutter surface normal');
  return target.normalize();
}

export function boxVolume(size: readonly number[]): ImplicitVolume {
  const half = new THREE.Vector3(size[0] / 2, size[1] / 2, size[2] / 2);
  return {
    bounds: new THREE.Box3(half.clone().negate(), half.clone()),
    extrusion: [2, 0, 1].map((axis) => ({
      axis,
      minimum: -half.getComponent(axis),
      maximum: half.getComponent(axis),
    })),
    countCentres: (first, span, spacing) =>
      intervalCount(first.x, span, spacing, half.x) *
      intervalCount(first.y, span, spacing, half.y) *
      intervalCount(first.z, span, spacing, half.z),
    normal: (point, target) => {
      target.set(
        Math.sign(point.x) * Math.max(Math.abs(point.x) - half.x, 0),
        Math.sign(point.y) * Math.max(Math.abs(point.y) - half.y, 0),
        Math.sign(point.z) * Math.max(Math.abs(point.z) - half.z, 0),
      );
      if (target.lengthSq() === 0) {
        const distances = [
          Math.abs(point.x) - half.x,
          Math.abs(point.y) - half.y,
          Math.abs(point.z) - half.z,
        ];
        const axis = distances.indexOf(Math.max(...distances));
        target.setComponent(axis, point.getComponent(axis) < 0 ? -1 : 1);
      }
      return target.normalize();
    },
    distance: (point) => {
      const x = Math.abs(point.x) - half.x;
      const y = Math.abs(point.y) - half.y;
      const z = Math.abs(point.z) - half.z;
      return (
        Math.hypot(Math.max(x, 0), Math.max(y, 0), Math.max(z, 0)) + Math.min(Math.max(x, y, z), 0)
      );
    },
  };
}

export function cylinderVolume(radius: number, length: number): ImplicitVolume {
  return {
    bounds: new THREE.Box3(
      new THREE.Vector3(-radius, -radius, -length / 2),
      new THREE.Vector3(radius, radius, length / 2),
    ),
    extrusion: [{ axis: 2, minimum: -length / 2, maximum: length / 2 }],
    planarExtrusionAxis: (bounds) =>
      Math.hypot(
        Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)),
        Math.max(Math.abs(bounds.min.y), Math.abs(bounds.max.y)),
      ) < radius
        ? 0
        : undefined,
    countCentres: (first, span, spacing) => {
      const axial = intervalCount(first.z, span, spacing, length / 2);
      if (!axial) return 0;
      let radial = 0;
      for (let y = 0; y < span; y++) {
        for (let x = 0; x < span; x++) {
          if ((first.x + x * spacing) ** 2 + (first.y + y * spacing) ** 2 < radius ** 2) radial++;
        }
      }
      return radial * axial;
    },
    normal: (point, target) => {
      const radialLength = Math.hypot(point.x, point.y);
      const radial = radialLength - radius;
      const axial = Math.abs(point.z) - length / 2;
      const radialWeight = radial > 0 || axial > 0 ? Math.max(radial, 0) : radial >= axial ? 1 : 0;
      const axialWeight = radial > 0 || axial > 0 ? Math.max(axial, 0) : axial > radial ? 1 : 0;
      return target
        .set(
          radialLength ? (radialWeight * point.x) / radialLength : 0,
          radialLength ? (radialWeight * point.y) / radialLength : 0,
          axialWeight * (point.z < 0 ? -1 : 1),
        )
        .normalize();
    },
    distance: (point) => {
      const radial = Math.hypot(point.x, point.y) - radius;
      const axial = Math.abs(point.z) - length / 2;
      return (
        Math.hypot(Math.max(radial, 0), Math.max(axial, 0)) + Math.min(Math.max(radial, axial), 0)
      );
    },
  };
}
