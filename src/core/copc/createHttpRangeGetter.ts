import type { Getter } from "copc";
import {
  createCachedRangeGetter,
  createControllableCachedRangeGetter,
  type CopcRangeGetterCacheOptions,
  type ControllableCachedRangeGetter,
} from "./createCachedRangeGetter";
import type { CopcPersistentRangeCache } from "./CopcPersistentRangeCache";
import { createPersistentHttpRangeGetter } from "./createPersistentRangeGetter";

const MAX_RANGE_REQUEST_ATTEMPTS = 3;
const RANGE_REQUEST_RETRY_DELAY_MILLISECONDS = 75;
const DEFAULT_MAX_RANGE_BYTE_LENGTH = 256 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const MAX_TIMER_DELAY_MILLISECONDS = 2_147_483_647;

export interface CopcHttpRangeGetterOptions
  extends CopcRangeGetterCacheOptions {
  /** Maximum number of bytes accepted in one half-open range request. */
  readonly maxRangeByteLength?: number;
  /** Per-attempt HTTP deadline. The default is 30 seconds. */
  readonly requestTimeoutMilliseconds?: number;
  /** Optional lifetime signal combined with the per-request timeout signal. */
  readonly signal?: AbortSignal;
  /** Opt-in browser-persistent fixed-block cache. Disabled by default. */
  readonly persistentRangeCache?: CopcPersistentHttpRangeCacheOptions;
}

export type CopcPersistentHttpRangeCacheOptions =
  | false
  | {
      readonly enabled?: boolean;
      /** Storage implementation shared by getters. Defaults to IndexedDB. */
      readonly cache?: CopcPersistentRangeCache;
      /**
       * Advanced stable namespace override. By default the normalized URL is
       * SHA-256 hashed so query-string credentials are not stored verbatim.
       * Caller-provided values are persisted as-is and must not contain secrets.
       */
      readonly sourceKey?: string;
      /** Fixed persistent block size. The default is 64 KiB. */
      readonly blockByteLength?: number;
      /** Maximum coalesced miss fetched underneath the block cache. */
      readonly maxUnderlyingFetchByteLength?: number;
      readonly validation?:
        | CopcPersistentStrongEtagValidationOptions
        | CopcPersistentApplicationVersionValidationOptions;
    };

export interface CopcPersistentStrongEtagValidationOptions {
  readonly mode: "strong-etag";
}

export interface CopcPersistentApplicationVersionValidationOptions {
  readonly mode: "application-version";
  readonly version: string;
  readonly sourceByteLength: number;
}

export interface CopcHttpRangeResponse {
  readonly bytes: Uint8Array;
  readonly etag?: string;
  readonly cacheControl?: string;
  readonly sourceByteLength?: number;
}

export type CopcRangeRequestErrorCode =
  | "network-or-cors"
  | "http-status"
  | "range-not-supported"
  | "timeout"
  | "malformed-content-range"
  | "mismatched-content-range"
  | "body-length-mismatch";

export interface CopcRangeRequestErrorOptions {
  readonly code: CopcRangeRequestErrorCode;
  /** Requested half-open byte range start. */
  readonly begin: number;
  /** Requested half-open byte range end. */
  readonly end: number;
  /** HTTP status when a response was received. */
  readonly status?: number;
  /** Whether this failure category is eligible for the built-in retry policy. */
  readonly retriable: boolean;
  readonly cause?: unknown;
}

export class CopcRangeRequestError extends Error {
  readonly code: CopcRangeRequestErrorCode;
  readonly begin: number;
  readonly end: number;
  readonly status?: number;
  readonly retriable: boolean;

  constructor(message: string, options: CopcRangeRequestErrorOptions) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "CopcRangeRequestError";
    this.code = options.code;
    this.begin = options.begin;
    this.end = options.end;
    this.status = options.status;
    this.retriable = options.retriable;
  }
}

