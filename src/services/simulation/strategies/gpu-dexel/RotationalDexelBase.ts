import * as THREE from 'three';
import type { RotationalProfile } from '../cpu-hybrid/RotationalProfile';
import { SimulationCapabilityError } from '../../shared/SimulationTypes';

type Slabs = RotationalProfile['meridianSlabs'];
type Span = [number, number];

/** Immutable material at the symmetry frontier, never updated after milling. */
export class RotationalDexelBase {
  readonly slabs: Slabs;
  readonly words: Uint32Array;
  readonly fingerprint: string;
  readonly estimatedBytes: number;
  readonly maxIntervals: number;

  constructor(profile: RotationalProfile) {
    this.slabs = profile.meridianSlabs.map((slab) =>
      Object.freeze({
        lower: slab.lower,
        upper: slab.upper,
        intervals: Object.freeze(
          slab.intervals.map((band) =>
            Object.freeze({
              lower: Object.freeze({ ...band.lower }),
              upper: Object.freeze({ ...band.upper }),
            }),
          ),
        ),
      }),
    );
    Object.freeze(this.slabs);
    this.fingerprint = JSON.stringify([profile.radius, profile.length, this.slabs]);
    const levels = [
      ...new Set(
        this.slabs.flatMap((slab) =>
          slab.intervals.flatMap((band) =>
            [band.lower, band.upper].flatMap((line) =>
              [slab.lower, slab.upper].map((z) => Math.max(0, line.slope * z + line.offset)),
            ),
          ),
        ),
      ),
    ].sort((a, b) => a - b);
    const radii = [...levels, ...levels.slice(1).map((r, i) => (r + levels[i]) / 2)];
    this.maxIntervals = Math.max(
      1,
      ...this.slabs.map((s) => s.intervals.length * 2),
      ...radii.map((r) => this.intervals(2, new THREE.Vector3(r, 0, 0)).length),
    );
    if (this.maxIntervals > 64)
      throw new SimulationCapabilityError('Implicit rotational base exceeds 64 ray intervals');
    // Header, indexed slab table (z bounds, first band, band count), linear radial bands.
    const bands = this.slabs.reduce((n, slab) => n + slab.intervals.length, 0);
    this.words = new Uint32Array(1 + this.slabs.length * 4 + bands * 4);
    const floats = new Float32Array(this.words.buffer);
    this.words[0] = this.slabs.length;
    let first = 1 + this.slabs.length * 4;
    this.slabs.forEach((slab, i) => {
      floats[1 + i * 4] = slab.lower;
      floats[2 + i * 4] = slab.upper;
      this.words[3 + i * 4] = first;
      this.words[4 + i * 4] = slab.intervals.length;
      for (const band of slab.intervals) {
        floats.set(
          [band.lower.slope, band.lower.offset, band.upper.slope, band.upper.offset],
          first,
        );
        first += 4;
      }
    });
    this.estimatedBytes =
      this.words.byteLength * 3 +
      this.fingerprint.length * 2 +
      this.slabs.length * 128 +
      bands * 192;
  }

  /** Exact axis-aligned ray intersections in stock-local coordinates. */
  intervals(axis: number, point: THREE.Vector3): Span[] {
    const result: Span[] = [];
    if (axis !== 2) {
      const slab = this.slabs.find((s) => point.z >= s.lower && point.z < s.upper);
      if (!slab) return result;
      const other = axis === 0 ? point.y : point.x;
      for (const band of slab.intervals) {
        const lo = Math.max(0, band.lower.slope * point.z + band.lower.offset);
        const hi = Math.max(0, band.upper.slope * point.z + band.upper.offset);
        if (hi <= Math.abs(other)) continue;
        const outer = Math.sqrt(hi * hi - other * other);
        const inner = Math.sqrt(Math.max(0, lo * lo - other * other));
        if (inner) result.push([-outer, -inner], [inner, outer]);
        else result.push([-outer, outer]);
      }
    } else {
      const radius = Math.hypot(point.x, point.y);
      for (const slab of this.slabs)
        for (const band of slab.intervals) {
          let lo = slab.lower,
            hi = slab.upper;
          for (const [line, sign] of [
            [band.lower, 1],
            [band.upper, -1],
          ] as const) {
            const a = sign * line.slope,
              b = sign * (line.offset - radius);
            if (!a) {
              if (b > 0) hi = lo;
            } else if (a > 0) hi = Math.min(hi, -b / a);
            else lo = Math.max(lo, -b / a);
          }
          if (hi > lo) result.push([lo, hi]);
        }
    }
    result.sort((a, b) => a[0] - b[0]);
    const merged: Span[] = [];
    for (const span of result) {
      const last = merged.at(-1);
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else merged.push(span);
    }
    return merged;
  }
}

