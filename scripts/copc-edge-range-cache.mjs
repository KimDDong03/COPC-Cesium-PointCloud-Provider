const DEFAULT_BLOCK_BYTE_LENGTH = 64 * 1024;
const DEFAULT_MAX_ORIGIN_SPAN_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DOWNSTREAM_RANGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DOWNSTREAM_BLOCK_COUNT = 64;
const DEFAULT_MAX_CONCURRENT_ORIGIN_SPANS = 4;
const DEFAULT_MAX_CACHED_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_CACHED_BLOCK_COUNT = 4096;
const DEFAULT_VALIDATION_TTL_MILLISECONDS = 30_000;

export function createCopcEdgeRangeCache(options = {}) {
  const routes = normalizeRoutes(options.routes);
  const blockByteLength = positiveInteger(
    options.blockByteLength,
    DEFAULT_BLOCK_BYTE_LENGTH,
    "blockByteLength",
  );
  const maxOriginSpanBytes = positiveInteger(
    options.maxOriginSpanBytes,
    DEFAULT_MAX_ORIGIN_SPAN_BYTES,
    "maxOriginSpanBytes",
  );
  const maxDownstreamRangeBytes = positiveInteger(
    options.maxDownstreamRangeBytes,
    DEFAULT_MAX_DOWNSTREAM_RANGE_BYTES,
    "maxDownstreamRangeBytes",
  );
  const maxDownstreamBlockCount = positiveInteger(
    options.maxDownstreamBlockCount,
    DEFAULT_MAX_DOWNSTREAM_BLOCK_COUNT,
    "maxDownstreamBlockCount",
  );
  const maxConcurrentOriginSpans = positiveInteger(
    options.maxConcurrentOriginSpans,
    DEFAULT_MAX_CONCURRENT_ORIGIN_SPANS,
    "maxConcurrentOriginSpans",
  );
  const maxCachedBytes = nonNegativeInteger(
    options.maxCachedBytes,
    DEFAULT_MAX_CACHED_BYTES,
    "maxCachedBytes",
  );
  const maxCachedBlockCount = nonNegativeInteger(
    options.maxCachedBlockCount ?? options.maxCachedCount,
    DEFAULT_MAX_CACHED_BLOCK_COUNT,
    "maxCachedBlockCount",
  );
  const validationTtlMilliseconds = nonNegativeInteger(
    options.validationTtlMilliseconds,
    DEFAULT_VALIDATION_TTL_MILLISECONDS,
    "validationTtlMilliseconds",
  );
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const onError = options.onError ?? (() => undefined);

  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }
  if (typeof onError !== "function") {
    throw new TypeError("onError must be a function");
  }
  if (blockByteLength > maxOriginSpanBytes) {
    throw new TypeError(
      "blockByteLength must not exceed maxOriginSpanBytes",
    );
  }

  const sources = new Map();
  const blocks = new Map();
  const inflightBlocks = new Map();
  const originSpanWaiters = [];
  let activeOriginSpanFetches = 0;
  let cacheGeneration = 0;
  let cachedBytes = 0;
  const stats = {
    downstreamRequests: 0,
    downstreamBytes: 0,
    originRequests: 0,
    originBytes: 0,
    blockHits: 0,
    blockMisses: 0,
    evictions: 0,
    validationRequests: 0,
    purges: 0,
    errors: 0,
  };

  async function handle(request) {
    stats.downstreamRequests += 1;

    let route;
    try {
      const requestUrl = new URL(request.url);
      route = requestUrl.search.length === 0
        ? routes.get(requestUrl.pathname)
        : undefined;
    } catch {
      stats.errors += 1;
      return textResponse("Invalid request URL", 400);
    }

    if (route === undefined) {
      stats.errors += 1;
      return textResponse("Not found", 404);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      stats.errors += 1;
      return textResponse("Method not allowed", 405, {
        Allow: "GET, OPTIONS",
      });
    }

    const parsedRange = parseRangeHeader(request.headers.get("range"), {
      blockByteLength,
      maxBlockCount: maxDownstreamBlockCount,
      maxRangeBytes: maxDownstreamRangeBytes,
    });
    if (parsedRange.error !== undefined) {
      stats.errors += 1;
      return textResponse(parsedRange.error, 416);
    }

    const source = getSource(route);
    try {
      await validateSourceIfNeeded(source, route);
      assertCurrentGeneration(source);
      const result = await readRangeBlocks(source, route, parsedRange);
      stats.downstreamBytes += result.bytes.byteLength;

      return new Response(result.bytes, {
        status: 206,
        headers: rangeResponseHeaders({
          etag: result.etag,
          length: result.bytes.byteLength,
          start: parsedRange.start,
          end: parsedRange.end,
          total: result.total,
        }),
      });
    } catch (error) {
      stats.errors += 1;
      try {
        onError(error);
      } catch {
        // Diagnostic callbacks must not change the HTTP failure contract.
      }
      return textResponse("Range cache request failed", 502);
    }
  }

  function clear() {
    cacheGeneration += 1;
    blocks.clear();
    inflightBlocks.clear();
    sources.clear();
    cachedBytes = 0;
  }

  function getStats() {
    return {
      ...stats,
      cachedBytes,
      cachedBlockCount: blocks.size,
      inflightBlockCount: inflightBlocks.size,
    };
  }

  async function readRangeBlocks(source, route, requestedRange) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assertCurrentGeneration(source);
      const result = await readRangeBlocksOnce(source, route, requestedRange);
      if (result !== null) {
        return result;
      }
      purgeSource(source);
    }
    throw new Error("Origin validator changed while assembling the range");
  }

  async function readRangeBlocksOnce(source, route, requestedRange) {
    const generation = source.generation;
    const blockStarts = enumerateBlockStarts(requestedRange, blockByteLength);
    const missingBlockStarts = [];
    const blockPromises = [];

    for (const blockStart of blockStarts) {
      const key = blockKey(source.key, blockStart);
      const entry = blocks.get(key);
      if (entry !== undefined && entry.etag === source.etag && entry.total === source.total) {
        stats.blockHits += 1;
        touchBlock(key, entry);
        blockPromises.push(Promise.resolve(entry));
        continue;
      }

      const inflight = inflightBlocks.get(key);
      if (inflight !== undefined) {
        stats.blockHits += 1;
        blockPromises.push(inflight);
        continue;
      }

      stats.blockMisses += 1;
      missingBlockStarts.push(blockStart);
    }

    for (const group of groupConsecutiveBlocks(missingBlockStarts, blockByteLength, maxOriginSpanBytes)) {
      const spanPromise = scheduleOriginSpanFetch(() =>
        fetchAndStoreBlockSpan(
          source,
          route,
          group.start,
          group.end,
          generation,
        ));
      for (const blockStart of group.blockStarts) {
        const key = blockKey(source.key, blockStart);
        const blockPromise = spanPromise.then((spanBlocks) => {
          const block = spanBlocks.get(blockStart);
          if (block === undefined) {
            throw new Error(`Origin response did not include block ${blockStart}`);
          }
          return block;
        });
        inflightBlocks.set(key, blockPromise);
        blockPromises.push(blockPromise);
        blockPromise.then(() => {
          if (inflightBlocks.get(key) === blockPromise) {
            inflightBlocks.delete(key);
          }
        }, () => {
          if (inflightBlocks.get(key) === blockPromise) {
            inflightBlocks.delete(key);
          }
        });
      }
    }

    const rangeBlocks = await Promise.all(blockPromises);
    const responseEtag = rangeBlocks[0]?.etag;
    const responseTotal = rangeBlocks[0]?.total;
    if (
      responseEtag === undefined ||
      responseTotal === undefined ||
      rangeBlocks.some((block) =>
        block.etag !== responseEtag || block.total !== responseTotal)
    ) {
      return null;
    }
    if (requestedRange.end >= responseTotal) {
      throw new Error("Requested range exceeds the origin object length");
    }
    const output = new Uint8Array(requestedRange.end - requestedRange.start + 1);
    let outputOffset = 0;

    for (const block of rangeBlocks.sort((left, right) => left.start - right.start)) {
      const copyStart = Math.max(requestedRange.start, block.start);
      const copyEnd = Math.min(requestedRange.end, block.start + block.data.byteLength - 1);
      if (copyEnd < copyStart) {
        continue;
      }
      output.set(
        block.data.subarray(copyStart - block.start, copyEnd - block.start + 1),
        outputOffset,
      );
      outputOffset += copyEnd - copyStart + 1;
    }

    if (outputOffset !== output.byteLength) {
      throw new Error("Cached blocks did not cover the requested range");
    }

    return { bytes: output, etag: responseEtag, total: responseTotal };
  }

  async function fetchAndStoreBlockSpan(
    source,
    route,
    spanStart,
    spanEnd,
    generation,
  ) {
    const response = await fetchOrigin(route.originUrl, spanStart, spanEnd);
    const parsed = await parseOriginRangeResponse(response, spanStart, spanEnd);
    assertGeneration(generation, source);

    if (source.etag !== undefined && (parsed.etag !== source.etag || parsed.total !== source.total)) {
      const retry = await fetchOrigin(route.originUrl, spanStart, spanEnd);
      const retryParsed = await parseOriginRangeResponse(retry, spanStart, spanEnd);
      assertGeneration(generation, source);
      if (retryParsed.etag !== parsed.etag || retryParsed.total !== parsed.total) {
        throw new Error("Origin validator changed repeatedly");
      }
      purgeSource(source);
      applySourceValidator(source, retryParsed);
      return storeOriginSpan(source, retryParsed, spanStart, generation);
    }

    applySourceValidator(source, parsed);
    return storeOriginSpan(source, parsed, spanStart, generation);
  }

  async function fetchOrigin(originUrl, start, end, headers = {}) {
    stats.originRequests += 1;
    return fetchImpl(originUrl, {
      method: "GET",
      redirect: "error",
      headers: {
        Range: `bytes=${start}-${end}`,
        ...headers,
      },
    });
  }

  async function scheduleOriginSpanFetch(task) {
    if (activeOriginSpanFetches >= maxConcurrentOriginSpans) {
      await new Promise((resolve) => originSpanWaiters.push(resolve));
    }
    activeOriginSpanFetches += 1;
    try {
      return await task();
    } finally {
      activeOriginSpanFetches -= 1;
      originSpanWaiters.shift()?.();
    }
  }

  async function parseOriginRangeResponse(response, expectedStart, requestedEnd) {
    if (response.status !== 206) {
      throw new Error(`Origin returned HTTP ${response.status}`);
    }

    const etag = response.headers.get("etag");
    if (!isStrongEtag(etag)) {
      throw new Error("Origin response is missing a strong ETag");
    }

    const contentRange = parseContentRange(response.headers.get("content-range"));
    if (contentRange === null) {
      throw new Error("Origin response has invalid Content-Range");
    }
    if (contentRange.start !== expectedStart) {
      throw new Error("Origin response start does not match request");
    }
    if (contentRange.end > requestedEnd) {
      throw new Error("Origin response exceeds requested span");
    }
    if (contentRange.end < requestedEnd && contentRange.end + 1 !== contentRange.total) {
      throw new Error("Origin response is shorter than requested span before EOF");
    }

    const data = new Uint8Array(await response.arrayBuffer());
    const expectedLength = contentRange.end - contentRange.start + 1;
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      parseSafeDecimalInteger(contentLength) !== expectedLength
    ) {
      throw new Error("Origin Content-Length does not match Content-Range");
    }
    if (data.byteLength !== expectedLength) {
      throw new Error("Origin body length does not match Content-Range");
    }

    stats.originBytes += data.byteLength;
    return { data, etag, total: contentRange.total };
  }

  async function validateSourceIfNeeded(source, route) {
    if (
      source.etag === undefined ||
      source.lastValidatedAt === undefined ||
      now() - source.lastValidatedAt < validationTtlMilliseconds
    ) {
      return;
    }

    stats.validationRequests += 1;
    const response = await fetchImpl(route.originUrl, {
      method: "HEAD",
      redirect: "error",
      headers: {
        "If-None-Match": source.etag,
      },
    });

    if (response.status === 304) {
      assertCurrentGeneration(source);
      source.lastValidatedAt = now();
      return;
    }

    const nextEtag = response.headers.get("etag");
    const nextLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (
      response.status >= 200 &&
      response.status < 300 &&
      isStrongEtag(nextEtag) &&
      Number.isSafeInteger(nextLength) &&
      nextLength >= 0
    ) {
      assertCurrentGeneration(source);
      if (nextEtag !== source.etag || nextLength !== source.total) {
        purgeSource(source);
      }
      source.etag = nextEtag;
      source.total = nextLength;
      source.lastValidatedAt = now();
      return;
    }

    throw new Error(`Origin validation returned HTTP ${response.status}`);
  }

  function storeOriginSpan(source, parsed, spanStart, generation) {
    assertGeneration(generation, source);
    const storedBlocks = new Map();
    for (let offset = 0; offset < parsed.data.byteLength; offset += blockByteLength) {
      const start = spanStart + offset;
      const data = parsed.data.slice(offset, Math.min(offset + blockByteLength, parsed.data.byteLength));
      const entry = {
        data,
        etag: parsed.etag,
        start,
        total: parsed.total,
        touchedAt: now(),
      };
      setBlock(blockKey(source.key, start), entry);
      storedBlocks.set(start, entry);
    }
    return storedBlocks;
  }

  function applySourceValidator(source, parsed) {
    assertCurrentGeneration(source);
    source.etag = parsed.etag;
    source.total = parsed.total;
    source.lastValidatedAt = now();
  }

  function purgeSource(source) {
    if (source.generation !== cacheGeneration) {
      return;
    }
    stats.purges += 1;
    for (const [key, entry] of blocks) {
      if (key.startsWith(`${source.key}\n`)) {
        cachedBytes -= entry.data.byteLength;
        blocks.delete(key);
      }
    }
    for (const key of inflightBlocks.keys()) {
      if (key.startsWith(`${source.key}\n`)) {
        inflightBlocks.delete(key);
      }
    }
  }

  function setBlock(key, entry) {
    const previous = blocks.get(key);
    if (previous !== undefined) {
      cachedBytes -= previous.data.byteLength;
    }
    blocks.set(key, entry);
    cachedBytes += entry.data.byteLength;
    evictIfNeeded();
  }

  function touchBlock(key, entry) {
    blocks.delete(key);
    entry.touchedAt = now();
    blocks.set(key, entry);
  }

  function evictIfNeeded() {
    while (
      cachedBytes > maxCachedBytes ||
      blocks.size > maxCachedBlockCount
    ) {
      const oldestKey = blocks.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      const oldest = blocks.get(oldestKey);
      cachedBytes -= oldest.data.byteLength;
      blocks.delete(oldestKey);
      stats.evictions += 1;
    }
  }

  function getSource(route) {
    const existing = sources.get(route.sourceKey);
    if (existing !== undefined) {
      return existing;
    }
    const source = {
      key: route.sourceKey,
      generation: cacheGeneration,
      etag: undefined,
      total: undefined,
      lastValidatedAt: undefined,
    };
    sources.set(route.sourceKey, source);
    return source;
  }

  function assertCurrentGeneration(source) {
    assertGeneration(source.generation, source);
  }

  function assertGeneration(generation, source) {
    if (generation !== cacheGeneration || source.generation !== cacheGeneration) {
      throw new Error("Edge cache was cleared while the range was in flight");
    }
  }

  return { handle, clear, getStats };
}