export function createHttpRangeGetter(
  url: string,
  options: CopcHttpRangeGetterOptions = {},
): Getter {
  const parsedUrl = createHttpUrl(url);
  const maxRangeByteLength = readPositiveSafeIntegerOption(
    "maxRangeByteLength",
    options.maxRangeByteLength,
    DEFAULT_MAX_RANGE_BYTE_LENGTH,
  );
  const requestTimeoutMilliseconds = readPositiveSafeIntegerOption(
    "requestTimeoutMilliseconds",
    options.requestTimeoutMilliseconds,
    DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
    MAX_TIMER_DELAY_MILLISECONDS,
  );

  const fetcher = async (begin: number, end: number): Promise<Uint8Array> => {
    const byteLength = validateByteRange(begin, end, maxRangeByteLength);

    if (byteLength === 0) {
      return new Uint8Array();
    }

    return (await fetchRangeWithRetries(
      parsedUrl,
      begin,
      end,
      requestTimeoutMilliseconds,
      options.signal,
    )).bytes;
  };

  if (
    typeof options.persistentRangeCache === "object" &&
    options.persistentRangeCache.enabled !== false
  ) {
    let memoryCache: ControllableCachedRangeGetter | undefined;
    let canUsePersistentMemoryCache: () => Promise<boolean> = async () => true;
    const persistentGetter = createPersistentHttpRangeGetter(
      parsedUrl,
      options.persistentRangeCache,
      async (begin, end, requestOptions) => {
        validateByteRange(begin, end, maxRangeByteLength);

        if (begin === end) {
          return {
            bytes: new Uint8Array(),
          };
        }

        return fetchRangeWithRetries(
          parsedUrl,
          begin,
          end,
          requestTimeoutMilliseconds,
          options.signal,
          requestOptions?.forceOriginRevalidation ? "reload" : undefined,
          requestOptions?.onCacheStorageForbidden,
        );
      },
      maxRangeByteLength,
      () => memoryCache?.disable(),
      (canUseMemoryCache) => {
        canUsePersistentMemoryCache = canUseMemoryCache;
      },
    );
    const controlledMemoryCache = createControllableCachedRangeGetter(
      persistentGetter,
      options,
      () => canUsePersistentMemoryCache(),
    );
    memoryCache = controlledMemoryCache;

    return async (begin: number, end: number): Promise<Uint8Array> => {
      const byteLength = validateByteRange(begin, end, maxRangeByteLength);

      if (byteLength === 0) {
        return new Uint8Array();
      }

      return controlledMemoryCache.getter(begin, end);
    };
  }

  return createCachedRangeGetter(fetcher, options);
}

async function fetchRangeWithRetries(
  parsedUrl: URL,
  begin: number,
  end: number,
  requestTimeoutMilliseconds: number,
  signal: AbortSignal | undefined,
  requestCache?: RequestCache,
  onCacheStorageForbidden?: () => Promise<void>,
): Promise<CopcHttpRangeResponse> {
  let lastError: unknown;

  throwIfAborted(signal);

  for (let attempt = 1; attempt <= MAX_RANGE_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await fetchRange(
        parsedUrl,
        begin,
        end,
        requestTimeoutMilliseconds,
        signal,
        requestCache,
        onCacheStorageForbidden,
      );
    } catch (error) {
      lastError = error;

      if (
        attempt === MAX_RANGE_REQUEST_ATTEMPTS ||
        !isRetriableRangeRequestError(error)
      ) {
        throw error;
      }

      await delayRangeRequestRetry(attempt, signal);
    }
  }

  throw lastError;
}

async function fetchRange(
  parsedUrl: URL,
  begin: number,
  end: number,
  requestTimeoutMilliseconds: number,
  callerSignal: AbortSignal | undefined,
  requestCache?: RequestCache,
  onCacheStorageForbidden?: () => Promise<void>,
): Promise<CopcHttpRangeResponse> {
  const timeoutError = createRangeRequestTimeoutError(
    begin,
    end,
    requestTimeoutMilliseconds,
  );
  const abortContext = createRequestAbortContext(
    callerSignal,
    requestTimeoutMilliseconds,
    timeoutError,
  );
  let cachePolicyCallbackFailed = false;

  try {
    throwIfRequestAborted(abortContext, callerSignal);

    const response = await fetch(parsedUrl.toString(), {
      cache: requestCache,
      headers: {
        Range: `bytes=${begin}-${end - 1}`,
      },
      signal: abortContext.signal,
    });

    throwIfRequestAborted(abortContext, callerSignal);
    const cacheControl = response.headers.get("Cache-Control") ?? undefined;

    if (
      cacheControlDisallowsStore(cacheControl) &&
      onCacheStorageForbidden
    ) {
      try {
        await onCacheStorageForbidden();
      } catch (error) {
        cachePolicyCallbackFailed = true;
        throw error;
      }
    }

    if (!response.ok) {
      throw new CopcRangeRequestError(
        `COPC range request failed with HTTP ${response.status}.`,
        {
          code: "http-status",
          begin,
          end,
          status: response.status,
          retriable: isRetriableHttpStatus(response.status),
        },
      );
    }

    if (response.status !== 206) {
      throw new CopcRangeRequestError(
        "COPC source must support HTTP range requests.",
        {
          code: "range-not-supported",
          begin,
          end,
          status: response.status,
          retriable: false,
        },
      );
    }

    const contentRange = response.headers.get("Content-Range");
    let sourceByteLength: number | undefined;

    if (contentRange !== null) {
      sourceByteLength = validateContentRange(
        contentRange,
        begin,
        end,
        response.status,
      );
    }

    const expectedByteLength = end - begin;
    const bytes = await readExactRangeResponseBody(
      response,
      expectedByteLength,
      begin,
      end,
    );

    throwIfRequestAborted(abortContext, callerSignal);
    return {
      bytes,
      cacheControl,
      etag: response.headers.get("ETag") ?? undefined,
      sourceByteLength,
    };
  } catch (error) {
    if (abortContext.abortSource === "caller") {
      throw createAbortError(callerSignal);
    }

    if (abortContext.abortSource === "timeout") {
      throw timeoutError;
    }

    if (error instanceof CopcRangeRequestError) {
      throw error;
    }

    if (cachePolicyCallbackFailed) {
      throw error;
    }

    if (error instanceof TypeError) {
      throw createNetworkOrCorsError(begin, end, error);
    }

    throw error;
  } finally {
    abortContext.cleanup();
  }
}

