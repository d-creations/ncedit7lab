import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MaterialReplayEngine, REPLAY_LIMITS, type ReplayFrame } from '../MaterialReplayEngine';
import { MaterialRemovalEngine, simulateMaterialRemoval } from '../MaterialRemovalEngine';
import type { RemovalMotion, SimulationInput, StockSurfaceChunk } from '../SimulationTypes';
import type { ProgramToolDefinition } from '../../tools/SimulationMetadata';
import { StockMeshBuilder } from '../StockMeshBuilder';
import { StockModel } from '../StockModel';
import { boxVolume } from '../ImplicitGeometry';

const mill: ProgramToolDefinition = {
  toolNumber: 1,
  description: 'Replay mill',
  cutting: [{ type: 'endMill', diameter: 0.8, length: 2 }],
};
const insert: ProgramToolDefinition = {
  toolNumber: 2,
  description: 'Replay insert',
  cutting: [
    {
      type: 'insert',
      shape: 'S',
      ic: 2,
      thickness: 0.5,
      noseRadius: 0,
      clearanceAngle: 0,
      rotation: [0, 45, 0],
    },
  ],
};
function motion(
  start: [number, number, number],
  end: [number, number, number],
  step: number,
  tool = mill,
  mode: RemovalMotion['mode'] = 'milling',
): RemovalMotion {
  const pose = (position: [number, number, number]) => ({
    position,
    orientation: [0, 0, 0, 1] as const,
    frameId: 'workpiece:replay',
    reference: mode === 'turning' ? ('turningVirtualTip' as const) : ('millingTip' as const),
  });
  return { start: pose(start), end: pose(end), tool, mode, executionStep: step, lineNumber: 20 };
}
function input(motions: RemovalMotion[] = []): SimulationInput {
  return {
    algorithmVersion: 2,
    stock: { type: 'box', width: 4, height: 4, depth: 4 },
    resolutionMm: 0.5,
    motions,
    binding: {
      frameId: 'workpiece:replay',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      spindleOrigin: [0, 0, 0],
      spindleAxis: [0, 0, 1],
    },
  };
}
function geometry(chunks: readonly StockSurfaceChunk[]): string[] {
  return chunks
    .flatMap((chunk) => {
      const triangles: string[] = [];
      for (let i = 0; i < chunk.positions.length; i += 9) {
        const vertices = [0, 3, 6].map((offset) =>
          Array.from(chunk.positions.subarray(i + offset, i + offset + 3), (n) =>
            n.toFixed(5),
          ).join(','),
        );
        triangles.push(vertices.sort().join('|'));
      }
      return triangles;
    })
    .sort();
}
function update(cache: Map<number, StockSurfaceChunk>, frame: ReplayFrame): void {
  if (frame.replace) cache.clear();
  for (const chunk of frame.chunks) {
    if (chunk.positions.length) cache.set(chunk.id, chunk);
    else cache.delete(chunk.id);
  }
}
function expectPrefix(
  cache: Map<number, StockSurfaceChunk>,
  frame: ReplayFrame,
  setup: SimulationInput,
  steps: number[],
): void {
  const step = steps[frame.position - 1] ?? -1;
  const expected = simulateMaterialRemoval({
    ...setup,
    stop: undefined,
    motions: setup.motions.filter((m) => m.executionStep <= step),
  });
  expect(frame.removedCells).toBe(expected.removedCells);
  expect(frame.remainingCells).toBe(expected.remainingCells);
  expect(geometry([...cache.values()])).toEqual(geometry(expected.chunks));
}

