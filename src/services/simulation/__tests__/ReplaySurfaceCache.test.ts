import { describe, expect, it } from 'vitest';
import { ReplaySurfaceCache, REPLAY_SURFACE_BYTES } from '../ReplaySurfaceCache';
import type { StockSurfaceChunk } from '../SimulationTypes';

function chunk(id: number, value = 1): StockSurfaceChunk {
  return {
    id,
    positions: new Float32Array(9).fill(value),
    normals: new Float32Array(9).fill(0.5),
  };
}

describe('bounded versioned surface history', () => {
  it('shares unchanged and byte-identical versions across state manifests', () => {
    const cache = new ReplaySurfaceCache();
    const a = chunk(1),
      b = chunk(2);
    expect(cache.retain(0, [a, b], () => true)).toBe(true);
    const initial = cache.bytes;
    expect(cache.retain(1, [a, chunk(2)], () => true)).toBe(true);
    expect(cache.versionCount).toBe(2);
    expect(cache.get(1)?.[1]).toBe(b);
    expect(cache.bytes - initial).toBe(256 + 2 * 32);
    const changed = chunk(2, 2);
    cache.retain(2, [a, changed], () => true);
    expect(cache.versionCount).toBe(3);
    expect(cache.get(0)).toEqual([a, b]);
    expect(cache.get(2)).toEqual([a, changed]);
  });

  it('compares normals and signed-zero bits rather than just positions or numerical equality', () => {
    const cache = new ReplaySurfaceCache();
    const a = chunk(1, 0);
    const b = chunk(1, -0);
    const c = chunk(1, 0);
    c.normals[0] = -0.5;
    for (const [i, surface] of [a, b, c].entries()) cache.retain(i, [surface], () => true);
    expect(cache.versionCount).toBe(3);
    expect(Object.is(cache.get(1)![0].positions[0], -0)).toBe(true);
    expect(cache.get(2)![0].normals[0]).toBe(-0.5);
  });

  it('evicts least-recently-used manifests and releases only unreferenced versions', () => {
    const cache = new ReplaySurfaceCache(1300);
    const surface = chunk(1);
    cache.retain(0, [surface], () => true);
    cache.retain(1, [surface], () => true);
    cache.get(0);
    cache.retain(2, [surface], () => true);
    expect(cache.get(1)).toBeUndefined();
    expect(cache.get(0)?.[0]).toBe(surface);
    expect(cache.versionCount).toBe(1);
    expect(cache.evictions).toBe(1);
    expect(cache.bytes).toBeLessThanOrEqual(1300);
    expect(cache.release(REPLAY_SURFACE_BYTES)).toBeGreaterThan(0);
    expect(cache.bytes).toBe(0);
    expect(cache.versionCount).toBe(0);
    expect(cache.evictions).toBe(3);
  });

  it('skips optional retention when shared workspace cannot fit without modifying geometry', () => {
    const cache = new ReplaySurfaceCache();
    const surface = chunk(1);
    const original = surface.positions.slice();
    expect(cache.retain(0, [surface], () => false)).toBe(false);
    expect(cache.skipped).toBe(1);
    expect(cache.bytes).toBe(0);
    expect(surface.positions).toEqual(original);
  });

  it('validates capacity and surface shape and supports intentionally disabled caching', () => {
    expect(() => new ReplaySurfaceCache(REPLAY_SURFACE_BYTES + 1)).toThrow('memory bound');
    const cache = new ReplaySurfaceCache();
    expect(() => cache.retain(-1, [], () => true)).toThrow('position');
    expect(() => cache.retain(0, [chunk(1), chunk(1)], () => true)).toThrow('surface chunk');
    expect(new ReplaySurfaceCache(0).retain(0, [chunk(1)], () => true)).toBe(false);
    cache.retain(0, [chunk(1)], () => true);
    cache.clear();
    expect(cache.bytes).toBe(0);
    expect(cache.size).toBe(0);
    expect(cache.clears).toBe(1);
  });

  it('charges complete backing buffers retained through small typed-array views', () => {
    const cache = new ReplaySurfaceCache(4096);
    const surface = chunk(1);
    surface.positions = new Float32Array(4096).subarray(0, 9);
    expect(cache.retain(0, [surface], () => true)).toBe(false);
    expect(cache.bytes).toBe(0);
  });
});
