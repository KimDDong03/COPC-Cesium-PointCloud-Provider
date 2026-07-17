import { Copc } from "copc";
import type { Copc as CopcData, Getter } from "copc";
import {
  createCopcRangeGetter,
  createCopcSourceDescriptor,
  type CopcSourceDescriptor,
} from "./createCopcRangeGetter";
import {
  loadCopcNodePointDataView,
  sampleCopcPointDataView,
  type CopcPointDataView,
} from "./loadCopcNodePointSamples";
import {
  createSpatiallyDistributedPointIndices,
  SPATIAL_POINT_ORDER_BYTES_PER_POINT,
} from "./createSpatiallyDistributedPointIndices";
import type {
  CopcPointSampleWorkerRequest,
  CopcPointSampleWorkerResponse,
} from "./CopcPointSampleWorkerProtocol";
import type { CopcNodePointSampleResult } from "./CopcPointDataSample";
import type {
  CopcDecodedPointDataCacheNodeKey,
  CopcDecodedPointDataCacheSnapshot,
} from "./CopcDecodedPointDataCache";

interface WorkerCopcSource {
  readonly sourceKey: string;
  readonly getter: Getter;
  copc: Promise<CopcData>;
}

interface WorkerDecodedNodeViewEntry {
  readonly sourceKey: string;
  readonly nodeKey: string;
  readonly view: Promise<CopcPointDataView>;
  readonly estimatedByteSize: number;
  spatialPointOrder?: Uint32Array;
}

interface WorkerPointDataViewResult {
  readonly view: CopcPointDataView;
  readonly entry: WorkerDecodedNodeViewEntry;
  readonly cache: CopcDecodedPointDataCacheSnapshot;
}

interface WorkerDecodedNodeViewCacheLimits {
  readonly maxDecodedNodeViewCount: number;
  readonly maxDecodedNodeViewBytes: number;
}

const CANCELED_REQUEST_TTL_MS = 60_000;
const DEFAULT_MAX_DECODED_NODE_VIEW_COUNT = 48;
const DEFAULT_MAX_DECODED_NODE_VIEW_BYTES = 192 * 1024 * 1024;
const copcSources = new Map<string, WorkerCopcSource>();
const decodedNodeViews = new Map<string, WorkerDecodedNodeViewEntry>();
const canceledRequestIds = new Set<number>();
let decodedNodeViewBytes = 0;
let peakDecodedNodeViewBytes = 0;
let decodedNodeViewCacheHitCount = 0;
let decodedNodeViewCacheMissCount = 0;
let decodedNodeViewCacheEvictionCount = 0;
let oversizedDecodedNodeViewSkipCount = 0;
const workerScope = globalThis as unknown as {
  addEventListener(
    type: "message",
    listener: (event: { readonly data: CopcPointSampleWorkerRequest }) => void,
  ): void;
  postMessage(
    message: CopcPointSampleWorkerResponse,
    transfer?: readonly Transferable[],
  ): void;
};

workerScope.addEventListener("message", (event) => {
  void handleRequest(event.data);
});

async function handleRequest(
  request: CopcPointSampleWorkerRequest,
): Promise<void> {
  let cacheSnapshot: CopcDecodedPointDataCacheSnapshot | undefined;

  try {
    if (request.type === "cancel") {
      canceledRequestIds.add(request.id);
      setTimeout(() => {
        canceledRequestIds.delete(request.id);
      }, CANCELED_REQUEST_TTL_MS);
      return;
    }

    if (canceledRequestIds.delete(request.id)) {
      postCanceledResponse(request.id, cacheSnapshot);
      return;
    }

    const source = getWorkerCopcSource(
      readWorkerRequestSource(request),
      request.copc,
    );
    const pointDataView = await loadWorkerPointDataView(
      source,
      request,
      (snapshot) => {
        cacheSnapshot = snapshot;
      },
    );
    const spatialPointOrder = getOrCreateSpatialPointOrder(
      pointDataView.entry,
      pointDataView.view,
    );
    const result = sampleCopcPointDataView({
      nodeKey: request.nodeKey,
      view: pointDataView.view,
      maxPointCount: request.maxPointCount,
      sampleFormat: request.sampleFormat,
      spatialPointOrder,
    });

    if (canceledRequestIds.delete(request.id)) {
      postCanceledResponse(request.id, cacheSnapshot);
      return;
    }

    workerScope.postMessage(
      {
        id: request.id,
        type: "loadNodePointSamples:success",
        result,
        cache: pointDataView.cache,
      },
      getPointSampleResultTransferables(result),
    );
  } catch (error) {
    if (canceledRequestIds.delete(request.id)) {
      postCanceledResponse(request.id, cacheSnapshot);
      return;
    }

    workerScope.postMessage({
      id: request.id,
      type: "loadNodePointSamples:error",
      cache: cacheSnapshot,
      error: serializeError(error),
    });
  }
}

