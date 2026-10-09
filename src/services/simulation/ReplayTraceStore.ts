export interface TraceUpdate {
  key: number;
  before: Uint8Array;
  after: Uint8Array;
}

export interface TraceRecord {
  key: number;
  data: Uint8Array;
}

export interface ReplayTraceStore {
  readonly bytes: number;
  readonly indexBytes: number;
  readonly warning: string | undefined;
  readonly available: boolean;
  write(position: number, updates: readonly TraceUpdate[]): Promise<boolean>;
  /** Reserves the total transient workspace demand, not an incremental allocation. */
  restore(
    from: number,
    to: number,
    reserveWorkspace?: (bytes: number) => void,
  ): AsyncIterable<TraceRecord>;
  close(): Promise<void>;
}

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_RAW_BYTES = 64 * 1024 * 1024;
const MIN_GZIP_BYTES = 512;
const MAX_KEYS = 65536;
const RECORD_OVERHEAD = 128;
const INDEX_OVERHEAD = 4096;
const KEY_INDEX_BYTES = 128;
const RESTORE_BATCH_RECORDS = 64;
const RESTORE_BATCH_BYTES = 8 * 1024 * 1024;
const BATCH_METADATA_BYTES = 512;
const DECODE_CONCURRENCY = 4;
const STORE = 'regions';
const METADATA = 'metadata';
let sessionCounter = 0;

interface StoredRecord {
  key: number;
  position: number;
  data: Uint8Array;
  rawBytes: number;
  codec: 'raw' | 'gzip';
}

interface RecordMetadata extends Omit<StoredRecord, 'data'> {
  compressedBytes: number;
}

function growKeyCapacity(capacity: number): number {
  return Math.min(MAX_KEYS, Math.max(64, capacity * 2));
}

function payloadWorkspace(info: RecordMetadata): number {
  return info.rawBytes * 4 + info.compressedBytes * 2;
}

function validateMetadata(
  info: RecordMetadata | undefined,
  key: number,
  to: number,
): RecordMetadata {
  if (
    !info ||
    info.key !== key ||
    !Number.isSafeInteger(info.position) ||
    info.position < 0 ||
    info.position > to ||
    !Number.isSafeInteger(info.rawBytes) ||
    info.rawBytes < 0 ||
    info.rawBytes > MAX_RAW_BYTES ||
    !Number.isSafeInteger(info.compressedBytes) ||
    info.compressedBytes < 0 ||
    info.compressedBytes + RECORD_OVERHEAD > MAX_BYTES ||
    (info.codec !== 'raw' && info.codec !== 'gzip') ||
    (info.codec === 'raw' && info.rawBytes !== info.compressedBytes)
  ) {
    throw new Error(`Replay trace invalid or missing metadata for region ${key}`);
  }
  return info;
}

function position(value: number, writing = false): void {
  if (!Number.isSafeInteger(value) || value < (writing ? 1 : 0)) {
    throw new RangeError(
      'Replay trace position must be a safe nonnegative integer (writes start at 1)',
    );
  }
}

function validateUpdates(updates: readonly TraceUpdate[]): Map<number, TraceUpdate> {
  const unique = new Map<number, TraceUpdate>();
  for (const update of updates) {
    if (!Number.isSafeInteger(update.key) || update.key < -1) {
      throw new RangeError('Replay trace key must be -1 or a safe nonnegative integer');
    }
    for (const data of [update.before, update.after]) {
      if (!(data instanceof Uint8Array)) {
        throw new TypeError('Replay trace blobs must be Uint8Array');
      }
      if (data.byteLength > MAX_RAW_BYTES) {
        throw new RangeError('Replay trace raw record exceeds 64 MiB');
      }
    }
    const first = unique.get(update.key);
    unique.set(update.key, first ? { ...update, before: first.before } : update);
    if (unique.size > MAX_KEYS) throw new RangeError('Replay trace exceeds 65536 region keys');
  }
  return unique;
}

function size(record: StoredRecord): number {
  return record.data.byteLength + RECORD_OVERHEAD;
}

function rawRecord(key: number, at: number, data: Uint8Array): StoredRecord {
  return { key, position: at, data: data.slice(), rawBytes: data.byteLength, codec: 'raw' };
}

