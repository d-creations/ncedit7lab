import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createDexelLayout,
  DEXEL_INTERVALS,
  DEXEL_MEMORY_BYTES,
  type DexelIntervalCapacity,
  indexDexelTiles,
  dexelTilesForBounds,
  originalDexelSpan,
  subtractDexelInterval,
} from '../DexelLayout';
import type { CompiledGpuSweep } from '../GpuSweepCompiler';

describe('bounded tiled tri-dexel layout', () => {
  it('reconstructs untouched box/cylinder rays consistently on all axes, including padded and empty rays', () => {
    const layout = createDexelLayout(new THREE.Vector3(2, 2, 2), 0.1, 16, { bounds: [] });
    expect(originalDexelSpan(layout, 0, false)).toEqual([-1, 1]);
    expect(originalDexelSpan(layout, 1024, false)).toEqual([-1, 1]);
    expect(originalDexelSpan(layout, 2048, false)).toEqual([-1, 1]);
    const span = originalDexelSpan(layout, 0, true)!;
    expect(span[0]).toBeCloseTo(-Math.sqrt(1 - 0.95 ** 2), 12);
    expect(span[1]).toBeCloseTo(Math.sqrt(1 - 0.95 ** 2), 12);
    expect(originalDexelSpan(layout, 2048, true)).toBeUndefined();
    expect(originalDexelSpan(layout, 2048 + 9 + 9 * 32, true)).toEqual([-1, 1]);
    expect(originalDexelSpan(layout, 31, false)).toBeUndefined();
    expect(() => originalDexelSpan(layout, layout.rays, false)).toThrow(/Invalid GPU dexel ray/);
  });
  it('allocates intervals only for conservatively touched tiles without changing the fine ray grid', () => {
    const size = new THREE.Vector3(20, 20, 20);
    const bounds = new THREE.Box3(
      new THREE.Vector3(-0.1, -0.1, -0.1),
      new THREE.Vector3(0.1, 0.1, 0.1),
    );
    const dense = createDexelLayout(size, 0.02, 4);
    const sparse = createDexelLayout(size, 0.02, 16, { bounds: [bounds] });
    expect(sparse.dimensions.equals(dense.dimensions)).toBe(true);
    expect(sparse.rays).toBe(dense.rays);
    expect(sparse.storedTiles.length).toBeLessThan(dense.tiles / 100);
    expect(sparse.intervalBytes).toBe(sparse.storageRays * 16 * 8);
    expect(sparse.estimatedBytes).toBeLessThan(dense.estimatedBytes / 4);
    expect([...sparse.storedTiles]).toEqual(
      dexelTilesForBounds(sparse, bounds).sort((a, b) => a - b),
    );
    const extended = createDexelLayout(size, 0.02, 32, {
      retainedTiles: sparse.storedTiles,
      bounds: [new THREE.Box3(new THREE.Vector3(9, 9, 9), new THREE.Vector3(10, 10, 10))],
    });
    for (const tile of sparse.storedTiles) expect(extended.storedTiles).toContain(tile);
  });
  it('keeps untouched stock implicit but still bounds full ray metadata', () => {
    const empty = createDexelLayout(new THREE.Vector3(20, 20, 20), 0.02, 64, { bounds: [] });
    expect(empty.storageRays).toBe(0);
    expect(empty.intervalBytes).toBe(64 * 8);
    expect(() =>
      createDexelLayout(new THREE.Vector3(100, 100, 100), 0.001, 16, { bounds: [] }),
    ).toThrow(/metadata/);
    expect(() =>
      createDexelLayout(new THREE.Vector3(2, 2, 2), 0.1, 16, {
        bounds: [],
        retainedTiles: new Uint32Array([99]),
      }),
    ).toThrow(/Invalid retained GPU tile/);
  });
  it.each([4, 8, 16, 32, 64] as DexelIntervalCapacity[])(
    'accounts for %i intervals without changing pitch or ray dimensions',
    (capacity) => {
      const layout = createDexelLayout(new THREE.Vector3(2, 3, 4), 0.1, capacity);
      expect(layout.intervalCapacity).toBe(capacity);
      expect(layout.intervalBytes).toBe(layout.rays * capacity * 8);
      expect(layout.dimensions.toArray()).toEqual([20, 30, 40]);
      expect(layout.pitchMm).toBe(0.1);
    },
  );
  it('checks storage and total-memory limits using the requested interval capacity', () => {
    expect(createDexelLayout(new THREE.Vector3(20, 20, 20), 0.02, 4).estimatedBytes).toBeLessThan(
      DEXEL_MEMORY_BYTES,
    );
    expect(() => createDexelLayout(new THREE.Vector3(20, 20, 20), 0.02, 8)).toThrow(/larger pitch/);
  });
  it('uses three projected ray grids, padded only to 32-ray tiles', () => {
    const layout = createDexelLayout(new THREE.Vector3(2, 3, 4), 0.1);
    expect(layout.dimensions.toArray()).toEqual([20, 30, 40]);
    expect(layout.tileCounts).toEqual([2, 2, 1]);
    expect(layout.rays).toBe(5 * 1024);
    expect(layout.intervalBytes).toBe(layout.rays * DEXEL_INTERVALS * 8);
    expect(layout.estimatedBytes).toBeGreaterThan(layout.intervalBytes * 2);
  });
  it('fits an explicit compact layout without pretending higher capacities or global micron stock are cheap', () => {
    expect(createDexelLayout(new THREE.Vector3(20, 20, 20), 0.02, 4).estimatedBytes).toBeLessThan(
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
        Array.from({ length: DEXEL_INTERVALS }, (_, i): [number, number] => [2 * i, 2 * i + 1]),
        [0.4, 0.6],
      ),
    ).toThrow(/intervals/);
  });
  it('rejects nonfinite or inverted intervals explicitly', () => {
    expect(() => subtractDexelInterval([[0, 1]], [NaN, 2])).toThrow(/Invalid/);
    expect(() => subtractDexelInterval([[1, 0]], [0, 2])).toThrow(/Invalid/);
  });
});
