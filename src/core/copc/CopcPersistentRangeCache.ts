export interface CopcPersistentRangeCacheKey {
  readonly sourceKey: string;
  readonly sourceIdentityKey?: string;
  readonly begin: number;
  readonly end: number;
}

export interface CopcPersistentRangeCache<
  K extends CopcPersistentRangeCacheKey = CopcPersistentRangeCacheKey,
> {
  get(key: K): Promise<Uint8Array | undefined>;
  set(key: K, bytes: Uint8Array): Promise<void>;
  delete?(key: K): Promise<void>;
  /** Returns whether this stable source identity is tombstoned. */
  isSourceDisabled(sourceIdentityKey: string): Promise<boolean>;
  /** Purges every validator/version namespace for this stable source identity and tombstones it. */
  disableSource(sourceIdentityKey: string): Promise<void>;
  /** Removes a tombstone after a fresh validator response permits storage. */
  enableSource(sourceIdentityKey: string): Promise<void>;
  clear?(): Promise<void>;
}

export interface CopcPersistentRangeCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly writes: number;
  readonly evictions: number;
  readonly errors: number;
  readonly cachedRangeBytes: number;
  readonly cachedRangeCount: number;
  readonly hitBytes: number;
  readonly writtenBytes: number;
}

export interface CopcIndexedDbRangeCacheOptions {
  readonly databaseName: string;
  readonly maxCachedRangeBytes?: number;
  readonly maxCachedRangeCount?: number;
  readonly indexedDB?: IDBFactory;
}

type NormalizedRangeCacheKey = CopcPersistentRangeCacheKey & {
  readonly sourceIdentityKey: string;
};

interface StoredRangeCacheEntry {
  readonly id: string;
  readonly sourceKey: string;
  readonly sourceIdentityKey: string;
  readonly begin: number;
  readonly end: number;
  readonly byteLength: number;
  accessTime: number;
  readonly bytes: Uint8Array;
}

interface StoredRangeCacheTotals {
  readonly id: typeof METADATA_TOTALS_ID;
  readonly cachedRangeBytes: number;
  readonly cachedRangeCount: number;
}

interface StoredRangeCacheSourceState {
  readonly id: string;
  readonly disabled: true;
}

interface MutableRangeCacheStats {
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  errors: number;
  cachedRangeBytes: number;
  cachedRangeCount: number;
  hitBytes: number;
  writtenBytes: number;
}

const RANGE_STORE_NAME = "ranges";
const METADATA_STORE_NAME = "metadata";
const ACCESS_TIME_INDEX_NAME = "accessTime";
const METADATA_TOTALS_ID = "totals";
const METADATA_DISABLED_SOURCE_PREFIX = "disabled-source:";
const DATABASE_VERSION = 3;
const DEFAULT_DATABASE_NAME = "copc-cesium-range-cache";
const DEFAULT_MAX_CACHED_RANGE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_CACHED_RANGE_COUNT = 4096;

