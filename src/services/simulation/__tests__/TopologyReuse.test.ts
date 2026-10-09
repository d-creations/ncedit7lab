import { describe, expect, it, vi } from 'vitest';
import { MaterialRemovalEngine, batchRemovalMotions } from '../MaterialRemovalEngine';
import { StockMeshBuilder, MAX_TOPOLOGY_CACHE_BYTES } from '../StockMeshBuilder';
import { StockModel } from '../StockModel';
import { SIMULATION_LIMITS } from '../SimulationTypes';
import { traceInput } from './fixtures/traceInput';
import { boxVolume } from '../ImplicitGeometry';

function identical(actual: StockMeshBuilder, reference: StockMeshBuilder): void {
  const expected = new Map(reference.getChunks().map((chunk) => [chunk.id, chunk]));
  expect(actual.getChunks().length).toBe(expected.size);
  for (const chunk of actual.getChunks()) {
    expect(chunk.positions).toEqual(expected.get(chunk.id)!.positions);
    expect(chunk.normals).toEqual(expected.get(chunk.id)!.normals);
  }
}

describe('bounded per-build seam topology reuse', () => {
  it('avoids the second sampling pass and retains exact mixed-stock geometry and normals', () => {
    const input = traceInput();
    const engine = new MaterialRemovalEngine(input);
    engine.applyBatches(batchRemovalMotions(input.motions));
    const reference = new MaterialRemovalEngine(input);
    reference.applyBatches(batchRemovalMotions(input.motions));
    const cached = new StockMeshBuilder();
    const streamed = new StockMeshBuilder(undefined, { topologyCacheBytes: 0 });
    cached.buildChanged(engine.stock);
    streamed.buildChanged(reference.stock);
    expect(cached.topologyPasses).toBe(1);
    expect(cached.topologyReused).toBe(true);
    expect(streamed.topologyPasses).toBe(2);
    expect(cached.topologyCachePeakBytes).toBeGreaterThan(0);
    expect(cached.topologyCachePeakBytes).toBeLessThanOrEqual(MAX_TOPOLOGY_CACHE_BYTES);
    expect(engine.stock.peakAllocatedBytes).toBeLessThanOrEqual(SIMULATION_LIMITS.stockBytes);
    identical(cached, streamed);
  });

  it('preserves coarse/fine seam context during incremental milling after turning', () => {
    const input = traceInput();
    const engine = new MaterialRemovalEngine(input);
    engine.applyMotion(input.motions[0]);
    const reference = new MaterialRemovalEngine(input);
    reference.applyMotion(input.motions[0]);
    const cached = new StockMeshBuilder();
    const streamed = new StockMeshBuilder(undefined, { topologyCacheBytes: 0 });
    cached.buildChanged(engine.stock);
    streamed.buildChanged(reference.stock);
    engine.applyMotion(input.motions[1]);
    reference.applyMotion(input.motions[1]);
    cached.buildChanged(engine.stock);
    streamed.buildChanged(reference.stock);
    expect(cached.topologyPasses).toBe(1);
    identical(cached, streamed);
  });

  it('falls back to streamed sampling at unchanged detail when the temporary cache is full', () => {
    const input = traceInput();
    const engine = new MaterialRemovalEngine(input);
    engine.applyBatches(batchRemovalMotions(input.motions));
    const reference = new MaterialRemovalEngine(input);
    reference.applyBatches(batchRemovalMotions(input.motions));
    const constrained = new StockMeshBuilder(undefined, { topologyCacheBytes: 1 });
    const streamed = new StockMeshBuilder(undefined, { topologyCacheBytes: 0 });
    constrained.buildChanged(engine.stock);
    streamed.buildChanged(reference.stock);
    expect(constrained.topologyPasses).toBe(2);
    expect(constrained.topologyReused).toBe(false);
    expect(constrained.topologyCachePeakBytes).toBe(0);
    identical(constrained, streamed);
  });

  it('restarts the complete breakpoint pass if workspace pressure drops cached topology while consuming it', () => {
    const input = traceInput();
    const engine = new MaterialRemovalEngine(input);
    engine.applyBatches(batchRemovalMotions(input.motions));
    const reference = new MaterialRemovalEngine(input);
    reference.applyBatches(batchRemovalMotions(input.motions));
    const cached = new StockMeshBuilder();
    const streamed = new StockMeshBuilder(undefined, { topologyCacheBytes: 0 });
    let firstPassComplete = false;
    let declined = false;
    const iterate = engine.stock.iterateBoundaryTopology;
    const account = engine.stock.accountSurfaceWorkspace;
    const iterator = vi
      .spyOn(engine.stock, 'iterateBoundaryTopology')
      .mockImplementation(function* (
        this: StockModel,
        ...args: Parameters<StockModel['iterateBoundaryTopology']>
      ) {
        yield* iterate.apply(this, args);
        firstPassComplete = true;
      });
    const capacity = vi.spyOn(engine.stock, 'accountSurfaceWorkspace').mockImplementation(function (
      this: StockModel,
      bytes,
    ) {
      if (firstPassComplete && !declined) {
        declined = true;
        const released = this.releaseSurfaceWorkspace?.(1) ?? 0;
        return account.call(this, bytes - released);
      }
      return account.call(this, bytes);
    });
    try {
      cached.buildChanged(engine.stock);
      expect(declined).toBe(true);
      expect(cached.topologyPasses).toBe(2);
      expect(cached.topologyReused).toBe(false);
      expect(cached.topologyCachePeakBytes).toBeGreaterThan(0);
      expect(engine.stock.releaseSurfaceWorkspace).toBeUndefined();
      streamed.buildChanged(reference.stock);
      identical(cached, streamed);
    } finally {
      iterator.mockRestore();
      capacity.mockRestore();
    }
  });

  it('releases optional extraction workspace only under actual budget pressure', () => {
    const limits = { cells: SIMULATION_LIMITS.cells, stockBytes: SIMULATION_LIMITS.stockBytes };
    const stock = new StockModel([4, 4, 4], 0.5, boxVolume([4, 4, 4]), limits);
    limits.stockBytes = stock.allocatedBytes + 2000;
    const release = vi.fn(() => 1024);
    stock.releaseSurfaceWorkspace = release;
    stock.accountSurfaceWorkspace(1000);
    expect(release).not.toHaveBeenCalled();
    stock.accountSurfaceWorkspace(2500);
    expect(release).toHaveBeenCalledWith(500);
    expect(stock.peakAllocatedBytes).toBeLessThanOrEqual(limits.stockBytes);
    stock.releaseSurfaceWorkspace = () => 3000;
    expect(() => stock.accountSurfaceWorkspace(2500)).toThrow('Invalid released extraction');
  });

  it('restores the previous workspace release hook after an extraction error', () => {
    const stock = new StockModel([4, 4, 4], 0.5, boxVolume([4, 4, 4]));
    const previous = () => 0;
    stock.releaseSurfaceWorkspace = previous;
    const iteration = vi.spyOn(stock, 'iterateBoundaryTopology').mockImplementation(() => {
      throw new Error('Forced extraction failure');
    });
    try {
      expect(() => new StockMeshBuilder().buildChanged(stock)).toThrow('Forced extraction failure');
      expect(stock.releaseSurfaceWorkspace).toBe(previous);
    } finally {
      iteration.mockRestore();
    }
  });

  it('rejects invalid cache capacities', () => {
    for (const topologyCacheBytes of [-1, NaN, 0.5, MAX_TOPOLOGY_CACHE_BYTES + 1])
      expect(() => new StockMeshBuilder(undefined, { topologyCacheBytes })).toThrow('capacity');
  });
});
