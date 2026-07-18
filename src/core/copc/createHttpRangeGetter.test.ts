import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CopcRangeRequestError,
  createHttpRangeGetter,
  type CopcRangeRequestErrorCode,
} from "./createHttpRangeGetter";

describe("createHttpRangeGetter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resolves browser-relative COPC URLs against the current page location", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2]), {
      headers: {
        "Content-Range": "bytes 10-11/100",
      },
      status: 206,
    }));
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");
    const bytes = await getter(10, 12);

    expect([...bytes]).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/copc-samples/sample.copc.laz",
      {
        headers: {
          Range: "bytes=10-11",
        },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("returns an empty buffer for valid zero-length range reads", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");
    const bytes = await getter(0, 0);

    expect([...bytes]).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects ranges above the configured byte-length limit before fetching", async () => {
    const fetchMock = vi.fn(async () => new Response(
      new Uint8Array([1, 2, 3]),
      { status: 206 },
    ));
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter(
      "/copc-samples/sample.copc.laz",
      { maxRangeByteLength: 2 },
    );

    await expect(getter(10, 13)).rejects.toThrow(
      "COPC byte range length 3 exceeds the configured maximum of 2 bytes.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces the default 256 MiB range limit before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");

    await expect(getter(0, 256 * 1024 * 1024 + 1)).rejects.toThrow(
      "COPC byte range length 268435457 exceeds the configured maximum of 268435456 bytes.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts a stalled HTTP range request at the configured deadline", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        requestSignal = init.signal as AbortSignal;
        requestSignal.addEventListener(
          "abort",
          () => reject(requestSignal?.reason),
          { once: true },
        );
      });
    });
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter(
      "/copc-samples/sample.copc.laz",
      { requestTimeoutMilliseconds: 25 },
    );
    const pending = getter(10, 12);
    const rejection = expectRangeRequestError(
      pending,
      {
        code: "timeout",
        begin: 10,
        end: 12,
        retriable: false,
      },
      "COPC range request timed out after 25 milliseconds.",
    );

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the request deadline active while the response body is streaming", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          requestSignal?.addEventListener(
            "abort",
            () => controller.error(requestSignal?.reason),
            { once: true },
          );
        },
      });

      return new Response(body, { status: 206 });
    });
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter(
      "/copc-samples/sample.copc.laz",
      { requestTimeoutMilliseconds: 25 },
    );
    const pending = getter(10, 12);
    const rejection = expectRangeRequestError(
      pending,
      {
        code: "timeout",
        begin: 10,
        end: 12,
        retriable: false,
      },
      "COPC range request timed out after 25 milliseconds.",
    );

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("combines a caller signal without passing or mutating it as the timeout controller", async () => {
    const callerController = new AbortController();
    const callerError = new Error("caller canceled the source");
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        requestSignal = init.signal as AbortSignal;
        requestSignal.addEventListener(
          "abort",
          () => reject(requestSignal?.reason),
          { once: true },
        );
      });
    });
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter(
      "/copc-samples/sample.copc.laz",
      {
        requestTimeoutMilliseconds: 1_000,
        signal: callerController.signal,
      },
    );
    const pending = getter(10, 12);

    expect(requestSignal).not.toBe(callerController.signal);
    callerController.abort(callerError);
    await expect(pending).rejects.toBe(callerError);
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves the timeout reason when the caller aborts after the deadline", async () => {
    vi.useFakeTimers();
    const callerController = new AbortController();
    const fetchMock = vi.fn((_: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const requestSignal = init.signal as AbortSignal;
        requestSignal.addEventListener(
          "abort",
          () => reject(requestSignal.reason),
          { once: true },
        );
      });
    });
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter(
      "/copc-samples/sample.copc.laz",
      {
        requestTimeoutMilliseconds: 25,
        signal: callerController.signal,
      },
    );
    const pending = getter(10, 12);
    const rejection = expectRangeRequestError(
      pending,
      {
        code: "timeout",
        begin: 10,
        end: 12,
        retriable: false,
      },
      "COPC range request timed out after 25 milliseconds.",
    );

    vi.advanceTimersByTime(25);
    callerController.abort(new Error("late caller cancellation"));
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid resource-limit options at construction", () => {
    expect(() => createHttpRangeGetter(
      "https://example.com/sample.copc.laz",
      { maxRangeByteLength: 0 },
    )).toThrow(
      "maxRangeByteLength must be a positive integer no greater than 9007199254740991.",
    );
    expect(() => createHttpRangeGetter(
      "https://example.com/sample.copc.laz",
      { requestTimeoutMilliseconds: 2_147_483_648 },
    )).toThrow(
      "requestTimeoutMilliseconds must be a positive integer no greater than 2147483647.",
    );
  });

  it("caches repeated exact HTTP byte range reads", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([7, 8]), {
      status: 206,
    }));
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");
    const first = await getter(50, 52);
    first[0] = 99;
    const second = await getter(50, 52);

    expect([...second]).toEqual([7, 8]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient browser range fetch failures", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([3, 4]), {
          status: 206,
        }),
      );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");
    const bytes = await getter(20, 22);

    expect([...bytes]).toEqual([3, 4]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports an exhausted network or CORS failure with its cause", async () => {
    vi.useFakeTimers();
    const cause = new TypeError("Failed to fetch");
    const fetchMock = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");
    const rejection = expectRangeRequestError(
      getter(20, 22),
      {
        code: "network-or-cors",
        begin: 20,
        end: 22,
        retriable: true,
      },
      "Failed to fetch",
    );

    await vi.runAllTimersAsync();
    const error = await rejection;
    expect(error.cause).toBe(cause);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry or wrap non-TypeError fetch failures", async () => {
    const cause = new Error("unexpected fetch adapter failure");
    const fetchMock = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");

    await expect(getter(20, 22)).rejects.toBe(cause);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries retriable HTTP range failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([5, 6]), {
          status: 206,
        }),
      );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");
    const bytes = await getter(30, 32);

    expect([...bytes]).toEqual([5, 6]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps retriable HTTP status metadata after retry exhaustion", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 503 }),
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");
    const rejection = expectRangeRequestError(
      getter(30, 32),
      {
        code: "http-status",
        begin: 30,
        end: 32,
        status: 503,
        retriable: true,
      },
      "COPC range request failed with HTTP 503.",
    );

    await vi.runAllTimersAsync();
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retriable HTTP range failures", async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 404 }),
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/missing.copc.laz");

    await expectRangeRequestError(
      getter(40, 42),
      {
        code: "http-status",
        begin: 40,
        end: 42,
        status: 404,
        retriable: false,
      },
      "COPC range request failed with HTTP 404.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects successful responses that do not use partial content", async () => {
    const fetchMock = vi.fn(
      async () => new Response(new Uint8Array([1, 2]), { status: 200 }),
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");

    await expectRangeRequestError(
      getter(10, 12),
      {
        code: "range-not-supported",
        begin: 10,
        end: 12,
        status: 200,
        retriable: false,
      },
      "COPC source must support HTTP range requests.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed Content-Range headers", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2]), {
      headers: {
        "Content-Range": "bytes invalid",
      },
      status: 206,
    }));
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");

    await expectRangeRequestError(
      getter(10, 12),
      {
        code: "malformed-content-range",
        begin: 10,
        end: 12,
        status: 206,
        retriable: false,
      },
      "COPC range response has malformed Content-Range: bytes invalid.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects Content-Range headers that do not match the requested range", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2]), {
      headers: {
        "Content-Range": "bytes 11-12/100",
      },
      status: 206,
    }));
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");

    await expectRangeRequestError(
      getter(10, 12),
      {
        code: "mismatched-content-range",
        begin: 10,
        end: 12,
        status: 206,
        retriable: false,
      },
      "COPC range response Content-Range mismatch: expected bytes 10-11, received bytes 11-12.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects truncated range response bodies", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), {
      headers: {
        "Content-Range": "bytes 10-11/100",
      },
      status: 206,
    }));
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");

    await expectRangeRequestError(
      getter(10, 12),
      {
        code: "body-length-mismatch",
        begin: 10,
        end: 12,
        status: 206,
        retriable: true,
      },
      "COPC range response body length mismatch: expected 2 bytes, received 1.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a transient truncated range response body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), {
        headers: {
          "Content-Range": "bytes 10-11/100",
        },
        status: 206,
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), {
        headers: {
          "Content-Range": "bytes 10-11/100",
        },
        status: 206,
      }));
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");

    await expect(getter(10, 12)).resolves.toEqual(new Uint8Array([1, 2]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized range response bodies without accepting extra bytes", async () => {
    const fetchMock = vi.fn(async () => new Response(
      new Uint8Array([1, 2, 3]),
      { status: 206 },
    ));
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");

    await expectRangeRequestError(
      getter(10, 12),
      {
        code: "body-length-mismatch",
        begin: 10,
        end: 12,
        status: 206,
        retriable: true,
      },
      "COPC range response body length mismatch: expected 2 bytes, received 3.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reuses persistent fixed-block cache entries across getter instances", async () => {
    const cache = new MemoryPersistentRangeCache();
    const fetchMock = createRangeFetchMock(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const firstGetter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        validation: {
          mode: "application-version",
          sourceByteLength: 8,
          version: "v1",
        },
      },
    });
    const secondGetter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        validation: {
          mode: "application-version",
          sourceByteLength: 8,
          version: "v1",
        },
      },
    });

    await expect(firstGetter(1, 7)).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6]),
    );
    await expect(secondGetter(1, 7)).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6]),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/copc-samples/sample.copc.laz",
      expect.objectContaining({
        headers: {
          Range: "bytes=0-7",
        },
      }),
    );
  });

  it("uses strong ETag validation by default when persistent caching is enabled", async () => {
    const cache = new MemoryPersistentRangeCache();
    const fetchMock = createRangeFetchMock(
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const createGetter = () =>
      createHttpRangeGetter("/copc-samples/sample.copc.laz", {
        persistentRangeCache: { blockByteLength: 4, cache },
      });

    await expect(createGetter()(1, 3)).resolves.toEqual(
      new Uint8Array([1, 2]),
    );
    await expect(createGetter()(1, 3)).resolves.toEqual(
      new Uint8Array([1, 2]),
    );

    expect(fetchMock.mock.calls.map((call) => (
      (call[1] as RequestInit).headers as Record<string, string>
    ).Range)).toEqual(["bytes=0-0", "bytes=0-3", "bytes=0-0"]);
    expect(fetchMock.mock.calls.map((call) =>
      (call[1] as RequestInit).cache,
    )).toEqual(["reload", undefined, "reload"]);
  });

  it("rejects custom persistent caches without atomic source policy methods", () => {
    const incompleteCache = {
      get: async () => undefined,
      set: async () => undefined,
    };

    expect(() =>
      createHttpRangeGetter("https://example.test/sample.copc.laz", {
        persistentRangeCache: {
          cache: incompleteCache as never,
          validation: {
            mode: "application-version",
            sourceByteLength: 8,
            version: "v1",
          },
        },
      }),
    ).toThrow("persistentRangeCache.cache must implement isSourceDisabled()");
  });

  it("rejects persistent blocks above the configured underlying fetch maximum", () => {
    expect(() =>
      createHttpRangeGetter("https://example.test/sample.copc.laz", {
        persistentRangeCache: {
          blockByteLength: 8,
          maxUnderlyingFetchByteLength: 4,
        },
      }),
    ).toThrow(
      "persistentRangeCache.blockByteLength must not exceed the effective underlying fetch maximum of 4 bytes.",
    );
  });

  it("caps persistent underlying fetches to maxRangeByteLength at construction", () => {
    expect(() =>
      createHttpRangeGetter("https://example.test/sample.copc.laz", {
        maxRangeByteLength: 4,
        persistentRangeCache: {
          blockByteLength: 8,
          maxUnderlyingFetchByteLength: 16,
        },
      }),
    ).toThrow(
      "persistentRangeCache.blockByteLength must not exceed the effective underlying fetch maximum of 4 bytes.",
    );
  });

  it("caps persistent coalesced block fetches to maxRangeByteLength", async () => {
    const cache = new MemoryPersistentRangeCache();
    const fetchMock = createRangeFetchMock(
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      maxRangeByteLength: 6,
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        maxUnderlyingFetchByteLength: 8,
        validation: {
          mode: "application-version",
          sourceByteLength: 8,
          version: "v1",
        },
      },
    });

    await expect(getter(1, 7)).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6]),
    );

    expect(fetchMock.mock.calls.map((call) => (
      (call[1] as RequestInit).headers as Record<string, string>
    ).Range)).toEqual(["bytes=0-3", "bytes=4-7"]);
  });

  it("keeps maxRangeByteLength as a public read ceiling with persistence", async () => {
    const getter = createHttpRangeGetter("https://example.test/sample.copc.laz", {
      maxRangeByteLength: 6,
      persistentRangeCache: {
        blockByteLength: 4,
        validation: {
          mode: "application-version",
          sourceByteLength: 8,
          version: "v1",
        },
      },
    });

    await expect(getter(0, 8)).rejects.toThrow(
      "COPC byte range length 8 exceeds the configured maximum of 6 bytes.",
    );
  });

  it("uses 64 KiB persistent blocks by default and still coalesces misses", async () => {
    const cache = new MemoryPersistentRangeCache();
    const source = new Uint8Array(192 * 1024);
    source[1] = 7;
    source[(128 * 1024) - 2] = 8;
    const fetchMock = createRangeFetchMock(source);
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        cache,
        validation: {
          mode: "application-version",
          sourceByteLength: source.byteLength,
          version: "v1",
        },
      },
    });

    const bytes = await getter(1, (128 * 1024) - 1);

    expect(bytes[0]).toBe(7);
    expect(bytes[bytes.byteLength - 1]).toBe(8);
    expect(fetchMock.mock.calls.map((call) => (
      (call[1] as RequestInit).headers as Record<string, string>
    ).Range)).toEqual(["bytes=0-131071"]);
    expect(cache.keys).toHaveLength(2);
    expect(cache.keys.map((key) => key.replace(/^app:sha256:[0-9a-f]{64}:v1:196608:/, "")))
      .toEqual(["0:65536", "65536:131072"]);
  });

  it("uses a changed strong ETag as a new persistent cache namespace", async () => {
    const cache = new MemoryPersistentRangeCache();
    const source = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const fetchMock = createRangeFetchMock(source, () =>
      fetchMock.mock.calls.length <= 2 ? "\"v1\"" : "\"v2\"",
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const createGetter = () => createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        validation: { mode: "strong-etag" },
      },
    });

    await expect(createGetter()(2, 4)).resolves.toEqual(new Uint8Array([2, 3]));
    await expect(createGetter()(2, 4)).resolves.toEqual(new Uint8Array([2, 3]));

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map((call) => (
      (call[1] as RequestInit).headers as Record<string, string>
    ).Range)).toEqual([
      "bytes=0-0",
      "bytes=0-3",
      "bytes=0-0",
      "bytes=0-3",
    ]);
  });

  it("bypasses persistent caching when strong validator probing has no ETag", async () => {
    const cache = new MemoryPersistentRangeCache();
    const fetchMock = createRangeFetchMock(
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
      () => undefined,
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        validation: { mode: "strong-etag" },
      },
    });

    await expect(getter(2, 4)).resolves.toEqual(new Uint8Array([2, 3]));

    expect(fetchMock.mock.calls.map((call) => (
      (call[1] as RequestInit).headers as Record<string, string>
    ).Range)).toEqual(["bytes=0-0", "bytes=2-3"]);
    expect(cache.size).toBe(0);
  });

  it("falls back to HTTP and replaces corrupt persistent cache blocks", async () => {
    const cache = new MemoryPersistentRangeCache();
    cache.prime({
      begin: 0,
      end: 4,
      sourceKey: "app:sample-source:v1:8",
    }, new Uint8Array([99]));
    const fetchMock = createRangeFetchMock(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        sourceKey: "sample-source",
        validation: {
          mode: "application-version",
          sourceByteLength: 8,
          version: "v1",
        },
      },
    });

    await expect(getter(0, 3)).resolves.toEqual(new Uint8Array([0, 1, 2]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache.deletedKeys).toEqual([
      "app:sample-source:v1:8:0:4",
    ]);
  });

  it("deduplicates in-flight persistent block fetches for overlapping ranges", async () => {
    const cache = new MemoryPersistentRangeCache();
    const deferred = createDeferred<Response>();
    const fetchMock = vi.fn(async () => deferred.promise);
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        sourceKey: "dedupe-source",
        validation: {
          mode: "application-version",
          sourceByteLength: 8,
          version: "v1",
        },
      },
    });

    const first = getter(0, 2);
    await flushPromises();
    const second = getter(1, 3);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    deferred.resolve(new Response(new Uint8Array([0, 1, 2, 3]), {
      headers: {
        "Content-Range": "bytes 0-3/8",
      },
      status: 206,
    }));

    await expect(first).resolves.toEqual(new Uint8Array([0, 1]));
    await expect(second).resolves.toEqual(new Uint8Array([1, 2]));
  });

  it("rejects persistent strong-validator responses that change during block fetch", async () => {
    const cache = new MemoryPersistentRangeCache();
    let etagCallCount = 0;
    const fetchMock = createRangeFetchMock(
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
      () => {
        etagCallCount += 1;
        return etagCallCount === 1 ? "\"v1\"" : "\"v2\"";
      },
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        validation: { mode: "strong-etag" },
      },
    });

    await expect(getter(2, 4)).rejects.toThrow(
      "COPC persistent range validator changed during fetch.",
    );
    expect(cache.size).toBe(0);
  });

  it("retries persistent strong-validator probing after a transient rejection", async () => {
    const cache = new MemoryPersistentRangeCache();
    const rangeFetchMock = createRangeFetchMock(new Uint8Array([0, 1, 2, 3]));
    const fetchAfterFailure = rangeFetchMock as unknown as (
      url: string,
      init: RequestInit,
    ) => Promise<Response>;
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary probe failure"))
      .mockImplementation((url: string, init: RequestInit) =>
        fetchAfterFailure(url, init),
      );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        validation: { mode: "strong-etag" },
      },
    });

    await expect(getter(1, 2)).rejects.toThrow("temporary probe failure");
    await expect(getter(1, 2)).resolves.toEqual(new Uint8Array([1]));

    expect(fetchMock.mock.calls.map((call) => (
      (call[1] as RequestInit | undefined)?.headers as
        Record<string, string> | undefined
    )?.Range)).toEqual(["bytes=0-0", "bytes=0-0", "bytes=0-3"]);
  });

  it("does not persist application-version block responses with no-store and disables later persistence", async () => {
    const cache = new MemoryPersistentRangeCache();
    const source = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    let cacheControlCallCount = 0;
    const fetchMock = createRangeFetchMock(
      source,
      () => "\"v1\"",
      () => {
        cacheControlCallCount += 1;
        return cacheControlCallCount === 2
          ? "public, no-store, max-age=0"
          : "public, max-age=3600";
      },
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        validation: {
          mode: "application-version",
          sourceByteLength: 8,
          version: "v1",
        },
      },
    });

    await expect(getter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));
    await expect(getter(4, 6)).resolves.toEqual(new Uint8Array([4, 5]));
    await expect(getter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));

    expect(cache.size).toBe(0);
    expect(fetchMock.mock.calls.map((call) => (
      (call[1] as RequestInit).headers as Record<string, string>
    ).Range)).toEqual(["bytes=0-3", "bytes=4-7", "bytes=1-2"]);
    expect(cache.deletedKeys).toHaveLength(1);
    expect(cache.deletedKeys[0]).toMatch(
      /^app:sha256:[0-9a-f]{64}:v1:8:0:4$/,
    );
  });

  it("revokes an older live getter's memory cache through the shared source tombstone", async () => {
    const cache = new MemoryPersistentRangeCache();
    const source = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    let cacheControlCallCount = 0;
    const fetchMock = createRangeFetchMock(
      source,
      () => "\"v1\"",
      () => {
        cacheControlCallCount += 1;
        return cacheControlCallCount === 2 ? "no-store" : "public, max-age=3600";
      },
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);
    const createGetter = () =>
      createHttpRangeGetter("/copc-samples/sample.copc.laz", {
        persistentRangeCache: {
          blockByteLength: 4,
          cache,
          sourceKey: "sample-source",
          validation: {
            mode: "application-version",
            sourceByteLength: 8,
            version: "v1",
          },
        },
      });
    const olderGetter = createGetter();
    const policyChangingGetter = createGetter();

    await expect(olderGetter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));
    await expect(policyChangingGetter(4, 6)).resolves.toEqual(
      new Uint8Array([4, 5]),
    );
    await expect(olderGetter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));

    expect(fetchMock.mock.calls.map((call) => (
      (call[1] as RequestInit).headers as Record<string, string>
    ).Range)).toEqual(["bytes=0-3", "bytes=4-7", "bytes=1-2"]);
  });

  it("keeps an older strong getter revoked after a fresh ETag re-enables the source", async () => {
    const cache = new MemoryPersistentRangeCache();
    const v1 = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const v2 = new Uint8Array([0, 9, 8, 7, 6, 5, 4, 3]);
    let responsePolicy: "v1" | "no-store" | "v2" = "v1";
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const range = (init.headers as Record<string, string>).Range;
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);

      if (!match) {
        throw new Error(`Unexpected range header: ${range}`);
      }

      const begin = Number(match[1]);
      const inclusiveEnd = Number(match[2]);
      const currentPolicy = responsePolicy;
      const source = currentPolicy === "v2" ? v2 : v1;

      if (currentPolicy === "no-store") {
        responsePolicy = "v1";
      }

      return new Response(source.slice(begin, inclusiveEnd + 1), {
        headers: {
          "Cache-Control": currentPolicy === "no-store"
            ? "no-store"
            : "public, max-age=3600",
          "Content-Range": `bytes ${begin}-${inclusiveEnd}/${source.byteLength}`,
          ETag: currentPolicy === "v2" ? '"v2"' : '"v1"',
        },
        status: 206,
      });
    });
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);
    const createGetter = () =>
      createHttpRangeGetter("/copc-samples/sample.copc.laz", {
        persistentRangeCache: {
          blockByteLength: 4,
          cache,
          sourceKey: "strong-reenable-source",
          validation: { mode: "strong-etag" },
        },
      });
    const olderGetter = createGetter();
    const policyChangingGetter = createGetter();

    await expect(olderGetter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));
    responsePolicy = "no-store";
    await expect(policyChangingGetter(4, 6)).resolves.toEqual(
      new Uint8Array([4, 5]),
    );

    responsePolicy = "v2";
    await expect(createGetter()(1, 3)).resolves.toEqual(new Uint8Array([9, 8]));
    await expect(olderGetter(1, 3)).resolves.toEqual(new Uint8Array([9, 8]));

    expect(fetchMock.mock.calls.map((call) => (
      (call[1] as RequestInit).headers as Record<string, string>
    ).Range)).toEqual([
      "bytes=0-0",
      "bytes=0-3",
      "bytes=0-0",
      "bytes=4-5",
      "bytes=0-0",
      "bytes=0-3",
      "bytes=1-2",
    ]);
    expect(cache.keys).toEqual([
      'etag:strong-reenable-source:"v2":8:0:4',
    ]);
  });

  it("does not let an older in-flight strong probe clear a newer no-store tombstone", async () => {
    class TrackingPolicyCache extends MemoryPersistentRangeCache {
      enableCallCount = 0;

      override async enableSource(sourceKey: string): Promise<void> {
        this.enableCallCount += 1;
        await super.enableSource(sourceKey);
      }
    }

    const cache = new TrackingPolicyCache();
    const delayedProbe = createDeferred<Response>();
    const v2 = new Uint8Array([0, 9, 8, 7, 6, 5, 4, 3]);
    let requestCount = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      requestCount += 1;

      if (requestCount === 1) {
        return delayedProbe.promise;
      }

      const range = (init.headers as Record<string, string>).Range;
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);

      if (!match) {
        throw new Error(`Unexpected range header: ${range}`);
      }

      const begin = Number(match[1]);
      const inclusiveEnd = Number(match[2]);

      return new Response(v2.slice(begin, inclusiveEnd + 1), {
        headers: {
          "Cache-Control": requestCount === 2
            ? "no-store"
            : "public, max-age=3600",
          "Content-Range": `bytes ${begin}-${inclusiveEnd}/${v2.byteLength}`,
          ETag: '"v2"',
        },
        status: 206,
      });
    });
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);
    const createGetter = () =>
      createHttpRangeGetter("/copc-samples/sample.copc.laz", {
        persistentRangeCache: {
          blockByteLength: 4,
          cache,
          sourceKey: "strong-probe-race-source",
          validation: { mode: "strong-etag" },
        },
      });
    const olderProbeRead = createGetter()(1, 3);

    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(createGetter()(4, 6)).resolves.toEqual(new Uint8Array([6, 5]));
    await expect(cache.isSourceDisabled("strong-probe-race-source"))
      .resolves.toBe(true);

    delayedProbe.resolve(new Response(new Uint8Array([0]), {
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Content-Range": "bytes 0-0/8",
        ETag: '"v1"',
      },
      status: 206,
    }));

    await expect(olderProbeRead).resolves.toEqual(new Uint8Array([9, 8]));
    await expect(cache.isSourceDisabled("strong-probe-race-source"))
      .resolves.toBe(true);
    expect(cache.enableCallCount).toBe(0);
    expect(fetchMock.mock.calls.map((call) => (
      (call[1] as RequestInit).headers as Record<string, string>
    ).Range)).toEqual([
      "bytes=0-0",
      "bytes=0-0",
      "bytes=4-5",
      "bytes=1-2",
    ]);
  });

  it("queues no-store purge after an in-progress re-enable as the final policy writer", async () => {
    const enableStarted = createDeferred<void>();
    const releaseEnable = createDeferred<void>();
    const policyEvents: string[] = [];

    class DelayedEnableCache extends MemoryPersistentRangeCache {
      override async enableSource(sourceKey: string): Promise<void> {
        policyEvents.push("enable:start");
        enableStarted.resolve(undefined);
        await releaseEnable.promise;
        await super.enableSource(sourceKey);
        policyEvents.push("enable:finish");
      }

      override async disableSource(sourceKey: string): Promise<void> {
        policyEvents.push("disable");
        await super.disableSource(sourceKey);
      }
    }

    const cache = new DelayedEnableCache();
    const v2 = new Uint8Array([0, 9, 8, 7, 6, 5, 4, 3]);
    let requestCount = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      requestCount += 1;
      const range = (init.headers as Record<string, string>).Range;
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);

      if (!match) {
        throw new Error(`Unexpected range header: ${range}`);
      }

      const begin = Number(match[1]);
      const inclusiveEnd = Number(match[2]);

      return new Response(v2.slice(begin, inclusiveEnd + 1), {
        headers: {
          "Cache-Control": requestCount === 2
            ? "no-store"
            : "public, max-age=3600",
          "Content-Range": `bytes ${begin}-${inclusiveEnd}/${v2.byteLength}`,
          ETag: requestCount === 1 ? '"v1"' : '"v2"',
        },
        status: 206,
      });
    });
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);
    const createGetter = () =>
      createHttpRangeGetter("/copc-samples/sample.copc.laz", {
        persistentRangeCache: {
          blockByteLength: 4,
          cache,
          sourceKey: "strong-enable-revoke-race-source",
          validation: { mode: "strong-etag" },
        },
      });
    const enablingRead = createGetter()(1, 3);

    await enableStarted.promise;
    const revokingRead = createGetter()(4, 6);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(policyEvents).toEqual(["enable:start"]);
    releaseEnable.resolve(undefined);

    await expect(enablingRead).resolves.toEqual(new Uint8Array([9, 8]));
    await expect(revokingRead).resolves.toEqual(new Uint8Array([6, 5]));
    expect(policyEvents).toEqual(["enable:start", "enable:finish", "disable"]);
    await expect(cache.isSourceDisabled("strong-enable-revoke-race-source"))
      .resolves.toBe(true);
    expect(cache.size).toBe(0);
    expect(fetchMock.mock.calls.map((call) => (
      (call[1] as RequestInit).headers as Record<string, string>
    ).Range)).toEqual(expect.arrayContaining([
      "bytes=0-0",
      "bytes=1-2",
      "bytes=4-5",
    ]));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not persist strong-validator block responses with no-store and disables later persistence", async () => {
    const cache = new MemoryPersistentRangeCache();
    const source = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    let cacheControlCallCount = 0;
    const fetchMock = createRangeFetchMock(
      source,
      () => "\"v1\"",
      () => {
        cacheControlCallCount += 1;
        return cacheControlCallCount === 2
          ? "no-store"
          : "public, max-age=3600";
      },
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        validation: { mode: "strong-etag" },
      },
    });

    await expect(getter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));
    await expect(getter(4, 6)).resolves.toEqual(new Uint8Array([4, 5]));
    await expect(getter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));

    expect(cache.size).toBe(0);
    expect(fetchMock.mock.calls.map((call) => (
      (call[1] as RequestInit).headers as Record<string, string>
    ).Range)).toEqual([
      "bytes=0-0",
      "bytes=0-3",
      "bytes=4-5",
      "bytes=1-2",
    ]);
  });

  it("applies no-store before rejecting a changed block validator", async () => {
    const cache = new MemoryPersistentRangeCache();
    cache.prime(
      {
        sourceIdentityKey: "sample-source",
        sourceKey: 'etag:sample-source:"v1":8',
        begin: 0,
        end: 4,
      },
      new Uint8Array([0, 1, 2, 3]),
    );
    let responseCount = 0;
    const fetchMock = createRangeFetchMock(
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
      () => {
        responseCount += 1;
        return responseCount === 1 ? "\"v1\"" : "\"v2\"";
      },
      () => responseCount === 0 ? "public, max-age=3600" : "no-store",
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        sourceKey: "sample-source",
        validation: { mode: "strong-etag" },
      },
    });

    await expect(getter(4, 6)).rejects.toThrow(
      "COPC persistent range validator changed during fetch.",
    );
    await expect(cache.isSourceDisabled("sample-source")).resolves.toBe(true);
    expect(cache.size).toBe(0);
  });

  it("applies no-store before rejecting malformed Range response metadata", async () => {
    const cache = new MemoryPersistentRangeCache();
    cache.prime(
      {
        sourceIdentityKey: "sample-source",
        sourceKey: "app:sample-source:v1:8",
        begin: 4,
        end: 8,
      },
      new Uint8Array([4, 5, 6, 7]),
    );
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([0, 1, 2, 3]), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Range": "bytes 1-4/8",
        },
        status: 206,
      }),
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        sourceKey: "sample-source",
        validation: {
          mode: "application-version",
          sourceByteLength: 8,
          version: "v1",
        },
      },
    });

    await expect(getter(0, 2)).rejects.toThrow("Content-Range");
    await expect(cache.isSourceDisabled("sample-source")).resolves.toBe(true);
    expect(cache.size).toBe(0);
  });

  it("does not retry a custom-cache source revocation failure", async () => {
    class FailingRevocationCache extends MemoryPersistentRangeCache {
      override async disableSource(): Promise<void> {
        throw new TypeError("source purge failed");
      }
    }

    const cache = new FailingRevocationCache();
    const fetchMock = createRangeFetchMock(
      new Uint8Array([0, 1, 2, 3]),
      () => "\"v1\"",
      () => "no-store",
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const createGetter = () =>
      createHttpRangeGetter("/copc-samples/sample.copc.laz", {
        persistentRangeCache: {
          blockByteLength: 4,
          cache,
          sourceKey: "failing-revocation-source",
          validation: {
            mode: "application-version",
            sourceByteLength: 4,
            version: "v1",
          },
        },
      });
    const getter = createGetter();

    await expect(getter(1, 3)).rejects.toThrow("source purge failed");
    await expect(getter(1, 3)).rejects.toThrow("source purge failed");
    await expect(createGetter()(1, 3)).rejects.toThrow("source purge failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed strong-probe purge fail-closed for live and new getters", async () => {
    class FailingStrongRevocationCache extends MemoryPersistentRangeCache {
      override async disableSource(): Promise<void> {
        throw new TypeError("strong source purge failed");
      }
    }

    const cache = new FailingStrongRevocationCache();
    let responseCount = 0;
    const fetchMock = createRangeFetchMock(
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
      () => '"v1"',
      () => {
        responseCount += 1;
        return responseCount === 3 ? "no-store" : "public, max-age=3600";
      },
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);
    const createGetter = () =>
      createHttpRangeGetter("/copc-samples/sample.copc.laz", {
        persistentRangeCache: {
          blockByteLength: 4,
          cache,
          sourceKey: "failing-strong-revocation-source",
          validation: { mode: "strong-etag" },
        },
      });
    const olderGetter = createGetter();
    const policyChangingGetter = createGetter();

    await expect(olderGetter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));
    await expect(policyChangingGetter(4, 6)).rejects.toThrow(
      "strong source purge failed",
    );
    await expect(policyChangingGetter(4, 6)).rejects.toThrow(
      "strong source purge failed",
    );
    await expect(olderGetter(1, 3)).rejects.toThrow(
      "strong source purge failed",
    );
    await expect(createGetter()(1, 3)).rejects.toThrow(
      "strong source purge failed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("revokes an older live memory hit when source purge fails", async () => {
    class FailingRevocationCache extends MemoryPersistentRangeCache {
      override async disableSource(): Promise<void> {
        throw new TypeError("shared source purge failed");
      }
    }

    const cache = new FailingRevocationCache();
    let responseCount = 0;
    const fetchMock = createRangeFetchMock(
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
      () => "\"v1\"",
      () => {
        responseCount += 1;
        return responseCount === 2 ? "no-store" : "public, max-age=3600";
      },
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);
    const createGetter = () =>
      createHttpRangeGetter("/copc-samples/sample.copc.laz", {
        persistentRangeCache: {
          blockByteLength: 4,
          cache,
          sourceKey: "failing-live-revocation-source",
          validation: {
            mode: "application-version",
            sourceByteLength: 8,
            version: "v1",
          },
        },
      });
    const olderGetter = createGetter();
    const policyChangingGetter = createGetter();

    await expect(olderGetter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));
    await expect(policyChangingGetter(4, 6)).rejects.toThrow(
      "shared source purge failed",
    );
    await expect(olderGetter(1, 3)).rejects.toThrow(
      "shared source purge failed",
    );
    await expect(createGetter()(1, 3)).rejects.toThrow(
      "shared source purge failed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("purges untouched application-version blocks and keeps no-store disabled across getters", async () => {
    const cache = new MemoryPersistentRangeCache();
    cache.prime(
      {
        sourceIdentityKey: "sample-source",
        sourceKey: "app:sample-source:v1:8",
        begin: 0,
        end: 4,
      },
      new Uint8Array([0, 1, 2, 3]),
    );
    const source = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const fetchMock = createRangeFetchMock(
      source,
      () => "\"v1\"",
      () => "no-store",
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const createGetter = () =>
      createHttpRangeGetter("/copc-samples/sample.copc.laz", {
        persistentRangeCache: {
          blockByteLength: 4,
          cache,
          sourceKey: "sample-source",
          validation: {
            mode: "application-version",
            sourceByteLength: 8,
            version: "v1",
          },
        },
      });

    await expect(createGetter()(4, 6)).resolves.toEqual(
      new Uint8Array([4, 5]),
    );
    await expect(createGetter()(0, 2)).resolves.toEqual(
      new Uint8Array([0, 1]),
    );

    expect(cache.size).toBe(0);
    await expect(
      cache.isSourceDisabled("sample-source"),
    ).resolves.toBe(true);
    expect(fetchMock.mock.calls.map((call) => (
      (call[1] as RequestInit).headers as Record<string, string>
    ).Range)).toEqual(["bytes=4-7", "bytes=0-1"]);
  });

  it("purges a strong-ETag namespace when its validation probe says no-store", async () => {
    const cache = new MemoryPersistentRangeCache();
    const namespace = 'etag:sample-source:"v1":8';
    cache.prime(
      {
        sourceIdentityKey: "sample-source",
        sourceKey: namespace,
        begin: 0,
        end: 4,
      },
      new Uint8Array([0, 1, 2, 3]),
    );
    const fetchMock = createRangeFetchMock(
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
      () => "\"v1\"",
      () => "no-store",
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        sourceKey: "sample-source",
        validation: { mode: "strong-etag" },
      },
    });

    await expect(getter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));

    expect(cache.size).toBe(0);
    await expect(cache.isSourceDisabled("sample-source")).resolves.toBe(true);
    expect(fetchMock.mock.calls.map((call) => (
      (call[1] as RequestInit).headers as Record<string, string>
    ).Range)).toEqual(["bytes=0-0", "bytes=1-2"]);
  });

  it("keeps a strong probe disabled after a retried no-store response", async () => {
    const cache = new MemoryPersistentRangeCache();
    const source = new Uint8Array([0, 1, 2, 3]);
    let callCount = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      callCount += 1;

      if (callCount === 1) {
        return new Response(undefined, {
          headers: { "Cache-Control": "no-store" },
          status: 503,
        });
      }

      const range = (init.headers as Record<string, string>).Range;
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);

      if (!match) {
        throw new Error(`Unexpected range header: ${range}`);
      }

      const begin = Number(match[1]);
      const inclusiveEnd = Number(match[2]);
      return new Response(source.slice(begin, inclusiveEnd + 1), {
        headers: {
          "Cache-Control": "public, max-age=3600",
          "Content-Range": `bytes ${begin}-${inclusiveEnd}/${source.byteLength}`,
          ETag: "\"v1\"",
        },
        status: 206,
      });
    });
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        sourceKey: "sample-source",
        validation: { mode: "strong-etag" },
      },
    });

    await expect(getter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));
    await expect(cache.isSourceDisabled("sample-source")).resolves.toBe(true);
    expect(cache.size).toBe(0);
    expect(fetchMock.mock.calls.map((call) => (
      (call[1] as RequestInit).headers as Record<string, string>
    ).Range)).toEqual(["bytes=0-0", "bytes=0-0", "bytes=1-2"]);
  });

  it("source-scopes a no-store probe without clearing unrelated cache policy", async () => {
    const cache = new MemoryPersistentRangeCache();
    cache.prime(
      {
        sourceIdentityKey: "sample-source",
        sourceKey: 'etag:sample-source:"old":8',
        begin: 0,
        end: 4,
      },
      new Uint8Array([9, 9, 9, 9]),
    );
    cache.prime(
      {
        sourceIdentityKey: "other-source",
        sourceKey: "app:other-source:v1:8",
        begin: 0,
        end: 4,
      },
      new Uint8Array([4, 3, 2, 1]),
    );
    await cache.disableSource("protected-source");
    const fetchMock = createRangeFetchMock(
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
      () => undefined,
      () => "no-store",
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        sourceKey: "sample-source",
        validation: { mode: "strong-etag" },
      },
    });

    await expect(getter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));

    await expect(cache.isSourceDisabled("sample-source")).resolves.toBe(true);
    await expect(cache.isSourceDisabled("protected-source")).resolves.toBe(true);
    expect(cache.keys).toEqual(["app:other-source:v1:8:0:4"]);
  });

  it("uses an opaque source identity for default persistent cache keys", async () => {
    const cache = new MemoryPersistentRangeCache();
    const fetchMock = createRangeFetchMock(new Uint8Array([0, 1, 2, 3]));
    vi.stubGlobal("location", {
      href: "http://localhost:3000/viewer/?session=page-token",
    });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter(
      "/copc-samples/sample.copc.laz?token=secret-token",
      {
        persistentRangeCache: {
          blockByteLength: 4,
          cache,
          validation: {
            mode: "application-version",
            sourceByteLength: 4,
            version: "v1",
          },
        },
      },
    );

    await expect(getter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));

    expect(cache.keys).toHaveLength(1);
    expect(cache.keys[0]).toMatch(/^app:sha256:[0-9a-f]{64}:v1:4:0:4$/);
    expect(cache.keys[0]).not.toContain("sample.copc.laz");
    expect(cache.keys[0]).not.toContain("secret-token");
    expect(cache.keys[0]).not.toContain("page-token");
  });

  it("normalizes URL fragments out of the default persistent source identity", async () => {
    const cache = new MemoryPersistentRangeCache();
    const fetchMock = createRangeFetchMock(new Uint8Array([0, 1, 2, 3]));
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);
    const createGetter = (fragment: string) =>
      createHttpRangeGetter(
        `/copc-samples/sample.copc.laz#${fragment}`,
        {
          persistentRangeCache: {
            blockByteLength: 4,
            cache,
            validation: {
              mode: "application-version",
              sourceByteLength: 4,
              version: "v1",
            },
          },
        },
      );

    await expect(createGetter("first")(1, 3)).resolves.toEqual(
      new Uint8Array([1, 2]),
    );
    await expect(createGetter("second")(1, 3)).resolves.toEqual(
      new Uint8Array([1, 2]),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache.keys).toHaveLength(1);
  });

  it("fails closed when Web Crypto cannot create the default source identity", async () => {
    const cache = new MemoryPersistentRangeCache();
    const fetchMock = createRangeFetchMock(new Uint8Array([0, 1, 2, 3]));
    vi.stubGlobal("crypto", {});
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        validation: {
          mode: "application-version",
          sourceByteLength: 4,
          version: "v1",
        },
      },
    });

    await expect(getter(1, 3)).rejects.toThrow(
      "Persistent range caching requires Web Crypto",
    );

    expect(cache.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains the bounded memory cache when strong validation must bypass persistence", async () => {
    const cache = new MemoryPersistentRangeCache();
    const fetchMock = createRangeFetchMock(
      new Uint8Array([0, 1, 2, 3]),
      () => undefined,
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        validation: { mode: "strong-etag" },
      },
    });

    await expect(getter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));
    await expect(getter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));
    expect(fetchMock.mock.calls.map((call) => (
      (call[1] as RequestInit).headers as Record<string, string>
    ).Range)).toEqual(["bytes=0-0", "bytes=1-2"]);
  });

  it("honors the memory-cache opt-out when persistence must bypass", async () => {
    const cache = new MemoryPersistentRangeCache();
    const fetchMock = createRangeFetchMock(
      new Uint8Array([0, 1, 2, 3]),
      () => undefined,
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      maxCachedRangeCount: 0,
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        validation: { mode: "strong-etag" },
      },
    });

    await expect(getter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));
    await expect(getter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));
    expect(fetchMock.mock.calls.map((call) => (
      (call[1] as RequestInit).headers as Record<string, string>
    ).Range)).toEqual(["bytes=0-0", "bytes=1-2", "bytes=1-2"]);
  });

  it("fails closed when the default source identity digest rejects", async () => {
    const cache = new MemoryPersistentRangeCache();
    const fetchMock = createRangeFetchMock(new Uint8Array([0, 1, 2, 3]));
    vi.stubGlobal("crypto", {
      subtle: {
        digest: vi.fn().mockRejectedValue(new Error("digest unavailable")),
      },
    });
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz", {
      persistentRangeCache: {
        blockByteLength: 4,
        cache,
        validation: {
          mode: "application-version",
          sourceByteLength: 4,
          version: "v1",
        },
      },
    });

    await expect(getter(1, 3)).rejects.toThrow(
      "Persistent range caching requires Web Crypto",
    );

    expect(cache.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

interface ExpectedCopcRangeRequestError {
  readonly code: CopcRangeRequestErrorCode;
  readonly begin: number;
  readonly end: number;
  readonly status?: number;
  readonly retriable: boolean;
}

async function expectRangeRequestError(
  promise: Promise<unknown>,
  expected: ExpectedCopcRangeRequestError,
  message: string,
): Promise<CopcRangeRequestError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CopcRangeRequestError);

    const rangeError = error as CopcRangeRequestError;
    expect(rangeError.name).toBe("CopcRangeRequestError");
    expect(rangeError.message).toBe(message);
    expect(rangeError.code).toBe(expected.code);
    expect(rangeError.begin).toBe(expected.begin);
    expect(rangeError.end).toBe(expected.end);
    expect(rangeError.status).toBe(expected.status);
    expect(rangeError.retriable).toBe(expected.retriable);
    return rangeError;
  }

  throw new Error("Expected the COPC range request to reject.");
}

