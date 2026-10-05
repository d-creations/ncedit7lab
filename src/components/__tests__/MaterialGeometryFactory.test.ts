import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { getMaterialPickPoints, MaterialGeometryFactory } from '../MaterialGeometryFactory';
import { validateProgramMaterial, type ProgramMaterialDefinition } from '@services/tools/SimulationMetadata';

const factory = new MaterialGeometryFactory();
const plate = { type: 'box', width: 100, height: 20, depth: 60 } as const;
const round = { type: 'cylinder', diameter: 40, length: 100 } as const;

function bounds(material: ProgramMaterialDefinition): THREE.Box3 {
  const group = factory.create(material);
  const box = new THREE.Box3().setFromObject(group);
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) object.geometry.dispose();
  });
  return box;
}

describe('MaterialGeometryFactory', () => {
  it.each(Array.from({ length: 8 }, (_, index) => index))('anchors plate corner %s at the program zero', (zeroVertex) => {
    const material = { ...plate, zeroVertex };
    const points = getMaterialPickPoints(material);
    expect(points).toHaveLength(8);
    expect(points.filter((point) => point.active)).toHaveLength(1);
    expect(points[zeroVertex].position).toEqual([0, 0, 0]);
    const box = bounds(material);
    expect(box.getSize(new THREE.Vector3()).toArray()).toEqual([100, 20, 60]);
    expect(zeroVertex & 1 ? box.max.x : box.min.x).toBe(0);
    expect(zeroVertex & 2 ? box.max.y : box.min.y).toBe(0);
    expect(zeroVertex & 4 ? box.max.z : box.min.z).toBe(0);
  });

  it.each([0, 1])('anchors round end %s at the program zero', (zeroVertex) => {
    const material = { ...round, zeroVertex };
    const points = getMaterialPickPoints(material);
    expect(points).toHaveLength(2);
    expect(points[zeroVertex]).toMatchObject({ active: true, position: [0, 0, 0] });
    const box = bounds(material);
    expect(zeroVertex ? box.max.z : box.min.z).toBeCloseTo(0);
    expect(box.getSize(new THREE.Vector3()).z).toBeCloseTo(100);
  });

  it.each([plate, round])('preserves legacy centre placement for $type', (material) => {
    const placed = { ...material, position: [10, 20, 30] as [number, number, number] };
    expect(bounds(placed).getCenter(new THREE.Vector3()).toArray()).toEqual([10, 20, 30]);
    expect(getMaterialPickPoints(placed).some((point) => point.active)).toBe(false);
  });

  it.each([plate, round])('rotates $type about the selected point before translating', (material) => {
    const placed: ProgramMaterialDefinition = { ...material, zeroVertex: 1, rotation: [90, 0, 0], position: [10, 20, 30] };
    const points = getMaterialPickPoints(placed);
    points[1].position.forEach((value, index) => expect(value).toBeCloseTo([10, 20, 30][index], 12));
    const box = bounds(placed);
    points.forEach((point) => {
      const p = new THREE.Vector3(...point.position);
      expect(box.clone().expandByScalar(0.00001).containsPoint(p)).toBe(true);
    });
    const expected = material.type === 'box' ? [100, 60, 20] : [40, 100, 40];
    box.getSize(new THREE.Vector3()).toArray().forEach((value, index) => expect(value).toBeCloseTo(expected[index]));
  });

  it.each([
    { ...plate, zeroVertex: -1 }, { ...plate, zeroVertex: 8 }, { ...plate, zeroVertex: 0.5 },
    { ...round, zeroVertex: 2 }, { ...round, zeroVertex: NaN },
    { ...round, diameter: 0 }, { ...plate, height: Infinity },
  ])('rejects invalid dimensions and zero points: %o', (material) => {
    expect(() => validateProgramMaterial(material)).toThrow();
    expect(() => factory.create(material)).toThrow();
  });
});