function normalizeRoutes(routes) {
  const normalized = new Map();
  const entries = routes instanceof Map ? routes.entries() : Object.entries(routes ?? {});
  for (const [pathname, originUrl] of entries) {
    if (typeof pathname !== "string" || !pathname.startsWith("/")) {
      throw new TypeError("Route keys must be exact pathnames starting with /");
    }
    const origin = new URL(originUrl);
    if (origin.protocol !== "https:") {
      throw new TypeError("Route origins must be fixed HTTPS URLs");
    }
    if (origin.username || origin.password || origin.search || origin.hash) {
      throw new TypeError(
        "Route origins must not include credentials, query strings, or fragments",
      );
    }
    normalized.set(pathname, {
      originUrl: origin.toString(),
      sourceKey: origin.toString(),
    });
  }
  return normalized;
}

function parseRangeHeader(header, { blockByteLength, maxBlockCount, maxRangeBytes }) {
  if (typeof header !== "string") {
    return { error: "Missing Range header" };
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(header);
  if (match === null) {
    return { error: "Only single explicit byte ranges are supported" };
  }
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
    return { error: "Invalid byte range" };
  }
  const rangeBytes = end - start + 1;
  const firstBlock = Math.floor(start / blockByteLength);
  const lastBlock = Math.floor(end / blockByteLength);
  const blockCount = lastBlock - firstBlock + 1;
  if (
    !Number.isSafeInteger(rangeBytes) ||
    rangeBytes > maxRangeBytes ||
    !Number.isSafeInteger(blockCount) ||
    blockCount > maxBlockCount
  ) {
    return { error: "Requested byte range is too large" };
  }
  return { start, end };
}

