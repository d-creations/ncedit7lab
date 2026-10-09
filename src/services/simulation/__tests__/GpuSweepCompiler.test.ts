import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoseSample } from '@core/types';
import type {
  CuttingPart,
  ProgramMaterialDefinition,
  ProgramToolDefinition,
} from '../../tools/SimulationMetadata';
import { CuttingToolModel } from '../CuttingToolModel';
import {
  compileGpuSweeps,
  evaluateGpuSweep,
  evaluateGpuSweepRayCuts,
  GPU_SWEEP_MAX_PLANES,
  GPU_SWEEP_STRIDE,
  GPU_SWEEP_WGSL,
  GPU_SWEEP_RAY_WGSL,
  type CompiledGpuSweep,
} from '../GpuSweepCompiler';
import { rotationQuaternion, stockPlacement } from '../SimulationTransforms';
import {
  SimulationCapabilityError,
  type RemovalMotion,
  type SimulationInput,
  type StockBinding,
} from '../SimulationTypes';
import * as TurningEnvelope from '../TurningEnvelope';

const frameId = 'workpiece:gpu-test';
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const tool = (part: CuttingPart): ProgramToolDefinition => ({
  toolNumber: 1,
  description: 'GPU analytical cutter',
  cutting: [part],
});
const flat = tool({ type: 'endMill', diameter: 2, length: 4 });
const ball = tool({ type: 'ballMill', diameter: 2, length: 4 });
const drill = tool({ type: 'drill', diameter: 2, length: 4, tipAngle: 118 });
const rounded = tool({ type: 'endMill', diameter: 2, length: 4, cornerRadius: 0.3 });
const insert = tool({
  type: 'insert',
  shape: 'S',
  ic: 2,
  thickness: 0.8,
  noseRadius: 0.1,
  clearanceAngle: 0,
  rotation: [0, 45, 0],
});

