import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { getInsertPickPoints, getInsertQShift, ToolGeometryFactory } from '../ToolGeometryFactory';
import type { ProgramToolDefinition } from '@services/tools/SimulationMetadata';

describe('ToolGeometryFactory', () => {
  it('keeps a profile holder and insert reference at the local tip/origin', () => {
    const factory = new ToolGeometryFactory();
    const tool: ProgramToolDefinition = {
      toolNumber: 2,
      description: 'Turning tool',
      holder: [{ type: 'profile', points: [[0, 2], [15, 4], [30, 2]] }],
      cutting: [{ type: 'insert', shape: 'D', ic: 12, thickness: 3, noseRadius: 0.4, clearanceAngle: 7 }],
    };

    const group = factory.create(tool);
    expect(group).toBeTruthy();
    expect(group!.children.length).toBeGreaterThan(1);

    const meshes = group!.children.filter((child) => child instanceof THREE.Mesh);
    const insert = meshes.find((mesh) => mesh.material instanceof THREE.MeshStandardMaterial && mesh.material.color.getHexString() === 'f4c542');
    expect(insert).toBeTruthy();
    const geometry = (insert as THREE.Mesh).geometry as THREE.BufferGeometry;
    geometry.computeBoundingBox();
    expect(geometry.boundingBox).toBeTruthy();
    expect(geometry.boundingBox!.min.z).toBeGreaterThanOrEqual(-0.001);
    expect(geometry.boundingBox!.min.z).toBeLessThan(1);
    expect(geometry.boundingBox!.min.x).toBeLessThan(0);
    expect(geometry.boundingBox!.max.x).toBeGreaterThan(0);
    const worldMinZ = (insert as THREE.Mesh).position.z + geometry.boundingBox!.min.z;
    expect(worldMinZ).toBeGreaterThanOrEqual(-0.001);

    // The holder is added after the cutting part.
    const holder = meshes[1];
    expect(holder).toBeTruthy();
    expect(meshes.every((mesh) => mesh.material instanceof THREE.MeshStandardMaterial && mesh.material.color.getHexString() === 'f4c542')).toBe(true);
    const holderGeometry = (holder as THREE.Mesh).geometry as THREE.BufferGeometry;
    holderGeometry.computeBoundingBox();
    expect(holderGeometry.boundingBox).toBeTruthy();
    expect(holderGeometry.boundingBox!.min.z).toBeLessThanOrEqual(0.001);
  });

  it.each(['C', 'D', 'V', 'W', 'T', 'S', 'R', 'E', 'H', 'O', 'P', 'L', 'A', 'B', 'K'] as const)('keeps insert %s aligned to a local virtual tip', (shape) => {
    const factory = new ToolGeometryFactory();
    const tool: ProgramToolDefinition = {
      toolNumber: 10,
      description: `Shape ${shape}`,
      cutting: [{ type: 'insert', shape, ic: 12, thickness: 3, noseRadius: 0.4, clearanceAngle: 7 }],
    };

    const group = factory.create(tool);
    expect(group).toBeTruthy();
    const mesh = group!.children.find((child) => child instanceof THREE.Mesh) as THREE.Mesh | undefined;
    expect(mesh).toBeTruthy();

    const geometry = mesh!.geometry as THREE.BufferGeometry;
    geometry.computeBoundingBox();
    expect(geometry.boundingBox).toBeTruthy();
    // The rounded solid stays behind the sharp virtual tip, which is the origin.
    expect(geometry.boundingBox!.min.z).toBeGreaterThanOrEqual(-0.001);
    expect(geometry.boundingBox!.min.z).toBeLessThan(1);
    expect(geometry.boundingBox!.max.z).toBeGreaterThan(0);
    expect(getInsertPickPoints(tool).find((point) => point.active)?.position).toEqual([0, 0, 0]);
  });

  it.each(['endMill', 'drill'] as const)('puts %s cutting zero at the front of the tool', (type) => {
    const factory = new ToolGeometryFactory();
    const cutting = type === 'drill'
      ? { type, diameter: 8, length: 48, tipAngle: 118 }
      : { type, diameter: 8, length: 24 };
    const group = factory.create({ toolNumber: 1, description: type, cutting: [cutting] });
    const mesh = group!.children[0] as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.z).toBeCloseTo(0, 6);
    expect(geometry.boundingBox!.max.z).toBeCloseTo(cutting.length, 6);
  });

  it('applies the declared extrinsic tool orientation to the complete assembly', () => {
    const factory = new ToolGeometryFactory();
    const group = factory.create({
      toolNumber: 1,
      description: 'Oriented turning insert',
      orientation: [90, 90, 0],
      cutting: [{ type: 'insert', shape: 'A', ic: 9.525, thickness: 2.18, noseRadius: 0.4, clearanceAngle: 7 }],
    });

    expect(group).toBeTruthy();
    expect(group!.rotation.order).toBe('ZYX');
    expect(group!.rotation.x).toBeCloseTo(Math.PI / 2);
    expect(group!.rotation.y).toBeCloseTo(Math.PI / 2);
    expect(group!.rotation.z).toBeCloseTo(0);
  });

  it('keeps a box holder length on local Z without a hidden rotation', () => {
    const factory = new ToolGeometryFactory();
    const group = factory.create({
      toolNumber: 1,
      description: 'Turning holder',
      holder: [{ type: 'box', width: 12, height: 12, length: 39, position: [6, 20, -6] }],
      cutting: [{ type: 'insert', shape: 'A', ic: 3.525, thickness: 2.18, noseRadius: 0.4, clearanceAngle: 7 }],
    });
    const holder = group!.children.find((child) => child instanceof THREE.Mesh && child.position.x === 6) as THREE.Mesh;

    expect(holder.rotation.toArray()).toEqual([0, 0, 0, 'XYZ']);
    const geometry = holder.geometry as THREE.BufferGeometry;
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.getSize(new THREE.Vector3()).z).toBeCloseTo(39);
  });

  it('keeps the chosen zero vertex at the origin when the plate is turned around Y', () => {
    const insert = { type: 'insert', shape: 'D', ic: 9.525, thickness: 3.18, noseRadius: 0.4, clearanceAngle: 7 } as const;
    for (const zeroVertex of [0, 1, 2, 3]) {
      for (const turn of [0, 90, 180]) {
        const points = getInsertPickPoints({ toolNumber: 1, description: '', cutting: [{ ...insert, zeroVertex, rotation: [0, turn, 0] }] });
        const active = points.filter((point) => point.active);
        expect(active.map((point) => point.index)).toEqual([zeroVertex]);
        active[0].position.forEach((value) => expect(value).toBeCloseTo(0, 9));
      }
    }
  });

  it('turns the plate in its own plane when rotated 180 degrees around Y', () => {
    const insert = { type: 'insert', shape: 'A', ic: 9.525, thickness: 3.18, noseRadius: 0.4, clearanceAngle: 7, width: 6, length: 12.5 } as const;
    const plain = getInsertPickPoints({ toolNumber: 1, description: '', cutting: [insert] });
    const turned = getInsertPickPoints({ toolNumber: 1, description: '', cutting: [{ ...insert, rotation: [0, 180, 0] }] });
    plain.forEach((point, index) => {
      expect(turned[index].position[0]).toBeCloseTo(-point.position[0], 9);
      expect(turned[index].position[1]).toBeCloseTo(point.position[1], 9);
      expect(turned[index].position[2]).toBeCloseTo(-point.position[2], 9);
    });
  });

  it('rounds only the cutting vertex of the plate mesh', () => {
    const factory = new ToolGeometryFactory();
    const build = (noseRadius: number) => {
      const group = factory.create({ toolNumber: 1, description: '', cutting: [{ type: 'insert', shape: 'S', ic: 10, thickness: 3, noseRadius, clearanceAngle: 7, zeroVertex: 0 }] });
      return (group!.children[0] as THREE.Mesh).geometry as THREE.BufferGeometry;
    };
    const sharp = build(0);
    const rounded = build(1);
    expect(rounded.getAttribute('position').count).toBeGreaterThan(sharp.getAttribute('position').count);
    const corners = (geometry: THREE.BufferGeometry) => {
      const position = geometry.getAttribute('position');
      const seen = new Set<string>();
      for (let index = 0; index < position.count; index++) {
        seen.add([position.getX(index), position.getZ(index)].map((value) => value.toFixed(4)).join(','));
      }
      return seen;
    };
    // Only the zero corner at (0,0) is replaced by an arc; all other outline corners survive.
    const sharpCorners = corners(sharp);
    const roundedCorners = corners(rounded);
    expect(roundedCorners.has('0.0000,0.0000')).toBe(false);
    sharpCorners.delete('0.0000,0.0000');
    sharpCorners.forEach((corner) => expect(roundedCorners.has(corner)).toBe(true));
  });

  it('seats a turning holder profile directly below the plate and keeps its outline in tool X/Z', () => {
    const factory = new ToolGeometryFactory();
    const group = factory.create({
      toolNumber: 1,
      description: '',
      holder: [{ type: 'turningHolderProfile', width: 12, depth: 12, outline: [[-0.5, 1], [-0.5, 40], [-12.5, 40], [-12.5, 9]] }],
      cutting: [{ type: 'insert', shape: 'D', ic: 9.525, thickness: 3, noseRadius: 0.4, clearanceAngle: 7 }],
    });
    const holder = group!.children[1] as THREE.Mesh;
    const box = new THREE.Box3().setFromObject(holder);
    expect(box.max.y).toBeCloseTo(-1.5, 6);
    expect(box.min.y).toBeCloseTo(-13.5, 6);
    expect(box.min.x).toBeCloseTo(-12.5, 6);
    expect(box.max.x).toBeCloseTo(-0.5, 6);
    expect(box.max.z).toBeCloseTo(40, 6);
  });

  it('creates a material mesh for box and cylinder material definitions', () => {
    const factory = new ToolGeometryFactory();
    const box = factory.createMaterialMesh({ type: 'box', width: 100, depth: 60, height: 20, position: [50, 30, -10] });
    const cylinder = factory.createMaterialMesh({ type: 'cylinder', diameter: 40, length: 100, position: [0, 0, -50] });

    expect(box).toBeTruthy();
    expect(cylinder).toBeTruthy();
    expect(box!.children[0]).toBeInstanceOf(THREE.Mesh);
    expect(cylinder!.children[0]).toBeInstanceOf(THREE.Mesh);
  });

  it('shifts the assembly according to Q so the theoretical tool tip is at the origin', () => {
    const factory = new ToolGeometryFactory();
    const toolQ3 = {
      toolNumber: 1,
      description: 'V insert Q3',
      Q: 3,
      cutting: [{ type: 'insert', shape: 'V', ic: 9.525, thickness: 3.18, noseRadius: 0.4, clearanceAngle: 7, rotation: [0, -69.5, 0] }],
    } as const;
    const shiftQ3 = getInsertQShift(toolQ3);
    expect(shiftQ3.x).toBeCloseTo(1.646, 3);
    expect(shiftQ3.z).toBeCloseTo(-0.066, 3);

    const groupQ3 = factory.create(toolQ3);
    const meshQ3 = groupQ3!.children[0] as THREE.Mesh;
    expect(meshQ3.position.x).toBeCloseTo(shiftQ3.x, 3);
    expect(meshQ3.position.z).toBeCloseTo(shiftQ3.z, 3);

    const toolQ0 = { ...toolQ3, Q: 0 };
    const shiftQ0 = getInsertQShift(toolQ0);
    expect(shiftQ0.x).toBeCloseTo(1.246, 3);
    expect(shiftQ0.z).toBeCloseTo(-0.466, 3);

    const toolNoQ = { ...toolQ3, Q: undefined };
    const shiftNoQ = getInsertQShift(toolNoQ);
    expect(shiftNoQ.x).toBe(0);
    expect(shiftNoQ.z).toBe(0);
  });
});