abstract class TraceStoreBase implements ReplayTraceStore {
  bytes = 0;
  warning: string | undefined;
  available = true;
  protected closing = false;
  protected indexOverhead = INDEX_OVERHEAD;
  protected pending: Promise<unknown> = Promise.resolve();

  protected warn(error: unknown, fatal = true): void {
    this.warning = `Replay trace cache: ${error instanceof Error ? error.message : String(error)}`;
    console.warn(this.warning);
    if (fatal) this.available = false;
  }

  protected enqueue(operation: () => Promise<boolean>): Promise<boolean> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  protected checkReadable(): void {
    if (!this.available || this.closing)
      throw new Error(this.warning ?? 'Replay trace cache is closed');
  }

  abstract write(position: number, updates: readonly TraceUpdate[]): Promise<boolean>;
  abstract readonly indexBytes: number;
  abstract restore(
    from: number,
    to: number,
    reserveWorkspace?: (bytes: number) => void,
  ): AsyncIterable<TraceRecord>;
  abstract close(): Promise<void>;
}

/** Uncompressed temporal store for deterministic tests; returned blobs never alias stored data. */
export class MemoryReplayTraceStore extends TraceStoreBase {
  private readonly records = new Map<number, Map<number, StoredRecord>>();

  get indexBytes(): number {
    return this.records.size * KEY_INDEX_BYTES + this.indexOverhead;
  }

  constructor(private readonly maxBytes = MAX_BYTES) {
    super();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BYTES) {
      throw new RangeError('Replay trace byte limit must be between 0 and 256 MiB');
    }
  }

  protected beforeWrite(): void {}
  protected beforeRead(): void {}

  async write(at: number, updates: readonly TraceUpdate[]): Promise<boolean> {
    position(at, true);
    let unique: Map<number, TraceUpdate>;
    try {
      unique = validateUpdates(updates);
    } catch (error) {
      if (error instanceof RangeError && /exceeds/.test(error.message)) this.warn(error);
      throw error;
    }
    return this.enqueue(async () => {
      if (!this.available || this.closing) return false;
      try {
        this.beforeWrite();
        let nextBytes = this.bytes;
        let keys = this.records.size;
        for (const update of unique.values()) {
          const history = this.records.get(update.key);
          if (!history) {
            keys++;
            nextBytes += update.before.byteLength + RECORD_OVERHEAD;
          }
          nextBytes +=
            update.after.byteLength +
            RECORD_OVERHEAD -
            (history?.get(at) ? size(history.get(at)!) : 0);
        }
        if (keys > MAX_KEYS) throw new Error('Replay trace exceeds 65536 region keys');
        if (nextBytes > this.maxBytes) throw new Error('Replay trace byte cap exceeded');
        const staged = [...unique.values()].map((update) => ({
          key: update.key,
          baseline: this.records.has(update.key)
            ? undefined
            : rawRecord(update.key, 0, update.before),
          after: rawRecord(update.key, at, update.after),
        }));
        for (const entry of staged) {
          let history = this.records.get(entry.key);
          if (!history) this.records.set(entry.key, (history = new Map()));
          if (entry.baseline) history.set(0, entry.baseline);
          history.set(at, entry.after);
        }
        this.bytes = nextBytes;
        return true;
      } catch (error) {
        this.warn(error);
        return false;
      }
    });
  }

  async *restore(
    from: number,
    to: number,
    reserveWorkspace?: (bytes: number) => void,
  ): AsyncIterable<TraceRecord> {
    position(from);
    position(to);
    await this.pending;
    this.checkReadable();
    if (from === to) return;
    try {
      let capacity = 0;
      let scanBytes = INDEX_OVERHEAD;
      reserveWorkspace?.(scanBytes);
      const lower = Math.min(from, to);
      const upper = Math.max(from, to);
      const keys: number[] = [];
      for (const [key, history] of this.records) {
        for (const at of history.keys()) {
          if (at > lower && at <= upper) {
            if (keys.length === capacity) {
              capacity = growKeyCapacity(capacity);
              scanBytes = capacity * KEY_INDEX_BYTES + INDEX_OVERHEAD;
              reserveWorkspace?.(scanBytes);
            }
            keys.push(key);
            break;
          }
        }
      }
      keys.sort((a, b) => a - b);
      for (const key of keys) {
        this.checkReadable();
        let latest: StoredRecord | undefined;
        for (const record of this.records.get(key)!.values()) {
          if (record.position <= to && (!latest || record.position > latest.position))
            latest = record;
        }
        if (!latest) throw new Error(`Replay trace baseline missing for region ${key}`);
        reserveWorkspace?.(latest.rawBytes * 4 + latest.data.byteLength * 2 + scanBytes);
        this.beforeRead();
        yield { key, data: latest.data.slice() };
      }
    } catch (error) {
      this.warn(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.pending;
    this.available = false;
    this.records.clear();
    this.indexOverhead = 0;
    this.bytes = 0;
  }
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Replay trace transaction aborted'));
    transaction.onerror = () => {}; // Abort is the terminal event, including request failures.
  });
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error('Replay trace database deletion failed'));
    request.onblocked = () => reject(new Error('Replay trace database deletion blocked'));
  });
}

