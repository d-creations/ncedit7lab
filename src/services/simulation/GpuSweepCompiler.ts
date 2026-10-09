import * as THREE from 'three';
import type { DeepReadonly } from '../tools/SimulationMetadata';
import { CuttingToolModel } from './CuttingToolModel';
import { stockPlacement } from './SimulationTransforms';
import { SimulationCapabilityError, type SimulationInput } from './SimulationTypes';
import { buildTurningSweep } from './TurningEnvelope';

export interface CompiledGpuSweep {
  executionStep: number;
  motionIndex: number;
  /** Stock-local, conservative bounds, including float32 packing roundoff. */
  bounds: THREE.Box3;
  data: Float32Array;
}

export const GPU_SWEEP_MAX_PLANES = 64;
/** 72 vec4s / 1152 bytes per record. Never use a motion index as a record index. */
export const GPU_SWEEP_STRIDE = (8 + GPU_SWEEP_MAX_PLANES) * 4;

/**
 * Record layout (vec4 indices):
 * 0: kind (flat=1, ball=2, drill=3, rounded=4, turning=5), radius, length, corner
 * 1: part-local travel.xyz, cos(drill half angle)
 * 2..4: stock-to-start-part affine rows
 * 5: stock-local spindle origin.xyz, positive radial section enabled
 * 6: stock-local spindle axis.xyz, reflected radial section enabled
 * 7: plane count, sin(drill half angle), packed affine Lipschitz bound, axial flag
 * 8..71: validated turning section planes (radial normal, axial normal, offset, 0).
 *
 * Fields are negative inside, not generally Euclidean signed distances. Max/min
 * of unit-Lipschitz fields and their translation infimum remain 1-Lipschitz.
 * Fixed-orientation flat, ball and drill translations use a finite analytical
 * minimax candidate set (stationary points, pairwise intersections, endpoints).
 * No spatial/depth-pitch sampling is involved. Rounded mills use the existing
 * axial extrusion field or a lateral nearest-segment projection; diagonal
 * rounded travel is deliberately unsupported.
 *
 * Turning folds a convex meridian across the spindle axis, including annular
 * sections. Plane maxima are conservative fields, not polygon Euclidean SDFs.
 * Float32 arithmetic has ordinary boundary roundoff; no geometric epsilon or
 * artificial inflation is added to the field. Affine roundoff is compensated
 * by a Lipschitz divisor, and bounds are padded independently.
 */
