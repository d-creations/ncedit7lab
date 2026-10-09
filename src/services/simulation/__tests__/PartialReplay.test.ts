import { describe, expect, it, vi } from 'vitest';
import { MaterialReplayEngine, type ReplayFrame } from '../MaterialReplayEngine';
import { MemoryReplayTraceStore } from '../ReplayTraceStore';
import { simulateMaterialRemoval } from '../MaterialRemovalEngine';
import type { StockSurfaceChunk } from '../SimulationTypes';
import { SIMULATION_LIMITS } from '../SimulationTypes';
import { traceInput } from './fixtures/traceInput';
import { StockMeshBuilder } from '../StockMeshBuilder';
import { ReplaySurfaceCache } from '../ReplaySurfaceCache';

const steps = [0, 1, 2, 3, 4, 5, 6];
function geometry(chunks: Iterable<StockSurfaceChunk>): string[] {
  return [...chunks]
    .flatMap((chunk) => {
      const triangles: string[] = [];
      for (let i = 0; i < chunk.positions.length; i += 9)
        triangles.push(
          [0, 3, 6]
            .map((n) =>
              Array.from(chunk.positions.subarray(i + n, i + n + 3), (v) => v.toFixed(6)).join(','),
            )
            .sort()
            .join('|'),
        );
      return triangles;
    })
    .sort();
}
function update(chunks: Map<number, StockSurfaceChunk>, frame: ReplayFrame): void {
  if (frame.replace) chunks.clear();
  for (const chunk of frame.chunks)
    if (chunk.positions.length) chunks.set(chunk.id, chunk);
    else chunks.delete(chunk.id);
}

