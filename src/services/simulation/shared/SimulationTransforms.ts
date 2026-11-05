import * as THREE from 'three';
import type { PlotMetadata, PoseSample } from '@core/types';
import type {
  DeepReadonly,
  MaterialChannelId,
  ProgramMaterialChannelReference,
  ProgramMaterialDefinition,
  Vector3,
} from '@services/tools/SimulationMetadata';
import { validateProgramMaterial } from '@services/tools/SimulationMetadata';
import type { StockBinding } from './SimulationTypes';

export function rotationQuaternion(rotation: readonly number[]): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...(rotation.map(THREE.MathUtils.degToRad) as [number, number, number]), 'ZYX'),
  );
}

export function materialSize(material: DeepReadonly<ProgramMaterialDefinition>): Vector3 {
  return material.type === 'box'
    ? [material.width, material.height, material.depth]
    : [material.diameter, material.diameter, material.length];
}

export function getChannelMaterialReference(
  material: DeepReadonly<ProgramMaterialDefinition>,
  channelId: MaterialChannelId = '1',
): ProgramMaterialChannelReference {
  const override = material.channelReferences?.[channelId];
  if (override) {
    return {
      ...(override.zeroVertex !== undefined ? { zeroVertex: override.zeroVertex } : {}),
      ...(override.position ? { position: [...override.position] as Vector3 } : {}),
      ...(override.rotation ? { rotation: [...override.rotation] as Vector3 } : {}),
    };
  }
  return {
    ...(material.zeroVertex !== undefined ? { zeroVertex: material.zeroVertex } : {}),
    ...(material.position ? { position: [...material.position] as Vector3 } : {}),
    ...(material.rotation ? { rotation: [...material.rotation] as Vector3 } : {}),
  };
}

export function channelMaterial(
  material: DeepReadonly<ProgramMaterialDefinition>,
  channelId: MaterialChannelId = '1',
): ProgramMaterialDefinition {
  validateProgramMaterial(material);
  const ref = getChannelMaterialReference(material, channelId);
  const base =
    material.type === 'box'
      ? {
          type: 'box' as const,
          width: material.width,
          height: material.height,
          depth: material.depth,
        }
      : {
          type: 'cylinder' as const,
          diameter: material.diameter,
          length: material.length,
        };
  return {
    ...base,
    ...(ref.zeroVertex !== undefined ? { zeroVertex: ref.zeroVertex } : {}),
    ...(ref.position?.some((v) => v !== 0) ? { position: [...ref.position] as Vector3 } : {}),
    ...(ref.rotation?.some((v) => v !== 0) ? { rotation: [...ref.rotation] as Vector3 } : {}),
  };
}

export function hasDistinctChannelReference(
  material: DeepReadonly<ProgramMaterialDefinition>,
  channelId: MaterialChannelId,
): boolean {
  if (channelId === '1') return false;
  const ref1 = getChannelMaterialReference(material, '1');
  const refC = getChannelMaterialReference(material, channelId);
  const pos1 = ref1.position ?? [0, 0, 0];
  const posC = refC.position ?? [0, 0, 0];
  const rot1 = ref1.rotation ?? [0, 0, 0];
  const rotC = refC.rotation ?? [0, 0, 0];
  return (
    (ref1.zeroVertex ?? null) !== (refC.zeroVertex ?? null) ||
    pos1.some((v, i) => v !== posC[i]) ||
    rot1.some((v, i) => v !== rotC[i])
  );
}

export function oppositeMaterialZeroVertex(
  material: DeepReadonly<Pick<ProgramMaterialDefinition, 'type'>>,
  zeroVertex?: number,
): number {
  if (material.type === 'cylinder') {
    return zeroVertex === 0 ? 1 : 0;
  }
  return zeroVertex === undefined ? 0 : (zeroVertex ^ 4) & 7;
}

export function pickupChannelMaterialReference(
  material: DeepReadonly<ProgramMaterialDefinition>,
  baseChannelId: MaterialChannelId = '1',
): ProgramMaterialChannelReference {
  const base = getChannelMaterialReference(material, baseChannelId);
  const baseRotation = base.rotation ?? [0, 0, 0];
  const nextRx = ((baseRotation[0] + 180) % 360 + 360) % 360;
  const rotation: Vector3 = [nextRx, baseRotation[1], baseRotation[2]];
  return {
    zeroVertex: oppositeMaterialZeroVertex(material, base.zeroVertex),
    ...(rotation.some((v) => v !== 0) ? { rotation } : {}),
  };
}

function cleanScalar(value: number): number {
  if (Math.abs(value) < 1e-14) return 0;
  if (Math.abs(value - 1) < 1e-14) return 1;
  if (Math.abs(value + 1) < 1e-14) return -1;
  return Object.is(value, -0) ? 0 : value;
}

function cleanMatrix4(matrix: THREE.Matrix4): THREE.Matrix4 {
  for (let i = 0; i < 16; i++) {
    matrix.elements[i] = cleanScalar(matrix.elements[i]);
  }
  return matrix;
}

export function channelPlotTransform(
  material: DeepReadonly<ProgramMaterialDefinition>,
  channelId: MaterialChannelId,
): THREE.Matrix4 {
  validateProgramMaterial(material);
  if (!hasDistinctChannelReference(material, channelId)) {
    return new THREE.Matrix4();
  }
  const primaryPlacement = materialPlacement(channelMaterial(material, '1'));
  const channelPlacement = materialPlacement(channelMaterial(material, channelId));
  return cleanMatrix4(primaryPlacement.multiply(channelPlacement.invert()));
}

