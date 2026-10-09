import * as THREE from 'three';
import { cylinderVolume, type ImplicitVolume } from './ImplicitGeometry';
import { SIMULATION_LIMITS } from './SimulationTypes';
import { turningSectionVolume } from './TurningEnvelope';

interface Line {
  slope: number;
  offset: number;
}
interface Interval {
  lower: Line;
  upper: Line;
}
interface Slab {
  lower: number;
  upper: number;
  intervals: Interval[];
}
interface ProfileCut {
  volume: ImplicitVolume;
  order: readonly number[];
  positive: boolean;
  negative: boolean;
}

interface ProfileHistoryState {
  version: 1;
  radius: number;
  length: number;
  slabs: Slab[];
  cuts: Array<{
    origin: [number, number, number];
    axis: [number, number, number];
    radial: [number, number, number];
    polygon: [number, number][];
    order: readonly number[];
    positive: boolean;
    negative: boolean;
  }>;
  fieldBytes: number;
  updates: number;
  arrangementTests: number;
}

const value = (line: Line, z: number): number => line.slope * z + line.offset;
const sameLine = (a: Line, b: Line): boolean => a.slope === b.slope && a.offset === b.offset;

/** A meridian interval arrangement; non-axisymmetric removals remain in StockModel. */
export class RotationalProfile {
  readonly volume: ImplicitVolume;
  private readonly initial: ImplicitVolume;
  private readonly cuts: ProfileCut[] = [];
  private slabs: Slab[];
  private fieldBytes = 0;
  private readonly zero: Line = { slope: 0, offset: 0 };
  private readonly outer: Line;
  private readonly countCache = new Map<string, number>();
  private countCacheBytes = 0;
  readonly maxCachedCounts = 4096;
  updates = 0;
  distancePrimitiveTests = 0;
  planeTests = 0;
  arrangementTests = 0;
  private activeCut?: ImplicitVolume;

  constructor(
    readonly radius: number,
    readonly length: number,
  ) {
    if (!(radius > 0 && length > 0) || !Number.isFinite(radius + length))
      throw new Error('Invalid rotational profile dimensions');
    this.initial = cylinderVolume(radius, length);
    this.outer = { slope: 0, offset: radius };
    this.slabs = [
      {
        lower: -length / 2,
        upper: length / 2,
        intervals: [{ lower: this.zero, upper: this.outer }],
      },
    ];
    this.volume = {
      bounds: this.initial.bounds,
      distance: (point) => {
        return this.evaluate(point);
      },
      normal: (point, target) => {
        this.evaluate(point);
        const active = this.activeCut;
        if (active) {
          if (!active.normal) throw new Error('Rotational cut requires analytical normals');
          return active.normal(point, target).negate();
        }
        return this.initial.normal!(point, target);
      },
      countCentres: (first, span, spacing) => this.countCentres(first, span, spacing),
      planarExtrusionAxis: (bounds) => this.planarExtrusionAxis(bounds),
    };
    this.refreshExtrusions();
  }

  get allocatedBytes(): number {
    return (
      1024 +
      this.fieldBytes +
      this.slabs.reduce((bytes, slab) => bytes + 128 + slab.intervals.length * 192, 0) +
      this.countCacheBytes
    );
  }

  fork(): RotationalProfile {
    const copy = new RotationalProfile(this.radius, this.length);
    copy.cuts.push(...this.cuts);
    copy.slabs = this.slabs.map((slab) => ({
      ...slab,
      intervals: slab.intervals.map((interval) => ({
        lower: { ...interval.lower },
        upper: { ...interval.upper },
      })),
    }));
    copy.fieldBytes = this.fieldBytes;
    copy.updates = this.updates;
    copy.arrangementTests = this.arrangementTests;
    copy.refreshExtrusions();
    return copy;
  }

  encodeHistory(): Uint8Array {
    const state: ProfileHistoryState = {
      version: 1, radius: this.radius, length: this.length, slabs: this.slabs,
      cuts: this.cuts.map((cut) => {
        const section = cut.volume.rotationalSection!;
        if (!section.radialDirection || !section.planes)
          throw new Error('Rotational history requires a production convex turning section');
        return {
          origin: section.spindleOrigin.toArray(), axis: section.spindleAxis.toArray(),
          radial: section.radialDirection.toArray(),
          polygon: section.polygon.map((point) => point.toArray()),
          order: cut.order, positive: cut.positive, negative: cut.negative,
        };
      }),
      fieldBytes: this.fieldBytes, updates: this.updates, arrangementTests: this.arrangementTests,
    };
    return new TextEncoder().encode(JSON.stringify(state));
  }