function postCanceledResponse(
  id: number,
  cache: CopcDecodedPointDataCacheSnapshot | undefined,
): void {
  workerScope.postMessage({
    id,
    type: "loadNodePointSamples:canceled",
    cache,
  });
}

function getPointSampleResultTransferables(
  result: CopcNodePointSampleResult,
): Transferable[] {
  const transferables: Transferable[] = [];
  const { pointData } = result;

  if (!pointData) {
    return transferables;
  }

  addTransferableBuffer(transferables, pointData.x.buffer);
  addTransferableBuffer(transferables, pointData.y.buffer);
  addTransferableBuffer(transferables, pointData.z.buffer);

  if (pointData.red) {
    addTransferableBuffer(transferables, pointData.red.buffer);
  }

  if (pointData.green) {
    addTransferableBuffer(transferables, pointData.green.buffer);
  }

  if (pointData.blue) {
    addTransferableBuffer(transferables, pointData.blue.buffer);
  }

  if (pointData.classification) {
    addTransferableBuffer(transferables, pointData.classification.buffer);
  }

  if (pointData.intensity) {
    addTransferableBuffer(transferables, pointData.intensity.buffer);
  }

  return transferables;
}

function addTransferableBuffer(
  transferables: Transferable[],
  buffer: ArrayBufferLike,
): void {
  if (buffer instanceof ArrayBuffer) {
    transferables.push(buffer);
  }
}

function getWorkerCopcSource(
  descriptor: CopcSourceDescriptor,
  copc: CopcData | undefined,
): WorkerCopcSource {
  let source = copcSources.get(descriptor.key);

  if (!source) {
    const getter = createCopcRangeGetter(descriptor.input);
    source = {
      sourceKey: descriptor.key,
      getter,
      copc: copc ? Promise.resolve(copc) : createWorkerCopcPromise(getter),
    };
    copcSources.set(descriptor.key, source);
  } else if (copc) {
    source.copc = Promise.resolve(copc);
  }

  return source;
}

function createWorkerCopcPromise(getter: Getter): Promise<CopcData> {
  const promise = Copc.create(getter);
  void promise.catch(() => undefined);
  return promise;
}

function readWorkerRequestSource(
  request: Exclude<CopcPointSampleWorkerRequest, { readonly type: "cancel" }>,
): CopcSourceDescriptor {
  if (request.source) {
    return request.source;
  }

  if (request.url) {
    return createCopcSourceDescriptor(request.url);
  }

  throw new Error("COPC point sample worker requests require a source or url.");
}