function transformPoseArray(
  poses: readonly DeepReadonly<PoseSample>[],
  transform: THREE.Matrix4,
  rotation: THREE.Quaternion,
  targetFrameId?: string,
): PoseSample[] {
  let previousOrientation: THREE.Quaternion | undefined;
  return poses.map((pose) => {
    const position = new THREE.Vector3(...pose.position)
      .applyMatrix4(transform)
      .toArray()
      .map(cleanScalar) as [number, number, number];
    const orientationQuat = new THREE.Quaternion(...pose.orientation)
      .premultiply(rotation)
      .normalize();
    if (previousOrientation && orientationQuat.dot(previousOrientation) < 0) {
      orientationQuat.set(
        -orientationQuat.x,
        -orientationQuat.y,
        -orientationQuat.z,
        -orientationQuat.w,
      );
    }
    previousOrientation = orientationQuat.clone();
    const orientation = [
      cleanScalar(orientationQuat.x),
      cleanScalar(orientationQuat.y),
      cleanScalar(orientationQuat.z),
      cleanScalar(orientationQuat.w),
    ] as [number, number, number, number];
    return {
      ...(structuredClone(pose) as PoseSample),
      position,
      orientation,
      ...(targetFrameId ? { frameId: targetFrameId } : {}),
    };
  });
}

export function transformPlotMetadataForChannel(
  metadata: PlotMetadata,
  material: DeepReadonly<ProgramMaterialDefinition>,
  channelId: MaterialChannelId,
  targetFrameId?: string,
): PlotMetadata {
  if (!hasDistinctChannelReference(material, channelId)) {
    return metadata;
  }
  const transform = channelPlotTransform(material, channelId);
  const rotation = new THREE.Quaternion().setFromRotationMatrix(transform).normalize();
  const transformCoords = <T extends { x: number; y: number; z: number }>(point: T): T => {
    const v = new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(transform);
    return {
      ...point,
      x: cleanScalar(v.x),
      y: cleanScalar(v.y),
      z: cleanScalar(v.z),
    };
  };
  return {
    ...metadata,
    points: metadata.points.map(transformCoords),
    segments: metadata.segments.map((segment) => ({
      ...segment,
      startPoint: transformCoords(segment.startPoint),
      endPoint: transformCoords(segment.endPoint),
      ...(segment.poses
        ? { poses: transformPoseArray(segment.poses, transform, rotation, targetFrameId) }
        : {}),
    })),
    ...(metadata.executionOccurrences
      ? {
          executionOccurrences: metadata.executionOccurrences.map((occurrence) => ({
            ...occurrence,
            ...(occurrence.toolState?.poses
              ? {
                  toolState: {
                    ...occurrence.toolState,
                    poses: transformPoseArray(
                      occurrence.toolState.poses,
                      transform,
                      rotation,
                      targetFrameId,
                    ),
                  },
                }
              : {}),
          })),
        }
      : {}),
  };
}

export function materialPlacement(
  material: DeepReadonly<ProgramMaterialDefinition>,
): THREE.Matrix4 {
  validateProgramMaterial(material);
  const size = materialSize(material);
  const origin = new THREE.Vector3();
  if (material.zeroVertex !== undefined) {
    if (material.type === 'cylinder') {
      origin.z = ((material.zeroVertex === 0 ? -1 : 1) * material.length) / 2;
    } else {
      origin.set(
        ...(size.map(
          (length, axis) => ((material.zeroVertex! & (1 << axis) ? 1 : -1) * length) / 2,
        ) as Vector3),
      );
    }
  }
  const orientation = rotationQuaternion(material.rotation ?? [0, 0, 0]);
  const centre = new THREE.Vector3(...(material.position ?? [0, 0, 0])).sub(
    origin.applyQuaternion(orientation),
  );
  return new THREE.Matrix4().compose(centre, orientation, new THREE.Vector3(1, 1, 1));
}

export function validateStockBinding(binding: DeepReadonly<StockBinding>): void {
  if (typeof binding.frameId !== 'string' || !binding.frameId.trim()) {
    throw new Error('Select the workpiece frame for the stock');
  }
  for (const vector of [
    binding.position,
    binding.rotation,
    binding.spindleOrigin,
    binding.spindleAxis,
  ]) {
    if (
      !Array.isArray(vector) ||
      vector.length !== 3 ||
      vector.some((value) => !Number.isFinite(value) || Math.abs(value) > 1_000_000)
    ) {
      throw new Error('Stock binding requires finite, bounded XYZ vectors');
    }
  }
  if (Math.abs(Math.hypot(...binding.spindleAxis) - 1) > 1e-6) {
    throw new Error('Stock spindle axis must be a unit direction');
  }
}

export function stockPlacement(
  material: DeepReadonly<ProgramMaterialDefinition>,
  binding: DeepReadonly<StockBinding>,
): THREE.Matrix4 {
  validateStockBinding(binding);
  const programToWorkpiece = new THREE.Matrix4().compose(
    new THREE.Vector3(...binding.position),
    rotationQuaternion(binding.rotation),
    new THREE.Vector3(1, 1, 1),
  );
  return programToWorkpiece.multiply(materialPlacement(material));
}
