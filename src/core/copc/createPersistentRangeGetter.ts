import type { Getter } from "copc";
import {
  CopcIndexedDbRangeCache,
  type CopcPersistentRangeCache,
} from "./CopcPersistentRangeCache";
import type {
  CopcHttpRangeResponse,
  CopcPersistentHttpRangeCacheOptions,
} from "./createHttpRangeGetter";

const DEFAULT_PERSISTENT_BLOCK_BYTE_LENGTH = 64 * 1024;
const DEFAULT_MAX_UNDERLYING_FETCH_BYTE_LENGTH = 256 * 1024 * 1024;
const SOURCE_REVOCATIONS = new Map<string, Promise<void>>();
// A no-store event advances the source epoch before its purge starts. Live
// getters capture one epoch, so a later strong-validator re-enable can never
// make their older memory or validation namespace usable again.
const SOURCE_POLICY_EPOCHS = new Map<string, number>();
const SOURCE_POLICY_OPERATIONS = new Map<string, Promise<void>>();

interface PersistentBlockKey {
  /** Stable URL/source identity shared by every validator namespace. */
  readonly sourceIdentityKey: string;
  /** Validator/version-scoped namespace used for exact block lookup. */
  readonly sourceKey: string;
  readonly begin: number;
  readonly end: number;
}

type PersistentRangeCacheAdapter = CopcPersistentRangeCache<PersistentBlockKey>;

interface SourceValidation {
  readonly sourceIdentityKey: string;
  readonly cacheSourceKey: string;
  readonly sourcePolicyEpoch: number;
  readonly mode: "application-version" | "strong-etag";
  readonly validator?: string;
  readonly sourceByteLength: number;
}

type HttpRangeFetcher = (
  begin: number,
  end: number,
  options?: {
    /** Bypasses a fresh browser HTTP-cache entry for validator probing. */
    readonly forceOriginRevalidation?: boolean;
    /** Runs as soon as response headers forbid any cache storage. */
    readonly onCacheStorageForbidden?: () => Promise<void>;
  },
) => Promise<CopcHttpRangeResponse>;

