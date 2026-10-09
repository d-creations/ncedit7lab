import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { StockModel, type StockTraceUpdate } from '../StockModel';
import { StockMeshBuilder } from '../StockMeshBuilder';
import { boxVolume } from '../ImplicitGeometry';
import { encodeStockRegion, decodeStockRegion, type TraceNode } from '../StockTraceCodec';
import { MaterialRemovalEngine } from '../MaterialRemovalEngine';
import { traceInput } from './fixtures/traceInput';
function surface(stock: StockModel): string[] {
  const builder = new StockMeshBuilder();
  builder.buildChanged(stock);
  return builder
    .getChunks()
    .flatMap((chunk) => {
      const triangles: string[] = [];
      for (let i = 0; i < chunk.positions.length; i += 9)
        triangles.push(
          [0, 3, 6]
            .map((offset) =>
              Array.from(chunk.positions.subarray(i + offset, i + offset + 3), (n) =>
                n.toFixed(6),
              ).join(','),
            )
            .sort()
            .join('|'),
        );
      return triangles;
    })
    .sort();
}
function restore(
  stock: StockModel,
  updates: StockTraceUpdate[],
  direction: 'before' | 'after',
): void {
  for (const update of [...updates].sort((a, b) => a.key - b.key))
    stock.restoreTraceRegion(update.key, update[direction]);
}

describe('lossless selective stock traces', () => {
  it('round-trips packed fields, NaN roots, signed zero and shared arrays exactly', () => {
    const field = new Float64Array([1, 2, 3, -0, 5, 6, 7, 8, NaN]);
    const normal = new Float32Array([1, -0, 0]);
    const children: TraceNode[] = Array.from({ length: 8 }, (_, i) => ({
      x: i & 1,
      y: (i >> 1) & 1,
      z: (i >> 2) & 1,
      span: 1,
      occupied: 0,
      state: 'boundary',
      data: field,
      normals: normal,
      edgeMask: 0,
      normalMask: 1,
    }));
    const root: TraceNode = { x: 0, y: 0, z: 0, span: 2, occupied: 0, state: 'branch', children };
    const restored = decodeStockRegion(encodeStockRegion(root, () => {}));
    expect(restored).toEqual(root);
    expect(restored.children![0].data).toBe(restored.children![7].data);
    expect(Object.is(restored.children![0].data![3], -0)).toBe(true);
    expect(() => decodeStockRegion(new Uint8Array())).toThrow('header');
  });

  it('restores turning/milling/turning fields, occupancy, normals and reconstructed surfaces', () => {
    const setup = traceInput();
    const engine = new MaterialRemovalEngine(setup);
    const raw = engine.stock.remainingCells;
    const records: StockTraceUpdate[][] = [];
    const removed: number[] = [];
    const surfaces: string[][] = [];
    for (const motion of setup.motions) {
      engine.stock.beginTrace();
      engine.applyMotion(motion);
      const trace = engine.stock.finishTrace();
      expect(trace).toBeDefined();
      records.push(trace!);
      removed.push(engine.stock.removedCells);
      surfaces.push(surface(engine.stock));
    }
    for (let i = records.length - 1; i >= 0; i--) {
      restore(engine.stock, records[i], 'before');
      expect(engine.stock.remainingCells).toBe(i ? raw - removed[i - 1] : raw);
      if (i) expect(surface(engine.stock)).toEqual(surfaces[i - 1]);
    }
    for (let i = 0; i < records.length; i++) {
      restore(engine.stock, records[i], 'after');
      expect(engine.stock.removedCells).toBe(removed[i]);
      expect(surface(engine.stock)).toEqual(surfaces[i]);
    }
    expect(engine.stock.contains(new THREE.Vector3(0.5, 0, 1.5))).toBe(false);
  });

  it('charges optional trace workspace and explicitly abandons history without losing a valid cut', () => {
    const limits = { cells: 100_000, stockBytes: 32 * 1024 * 1024 };
    const stock = new StockModel([4, 4, 4], 0.5, boxVolume([4, 4, 4]), limits);
    stock.beginTrace();
    stock.subtract({ ...boxVolume([1, 1, 1]), identity: 'trace-test' }, () => {});
    limits.stockBytes = stock.allocatedBytes + 4096;
    expect(stock.finishTrace()).toBeUndefined();
    expect(stock.traceWarning).toContain('recompute');
    expect(stock.removedCells).toBeGreaterThan(0);
  });
});
