import * as THREE from 'three';
import type { CompiledGpuSweep } from './GpuSweepCompiler';
import { SimulationCapabilityError } from './SimulationTypes';

export const DEXEL_TILE_SIZE = 32;
export const DEXEL_INTERVALS = 4;
export const DEXEL_MEMORY_BYTES = 256 * 1024 * 1024;
export const DEXEL_BINDING_BYTES = 128 * 1024 * 1024;

export interface DexelLayout {
  size: THREE.Vector3;
  dimensions: THREE.Vector3;
  rayCounts: [number, number, number];
  tileCounts: [number, number, number];
  rays: number;
  tiles: number;
  intervalBytes: number;
  estimatedBytes: number;
  pitchMm: number;
}

export function createDexelLayout(size: THREE.Vector3, pitchMm: number): DexelLayout {
  if (
    !Number.isFinite(pitchMm) ||
    pitchMm < 0.001 ||
    pitchMm > 5 ||
    size.toArray().some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    throw new SimulationCapabilityError(
      'GPU stock requires positive finite dimensions and a pitch between 0.001 and 5 mm',
    );
  }
  const dimensions = size.clone().divideScalar(pitchMm).ceil();
  const [nx, ny, nz] = dimensions.toArray();
  const padded = (n: number): number => Math.ceil(n / DEXEL_TILE_SIZE);
  const tileCounts: [number, number, number] = [
    padded(ny) * padded(nz),
    padded(nx) * padded(nz),
    padded(nx) * padded(ny),
  ];
  const rayCounts = tileCounts.map((n) => n * DEXEL_TILE_SIZE ** 2) as [number, number, number];
  const rays = rayCounts.reduce((sum, n) => sum + n, 0);
  const tiles = tileCounts.reduce((sum, n) => sum + n, 0);
  const intervalBytes = rays * DEXEL_INTERVALS * 8;
  // Storage attributes retain a CPU allocation as well as their GPU buffers.
  const estimatedBytes = 2 * (intervalBytes + rays * 4 + tiles * 8) + 4096;
  if (
    !Number.isSafeInteger(rays) ||
    intervalBytes > DEXEL_BINDING_BYTES ||
    estimatedBytes > DEXEL_MEMORY_BYTES
  ) {
    throw new SimulationCapabilityError(
      `GPU stock at ${pitchMm} mm needs approximately ${(estimatedBytes / 1048576).toFixed(1)} MiB including CPU/GPU buffers, or exceeds the 128 MiB storage binding limit. Use a larger pitch or smaller stock; resolution is not silently reduced.`,
    );
  }
  return {
    size: size.clone(),
    dimensions,
    rayCounts,
    tileCounts,
    rays,
    tiles,
    intervalBytes,
    estimatedBytes,
    pitchMm,
  };
}

export interface DexelTileIndex {
  ranges: Uint32Array;
  sweeps: Uint32Array;
  bytes: number;
}

export function indexDexelTiles(
  layout: DexelLayout,
  sweeps: readonly CompiledGpuSweep[],
): DexelTileIndex {
  const lists: number[][] = Array.from({ length: layout.tiles }, () => []);
  let base = 0,
    stagingEntries = 0;
  const stagingBase = layout.tiles * 96;
  if (layout.estimatedBytes + stagingBase > DEXEL_MEMORY_BYTES)
    throw new SimulationCapabilityError('GPU tile-index staging exceeds the memory budget');
  for (let axis = 0; axis < 3; axis++) {
    const u = axis === 0 ? 1 : 0;
    const v = axis === 2 ? 1 : 2;
    const nu = layout.dimensions.getComponent(u),
      nv = layout.dimensions.getComponent(v);
    const tilesU = Math.ceil(nu / DEXEL_TILE_SIZE),
      tilesV = Math.ceil(nv / DEXEL_TILE_SIZE);
    for (let i = 0; i < sweeps.length; i++) {
      const bounds = sweeps[i].bounds;
      if (
        bounds.isEmpty() ||
        [0, 1, 2].some(
          (a) =>
            bounds.max.getComponent(a) < -layout.size.getComponent(a) / 2 ||
            bounds.min.getComponent(a) > layout.size.getComponent(a) / 2,
        )
      )
        continue;
      const tileCoordinate = (value: number, a: number): number =>
        Math.floor(
          (((value + layout.size.getComponent(a) / 2) / layout.size.getComponent(a)) *
            layout.dimensions.getComponent(a)) /
            DEXEL_TILE_SIZE,
        );
      const loU = Math.max(0, tileCoordinate(bounds.min.getComponent(u), u));
      const hiU = Math.min(tilesU - 1, tileCoordinate(bounds.max.getComponent(u), u));
      const loV = Math.max(0, tileCoordinate(bounds.min.getComponent(v), v));
      const hiV = Math.min(tilesV - 1, tileCoordinate(bounds.max.getComponent(v), v));
      const added = Math.max(0, hiU - loU + 1) * Math.max(0, hiV - loV + 1);
      stagingEntries += added;
      if (layout.estimatedBytes + stagingBase + stagingEntries * 16 > DEXEL_MEMORY_BYTES)
        throw new SimulationCapabilityError('GPU tile-index staging exceeds the memory budget');
      for (let y = loV; y <= hiV; y++)
        for (let x = loU; x <= hiU; x++) lists[base + x + tilesU * y].push(i);
    }
    base += layout.tileCounts[axis];
  }
  const entries = lists.reduce((sum, list) => sum + list.length, 0);
  const bytes = 2 * (layout.tiles * 8 + Math.max(1, entries) * 4);
  if (bytes + layout.estimatedBytes > DEXEL_MEMORY_BYTES)
    throw new SimulationCapabilityError('GPU cutter-to-tile index exceeds the stock memory budget');
  const ranges = new Uint32Array(layout.tiles * 2),
    indices = new Uint32Array(Math.max(1, entries));
  let offset = 0;
  lists.forEach((list, tile) => {
    ranges[tile * 2] = offset;
    ranges[tile * 2 + 1] = list.length;
    indices.set(list, offset);
    offset += list.length;
  });
  return { ranges, sweeps: indices, bytes };
}

export function subtractDexelInterval(
  intervals: readonly (readonly [number, number])[],
  cut: readonly [number, number],
): [number, number][] {
  if (
    ![...cut, ...intervals.flat()].every(Number.isFinite) ||
    cut[0] > cut[1] ||
    intervals.some(([a, b]) => a >= b)
  )
    throw new Error('Invalid dexel interval');
  const result: [number, number][] = [];
  for (const [a, b] of intervals) {
    if (cut[1] <= a || cut[0] >= b || cut[0] === cut[1]) result.push([a, b]);
    else {
      if (a < cut[0]) result.push([a, cut[0]]);
      if (b > cut[1]) result.push([cut[1], b]);
    }
  }
  if (result.length > DEXEL_INTERVALS)
    throw new SimulationCapabilityError(
      `GPU dexel exceeds ${DEXEL_INTERVALS} material intervals per ray`,
    );
  return result;
}