async function loadWorkerPointDataView(
  source: WorkerCopcSource,
  request: Exclude<CopcPointSampleWorkerRequest, { readonly type: "cancel" }>,
  onCacheSnapshot: (snapshot: CopcDecodedPointDataCacheSnapshot) => void,
): Promise<WorkerPointDataViewResult> {
  const cacheKey = createDecodedNodeViewKey(source.sourceKey, request.nodeKey);
  const limits = readDecodedNodeViewCacheLimits(request);
  const evictedNodeKeys: CopcDecodedPointDataCacheNodeKey[] = [];
  let requestedEntry: WorkerDecodedNodeViewEntry | undefined;

  try {
    const cached = decodedNodeViews.get(cacheKey);

    if (cached) {
      if (!canRetainDecodedNodeView(cached.estimatedByteSize, limits)) {
        deleteDecodedNodeView(cacheKey, cached, true, evictedNodeKeys);
      } else {
        requestedEntry = cached;
        decodedNodeViewCacheHitCount += 1;
        touchDecodedNodeView(cacheKey, cached);
        evictDecodedNodeViewsToLimits(limits, evictedNodeKeys);
        const view = await cached.view;
        const cache = createDecodedNodeViewCacheSnapshot(
          cacheKey,
          cached,
          evictedNodeKeys,
        );
        onCacheSnapshot(cache);
        return { view, entry: cached, cache };
      }
    }

    decodedNodeViewCacheMissCount += 1;
    const copc = await source.copc;
    const estimatedByteSize =
      request.node.pointCount *
      (copc.header.pointDataRecordLength +
        SPATIAL_POINT_ORDER_BYTES_PER_POINT);
    const view = loadCopcNodePointDataView({
      getter: source.getter,
      copc,
      node: request.node,
    }).catch((error: unknown) => {
      const existing = decodedNodeViews.get(cacheKey);

      if (existing?.view === view) {
        deleteDecodedNodeView(cacheKey, existing, false);
      }

      throw error;
    });
    const entry = {
      sourceKey: source.sourceKey,
      nodeKey: request.nodeKey,
      view,
      estimatedByteSize,
    };
    requestedEntry = entry;

    if (canRetainDecodedNodeView(estimatedByteSize, limits)) {
      evictDecodedNodeViewsToFit(entry, limits, evictedNodeKeys);
      decodedNodeViews.set(cacheKey, entry);
      decodedNodeViewBytes += estimatedByteSize;
      peakDecodedNodeViewBytes = Math.max(
        peakDecodedNodeViewBytes,
        decodedNodeViewBytes,
      );
    } else {
      oversizedDecodedNodeViewSkipCount += 1;
    }

    const loadedView = await view;
    const cache = createDecodedNodeViewCacheSnapshot(
      cacheKey,
      entry,
      evictedNodeKeys,
    );
    onCacheSnapshot(cache);
    return {
      view: loadedView,
      entry,
      cache,
    };
  } catch (error) {
    onCacheSnapshot(
      createDecodedNodeViewCacheSnapshot(
        cacheKey,
        requestedEntry,
        evictedNodeKeys,
      ),
    );
    throw error;
  }
}

function getOrCreateSpatialPointOrder(
  entry: WorkerDecodedNodeViewEntry,
  view: CopcPointDataView,
): Uint32Array {
  let spatialPointOrder = entry.spatialPointOrder;

  if (!spatialPointOrder) {
    spatialPointOrder = createSpatiallyDistributedPointIndices({
      pointCount: view.pointCount,
      sampleCount: view.pointCount,
      getX: view.getter("X"),
      getY: view.getter("Y"),
      getZ: view.getter("Z"),
    });
    entry.spatialPointOrder = spatialPointOrder;
  }

  return spatialPointOrder;
}

function touchDecodedNodeView(
  cacheKey: string,
  entry: WorkerDecodedNodeViewEntry,
): void {
  decodedNodeViews.delete(cacheKey);
  decodedNodeViews.set(cacheKey, entry);
}

function readDecodedNodeViewCacheLimits(
  request: Exclude<CopcPointSampleWorkerRequest, { readonly type: "cancel" }>,
): WorkerDecodedNodeViewCacheLimits {
  return {
    maxDecodedNodeViewCount:
      request.maxDecodedPointDataViews ?? DEFAULT_MAX_DECODED_NODE_VIEW_COUNT,
    maxDecodedNodeViewBytes:
      request.maxDecodedPointDataViewBytes ??
      DEFAULT_MAX_DECODED_NODE_VIEW_BYTES,
  };
}

