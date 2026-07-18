import type { Copc as CopcData, Hierarchy } from "copc";
import type {
  CesiumPointGeometryLoadingMode,
} from "./CesiumPointGeometryWorkerPool";
import { createCesiumCopcPointGeometryWorker } from "./createCesiumCopcPointGeometryWorker";
import type {
  CesiumCopcPointGeometryWorkerHalfOpenRange,
  CesiumCopcPointGeometryWorkerInboundMessage,
  CesiumCopcPointGeometryWorkerLoadRequest,
  CesiumCopcPointGeometryWorkerOutboundMessage,
  CesiumCopcPointGeometryWorkerPrefetchRequest,
  CesiumCopcPointGeometryWorkerRangeRequestMessage,
  CesiumCopcPointGeometryWorkerSerializedError,
  CesiumCopcPointGeometryWorkerWarmupErrorResponse,
  CesiumCopcPointGeometryWorkerWarmupSuccessResponse,
  CesiumCopcPointGeometryWorkerWorkRequest,
  CopcNodePointGeometryBatchResult,
  CopcNodePointDataPrefetchResult,
} from "./CesiumCopcPointGeometryWorkerProtocol";
import {
  createCopcSourceDescriptor,
  type CopcRangeGetterOptions,
  type CopcSourceDescriptor,
} from "../core/copc/createCopcRangeGetter";
import {
  calculateEffectiveDecodedPointDataViewBytesPerWorker,
  DEFAULT_MAX_CONCURRENT_COPC_POINT_GEOMETRY_WORKER_REQUESTS,
  type CopcDecodedPointDataCacheSnapshot,
  type CopcDecodedPointDataCacheStats,
} from "../core/copc/CopcDecodedPointDataCache";
import type { CesiumPointGeometryTransform } from "./pointGeometryBatch";
import type { ResolvedCopcPointColorStyle } from "./copcPointColorizer";
import {
  planCopcPointDataRanges,
  type CopcPointDataPlannedRange,
} from "../core/copc/planCopcPointDataRanges";
import { CopcWorkerRangeRequestBroker } from "./CopcWorkerRangeRequestBroker";

export interface CesiumCopcPointGeometryWorkerPoolOptions {
  readonly rangeGetterOptions?: CopcRangeGetterOptions;
  readonly pointGeometryLoading?: CesiumPointGeometryLoadingMode;
  readonly maxConcurrentPointGeometryWorkerRequests?: number;
  readonly activeRequestCancellation?: CesiumCopcPointGeometryWorkerCancellationMode;
  readonly decodedNodeWorkerFallbackDelayMilliseconds?: number;
  readonly maxDecodedPointDataViewsPerWorker?: number;
  readonly maxDecodedPointDataViewBytesPerWorker?: number;
  readonly maxDecodedPointDataViewBytesAcrossWorkers?: number;
  /**
   * Route worker byte reads through one shared main-thread range cache.
   * Terminating cancellation modes use direct worker reads so termination also
   * stops their network work.
   */
  readonly brokeredRangeRequests?: boolean;
  /** Maximum lazy contiguous point-data span fetched for one worker request. */
  readonly maxCoalescedPointDataRangeBytes?: number;
  /** Maximum byte gap allowed inside a planned point-data span. Defaults to 64 KiB. */
  readonly maxCoalescedPointDataRangeGapBytes?: number;
  readonly createCopcPointGeometryWorker?: () => Worker;
}

export interface CesiumCopcPointGeometryWorkerWarmupOptions {
  readonly copc?: CopcData;
  readonly workerCount?: number;
  readonly source?: CopcSourceDescriptor;
  readonly url?: string;
}

export type CesiumCopcPointGeometryWorkerCancellationMode =
  | "soft"
  | "terminate-uncached"
  | "terminate";

interface PointGeometryWorkerRequestEntry {
  worker?: Worker;
  request: CesiumCopcPointGeometryWorkerWorkRequest;
  coalescingKey: string;
  readonly consumers: PointGeometryWorkerRequestConsumer[];
  readonly queuedAtMilliseconds: number;
  priority: number;
  startedAtMilliseconds?: number;
  state: "queued" | "active" | "canceled";
}

interface PointGeometryWorkerWarmupEntry {
  readonly id: number;
  readonly worker: Worker;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

type PointGeometryWorkerGeometryRequestEntry =
  PointGeometryWorkerRequestEntry & {
    request: CesiumCopcPointGeometryWorkerLoadRequest;
  };

interface PointGeometryWorkerRequestConsumerBase {
  readonly signal?: AbortSignal;
  readonly priority: number;
  readonly cleanup: () => void;
  readonly reject: (error: Error) => void;
}

interface PointGeometryWorkerGeometryRequestConsumer
  extends PointGeometryWorkerRequestConsumerBase {
  readonly kind: "geometry";
  readonly maxPointCount: number;
  readonly resolve: (result: CopcNodePointGeometryBatchResult) => void;
}

interface PointGeometryWorkerPrefetchRequestConsumer
  extends PointGeometryWorkerRequestConsumerBase {
  readonly kind: "prefetch";
  readonly resolve: (result: CopcNodePointDataPrefetchResult) => void;
}

type PointGeometryWorkerRequestConsumer =
  | PointGeometryWorkerGeometryRequestConsumer
  | PointGeometryWorkerPrefetchRequestConsumer;

const DEFAULT_DECODED_NODE_WORKER_FALLBACK_DELAY_MILLISECONDS =
  Number.POSITIVE_INFINITY;
const DEFAULT_MAX_COALESCED_POINT_DATA_RANGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_COALESCED_POINT_DATA_RANGE_GAP_BYTES = 64 * 1024;

export class CesiumCopcPointGeometryWorkerPool {
  private readonly pointGeometryLoading: CesiumPointGeometryLoadingMode;
  private readonly maxConcurrentPointGeometryWorkerRequests: number;
  private readonly activeRequestCancellation: CesiumCopcPointGeometryWorkerCancellationMode;
  private readonly decodedNodeWorkerFallbackDelayMilliseconds: number;
  private readonly maxDecodedPointDataViewsPerWorker: number | undefined;
  private readonly maxDecodedPointDataViewBytesPerWorker: number | undefined;
  private readonly maxDecodedPointDataViewBytesAcrossWorkers: number | undefined;
  private readonly brokeredRangeRequests: boolean;
  private readonly maxCoalescedPointDataRangeBytes: number;
  private readonly maxCoalescedPointDataRangeGapBytes: number;
  private readonly createCopcPointGeometryWorker: () => Worker;
  private readonly rangeRequestBroker: CopcWorkerRangeRequestBroker;
  private readonly workers: Worker[] = [];
  private readonly activeWorkers = new Set<Worker>();
  private readonly requests = new Map<number, PointGeometryWorkerRequestEntry>();
  private readonly coalescedRequests =
    new Map<string, PointGeometryWorkerRequestEntry>();
  private readonly queue: PointGeometryWorkerRequestEntry[] = [];
  private readonly warmupRequests = new Map<number, PointGeometryWorkerWarmupEntry>();
  private readonly activeNodeWorkers = new Map<string, Worker>();
  private readonly decodedNodeWorkers = new Map<string, Worker>();
  private readonly decodedPointDataCacheSnapshots = new Map<
    Worker,
    CopcDecodedPointDataCacheSnapshot
  >();
  private lastWarmupOptions: CesiumCopcPointGeometryWorkerWarmupOptions | undefined;
  private warmupPromise: Promise<void> | undefined;
  private workerUnavailable = false;
  private queueDrainScheduled = false;
  private queueDrainTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private requestId = 0;
  private destroyed = false;
  private peakDecodedPointDataRetainedBytes = 0;
  private retiredDecodedPointDataCacheHitCount = 0;
  private retiredDecodedPointDataCacheMissCount = 0;
  private retiredDecodedPointDataCacheEvictionCount = 0;
  private retiredOversizedDecodedPointDataEntrySkipCount = 0;