export function createPersistentHttpRangeGetter(
  parsedUrl: URL,
  options: Exclude<CopcPersistentHttpRangeCacheOptions, false>,
  fetchRange: HttpRangeFetcher,
  maxRangeByteLength = DEFAULT_MAX_UNDERLYING_FETCH_BYTE_LENGTH,
  onCacheStorageForbidden: () => void = () => undefined,
  onSourcePolicyAvailable: (
    canUseMemoryCache: () => Promise<boolean>,
  ) => void = () => undefined,
): Getter {
  const effectiveMaxUnderlyingFetchByteLength = Math.min(
    readPositiveSafeIntegerOption(
      "maxRangeByteLength",
      maxRangeByteLength,
      DEFAULT_MAX_UNDERLYING_FETCH_BYTE_LENGTH,
    ),
    readPositiveSafeIntegerOption(
      "persistentRangeCache.maxUnderlyingFetchByteLength",
      options.maxUnderlyingFetchByteLength,
      DEFAULT_MAX_UNDERLYING_FETCH_BYTE_LENGTH,
    ),
  );
  const blockByteLength = readPositiveSafeIntegerOption(
    "persistentRangeCache.blockByteLength",
    options.blockByteLength,
    DEFAULT_PERSISTENT_BLOCK_BYTE_LENGTH,
  );

  if (blockByteLength > effectiveMaxUnderlyingFetchByteLength) {
    throw new Error(
      `persistentRangeCache.blockByteLength must not exceed the effective underlying fetch maximum of ${effectiveMaxUnderlyingFetchByteLength} bytes.`,
    );
  }
  const cache = createPersistentRangeCacheAdapter(options.cache);
  let validationPromise: Promise<SourceValidation | undefined> | undefined;
  let persistenceDisabled = false;
  let resolvedSourceIdentityKey: string | undefined;
  let resolvedSourcePolicyEpoch: number | undefined;
  const inFlightBlocks = new Map<string, Promise<Uint8Array>>();
  const forbidCaching = (): void => {
    persistenceDisabled = true;
    onCacheStorageForbidden();
  };
  const readFallbackRange = async (
    begin: number,
    end: number,
  ): Promise<Uint8Array> => readNetworkOnlyRange(
    fetchRange,
    begin,
    end,
    async () => {
      forbidCaching();

      if (resolvedSourceIdentityKey) {
        await disableCacheSource(cache, resolvedSourceIdentityKey);
      }
    },
  );

  return async (begin: number, end: number): Promise<Uint8Array> => {
    if (begin === end) {
      return new Uint8Array();
    }

    if (resolvedSourceIdentityKey) {
      const revocation = readSourceRevocation(resolvedSourceIdentityKey);

      if (revocation) {
        await revocation;
      }

      if (
        resolvedSourcePolicyEpoch !==
        readSourcePolicyEpoch(resolvedSourceIdentityKey)
      ) {
        forbidCaching();
      }
    }

    if (persistenceDisabled) {
      return readFallbackRange(begin, end);
    }

    const validation = await getSourceValidation(
      parsedUrl,
      options,
      fetchRange,
      cache,
      forbidCaching,
      (sourceIdentityKey, sourcePolicyEpoch) => {
        if (resolvedSourceIdentityKey !== undefined) {
          return;
        }

        resolvedSourceIdentityKey = sourceIdentityKey;
        resolvedSourcePolicyEpoch = sourcePolicyEpoch;
        onSourcePolicyAvailable(async () => {
          const revocation = readSourceRevocation(sourceIdentityKey);

          if (revocation) {
            await revocation;
          }

          if (sourcePolicyEpoch !== readSourcePolicyEpoch(sourceIdentityKey)) {
            return false;
          }

          const sourceDisabled = await isCacheSourceDisabled(
            cache,
            sourceIdentityKey,
          );

          return (
            !sourceDisabled &&
            sourcePolicyEpoch === readSourcePolicyEpoch(sourceIdentityKey)
          );
        });
      },
      () => validationPromise,
      (promise) => {
        validationPromise = promise;
      },
    );

    if (!validation) {
      return readFallbackRange(begin, end);
    }

    if (end > validation.sourceByteLength) {
      throw new Error(
        `COPC byte range ${begin}-${end} exceeds the source size of ${validation.sourceByteLength} bytes.`,
      );
    }

    const blocks = createBlockRanges(
      begin,
      end,
      blockByteLength,
      validation.sourceByteLength,
    );
    const bytes = new Uint8Array(end - begin);

    const blockBytes = await readPersistentBlocks(
      cache,
      inFlightBlocks,
      blocks,
      validation,
      effectiveMaxUnderlyingFetchByteLength,
      fetchRange,
      async () => {
        forbidCaching();
        await disableCacheSource(cache, validation.sourceIdentityKey);
      },
      () => persistenceDisabled,
    );

    if (
      !persistenceDisabled &&
      !(await isSourcePolicyEpochCurrent(validation))
    ) {
      forbidCaching();
      return readFallbackRange(begin, end);
    }

    for (const block of blocks) {
      const key = createBlockCacheKey(validation.cacheSourceKey, block);
      const currentBlockBytes = blockBytes.get(key);

      if (!currentBlockBytes) {
        throw new Error("COPC persistent range block was not loaded.");
      }

      const copyBegin = Math.max(begin, block.begin);
      const copyEnd = Math.min(end, block.end);

      bytes.set(
        currentBlockBytes.subarray(
          copyBegin - block.begin,
          copyEnd - block.begin,
        ),
        copyBegin - begin,
      );
    }

    return bytes;
  };
}