export function compileGpuSweeps(input: DeepReadonly<SimulationInput>): CompiledGpuSweep[] {
  if (input.algorithmVersion !== 2)
    throw new SimulationCapabilityError('GPU sweeps require simulation algorithm version 2');
  const workpieceToStock = stockPlacement(input.stock, input.binding).invert();
  const spindleOrigin = new THREE.Vector3(...input.binding.spindleOrigin).applyMatrix4(
    workpieceToStock,
  );
  const spindleAxis = new THREE.Vector3(...input.binding.spindleAxis).transformDirection(
    workpieceToStock,
  );
  return input.motions.map((motion, motionIndex) => {
    const fail = (message: string): never => {
      throw new SimulationCapabilityError(`GPU sweep ${motionIndex}: ${message}`);
    };
    if (motion.mode !== 'milling' && motion.mode !== 'turning') fail('unknown machining mode');
    if (!Number.isSafeInteger(motion.executionStep) || motion.executionStep < 0)
      fail('execution step must be a nonnegative safe integer');
    for (const pose of [motion.start, motion.end]) {
      if (
        pose.position.length !== 3 ||
        !pose.position.every(Number.isFinite) ||
        pose.orientation.length !== 4 ||
        !pose.orientation.every(Number.isFinite) ||
        Math.abs(Math.hypot(...pose.orientation) - 1) > 1e-6
      )
        fail('poses must have finite XYZ positions and unit quaternions');
      if (pose.frameId !== input.binding.frameId)
        fail('pose is not in the explicitly bound stock frame');
    }
    const a = new THREE.Quaternion(...motion.start.orientation).normalize();
    const b = new THREE.Quaternion(...motion.end.orientation).normalize();
    if (a.dot(b) < 0) b.set(-b.x, -b.y, -b.z, -b.w);
    if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z, a.w - b.w) > 1e-12)
      fail('changing orientations are unsupported; only continuous fixed-orientation sweeps');
    const poseMatrix = (position: readonly number[]) =>
      workpieceToStock
        .clone()
        .multiply(
          new THREE.Matrix4().compose(
            new THREE.Vector3(...position),
            a,
            new THREE.Vector3(1, 1, 1),
          ),
        );
    const start = poseMatrix(motion.start.position);
    const end = poseMatrix(motion.end.position);
    const cutter = new CuttingToolModel(motion.tool, motion.executedQ);
    const data = new Float32Array(GPU_SWEEP_STRIDE);
    let bounds: THREE.Box3;
    if (motion.mode === 'turning') {
      const volume = buildTurningSweep(cutter, start, end, spindleOrigin, spindleAxis);
      const section = volume.rotationalSection;
      if (!section?.planes?.length) fail('turning requires a validated convex meridian section');
      const planes = section!.planes!;
      if (planes.length > GPU_SWEEP_MAX_PLANES)
        fail(`turning section has ${planes.length} planes; maximum is ${GPU_SWEEP_MAX_PLANES}`);
      data[0] = 5;
      data.set(spindleOrigin.toArray(), 20);
      data[23] = section!.polygon.some((point) => point.x >= 0) ? 1 : 0;
      data.set(spindleAxis.toArray(), 24);
      data[27] = section!.polygon.some((point) => point.x <= 0) ? 1 : 0;
      data[28] = planes.length;
      data[30] = 1;
      planes.forEach((plane, i) => data.set([plane.x, plane.y, plane.offset, 0], 32 + i * 4));
      bounds = volume.bounds.clone();
    } else {
      const part = cutter.part;
      if (part.type === 'insert')
        throw new SimulationCapabilityError(
          `GPU sweep ${motionIndex}: insert milling is unsupported`,
        );
      data[0] =
        part.type === 'ballMill' ? 2 : part.type === 'drill' ? 3 : part.cornerRadius ? 4 : 1;
      data[1] = part.diameter / 2;
      data[2] = part.length;
      data[3] = part.type === 'endMill' ? (part.cornerRadius ?? 0) : 0;
      if (part.type === 'drill') {
        const angle = THREE.MathUtils.degToRad(part.tipAngle / 2);
        data[7] = Math.cos(angle);
        data[29] = Math.sin(angle);
      }
      const partMatrix = start.clone().multiply(cutter.partToAssembly);
      const inverse = partMatrix.clone().invert();
      const travel = new THREE.Vector3()
        .setFromMatrixPosition(end.clone().multiply(cutter.partToAssembly))
        .applyMatrix4(inverse);
      // Suppress only double-precision rigid-transform cancellation, not actual travel.
      const cancellation =
        32 * Number.EPSILON * Math.max(1, ...partMatrix.elements.map(Math.abs), travel.length());
      for (let axis = 0; axis < 3; axis++)
        if (Math.abs(travel.getComponent(axis)) < cancellation) travel.setComponent(axis, 0);
      const axial = travel.x === 0 && travel.y === 0;
      if (data[0] === 4 && !axial && travel.z !== 0)
        fail(
          'rounded endmills support only axial or lateral travel; diagonal rounded sweep unsupported',
        );
      data.set(travel.toArray(), 4);
      data[31] = axial && data[0] !== 2 ? 1 : 0;
      const e = inverse.elements;
      for (let row = 0; row < 3; row++)
        data.set([e[row], e[row + 4], e[row + 8], e[row + 12]], 8 + row * 4);
      // Gershgorin bound on R R^T compensates float32 affine rotation packing.
      let squaredBound = 1;
      for (let i = 0; i < 3; i++) {
        let rowSum = 0;
        for (let j = 0; j < 3; j++) {
          let dot = 0;
          for (let k = 0; k < 3; k++) dot += data[8 + i * 4 + k] * data[8 + j * 4 + k];
          rowSum += Math.abs(dot);
        }
        squaredBound = Math.max(squaredBound, rowSum);
      }
      // Rounding the bound downward must not invalidate the certificate.
      data[30] =
        Math.sqrt(squaredBound) *
        Math.max(1, part.type === 'drill' ? Math.hypot(data[7], data[29]) : 1) *
        (1 + 2 ** -23);
      bounds = cutter.bounds
        .clone()
        .applyMatrix4(start)
        .union(cutter.bounds.clone().applyMatrix4(end));
    }
    if (
      !data.every(Number.isFinite) ||
      [...bounds.min.toArray(), ...bounds.max.toArray()].some(
        (value) => !Number.isFinite(value) || Math.abs(value) > 1_000_000,
      )
    )
      fail('float32 geometry requires finite stock-local bounds within +/-1,000,000 mm');
    const magnitude = Math.max(
      1,
      ...bounds.min.toArray().map(Math.abs),
      ...bounds.max.toArray().map(Math.abs),
    );
    bounds.expandByScalar(magnitude * 2 ** -19);
    return { executionStep: motion.executionStep, motionIndex, bounds, data };
  });
}

type RadialTerm = readonly [number, number, number];
const clamp = (t: number): number => Math.max(0, Math.min(1, t));

/** Stable bounded quadratic roots. Extraneous squared-equation roots are harmless candidates. */
function quadratic(a: number, b: number, c: number, candidate: (t: number) => void): void {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (scale === 0) return;
  a /= scale;
  b /= scale;
  c /= scale;
  if (a === 0) {
    if (b !== 0) candidate(-c / b);
    return;
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return;
  const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(discriminant));
  if (q === 0) candidate(-b / (2 * a));
  else {
    candidate(q / a);
    candidate(c / q);
  }
}

