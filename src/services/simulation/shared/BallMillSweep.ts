import * as THREE from 'three';

/** Minimum of the convex finite ball-cutter field over a translation segment. */
export class BallMillSweep {
  private readonly candidates = new Float64Array(9);
  private count = 0;
  private readonly dx: number;
  private readonly dy: number;
  private readonly dz: number;
  private readonly radialSquared: number;
  private readonly squared: number;

  constructor(
    private readonly radius: number,
    private readonly length: number,
    travel = new THREE.Vector3(),
  ) {
    this.dx = travel.x;
    this.dy = travel.y;
    this.dz = travel.z;
    this.radialSquared = travel.x ** 2 + travel.y ** 2;
    this.squared = this.radialSquared + travel.z ** 2;
  }

  private candidate(t: number): void {
    if (t > 0 && t < 1) this.candidates[this.count++] = t;
  }

  private intersections(a: number, b: number, c: number): void {
    const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
    if (scale === 0) return;
    a /= scale;
    b /= scale;
    c /= scale;
    if (a === 0) {
      if (b !== 0) this.candidate(-c / b);
      return;
    }
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return;
    const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(discriminant));
    if (q === 0) this.candidate(-b / (2 * a));
    else {
      this.candidate(q / a);
      this.candidate(c / q);
    }
  }

  evaluate(point: THREE.Vector3, normal?: THREE.Vector3): number {
    const { x, y, z } = point;
    this.count = 1;
    this.candidates[0] = 0;
    if (this.squared > 0) {
      this.candidates[this.count++] = 1;
      const radialDot = x * this.dx + y * this.dy;
      const radial = x * x + y * y;
      const bottom = z - this.radius;
      const cap = z - this.length + this.radius;
      this.candidate((radialDot + bottom * this.dz) / this.squared);
      if (this.radialSquared > 0) this.candidate(radialDot / this.radialSquared);
      if (this.dz !== 0) this.candidate(bottom / this.dz);
      // A minimax minimum lies at an endpoint, a rounded-field stationary
      // point, the equator, or an intersection with the finite top plane.
      this.intersections(
        this.radialSquared,
        -2 * radialDot + 2 * this.dz * (2 * this.radius - this.length),
        radial + (this.length - 2 * this.radius) * (2 * z - this.length),
      );
      this.intersections(
        this.radialSquared - this.dz ** 2,
        -2 * radialDot + 2 * cap * this.dz,
        radial - cap * cap,
      );
    }
    let best = Infinity,
      parameter = 0;
    for (let i = 0; i < this.count; i++) {
      const t = this.candidates[i];
      const value = Math.max(
        Math.hypot(x - t * this.dx, y - t * this.dy, Math.min(z - t * this.dz - this.radius, 0)) -
          this.radius,
        z - t * this.dz - this.length,
      );
      if (value < best) {
        best = value;
        parameter = t;
      }
    }
    if (normal) {
      const qx = x - parameter * this.dx,
        qy = y - parameter * this.dy,
        qz = z - parameter * this.dz;
      const bottom = Math.min(qz - this.radius, 0);
      const magnitude = Math.hypot(qx, qy, bottom);
      const rounded = magnitude - this.radius,
        top = qz - this.length;
      const tie =
        Math.abs(rounded - top) <= 32 * Number.EPSILON * Math.max(1, this.radius, Math.abs(top));
      if (top > rounded && !tie) normal.set(0, 0, 1);
      else {
        if (magnitude > 0) normal.set(qx / magnitude, qy / magnitude, bottom / magnitude);
        else normal.set(1, 0, 0);
        if (tie && parameter > 0 && parameter < 1) {
          const denominator =
            this.dz - normal.x * this.dx - normal.y * this.dy - normal.z * this.dz;
          const weight = denominator === 0 ? 1 : this.dz / denominator;
          if (weight >= 0 && weight <= 1) {
            normal.multiplyScalar(weight);
            normal.z += 1 - weight;
          }
        }
        normal.normalize();
      }
    }
    return best;
  }
}
