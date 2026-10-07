import * as THREE from 'three';
import type { ImplicitVolume } from './ImplicitGeometry';

interface SweepNode {
  tips: THREE.Box3;
  firstIndex: number;
  sweep?: number;
  left?: SweepNode;
  right?: SweepNode;
}

export const MAX_INDEXED_SWEEPS = 128;

/** Bounded BVH of exact fields; box overlap alone never certifies removal. */
export class IndexedBallSweeps {
  readonly volume: ImplicitVolume;
  readonly workspaceBytes: number;
  primitiveTests = 0;
  boundTests = 0;
  private readonly root: SweepNode;
  private readonly frame: THREE.Matrix4;
  private readonly radius: number;
  private readonly length: number;
  private readonly local = new THREE.Vector3();
  private best = Infinity;
  private winner = -1;

  constructor(
    private readonly sweeps: readonly ImplicitVolume[],
    private readonly test: () => void = () => {},
    private readonly testBound: () => void = () => {},
  ) {
    if (sweeps.length < 2 || sweeps.length > MAX_INDEXED_SWEEPS)
      throw new Error(`Indexed ball batches require 2..${MAX_INDEXED_SWEEPS} sweeps`);
    const first = sweeps[0].ballBounds;
    if (!first) throw new Error('Indexed ball batch requires certified ball bounds');
    if (
      sweeps.some(
        (sweep) =>
          !sweep.ballBounds ||
          !sweep.normal ||
          sweep.ballBounds.radius !== first.radius ||
          sweep.ballBounds.length !== first.length ||
          !sweep.ballBounds.frame.equals(first.frame),
      )
    )
      throw new Error('Indexed ball batch must share an exact cutter frame and profile');
    this.frame = first.frame;
    this.radius = first.radius;
    this.length = first.length;
    this.root = this.build(sweeps.map((_, index) => index));
    this.workspaceBytes = sweeps.length * 4096 + (2 * sweeps.length - 1) * 256 + 4096;
    const bounds = new THREE.Box3();
    for (const sweep of sweeps) bounds.union(sweep.bounds);
    this.volume = {
      bounds,
      workspaceBytes: this.workspaceBytes,
      distance: (point) => this.evaluate(point),
      normal: (point, target) => {
        this.evaluate(point);
        this.test();
        return this.sweeps[this.winner].normal!(point, target);
      },
    };
  }

  private build(indices: number[]): SweepNode {
    const tips = new THREE.Box3();
    for (const index of indices) tips.union(this.sweeps[index].ballBounds!.tips);
    const node: SweepNode = { tips, firstIndex: Math.min(...indices) };
    if (indices.length === 1) node.sweep = indices[0];
    else {
      const size = tips.getSize(new THREE.Vector3());
      const axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
      indices.sort((a, b) => {
        const first = this.sweeps[a].ballBounds!.tips,
          second = this.sweeps[b].ballBounds!.tips;
        return (
          first.min.getComponent(axis) +
            first.max.getComponent(axis) -
            second.min.getComponent(axis) -
            second.max.getComponent(axis) || a - b
        );
      });
      const half = Math.floor(indices.length / 2);
      node.left = this.build(indices.slice(0, half));
      node.right = this.build(indices.slice(half));
    }
    return node;
  }

  private lowerBound(node: SweepNode): number {
    this.testBound();
    this.boundTests++;
    const { min, max } = node.tips;
    const { x, y, z } = this.local;
    // The infinite rounded body contains a ray starting at each ball centre.
    // A bounding semi-box contains every such ray; the finite top adds a plane.
    // max(min(body fields), min(top fields)) <= min(complete cutter fields).
    const radial =
      Math.hypot(
        Math.max(min.x - x, 0, x - max.x),
        Math.max(min.y - y, 0, y - max.y),
        Math.max(min.z + this.radius - z, 0),
      ) - this.radius;
    const top = z - max.z - this.length;
    const error =
      128 *
      Number.EPSILON *
      Math.max(1, Math.abs(x), Math.abs(y), Math.abs(z), min.length(), max.length(), this.length);
    return Math.max(radial, top) - error;
  }

  private visit(node: SweepNode, lower: number, point: THREE.Vector3): void {
    if (lower > this.best) return;
    if (node.sweep !== undefined) {
      this.test();
      this.primitiveTests++;
      const value = this.sweeps[node.sweep].distance(point);
      if (!Number.isFinite(value)) throw new Error('Non-finite indexed cutter field');
      if (value < this.best || (value === this.best && node.sweep < this.winner)) {
        this.best = value;
        this.winner = node.sweep;
      }
      return;
    }
    const left = node.left!,
      right = node.right!;
    const a = this.lowerBound(left),
      b = this.lowerBound(right);
    if (a < b || (a === b && left.firstIndex < right.firstIndex)) {
      this.visit(left, a, point);
      this.visit(right, b, point);
    } else {
      this.visit(right, b, point);
      this.visit(left, a, point);
    }
  }

  evaluate(point: THREE.Vector3): number {
    this.local.copy(point).applyMatrix4(this.frame);
    this.best = Infinity;
    this.winner = -1;
    this.visit(this.root, this.lowerBound(this.root), point);
    if (this.winner < 0) throw new Error('Indexed ball batch has no finite field');
    return this.best;
  }
}