  constructor(options: CesiumCopcPointGeometryWorkerPoolOptions = {}) {
    const maxConcurrentPointGeometryWorkerRequests =
      options.maxConcurrentPointGeometryWorkerRequests ??
      DEFAULT_MAX_CONCURRENT_COPC_POINT_GEOMETRY_WORKER_REQUESTS;

    if (
      !Number.isSafeInteger(maxConcurrentPointGeometryWorkerRequests) ||
      maxConcurrentPointGeometryWorkerRequests <= 0
    ) {
      throw new Error(
        "maxConcurrentPointGeometryWorkerRequests must be a positive integer.",
      );
    }

    if (
      options.activeRequestCancellation !== undefined &&
      options.activeRequestCancellation !== "soft" &&
      options.activeRequestCancellation !== "terminate-uncached" &&
      options.activeRequestCancellation !== "terminate"
    ) {
      throw new Error(
        "activeRequestCancellation must be 'soft', 'terminate-uncached', or 'terminate'.",
      );
    }

    this.maxDecodedPointDataViewsPerWorker = readOptionalPositiveInteger(
      "maxDecodedPointDataViewsPerWorker",
      options.maxDecodedPointDataViewsPerWorker,
    );
    const maxDecodedPointDataViewBytesPerWorker = readOptionalPositiveInteger(
      "maxDecodedPointDataViewBytesPerWorker",
      options.maxDecodedPointDataViewBytesPerWorker,
    );
    this.maxDecodedPointDataViewBytesAcrossWorkers =
      readOptionalPositiveInteger(
        "maxDecodedPointDataViewBytesAcrossWorkers",
        options.maxDecodedPointDataViewBytesAcrossWorkers,
      );
    this.maxDecodedPointDataViewBytesPerWorker =
      calculateEffectiveDecodedPointDataViewBytesPerWorker(
        maxDecodedPointDataViewBytesPerWorker,
        this.maxDecodedPointDataViewBytesAcrossWorkers,
        maxConcurrentPointGeometryWorkerRequests,
      );
    this.pointGeometryLoading = options.pointGeometryLoading ?? "main-thread";
    this.maxConcurrentPointGeometryWorkerRequests =
      maxConcurrentPointGeometryWorkerRequests;
    this.activeRequestCancellation =
      options.activeRequestCancellation ?? "soft";
    this.decodedNodeWorkerFallbackDelayMilliseconds =
      readOptionalNonNegativeNumber(
        "decodedNodeWorkerFallbackDelayMilliseconds",
        options.decodedNodeWorkerFallbackDelayMilliseconds,
        DEFAULT_DECODED_NODE_WORKER_FALLBACK_DELAY_MILLISECONDS,
      );
    this.brokeredRangeRequests =
      (options.brokeredRangeRequests ?? true) &&
      this.activeRequestCancellation === "soft";
    this.maxCoalescedPointDataRangeBytes =
      readOptionalPositiveInteger(
        "maxCoalescedPointDataRangeBytes",
        options.maxCoalescedPointDataRangeBytes,
      ) ?? DEFAULT_MAX_COALESCED_POINT_DATA_RANGE_BYTES;
    this.maxCoalescedPointDataRangeGapBytes =
      readOptionalNonNegativeSafeInteger(
        "maxCoalescedPointDataRangeGapBytes",
        options.maxCoalescedPointDataRangeGapBytes,
        DEFAULT_MAX_COALESCED_POINT_DATA_RANGE_GAP_BYTES,
      );
    this.createCopcPointGeometryWorker =
      options.createCopcPointGeometryWorker ??
      createCesiumCopcPointGeometryWorker;
    this.rangeRequestBroker = new CopcWorkerRangeRequestBroker(
      undefined,
      options.rangeGetterOptions,
    );
  }

  planPointDataRanges(
    nodes: readonly {
      readonly key: string;
      readonly pointDataOffset: number;
      readonly pointDataLength: number;
    }[],
  ): ReadonlyMap<string, CopcPointDataPlannedRange> {
    return planCopcPointDataRanges(nodes.map((node) => ({
      nodeKey: node.key,
      pointDataOffset: node.pointDataOffset,
      pointDataLength: node.pointDataLength,
    })), {
      maxGapBytes: this.maxCoalescedPointDataRangeGapBytes,
      maxSpanBytes: this.maxCoalescedPointDataRangeBytes,
    });
  }

  loadNodePointGeometryBatch(options: {
    readonly copc?: CopcData;
    readonly source?: CopcSourceDescriptor;
    readonly url?: string;
    readonly nodeKey: string;
    readonly node: Hierarchy.Node;
    readonly maxPointCount: number;
    readonly transform: CesiumPointGeometryTransform;
    readonly pointColorStyle?: ResolvedCopcPointColorStyle;
    readonly pointDataRange?: CesiumCopcPointGeometryWorkerHalfOpenRange;
    readonly priority?: number;
    readonly signal?: AbortSignal;
  }): Promise<CopcNodePointGeometryBatchResult> | undefined {
    if (this.destroyed || !this.canUseWorker()) {
      return undefined;
    }

    throwIfAborted(options.signal);
    const source = readPointGeometryRequestSource(options);
    this.registerBrokerSource(source);
    const priority = readOptionalFiniteNumber(
      "priority",
      options.priority,
      0,
    );
    const requestOptions = {
      ...options,
      source,
      priority,
    };
    const coalescingKey = createCoalescedGeometryRequestKey(requestOptions);

    return new Promise((resolve, reject) => {
      let entry: PointGeometryWorkerRequestEntry | undefined;
      let consumer: PointGeometryWorkerRequestConsumer;
      const abort = (): void => {
        if (entry) {
          this.cancelRequestConsumer(
            entry,
            consumer,
            createAbortError(options.signal),
          );
        }
      };
      const cleanup = (): void => {
        options.signal?.removeEventListener("abort", abort);
      };

      consumer = {
        kind: "geometry",
        signal: options.signal,
        maxPointCount: options.maxPointCount,
        priority,
        cleanup,
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };

      if (options.signal?.aborted) {
        consumer.reject(createAbortError(options.signal));
        return;
      }

      const existingEntry =
        this.findReusableGeometryRequest(requestOptions);

      if (existingEntry) {
        entry = existingEntry;
        this.addGeometryRequestConsumer(existingEntry, consumer, options);
        options.signal?.addEventListener("abort", abort, { once: true });
        return;
      }

      const id = ++this.requestId;
      const request: CesiumCopcPointGeometryWorkerLoadRequest = {
        id,
        type: "loadNodePointGeometry",
        copc: options.copc,
        source,
        nodeKey: options.nodeKey,
        node: options.node,
        maxPointCount: options.maxPointCount,
        transform: options.transform,
        pointColorStyle: options.pointColorStyle,
        brokeredRangeRequests: this.brokeredRangeRequests,
        pointDataRange: options.pointDataRange,
        maxDecodedPointDataViews: this.maxDecodedPointDataViewsPerWorker,
        maxDecodedPointDataViewBytes:
          this.maxDecodedPointDataViewBytesPerWorker,
      };

      entry = {
        request,
        coalescingKey,
        consumers: [consumer],
        queuedAtMilliseconds: nowMilliseconds(),
        priority,
        state: "queued",
      };

      this.requests.set(id, entry);
      this.coalescedRequests.set(coalescingKey, entry);
      options.signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(entry);
      this.scheduleDrainQueue();
    });
  }

