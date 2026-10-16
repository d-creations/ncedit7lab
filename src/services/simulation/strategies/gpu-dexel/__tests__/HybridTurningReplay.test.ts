// @vitest-environment jsdom
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GpuMaterialReplaySession, type GpuReplayFrame } from '../GpuMaterialReplaySession';
import { compileGpuSweeps, evaluateGpuSweep, type CompiledGpuSweep } from '../GpuSweepCompiler';
import * as sweepCompiler from '../GpuSweepCompiler';
import { cylinderVolume } from '../../../shared/ImplicitGeometry';
import { turningSectionVolume } from '../../../shared/TurningEnvelope';
import { stockPlacement } from '../../../shared/SimulationTransforms';
import type { RemovalMotion, SimulationInput } from '../../../shared/SimulationTypes';
import type { ProgramToolDefinition } from '@services/tools/SimulationMetadata';
import { RotationalProfile } from '../../cpu-hybrid/RotationalProfile';
import { RevolvedStock } from '../RevolvedStock';
import { RotationalDexelBase } from '../RotationalDexelBase';
import { GpuDexelHistory } from '../GpuDexelHistory';
import { dexelIntervalCapacity, type DexelIntervalCapacity } from '../DexelLayout';

const model = vi.hoisted(() => ({ constructed: vi.fn(), calculate: vi.fn(), copy: vi.fn() }));

// A material oracle, not GPU hardware: verify the session's exact prefix/source selection.
vi.mock('../GpuDexelStock', async () => {
  const THREE = await import('three');
  const { createDexelLayout } = await import('../DexelLayout');
  return {
    GpuDexelStock: class {
      group = new THREE.Group();
      applied: CompiledGpuSweep[] = [];
      layout: ReturnType<typeof createDexelLayout>;
      tileSlots: Uint32Array;
      estimatedBytes: number;
      dispose = vi.fn();
      releasePreparation = vi.fn();
      takeHistory = vi.fn();
      rotationalBase?: RotationalDexelBase;
      updateBase?: boolean;
      constructor(
        _renderer: unknown,
        _device: unknown,
        size: THREE.Vector3,
        pitch: number,
        _cylinder: boolean,
        private sweeps: CompiledGpuSweep[],
        _placement: THREE.Matrix4,
        capacity: DexelIntervalCapacity,
        options: {
          retainedTiles?: Uint32Array;
          rotationalBase?: RotationalDexelBase;
          updateBase?: boolean;
        },
      ) {
        this.group.matrix.copy(_placement);
        this.rotationalBase = options.rotationalBase;
        this.updateBase = options.updateBase;
        this.layout = createDexelLayout(size, pitch, capacity, {
          bounds: sweeps.map((sweep) => sweep.bounds),
          retainedTiles: options.retainedTiles,
        });
        this.estimatedBytes = this.layout.estimatedBytes;
        this.tileSlots = new Uint32Array(this.layout.tiles).fill(0xffffffff);
        this.layout.storedTiles.forEach((tile, slot) => {
          this.tileSlots[tile] = slot;
        });
        model.constructed(this);
      }
      async copyFrom(source: { applied: CompiledGpuSweep[] }, cancelled: () => boolean) {
        if (cancelled()) throw new DOMException('cancelled', 'AbortError');
        this.applied = [...source.applied];
        model.copy(source);
        return 0;
      }
      async calculate(prefix: number, cancelled: () => boolean) {
        if (cancelled()) throw new DOMException('cancelled', 'AbortError');
        this.applied.push(...this.sweeps.slice(0, prefix));
        model.calculate(this.applied);
        return 0;
      }
    },
  };
});

