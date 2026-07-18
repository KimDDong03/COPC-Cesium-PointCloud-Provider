import { Copc } from "copc";
import type { Copc as CopcData, Getter, Hierarchy } from "copc";
import {
  consumeSharedAbortableTask,
  createSharedAbortableTask,
  isReusableSharedAbortableTask,
  type SharedAbortableTask,
} from "../SharedAbortableTask";
import {
  createCopcRangeGetter,
  createCopcSourceDescriptor,
  createCopcSourceLabel,
  type CopcRangeGetterOptions,
  type CopcSourceDescriptor,
  type CopcSourceInput,
} from "./createCopcRangeGetter";
import { createCopcPointSampleWorker } from "./createCopcPointSampleWorker";
import { loadCopcNodePointSamples } from "./loadCopcNodePointSamples";
import type {
  CopcPointSampleWorkerLoadRequest,
  CopcPointSampleWorkerResponse,
} from "./CopcPointSampleWorkerProtocol";
import {
  calculateEffectiveDecodedPointDataViewBytesPerWorker,
  DEFAULT_MAX_CONCURRENT_POINT_SAMPLE_WORKER_REQUESTS,
  type CopcDecodedPointDataCacheSnapshot,
  type CopcDecodedPointDataCacheStats,
} from "./CopcDecodedPointDataCache";
import type {
  CopcHierarchyCacheStats,
  CopcHierarchyPageReference,
  CopcHierarchyNodeSummary,
  CopcHierarchySummary,
} from "./CopcHierarchySummary";
import type {
  CopcBounds,
  CopcInspection,
  CopcVlrSummary,
} from "./CopcInspection";
import type {
  CopcMultiNodePointSampleResult,
  CopcNodePointSampleResult,
  CopcPointDataSampleArrays,
  CopcPointDataSample,
  CopcPointSampleCacheStats,
  CopcPointSampleFormat,
} from "./CopcPointDataSample";

export type { CopcSourceDescriptor, CopcSourceInput };

export interface LoadNodePointSamplesOptions {
  readonly nodeKey?: string;
  readonly maxPointCount?: number;
  readonly sampleFormat?: CopcPointSampleFormat;
  readonly requestPriority?: number;
  readonly signal?: AbortSignal;
}

export interface LoadNodesPointSamplesOptions {
  readonly nodeKeys: readonly string[];
  readonly maxPointCountPerNode?: number;
  readonly maxTotalSampledPointCount?: number;
  readonly sampleFormat?: CopcPointSampleFormat;
  readonly requestPriority?: number;
  readonly signal?: AbortSignal;
}

export interface LoadHierarchyPagesResult {
  readonly hierarchy: CopcHierarchySummary;
  readonly loadedPageKeys: readonly string[];
}

export interface LoadHierarchyOptions {
  readonly signal?: AbortSignal;
}

export interface CopcSourceOptions {
  readonly rangeGetterOptions?: CopcRangeGetterOptions;
  readonly maxCachedHierarchyPages?: number;
  readonly maxCachedHierarchyPageBytes?: number;
  readonly maxCachedSampleSets?: number;
  readonly maxCachedPointSampleBytes?: number;
  readonly maxDecodedPointDataViewsPerWorker?: number;
  readonly maxDecodedPointDataViewBytesPerWorker?: number;
  readonly maxDecodedPointDataViewBytesAcrossWorkers?: number;
  readonly maxConcurrentPointSampleWorkerRequests?: number;
  readonly pointSampleLoading?: CopcPointSampleLoadingMode;
  readonly createPointSampleWorker?: () => Worker;
}

export interface CopcPointSampleWorkerWarmupOptions {
  readonly workerCount?: number;
}

export type CopcPointSampleLoadingMode = "main-thread" | "worker";

const DEFAULT_MAX_POINT_COUNT = 5_000;
const DEFAULT_NODE_KEY = "0-0-0-0";
const DEFAULT_MAX_CACHED_HIERARCHY_PAGES = 64;
const DEFAULT_MAX_CACHED_HIERARCHY_PAGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_CACHED_SAMPLE_SETS = 32;
const DEFAULT_MAX_CACHED_POINT_SAMPLE_BYTES = 32 * 1024 * 1024;
const POINT_SAMPLE_COORDINATE_BYTES = 3 * 8;
const POINT_SAMPLE_COLOR_BYTES = 3;
const POINT_SAMPLE_CLASSIFICATION_BYTES = 1;
const POINT_SAMPLE_INTENSITY_BYTES = 2;

interface PointSampleCacheEntry {
  readonly task: SharedAbortableTask<CopcNodePointSampleResult>;
  readonly nodeKey: string;
  readonly maxPointCount: number;
  readonly sampleFormat: CopcPointSampleFormat;
  readonly priority: PointSamplePriorityHandle;
  estimatedByteSize: number;
}

interface PointSamplePriorityHandle {
  value: number;
}

interface HierarchyPageCacheEntry {
  readonly page: Hierarchy.Page;
  readonly pageKey?: string;
  readonly parentPageId?: string;
  readonly isRoot: boolean;
}

interface PointSampleWorkerRequestEntry {
  worker?: Worker;
  request: CopcPointSampleWorkerLoadRequest;
  readonly consumers: PointSampleWorkerRequestConsumer[];
  priority: number;
  state: "queued" | "active";
}

interface PointSampleWorkerRequestConsumer {
  readonly signal?: AbortSignal;
  readonly maxPointCount: number;
  priority: number;
  readonly cleanup: () => void;
  readonly resolve: (result: CopcNodePointSampleResult) => void;
  readonly reject: (error: unknown) => void;
}

export class CopcSource {
  readonly url: string;
  readonly input: CopcSourceInput;
  readonly sourceKey: string;

  private readonly maxCachedSampleSets: number;
  private readonly maxCachedPointSampleBytes: number;
  private readonly maxCachedHierarchyPages: number;
  private readonly maxCachedHierarchyPageBytes: number;
  private readonly maxDecodedPointDataViewsPerWorker: number | undefined;
  private readonly maxDecodedPointDataViewBytesPerWorker: number | undefined;
  private readonly maxDecodedPointDataViewBytesAcrossWorkers: number | undefined;
  private readonly maxConcurrentPointSampleWorkerRequests: number;
  private readonly pointSampleLoading: CopcPointSampleLoadingMode;
  private readonly createPointSampleWorker: () => Worker;
  private readonly getter: Getter;
  private copcPromise: Promise<CopcData> | undefined;
  private loadedCopcMetadata: CopcData | undefined;
  private hierarchyPromise: Promise<Hierarchy.Subtree> | undefined;
  private inspectionPromise: Promise<CopcInspection> | undefined;
  private readonly hierarchyPagePromises = new Map<
    string,
    Promise<Hierarchy.Subtree>
  >();
  private readonly hierarchyPageLoadTasks = new Map<
    string,
    SharedAbortableTask<void>
  >();
  private readonly loadedHierarchyPages = new Map<
    string,
    HierarchyPageCacheEntry
  >();
  private readonly hierarchyNodePageIds = new Map<string, string>();
  private readonly hierarchyPendingPageIds = new Map<string, string>();
  private readonly nodePointSampleCache = new Map<
    string,
    PointSampleCacheEntry
  >();
  private readonly pointSampleWorkerRequests = new Map<
    number,
    PointSampleWorkerRequestEntry
  >();
  private readonly pointSampleWorkerQueue: PointSampleWorkerRequestEntry[] = [];
  private readonly activeNodePointSampleWorkers = new Map<string, Worker>();
  private readonly decodedNodePointSampleWorkers = new Map<string, Worker>();
  private readonly decodedPointDataCacheSnapshots = new Map<
    Worker,
    CopcDecodedPointDataCacheSnapshot
  >();
  private cachedPointSampleBytes = 0;
  private cachedHierarchyPageBytes = 0;
  private hierarchyPageCacheEvictionCount = 0;
  private pointSampleCacheHitCount = 0;
  private pointSampleCacheMissCount = 0;
  private pointSampleCacheEvictionCount = 0;
  private readonly pointSampleWorkers: Worker[] = [];
  private readonly activePointSampleWorkers = new Set<Worker>();
  private pointSampleWorkerUnavailable = false;
  private pointSampleWorkerRequestId = 0;
  private peakDecodedPointDataRetainedBytes = 0;
  private retiredDecodedPointDataCacheHitCount = 0;
  private retiredDecodedPointDataCacheMissCount = 0;
  private retiredDecodedPointDataCacheEvictionCount = 0;
  private retiredOversizedDecodedPointDataEntrySkipCount = 0;