async function streamBytes(
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream,
  limit: number,
): Promise<Uint8Array> {
  const blobData =
    data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : data.slice();
  const reader = new Blob([blobData]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      const { value } = chunk;
      length += value.byteLength;
      if (length > limit) throw new Error('Replay trace codec output exceeds record limit');
      chunks.push(value);
      chunk = await reader.read();
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

class IndexedReplayTraceStore extends TraceStoreBase {
  private readonly keys = new Set<number>();
  private readonly compressed =
    typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
  private closePromise: Promise<void> | undefined;

  get indexBytes(): number {
    return this.keys.size * KEY_INDEX_BYTES + this.indexOverhead;
  }

  constructor(
    private readonly database: IDBDatabase,
    private readonly factory: IDBFactory,
  ) {
    super();
    if (!this.compressed) this.warn('gzip streams unavailable; storing raw region blobs', false);
    database.onversionchange = () => {
      this.warn('database unexpectedly changed');
      database.close();
    };
  }

  async write(at: number, updates: readonly TraceUpdate[]): Promise<boolean> {
    position(at, true);
    let unique: Map<number, TraceUpdate>;
    try {
      unique = validateUpdates(updates);
    } catch (error) {
      if (error instanceof RangeError && /exceeds/.test(error.message)) this.warn(error);
      throw error;
    }
    return this.enqueue(async () => {
      if (!this.available || this.closing) return false;
      if (!unique.size) return true;
      try {
        let keyCount = this.keys.size;
        let preparedBytes = 0;
        const prepared: StoredRecord[] = [];
        for (const update of unique.values()) {
          if (!this.keys.has(update.key) && ++keyCount > MAX_KEYS) {
            throw new Error('Replay trace exceeds 65536 region keys');
          }
          for (const [recordPosition, data] of [
            ...(!this.keys.has(update.key) ? [[0, update.before] as const] : []),
            [at, update.after] as const,
          ]) {
            const compressed = this.compressed && data.byteLength >= MIN_GZIP_BYTES;
            const encoded = compressed
              ? await streamBytes(data, new CompressionStream('gzip'), MAX_BYTES - RECORD_OVERHEAD)
              : data.slice();
            const record: StoredRecord = {
              key: update.key,
              position: recordPosition,
              data: encoded,
              rawBytes: data.byteLength,
              codec: compressed ? 'gzip' : 'raw',
            };
            preparedBytes += size(record);
            if (preparedBytes > MAX_BYTES) throw new Error('Replay trace byte cap exceeded');
            prepared.push(record);
          }
        }
        const transaction = this.database.transaction([STORE, METADATA], 'readwrite');
        const completion = transactionDone(transaction);
        const store = transaction.objectStore(STORE);
        const metadata = transaction.objectStore(METADATA);
        let nextBytes = this.bytes;
        let failure: Error | undefined;
        for (const record of prepared) {
          // Requests and subsequent puts are enqueued in callbacks, never after an await.
          const lookup = metadata.get([record.key, record.position]);
          lookup.onsuccess = () => {
            const previous = lookup.result as RecordMetadata | undefined;
            if (record.position === 0 && previous) return;
            nextBytes += size(record) - (previous ? previous.compressedBytes + RECORD_OVERHEAD : 0);
            if (nextBytes > MAX_BYTES) {
              failure = new Error('Replay trace byte cap exceeded');
              transaction.abort();
              return;
            }
            store.put(record);
            metadata.put({
              key: record.key,
              position: record.position,
              rawBytes: record.rawBytes,
              codec: record.codec,
              compressedBytes: record.data.byteLength,
            } satisfies RecordMetadata);
          };
        }
        try {
          await completion;
        } catch (error) {
          throw failure ?? error;
        }
        this.bytes = nextBytes;
        for (const key of unique.keys()) this.keys.add(key);
        return true;
      } catch (error) {
        this.warn(error);
        return false;
      }
    });
  }

  async *restore(
    from: number,
    to: number,
    reserveWorkspace?: (bytes: number) => void,
  ): AsyncIterable<TraceRecord> {
    position(from);
    position(to);
    await this.pending;
    this.checkReadable();
    if (from === to) return;
    try {
      let capacity = 0;
      let scanBytes = INDEX_OVERHEAD;
      reserveWorkspace?.(scanBytes);
      const transaction = this.database.transaction(METADATA, 'readonly');
      const completion = transactionDone(transaction);
      const keys = new Set<number>();
      let failure: unknown;
      const cursor = transaction
        .objectStore(METADATA)
        .index('position')
        .openKeyCursor(IDBKeyRange.bound(Math.min(from, to), Math.max(from, to), true));
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        try {
          this.checkReadable();
          const primary = entry.primaryKey;
          if (
            !Array.isArray(primary) ||
            typeof primary[0] !== 'number' ||
            !this.keys.has(primary[0])
          ) {
            throw new Error('Replay trace invalid region index');
          }
          if (!keys.has(primary[0])) {
            if (keys.size === MAX_KEYS)
              throw new Error('Replay trace restore exceeds 65536 region keys');
            if (keys.size === capacity) {
              const nextCapacity = growKeyCapacity(capacity);
              const nextBytes = nextCapacity * KEY_INDEX_BYTES + INDEX_OVERHEAD;
              reserveWorkspace?.(nextBytes);
              capacity = nextCapacity;
              scanBytes = nextBytes;
            }
            keys.add(primary[0]);
          }
          entry.continue();
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      try {
        await completion;
      } catch (error) {
        throw failure ?? error;
      }
      const orderedKeys = [...keys].sort((a, b) => a - b);
      for (let start = 0; start < orderedKeys.length; start += RESTORE_BATCH_RECORDS) {
        this.checkReadable();
        const count = Math.min(RESTORE_BATCH_RECORDS, orderedKeys.length - start);
        const metadataBytes = scanBytes + count * BATCH_METADATA_BYTES;
        reserveWorkspace?.(metadataBytes);
        const read = this.database.transaction(METADATA, 'readonly');
        const done = transactionDone(read);
        const metadata: Array<RecordMetadata | undefined> = new Array(count);
        for (let index = 0; index < count; index++) {
          const key = orderedKeys[start + index];
          const latest = read
            .objectStore(METADATA)
            .openCursor(IDBKeyRange.bound([key, 0], [key, to]), 'prev');
          latest.onsuccess = () => {
            metadata[index] = latest.result?.value as RecordMetadata | undefined;
          };
        }
        await done;
        this.checkReadable();
        const infos = metadata.map((info, index) =>
          validateMetadata(info, orderedKeys[start + index], to),
        );
        for (let offset = 0; offset < infos.length;) {
          let end = offset;
          let workspace = 0;
          // An oversized record is a bounded singleton; tiny records share a byte-limited batch.
          while (end < infos.length) {
            const nextBytes = payloadWorkspace(infos[end]);
            if (end > offset && workspace + nextBytes > RESTORE_BATCH_BYTES) break;
            workspace += nextBytes;
            end++;
          }
          reserveWorkspace?.(metadataBytes + workspace);
          this.checkReadable();
          const decoded = await this.readBatch(infos.slice(offset, end));
          for (let index = 0; index < decoded.length; index++) {
            this.checkReadable();
            const record = decoded[index]!;
            decoded[index] = undefined;
            yield record;
          }
          offset = end;
        }
      }
    } catch (error) {
      this.warn(error);
      throw error;
    }
  }

  private async readBatch(
    infos: readonly RecordMetadata[],
  ): Promise<Array<TraceRecord | undefined>> {
    const transaction = this.database.transaction(STORE, 'readonly');
    const completion = transactionDone(transaction);
    const records: Array<StoredRecord | undefined> = new Array(infos.length);
    for (let index = 0; index < infos.length; index++) {
      const info = infos[index];
      const request = transaction.objectStore(STORE).get([info.key, info.position]);
      request.onsuccess = () => {
        records[index] = request.result as StoredRecord | undefined;
      };
    }
    await completion;
    this.checkReadable();
    for (let index = 0; index < infos.length; index++) {
      const info = infos[index];
      const record = records[index];
      if (
        !record ||
        record.key !== info.key ||
        record.position !== info.position ||
        record.rawBytes !== info.rawBytes ||
        record.codec !== info.codec ||
        !(record.data instanceof Uint8Array) ||
        record.data.byteLength !== info.compressedBytes
      ) {
        throw new Error(`Replay trace record does not match metadata for region ${info.key}`);
      }
    }
    const decoded: Array<TraceRecord | undefined> = new Array(infos.length);
    let next = 0;
    const worker = async () => {
      while (next < records.length) {
        this.checkReadable();
        const index = next++;
        const record = records[index]!;
        let data: Uint8Array;
        if (record.codec === 'gzip') {
          if (typeof DecompressionStream === 'undefined')
            throw new Error('Replay trace gzip decoder unavailable');
          data = await streamBytes(record.data, new DecompressionStream('gzip'), record.rawBytes);
        } else {
          data = record.data;
        }
        this.checkReadable();
        if (data.byteLength !== record.rawBytes)
          throw new Error('Replay trace decoded length mismatch');
        decoded[index] = { key: record.key, data };
        records[index] = undefined;
      }
    };
    // Settle every in-flight stream before propagating a decoder failure or closure.
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(DECODE_CONCURRENCY, infos.length) }, worker),
    );
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
    return decoded;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = (async () => {
        await this.pending;
        this.available = false;
        this.database.close();
        try {
          await deleteDatabase(this.factory, this.database.name);
          this.keys.clear();
          this.indexOverhead = 0;
          this.bytes = 0;
        } catch (error) {
          this.warn(error);
          throw error;
        }
      })();
    }
    return this.closePromise;
  }
}

