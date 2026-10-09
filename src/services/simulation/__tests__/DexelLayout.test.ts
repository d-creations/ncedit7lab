import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createDexelLayout,
  DEXEL_INTERVALS,
  DEXEL_MEMORY_BYTES,
  indexDexelTiles,
  subtractDexelInterval,
} from '../DexelLayout';
import type { CompiledGpuSweep } from '../GpuSweepCompiler';

describe('bounded tiled tri-dexel layout', () => {
  it('uses three projected ray grids, padded only to 32-ray tiles', () => {
    const layout = createDexelLayout(new THREE.Vector3(2, 3, 4), 0.1);
    expect(layout.dimensions.toArray()).toEqual([20, 30, 40]);
    expect(layout.tileCounts).toEqual([2, 2, 1]);
    expect(layout.rays).toBe(5 * 1024);
    expect(layout.intervalBytes).toBe(layout.rays * DEXEL_INTERVALS * 8);
    expect(layout.estimatedBytes).toBeGreaterThan(layout.intervalBytes * 2);
  });
  it('fits 20 mm cubic stock at 0.02 mm without pretending 1 micron global stock is cheap', () => {
    expect(createDexelLayout(new THREE.Vector3(20, 20, 20), 0.02).estimatedBytes).toBeLessThan(
      DEXEL_MEMORY_BYTES,
    );
    expect(() => createDexelLayout(new THREE.Vector3(20, 20, 20), 0.001)).toThrow(/larger pitch/);
    expect(() => createDexelLayout(new THREE.Vector3(100, 100, 100), 0.02)).toThrow(/larger pitch/);
  });
  it.each([0, -1, NaN, Infinity, 0.0001, 6])('rejects invalid pitch %s', (pitch) => {
    expect(() => createDexelLayout(new THREE.Vector3(2, 2, 2), pitch)).toThrow();
  });
  it.each([0, -1, NaN, Infinity])('rejects invalid stock dimension %s', (size) => {
    expect(() => createDexelLayout(new THREE.Vector3(size, 2, 2), 0.1)).toThrow();
  });
  it('indexes every intersected projected tile in sweep order and excludes disjoint stock', () => {
    const layout = createDexelLayout(new THREE.Vector3(8, 8, 8), 0.1);
    const sweep = (bounds: THREE.Box3): CompiledGpuSweep => ({
      bounds,
      data: new Float32Array(0),
      motionIndex: 0,
      executionStep: 1,
    });
    const index = indexDexelTiles(layout, [
      sweep(new THREE.Box3(new THREE.Vector3(-4, -4, -4), new THREE.Vector3(4, 4, 4))),
      sweep(new THREE.Box3(new THREE.Vector3(10, 10, 10), new THREE.Vector3(11, 11, 11))),
      sweep(new THREE.Box3(new THREE.Vector3(-0.1, -0.1, -0.1), new THREE.Vector3(0.1, 0.1, 0.1))),
    ]);
    for (let tile = 0; tile < layout.tiles; tile++) {
      const [start, count] = index.ranges.subarray(tile * 2, tile * 2 + 2);
      const list = [...index.sweeps.subarray(start, start + count)];
      expect(list[0]).toBe(0);
      expect(list).not.toContain(1);
      expect(list).toEqual([...list].sort((a, b) => a - b));
    }
    expect([...index.sweeps]).toContain(2);
  });
});

describe('multi-interval material subtraction', () => {
  it('retains both sides of a through cut, cavities, and an earlier hole after later cuts', () => {
    const first = subtractDexelInterval([[-2, 2]], [-0.2, 0.2]);
    expect(first).toEqual([
      [-2, -0.2],
      [0.2, 2],
    ]);
    expect(subtractDexelInterval(first, [1, 3])).toEqual([
      [-2, -0.2],
      [0.2, 1],
    ]);
    expect(subtractDexelInterval(first, [-3, 3])).toEqual([]);
  });
  it('does not erase material for a tangent or zero-length intersection', () => {
    expect(subtractDexelInterval([[0, 1]], [1, 2])).toEqual([[0, 1]]);
    expect(subtractDexelInterval([[0, 1]], [0.5, 0.5])).toEqual([[0, 1]]);
  });
  it('reports overflow rather than truncating thin walls', () => {
    expect(() =>
      subtractDexelInterval(
        [
          [0, 1],
          [2, 3],
          [4, 5],
          [6, 7],
        ],
        [0.4, 0.6],
      ),
    ).toThrow(/intervals/);
  });
  it('rejects nonfinite or inverted intervals explicitly', () => {
    expect(() => subtractDexelInterval([[0, 1]], [NaN, 2])).toThrow(/Invalid/);
    expect(() => subtractDexelInterval([[1, 0]], [0, 2])).toThrow(/Invalid/);
  });
});