/** CPU reference reads only the public float32 record, not hidden geometry metadata. */
export function evaluateGpuSweep(sweep: CompiledGpuSweep, point: THREE.Vector3): number {
  const d = sweep.data;
  if (d.length !== GPU_SWEEP_STRIDE || !point.toArray().every(Number.isFinite))
    throw new SimulationCapabilityError(
      'GPU sweep evaluation requires a full record and finite point',
    );
  if (d[0] === 5) {
    const axis = new THREE.Vector3(d[24], d[25], d[26]).normalize();
    const relative = point.clone().sub(new THREE.Vector3(d[20], d[21], d[22]));
    const axial = relative.dot(axis);
    const radial = relative.addScaledVector(axis, -axial).length();
    let positive = -1e30,
      negative = -1e30;
    for (let i = 0; i < d[28]; i++) {
      const offset = 32 + i * 4;
      // Float32 planes can round their unit normal upward.
      const norm = Math.max(1, Math.hypot(d[offset], d[offset + 1]));
      positive = Math.max(
        positive,
        (d[offset] * radial + d[offset + 1] * axial + d[offset + 2]) / norm,
      );
      negative = Math.max(
        negative,
        (-d[offset] * radial + d[offset + 1] * axial + d[offset + 2]) / norm,
      );
    }
    return Math.min(d[23] ? positive : 1e30, d[27] ? negative : 1e30);
  }
  const p = [0, 1, 2].map(
    (row) =>
      d[8 + row * 4] * point.x +
      d[9 + row * 4] * point.y +
      d[10 + row * 4] * point.z +
      d[11 + row * 4],
  );
  const [x, y, z] = p;
  const [dx, dy, dz] = d.slice(4, 7);
  const radius = d[1],
    length = d[2],
    corner = d[3];
  const field = (t: number, top = length, lower = 0): number => {
    const radial = Math.hypot(x - t * dx, y - t * dy);
    const axial = z - t * dz - lower;
    if (d[0] === 2)
      return Math.max(Math.hypot(radial, Math.min(axial - radius, 0)) - radius, axial - top);
    if (d[0] === 3)
      return Math.max(radial * d[7] - axial * d[29], radial - radius, -axial, axial - top);
    if (d[0] === 4) {
      const rounded = Math.max(
        Math.hypot(Math.max(radial - (radius - corner), 0), axial - corner) - corner,
        axial - corner,
      );
      return Math.max(Math.min(rounded, Math.max(radial - radius, corner - axial)), axial - top);
    }
    return Math.max(radial - radius, -axial, axial - top);
  };
  if (d[31]) {
    const low = Math.min(0, dz);
    return field(0, length + Math.max(0, dz) - low, low) / d[30];
  }
  const A = dx * dx + dy * dy,
    B = x * dx + y * dy,
    C = x * x + y * y;
  if (d[0] === 4) return field(A > 0 ? clamp(B / A) : 0) / d[30];
  let best = Math.min(field(0), field(1));
  const candidate = (t: number): void => {
    if (Number.isFinite(t) && t > 0 && t < 1) best = Math.min(best, field(t));
  };
  if (A > 0) candidate(B / A);
  if (d[0] === 2) {
    const squared = A + dz * dz;
    if (squared > 0) candidate((B + (z - radius) * dz) / squared);
    if (dz !== 0) candidate((z - radius) / dz);
    const cap = z - length + radius;
    quadratic(
      A,
      -2 * B + 2 * dz * (2 * radius - length),
      C + (length - 2 * radius) * (2 * z - length),
      candidate,
    );
    quadratic(A - dz * dz, -2 * B + 2 * cap * dz, C - cap * cap, candidate);
  } else {
    const terms: RadialTerm[] = [
      [1, 0, -radius],
      [0, -1, 0],
      [0, 1, -length],
    ];
    if (d[0] === 3) terms.push([d[7], -d[29], 0]);
    for (let i = 0; i < terms.length; i++) {
      const [alpha, beta] = terms[i];
      if (alpha !== 0 && A > 0) {
        const k = (beta * dz) / alpha;
        quadratic(A * (A - k * k), -2 * B * (A - k * k), B * B - k * k * C, candidate);
      }
      for (let j = 0; j < i; j++) {
        const u = alpha - terms[j][0];
        const v = beta - terms[j][1];
        const w = terms[i][2] - terms[j][2];
        const intercept = v * z + w,
          slope = -v * dz;
        if (u === 0) {
          if (slope !== 0) candidate(-intercept / slope);
        } else {
          quadratic(
            u * u * A - slope * slope,
            -2 * u * u * B - 2 * intercept * slope,
            u * u * C - intercept * intercept,
            candidate,
          );
        }
      }
    }
  }
  return best / d[30];
}

