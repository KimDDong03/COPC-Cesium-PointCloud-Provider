import { describe, expect, it } from "vitest";
import { CopcIndexedDbRangeCache } from "./CopcPersistentRangeCache";

describe("CopcIndexedDbRangeCache", () => {
  it("validates constructor options", () => {
    expect(() => new CopcIndexedDbRangeCache({ databaseName: "" })).toThrow(
      "databaseName",
    );
    expect(
      () =>
        new CopcIndexedDbRangeCache({
          databaseName: "ranges",
          maxCachedRangeBytes: 0,
        }),
    ).toThrow("maxCachedRangeBytes");
    expect(
      () =>
        new CopcIndexedDbRangeCache({
          databaseName: "ranges",
          maxCachedRangeCount: -1,
        }),
    ).toThrow("maxCachedRangeCount");
  });

  it("returns copied exact-range bytes and tracks hit stats", async () => {
    const cache = createCache();
    const key = { sourceKey: "url:https://example.test/a.copc.laz", begin: 4, end: 7 };

    const source = new Uint8Array([1, 2, 3]);
    await cache.set(key, source);
    source[0] = 99;

    const first = await cache.get(key);
    expect(first).toEqual(new Uint8Array([1, 2, 3]));

    if (!first) {
      throw new Error("expected cache hit");
    }

    first[1] = 88;
    await expect(cache.get(key)).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(cache.get({ ...key, begin: 5 })).resolves.toBeUndefined();

    await expect(cache.getStats()).resolves.toMatchObject({
      hits: 2,
      misses: 1,
      writes: 1,
      cachedRangeBytes: 3,
      cachedRangeCount: 1,
      hitBytes: 6,
      writtenBytes: 3,
    });
  });

  it("rejects invalid keys and byte lengths before writing", async () => {
    const cache = createCache();

    await expect(
      cache.set({ sourceKey: "source", begin: 10, end: 12 }, new Uint8Array([1])),
    ).rejects.toThrow("length");
    await expect(
      cache.get({ sourceKey: "source", begin: 12, end: 10 }),
    ).rejects.toThrow("end");

    await expect(cache.getStats()).resolves.toMatchObject({
      errors: 0,
      cachedRangeBytes: 0,
      cachedRangeCount: 0,
    });
  });

  it("evicts least recently used exact ranges by byte and count budgets", async () => {
    const cache = createCache({
      maxCachedRangeBytes: 4,
      maxCachedRangeCount: 2,
    });
    const first = { sourceKey: "source", begin: 0, end: 2 };
    const second = { sourceKey: "source", begin: 2, end: 4 };
    const third = { sourceKey: "source", begin: 4, end: 6 };

    await cache.set(first, new Uint8Array([1, 1]));
    await cache.set(second, new Uint8Array([2, 2]));
    await cache.get(first);
    await cache.set(third, new Uint8Array([3, 3]));

    await expect(cache.get(second)).resolves.toBeUndefined();
    await expect(cache.get(first)).resolves.toEqual(new Uint8Array([1, 1]));
    await expect(cache.get(third)).resolves.toEqual(new Uint8Array([3, 3]));
    await expect(cache.getStats()).resolves.toMatchObject({
      evictions: 1,
      cachedRangeBytes: 4,
      cachedRangeCount: 2,
    });
  });

  it("skips ranges larger than the byte budget", async () => {
    const cache = createCache({ maxCachedRangeBytes: 2 });
    const key = { sourceKey: "source", begin: 0, end: 3 };

    await cache.set(key, new Uint8Array([1, 2, 3]));

    await expect(cache.get(key)).resolves.toBeUndefined();
    await expect(cache.getStats()).resolves.toMatchObject({
      writes: 0,
      cachedRangeBytes: 0,
      cachedRangeCount: 0,
    });
  });

  it("deletes and clears ranges", async () => {
    const cache = createCache();
    const first = { sourceKey: "source", begin: 0, end: 1 };
    const second = { sourceKey: "source", begin: 1, end: 2 };

    await cache.set(first, new Uint8Array([1]));
    await cache.set(second, new Uint8Array([2]));
    await cache.delete(first);

    await expect(cache.get(first)).resolves.toBeUndefined();
    await expect(cache.get(second)).resolves.toEqual(new Uint8Array([2]));

    await cache.clear();

    await expect(cache.get(second)).resolves.toBeUndefined();
    await expect(cache.getStats()).resolves.toMatchObject({
      cachedRangeBytes: 0,
      cachedRangeCount: 0,
    });
  });

  it("purges, tombstones, re-enables, and clears one source identity across validator namespaces", async () => {
    const cache = createCache();
    const first = {
      sourceKey: "app:source-a:etag-1:8",
      sourceIdentityKey: "app:source-a",
      begin: 0,
      end: 2,
    };
    const second = {
      sourceKey: "app:source-a:etag-2:8",
      sourceIdentityKey: "app:source-a",
      begin: 2,
      end: 4,
    };
    const other = {
      sourceKey: "app:source-b:etag-1:8",
      sourceIdentityKey: "app:source-b",
      begin: 0,
      end: 2,
    };

    await cache.set(first, new Uint8Array([1, 2]));
    await cache.set(second, new Uint8Array([3, 4]));
    await cache.set(other, new Uint8Array([5, 6]));
    await cache.disableSource(first.sourceIdentityKey);

    await expect(cache.isSourceDisabled(first.sourceIdentityKey)).resolves.toBe(true);
    await expect(cache.isSourceDisabled(first.sourceKey)).resolves.toBe(false);
    await expect(cache.get(first)).resolves.toBeUndefined();
    await expect(cache.get(second)).resolves.toBeUndefined();
    await expect(cache.get(other)).resolves.toEqual(new Uint8Array([5, 6]));
    await cache.set(first, new Uint8Array([7, 8]));
    await expect(cache.get(first)).resolves.toBeUndefined();
    await expect(cache.getStats()).resolves.toMatchObject({
      cachedRangeBytes: 2,
      cachedRangeCount: 1,
    });

    await cache.enableSource(first.sourceIdentityKey);
    await expect(cache.isSourceDisabled(first.sourceIdentityKey)).resolves.toBe(false);
    await cache.set(first, new Uint8Array([7, 8]));
    await expect(cache.get(first)).resolves.toEqual(new Uint8Array([7, 8]));

    await cache.disableSource(first.sourceIdentityKey);
    await cache.clear();
    await expect(cache.isSourceDisabled(first.sourceIdentityKey)).resolves.toBe(false);
    await expect(cache.getStats()).resolves.toMatchObject({
      cachedRangeBytes: 0,
      cachedRangeCount: 0,
    });
  });

  it("rejects IndexedDB failures and records errors", async () => {
    const cache = new CopcIndexedDbRangeCache({
      databaseName: "ranges",
      indexedDB: undefined,
    });

    await expect(
      cache.get({ sourceKey: "source", begin: 0, end: 1 }),
    ).rejects.toThrow("IndexedDB");
    await expect(cache.getStats()).rejects.toThrow("IndexedDB");
  });

  it("tracks stats for many writes without scanning range payloads", async () => {
    const indexedDB = new FakeIndexedDbFactory();
    const cache = createCache({}, indexedDB);

    for (let index = 0; index < 64; index += 1) {
      await cache.set(
        { sourceKey: "source", begin: index * 1024, end: (index + 1) * 1024 },
        new Uint8Array(1024).fill(index),
      );
    }

    await expect(cache.getStats()).resolves.toMatchObject({
      writes: 64,
      cachedRangeBytes: 64 * 1024,
      cachedRangeCount: 64,
      writtenBytes: 64 * 1024,
    });
    expect(indexedDB.getStoreGetAllCount("ranges")).toBe(0);
  });

  it("clears legacy ranges and metadata when upgrading to the source-identity schema", async () => {
    const indexedDB = new FakeIndexedDbFactory();
    indexedDB.seedVersion2Ranges([
      createLegacyStoredTestEntry("source:v1", 0, 2, [1, 2], 1),
      createLegacyStoredTestEntry("source:v2", 2, 5, [3, 4, 5], 2),
    ]);
    const cache = createCache({}, indexedDB);

    await expect(cache.getStats()).resolves.toMatchObject({
      cachedRangeBytes: 0,
      cachedRangeCount: 0,
    });
    await expect(
      cache.get({
        sourceKey: "source:v1",
        sourceIdentityKey: "source",
        begin: 0,
        end: 2,
      }),
    ).resolves.toBeUndefined();
    expect(indexedDB.getStoreGetAllCount("ranges")).toBe(0);
  });
});