  prefetchNodePointData(options: {
    readonly copc?: CopcData;
    readonly source?: CopcSourceDescriptor;
    readonly url?: string;
    readonly nodeKey: string;
    readonly node: Hierarchy.Node;
    readonly pointDataRange?: CesiumCopcPointGeometryWorkerHalfOpenRange;
    readonly priority?: number;
    readonly signal?: AbortSignal;
  }): Promise<CopcNodePointDataPrefetchResult> | undefined {
    if (this.destroyed || !this.canUseWorker()) {
      return undefined;
    }

    throwIfAborted(options.signal);
    const source = readPointGeometryRequestSource(options);
    this.registerBrokerSource(source);
    const priority = readOptionalFiniteNumber(
      "priority",
      options.priority,
      0,
    );
    const requestOptions = {
      ...options,
      source,
      priority,
    };
    const coalescingKey = createCoalescedPrefetchRequestKey(requestOptions);

    return new Promise((resolve, reject) => {
      let entry: PointGeometryWorkerRequestEntry | undefined;
      let consumer: PointGeometryWorkerPrefetchRequestConsumer;
      const abort = (): void => {
        if (entry) {
          this.cancelRequestConsumer(
            entry,
            consumer,
            createAbortError(options.signal),
          );
        }
      };
      const cleanup = (): void => {
        options.signal?.removeEventListener("abort", abort);
      };

      consumer = {
        kind: "prefetch",
        signal: options.signal,
        priority,
        cleanup,
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };

      if (options.signal?.aborted) {
        consumer.reject(createAbortError(options.signal));
        return;
      }

      const existingEntry = this.coalescedRequests.get(coalescingKey);

      if (
        existingEntry &&
        (existingEntry.state === "queued" || existingEntry.state === "active")
      ) {
        entry = existingEntry;
        existingEntry.consumers.push(consumer);
        existingEntry.priority = Math.max(existingEntry.priority, priority);
        options.signal?.addEventListener("abort", abort, { once: true });
        return;
      }

      const id = ++this.requestId;
      const request: CesiumCopcPointGeometryWorkerPrefetchRequest = {
        id,
        type: "prefetchNodePointData",
        copc: options.copc,
        source,
        nodeKey: options.nodeKey,
        node: options.node,
        brokeredRangeRequests: this.brokeredRangeRequests,
        pointDataRange: options.pointDataRange,
        maxDecodedPointDataViews: this.maxDecodedPointDataViewsPerWorker,
        maxDecodedPointDataViewBytes:
          this.maxDecodedPointDataViewBytesPerWorker,
      };

      entry = {
        request,
        coalescingKey,
        consumers: [consumer],
        queuedAtMilliseconds: nowMilliseconds(),
        priority,
        state: "queued",
      };

      this.requests.set(id, entry);
      this.coalescedRequests.set(coalescingKey, entry);
      options.signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(entry);
      this.scheduleDrainQueue();
    });
  }

  hasDecodedNodePointData(options: {
    readonly source?: CopcSourceDescriptor;
    readonly url?: string;
    readonly nodeKey: string;
  }): boolean {
    if (this.destroyed) {
      return false;
    }

    return this.decodedNodeWorkers.has(createDecodedNodeWorkerKey(options));
  }

  getDecodedPointDataCacheStats(): CopcDecodedPointDataCacheStats {
    const snapshots = [...this.decodedPointDataCacheSnapshots.values()];

    return {
      workerCount: this.workers.length,
      retainedViewCount: sumCacheSnapshots(
        snapshots,
        (snapshot) => snapshot.retainedViewCount,
      ),
      retainedBytes: sumCacheSnapshots(
        snapshots,
        (snapshot) => snapshot.retainedBytes,
      ),
      peakRetainedBytes: this.peakDecodedPointDataRetainedBytes,
      cacheHitCount:
        this.retiredDecodedPointDataCacheHitCount +
        sumCacheSnapshots(snapshots, (snapshot) => snapshot.cacheHitCount),
      cacheMissCount:
        this.retiredDecodedPointDataCacheMissCount +
        sumCacheSnapshots(snapshots, (snapshot) => snapshot.cacheMissCount),
      cacheEvictionCount:
        this.retiredDecodedPointDataCacheEvictionCount +
        sumCacheSnapshots(snapshots, (snapshot) => snapshot.cacheEvictionCount),
      oversizedEntrySkipCount:
        this.retiredOversizedDecodedPointDataEntrySkipCount +
        sumCacheSnapshots(
          snapshots,
          (snapshot) => snapshot.oversizedEntrySkipCount,
        ),
      affinityEntryCount: this.decodedNodeWorkers.size,
      maxDecodedPointDataViewBytesPerWorker:
        this.maxDecodedPointDataViewBytesPerWorker,
      maxDecodedPointDataViewBytesAcrossWorkers:
        this.maxDecodedPointDataViewBytesAcrossWorkers,
    };
  }

  warmUp(options: CesiumCopcPointGeometryWorkerWarmupOptions = {}): void {
    if (this.destroyed || this.pointGeometryLoading !== "integrated-worker") {
      return;
    }

    const workerCount = Math.min(
      options.workerCount ?? this.maxConcurrentPointGeometryWorkerRequests,
      this.maxConcurrentPointGeometryWorkerRequests,
    );

    if (!Number.isSafeInteger(workerCount) || workerCount <= 0) {
      throw new Error("workerCount must be a positive integer.");
    }

    const source = readOptionalPointGeometryRequestSource(options);
    if (source) {
      this.registerBrokerSource(source);
    }

    while (
      !this.workerUnavailable &&
      this.workers.length < workerCount
    ) {
      const worker = this.createAndRegisterWorker();

      if (!worker) {
        return;
      }

      this.workers.push(worker);
    }

    this.lastWarmupOptions = {
      copc: options.copc,
      workerCount,
      source: options.source,
      url: options.url,
    };

    const warmupPromises: Promise<void>[] = [];

    for (const worker of this.workers.slice(0, workerCount)) {
      warmupPromises.push(this.postWarmup(worker, options));
    }

    this.warmupPromise = Promise.allSettled(warmupPromises).then(
      () => undefined,
    );
  }

  async waitForWarmup(): Promise<void> {
    await this.warmupPromise;
  }

  reset(): number {
    if (this.destroyed) {
      return 0;
    }

    const workerCount = this.workers.length;
    const lastWarmupOptions = this.lastWarmupOptions;

    this.terminateAllWorkers(
      new Error("Cesium COPC point geometry worker was reset."),
    );

    if (lastWarmupOptions) {
      this.warmUp(lastWarmupOptions);
    }

    return workerCount;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.terminateAllWorkers(
      new Error("Cesium COPC point geometry worker was terminated."),
    );
    this.rangeRequestBroker.clear();
  }

  private canUseWorker(): boolean {
    if (
      this.pointGeometryLoading !== "integrated-worker" ||
      this.workerUnavailable ||
      this.destroyed
    ) {
      return false;
    }

    if (this.workers.length === 0) {
      const worker = this.createAndRegisterWorker();

      if (worker) {
        this.workers.push(worker);
        this.postLastWarmup(worker);
      } else {
        return false;
      }
    }

    return true;
  }