  private readonly sourceDescriptor: CopcSourceDescriptor;

  constructor(input: CopcSourceInput, options: CopcSourceOptions = {}) {
    const maxCachedHierarchyPages =
      options.maxCachedHierarchyPages ?? DEFAULT_MAX_CACHED_HIERARCHY_PAGES;
    const maxCachedHierarchyPageBytes =
      options.maxCachedHierarchyPageBytes ??
      DEFAULT_MAX_CACHED_HIERARCHY_PAGE_BYTES;
    const maxCachedSampleSets =
      options.maxCachedSampleSets ?? DEFAULT_MAX_CACHED_SAMPLE_SETS;
    const maxCachedPointSampleBytes =
      options.maxCachedPointSampleBytes ??
      DEFAULT_MAX_CACHED_POINT_SAMPLE_BYTES;
    const maxConcurrentPointSampleWorkerRequests =
      options.maxConcurrentPointSampleWorkerRequests ??
      DEFAULT_MAX_CONCURRENT_POINT_SAMPLE_WORKER_REQUESTS;

    if (
      !Number.isSafeInteger(maxCachedHierarchyPages) ||
      maxCachedHierarchyPages <= 0
    ) {
      throw new Error("maxCachedHierarchyPages must be a positive integer.");
    }

    if (
      !Number.isSafeInteger(maxCachedHierarchyPageBytes) ||
      maxCachedHierarchyPageBytes <= 0
    ) {
      throw new Error(
        "maxCachedHierarchyPageBytes must be a positive integer.",
      );
    }

    if (
      !Number.isSafeInteger(maxCachedSampleSets) ||
      maxCachedSampleSets <= 0
    ) {
      throw new Error("maxCachedSampleSets must be a positive integer.");
    }

    if (
      !Number.isSafeInteger(maxCachedPointSampleBytes) ||
      maxCachedPointSampleBytes <= 0
    ) {
      throw new Error("maxCachedPointSampleBytes must be a positive integer.");
    }

    if (
      !Number.isSafeInteger(maxConcurrentPointSampleWorkerRequests) ||
      maxConcurrentPointSampleWorkerRequests <= 0
    ) {
      throw new Error(
        "maxConcurrentPointSampleWorkerRequests must be a positive integer.",
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
        maxConcurrentPointSampleWorkerRequests,
      );
    if (
      options.pointSampleLoading !== undefined &&
      options.pointSampleLoading !== "main-thread" &&
      options.pointSampleLoading !== "worker"
    ) {
      throw new Error(
        "pointSampleLoading must be either 'main-thread' or 'worker'.",
      );
    }

    this.input = input;
    this.sourceDescriptor = createCopcSourceDescriptor(input);
    this.sourceKey = this.sourceDescriptor.key;
    this.url = createCopcSourceLabel(input);
    this.maxCachedHierarchyPages = maxCachedHierarchyPages;
    this.maxCachedHierarchyPageBytes = maxCachedHierarchyPageBytes;
    this.maxCachedSampleSets = maxCachedSampleSets;
    this.maxCachedPointSampleBytes = maxCachedPointSampleBytes;
    this.maxConcurrentPointSampleWorkerRequests =
      maxConcurrentPointSampleWorkerRequests;
    this.pointSampleLoading =
      options.pointSampleLoading ??
      (options.createPointSampleWorker ? "worker" : "main-thread");
    this.createPointSampleWorker =
      options.createPointSampleWorker ?? createCopcPointSampleWorker;
    this.getter = createCopcRangeGetter(input, options.rangeGetterOptions);
  }

  getDescriptor(): CopcSourceDescriptor {
    return this.sourceDescriptor;
  }

  getLoadedCopcMetadata(): CopcData | undefined {
    return this.loadedCopcMetadata;
  }

  inspect(): Promise<CopcInspection> {
    let promise = this.inspectionPromise;

    if (!promise) {
      promise = this.loadCopc().then((copc) => createInspection(this.url, copc));
      this.inspectionPromise = promise;
      void promise.catch(() => {
        if (this.inspectionPromise === promise) {
          this.inspectionPromise = undefined;
        }
      });
    }

    return promise;
  }

  async loadHierarchySummary(
    options: LoadHierarchyOptions = {},
  ): Promise<CopcHierarchySummary> {
    throwIfAborted(options.signal);
    const [copc, hierarchy] = await withCallerAbortSignal(
      Promise.all([this.loadCopc(), this.loadHierarchy()]),
      options.signal,
    );
    throwIfAborted(options.signal);

    return summarizeHierarchy(
      hierarchy,
      copc.info.cube,
      this.loadedHierarchyPages.size,
      this.hierarchyNodePageIds,
      this.hierarchyPendingPageIds,
    );
  }

  async loadHierarchyPage(
    pageKey: string,
    options: LoadHierarchyOptions = {},
  ): Promise<CopcHierarchySummary> {
    throwIfAborted(options.signal);
    const [copc, hierarchy] = await withCallerAbortSignal(
      Promise.all([this.loadCopc(), this.loadHierarchy()]),
      options.signal,
    );
    throwIfAborted(options.signal);
    const page = hierarchy.pages[pageKey];

    if (!page) {
      if (hierarchy.nodes[pageKey]) {
        this.touchLoadedHierarchyPage(this.hierarchyNodePageIds.get(pageKey));

        return summarizeHierarchy(
          hierarchy,
          copc.info.cube,
          this.loadedHierarchyPages.size,
          this.hierarchyNodePageIds,
          this.hierarchyPendingPageIds,
        );
      }

      throw new Error(`COPC hierarchy page was not found: ${pageKey}`);
    }

    const pageId = hierarchyPageId(page);
    let loadTask = this.hierarchyPageLoadTasks.get(pageId);

    if (!loadTask || !isReusableSharedAbortableTask(loadTask)) {
      loadTask = createSharedAbortableTask(async (signal) => {
        const subtree = await this.loadHierarchyPageData(page);
        throwIfAborted(signal);

        const pendingPage = hierarchy.pages[pageKey];

        if (!pendingPage) {
          if (hierarchy.nodes[pageKey]) {
            this.touchLoadedHierarchyPage(pageId);
            return;
          }

          throw new Error(
            `COPC hierarchy page disappeared while loading: ${pageKey}`,
          );
        }

        if (hierarchyPageId(pendingPage) !== pageId) {
          throw new Error(
            `COPC hierarchy page changed while loading: ${pageKey}`,
          );
        }

        const parentPageId = this.hierarchyPendingPageIds.get(pageKey);
        delete hierarchy.pages[pageKey];
        this.hierarchyPendingPageIds.delete(pageKey);
        this.recordHierarchyProvenance(subtree, pendingPage);
        mergeHierarchy(hierarchy, subtree);
        this.rememberLoadedHierarchyPage(pendingPage, {
          pageKey,
          parentPageId,
        });
        this.evictHierarchyPagesIfNeeded(hierarchy);
      });
      this.hierarchyPageLoadTasks.set(pageId, loadTask);
      const createdTask = loadTask;
      void createdTask.promise.catch(() => {
        if (this.hierarchyPageLoadTasks.get(pageId) === createdTask) {
          this.hierarchyPageLoadTasks.delete(pageId);
        }
      });
    }

    await consumeSharedAbortableTask(loadTask, options.signal);
    throwIfAborted(options.signal);

    return summarizeHierarchy(
      hierarchy,
      copc.info.cube,
      this.loadedHierarchyPages.size,
      this.hierarchyNodePageIds,
      this.hierarchyPendingPageIds,
    );
  }

  async loadHierarchyPages(
    pageKeys: readonly string[],
    options: LoadHierarchyOptions = {},
  ): Promise<LoadHierarchyPagesResult> {
    throwIfAborted(options.signal);
    const loadedPageKeys: string[] = [];
    let hierarchy: CopcHierarchySummary | undefined;

    for (const pageKey of [...new Set(pageKeys)]) {
      const before = await this.loadHierarchySummary(options);

      if (!before.pendingPages.some((page) => page.key === pageKey)) {
        if (before.nodes.some((node) => node.key === pageKey)) {
          hierarchy = before;
          continue;
        }

        throw new Error(`COPC hierarchy page was not found: ${pageKey}`);
      }

      hierarchy = await this.loadHierarchyPage(pageKey, options);
      loadedPageKeys.push(pageKey);
    }

    return {
      hierarchy: hierarchy ?? (await this.loadHierarchySummary(options)),
      loadedPageKeys,
    };
  }

  async loadNextHierarchyPage(
    options: LoadHierarchyOptions = {},
  ): Promise<CopcHierarchySummary | undefined> {
    throwIfAborted(options.signal);
    const hierarchy = await withCallerAbortSignal(
      this.loadHierarchy(),
      options.signal,
    );
    throwIfAborted(options.signal);
    const nextPageKey = Object.keys(hierarchy.pages).sort(compareNodeKeys)[0];

    if (!nextPageKey) {
      return undefined;
    }

    return this.loadHierarchyPage(nextPageKey, options);
  }

  getHierarchyCacheStats(): CopcHierarchyCacheStats {
    return {
      loadedPageCount: this.loadedHierarchyPages.size,
      maxCachedPageCount: this.maxCachedHierarchyPages,
      loadedPageBytes: this.cachedHierarchyPageBytes,
      maxCachedPageBytes: this.maxCachedHierarchyPageBytes,
      pendingPageCount: this.hierarchyPendingPageIds.size,
      trackedNodeCount: this.hierarchyNodePageIds.size,
      trackedPendingPageCount: this.hierarchyPendingPageIds.size,
      cacheEvictionCount: this.hierarchyPageCacheEvictionCount,
      isOverLimit:
        this.loadedHierarchyPages.size > this.maxCachedHierarchyPages ||
        this.cachedHierarchyPageBytes > this.maxCachedHierarchyPageBytes,
    };
  }

  loadNodePointSamples(
    options: LoadNodePointSamplesOptions = {},
  ): Promise<CopcNodePointSampleResult> {
    throwIfAborted(options.signal);

    const maxPointCount = options.maxPointCount ?? DEFAULT_MAX_POINT_COUNT;
    const nodeKey = options.nodeKey ?? DEFAULT_NODE_KEY;
    const sampleFormat = options.sampleFormat ?? "objects";
    const requestPriority = readOptionalFiniteNumber(
      "requestPriority",
      options.requestPriority,
      0,
    );

    if (!Number.isSafeInteger(maxPointCount) || maxPointCount <= 0) {
      throw new Error("maxPointCount must be a positive integer.");
    }

    const cacheKey = `${nodeKey}:${maxPointCount}:${sampleFormat}`;
    const cached = this.nodePointSampleCache.get(cacheKey);

    if (cached && isReusableSharedAbortableTask(cached.task)) {
      return this.returnCachedPointSample(
        cacheKey,
        cached,
        maxPointCount,
        requestPriority,
        options.signal,
      );
    }

    if (cached) {
      this.deletePointSampleCacheEntry(cacheKey, false);
    }

    const reusableCached = this.findReusablePointSampleCacheEntry(
      nodeKey,
      maxPointCount,
      sampleFormat,
      requestPriority,
    );

    if (reusableCached) {
      return this.returnCachedPointSample(
        reusableCached.cacheKey,
        reusableCached.entry,
        maxPointCount,
        requestPriority,
        options.signal,
      );
    }

    this.pointSampleCacheMissCount += 1;
    let entry: PointSampleCacheEntry;
    const priority: PointSamplePriorityHandle = { value: requestPriority };
    const task = createSharedAbortableTask((signal) =>
      this.loadNodePointSamplesWithoutCache(
        nodeKey,
        maxPointCount,
        sampleFormat,
        priority,
        signal,
      ),
    );

    void task.promise.then(
      (result) => {
        if (this.nodePointSampleCache.get(cacheKey) !== entry) {
          return;
        }

        const estimatedByteSize = estimatePointSampleResultByteSize(result);
        this.cachedPointSampleBytes +=
          estimatedByteSize - entry.estimatedByteSize;
        entry.estimatedByteSize = estimatedByteSize;
        this.evictPointSampleCacheIfNeeded();
      },
      () => {
        if (this.nodePointSampleCache.get(cacheKey) === entry) {
          this.deletePointSampleCacheEntry(cacheKey, false);
        }
      },
    );
    entry = {
      task,
      nodeKey,
      maxPointCount,
      sampleFormat,
      priority,
      estimatedByteSize: 0,
    };
    this.nodePointSampleCache.set(cacheKey, entry);
    this.evictPointSampleCacheIfNeeded();
    return this.consumePointSampleCacheEntry(
      entry,
      maxPointCount,
      options.signal,
    );
  }

  private findReusablePointSampleCacheEntry(
    nodeKey: string,
    maxPointCount: number,
    sampleFormat: CopcPointSampleFormat,
    requestPriority: number,
  ): { readonly cacheKey: string; readonly entry: PointSampleCacheEntry } | undefined {
    return [...this.nodePointSampleCache.entries()]
      .filter(
        ([, entry]) =>
          isReusableSharedAbortableTask(entry.task) &&
          entry.nodeKey === nodeKey &&
          entry.sampleFormat === sampleFormat &&
          entry.maxPointCount >= maxPointCount &&
          !(
            entry.task.state === "pending" &&
            entry.maxPointCount > maxPointCount &&
            entry.priority.value < requestPriority
          ),
      )
      .sort(([, first], [, second]) => first.maxPointCount - second.maxPointCount)
      .map(([cacheKey, entry]) => ({ cacheKey, entry }))[0];
  }

  private returnCachedPointSample(
    cacheKey: string,
    entry: PointSampleCacheEntry,
    maxPointCount: number,
    requestPriority: number,
    signal: AbortSignal | undefined,
  ): Promise<CopcNodePointSampleResult> {
    this.pointSampleCacheHitCount += 1;
    this.raisePointSampleCacheEntryPriority(entry, requestPriority);
    this.nodePointSampleCache.delete(cacheKey);
    this.nodePointSampleCache.set(cacheKey, entry);

    return this.consumePointSampleCacheEntry(entry, maxPointCount, signal);
  }

  private consumePointSampleCacheEntry(
    entry: PointSampleCacheEntry,
    maxPointCount: number,
    signal: AbortSignal | undefined,
  ): Promise<CopcNodePointSampleResult> {
    return consumeSharedAbortableTask(entry.task, signal).then((result) =>
      downsamplePointSampleResult(result, maxPointCount),
    );
  }

  private raisePointSampleCacheEntryPriority(
    entry: PointSampleCacheEntry,
    requestPriority: number,
  ): void {
    if (requestPriority <= entry.priority.value) {
      return;
    }

    entry.priority.value = requestPriority;
    this.raisePendingPointSampleWorkerRequestPriority(
      entry.nodeKey,
      entry.maxPointCount,
      entry.sampleFormat,
      requestPriority,
    );
  }

  private raisePendingPointSampleWorkerRequestPriority(
    nodeKey: string,
    maxPointCount: number,
    sampleFormat: CopcPointSampleFormat,
    requestPriority: number,
  ): void {
    for (const request of this.pointSampleWorkerRequests.values()) {
      if (
        request.request.nodeKey !== nodeKey ||
        request.request.sampleFormat !== sampleFormat ||
        request.request.maxPointCount < maxPointCount
      ) {
        continue;
      }

      request.priority = Math.max(request.priority, requestPriority);
      for (const consumer of request.consumers) {
        consumer.priority = Math.max(consumer.priority, requestPriority);
      }
    }
  }

  getPointSampleCacheStats(): CopcPointSampleCacheStats {
    return {
      cachedSampleSetCount: this.nodePointSampleCache.size,
      maxCachedSampleSetCount: this.maxCachedSampleSets,
      cachedPointSampleBytes: this.cachedPointSampleBytes,
      maxCachedPointSampleBytes: this.maxCachedPointSampleBytes,
      cacheHitCount: this.pointSampleCacheHitCount,
      cacheMissCount: this.pointSampleCacheMissCount,
      cacheEvictionCount: this.pointSampleCacheEvictionCount,
    };
  }

  getDecodedPointDataCacheStats(): CopcDecodedPointDataCacheStats {
    const snapshots = [...this.decodedPointDataCacheSnapshots.values()];

    return {
      workerCount: this.pointSampleWorkers.length,
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
      affinityEntryCount: this.decodedNodePointSampleWorkers.size,
      maxDecodedPointDataViewBytesPerWorker:
        this.maxDecodedPointDataViewBytesPerWorker,
      maxDecodedPointDataViewBytesAcrossWorkers:
        this.maxDecodedPointDataViewBytesAcrossWorkers,
    };
  }

  clearPointSampleCache(): number {
    const clearedCount = this.nodePointSampleCache.size;
    this.nodePointSampleCache.clear();
    this.cachedPointSampleBytes = 0;
    return clearedCount;
  }

  warmUpPointSampleWorkers(
    options: CopcPointSampleWorkerWarmupOptions = {},
  ): number {
    if (this.pointSampleLoading !== "worker" || this.pointSampleWorkerUnavailable) {
      return this.pointSampleWorkers.length;
    }

    const requestedWorkerCount = readOptionalPositiveInteger(
      "workerCount",
      options.workerCount,
    );
    const targetWorkerCount = Math.min(
      requestedWorkerCount ?? this.maxConcurrentPointSampleWorkerRequests,
      this.maxConcurrentPointSampleWorkerRequests,
    );

    while (this.pointSampleWorkers.length < targetWorkerCount) {
      const worker = this.createAndRegisterPointSampleWorker();

      if (!worker) {
        break;
      }

      this.pointSampleWorkers.push(worker);
    }

    return this.pointSampleWorkers.length;
  }

  resetPointSampleWorkers(): number {
    const workerCount = this.pointSampleWorkers.length;
    this.terminatePointSampleWorker(
      new Error("COPC point sample worker was reset."),
    );
    return workerCount;
  }

  destroy(): void {
    this.clearPointSampleCache();
    this.terminatePointSampleWorker(
      new Error("COPC point sample worker was terminated."),
    );
  }

  async loadNodesPointSamples(
    options: LoadNodesPointSamplesOptions,
  ): Promise<CopcMultiNodePointSampleResult> {
    const nodeKeys = [...new Set(options.nodeKeys)];

    if (nodeKeys.length === 0) {
      throw new Error("At least one COPC hierarchy node key is required.");
    }

    const maxPointCounts = allocateNodeSampleBudgets(
      nodeKeys.length,
      options.maxPointCountPerNode,
      options.maxTotalSampledPointCount,
    );

    const nodeResults = await Promise.all(
      nodeKeys.map((nodeKey, index) =>
        this.loadNodePointSamples({
          nodeKey,
          maxPointCount: maxPointCounts?.[index] ?? options.maxPointCountPerNode,
          sampleFormat: options.sampleFormat,
          requestPriority: options.requestPriority,
          signal: options.signal,
        }),
      ),
    );

    return {
      nodeKeys,
      nodeResults,
      nodePointCount: nodeResults.reduce(
        (total, result) => total + result.nodePointCount,
        0,
      ),
      sampledPointCount: nodeResults.reduce(
        (total, result) => total + result.sampledPointCount,
        0,
      ),
      points: nodeResults.flatMap((result) => result.points),
    };
  }

  private loadHierarchy(): Promise<Hierarchy.Subtree> {
    let promise = this.hierarchyPromise;

    if (!promise) {
      promise = this.loadCopc().then(async (copc) => {
        const subtree = await this.loadHierarchyPageData(
          copc.info.rootHierarchyPage,
        );
        this.recordHierarchyProvenance(subtree, copc.info.rootHierarchyPage);
        this.rememberLoadedHierarchyPage(copc.info.rootHierarchyPage, {
          isRoot: true,
        });
        return subtree;
      });
      this.hierarchyPromise = promise;
      void promise.catch(() => {
        if (this.hierarchyPromise === promise) {
          this.hierarchyPromise = undefined;
        }
      });
    }

    return promise;
  }

  private loadCopc(): Promise<CopcData> {
    let promise = this.copcPromise;

    if (!promise) {
      promise = Copc.create(this.getter).then((copc) => {
        this.loadedCopcMetadata = copc;
        return copc;
      });
      this.copcPromise = promise;
      void promise.catch(() => {
        if (this.copcPromise === promise) {
          this.copcPromise = undefined;
        }
      });
    }

    return promise;
  }

  private loadHierarchyPageData(
    page: Hierarchy.Page,
  ): Promise<Hierarchy.Subtree> {
    const pageId = hierarchyPageId(page);
    let promise = this.hierarchyPagePromises.get(pageId);

    if (!promise) {
      promise = Copc.loadHierarchyPage(this.getter, page);
      this.hierarchyPagePromises.set(pageId, promise);
      void promise.catch(() => {
        if (this.hierarchyPagePromises.get(pageId) === promise) {
          this.hierarchyPagePromises.delete(pageId);
        }
      });
    }

    return promise;
  }

  private recordHierarchyProvenance(
    subtree: Hierarchy.Subtree,
    page: Hierarchy.Page,
  ): void {
    const pageId = hierarchyPageId(page);

    for (const [nodeKey, node] of Object.entries(subtree.nodes)) {
      if (node) {
        this.hierarchyNodePageIds.set(nodeKey, pageId);
      }
    }

    for (const [pageKey, childPage] of Object.entries(subtree.pages)) {
      if (childPage) {
        this.hierarchyPendingPageIds.set(pageKey, pageId);
      }
    }
  }

  private rememberLoadedHierarchyPage(
    page: Hierarchy.Page,
    options: {
      readonly pageKey?: string;
      readonly parentPageId?: string;
      readonly isRoot?: boolean;
    } = {},
  ): void {
    const pageId = hierarchyPageId(page);
    const previousEntry = this.loadedHierarchyPages.get(pageId);

    if (previousEntry) {
      this.cachedHierarchyPageBytes -= estimateHierarchyPageByteSize(
        previousEntry.page,
      );
    }

    this.loadedHierarchyPages.delete(pageId);
    this.loadedHierarchyPages.set(pageId, {
      page,
      pageKey: options.pageKey,
      parentPageId: options.parentPageId,
      isRoot: options.isRoot ?? false,
    });
    this.cachedHierarchyPageBytes += estimateHierarchyPageByteSize(page);
  }

  private touchLoadedHierarchyPage(pageId: string | undefined): void {
    if (!pageId) {
      return;
    }

    const entry = this.loadedHierarchyPages.get(pageId);

    if (!entry) {
      return;
    }

    this.loadedHierarchyPages.delete(pageId);
    this.loadedHierarchyPages.set(pageId, entry);
  }

  private evictHierarchyPagesIfNeeded(hierarchy: Hierarchy.Subtree): void {
    while (
      this.loadedHierarchyPages.size > this.maxCachedHierarchyPages ||
      this.cachedHierarchyPageBytes > this.maxCachedHierarchyPageBytes
    ) {
      const pageId = this.findEvictableHierarchyPageId();

      if (!pageId) {
        return;
      }

      this.deleteHierarchyPageCacheEntry(hierarchy, pageId);
    }
  }

  private findEvictableHierarchyPageId(): string | undefined {
    for (const [pageId, entry] of this.loadedHierarchyPages) {
      if (entry.isRoot || this.hasLoadedHierarchyPageChild(pageId)) {
        continue;
      }

      return pageId;
    }

    return undefined;
  }

  private hasLoadedHierarchyPageChild(pageId: string): boolean {
    for (const entry of this.loadedHierarchyPages.values()) {
      if (entry.parentPageId === pageId) {
        return true;
      }
    }

    return false;
  }

  private deleteHierarchyPageCacheEntry(
    hierarchy: Hierarchy.Subtree,
    pageId: string,
  ): void {
    const entry = this.loadedHierarchyPages.get(pageId);

    if (!entry || entry.isRoot || !entry.pageKey) {
      return;
    }

    this.loadedHierarchyPages.delete(pageId);
    this.cachedHierarchyPageBytes -= estimateHierarchyPageByteSize(entry.page);
    this.hierarchyPagePromises.delete(pageId);
    this.hierarchyPageLoadTasks.delete(pageId);

    for (const [nodeKey, sourcePageId] of [
      ...this.hierarchyNodePageIds.entries(),
    ]) {
      if (sourcePageId === pageId) {
        delete hierarchy.nodes[nodeKey];
        this.hierarchyNodePageIds.delete(nodeKey);
      }
    }

    for (const [pageKey, sourcePageId] of [
      ...this.hierarchyPendingPageIds.entries(),
    ]) {
      if (sourcePageId === pageId) {
        delete hierarchy.pages[pageKey];
        this.hierarchyPendingPageIds.delete(pageKey);
      }
    }

    hierarchy.pages[entry.pageKey] = entry.page;
    if (entry.parentPageId) {
      this.hierarchyPendingPageIds.set(entry.pageKey, entry.parentPageId);
    }
    this.hierarchyPageCacheEvictionCount += 1;
  }

  private canUsePointSampleWorker(): boolean {
    if (this.pointSampleLoading !== "worker" || this.pointSampleWorkerUnavailable) {
      return false;
    }

    if (this.pointSampleWorkers.length === 0) {
      const worker = this.createAndRegisterPointSampleWorker();

      if (worker) {
        this.pointSampleWorkers.push(worker);
      } else {
        return false;
      }
    }

    return true;
  }

  private getIdlePointSampleWorker(
    request: CopcPointSampleWorkerLoadRequest,
  ): Worker | undefined {
    if (this.pointSampleLoading !== "worker" || this.pointSampleWorkerUnavailable) {
      return undefined;
    }

    const activeNodeWorker = this.activeNodePointSampleWorkers.get(
      request.nodeKey,
    );

    if (activeNodeWorker && this.pointSampleWorkers.includes(activeNodeWorker)) {
      return this.activePointSampleWorkers.has(activeNodeWorker)
        ? undefined
        : activeNodeWorker;
    }

    const preferredWorker = this.decodedNodePointSampleWorkers.get(request.nodeKey);

    if (preferredWorker && this.pointSampleWorkers.includes(preferredWorker)) {
      return this.activePointSampleWorkers.has(preferredWorker)
        ? undefined
        : preferredWorker;
    }

    const idleWorker = this.pointSampleWorkers.find(
      (worker) => !this.activePointSampleWorkers.has(worker),
    );

    if (idleWorker) {
      return idleWorker;
    }

    if (
      this.pointSampleWorkers.length <
      this.maxConcurrentPointSampleWorkerRequests
    ) {
      const worker = this.createAndRegisterPointSampleWorker();

      if (worker) {
        this.pointSampleWorkers.push(worker);
        return worker;
      }
    }

    return undefined;
  }

  private createAndRegisterPointSampleWorker(): Worker | undefined {
    try {
      const worker = this.createPointSampleWorker();
      worker.addEventListener("message", (event) => {
        this.handlePointSampleWorkerMessage(
          event as MessageEvent<CopcPointSampleWorkerResponse>,
        );
      });
      worker.addEventListener("error", (event) => {
        this.pointSampleWorkerUnavailable = true;
        this.terminatePointSampleWorker(
          event.error instanceof Error
            ? event.error
            : new Error("COPC point sample worker failed."),
        );
      });
      return worker;
    } catch {
      if (this.pointSampleWorkers.length === 0) {
        this.pointSampleWorkerUnavailable = true;
      }
      return undefined;
    }
  }

  private loadNodePointSamplesWithWorker(
    copc: CopcData,
    nodeKey: string,
    node: Hierarchy.Node,
    maxPointCount: number,
    sampleFormat: CopcPointSampleFormat,
    priority: number,
    signal: AbortSignal | undefined,
  ): Promise<CopcNodePointSampleResult> | undefined {
    if (!this.canUsePointSampleWorker()) {
      return undefined;
    }

    throwIfAborted(signal);

    return new Promise((resolve, reject) => {
      let entry: PointSampleWorkerRequestEntry | undefined;
      let consumer: PointSampleWorkerRequestConsumer;
      const abort = (): void => {
        if (entry) {
          this.cancelPointSampleWorkerConsumer(
            entry,
            consumer,
            createAbortError(signal),
          );
        }
      };
      const cleanup = (): void => {
        signal?.removeEventListener("abort", abort);
      };

      if (signal?.aborted) {
        reject(createAbortError(signal));
        return;
      }

      consumer = {
        signal,
        maxPointCount,
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

      const existingEntry = this.findReusablePointSampleWorkerRequest(
        nodeKey,
        maxPointCount,
        sampleFormat,
        priority,
      );

      if (existingEntry) {
        entry = existingEntry;
        this.addPointSampleWorkerConsumer(existingEntry, consumer, {
          node,
          maxPointCount,
        });
        signal?.addEventListener("abort", abort, { once: true });
        return;
      }

      const id = ++this.pointSampleWorkerRequestId;
      const request: CopcPointSampleWorkerLoadRequest = {
        id,
        type: "loadNodePointSamples",
        copc,
        source: this.sourceDescriptor,
        nodeKey,
        node,
        maxPointCount,
        sampleFormat,
        maxDecodedPointDataViews: this.maxDecodedPointDataViewsPerWorker,
        maxDecodedPointDataViewBytes:
          this.maxDecodedPointDataViewBytesPerWorker,
      };

      entry = {
        request,
        consumers: [consumer],
        priority,
        state: "queued",
      };
      this.pointSampleWorkerRequests.set(id, entry);
      signal?.addEventListener("abort", abort, { once: true });
      this.pointSampleWorkerQueue.push(entry);
      this.drainPointSampleWorkerQueue();
    });
  }

  private handlePointSampleWorkerMessage(
    event: MessageEvent<CopcPointSampleWorkerResponse>,
  ): void {
    const response = event.data;
    const request = this.pointSampleWorkerRequests.get(response.id);

    if (!request) {
      return;
    }

    const worker = request.worker;
    this.pointSampleWorkerRequests.delete(response.id);

    if (response.type === "loadNodePointSamples:success") {
      if (worker) {
        this.applyDecodedPointDataCacheSnapshot(
          worker,
          request.request,
          response.cache,
          "success",
        );
      }
      this.finishPointSampleWorkerRequest(request);
      this.resolvePointSampleWorkerConsumers(request, response.result);
      return;
    }

    if (response.type === "loadNodePointSamples:canceled") {
      if (worker) {
        this.applyDecodedPointDataCacheSnapshot(
          worker,
          request.request,
          response.cache,
          "retained-only",
        );
      }
      this.finishPointSampleWorkerRequest(request);
      this.rejectPointSampleWorkerConsumers(
        request,
        createAbortError(request.consumers[0]?.signal),
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

    this.finishPointSampleWorkerRequest(request);
    this.rejectPointSampleWorkerConsumers(
      request,
      createErrorFromWorkerResponse(response.error),
    );
  }

  private drainPointSampleWorkerQueue(): void {
    while (this.pointSampleWorkerQueue.length > 0) {
      const dispatchableEntry = this.findDispatchablePointSampleWorkerRequest();

      if (!dispatchableEntry) {
        return;
      }

      const { request, worker } = dispatchableEntry;
      this.removeQueuedPointSampleWorkerRequest(request);

      this.removeAbortedPointSampleWorkerConsumers(request);

      if (request.consumers.length === 0) {
        this.pointSampleWorkerRequests.delete(request.request.id);
        continue;
      }

      request.worker = worker;
      request.state = "active";
      this.activePointSampleWorkers.add(worker);
      this.activeNodePointSampleWorkers.set(request.request.nodeKey, worker);
      worker.postMessage(request.request);
    }
  }

  private findDispatchablePointSampleWorkerRequest():
    | {
        readonly request: PointSampleWorkerRequestEntry;
        readonly worker: Worker;
      }
    | undefined {
    while (this.pointSampleWorkerQueue.length > 0) {
      let sawValidQueuedRequest = false;
      let dispatchableEntry:
        | {
            readonly request: PointSampleWorkerRequestEntry;
            readonly worker: Worker;
          }
        | undefined;

      for (
        let index = 0;
        index < this.pointSampleWorkerQueue.length;
        index += 1
      ) {
        const request = this.pointSampleWorkerQueue[index];

        if (this.pointSampleWorkerRequests.get(request.request.id) !== request) {
          this.pointSampleWorkerQueue.splice(index, 1);
          index -= 1;
          continue;
        }

        sawValidQueuedRequest = true;
        const worker = this.getIdlePointSampleWorker(request.request);

        if (worker) {
          const nextEntry = {
            request,
            worker,
          };

          if (
            !dispatchableEntry ||
            comparePointSampleWorkerRequestPriority(
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

  private removeQueuedPointSampleWorkerRequest(
    request: PointSampleWorkerRequestEntry,
  ): void {
    const index = this.pointSampleWorkerQueue.indexOf(request);

    if (index !== -1) {
      this.pointSampleWorkerQueue.splice(index, 1);
    }
  }

  private finishPointSampleWorkerRequest(
    request: PointSampleWorkerRequestEntry,
  ): void {
    if (request.state === "active") {
      this.finishActivePointSampleWorkerRequest(request);
      this.drainPointSampleWorkerQueue();
    }
  }

  private finishActivePointSampleWorkerRequest(
    request: PointSampleWorkerRequestEntry,
  ): void {
    if (request.worker) {
      if (
        this.activeNodePointSampleWorkers.get(request.request.nodeKey) ===
        request.worker
      ) {
        this.activeNodePointSampleWorkers.delete(request.request.nodeKey);
      }
      this.activePointSampleWorkers.delete(request.worker);
      request.worker = undefined;
    }
  }

  private terminateActivePointSampleWorkerRequest(
    request: PointSampleWorkerRequestEntry,
  ): void {
    const worker = request.worker;

    if (!worker) {
      return;
    }

    this.activePointSampleWorkers.delete(worker);
    request.worker = undefined;
    this.removeActiveNodePointSampleWorkerAffinities(worker);
    this.removeDecodedNodePointSampleWorkerAffinities(worker);
    this.retireDecodedPointDataCacheSnapshot(worker);

    const workerIndex = this.pointSampleWorkers.indexOf(worker);
    if (workerIndex !== -1) {
      this.pointSampleWorkers.splice(workerIndex, 1);
    }

    worker.terminate();
  }

  private findReusablePointSampleWorkerRequest(
    nodeKey: string,
    maxPointCount: number,
    sampleFormat: CopcPointSampleFormat,
    priority: number,
  ): PointSampleWorkerRequestEntry | undefined {
    const sameNodeRequests = [...this.pointSampleWorkerRequests.values()].filter(
      (request) =>
        request.request.nodeKey === nodeKey &&
        request.request.sampleFormat === sampleFormat,
    );
    const sufficientRequest = sameNodeRequests
      .filter(
        (request) =>
          (request.state === "queued" || request.state === "active") &&
          request.request.maxPointCount >= maxPointCount &&
          canReusePointSampleWorkerRequestForPriority(request, priority),
      )
      .sort(
        (left, right) =>
          left.request.maxPointCount - right.request.maxPointCount ||
          left.request.id - right.request.id,
      )[0];

    if (sufficientRequest) {
      return sufficientRequest;
    }

    return sameNodeRequests
      .filter(
        (request) =>
          request.state === "queued" &&
          request.request.maxPointCount < maxPointCount &&
          request.priority <= priority,
      )
      .sort(
        (left, right) =>
          right.request.maxPointCount - left.request.maxPointCount ||
          left.request.id - right.request.id,
      )[0];
  }

  private addPointSampleWorkerConsumer(
    request: PointSampleWorkerRequestEntry,
    consumer: PointSampleWorkerRequestConsumer,
    options: {
      readonly node: Hierarchy.Node;
      readonly maxPointCount: number;
    },
  ): void {
    request.consumers.push(consumer);
    request.priority = Math.max(request.priority, consumer.priority);

    if (
      request.state === "queued" &&
      request.request.maxPointCount < options.maxPointCount
    ) {
      this.updateQueuedPointSampleWorkerRequestPointCount(
        request,
        options.maxPointCount,
        options.node,
      );
    }
  }

  private cancelPointSampleWorkerConsumer(
    request: PointSampleWorkerRequestEntry,
    consumer: PointSampleWorkerRequestConsumer,
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
      this.resizeQueuedPointSampleWorkerRequestForConsumers(request);
      return;
    }

    this.pointSampleWorkerRequests.delete(request.request.id);
    if (request.state === "queued") {
      this.removeQueuedPointSampleWorkerRequest(request);
    } else {
      this.terminateActivePointSampleWorkerRequest(request);
    }

    queueMicrotask(() => {
      this.drainPointSampleWorkerQueue();
    });
  }

  private removeAbortedPointSampleWorkerConsumers(
    request: PointSampleWorkerRequestEntry,
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

    if (request.consumers.length > 0) {
      request.priority = Math.max(
        ...request.consumers.map((remaining) => remaining.priority),
      );
    }
    this.resizeQueuedPointSampleWorkerRequestForConsumers(request);
  }

  private resizeQueuedPointSampleWorkerRequestForConsumers(
    request: PointSampleWorkerRequestEntry,
  ): void {
    if (request.state !== "queued" || request.consumers.length === 0) {
      return;
    }

    const maxPointCount = Math.max(
      ...request.consumers.map((consumer) => consumer.maxPointCount),
    );

    if (maxPointCount !== request.request.maxPointCount) {
      this.updateQueuedPointSampleWorkerRequestPointCount(
        request,
        maxPointCount,
        request.request.node,
      );
    }
  }

  private updateQueuedPointSampleWorkerRequestPointCount(
    request: PointSampleWorkerRequestEntry,
    maxPointCount: number,
    node: Hierarchy.Node,
  ): void {
    request.request = {
      ...request.request,
      node,
      maxPointCount,
    };
  }

  private resolvePointSampleWorkerConsumers(
    request: PointSampleWorkerRequestEntry,
    result: CopcNodePointSampleResult,
  ): void {
    const consumers = request.consumers.splice(0);

    for (const consumer of consumers) {
      consumer.resolve(
        downsamplePointSampleResult(result, consumer.maxPointCount),
      );
    }
  }

  private rejectPointSampleWorkerConsumers(
    request: PointSampleWorkerRequestEntry,
    error: unknown,
  ): void {
    const consumers = request.consumers.splice(0);

    for (const consumer of consumers) {
      consumer.reject(error);
    }
  }

  private terminatePointSampleWorker(error: Error): void {
    const workers = [...this.pointSampleWorkers];
    this.pointSampleWorkers.length = 0;

    for (const worker of workers) {
      this.retireDecodedPointDataCacheSnapshot(worker);
      worker.terminate();
    }

    for (const request of this.pointSampleWorkerRequests.values()) {
      this.rejectPointSampleWorkerConsumers(request, error);
    }
    this.pointSampleWorkerRequests.clear();
    this.pointSampleWorkerQueue.length = 0;
    this.activePointSampleWorkers.clear();
    this.activeNodePointSampleWorkers.clear();
    this.decodedNodePointSampleWorkers.clear();
  }

  private removeActiveNodePointSampleWorkerAffinities(worker: Worker): void {
    for (const [nodeKey, activeWorker] of this.activeNodePointSampleWorkers) {
      if (activeWorker === worker) {
        this.activeNodePointSampleWorkers.delete(nodeKey);
      }
    }
  }

  private applyDecodedPointDataCacheSnapshot(
    worker: Worker,
    request: CopcPointSampleWorkerLoadRequest,
    snapshot: CopcDecodedPointDataCacheSnapshot | undefined,
    affinityMode: "success" | "retained-only" | "none",
  ): void {
    if (!snapshot) {
      if (affinityMode === "success") {
        this.decodedNodePointSampleWorkers.set(request.nodeKey, worker);
      }
      return;
    }

    this.decodedPointDataCacheSnapshots.set(worker, snapshot);

    for (const evicted of snapshot.evictedNodeKeys) {
      if (evicted.sourceKey !== this.sourceKey) {
        continue;
      }

      if (this.decodedNodePointSampleWorkers.get(evicted.nodeKey) === worker) {
        this.decodedNodePointSampleWorkers.delete(evicted.nodeKey);
      }
    }

    if (snapshot.requestedNodeRetained && affinityMode !== "none") {
      this.decodedNodePointSampleWorkers.set(request.nodeKey, worker);
    } else if (
      !snapshot.requestedNodeRetained &&
      this.decodedNodePointSampleWorkers.get(request.nodeKey) === worker
    ) {
      this.decodedNodePointSampleWorkers.delete(request.nodeKey);
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

  private removeDecodedNodePointSampleWorkerAffinities(worker: Worker): void {
    for (const [nodeKey, decodedWorker] of this.decodedNodePointSampleWorkers) {
      if (decodedWorker === worker) {
        this.decodedNodePointSampleWorkers.delete(nodeKey);
      }
    }
  }

  private evictPointSampleCacheIfNeeded(): void {
    while (
      this.nodePointSampleCache.size > this.maxCachedSampleSets ||
      this.cachedPointSampleBytes > this.maxCachedPointSampleBytes
    ) {
      const oldestCacheKey = this.nodePointSampleCache.keys().next().value;

      if (!oldestCacheKey) {
        return;
      }

      this.deletePointSampleCacheEntry(oldestCacheKey, true);
    }
  }

  private deletePointSampleCacheEntry(
    cacheKey: string,
    countEviction: boolean,
  ): boolean {
    const entry = this.nodePointSampleCache.get(cacheKey);

    if (!entry) {
      return false;
    }

    this.nodePointSampleCache.delete(cacheKey);
    this.cachedPointSampleBytes -= entry.estimatedByteSize;

    if (countEviction) {
      this.pointSampleCacheEvictionCount += 1;
    }

    return true;
  }

  private async loadNodePointSamplesWithoutCache(
    nodeKey: string,
    maxPointCount: number,
    sampleFormat: CopcPointSampleFormat,
    requestPriority: PointSamplePriorityHandle,
    signal: AbortSignal | undefined,
  ): Promise<CopcNodePointSampleResult> {
    throwIfAborted(signal);

    const [copc, hierarchy] = await Promise.all([
      this.loadCopc(),
      this.loadHierarchy(),
    ]);
    throwIfAborted(signal);

    let node = hierarchy.nodes[nodeKey];

    if (!node && hierarchy.pages[nodeKey]) {
      await this.loadHierarchyPage(nodeKey, { signal });
      throwIfAborted(signal);
      node = hierarchy.nodes[nodeKey];
    }

    if (!node) {
      throw new Error(`COPC hierarchy node was not found: ${nodeKey}`);
    }

    this.touchLoadedHierarchyPage(this.hierarchyNodePageIds.get(nodeKey));

    const workerResult = this.loadNodePointSamplesWithWorker(
      copc,
      nodeKey,
      node,
      maxPointCount,
      sampleFormat,
      requestPriority.value,
      signal,
    );

    if (workerResult) {
      return workerResult;
    }

    const result = await loadCopcNodePointSamples({
      getter: this.getter,
      copc,
      nodeKey,
      node,
      maxPointCount,
      sampleFormat,
      signal,
    });

    throwIfAborted(signal);
    return result;
  }
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

function allocateNodeSampleBudgets(
  nodeCount: number,
  maxPointCountPerNode: number | undefined,
  maxTotalSampledPointCount: number | undefined,
): readonly number[] | undefined {
  if (maxTotalSampledPointCount === undefined) {
    return undefined;
  }

  const perNodeLimit = maxPointCountPerNode ?? DEFAULT_MAX_POINT_COUNT;

  if (!Number.isSafeInteger(perNodeLimit) || perNodeLimit <= 0) {
    throw new Error("maxPointCountPerNode must be a positive integer.");
  }

  if (
    !Number.isSafeInteger(maxTotalSampledPointCount) ||
    maxTotalSampledPointCount <= 0
  ) {
    throw new Error("maxTotalSampledPointCount must be a positive integer.");
  }

  if (maxTotalSampledPointCount < nodeCount) {
    throw new Error(
      "maxTotalSampledPointCount must be greater than or equal to the number of COPC hierarchy nodes.",
    );
  }

  const baseBudget = Math.floor(maxTotalSampledPointCount / nodeCount);
  const remainder = maxTotalSampledPointCount % nodeCount;

  return Array.from({ length: nodeCount }, (_value, index) =>
    Math.min(perNodeLimit, baseBudget + (index < remainder ? 1 : 0)),
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

function withCallerAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return promise;
  }

  if (signal.aborted) {
    return Promise.reject(createAbortError(signal));
  }

  return new Promise((resolve, reject) => {
    const abort = (): void => {
      cleanup();
      reject(createAbortError(signal));
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", abort);
    };

    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function createAbortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;

  if (reason instanceof Error) {
    return reason;
  }

  if (typeof DOMException !== "undefined") {
    return new DOMException("COPC point sample request was aborted.", "AbortError");
  }

  const error = new Error("COPC point sample request was aborted.");
  error.name = "AbortError";
  return error;
}

function createInspection(sourceUrl: string, copc: CopcData): CopcInspection {
  return {
    sourceUrl,
    pointCount: copc.header.pointCount,
    lasVersion: `${copc.header.majorVersion}.${copc.header.minorVersion}`,
    pointDataRecordFormat: copc.header.pointDataRecordFormat,
    pointDataRecordLength: copc.header.pointDataRecordLength,
    bounds: boundsFromTuple([...copc.header.min, ...copc.header.max]),
    cube: boundsFromTuple(copc.info.cube),
    scale: copc.header.scale,
    offset: copc.header.offset,
    spacing: copc.info.spacing,
    gpsTimeRange: copc.info.gpsTimeRange,
    rootHierarchyPage: {
      pageOffset: copc.info.rootHierarchyPage.pageOffset,
      pageLength: copc.info.rootHierarchyPage.pageLength,
    },
    vlrs: summarizeVlrs(copc),
    wkt: copc.wkt ?? null,
  };
}

function summarizeVlrs(copc: CopcData): CopcVlrSummary[] {
  return copc.vlrs.map((vlr) => ({
    userId: vlr.userId,
    recordId: vlr.recordId,
    description: vlr.description,
    contentLength: vlr.contentLength,
    isExtended: vlr.isExtended,
  }));
}

function summarizeNodes(
  nodes: Hierarchy.Node.Map,
  cube: readonly number[],
  nodePageIds: ReadonlyMap<string, string>,
): CopcHierarchyNodeSummary[] {
  return Object.entries(nodes)
    .flatMap(([key, node]) => {
      if (!node) {
        return [];
      }

      return [
        {
          ...createNodeSummary(key, node, cube),
          key,
          sourceHierarchyPageId: nodePageIds.get(key),
        },
      ];
    })
    .sort(compareNodes);
}

function summarizeHierarchy(
  hierarchy: Hierarchy.Subtree,
  cube: readonly number[],
  loadedPageCount: number,
  nodePageIds: ReadonlyMap<string, string>,
  pendingPageIds: ReadonlyMap<string, string>,
): CopcHierarchySummary {
  const pendingPages = summarizePendingPages(
    hierarchy.pages,
    cube,
    pendingPageIds,
  );

  return {
    nodes: summarizeNodes(hierarchy.nodes, cube, nodePageIds),
    pendingPages,
    pageCount: pendingPages.length,
    loadedPageCount,
    pendingPageCount: pendingPages.length,
  };
}

function summarizePendingPages(
  pages: Hierarchy.Page.Map,
  cube: readonly number[],
  pendingPageIds: ReadonlyMap<string, string>,
): CopcHierarchyPageReference[] {
  return Object.entries(pages)
    .flatMap(([key, page]) => {
      if (!page) {
        return [];
      }

      return [
        {
          ...createPageReferenceSummary(key, cube),
          key,
          sourceHierarchyPageId: pendingPageIds.get(key),
          pageOffset: page.pageOffset,
          pageLength: page.pageLength,
        },
      ];
    })
    .sort((left, right) => compareNodeKeys(left.key, right.key));
}

function createPageReferenceSummary(
  key: string,
  cube: readonly number[],
): Pick<CopcHierarchyPageReference, "depth" | "x" | "y" | "z" | "bounds"> {
  const parsedKey = parseNodeKey(key);

  return {
    ...parsedKey,
    bounds: boundsForNode(cube, parsedKey),
  };
}

function mergeHierarchy(
  target: Hierarchy.Subtree,
  source: Hierarchy.Subtree,
): void {
  Object.assign(target.nodes, source.nodes);
  Object.assign(target.pages, source.pages);
}

function createNodeSummary(
  key: string,
  node: Hierarchy.Node,
  cube: readonly number[],
): Omit<CopcHierarchyNodeSummary, "key"> {
  const parsedKey = parseNodeKey(key);
  const bounds = boundsForNode(cube, parsedKey);
  const volume = Math.max(
    (bounds.maxX - bounds.minX) *
      (bounds.maxY - bounds.minY) *
      (bounds.maxZ - bounds.minZ),
    Number.EPSILON,
  );

  return {
    ...parsedKey,
    bounds,
    pointCount: node.pointCount,
    pointDensity: node.pointCount / volume,
    pointDataOffset: node.pointDataOffset,
    pointDataLength: node.pointDataLength,
  };
}

function parseNodeKey(
  key: string,
): Pick<CopcHierarchyNodeSummary, "depth" | "x" | "y" | "z"> {
  const parts = key.split("-").map(Number);

  if (parts.length !== 4 || parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`Invalid COPC hierarchy node key: ${key}`);
  }

  const [depth, x, y, z] = parts;

  return {
    depth,
    x,
    y,
    z,
  };
}

function boundsForNode(
  cube: readonly number[],
  key: Pick<CopcHierarchyNodeSummary, "depth" | "x" | "y" | "z">,
): CopcBounds {
  const cubeBounds = boundsFromTuple(cube);
  const divisions = 2 ** key.depth;
  const width = (cubeBounds.maxX - cubeBounds.minX) / divisions;
  const depth = (cubeBounds.maxY - cubeBounds.minY) / divisions;
  const height = (cubeBounds.maxZ - cubeBounds.minZ) / divisions;
  const minX = cubeBounds.minX + key.x * width;
  const minY = cubeBounds.minY + key.y * depth;
  const minZ = cubeBounds.minZ + key.z * height;

  return {
    minX,
    minY,
    minZ,
    maxX: minX + width,
    maxY: minY + depth,
    maxZ: minZ + height,
  };
}

function compareNodes(
  left: CopcHierarchyNodeSummary,
  right: CopcHierarchyNodeSummary,
): number {
  return compareParsedNodeKeys(left, right);
}

function comparePointSampleWorkerRequestPriority(
  left: PointSampleWorkerRequestEntry,
  right: PointSampleWorkerRequestEntry,
): number {
  return right.priority - left.priority || left.request.id - right.request.id;
}

function canReusePointSampleWorkerRequestForPriority(
  request: PointSampleWorkerRequestEntry,
  priority: number,
): boolean {
  return request.state === "active" || request.priority >= priority;
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

function compareNodeKeys(leftKey: string, rightKey: string): number {
  return compareParsedNodeKeys(parseNodeKey(leftKey), parseNodeKey(rightKey));
}

function compareParsedNodeKeys(
  left: Pick<CopcHierarchyNodeSummary, "depth" | "x" | "y" | "z">,
  right: Pick<CopcHierarchyNodeSummary, "depth" | "x" | "y" | "z">,
): number {
  return (
    left.depth - right.depth ||
    left.z - right.z ||
    left.y - right.y ||
    left.x - right.x
  );
}

function boundsFromTuple(bounds: readonly number[]): CopcBounds {
  if (bounds.length !== 6) {
    throw new Error(`Expected six bound values, received ${bounds.length}.`);
  }

  return {
    minX: bounds[0],
    minY: bounds[1],
    minZ: bounds[2],
    maxX: bounds[3],
    maxY: bounds[4],
    maxZ: bounds[5],
  };
}

function estimatePointSampleResultByteSize(
  result: CopcNodePointSampleResult,
): number {
  const objectPointBytes = result.points.reduce(
    (total, point) => total + estimatePointSampleByteSize(point),
    0,
  );

  return objectPointBytes + estimatePointDataSampleArraysByteSize(result.pointData);
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

function estimateHierarchyPageByteSize(page: Hierarchy.Page): number {
  return Number.isSafeInteger(page.pageLength) && page.pageLength > 0
    ? page.pageLength
    : 0;
}

function estimatePointSampleByteSize(point: CopcPointDataSample): number {
  return (
    POINT_SAMPLE_COORDINATE_BYTES +
    (point.color ? POINT_SAMPLE_COLOR_BYTES : 0) +
    (point.classification === undefined
      ? 0
      : POINT_SAMPLE_CLASSIFICATION_BYTES) +
    (point.intensity === undefined ? 0 : POINT_SAMPLE_INTENSITY_BYTES)
  );
}

function downsamplePointSampleResult(
  result: CopcNodePointSampleResult,
  maxPointCount: number,
): CopcNodePointSampleResult {
  const sampledPointCount = Math.min(
    result.sampledPointCount,
    result.nodePointCount,
    maxPointCount,
  );

  if (sampledPointCount >= result.sampledPointCount) {
    return result;
  }

  const pointData = result.pointData
    ? createDownsampledPointDataSampleArrays(
        result.pointData,
        sampledPointCount,
      )
    : undefined;
  const points = result.points.slice(0, sampledPointCount);

  return {
    nodeKey: result.nodeKey,
    nodePointCount: result.nodePointCount,
    sampledPointCount: result.pointData ? sampledPointCount : points.length,
    points,
    pointData,
  };
}

function estimatePointDataSampleArraysByteSize(
  pointData: CopcPointDataSampleArrays | undefined,
): number {
  if (!pointData) {
    return 0;
  }

  return (
    pointData.x.byteLength +
    pointData.y.byteLength +
    pointData.z.byteLength +
    (pointData.red?.byteLength ?? 0) +
    (pointData.green?.byteLength ?? 0) +
    (pointData.blue?.byteLength ?? 0) +
    (pointData.classification?.byteLength ?? 0) +
    (pointData.intensity?.byteLength ?? 0)
  );
}

function createDownsampledPointDataSampleArrays(
  pointData: CopcPointDataSampleArrays,
  sampledPointCount: number,
): CopcPointDataSampleArrays {
  return {
    x: pointData.x.slice(0, sampledPointCount),
    y: pointData.y.slice(0, sampledPointCount),
    z: pointData.z.slice(0, sampledPointCount),
    red: pointData.red?.slice(0, sampledPointCount),
    green: pointData.green?.slice(0, sampledPointCount),
    blue: pointData.blue?.slice(0, sampledPointCount),
    classification: pointData.classification?.slice(0, sampledPointCount),
    intensity: pointData.intensity?.slice(0, sampledPointCount),
  };
}

function hierarchyPageId(page: Hierarchy.Page): string {
  return `${page.pageOffset}:${page.pageLength}`;
}
