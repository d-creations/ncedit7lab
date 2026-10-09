import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryReplayTraceStore,
  openReplayTraceStore,
  type ReplayTraceStore,
  type TraceRecord,
  type TraceUpdate,
} from '../ReplayTraceStore';

function update(key: number, before: number, after: number): TraceUpdate {
  return { key, before: Uint8Array.of(before), after: Uint8Array.of(after) };
}

async function restore(
  store: ReplayTraceStore,
  from: number,
  to: number,
  reserveWorkspace?: (bytes: number) => void,
): Promise<TraceRecord[]> {
  const records: TraceRecord[] = [];
  for await (const record of store.restore(from, to, reserveWorkspace)) records.push(record);
  return records;
}

async function values(store: ReplayTraceStore, from: number, to: number): Promise<number[][]> {
  return (await restore(store, from, to)).map(({ key, data }) => [key, ...data]);
}

interface CachedRecord {
  key: number;
  position: number;
  rawBytes: number;
  codec: 'raw' | 'gzip';
  data?: Uint8Array;
  compressedBytes?: number;
}

/** Exercises native codecs with only the IDB request/transaction subset used by this store. */
function installCodecDatabase() {
  const tables = new Map<string, Map<string, CachedRecord>>();
  const payloadReads = vi.fn();
  const transactions = vi.fn();
  const token = (key: number[]) => key.join(':');
  type Range = { lower: number | number[]; upper: number | number[]; lowerOpen: boolean };
  type Request = { result?: unknown; onsuccess?: () => void };
  const database = {
    name: 'codec-test',
    close: vi.fn(),
    createObjectStore(name: string) {
      tables.set(name, new Map());
      return { createIndex: vi.fn() };
    },
    transaction(stores: string | string[], mode: string) {
      transactions(stores, mode);
      const transactionId = transactions.mock.calls.length;
      let pending = 0;
      let completed = false;
      const transaction = {
        oncomplete: undefined as (() => void) | undefined,
        onabort: undefined as (() => void) | undefined,
        abort() {
          completed = true;
          queueMicrotask(() => transaction.onabort?.());
        },
        objectStore(name: string) {
          const table = tables.get(name)!;
          return {
            get(key: number[]) {
              const request: Request = {};
              enqueue(() => {
                if (name === 'regions') payloadReads(key, transactionId);
                request.result = structuredClone(table.get(token(key)));
                request.onsuccess?.();
              });
              return request;
            },
            put(record: CachedRecord) {
              enqueue(() => {
                table.set(token([record.key, record.position]), structuredClone(record));
              });
            },
            openCursor(range: Range) {
              const request: Request = {};
              enqueue(() => {
                const [key, upper] = range.upper as number[];
                const latest = [...table.values()]
                  .filter((record) => record.key === key && record.position <= upper)
                  .sort((a, b) => b.position - a.position)[0];
                request.result = latest ? { value: structuredClone(latest) } : null;
                request.onsuccess?.();
              });
              return request;
            },
            index() {
              return {
                openKeyCursor(range: Range) {
                  const request: Request = {};
                  const records = [...table.values()]
                    .filter(
                      (record) =>
                        (range.lowerOpen
                          ? record.position > Number(range.lower)
                          : record.position >= Number(range.lower)) &&
                        record.position <= Number(range.upper),
                    )
                    .sort((a, b) => a.position - b.position);
                  let offset = 0;
                  const advance = () =>
                    enqueue(() => {
                      const record = records[offset++];
                      request.result = record
                        ? { primaryKey: [record.key, record.position], continue: advance }
                        : null;
                      request.onsuccess?.();
                    });
                  advance();
                  return request;
                },
              };
            },
          };
        },
      };
      function enqueue(operation: () => void) {
        pending++;
        queueMicrotask(() => {
          if (completed) return;
          operation();
          pending--;
          queueMicrotask(() => {
            if (!pending && !completed) {
              completed = true;
              transaction.oncomplete?.();
            }
          });
        });
      }
      return transaction;
    },
  };
  vi.stubGlobal('IDBKeyRange', {
    bound: (lower: Range['lower'], upper: Range['upper'], lowerOpen = false): Range => ({
      lower,
      upper,
      lowerOpen,
    }),
  });
  vi.stubGlobal('indexedDB', {
    open() {
      const request = {
        result: database,
        onupgradeneeded: undefined as (() => void) | undefined,
        onsuccess: undefined as (() => void) | undefined,
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
    deleteDatabase() {
      const request: Request = {};
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  });
  return { tables, payloadReads, transactions, database };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('bounded IndexedDB restore batches', () => {
  it('reads 130 sorted latest versions using seven transactions instead of one pair per key', async () => {
    const { transactions, payloadReads } = installCodecDatabase();
    const store = await openReplayTraceStore();
    const keys = Array.from({ length: 130 }, (_, index) => index - 1);
    await store.write(
      1,
      [...keys].reverse().map((key) => update(key, 0, key + 1)),
    );
    await store.write(2, [update(2, 3, 123)]);
    transactions.mockClear();
    payloadReads.mockClear();
    const reserve = vi.fn();
    expect(await restore(store, 0, 2, reserve)).toEqual(
      keys.map((key) => ({
        key,
        data: Uint8Array.of(key === 2 ? 123 : key + 1),
      })),
    );
    expect(transactions.mock.calls).toEqual([
      ['metadata', 'readonly'],
      ['metadata', 'readonly'],
      ['regions', 'readonly'],
      ['metadata', 'readonly'],
      ['regions', 'readonly'],
      ['metadata', 'readonly'],
      ['regions', 'readonly'],
    ]);
    const batchSizes = new Map<number, number>();
    for (const [, transactionId] of payloadReads.mock.calls) {
      batchSizes.set(transactionId, (batchSizes.get(transactionId) ?? 0) + 1);
    }
    expect([...batchSizes.values()]).toEqual([64, 64, 2]);
    const scanBytes = 256 * 128 + 4096;
    expect(reserve.mock.calls.map(([bytes]) => bytes)).toEqual([
      4096,
      64 * 128 + 4096,
      128 * 128 + 4096,
      scanBytes,
      scanBytes + 64 * 512,
      scanBytes + 64 * 512 + 64 * 6,
      scanBytes + 64 * 512,
      scanBytes + 64 * 512 + 64 * 6,
      scanBytes + 2 * 512,
      scanBytes + 2 * 512 + 2 * 6,
    ]);
    transactions.mockClear();
    expect(await restore(store, 2, 0)).toEqual(
      keys.map((key) => ({
        key,
        data: Uint8Array.of(0),
      })),
    );
    expect(transactions).toHaveBeenCalledTimes(7);
    await store.close();
  });

  it('splits payload batches by total raw/compressed/decode workspace, not just record count', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('CompressionStream', undefined);
    const { transactions, payloadReads } = installCodecDatabase();
    const store = await openReplayTraceStore();
    const megabyte = 1024 * 1024;
    await store.write(
      1,
      [3, 1, 2].map((key) => ({
        key,
        before: new Uint8Array(),
        after: new Uint8Array(megabyte).fill(key),
      })),
    );
    transactions.mockClear();
    payloadReads.mockClear();
    const reserve = vi.fn();
    const restored = await restore(store, 0, 1, reserve);
    expect(restored.map(({ key, data }) => [key, data.length, data[0]])).toEqual([
      [1, megabyte, 1],
      [2, megabyte, 2],
      [3, megabyte, 3],
    ]);
    expect(transactions.mock.calls).toEqual([
      ['metadata', 'readonly'],
      ['metadata', 'readonly'],
      ['regions', 'readonly'],
      ['regions', 'readonly'],
      ['regions', 'readonly'],
    ]);
    const metadataBytes = 64 * 128 + 4096 + 3 * 512;
    expect(reserve.mock.calls.map(([bytes]) => bytes)).toEqual([
      4096,
      64 * 128 + 4096,
      metadataBytes,
      metadataBytes + 6 * megabyte,
      metadataBytes + 6 * megabyte,
      metadataBytes + 6 * megabyte,
    ]);
    expect(Math.max(...reserve.mock.calls.map(([bytes]) => bytes))).toBeLessThan(8 * megabyte);
    expect(payloadReads).toHaveBeenCalledTimes(3);
    await store.close();
  });

  it('treats a larger valid record as a separately reserved bounded singleton', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('CompressionStream', undefined);
    const { transactions } = installCodecDatabase();
    const store = await openReplayTraceStore();
    const data = new Uint8Array(2 * 1024 * 1024).fill(3);
    await store.write(1, [{ key: -1, before: new Uint8Array(), after: data }, update(0, 0, 1)]);
    transactions.mockClear();
    const reserve = vi.fn();
    const restored = await restore(store, 0, 1, reserve);
    expect(restored.map(({ key, data: blob }) => [key, blob.byteLength, blob[0]])).toEqual([
      [-1, data.byteLength, 3],
      [0, 1, 1],
    ]);
    expect(restored[0].data.every((value) => value === 3)).toBe(true);
    const metadataBytes = 64 * 128 + 4096 + 2 * 512;
    expect(reserve.mock.calls.map(([bytes]) => bytes)).toEqual([
      4096,
      64 * 128 + 4096,
      metadataBytes,
      metadataBytes + data.byteLength * 6,
      metadataBytes + 6,
    ]);
    expect(transactions.mock.calls.filter(([storeName]) => storeName === 'regions')).toHaveLength(
      2,
    );
    await store.close();
  });

  it('rejects key-scan growth before allocation and never fetches payloads', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { transactions, payloadReads } = installCodecDatabase();
    const store = await openReplayTraceStore();
    await store.write(1, [update(1, 0, 1)]);
    transactions.mockClear();
    const reserve = vi.fn((bytes: number) => {
      if (bytes > 4096) throw new Error('key capacity exhausted');
    });
    await expect(restore(store, 0, 1, reserve)).rejects.toThrow('key capacity exhausted');
    expect(transactions.mock.calls).toEqual([['metadata', 'readonly']]);
    expect(payloadReads).not.toHaveBeenCalled();
    expect(store.available).toBe(false);
    expect(store.warning).toMatch(/key capacity exhausted/);
    await store.close();
  });

  it('reserves the entire payload batch before any fetch, not only the largest member', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { payloadReads, transactions } = installCodecDatabase();
    const store = await openReplayTraceStore();
    await store.write(1, [update(1, 0, 1), update(2, 0, 2)]);
    transactions.mockClear();
    const metadataBytes = 64 * 128 + 4096 + 2 * 512;
    const reserve = vi.fn((bytes: number) => {
      if (bytes > metadataBytes + 6) throw new Error('batch workspace exhausted');
    });
    await expect(restore(store, 0, 1, reserve)).rejects.toThrow('batch workspace exhausted');
    expect(reserve).toHaveBeenLastCalledWith(metadataBytes + 12);
    expect(transactions.mock.calls).toEqual([
      ['metadata', 'readonly'],
      ['metadata', 'readonly'],
    ]);
    expect(payloadReads).not.toHaveBeenCalled();
    await store.close();
  });

  it('decodes gzip with at most four native streams and yields deterministic key order', async () => {
    installCodecDatabase();
    const NativeDecompression = DecompressionStream;
    let active = 0;
    let peak = 0;
    vi.stubGlobal(
      'DecompressionStream',
      class {
        readonly writable: WritableStream<BufferSource>;
        readonly readable: ReadableStream<Uint8Array>;
        constructor(format: CompressionFormat) {
          const native = new NativeDecompression(format);
          this.writable = native.writable;
          active++;
          peak = Math.max(peak, active);
          this.readable = native.readable.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                controller.enqueue(chunk);
              },
              flush() {
                active--;
              },
            }),
          );
        }
      },
    );
    const store = await openReplayTraceStore();
    const updates = Array.from({ length: 10 }, (_, index) => ({
      key: index - 1,
      before: new Uint8Array(),
      after: new Uint8Array(1024).fill(index),
    }));
    await store.write(1, [...updates].reverse());
    expect(await restore(store, 0, 1)).toEqual(
      updates.map(({ key, after }) => ({ key, data: after })),
    );
    expect(peak).toBe(4);
    expect(active).toBe(0);
    await store.close();
  });

  it('throws on a corrupt gzip batch without yielding partially decoded results', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { tables } = installCodecDatabase();
    const store = await openReplayTraceStore();
    await store.write(
      1,
      [1, 2].map((key) => ({
        key,
        before: new Uint8Array(),
        after: new Uint8Array(1024).fill(key),
      })),
    );
    tables.get('regions')!.get('2:1')!.data![0] ^= 255;
    const yielded: TraceRecord[] = [];
    const consume = async () => {
      for await (const record of store.restore(0, 1)) yielded.push(record);
    };
    await expect(consume()).rejects.toThrow();
    expect(yielded).toEqual([]);
    expect(store.available).toBe(false);
    await store.close();
  });

  it('does not yield or fetch further records after closing a paused batch iterator', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { payloadReads, transactions, database } = installCodecDatabase();
    const store = await openReplayTraceStore();
    await store.write(1, [update(-1, 0, 1), update(0, 0, 2), update(1, 0, 3)]);
    const iterator = store.restore(0, 1)[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({
      value: { key: -1, data: Uint8Array.of(1) },
      done: false,
    });
    expect(payloadReads).toHaveBeenCalledTimes(3);
    transactions.mockClear();
    await store.close();
    await store.close();
    expect(store.bytes).toBe(0);
    expect(store.indexBytes).toBe(0);
    expect(database.close).toHaveBeenCalledTimes(1);
    await expect(iterator.next()).rejects.toThrow(/closed/);
    expect(transactions).not.toHaveBeenCalled();
    expect(payloadReads).toHaveBeenCalledTimes(3);
  });
});