function cacheControlDisallowsStore(cacheControl: string | undefined): boolean {
  return cacheControl
    ?.split(",")
    .some((directive) => directive.trim().toLowerCase() === "no-store") ?? false;
}

function createRangeRequestTimeoutError(
  begin: number,
  end: number,
  timeoutMilliseconds: number,
): CopcRangeRequestError {
  return new CopcRangeRequestError(
    `COPC range request timed out after ${timeoutMilliseconds} milliseconds.`,
    {
      code: "timeout",
      begin,
      end,
      retriable: false,
    },
  );
}

function createNetworkOrCorsError(
  begin: number,
  end: number,
  cause: unknown,
): CopcRangeRequestError {
  const message =
    cause instanceof Error && cause.message.length > 0
      ? cause.message
      : "COPC range request failed because of a network or CORS error.";

  return new CopcRangeRequestError(message, {
    code: "network-or-cors",
    begin,
    end,
    retriable: true,
    cause,
  });
}

interface RequestAbortContext {
  readonly signal: AbortSignal;
  readonly abortSource: "caller" | "timeout" | undefined;
  readonly cleanup: () => void;
}

function createRequestAbortContext(
  callerSignal: AbortSignal | undefined,
  timeoutMilliseconds: number,
  timeoutError: CopcRangeRequestError,
): RequestAbortContext {
  const controller = new AbortController();
  let abortSource: "caller" | "timeout" | undefined;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;

  const abortForCaller = (): void => {
    if (abortSource !== undefined) {
      return;
    }

    abortSource = "caller";
    controller.abort(callerSignal?.reason);
  };
  const abortForTimeout = (): void => {
    if (abortSource !== undefined) {
      return;
    }

    abortSource = "timeout";
    controller.abort(timeoutError);
  };

  if (callerSignal?.aborted) {
    abortForCaller();
  } else {
    callerSignal?.addEventListener("abort", abortForCaller, { once: true });
    timeoutId = globalThis.setTimeout(abortForTimeout, timeoutMilliseconds);
  }

  return {
    signal: controller.signal,
    get abortSource() {
      return abortSource;
    },
    cleanup: () => {
      if (timeoutId !== undefined) {
        globalThis.clearTimeout(timeoutId);
      }

      callerSignal?.removeEventListener("abort", abortForCaller);
    },
  };
}

function throwIfRequestAborted(
  context: RequestAbortContext,
  callerSignal: AbortSignal | undefined,
): void {
  if (context.abortSource === "caller") {
    throw createAbortError(callerSignal);
  }

  if (context.abortSource === "timeout") {
    throw context.signal.reason;
  }
}

async function readExactRangeResponseBody(
  response: Response,
  expectedByteLength: number,
  begin: number,
  end: number,
): Promise<Uint8Array> {
  if (!response.body) {
    throw createBodyLengthMismatchError(
      expectedByteLength,
      0,
      begin,
      end,
      response.status,
    );
  }

  const bytes = new Uint8Array(expectedByteLength);
  const reader = response.body.getReader();
  let receivedByteLength = 0;
  let completed = false;

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        completed = true;
        break;
      }

      const nextByteLength = receivedByteLength + chunk.value.byteLength;

      if (nextByteLength > expectedByteLength) {
        throw createBodyLengthMismatchError(
          expectedByteLength,
          nextByteLength,
          begin,
          end,
          response.status,
        );
      }

      bytes.set(chunk.value, receivedByteLength);
      receivedByteLength = nextByteLength;
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }

    reader.releaseLock();
  }

  if (receivedByteLength !== expectedByteLength) {
    throw createBodyLengthMismatchError(
      expectedByteLength,
      receivedByteLength,
      begin,
      end,
      response.status,
    );
  }

  return bytes;
}

