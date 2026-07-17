import { Copc } from "copc";
import type { Copc as CopcData, Getter } from "copc";
import {
  createCopcRangeGetter,
  createCopcSourceDescriptor,
  type CopcSourceDescriptor,
} from "../core/copc/createCopcRangeGetter";
import { getSharedLazPerf } from "../core/copc/createLazPerf";
import {
  loadCopcNodePointDataView,
  sampleCopcPointDataView,
  type CopcPointDataView,
} from "../core/copc/loadCopcNodePointSamples";
import {
  createSpatiallyDistributedPointIndices,
  SPATIAL_POINT_ORDER_BYTES_PER_POINT,
} from "../core/copc/createSpatiallyDistributedPointIndices";
import type { CopcNodePointSampleResult } from "../core/copc/CopcPointDataSample";
import type {
  CopcDecodedPointDataCacheNodeKey,
  CopcDecodedPointDataCacheSnapshot,
} from "../core/copc/CopcDecodedPointDataCache";
import type { PointGeometryBatch } from "./CopcPointCloudRenderer";
import type {
  CesiumCopcPointGeometryWorkerLoadRequest,
  CesiumCopcPointGeometryWorkerPrefetchRequest,
  CesiumCopcPointGeometryWorkerRequest,
  CesiumCopcPointGeometryWorkerResponse,
} from "./CesiumCopcPointGeometryWorkerProtocol";
import {
  createNodePointSampleBatchKey,
  createPointGeometryBatchFromSerializableTransform,
} from "./pointGeometryBatch";

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
  readonly cacheHit: boolean;
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
    listener: (event: {
      readonly data: CesiumCopcPointGeometryWorkerRequest;
    }) => void,
  ): void;
  postMessage(
    message: CesiumCopcPointGeometryWorkerResponse,
    transfer?: readonly Transferable[],
  ): void;
};

workerScope.addEventListener("message", (event) => {
  void handleRequest(event.data);
});

async function handleRequest(
  request: CesiumCopcPointGeometryWorkerRequest,
): Promise<void> {
  let cacheSnapshot: CopcDecodedPointDataCacheSnapshot | undefined;

  try {
    if (request.type === "warmup") {
      await getSharedLazPerf();

      const sourceDescriptor = readWorkerWarmupSource(request);
      if (sourceDescriptor) {
        await getWorkerCopcSource(sourceDescriptor, request.copc).copc;
      }

      workerScope.postMessage({
        id: request.id,
        type: "warmup:success",
      });
      return;
    }

    if (request.type === "cancel") {
      rememberCanceledRequest(request.id);
      return;
    }

    if (isRequestCanceled(request.id)) {
      postCanceledResponse(request, cacheSnapshot);
      return;
    }

    if (request.type === "prefetchNodePointData") {
      await handlePrefetchNodePointDataRequest(request, (snapshot) => {
        cacheSnapshot = snapshot;
      });
      return;
    }

    const workerStartedAt = nowMilliseconds();
    const source = getWorkerCopcSource(
      readWorkerRequestSource(request),
      request.copc,
    );
    const pointDataViewStartedAt = nowMilliseconds();
    const pointDataView = await loadWorkerPointDataView(
      source,
      request,
      (snapshot) => {
        cacheSnapshot = snapshot;
      },
    );
    const pointDataViewEndedAt = nowMilliseconds();
    const sampleStartedAt = nowMilliseconds();
    const spatialPointOrder = getOrCreateSpatialPointOrder(
      pointDataView.entry,
      pointDataView.view,
    );
    const pointSamplesWithData = sampleCopcPointDataView({
      nodeKey: request.nodeKey,
      view: pointDataView.view,
      maxPointCount: request.maxPointCount,
      sampleFormat: "typed",
      spatialPointOrder,
    });
    const sampleEndedAt = nowMilliseconds();

    if (isRequestCanceled(request.id)) {
      postCanceledResponse(request, cacheSnapshot);
      return;
    }

    if (!pointSamplesWithData.pointData) {
      throw new Error("Typed COPC point data was not produced.");
    }

    const geometryStartedAt = nowMilliseconds();
    const geometryBatch = createPointGeometryBatchFromSerializableTransform({
      key: createNodePointSampleBatchKey(pointSamplesWithData),
      pointData: pointSamplesWithData.pointData,
      transform: request.transform,
      pointColorStyle: request.pointColorStyle,
    });
    const geometryEndedAt = nowMilliseconds();
    const pointSamples = stripTransferOnlyPointData(pointSamplesWithData);

    if (isRequestCanceled(request.id)) {
      postCanceledResponse(request, cacheSnapshot);
      return;
    }

    workerScope.postMessage(
      {
        id: request.id,
        type: "loadNodePointGeometry:success",
        result: {
          pointSamples,
          geometryBatch,
          timing: {
            pointDataViewMilliseconds: Math.max(
              0,
              pointDataViewEndedAt - pointDataViewStartedAt,
            ),
            pointDataViewCacheHit: pointDataView.cacheHit,
            sampleMilliseconds: Math.max(0, sampleEndedAt - sampleStartedAt),
            geometryMilliseconds: Math.max(
              0,
              geometryEndedAt - geometryStartedAt,
            ),
            workerTotalMilliseconds: Math.max(
              0,
              geometryEndedAt - workerStartedAt,
            ),
          },
        },
        cache: pointDataView.cache,
      },
      getPointGeometryBatchTransferables(geometryBatch),
    );
  } catch (error) {
    if (request.type === "warmup") {
      workerScope.postMessage({
        id: request.id,
        type: "warmup:error",
        error: serializeError(error),
      });
      return;
    }

    if (request.type === "cancel") {
      return;
    }

    if (isRequestCanceled(request.id)) {
      postCanceledResponse(request, cacheSnapshot);
      return;
    }

    workerScope.postMessage({
      id: request.id,
      type:
        request.type === "prefetchNodePointData"
          ? "prefetchNodePointData:error"
          : "loadNodePointGeometry:error",
      cache: cacheSnapshot,
      error: serializeError(error),
    });
  }
}