/** Each owner deletes only its own database; no sweep can accidentally delete an active session. */
export async function openReplayTraceStore(): Promise<ReplayTraceStore> {
  let factory: IDBFactory | undefined;
  let name: string | undefined;
  let database: IDBDatabase | undefined;
  try {
    factory = globalThis.indexedDB;
    if (!factory) throw new Error('IndexedDB unavailable');
    const id =
      globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    name = `nc-edit7-replay-trace-${id}-${sessionCounter++}`;
    database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory!.open(name!, 1);
      let abandoned = false;
      request.onupgradeneeded = () => {
        try {
          request.result.createObjectStore(STORE, { keyPath: ['key', 'position'] });
          const store = request.result.createObjectStore(METADATA, {
            keyPath: ['key', 'position'],
          });
          store.createIndex('position', 'position');
        } catch (error) {
          abandoned = true;
          request.transaction?.abort();
          reject(error);
        }
      };
      request.onsuccess = () => {
        if (abandoned) {
          request.result.close();
          void deleteDatabase(factory!, name!).catch((error) =>
            console.warn('Replay trace cleanup failed', error),
          );
        } else resolve(request.result);
      };
      request.onerror = () =>
        reject(request.error ?? new Error('Replay trace database open failed'));
      request.onblocked = () => {
        abandoned = true;
        reject(new Error('Replay trace database open blocked'));
      };
    });
    return new IndexedReplayTraceStore(database, factory);
  } catch (error) {
    database?.close();
    if (factory && name) {
      await deleteDatabase(factory, name).catch((cleanupError) =>
        console.warn('Replay trace cleanup failed', cleanupError),
      );
    }
    const disabled = new MemoryReplayTraceStore(0);
    await disabled.close();
    disabled.warning = `Replay trace cache unavailable: ${error instanceof Error ? error.message : String(error)}`;
    console.warn(disabled.warning);
    return disabled;
  }
}