  get historySerializable(): boolean {
    return this.cuts.every((cut) =>
      Boolean(cut.volume.rotationalSection?.planes && cut.volume.rotationalSection.radialDirection));
  }

  restoreHistory(data: Uint8Array): void {
    const state: ProfileHistoryState = JSON.parse(new TextDecoder().decode(data));
    if (state.version !== 1 || state.radius !== this.radius || state.length !== this.length ||
      !Array.isArray(state.slabs) || !Array.isArray(state.cuts) ||
      !Number.isSafeInteger(state.fieldBytes) || state.fieldBytes < 0 ||
      !Number.isSafeInteger(state.updates) || state.updates < 0)
      throw new Error('Invalid rotational stock history');
    const cuts = state.cuts.map((cut): ProfileCut => ({
      volume: turningSectionVolume(
        cut.polygon.map((point) => new THREE.Vector2(...point)),
        new THREE.Vector3(...cut.origin), new THREE.Vector3(...cut.axis), new THREE.Vector3(...cut.radial),
      ),
      order: cut.order, positive: cut.positive, negative: cut.negative,
    }));
    this.cuts.splice(0, this.cuts.length, ...cuts);
    this.slabs = state.slabs;
    this.fieldBytes = state.fieldBytes;
    this.updates = state.updates;
    this.arrangementTests = state.arrangementTests;
    this.countCache.clear();
    this.countCacheBytes = 0;
    this.activeCut = undefined;
    this.resetQueryCounters();
    this.refreshExtrusions();
  }

  resetQueryCounters(): void {
    this.distancePrimitiveTests = 0;
    this.planeTests = 0;
  }

  canApply(cut: ImplicitVolume): boolean {
    const section = cut.rotationalSection;
    if (!section || !cut.normal) return false;
    const epsilon = 64 * Number.EPSILON * Math.max(1, this.radius, this.length);
    return (
      Math.abs(section.spindleOrigin.x) <= epsilon &&
      Math.abs(section.spindleOrigin.y) <= epsilon &&
      Math.abs(section.spindleAxis.x) <= 64 * Number.EPSILON &&
      Math.abs(section.spindleAxis.y) <= 64 * Number.EPSILON &&
      Math.abs(Math.abs(section.spindleAxis.z) - 1) <= 64 * Number.EPSILON
    );
  }

  apply(cut: ImplicitVolume, reserve: (bytes: number) => void): void {
    if (!this.canApply(cut)) throw new Error('Cut is not coaxial conventional turning');
    if (cut.identity && this.cuts.some((previous) => previous.volume.identity === cut.identity))
      return;
    const section = cut.rotationalSection!;
    let next = this.slabs;
    const axis = section.spindleAxis.z < 0 ? -1 : 1;
    for (const sign of [1, -1]) {
      const polygon = section.polygon.map(
        (p) => new THREE.Vector2(sign * p.x, section.spindleOrigin.z + axis * p.y),
      );
      if (Math.max(...polygon.map((p) => p.x)) <= 0) continue;
      next = this.subtractPolygon(next, polygon, reserve);
    }
    reserve(
      this.allocatedBytes +
        next.reduce((bytes, slab) => bytes + 128 + slab.intervals.length * 192, 0) +
        section.polygon.length * 256 +
        4096,
    );
    this.slabs = next;
    const planes = section.planes ?? [];
    const selected = new Set<number>();
    for (const score of [
      (p: { x: number; y: number }) => -p.x,
      (p: { x: number; y: number }) => p.x,
      (p: { x: number; y: number }) => -p.y,
      (p: { x: number; y: number }) => p.y,
    ]) {
      let best = 0;
      for (let i = 1; i < planes.length; i++) if (score(planes[i]) > score(planes[best])) best = i;
      if (planes.length) selected.add(best);
    }
    this.cuts.push({
      volume: cut,
      order: [...selected, ...planes.map((_, i) => i).filter((i) => !selected.has(i))],
      positive: section.polygon.some((p) => p.x >= 0),
      negative: section.polygon.some((p) => p.x <= 0),
    });
    this.fieldBytes += section.polygon.length * 256 + 4096;
    this.countCache.clear();
    this.countCacheBytes = 0;
    this.updates++;
    this.refreshExtrusions();
  }

