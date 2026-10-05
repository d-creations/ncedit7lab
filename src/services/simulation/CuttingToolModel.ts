import * as THREE from 'three';
import type { CuttingPart, DeepReadonly, ProgramToolDefinition } from '../tools/SimulationMetadata';
import { validateProgramTool } from '../tools/SimulationMetadata';
import { buildInsertContour } from '../tools/InsertOutline';
import { getInsertQShift, TURN_Q_VECTORS } from './TurningReference';
import { rotationQuaternion } from './SimulationTransforms';
import { SimulationCapabilityError } from './SimulationTypes';

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

  constructor(tool: DeepReadonly<ProgramToolDefinition>, executedQ?: number) {
    validateProgramTool(tool);
    if (tool.cutting?.length !== 1)
      throw new SimulationCapabilityError('Removal currently requires exactly one cutting part');
    this.part = tool.cutting[0];
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
}