describe('MemoryReplayTraceStore temporal contract', () => {
  it('restores latest selective forward/backward versions in key order, including profile', async () => {
    const store = new MemoryReplayTraceStore();
    await store.write(1, [update(8, 80, 81), update(2, 20, 21), update(-1, 10, 11)]);
    await store.write(3, [update(2, 21, 23)]);
    await store.write(5, [update(8, 81, 85)]);
    await store.write(7, [update(-1, 11, 17)]);

    expect(await values(store, 1, 5)).toEqual([
      [2, 23],
      [8, 85],
    ]);
    expect(await values(store, 5, 1)).toEqual([
      [2, 21],
      [8, 81],
    ]);
    expect(await values(store, 7, 0)).toEqual([
      [-1, 10],
      [2, 20],
      [8, 80],
    ]);
    expect(await values(store, 0, 7)).toEqual([
      [-1, 17],
      [2, 23],
      [8, 85],
    ]);
    expect(await values(store, 5, 5)).toEqual([]);
  });

  it('saves the first baseline only, including keys first changed at a later occurrence', async () => {
    const store = new MemoryReplayTraceStore();
    await store.write(4, [update(9, 90, 94)]);
    const initialBytes = store.bytes;
    await store.write(6, [update(9, 255, 96)]);
    expect(store.bytes - initialBytes).toBe(initialBytes / 2);
    expect(await values(store, 6, 2)).toEqual([[9, 90]]);
    expect(await values(store, 2, 5)).toEqual([[9, 94]]);
    expect(await values(store, 0, 3)).toEqual([]);
  });

  it('coalesces repeated keys within a write and replaces the same occurrence atomically', async () => {
    const store = new MemoryReplayTraceStore();
    await store.write(1, [update(4, 40, 41), update(4, 41, 42)]);
    const bytes = store.bytes;
    await store.write(1, [update(4, 255, 43)]);
    expect(store.bytes).toBe(bytes);
    expect(await values(store, 0, 1)).toEqual([[4, 43]]);
    expect(await values(store, 1, 0)).toEqual([[4, 40]]);
  });

  it('adds neither region keys nor records for no-stock updates', async () => {
    const store = new MemoryReplayTraceStore();
    expect(await store.write(1, [])).toBe(true);
    expect(await store.write(200, [])).toBe(true);
    expect(store.bytes).toBe(0);
    expect(await values(store, 0, 200)).toEqual([]);
    await store.write(201, [update(3, 30, 31)]);
    expect(await values(store, 200, 0)).toEqual([]);
  });

  it('isolates both input and returned blobs', async () => {
    const store = new MemoryReplayTraceStore();
    const entry = update(1, 1, 2);
    await store.write(1, [entry]);
    entry.before[0] = 99;
    entry.after[0] = 99;
    const records = await restore(store, 0, 1);
    records[0].data[0] = 88;
    expect(await values(store, 0, 1)).toEqual([[1, 2]]);
    expect(await values(store, 1, 0)).toEqual([[1, 1]]);
  });

  it('serializes simultaneous writes and preserves the earliest baseline', async () => {
    const store = new MemoryReplayTraceStore();
    expect(
      await Promise.all([store.write(1, [update(1, 0, 1)]), store.write(2, [update(1, 1, 2)])]),
    ).toEqual([true, true]);
    expect(await values(store, 0, 2)).toEqual([[1, 2]]);
    expect(await values(store, 2, 0)).toEqual([[1, 0]]);
  });

  it('counts record overhead, warns on a cap, and never partially commits', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new MemoryReplayTraceStore(300);
    expect(await store.write(1, [update(1, 0, 1)])).toBe(true);
    const bytes = store.bytes;
    expect(bytes).toBeGreaterThan(2);
    expect(await store.write(2, [update(1, 1, 2), update(2, 0, 2)])).toBe(false);
    expect(store.bytes).toBe(bytes);
    expect(store.available).toBe(false);
    expect(store.warning).toMatch(/cap/);
    expect(warn).toHaveBeenCalledWith(store.warning);
    expect(await store.write(3, [])).toBe(false);
    await expect(restore(store, 2, 0)).rejects.toThrow(/cap/);
  });

  it('allows exact cap and same-position replacement without double accounting', async () => {
    const probe = new MemoryReplayTraceStore();
    await probe.write(1, [update(1, 0, 1)]);
    const store = new MemoryReplayTraceStore(probe.bytes);
    expect(await store.write(1, [update(1, 0, 1)])).toBe(true);
    expect(await store.write(1, [update(1, 99, 2)])).toBe(true);
    expect(store.bytes).toBe(probe.bytes);
  });

  it('disables on injected write errors and throws injected read errors rather than fabricating results', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    class FailingWrite extends MemoryReplayTraceStore {
      protected override beforeWrite(): void {
        throw new Error('quota failure');
      }
    }
    class FailingRead extends MemoryReplayTraceStore {
      protected override beforeRead(): void {
        throw new Error('decode failure');
      }
    }
    const writer = new FailingWrite();
    expect(await writer.write(1, [update(1, 0, 1)])).toBe(false);
    expect(writer.bytes).toBe(0);
    expect(writer.available).toBe(false);
    expect(writer.warning).toMatch(/quota failure/);
    const reader = new FailingRead();
    await reader.write(1, [update(1, 0, 1)]);
    await expect(restore(reader, 0, 1)).rejects.toThrow('decode failure');
    expect(reader.available).toBe(false);
    expect(reader.warning).toMatch(/decode failure/);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid positions, keys, blobs, and byte limits without committing', async () => {
    const store = new MemoryReplayTraceStore();
    for (const at of [-1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(store.write(at, [])).rejects.toThrow(RangeError);
    }
    for (const key of [-2, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(store.write(1, [update(key, 0, 1)])).rejects.toThrow(RangeError);
    }
    await expect(
      store.write(1, [{ key: 1, before: [] as unknown as Uint8Array, after: Uint8Array.of(1) }]),
    ).rejects.toThrow(TypeError);
    await expect(restore(store, -1, 0)).rejects.toThrow(RangeError);
    await expect(restore(store, 0, NaN)).rejects.toThrow(RangeError);
    expect(() => new MemoryReplayTraceStore(-1)).toThrow(RangeError);
    expect(() => new MemoryReplayTraceStore(256 * 1024 * 1024 + 1)).toThrow(RangeError);
    expect(store.bytes).toBe(0);
    expect(store.available).toBe(true);
  });

  it('warns and disables on oversized raw blobs or too many distinct region keys', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new MemoryReplayTraceStore();
    await expect(
      store.write(1, [
        {
          key: 1,
          before: new Uint8Array(64 * 1024 * 1024 + 1),
          after: new Uint8Array(),
        },
      ]),
    ).rejects.toThrow(/64 MiB/);
    expect(store.available).toBe(false);
    expect(store.warning).toMatch(/64 MiB/);
    const manyKeys = new MemoryReplayTraceStore();
    const empty = new Uint8Array();
    await expect(
      manyKeys.write(
        1,
        Array.from({ length: 65537 }, (_, key) => ({
          key,
          before: empty,
          after: empty,
        })),
      ),
    ).rejects.toThrow(/65536/);
    expect(manyKeys.available).toBe(false);
    expect(manyKeys.bytes).toBe(0);
  });

  it('clears history and accounting on idempotent close and refuses further replay', async () => {
    const store = new MemoryReplayTraceStore();
    await store.write(1, [update(1, 0, 1)]);
    await store.close();
    await store.close();
    expect(store.bytes).toBe(0);
    expect(store.indexBytes).toBe(0);
    expect(store.available).toBe(false);
    expect(await store.write(2, [update(1, 1, 2)])).toBe(false);
    await expect(restore(store, 0, 1)).rejects.toThrow(/closed/);
  });

  it('reports bounded key metadata separately from test-only raw payloads', async () => {
    const store = new MemoryReplayTraceStore();
    expect(store.indexBytes).toBe(4096);
    await store.write(1, [
      {
        key: 1,
        before: new Uint8Array(1024),
        after: new Uint8Array(2048),
      },
    ]);
    expect(store.indexBytes).toBe(4096 + 128);
    await store.write(2, [update(1, 1, 2)]);
    expect(store.indexBytes).toBe(4096 + 128);
    await store.write(3, [update(-1, 0, 1)]);
    expect(store.indexBytes).toBe(4096 + 2 * 128);
    await store.close();
    expect(store.indexBytes).toBe(0);
  });

  it('reserves scan metadata and per-region buffers with practical payload granularity', async () => {
    const store = new MemoryReplayTraceStore();
    await store.write(1, [
      update(1, 0, 1),
      {
        key: 2,
        before: new Uint8Array(2),
        after: new Uint8Array(3),
      },
    ]);
    const reserve = vi.fn();
    const records: TraceRecord[] = [];
    for await (const record of store.restore(0, 1, reserve)) records.push(record);
    const scanBytes = 64 * 128 + 4096;
    expect(reserve.mock.calls.map(([bytes]) => bytes)).toEqual([
      4096,
      scanBytes,
      scanBytes + 6,
      scanBytes + 18,
    ]);
    expect(records.map(({ key }) => key)).toEqual([1, 2]);
    reserve.mockClear();
    for await (const record of store.restore(1, 1, reserve)) records.push(record);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('propagates scan or payload reservation rejection before reading/decoding', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    class ObservedReads extends MemoryReplayTraceStore {
      readonly read = vi.fn();
      protected override beforeRead(): void {
        this.read();
      }
    }
    for (const rejectAt of [1, 2, 3]) {
      const store = new ObservedReads();
      await store.write(1, [update(1, 0, 1)]);
      let calls = 0;
      const reserve = () => {
        if (++calls === rejectAt) throw new Error('workspace cap exceeded');
      };
      const collect = async () => {
        const records: TraceRecord[] = [];
        for await (const record of store.restore(0, 1, reserve)) records.push(record);
        return records;
      };
      await expect(collect()).rejects.toThrow('workspace cap exceeded');
      expect(calls).toBe(rejectAt);
      expect(store.read).not.toHaveBeenCalled();
      expect(store.available).toBe(false);
      expect(store.warning).toMatch(/workspace cap exceeded/);
      await store.close();
      expect(store.indexBytes).toBe(0);
    }
  });
});

