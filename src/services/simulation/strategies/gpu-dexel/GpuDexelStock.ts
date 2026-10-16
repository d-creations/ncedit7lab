/// <reference types="@webgpu/types" />
import * as THREE from 'three';
import {
  MeshBasicNodeMaterial,
  StorageBufferAttribute,
  type WebGPURenderer,
  type Node,
  type NodeBuilder,
} from 'three/webgpu';
import {
  cameraProjectionMatrix,
  code,
  Fn,
  If,
  Discard,
  instanceIndex,
  modelViewMatrix,
  positionLocal,
  storage,
  uniform,
  vec3,
  vec4,
  wgslFn,
} from 'three/tsl';
import {
  createDexelLayout,
  DEXEL_INTERVALS,
  DEXEL_MAX_INTERVALS,
  DEXEL_MEMORY_BYTES,
  GpuDexelIntervalOverflowError,
  indexDexelTiles,
  type DexelLayout,
  type DexelIntervalCapacity,
} from './DexelLayout';
import {
  GPU_SWEEP_STRIDE,
  GPU_SWEEP_WGSL,
  GPU_SWEEP_RAY_WGSL,
  type CompiledGpuSweep,
  usesAnalyticalFlatRayCuts,
  usesAnalyticalProfileRayCuts,
} from './GpuSweepCompiler';
import { SimulationCapabilityError } from '../../shared/SimulationTypes';
import { recordGpuDiagnostic } from './GpuDiagnostics';
import { GpuDexelHistory } from './GpuDexelHistory';
import { GpuDexelTileArena } from './GpuDexelTileArena';
import { ROTATIONAL_BASE_WGSL, type RotationalDexelBase } from './RotationalDexelBase';

export const DEXEL_DISPATCH_RAYS = 16384;
export const DEXEL_PASS_SWEEPS = 256;

export function dexelHistorySubmission(capacity: number, tileSweeps: number, rays: number) {
  // One analytical sweep can emit four removal intervals on every ray.
  const sweeps = Math.max(1, Math.min(DEXEL_PASS_SWEEPS, tileSweeps, Math.floor(capacity / 4)));
  return { sweeps, rays: Math.max(1, Math.min(rays, Math.floor(capacity / (sweeps * 4)))) };
}

export function dexelDispatchRays(tileRanges: Uint32Array): number {
  let maxTileSweeps = 1;
  for (let i = 1; i < tileRanges.length; i += 2)
    maxTileSweeps = Math.max(maxTileSweeps, Math.min(DEXEL_PASS_SWEEPS, tileRanges[i]));
  return Math.max(64, Math.min(DEXEL_DISPATCH_RAYS, Math.floor(65536 / maxTileSweeps / 64) * 64));
}

export function dexelDispatchRanges(ranges: Uint32Array, entryOffset: number): [number, number][] {
  const result: [number, number][] = [];
  for (let tile = 0; tile < ranges.length / 2; tile++) {
    if (ranges[tile * 2 + 1] <= entryOffset) continue;
    const last = result.at(-1);
    if (last && last[0] + last[1] === tile * 1024) last[1] += 1024;
    else result.push([tile * 1024, 1024]);
  }
  return result;
}

export const DEXEL_MATCAP_WGSL = `
fn gpuStockMatcap(normal: vec3f, viewDirection: vec3f) -> vec3f {
  let view = normalize(viewDirection);
  var right = vec3f(view.z, 0.0, -view.x);
  if (dot(right, right) < 1e-10) { right = vec3f(1.0, 0.0, 0.0); }
  right = normalize(right);
  let up = cross(view, right);
  let uv = vec2f(dot(right, normal), dot(up, normal));
  // A procedural lit-sphere map: broad studio highlights, no shadow passes.
  let highlight = exp(-3.0 * dot(uv - vec2f(-0.35, 0.4), uv - vec2f(-0.35, 0.4)));
  let fill = exp(-2.0 * dot(uv - vec2f(0.55, 0.0), uv - vec2f(0.55, 0.0)));
  let brightness = 0.46 + 0.10 * uv.y + 0.25 * highlight + 0.10 * fill;
  return vec3f(0.93, 0.94, 0.96) * brightness;
}
`;

type DexelDevice = Pick<
  GPUDevice,
  'lost' | 'pushErrorScope' | 'popErrorScope' | 'createShaderModule'
> & { readonly queue: Pick<GPUQueue, 'onSubmittedWorkDone'> };

function lostDeviceError(info: GPUDeviceLostInfo): SimulationCapabilityError {
  return new SimulationCapabilityError(`WebGPU device lost: ${info.message || info.reason}`);
}

// Fixed scratch arrays let all storage capacities share the same shader program.
const DEXEL_HELPERS = `
fn gpuRayCount(dims: vec3f) -> u32 {
  let tiles = vec3u(ceil(dims / 32.0));
  return (tiles.x * tiles.y + tiles.x * tiles.z + tiles.y * tiles.z) * 1024u;
}
fn gpuRayInfo(id: u32, size: vec3f, dims: vec3f) -> vec4f {
  let tx = u32(ceil(dims.x / 32.0)); let ty = u32(ceil(dims.y / 32.0)); let tz = u32(ceil(dims.z / 32.0));
  let xCount = ty * tz * 1024u; let yCount = tx * tz * 1024u;
  var axis = 0u; var localId = id; var tilesU = ty; var u = 1u; var v = 2u;
  if (id >= xCount + yCount) { axis = 2u; localId -= xCount + yCount; tilesU = tx; u = 0u; v = 1u; }
  else if (id >= xCount) { axis = 1u; localId -= xCount; tilesU = tx; u = 0u; v = 2u; }
  let tile = localId / 1024u; let localRay = localId % 1024u;
  let a = (tile % tilesU) * 32u + localRay % 32u;
  let b = (tile / tilesU) * 32u + localRay / 32u;
  var p = -size * 0.5;
  p[u] += (f32(a) + 0.5) * size[u] / dims[u];
  p[v] += (f32(b) + 0.5) * size[v] / dims[v];
  return vec4f(p, f32(axis));
}
fn gpuRayIndex(p: vec3f, axis: u32, size: vec3f, dims: vec3f) -> u32 {
  let tx = u32(ceil(dims.x / 32.0)); let ty = u32(ceil(dims.y / 32.0)); let tz = u32(ceil(dims.z / 32.0));
  var u = 1u; var v = 2u; var base = 0u; var tilesU = ty;
  if (axis == 1u) { u = 0u; v = 2u; base = ty * tz * 1024u; tilesU = tx; }
  if (axis == 2u) { u = 0u; v = 1u; base = (ty * tz + tx * tz) * 1024u; tilesU = tx; }
  let c = clamp(vec3u(floor((p + size * 0.5) / size * dims)), vec3u(0u), vec3u(dims) - vec3u(1u));
  let tile = c[u] / 32u + tilesU * (c[v] / 32u);
  return base + tile * 1024u + c[u] % 32u + 32u * (c[v] % 32u);
}
fn gpuCylinderSpan(id: u32, size: vec3f, dims: vec3f, cylinder: u32) -> vec2f {
  let info = gpuRayInfo(id, size, dims); let axis = u32(info.w);
  if (any(info.xyz > size * 0.5)) { return vec2f(0.0); }
  if (cylinder == 0u) { return vec2f(-size[axis] * 0.5, size[axis] * 0.5); }
  let radius = size.x * 0.5;
  if (axis == 2u) {
    if (dot(info.xy, info.xy) >= radius * radius) { return vec2f(0.0); }
    return vec2f(-size.z * 0.5, size.z * 0.5);
  }
  let square = radius * radius - info[1u - axis] * info[1u - axis];
  if (square <= 0.0) { return vec2f(0.0); }
  return vec2f(-sqrt(square), sqrt(square));
}
${ROTATIONAL_BASE_WGSL}
fn gpuCutIntervals(cut: vec2f, segments: ptr<function, array<vec2f, ${DEXEL_MAX_INTERVALS}>>, count: u32, capacity: u32) -> u32 {
  if (cut.x == cut.y) { return count; }
  var result: array<vec2f, ${DEXEL_MAX_INTERVALS}>; var n = 0u;
  for (var i = 0u; i < count; i++) {
    let old = (*segments)[i];
    if (cut.y <= old.x || cut.x >= old.y) { if (n >= capacity) { return 99u; } result[n] = old; n++; }
    else {
      if (old.x < cut.x) { if (n >= capacity) { return 99u; } result[n] = vec2f(old.x, cut.x); n++; }
      if (old.y > cut.y) { if (n >= capacity) { return 99u; } result[n] = vec2f(cut.y, old.y); n++; }
    }
  }
  *segments = result; return n;
}
`;