async function getSourceValidation(
  parsedUrl: URL,
  options: Exclude<CopcPersistentHttpRangeCacheOptions, false>,
  fetchRange: HttpRangeFetcher,
  cache: PersistentRangeCacheAdapter,
  onCacheStorageForbidden: () => void,
  writeSourceIdentity: (
    sourceIdentityKey: string,
    sourcePolicyEpoch: number,
  ) => void,
  readPromise: () => Promise<SourceValidation | undefined> | undefined,
  writePromise: (promise: Promise<SourceValidation | undefined> | undefined) => void,
): Promise<SourceValidation | undefined> {
  const existing = readPromise();

  if (existing) {
    return existing;
  }

  const next = resolveSourceValidation(
    parsedUrl,
    options,
    fetchRange,
    cache,
    onCacheStorageForbidden,
    writeSourceIdentity,
  );
  writePromise(next);

  try {
    return await next;
  } catch (error) {
    if (readPromise() === next) {
      writePromise(undefined);
    }

    throw error;
  }
}

async function resolveSourceValidation(
  parsedUrl: URL,
  options: Exclude<CopcPersistentHttpRangeCacheOptions, false>,
  fetchRange: HttpRangeFetcher,
  cache: PersistentRangeCacheAdapter,
  onCacheStorageForbidden: () => void,
  writeSourceIdentity: (
    sourceIdentityKey: string,
    sourcePolicyEpoch: number,
  ) => void,
): Promise<SourceValidation | undefined> {
  const configuredSourceIdentityKey = options.sourceKey?.trim();

  if (options.sourceKey !== undefined && !configuredSourceIdentityKey) {
    throw new Error("persistentRangeCache.sourceKey must be non-empty.");
  }

  const sourceIdentityKey =
    configuredSourceIdentityKey ?? await createOpaqueUrlSourceKey(parsedUrl);

  if (!sourceIdentityKey) {
    throw new Error(
      "Persistent range caching requires Web Crypto for an opaque URL identity; provide a non-secret persistentRangeCache.sourceKey or disable persistence.",
    );
  }

  const sourcePolicyEpoch = readSourcePolicyEpoch(sourceIdentityKey);
  writeSourceIdentity(sourceIdentityKey, sourcePolicyEpoch);
  const sourceRevocation = readSourceRevocation(sourceIdentityKey);

  if (sourceRevocation) {
    await sourceRevocation;
  }

  const validation = options.validation ?? { mode: "strong-etag" as const };

  if (validation?.mode === "application-version") {
    if (validation.version.trim().length === 0) {
      throw new Error("persistentRangeCache.validation.version must be non-empty.");
    }

    const sourceByteLength = readPositiveSafeIntegerOption(
      "persistentRangeCache.validation.sourceByteLength",
      validation.sourceByteLength,
      validation.sourceByteLength,
    );

    const cacheSourceKey =
      `app:${sourceIdentityKey}:${validation.version}:${sourceByteLength}`;

    if (await isCacheSourceDisabled(cache, sourceIdentityKey)) {
      return undefined;
    }

    if (sourcePolicyEpoch !== readSourcePolicyEpoch(sourceIdentityKey)) {
      return undefined;
    }

    return {
      sourceIdentityKey,
      cacheSourceKey,
      sourcePolicyEpoch,
      mode: "application-version",
      sourceByteLength,
      validator: validation.version,
    };
  }

  if (validation?.mode !== "strong-etag") {
    return undefined;
  }

  let noStorePromise: Promise<void> | undefined;
  const handleNoStore = async (): Promise<void> => {
    noStorePromise ??= (async () => {
      onCacheStorageForbidden();
      await disableCacheSource(cache, sourceIdentityKey);
    })();
    await noStorePromise;
  };
  const probe = await fetchRange(0, 1, {
    forceOriginRevalidation: true,
    onCacheStorageForbidden: handleNoStore,
  });
  const etag = probe.etag;
  const sourceByteLength = probe.sourceByteLength;
  const cacheSourceKey =
    etag && isStrongEtag(etag) && sourceByteLength !== undefined
      ? `etag:${sourceIdentityKey}:${etag}:${sourceByteLength}`
      : undefined;

  if (noStorePromise || cacheControlDisallowsStore(probe.cacheControl)) {
    await handleNoStore();

    return undefined;
  }

  if (
    !etag ||
    !isStrongEtag(etag) ||
    sourceByteLength === undefined ||
    !cacheSourceKey
  ) {
    return undefined;
  }

  if (!(await enableCacheSource(cache, sourceIdentityKey, sourcePolicyEpoch))) {
    return undefined;
  }

  return {
    sourceIdentityKey,
    cacheSourceKey,
    sourcePolicyEpoch,
    mode: "strong-etag",
    sourceByteLength,
    validator: etag,
  };
}