describe('openReplayTraceStore unavailable environments', () => {
  it('explicitly warns and returns a disabled store when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = await openReplayTraceStore();
    expect(store.available).toBe(false);
    expect(store.bytes).toBe(0);
    expect(store.indexBytes).toBe(0);
    expect(store.warning).toMatch(/IndexedDB unavailable/);
    expect(warn).toHaveBeenCalledWith(store.warning);
    expect(await store.write(1, [])).toBe(false);
    await expect(restore(store, 0, 1)).rejects.toThrow(/unavailable/);
    await store.close();
  });

  describe('adaptive IndexedDB record compression', () => {
    it('roundtrips mixed raw/gzip records at the 512-byte threshold with exact reservations', async () => {
      const { tables, payloadReads } = installCodecDatabase();
      const NativeCompression = CompressionStream;
      const NativeDecompression = DecompressionStream;
      const compress = vi.fn();
      const decompress = vi.fn();
      vi.stubGlobal(
        'CompressionStream',
        class extends NativeCompression {
          constructor(format: CompressionFormat) {
            super(format);
            compress();
          }
        },
      );
      vi.stubGlobal(
        'DecompressionStream',
        class extends NativeDecompression {
          constructor(format: CompressionFormat) {
            super(format);
            decompress();
          }
        },
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const store = await openReplayTraceStore();
      const updates: TraceUpdate[] = [
        { key: -1, before: Uint8Array.of(7), after: new Uint8Array(512).fill(8) },
        { key: 1, before: new Uint8Array(511).fill(1), after: new Uint8Array(513).fill(2) },
        { key: 2, before: new Uint8Array(512).fill(3), after: new Uint8Array(511).fill(4) },
      ];
      expect(await store.write(1, updates)).toBe(true);
      expect(compress).toHaveBeenCalledTimes(3);
      const records = tables.get('regions')!;
      expect([...records.values()].map(({ codec }) => codec)).toEqual([
        'raw',
        'gzip',
        'raw',
        'gzip',
        'gzip',
        'raw',
      ]);
      expect(store.bytes).toBe(
        [...records.values()].reduce((total, record) => total + record.data!.byteLength + 128, 0),
      );
      expect(store.warning).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      const scanBytes = 64 * 128 + 4096;
      const metadataBytes = scanBytes + updates.length * 512;
      for (const [from, to, version] of [
        [0, 1, 'after'],
        [1, 0, 'before'],
      ] as const) {
        const reserve = vi.fn();
        const restored: TraceRecord[] = [];
        for await (const record of store.restore(from, to, reserve)) restored.push(record);
        expect(restored).toEqual(
          updates.map((entry) => ({ key: entry.key, data: entry[version] })),
        );
        expect(reserve.mock.calls.map(([bytes]) => bytes)).toEqual([
          4096,
          scanBytes,
          metadataBytes,
          metadataBytes +
            updates.reduce((total, { key }) => {
              const record = records.get(`${key}:${to}`)!;
              return total + record.rawBytes * 4 + record.data!.byteLength * 2;
            }, 0),
        ]);
      }
      expect(decompress).toHaveBeenCalledTimes(3);
      payloadReads.mockClear();
      decompress.mockClear();
      const reserve = vi.fn((bytes: number) => {
        if (bytes > metadataBytes) throw new Error('workspace exhausted');
      });
      const denied = async () => {
        for await (const record of store.restore(0, 1, reserve)) {
          throw new Error(`Unexpected decoded region ${record.key}`);
        }
      };
      await expect(denied()).rejects.toThrow('workspace exhausted');
      expect(reserve).toHaveBeenCalledTimes(4);
      expect(payloadReads).not.toHaveBeenCalled();
      expect(decompress).not.toHaveBeenCalled();
      await store.close();
      expect(store.indexBytes).toBe(0);
    });
  });

  it('cleans up its unique database when opening fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const deleted: string[] = [];
    const factory = {
      open: vi.fn((_name: string) => {
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() => request.onerror?.(new Event('error')));
        return request;
      }),
      deleteDatabase: vi.fn((name: string) => {
        deleted.push(name);
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() => request.onsuccess?.(new Event('success')));
        return request;
      }),
    };
    vi.stubGlobal('indexedDB', factory);
    const store = await openReplayTraceStore();
    expect(store.available).toBe(false);
    expect(store.warning).toMatch(/open failed/);
    expect(deleted).toEqual([factory.open.mock.calls[0][0]]);
  });

  it('warns nonfatally for raw fallback and deletes only its own unique database', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('CompressionStream', undefined);
    vi.stubGlobal('DecompressionStream', undefined);
    const databases: Array<{ name: string; close: ReturnType<typeof vi.fn> }> = [];
    const deleted: string[] = [];
    const factory = {
      open: vi.fn((name: string) => {
        const database = { name, close: vi.fn() };
        databases.push(database);
        const request = { result: database } as unknown as IDBOpenDBRequest;
        queueMicrotask(() => request.onsuccess?.(new Event('success')));
        return request;
      }),
      deleteDatabase: vi.fn((name: string) => {
        deleted.push(name);
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() => request.onsuccess?.(new Event('success')));
        return request;
      }),
    };
    vi.stubGlobal('indexedDB', factory);
    const first = await openReplayTraceStore();
    const second = await openReplayTraceStore();
    expect(first.available).toBe(true);
    expect(first.warning).toMatch(/storing raw/);
    expect(warn).toHaveBeenCalledWith(first.warning);
    expect(databases[0].name).not.toBe(databases[1].name);
    await first.close();
    await first.close();
    expect(deleted).toEqual([databases[0].name]);
    expect(first.indexBytes).toBe(0);
    expect(second.indexBytes).toBe(4096);
    expect(databases[0].close).toHaveBeenCalledTimes(1);
    expect(databases[1].close).not.toHaveBeenCalled();
    expect(second.available).toBe(true);
    await second.close();
    expect(deleted).toEqual(databases.map(({ name }) => name));
  });
});