function canRetainDecodedNodeView(
  estimatedByteSize: number,
  limits: WorkerDecodedNodeViewCacheLimits,
): boolean {
  return (
    limits.maxDecodedNodeViewCount > 0 &&
    estimatedByteSize <= limits.maxDecodedNodeViewBytes
  );
}

function evictDecodedNodeViewsToLimits(
  limits: WorkerDecodedNodeViewCacheLimits,
  evictedNodeKeys: CopcDecodedPointDataCacheNodeKey[],
): void {
  while (
    decodedNodeViews.size > limits.maxDecodedNodeViewCount ||
    decodedNodeViewBytes > limits.maxDecodedNodeViewBytes
  ) {
    if (!evictOldestDecodedNodeView(evictedNodeKeys)) {
      return;
    }
  }
}

function evictDecodedNodeViewsToFit(
  entry: WorkerDecodedNodeViewEntry,
  limits: WorkerDecodedNodeViewCacheLimits,
  evictedNodeKeys: CopcDecodedPointDataCacheNodeKey[],
): void {
  while (
    decodedNodeViews.size >= limits.maxDecodedNodeViewCount ||
    decodedNodeViewBytes + entry.estimatedByteSize >
      limits.maxDecodedNodeViewBytes
  ) {
    if (!evictOldestDecodedNodeView(evictedNodeKeys)) {
      return;
    }
  }
}

function evictOldestDecodedNodeView(
  evictedNodeKeys: CopcDecodedPointDataCacheNodeKey[],
): boolean {
  const oldestCacheKey = decodedNodeViews.keys().next().value;

  if (!oldestCacheKey) {
    return false;
  }

  const oldestEntry = decodedNodeViews.get(oldestCacheKey);

  if (!oldestEntry) {
    decodedNodeViews.delete(oldestCacheKey);
    return true;
  }

  deleteDecodedNodeView(
    oldestCacheKey,
    oldestEntry,
    true,
    evictedNodeKeys,
  );
  return true;
}

function deleteDecodedNodeView(
  cacheKey: string,
  entry: WorkerDecodedNodeViewEntry,
  countEviction: boolean,
  evictedNodeKeys?: CopcDecodedPointDataCacheNodeKey[],
): void {
  if (!decodedNodeViews.delete(cacheKey)) {
    return;
  }

  decodedNodeViewBytes = Math.max(
    0,
    decodedNodeViewBytes - entry.estimatedByteSize,
  );

  if (countEviction) {
    decodedNodeViewCacheEvictionCount += 1;
    evictedNodeKeys?.push({
      sourceKey: entry.sourceKey,
      nodeKey: entry.nodeKey,
    });
  }
}

function createDecodedNodeViewCacheSnapshot(
  requestedCacheKey: string,
  requestedEntry: WorkerDecodedNodeViewEntry | undefined,
  evictedNodeKeys: readonly CopcDecodedPointDataCacheNodeKey[],
): CopcDecodedPointDataCacheSnapshot {
  return {
    retainedViewCount: decodedNodeViews.size,
    retainedBytes: decodedNodeViewBytes,
    peakRetainedBytes: peakDecodedNodeViewBytes,
    cacheHitCount: decodedNodeViewCacheHitCount,
    cacheMissCount: decodedNodeViewCacheMissCount,
    cacheEvictionCount: decodedNodeViewCacheEvictionCount,
    oversizedEntrySkipCount: oversizedDecodedNodeViewSkipCount,
    requestedNodeRetained:
      requestedEntry !== undefined &&
      decodedNodeViews.get(requestedCacheKey) === requestedEntry,
    evictedNodeKeys: [...evictedNodeKeys],
  };
}

function createDecodedNodeViewKey(
  sourceKey: string,
  nodeKey: string,
): string {
  return `${sourceKey.length}:${sourceKey}${nodeKey}`;
}

function serializeError(error: unknown): {
  readonly name?: string;
  readonly message: string;
  readonly stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}
