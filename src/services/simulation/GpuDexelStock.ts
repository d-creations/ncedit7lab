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
  DEXEL_MEMORY_BYTES,
  indexDexelTiles,
  type DexelLayout,
} from './DexelLayout';
import {
  GPU_SWEEP_STRIDE,
  GPU_SWEEP_WGSL,
  GPU_SWEEP_RAY_WGSL,
  type CompiledGpuSweep,
} from './GpuSweepCompiler';
import { SimulationCapabilityError } from './SimulationTypes';

export const DEXEL_DISPATCH_RAYS = 16384;

type DexelDevice = Pick<
  GPUDevice,
  'lost' | 'pushErrorScope' | 'popErrorScope' | 'createShaderModule'
> & { readonly queue: Pick<GPUQueue, 'onSubmittedWorkDone'> };

function lostDeviceError(info: GPUDeviceLostInfo): SimulationCapabilityError {
  return new SimulationCapabilityError(`WebGPU device lost: ${info.message || info.reason}`);
}

const HELPERS = `
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
fn gpuCutIntervals(cut: vec2f, segments: ptr<function, array<vec2f, ${DEXEL_INTERVALS}>>, count: u32) -> u32 {
  var result: array<vec2f, ${DEXEL_INTERVALS}>; var n = 0u;
  for (var i = 0u; i < count; i++) {
    let old = (*segments)[i];
    if (cut.y <= old.x || cut.x >= old.y) { if (n >= ${DEXEL_INTERVALS}u) { return 99u; } result[n] = old; n++; }
    else {
      if (old.x < cut.x) { if (n >= ${DEXEL_INTERVALS}u) { return 99u; } result[n] = vec2f(old.x, cut.x); n++; }
      if (old.y > cut.y) { if (n >= ${DEXEL_INTERVALS}u) { return 99u; } result[n] = vec2f(cut.y, old.y); n++; }
    }
  }
  *segments = result; return n;
}
`;

const COMPUTE = `
fn gpuBuildDexels(id: u32, prefix: u32, size: vec3f, dims: vec3f, cylinder: u32) -> void {
  if (id >= arrayLength(&dexelCounts.value)) { return; }
  dexelCounts.value[id] = 0u;
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
  var segments: array<vec2f, ${DEXEL_INTERVALS}>; segments[0] = vec2f(lo, hi); var count = 1u;
  let epsilon = max(0.0000001, min(size.x / dims.x, min(size.y / dims.y, size.z / dims.z)) * 0.0005);
  let range = dexelTileRanges.value[id / 1024u];
  for (var entry = 0u; entry < range.y; entry++) {
    let sweep = dexelTileSweeps.value[range.x + entry]; if (sweep >= prefix || count == 0u) { break; }
    let minimum = dexelBounds.value[sweep * 2u].xyz; let maximum = dexelBounds.value[sweep * 2u + 1u].xyz;
    var overlaps = true;
    for (var a = 0u; a < 3u; a++) { if (a != axis && (origin[a] < minimum[a] || origin[a] > maximum[a])) { overlaps = false; } }
    if (!overlaps) { continue; }
    let end = min(hi, maximum[axis] + epsilon); var t = max(lo, minimum[axis] - epsilon);
    if (t >= end) { continue; }
    var cuts: array<vec2f, 4>;
    let cutCount = gpuSweepRayCuts(origin, direction, vec2f(t, end), sweep, &cuts);
    if (cutCount > 4u) { atomicOr(&dexelErrors.value[0], 2u); return; }
    for (var cut = 0u; cut < cutCount; cut++) {
      count = gpuCutIntervals(cuts[cut], &segments, count);
      if (count > ${DEXEL_INTERVALS}u) { atomicOr(&dexelErrors.value[0], 1u); return; }
    }
  }
  dexelCounts.value[id] = count;
  for (var i = 0u; i < count; i++) { dexelIntervals.value[id * ${DEXEL_INTERVALS}u + i] = segments[i]; }
}
`;