  private evaluate(point: THREE.Vector3): number {
    this.distancePrimitiveTests++;
    let field = this.initial.distance(point);
    this.activeCut = undefined;
    for (const cut of this.cuts) {
      this.distancePrimitiveTests++;
      const next = -this.cutDistance(cut, point, -field);
      if (next > field) {
        field = next;
        this.activeCut = cut.volume;
      }
    }
    return field;
  }

  private cutDistance(cut: ProfileCut, point: THREE.Vector3, threshold: number): number {
    const section = cut.volume.rotationalSection!;
    if (!section.planes) return cut.volume.distance(point);
    const x = point.x - section.spindleOrigin.x;
    const y = point.y - section.spindleOrigin.y;
    const z = point.z - section.spindleOrigin.z;
    const axial = x * section.spindleAxis.x + y * section.spindleAxis.y + z * section.spindleAxis.z;
    const r = Math.sqrt(Math.max(0, x * x + y * y + z * z - axial * axial));
    const positive = cut.positive ? this.branch(cut, r, axial, threshold) : Infinity;
    const negative = cut.negative ? this.branch(cut, -r, axial, threshold) : Infinity;
    return Math.min(positive, negative);
  }

  private branch(cut: ProfileCut, radial: number, axial: number, threshold: number): number {
    let distance = -Infinity;
    for (const index of cut.order) {
      const plane = cut.volume.rotationalSection!.planes![index];
      this.planeTests++;
      if (this.planeTests > SIMULATION_LIMITS.cellTests * 8)
        throw new Error('Rotational profile plane-test budget exceeded; use a smaller program');
      distance = Math.max(distance, plane.x * radial + plane.y * axial + plane.offset);
      // Each supporting plane is a lower bound on this convex branch.
      if (distance >= threshold) return distance;
    }
    return distance;
  }

  private subtractPolygon(
    slabs: readonly Slab[],
    polygon: readonly THREE.Vector2[],
    reserve: (bytes: number) => void,
  ): Slab[] {
    const output: Slab[] = [];
    let bytes = 0;
    const levels = [...new Set(polygon.map((p) => p.y))].sort((a, b) => a - b);
    for (const slab of slabs) {
      const breaks = [
        slab.lower,
        ...levels.filter((z) => z > slab.lower && z < slab.upper),
        slab.upper,
      ];
      for (let i = 1; i < breaks.length; i++) {
        const lower = breaks[i - 1],
          upper = breaks[i],
          mid = (lower + upper) / 2;
        const edges: Line[] = [];
        for (let j = 0; j < polygon.length; j++) {
          const a = polygon[j],
            b = polygon[(j + 1) % polygon.length];
          if (mid <= Math.min(a.y, b.y) || mid >= Math.max(a.y, b.y)) continue;
          const slope = (b.x - a.x) / (b.y - a.y);
          edges.push({ slope, offset: a.x - slope * a.y });
        }
        if (!edges.length) {
          output.push({ lower, upper, intervals: slab.intervals });
          bytes += 128 + slab.intervals.length * 192;
          reserve(this.allocatedBytes + bytes + 4096);
          continue;
        }
        if (edges.length !== 2) throw new Error('Invalid convex turning profile section');
        edges.sort((a, b) => value(a, mid) - value(b, mid));
        const functions = [
          this.zero,
          this.outer,
          ...edges,
          ...slab.intervals.flatMap((interval) => [interval.lower, interval.upper]),
        ];
        const crossings = new Set([lower, upper]);
        for (let a = 0; a < functions.length; a++)
          for (let b = a + 1; b < functions.length; b++) {
            if (++this.arrangementTests > SIMULATION_LIMITS.cellTests)
              throw new Error('Rotational profile update budget exceeded; use a smaller program');
            const denominator = functions[a].slope - functions[b].slope;
            if (!denominator) continue;
            const z = (functions[b].offset - functions[a].offset) / denominator;
            if (z > lower && z < upper && !crossings.has(z)) {
              reserve(
                this.allocatedBytes +
                  bytes +
                  functions.length * 256 +
                  (crossings.size + 1) * 64 +
                  4096,
              );
              crossings.add(z);
            }
          }
        const sorted = [...crossings].sort((a, b) => a - b);
        for (let k = 1; k < sorted.length; k++) {
          const low = sorted[k - 1],
            high = sorted[k],
            z = (low + high) / 2;
          const cutLow = value(edges[0], z) > 0 ? edges[0] : this.zero;
          const cutHigh = value(edges[1], z) < this.radius ? edges[1] : this.outer;
          const intervals: Interval[] = [];
          for (const interval of slab.intervals) {
            if (
              value(cutHigh, z) <= value(interval.lower, z) ||
              value(cutLow, z) >= value(interval.upper, z) ||
              value(cutLow, z) >= value(cutHigh, z)
            ) {
              intervals.push(interval);
              continue;
            }
            if (value(cutLow, z) > value(interval.lower, z))
              intervals.push({ lower: interval.lower, upper: cutLow });
            if (value(cutHigh, z) < value(interval.upper, z))
              intervals.push({ lower: cutHigh, upper: interval.upper });
          }
          output.push({ lower: low, upper: high, intervals });
          bytes += 128 + intervals.length * 192;
          reserve(this.allocatedBytes + bytes + functions.length * 256 + 4096);
        }
      }
    }
    const merged: Slab[] = [];
    for (const slab of output) {
      const previous = merged[merged.length - 1];
      if (
        previous &&
        previous.upper === slab.lower &&
        previous.intervals.length === slab.intervals.length &&
        previous.intervals.every(
          (interval, i) =>
            sameLine(interval.lower, slab.intervals[i].lower) &&
            sameLine(interval.upper, slab.intervals[i].upper),
        )
      )
        previous.upper = slab.upper;
      else merged.push({ ...slab });
    }
    return merged;
  }

