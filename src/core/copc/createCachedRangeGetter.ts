import type { Getter } from "copc";

export interface CopcRangeGetterCacheOptions {
  readonly maxCachedRangeBytes?: number;
  readonly maxCachedRangeCount?: number;
}

export interface ControllableCachedRangeGetter {
  readonly getter: Getter;
  /** Drops all resolved and in-flight entries without changing cache policy. */
  readonly clear: () => void;
  /** Permanently bypasses this in-memory cache and drops every entry. */
  readonly disable: () => void;
}

interface RangeCacheEntry {
  readonly begin: number;
  readonly end: number;
  readonly promise: Promise<Uint8Array>;
  byteLength: number;
}

const DEFAULT_MAX_CACHED_RANGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_CACHED_RANGE_COUNT = 64;

export function createCachedRangeGetter(
  getter: Getter,
  options: CopcRangeGetterCacheOptions = {},
): Getter {
  return createControllableCachedRangeGetter(getter, options).getter;
}

/**
 * Internal control surface used when HTTP response policy can revoke caching
 * after a request has already started (for example, Cache-Control: no-store).
 */
export function createControllableCachedRangeGetter(
  getter: Getter,
  options: CopcRangeGetterCacheOptions = {},
  canUseCache: () => boolean | Promise<boolean> = () => true,
): ControllableCachedRangeGetter {
  const maxCachedRangeBytes = normalizePositiveIntegerOption(
    options.maxCachedRangeBytes,
    DEFAULT_MAX_CACHED_RANGE_BYTES,
  );
  const maxCachedRangeCount = normalizePositiveIntegerOption(
    options.maxCachedRangeCount,
    DEFAULT_MAX_CACHED_RANGE_COUNT,
  );
  const cache = new Map<string, RangeCacheEntry>();
  let cachedByteLength = 0;
  let disabled = maxCachedRangeBytes <= 0 || maxCachedRangeCount <= 0;

  const clear = (): void => {
    cache.clear();
    cachedByteLength = 0;
  };

  const disable = (): void => {
    disabled = true;
    clear();
  };

  const cachedGetter = async (begin: number, end: number): Promise<Uint8Array> => {
    if (disabled) {
      return copyBytes(await getter(begin, end));
    }

    const key = createRangeCacheKey(begin, end);
    const cached = findContainingRangeCacheEntry(cache, begin, end, key);

    if (cached) {
      if (!(await readCachePermission(canUseCache))) {
        disable();
        return copyBytes(await getter(begin, end));
      }

      cache.delete(cached.key);
      cache.set(cached.key, cached.entry);
      return copyBytesFromRange(
        await cached.entry.promise,
        begin - cached.entry.begin,
        end - begin,
      );
    }

    const entry: RangeCacheEntry = {
      begin,
      end,
      byteLength: 0,
      promise: getter(begin, end).then((bytes) => {
        const cachedBytes = copyBytes(bytes);

        return readCachePermission(canUseCache).then((cacheAllowed) => {
          if (!cacheAllowed) {
            disable();
            return cachedBytes;
          }

          if (cache.get(key) !== entry) {
            return cachedBytes;
          }

          if (cachedBytes.byteLength > maxCachedRangeBytes) {
            cache.delete(key);
            return cachedBytes;
          }

          entry.byteLength = cachedBytes.byteLength;
          cachedByteLength += entry.byteLength;
          cachedByteLength = trimRangeCache(
            cache,
            cachedByteLength,
            maxCachedRangeCount,
            maxCachedRangeBytes,
          );

          return cachedBytes;
        });
      }).catch((error: unknown) => {
        if (cache.get(key) === entry) {
          cache.delete(key);
        }

        throw error;
      }),
    };

    cache.set(key, entry);
    return copyBytes(await entry.promise);
  };

  return {
    getter: cachedGetter,
    clear,
    disable,
  };
}

async function readCachePermission(
  canUseCache: () => boolean | Promise<boolean>,
): Promise<boolean> {
  try {
    return await canUseCache();
  } catch {
    return false;
  }
}

function findContainingRangeCacheEntry(
  cache: Map<string, RangeCacheEntry>,
  begin: number,
  end: number,
  exactKey: string,
): { key: string; entry: RangeCacheEntry } | undefined {
  const exact = cache.get(exactKey);

  if (exact) {
    return { key: exactKey, entry: exact };
  }

  let containing: { key: string; entry: RangeCacheEntry } | undefined;

  for (const [key, entry] of cache) {
    if (entry.begin <= begin && end <= entry.end) {
      containing = { key, entry };
    }
  }

  return containing;
}

function trimRangeCache(
  cache: Map<string, RangeCacheEntry>,
  cachedByteLength: number,
  maxCachedRangeCount: number,
  maxCachedRangeBytes: number,
): number {
  while (
    cache.size > maxCachedRangeCount ||
    cachedByteLength > maxCachedRangeBytes
  ) {
    if (cache.size === 0) {
      return 0;
    }

    cachedByteLength -= removeOldestRangeCacheEntry(cache);
  }

  return cachedByteLength;
}

function removeOldestRangeCacheEntry(
  cache: Map<string, RangeCacheEntry>,
): number {
  const oldestKey = cache.keys().next().value;

  if (!oldestKey) {
    return 0;
  }

  const oldest = cache.get(oldestKey);
  cache.delete(oldestKey);
  return oldest?.byteLength ?? 0;
}

function createRangeCacheKey(begin: number, end: number): string {
  return `${begin}:${end}`;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

function copyBytesFromRange(
  bytes: Uint8Array,
  beginOffset: number,
  byteLength: number,
): Uint8Array {
  return bytes.slice(beginOffset, beginOffset + byteLength);
}

function normalizePositiveIntegerOption(
  value: number | undefined,
  fallback: number,
): number {
  return value === undefined || !Number.isSafeInteger(value) || value < 0
    ? fallback
    : value;
}