interface PersistentCacheKey {
  readonly sourceIdentityKey?: string;
  readonly sourceKey: string;
  readonly begin: number;
  readonly end: number;
}

class MemoryPersistentRangeCache {
  readonly deletedKeys: string[] = [];
  private readonly entries = new Map<string, Uint8Array>();
  private readonly entrySourceIdentities = new Map<string, string>();
  private readonly disabledSources = new Set<string>();

  get size(): number {
    return this.entries.size;
  }

  get keys(): string[] {
    return [...this.entries.keys()];
  }

  prime(key: PersistentCacheKey, bytes: Uint8Array): void {
    const cacheKey = this.key(key);
    this.entries.set(cacheKey, bytes.slice());
    this.entrySourceIdentities.set(cacheKey, this.sourceIdentity(key));
  }

  async get(key: PersistentCacheKey): Promise<Uint8Array | undefined> {
    return this.entries.get(this.key(key))?.slice();
  }

  async set(key: PersistentCacheKey, bytes: Uint8Array): Promise<void> {
    const sourceIdentity = this.sourceIdentity(key);

    if (this.disabledSources.has(sourceIdentity)) {
      return;
    }

    const cacheKey = this.key(key);
    this.entries.set(cacheKey, bytes.slice());
    this.entrySourceIdentities.set(cacheKey, sourceIdentity);
  }