async function handlePrefetchNodePointDataRequest(
  request: CesiumCopcPointGeometryWorkerPrefetchRequest,
  onCacheSnapshot: (snapshot: CopcDecodedPointDataCacheSnapshot) => void,
): Promise<void> {
  const workerStartedAt = nowMilliseconds();
  const source = getWorkerCopcSource(
    readWorkerRequestSource(request),
    request.copc,
  );
  const pointDataViewStartedAt = nowMilliseconds();
  const pointDataView = await loadWorkerPointDataView(
    source,
    request,
    onCacheSnapshot,
  );
  const pointDataViewEndedAt = nowMilliseconds();

  if (isRequestCanceled(request.id)) {
    postCanceledResponse(request, pointDataView.cache);
    return;
  }

  workerScope.postMessage({
    id: request.id,
    type: "prefetchNodePointData:success",
    result: {
      nodeKey: request.nodeKey,
      timing: {
        pointDataViewMilliseconds: Math.max(
          0,
          pointDataViewEndedAt - pointDataViewStartedAt,
        ),
        pointDataViewCacheHit: pointDataView.cacheHit,
        workerTotalMilliseconds: Math.max(
          0,
          pointDataViewEndedAt - workerStartedAt,
        ),
      },
    },
    cache: pointDataView.cache,
  });
}

function rememberCanceledRequest(id: number): void {
  canceledRequestIds.add(id);
  setTimeout(() => {
    canceledRequestIds.delete(id);
  }, CANCELED_REQUEST_TTL_MS);
}

function isRequestCanceled(id: number): boolean {
  return canceledRequestIds.has(id);
}

function postCanceledResponse(
  request: CesiumCopcPointGeometryWorkerLoadRequest |
    CesiumCopcPointGeometryWorkerPrefetchRequest,
  cache: CopcDecodedPointDataCacheSnapshot | undefined,
): void {
  canceledRequestIds.delete(request.id);
  workerScope.postMessage({
    id: request.id,
    type:
      request.type === "prefetchNodePointData"
        ? "prefetchNodePointData:canceled"
        : "loadNodePointGeometry:canceled",
    cache,
  });
}

function stripTransferOnlyPointData(
  result: CopcNodePointSampleResult,
): CopcNodePointSampleResult {
  return {
    nodeKey: result.nodeKey,
    nodePointCount: result.nodePointCount,
    sampledPointCount: result.sampledPointCount,
    points: [],
  };
}

function getPointGeometryBatchTransferables(
  batch: PointGeometryBatch,
): Transferable[] {
  const transferables: Transferable[] = [];
  addTransferableBuffer(transferables, batch.positions.buffer);
  addTransferableBuffer(transferables, batch.colors.buffer);
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
  copc?: CopcData,
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
  request:
    | CesiumCopcPointGeometryWorkerLoadRequest
    | CesiumCopcPointGeometryWorkerPrefetchRequest,
): CopcSourceDescriptor {
  if (request.source) {
    return request.source;
  }

  if (request.url) {
    return createCopcSourceDescriptor(request.url);
  }

  throw new Error("COPC point geometry worker requests require a source or url.");
}

function readWorkerWarmupSource(request: {
  readonly source?: CopcSourceDescriptor;
  readonly url?: string;
}): CopcSourceDescriptor | undefined {
  if (request.source) {
    return request.source;
  }

  if (request.url) {
    return createCopcSourceDescriptor(request.url);
  }

  return undefined;
}

async function loadWorkerPointDataView(
  source: WorkerCopcSource,
  request:
    | CesiumCopcPointGeometryWorkerLoadRequest
    | CesiumCopcPointGeometryWorkerPrefetchRequest,
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
        return {
          view,
          entry: cached,
          cacheHit: true,
          cache,
        };
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
      cacheHit: false,
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

function nowMilliseconds(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function touchDecodedNodeView(
  cacheKey: string,
  entry: WorkerDecodedNodeViewEntry,
): void {
  decodedNodeViews.delete(cacheKey);
  decodedNodeViews.set(cacheKey, entry);
}

function readDecodedNodeViewCacheLimits(
  request:
    | CesiumCopcPointGeometryWorkerLoadRequest
    | CesiumCopcPointGeometryWorkerPrefetchRequest,
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