  private getIdleWorker(
    entry: PointGeometryWorkerRequestEntry,
  ): Worker | undefined {
    const request = entry.request;
    const nodeWorkerKey = createDecodedNodeWorkerKey(request);
    const activeNodeWorker = this.activeNodeWorkers.get(nodeWorkerKey);

    if (activeNodeWorker && this.workers.includes(activeNodeWorker)) {
      if (!this.activeWorkers.has(activeNodeWorker)) {
        return activeNodeWorker;
      }

      return undefined;
    }

    const preferredWorker = this.decodedNodeWorkers.get(nodeWorkerKey);

    if (preferredWorker && this.workers.includes(preferredWorker)) {
      if (!this.activeWorkers.has(preferredWorker)) {
        return preferredWorker;
      }

      if (!this.canBypassBusyDecodedNodeWorker(entry)) {
        return undefined;
      }
    }

    return this.getFallbackIdleWorker();
  }

  private getFallbackIdleWorker(): Worker | undefined {
    const idleWorker = this.workers.find(
      (worker) => !this.activeWorkers.has(worker),
    );

    if (idleWorker) {
      return idleWorker;
    }

    if (this.workers.length < this.maxConcurrentPointGeometryWorkerRequests) {
      const worker = this.createAndRegisterWorker();

      if (worker) {
        this.workers.push(worker);
        this.postLastWarmup(worker);
        return worker;
      }
    }

    return undefined;
  }

  private canBypassBusyDecodedNodeWorker(
    request: PointGeometryWorkerRequestEntry,
  ): boolean {
    const fallbackDelay = this.decodedNodeWorkerFallbackDelayMilliseconds;

    if (fallbackDelay === Number.POSITIVE_INFINITY) {
      return false;
    }

    return nowMilliseconds() - request.queuedAtMilliseconds >= fallbackDelay;
  }

  private createAndRegisterWorker(): Worker | undefined {
    try {
      const worker = this.createCopcPointGeometryWorker();
      worker.addEventListener("message", (event) => {
        this.handleWorkerMessage(
          worker,
          event as MessageEvent<CesiumCopcPointGeometryWorkerOutboundMessage>,
        );
      });
      worker.addEventListener("error", (event) => {
        this.handleWorkerFailure(
          worker,
          event.error instanceof Error
            ? event.error
            : new Error("Cesium COPC point geometry worker failed."),
        );
      });
      return worker;
    } catch {
      if (this.workers.length === 0) {
        this.workerUnavailable = true;
      }
      return undefined;
    }
  }

  private postLastWarmup(worker: Worker): void {
    if (!this.lastWarmupOptions) {
      return;
    }

    this.trackAdditionalWarmup(this.postWarmup(worker, this.lastWarmupOptions));
  }

  private postWarmup(
    worker: Worker,
    options: CesiumCopcPointGeometryWorkerWarmupOptions,
  ): Promise<void> {
    const id = ++this.requestId;
    const promise = new Promise<void>((resolve, reject) => {
      this.warmupRequests.set(id, {
        id,
        worker,
        resolve,
        reject,
      });
    });

    worker.postMessage({
      id,
      type: "warmup",
      copc: options.copc,
      source: options.source,
      url: options.url,
      brokeredRangeRequests: this.brokeredRangeRequests,
    });

    return promise;
  }

  private trackAdditionalWarmup(promise: Promise<void>): void {
    this.warmupPromise = Promise.allSettled([
      this.warmupPromise ?? Promise.resolve(),
      promise,
    ]).then(() => undefined);
  }

  private handleWorkerMessage(
    messageWorker: Worker,
    event: MessageEvent<CesiumCopcPointGeometryWorkerOutboundMessage>,
  ): void {
    const response = event.data;

    if (response.type === "range:request") {
      void this.handleWorkerRangeRequest(messageWorker, response);
      return;
    }

    const completedAtMilliseconds = nowMilliseconds();

    if (
      response.type === "warmup:success" ||
      response.type === "warmup:error"
    ) {
      this.resolveWarmupResponse(response);
      return;
    }

    const request = this.requests.get(response.id);

    if (!request) {
      return;
    }

    const worker = request.worker;
    this.requests.delete(response.id);
    this.coalescedRequests.delete(request.coalescingKey);

    if (
      request.state === "canceled" ||
      response.type === "loadNodePointGeometry:canceled" ||
      response.type === "prefetchNodePointData:canceled"
    ) {
      if (worker) {
        this.applyDecodedPointDataCacheSnapshot(
          worker,
          request.request,
          response.cache,
          response.type === "loadNodePointGeometry:error" ||
            response.type === "prefetchNodePointData:error"
            ? "none"
            : "retained-only",
        );
      }
      this.finishRequest(request);
      if (request.state !== "canceled") {
        this.rejectRequestConsumers(
          request,
          createAbortError(getFirstRequestSignal(request)),
        );
      }
      return;
    }

    if (response.type === "prefetchNodePointData:success") {
      if (worker) {
        this.applyDecodedPointDataCacheSnapshot(
          worker,
          request.request,
          response.cache,
          "success",
        );
      }
      this.finishRequest(request);
      this.resolvePrefetchRequestConsumers(
        request,
        addPrefetchRequestTimingToResult(
          response.result,
          request,
          completedAtMilliseconds,
        ),
      );
      return;
    }

    if (response.type === "loadNodePointGeometry:success") {
      if (worker) {
        this.applyDecodedPointDataCacheSnapshot(
          worker,
          request.request,
          response.cache,
          "success",
        );
      }
      this.finishRequest(request);
      this.resolveRequestConsumers(
        request,
        addRequestTimingToResult(
          response.result,
          request,
          completedAtMilliseconds,
        ),
      );
      return;
    }

    if (worker) {
      this.applyDecodedPointDataCacheSnapshot(
        worker,
        request.request,
        response.cache,
        "none",
      );
    }
    this.finishRequest(request);
    this.rejectRequestConsumers(
      request,
      createErrorFromWorkerResponse(response.error),
    );
  }

  private async handleWorkerRangeRequest(
    worker: Worker,
    request: CesiumCopcPointGeometryWorkerRangeRequestMessage,
  ): Promise<void> {
    try {
      const bytes = await this.rangeRequestBroker.getRange(request);

      if (!this.canPostRangeResponse(worker)) {
        return;
      }

      const buffer = createTransferableArrayBuffer(bytes);
      const response: CesiumCopcPointGeometryWorkerInboundMessage = {
        type: "range:success",
        rangeRequestId: request.rangeRequestId,
        buffer,
      };
      worker.postMessage(response, [buffer]);
    } catch (error) {
      if (!this.canPostRangeResponse(worker)) {
        return;
      }

      const response: CesiumCopcPointGeometryWorkerInboundMessage = {
        type: "range:error",
        rangeRequestId: request.rangeRequestId,
        error: serializeErrorForWorker(error),
      };
      worker.postMessage(response);
    }
  }

  private canPostRangeResponse(worker: Worker): boolean {
    return !this.destroyed && this.workers.includes(worker);
  }

  private registerBrokerSource(source: CopcSourceDescriptor): void {
    if (this.brokeredRangeRequests) {
      this.rangeRequestBroker.registerSource(source);
    }
  }