export class CopcIndexedDbRangeCache
  implements CopcPersistentRangeCache
{
  private readonly databaseName: string;
  private readonly maxCachedRangeBytes: number;
  private readonly maxCachedRangeCount: number;
  private readonly indexedDB: IDBFactory | undefined;
  private readonly stats: MutableRangeCacheStats = {
    hits: 0,
    misses: 0,
    writes: 0,
    evictions: 0,
    errors: 0,
    cachedRangeBytes: 0,
    cachedRangeCount: 0,
    hitBytes: 0,
    writtenBytes: 0,
  };
  private databasePromise: Promise<IDBDatabase> | undefined;
  private accessClock = 0;

  constructor(options: CopcIndexedDbRangeCacheOptions = {
    databaseName: DEFAULT_DATABASE_NAME,
  }) {
    this.databaseName = normalizeDatabaseName(options.databaseName);
    this.maxCachedRangeBytes = normalizePositiveIntegerOption(
      "maxCachedRangeBytes",
      options.maxCachedRangeBytes,
      DEFAULT_MAX_CACHED_RANGE_BYTES,
    );
    this.maxCachedRangeCount = normalizePositiveIntegerOption(
      "maxCachedRangeCount",
      options.maxCachedRangeCount,
      DEFAULT_MAX_CACHED_RANGE_COUNT,
    );
    this.indexedDB = options.indexedDB ?? globalThis.indexedDB;
  }

  async get(
    key: CopcPersistentRangeCacheKey,
  ): Promise<Uint8Array | undefined> {
    const normalizedKey = normalizeRangeCacheKey(key);
    const id = createRangeCacheId(normalizedKey);

    return await this.runIndexedDbOperation(async () => {
      const database = await this.openDatabase();
      const transaction = database.transaction(
        [RANGE_STORE_NAME, METADATA_STORE_NAME],
        "readwrite",
      );
      const store = transaction.objectStore(RANGE_STORE_NAME);
      const metadataStore = transaction.objectStore(METADATA_STORE_NAME);
      const entry = await requestToPromise<StoredRangeCacheEntry | undefined>(
        store.get(id),
      );
      const sourceDisabled = await readStoredSourceDisabled(
        metadataStore,
        normalizedKey.sourceIdentityKey,
      );

      if (sourceDisabled || !entry || !isValidStoredEntry(entry, normalizedKey)) {
        if (entry) {
          store.delete(id);
          const totals = removeEntryFromTotals(
            await readStoredTotals(metadataStore),
            entry,
          );
          metadataStore.put(totals);
          await transactionDone(transaction);
          this.applyCachedRangeTotals(totals);
        } else {
          await transactionDone(transaction);
        }

        this.stats.misses += 1;
        return undefined;
      }

      entry.accessTime = this.nextAccessTime();
      store.put(entry);
      await transactionDone(transaction);

      this.stats.hits += 1;
      this.stats.hitBytes += entry.byteLength;
      return copyBytes(entry.bytes);
    });
  }

  async set(
    key: CopcPersistentRangeCacheKey,
    bytes: Uint8Array,
  ): Promise<void> {
    const normalizedKey = normalizeRangeCacheKey(key);
    const byteLength = normalizedKey.end - normalizedKey.begin;

    if (bytes.byteLength !== byteLength) {
      throw new RangeError(
        `COPC range cache entry length must be ${byteLength} bytes.`,
      );
    }

    await this.runIndexedDbOperation(async () => {
      const database = await this.openDatabase();
      const transaction = database.transaction(
        [RANGE_STORE_NAME, METADATA_STORE_NAME],
        "readwrite",
      );
      const store = transaction.objectStore(RANGE_STORE_NAME);
      const metadataStore = transaction.objectStore(METADATA_STORE_NAME);
      const id = createRangeCacheId(normalizedKey);
      const sourceDisabled = await readStoredSourceDisabled(
        metadataStore,
        normalizedKey.sourceIdentityKey,
      );
      const existingEntry = await requestToPromise<
        StoredRangeCacheEntry | undefined
      >(store.get(id));
      let totals = await readStoredTotals(metadataStore);

      if (sourceDisabled) {
        if (existingEntry) {
          store.delete(id);
          totals = removeEntryFromTotals(totals, existingEntry);
          metadataStore.put(totals);
        }

        await transactionDone(transaction);
        this.applyCachedRangeTotals(totals);
        return;
      }

      if (byteLength > this.maxCachedRangeBytes) {
        if (existingEntry) {
          store.delete(id);
          totals = removeEntryFromTotals(totals, existingEntry);
          metadataStore.put(totals);
        }

        await transactionDone(transaction);
        this.applyCachedRangeTotals(totals);
        return;
      }

      const entry: StoredRangeCacheEntry = {
        id,
        sourceKey: normalizedKey.sourceKey,
        sourceIdentityKey: normalizedKey.sourceIdentityKey,
        begin: normalizedKey.begin,
        end: normalizedKey.end,
        byteLength,
        accessTime: this.nextAccessTime(),
        bytes: copyBytes(bytes),
      };

      store.put(entry);
      totals = replaceEntryInTotals(totals, existingEntry, byteLength);
      const evictionResult = await evictLeastRecentlyUsedRanges(
        store,
        totals,
        this.maxCachedRangeBytes,
        this.maxCachedRangeCount,
      );
      metadataStore.put(evictionResult.totals);

      await transactionDone(transaction);

      this.stats.writes += 1;
      this.stats.writtenBytes += byteLength;
      this.stats.evictions += evictionResult.evictedCount;
      this.applyCachedRangeTotals(evictionResult.totals);
    });
  }

  async delete(key: CopcPersistentRangeCacheKey): Promise<void> {
    const normalizedKey = normalizeRangeCacheKey(key);
    const id = createRangeCacheId(normalizedKey);

    await this.runIndexedDbOperation(async () => {
      const database = await this.openDatabase();
      const transaction = database.transaction(
        [RANGE_STORE_NAME, METADATA_STORE_NAME],
        "readwrite",
      );
      const store = transaction.objectStore(RANGE_STORE_NAME);
      const metadataStore = transaction.objectStore(METADATA_STORE_NAME);
      const existingEntry = await requestToPromise<
        StoredRangeCacheEntry | undefined
      >(store.get(id));

      if (existingEntry) {
        store.delete(id);
        const totals = removeEntryFromTotals(
          await readStoredTotals(metadataStore),
          existingEntry,
        );
        metadataStore.put(totals);
        await transactionDone(transaction);
        this.applyCachedRangeTotals(totals);
        return;
      }

      await transactionDone(transaction);
    });
  }

  async isSourceDisabled(sourceIdentityKey: string): Promise<boolean> {
    const normalizedSourceIdentityKey = normalizeSourceIdentityKey(sourceIdentityKey);

    return await this.runIndexedDbOperation(async () => {
      const database = await this.openDatabase();
      const transaction = database.transaction(METADATA_STORE_NAME, "readonly");
      const disabled = await readStoredSourceDisabled(
        transaction.objectStore(METADATA_STORE_NAME),
        normalizedSourceIdentityKey,
      );
      await transactionDone(transaction);
      return disabled;
    });
  }

  async disableSource(sourceIdentityKey: string): Promise<void> {
    const normalizedSourceIdentityKey = normalizeSourceIdentityKey(sourceIdentityKey);

    await this.runIndexedDbOperation(async () => {
      const database = await this.openDatabase();
      const transaction = database.transaction(
        [RANGE_STORE_NAME, METADATA_STORE_NAME],
        "readwrite",
      );
      const store = transaction.objectStore(RANGE_STORE_NAME);
      const metadataStore = transaction.objectStore(METADATA_STORE_NAME);
      let totals = await readStoredTotals(metadataStore);

      await iterateCursor(store.openCursor(), (cursor) => {
        const entry = cursor.value as StoredRangeCacheEntry;

        if (entry.sourceIdentityKey === normalizedSourceIdentityKey) {
          cursor.delete();
          totals = removeEntryFromTotals(totals, entry);
        }

        return true;
      });

      metadataStore.put(createStoredSourceState(normalizedSourceIdentityKey));
      metadataStore.put(totals);
      await transactionDone(transaction);
      this.applyCachedRangeTotals(totals);
    });
  }

  async enableSource(sourceIdentityKey: string): Promise<void> {
    const normalizedSourceIdentityKey = normalizeSourceIdentityKey(sourceIdentityKey);

    await this.runIndexedDbOperation(async () => {
      const database = await this.openDatabase();
      const transaction = database.transaction(METADATA_STORE_NAME, "readwrite");
      transaction.objectStore(METADATA_STORE_NAME).delete(
        createDisabledSourceId(normalizedSourceIdentityKey),
      );
      await transactionDone(transaction);
    });
  }

  async clear(): Promise<void> {
    await this.runIndexedDbOperation(async () => {
      const database = await this.openDatabase();
      const transaction = database.transaction(
        [RANGE_STORE_NAME, METADATA_STORE_NAME],
        "readwrite",
      );
      transaction.objectStore(RANGE_STORE_NAME).clear();
      const totals = createStoredTotals(0, 0);
      const metadataStore = transaction.objectStore(METADATA_STORE_NAME);
      metadataStore.clear();
      metadataStore.put(totals);
      await transactionDone(transaction);
      this.applyCachedRangeTotals(totals);
    });
  }

  async getStats(): Promise<CopcPersistentRangeCacheStats> {
    await this.runIndexedDbOperation(async () => {
      const database = await this.openDatabase();
      const transaction = database.transaction(METADATA_STORE_NAME, "readonly");
      const totals = await readStoredTotals(
        transaction.objectStore(METADATA_STORE_NAME),
      );
      await transactionDone(transaction);
      this.applyCachedRangeTotals(totals);
    });

    return { ...this.stats };
  }

  private async runIndexedDbOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.stats.errors += 1;
      throw error;
    }
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (!this.indexedDB) {
      return Promise.reject(new Error("IndexedDB is not available."));
    }

    this.databasePromise ??= new Promise((resolve, reject) => {
      const request = this.indexedDB?.open(
        this.databaseName,
        DATABASE_VERSION,
      );

      if (!request) {
        reject(new Error("IndexedDB is not available."));
        return;
      }

      request.onupgradeneeded = (event) => {
        const database = request.result;
        const transaction = request.transaction;

        if (!transaction) {
          throw new Error("IDB upgrade transaction is not available.");
        }

        const hadRangeStore = database.objectStoreNames.contains(RANGE_STORE_NAME);
        const rangeStore = hadRangeStore
          ? transaction.objectStore(RANGE_STORE_NAME)
          : database.createObjectStore(RANGE_STORE_NAME, { keyPath: "id" });

        if (!rangeStore.indexNames.contains(ACCESS_TIME_INDEX_NAME)) {
          rangeStore.createIndex(ACCESS_TIME_INDEX_NAME, "accessTime");
        }

        const metadataStore = database.objectStoreNames.contains(
          METADATA_STORE_NAME,
        )
          ? transaction.objectStore(METADATA_STORE_NAME)
          : database.createObjectStore(METADATA_STORE_NAME, { keyPath: "id" });

        if ((event as IDBVersionChangeEvent).oldVersion < DATABASE_VERSION) {
          rangeStore.clear();
          metadataStore.clear();
        }

        metadataStore.put(createStoredTotals(0, 0));
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IDB open failed."));
      request.onblocked = () => reject(new Error("IDB open blocked."));
    });

    return this.databasePromise;
  }

  private nextAccessTime(): number {
    this.accessClock = Math.max(this.accessClock + 1, Date.now());
    return this.accessClock;
  }

  private applyCachedRangeTotals(totals: StoredRangeCacheTotals): void {
    this.stats.cachedRangeBytes = totals.cachedRangeBytes;
    this.stats.cachedRangeCount = totals.cachedRangeCount;
  }
}

