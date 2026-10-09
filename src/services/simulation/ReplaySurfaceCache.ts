import type { StockSurfaceChunk } from './SimulationTypes';

export const REPLAY_SURFACE_BYTES = 64 * 1024 * 1024;

interface Version {
  key: string;
  chunk: StockSurfaceChunk;
  bytes: number;
  references: number;
}

interface SurfaceState {
  versions: Version[];
  chunks: StockSurfaceChunk[];
  bytes: number;
}

function hash(chunk: StockSurfaceChunk): string {
  let value = 2166136261;
  for (const array of [chunk.positions, chunk.normals]) {
    const words = new Uint32Array(array.buffer, array.byteOffset, array.length);
    for (const word of words) value = Math.imul(value ^ word, 16777619);
  }
  return `${chunk.id}:${chunk.positions.length}:${value >>> 0}`;
}

function equal(a: StockSurfaceChunk, b: StockSurfaceChunk): boolean {
  for (const [left, right] of [
    [a.positions, b.positions],
    [a.normals, b.normals],
  ]) {
    if (left.length !== right.length) return false;
    const x = new Uint32Array(left.buffer, left.byteOffset, left.length);
    const y = new Uint32Array(right.buffer, right.byteOffset, right.length);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}

/** Exact visited-state manifests share immutable chunk versions, never whole mesh copies. */
export class ReplaySurfaceCache {
  private readonly states = new Map<number, SurfaceState>();
  private readonly versions = new Map<string, Version[]>();
  private readonly objects = new Map<StockSurfaceChunk, Version>();
  private retainedBytes = 0;
  private warned = false;
  skipped = 0;
  evictions = 0;
  clears = 0;

  constructor(private readonly limit = REPLAY_SURFACE_BYTES) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > REPLAY_SURFACE_BYTES)
      throw new Error('Replay surface cache exceeds its supported memory bound');
  }

  get bytes(): number {
    return this.retainedBytes;
  }
  get size(): number {
    return this.states.size;
  }
  get versionCount(): number {
    return this.objects.size;
  }

  get(position: number): readonly StockSurfaceChunk[] | undefined {
    const state = this.states.get(position);
    if (!state) return undefined;
    this.states.delete(position);
    this.states.set(position, state);
    return state.chunks;
  }

  private remove(position: number): void {
    const state = this.states.get(position);
    if (!state) return;
    this.states.delete(position);
    this.retainedBytes -= state.bytes;
    for (const version of state.versions) {
      if (--version.references) continue;
      this.retainedBytes -= version.bytes;
      this.objects.delete(version.chunk);
      const bucket = this.versions.get(version.key)!;
      bucket.splice(bucket.indexOf(version), 1);
      if (!bucket.length) this.versions.delete(version.key);
    }
  }

  release(required: number): number {
    const before = this.bytes;
    while (this.states.size && before - this.bytes < required) {
      this.remove(this.states.keys().next().value!);
      this.evictions++;
    }
    return before - this.bytes;
  }

  clear(): void {
    this.clears += this.states.size;
    this.states.clear();
    this.versions.clear();
    this.objects.clear();
    this.retainedBytes = 0;
  }

  retain(
    position: number,
    chunks: readonly StockSurfaceChunk[],
    canRetain: (bytes: number) => boolean,
  ): boolean {
    if (!Number.isSafeInteger(position) || position < 0)
      throw new Error('Invalid historical surface position');
    if (!this.limit) return false;
    this.remove(position);
    const metadata = 256 + chunks.length * 32;
    const staging = 4096 + chunks.length * 512;
    while (this.states.size && !canRetain(this.bytes + metadata + staging)) this.release(1);
    if (!canRetain(this.bytes + metadata + staging)) return this.skip();
    const versions: Version[] = [];
    const ids = new Set<number>();
    for (const chunk of chunks) {
      if (
        ids.has(chunk.id) ||
        chunk.positions.length % 9 ||
        chunk.positions.length !== chunk.normals.length
      )
        throw new Error('Invalid historical surface chunk');
      ids.add(chunk.id);
      const object = this.objects.get(chunk);
      if (object) {
        versions.push(object);
        continue;
      }
      const key = hash(chunk);
      const existing = this.versions.get(key)?.find((version) => equal(chunk, version.chunk));
      versions.push(
        existing ?? {
          key,
          chunk,
          references: 0,
          bytes: chunk.positions.buffer.byteLength + chunk.normals.buffer.byteLength + 512,
        },
      );
    }
    const demand = (): number =>
      this.bytes +
      metadata +
      versions.reduce((sum, version) => sum + (version.references ? 0 : version.bytes), 0);
    while (this.states.size && (demand() > this.limit || !canRetain(demand() + staging)))
      this.release(1);
    if (demand() > this.limit || !canRetain(demand() + staging)) return this.skip();
    for (const version of versions) {
      if (!version.references++) {
        const bucket = this.versions.get(version.key) ?? [];
        bucket.push(version);
        this.versions.set(version.key, bucket);
        this.objects.set(version.chunk, version);
        this.retainedBytes += version.bytes;
      }
    }
    this.states.set(position, {
      versions,
      chunks: versions.map((version) => version.chunk),
      bytes: metadata,
    });
    this.retainedBytes += metadata;
    return true;
  }

  private skip(): false {
    this.skipped++;
    if (!this.warned) {
      console.warn(
        'Historical surface cache cannot retain this state within its memory budget; uncached jumps will remesh at unchanged detail.',
      );
      this.warned = true;
    }
    return false;
  }
}