interface CreateCacheOptions {
  readonly maxCachedRangeBytes?: number;
  readonly maxCachedRangeCount?: number;
}

function createCache(
  options: CreateCacheOptions = {},
  indexedDB = new FakeIndexedDbFactory(),
): CopcIndexedDbRangeCache {
  return new CopcIndexedDbRangeCache({
    databaseName: "ranges",
    indexedDB: indexedDB as unknown as IDBFactory,
    ...options,
  });
}

class FakeIndexedDbFactory {
  private readonly database = new FakeIdbDatabase();

  open(_name: string, version = 1): FakeIdbOpenRequest {
    const request = new FakeIdbOpenRequest(this.database);

    queueMicrotask(() => {
      request.result = this.database;

      if (version > this.database.version) {
        const oldVersion = this.database.version;
        const transaction = this.database.beginUpgradeTransaction();
        request.transaction = transaction;
        request.onupgradeneeded?.(
          createVersionChangeEvent("upgradeneeded", oldVersion),
        );
        this.database.version = version;
        transaction.finishScheduling();
        transaction.done.then(() => {
          request.transaction = null;
          request.onsuccess?.(new Event("success"));
        });
        return;
      }

      request.onsuccess?.(new Event("success"));
    });

    return request;
  }

  getStoreGetAllCount(name: string): number {
    return this.database.getStoreGetAllCount(name);
  }

