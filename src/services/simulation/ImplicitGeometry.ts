import * as THREE from 'three';

/** Negative inside; fields must be 1-Lipschitz for conservative region classification. */
export interface ImplicitVolume {
  bounds: THREE.Box3;
  distance(point: THREE.Vector3): number;
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

// The same body diagonal in every cell gives matching triangulations on shared faces.
export const CELL_TETRAHEDRA = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
] as const;

export const CELL_EDGES: readonly (readonly [number, number])[] = (() => {
  const edges = new Map<string, [number, number]>();
  for (const tetra of CELL_TETRAHEDRA) {
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const a = Math.min(tetra[i], tetra[j]),
          b = Math.max(tetra[i], tetra[j]);
        edges.set(`${a}:${b}`, [a, b]);
      }
    }
  }
  return [...edges.values()];
})();

export function edgeIndex(a: number, b: number): number {
  const index = CELL_EDGES.findIndex(([u, v]) => u === Math.min(a, b) && v === Math.max(a, b));
  if (index < 0) throw new Error('Invalid surface edge');
  return index;
}

export function edgeRoot(a: number, b: number, field: (t: number) => number): number {
  if (Math.abs(a) < 1e-12) return 0;
  if (Math.abs(b) < 1e-12) return 1;
  if (a < 0 === b < 0) throw new Error('Surface edge has no bracketed intersection');
  let low = 0,
    high = 1;
  for (let iteration = 0; iteration < 24; iteration++) {
    const middle = (low + high) / 2;
    if (field(middle) < 0 === a < 0) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

export function boxVolume(size: readonly number[]): ImplicitVolume {
  const half = new THREE.Vector3(size[0] / 2, size[1] / 2, size[2] / 2);
  return {
    bounds: new THREE.Box3(half.clone().negate(), half.clone()),
    countCentres: (first, span, spacing) =>
      intervalCount(first.x, span, spacing, half.x) *
      intervalCount(first.y, span, spacing, half.y) *
      intervalCount(first.z, span, spacing, half.z),
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
    distance: (point) => {
      const radial = Math.hypot(point.x, point.y) - radius;
      const axial = Math.abs(point.z) - length / 2;
      return (
        Math.hypot(Math.max(radial, 0), Math.max(axial, 0)) + Math.min(Math.max(radial, axial), 0)
      );
    },
  };
}