async function createOpaqueUrlSourceKey(parsedUrl: URL): Promise<string | undefined> {
  const digest = globalThis.crypto?.subtle?.digest;

  if (typeof digest !== "function") {
    return undefined;
  }

  try {
    const resourceUrl = new URL(parsedUrl);
    resourceUrl.hash = "";
    const encoded = new TextEncoder().encode(resourceUrl.toString());
    const hash = await digest.call(
      globalThis.crypto.subtle,
      "SHA-256",
      encoded,
    );

    return `sha256:${toHex(new Uint8Array(hash))}`;
  } catch {
    return undefined;
  }
}

function toHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readPersistentBlocks(
  cache: PersistentRangeCacheAdapter,
  inFlightBlocks: Map<string, Promise<Uint8Array>>,
  blocks: readonly PersistentBlockKey[],
  validation: SourceValidation,
  maxUnderlyingFetchByteLength: number,
  fetchRange: HttpRangeFetcher,
  disablePersistence: () => Promise<void>,
  isPersistenceDisabled: () => boolean,
): Promise<Map<string, Uint8Array>> {
  const loaded = new Map<string, Uint8Array>();
  const missing: PersistentBlockKey[] = [];

  await Promise.all(blocks.map(async (block) => {
    const key = createPersistentBlockKey(validation, block);
    const cacheKey = createBlockCacheKey(validation.cacheSourceKey, block);
    const inFlight = inFlightBlocks.get(cacheKey);

    if (inFlight) {
      loaded.set(cacheKey, (await inFlight).slice());
      return;
    }

    const cached = await readCacheBlock(cache, key);
    const expectedByteLength = key.end - key.begin;

    if (cached?.byteLength === expectedByteLength) {
      loaded.set(cacheKey, cached.slice());
      return;
    }

    if (cached) {
      await deleteCacheBlock(cache, key);
    }

    missing.push(block);
  }));

  missing.sort((left, right) => left.begin - right.begin);

  for (const candidateRun of createMissingBlockRuns(
    missing,
    maxUnderlyingFetchByteLength,
  )) {
    const run: PersistentBlockKey[] = [];

    for (const block of candidateRun) {
      const cacheKey = createBlockCacheKey(validation.cacheSourceKey, block);
      const lateInFlight = inFlightBlocks.get(cacheKey);

      if (lateInFlight) {
        loaded.set(cacheKey, (await lateInFlight).slice());
      } else {
        run.push(block);
      }
    }

    if (run.length === 0) {
      continue;
    }

    const runPromise = fetchMissingBlockRun(
      cache,
      run,
      validation,
      fetchRange,
      disablePersistence,
      isPersistenceDisabled,
    );
    const runBlockPromises: Promise<Uint8Array>[] = [];

    for (const block of run) {
      const cacheKey = createBlockCacheKey(validation.cacheSourceKey, block);
      const blockPromise = runPromise.then((runBlocks) => {
        const bytes = runBlocks.get(cacheKey);

        if (!bytes) {
          throw new Error("COPC persistent range block was not loaded.");
        }

        return bytes.slice();
      });
      runBlockPromises.push(blockPromise);

      const storedPromise = blockPromise.finally(() => {
        inFlightBlocks.delete(cacheKey);
      });
      void storedPromise.catch(() => undefined);
      inFlightBlocks.set(cacheKey, storedPromise);
    }

    try {
      for (const [key, bytes] of await runPromise) {
        loaded.set(key, bytes.slice());
      }
    } catch (error) {
      await Promise.allSettled(runBlockPromises);
      throw error;
    }
  }

  return loaded;
}