  private slabAt(z: number): Slab | undefined {
    let lower = 0,
      upper = this.slabs.length;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      if (this.slabs[middle].upper <= z) lower = middle + 1;
      else upper = middle;
    }
    const slab = this.slabs[lower];
    return slab && slab.lower <= z ? slab : undefined;
  }

  radialIntervals(z: number): readonly (readonly [number, number])[] {
    const slab = this.slabAt(z);
    if (!slab || z <= -this.length / 2 || z >= this.length / 2) return [];
    const intervals = slab.intervals.map(
      (interval) => [value(interval.lower, z), value(interval.upper, z)] as const,
    );
    if (z !== slab.lower) return intervals;
    const previous = this.slabs[this.slabs.indexOf(slab) - 1];
    if (!previous) return [];
    const joined: [number, number][] = [];
    for (const [low, high] of intervals)
      for (const interval of previous.intervals) {
        const lower = Math.max(low, value(interval.lower, z));
        const upper = Math.min(high, value(interval.upper, z));
        if (lower < upper) joined.push([lower, upper]);
      }
    return joined;
  }

  countRegion(
    x: number,
    y: number,
    z: number,
    span: number,
    spacing: number,
    minimum: THREE.Vector3,
    test: () => void,
  ): number {
    const first = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5).multiplyScalar(spacing).add(minimum);
    return this.countCentres(first, span, spacing, { x, y, z, minimum }, test);
  }

  private countCentres(
    first: THREE.Vector3,
    span: number,
    spacing: number,
    canonical?: { x: number; y: number; z: number; minimum: THREE.Vector3 },
    test: () => void = () => {},
  ): number {
    let result = 0;
    const point = new THREE.Vector3();
    const coordinate = (axis: 'x' | 'y' | 'z', index: number): number =>
      canonical
        ? (canonical[axis] + index + 0.5) * spacing + canonical.minimum[axis]
        : first[axis] + index * spacing;
    const inside = (ix: number, iy: number, z: number): boolean => {
      for (let i = 0; i <= this.cuts.length; i++) test();
      return this.volume.distance(point.set(coordinate('x', ix), coordinate('y', iy), z)) < 0;
    };
    for (let iz = 0; iz < span; iz++) {
      const z = coordinate('z', iz);
      const epsilon = 128 * Number.EPSILON * Math.max(1, this.radius, this.length, Math.abs(z));
      const axialContact = this.slabs.some(
        (slab) => Math.abs(slab.lower - z) <= epsilon || Math.abs(slab.upper - z) <= epsilon,
      );
      if (this.cuts.length && axialContact) {
        for (let iy = 0; iy < span; iy++)
          for (let ix = 0; ix < span; ix++) if (inside(ix, iy, z)) result++;
        continue;
      }
      const intervals = this.radialIntervals(z);
      if (!intervals.length) continue;
      const key = JSON.stringify([first.x, first.y, span, spacing, intervals]);
      let count = this.countCache.get(key);
      if (count === undefined) {
        count = 0;
        for (const [lower, upper] of intervals)
          for (let iy = 0; iy < span; iy++) {
            const y = first.y + iy * spacing;
            count += this.discRow(first.x, y, span, spacing, upper, false);
            if (lower > 0) count -= this.discRow(first.x, y, span, spacing, lower, true);
          }
        const bytes = key.length * 2 + 96;
        while (
          this.countCache.size &&
          (this.countCache.size >= this.maxCachedCounts || this.countCacheBytes + bytes > 1048576)
        ) {
          const firstKey = this.countCache.keys().next().value!;
          this.countCache.delete(firstKey);
          this.countCacheBytes -= firstKey.length * 2 + 96;
        }
        if (bytes <= 1048576) {
          this.countCache.set(key, count);
          this.countCacheBytes += bytes;
        }
      }
      result += count;
      if (!this.cuts.length) continue;
      for (let iy = 0; iy < span; iy++) {
        const y = first.y + iy * spacing;
        const candidates = new Set<number>();
        for (const radius of intervals.flat()) {
          if (radius <= 0 || y * y > radius * radius + epsilon) continue;
          const extent = Math.sqrt(Math.max(0, radius * radius - y * y));
          for (const boundary of [-extent, extent]) {
            const index = Math.round((boundary - first.x) / spacing);
            if (index < 0 || index >= span) continue;
            const squared = (first.x + index * spacing) ** 2 + y * y;
            if (Math.abs(squared - radius * radius) <= epsilon * Math.max(1, radius))
              candidates.add(index);
          }
        }
        for (const ix of candidates) {
          const squared = (first.x + ix * spacing) ** 2 + y * y;
          const approximate = intervals.some(
            ([lower, upper]) => squared < upper * upper && (lower === 0 || squared > lower * lower),
          );
          result += Number(inside(ix, iy, z)) - Number(approximate);
        }
      }
    }
    return result;
  }

  private discRow(
    first: number,
    y: number,
    span: number,
    spacing: number,
    radius: number,
    inclusive: boolean,
  ): number {
    if (!(radius > 0) || y * y > radius * radius) return 0;
    const extent = Math.sqrt(Math.max(0, radius * radius - y * y));
    let low = Math.max(0, Math.ceil((-extent - first) / spacing));
    let high = Math.min(span - 1, Math.floor((extent - first) / spacing));
    const inside = (i: number): boolean => {
      const squared = (first + i * spacing) ** 2 + y * y;
      return inclusive ? squared <= radius * radius : squared < radius * radius;
    };
    if (low > 0 && inside(low - 1)) low--;
    if (high + 1 < span && inside(high + 1)) high++;
    while (low <= high && !inside(low)) low++;
    while (high >= low && !inside(high)) high--;
    return Math.max(0, high - low + 1);
  }

  private refreshExtrusions(): void {
    this.volume.extrusion = this.slabs
      .filter((slab) =>
        slab.intervals.every(
          (interval) => interval.lower.slope === 0 && interval.upper.slope === 0,
        ),
      )
      .map((slab) => ({ axis: 2, minimum: slab.lower, maximum: slab.upper }));
  }

  private planarExtrusionAxis(bounds: THREE.Box3): number | undefined {
    const far = Math.hypot(
      Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)),
      Math.max(Math.abs(bounds.min.y), Math.abs(bounds.max.y)),
    );
    const near = Math.hypot(
      bounds.min.x > 0 ? bounds.min.x : bounds.max.x < 0 ? bounds.max.x : 0,
      bounds.min.y > 0 ? bounds.min.y : bounds.max.y < 0 ? bounds.max.y : 0,
    );
    for (const slab of this.slabs) {
      if (slab.upper < bounds.min.z || slab.lower > bounds.max.z) continue;
      for (const interval of slab.intervals) {
        const a = Math.max(slab.lower, bounds.min.z),
          b = Math.min(slab.upper, bounds.max.z);
        const lowMin = Math.min(value(interval.lower, a), value(interval.lower, b));
        const lowMax = Math.max(value(interval.lower, a), value(interval.lower, b));
        const highMin = Math.min(value(interval.upper, a), value(interval.upper, b));
        const highMax = Math.max(value(interval.upper, a), value(interval.upper, b));
        if (far < lowMin || near > highMax) continue;
        if ((lowMax > 0 && near <= lowMax) || far >= highMin) return undefined;
      }
    }
    return 0;
  }
}