async function evictLeastRecentlyUsedRanges(
  store: IDBObjectStore,
  initialTotals: StoredRangeCacheTotals,
  maxCachedRangeBytes: number,
  maxCachedRangeCount: number,
): Promise<{
  readonly totals: StoredRangeCacheTotals;
  readonly evictedCount: number;
}> {
  let totals = initialTotals;
  let evictedCount = 0;

  await iterateCursor(
    store.index(ACCESS_TIME_INDEX_NAME).openCursor(),
    (cursor) => {
      if (
        totals.cachedRangeBytes <= maxCachedRangeBytes &&
        totals.cachedRangeCount <= maxCachedRangeCount
      ) {
        return false;
      }

      const entry = cursor.value as StoredRangeCacheEntry;
      store.delete(entry.id);
      totals = removeEntryFromTotals(totals, entry);
      evictedCount += 1;
      return true;
    },
  );

  return { totals, evictedCount };
}

function isValidStoredEntry(
  entry: StoredRangeCacheEntry,
  key: NormalizedRangeCacheKey,
): boolean {
  return (
    entry.sourceKey === key.sourceKey &&
    entry.sourceIdentityKey === key.sourceIdentityKey &&
    entry.begin === key.begin &&
    entry.end === key.end &&
    entry.byteLength === key.end - key.begin &&
    entry.bytes.byteLength === entry.byteLength
  );
}