const DEXEL_COMPUTE = `
fn gpuBuildDexels(id: u32, rayEnd: u32, prefix: u32, entryOffset: u32, passSweeps: u32, capacity: u32, resume: u32, recordHistory: u32, size: vec3f, dims: vec3f, cylinder: u32) -> void {
  if (id >= rayEnd || id >= gpuRayCount(dims)) { return; }
  let slot = dexelTileSweeps.value[id / 1024u];
  if (slot == 0xffffffffu) { return; }
  let storageRay = slot * 1024u + id % 1024u;
  if (entryOffset == 0u && resume == 0u) { dexelCounts.value[storageRay] = 0u; }
  let info = gpuRayInfo(id, size, dims); let axis = u32(info.w); var origin = info.xyz;
  if (any(origin > size * 0.5)) { return; }
  var direction = vec3f(0.0); direction[axis] = 1.0;
  var lo = -size[axis] * 0.5; var hi = size[axis] * 0.5;
  if (cylinder == 1u) {
    let radius = size.x * 0.5;
    if (axis == 2u) { if (dot(origin.xy, origin.xy) >= radius * radius) { return; } }
    else {
      let other = origin[1u - axis]; let square = radius * radius - other * other;
      if (square <= 0.0) { return; } lo = -sqrt(square); hi = -lo;
    }
  }
  origin[axis] = 0.0;
  var segments: array<vec2f, ${DEXEL_MAX_INTERVALS}>;
  var count = 0u;
  if (entryOffset > 0u || resume != 0u) {
    count = dexelCounts.value[storageRay];
    for (var i = 0u; i < count; i++) { segments[i] = dexelIntervals.value[storageRay * capacity + i]; }
  } else {
    count = gpuOriginalIntervals(id, size, dims, cylinder, &segments);
    if (count > capacity) { atomicOr(&dexelErrors.value[0], 1u); return; }
  }
  let epsilon = max(0.0000001, min(size.x / dims.x, min(size.y / dims.y, size.z / dims.z)) * 0.0005);
  let range = dexelTileRanges.value[id / 1024u];
  let entryEnd = min(range.y, entryOffset + passSweeps);
  for (var entry = entryOffset; entry < entryEnd; entry++) {
    let sweep = dexelTileSweeps.value[range.x + entry]; if (sweep >= prefix || count == 0u) { break; }
    let minimum = dexelBounds.value[sweep * 2u].xyz; let maximum = dexelBounds.value[sweep * 2u + 1u].xyz;
    var overlaps = true;
    for (var a = 0u; a < 3u; a++) { if (a != axis && (origin[a] < minimum[a] || origin[a] > maximum[a])) { overlaps = false; } }
    if (!overlaps) { continue; }
    let end = min(hi, maximum[axis] + epsilon); var t = max(lo, minimum[axis] - epsilon);
    if (t >= end) { continue; }
    var touchesMaterial = false;
    for (var i = 0u; i < count; i++) {
      if (t < segments[i].y && end > segments[i].x) { touchesMaterial = true; break; }
    }
    if (!touchesMaterial) { continue; }
    var cuts: array<vec2f, 4>;
    let cutCount = gpuSweepRayCuts(origin, direction, vec2f(t, end), sweep, &cuts);
    if (cutCount > 4u) { atomicOr(&dexelErrors.value[0], 2u); return; }
    for (var cut = 0u; cut < cutCount; cut++) {
      if (recordHistory != 0u && atomicLoad(&dexelErrors.value[3]) == 0u && cuts[cut].x < cuts[cut].y) {
        var changes = false;
        for (var i = 0u; i < count; i++) {
          if (cuts[cut].x < segments[i].y && cuts[cut].y > segments[i].x) { changes = true; break; }
        }
        if (changes) {
          let event = atomicAdd(&dexelErrors.value[2], 1u);
          if (event < arrayLength(&dexelHistory.value)) {
            dexelHistory.value[event] = vec4u(id, sweep * 4u + cut, bitcast<u32>(cuts[cut].x), bitcast<u32>(cuts[cut].y));
          } else { atomicOr(&dexelErrors.value[3], 1u); }
        }
      }
      count = gpuCutIntervals(cuts[cut], &segments, count, capacity);
      if (count > capacity) { atomicOr(&dexelErrors.value[0], 1u); return; }
    }
  }
  dexelCounts.value[storageRay] = count;
  if (slot != 0xffffffffu) {
    let storageRay = slot * 1024u + id % 1024u;
    for (var i = 0u; i < count; i++) { dexelIntervals.value[storageRay * capacity + i] = segments[i]; }
  }
}
`;

const DEXEL_RESTORE = `
fn gpuRestoreHistory(id: u32, capacity: u32, resume: u32, after: u32, through: u32, size: vec3f, dims: vec3f, cylinder: u32) -> void {
  if (id >= gpuRayCount(dims)) { return; }
  let slot = restoreTiles.value[id / 1024u];
  if (slot == 0xffffffffu) { return; }
  var segments: array<vec2f, ${DEXEL_MAX_INTERVALS}>;
  var count = gpuOriginalIntervals(id, size, dims, cylinder, &segments);
  if (count > capacity) { atomicOr(&restoreErrors.value[0], 1u); return; }
  let storageRay = slot * 1024u + id % 1024u;
  if (resume != 0u) {
    count = restoreCounts.value[storageRay];
    for (var i = 0u; i < count; i++) { segments[i] = restoreIntervals.value[storageRay * capacity + i]; }
  }
  if (slot != 0xffffffffu) {
    let historySlot = restoreRanges.value[id / 1024u].x;
    var range = vec2u(0u);
    if (historySlot != 0xffffffffu) { range = restoreRanges.value[historySlot + id % 1024u]; }
    var first = 0u; var last = range.y;
    loop {
      if (first >= last) { break; }
      let middle = first + (last - first) / 2u;
      if (restoreEvents.value[range.x + middle].y <= after) { first = middle + 1u; }
      else { last = middle; }
    }
    for (var i = first; i < range.y; i++) {
      let event = restoreEvents.value[range.x + i];
      if (event.y > through) { break; }
      if (event.y <= after) { continue; }
      count = gpuCutIntervals(vec2f(bitcast<f32>(event.z), bitcast<f32>(event.w)), &segments, count, capacity);
      if (count > capacity) { atomicOr(&restoreErrors.value[0], 1u); return; }
      if (count == 0u) { break; }
    }
    for (var i = 0u; i < count; i++) { restoreIntervals.value[storageRay * capacity + i] = segments[i]; }
  }
  restoreCounts.value[storageRay] = count;
}
`;

const DEXEL_COPY = `
fn gpuCopyDexels(id: u32, sourceCapacity: u32, targetCapacity: u32, trimBase: u32, size: vec3f, dims: vec3f, cylinder: u32) -> void {
  if (id >= gpuRayCount(dims)) { return; }
  let targetSlot = copyTargetTiles.value[id / 1024u];
  if (targetSlot == 0xffffffffu) { return; }
  let sourceSlot = copySourceTiles.value[id / 1024u];
  var count = 0u;
  var original: array<vec2f, 64>;
  if (sourceSlot != 0xffffffffu) {
    count = copySourceCounts.value[sourceSlot * 1024u + id % 1024u];
  } else {
    count = gpuOriginalIntervals(id, size, dims, cylinder, &original);
    if (count > targetCapacity) { atomicOr(&copyErrors.value[0], 1u); return; }
  }
  if (trimBase != 0u && sourceSlot != 0xffffffffu) {
    let originalCount = gpuOriginalIntervals(id, size, dims, cylinder, &original);
    var result: array<vec2f, 64>; var n = 0u; var a = 0u; var b = 0u;
    loop {
      if (a >= count || b >= originalCount) { break; }
      let old = copySourceIntervals.value[(sourceSlot * 1024u + id % 1024u) * sourceCapacity + a];
      let base = original[b];
      let span = vec2f(max(old.x, base.x), min(old.y, base.y));
      if (span.x < span.y) {
        if (n >= targetCapacity) { atomicOr(&copyErrors.value[0], 1u); return; }
        result[n] = span; n++;
      }
      if (old.y <= base.y) { a++; } else { b++; }
    }
    for (var i = 0u; i < n; i++) {
      copyTargetIntervals.value[(targetSlot * 1024u + id % 1024u) * targetCapacity + i] = result[i];
    }
    copyTargetCounts.value[targetSlot * 1024u + id % 1024u] = n;
    return;
  }
  copyTargetCounts.value[targetSlot * 1024u + id % 1024u] = count;
  for (var i = 0u; i < count; i++) {
    var span = original[i];
    if (sourceSlot != 0xffffffffu) {
      span = copySourceIntervals.value[(sourceSlot * 1024u + id % 1024u) * sourceCapacity + i];
    }
    copyTargetIntervals.value[(targetSlot * 1024u + id % 1024u) * targetCapacity + i] = span;
  }
}
`;

// A shared arena must be bound only once for writes: overlapping read/write
// storage bindings of the same buffer are invalid in a WebGPU dispatch.
const DEXEL_SHARED_COPY = DEXEL_COPY.replace(/copySourceIntervals/g, 'copyTargetIntervals').replace(
  /copySourceCounts/g,
  'copyTargetCounts',
);

