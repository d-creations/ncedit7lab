import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ToolGeometryFactory } from '../ToolGeometryFactory';
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
    expect(geometry.boundingBox!.min.z).toBeLessThanOrEqual(0.001);
    expect(geometry.boundingBox!.min.x).toBeLessThan(0);
    expect(geometry.boundingBox!.max.x).toBeGreaterThan(0);
    const worldMinZ = (insert as THREE.Mesh).position.z + geometry.boundingBox!.min.z;
    expect(worldMinZ).toBeLessThanOrEqual(0.001);

    const holder = meshes.find((mesh) => mesh.material instanceof THREE.MeshStandardMaterial && mesh.material.color.getHexString() === 'f4c542');
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
    expect(geometry.boundingBox!.min.z).toBeLessThanOrEqual(0.001);
    expect(geometry.boundingBox!.max.z).toBeGreaterThan(0);
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

  it('creates a material mesh for box and cylinder material definitions', () => {
    const factory = new ToolGeometryFactory();
    const box = factory.createMaterialMesh({ type: 'box', width: 100, depth: 60, height: 20, position: [50, 30, -10] });
    const cylinder = factory.createMaterialMesh({ type: 'cylinder', diameter: 40, length: 100, position: [0, 0, -50] });

    expect(box).toBeTruthy();
    expect(cylinder).toBeTruthy();
    expect(box!.children[0]).toBeInstanceOf(THREE.Mesh);
    expect(cylinder!.children[0]).toBeInstanceOf(THREE.Mesh);
  });
});