function createStoredTotals(
  cachedRangeBytes: number,
  cachedRangeCount: number,
): StoredRangeCacheTotals {
  return {
    id: METADATA_TOTALS_ID,
    cachedRangeBytes,
    cachedRangeCount,
  };
}

function createStoredSourceState(
  sourceIdentityKey: string,
): StoredRangeCacheSourceState {
  return {
    id: createDisabledSourceId(sourceIdentityKey),
    disabled: true,
  };
}

async function readStoredTotals(
  metadataStore: IDBObjectStore,
): Promise<StoredRangeCacheTotals> {
  const totals = await requestToPromise<StoredRangeCacheTotals | undefined>(
    metadataStore.get(METADATA_TOTALS_ID),
  );

  if (
    !totals ||
    totals.id !== METADATA_TOTALS_ID ||
    !Number.isSafeInteger(totals.cachedRangeBytes) ||
    totals.cachedRangeBytes < 0 ||
    !Number.isSafeInteger(totals.cachedRangeCount) ||
    totals.cachedRangeCount < 0
  ) {
    return createStoredTotals(0, 0);
  }

  return totals;
}

async function readStoredSourceDisabled(
  metadataStore: IDBObjectStore,
  sourceIdentityKey: string,
): Promise<boolean> {
  const state = await requestToPromise<
    StoredRangeCacheSourceState | undefined
  >(metadataStore.get(createDisabledSourceId(sourceIdentityKey)));

  return state?.disabled === true;
}