/** WGSL helpers use Three.js's global storage struct for browser portability. */
export const GPU_SWEEP_WGSL = /* wgsl */ `
const GPU_SWEEP_VEC4_STRIDE: u32 = ${GPU_SWEEP_STRIDE / 4}u;

fn gpuSweepPartField(p: vec3f, shape: vec4f, angle: vec2f) -> f32 {
  let r = length(p.xy);
  if (shape.x == 2.0) {
    return max(length(vec3f(p.xy, min(p.z - shape.y, 0.0))) - shape.y, p.z - shape.z);
  }
  if (shape.x == 3.0) {
    return max(max(r * angle.x - p.z * angle.y, r - shape.y), max(-p.z, p.z - shape.z));
  }
  if (shape.x == 4.0) {
    let rounded = max(length(vec2f(max(r - (shape.y - shape.w), 0.0), p.z - shape.w)) - shape.w, p.z - shape.w);
    return max(min(rounded, max(r - shape.y, shape.w - p.z)), p.z - shape.z);
  }
  return max(r - shape.y, max(-p.z, p.z - shape.z));
}

fn gpuSweepCandidate(t: f32, p: vec3f, travel: vec3f, shape: vec4f, angle: vec2f, best: f32) -> f32 {
  if (t > 0.0 && t < 1.0) { return min(best, gpuSweepPartField(p - t * travel, shape, angle)); }
  return best;
}

fn gpuSweepQuadratic(coeff: vec3f, p: vec3f, travel: vec3f, shape: vec4f, angle: vec2f, initial: f32) -> f32 {
  let scale = max(abs(coeff.x), max(abs(coeff.y), abs(coeff.z)));
  if (scale == 0.0) { return initial; }
  let c = coeff / scale;
  if (c.x == 0.0) {
    if (c.y != 0.0) { return gpuSweepCandidate(-c.z / c.y, p, travel, shape, angle, initial); }
    return initial;
  }
  let discriminant = c.y * c.y - 4.0 * c.x * c.z;
  if (discriminant < 0.0) { return initial; }
  let q = -0.5 * (c.y + select(1.0, -1.0, c.y < 0.0) * sqrt(discriminant));
  if (q == 0.0) { return gpuSweepCandidate(-c.y / (2.0 * c.x), p, travel, shape, angle, initial); }
  let best = gpuSweepCandidate(q / c.x, p, travel, shape, angle, initial);
  return gpuSweepCandidate(c.z / q, p, travel, shape, angle, best);
}

fn gpuSweepDistance(point: vec3f, sweep: u32) -> f32 {
  let base = sweep * GPU_SWEEP_VEC4_STRIDE;
  let shape = dexelRecords.value[base];
  let motion = dexelRecords.value[base + 1u];
  let sweepInfo = dexelRecords.value[base + 7u];
  if (shape.x == 5.0) {
    let origin = dexelRecords.value[base + 5u];
    let spindle = dexelRecords.value[base + 6u];
    let axis = normalize(spindle.xyz);
    let relative = point - origin.xyz;
    let axial = dot(relative, axis);
    let radial = length(relative - axial * axis);
    var positive = -1e30;
    var negative = -1e30;
    for (var i = 0u; i < u32(sweepInfo.x); i++) {
      let plane = dexelRecords.value[base + 8u + i];
      let divisor = max(1.0, length(plane.xy));
      positive = max(positive, (plane.x * radial + plane.y * axial + plane.z) / divisor);
      negative = max(negative, (-plane.x * radial + plane.y * axial + plane.z) / divisor);
    }
    return min(select(1e30, positive, origin.w != 0.0), select(1e30, negative, spindle.w != 0.0));
  }
  let homogeneous = vec4f(point, 1.0);
  var p = vec3f(dot(dexelRecords.value[base + 2u], homogeneous), dot(dexelRecords.value[base + 3u], homogeneous), dot(dexelRecords.value[base + 4u], homogeneous));
  let travel = motion.xyz;
  let angle = vec2f(motion.w, sweepInfo.y);
  if (sweepInfo.w != 0.0) {
    let low = min(0.0, travel.z);
    p.z -= low;
    return gpuSweepPartField(p, vec4f(shape.xy, shape.z + max(0.0, travel.z) - low, shape.w), angle) / sweepInfo.z;
  }
  let A = dot(travel.xy, travel.xy);
  let B = dot(p.xy, travel.xy);
  let C = dot(p.xy, p.xy);
  if (shape.x == 4.0) {
    var t = 0.0;
    if (A > 0.0) { t = clamp(B / A, 0.0, 1.0); }
    return gpuSweepPartField(p - t * travel, shape, angle) / sweepInfo.z;
  }
  var best = min(gpuSweepPartField(p, shape, angle), gpuSweepPartField(p - travel, shape, angle));
  if (A > 0.0) { best = gpuSweepCandidate(B / A, p, travel, shape, angle, best); }
  if (shape.x == 2.0) {
    let squared = dot(travel, travel);
    if (squared > 0.0) { best = gpuSweepCandidate((B + (p.z - shape.y) * travel.z) / squared, p, travel, shape, angle, best); }
    if (travel.z != 0.0) { best = gpuSweepCandidate((p.z - shape.y) / travel.z, p, travel, shape, angle, best); }
    let cap = p.z - shape.z + shape.y;
    best = gpuSweepQuadratic(vec3f(A, -2.0 * B + 2.0 * travel.z * (2.0 * shape.y - shape.z), C + (shape.z - 2.0 * shape.y) * (2.0 * p.z - shape.z)), p, travel, shape, angle, best);
    best = gpuSweepQuadratic(vec3f(A - travel.z * travel.z, -2.0 * B + 2.0 * cap * travel.z, C - cap * cap), p, travel, shape, angle, best);
  } else {
    var terms = array<vec3f, 4>(vec3f(1.0, 0.0, -shape.y), vec3f(0.0, -1.0, 0.0), vec3f(0.0, 1.0, -shape.z), vec3f(angle.x, -angle.y, 0.0));
    let count = select(3u, 4u, shape.x == 3.0);
    for (var i = 0u; i < count; i++) {
      let term = terms[i];
      if (term.x != 0.0 && A > 0.0) {
        let k = term.y * travel.z / term.x;
        best = gpuSweepQuadratic(vec3f(A * (A - k*k), -2.0 * B * (A - k*k), B*B - k*k*C), p, travel, shape, angle, best);
      }
      for (var j = 0u; j < i; j++) {
        let difference = term - terms[j];
        let intercept = difference.y * p.z + difference.z;
        let slope = -difference.y * travel.z;
        if (difference.x == 0.0) {
          if (slope != 0.0) { best = gpuSweepCandidate(-intercept / slope, p, travel, shape, angle, best); }
        } else {
          let u2 = difference.x * difference.x;
          best = gpuSweepQuadratic(vec3f(u2*A - slope*slope, -2.0*u2*B - 2.0*intercept*slope, u2*C - intercept*intercept), p, travel, shape, angle, best);
        }
      }
    }
  }
  return best / sweepInfo.z;
}
`;

