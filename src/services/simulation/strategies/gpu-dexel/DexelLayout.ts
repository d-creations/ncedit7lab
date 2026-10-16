import * as THREE from 'three';
import type { CompiledGpuSweep } from './GpuSweepCompiler';
import { SimulationCapabilityError } from '../../shared/SimulationTypes';

export const DEXEL_TILE_SIZE = 32;
export const DEXEL_INTERVALS = 16;
export const DEXEL_MAX_INTERVALS = 64;
export type DexelIntervalCapacity = 4 | 8 | 16 | 32 | 64;
export function dexelIntervalCapacity(required: number): DexelIntervalCapacity {
  if (!Number.isSafeInteger(required) || required < 0)
    throw new SimulationCapabilityError('GPU interval requirement must be a nonnegative integer');
  for (const capacity of [4, 8, 16, 32, 64] as const) if (required <= capacity) return capacity;
  throw new SimulationCapabilityError('GPU stock exceeds 64 material intervals on a ray');
}

export class GpuDexelIntervalOverflowError extends SimulationCapabilityError {
  constructor(capacity: DexelIntervalCapacity) {
    super(`GPU stock exceeds ${capacity} material intervals on a ray`);
  }
}
export const DEXEL_MEMORY_BYTES = 256 * 1024 * 1024;
export const DEXEL_BINDING_BYTES = 128 * 1024 * 1024;

export interface DexelLayout {
  size: THREE.Vector3;
  dimensions: THREE.Vector3;
  rayCounts: [number, number, number];
  tileCounts: [number, number, number];
  rays: number;
  tiles: number;
  storedTiles: Uint32Array;
  storageRays: number;
  intervalBytes: number;
  estimatedBytes: number;
  pitchMm: number;
  intervalCapacity: DexelIntervalCapacity;
}

export function createDexelLayout(
  size: THREE.Vector3,
  pitchMm: number,
  intervalCapacity: DexelIntervalCapacity = DEXEL_INTERVALS,
  sparse?: { bounds: readonly THREE.Box3[]; retainedTiles?: Uint32Array },
): DexelLayout {
  if (![4, 8, 16, 32, 64].includes(intervalCapacity))
    throw new SimulationCapabilityError('GPU interval capacity must be 4, 8, 16, 32 or 64');
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
  if (!Number.isSafeInteger(rays) || rays > 0xffffffff || tiles * 128 > DEXEL_MEMORY_BYTES)
    throw new SimulationCapabilityError(
      'GPU ray metadata exceeds the 256 MiB memory budget; use a larger pitch',
    );
  const geometry = { size, dimensions, tileCounts };
  const selected = sparse ? new Set(sparse.retainedTiles ?? []) : undefined;
  if (selected) {
    for (const tile of selected)
      if (!Number.isSafeInteger(tile) || tile < 0 || tile >= tiles)
        throw new SimulationCapabilityError('Invalid retained GPU tile');
    for (const bounds of sparse!.bounds)
      for (const tile of dexelTilesForBounds(geometry, bounds)) selected.add(tile);
  }
  const storedTiles = selected
    ? Uint32Array.from([...selected].sort((a, b) => a - b))
    : Uint32Array.from({ length: tiles }, (_, tile) => tile);
  const storageRays = storedTiles.length * DEXEL_TILE_SIZE ** 2;
  const intervalBytes = Math.max(1, storageRays) * intervalCapacity * 8;
  // Storage attributes retain a CPU allocation as well as their GPU buffers.
  const estimatedBytes =
    2 * (intervalBytes + Math.max(1, storageRays) * 4 + tiles * 16) + storedTiles.byteLength + 4096;
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
    storedTiles,
    storageRays,
    intervalBytes,
    estimatedBytes,
    pitchMm,
    intervalCapacity,
  };
}