function motion(
  cutter = flat,
  start = v(),
  end = v(3, 0, 0),
  mode: RemovalMotion['mode'] = 'milling',
): RemovalMotion {
  const pose = (position: THREE.Vector3): PoseSample => ({
    position: position.toArray(),
    orientation: [0, 0, 0, 1],
    reference: mode === 'turning' ? 'turningVirtualTip' : 'millingTip',
    frameId,
  });
  return { tool: cutter, mode, executionStep: 7, start: pose(start), end: pose(end) };
}
type FixtureInput = Omit<SimulationInput, 'stock' | 'binding'> & {
  stock: ProgramMaterialDefinition;
  binding: StockBinding;
};
function input(motions: RemovalMotion[]): FixtureInput {
  return {
    algorithmVersion: 2,
    stock: { type: 'box', width: 20, height: 18, depth: 16 },
    binding: {
      frameId,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      spindleOrigin: [0, 0, 0],
      spindleAxis: [0, 0, 1],
    },
    resolutionMm: 0.2,
    motions,
  };
}
function matrices(config: SimulationInput, cut: RemovalMotion) {
  const inverse = stockPlacement(config.stock, config.binding).invert();
  const pose = (sample: PoseSample) =>
    inverse
      .clone()
      .multiply(
        new THREE.Matrix4().compose(
          new THREE.Vector3(...sample.position),
          new THREE.Quaternion(...sample.orientation).normalize(),
          v(1, 1, 1),
        ),
      );
  return {
    inverse,
    start: pose(cut.start),
    end: pose(cut.end),
    cutter: new CuttingToolModel(cut.tool, cut.executedQ),
  };
}
function random() {
  let state = 734911;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
function sampled(sweep: CompiledGpuSweep, count = 100): THREE.Vector3[] {
  const next = random();
  const size = sweep.bounds.getSize(v()).addScalar(2);
  const low = sweep.bounds.min.clone().subScalar(1);
  return Array.from({ length: count }, () => v(next(), next(), next()).multiply(size).add(low));
}
function expectField(sweep: CompiledGpuSweep, reference: (point: THREE.Vector3) => number) {
  for (const point of sampled(sweep, 200)) {
    const expected = reference(point);
    const actual = evaluateGpuSweep(sweep, point);
    expect(Number.isFinite(actual)).toBe(true);
    expect(actual, `point ${point.toArray()}`).toBeCloseTo(expected, 5);
    if (Math.abs(expected) > 1e-5) expect(actual < 0).toBe(expected < 0);
  }
}

afterEach(() => vi.restoreAllMocks());

describe('GPU continuous sweep compiler', () => {
  it('does not emit WGSL reserved identifier words', () => {
    const reserved = new Set(
      `NULL Self abstract active alignas alignof as asm asm_fragment async attribute auto await
       become cast catch class co_await co_return co_yield coherent column_major common compile
       compile_fragment concept const_cast consteval constexpr constinit crate debugger decltype
       delete demote demote_to_helper do dynamic_cast enum explicit export extends extern external
       fallthrough filter final finally friend from fxgroup get goto groupshared highp impl
       implements import inline instanceof interface layout lowp macro macro_rules match mediump
       meta mod module move mut mutable namespace new nil noexcept noinline nointerpolation
       non_coherent noncoherent noperspective null nullptr of operator package packoffset partition
       pass patch pixelfragment precise precision premerge priv protected pub public readonly ref
       regardless register reinterpret_cast require resource restrict self set shared sizeof smooth
       snorm static static_assert static_cast std subroutine super target template this thread_local
       throw trait try type typedef typeid typename typeof union unless unorm unsafe unsized use using
       varying virtual volatile wgsl where with writeonly yield`.split(/\s+/),
    );
    const words = (GPU_SWEEP_WGSL + GPU_SWEEP_RAY_WGSL).match(/\b[A-Za-z_]\w*\b/g) ?? [];
    expect(words.filter((word) => reserved.has(word))).toEqual([]);
  });

  it('packs bounded independent stock-local records in execution order without modifying input', () => {
    const config = input([motion(), motion(ball)]);
    config.motions[1].executionStep = 19;
    const before = JSON.stringify(config);
    const sweeps = compileGpuSweeps(config);
    expect(GPU_SWEEP_STRIDE).toBe(288);
    expect(GPU_SWEEP_MAX_PLANES).toBe(64);
    expect(GPU_SWEEP_STRIDE % 4).toBe(0);
    expect(sweeps.map((sweep) => [sweep.motionIndex, sweep.executionStep])).toEqual([
      [0, 7],
      [1, 19],
    ]);
    expect(sweeps[0].data).toHaveLength(GPU_SWEEP_STRIDE);
    expect(sweeps[0].data).not.toBe(sweeps[1].data);
    expect(sweeps[0].data.every(Number.isFinite)).toBe(true);
    expect(JSON.stringify(config)).toBe(before);
    expect(compileGpuSweeps(input([]))).toEqual([]);
    expect(GPU_SWEEP_WGSL).toContain(
      'fn gpuSweepDistance(point: vec3f, sweep: u32) -> f32',
    );
    expect(GPU_SWEEP_WGSL).toContain('GPU_SWEEP_VEC4_STRIDE: u32 = 72u');
    expect(GPU_SWEEP_WGSL + GPU_SWEEP_RAY_WGSL).not.toMatch(/ptr\s*<\s*storage\b/);
  });

  for (const cutter of [flat, ball, drill, rounded]) {
    for (const end of [v(), v(3, -1, 0), v(0, 0, 3), v(0, 0, -3)]) {
      it(`matches CPU ${cutter.cutting![0].type} continuous field for ${end.toArray()}`, () => {
        const cut = motion(cutter, v(), end);
        const config = input([cut]);
        const { cutter: model, start, end: finish } = matrices(config, cut);
        const sweep = compileGpuSweeps(config)[0];
        const cpu = model.translationSweep(start, finish);
        if (!cpu) {
          // CPU's fallback lacks continuous lateral drill/rounded sweeps: independently
          // minimize the convex pose field, rather than comparing sampled removal.
          const at = (point: THREE.Vector3, t: number) =>
            model
              .volume(new THREE.Matrix4().makeTranslation(end.x * t, end.y * t, end.z * t))
              .distance(point);
          expectField(sweep, (point) => minimize((t) => at(point, t)));
        } else {
          expect(cpu).toBeDefined();
          expectField(sweep, cpu!.distance);
        }
        expect(sweep.bounds.containsBox(model.bounds.clone().applyMatrix4(start))).toBe(true);
        expect(sweep.bounds.containsBox(model.bounds.clone().applyMatrix4(finish))).toBe(true);
      });
    }
  }

  for (const cutter of [flat, ball, drill]) {
    for (const travel of [v(3, 1, 2), v(-2, 1, -3), v(1e-7, -2e-7, 3e-7)]) {
      it(`matches continuous minimax ${cutter.cutting![0].type} diagonal ${travel.toArray()}`, () => {
        const cut = motion(cutter, v(), travel);
        const config = input([cut]);
        const sweep = compileGpuSweeps(config)[0];
        const model = new CuttingToolModel(cutter);
        const identity = new THREE.Matrix4();
        const poseVolume = model.volume(identity);
        expectField(sweep, (point) =>
          minimize((t) => poseVolume.distance(point.clone().addScaledVector(travel, -t))),
        );
        if (cutter === ball)
          expectField(
            sweep,
            model.translationSweep(
              identity,
              new THREE.Matrix4().makeTranslation(...travel.toArray()),
            )!.distance,
          );
      });
    }
  }

  it('preserves cutter offsets/rotations, pose rotations, stock zeroVertex and binding placement', () => {
    const rotated = tool({
      type: 'ballMill',
      diameter: 2,
      length: 4,
      position: [1.2, -0.7, 0.4],
      rotation: [30, -15, 70],
    });
    const cut = motion(rotated, v(5, 2, -3), v(9, 1, 0));
    cut.start.orientation = rotationQuaternion([20, 30, -10]).toArray();
    cut.end.orientation = [
      -cut.start.orientation[0],
      -cut.start.orientation[1],
      -cut.start.orientation[2],
      -cut.start.orientation[3],
    ];
    const config = input([cut]);
    config.stock = {
      type: 'box',
      width: 20,
      height: 18,
      depth: 16,
      zeroVertex: 5,
      position: [3, -1, 2],
      rotation: [10, 15, 20],
    };
    config.binding.position = [8, -9, 5];
    config.binding.rotation = [25, -40, 5];
    const { cutter: model, start, end } = matrices(config, cut);
    const compiled = compileGpuSweeps(config)[0];
    expectField(compiled, model.translationSweep(start, end)!.distance);
    const copy = { ...compiled, data: compiled.data.slice() };
    expect(evaluateGpuSweep(copy, v(1, 2, 3))).toBe(evaluateGpuSweep(compiled, v(1, 2, 3)));
  });

  it('supports continuous diagonal flat cutters in their own rotated local frame', () => {
    const cutter = tool({
      type: 'endMill',
      diameter: 2,
      length: 4,
      position: [0.7, -0.3, 1.5],
      rotation: [20, 35, -15],
    });
    const cut = motion(cutter, v(1, 2, 3), v(5, -1, 6));
    const config = input([cut]);
    config.binding.rotation = [20, 10, 30];
    const { cutter: model, start, end } = matrices(config, cut);
    const displacement = v().setFromMatrixPosition(end).sub(v().setFromMatrixPosition(start));
    const volume = model.volume(start);
    expectField(compileGpuSweeps(config)[0], (point) =>
      minimize((t) => volume.distance(point.clone().addScaledVector(displacement, -t))),
    );
  });

  it('resolves near-boundary lateral and diagonal surfaces without depth stepping', () => {
    const lateral = compileGpuSweeps(input([motion(flat, v(), v(1000, 0, 0))]))[0];
    for (const epsilon of [-1e-4, 0, 1e-4]) {
      expect(evaluateGpuSweep(lateral, v(499.12345, 1 + epsilon, 2))).toBeCloseTo(epsilon, 7);
    }
    const diagonal = compileGpuSweeps(input([motion(flat, v(), v(3, 0, 3))]))[0];
    for (const epsilon of [-1e-4, 1e-4]) {
      const value = evaluateGpuSweep(diagonal, v(1.5, 1 + epsilon, 3.5));
      expect(value < 0).toBe(epsilon < 0);
      expect(Math.abs(value)).toBeCloseTo(Math.abs(epsilon), 7);
    }
    const sphere = compileGpuSweeps(input([motion(ball, v(), v(3, 0, 0))]))[0];
    for (const epsilon of [-1e-4, 1e-4]) {
      expect(evaluateGpuSweep(sphere, v(1.5, 0, epsilon)) < 0).toBe(epsilon > 0);
    }
  });

  for (const sign of [1, -1]) {
    for (const radial of [4, -4, 0]) {
      it(`matches reflected/annular turning section radius ${radial}, spindle sign ${sign}, Q override`, () => {
        const turning = { ...insert, Q: 1 };
        const cut = motion(turning, v(radial + 2, 0, 0.5), v(radial + 2, 0, 3), 'turning');
        cut.executedQ = 3;
        const config = input([motion(ball), cut]);
        config.binding.spindleOrigin = [2, 0, 1];
        config.binding.spindleAxis = [0, 0, sign];
        config.binding.position = [3, -5, 2];
        config.binding.rotation = [20, -30, 40];
        config.stock.position = [2, 1, 3];
        config.stock.rotation = [10, 15, -5];
        const { cutter: model, start, end, inverse } = matrices(config, cut);
        const origin = new THREE.Vector3(...config.binding.spindleOrigin).applyMatrix4(inverse);
        const axis = new THREE.Vector3(...config.binding.spindleAxis).transformDirection(inverse);
        const cpu = TurningEnvelope.buildTurningSweep(model, start, end, origin, axis);
        const sweeps = compileGpuSweeps(config);
        expect(sweeps[1].motionIndex).toBe(1);
        expect(sweeps[1].data[0]).toBe(5);
        expectField(sweeps[1], cpu.distance);
        expect(sweeps[1].bounds.containsBox(cpu.bounds)).toBe(true);
        const withoutQ = compileGpuSweeps(
          input([
            {
              ...cut,
              executedQ: 1,
              start: { ...cut.start },
              end: { ...cut.end },
            },
          ]),
        )[0];
        expect(Array.from(withoutQ.data)).not.toEqual(Array.from(sweeps[1].data));
      });
    }
  }

  it('keeps an annular hole and folds a section that crosses zero radius', () => {
    for (const polygon of [
      [
        new THREE.Vector2(2, -1),
        new THREE.Vector2(4, -1),
        new THREE.Vector2(4, 1),
        new THREE.Vector2(2, 1),
      ],
      [
        new THREE.Vector2(-1, -1),
        new THREE.Vector2(2, -1),
        new THREE.Vector2(2, 1),
        new THREE.Vector2(-1, 1),
      ],
    ]) {
      const section = TurningEnvelope.turningSectionVolume(polygon, v(), v(0, 0, 1), v(1));
      vi.spyOn(TurningEnvelope, 'buildTurningSweep').mockReturnValue(section);
      const compiled = compileGpuSweeps(input([motion(insert, v(), v(), 'turning')]))[0];
      expectField(compiled, section.distance);
      for (const epsilon of [-1e-4, 1e-4]) {
        const outer = Math.max(...polygon.map((p) => Math.abs(p.x)));
        expect(evaluateGpuSweep(compiled, v(outer + epsilon, 0, 0)) < 0).toBe(epsilon < 0);
      }
      expect(evaluateGpuSweep(compiled, v()) < 0).toBe(polygon[0].x < 0);
      vi.restoreAllMocks();
    }
  });

  it('fields are conservatively Lipschitz under packed transforms', () => {
    const cuts = [
      motion(flat, v(), v(3, 1, 2)),
      motion(ball),
      motion(drill, v(), v(2, 1, -3)),
      motion(rounded),
    ];
    const config = input(cuts);
    config.binding.rotation = [25, 50, -20];
    for (const sweep of compileGpuSweeps(config)) {
      const points = sampled(sweep, 100);
      for (const point of points) {
        const neighbor = point.clone().add(v(0.001, -0.002, 0.003));
        const difference = Math.abs(
          evaluateGpuSweep(sweep, point) - evaluateGpuSweep(sweep, neighbor),
        );
        expect(difference).toBeLessThanOrEqual(point.distanceTo(neighbor) + 1e-9);
      }
    }
  });

  it('rejects unsupported sweep geometry rather than approximating it', () => {
    const changing = motion(ball);
    changing.end.orientation = rotationQuaternion([0, 0.001, 0]).toArray();
    expect(() => compileGpuSweeps(input([changing]))).toThrow(SimulationCapabilityError);
    expect(() => compileGpuSweeps(input([changing]))).toThrow(/changing orientations/);
    expect(() => compileGpuSweeps(input([motion(rounded, v(), v(1, 0, 1))]))).toThrow(
      /diagonal rounded sweep unsupported/,
    );
    expect(() => compileGpuSweeps(input([motion(insert)]))).toThrow(/insert milling/);
    expect(() => compileGpuSweeps(input([motion(flat, v(), v(), 'turning')]))).toThrow(
      SimulationCapabilityError,
    );
    expect(() =>
      compileGpuSweeps(input([motion(insert, v(4, 1, 0), v(4, 2, 1), 'turning')])),
    ).toThrow(SimulationCapabilityError);
    const wrongFrame = motion();
    wrongFrame.end.frameId = 'other';
    expect(() => compileGpuSweeps(input([wrongFrame]))).toThrow(/bound stock frame/);
    const invalidPose = motion();
    invalidPose.start.position = [NaN, 0, 0];
    expect(() => compileGpuSweeps(input([invalidPose]))).toThrow(/finite XYZ/);
    const multiple = { ...flat, cutting: [flat.cutting![0], flat.cutting![0]] };
    expect(() => compileGpuSweeps(input([motion(multiple)]))).toThrow(/exactly one cutting part/);
  });

  it('rejects excessive turning plane counts explicitly', () => {
    const polygon = Array.from({ length: GPU_SWEEP_MAX_PLANES + 1 }, (_, i) => {
      const angle = (i * Math.PI * 2) / (GPU_SWEEP_MAX_PLANES + 1);
      return new THREE.Vector2(4 + Math.cos(angle), Math.sin(angle));
    });
    vi.spyOn(TurningEnvelope, 'buildTurningSweep').mockReturnValue(
      TurningEnvelope.turningSectionVolume(polygon, v(), v(0, 0, 1), v(1)),
    );
    expect(() => compileGpuSweeps(input([motion(insert, v(), v(), 'turning')]))).toThrow(
      /65 planes; maximum is 64/,
    );
  });
});

function minimize(field: (t: number) => number): number {
  let low = 0,
    high = 1;
  for (let iteration = 0; iteration < 90; iteration++) {
    const a = low + (high - low) / 3;
    const b = high - (high - low) / 3;
    if (field(a) <= field(b)) high = b;
    else low = a;
  }
  return Math.min(field(0), field(1), field((low + high) / 2));
}

describe('bounded GPU ray sweep intervals', () => {
  function intervals(
    sweep: CompiledGpuSweep,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    limits: readonly [number, number] = [-6, 6],
  ): [number, number][] {
    const result = evaluateGpuSweepRayCuts(sweep, origin, direction, limits);
    expect(result).not.toBe(99);
    if (result === 99) throw new Error('Unexpected interval overflow');
    expect(result.length).toBeLessThanOrEqual(4);
    for (let i = 0; i < result.length; i++) {
      expect(result[i][0]).toBeGreaterThanOrEqual(limits[0]);
      expect(result[i][1]).toBeLessThanOrEqual(limits[1]);
      expect(result[i][0]).toBeLessThanOrEqual(result[i][1]);
      if (i > 0) expect(result[i][0]).toBeGreaterThan(result[i - 1][1]);
    }
    for (let i = 0; i <= 300; i++) {
      const t = limits[0] + ((limits[1] - limits[0]) * i) / 300;
      const point = origin.clone().addScaledVector(direction, t);
      const field = evaluateGpuSweep(sweep, point);
      const inside = result.some(([low, high]) => low <= t && t <= high);
      // Root arithmetic has a conservative scale-relative boundary allowance.
      if (Math.abs(field) > 2e-4) expect(inside, `ray t=${t}, field=${field}`).toBe(field < 0);
    }
    return result;
  }

  it('exports the bounded ray helper with unchanged record stride', () => {
    expect(GPU_SWEEP_RAY_WGSL).toContain(
      'fn gpuSweepRayCuts(origin:vec3f,direction:vec3f,limits:vec2f,sweep:u32,cuts:ptr<function,array<vec2f,4>>) -> u32',
    );
    expect(GPU_SWEEP_RAY_WGSL).toContain('return 99u');
    expect(GPU_SWEEP_STRIDE).toBe(288);
  });

  for (const cutter of [flat, ball, drill, rounded]) {
    for (const travel of [v(3, -1, 0), v(0, 0, 3), v(0, 0, -2)]) {
      it(`clips ${cutter.cutting![0].type} ${travel.toArray()} on transverse and axial rays`, () => {
        const sweep = compileGpuSweeps(input([motion(cutter, v(), travel)]))[0];
        for (const origin of [v(0, 0, 0), v(0, 0, 1), v(0, 0.4, 2), v(1, 0, 3)]) {
          intervals(sweep, origin, v(1));
          intervals(sweep, origin, v(0, 1));
          intervals(sweep, origin, v(0, 0, 1));
        }
      });
    }
  }

  for (const cutter of [flat, ball, drill]) {
    it(`clips diagonal continuous ${cutter.cutting![0].type} translations`, () => {
      const sweep = compileGpuSweeps(input([motion(cutter, v(), v(3, -1, 2))]))[0];
      for (const origin of [v(), v(0, 0.4, 2), v(2, 0, 3)]) {
        intervals(sweep, origin, v(1));
        intervals(sweep, origin, v(1, 1, 1).normalize());
      }
    });
  }

  it('terminates long tangent flat-face rays and cap rays without sphere tracing', () => {
    const sweep = compileGpuSweeps(input([motion(flat, v(), v(1000, 0, 0))]))[0];
    const cuts = intervals(sweep, v(0, 1, 2), v(1), [0, 1000]);
    expect(cuts).toEqual([[0, 1000]]);
    const cap = intervals(sweep, v(0, 0, 0), v(1), [-2, 1002]);
    expect(cap).toHaveLength(1);
    expect(cap[0][0]).toBeCloseTo(-1, 1);
    expect(cap[0][1]).toBeCloseTo(1001, 1);
    expect(intervals(sweep, v(0, 1.1, 2), v(1), [0, 1000])).toEqual([]);
  });

  it('localizes rounded cutters across the old internal equator zero seam', () => {
    const sweep = compileGpuSweeps(input([motion(rounded, v(), v())]))[0];
    const vertical = intervals(sweep, v(), v(0, 0, 1), [-1, 5]);
    expect(vertical).toHaveLength(1);
    expect(vertical[0][0]).toBeCloseTo(0, 4);
    expect(vertical[0][1]).toBeCloseTo(4, 4);
    const seam = intervals(sweep, v(0, 0, sweep.data[3]), v(1), [-2, 2]);
    expect(seam).toHaveLength(1);
    expect(seam[0][0]).toBeCloseTo(-1, 4);
    expect(seam[0][1]).toBeCloseTo(1, 4);
  });

  function sectionSweep(polygon: THREE.Vector2[]): CompiledGpuSweep {
    const volume = TurningEnvelope.turningSectionVolume(polygon, v(), v(0, 0, 1), v(1));
    vi.spyOn(TurningEnvelope, 'buildTurningSweep').mockReturnValue(volume);
    const sweep = compileGpuSweeps(input([motion(insert, v(), v(), 'turning')]))[0];
    vi.restoreAllMocks();
    return sweep;
  }

  it('clips an annulus into two diameter intervals without filling its bore', () => {
    const sweep = sectionSweep([
      new THREE.Vector2(2, -1),
      new THREE.Vector2(4, -1),
      new THREE.Vector2(4, 1),
      new THREE.Vector2(2, 1),
    ]);
    const cuts = intervals(sweep, v(), v(1));
    expect(cuts).toHaveLength(2);
    expect(cuts[0][0]).toBeCloseTo(-4, 4);
    expect(cuts[0][1]).toBeCloseTo(-2, 4);
    expect(cuts[1][0]).toBeCloseTo(2, 4);
    expect(cuts[1][1]).toBeCloseTo(4, 4);
    expect(intervals(sweep, v(), v(0, 0, 1))).toEqual([]);
    intervals(sweep, v(0, 2, 0), v(1));
    intervals(sweep, v(0, 4, 0), v(1));
  });

  it('handles reflected radial sections, zero crossings, oblique rays and axial plane limits', () => {
    for (const polygon of [
      [
        new THREE.Vector2(-4, -1),
        new THREE.Vector2(-2, -1),
        new THREE.Vector2(-2, 2),
        new THREE.Vector2(-4, 2),
      ],
      [
        new THREE.Vector2(-2, -1),
        new THREE.Vector2(4, -1),
        new THREE.Vector2(3, 2),
        new THREE.Vector2(-1, 2),
      ],
      [
        new THREE.Vector2(2, -2),
        new THREE.Vector2(4, -1),
        new THREE.Vector2(5, 2),
        new THREE.Vector2(1, 1),
      ],
    ]) {
      const sweep = sectionSweep(polygon);
      for (const origin of [v(), v(0, 1, 0), v(0, 3, 0)]) {
        intervals(sweep, origin, v(1));
        intervals(sweep, origin, v(1, 0, 0.3).normalize());
        intervals(sweep, origin, v(0, 0, 1));
      }
    }
  });

  it('clips turned inserts with offset/reversed spindle in transformed stock coordinates', () => {
    const cut = motion(insert, v(5, 0, 0), v(5, 0, 3), 'turning');
    cut.executedQ = 3;
    const config = input([cut]);
    config.binding.spindleOrigin = [1, 0, 0];
    config.binding.spindleAxis = [0, 0, -1];
    config.binding.position = [2, -5, 1];
    config.binding.rotation = [20, -30, 15];
    const sweep = compileGpuSweeps(config)[0];
    const inverse = stockPlacement(config.stock, config.binding).invert();
    const rayOrigin = v(1, 0, 1).applyMatrix4(inverse);
    const rayDirection = v(1).transformDirection(inverse);
    intervals(sweep, rayOrigin, rayDirection, [-8, 8]);
    intervals(sweep, rayOrigin, v(0, 0, 1).transformDirection(inverse), [-8, 8]);
  });

  it('reports invalid records and unsupported numeric ray domains as 99, not empty cuts', () => {
    const sweep = compileGpuSweeps(input([motion()]))[0];
    expect(evaluateGpuSweepRayCuts(sweep, v(), v(), [-1, 1])).toBe(99);
    expect(evaluateGpuSweepRayCuts(sweep, v(), v(1), [2, 1])).toBe(99);
    expect(evaluateGpuSweepRayCuts(sweep, v(NaN), v(1), [-1, 1])).toBe(99);
    expect(evaluateGpuSweepRayCuts(sweep, v(), v(1), [-Infinity, 1])).toBe(99);
    expect(evaluateGpuSweepRayCuts(sweep, v(1e20), v(1), [-1, 1])).toBe(99);
    const invalid = { ...sweep, data: sweep.data.slice() };
    invalid.data[30] = 0;
    expect(evaluateGpuSweepRayCuts(invalid, v(), v(1), [-1, 1])).toBe(99);
    invalid.data[30] = 1;
    invalid.data[0] = 6;
    expect(evaluateGpuSweepRayCuts(invalid, v(), v(1), [-1, 1])).toBe(99);
  });

  it('reports a valid convex turning section requiring more than four ray intervals as overflow', () => {
    const polygon = Array.from({ length: 9 }, (_, i) => {
      const z = -2 + i / 2;
      return new THREE.Vector2(Math.hypot(1, z), z);
    });
    const sweep = sectionSweep(polygon);
    expect(evaluateGpuSweepRayCuts(sweep, v(0, 1, 0), v(1, 0, 1), [-2, 2])).toBe(99);
  });
});
