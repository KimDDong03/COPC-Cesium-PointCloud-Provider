import { Copc } from "copc";
import type { Copc as CopcData, Getter, Hierarchy } from "copc";
import { createHttpRangeGetter } from "./createHttpRangeGetter";
import { createCopcPointSampleWorker } from "./createCopcPointSampleWorker";
import { loadCopcNodePointSamples } from "./loadCopcNodePointSamples";
import type {
  CopcPointSampleWorkerLoadRequest,
  CopcPointSampleWorkerRequest,
  CopcPointSampleWorkerResponse,
} from "./CopcPointSampleWorkerProtocol";
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
  CopcPointDataSample,
  CopcPointSampleCacheStats,
} from "./CopcPointDataSample";

export interface LoadNodePointSamplesOptions {
  readonly nodeKey?: string;
  readonly maxPointCount?: number;
  readonly signal?: AbortSignal;
}

export interface LoadNodesPointSamplesOptions {
  readonly nodeKeys: readonly string[];
  readonly maxPointCountPerNode?: number;
  readonly maxTotalSampledPointCount?: number;
  readonly signal?: AbortSignal;
}

export interface LoadHierarchyPagesResult {
  readonly hierarchy: CopcHierarchySummary;
  readonly loadedPageKeys: readonly string[];
}

export interface CopcSourceOptions {
  readonly maxCachedHierarchyPages?: number;
  readonly maxCachedSampleSets?: number;
  readonly maxCachedPointSampleBytes?: number;
  readonly maxConcurrentPointSampleWorkerRequests?: number;
  readonly pointSampleLoading?: CopcPointSampleLoadingMode;
  readonly createPointSampleWorker?: () => Worker;
}

export type CopcPointSampleLoadingMode = "main-thread" | "worker";

const DEFAULT_MAX_POINT_COUNT = 5_000;
const DEFAULT_NODE_KEY = "0-0-0-0";
const DEFAULT_MAX_CACHED_HIERARCHY_PAGES = 64;
const DEFAULT_MAX_CACHED_SAMPLE_SETS = 32;
const DEFAULT_MAX_CACHED_POINT_SAMPLE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_POINT_SAMPLE_WORKER_REQUESTS = 3;
const POINT_SAMPLE_COORDINATE_BYTES = 3 * 8;
const POINT_SAMPLE_COLOR_BYTES = 3;

interface PointSampleCacheEntry {
  readonly promise: Promise<CopcNodePointSampleResult>;
  estimatedByteSize: number;
}

interface HierarchyPageCacheEntry {
  readonly page: Hierarchy.Page;
  readonly pageKey?: string;
  readonly parentPageId?: string;
  readonly isRoot: boolean;
}

interface PointSampleWorkerRequestEntry {
  readonly worker: Worker;
  readonly request: CopcPointSampleWorkerLoadRequest;
  readonly signal?: AbortSignal;
  readonly cleanup: () => void;
  readonly resolve: (result: CopcNodePointSampleResult) => void;
  readonly reject: (error: unknown) => void;
  state: "queued" | "active";
}

export class CopcSource {
  readonly url: string;

  private readonly maxCachedSampleSets: number;
  private readonly maxCachedPointSampleBytes: number;
  private readonly maxCachedHierarchyPages: number;
  private readonly maxConcurrentPointSampleWorkerRequests: number;
  private readonly pointSampleLoading: CopcPointSampleLoadingMode;
  private readonly createPointSampleWorker: () => Worker;
  private readonly getter: Getter;
  private readonly copcPromise: Promise<CopcData>;
  private hierarchyPromise: Promise<Hierarchy.Subtree> | undefined;
  private inspectionPromise: Promise<CopcInspection> | undefined;
  private readonly hierarchyPagePromises = new Map<
    string,
    Promise<Hierarchy.Subtree>
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
  private cachedPointSampleBytes = 0;
  private hierarchyPageCacheEvictionCount = 0;
  private pointSampleCacheHitCount = 0;
  private pointSampleCacheMissCount = 0;
  private pointSampleCacheEvictionCount = 0;
  private pointSampleWorker: Worker | undefined;
  private pointSampleWorkerUnavailable = false;
  private pointSampleWorkerRequestId = 0;
  private activePointSampleWorkerRequestCount = 0;