const DEXEL_DISPLAY_HELPERS = `
fn gpuDexelIntervals(ray: u32, size: vec3f, dims: vec3f, capacity: u32, cylinder: u32,
  segments: ptr<function, array<vec2f, 64>>) -> u32 {
  let slot = dexelTileSweeps.value[ray / 1024u];
  if (slot == 0xffffffffu) {
    return gpuOriginalIntervals(ray, size, dims, cylinder, segments);
  }
  let base = slot * 1024u + ray % 1024u;
  let count = dexelCounts.value[base];
  for (var i = 0u; i < count; i++) {
    (*segments)[i] = dexelIntervals.value[base * capacity + i];
  }
  return count;
}
fn gpuDexelNearestAxis(p: vec3f, axis: u32, size: vec3f, dims: vec3f, capacity: u32, cylinder: u32) -> vec4f {
  let ray = gpuRayIndex(clamp(p, -size * 0.5, size * 0.5), axis, size, dims);
  var result = vec4f(0.0, 0.0, 0.0, 1e20);
  var spans: array<vec2f, 64>;
  let count = gpuDexelIntervals(ray, size, dims, capacity, cylinder, &spans);
  for (var i = 0u; i < count; i++) {
    let span = spans[i];
    let lower = span.x - p[axis]; let upper = p[axis] - span.y;
    let field = max(lower, upper);
    if (field < result.w) {
      result = vec4f(0.0, 0.0, 0.0, field);
      result[axis] = select(1.0, -1.0, lower >= upper);
    }
  }
  return result;
}
fn gpuDexelMatchEndpoint(ray: u32, reference: f32, entry: bool, limit: f32, capacity: u32, size: vec3f, dims: vec3f, cylinder: u32) -> vec2f {
  var best = vec2f(0.0, 1e20);
  var second = 1e20;
  var spans: array<vec2f, 64>;
  let count = gpuDexelIntervals(ray, size, dims, capacity, cylinder, &spans);
  for (var i = 0u; i < count; i++) {
    let span = spans[i];
    let endpoint = select(span.y, span.x, entry);
    let distance = abs(endpoint - reference);
    if (distance < best.y) { second = best.y; best = vec2f(endpoint, distance); }
    else { second = min(second, distance); }
  }
  if (best.y > limit || second - best.y < 0.000001) { return vec2f(0.0, -1.0); }
  return vec2f(best.x, 1.0);
}
fn gpuDexelAxisSample(p: vec3f, axis: u32, size: vec3f, dims: vec3f, capacity: u32, cylinder: u32) -> vec4f {
  let nearest = gpuDexelNearestAxis(p, axis, size, dims, capacity, cylinder);
  var u = 1u; var v = 2u;
  if (axis == 1u) { u = 0u; }
  if (axis == 2u) { u = 0u; v = 1u; }
  let h = size / dims;
  let cell = clamp((p + size * 0.5) / h - vec3f(0.5), vec3f(0.0), dims - vec3f(1.0));
  let low = floor(cell); let high = min(low + vec3f(1.0), dims - vec3f(1.0));
  let weight = cell - low;
  var point = p;
  point[u] = -size[u] * 0.5 + (low[u] + 0.5) * h[u];
  point[v] = -size[v] * 0.5 + (low[v] + 0.5) * h[v];
  var rays: array<u32, 4>;
  rays[0] = gpuRayIndex(point, axis, size, dims);
  point[u] = -size[u] * 0.5 + (high[u] + 0.5) * h[u];
  rays[1] = gpuRayIndex(point, axis, size, dims);
  point[u] = -size[u] * 0.5 + (low[u] + 0.5) * h[u];
  point[v] = -size[v] * 0.5 + (high[v] + 0.5) * h[v];
  rays[2] = gpuRayIndex(point, axis, size, dims);
  point[u] = -size[u] * 0.5 + (high[u] + 0.5) * h[u];
  rays[3] = gpuRayIndex(point, axis, size, dims);
  if (nearest.w > 1e19) { return nearest; }
  let entry = nearest[axis] < 0.0;
  let reference = p[axis] - nearest[axis] * nearest.w;
  let limit = 4.0 * max(h[u], h[v]);
  let a = gpuDexelMatchEndpoint(rays[0], reference, entry, limit, capacity, size, dims, cylinder);
  let b = gpuDexelMatchEndpoint(rays[1], reference, entry, limit, capacity, size, dims, cylinder);
  let c = gpuDexelMatchEndpoint(rays[2], reference, entry, limit, capacity, size, dims, cylinder);
  let d = gpuDexelMatchEndpoint(rays[3], reference, entry, limit, capacity, size, dims, cylinder);
  if (min(min(a.y, b.y), min(c.y, d.y)) < 0.0) { return nearest; }
  let endpoint = mix(mix(a.x, b.x, weight[u]), mix(c.x, d.x, weight[u]), weight[v]);
  let du = mix(b.x - a.x, d.x - c.x, weight[v]) / h[u];
  let dv = mix(c.x - a.x, d.x - b.x, weight[u]) / h[v];
  var result = vec4f(0.0, 0.0, 0.0, nearest[axis] * (p[axis] - endpoint));
  result[axis] = nearest[axis];
  result[u] = -nearest[axis] * du * select(0.0, 1.0, high[u] > low[u]);
  result[v] = -nearest[axis] * dv * select(0.0, 1.0, high[v] > low[v]);
  return result;
}
fn gpuDexelNormal(p: vec3f, size: vec3f, dims: vec3f, capacity: u32, cylinder: u32) -> vec3f {
  var surface = vec4f(0.0, 0.0, 0.0, -1e20);
  for (var axis = 0u; axis < 3u; axis++) {
    let sample = gpuDexelAxisSample(p, axis, size, dims, capacity, cylinder);
    let magnitude = length(sample.xyz);
    if (magnitude > 0.0 && sample.w < 1e19) {
      let normalized = sample / magnitude;
      if (normalized.w > surface.w) { surface = normalized; }
    }
  }
  if (dot(surface.xyz, surface.xyz) < 1e-15) { return vec3f(0.0, 0.0, 1.0); }
  return normalize(surface.xyz);
}
`;