describe('partial temporal stock history', () => {
  it('retains contiguous operation diagnostics across recorded occurrences and finalizes before a blocker', async () => {
    const input = traceInput();
    input.motions.splice(1, 0, { ...input.motions[0], executionStep: 2 });
    input.stop = {
      executionStep: 5,
      message: 'Unsupported final occurrence',
    };
    const replay = new MaterialReplayEngine(input, steps);
    replay.setTraceStore(new MemoryReplayTraceStore());
    const frame = await replay.prepareFinal(() => {});
    expect(frame.finalResult?.status).toBe('stopped');
    expect(
      frame.finalResult?.operationDiagnostics?.map((operation) => ({
        mode: operation.mode,
        count: operation.motionCount,
        indexes: operation.motions.map((motion) => motion.motionIndex),
      })),
    ).toEqual([
      { mode: 'turning', count: 2, indexes: [0, 1] },
      { mode: 'milling', count: 1, indexes: [2] },
    ]);
    await replay.close();
  });
  it('records the first final calculation, then arbitrary jumps perform no cutter subtraction', async () => {
    const input = traceInput();
    const store = new MemoryReplayTraceStore();
    const replay = new MaterialReplayEngine(input, steps);
    replay.setTraceStore(store);
    const first = await replay.prepareFinal(() => {});
    const expectedFinal = simulateMaterialRemoval(input);
    expect(first.removedCells).toBe(expectedFinal.removedCells);
    expect(first.finalResult?.operationDiagnostics?.map((operation) => operation.mode)).toEqual([
      'turning',
      'milling',
      'turning',
    ]);
    expect(
      first.finalResult?.operationDiagnostics?.flatMap((operation) =>
        operation.motions.map((motion) => motion.motionIndex),
      ),
    ).toEqual([0, 1, 2]);
    expect(first.checkpointCount).toBe(0);
    expect(store.bytes).toBeGreaterThan(0);
    const chunks = new Map<number, StockSurfaceChunk>();
    update(chunks, first);
    for (const position of [4, 2, 7, 0, 6, 1, 5, 3, 7]) {
      const frame = await replay.seekRecorded(position);
      update(chunks, frame);
      const direct = simulateMaterialRemoval({
        ...input,
        motions: input.motions.filter(
          (motion) => motion.executionStep <= (steps[position - 1] ?? -1),
        ),
      });
      expect(frame.historyMode).toBe('partial-disk');
      expect(frame.appliedMotions).toBe(0);
      expect(frame.subtractionMs).toBe(0);
      expect(frame.removedCells).toBe(direct.removedCells);
      expect(geometry(chunks.values())).toEqual(geometry(direct.chunks));
    }
    await replay.close();
    expect(store.bytes).toBe(0);
  });

  it('extends recorded history only at occurrence boundaries after restoring an earlier prefix', async () => {
    const replay = new MaterialReplayEngine(traceInput(), steps);
    replay.setTraceStore(new MemoryReplayTraceStore());
    const first = await replay.seekRecorded(2);
    expect(first.appliedMotions).toBe(1);
    await replay.seekRecorded(0);
    const extended = await replay.seekRecorded(7);
    expect(extended.appliedMotions).toBe(2);
    expect((await replay.seekRecorded(2)).appliedMotions).toBe(0);
    await replay.close();
  });

  it('reuses exact visited surface versions including normals and seam context on warm jumps', async () => {
    const replay = new MaterialReplayEngine(traceInput(), steps);
    replay.setTraceStore(new MemoryReplayTraceStore());
    const final = await replay.prepareFinal(() => {});
    const display = new Map<number, StockSurfaceChunk>();
    update(display, final);
    const snapshots = new Map<number, Map<number, StockSurfaceChunk>>();
    for (const position of [0, 2, 4, 7]) {
      const frame = await replay.seekRecorded(position);
      update(display, frame);
      snapshots.set(position, new Map(display));
    }
    for (const position of [4, 0, 7, 2, 7]) {
      const frame = await replay.seekRecorded(position);
      expect(frame.surfaceCacheHit).toBe(true);
      expect(frame.surfaceCacheMissReason).toBeUndefined();
      expect(frame.extractionMs).toBe(0);
      expect(frame.triangulationMs).toBe(0);
      expect(frame.adaptationMs).toBe(0);
      expect(frame.remeshedChunks).toBe(0);
      expect(frame.appliedMotions).toBe(0);
      update(display, frame);
      const expected = snapshots.get(position)!;
      expect([...display.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [id, chunk] of display) {
        expect(chunk.positions).toEqual(expected.get(id)!.positions);
        expect(chunk.normals).toEqual(expected.get(id)!.normals);
      }
      expect(frame.peakStockBytes).toBeLessThanOrEqual(SIMULATION_LIMITS.stockBytes);
    }
    await replay.close();
  });

  it('remeshes at unchanged detail when historical surfaces cannot be retained', async () => {
    const replay = new MaterialReplayEngine(traceInput(), steps, { surfaceCacheBytes: 0 });
    replay.setTraceStore(new MemoryReplayTraceStore());
    const final = await replay.prepareFinal(() => {});
    const display = new Map<number, StockSurfaceChunk>();
    update(display, final);
    await replay.seekRecorded(0);
    display.clear();
    const back = await replay.seekRecorded(7, true);
    update(display, back);
    expect(back.surfaceCacheHit).toBe(false);
    expect(back.surfaceCacheMissReason).toBe('disabled');
    expect(back.surfaceCacheBytes).toBe(0);
    expect(geometry(display.values())).toEqual(geometry(final.chunks));
    await replay.close();
  });

  it('reports exact per-build phases and work counts, not timings from an earlier frame', async () => {
    const build = StockMeshBuilder.prototype.buildChanged;
    let expected = {
      extractionMs: 0,
      triangulationMs: 0,
      adaptationMs: 0,
      remeshedChunks: 0,
      fineTriangles: 0,
      outputTriangles: 0,
    };
    const spy = vi.spyOn(StockMeshBuilder.prototype, 'buildChanged').mockImplementation(function (
      this: StockMeshBuilder,
      stock,
    ) {
      const chunks = build.call(this, stock);
      expected = {
        extractionMs: this.extractionMs,
        triangulationMs: this.chunkDiagnostics.reduce(
          (sum, chunk) => sum + chunk.triangulationMs,
          0,
        ),
        adaptationMs: this.chunkDiagnostics.reduce((sum, chunk) => sum + chunk.adaptationMs, 0),
        remeshedChunks: this.chunkDiagnostics.length,
        fineTriangles: this.chunkDiagnostics.reduce((sum, chunk) => sum + chunk.fineTriangles, 0),
        outputTriangles: this.chunkDiagnostics.reduce(
          (sum, chunk) => sum + chunk.outputTriangles,
          0,
        ),
      };
      return chunks;
    });
    const replay = new MaterialReplayEngine(traceInput(), steps);
    replay.setTraceStore(new MemoryReplayTraceStore());
    try {
      const frame = await replay.prepareFinal(() => {});
      expect(frame.surfaceCacheMissReason).toBe('first-visit');
      expect(frame.surfaceReconstructed).toBe(true);
      expect(frame.surfaceCacheLimitBytes).toBe(64 * 1024 * 1024);
      expect(frame.remeshedChunks).toBeGreaterThan(0);
      for (const key of [
        'extractionMs',
        'triangulationMs',
        'adaptationMs',
        'remeshedChunks',
        'fineTriangles',
        'outputTriangles',
      ] as const)
        expect(frame[key]).toBe(expected[key]);
      const again = await replay.seekRecorded(7);
      expect(again.surfaceCacheHit).toBe(true);
      expect(again.surfaceReconstructed).toBe(false);
      expect(again.remeshedChunks).toBe(0);
    } finally {
      spy.mockRestore();
      await replay.close();
    }
  });

  it('distinguishes an evicted prefix from a visited prefix that could never be retained', async () => {
    const get = ReplaySurfaceCache.prototype.get;
    const release = vi.spyOn(ReplaySurfaceCache.prototype, 'get').mockImplementation(function (
      this: ReplaySurfaceCache,
      position,
    ) {
      this.release(Number.MAX_SAFE_INTEGER);
      return get.call(this, position);
    });
    const replay = new MaterialReplayEngine(traceInput(), steps);
    replay.setTraceStore(new MemoryReplayTraceStore());
    try {
      await replay.prepareFinal(() => {});
      const repeated = await replay.seekRecorded(7);
      expect(repeated.surfaceCacheMissReason).toBe('evicted-or-cleared');
      expect(repeated.surfaceCacheEvictions).toBeGreaterThan(0);
    } finally {
      release.mockRestore();
      await replay.close();
    }
    const capacity = new MaterialReplayEngine(traceInput(), steps, { surfaceCacheBytes: 1 });
    capacity.setTraceStore(new MemoryReplayTraceStore());
    await capacity.prepareFinal(() => {});
    const skipped = await capacity.seekRecorded(7);
    expect(skipped.surfaceCacheMissReason).toBe('not-retained');
    expect(skipped.surfaceCacheSkipped).toBeGreaterThan(0);
    await capacity.close();
  });

  it('surfaces a storage cap and preserves exact checkpoint/recompute fallback', async () => {
    const input = traceInput();
    const replay = new MaterialReplayEngine(input, steps, { checkpointInterval: 1 });
    replay.setTraceStore(new MemoryReplayTraceStore(0));
    const first = await replay.prepareFinal(() => {});
    expect(first.historyMode).toBe('checkpoint');
    expect(first.historyWarning).toContain('cap');
    expect(first.removedCells).toBe(simulateMaterialRemoval(input).removedCells);
    expect(first.finalResult?.operationDiagnostics?.map((operation) => operation.mode)).toEqual([
      'turning',
      'milling',
      'turning',
    ]);
    const back = await replay.seekRecorded(2);
    expect(back.removedCells).toBe(
      simulateMaterialRemoval({ ...input, motions: input.motions.slice(0, 1) }).removedCells,
    );
    await replay.close();
  });

  it('reconstructs from raw stock after a decode failure, never accepting a partially restored state', async () => {
    class BrokenStore extends MemoryReplayTraceStore {
      override async *restore(): AsyncIterable<{ key: number; data: Uint8Array }> {
        yield { key: 0, data: new Uint8Array([0]) };
      }
    }
    const input = traceInput();
    const replay = new MaterialReplayEngine(input, steps);
    replay.setTraceStore(new BrokenStore());
    await replay.prepareFinal(() => {});
    const back = await replay.seekRecorded(2);
    expect(back.replace).toBe(true);
    expect(back.historyWarning).toContain('could not be restored');
    expect(back.removedCells).toBe(
      simulateMaterialRemoval({ ...input, motions: input.motions.slice(0, 1) }).removedCells,
    );
    await replay.close();
  });

  it('disables optional history when its temporal index outgrows available RAM', async () => {
    class GrowingIndexStore extends MemoryReplayTraceStore {
      private recorded = false;
      override get indexBytes(): number {
        return this.recorded ? SIMULATION_LIMITS.stockBytes : 0;
      }
      override async write(
        position: number,
        updates: Parameters<MemoryReplayTraceStore['write']>[1],
      ): Promise<boolean> {
        const result = await super.write(position, updates);
        this.recorded = true;
        return result;
      }
    }
    const input = traceInput();
    const replay = new MaterialReplayEngine(input, steps);
    replay.setTraceStore(new GrowingIndexStore());
    const frame = await replay.prepareFinal(() => {});
    expect(frame.historyMode).toBe('checkpoint');
    expect(frame.historyWarning).toContain('index exceeded');
    expect(frame.removedCells).toBe(simulateMaterialRemoval(input).removedCells);
    await replay.close();
  });

  it('rejects concurrent seeks and cancels recording at the next storage boundary', async () => {
    const replay = new MaterialReplayEngine(traceInput(), steps);
    replay.setTraceStore(new MemoryReplayTraceStore());
    const pending = replay.seekRecorded(7);
    await expect(replay.seekRecorded(0)).rejects.toThrow('Concurrent');
    replay.cancel();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await replay.close();
  });
});
