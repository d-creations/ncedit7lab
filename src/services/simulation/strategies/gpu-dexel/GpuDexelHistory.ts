import { StorageBufferAttribute } from 'three/webgpu';
import { SimulationCapabilityError } from '../../shared/SimulationTypes';
import type { CompiledGpuSweep } from './GpuSweepCompiler';
import { DEXEL_BINDING_BYTES, DEXEL_MEMORY_BYTES } from './DexelLayout';

/** Ordered removed intervals, not sampled surfaces or approximated coarse-to-fine cuts. */
export class GpuDexelHistory {
  readonly events: StorageBufferAttribute;
  readonly ranges: StorageBufferAttribute;
  readonly steps: number[];
  readonly estimatedBytes: number;
  readonly count: number;
  private readonly firstRanks: Uint32Array;
  private readonly rankWork: Uint32Array;

  constructor(
    raw: Uint32Array,
    readonly rays: number,
    sweeps: readonly CompiledGpuSweep[],
    readonly stockKey = '',
  ) {
    if (
      raw.length % 4 ||
      raw.length > 4194304 * 4 ||
      !Number.isSafeInteger(rays) ||
      rays < 1 ||
      rays > 0xffffffff
    )
      throw new SimulationCapabilityError('Invalid GPU removal history');
    this.count = raw.length / 4;
    if (
      sweeps.some(
        (sweep, i) =>
          !Number.isSafeInteger(sweep.executionStep) ||
          sweep.executionStep < 0 ||
          (i > 0 && sweep.executionStep < sweeps[i - 1].executionStep),
      )
    )
      throw new SimulationCapabilityError('GPU removal history requires ordered execution steps');
    this.steps = [...new Set(sweeps.map((sweep) => sweep.executionStep))].sort((a, b) => a - b);
    this.rankWork = new Uint32Array(this.steps.length);
    const ranks = new Map(this.steps.map((step, rank) => [step, rank + 1]));
    const order = Uint32Array.from({ length: this.count }, (_, i) => i);
    for (let i = 0; i < this.count; i++) {
      const ray = raw[i * 4],
        key = raw[i * 4 + 1];
      if (ray >= rays || !sweeps[Math.floor(key / 4)])
        throw new SimulationCapabilityError(
          'GPU removal history contains an invalid ray or cutter',
        );
      const span = new Float32Array(raw.buffer, raw.byteOffset + i * 16 + 8, 2);
      if (!span.every(Number.isFinite) || span[0] >= span[1])
        throw new SimulationCapabilityError('GPU removal history contains an invalid interval');
    }
    order.sort((a, b) => raw[a * 4] - raw[b * 4] || raw[a * 4 + 1] - raw[b * 4 + 1]);
    const events = new Uint32Array(Math.max(4, raw.length));
    const tiles = Math.ceil(rays / 1024);
    const changedTiles = [...new Set(Array.from(order, (i) => Math.floor(raw[i * 4] / 1024)))].sort(
      (a, b) => a - b,
    );
    const rangeBytes = (tiles + changedTiles.length * 1024) * 8;
    if (
      rangeBytes > DEXEL_BINDING_BYTES ||
      2 * (rangeBytes + events.byteLength) > DEXEL_MEMORY_BYTES
    )
      throw new SimulationCapabilityError('GPU removal history exceeds storage or memory limits');
    const ranges = new Uint32Array(rangeBytes / 4);
    this.firstRanks = new Uint32Array(tiles).fill(0xffffffff);
    for (let tile = 0; tile < tiles; tile++) ranges[tile * 2] = 0xffffffff;
    changedTiles.forEach((tile, slot) => {
      ranges[tile * 2] = tiles + slot * 1024;
    });
    for (let i = 0; i < this.count; i++) {
      const source = order[i] * 4,
        ray = raw[source];
      const tile = Math.floor(ray / 1024),
        range = (ranges[tile * 2] + (ray % 1024)) * 2;
      if (!ranges[range + 1]) ranges[range] = i;
      ranges[range + 1]++;
      ranges[tile * 2 + 1] = Math.max(ranges[tile * 2 + 1], ranges[range + 1]);
      events.set(raw.subarray(source, source + 4), i * 4);
      events[i * 4 + 1] = ranks.get(sweeps[Math.floor(raw[source + 1] / 4)].executionStep)!;
      this.rankWork[events[i * 4 + 1] - 1]++;
      this.firstRanks[tile] = Math.min(this.firstRanks[tile], events[i * 4 + 1]);
    }
    this.events = new StorageBufferAttribute(events, 4);
    this.ranges = new StorageBufferAttribute(ranges, 2);
    this.estimatedBytes =
      2 * (events.byteLength + ranges.byteLength) +
      this.steps.length * 8 +
      this.rankWork.byteLength +
      this.firstRanks.byteLength;
  }