const insert: ProgramToolDefinition = {
  toolNumber: 1,
  description: 'nose insert',
  Q: 3,
  cutting: [
    {
      type: 'insert',
      shape: 'V',
      ic: 4.7625,
      thickness: 1.59,
      noseRadius: 0.2,
      clearanceAngle: 7,
      zeroVertex: 0,
      rotation: [0, 18, 0],
    },
  ],
};
const mill: ProgramToolDefinition = {
  toolNumber: 200,
  description: 'pocket mill',
  cutting: [{ type: 'endMill', diameter: 0.6, length: 1 }],
};
function motion(
  tool: ProgramToolDefinition,
  mode: RemovalMotion['mode'],
  executionStep: number,
  a: [number, number, number],
  b: [number, number, number],
): RemovalMotion {
  const pose = (position: [number, number, number]) => ({
    position,
    orientation: [0, 0, 0, 1] as [number, number, number, number],
    frameId: 'workpiece:hybrid',
    reference: mode === 'turning' ? ('turningVirtualTip' as const) : ('millingTip' as const),
  });
  return { tool, mode, executionStep, start: pose(a), end: pose(b) };
}
function input(motions: RemovalMotion[] = []): SimulationInput {
  return {
    algorithmVersion: 2,
    stock: { type: 'cylinder', diameter: 4, length: 6 },
    resolutionMm: 0.05,
    motions,
    binding: {
      frameId: 'workpiece:hybrid',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      spindleOrigin: [0, 0, 0],
      spindleAxis: [0, 0, 1],
    },
  };
}
const axial = motion(insert, 'turning', 1, [1.7, 0, -2], [1.7, 0, 2]);
const radial = motion(insert, 'turning', 3, [2.5, 0, 1], [0.2, 0, 1]);
const milling = motion(mill, 'milling', 3, [0.6, 0.5, -0.4], [0.6, 0.5, 0.4]);
const laterTurning = motion(insert, 'turning', 5, [1.5, 0, -2], [1.5, 0, 2]);

function field(frame: GpuReplayFrame, point: THREE.Vector3): number {
  if (frame.backend === 'hybrid-turning') return frame.stock.profile.volume.distance(point);
  const applied = (frame.stock as unknown as { applied: CompiledGpuSweep[] }).applied;
  const base = frame.stock.rotationalBase;
  return Math.max(
    base
      ? base.intervals(2, point).some(([a, b]) => point.z > a && point.z < b)
        ? -1
        : 1
      : cylinderVolume(2, 6).distance(point),
    ...applied.map((sweep) => -evaluateGpuSweep(sweep, point)),
  );
}
function assertPrefix(frame: GpuReplayFrame, config: SimulationInput, through: number) {
  const sweeps = compileGpuSweeps(config).filter((sweep) => sweep.executionStep <= through);
  const stock = config.stock;
  if (stock.type !== 'cylinder') throw new Error('test needs a cylinder');
  const initial = cylinderVolume(stock.diameter / 2, stock.length);
  let compared = 0;
  for (let z = -2.73; z < 3; z += 0.31)
    for (let x = -1.91; x < 2; x += 0.23)
      for (const y of [-0.83, 0.07, 0.51]) {
        const p = new THREE.Vector3(x, y, z);
        const expected = Math.max(
          initial.distance(p),
          ...sweeps.map(
            (sweep) =>
              -(sweep.turningVolume ? sweep.turningVolume.distance(p) : evaluateGpuSweep(sweep, p)),
          ),
        );
        if (Math.abs(expected) < 1e-4) continue;
        expect(field(frame, p) < 0).toBe(expected < 0);
        compared++;
      }
  expect(compared).toBeGreaterThan(500);
}