  private resolveWarmupResponse(
    response:
      | CesiumCopcPointGeometryWorkerWarmupSuccessResponse
      | CesiumCopcPointGeometryWorkerWarmupErrorResponse,
  ): void {
    const warmup = this.warmupRequests.get(response.id);

    if (!warmup) {
      return;
    }

    this.warmupRequests.delete(response.id);

    if (response.type === "warmup:error") {
      warmup.reject(createErrorFromWorkerResponse(response.error));
      return;
    }

    warmup.resolve();
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    const request = [...this.requests.values()].find(
      (entry) => entry.worker === worker,
    );

    for (const [id, warmup] of this.warmupRequests) {
      if (warmup.worker !== worker) {
        continue;
      }

      this.warmupRequests.delete(id);
      warmup.reject(error);
    }

    this.removeWorker(worker);

    if (!request) {
      return;
    }

    this.requests.delete(request.request.id);
    this.coalescedRequests.delete(request.coalescingKey);
    if (request.state !== "canceled") {
      this.rejectRequestConsumers(request, error);
    }
    this.drainQueue();
  }

  private drainQueue(): void {
    this.queueDrainScheduled = false;
    this.clearScheduledDrainTimeout();

    while (this.queue.length > 0) {
      const dispatchableEntry = this.findDispatchableQueuedRequest();

      if (!dispatchableEntry) {
        this.scheduleDrainAfterDecodedWorkerFallbackDelay();
        return;
      }

      const { request, worker } = dispatchableEntry;
      this.removeQueuedRequest(request);

      this.removeAbortedConsumers(request);

      if (request.consumers.length === 0) {
        this.requests.delete(request.request.id);
        this.coalescedRequests.delete(request.coalescingKey);
        continue;
      }

      request.worker = worker;
      request.state = "active";
      request.startedAtMilliseconds = nowMilliseconds();
      this.activeWorkers.add(worker);
      this.activeNodeWorkers.set(
        createDecodedNodeWorkerKey(request.request),
        worker,
      );
      worker.postMessage(request.request);
    }
  }

  private findDispatchableQueuedRequest():
    | {
        readonly request: PointGeometryWorkerRequestEntry;
        readonly worker: Worker;
      }
    | undefined {
    while (this.queue.length > 0) {
      let sawValidQueuedRequest = false;
      let dispatchableEntry:
        | {
            readonly request: PointGeometryWorkerRequestEntry;
            readonly worker: Worker;
          }
        | undefined;

      for (let index = 0; index < this.queue.length; index += 1) {
        const request = this.queue[index];

        if (this.requests.get(request.request.id) !== request) {
          this.coalescedRequests.delete(request.coalescingKey);
          this.queue.splice(index, 1);
          index -= 1;
          continue;
        }

        sawValidQueuedRequest = true;

        const worker = this.getIdleWorker(request);

        if (worker) {
          const nextEntry = {
            request,
            worker,
          };

          if (
            !dispatchableEntry ||
            compareQueuedRequestPriority(
              nextEntry.request,
              dispatchableEntry.request,
            ) < 0
          ) {
            dispatchableEntry = nextEntry;
          }
        }
      }

      if (dispatchableEntry) {
        return dispatchableEntry;
      }

      if (sawValidQueuedRequest) {
        return undefined;
      }
    }

    return undefined;
  }

  private scheduleDrainQueue(): void {
    if (this.queueDrainScheduled) {
      return;
    }

    this.clearScheduledDrainTimeout();
    this.queueDrainScheduled = true;
    queueMicrotask(() => {
      if (this.destroyed) {
        this.queueDrainScheduled = false;
        return;
      }

      this.drainQueue();
    });
  }

  private scheduleDrainAfterDecodedWorkerFallbackDelay(): void {
    if (
      this.queueDrainScheduled ||
      this.queueDrainTimeoutId !== undefined
    ) {
      return;
    }

    const delayMilliseconds =
      this.findNextDecodedWorkerFallbackDelayMilliseconds();

    if (delayMilliseconds === undefined) {
      return;
    }

    this.queueDrainTimeoutId = setTimeout(() => {
      this.queueDrainTimeoutId = undefined;

      if (this.destroyed) {
        return;
      }

      this.drainQueue();
    }, delayMilliseconds);
  }

  private findNextDecodedWorkerFallbackDelayMilliseconds(): number | undefined {
    const fallbackDelay = this.decodedNodeWorkerFallbackDelayMilliseconds;

    if (
      fallbackDelay === Number.POSITIVE_INFINITY ||
      fallbackDelay <= 0 ||
      this.workerUnavailable
    ) {
      return undefined;
    }

    let nextDelay: number | undefined;
    const now = nowMilliseconds();

    for (const request of this.queue) {
      if (
        this.requests.get(request.request.id) !== request ||
        !this.isWaitingForBusyDecodedNodeWorker(request) ||
        !this.hasFallbackWorkerCapacity()
      ) {
        continue;
      }

      const remainingDelay = Math.max(
        0,
        fallbackDelay - (now - request.queuedAtMilliseconds),
      );
      nextDelay =
        nextDelay === undefined
          ? remainingDelay
          : Math.min(nextDelay, remainingDelay);
    }

    return nextDelay;
  }

  private isWaitingForBusyDecodedNodeWorker(
    entry: PointGeometryWorkerRequestEntry,
  ): boolean {
    const request = entry.request;
    const nodeWorkerKey = createDecodedNodeWorkerKey(request);
    const activeNodeWorker = this.activeNodeWorkers.get(nodeWorkerKey);

    if (activeNodeWorker && this.workers.includes(activeNodeWorker)) {
      return false;
    }

    const preferredWorker = this.decodedNodeWorkers.get(nodeWorkerKey);

    return (
      preferredWorker !== undefined &&
      this.workers.includes(preferredWorker) &&
      this.activeWorkers.has(preferredWorker)
    );
  }

  private hasFallbackWorkerCapacity(): boolean {
    return (
      this.workers.some((worker) => !this.activeWorkers.has(worker)) ||
      this.workers.length < this.maxConcurrentPointGeometryWorkerRequests
    );
  }

  private clearScheduledDrainTimeout(): void {
    if (this.queueDrainTimeoutId === undefined) {
      return;
    }

    clearTimeout(this.queueDrainTimeoutId);
    this.queueDrainTimeoutId = undefined;
  }

  private removeQueuedRequest(request: PointGeometryWorkerRequestEntry): void {
    const index = this.queue.indexOf(request);

    if (index !== -1) {
      this.queue.splice(index, 1);
    }
  }

  private finishRequest(request: PointGeometryWorkerRequestEntry): void {
    if (request.state === "active" || request.state === "canceled") {
      this.finishActiveRequest(request);
      this.drainQueue();
    }
  }

  private finishActiveRequest(request: PointGeometryWorkerRequestEntry): void {
    if (request.worker) {
      this.removeActiveNodeWorkerAffinity(request.request, request.worker);
      this.activeWorkers.delete(request.worker);
      request.worker = undefined;
    }
  }

  private cancelRequestConsumer(
    request: PointGeometryWorkerRequestEntry,
    consumer: PointGeometryWorkerRequestConsumer,
    error: Error,
  ): void {
    const consumerIndex = request.consumers.indexOf(consumer);

    if (consumerIndex === -1) {
      return;
    }

    request.consumers.splice(consumerIndex, 1);
    consumer.reject(error);

    if (request.consumers.length > 0) {
      request.priority = Math.max(
        ...request.consumers.map((remaining) => remaining.priority),
      );
      this.resizeQueuedGeometryRequestForConsumers(request);
      return;
    }

    this.coalescedRequests.delete(request.coalescingKey);

    if (request.state === "queued") {
      this.requests.delete(request.request.id);
      this.removeQueuedRequest(request);
    } else {
      this.cancelActiveRequest(request);
    }

    this.drainQueue();
  }

