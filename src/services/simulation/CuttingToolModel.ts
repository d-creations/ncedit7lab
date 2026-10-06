import * as THREE from 'three';
import type { CuttingPart, DeepReadonly, ProgramToolDefinition } from '../tools/SimulationMetadata';
import { validateProgramTool } from '../tools/SimulationMetadata';
import { buildInsertContour } from '../tools/InsertOutline';
import { getInsertQShift, TURN_Q_VECTORS } from './TurningReference';
import { rotationQuaternion } from './SimulationTransforms';
import { SimulationCapabilityError } from './SimulationTypes';
import type { ImplicitVolume } from './ImplicitGeometry';
import { BallMillSweep } from './BallMillSweep';

export function pointInPolygon(x: number, y: number, polygon: readonly THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j],
      b = polygon[i];
    const cross = (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
    if (
      Math.abs(cross) < 1e-9 &&
      x >= Math.min(a.x, b.x) - 1e-9 &&
      x <= Math.max(a.x, b.x) + 1e-9 &&
      y >= Math.min(a.y, b.y) - 1e-9 &&
      y <= Math.max(a.y, b.y) + 1e-9
    )
      return true;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function cuttingRadiusAt(
  part: DeepReadonly<Exclude<CuttingPart, { type: 'insert' }>>,
  z: number,
): number {
  const radius = part.diameter / 2;
  if (part.type === 'drill') {
    const tipLength = radius / Math.tan(THREE.MathUtils.degToRad(part.tipAngle / 2));
    return radius * Math.min(1, z / tipLength);
  }
  if (part.type === 'ballMill' && z < radius) {
    return Math.sqrt(Math.max(0, radius ** 2 - (z - radius) ** 2));
  }
  if (part.type === 'endMill' && part.cornerRadius && z < part.cornerRadius) {
    const corner = part.cornerRadius;
    return radius - corner + Math.sqrt(Math.max(0, corner ** 2 - (z - corner) ** 2));
  }
  return radius;
}

export class CuttingToolModel {
  readonly part: DeepReadonly<CuttingPart>;
  readonly partToAssembly: THREE.Matrix4;
  readonly assemblyToPart: THREE.Matrix4;
  readonly bounds: THREE.Box3;
  readonly sweepRadius: number;
  readonly insertSection?: THREE.Vector3[];
  private readonly point = new THREE.Vector3();
  private readonly ballField?: BallMillSweep;

  constructor(tool: DeepReadonly<ProgramToolDefinition>, executedQ?: number) {
    validateProgramTool(tool);
    if (tool.cutting?.length !== 1)
      throw new SimulationCapabilityError('Removal currently requires exactly one cutting part');
    this.part = tool.cutting[0];
    if (this.part.type === 'ballMill')
      this.ballField = new BallMillSweep(this.part.diameter / 2, this.part.length);
    const effective = { ...tool, Q: executedQ ?? tool.Q };
    if (
      this.part.type === 'insert' &&
      effective.Q !== undefined &&
      (!Number.isInteger(effective.Q) || !TURN_Q_VECTORS[effective.Q])
    ) {
      throw new SimulationCapabilityError(
        'Turning preview supports only explicit Q values 0 through 9',
      );
    }
    const shift = this.part.type === 'insert' ? getInsertQShift(effective) : new THREE.Vector3();
    const position = new THREE.Vector3(...(this.part.position ?? [0, 0, 0])).add(shift);
    this.partToAssembly = new THREE.Matrix4().compose(
      position,
      rotationQuaternion(this.part.rotation ?? [0, 0, 0]),
      new THREE.Vector3(1, 1, 1),
    );
    this.assemblyToPart = this.partToAssembly.clone().invert();
    if (this.part.type === 'insert') {
      const contour = buildInsertContour(this.part, tool.turning?.activeCorner);
      if (contour.radiusCenter && contour.zeroIndex !== undefined) {
        const [x, z] = contour.contour[contour.zeroIndex];
        const radius = Math.hypot(x - contour.radiusCenter[0], z - contour.radiusCenter[1]);
        if (Math.abs(radius - this.part.noseRadius) > 1e-6) {
          throw new SimulationCapabilityError(
            'Insert nose radius exceeds the supported outline fillet',
          );
        }
      }
      if (
        this.part.shape === 'R' &&
        effective.Q !== undefined &&
        effective.Q !== 0 &&
        effective.Q !== 9
      ) {
        throw new SimulationCapabilityError(
          'Round insert Q mounting requires a separately verified reference',
        );
      }
      this.insertSection = contour.contour.map(([x, z]) =>
        new THREE.Vector3(x, 0, z).applyMatrix4(this.partToAssembly),
      );
      this.bounds = new THREE.Box3().setFromPoints(this.insertSection);
      this.bounds.expandByScalar(this.part.thickness / 2);
    } else {
      const radius = this.part.diameter / 2;
      this.bounds = new THREE.Box3(
        new THREE.Vector3(-radius, -radius, 0),
        new THREE.Vector3(radius, radius, this.part.length),
      ).applyMatrix4(this.partToAssembly);
    }
    this.sweepRadius = Math.max(
      this.bounds.min.length(),
      this.bounds.max.length(),
      ...[this.bounds.min.x, this.bounds.max.x].flatMap((x) =>
        [this.bounds.min.y, this.bounds.max.y].flatMap((y) =>
          [this.bounds.min.z, this.bounds.max.z].map((z) => Math.hypot(x, y, z)),
        ),
      ),
    );
  }

  containsAssembly(point: THREE.Vector3): boolean {
    const part = this.part;
    if (part.type === 'insert')
      throw new Error('An insert requires the conventional-turning envelope');
    this.point.copy(point).applyMatrix4(this.assemblyToPart);
    const z = this.point.z;
    if (z < 0 || z > part.length) return false;
    const cuttingRadius = cuttingRadiusAt(part, z);
    return this.point.x ** 2 + this.point.y ** 2 <= cuttingRadius ** 2;
  }

  private distancePart(point: THREE.Vector3, length?: number): number {
    const part = this.part;
    if (part.type === 'insert') throw new Error('An insert requires the turning envelope');
    const radius = part.diameter / 2;
    const top = length ?? part.length;
    const radial = Math.hypot(point.x, point.y);
    const z = point.z;
    if (part.type === 'ballMill')
      return Math.max(Math.hypot(radial, Math.min(z - radius, 0)) - radius, z - top);
    if (part.type === 'drill') {
      const halfAngle = THREE.MathUtils.degToRad(part.tipAngle / 2);
      return Math.max(
        radial * Math.cos(halfAngle) - z * Math.sin(halfAngle),
        radial - radius,
        -z,
        z - top,
      );
    }
    const corner = part.cornerRadius ?? 0;
    if (corner > 0) {
      const rounded = Math.max(
        Math.hypot(Math.max(radial - (radius - corner), 0), z - corner) - corner,
        z - corner,
      );
      const upper = Math.max(radial - radius, corner - z);
      return Math.max(Math.min(rounded, upper), z - top);
    }
    return Math.max(radial - radius, -z, z - top);
  }

  volume(matrix: THREE.Matrix4): ImplicitVolume {
    const partMatrix = matrix.clone().multiply(this.partToAssembly);
    const inverse = partMatrix.clone().invert();
    const point = new THREE.Vector3();
    const field = this.ballField;
    return {
      bounds: this.bounds.clone().applyMatrix4(matrix),
      identity: JSON.stringify(['pose', this.part, inverse.elements]),
      distance: (value) => this.distancePart(point.copy(value).applyMatrix4(inverse)),
      normal: field
        ? (value, target) => {
            field.evaluate(point.copy(value).applyMatrix4(inverse), target);
            return target.transformDirection(partMatrix);
          }
        : undefined,
    };
  }

  /** Continuous fixed-orientation sweeps for balls, axial travel and flat-mill lateral travel. */
  translationSweep(start: THREE.Matrix4, end: THREE.Matrix4): ImplicitVolume | undefined {
    if (this.part.type === 'insert') return undefined;
    const inverse = start.clone().multiply(this.partToAssembly).invert();
    const endOrigin = new THREE.Vector3()
      .setFromMatrixPosition(end.clone().multiply(this.partToAssembly))
      .applyMatrix4(inverse);
    const point = new THREE.Vector3();
    const bounds = this.bounds
      .clone()
      .applyMatrix4(start)
      .union(this.bounds.clone().applyMatrix4(end));
    if (this.part.type === 'ballMill') {
      const field = new BallMillSweep(this.part.diameter / 2, this.part.length, endOrigin);
      const partMatrix = start.clone().multiply(this.partToAssembly);
      let sweepCoverage: ImplicitVolume['sweepCoverage'];
      if (endOrigin.lengthSq() > 0) {
        const direction = endOrigin.clone().normalize();
        const largest = direction.toArray().map(Math.abs);
        if (direction.getComponent(largest.indexOf(Math.max(...largest))) < 0) direction.negate();
        const axis = direction.clone().transformDirection(partMatrix);
        const origin = new THREE.Vector3().setFromMatrixPosition(partMatrix);
        const finish = new THREE.Vector3().setFromMatrixPosition(
          end.clone().multiply(this.partToAssembly),
        );
        const lower = origin.dot(axis),
          upper = finish.dot(axis);
        const lineMoment = origin.clone().cross(axis);
        sweepCoverage = {
          key: JSON.stringify([
            'ballLinear',
            this.part,
            inverse.elements.slice(0, 12),
            direction.toArray(),
            lineMoment.toArray(),
          ]),
          axis,
          lower: Math.min(lower, upper),
          upper: Math.max(lower, upper),
          partial: endOrigin.z === 0,
          projected: endOrigin.z === 0,
        };
      }
      return {
        bounds,
        identity: JSON.stringify(['ballLinear', this.part, inverse.elements, endOrigin.toArray()]),
        sweepCoverage,
        distance: (value) => field.evaluate(point.copy(value).applyMatrix4(inverse)),
        normal: (value, target) => {
          field.evaluate(point.copy(value).applyMatrix4(inverse), target);
          return target.transformDirection(partMatrix);
        },
      };
    }
    if (Math.hypot(endOrigin.x, endOrigin.y) < 1e-9) {
      const lower = Math.min(0, endOrigin.z),
        upper = Math.max(0, endOrigin.z);
      const length = this.part.length;
      return {
        bounds,
        identity: JSON.stringify(['axial', this.part, inverse.elements, lower, upper]),
        axialCoverage:
          this.part.type === 'endMill' && !this.part.cornerRadius
            ? {
                key: JSON.stringify([
                  this.part.diameter,
                  ...inverse.elements.slice(0, 12),
                  inverse.elements[12],
                  inverse.elements[13],
                ]),
                axis: new THREE.Vector3(
                  inverse.elements[2],
                  inverse.elements[6],
                  inverse.elements[10],
                ),
                lower: lower - inverse.elements[14],
                upper: length + upper - inverse.elements[14],
              }
            : undefined,
        distance: (value) => {
          point.copy(value).applyMatrix4(inverse);
          point.z -= lower;
          return this.distancePart(point, length + upper - lower);
        },
      };
    }
    if (this.part.type !== 'endMill' || this.part.cornerRadius || Math.abs(endOrigin.z) > 1e-9)
      return undefined;
    const length = this.part.length,
      radius = this.part.diameter / 2;
    const squared = endOrigin.x ** 2 + endOrigin.y ** 2;
    return {
      bounds,
      identity: JSON.stringify(['lateral', this.part, inverse.elements, endOrigin.toArray()]),
      distance: (value) => {
        point.copy(value).applyMatrix4(inverse);
        const t = THREE.MathUtils.clamp(
          (point.x * endOrigin.x + point.y * endOrigin.y) / squared,
          0,
          1,
        );
        return Math.max(
          Math.hypot(point.x - t * endOrigin.x, point.y - t * endOrigin.y) - radius,
          -point.z,
          point.z - length,
        );
      },
    };
  }
}