describe('bounded execution-occurrence stock replay', () => {
  it('matches direct prefixes, completes all submoves of one occurrence, and never cuts a future line', () => {
    const setup = input([
      motion([-1, 0, -1], [1, 0, -1], 1),
      motion([1, 0, -1], [1, 1, -1], 1),
      motion([-1, -1, -1], [1, -1, -1], 4),
    ]);
    const steps = [0, 1, 2, 3, 4, 5];
    const replay = new MaterialReplayEngine(setup, steps);
    const cache = new Map<number, StockSurfaceChunk>();
    for (const position of [0, 1, 2, 4, 5, 6]) {
      const frame = replay.seek(position);
      update(cache, frame);
      expectPrefix(cache, frame, setup, steps);
      if (position === 2) expect(frame.processedMotions).toBe(2);
      if (position === 4 || position === 6) {
        expect(frame.chunks).toEqual([]);
        expect(frame.appliedMotions).toBe(0);
      }
    }
  });

  it('restores a checkpoint in either direction instead of replaying its already computed motions', () => {
    const setup = input([
      motion([-1, 0, -1], [1, 0, -1], 1),
      motion([-1, -1, -1], [1, -1, -1], 3),
      motion([0, -1, -1], [0, 1, -1], 5),
    ]);
    const steps = [0, 1, 2, 3, 4, 5];
    const replay = new MaterialReplayEngine(setup, steps, { checkpointInterval: 1 });
    const cache = new Map<number, StockSurfaceChunk>();
    update(cache, replay.seek(6));
    const back = replay.seek(2);
    expect(back.replace).toBe(true);
    expect(back.restoredPosition).toBe(2);
    expect(back.appliedMotions).toBe(0);
    update(cache, back);
    expectPrefix(cache, back, setup, steps);
    const forward = replay.seek(6);
    expect(forward.restoredPosition).toBe(6);
    expect(forward.appliedMotions).toBe(0);
    update(cache, forward);
    expectPrefix(cache, forward, setup, steps);
  });

  it('preserves hybrid turning and local milling data through independent checkpoints', () => {
    const setup = input([
      motion([1.6, 0, -4], [1.6, 0, 0], 1, insert, 'turning'),
      motion([0.5, 0, 0], [0.5, 0, -1], 3),
      motion([1.3, 0, -4], [1.3, 0, 0], 5, insert, 'turning'),
    ]);
    setup.stock = { type: 'cylinder', diameter: 4, length: 4, zeroVertex: 1 };
    const steps = [0, 1, 2, 3, 4, 5];
    const replay = new MaterialReplayEngine(setup, steps, { checkpointInterval: 1 });
    const cache = new Map<number, StockSurfaceChunk>();
    for (const position of [2, 4, 6, 4, 2, 6, 0, 6]) {
      const frame = replay.seek(position);
      update(cache, frame);
      expectPrefix(cache, frame, setup, steps);
      expect(frame.checkpointBytes).toBeLessThanOrEqual(REPLAY_LIMITS.checkpointBytes);
      expect(frame.checkpointCount).toBeLessThanOrEqual(REPLAY_LIMITS.checkpoints);
    }
  });

  it('copies stock field/normal pools and profiles without changing old checkpoint occupancy', () => {
    const setup = input([motion([-1, 0, -1], [1, 0, -1], 1), motion([-1, -1, -1], [1, -1, -1], 2)]);
    const engine = new MaterialRemovalEngine(setup);
    engine.applyMotion(setup.motions[0]);
    const copy = engine.forkForReplay();
    expect(copy.stock.allocatedBytes).toBe(engine.stock.allocatedBytes);
    const sample = (stock: typeof engine.stock) => {
      const result: boolean[] = [];
      for (let z = -1.75; z < 2; z += 0.5)
        for (let y = -1.75; y < 2; y += 0.5)
          for (let x = -1.75; x < 2; x += 0.5)
            result.push(stock.contains(new THREE.Vector3(x, y, z)));
      return result;
    };
    const before = sample(copy.stock);
    engine.applyMotion(setup.motions[1]);
    expect(sample(copy.stock)).toEqual(before);
    copy.applyMotion(setup.motions[1]);
    expect(sample(copy.stock)).toEqual(sample(engine.stock));
    const a = new StockMeshBuilder(),
      b = new StockMeshBuilder();
    a.buildChanged(engine.stock);
    b.buildChanged(copy.stock);
    expect(geometry(a.getChunks())).toEqual(geometry(b.getChunks()));
  });

  it('keeps its cached mesh intact when response buffers are transferred and detached', () => {
    const replay = new MaterialReplayEngine(input(), [0]);
    const first = replay.seek(0);
    const expected = geometry(first.chunks);
    structuredClone(first, {
      transfer: first.chunks.flatMap((c) => [c.positions.buffer, c.normals.buffer]),
    });
    expect(first.chunks[0].positions.byteLength).toBe(0);
    expect(geometry(replay.seek(0, true).chunks)).toEqual(expected);
  });

  it('bounds checkpoint memory and reports unavailable history instead of reducing geometry detail', () => {
    const setup = input([motion([-1, 0, -1], [1, 0, -1], 1)]);
    const replay = new MaterialReplayEngine(setup, [0, 1], {
      checkpointBytes: 1,
      checkpointInterval: 1,
    });
    const end = replay.seek(2);
    expect(end.checkpointCount).toBe(0);
    expect(end.checkpointBytes).toBe(0);
    expect(end.skippedCheckpoints).toBe(1);
    const raw = replay.seek(0);
    expect(raw.restoredPosition).toBe(0);
    expect(raw.removedCells).toBe(0);
  });

  it('releases optional history under actual workspace pressure before failing core stock work', () => {
    const limits = { cells: 100_000, stockBytes: 16 * 1024 * 1024 };
    const stock = new StockModel([4, 4, 4], 0.5, boxVolume([4, 4, 4]), limits);
    const historyBytes = 64 * 1024;
    stock.setReplayWorkspaceBytes(historyBytes);
    limits.stockBytes = stock.allocatedBytes + historyBytes + 1024;
    let requested = 0;
    stock.releaseReplayHistory = (bytes) => {
      requested = bytes;
      return historyBytes;
    };
    stock.accountSurfaceWorkspace(2048);
    expect(requested).toBe(1024);
    expect(stock.peakAllocatedBytes).toBeLessThanOrEqual(limits.stockBytes);
    stock.releaseReplayHistory = undefined;
    expect(() => stock.accountSurfaceWorkspace(historyBytes + 2048)).toThrow('memory budget');
  });

  it('stops before unsupported occurrences without including even earlier submoves of that command', () => {
    const setup = input([motion([-1, 0, -1], [1, 0, -1], 1), motion([-1, -1, -1], [1, -1, -1], 3)]);
    setup.stop = { executionStep: 3, lineNumber: 20, message: 'Unverified compound motion' };
    const replay = new MaterialReplayEngine(setup, [0, 1, 2, 3, 4]);
    const frame = replay.seek(5);
    expect(frame.position).toBe(3);
    expect(frame.processedMotions).toBe(1);
    expect(frame.stop).toEqual(setup.stop);
    expect(replay.seek(2).stop).toBeUndefined();
  });

  it('reports a terminal blocker even when an older motion-only timeline omits that occurrence', () => {
    const setup = input([motion([-1, 0, -1], [1, 0, -1], 1)]);
    setup.stop = { executionStep: 9, message: 'Unsupported omitted motion' };
    const replay = new MaterialReplayEngine(setup, [0, 1]);
    expect(replay.seek(1).stop).toBeUndefined();
    expect(replay.seek(2).stop).toEqual(setup.stop);
  });

  it('rejects invalid positions, unordered/missing steps and excessive history bounds explicitly', () => {
    const replay = new MaterialReplayEngine(input(), [0, 1]);
    for (const position of [-1, 3, 0.5, NaN])
      expect(() => replay.seek(position)).toThrow('position');
    expect(() => new MaterialReplayEngine(input(), [0, 0])).toThrow('strictly increasing');
    expect(() => new MaterialReplayEngine(input([motion([0, 0, 0], [1, 0, 0], 2)]), [0])).toThrow(
      'absent',
    );
    expect(() => new MaterialReplayEngine(input(), [0], { checkpointInterval: 0 })).toThrow(
      'Invalid replay',
    );
    expect(
      () =>
        new MaterialReplayEngine(input(), [0], {
          checkpointBytes: REPLAY_LIMITS.checkpointBytes + 1,
        }),
    ).toThrow('memory bounds');
  });
});