describe('symmetry-aware hybrid turning replay', () => {
  const sessions: GpuMaterialReplaySession[] = [];
  const refined = vi.fn(),
    failed = vi.fn();
  function session(residentBytes = 0) {
    const replay = new GpuMaterialReplaySession(
      'hybrid:test',
      new WebGPURenderer(),
      {} as GPUDevice,
      {
        finePitchMm: 0.02,
        residentBytes,
        onRefined: refined,
        onRefinementError: failed,
      },
    );
    sessions.push(replay);
    return replay;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    sessions.forEach((replay) => replay.cancel());
    sessions.length = 0;
    vi.useRealTimers();
  });

  it('preserves every cut through turn/mill/turn/mill, repeated prefixes and fine refinement', async () => {
    const secondMill = motion(mill, 'milling', 7, [-0.6, -0.5, -0.4], [-0.6, -0.5, 0.4]);
    const config = input([axial, milling, laterTurning, secondMill]);
    const replay = session();
    await replay.start(
      config,
      Array.from({ length: 9 }, (_, i) => i),
      () => {},
    );
    for (const position of [2, 4, 6, 8, 3, 6, 0, 8, 4, 9]) {
      const frame = await replay.seek(position);
      assertPrefix(frame, config, position - 1);
      expect(frame.backend).toBe(position <= 3 ? 'hybrid-turning' : 'webgpu-dexel');
    }
    await vi.advanceTimersByTimeAsync(350);
    const fine = refined.mock.calls.at(-1)?.[0] as GpuReplayFrame;
    expect(fine).toMatchObject({ position: 9, phase: 'fine', backend: 'webgpu-dexel' });
    assertPrefix(fine, config, 8);
    expect(failed).not.toHaveBeenCalled();
    replay.cancel();
    await expect(replay.seek(4)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('finishes diameter 20 × length 50 turning at 0.02 mm without allocating any 3D rays', async () => {
    const config = {
      ...input([axial]),
      stock: { type: 'cylinder' as const, diameter: 20, length: 50 },
    };
    const progress = vi.fn();
    const replay = session();
    const coarse = await replay.start(config, [0, 1, 2], progress, true);
    expect(coarse).toMatchObject({ backend: 'hybrid-turning', position: 3, phase: 'coarse' });
    expect(coarse.estimatedBytes).toBeLessThan(4 * 1024 * 1024);
    await vi.advanceTimersByTimeAsync(350);
    const fine = refined.mock.calls[0][0] as GpuReplayFrame;
    expect(fine).toMatchObject({ backend: 'hybrid-turning', phase: 'fine', pitchMm: 0.02 });
    expect(fine.estimatedBytes).toBeLessThan(4 * 1024 * 1024);
    expect(model.constructed).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(1, 1);
    if (coarse.backend !== 'hybrid-turning' || fine.backend !== 'hybrid-turning')
      throw new Error('wrong representation');
    expect(fine.stock.profile.encodeHistory()).toEqual(coarse.stock.profile.encodeHistory());
    expect((await replay.seek(3)).phase).toBe('fine');
  });

  it.each([{ motions: [axial] }, { motions: [radial] }, { motions: [axial, radial] }])(
    'matches exact insert removal for axial/radial facing and nose geometry (%#)',
    async ({ motions }) => {
      const config = input(motions);
      const frame = await session().start(config, [0, 1, 2, 3, 4], () => {}, true);
      expect(frame.backend).toBe('hybrid-turning');
      assertPrefix(frame, config, 4);
    },
  );

  it('replays turning → milling → turning without re-revolving or material resurrection', async () => {
    const config = input([axial, milling, laterTurning]);
    const replay = session();
    await replay.start(config, [0, 1, 2, 3, 4, 5, 6]);
    const before = await replay.seek(3);
    expect(before.backend).toBe('hybrid-turning');
    assertPrefix(before, config, 2);
    const transition = await replay.seek(4);
    expect(transition.backend).toBe('webgpu-dexel');
    expect(transition.newMotions).toBe(1);
    expect(
      model.calculate.mock.calls[0][0].map((sweep: CompiledGpuSweep) => sweep.motionIndex),
    ).toEqual([1]);
    if (transition.backend !== 'webgpu-dexel') throw new Error('Expected sparse stock');
    expect(transition.stock.rotationalBase).toBeDefined();
    expect(transition.stock.layout.intervalCapacity).toBe(
      dexelIntervalCapacity(transition.stock.rotationalBase!.maxIntervals),
    );
    assertPrefix(transition, config, 3);
    const pocket = new THREE.Vector3(0.6, 0.5, 0.1);
    expect(field(before, pocket)).toBeLessThan(0);
    expect(field(transition, pocket)).toBeGreaterThan(0);
    const final = await replay.seek(7);
    expect(final.backend).toBe('webgpu-dexel');
    expect(final.newMotions).toBe(1);
    expect(final.reusedPosition).toBe(4);
    expect(field(final, pocket)).toBeGreaterThan(0);
    assertPrefix(final, config, 6);
    // Backward prefixes use their own immutable representation, not final-state stock.
    for (const [position, step] of [
      [2, 1],
      [0, -1],
      [5, 4],
      [3, 2],
      [7, 6],
      [4, 3],
    ]) {
      const frame = await replay.seek(position);
      expect(frame.backend).toBe(step < 3 ? 'hybrid-turning' : 'webgpu-dexel');
      assertPrefix(frame, config, step);
    }
    expect(field(before, pocket)).toBeLessThan(0);
    expect(field(transition, pocket)).toBeGreaterThan(0);
    expect(model.copy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(350);
    expect(refined.mock.calls.at(-1)?.[0]).toMatchObject({
      backend: 'webgpu-dexel',
      phase: 'fine',
      pitchMm: 0.02,
      position: 4,
    });
  });

  it('updates later broad turning implicitly and allocates only localized milling tiles at .02 mm', async () => {
    const first = motion(insert, 'turning', 1, [8, 0, -24], [8, 0, 24]);
    const pocket = motion(mill, 'milling', 3, [6.5, 0, -0.4], [6.5, 0, 0.4]);
    const finish = motion(insert, 'turning', 5, [7, 0, -24], [7, 0, 24]);
    const config = {
      ...input([first, pocket, finish]),
      stock: { type: 'cylinder' as const, diameter: 20, length: 50 },
    };
    const replay = session();
    await replay.start(config, [0, 1, 2, 3, 4, 5, 6]);
    const milled = await replay.seek(4);
    const finished = await replay.seek(7);
    if (milled.backend !== 'webgpu-dexel' || finished.backend !== 'webgpu-dexel')
      throw new Error('Expected sparse mixed stock');
    expect(finished.stock.rotationalBase?.fingerprint).not.toBe(
      milled.stock.rotationalBase?.fingerprint,
    );
    expect(finished.stock.layout.storedTiles).toEqual(milled.stock.layout.storedTiles);
    expect(finished.reusedPosition).toBe(4);
    expect(Reflect.get(finished.stock, 'updateBase')).toBe(true);
    expect(finished.stock.layout.intervalCapacity).toBe(
      dexelIntervalCapacity(
        Math.max(milled.stock.layout.intervalCapacity, finished.stock.rotationalBase!.maxIntervals),
      ),
    );
    expect(field(milled, new THREE.Vector3(7.5, 0.1, 0))).toBeLessThan(0);
    expect(field(finished, new THREE.Vector3(7.5, 0.1, 0))).toBeGreaterThan(0);
    expect(field(finished, new THREE.Vector3(6.5, 0, 0))).toBeGreaterThan(0);
    expect(
      model.calculate.mock.calls.flatMap(([sweeps]) =>
        sweeps.map((sweep: CompiledGpuSweep) => sweep.motionIndex),
      ),
    ).not.toContain(2);
    await vi.advanceTimersByTimeAsync(350);
    const fine = refined.mock.calls.at(-1)?.[0] as GpuReplayFrame;
    expect(fine).toMatchObject({ backend: 'webgpu-dexel', phase: 'fine', pitchMm: 0.02 });
    if (fine.backend !== 'webgpu-dexel') throw new Error('Expected fine sparse stock');
    expect(fine.stock.layout.estimatedBytes).toBeLessThan(8 * 1024 * 1024);
    expect(fine.stock.layout.storedTiles.length).toBeLessThan(32);
    expect(field(fine, new THREE.Vector3(6.5, 0, 0))).toBeGreaterThan(0);
    const earlier = await replay.seek(5);
    expect(field(earlier, new THREE.Vector3(7.5, 0.1, 0))).toBeLessThan(0);
    expect(field(milled, new THREE.Vector3(7.5, 0.1, 0))).toBeLessThan(0);
    expect(failed).not.toHaveBeenCalled();
  });

  it('uses only the target prefix when cold-starting after two turning/milling transitions', async () => {
    const secondMill = motion(mill, 'milling', 7, [-0.6, -0.5, -0.4], [-0.6, -0.5, 0.4]);
    const config = input([axial, milling, laterTurning, secondMill]);
    const replay = session();
    const final = await replay.start(config, [0, 1, 2, 3, 4, 5, 6, 7, 8], () => {}, true);
    assertPrefix(final, config, 8);
    for (const position of [4, 6, 8, 5, 9]) {
      const frame = await replay.seek(position);
      assertPrefix(frame, config, position - 1);
    }
    expect(
      model.constructed.mock.calls.every(([stock]) => stock.rotationalBase !== undefined),
    ).toBe(true);
  });
  it('discards history from another implicit prefix rather than restoring later turning into an earlier state', async () => {
    const replay = session();
    await replay.start(input([axial, milling, laterTurning]), [0, 1, 2, 3, 4, 5, 6]);
    const before = await replay.seek(4);
    if (before.backend !== 'webgpu-dexel') throw new Error('Expected mixed stock');
    const history = new GpuDexelHistory(new Uint32Array(), before.stock.layout.rays, []);
    const disposed = vi.spyOn(history, 'dispose');
    const histories: Map<
      string,
      { history: GpuDexelHistory; through: number; baseFingerprint?: string }
    > = Reflect.get(replay, 'histories');
    histories.set('coarse', {
      history,
      through: 7,
      baseFingerprint: before.stock.rotationalBase?.fingerprint,
    });
    const after = await replay.seek(7);
    expect(disposed).toHaveBeenCalledOnce();
    expect(after.historyHit).toBe(false);
    assertPrefix(after, input([axial, milling, laterTurning]), 6);
    const earlier = await replay.seek(5);
    assertPrefix(earlier, input([axial, milling, laterTurning]), 4);
    expect(field(before, new THREE.Vector3(1.6, 0.1, 0))).toBeLessThan(0);
  });

  it.each(['offset', 'tilted', 'box', 'disabled'])(
    'does not assume a coaxial cylinder for %s stock',
    async (variant) => {
      const config = input([axial]);
      if (variant === 'offset') config.stock = { ...config.stock, position: [0.5, 0, 0] };
      if (variant === 'tilted') config.stock = { ...config.stock, rotation: [30, 0, 0] };
      if (variant === 'box') config.stock = { type: 'box', width: 4, height: 4, depth: 6 };
      if (variant === 'disabled') config.rotationalProfile = false;
      const frame = await session().start(config, [0, 1], () => {}, true);
      expect(frame.backend).toBe('webgpu-dexel');
      expect(model.constructed).toHaveBeenCalled();
    },
  );

  it('accepts axial placement, explicit bound frame transforms and a reversed spindle axis', async () => {
    const config = input([axial, milling]);
    config.stock = { ...config.stock, position: [0, 0, 1], rotation: [0, 0, 90] };
    config.binding = { ...config.binding, position: [7, -3, 2], rotation: [20, 30, 40] };
    const placement = stockPlacement(config.stock, config.binding);
    const inverse = placement.clone().invert();
    // Binding spindle and poses are in the same explicit workpiece frame.
    const bound = new THREE.Matrix4().compose(
      new THREE.Vector3(7, -3, 2),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          ...([20, 30, 40].map(THREE.MathUtils.degToRad) as [number, number, number]),
          'ZYX',
        ),
      ),
      new THREE.Vector3(1, 1, 1),
    );
    config.binding = {
      ...config.binding,
      spindleOrigin: new THREE.Vector3().applyMatrix4(bound).toArray(),
      spindleAxis: new THREE.Vector3(0, 0, -1).transformDirection(bound).toArray(),
    };
    config.motions = config.motions.map((cut) => ({
      ...cut,
      start: {
        ...cut.start,
        position: new THREE.Vector3(...cut.start.position).applyMatrix4(bound).toArray(),
        orientation: new THREE.Quaternion().setFromRotationMatrix(bound).toArray(),
      },
      end: {
        ...cut.end,
        position: new THREE.Vector3(...cut.end.position).applyMatrix4(bound).toArray(),
        orientation: new THREE.Quaternion().setFromRotationMatrix(bound).toArray(),
      },
    }));
    expect(new THREE.Vector3(...config.binding.spindleOrigin).applyMatrix4(inverse).x).toBeCloseTo(
      0,
    );
    const replay = session();
    await replay.start(config, [0, 1, 2, 3]);
    const frame = await replay.seek(3);
    expect(frame.backend).toBe('hybrid-turning');
    expect(frame.stock.group.matrix.elements).toEqual(placement.elements);
    const mixed = await replay.seek(4);
    expect(mixed.backend).toBe('webgpu-dexel');
    expect(mixed.stock.group.matrix.elements).toEqual(placement.elements);
    if (mixed.backend !== 'webgpu-dexel') throw new Error('Expected sparse stock');
    const base = mixed.stock.rotationalBase!;
    const first = compileGpuSweeps(config)[0].turningVolume!;
    for (let z = -2.73; z < 3; z += 0.37)
      for (let x = 0.13; x < 2; x += 0.29) {
        const point = new THREE.Vector3(x, 0.17, z);
        const expected = Math.max(cylinderVolume(2, 6).distance(point), -first.distance(point));
        if (Math.abs(expected) < 1e-6) continue;
        for (const axis of [0, 1, 2])
          expect(
            base
              .intervals(axis, point)
              .some(([a, b]) => point.getComponent(axis) > a && point.getComponent(axis) < b),
          ).toBe(expected < 0);
      }
  });

  it('uses validated mode, never tool number, for T200 drilling', async () => {
    const drill = {
      ...mill,
      cutting: [{ type: 'drill' as const, diameter: 0.6, length: 1, tipAngle: 118 }],
    };
    const drilling = motion(drill, 'milling', 3, [0, 0, -1], [0, 0, 1]);
    const frame = await session().start(input([axial, drilling]), [0, 1, 2, 3], () => {}, true);
    expect(frame.backend).toBe('webgpu-dexel');
    await expect(
      session().start(input([{ ...drilling, mode: 'turning' }]), [0, 1, 2, 3], () => {}, true),
    ).rejects.toThrow();
  });

  it('honours stopped prefixes, including before the first 3D cut', async () => {
    const config = { ...input([axial]), stop: { executionStep: 3, message: 'unsupported pose' } };
    const frame = await session().start(config, [0, 1, 2, 3, 4], () => {}, true);
    expect(frame).toMatchObject({
      backend: 'hybrid-turning',
      position: 3,
      requestedPosition: 5,
      stop: config.stop,
    });
    assertPrefix(frame, config, 2);
    expect(model.constructed).not.toHaveBeenCalled();
  });

  it('cancels pending profile refinement and retains displayed stock until the view releases it', async () => {
    const replay = session();
    const frame = await replay.start(input([axial]), [0, 1], () => {}, true);
    const mesh = frame.stock.group.children[0] as THREE.Mesh;
    const dispose = vi.spyOn(mesh.geometry, 'dispose');
    const scene = new THREE.Scene();
    scene.add(frame.stock.group);
    replay.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(refined).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    scene.remove(frame.stock.group);
    frame.stock.group.userData.releaseGpuStock();
    frame.stock.group.userData.releaseGpuStock();
    expect(dispose).toHaveBeenCalledOnce();
    await expect(replay.seek(0)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('coalesces profile navigation and cancels work between bounded batches', async () => {
    const motions = Array.from({ length: 34 }, (_, i) => ({ ...axial, executionStep: i }));
    const replay = session();
    const pending = replay.start(
      input(motions),
      motions.map((cut) => cut.executionStep),
      () => {},
      true,
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const obsolete = replay.seek(20);
    const obsoleteRejected = expect(obsolete).rejects.toMatchObject({ name: 'AbortError' });
    const latest = replay.seek(2);
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    await obsoleteRejected;
    expect((await latest).position).toBe(2);
    expect(model.constructed).not.toHaveBeenCalled();
  });

  it('yields and cancels initial mixed-stock preparation before allocating GPU stock', async () => {
    const motions = [
      ...Array.from({ length: 34 }, (_, i) => ({ ...axial, executionStep: i })),
      { ...milling, executionStep: 34 },
    ];
    const replay = session();
    const apply = vi.spyOn(RotationalProfile.prototype, 'apply');
    try {
      const pending = replay.start(input(motions), motions.map((cut) => cut.executionStep), () => {}, true);
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(replay.computing).toBe(true);
      expect(apply).toHaveBeenCalledTimes(16);
      expect(model.constructed).not.toHaveBeenCalled();
      replay.cancel();
      await vi.advanceTimersByTimeAsync(0);
      await rejected;
      expect(apply).toHaveBeenCalledTimes(16);
      expect(model.constructed).not.toHaveBeenCalled();
    } finally {
      apply.mockRestore();
    }
  });

  it('does not rescan all compiled sweeps for every inner profile workspace reservation', async () => {
    const config = input([axial, milling, laterTurning]);
    const sweeps = compileGpuSweeps(config);
    const reduce = vi.spyOn(sweeps, 'reduce');
    const compile = vi.spyOn(sweepCompiler, 'compileGpuSweeps').mockReturnValue(sweeps);
    try {
      const frame = await session().start(config, [0, 1, 2, 3, 4, 5], () => {}, true);
      expect(frame.backend).toBe('webgpu-dexel');
      expect(reduce).toHaveBeenCalledOnce();
      expect(frame.estimatedBytes).toBeGreaterThan(
        sweeps.length * (sweepCompiler.GPU_SWEEP_STRIDE * 4 + 256),
      );
    } finally {
      compile.mockRestore();
      reduce.mockRestore();
    }
  });

  it('finishes a yielding mixed-stock prefix once with the same exact turning base', async () => {
    const motions = [
      ...Array.from({ length: 34 }, (_, i) => ({ ...axial, executionStep: i })),
      { ...milling, executionStep: 34 },
    ];
    const config = input(motions);
    const expected = new RotationalProfile(2, 6);
    for (const sweep of compileGpuSweeps(config))
      if (sweep.turningVolume) expected.apply(sweep.turningVolume, () => {});
    const apply = vi.spyOn(RotationalProfile.prototype, 'apply');
    try {
      const pending = session().start(config, motions.map((cut) => cut.executionStep), () => {}, true);
      expect(apply).toHaveBeenCalledTimes(16);
      await vi.advanceTimersByTimeAsync(10);
      const frame = await pending;
      expect(apply).toHaveBeenCalledTimes(34);
      expect(frame.backend).toBe('webgpu-dexel');
      if (frame.backend !== 'webgpu-dexel') throw new Error('Expected mixed stock');
      expect(frame.stock.rotationalBase?.fingerprint).toBe(
        new RotationalDexelBase(expected).fingerprint,
      );
      expect(model.calculate).toHaveBeenCalledOnce();
    } finally {
      apply.mockRestore();
    }
  });

  it('fails an over-budget compact stock explicitly, without GPU work or pitch reduction', async () => {
    const replay = session(256 * 1024 * 1024);
    await expect(replay.start(input([axial]), [0, 1], () => {}, true)).rejects.toThrow('budget');
    expect(model.constructed).not.toHaveBeenCalled();
  });

  it('refines diameter 20 × length 50 localized milling at 0.02 mm with an implicit turned base', async () => {
    const fullTurning = motion(insert, 'turning', 1, [9.7, 0, -24], [9.7, 0, 24]);
    const config = {
      ...input([fullTurning, milling]),
      stock: { type: 'cylinder' as const, diameter: 20, length: 50 },
    };
    const replay = session();
    await replay.start(config, [0, 1, 2, 3]);
    expect((await replay.seek(3)).backend).toBe('hybrid-turning');
    const transition = await replay.seek(4);
    expect(transition).toMatchObject({ backend: 'webgpu-dexel', phase: 'coarse', pitchMm: 0.1 });
    const scene = new THREE.Scene();
    scene.add(transition.stock.group);
    const stock = transition.stock;
    await vi.advanceTimersByTimeAsync(350);
    expect(failed).not.toHaveBeenCalled();
    expect(refined).toHaveBeenCalledOnce();
    const fine = refined.mock.calls[0][0] as GpuReplayFrame;
    expect(fine).toMatchObject({ backend: 'webgpu-dexel', phase: 'fine', pitchMm: 0.02 });
    if (fine.backend !== 'webgpu-dexel') throw new Error('Expected sparse stock');
    expect(fine.stock.layout.storageRays).toBeLessThan(fine.stock.layout.rays / 100);
    expect(fine.estimatedBytes).toBeLessThan(64 * 1024 * 1024);
    expect((await replay.seek(4)).stock).toBe(fine.stock);
    expect(stock.group.parent).toBe(scene);
    replay.cancel();
    scene.remove(stock.group);
    stock.group.userData.releaseGpuStock();
  });
});

describe('compact revolved annular and cutoff surfaces', () => {
  function cut(profile: RotationalProfile, lo: number, hi: number, a: number, b: number) {
    profile.apply(
      turningSectionVolume(
        [
          new THREE.Vector2(lo, a),
          new THREE.Vector2(hi, a),
          new THREE.Vector2(hi, b),
          new THREE.Vector2(lo, b),
        ],
        new THREE.Vector3(),
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(1, 0, 0),
      ),
      () => {},
    );
  }
  it('retains bore/annular intervals and empty cutoff slabs, showing only exposed caps', () => {
    const profile = new RotationalProfile(2, 6);
    cut(profile, 0, 0.4, -4, 4);
    cut(profile, 0.9, 1.2, -2, 2);
    cut(profile, -3, 3, -0.2, 0.2);
    expect(profile.radialIntervals(1)).toEqual([
      [0.4, 0.9],
      [1.2, 2],
    ]);
    expect(profile.radialIntervals(0)).toEqual([]);
    const stock = new RevolvedStock(profile, 0.02, new THREE.Matrix4(), () => {});
    stock.group.updateMatrixWorld(true);
    const geometry = (stock.group.children[0] as THREE.Mesh).geometry;
    const positions = geometry.getAttribute('position'),
      normals = geometry.getAttribute('normal');
    for (let i = 0; i < normals.count; i++) {
      expect(Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i))).toBeCloseTo(1, 5);
      expect(Number.isFinite(positions.getX(i))).toBe(true);
    }
    const cast = (r: number) =>
      new THREE.Raycaster(new THREE.Vector3(r, 0, 5), new THREE.Vector3(0, 0, -1)).intersectObject(
        stock.group,
      )[0]?.point.z;
    expect(cast(0.1)).toBeUndefined();
    expect(cast(0.6)).toBeCloseTo(3);
    expect(cast(1.0)).toBeCloseTo(3);
    const fromGap = new THREE.Raycaster(
      new THREE.Vector3(0.6, 0, 0),
      new THREE.Vector3(0, 0, 1),
    ).intersectObject(stock.group);
    expect(fromGap[0]?.point.z).toBeCloseTo(0.2);
    const fromGroove = new THREE.Raycaster(
      new THREE.Vector3(1, 0, 1),
      new THREE.Vector3(0, 0, 1),
    ).intersectObject(stock.group);
    expect(fromGroove[0]?.point.z).toBeCloseTo(2);
    stock.dispose();
  });
});