  private removeAbortedConsumers(
    request: PointGeometryWorkerRequestEntry,
  ): void {
    for (let index = 0; index < request.consumers.length; index += 1) {
      const consumer = request.consumers[index];

      if (!consumer.signal?.aborted) {
        continue;
      }

      request.consumers.splice(index, 1);
      index -= 1;
      consumer.reject(createAbortError(consumer.signal));
    }
  }

  private cancelActiveRequest(
    request: PointGeometryWorkerRequestEntry,
  ): void {
    const worker = request.worker;

    if (!worker) {
      return;
    }

    if (
      this.activeRequestCancellation === "terminate" ||
      (this.activeRequestCancellation === "terminate-uncached" &&
        !this.workerHasDecodedNodeData(worker))
    ) {
      this.requests.delete(request.request.id);
      request.state = "canceled";
      request.worker = undefined;
      this.removeWorker(worker);
      return;
    }

    request.state = "canceled";
    worker.postMessage({
      id: request.request.id,
      type: "cancel",
    });
  }

  private workerHasDecodedNodeData(worker: Worker): boolean {
    return [...this.decodedNodeWorkers.values()].some(
      (decodedWorker) => decodedWorker === worker,
    );
  }

  private terminateAllWorkers(error: Error): void {
    const workers = [...this.workers];
    this.workers.length = 0;

    for (const worker of workers) {
      this.retireDecodedPointDataCacheSnapshot(worker);
      worker.terminate();
    }

    for (const request of this.requests.values()) {
      this.rejectRequestConsumers(request, error);
    }

    this.requests.clear();
    this.coalescedRequests.clear();
    this.queue.length = 0;
    for (const warmup of this.warmupRequests.values()) {
      warmup.reject(error);
    }
    this.warmupRequests.clear();
    this.activeWorkers.clear();
    this.activeNodeWorkers.clear();
    this.decodedNodeWorkers.clear();
    this.queueDrainScheduled = false;
    this.clearScheduledDrainTimeout();
  }

  private removeWorker(worker: Worker): void {
    this.activeWorkers.delete(worker);
    this.removeNodeWorkerAffinities(worker);
    this.retireDecodedPointDataCacheSnapshot(worker);

    const workerIndex = this.workers.indexOf(worker);
    if (workerIndex !== -1) {
      this.workers.splice(workerIndex, 1);
    }

    worker.terminate();
  }

  private removeNodeWorkerAffinities(worker: Worker): void {
    for (const [key, activeWorker] of this.activeNodeWorkers) {
      if (activeWorker === worker) {
        this.activeNodeWorkers.delete(key);
      }
    }

    for (const [key, decodedWorker] of this.decodedNodeWorkers) {
      if (decodedWorker === worker) {
        this.decodedNodeWorkers.delete(key);
      }
    }
  }

  private applyDecodedPointDataCacheSnapshot(
    worker: Worker,
    request: CesiumCopcPointGeometryWorkerWorkRequest,
    snapshot: CopcDecodedPointDataCacheSnapshot | undefined,
    affinityMode: "success" | "retained-only" | "none",
  ): void {
    const requestedKey = createDecodedNodeWorkerKey(request);

    if (!snapshot) {
      if (affinityMode === "success") {
        this.decodedNodeWorkers.set(requestedKey, worker);
      }
      return;
    }

    this.decodedPointDataCacheSnapshots.set(worker, snapshot);

    for (const evicted of snapshot.evictedNodeKeys) {
      const evictedKey = createDecodedNodeWorkerKeyFromParts(
        evicted.sourceKey,
        evicted.nodeKey,
      );

      if (this.decodedNodeWorkers.get(evictedKey) === worker) {
        this.decodedNodeWorkers.delete(evictedKey);
      }
    }

    if (snapshot.requestedNodeRetained && affinityMode !== "none") {
      this.decodedNodeWorkers.set(requestedKey, worker);
    } else if (
      !snapshot.requestedNodeRetained &&
      this.decodedNodeWorkers.get(requestedKey) === worker
    ) {
      this.decodedNodeWorkers.delete(requestedKey);
    }

    const retainedBytes = sumCacheSnapshots(
      [...this.decodedPointDataCacheSnapshots.values()],
      (workerSnapshot) => workerSnapshot.retainedBytes,
    );
    this.peakDecodedPointDataRetainedBytes = Math.max(
      this.peakDecodedPointDataRetainedBytes,
      retainedBytes,
    );
  }

  private retireDecodedPointDataCacheSnapshot(worker: Worker): void {
    const snapshot = this.decodedPointDataCacheSnapshots.get(worker);

    if (!snapshot) {
      return;
    }

    this.decodedPointDataCacheSnapshots.delete(worker);
    this.retiredDecodedPointDataCacheHitCount += snapshot.cacheHitCount;
    this.retiredDecodedPointDataCacheMissCount += snapshot.cacheMissCount;
    this.retiredDecodedPointDataCacheEvictionCount +=
      snapshot.cacheEvictionCount;
    this.retiredOversizedDecodedPointDataEntrySkipCount +=
      snapshot.oversizedEntrySkipCount;
  }

  private removeActiveNodeWorkerAffinity(
    request: CesiumCopcPointGeometryWorkerWorkRequest,
    worker: Worker,
  ): void {
    const key = createDecodedNodeWorkerKey(request);

    if (this.activeNodeWorkers.get(key) === worker) {
      this.activeNodeWorkers.delete(key);
    }
  }

  private resolveRequestConsumers(
    request: PointGeometryWorkerRequestEntry,
    result: CopcNodePointGeometryBatchResult,
  ): void {
    const consumers = request.consumers.splice(0);

    for (const consumer of consumers) {
      if (consumer.kind === "geometry") {
        consumer.resolve(
          downsampleGeometryBatchResult(result, consumer.maxPointCount),
        );
        continue;
      }

      consumer.resolve({
        nodeKey: result.pointSamples.nodeKey,
        timing: result.timing
          ? {
              pointDataViewMilliseconds:
                result.timing.pointDataViewMilliseconds,
              pointDataViewCacheHit: result.timing.pointDataViewCacheHit,
              pointDataViewRangeWaitMilliseconds:
                result.timing.pointDataViewRangeWaitMilliseconds,
              pointDataViewRangeRequestCount:
                result.timing.pointDataViewRangeRequestCount,
              pointDataViewRangeBytes:
                result.timing.pointDataViewRangeBytes,
              pointDataViewLazPerfMilliseconds:
                result.timing.pointDataViewLazPerfMilliseconds,
              pointDataViewNonRangeMilliseconds:
                result.timing.pointDataViewNonRangeMilliseconds,
              pointDataViewCacheWaitMilliseconds:
                result.timing.pointDataViewCacheWaitMilliseconds,
              workerTotalMilliseconds: result.timing.workerTotalMilliseconds,
            }
          : undefined,
      });
    }
  }

  private resolvePrefetchRequestConsumers(
    request: PointGeometryWorkerRequestEntry,
    result: CopcNodePointDataPrefetchResult,
  ): void {
    const consumers = request.consumers.splice(0);

    for (const consumer of consumers) {
      if (consumer.kind === "prefetch") {
        consumer.resolve(result);
        continue;
      }

      consumer.reject(
        new Error("COPC geometry request resolved without geometry data."),
      );
    }
  }