async function fetchMissingBlockRun(
  cache: PersistentRangeCacheAdapter,
  blocks: readonly PersistentBlockKey[],
  validation: SourceValidation,
  fetchRange: HttpRangeFetcher,
  disablePersistence: () => Promise<void>,
  isPersistenceDisabled: () => boolean,
): Promise<Map<string, Uint8Array>> {
  const begin = blocks[0]?.begin;
  const end = blocks[blocks.length - 1]?.end;

  if (begin === undefined || end === undefined) {
    return new Map();
  }

  let noStorePromise: Promise<void> | undefined;
  const handleNoStore = async (): Promise<void> => {
    noStorePromise ??= disablePersistence();
    await noStorePromise;
  };
  const response = await fetchRange(begin, end, {
    onCacheStorageForbidden: handleNoStore,
  });
  const responseDisallowsStore = cacheControlDisallowsStore(
    response.cacheControl,
  );

  if (responseDisallowsStore) {
    await handleNoStore();
  }

  validateFetchedPersistentResponse(response, validation, begin, end);

  const loaded = new Map<string, Uint8Array>();

  await Promise.all(blocks.map(async (block) => {
    const key = createPersistentBlockKey(validation, block);
    const cacheKey = createBlockCacheKey(validation.cacheSourceKey, block);
    const bytes = response.bytes.slice(block.begin - begin, block.end - begin);

    if (bytes.byteLength !== block.end - block.begin) {
      throw new Error(
        `COPC persistent block response length mismatch: expected ${block.end - block.begin} bytes, received ${bytes.byteLength}.`,
      );
    }

    if (!responseDisallowsStore && !isPersistenceDisabled()) {
      await writeCacheBlock(cache, key, bytes);

      if (isPersistenceDisabled()) {
        await deleteCacheBlock(cache, key);
      }
    }

    loaded.set(cacheKey, bytes);
  }));

  return loaded;
}

function validateFetchedPersistentResponse(
  response: CopcHttpRangeResponse,
  validation: SourceValidation,
  begin: number,
  end: number,
): void {
  const expectedByteLength = end - begin;

  if (response.bytes.byteLength !== expectedByteLength) {
    throw new Error(
      `COPC persistent block response length mismatch: expected ${expectedByteLength} bytes, received ${response.bytes.byteLength}.`,
    );
  }

  if (validation.mode === "strong-etag" && response.etag !== validation.validator) {
    throw new Error("COPC persistent range validator changed during fetch.");
  }

  if (
    (validation.mode === "strong-etag" ||
      response.sourceByteLength !== undefined) &&
    response.sourceByteLength !== validation.sourceByteLength
  ) {
    throw new Error("COPC persistent range source length changed during fetch.");
  }
}

function createMissingBlockRuns(
  missing: readonly PersistentBlockKey[],
  maxUnderlyingFetchByteLength: number,
): PersistentBlockKey[][] {
  const runs: PersistentBlockKey[][] = [];
  let current: PersistentBlockKey[] = [];

  for (const block of missing) {
    const currentBegin = current[0]?.begin;
    const currentEnd = current[current.length - 1]?.end;
    const nextLength =
      currentBegin === undefined ? block.end - block.begin : block.end - currentBegin;

    if (
      current.length > 0 &&
      (currentEnd !== block.begin || nextLength > maxUnderlyingFetchByteLength)
    ) {
      runs.push(current);
      current = [];
    }

    const blockLength = block.end - block.begin;

    if (blockLength > maxUnderlyingFetchByteLength) {
      throw new Error(
        `COPC persistent block length ${blockLength} exceeds the configured underlying fetch maximum of ${maxUnderlyingFetchByteLength} bytes.`,
      );
    }

    current.push(block);
  }

  if (current.length > 0) {
    runs.push(current);
  }

  return runs;
}