  async delete(key: PersistentCacheKey): Promise<void> {
    const cacheKey = this.key(key);
    this.deletedKeys.push(cacheKey);
    this.entries.delete(cacheKey);
    this.entrySourceIdentities.delete(cacheKey);
  }

  async isSourceDisabled(sourceKey: string): Promise<boolean> {
    return this.disabledSources.has(sourceKey);
  }

  async disableSource(sourceKey: string): Promise<void> {
    this.disabledSources.add(sourceKey);

    for (const key of [...this.entries.keys()]) {
      if (this.entrySourceIdentities.get(key) === sourceKey) {
        this.deletedKeys.push(key);
        this.entries.delete(key);
        this.entrySourceIdentities.delete(key);
      }
    }
  }

  async enableSource(sourceKey: string): Promise<void> {
    this.disabledSources.delete(sourceKey);
  }

  async clear(): Promise<void> {
    this.entries.clear();
    this.entrySourceIdentities.clear();
    this.disabledSources.clear();
  }

  private key(key: PersistentCacheKey): string {
    return `${key.sourceKey}:${key.begin}:${key.end}`;
  }

  private sourceIdentity(key: PersistentCacheKey): string {
    return key.sourceIdentityKey ?? key.sourceKey;
  }
}

function createRangeFetchMock(
  source: Uint8Array,
  etag: () => string | undefined = () => "\"v1\"",
  cacheControl: () => string | undefined = () => "public, max-age=3600",
): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const range = ((init.headers as Record<string, string>).Range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);

    if (!match) {
      throw new Error(`Unexpected range header: ${range}`);
    }

    const begin = Number(match[1]);
    const inclusiveEnd = Number(match[2]);
    const headers: Record<string, string> = {
      "Content-Range": `bytes ${begin}-${inclusiveEnd}/${source.byteLength}`,
    };
    const currentCacheControl = cacheControl();
    const currentEtag = etag();

    if (currentCacheControl) {
      headers["Cache-Control"] = currentCacheControl;
    }

    if (currentEtag) {
      headers.ETag = currentEtag;
    }

    return new Response(source.slice(begin, inclusiveEnd + 1), {
      headers,
      status: 206,
    });
  });
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
