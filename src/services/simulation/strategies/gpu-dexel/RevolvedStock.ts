import * as THREE from 'three';
import { RotationalProfile } from '../cpu-hybrid/RotationalProfile';
import { SimulationCapabilityError, SIMULATION_LIMITS } from '../../shared/SimulationTypes';

type Span = readonly [number, number];

function exposed(span: Span, neighbours: readonly Span[]): Span[] {
  let remaining: Span[] = [span];
  for (const [lo, hi] of neighbours)
    remaining = remaining.flatMap(([a, b]) =>
      hi <= a || lo >= b
        ? [[a, b] as Span]
        : [...(a < lo ? [[a, lo] as Span] : []), ...(b > hi ? [[hi, b] as Span] : [])],
    );
  return remaining;
}

/** Compact display only: the double-precision meridian remains the material authority. */
export class RevolvedStock {
  readonly group = new THREE.Group();
  estimatedBytes: number;
  private disposed = false;

  constructor(
    readonly profile: RotationalProfile,
    readonly pitchMm: number,
    placement: THREE.Matrix4,
    reserve: (bytes: number) => void,
  ) {
    // Sagitta, not arc length: axial/meridian boundaries are never sampled or simplified.
    const segments = Math.max(
      16,
      Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - pitchMm / (2 * profile.radius)))),
    );
    const slabs = profile.meridianSlabs;
    const panels: { a: number; za: number; b: number; zb: number; inward: boolean }[] = [];
    for (let i = 0; i < slabs.length; i++) {
      const slab = slabs[i];
      const at = (line: { slope: number; offset: number }, z: number) =>
        Math.max(0, line.slope * z + line.offset);
      for (const interval of slab.intervals) {
        for (const [line, inward] of [
          [interval.lower, true],
          [interval.upper, false],
        ] as const) {
          const a = at(line, slab.lower),
            b = at(line, slab.upper);
          if (a || b) panels.push({ a, za: slab.lower, b, zb: slab.upper, inward });
        }
        for (const [z, adjacent, inward] of [
          [slab.lower, slabs[i - 1], false],
          [slab.upper, slabs[i + 1], true],
        ] as const) {
          const touching = adjacent && (adjacent.lower === z || adjacent.upper === z);
          const neighbours = touching
            ? adjacent.intervals.map((band): Span => [at(band.lower, z), at(band.upper, z)])
            : [];
          for (const [a, b] of exposed([at(interval.lower, z), at(interval.upper, z)], neighbours))
            if (b > a) panels.push({ a, za: z, b, zb: z, inward });
        }
      }
      if (panels.length * segments * 2 > SIMULATION_LIMITS.surfaceFaces)
        throw new SimulationCapabilityError('Revolved stock exceeds the surface triangle budget');
      reserve(profile.allocatedBytes + panels.length * 128 + panels.length * segments * 288 + 4096);
    }
    const positions = new Float32Array(panels.length * segments * 18);
    const normals = new Float32Array(positions.length);
    let offset = 0;
    const point = (r: number, z: number, j: number): [number, number, number] => {
      const angle = ((j % segments) * Math.PI * 2) / segments;
      return [r * Math.cos(angle), r * Math.sin(angle), z];
    };
    for (const panel of panels)
      for (let j = 0; j < segments; j++) {
        const a = point(panel.a, panel.za, j),
          b = point(panel.a, panel.za, j + 1);
        const c = point(panel.b, panel.zb, j),
          d = point(panel.b, panel.zb, j + 1);
        const vertices = panel.inward ? [a, c, b, b, c, d] : [a, b, c, b, d, c];
        for (let k = 0; k < 6; k += 3) {
          // An axis pole produces one triangle, not a collapsed ring quad.
          if (
            vertices[k].every((v, n) => v === vertices[k + 1][n]) ||
            vertices[k].every((v, n) => v === vertices[k + 2][n]) ||
            vertices[k + 1].every((v, n) => v === vertices[k + 2][n])
          )
            continue;
          for (const vertex of vertices.slice(k, k + 3)) {
            positions.set(vertex, offset);
            const radius = Math.hypot(vertex[0], vertex[1]);
            const angle = ((j + 0.5) * Math.PI * 2) / segments;
            const dz = panel.zb - panel.za,
              dr = panel.b - panel.a;
            const scale = (panel.inward ? -1 : 1) / Math.hypot(dz, dr);
            normals.set(
              [
                (radius ? vertex[0] / radius : Math.cos(angle)) * dz * scale,
                (radius ? vertex[1] / radius : Math.sin(angle)) * dz * scale,
                -dr * scale,
              ],
              offset,
            );
            offset += 3;
          }
        }
      }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, offset), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals.subarray(0, offset), 3));
    const material = new THREE.MeshStandardMaterial({
      color: 0xc4c7ca,
      roughness: 0.65,
      metalness: 0.15,
    });
    this.group.add(new THREE.Mesh(geometry, material));
    this.group.name = 'revolved-stock';
    this.group.matrixAutoUpdate = false;
    this.group.matrix.copy(placement);
    this.group.userData.releaseGpuStock = () => this.dispose();
    this.estimatedBytes =
      profile.allocatedBytes + positions.byteLength * 4 + panels.length * 128 + 4096;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const child of this.group.children) {
      const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}