  constructor(url: string, options: CopcSourceOptions = {}) {
    const maxCachedHierarchyPages =
      options.maxCachedHierarchyPages ?? DEFAULT_MAX_CACHED_HIERARCHY_PAGES;
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

    if (
      options.pointSampleLoading !== undefined &&
      options.pointSampleLoading !== "main-thread" &&
      options.pointSampleLoading !== "worker"
    ) {
      throw new Error(
        "pointSampleLoading must be either 'main-thread' or 'worker'.",
      );
    }

    this.url = url;
    this.maxCachedHierarchyPages = maxCachedHierarchyPages;
    this.maxCachedSampleSets = maxCachedSampleSets;
    this.maxCachedPointSampleBytes = maxCachedPointSampleBytes;
    this.maxConcurrentPointSampleWorkerRequests =
      maxConcurrentPointSampleWorkerRequests;
    this.pointSampleLoading =
      options.pointSampleLoading ??
      (options.createPointSampleWorker ? "worker" : "main-thread");
    this.createPointSampleWorker =
      options.createPointSampleWorker ?? createCopcPointSampleWorker;
    this.getter = createHttpRangeGetter(url);
    this.copcPromise = Copc.create(this.getter);
  }

  inspect(): Promise<CopcInspection> {
    this.inspectionPromise ??= this.copcPromise.then((copc) =>
      createInspection(this.url, copc),
    );

    return this.inspectionPromise;
  }

  loadHierarchySummary(): Promise<CopcHierarchySummary> {
    return Promise.all([
      this.copcPromise,
      this.loadHierarchy(),
    ]).then(([copc, hierarchy]) =>
      summarizeHierarchy(
        hierarchy,
        copc.info.cube,
        this.loadedHierarchyPages.size,
        this.hierarchyNodePageIds,
        this.hierarchyPendingPageIds,
      ),
    );
  }

  async loadHierarchyPage(pageKey: string): Promise<CopcHierarchySummary> {
    const [copc, hierarchy] = await Promise.all([
      this.copcPromise,
      this.loadHierarchy(),
    ]);
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

    const subtree = await this.loadHierarchyPageData(page);
    const parentPageId = this.hierarchyPendingPageIds.get(pageKey);
    delete hierarchy.pages[pageKey];
    this.hierarchyPendingPageIds.delete(pageKey);
    this.recordHierarchyProvenance(subtree, page);
    mergeHierarchy(hierarchy, subtree);
    this.rememberLoadedHierarchyPage(page, {
      pageKey,
      parentPageId,
    });
    this.evictHierarchyPagesIfNeeded(hierarchy);

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
  ): Promise<LoadHierarchyPagesResult> {
    const loadedPageKeys: string[] = [];
    let hierarchy: CopcHierarchySummary | undefined;

    for (const pageKey of [...new Set(pageKeys)]) {
      const before = await this.loadHierarchySummary();

      if (!before.pendingPages.some((page) => page.key === pageKey)) {
        if (before.nodes.some((node) => node.key === pageKey)) {
          hierarchy = before;
          continue;
        }

        throw new Error(`COPC hierarchy page was not found: ${pageKey}`);
      }

      hierarchy = await this.loadHierarchyPage(pageKey);
      loadedPageKeys.push(pageKey);
    }

    return {
      hierarchy: hierarchy ?? (await this.loadHierarchySummary()),
      loadedPageKeys,
    };
  }

  async loadNextHierarchyPage(): Promise<CopcHierarchySummary | undefined> {
    const hierarchy = await this.loadHierarchy();
    const nextPageKey = Object.keys(hierarchy.pages).sort(compareNodeKeys)[0];

    if (!nextPageKey) {
      return undefined;
    }

    return this.loadHierarchyPage(nextPageKey);
  }

  getHierarchyCacheStats(): CopcHierarchyCacheStats {
    return {
      loadedPageCount: this.loadedHierarchyPages.size,
      maxCachedPageCount: this.maxCachedHierarchyPages,
      pendingPageCount: this.hierarchyPendingPageIds.size,
      trackedNodeCount: this.hierarchyNodePageIds.size,
      trackedPendingPageCount: this.hierarchyPendingPageIds.size,
      cacheEvictionCount: this.hierarchyPageCacheEvictionCount,
      isOverLimit:
        this.loadedHierarchyPages.size > this.maxCachedHierarchyPages,
    };
  }