function replaceEntryInTotals(
  totals: StoredRangeCacheTotals,
  existingEntry: StoredRangeCacheEntry | undefined,
  nextByteLength: number,
): StoredRangeCacheTotals {
  return createStoredTotals(
    Math.max(
      0,
      totals.cachedRangeBytes -
        (existingEntry ? getStoredEntryByteLength(existingEntry) : 0) +
        nextByteLength,
    ),
    totals.cachedRangeCount + (existingEntry ? 0 : 1),
  );
}

function removeEntryFromTotals(
  totals: StoredRangeCacheTotals,
  entry: StoredRangeCacheEntry,
): StoredRangeCacheTotals {
  return createStoredTotals(
    Math.max(0, totals.cachedRangeBytes - getStoredEntryByteLength(entry)),
    Math.max(0, totals.cachedRangeCount - 1),
  );
}

function getStoredEntryByteLength(entry: StoredRangeCacheEntry): number {
  return Number.isSafeInteger(entry.byteLength) && entry.byteLength >= 0
    ? entry.byteLength
    : 0;
}

function normalizeRangeCacheKey(
  key: CopcPersistentRangeCacheKey,
): NormalizedRangeCacheKey {
  const sourceKey = normalizeSourceKey(key.sourceKey);
  const sourceIdentityKey = normalizeSourceIdentityKey(
    key.sourceIdentityKey ?? sourceKey,
  );

  if (!Number.isSafeInteger(key.begin) || key.begin < 0) {
    throw new RangeError("COPC range cache begin must be a safe non-negative integer.");
  }

  if (!Number.isSafeInteger(key.end) || key.end < key.begin) {
    throw new RangeError("COPC range cache end must be a safe integer >= begin.");
  }

  return { sourceKey, sourceIdentityKey, begin: key.begin, end: key.end };
}

function normalizeSourceKey(sourceKey: string): string {
  const normalized = sourceKey.trim();

  if (normalized.length === 0) {
    throw new TypeError("COPC range cache sourceKey must be non-empty.");
  }

  return normalized;
}

function normalizeSourceIdentityKey(sourceIdentityKey: string): string {
  const normalized = sourceIdentityKey.trim();

  if (normalized.length === 0) {
    throw new TypeError("COPC range cache sourceIdentityKey must be non-empty.");
  }

  return normalized;
}

function normalizeDatabaseName(databaseName: string): string {
  const normalized = databaseName.trim();

  if (normalized.length === 0) {
    throw new TypeError("COPC range cache databaseName must be non-empty.");
  }

  return normalized;
}

function normalizePositiveIntegerOption(
  optionName: string,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`COPC range cache ${optionName} must be a positive safe integer.`);
  }

  return value;
}

function createRangeCacheId(key: CopcPersistentRangeCacheKey): string {
  return JSON.stringify([key.sourceKey, key.begin, key.end]);
}

function createDisabledSourceId(sourceKey: string): string {
  return `${METADATA_DISABLED_SOURCE_PREFIX}${sourceKey}`;
}


function copyBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IDB request failed."));
  });
}

function iterateCursor<TCursor extends IDBCursorWithValue>(
  request: IDBRequest<TCursor | null>,
  onCursor: (cursor: TCursor) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;

      if (!cursor) {
        resolve();
        return;
      }

      if (onCursor(cursor)) {
        cursor.continue();
      } else {
        resolve();
      }
    };
    request.onerror = () => reject(request.error ?? new Error("IDB cursor failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IDB transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IDB transaction aborted."));
  });
}