  private rejectRequestConsumers(
    request: PointGeometryWorkerRequestEntry,
    error: Error,
  ): void {
    const consumers = request.consumers.splice(0);

    for (const consumer of consumers) {
      consumer.reject(error);
    }
  }

  private findReusableGeometryRequest(options: {
    readonly source: CopcSourceDescriptor;
    readonly nodeKey: string;
    readonly maxPointCount: number;
    readonly priority: number;
    readonly transform: CesiumPointGeometryTransform;
    readonly pointColorStyle?: ResolvedCopcPointColorStyle;
  }): PointGeometryWorkerGeometryRequestEntry | undefined {
    const exactEntry = this.coalescedRequests.get(
      createCoalescedGeometryRequestKey(options),
    );

    if (
      exactEntry &&
      isGeometryRequestEntry(exactEntry) &&
      (exactEntry.state === "queued" || exactEntry.state === "active")
    ) {
      return exactEntry;
    }

    const sameNodeRequests = [...this.requests.values()].filter(
      (request): request is PointGeometryWorkerGeometryRequestEntry =>
        isGeometryRequestEntry(request) &&
        isCompatibleGeometryRequest(request, options),
    );
    const sufficientRequest = sameNodeRequests
      .filter(
        (request) =>
          (request.state === "queued" || request.state === "active") &&
          request.request.maxPointCount >= options.maxPointCount,
      )
      .sort(
        (left, right) =>
          left.request.maxPointCount - right.request.maxPointCount ||
          left.queuedAtMilliseconds - right.queuedAtMilliseconds,
      )[0];

    if (sufficientRequest) {
      return sufficientRequest;
    }

    return sameNodeRequests
      .filter(
        (request) =>
          request.state === "queued" &&
          request.request.maxPointCount < options.maxPointCount &&
          request.priority <= options.priority,
      )
      .sort(
        (left, right) =>
          right.request.maxPointCount - left.request.maxPointCount ||
          left.queuedAtMilliseconds - right.queuedAtMilliseconds,
      )[0];
  }

  private addGeometryRequestConsumer(
    request: PointGeometryWorkerGeometryRequestEntry,
    consumer: PointGeometryWorkerGeometryRequestConsumer,
    options: {
      readonly maxPointCount: number;
      readonly node: Hierarchy.Node;
    },
  ): void {
    request.consumers.push(consumer);
    request.priority = Math.max(request.priority, consumer.priority);

    if (
      request.state === "queued" &&
      request.request.maxPointCount < options.maxPointCount
    ) {
      this.updateQueuedGeometryRequestPointCount(
        request,
        options.maxPointCount,
        options.node,
      );
    }
  }

  private resizeQueuedGeometryRequestForConsumers(
    request: PointGeometryWorkerRequestEntry,
  ): void {
    if (
      request.state !== "queued" ||
      request.request.type !== "loadNodePointGeometry" ||
      request.consumers.length === 0
    ) {
      return;
    }

    const geometryConsumers = request.consumers.filter(
      (
        consumer,
      ): consumer is PointGeometryWorkerGeometryRequestConsumer =>
        consumer.kind === "geometry",
    );

    if (geometryConsumers.length === 0) {
      return;
    }

    const maxPointCount = Math.max(
      ...geometryConsumers.map((consumer) => consumer.maxPointCount),
    );

    if (maxPointCount !== request.request.maxPointCount) {
      this.updateQueuedGeometryRequestPointCount(
        request,
        maxPointCount,
        request.request.node,
      );
    }
  }

