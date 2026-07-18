import { describe, expect, it } from "vitest";
import { createCopcEdgeRangeCache } from "./copc-edge-range-cache.mjs";

const originUrl = "https://copc.example/data/millsite.copc.laz";

describe("COPC edge range cache", () => {
  it("blocks non-allowlisted paths and refuses non-HTTPS route origins", async () => {
    const cache = createCache();
    const response = await cache.handle(request("https://edge.example/proxy/other", "bytes=0-9"));

    expect(response.status).toBe(404);
    expect((await cache.handle(request("https://edge.example/copc?url=https://evil.example", "bytes=0-9"))).status).toBe(404);
    expect((await cache.handle(new Request("https://edge.example/other", { method: "OPTIONS" }))).status).toBe(404);
    expect(() =>
      createCopcEdgeRangeCache({
        routes: { "/copc": "http://metadata.google.internal/latest" },
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      createCopcEdgeRangeCache({
        routes: { "/copc": "https://example.test/data?target=other" },
      }),
    ).toThrow(/query strings/);
  });

  it("returns the exact 206 slice and range headers", async () => {
    const fetchLog = [];
    const cache = createCache({ fetchImpl: createMockFetch({ fetchLog }) });

    const response = await cache.handle(request("https://edge.example/copc", "bytes=10-19"));
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(206);
    expect([...bytes]).toEqual([...sourceBytes.slice(10, 20)]);
    expect(response.headers.get("content-range")).toBe(`bytes 10-19/${sourceBytes.byteLength}`);
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("etag")).toBe('"v1"');
    expect(response.headers.get("access-control-expose-headers")).toContain("Content-Range");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    expect(fetchLog).toEqual([{ method: "GET", range: "bytes=0-31" }]);
  });

  it("shares cached blocks across overlapping downstream ranges", async () => {
    const fetchLog = [];
    const cache = createCache({ fetchImpl: createMockFetch({ fetchLog }) });

    await cache.handle(request("https://edge.example/copc", "bytes=4-13"));
    const response = await cache.handle(request("https://edge.example/copc", "bytes=8-15"));

    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...sourceBytes.slice(8, 16)]);
    expect(fetchLog).toEqual([{ method: "GET", range: "bytes=0-15" }]);
    expect(cache.getStats().blockHits).toBeGreaterThan(0);
  });

  it("coalesces consecutive missing blocks up to the configured origin span", async () => {
    const fetchLog = [];
    const cache = createCache({
      blockByteLength: 8,
      maxOriginSpanBytes: 16,
      fetchImpl: createMockFetch({ fetchLog }),
    });

    await cache.handle(request("https://edge.example/copc", "bytes=0-23"));

    expect(fetchLog).toEqual([
      { method: "GET", range: "bytes=0-15" },
      { method: "GET", range: "bytes=16-23" },
    ]);
    expect(() => createCache({
      blockByteLength: 16,
      maxOriginSpanBytes: 8,
    })).toThrow(/must not exceed/);
  });

  it("rejects invalid methods and malformed ranges without origin fetch", async () => {
    const fetchLog = [];
    const cache = createCache({ fetchImpl: createMockFetch({ fetchLog }) });

    expect((await cache.handle(new Request("https://edge.example/copc", { method: "POST" }))).status).toBe(405);
    expect((await cache.handle(request("https://edge.example/copc", "bytes=10-"))).status).toBe(416);
    expect((await cache.handle(request("https://edge.example/copc", "bytes=-10"))).status).toBe(416);
    expect((await cache.handle(request("https://edge.example/copc", "bytes=0-1,4-5"))).status).toBe(416);
    expect((await cache.handle(new Request("https://edge.example/copc", { method: "OPTIONS" }))).status).toBe(204);
    expect(fetchLog).toEqual([]);
  });

  it("bounds downstream range allocation and origin span concurrency", async () => {
    const fetchLog = [];
    let active = 0;
    let peakActive = 0;
    const cache = createCache({
      blockByteLength: 8,
      maxOriginSpanBytes: 8,
      maxDownstreamRangeBytes: 32,
      maxDownstreamBlockCount: 4,
      maxConcurrentOriginSpans: 2,
      fetchImpl: createMockFetch({
        fetchLog,
        beforeResponse: async () => {
          active += 1;
          peakActive = Math.max(peakActive, active);
          await Promise.resolve();
          active -= 1;
        },
      }),
    });

    expect((await cache.handle(request("https://edge.example/copc", "bytes=0-32"))).status).toBe(416);
    expect(fetchLog).toEqual([]);

    const response = await cache.handle(request("https://edge.example/copc", "bytes=0-31"));
    expect(response.status).toBe(206);
    expect(fetchLog).toHaveLength(4);
    expect(peakActive).toBeLessThanOrEqual(2);
  });

  it("purges source blocks and retries when origin validator changes", async () => {
    const fetchLog = [];
    let etag = '"v1"';
    const cache = createCache({ fetchImpl: createMockFetch({ fetchLog, getEtag: () => etag }) });

    await cache.handle(request("https://edge.example/copc", "bytes=0-15"));
    etag = '"v2"';
    const response = await cache.handle(request("https://edge.example/copc", "bytes=16-31"));

    expect(response.status).toBe(206);
    expect(fetchLog).toEqual([
      { method: "GET", range: "bytes=0-15" },
      { method: "GET", range: "bytes=16-31" },
      { method: "GET", range: "bytes=16-31" },
    ]);
    expect(cache.getStats().purges).toBe(1);
    expect(cache.getStats().cachedBlockCount).toBe(1);
  });

  it("retries the whole downstream read instead of mixing cached origin versions", async () => {
    let version = 1;
    const fetchImpl = async (_url, init = {}) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
      const start = Number.parseInt(match[1], 10);
      const end = Math.min(Number.parseInt(match[2], 10), sourceBytes.byteLength - 1);
      const bytes = new Uint8Array(end - start + 1).fill(version);
      return new Response(bytes, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${sourceBytes.byteLength}`,
          "Content-Length": String(bytes.byteLength),
          ETag: `"v${version}"`,
        },
      });
    };
    const cache = createCache({ fetchImpl });

    await cache.handle(request("https://edge.example/copc", "bytes=0-15"));
    version = 2;
    const response = await cache.handle(request("https://edge.example/copc", "bytes=0-31"));
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(206);
    expect(response.headers.get("etag")).toBe('"v2"');
    expect([...new Set(bytes)]).toEqual([2]);
  });

  it("validates stale source metadata with HEAD without refetching cached blocks", async () => {
    const fetchLog = [];
    let clock = 0;
    const cache = createCache({
      validationTtlMilliseconds: 5,
      now: () => clock,
      fetchImpl: createMockFetch({ fetchLog }),
    });

    await cache.handle(request("https://edge.example/copc", "bytes=0-7"));
    clock = 10;
    await cache.handle(request("https://edge.example/copc", "bytes=8-15"));

    expect(fetchLog).toEqual([
      { method: "GET", range: "bytes=0-15" },
      { method: "HEAD" },
    ]);
    expect(cache.getStats().validationRequests).toBe(1);
  });

  it("bounds cache size with LRU eviction", async () => {
    const cache = createCache({
      blockByteLength: 8,
      maxCachedBlockCount: 2,
      fetchImpl: createMockFetch(),
    });

    await cache.handle(request("https://edge.example/copc", "bytes=0-7"));
    await cache.handle(request("https://edge.example/copc", "bytes=8-15"));
    await cache.handle(request("https://edge.example/copc", "bytes=16-23"));

    expect(cache.getStats().cachedBlockCount).toBe(2);
    expect(cache.getStats().evictions).toBe(1);
  });

  it("deduplicates concurrent in-flight block fetches", async () => {
    const fetchLog = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const cache = createCache({
      fetchImpl: createMockFetch({
        fetchLog,
        beforeResponse: () => gate,
      }),
    });

    const first = cache.handle(request("https://edge.example/copc", "bytes=0-7"));
    const second = cache.handle(request("https://edge.example/copc", "bytes=4-15"));
    release();
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status)).toEqual([206, 206]);
    expect(fetchLog).toEqual([{ method: "GET", range: "bytes=0-15" }]);
    expect(cache.getStats().originRequests).toBe(1);
  });

  it("does not let an in-flight response repopulate a cleared cache", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const fetchLog = [];
    const cache = createCache({
      fetchImpl: createMockFetch({
        fetchLog,
        beforeResponse: () => gate,
      }),
    });

    const pending = cache.handle(
      request("https://edge.example/copc", "bytes=0-15"),
    );
    await waitFor(() => fetchLog.length === 1);
    cache.clear();
    release();

    expect((await pending).status).toBe(502);
    expect(cache.getStats().cachedBlockCount).toBe(0);
    expect(cache.getStats().inflightBlockCount).toBe(0);

    const next = await cache.handle(
      request("https://edge.example/copc", "bytes=0-15"),
    );
    expect(next.status).toBe(206);
    expect(cache.getStats().cachedBlockCount).toBe(1);
  });
});

const sourceBytes = Uint8Array.from({ length: 96 }, (_, index) => index);

function createCache(overrides = {}) {
  return createCopcEdgeRangeCache({
    routes: { "/copc": originUrl },
    blockByteLength: 16,
    maxCachedBlockCount: 64,
    maxCachedBytes: 1024,
    validationTtlMilliseconds: 1_000_000,
    ...overrides,
  });
}

function request(url, range) {
  return new Request(url, {
    method: "GET",
    headers: { Range: range },
  });
}

function createMockFetch({
  fetchLog = [],
  getEtag = () => '"v1"',
  beforeResponse = () => undefined,
} = {}) {
  return async (_url, init = {}) => {
    const method = init.method ?? "GET";
    if (method === "HEAD") {
      fetchLog.push({ method });
      return new Response(null, {
        status: 304,
        headers: { ETag: getEtag(), "Content-Length": String(sourceBytes.byteLength) },
      });
    }

    const range = init.headers?.Range ?? init.headers?.range;
    fetchLog.push({ method, range });
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (match === null) {
      return new Response("bad range", { status: 400 });
    }
    const start = Number.parseInt(match[1], 10);
    const requestedEnd = Number.parseInt(match[2], 10);
    const end = Math.min(requestedEnd, sourceBytes.byteLength - 1);
    await beforeResponse();
    return new Response(sourceBytes.slice(start, end + 1), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${sourceBytes.byteLength}`,
        "Content-Length": String(end - start + 1),
        ETag: getEtag(),
      },
    });
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for the test condition.");
}
