import { StorageBufferAttribute } from 'three/webgpu';
import { DEXEL_BINDING_BYTES, DEXEL_MEMORY_BYTES, type DexelIntervalCapacity } from './DexelLayout';
import { SimulationCapabilityError } from '../../shared/SimulationTypes';

/** Fixed buffers keep Three.js bindings stable while immutable stocks share tile slots. */
export class GpuDexelTileArena {
  readonly intervals: StorageBufferAttribute;
  readonly counts: StorageBufferAttribute;
  readonly estimatedBytes: number;
  private references: Uint32Array;
  private readonly free: number[];
  private owners = 0;
  private retired = false;

  constructor(
    readonly tiles: number,
    readonly capacity: DexelIntervalCapacity,
    memoryLimitBytes: number = DEXEL_MEMORY_BYTES,
  ) {
    const intervalBytes = Math.max(1, tiles * 1024) * capacity * 8;
    this.estimatedBytes = 2 * (intervalBytes + Math.max(1, tiles * 1024) * 4) + tiles * 12;
    if (
      !Number.isSafeInteger(tiles) ||
      tiles < 0 ||
      ![4, 8, 16, 32, 64].includes(capacity) ||
      intervalBytes > DEXEL_BINDING_BYTES ||
      this.estimatedBytes > memoryLimitBytes
    )
      throw new SimulationCapabilityError('GPU tile arena exceeds storage or memory limits');
    this.intervals = new StorageBufferAttribute(new Float32Array(intervalBytes / 4), 2);
    this.counts = new StorageBufferAttribute(new Uint32Array(Math.max(1, tiles * 1024)), 1);
    this.references = new Uint32Array(tiles);
    this.free = Array.from({ length: tiles }, (_, i) => tiles - i - 1);
  }

  get available(): number {
    return this.free.length;
  }

  allocate(): number {
    const slot = this.free.pop();
    if (slot === undefined) throw new SimulationCapabilityError('GPU tile arena is full');
    this.references[slot] = 1;
    return slot;
  }

  acquire(): void {
    if (this.retired) throw new SimulationCapabilityError('GPU tile arena is disposed');
    this.owners++;
  }

  retain(slot: number): number {
    if (!this.references[slot]) throw new Error('Cannot retain a released GPU tile');
    this.references[slot]++;
    return slot;
  }

  exclusive(slot: number): boolean {
    return this.references[slot] === 1;
  }

  release(slots: Iterable<number>): void {
    for (const slot of slots) {
      if (!this.references[slot]) throw new Error('GPU tile released twice');
      if (--this.references[slot] === 0) this.free.push(slot);
    }
    if (--this.owners === 0) {
      this.retired = true;
      this.intervals.dispose();
      this.counts.dispose();
      this.intervals.array = new Float32Array(2);
      this.counts.array = new Uint32Array(1);
      this.references = new Uint32Array(0);
      this.free.length = 0;
    }
  }
}