const DISPLAY_HELPERS = `
fn gpuDexelNearestAxis(p: vec3f, axis: u32, size: vec3f, dims: vec3f) -> vec4f {
  let ray = gpuRayIndex(clamp(p, -size * 0.5, size * 0.5), axis, size, dims);
  var result = vec4f(0.0, 0.0, 0.0, 1e20);
  for (var i = 0u; i < dexelCounts.value[ray]; i++) {
    let span = dexelIntervals.value[ray * ${DEXEL_INTERVALS}u + i];
    let lower = span.x - p[axis]; let upper = p[axis] - span.y;
    let field = max(lower, upper);
    if (field < result.w) {
      result = vec4f(0.0, 0.0, 0.0, field);
      result[axis] = select(1.0, -1.0, lower >= upper);
    }
  }
  return result;
}
fn gpuDexelAxisSample(p: vec3f, axis: u32, size: vec3f, dims: vec3f) -> vec4f {
  let nearest = gpuDexelNearestAxis(p, axis, size, dims);
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
  let count = dexelCounts.value[rays[0]];
  if (count == 0u || dexelCounts.value[rays[1]] != count ||
      dexelCounts.value[rays[2]] != count || dexelCounts.value[rays[3]] != count) { return nearest; }
  var result = vec4f(0.0, 0.0, 0.0, 1e20);
  for (var i = 0u; i < count; i++) {
    let a = dexelIntervals.value[rays[0] * ${DEXEL_INTERVALS}u + i];
    let b = dexelIntervals.value[rays[1] * ${DEXEL_INTERVALS}u + i];
    let c = dexelIntervals.value[rays[2] * ${DEXEL_INTERVALS}u + i];
    let d = dexelIntervals.value[rays[3] * ${DEXEL_INTERVALS}u + i];
    // Do not blend disjoint walls; interval-count changes are rejected above.
    if (max(max(a.x, b.x), max(c.x, d.x)) >= min(min(a.y, b.y), min(c.y, d.y))) { return nearest; }
    let span = mix(mix(a, b, weight[u]), mix(c, d, weight[u]), weight[v]);
    let lower = span.x - p[axis]; let upper = p[axis] - span.y;
    let field = max(lower, upper);
    if (field < result.w) {
      let du = mix(b - a, d - c, weight[v]) / h[u];
      let dv = mix(c - a, d - b, weight[u]) / h[v];
      let entry = lower >= upper;
      result = vec4f(0.0, 0.0, 0.0, field);
      result[axis] = select(1.0, -1.0, entry);
      result[u] = select(-du.y, du.x, entry) * select(0.0, 1.0, high[u] > low[u]);
      result[v] = select(-dv.y, dv.x, entry) * select(0.0, 1.0, high[v] > low[v]);
    }
  }
  return result;
}
fn gpuDexelNormal(p: vec3f, size: vec3f, dims: vec3f) -> vec3f {
  var surface = vec4f(0.0, 0.0, 0.0, -1e20);
  for (var axis = 0u; axis < 3u; axis++) {
    let sample = gpuDexelAxisSample(p, axis, size, dims);
    if (sample.w > surface.w) { surface = sample; }
  }
  if (dot(surface.xyz, surface.xyz) < 1e-15) { return vec3f(0.0, 0.0, 1.0); }
  return normalize(surface.xyz);
}
`;