function createBodyLengthMismatchError(
  expectedByteLength: number,
  receivedByteLength: number,
  begin: number,
  end: number,
  status: number,
): CopcRangeRequestError {
  return new CopcRangeRequestError(
    `COPC range response body length mismatch: expected ${expectedByteLength} bytes, received ${receivedByteLength}.`,
    {
      code: "body-length-mismatch",
      begin,
      end,
      status,
      // A proxy or upstream connection can terminate a valid 206 stream
      // early. Retrying remains bounded by MAX_RANGE_REQUEST_ATTEMPTS and the
      // exact-length check still prevents accepting truncated or extra bytes.
      retriable: true,
    },
  );
}

function validateContentRange(
  contentRange: string,
  begin: number,
  end: number,
  status: number,
): number | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange);

  if (!match) {
    throw new CopcRangeRequestError(
      `COPC range response has malformed Content-Range: ${contentRange}.`,
      {
        code: "malformed-content-range",
        begin,
        end,
        status,
        retriable: false,
      },
    );
  }

  const responseBegin = Number(match[1]);
  const responseEnd = Number(match[2]);

  if (
    !Number.isSafeInteger(responseBegin) ||
    !Number.isSafeInteger(responseEnd)
  ) {
    throw new CopcRangeRequestError(
      `COPC range response has malformed Content-Range: ${contentRange}.`,
      {
        code: "malformed-content-range",
        begin,
        end,
        status,
        retriable: false,
      },
    );
  }

  const expectedEnd = end - 1;

  if (responseBegin !== begin || responseEnd !== expectedEnd) {
    throw new CopcRangeRequestError(
      `COPC range response Content-Range mismatch: expected bytes ${begin}-${expectedEnd}, received bytes ${responseBegin}-${responseEnd}.`,
      {
        code: "mismatched-content-range",
        begin,
        end,
        status,
        retriable: false,
      },
    );
  }

  const completeLength = match[3];

  if (
    completeLength !== "*" &&
    BigInt(completeLength) <= BigInt(responseEnd)
  ) {
    throw new CopcRangeRequestError(
      `COPC range response has malformed Content-Range: ${contentRange}.`,
      {
        code: "malformed-content-range",
        begin,
        end,
        status,
        retriable: false,
      },
    );
  }

  if (completeLength === "*") {
    return undefined;
  }

  const sourceByteLength = Number(completeLength);

  if (!Number.isSafeInteger(sourceByteLength)) {
    throw new CopcRangeRequestError(
      `COPC range response has malformed Content-Range: ${contentRange}.`,
      {
        code: "malformed-content-range",
        begin,
        end,
        status,
        retriable: false,
      },
    );
  }

  return sourceByteLength;
}

function createHttpUrl(url: string): URL {
  const baseUrl =
    typeof globalThis.location?.href === "string"
      ? globalThis.location.href
      : undefined;
  const parsedUrl = baseUrl ? new URL(url, baseUrl) : new URL(url);

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS COPC URLs are supported.");
  }

  return parsedUrl;
}

function isRetriableRangeRequestError(error: unknown): boolean {
  return error instanceof CopcRangeRequestError && error.retriable;
}

function isRetriableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function delayRangeRequestRetry(
  attempt: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = (): void => {
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abort);
      reject(createAbortError(signal));
    };
    const timeoutId = globalThis.setTimeout(
      finish,
      RANGE_REQUEST_RETRY_DELAY_MILLISECONDS * attempt,
    );

    signal?.addEventListener("abort", abort, { once: true });
  });
}

function validateByteRange(
  begin: number,
  end: number,
  maxRangeByteLength: number,
): number {
  if (
    !Number.isSafeInteger(begin) ||
    !Number.isSafeInteger(end) ||
    begin < 0 ||
    end < begin
  ) {
    throw new Error(`Invalid byte range: ${begin}-${end}`);
  }

  const byteLength = end - begin;

  if (byteLength > maxRangeByteLength) {
    throw new Error(
      `COPC byte range length ${byteLength} exceeds the configured maximum of ${maxRangeByteLength} bytes.`,
    );
  }

  return byteLength;
}

function readPositiveSafeIntegerOption(
  name: string,
  value: number | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const resolved = value ?? fallback;

  if (
    !Number.isSafeInteger(resolved) ||
    resolved <= 0 ||
    resolved > maximum
  ) {
    throw new Error(
      `${name} must be a positive integer no greater than ${maximum}.`,
    );
  }

  return resolved;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

function createAbortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }

  return new DOMException("The operation was aborted.", "AbortError");
}