  loadNodePointSamples(
    options: LoadNodePointSamplesOptions = {},
  ): Promise<CopcNodePointSampleResult> {
    throwIfAborted(options.signal);

    const maxPointCount = options.maxPointCount ?? DEFAULT_MAX_POINT_COUNT;
    const nodeKey = options.nodeKey ?? DEFAULT_NODE_KEY;

    if (!Number.isSafeInteger(maxPointCount) || maxPointCount <= 0) {
      throw new Error("maxPointCount must be a positive integer.");
    }

    const cacheKey = `${nodeKey}:${maxPointCount}`;
    const cached = this.nodePointSampleCache.get(cacheKey);

    if (cached) {
      this.pointSampleCacheHitCount += 1;
      this.nodePointSampleCache.delete(cacheKey);
      this.nodePointSampleCache.set(cacheKey, cached);
      return withAbortSignal(cached.promise, options.signal);
    }

    this.pointSampleCacheMissCount += 1;
    let entry: PointSampleCacheEntry;
    const promise = this.loadNodePointSamplesWithoutCache(
      nodeKey,
      maxPointCount,
      options.signal,
    )
      .then((result) => {
        if (this.nodePointSampleCache.get(cacheKey) !== entry) {
          return result;
        }

        const estimatedByteSize = estimatePointSampleResultByteSize(result);
        this.cachedPointSampleBytes +=
          estimatedByteSize - entry.estimatedByteSize;
        entry.estimatedByteSize = estimatedByteSize;
        this.evictPointSampleCacheIfNeeded();
        return result;
      })
      .catch((error: unknown) => {
        if (this.nodePointSampleCache.get(cacheKey) === entry) {
          this.deletePointSampleCacheEntry(cacheKey, false);
        }

        throw error;
      });
    entry = {
      promise,
      estimatedByteSize: 0,
    };
    this.nodePointSampleCache.set(cacheKey, entry);
    this.evictPointSampleCacheIfNeeded();
    return promise;
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

  clearPointSampleCache(): number {
    const clearedCount = this.nodePointSampleCache.size;
    this.nodePointSampleCache.clear();
    this.cachedPointSampleBytes = 0;
    return clearedCount;
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
    this.hierarchyPromise ??= this.copcPromise.then(async (copc) => {
      const subtree = await this.loadHierarchyPageData(
        copc.info.rootHierarchyPage,
      );
      this.recordHierarchyProvenance(subtree, copc.info.rootHierarchyPage);
      this.rememberLoadedHierarchyPage(copc.info.rootHierarchyPage, {
        isRoot: true,
      });
      return subtree;
    });

    return this.hierarchyPromise;
  }

  private loadHierarchyPageData(
    page: Hierarchy.Page,
  ): Promise<Hierarchy.Subtree> {
    const pageId = hierarchyPageId(page);
    let promise = this.hierarchyPagePromises.get(pageId);

    if (!promise) {
      promise = Copc.loadHierarchyPage(this.getter, page);
      this.hierarchyPagePromises.set(pageId, promise);
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

    this.loadedHierarchyPages.delete(pageId);
    this.loadedHierarchyPages.set(pageId, {
      page,
      pageKey: options.pageKey,
      parentPageId: options.parentPageId,
      isRoot: options.isRoot ?? false,
    });
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
    while (this.loadedHierarchyPages.size > this.maxCachedHierarchyPages) {
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
    this.hierarchyPagePromises.delete(pageId);

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

  private getPointSampleWorker(): Worker | undefined {
    if (this.pointSampleLoading !== "worker" || this.pointSampleWorkerUnavailable) {
      return undefined;
    }

    if (this.pointSampleWorker) {
      return this.pointSampleWorker;
    }

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
      this.pointSampleWorker = worker;
      return worker;
    } catch {
      this.pointSampleWorkerUnavailable = true;
      return undefined;
    }
  }

  private loadNodePointSamplesWithWorker(
    nodeKey: string,
    node: Hierarchy.Node,
    maxPointCount: number,
    signal: AbortSignal | undefined,
  ): Promise<CopcNodePointSampleResult> | undefined {
    const worker = this.getPointSampleWorker();

    if (!worker) {
      return undefined;
    }

    throwIfAborted(signal);

    const id = ++this.pointSampleWorkerRequestId;
    const request: CopcPointSampleWorkerLoadRequest = {
      id,
      type: "loadNodePointSamples",
      url: this.url,
      nodeKey,
      node,
      maxPointCount,
    };

    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.cancelPointSampleWorkerRequest(id, createAbortError(signal));
      };
      const cleanup = (): void => {
        signal?.removeEventListener("abort", abort);
      };

      if (signal?.aborted) {
        reject(createAbortError(signal));
        return;
      }

      const entry: PointSampleWorkerRequestEntry = {
        worker,
        request,
        signal,
        cleanup,
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
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

    this.pointSampleWorkerRequests.delete(response.id);
    this.finishPointSampleWorkerRequest(request);

    if (response.type === "loadNodePointSamples:success") {
      request.resolve(response.result);
      return;
    }

    request.reject(createErrorFromWorkerResponse(response.error));
  }

  private drainPointSampleWorkerQueue(): void {
    while (
      this.activePointSampleWorkerRequestCount <
        this.maxConcurrentPointSampleWorkerRequests &&
      this.pointSampleWorkerQueue.length > 0
    ) {
      const request = this.pointSampleWorkerQueue.shift();

      if (
        !request ||
        this.pointSampleWorkerRequests.get(request.request.id) !== request
      ) {
        continue;
      }

      if (request.signal?.aborted) {
        this.pointSampleWorkerRequests.delete(request.request.id);
        request.cleanup();
        request.reject(createAbortError(request.signal));
        continue;
      }

      request.state = "active";
      this.activePointSampleWorkerRequestCount += 1;
      request.worker.postMessage(request.request);
    }
  }

  private cancelPointSampleWorkerRequest(id: number, error: Error): void {
    const request = this.pointSampleWorkerRequests.get(id);

    if (!request) {
      return;
    }

    this.pointSampleWorkerRequests.delete(id);
    if (request.state === "queued") {
      this.removeQueuedPointSampleWorkerRequest(request);
    } else {
      request.worker.postMessage({
        id,
        type: "cancel",
      } satisfies CopcPointSampleWorkerRequest);
      this.finishActivePointSampleWorkerRequest();
    }

    request.cleanup();
    request.reject(error);
    this.drainPointSampleWorkerQueue();
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
    request.cleanup();

    if (request.state === "active") {
      this.finishActivePointSampleWorkerRequest();
      this.drainPointSampleWorkerQueue();
    }
  }

  private finishActivePointSampleWorkerRequest(): void {
    this.activePointSampleWorkerRequestCount = Math.max(
      0,
      this.activePointSampleWorkerRequestCount - 1,
    );
  }

  private terminatePointSampleWorker(error: Error): void {
    const worker = this.pointSampleWorker;
    this.pointSampleWorker = undefined;

    if (worker) {
      worker.terminate();
    }

    for (const request of this.pointSampleWorkerRequests.values()) {
      request.cleanup();
      request.reject(error);
    }
    this.pointSampleWorkerRequests.clear();
    this.pointSampleWorkerQueue.length = 0;
    this.activePointSampleWorkerRequestCount = 0;
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
    signal: AbortSignal | undefined,
  ): Promise<CopcNodePointSampleResult> {
    throwIfAborted(signal);

    const [copc, hierarchy] = await Promise.all([
      this.copcPromise,
      this.loadHierarchy(),
    ]);
    throwIfAborted(signal);

    let node = hierarchy.nodes[nodeKey];

    if (!node && hierarchy.pages[nodeKey]) {
      await this.loadHierarchyPage(nodeKey);
      throwIfAborted(signal);
      node = hierarchy.nodes[nodeKey];
    }

    if (!node) {
      throw new Error(`COPC hierarchy node was not found: ${nodeKey}`);
    }

    this.touchLoadedHierarchyPage(this.hierarchyNodePageIds.get(nodeKey));

    const workerResult = this.loadNodePointSamplesWithWorker(
      nodeKey,
      node,
      maxPointCount,
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

function withAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return promise;
  }

  throwIfAborted(signal);

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
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
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
  return result.points.reduce(
    (total, point) => total + estimatePointSampleByteSize(point),
    0,
  );
}

function estimatePointSampleByteSize(point: CopcPointDataSample): number {
  return (
    POINT_SAMPLE_COORDINATE_BYTES +
    (point.color ? POINT_SAMPLE_COLOR_BYTES : 0)
  );
}

function hierarchyPageId(page: Hierarchy.Page): string {
  return `${page.pageOffset}:${page.pageLength}`;
}