  private updateQueuedGeometryRequestPointCount(
    request: PointGeometryWorkerRequestEntry,
    maxPointCount: number,
    node: Hierarchy.Node,
  ): void {
    if (request.request.type !== "loadNodePointGeometry") {
      return;
    }

    const previousCoalescingKey = request.coalescingKey;

    request.request = {
      ...request.request,
      node,
      maxPointCount,
    };
    request.coalescingKey = createCoalescedGeometryRequestKey(request.request);
    this.coalescedRequests.delete(previousCoalescingKey);
    this.coalescedRequests.set(request.coalescingKey, request);
  }
}

function createDecodedNodeWorkerKey(
  request: {
    readonly source?: CopcSourceDescriptor;
    readonly url?: string;
    readonly nodeKey: string;
  },
): string {
  return createDecodedNodeWorkerKeyFromParts(
    readPointGeometryRequestSource(request).key,
    request.nodeKey,
  );
}

function createDecodedNodeWorkerKeyFromParts(
  sourceKey: string,
  nodeKey: string,
): string {
  return `${sourceKey}\n${nodeKey}`;
}

function readPointGeometryRequestSource(options: {
  readonly source?: CopcSourceDescriptor;
  readonly url?: string;
}): CopcSourceDescriptor {
  if (options.source) {
    return options.source;
  }

  if (options.url) {
    return createCopcSourceDescriptor(options.url);
  }

  throw new Error("COPC point geometry worker requests require a source or url.");
}

function readOptionalPointGeometryRequestSource(options: {
  readonly source?: CopcSourceDescriptor;
  readonly url?: string;
}): CopcSourceDescriptor | undefined {
  if (options.source) {
    return options.source;
  }

  if (options.url) {
    return createCopcSourceDescriptor(options.url);
  }

  return undefined;
}

function createCoalescedGeometryRequestKey(options: {
  readonly source?: CopcSourceDescriptor;
  readonly url?: string;
  readonly nodeKey: string;
  readonly maxPointCount: number;
  readonly transform: CesiumPointGeometryTransform;
  readonly pointColorStyle?: ResolvedCopcPointColorStyle;
}): string {
  return [
    readPointGeometryRequestSource(options).key,
    options.nodeKey,
    options.maxPointCount,
    options.transform.kind,
    options.transform.heightScaleToMeters,
    options.transform.sourceCrs ?? "",
    options.transform.sourceDefinition ?? "",
    options.transform.targetCrs ?? "",
    options.transform.targetDefinition ?? "",
    createPointColorStyleKey(options.pointColorStyle),
  ].join("\n");
}

function createCoalescedPrefetchRequestKey(options: {
  readonly source?: CopcSourceDescriptor;
  readonly url?: string;
  readonly nodeKey: string;
}): string {
  return [
    readPointGeometryRequestSource(options).key,
    options.nodeKey,
    "prefetchNodePointData",
  ].join("\n");
}

function isCompatibleGeometryRequest(
  request: PointGeometryWorkerRequestEntry,
  options: {
    readonly source: CopcSourceDescriptor;
    readonly nodeKey: string;
    readonly transform: CesiumPointGeometryTransform;
    readonly pointColorStyle?: ResolvedCopcPointColorStyle;
  },
): boolean {
  if (request.request.type !== "loadNodePointGeometry") {
    return false;
  }

  const requestSource = readPointGeometryRequestSource(request.request);

  return (
    requestSource.key === options.source.key &&
    request.request.nodeKey === options.nodeKey &&
    request.request.transform.kind === options.transform.kind &&
    request.request.transform.heightScaleToMeters ===
      options.transform.heightScaleToMeters &&
    request.request.transform.sourceCrs === options.transform.sourceCrs &&
    request.request.transform.sourceDefinition ===
      options.transform.sourceDefinition &&
    request.request.transform.targetCrs === options.transform.targetCrs &&
    request.request.transform.targetDefinition ===
      options.transform.targetDefinition &&
    createPointColorStyleKey(request.request.pointColorStyle) ===
      createPointColorStyleKey(options.pointColorStyle)
  );
}

function createPointColorStyleKey(
  style: ResolvedCopcPointColorStyle | undefined,
): string {
  if (style?.mode === "elevation") {
    return `elevation:${style.minimumZ}:${style.inverseZRange}`;
  }

  return "attribute";
}

function isGeometryRequestEntry(
  request: PointGeometryWorkerRequestEntry,
): request is PointGeometryWorkerGeometryRequestEntry {
  return request.request.type === "loadNodePointGeometry";
}

function getFirstRequestSignal(
  request: PointGeometryWorkerRequestEntry,
): AbortSignal | undefined {
  return request.consumers.find((consumer) => consumer.signal)?.signal;
}

function addRequestTimingToResult(
  result: CopcNodePointGeometryBatchResult,
  request: PointGeometryWorkerRequestEntry,
  completedAtMilliseconds: number,
): CopcNodePointGeometryBatchResult {
  const startedAtMilliseconds =
    request.startedAtMilliseconds ?? completedAtMilliseconds;

  return {
    ...result,
    timing: {
      pointDataViewMilliseconds: result.timing?.pointDataViewMilliseconds ?? 0,
      pointDataViewCacheHit: result.timing?.pointDataViewCacheHit ?? false,
      pointDataViewRangeWaitMilliseconds:
        result.timing?.pointDataViewRangeWaitMilliseconds ?? 0,
      pointDataViewRangeRequestCount:
        result.timing?.pointDataViewRangeRequestCount ?? 0,
      pointDataViewRangeBytes: result.timing?.pointDataViewRangeBytes ?? 0,
      pointDataViewLazPerfMilliseconds:
        result.timing?.pointDataViewLazPerfMilliseconds ?? 0,
      pointDataViewNonRangeMilliseconds:
        result.timing?.pointDataViewNonRangeMilliseconds ?? 0,
      pointDataViewCacheWaitMilliseconds:
        result.timing?.pointDataViewCacheWaitMilliseconds ?? 0,
      sampleMilliseconds: result.timing?.sampleMilliseconds ?? 0,
      geometryMilliseconds: result.timing?.geometryMilliseconds ?? 0,
      workerTotalMilliseconds: result.timing?.workerTotalMilliseconds ?? 0,
      requestQueueMilliseconds: Math.max(
        0,
        startedAtMilliseconds - request.queuedAtMilliseconds,
      ),
      requestRoundTripMilliseconds: Math.max(
        0,
        completedAtMilliseconds - request.queuedAtMilliseconds,
      ),
    },
  };
}

function addPrefetchRequestTimingToResult(
  result: CopcNodePointDataPrefetchResult,
  request: PointGeometryWorkerRequestEntry,
  completedAtMilliseconds: number,
): CopcNodePointDataPrefetchResult {
  const startedAtMilliseconds =
    request.startedAtMilliseconds ?? completedAtMilliseconds;

  return {
    ...result,
    timing: {
      pointDataViewMilliseconds:
        result.timing?.pointDataViewMilliseconds ?? 0,
      pointDataViewCacheHit: result.timing?.pointDataViewCacheHit ?? false,
      pointDataViewRangeWaitMilliseconds:
        result.timing?.pointDataViewRangeWaitMilliseconds ?? 0,
      pointDataViewRangeRequestCount:
        result.timing?.pointDataViewRangeRequestCount ?? 0,
      pointDataViewRangeBytes: result.timing?.pointDataViewRangeBytes ?? 0,
      pointDataViewLazPerfMilliseconds:
        result.timing?.pointDataViewLazPerfMilliseconds ?? 0,
      pointDataViewNonRangeMilliseconds:
        result.timing?.pointDataViewNonRangeMilliseconds ?? 0,
      pointDataViewCacheWaitMilliseconds:
        result.timing?.pointDataViewCacheWaitMilliseconds ?? 0,
      workerTotalMilliseconds: result.timing?.workerTotalMilliseconds ?? 0,
      requestQueueMilliseconds: Math.max(
        0,
        startedAtMilliseconds - request.queuedAtMilliseconds,
      ),
      requestRoundTripMilliseconds: Math.max(
        0,
        completedAtMilliseconds - request.queuedAtMilliseconds,
      ),
    },
  };
}

function downsampleGeometryBatchResult(
  result: CopcNodePointGeometryBatchResult,
  maxPointCount: number,
): CopcNodePointGeometryBatchResult {
  const sourcePointCount = result.geometryBatch.pointCount;
  const sampledPointCount = Math.min(sourcePointCount, maxPointCount);

  if (sampledPointCount >= sourcePointCount) {
    return result;
  }

  const positions = result.geometryBatch.positions.slice(
    0,
    sampledPointCount * 3,
  );
  const colors = result.geometryBatch.colors.slice(0, sampledPointCount * 4);

  return {
    ...result,
    pointSamples: {
      ...result.pointSamples,
      sampledPointCount,
      points: [],
    },
    geometryBatch: {
      ...result.geometryBatch,
      key: `${result.geometryBatch.key}:downsampled:${sampledPointCount}`,
      pointCount: sampledPointCount,
      positions,
      colors,
      pointDensityScale:
        result.geometryBatch.pointDensityScale === undefined
          ? undefined
          : result.geometryBatch.pointDensityScale *
            (sampledPointCount / sourcePointCount),
    },
  };
}

function nowMilliseconds(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function sumCacheSnapshots(
  snapshots: readonly CopcDecodedPointDataCacheSnapshot[],
  select: (snapshot: CopcDecodedPointDataCacheSnapshot) => number,
): number {
  return snapshots.reduce(
    (total, snapshot) => total + select(snapshot),
    0,
  );
}

function readOptionalPositiveInteger(
  name: string,
  value: number | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

function readOptionalNonNegativeNumber(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (
    value !== Number.POSITIVE_INFINITY &&
    (!Number.isFinite(value) || value < 0)
  ) {
    throw new Error(`${name} must be a non-negative number.`);
  }

  return value;
}

function readOptionalNonNegativeSafeInteger(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  const resolved = value ?? fallback;

  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }

  return resolved;
}

function readOptionalFiniteNumber(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }

  return value;
}

function compareQueuedRequestPriority(
  left: PointGeometryWorkerRequestEntry,
  right: PointGeometryWorkerRequestEntry,
): number {
  return (
    right.priority - left.priority ||
    left.queuedAtMilliseconds - right.queuedAtMilliseconds ||
    left.request.id - right.request.id
  );
}

function createErrorFromWorkerResponse(error: {
  readonly name?: string;
  readonly message: string;
  readonly stack?: string;
}): Error {
  const restoredError = new Error(error.message);
  restoredError.name = error.name ?? "Error";
  restoredError.stack = error.stack;
  return restoredError;
}

function serializeErrorForWorker(
  error: unknown,
): CesiumCopcPointGeometryWorkerSerializedError {
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

function createTransferableArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }

  return bytes.slice().buffer;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  throw createAbortError(signal);
}

function createAbortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }

  if (typeof DOMException !== "undefined") {
    return new DOMException(
      "Cesium COPC point geometry request was aborted.",
      "AbortError",
    );
  }

  const error = new Error("Cesium COPC point geometry request was aborted.");
  error.name = "AbortError";
  return error;
}