const TRACE = `
fn gpuTraceDexels(origin: vec3f, surface: vec3f, size: vec3f, dims: vec3f) -> vec4f {
  let direction = normalize(surface - origin);
  var inverse = vec3f(0.0);
  for (var a = 0u; a < 3u; a++) { inverse[a] = 1.0 / select(direction[a], 1e-20, abs(direction[a]) < 1e-20); }
  let near = (-size * 0.5 - origin) * inverse; let far = (size * 0.5 - origin) * inverse;
  let low = min(near, far); let high = max(near, far);
  var t = max(0.0, max(low.x, max(low.y, low.z))); let end = min(high.x, min(high.y, high.z));
  if (t > end) { return vec4f(0.0); }
  let h = size / dims; let epsilon = min(h.x, min(h.y, h.z)) * 0.0001;
  for (var iteration = 0u; iteration < 8192u; iteration++) {
    if (t + epsilon >= end) { return vec4f(0.0); }
    let p = origin + direction * (t + epsilon);
    let cell = floor((p + size * 0.5) / h);
    var occupied = true; var safeSkip = 0.0;
    for (var axis = 0u; axis < 3u; axis++) {
      let ray = gpuRayIndex(clamp(p, -size * 0.5, size * 0.5), axis, size, dims);
      var inMaterial = false; var entry = end - t;
      for (var i = 0u; i < dexelCounts.value[ray]; i++) {
        let span = dexelIntervals.value[ray * ${DEXEL_INTERVALS}u + i];
        if (p[axis] >= span.x && p[axis] <= span.y) { inMaterial = true; }
        if (abs(direction[axis]) >= 1e-15) {
          let next = (select(span.y, span.x, direction[axis] > 0.0) - p[axis]) / direction[axis] + epsilon;
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
  readonly estimatedBytes: number;
  readonly intervalAttribute: StorageBufferAttribute;
  readonly countAttribute: StorageBufferAttribute;
  private readonly attributes: StorageBufferAttribute[];
  private readonly prefix = uniform(0, 'uint').setName('dexelPrefix');
  private readonly rayOffset = uniform(0, 'uint').setName('dexelRayOffset');
  private readonly errorAttribute = new StorageBufferAttribute(new Uint32Array(4), 1);
  private readonly computeNode;
  private readonly mesh: THREE.Mesh<THREE.BoxGeometry, MeshBasicNodeMaterial>;
  private disposed = false;
  private computeShader?: string;

  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly device: DexelDevice,
    size: THREE.Vector3,
    pitchMm: number,
    cylinder: boolean,
    sweeps: readonly CompiledGpuSweep[],
    stockToWorkpiece: THREE.Matrix4,
  ) {
    this.layout = createDexelLayout(size, pitchMm);
    const index = indexDexelTiles(this.layout, sweeps);
    const recordData = new Float32Array(Math.max(4, sweeps.length * GPU_SWEEP_STRIDE));
    const boundData = new Float32Array(Math.max(8, sweeps.length * 8));
    sweeps.forEach((sweep, i) => {
      recordData.set(sweep.data, i * GPU_SWEEP_STRIDE);
      boundData.set([...sweep.bounds.min.toArray(), 0, ...sweep.bounds.max.toArray(), 0], i * 8);
    });
    this.estimatedBytes =
      this.layout.estimatedBytes +
      index.bytes +
      2 * (recordData.byteLength + boundData.byteLength) +
      sweeps.reduce((sum, sweep) => sum + sweep.data.byteLength + 256, 0);
    if (this.estimatedBytes > DEXEL_MEMORY_BYTES)
      throw new SimulationCapabilityError(
        'GPU stock and cutter data exceed the combined CPU/GPU memory estimate',
      );
    this.intervalAttribute = new StorageBufferAttribute(
      new Float32Array(this.layout.rays * DEXEL_INTERVALS * 2),
      2,
    );
    this.countAttribute = new StorageBufferAttribute(new Uint32Array(this.layout.rays), 1);
    const records = new StorageBufferAttribute(recordData, 4),
      bounds = new StorageBufferAttribute(boundData, 4);
    const ranges = new StorageBufferAttribute(index.ranges, 2),
      indices = new StorageBufferAttribute(index.sweeps, 1);
    this.attributes = [
      this.intervalAttribute,
      this.countAttribute,
      records,
      bounds,
      ranges,
      indices,
      this.errorAttribute,
    ];
    // Stable binding names allow shader reuse instead of recompiling per stock state.
    const sizeNode = uniform(size).setName('dexelSize'),
      dimensionsNode = uniform(this.layout.dimensions).setName('dexelDimensions');
    const intervals = storage(
      this.intervalAttribute,
      'vec2',
      this.layout.rays * DEXEL_INTERVALS,
    ).setName('dexelIntervals');
    const counts = storage(this.countAttribute, 'uint', this.layout.rays).setName('dexelCounts');
    // Global bindings avoid optional WGSL storage-pointer function parameters.
    const computeBindings = [
      storage(records, 'vec4', recordData.length / 4).setName('dexelRecords').toReadOnly(),
      storage(bounds, 'vec4', boundData.length / 4).setName('dexelBounds').toReadOnly(),
      storage(ranges, 'uvec2', this.layout.tiles).setName('dexelTileRanges').toReadOnly(),
      storage(indices, 'uint', index.sweeps.length).setName('dexelTileSweeps').toReadOnly(),
      intervals,
      counts,
      storage(this.errorAttribute, 'uint', 4).setName('dexelErrors').toAtomic(),
    ];
    const helpers = code(HELPERS, [], 'wgsl'),
      sweepCode = code(`${GPU_SWEEP_WGSL}\n${GPU_SWEEP_RAY_WGSL}`, computeBindings, 'wgsl');
    const build = wgslFn(COMPUTE, [helpers, sweepCode]);
    this.computeNode = build({
      id: instanceIndex.add(this.rayOffset),
      prefix: this.prefix,
      size: sizeNode,
      dims: dimensionsNode,
      cylinder: uniform(cylinder ? 1 : 0, 'uint').setName('dexelCylinder'),
    }).compute(this.layout.rays, [64]);
    const material = new MeshBasicNodeMaterial({ side: THREE.BackSide });
    const camera = uniform(new THREE.Vector3()).setName('dexelCamera');
    const readIntervals = storage(
      this.intervalAttribute,
      'vec2',
      this.layout.rays * DEXEL_INTERVALS,
    ).setName('dexelIntervals').toReadOnly();
    const readCounts = storage(this.countAttribute, 'uint', this.layout.rays)
      .setName('dexelCounts')
      .toReadOnly();
    const displayHelpers = code(DISPLAY_HELPERS, [readIntervals, readCounts], 'wgsl');
    const trace = wgslFn(TRACE, [helpers, displayHelpers]);
    const hit = (
      trace({
        origin: camera,
        surface: positionLocal,
        size: sizeNode,
        dims: dimensionsNode,
      }) as Node<'vec4'>
    ).toVar('dexelHit');
    const normal = wgslFn(
      `fn gpuStockShade(p: vec3f, size: vec3f, dims: vec3f) -> vec3f {
      let n = gpuDexelNormal(p, size, dims);
      let lighting = 0.3 + 0.55 * max(dot(n, normalize(vec3f(1.0, 1.0, 2.0))), 0.0) + 0.15 * max(dot(n, normalize(vec3f(-1.0, 0.5, 0.0))), 0.0);
      return vec3f(0.70, 0.57, 0.38) * lighting;
    }`,
      [helpers, displayHelpers],
    );
    material.fragmentNode = Fn(() => {
      If(hit.w.equal(0), () => {
        Discard();
      });
      const shaded = normal({
        p: hit.xyz,
        size: sizeNode,
        dims: dimensionsNode,
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

  async calculate(sweepCount: number, cancelled: () => boolean = () => false): Promise<number> {
    if (this.disposed) throw new DOMException('GPU stock disposed', 'AbortError');
    if (!Number.isSafeInteger(sweepCount) || sweepCount < 0)
      throw new Error('Invalid GPU sweep prefix');
    this.prefix.value = sweepCount;
    this.errorAttribute.array.fill(0);
    this.errorAttribute.needsUpdate = true;
    const started = performance.now();
    const lost = this.device.lost.then(lostDeviceError);
    this.device.pushErrorScope('validation');
    let validation: GPUError | null = null;
    let failure: unknown;
    try {
      for (let offset = 0; offset < this.layout.rays; offset += DEXEL_DISPATCH_RAYS) {
        if (this.disposed || cancelled())
          throw new DOMException('GPU stock calculation cancelled', 'AbortError');
        this.rayOffset.value = offset;
        const context: { builder?: NodeBuilder } = {};
        const previous = this.renderer.debug.onNodeBuilderCreated;
        this.renderer.debug.onNodeBuilderCreated = (builder, object) => {
          previous?.(builder, object);
          if (object === this.computeNode) context.builder = builder;
        };
        try {
          await this.renderer.compute(
            this.computeNode,
            Math.min(DEXEL_DISPATCH_RAYS, this.layout.rays - offset),
          );
        } finally {
          this.renderer.debug.onNodeBuilderCreated = previous;
          const builder = context.builder;
          if (builder && 'computeShader' in builder && typeof builder.computeShader === 'string')
            this.computeShader = builder.computeShader;
        }
        const completion = await Promise.race([lost, this.device.queue.onSubmittedWorkDone()]);
        if (completion instanceof Error) throw completion;
      }
      if (this.disposed || cancelled())
        throw new DOMException('GPU stock calculation cancelled', 'AbortError');
      const header = await Promise.race([
        lost,
        this.renderer.getArrayBufferAsync(this.errorAttribute),
      ]);
      if (header instanceof Error) throw header;
      const flags = new Uint32Array(header)[0];
      if (flags & 1)
        throw new SimulationCapabilityError(
          `GPU stock exceeds ${DEXEL_INTERVALS} material intervals on a ray; use CPU simulation`,
        );
      if (flags & 2)
        throw new SimulationCapabilityError(
          'GPU cutter ray intersection is uncertain or exceeds bounded capacity; use CPU simulation',
        );
      if (flags & 4)
        throw new SimulationCapabilityError(
          'GPU cutter intersection exceeded Float32 numerical range; use CPU simulation',
        );
    } catch (error) {
      failure = error;
    } finally {
      try {
        validation = await this.device.popErrorScope();
      } catch (error) {
        console.error('GPU stock validation scope failed:', error);
        if (failure === undefined) failure = error;
      }
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
    if (this.disposed) throw new DOMException('GPU stock disposed', 'AbortError');
    return performance.now() - started;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.computeNode.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    for (const attribute of this.attributes) attribute.dispose();
    this.group.removeFromParent();
  }
}