export function dexelTilesForBounds(
  layout: Pick<DexelLayout, 'size' | 'dimensions' | 'tileCounts'>,
  bounds: THREE.Box3,
): number[] {
  if (
    bounds.isEmpty() ||
    [0, 1, 2].some(
      (axis) =>
        bounds.max.getComponent(axis) < -layout.size.getComponent(axis) / 2 ||
        bounds.min.getComponent(axis) > layout.size.getComponent(axis) / 2,
    )
  )
    return [];
  const result: number[] = [];
  let base = 0;
  for (let axis = 0; axis < 3; axis++) {
    const u = axis === 0 ? 1 : 0,
      v = axis === 2 ? 1 : 2;
    const tilesU = Math.ceil(layout.dimensions.getComponent(u) / DEXEL_TILE_SIZE);
    const tilesV = Math.ceil(layout.dimensions.getComponent(v) / DEXEL_TILE_SIZE);
    const coordinate = (value: number, a: number) =>
      Math.floor(
        (((value + layout.size.getComponent(a) / 2) / layout.size.getComponent(a)) *
          layout.dimensions.getComponent(a)) /
          DEXEL_TILE_SIZE,
      );
    const loU = Math.max(0, coordinate(bounds.min.getComponent(u), u));
    const hiU = Math.min(tilesU - 1, coordinate(bounds.max.getComponent(u), u));
    const loV = Math.max(0, coordinate(bounds.min.getComponent(v), v));
    const hiV = Math.min(tilesV - 1, coordinate(bounds.max.getComponent(v), v));
    for (let y = loV; y <= hiV; y++)
      for (let x = loU; x <= hiU; x++) result.push(base + x + tilesU * y);
    base += layout.tileCounts[axis];
  }
  return result;
}

export function originalDexelSpan(
  layout: DexelLayout,
  ray: number,
  cylinder: boolean,
): readonly [number, number] | undefined {
  if (!Number.isSafeInteger(ray) || ray < 0 || ray >= layout.rays)
    throw new SimulationCapabilityError('Invalid GPU dexel ray');
  let axis = 0,
    local = ray;
  while (local >= layout.rayCounts[axis]) {
    local -= layout.rayCounts[axis];
    axis++;
  }
  const u = axis === 0 ? 1 : 0,
    v = axis === 2 ? 1 : 2;
  const tilesU = Math.ceil(layout.dimensions.getComponent(u) / 32);
  const tile = Math.floor(local / 1024),
    column = local % 1024;
  const a = (tile % tilesU) * 32 + (column % 32);
  const b = Math.floor(tile / tilesU) * 32 + Math.floor(column / 32);
  if (a >= layout.dimensions.getComponent(u) || b >= layout.dimensions.getComponent(v))
    return undefined;
  const p = [0, 0, 0];
  p[u] =
    -layout.size.getComponent(u) / 2 +
    ((a + 0.5) * layout.size.getComponent(u)) / layout.dimensions.getComponent(u);
  p[v] =
    -layout.size.getComponent(v) / 2 +
    ((b + 0.5) * layout.size.getComponent(v)) / layout.dimensions.getComponent(v);
  if (!cylinder) return [-layout.size.getComponent(axis) / 2, layout.size.getComponent(axis) / 2];
  const radius = layout.size.x / 2;
  if (axis === 2)
    return p[0] ** 2 + p[1] ** 2 < radius ** 2
      ? [-layout.size.z / 2, layout.size.z / 2]
      : undefined;
  const square = radius ** 2 - p[1 - axis] ** 2;
  return square > 0 ? [-Math.sqrt(square), Math.sqrt(square)] : undefined;
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
  let stagingEntries = 0;
  const stagingBase = layout.tiles * 96;
  if (layout.estimatedBytes + stagingBase > DEXEL_MEMORY_BYTES)
    throw new SimulationCapabilityError('GPU tile-index staging exceeds the memory budget');
  for (let i = 0; i < sweeps.length; i++) {
    const touched = dexelTilesForBounds(layout, sweeps[i].bounds);
    stagingEntries += touched.length;
    if (layout.estimatedBytes + stagingBase + stagingEntries * 16 > DEXEL_MEMORY_BYTES)
      throw new SimulationCapabilityError('GPU tile-index staging exceeds the memory budget');
    for (const tile of touched) lists[tile].push(i);
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