export type GpuSweepRayCuts = [number, number][] | 99;

/**
 * Bounded ray intersection reference. Intervals include their boundary and are
 * sorted/disjoint. 99 means invalid input or interval/numerical overflow, never
 * an empty-success fallback. Parameters use origin + direction * t.
 *
 * Float32 GPU roots use a conservative boundary allowance of 1e-6 times the
 * local geometry/ray scale. This is arithmetic tolerance, not depth-pitch
 * stepping. The same allowance is used here. Tangent face rays produce a
 * bounded interval rather than an unbounded sequence of sphere-tracing steps.
 */
export function evaluateGpuSweepRayCuts(
  sweep: CompiledGpuSweep,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  limits: readonly [number, number],
): GpuSweepRayCuts {
  const data = sweep.data;
  const values = [...origin.toArray(), ...direction.toArray(), ...limits];
  if (
    data.length !== GPU_SWEEP_STRIDE ||
    !data.every(Number.isFinite) ||
    values.some((value) => !Number.isFinite(value) || Math.abs(value) >= 1e29) ||
    direction.lengthSq() === 0 ||
    limits[0] > limits[1] ||
    ![1, 2, 3, 4, 5].includes(data[0]) ||
    !(data[30] >= 1)
  )
    return 99;
  const first = origin.clone().addScaledVector(direction, limits[0]);
  const travel = direction.clone().multiplyScalar(limits[1] - limits[0]);
  const last = first.clone().add(travel);
  if (
    [...first.toArray(), ...travel.toArray(), ...last.toArray()].some(
      (value) => !Number.isFinite(value) || Math.abs(value) > 10_000_000,
    )
  )
    return 99;
  const epsilon =
    1e-6 *
    Math.max(
      1,
      data[1],
      data[2],
      travel.length(),
      ...first.toArray().map(Math.abs),
      ...last.toArray().map(Math.abs),
    );
  const convert = (intervals: [number, number][]): [number, number][] =>
    intervals.map(([low, high]) => [
      limits[0] + low * (limits[1] - limits[0]),
      limits[0] + high * (limits[1] - limits[0]),
    ]);
  if (data[0] !== 5) {
    const at = (t: number): number => {
      const point = first.clone().addScaledVector(travel, t);
      if (data[0] !== 4) return evaluateGpuSweep(sweep, point);
      // The existing rounded field has an internal zero seam at its equator.
      // Use a convex field with the same cutter boundary for ray localization.
      const p = new THREE.Vector3(
        data[8] * point.x + data[9] * point.y + data[10] * point.z + data[11],
        data[12] * point.x + data[13] * point.y + data[14] * point.z + data[15],
        data[16] * point.x + data[17] * point.y + data[18] * point.z + data[19],
      );
      let top = data[2];
      if (data[31]) {
        const low = Math.min(0, data[6]);
        p.z -= low;
        top += Math.max(0, data[6]) - low;
      } else {
        const squared = data[4] ** 2 + data[5] ** 2;
        const t = squared ? clamp((p.x * data[4] + p.y * data[5]) / squared) : 0;
        p.x -= t * data[4];
        p.y -= t * data[5];
      }
      return (
        Math.max(
          Math.hypot(
            Math.max(Math.hypot(p.x, p.y) - (data[1] - data[3]), 0),
            Math.min(p.z - data[3], 0),
          ) - data[3],
          p.z - top,
        ) / data[30]
      );
    };
    let low = 0,
      high = 1;
    for (let iteration = 0; iteration < 48; iteration++) {
      const a = low + (high - low) / 3;
      const b = high - (high - low) / 3;
      const fa = at(a),
        fb = at(b);
      if (!Number.isFinite(fa) || !Number.isFinite(fb)) return 99;
      if (fa <= fb) high = b;
      else low = a;
    }
    let middle = (low + high) / 2;
    let minimum = at(middle);
    const left = at(0),
      right = at(1);
    if (![minimum, left, right].every(Number.isFinite)) return 99;
    if (left < minimum) {
      minimum = left;
      middle = 0;
    }
    if (right < minimum) {
      minimum = right;
      middle = 1;
    }
    if (minimum > epsilon) {
      // A 1-Lipschitz field cannot fall by more than this unresolved bracket.
      return minimum - travel.length() * (high - low) > epsilon ? [] : 99;
    }
    let entry = 0,
      exit = 1;
    if (left > epsilon) {
      let outside = 0,
        inside = middle;
      for (let iteration = 0; iteration < 28; iteration++) {
        const t = (outside + inside) / 2;
        if (at(t) <= epsilon) inside = t;
        else outside = t;
      }
      entry = outside;
    }
    if (right > epsilon) {
      let inside = middle,
        outside = 1;
      for (let iteration = 0; iteration < 28; iteration++) {
        const t = (inside + outside) / 2;
        if (at(t) <= epsilon) inside = t;
        else outside = t;
      }
      exit = outside;
    }
    return convert([[entry, exit]]);
  }
  const count = data[28];
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > GPU_SWEEP_MAX_PLANES ||
    (!data[23] && !data[27])
  )
    return 99;
  const axis = new THREE.Vector3(data[24], data[25], data[26]);
  if (axis.lengthSq() === 0) return 99;
  axis.normalize();
  const relative = first.clone().sub(new THREE.Vector3(data[20], data[21], data[22]));
  const z0 = relative.dot(axis),
    zd = travel.dot(axis);
  const radial0 = relative.addScaledVector(axis, -z0);
  const radialD = travel.clone().addScaledVector(axis, -zd);
  const A = radialD.lengthSq(),
    B = 2 * radial0.dot(radialD),
    C = radial0.lengthSq();
  let result: [number, number][] = [];
  for (const sign of [1, -1]) {
    if (!(sign === 1 ? data[23] : data[27])) continue;
    let intervals: [number, number][] = [[0, 1]];
    for (let i = 0; i < count; i++) {
      const offset = 32 + i * 4;
      const a = sign * data[offset],
        b = data[offset + 1];
      const normalSquared = a * a + b * b;
      if (!(normalSquared > 0) || normalSquared > 4) return 99;
      const c = data[offset + 2] - epsilon * Math.max(1, Math.hypot(a, b));
      const q0 = b * z0 + c,
        qd = b * zd;
      const breaks = [0, 1];
      const root = (t: number) => {
        if (t > 0 && t < 1 && Number.isFinite(t)) breaks.push(t);
      };
      if (qd !== 0) root(-q0 / qd);
      quadratic(a * a * A - qd * qd, a * a * B - 2 * q0 * qd, a * a * C - q0 * q0, root);
      breaks.sort((x, y) => x - y);
      const accepted = (t: number) =>
        a * radial0.clone().addScaledVector(radialD, t).length() + q0 + qd * t <= 0;
      const plane: [number, number][] = [];
      for (let j = 0; j < breaks.length; j++) {
        if (accepted(breaks[j])) plane.push([breaks[j], breaks[j]]);
        if (j + 1 < breaks.length && accepted((breaks[j] + breaks[j + 1]) / 2))
          plane.push([breaks[j], breaks[j + 1]]);
      }
      const intersections: [number, number][] = [];
      for (const interval of intervals)
        for (const allowed of mergeRayIntervals(plane)) {
          const low = Math.max(interval[0], allowed[0]);
          const high = Math.min(interval[1], allowed[1]);
          if (low <= high) intersections.push([low, high]);
        }
      intervals = mergeRayIntervals(intersections);
      if (intervals.length > 4) return 99;
      if (!intervals.length) break;
    }
    result = mergeRayIntervals([...result, ...intervals]);
  }
  return result.length > 4 ? 99 : convert(result);
}