function createBlockRanges(
  begin: number,
  end: number,
  blockByteLength: number,
  sourceByteLength: number,
): PersistentBlockKey[] {
  const blocks: PersistentBlockKey[] = [];
  let blockBegin = Math.floor(begin / blockByteLength) * blockByteLength;

  while (blockBegin < end) {
    const blockEnd = Math.min(blockBegin + blockByteLength, sourceByteLength);
    blocks.push({
      sourceIdentityKey: "",
      sourceKey: "",
      begin: blockBegin,
      end: blockEnd,
    });
    blockBegin = blockEnd;
  }

  return blocks;
}

function createPersistentRangeCacheAdapter(
  cache: CopcPersistentRangeCache | undefined,
): PersistentRangeCacheAdapter {
  const resolved = cache ?? new CopcIndexedDbRangeCache();

  for (const method of [
    "get",
    "set",
    "isSourceDisabled",
    "disableSource",
    "enableSource",
  ] as const) {
    if (typeof resolved[method] !== "function") {
      throw new TypeError(
        `persistentRangeCache.cache must implement ${method}().`,
      );
    }
  }

  return resolved as PersistentRangeCacheAdapter;
}

function createPersistentBlockKey(
  validation: SourceValidation,
  block: PersistentBlockKey,
): PersistentBlockKey {
  return {
    sourceIdentityKey: validation.sourceIdentityKey,
    sourceKey: validation.cacheSourceKey,
    begin: block.begin,
    end: block.end,
  };
}

function createBlockCacheKey(sourceKey: string, block: PersistentBlockKey): string {
  return `${sourceKey}:${block.begin}:${block.end}`;
}

async function isCacheSourceDisabled(
  cache: PersistentRangeCacheAdapter,
  sourceKey: string,
): Promise<boolean> {
  try {
    return await cache.isSourceDisabled(sourceKey);
  } catch {
    // A persistent-state read failure must fail closed to the network path.
    return true;
  }
}

async function disableCacheSource(
  cache: PersistentRangeCacheAdapter,
  sourceKey: string,
): Promise<void> {
  const existing = SOURCE_REVOCATIONS.get(sourceKey);

  if (existing) {
    await existing;
    return;
  }

  SOURCE_POLICY_EPOCHS.set(
    sourceKey,
    readSourcePolicyEpoch(sourceKey) + 1,
  );

  // This operation is an atomic privacy boundary. A rejected promise remains
  // registered so every live or newly-created getter for this source fails
  // closed instead of reusing entries whose purge could not be confirmed.
  // Queue it behind an in-progress re-enable so no-store is always the final
  // policy writer even when the two responses race.
  const previousPolicyOperation = SOURCE_POLICY_OPERATIONS.get(sourceKey) ??
    Promise.resolve();
  const revocation = previousPolicyOperation.then(() =>
    cache.disableSource(sourceKey),
  );
  SOURCE_POLICY_OPERATIONS.set(sourceKey, revocation);
  SOURCE_REVOCATIONS.set(sourceKey, revocation);
  void revocation.then(
    () => {
      if (SOURCE_REVOCATIONS.get(sourceKey) === revocation) {
        SOURCE_REVOCATIONS.delete(sourceKey);
      }

      if (SOURCE_POLICY_OPERATIONS.get(sourceKey) === revocation) {
        SOURCE_POLICY_OPERATIONS.delete(sourceKey);
      }
    },
    () => undefined,
  );
  await revocation;
}