  rank(step: number): number {
    if ((!Number.isSafeInteger(step) && step !== Infinity) || step < -1)
      throw new SimulationCapabilityError('Invalid GPU history execution step');
    let lo = 0,
      hi = this.steps.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.steps[mid] <= step) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  checkpointPositions(timeline: readonly number[], through: number): number[] {
    if (through < 64 || !this.count) return [];
    const positions = new Set<number>();
    const targets = [this.count / 16, this.count / 3, (this.count * 2) / 3];
    let cumulative = 0,
      target = 0;
    for (let rank = 0; rank < this.rankWork.length && target < targets.length; rank++) {
      cumulative += this.rankWork[rank];
      while (target < targets.length && cumulative >= targets[target]) {
        let lo = 0,
          hi = through;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (timeline[mid] < this.steps[rank]) lo = mid + 1;
          else hi = mid;
        }
        const position =
          target === 0 ? Math.min(lo + 1, Math.max(1, Math.floor(through / 8))) : lo + 1;
        if (position > 0 && position < through) positions.add(position);
        target++;
      }
    }
    return [...positions].sort((a, b) => a - b);
  }

  tiles(step: number): Uint32Array {
    const rank = this.rank(step);
    const tiles: number[] = [];
    for (let tile = 0; tile < this.firstRanks.length; tile++)
      if (this.firstRanks[tile] <= rank) tiles.push(tile);
    return Uint32Array.from(tiles);
  }

  work(afterStep: number, step: number): Uint32Array {
    if (afterStep > step) throw new SimulationCapabilityError('GPU history range is reversed');
    const after = this.rank(afterStep),
      through = this.rank(step);
    const work = new Uint32Array(this.firstRanks.length * 2);
    if (after === through) return work;
    const data = this.events.array;
    const upperBound = (start: number, count: number, rank: number) => {
      let lo = start,
        hi = start + count;
      while (lo < hi) {
        const middle = lo + Math.floor((hi - lo) / 2);
        if (data[middle * 4 + 1] <= rank) lo = middle + 1;
        else hi = middle;
      }
      return lo;
    };
    for (let tile = 0; tile < this.firstRanks.length; tile++) {
      if (this.firstRanks[tile] > through) continue;
      const slot = this.ranges.array[tile * 2];
      let maximum = 0;
      for (let local = 0; local < 1024 && tile * 1024 + local < this.rays; local++) {
        const offset = (slot + local) * 2;
        const start = this.ranges.array[offset],
          count = this.ranges.array[offset + 1];
        if (!count) continue;
        maximum = Math.max(
          maximum,
          upperBound(start, count, through) - upperBound(start, count, after),
        );
      }
      work[tile * 2 + 1] = maximum;
    }
    return work;
  }

  range(ray: number): readonly [number, number] {
    if (!Number.isSafeInteger(ray) || ray < 0 || ray >= this.rays)
      throw new SimulationCapabilityError('Invalid GPU history ray');
    const data = this.ranges.array,
      slot = data[Math.floor(ray / 1024) * 2];
    if (slot === 0xffffffff) return [0, 0];
    const offset = (slot + (ray % 1024)) * 2;
    return [data[offset], data[offset + 1]];
  }

  dispose(): void {
    this.events.dispose();
    this.ranges.dispose();
  }
}