const DEXEL_TRACE = `
fn gpuTraceDexels(origin: vec3f, surface: vec3f, size: vec3f, dims: vec3f, capacity: u32, cylinder: u32) -> vec4f {
  let direction = normalize(surface - origin);
  var inverse = vec3f(0.0);
  for (var a = 0u; a < 3u; a++) { inverse[a] = 1.0 / select(direction[a], 1e-20, abs(direction[a]) < 1e-20); }
  let near = (-size * 0.5 - origin) * inverse; let far = (size * 0.5 - origin) * inverse;
  let low = min(near, far); let high = max(near, far);
  var t = max(0.0, max(low.x, max(low.y, low.z))); let end = min(high.x, min(high.y, high.z));
  if (t > end) { return vec4f(0.0); }
  let h = size / dims; let epsilon = min(h.x, min(h.y, h.z)) * 0.0001;
  for (var iteration = 0u; iteration < 32768u; iteration++) {
    if (t + epsilon >= end) { return vec4f(0.0); }
    let p = origin + direction * (t + epsilon);
    let clamped = clamp(p, -size * 0.5, size * 0.5);
    let cell = floor((p + size * 0.5) / h);
    let r0 = gpuRayIndex(clamped, 0u, size, dims);
    let r1 = gpuRayIndex(clamped, 1u, size, dims);
    let r2 = gpuRayIndex(clamped, 2u, size, dims);
    let s0 = dexelTileSweeps.value[r0 / 1024u];
    let s1 = dexelTileSweeps.value[r1 / 1024u];
    let s2 = dexelTileSweeps.value[r2 / 1024u];
    var occupied = true; var safeSkip = 0.0;
    if (s0 == 0xffffffffu && s1 == 0xffffffffu && s2 == 0xffffffffu) {
      let header = gpuRayCount(dims) / 1024u;
      let slabs = dexelTileSweeps.value[header];
      var zRayCenter = vec3f(-size.x * 0.5 + (clamp(cell.x, 0.0, dims.x - 1.0) + 0.5) * h.x,
                             -size.y * 0.5 + (clamp(cell.y, 0.0, dims.y - 1.0) + 0.5) * h.y, 0.0);
      let xRayCenter = vec3f(0.0, -size.y * 0.5 + (clamp(cell.y, 0.0, dims.y - 1.0) + 0.5) * h.y,
                             -size.z * 0.5 + (clamp(cell.z, 0.0, dims.z - 1.0) + 0.5) * h.z);
      var spans: array<vec2f, 64>;
      var count = 0u;
      if (slabs == 0u) {
        count = gpuOriginalPointIntervals(2u, zRayCenter, size, dims, cylinder, &spans);
      } else {
        count = gpuOriginalPointIntervals(0u, xRayCenter, size, dims, cylinder, &spans);
      }
      let axis = select(0u, 2u, slabs == 0u);
      var inMaterial = false; var entry = end - t;
      for (var i = 0u; i < count; i++) {
        let span = spans[i];
        if (p[axis] >= span.x && p[axis] <= span.y) { inMaterial = true; }
        if (abs(direction[axis]) >= 1e-15) {
          let next = (select(span.x, span.y, p[axis] < span.x) - p[axis]) / direction[axis] + epsilon;
          if (next > epsilon * 0.5) { entry = min(entry, next); }
        }
      }
      if (!inMaterial) {
        occupied = false;
        for (var transverse = 0u; transverse < 3u; transverse++) {
          if (transverse == axis || abs(direction[transverse]) < 1e-15) { continue; }
          let grid = -size[transverse] * 0.5 + (cell[transverse] + select(0.0, 1.0, direction[transverse] > 0.0)) * h[transverse];
          entry = min(entry, (grid - p[transverse]) / direction[transverse] + epsilon);
        }
        safeSkip = entry;
      } else {
        let testAxis = select(1u, 0u, slabs == 0u);
        var testCenter = vec3f(0.0);
        if (testAxis == 0u) {
          testCenter = vec3f(0.0, -size.y * 0.5 + (clamp(cell.y, 0.0, dims.y - 1.0) + 0.5) * h.y,
                             -size.z * 0.5 + (clamp(cell.z, 0.0, dims.z - 1.0) + 0.5) * h.z);
        } else {
          testCenter = vec3f(-size.x * 0.5 + (clamp(cell.x, 0.0, dims.x - 1.0) + 0.5) * h.x, 0.0,
                             -size.z * 0.5 + (clamp(cell.z, 0.0, dims.z - 1.0) + 0.5) * h.z);
        }
        let testCount = gpuOriginalPointIntervals(testAxis, testCenter, size, dims, cylinder, &spans);
        var inSecond = false; var secondEntry = end - t;
        for (var i = 0u; i < testCount; i++) {
          let span = spans[i];
          if (p[testAxis] >= span.x && p[testAxis] <= span.y) { inSecond = true; }
          if (abs(direction[testAxis]) >= 1e-15) {
            let next = (select(span.x, span.y, p[testAxis] < span.x) - p[testAxis]) / direction[testAxis] + epsilon;
            if (next > epsilon * 0.5) { secondEntry = min(secondEntry, next); }
          }
        }
        if (!inSecond) {
          occupied = false;
          for (var transverse = 0u; transverse < 3u; transverse++) {
            if (transverse == testAxis || abs(direction[transverse]) < 1e-15) { continue; }
            let grid = -size[transverse] * 0.5 + (cell[transverse] + select(0.0, 1.0, direction[transverse] > 0.0)) * h[transverse];
            secondEntry = min(secondEntry, (grid - p[transverse]) / direction[transverse] + epsilon);
          }
          safeSkip = secondEntry;
        }
      }
      if (!occupied) {
        var tileSkip = end - t;
        for (var a = 0u; a < 3u; a++) {
          if (abs(direction[a]) < 1e-15) { continue; }
          let tileCell = floor(clamp(cell[a], 0.0, dims[a] - 1.0) / 32.0) * 32.0;
          let tileBound = -size[a] * 0.5 + (tileCell + select(0.0, 32.0, direction[a] > 0.0)) * h[a];
          tileSkip = min(tileSkip, (tileBound - p[a]) / direction[a] + epsilon);
        }
        if (slabs > 0u) {
          var first = 0u; var last = slabs;
          loop {
            if (first >= last) { break; }
            let mid = first + (last - first) / 2u;
            let upper = bitcast<f32>(dexelTileSweeps.value[header + 2u + mid * 4u]);
            if (upper <= p.z) { first = mid + 1u; } else { last = mid; }
          }
          var maxR = 0.0; var slabBound = select(-size.z * 0.5, size.z * 0.5, direction.z > 0.0);
          if (first < slabs) {
            let table = header + 1u + first * 4u;
            let za = bitcast<f32>(dexelTileSweeps.value[table]);
            let zb = bitcast<f32>(dexelTileSweeps.value[table + 1u]);
            if (p.z < za) {
              slabBound = select(-size.z * 0.5, za, direction.z > 0.0);
            } else {
              slabBound = select(za, zb, direction.z > 0.0);
              let bands = dexelTileSweeps.value[table + 3u];
              for (var b = 0u; b < bands; b++) {
                let index = header + dexelTileSweeps.value[table + 2u] + b * 4u;
                let upper = vec2f(bitcast<f32>(dexelTileSweeps.value[index + 2u]), bitcast<f32>(dexelTileSweeps.value[index + 3u]));
                maxR = max(maxR, max(0.0, max(upper.x * za + upper.y, upper.x * zb + upper.y)));
              }
            }
          } else if (direction.z < 0.0) {
            slabBound = bitcast<f32>(dexelTileSweeps.value[header + 2u + (slabs - 1u) * 4u]);
          }
          let paddedR = maxR + max(h.x, h.y);
          let r2xy = dot(p.xy, p.xy);
          if (r2xy > paddedR * paddedR) {
            var cylSkip = end - t;
            if (abs(direction.z) >= 1e-15) {
              cylSkip = min(cylSkip, (slabBound - p.z) / direction.z + epsilon);
            }
            let a = dot(direction.xy, direction.xy);
            let halfB = dot(p.xy, direction.xy);
            let c = r2xy - paddedR * paddedR;
            if (a > 1e-15 && halfB < 0.0) {
              let disc = halfB * halfB - a * c;
              if (disc >= 0.0) {
                let hit = (-halfB - sqrt(disc)) / a;
                if (hit > 0.0) { cylSkip = min(cylSkip, hit); }
              }
            }
            safeSkip = max(safeSkip, min(tileSkip, cylSkip));
          }
        } else if (cylinder != 0u) {
          let paddedR = size.x * 0.5 + max(h.x, h.y);
          let r2xy = dot(p.xy, p.xy);
          if (r2xy > paddedR * paddedR) {
            var cylSkip = end - t;
            let a = dot(direction.xy, direction.xy);
            let halfB = dot(p.xy, direction.xy);
            let c = r2xy - paddedR * paddedR;
            if (a > 1e-15 && halfB < 0.0) {
              let disc = halfB * halfB - a * c;
              if (disc >= 0.0) {
                let hit = (-halfB - sqrt(disc)) / a;
                if (hit > 0.0) { cylSkip = min(cylSkip, hit); }
              }
            }
            safeSkip = max(safeSkip, min(tileSkip, cylSkip));
          }
        } else {
          safeSkip = max(safeSkip, tileSkip);
        }
        t += max(safeSkip, epsilon);
        continue;
      }
    }
    for (var axis = 0u; axis < 3u; axis++) {
      let ray = select(select(r0, r1, axis == 1u), r2, axis == 2u);
      var inMaterial = false; var entry = end - t;
      var spans: array<vec2f, 64>;
      let count = gpuDexelIntervals(ray, size, dims, capacity, cylinder, &spans);
      for (var i = 0u; i < count; i++) {
        let span = spans[i];
        if (p[axis] >= span.x && p[axis] <= span.y) { inMaterial = true; }
        if (abs(direction[axis]) >= 1e-15) {
          let next = (select(span.x, span.y, p[axis] < span.x) - p[axis]) / direction[axis] + epsilon;
          if (next > epsilon * 0.5) { entry = min(entry, next); }
        }
      }
      if (!inMaterial) {
        occupied = false;
        // This ray proves empty material until its next interval or transverse column boundary.
        for (var transverse = 0u; transverse < 3u; transverse++) {
          if (transverse == axis || abs(direction[transverse]) < 1e-15) { continue; }
          let grid = -size[transverse] * 0.5 + (cell[transverse] + select(0.0, 1.0, direction[transverse] > 0.0)) * h[transverse];
          entry = min(entry, (grid - p[transverse]) / direction[transverse] + epsilon);
        }
        safeSkip = max(safeSkip, entry);
      }
    }
    if (occupied) { return vec4f(p, 1.0); }
    t += max(safeSkip, epsilon);
  }
  return vec4f(origin + direction * min(t, end), -1.0);
}
`;