function parseContentRange(header) {
  if (typeof header !== "string") {
    return null;
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header);
  if (match === null) {
    return null;
  }
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  const total = Number.parseInt(match[3], 10);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start > end ||
    end >= total
  ) {
    return null;
  }
  return { start, end, total };
}

function parseSafeDecimalInteger(value) {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function enumerateBlockStarts(range, blockByteLength) {
  const starts = [];
  const first = Math.floor(range.start / blockByteLength) * blockByteLength;
  const last = Math.floor(range.end / blockByteLength) * blockByteLength;
  for (let start = first; start <= last; start += blockByteLength) {
    starts.push(start);
  }
  return starts;
}

function groupConsecutiveBlocks(blockStarts, blockByteLength, maxOriginSpanBytes) {
  const groups = [];
  let group = null;
  for (const blockStart of blockStarts) {
    if (
      group === null ||
      blockStart !== group.lastBlockStart + blockByteLength ||
      blockStart + blockByteLength - group.start > maxOriginSpanBytes
    ) {
      group = {
        start: blockStart,
        end: blockStart + blockByteLength - 1,
        lastBlockStart: blockStart,
        blockStarts: [blockStart],
      };
      groups.push(group);
      continue;
    }
    group.end = blockStart + blockByteLength - 1;
    group.lastBlockStart = blockStart;
    group.blockStarts.push(blockStart);
  }
  return groups;
}

function rangeResponseHeaders({ etag, length, start, end, total }) {
  return {
    ...corsHeaders(),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-cache",
    "Content-Length": String(length),
    "Content-Range": `bytes ${start}-${end}/${total}`,
    ETag: etag,
  };
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Headers": "Range, If-None-Match",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, ETag, Cache-Control",
    ...extra,
  };
}

function textResponse(text, status, headers = {}) {
  return new Response(text, {
    status,
    headers: {
      ...corsHeaders(),
      ...headers,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function isStrongEtag(etag) {
  return typeof etag === "string" && /^"(?:[^"\\]|\\.)*"$/.test(etag);
}

function blockKey(sourceKey, blockStart) {
  return `${sourceKey}\n${blockStart}`;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value, fallback, name) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}