async function enableCacheSource(
  cache: PersistentRangeCacheAdapter,
  sourceKey: string,
  expectedPolicyEpoch: number,
): Promise<boolean> {
  const revocation = readSourceRevocation(sourceKey);

  if (revocation) {
    await revocation;
  }

  if (expectedPolicyEpoch !== readSourcePolicyEpoch(sourceKey)) {
    return false;
  }

  const previousPolicyOperation = SOURCE_POLICY_OPERATIONS.get(sourceKey) ??
    Promise.resolve();
  let enabled = false;
  const enableOperation = previousPolicyOperation.then(async () => {
    if (expectedPolicyEpoch !== readSourcePolicyEpoch(sourceKey)) {
      return;
    }

    try {
      await cache.enableSource(sourceKey);
      enabled = true;
    } catch {
      // A stale tombstone makes this getter use the network path; it is safe.
    }
  });
  SOURCE_POLICY_OPERATIONS.set(sourceKey, enableOperation);

  try {
    await enableOperation;
  } finally {
    if (SOURCE_POLICY_OPERATIONS.get(sourceKey) === enableOperation) {
      SOURCE_POLICY_OPERATIONS.delete(sourceKey);
    }
  }

  const laterRevocation = readSourceRevocation(sourceKey);

  if (laterRevocation) {
    await laterRevocation;
  }

  if (
    !enabled ||
    expectedPolicyEpoch !== readSourcePolicyEpoch(sourceKey) ||
    await isCacheSourceDisabled(cache, sourceKey)
  ) {
    return false;
  }

  return expectedPolicyEpoch === readSourcePolicyEpoch(sourceKey);
}

function readSourceRevocation(sourceKey: string): Promise<void> | undefined {
  return SOURCE_REVOCATIONS.get(sourceKey);
}

function readSourcePolicyEpoch(sourceKey: string): number {
  return SOURCE_POLICY_EPOCHS.get(sourceKey) ?? 0;
}

async function isSourcePolicyEpochCurrent(
  validation: SourceValidation,
): Promise<boolean> {
  const revocation = readSourceRevocation(validation.sourceIdentityKey);

  if (revocation) {
    await revocation;
  }

  return validation.sourcePolicyEpoch ===
    readSourcePolicyEpoch(validation.sourceIdentityKey);
}

async function readCacheBlock(
  cache: PersistentRangeCacheAdapter,
  key: PersistentBlockKey,
): Promise<Uint8Array | undefined> {
  try {
    return await cache.get(key);
  } catch {
    return undefined;
  }
}

async function writeCacheBlock(
  cache: PersistentRangeCacheAdapter,
  key: PersistentBlockKey,
  bytes: Uint8Array,
): Promise<void> {
  try {
    await cache.set(key, bytes.slice());
  } catch {
    // Persistent cache writes must never make range loading fail.
  }
}

async function deleteCacheBlock(
  cache: PersistentRangeCacheAdapter,
  key: PersistentBlockKey,
): Promise<void> {
  try {
    await cache.delete?.(key);
  } catch {
    // Corrupt persistent entries are ignored if deletion fails.
  }
}

function cacheControlDisallowsStore(cacheControl: string | undefined): boolean {
  return cacheControl
    ?.split(",")
    .some((directive) => directive.trim().toLowerCase() === "no-store") ?? false;
}

async function readNetworkOnlyRange(
  fetchRange: HttpRangeFetcher,
  begin: number,
  end: number,
  onNoStore: () => Promise<void>,
): Promise<Uint8Array> {
  let noStorePromise: Promise<void> | undefined;
  const handleNoStore = async (): Promise<void> => {
    noStorePromise ??= onNoStore();
    await noStorePromise;
  };
  const response = await fetchRange(begin, end, {
    onCacheStorageForbidden: handleNoStore,
  });

  if (cacheControlDisallowsStore(response.cacheControl)) {
    await handleNoStore();
  }

  return response.bytes.slice();
}

function isStrongEtag(etag: string): boolean {
  return /^"[\s\S]*"$/.test(etag);
}

function readPositiveSafeIntegerOption(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  const resolved = value ?? fallback;

  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(
      `${name} must be a positive integer no greater than ${Number.MAX_SAFE_INTEGER}.`,
    );
  }

  return resolved;
}