  seedVersion2Ranges(entries: readonly StoredTestRecord[]): void {
    this.database.version = 2;
    const store = this.database.createObjectStoreState("ranges");

    for (const entry of entries) {
      store.records.set(entry.id, cloneRecord(entry));
    }
  }
}

class FakeIdbOpenRequest {
  error: DOMException | null = null;
  onblocked: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onsuccess: ((event: Event) => void) | null = null;
  onupgradeneeded: ((event: Event) => void) | null = null;
  result: FakeIdbDatabase;
  transaction: FakeIdbTransaction | null = null;

  constructor(database: FakeIdbDatabase) {
    this.result = database;
  }
}

class FakeIdbDatabase {
  version = 0;
  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };
  private readonly stores = new Map<string, FakeObjectStoreState>();
  private upgradeTransaction: FakeIdbTransaction | undefined;

  createObjectStore(name: string): FakeIdbObjectStore {
    const store = this.createObjectStoreState(name);
    return new FakeIdbObjectStore(
      name,
      store,
      this.upgradeTransaction ?? new FakeIdbTransaction(new Map([[name, store]])),
    );
  }

  createObjectStoreState(name: string): FakeObjectStoreState {
    let store = this.stores.get(name);

    if (!store) {
      store = {
        getAllCount: 0,
        indexes: new Set(),
        records: new Map(),
      };
      this.stores.set(name, store);
    }

    return store;
  }

  transaction(names: string | readonly string[]): FakeIdbTransaction {
    const storeNames = Array.isArray(names) ? names : [names];
    const stores = new Map<string, FakeObjectStoreState>();

    for (const name of storeNames) {
      stores.set(name, this.createObjectStoreState(name));
    }

    return new FakeIdbTransaction(stores);
  }

  beginUpgradeTransaction(): FakeIdbTransaction {
    const transaction = new FakeIdbTransaction(this.stores);
    this.upgradeTransaction = transaction;
    transaction.done.finally(() => {
      if (this.upgradeTransaction === transaction) {
        this.upgradeTransaction = undefined;
      }
    });
    return transaction;
  }

  getStoreGetAllCount(name: string): number {
    return this.stores.get(name)?.getAllCount ?? 0;
  }
}