export class GpuDexelStock {
  readonly group = new THREE.Group();
  readonly layout: DexelLayout;
  estimatedBytes: number;
  readonly analyticalFlatSweeps: number;
  readonly analyticalProfileSweeps: number;
  readonly intervalAttribute: StorageBufferAttribute;
  readonly countAttribute: StorageBufferAttribute;
  readonly tileArena: GpuDexelTileArena;
  private sharedSource?: GpuDexelStock;
  private readonly identity = {};
  private readonly sharingSourceIdentity?: object;
  private readonly privateTiles: Uint32Array;
  private readonly attributes: StorageBufferAttribute[];
  private readonly prefix = uniform(0, 'uint').setName('dexelPrefix');
  private readonly rayOffset = uniform(0, 'uint').setName('dexelRayOffset');
  private readonly entryOffset = uniform(0, 'uint').setName('dexelEntryOffset');
  private readonly passSweeps = uniform(DEXEL_PASS_SWEEPS, 'uint').setName('dexelPassSweeps');
  private readonly rayEnd = uniform(0, 'uint').setName('dexelRayEnd');
  private readonly resume = uniform(0, 'uint').setName('dexelResume');
  private readonly errorAttribute = new StorageBufferAttribute(new Uint32Array(4), 1);
  private readonly computeNode;
  private readonly mesh: THREE.Mesh<THREE.BoxGeometry, MeshBasicNodeMaterial>;
  private disposed = false;
  private active = 0;
  private slotsReleased = false;
  private calculated = false;
  private computeShader?: string;
  private readonly dispatchRays: number;
  private readonly maxTileSweeps: number;
  private readonly tileRanges: Uint32Array;
  private readonly tileIndices: StorageBufferAttribute;
  readonly tileSlots: Uint32Array;
  readonly timings = {
    copyMs: 0,
    computeMs: 0,
    submissions: 0,
    submittedRays: 0,
    copiedTiles: 0,
    sharedTiles: 0,
  };
  private readonly captureAttribute: StorageBufferAttribute;
  private readonly recordHistory = uniform(0, 'uint').setName('dexelRecordHistory');
  private sweeps: readonly CompiledGpuSweep[];
  private readonly historyLimit: number;
  private sealed = false;
  history?: GpuDexelHistory;
  historyUnavailable?: string;
  readonly historyKey: string;
  readonly rotationalBase?: RotationalDexelBase;
  private readonly copyKey: string;
  private readonly baseTransitionSource?: object;

  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly device: DexelDevice,
    size: THREE.Vector3,
    pitchMm: number,
    private readonly cylinder: boolean,
    sweeps: readonly CompiledGpuSweep[],
    stockToWorkpiece: THREE.Matrix4,
    intervalCapacity: DexelIntervalCapacity = DEXEL_INTERVALS,
    sparse?: {
      retainedTiles?: Uint32Array;
      historyEvents?: number;
      historyLimit?: number;
      source?: GpuDexelStock;
      changedTiles?: Uint32Array;
      arenaTiles?: number;
      arena?: GpuDexelTileArena;
      rotationalBase?: RotationalDexelBase;
      updateBase?: boolean;
    },
  ) {
    this.rotationalBase = sparse?.rotationalBase;
    if ((this.rotationalBase?.maxIntervals ?? 0) > intervalCapacity)
      throw new GpuDexelIntervalOverflowError(intervalCapacity);
    this.copyKey = JSON.stringify([size.toArray(), pitchMm, cylinder, stockToWorkpiece.elements]);
    this.historyKey = JSON.stringify([this.copyKey, this.rotationalBase?.fingerprint ?? null]);
    if (sparse?.updateBase) {
      if (!sparse.source?.rotationalBase || !this.rotationalBase)
        throw new SimulationCapabilityError(
          'An implicit base update requires both source and target bases',
        );
      this.baseTransitionSource = sparse.source.identity;
    }
    this.sweeps = sweeps;
    const historyEvents = sparse?.historyEvents ?? 0;
    this.historyLimit = sparse?.historyLimit ?? historyEvents;
    if (!Number.isSafeInteger(historyEvents) || historyEvents < 0 || historyEvents > 1048576)
      throw new SimulationCapabilityError('Invalid GPU history capacity');
    if (
      !Number.isSafeInteger(this.historyLimit) ||
      this.historyLimit < historyEvents ||
      this.historyLimit > 4194304
    )
      throw new SimulationCapabilityError('Invalid GPU history retention limit');
    this.recordHistory.value = historyEvents ? 1 : 0;
    this.captureAttribute = new StorageBufferAttribute(
      new Uint32Array(Math.max(1, historyEvents) * 4),
      4,
    );
    this.layout = createDexelLayout(
      size,
      pitchMm,
      intervalCapacity,
      sparse
        ? { bounds: sweeps.map((sweep) => sweep.bounds), retainedTiles: sparse.retainedTiles }
        : undefined,
    );
    this.analyticalFlatSweeps = sweeps.filter(usesAnalyticalFlatRayCuts).length;
    this.analyticalProfileSweeps = sweeps.filter(usesAnalyticalProfileRayCuts).length;
    const index = indexDexelTiles(this.layout, sweeps);
    this.tileRanges = index.ranges;
    this.tileSlots = new Uint32Array(this.layout.tiles).fill(0xffffffff);
    const source = sparse?.source;
    const changed = new Set(sparse?.changedTiles ?? this.layout.storedTiles);
    if (this.baseTransitionSource) for (const tile of source!.layout.storedTiles) changed.add(tile);
    const canShare =
      source?.sealed &&
      !source.disposed &&
      source.renderer === renderer &&
      source.device === device &&
      source.copyKey === this.copyKey &&
      (source.historyKey === this.historyKey || this.baseTransitionSource === source.identity) &&
      source.layout.intervalCapacity === intervalCapacity &&
      source.layout.storedTiles.every((tile) => this.layout.storedTiles.includes(tile));
    const privateTiles = this.layout.storedTiles.filter(
      (tile) =>
        !canShare ||
        changed.has(tile) ||
        source!.tileSlots[tile] === 0xffffffff ||
        !!this.baseTransitionSource,
    );
    this.sharedSource =
      canShare && source!.tileArena.available >= privateTiles.length ? source : undefined;
    this.sharingSourceIdentity = this.sharedSource?.identity;
    this.privateTiles = this.sharedSource ? privateTiles : this.layout.storedTiles;
    this.tileArena =
      this.sharedSource?.tileArena ??
      (sparse?.arena?.capacity === intervalCapacity &&
      sparse.arena.available >= this.privateTiles.length
        ? sparse.arena
        : undefined) ??
      new GpuDexelTileArena(
        Math.max(this.layout.storedTiles.length, sparse?.arenaTiles ?? 0),
        intervalCapacity,
      );
    const privateSet = new Set(this.privateTiles);
    this.tileArena.acquire();
    this.layout.storedTiles.forEach((tile) => {
      this.tileSlots[tile] =
        this.sharedSource && !privateSet.has(tile)
          ? this.tileArena.retain(this.sharedSource.tileSlots[tile])
          : this.tileArena.allocate();
    });
    const baseWords = this.rotationalBase?.words ?? new Uint32Array(1);
    const mappedIndices = new Uint32Array(
      this.layout.tiles + baseWords.length + index.sweeps.length,
    );
    mappedIndices.set(this.tileSlots);
    mappedIndices.set(baseWords, this.layout.tiles);
    mappedIndices.set(index.sweeps, this.layout.tiles + baseWords.length);
    for (let i = 0; i < index.ranges.length; i += 2)
      index.ranges[i] += this.layout.tiles + baseWords.length;
    this.maxTileSweeps = index.ranges.reduce(
      (maximum, value, i) => (i % 2 === 1 ? Math.max(maximum, value) : maximum),
      0,
    );
    // Ray count alone does not bound work: each ray evaluates its tile's cutter list.
    this.dispatchRays = dexelDispatchRays(index.ranges);
    const recordData = new Float32Array(Math.max(4, sweeps.length * GPU_SWEEP_STRIDE));
    const boundData = new Float32Array(Math.max(8, sweeps.length * 8));
    sweeps.forEach((sweep, i) => {
      recordData.set(sweep.data, i * GPU_SWEEP_STRIDE);
      boundData.set([...sweep.bounds.min.toArray(), 0, ...sweep.bounds.max.toArray(), 0], i * 8);
    });
    this.estimatedBytes =
      this.layout.estimatedBytes +
      this.tileArena.estimatedBytes -
      2 * (this.layout.intervalBytes + Math.max(1, this.layout.storageRays) * 4) +
      index.bytes +
      this.layout.tiles * 12 +
      this.captureAttribute.array.byteLength * 2 +
      2 * (recordData.byteLength + boundData.byteLength) +
      sweeps.reduce((sum, sweep) => sum + sweep.data.byteLength + 256, 0);
    this.estimatedBytes += (this.rotationalBase?.estimatedBytes ?? 0) + baseWords.byteLength * 2;
    if (this.estimatedBytes > DEXEL_MEMORY_BYTES) {
      this.tileArena.release(this.layout.storedTiles.map((tile) => this.tileSlots[tile]));
      throw new SimulationCapabilityError(
        'GPU stock and cutter data exceed the combined CPU/GPU memory estimate',
      );
    }
    this.intervalAttribute = this.tileArena.intervals;
    this.countAttribute = this.tileArena.counts;
    const records = new StorageBufferAttribute(recordData, 4),
      bounds = new StorageBufferAttribute(boundData, 4);
    const ranges = new StorageBufferAttribute(index.ranges, 2),
      indices = new StorageBufferAttribute(mappedIndices, 1);
    this.tileIndices = indices;
    this.attributes = [
      this.intervalAttribute,
      this.countAttribute,
      records,
      bounds,
      ranges,
      indices,
      this.errorAttribute,
      this.captureAttribute,
    ];
    // Stable binding names allow shader reuse instead of recompiling per stock state.
    const sizeNode = uniform(size).setName('dexelSize'),
      dimensionsNode = uniform(this.layout.dimensions).setName('dexelDimensions');
    const capacityNode = uniform(intervalCapacity, 'uint').setName('dexelCapacity');
    const intervals = storage(
      this.intervalAttribute,
      'vec2',
      this.intervalAttribute.array.length / 2,
    ).setName('dexelIntervals');
    const counts = storage(this.countAttribute, 'uint', this.countAttribute.array.length).setName(
      'dexelCounts',
    );
    // Global bindings avoid optional WGSL storage-pointer function parameters.
    const computeBindings = [
      storage(records, 'vec4', recordData.length / 4)
        .setName('dexelRecords')
        .toReadOnly(),
      storage(bounds, 'vec4', boundData.length / 4)
        .setName('dexelBounds')
        .toReadOnly(),
      storage(ranges, 'uvec2', this.layout.tiles).setName('dexelTileRanges').toReadOnly(),
      storage(indices, 'uint', mappedIndices.length).setName('dexelTileSweeps').toReadOnly(),
      intervals,
      counts,
      storage(this.errorAttribute, 'uint', 4).setName('dexelErrors').toAtomic(),
      storage(this.captureAttribute, 'uvec4', this.captureAttribute.array.length / 4).setName(
        'dexelHistory',
      ),
    ];
    const helpers = code(DEXEL_HELPERS, [computeBindings[3]], 'wgsl'),
      sweepCode = code(`${GPU_SWEEP_WGSL}\n${GPU_SWEEP_RAY_WGSL}`, computeBindings, 'wgsl');
    const build = wgslFn(DEXEL_COMPUTE, [helpers, sweepCode]);
    const cylinderNode = uniform(cylinder ? 1 : 0, 'uint').setName('dexelCylinder');
    this.computeNode = build({
      id: instanceIndex.add(this.rayOffset),
      rayEnd: this.rayEnd,
      prefix: this.prefix,
      entryOffset: this.entryOffset,
      passSweeps: this.passSweeps,
      resume: this.resume,
      recordHistory: this.recordHistory,
      capacity: capacityNode,
      size: sizeNode,
      dims: dimensionsNode,
      cylinder: cylinderNode,
    }).compute(this.layout.rays, [64]);
    const material = new MeshBasicNodeMaterial({ side: THREE.BackSide });
    const camera = uniform(new THREE.Vector3()).setName('dexelCamera');
    const readIntervals = storage(
      this.intervalAttribute,
      'vec2',
      this.intervalAttribute.array.length / 2,
    )
      .setName('dexelIntervals')
      .toReadOnly();
    const readCounts = storage(this.countAttribute, 'uint', this.countAttribute.array.length)
      .setName('dexelCounts')
      .toReadOnly();
    const readTiles = storage(indices, 'uint', mappedIndices.length)
      .setName('dexelTileSweeps')
      .toReadOnly();
    const displayHelpers = code(
      DEXEL_DISPLAY_HELPERS,
      [readIntervals, readCounts, readTiles],
      'wgsl',
    );
    const renderHelpers = code(DEXEL_HELPERS, [readTiles], 'wgsl');
    const trace = wgslFn(DEXEL_TRACE, [renderHelpers, displayHelpers]);
    const hit = (
      trace({
        origin: camera,
        surface: positionLocal,
        size: sizeNode,
        dims: dimensionsNode,
        capacity: capacityNode,
        cylinder: cylinderNode,
      }) as Node<'vec4'>
    ).toVar('dexelHit');
    const normal = wgslFn(
      'fn gpuStockNormal(p: vec3f, size: vec3f, dims: vec3f, capacity: u32, cylinder: u32) -> vec3f { return gpuDexelNormal(p, size, dims, capacity, cylinder); }',
      [renderHelpers, displayHelpers],
    );
    const matcap = wgslFn(DEXEL_MATCAP_WGSL);
    material.fragmentNode = Fn(() => {
      If(hit.w.equal(0), () => {
        Discard();
      });
      const surfaceNormal = normal({
        p: hit.xyz,
        size: sizeNode,
        dims: dimensionsNode,
        capacity: capacityNode,
        cylinder: cylinderNode,
      }) as Node<'vec3'>;
      const shaded = matcap({
        normal: modelViewMatrix.mul(vec4(surfaceNormal, 0)).xyz.normalize(),
        viewDirection: modelViewMatrix.mul(vec4(hit.xyz, 1)).xyz.negate(),
      }) as Node<'vec3'>;
      return vec4(hit.w.lessThan(0).select(vec3(1, 0, 1), shaded), 1);
    })();
    const clip = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(hit.xyz, 1)));
    material.depthNode = clip.z.div(clip.w);
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
    this.mesh.onBeforeRender = (_renderer, _scene, viewCamera) => {
      camera.value.copy(viewCamera.getWorldPosition(new THREE.Vector3()));
      this.mesh.worldToLocal(camera.value);
    };
    this.group.name = 'gpu-dexel-stock';
    this.group.matrixAutoUpdate = false;
    this.group.matrix.copy(stockToWorkpiece);
    this.group.add(this.mesh);
  }

  async copyFrom(source: GpuDexelStock, cancelled: () => boolean = () => false): Promise<number> {
    if (this.sealed) throw new SimulationCapabilityError('Published GPU stock is immutable');
    if (this.active) throw new SimulationCapabilityError('GPU stock is already in use');
    if (this.disposed || source.disposed || cancelled())
      throw new DOMException('GPU stock copy cancelled', 'AbortError');
    if (
      source === this ||
      !source.calculated ||
      source.renderer !== this.renderer ||
      source.device !== this.device ||
      (source.historyKey !== this.historyKey &&
        (source.copyKey !== this.copyKey || this.baseTransitionSource !== source.identity)) ||
      source.cylinder !== this.cylinder ||
      !source.group.matrix.equals(this.group.matrix) ||
      !source.layout.size.equals(this.layout.size) ||
      !source.layout.dimensions.equals(this.layout.dimensions) ||
      source.layout.pitchMm !== this.layout.pitchMm ||
      source.layout.intervalCapacity > this.layout.intervalCapacity ||
      source.layout.storedTiles.some((tile) => this.tileSlots[tile] === 0xffffffff)
    )
      throw new SimulationCapabilityError(
        'GPU stock copy requires a completed compatible stock at the same pitch and sufficient interval capacity',
      );
    if (this.sharingSourceIdentity && this.sharingSourceIdentity !== source.identity)
      throw new SimulationCapabilityError('Shared GPU stock must copy its original source');
    const shared = this.tileArena === source.tileArena;
    const copyRanges = shared ? this.storageRanges(this.privateTiles, false) : this.storageRanges();
    this.timings.copiedTiles = shared ? this.privateTiles.length : this.layout.storedTiles.length;
    this.timings.sharedTiles = this.layout.storedTiles.length - this.timings.copiedTiles;
    this.assertWritable(copyRanges);
    this.active++;
    source.active++;
    this.calculated = false;
    this.resume.value = 0;
    this.errorAttribute.array.fill(0);
    this.errorAttribute.needsUpdate = true;
    const bindings = code(
      '',
      [
        ...(shared
          ? []
          : [
              storage(source.intervalAttribute, 'vec2', source.intervalAttribute.array.length / 2)
                .setName('copySourceIntervals')
                .toReadOnly(),
              storage(source.countAttribute, 'uint', source.countAttribute.array.length)
                .setName('copySourceCounts')
                .toReadOnly(),
            ]),
        storage(this.intervalAttribute, 'vec2', this.intervalAttribute.array.length / 2).setName(
          'copyTargetIntervals',
        ),
        storage(this.countAttribute, 'uint', this.countAttribute.array.length).setName(
          'copyTargetCounts',
        ),
        storage(this.errorAttribute, 'uint', 4).setName('copyErrors').toAtomic(),
        storage(source.tileIndices, 'uint', source.tileIndices.array.length)
          .setName('copySourceTiles')
          .toReadOnly(),
        storage(this.tileIndices, 'uint', this.tileIndices.array.length)
          .setName('copyTargetTiles')
          .toReadOnly(),
      ],
      'wgsl',
    );
    const offset = uniform(0, 'uint').setName('dexelCopyOffset');
    const node = wgslFn(shared ? DEXEL_SHARED_COPY : DEXEL_COPY, [
      code(DEXEL_HELPERS.replace(/dexelTileSweeps/g, 'copyTargetTiles'), [bindings], 'wgsl'),
      bindings,
    ])({
      id: instanceIndex.add(offset),
      sourceCapacity: uniform(source.layout.intervalCapacity, 'uint').setName(
        'dexelCopySourceCapacity',
      ),
      targetCapacity: uniform(this.layout.intervalCapacity, 'uint').setName(
        'dexelCopyTargetCapacity',
      ),
      trimBase: uniform(this.baseTransitionSource ? 1 : 0, 'uint').setName('dexelCopyTrimBase'),
      size: uniform(this.layout.size).setName('dexelCopySize'),
      dims: uniform(this.layout.dimensions).setName('dexelCopyDimensions'),
      cylinder: uniform(this.cylinder ? 1 : 0, 'uint').setName('dexelCopyCylinder'),
    }).compute(this.layout.rays, [64]);
    const started = performance.now();
    const lost = this.device.lost.then(lostDeviceError);
    const batchRays = Math.min(
      DEXEL_DISPATCH_RAYS,
      Math.floor(65536 / source.layout.intervalCapacity / 64) * 64,
    );
    recordGpuDiagnostic(this.device, 'stock-copy-start', {
      rays: this.layout.rays,
      sourceCapacity: source.layout.intervalCapacity,
      targetCapacity: this.layout.intervalCapacity,
      pitchMm: this.layout.pitchMm,
      copiedTiles: this.timings.copiedTiles,
      sharedTiles: this.timings.sharedTiles,
    });
    let scoped = false;
    let failure: unknown;
    try {
      this.device.pushErrorScope('validation');
      scoped = true;
      for (const [start, rays] of copyRanges) {
        for (let ray = start; ray < start + rays; ray += batchRays) {
          if (this.disposed || source.disposed || cancelled())
            throw new DOMException('GPU stock copy cancelled', 'AbortError');
          offset.value = ray;
          await this.renderer.compute(node, Math.min(batchRays, start + rays - ray));
          const completion = await Promise.race([lost, this.device.queue.onSubmittedWorkDone()]);
          if (completion instanceof Error) throw completion;
        }
      }
      if (!copyRanges.length) {
        const completion = await Promise.race([lost, this.device.queue.onSubmittedWorkDone()]);
        if (completion instanceof Error) throw completion;
      }
      if (this.disposed || source.disposed || cancelled())
        throw new DOMException('GPU stock copy cancelled', 'AbortError');
      if (this.baseTransitionSource) {
        const header = await Promise.race([
          lost,
          this.renderer.getArrayBufferAsync(this.errorAttribute),
        ]);
        if (header instanceof Error) throw header;
        if (new Uint32Array(header)[0] & 1)
          throw new GpuDexelIntervalOverflowError(this.layout.intervalCapacity);
      }
    } catch (error) {
      failure = error;
    } finally {
      node.dispose();
      if (scoped) {
        try {
          const validation = await this.device.popErrorScope();
          if (validation && failure === undefined)
            failure = new SimulationCapabilityError(
              `GPU stock copy validation failed: ${validation.message}`,
            );
        } catch (error) {
          console.error('GPU stock copy validation scope failed:', error);
          if (failure === undefined) failure = error;
        }
      }
    }
    this.finishOperation();
    source.finishOperation();
    if (failure !== undefined) {
      recordGpuDiagnostic(this.device, 'stock-copy-error', { message: String(failure) });
      throw failure;
    }
    if (this.disposed || source.disposed || cancelled())
      throw new DOMException('GPU stock copy cancelled', 'AbortError');
    this.resume.value = 1;
    this.calculated = true;
    this.sharedSource = undefined;
    const elapsedMs = performance.now() - started;
    this.timings.copyMs += elapsedMs;
    recordGpuDiagnostic(this.device, 'stock-copy-finished', { elapsedMs: Math.round(elapsedMs) });
    return elapsedMs;
  }

  async calculate(sweepCount: number, cancelled: () => boolean = () => false): Promise<number> {
    if (this.sealed) throw new SimulationCapabilityError('Published GPU stock is immutable');
    if (this.active) throw new SimulationCapabilityError('GPU stock is already in use');
    if (this.disposed) throw new DOMException('GPU stock disposed', 'AbortError');
    if (!Number.isSafeInteger(sweepCount) || sweepCount < 0)
      throw new Error('Invalid GPU sweep prefix');
    this.active++;
    this.calculated = false;
    this.history?.dispose();
    this.history = undefined;
    this.prefix.value = sweepCount;
    this.errorAttribute.array.fill(0);
    this.errorAttribute.needsUpdate = true;
    const started = performance.now();
    recordGpuDiagnostic(this.device, 'compute-start', {
      pitchMm: this.layout.pitchMm,
      intervalCapacity: this.layout.intervalCapacity,
      rays: this.layout.rays,
      sweeps: sweepCount,
      resumedStock: this.resume.value !== 0,
      analyticalFlatSweeps: this.analyticalFlatSweeps,
      analyticalProfileSweeps: this.analyticalProfileSweeps,
      dispatchRays: this.dispatchRays,
      maxTileSweeps: this.maxTileSweeps,
      passSweeps: DEXEL_PASS_SWEEPS,
      estimatedMiB: Math.round(this.estimatedBytes / 1048576),
      storedTiles: this.layout.storedTiles.length,
    });
    const lost = this.device.lost.then(lostDeviceError);
    let scoped = false;
    let validation: GPUError | null = null;
    let failure: unknown;
    const historyChunks: Uint32Array[] = [];
    let retainedEvents = 0;
    const historyFailure = (reason: string) => {
      this.historyUnavailable = reason + '; uncached jumps use geometric replay.';
      this.recordHistory.value = 0;
      historyChunks.length = 0;
      retainedEvents = 0;
      console.warn('[NC-Edit7 GPU] ' + this.historyUnavailable);
    };
    const captureCapacity = this.captureAttribute.array.length / 4;
    if (this.recordHistory.value && captureCapacity < 4)
      historyFailure('Removal history batch capacity exhausted: fewer than four event slots');
    const submission = this.recordHistory.value
      ? dexelHistorySubmission(captureCapacity, this.maxTileSweeps, this.dispatchRays)
      : { sweeps: DEXEL_PASS_SWEEPS, rays: this.dispatchRays };
    this.passSweeps.value = submission.sweeps;
    const drain = async () => {
      const header = await Promise.race([
        lost,
        this.renderer.getArrayBufferAsync(this.errorAttribute),
      ]);
      if (header instanceof Error) throw header;
      const values = new Uint32Array(header),
        flags = values[0];
      if (flags & 2)
        throw new SimulationCapabilityError(
          'GPU cutter ray intersection is uncertain or exceeds bounded capacity; use CPU simulation',
        );
      if (flags & 4)
        throw new SimulationCapabilityError(
          'GPU cutter intersection exceeded Float32 numerical range; use CPU simulation',
        );
      if (flags & 1) throw new GpuDexelIntervalOverflowError(this.layout.intervalCapacity);
      if (!this.recordHistory.value) return;
      const count = values[2];
      if (values[3] || count > captureCapacity) {
        historyFailure('Removal history batch capacity exhausted');
      } else if (retainedEvents + count > this.historyLimit) {
        historyFailure('Removal history retention budget exhausted');
      } else if (count) {
        const captured = await Promise.race([
          lost,
          this.renderer.getArrayBufferAsync(this.captureAttribute),
        ]);
        if (captured instanceof Error) throw captured;
        if (this.disposed || cancelled())
          throw new DOMException('GPU history cancelled', 'AbortError');
        historyChunks.push(new Uint32Array(captured, 0, count * 4).slice());
        retainedEvents += count;
      }
      this.errorAttribute.array.fill(0);
      this.errorAttribute.needsUpdate = true;
    };
    try {
      this.device.pushErrorScope('validation');
      scoped = true;
      const entries = Math.min(sweepCount, this.maxTileSweeps);
      for (
        let entryOffset = 0;
        entryOffset < Math.max(1, entries);
        entryOffset += submission.sweeps
      ) {
        this.entryOffset.value = entryOffset;
        const ranges: [number, number][] =
          entryOffset === 0 && this.resume.value === 0
            ? this.storageRanges()
            : dexelDispatchRanges(this.tileRanges, entryOffset);
        this.assertWritable(ranges);
        for (const [start, rays] of ranges) {
          for (let offset = start; offset < start + rays; offset += submission.rays) {
            const count = Math.min(submission.rays, start + rays - offset);
            if (this.disposed || cancelled())
              throw new DOMException('GPU stock calculation cancelled', 'AbortError');
            this.rayOffset.value = offset;
            this.rayEnd.value = offset + count;
            recordGpuDiagnostic(this.device, 'compute-submit', {
              offset,
              entryOffset,
              rays: count,
              elapsedMs: Math.round(performance.now() - started),
            });
            const context: { builder?: NodeBuilder } = {};
            const submitStarted = performance.now();
            const previous = this.renderer.debug.onNodeBuilderCreated;
            this.renderer.debug.onNodeBuilderCreated = (builder, object) => {
              previous?.(builder, object);
              if (object === this.computeNode) context.builder = builder;
            };
            try {
              await this.renderer.compute(this.computeNode, count);
              this.timings.submissions++;
              this.timings.submittedRays += count;
            } finally {
              this.renderer.debug.onNodeBuilderCreated = previous;
              const builder = context.builder;
              if (
                builder &&
                'computeShader' in builder &&
                typeof builder.computeShader === 'string'
              )
                this.computeShader = builder.computeShader;
            }
            const submitCpuMs = Math.round(performance.now() - submitStarted);
            const queueStarted = performance.now();
            const completion = await Promise.race([lost, this.device.queue.onSubmittedWorkDone()]);
            if (completion instanceof Error) throw completion;
            const queueWaitMs = Math.round(performance.now() - queueStarted);
            const timing = {
              offset,
              entryOffset,
              submitCpuMs,
              queueWaitMs,
              intervalCapacity: this.layout.intervalCapacity,
            };
            recordGpuDiagnostic(this.device, 'compute-complete', timing);
            if (offset === 0 && entryOffset === 0) {
              recordGpuDiagnostic(this.device, 'compute-first-complete', timing);
              if (submitCpuMs + queueWaitMs > 500)
                console.info(
                  '[NC-Edit7 GPU] Slow first compute submission ' + JSON.stringify(timing),
                );
            }
            // Queue completion precedes readback/reset; no submission can fill
            // beyond the staging capacity, even when total history exceeds it.
            if (this.recordHistory.value) {
              if (this.disposed || cancelled())
                throw new DOMException('GPU history cancelled', 'AbortError');
              await drain();
            }
          }
        }
        if (this.disposed || cancelled())
          throw new DOMException('GPU stock calculation cancelled', 'AbortError');
        if (!this.recordHistory.value) await drain();
      }
    } catch (error) {
      recordGpuDiagnostic(this.device, 'compute-error', {
        message: error instanceof Error ? error.message : String(error),
      });
      failure = error;
    } finally {
      try {
        if (scoped) validation = await this.device.popErrorScope();
      } catch (error) {
        console.error('GPU stock validation scope failed:', error);
        if (failure === undefined) failure = error;
      }
      this.finishOperation();
    }
    if (validation) {
      let detail = '';
      if (this.computeShader) {
        this.device.pushErrorScope('validation');
        try {
          const module = this.device.createShaderModule({ code: this.computeShader });
          const info = await module.getCompilationInfo();
          detail = info.messages
            .filter((message) => message.type === 'error')
            .map((message) => `WGSL ${message.lineNum}:${message.linePos}: ${message.message}`)
            .join('; ');
        } catch (error) {
          console.error('GPU stock shader diagnostics failed:', error);
        } finally {
          await this.device.popErrorScope();
        }
      }
      throw new SimulationCapabilityError(
        `GPU stock shader validation failed: ${detail || validation.message}`,
      );
    }
    if (failure !== undefined) throw failure;
    if (this.disposed || cancelled())
      throw new DOMException('GPU stock disposed or cancelled', 'AbortError');
    if (this.recordHistory.value) {
      const captured = new Uint32Array(retainedEvents * 4);
      let offset = 0;
      for (const chunk of historyChunks) {
        captured.set(chunk, offset);
        offset += chunk.length;
      }
      this.history = new GpuDexelHistory(captured, this.layout.rays, this.sweeps, this.historyKey);
      this.historyUnavailable = undefined;
    }
    this.calculated = true;
    const elapsedMs = performance.now() - started;
    this.timings.computeMs += elapsedMs;
    recordGpuDiagnostic(this.device, 'compute-finished', { elapsedMs: Math.round(elapsedMs) });
    console.debug(
      '[NC-Edit7 GPU] Stock calculation finished ' +
        JSON.stringify({
          pitchMm: this.layout.pitchMm,
          sweeps: sweepCount,
          rays: this.layout.rays,
          dispatchRays: this.dispatchRays,
          elapsedMs: Math.round(elapsedMs),
        }),
    );
    return elapsedMs;
  }

  takeHistory(): GpuDexelHistory | undefined {
    const history = this.history;
    this.history = undefined;
    return history;
  }

  releasePreparation(): void {
    if (!this.calculated || this.sealed) return;
    this.sealed = true;
    this.computeNode.dispose();
    this.estimatedBytes -= this.sweeps.reduce((sum, sweep) => sum + sweep.data.byteLength + 256, 0);
    this.sweeps = [];
    for (const attribute of this.attributes) {
      if (
        attribute === this.intervalAttribute ||
        attribute === this.countAttribute ||
        attribute === this.tileIndices
      )
        continue;
      const bytes = attribute.array.byteLength;
      attribute.dispose();
      attribute.array =
        attribute.array instanceof Float32Array
          ? new Float32Array(attribute.itemSize)
          : new Uint32Array(attribute.itemSize);
      this.estimatedBytes -= 2 * (bytes - attribute.array.byteLength);
    }
  }

  async restoreHistory(
    history: GpuDexelHistory,
    step: number,
    cancelled: () => boolean = () => false,
    afterStep = -1,
  ): Promise<number> {
    if (this.sealed) throw new SimulationCapabilityError('Published GPU stock is immutable');
    if (this.active) throw new SimulationCapabilityError('GPU stock is already in use');
    if (this.disposed || cancelled())
      throw new DOMException('GPU history restore cancelled', 'AbortError');
    if (
      history.stockKey !== this.historyKey ||
      history.rays !== this.layout.rays ||
      afterStep > step ||
      (afterStep >= 0 && !this.calculated)
    )
      throw new SimulationCapabilityError(
        'GPU history restore requires a compatible ray grid and earlier completed stock',
      );
    const through = history.rank(step),
      after = history.rank(afterStep);
    for (const tile of history.tiles(step))
      if (this.tileSlots[tile] === 0xffffffff)
        throw new SimulationCapabilityError('GPU history restore target is missing a changed tile');
    this.active++;
    this.calculated = false;
    this.errorAttribute.array.fill(0);
    this.errorAttribute.needsUpdate = true;
    const bindings = code(
      '',
      [
        storage(history.events, 'uvec4', history.events.array.length / 4)
          .setName('restoreEvents')
          .toReadOnly(),
        storage(history.ranges, 'uvec2', history.ranges.array.length / 2)
          .setName('restoreRanges')
          .toReadOnly(),
        storage(this.tileIndices, 'uint', this.tileIndices.array.length)
          .setName('restoreTiles')
          .toReadOnly(),
        storage(this.intervalAttribute, 'vec2', this.intervalAttribute.array.length / 2).setName(
          'restoreIntervals',
        ),
        storage(this.countAttribute, 'uint', this.countAttribute.array.length).setName(
          'restoreCounts',
        ),
        storage(this.errorAttribute, 'uint', 4).setName('restoreErrors').toAtomic(),
      ],
      'wgsl',
    );
    const offset = uniform(0, 'uint').setName('dexelRestoreOffset');
    const resumed = this.resume.value;
    const node = wgslFn(DEXEL_RESTORE, [
      code(DEXEL_HELPERS.replace(/dexelTileSweeps/g, 'restoreTiles'), [bindings], 'wgsl'),
      bindings,
    ])({
      id: instanceIndex.add(offset),
      capacity: uniform(this.layout.intervalCapacity, 'uint').setName('dexelRestoreCapacity'),
      resume: uniform(resumed, 'uint').setName('dexelRestoreResume'),
      after: uniform(after, 'uint').setName('dexelRestoreAfter'),
      through: uniform(through, 'uint').setName('dexelRestoreThrough'),
      size: uniform(this.layout.size).setName('dexelRestoreSize'),
      dims: uniform(this.layout.dimensions).setName('dexelRestoreDimensions'),
      cylinder: uniform(this.cylinder ? 1 : 0, 'uint').setName('dexelRestoreCylinder'),
    }).compute(this.layout.rays, [64]);
    const started = performance.now();
    const lost = this.device.lost.then(lostDeviceError);
    let failure: unknown,
      scoped = false;
    try {
      this.device.pushErrorScope('validation');
      scoped = true;
      const tileWork = history.work(afterStep, step);
      const ranges: [number, number][] = resumed
        ? dexelDispatchRanges(tileWork, 0)
        : this.storageRanges();
      this.assertWritable(ranges);
      const maximum = tileWork.reduce((max, count, i) => (i % 2 ? Math.max(max, count) : max), 1);
      const batch = Math.max(
        64,
        Math.min(DEXEL_DISPATCH_RAYS, Math.floor(65536 / maximum / 64) * 64),
      );
      recordGpuDiagnostic(this.device, 'history-restore-start', {
        step,
        afterStep,
        maxRayEvents: maximum,
        batchRays: batch,
        activeTiles: tileWork.filter((count, i) => i % 2 === 1 && count > 0).length,
      });
      let submitted = false;
      for (const [start, rays] of ranges) {
        for (let ray = start; ray < start + rays; ray += batch) {
          if (this.disposed || cancelled())
            throw new DOMException('GPU history restore cancelled', 'AbortError');
          offset.value = ray;
          const count = Math.min(batch, start + rays - ray);
          await this.renderer.compute(node, count);
          submitted = true;
          this.timings.submissions++;
          this.timings.submittedRays += count;
          const done = await Promise.race([lost, this.device.queue.onSubmittedWorkDone()]);
          if (done instanceof Error) throw done;
        }
      }
      if (!submitted) {
        // Initialize the error binding for the readback, without visiting material rays.
        offset.value = this.layout.rays;
        await this.renderer.compute(node, 1);
      }
      const header = await Promise.race([
        lost,
        this.renderer.getArrayBufferAsync(this.errorAttribute),
      ]);
      if (header instanceof Error) throw header;
      if (new Uint32Array(header)[0])
        throw new GpuDexelIntervalOverflowError(this.layout.intervalCapacity);
    } catch (error) {
      failure = error;
    } finally {
      node.dispose();
      if (scoped) {
        try {
          const validation = await this.device.popErrorScope();
          if (validation && failure === undefined)
            failure = new SimulationCapabilityError(
              `GPU history restore validation failed: ${validation.message}`,
            );
        } catch (error) {
          console.error('GPU history restore validation scope failed:', error);
          if (failure === undefined) failure = error;
        }
      }
    }
    this.finishOperation();
    if (failure !== undefined) throw failure;
    if (this.disposed || cancelled())
      throw new DOMException('GPU history restore cancelled', 'AbortError');
    this.calculated = true;
    this.resume.value = 1;
    const elapsedMs = performance.now() - started;
    this.timings.computeMs += elapsedMs;
    recordGpuDiagnostic(this.device, 'history-restored', {
      step,
      afterStep,
      elapsedMs: Math.round(elapsedMs),
    });
    return elapsedMs;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    if (!this.active) this.disposeResources();
  }

  private disposeResources(): void {
    this.history?.dispose();
    this.computeNode.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    for (const attribute of this.attributes)
      if (attribute !== this.intervalAttribute && attribute !== this.countAttribute)
        attribute.dispose();
    this.releaseSlots();
  }

  private releaseSlots(): void {
    if (this.slotsReleased) return;
    this.slotsReleased = true;
    this.tileArena.release(this.layout.storedTiles.map((tile) => this.tileSlots[tile]));
  }

  private finishOperation(): void {
    this.active--;
    if (this.disposed && !this.active) this.disposeResources();
  }

  private assertWritable(ranges: readonly [number, number][]): void {
    for (const [start, count] of ranges)
      for (let tile = Math.floor(start / 1024); tile < Math.ceil((start + count) / 1024); tile++) {
        const slot = this.tileSlots[tile];
        if (slot !== undefined && slot !== 0xffffffff && !this.tileArena.exclusive(slot))
          throw new SimulationCapabilityError(
            'GPU replay attempted to mutate a shared immutable tile',
          );
      }
  }

  private storageRanges(tiles = this.layout.storedTiles, initialize = true): [number, number][] {
    const ranges: [number, number][] = [];
    for (const tile of tiles) {
      const last = ranges.at(-1);
      if (last && last[0] + last[1] === tile * 1024) last[1] += 1024;
      else ranges.push([tile * 1024, 1024]);
    }
    // Initialize bindings/error storage even when all material is implicit.
    return ranges.length || !initialize ? ranges : [[0, 1]];
  }
}