/** Uses the existing tile-index binding, retaining the eight-storage-binding baseline. */
export const ROTATIONAL_BASE_WGSL = `
fn gpuOriginalIntervals(id: u32, size: vec3f, dims: vec3f, cylinder: u32,
  segments: ptr<function, array<vec2f, 64>>) -> u32 {
  let header = gpuRayCount(dims) / 1024u;
  let slabs = dexelTileSweeps.value[header];
  if (slabs == 0u) {
    let span = gpuCylinderSpan(id, size, dims, cylinder);
    (*segments)[0] = span;
    return select(0u, 1u, span.x < span.y);
  }
  let info = gpuRayInfo(id, size, dims); let axis = u32(info.w);
  if (any(info.xyz > size * 0.5)) { return 0u; }
  var first = 0u; var last = slabs;
  if (axis != 2u) {
    loop {
      if (first >= last) { break; }
      let mid = first + (last - first) / 2u;
      let upper = bitcast<f32>(dexelTileSweeps.value[header + 2u + mid * 4u]);
      if (upper <= info.z) { first = mid + 1u; } else { last = mid; }
    }
    last = min(slabs, first + 1u);
  }
  var count = 0u;
  for (var s = first; s < last; s++) {
    let table = header + 1u + s * 4u;
    let za = bitcast<f32>(dexelTileSweeps.value[table]);
    let zb = bitcast<f32>(dexelTileSweeps.value[table + 1u]);
    if (axis != 2u && (info.z < za || info.z >= zb)) { continue; }
    let bands = dexelTileSweeps.value[table + 3u];
    for (var b = 0u; b < bands; b++) {
      let index = header + dexelTileSweeps.value[table + 2u] + b * 4u;
      let lower = vec2f(bitcast<f32>(dexelTileSweeps.value[index]), bitcast<f32>(dexelTileSweeps.value[index + 1u]));
      let upper = vec2f(bitcast<f32>(dexelTileSweeps.value[index + 2u]), bitcast<f32>(dexelTileSweeps.value[index + 3u]));
      var spans: array<vec2f, 2>; var n = 0u;
      if (axis == 2u) {
        let radius = length(info.xy); var lo = za; var hi = zb;
        let lines = array<vec2f, 2>(lower, -upper);
        for (var l = 0u; l < 2u; l++) {
          let a = lines[l].x;
          let v = lines[l].y - select(radius, -radius, l == 1u);
          if (a == 0.0) { if (v > 0.0) { hi = lo; } }
          else if (a > 0.0) { hi = min(hi, -v / a); }
          else { lo = max(lo, -v / a); }
        }
        if (hi > lo) { spans[0] = vec2f(lo, hi); n = 1u; }
      } else {
        let other = info[1u - axis];
        let lo = max(0.0, lower.x * info.z + lower.y);
        let hi = max(0.0, upper.x * info.z + upper.y);
        if (hi > abs(other)) {
          let outer = sqrt(max(0.0, hi * hi - other * other));
          let inner = sqrt(max(0.0, lo * lo - other * other));
          spans[0] = vec2f(-outer, outer); n = 1u;
          if (inner > 0.0) { spans[0].y = -inner; spans[1] = vec2f(inner, outer); n = 2u; }
        }
      }
      for (var j = 0u; j < n; j++) {
        // Insert/union in sorted order, including adjacent axial slabs.
        var cut = spans[j]; var at = 0u;
        loop { if (at >= count || (*segments)[at].y >= cut.x) { break; } at++; }
        var end = at;
        loop {
          if (end >= count || (*segments)[end].x > cut.y) { break; }
          cut = vec2f(min(cut.x, (*segments)[end].x), max(cut.y, (*segments)[end].y)); end++;
        }
        if (at == end && count == 64u) { return 99u; }
        let removed = end - at;
        if (removed == 0u) {
          var k = count;
          loop { if (k <= at) { break; } (*segments)[k] = (*segments)[k - 1u]; k--; }
          count++;
        } else {
          for (var k = end; k < count; k++) { (*segments)[at + 1u + k - end] = (*segments)[k]; }
          count = count + 1u - removed;
        }
        (*segments)[at] = cut;
      }
    }
  }
  return count;
}
fn gpuOriginalSpan(id: u32, i: u32, size: vec3f, dims: vec3f, cylinder: u32) -> vec2f {
  var segments: array<vec2f, 64>;
  let count = gpuOriginalIntervals(id, size, dims, cylinder, &segments);
  if (i >= count || count > 64u) { return vec2f(0.0); }
  return segments[i];
}
fn gpuOriginalCount(id: u32, size: vec3f, dims: vec3f, cylinder: u32) -> u32 {
  var segments: array<vec2f, 64>;
  return gpuOriginalIntervals(id, size, dims, cylinder, &segments);
}
`;