class FakeIdbTransaction {
  error: DOMException | null = null;
  onabort: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private pendingRequests = 0;
  private completeQueued = false;
  private completed = false;
  private completeHandler: ((event: Event) => void) | null = null;
  readonly done: Promise<void>;
  private resolveDone: () => void = () => undefined;

  constructor(private readonly stores: Map<string, FakeObjectStoreState>) {
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  get oncomplete(): ((event: Event) => void) | null {
    return this.completeHandler;
  }

  set oncomplete(handler: ((event: Event) => void) | null) {
    this.completeHandler = handler;

    if (handler && this.completed) {
      queueMicrotask(() => handler(new Event("complete")));
    }
  }

  objectStore(name: string): FakeIdbObjectStore {
    const store = this.stores.get(name);

    if (!store) {
      throw new Error(`Missing fake object store: ${name}`);
    }

    return new FakeIdbObjectStore(name, store, this);
  }

  trackRequest(): void {
    this.pendingRequests += 1;
    this.completeQueued = false;
  }

  completeRequest(): void {
    this.pendingRequests -= 1;
    this.scheduleCompletion();
  }

  finishScheduling(): void {
    this.scheduleCompletion();
  }

  private scheduleCompletion(): void {
    if (this.pendingRequests !== 0 || this.completeQueued) {
      return;
    }

    this.completeQueued = true;
    setTimeout(() => {
      this.completeQueued = false;

      if (this.pendingRequests !== 0 || this.completed) {
        return;
      }

      this.completed = true;
      this.completeHandler?.(new Event("complete"));
      this.resolveDone();
    }, 0);
  }
}

class FakeIdbObjectStore {
  readonly indexNames = {
    contains: (name: string) => this.store.indexes.has(name),
  };

  constructor(
    private readonly name: string,
    private readonly store: FakeObjectStoreState,
    private readonly transaction: FakeIdbTransaction,
  ) {}

  get(id: string): FakeIdbRequest<StoredTestRecord | undefined> {
    return this.resolveRequest(cloneRecord(this.store.records.get(id)));
  }

  getAll(): FakeIdbRequest<StoredTestRecord[]> {
    this.store.getAllCount += 1;
    return this.resolveRequest([...this.store.records.values()].map(cloneRecord));
  }

  put(record: StoredTestRecord): FakeIdbRequest<StoredTestRecord> {
    this.store.records.set(record.id, cloneRecord(record));
    return this.resolveRequest(record);
  }

  delete(id: string): FakeIdbRequest<void> {
    this.store.records.delete(id);
    return this.resolveRequest(undefined);
  }

  clear(): FakeIdbRequest<void> {
    this.store.records.clear();
    return this.resolveRequest(undefined);
  }

  createIndex(name: string): void {
    this.store.indexes.add(name);
  }

  index(name: string): FakeIdbIndex {
    if (!this.indexNames.contains(name)) {
      throw new Error(`Missing fake index: ${this.name}.${name}`);
    }

    return new FakeIdbIndex(this.store, this.transaction);
  }

  openCursor(): FakeIdbCursorRequest {
    const entries = [...this.store.records.values()].filter(
      isStoredTestRangeRecord,
    );
    const request = new FakeIdbCursorRequest(
      entries,
      this.transaction,
      this.store,
    );
    this.transaction.trackRequest();
    queueMicrotask(() => request.deliver());
    return request;
  }

  resolveRequest<T>(result: T): FakeIdbRequest<T> {
    const request = new FakeIdbRequest(result);
    this.transaction.trackRequest();

    queueMicrotask(() => {
      request.onsuccess?.(new Event("success"));
      this.transaction.completeRequest();
    });

    return request;
  }
}

class FakeIdbIndex {
  constructor(
    private readonly store: FakeObjectStoreState,
    private readonly transaction: FakeIdbTransaction,
  ) {}