function mergeRayIntervals(intervals: [number, number][]): [number, number][] {
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const result: [number, number][] = [];
  for (const interval of intervals) {
    const last = result[result.length - 1];
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else result.push([...interval]);
  }
  return result;
}

/**
 * Include after GPU_SWEEP_WGSL. Fixed work, no depth stepping. Milling clips
 * convex translation fields by bracketed minimization/root localization.
 * Turning partitions the ray at axial and quadratic plane roots, clips every
 * plane analytically, then unions the positive/reflected meridian branches.
 */
export const GPU_SWEEP_RAY_WGSL = /* wgsl */ `
fn gpuRayAppend(interval: vec2f, output: ptr<function,array<vec2f,4>>, count: u32) -> u32 {
  if (count == 99u) { return 99u; }
  if (interval.x > interval.y) { return count; }
  if (count > 0u && interval.x <= (*output)[count - 1u].y) {
    (*output)[count - 1u].y = max((*output)[count - 1u].y, interval.y);
    return count;
  }
  if (count >= 4u) { return 99u; }
  (*output)[count] = interval;
  return count + 1u;
}

fn gpuRayRoot(t: f32, roots: ptr<function,array<f32,5>>, count: u32) -> u32 {
  if (t > 0.0 && t < 1.0) {
    (*roots)[count] = t;
    return count + 1u;
  }
  return count;
}

fn gpuRayQuadratic(coeff: vec3f, roots: ptr<function,array<f32,5>>, initialCount: u32) -> u32 {
  let scale = max(abs(coeff.x), max(abs(coeff.y), abs(coeff.z)));
  if (scale == 0.0) { return initialCount; }
  let c = coeff / scale;
  if (c.x == 0.0) {
    if (c.y != 0.0) { return gpuRayRoot(-c.z / c.y, roots, initialCount); }
    return initialCount;
  }
  let discriminant = c.y * c.y - 4.0 * c.x * c.z;
  if (discriminant < 0.0) { return initialCount; }
  let q = -0.5 * (c.y + select(1.0, -1.0, c.y < 0.0) * sqrt(discriminant));
  if (q == 0.0) { return gpuRayRoot(-c.y / (2.0 * c.x), roots, initialCount); }
  let count = gpuRayRoot(q / c.x, roots, initialCount);
  return gpuRayRoot(c.z / q, roots, count);
}

fn gpuRayRoundedField(point: vec3f, base: u32) -> f32 {
  let shape = dexelRecords.value[base];
  let motion = dexelRecords.value[base + 1u];
  let sweepInfo = dexelRecords.value[base + 7u];
  let h = vec4f(point, 1.0);
  var p = vec3f(dot(dexelRecords.value[base + 2u], h), dot(dexelRecords.value[base + 3u], h), dot(dexelRecords.value[base + 4u], h));
  var top = shape.z;
  if (sweepInfo.w != 0.0) {
    let low = min(0.0, motion.z);
    p.z -= low;
    top += max(0.0, motion.z) - low;
  } else {
    let squared = dot(motion.xy, motion.xy);
    var t = 0.0;
    if (squared > 0.0) { t = clamp(dot(p.xy, motion.xy) / squared, 0.0, 1.0); }
    p.x -= t * motion.x;
    p.y -= t * motion.y;
  }
  return max(length(vec2f(max(length(p.xy) - (shape.y - shape.w), 0.0), min(p.z - shape.w, 0.0))) - shape.w, p.z - top) / sweepInfo.z;
}

fn gpuRayField(point: vec3f, sweep: u32) -> f32 {
  let base = sweep * GPU_SWEEP_VEC4_STRIDE;
  if (dexelRecords.value[base].x == 4.0) { return gpuRayRoundedField(point, base); }
  return gpuSweepDistance(point, sweep);
}

fn gpuRayPlaneInside(t: f32, a: f32, q: vec2f, radialOrigin: vec3f, radialTravel: vec3f) -> bool {
  return a * length(radialOrigin + t * radialTravel) + q.x + q.y * t <= 0.0;
}

fn gpuSweepRayCuts(origin:vec3f,direction:vec3f,limits:vec2f,sweep:u32,cuts:ptr<function,array<vec2f,4>>) -> u32 {
  if (!all(abs(origin) < vec3f(1e29)) || !all(abs(direction) < vec3f(1e29)) ||
      !all(abs(limits) < vec2f(1e29)) || dot(direction,direction) == 0.0 || limits.x > limits.y ||
      sweep >= arrayLength(&dexelRecords.value) / GPU_SWEEP_VEC4_STRIDE) { return 99u; }
  let base = sweep * GPU_SWEEP_VEC4_STRIDE;
  let shape = dexelRecords.value[base];
  let sweepInfo = dexelRecords.value[base + 7u];
  if (!all(abs(shape) < vec4f(1e29)) || !all(abs(sweepInfo) < vec4f(1e29)) ||
      shape.x < 1.0 || shape.x > 5.0 || shape.x != floor(shape.x) || !(sweepInfo.z >= 1.0)) { return 99u; }
  let first = origin + direction * limits.x;
  let travel = direction * (limits.y - limits.x);
  let finish = first + travel;
  if (!all(abs(first) <= vec3f(1e7)) || !all(abs(travel) <= vec3f(1e7)) ||
      !all(abs(finish) <= vec3f(1e7))) { return 99u; }
  let coordinates = max(abs(first),abs(finish));
  let epsilon = 1e-6 * max(max(1.0,max(shape.y,shape.z)),max(length(travel),max(coordinates.x,max(coordinates.y,coordinates.z))));
  if (shape.x != 5.0) {
    var low = 0.0;
    var high = 1.0;
    for (var iteration = 0u; iteration < 48u; iteration++) {
      let a = low + (high-low)/3.0;
      let b = high - (high-low)/3.0;
      let fa = gpuRayField(first + a*travel,sweep);
      let fb = gpuRayField(first + b*travel,sweep);
      if (!(abs(fa) < 1e29) || !(abs(fb) < 1e29)) { return 99u; }
      if (fa <= fb) { high = b; } else { low = a; }
    }
    var middle = (low+high)*0.5;
    var minimum = gpuRayField(first + middle*travel,sweep);
    let left = gpuRayField(first,sweep);
    let right = gpuRayField(finish,sweep);
    if (!(abs(minimum) < 1e29) || !(abs(left) < 1e29) || !(abs(right) < 1e29)) { return 99u; }
    if (left < minimum) { minimum = left; middle = 0.0; }
    if (right < minimum) { minimum = right; middle = 1.0; }
    if (minimum > epsilon) {
      if (minimum - length(travel)*(high-low) > epsilon) { return 0u; }
      return 99u;
    }
    var entry = 0.0;
    var exit = 1.0;
    if (left > epsilon) {
      var outside = 0.0;
      var inside = middle;
      for (var iteration = 0u; iteration < 28u; iteration++) {
        let t = (outside+inside)*0.5;
        if (gpuRayField(first+t*travel,sweep) <= epsilon) { inside=t; } else { outside=t; }
      }
      entry = outside;
    }
    if (right > epsilon) {
      var inside = middle;
      var outside = 1.0;
      for (var iteration = 0u; iteration < 28u; iteration++) {
        let t = (inside+outside)*0.5;
        if (gpuRayField(first+t*travel,sweep) <= epsilon) { inside=t; } else { outside=t; }
      }
      exit = outside;
    }
    (*cuts)[0] = vec2f(limits.x) + vec2f(entry,exit)*(limits.y-limits.x);
    return 1u;
  }
  let sectionOrigin = dexelRecords.value[base+5u];
  let spindle = dexelRecords.value[base+6u];
  if (sweepInfo.x < 1.0 || sweepInfo.x > ${GPU_SWEEP_MAX_PLANES}.0 || sweepInfo.x != floor(sweepInfo.x) ||
      (sectionOrigin.w == 0.0 && spindle.w == 0.0) || !(dot(spindle.xyz,spindle.xyz) > 0.0)) { return 99u; }
  let axis = normalize(spindle.xyz);
  let relative = first-sectionOrigin.xyz;
  let z0 = dot(relative,axis);
  let zd = dot(travel,axis);
  let radialOrigin = relative-z0*axis;
  let radialTravel = travel-zd*axis;
  let A = dot(radialTravel,radialTravel);
  let B = 2.0*dot(radialOrigin,radialTravel);
  let C = dot(radialOrigin,radialOrigin);
  var combined: array<vec2f,8>;
  var combinedCount = 0u;
  for (var branch=0u; branch<2u; branch++) {
    if ((branch == 0u && sectionOrigin.w == 0.0) || (branch == 1u && spindle.w == 0.0)) { continue; }
    let radialSign = select(1.0,-1.0,branch == 1u);
    var intervals: array<vec2f,4>;
    intervals[0] = vec2f(0.0,1.0);
    var intervalCount = 1u;
    for (var planeIndex=0u; planeIndex<u32(sweepInfo.x); planeIndex++) {
      let plane = dexelRecords.value[base+8u+planeIndex];
      if (!all(abs(plane.xyz) < vec3f(1e29))) { return 99u; }
      let normalSquared = dot(plane.xy,plane.xy);
      if (!(normalSquared > 0.0) || normalSquared > 4.0) { return 99u; }
      let a = radialSign*plane.x;
      let q0 = plane.y*z0+plane.z-epsilon*max(1.0,length(plane.xy));
      let qd = plane.y*zd;
      var roots: array<f32,5>;
      roots[0]=0.0;
      roots[1]=1.0;
      var rootCount=2u;
      if (qd != 0.0) { rootCount=gpuRayRoot(-q0/qd,&roots,rootCount); }
      rootCount=gpuRayQuadratic(vec3f(a*a*A-qd*qd,a*a*B-2.0*q0*qd,a*a*C-q0*q0),&roots,rootCount);
      for (var i=1u;i<rootCount;i++) {
        var j=i;
        loop {
          if (j == 0u || roots[j-1u] <= roots[j]) { break; }
          let saved=roots[j-1u]; roots[j-1u]=roots[j]; roots[j]=saved;
          j--;
        }
      }
      var allowed: array<vec2f,4>;
      var allowedCount=0u;
      for (var i=0u;i<rootCount;i++) {
        let t=roots[i];
        if (gpuRayPlaneInside(t,a,vec2f(q0,qd),radialOrigin,radialTravel)) {
          allowedCount=gpuRayAppend(vec2f(t,t),&allowed,allowedCount);
        }
        if (i+1u<rootCount && gpuRayPlaneInside((t+roots[i+1u])*0.5,a,vec2f(q0,qd),radialOrigin,radialTravel)) {
          allowedCount=gpuRayAppend(vec2f(t,roots[i+1u]),&allowed,allowedCount);
        }
        if (allowedCount == 99u) { return 99u; }
      }
      var nextIntervals: array<vec2f,4>;
      var nextCount=0u;
      for (var i=0u;i<intervalCount;i++) {
        for (var j=0u;j<allowedCount;j++) {
          let clipped=vec2f(max(intervals[i].x,allowed[j].x),min(intervals[i].y,allowed[j].y));
          nextCount=gpuRayAppend(clipped,&nextIntervals,nextCount);
          if (nextCount == 99u) { return 99u; }
        }
      }
      intervals=nextIntervals;
      intervalCount=nextCount;
      if (intervalCount == 0u) { break; }
    }
    for (var i=0u;i<intervalCount;i++) {
      if (combinedCount >= 8u) { return 99u; }
      combined[combinedCount]=intervals[i];
      combinedCount++;
    }
  }
  for (var i=1u;i<combinedCount;i++) {
    var j=i;
    loop {
      if (j == 0u || combined[j-1u].x <= combined[j].x) { break; }
      let saved=combined[j-1u]; combined[j-1u]=combined[j]; combined[j]=saved;
      j--;
    }
  }
  var count=0u;
  for (var i=0u;i<combinedCount;i++) {
    count=gpuRayAppend(combined[i],cuts,count);
    if (count == 99u) { return 99u; }
  }
  for (var i=0u;i<count;i++) { (*cuts)[i]=vec2f(limits.x)+(*cuts)[i]*(limits.y-limits.x); }
  return count;
}
`;