  openCursor(): FakeIdbCursorRequest {
    const entries = [...this.store.records.values()]
      .filter(isStoredTestRangeRecord)
      .sort((left, right) => left.accessTime - right.accessTime);
    const request = new FakeIdbCursorRequest(
      entries,
      this.transaction,
      this.store,
    );
    this.transaction.trackRequest();

    queueMicrotask(() => request.deliver());

    return request;
  }
}

class FakeIdbCursorRequest {
  error: DOMException | null = null;
  onerror: ((event: Event) => void) | null = null;
  onsuccess: ((event: Event) => void) | null = null;
  result: FakeIdbCursor | null = null;
  private cursorIndex = 0;

  constructor(
    private readonly entries: readonly StoredTestRangeRecord[],
    private readonly transaction: FakeIdbTransaction,
    private readonly store: FakeObjectStoreState,
  ) {}

  deliver(): void {
    const entry = this.entries[this.cursorIndex];

    if (!entry) {
      this.result = null;
      this.onsuccess?.(new Event("success"));
      this.transaction.completeRequest();
      return;
    }

    const cursor = new FakeIdbCursor(
      cloneRecord(entry),
      () => {
        this.cursorIndex += 1;
        queueMicrotask(() => this.deliver());
      },
      () => {
        this.store.records.delete(entry.id);
      },
    );
    this.result = cursor;
    this.onsuccess?.(new Event("success"));

    if (!cursor.didContinue) {
      this.transaction.completeRequest();
    }
  }
}

class FakeIdbCursor {
  didContinue = false;

  constructor(
    readonly value: StoredTestRangeRecord,
    private readonly continueCursor: () => void,
    private readonly deleteCursor: () => void,
  ) {}

  continue(): void {
    this.didContinue = true;
    this.continueCursor();
  }

  delete(): void {
    this.deleteCursor();
  }
}

class FakeIdbRequest<T> {
  error: DOMException | null = null;
  onerror: ((event: Event) => void) | null = null;
  onsuccess: ((event: Event) => void) | null = null;

  constructor(readonly result: T) {}
}

interface FakeObjectStoreState {
  getAllCount: number;
  indexes: Set<string>;
  records: Map<string, StoredTestRecord>;
}

type StoredTestRecord =
  | StoredTestLegacyEntry
  | StoredTestEntry
  | StoredTestTotals
  | StoredTestSourceState;

interface StoredTestLegacyEntry {
  readonly id: string;
  readonly sourceKey: string;
  readonly begin: number;
  readonly end: number;
  readonly byteLength: number;
  readonly accessTime: number;
  readonly bytes: Uint8Array;
}

interface StoredTestEntry extends StoredTestLegacyEntry {
  readonly sourceIdentityKey: string;
}

type StoredTestRangeRecord = StoredTestLegacyEntry | StoredTestEntry;

interface StoredTestTotals {
  readonly id: string;
  readonly cachedRangeBytes: number;
  readonly cachedRangeCount: number;
}

interface StoredTestSourceState {
  readonly id: string;
  readonly disabled: true;
}

function createLegacyStoredTestEntry(
  sourceKey: string,
  begin: number,
  end: number,
  bytes: readonly number[],
  accessTime: number,
): StoredTestLegacyEntry {
  return {
    id: JSON.stringify([sourceKey, begin, end]),
    sourceKey,
    begin,
    end,
    byteLength: end - begin,
    accessTime,
    bytes: new Uint8Array(bytes),
  };
}

function cloneRecord<T extends StoredTestRecord | undefined>(record: T): T {
  if (!record) {
    return record;
  }

  if (isStoredTestRangeRecord(record)) {
    return {
      ...record,
      bytes: record.bytes.slice(),
    } as T;
  }

  return {
    ...record,
  };
}

function isStoredTestRangeRecord(
  record: StoredTestRecord,
): record is StoredTestRangeRecord {
  return "bytes" in record;
}

function createVersionChangeEvent(
  type: string,
  oldVersion: number,
): Event & { readonly oldVersion: number } {
  const event = new Event(type) as Event & { oldVersion: number };
  Object.defineProperty(event, "oldVersion", { value: oldVersion });
  return event;
}
