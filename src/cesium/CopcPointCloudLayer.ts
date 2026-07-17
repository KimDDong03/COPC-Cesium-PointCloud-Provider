import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Intersect,
  Math as CesiumMath,
  type Camera,
  type Scene,
} from "cesium";
import type { Hierarchy } from "copc";
import type {
  CopcHierarchyNodeSummary,
  CopcHierarchySummary,
} from "../core/copc/CopcHierarchySummary";
import type { CopcInspection } from "../core/copc/CopcInspection";
import {
  DEFAULT_MAX_CONCURRENT_COPC_POINT_GEOMETRY_WORKER_REQUESTS,
  DEFAULT_MAX_CONCURRENT_POINT_SAMPLE_WORKER_REQUESTS,
  mergeDecodedPointDataCacheStats,
  type CopcDecodedPointDataCacheStats,
} from "../core/copc/CopcDecodedPointDataCache";
import type {
  CopcMultiNodePointSampleResult,
  CopcNodePointSampleResult,
  CopcPointSampleFormat,
} from "../core/copc/CopcPointDataSample";
import {
  CopcSource,
  type CopcSourceInput,
  type CopcPointSampleLoadingMode,
} from "../core/copc/CopcSource";
import {
  selectHierarchyPagesForTarget,
  type CopcHierarchyPageTargetSelection,
} from "../core/copc/selectHierarchyPagesForTarget";
import {
  selectHierarchyNodesForCamera,
  type CopcHierarchyNodeCameraSelection,
  type CopcTargetVector,
  type SelectHierarchyNodesForCameraOptions,
} from "../core/copc/selectHierarchyNodesForCamera";
import {
  suggestHierarchyNode,
  type CopcHierarchyNodeSuggestion,
  type CopcTargetPoint,
} from "../core/copc/suggestHierarchyNode";
import type { PointSample } from "../core/PointSample";
import {
  consumeSharedAbortableTask,
  createFulfilledSharedAbortableTask,
  createSharedAbortableTask,
  isReusableSharedAbortableTask,
  type SharedAbortableTask,
} from "../core/SharedAbortableTask";
import { calculateCameraHeightAboveCopcBoundsMeters } from "./calculateCameraHeightAboveCopcBounds";
import { CesiumBoundsRenderer } from "./CesiumBoundsRenderer";
import { CesiumPrimitivePointRenderer } from "./CesiumPrimitivePointRenderer";
import {
  isCopcPointCloudBatchRenderer,
  isCopcPointCloudGeometryBatchRenderer,
  type CopcPointCloudRenderer,
  type CopcPointCloudRendererFactory,
  type PointGeometryBatch,
  type PointSampleBatch,
} from "./CopcPointCloudRenderer";
import {
  createDefaultCopcCoordinateTransforms,
  type CopcCoordinateTransformFactory,
  type CopcCoordinateTransformSet,
  type CopcCoordinateTransformStatus,
} from "./copcCoordinateTransform";
import { createPointSamplesFromCopc } from "./createPointSamplesFromCopc";
import {
  resolveCopcPointColorStyle,
  type CopcPointColorMode,
  type ResolvedCopcPointColorStyle,
} from "./copcPointColorizer";
import {
  CesiumPointGeometryWorkerPool,
  type CesiumPointGeometryLoadingMode,
} from "./CesiumPointGeometryWorkerPool";
import {
  CesiumCopcPointGeometryWorkerPool,
  type CesiumCopcPointGeometryWorkerCancellationMode,
} from "./CesiumCopcPointGeometryWorkerPool";
import type {
  CopcNodePointGeometryBatchResult,
  CopcPointGeometryBatchTiming,
} from "./CesiumCopcPointGeometryWorkerProtocol";
import {
  createCesiumPointGeometryTransform,
  createNodePointSampleBatchKey,
  createPointGeometryBatchFromCopc,
  estimatePointGeometryBatchByteSize,
  getPointGeometryBatchBackingBuffers,
  getPointDataSamples,
  withCopcPointGeometryBatchRenderMetadata,
  type CesiumPointGeometryTransform,
} from "./pointGeometryBatch";
import {
  createProgressPointGeometryResults,
  limitNodeSampleProgressEntries,
  limitPointGeometryBatchResult,
  limitPointGeometryProgressEntries,
  markPointGeometryBatchResultCacheHit,
} from "./progressivePointResultBudget";
import { createCopcNodeAncestorKeys } from "./CopcCameraStreamNodePlan";

export interface CopcPointCloudLayerOptions {
  readonly url?: string;
  readonly source?: CopcSourceInput;
  readonly maxPointCountPerNode?: number;
  readonly maxCachedHierarchyPages?: number;
  readonly maxCachedHierarchyPageBytes?: number;
  readonly maxCachedSampleSets?: number;
  readonly maxCachedPointSampleBytes?: number;
  readonly maxCachedPointGeometryBatches?: number;
  readonly maxCachedTransformedPointGeometryBatches?: number;
  readonly maxCachedPointGeometryBytes?: number;
  readonly maxDecodedPointDataViewsPerWorker?: number;
  readonly maxDecodedPointDataViewBytesPerWorker?: number;
  readonly maxDecodedPointDataViewBytesAcrossWorkers?: number;
  readonly maxConcurrentPointSampleWorkerRequests?: number;
  readonly maxConcurrentPointGeometryWorkerRequests?: number;
  readonly activePointGeometryWorkerCancellation?: CesiumCopcPointGeometryWorkerCancellationMode;
  readonly decodedNodeWorkerFallbackDelayMilliseconds?: number;
  readonly pointSampleLoading?: CopcPointSampleLoadingMode;
  readonly pointGeometryLoading?: CesiumPointGeometryLoadingMode;
  readonly createPointSampleWorker?: () => Worker;
  readonly createPointGeometryWorker?: () => Worker;
  readonly createCopcPointGeometryWorker?: () => Worker;
  readonly createPointRenderer?: CopcPointCloudRendererFactory;
  readonly pointColorMode?: CopcPointColorMode;
  readonly showBounds?: boolean;
  readonly coordinateTransforms?: CopcCoordinateTransformFactory;
}

export interface CopcPointCloudLayerLoadResult {
  readonly inspection: CopcInspection;
  readonly hierarchy: CopcHierarchySummary;
  readonly coordinateTransform: CopcCoordinateTransformStatus;
}

export interface CopcPointCloudLayerRenderStats {
  readonly pointCount: number;
  readonly estimatedRenderPayloadBytes: number;
  readonly coordinateTransformMilliseconds: number;
  readonly rendererSetPointsMilliseconds: number;
  readonly boundsRenderMilliseconds: number;
  readonly totalRenderMilliseconds: number;
  readonly pointGeometryTimings?: CopcPointCloudLayerPointGeometryTimingStats;
}

export interface CopcPointCloudLayerPointGeometryTimingStats {
  readonly nodeCount: number;
  readonly cacheHitCount: number;
  readonly slowestNodes: readonly CopcPointCloudLayerPointGeometryNodeTimingStats[];
  readonly pointDataViewMilliseconds: number;
  readonly sampleMilliseconds: number;
  readonly geometryMilliseconds: number;
  readonly workerTotalMilliseconds: number;
  readonly requestQueueMilliseconds: number;
  readonly requestRoundTripMilliseconds: number;
  readonly maxPointDataViewMilliseconds: number;
  readonly maxSampleMilliseconds: number;
  readonly maxGeometryMilliseconds: number;
  readonly maxWorkerTotalMilliseconds: number;
  readonly maxRequestQueueMilliseconds: number;
  readonly maxRequestRoundTripMilliseconds: number;
}

export interface CopcPointCloudLayerPointGeometryNodeTimingStats {
  readonly nodeKey: string;
  readonly nodePointCount: number;
  readonly sampledPointCount: number;
  readonly pointDataLength?: number;
  readonly pointDataViewMilliseconds: number;
  readonly pointDataViewCacheHit: boolean;
  readonly sampleMilliseconds: number;
  readonly geometryMilliseconds: number;
  readonly workerTotalMilliseconds: number;
  readonly requestQueueMilliseconds: number;
  readonly requestRoundTripMilliseconds: number;
}

export interface CopcPointCloudLayerPointGeometryCacheStats {
  readonly cachedLoadedBatchCount: number;
  readonly maxCachedLoadedBatchCount: number;
  readonly loadedBatchCacheHitCount: number;
  readonly loadedBatchCacheMissCount: number;
  readonly loadedBatchCacheReuseCount: number;
  readonly loadedBatchCacheEvictionCount: number;
  readonly cachedTransformedBatchCount: number;
  readonly maxCachedTransformedBatchCount: number;
  readonly transformedBatchCacheHitCount: number;
  readonly transformedBatchCacheMissCount: number;
  readonly transformedBatchCacheEvictionCount: number;
  readonly cachedPointGeometryBytes: number;
  readonly maxCachedPointGeometryBytes: number | undefined;
  readonly peakCachedPointGeometryBytes: number;
  readonly pointGeometryCacheByteEvictionCount: number;
  readonly pointGeometryCacheEvictedBytes: number;
  readonly oversizedPointGeometryBatchCacheSkipCount: number;
}

export interface CopcPointCloudLayerDecodedPointDataCacheStats extends CopcDecodedPointDataCacheStats {
  readonly pointSample: CopcDecodedPointDataCacheStats;
  readonly integratedPointGeometry: CopcDecodedPointDataCacheStats;
}

export interface CopcPointCloudLayerStreamingCacheResetResult {
  readonly pointSampleSetCount: number;
  readonly pointGeometryBatchCount: number;
  readonly pointSampleWorkerCount: number;
  readonly pointGeometryWorkerCount: number;
}

export interface CopcPointCloudLayerRenderNodeOptions {
  readonly maxPointCount?: number;
  readonly requestPriority?: number;
  readonly showBounds?: boolean;
  readonly signal?: AbortSignal;
}

export interface CopcPointCloudLayerRenderNodesOptions {
  readonly maxPointCountPerNode?: number;
  readonly maxRenderedPointCount?: number;
  readonly includePointsInResult?: boolean;
  readonly requestPriority?: number;
  readonly showBounds?: boolean;
  readonly signal?: AbortSignal;
}

export interface CopcPointCloudLayerRenderNodeSampleResultsOptions {
  readonly includePointsInResult?: boolean;
  readonly maxPointCountPerNode?: number;
  readonly maxRenderedPointCount?: number;
  readonly showBounds?: boolean;
  readonly signal?: AbortSignal;
}

export interface CopcPointCloudLayerPrepareNodesOptions {
  readonly maxPointCountPerNode?: number;
  readonly maxRenderedPointCount?: number;
  readonly requestPriority?: number;
  readonly signal?: AbortSignal;
}

export interface CopcPointCloudLayerPrefetchNodePointDataOptions {
  readonly maxConcurrentRequests?: number;
  readonly requestPriority?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (
    result: CopcPointCloudLayerPrefetchNodePointDataResult,
  ) => void;
}

export interface CopcPointCloudLayerPrefetchNodePointDataResult {
  readonly requestedNodeCount: number;
  readonly prefetchedNodeCount: number;
  readonly skippedNodeCount: number;
}

export interface CopcPointCloudLayerPrefetchNodePointGeometryOptions extends CopcPointCloudLayerPrefetchNodePointDataOptions {
  readonly maxPointCountPerNode?: number;
}

export interface CopcPointCloudLayerPrefetchNodePointGeometryResult extends CopcPointCloudLayerPrefetchNodePointDataResult {}

export interface CopcPointCloudLayerProgressivePrepareNodesOptions extends CopcPointCloudLayerPrepareNodesOptions {
  readonly maxActiveProgressiveNodeRequests?: number;
  readonly progressBatchNodeCount?: number;
  readonly onProgress?: (result: CopcPointCloudLayerPrepareNodesResult) => void;
}

export type CopcPointCloudLayerProgressiveRenderMode =
  "incremental" | "final-only";

export type CopcPointCloudLayerPostStopProgressMode = "render" | "load-only";

export type CopcPointCloudLayerPostStopLoadingMode = "await" | "background";

export type CopcPointCloudLayerProgressiveNodeOrder =
  "selection" | "lightweight-first" | "source-points-first";

/**
 * Describes an intermediate progressive frame after point-budget limiting but
 * before it mutates the shared renderer.
 */
export interface CopcPointCloudLayerProgressiveRenderCandidate {
  readonly nodeKeys: readonly string[];
  readonly sampledPointCount: number;
  /** Per-node density evidence after the aggregate render budget is applied. */
  readonly nodeSamples: readonly {
    readonly nodeKey: string;
    readonly nodePointCount: number;
    readonly sampledPointCount: number;
  }[];
}

export interface CopcPointCloudLayerProgressiveRenderNodesOptions extends CopcPointCloudLayerRenderNodesOptions {
  readonly backgroundNodeResults?: readonly CopcNodePointSampleResult[];
  readonly continueLoadingAfterStop?: boolean;
  readonly initialNodeResults?: readonly CopcNodePointSampleResult[];
  readonly maxActiveProgressiveNodeRequests?: number;
  /** Positive source-point weights aligned with the requested node keys. */
  readonly nodePointCountWeights?: readonly number[];
  readonly nodeRequestOrder?: CopcPointCloudLayerProgressiveNodeOrder;
  readonly postStopLoadingMode?: CopcPointCloudLayerPostStopLoadingMode;
  readonly postStopProgressMode?: CopcPointCloudLayerPostStopProgressMode;
  readonly progressBatchNodeCount?: number;
  readonly progressRenderMode?: CopcPointCloudLayerProgressiveRenderMode;
  readonly skipInitialProgressRender?: boolean;
  /**
   * Loads up to the configured per-node cap and applies the global point
   * budget only while composing render payloads. Defaults to false.
   */
  readonly useSourcePointBudgetHeadroom?: boolean;
  /**
   * Returning false keeps the currently committed renderer frame and skips
   * this intermediate progress notification. The final render is never
   * offered to this callback and is always committed.
   */
  readonly shouldRenderProgress?: (
    candidate: CopcPointCloudLayerProgressiveRenderCandidate,
  ) => boolean;
  readonly onProgress?: (result: CopcPointCloudLayerNodesRenderResult) => void;
  readonly shouldStopAfterProgress?: (
    result: CopcPointCloudLayerNodesRenderResult,
  ) => boolean;
}

export interface CopcPointCloudLayerCameraSelectionOptions extends Omit<
  SelectHierarchyNodesForCameraOptions,
  "target" | "viewDirection" | "viewportHeightPixels"
> {
  readonly camera: Camera;
  readonly viewportWidthPixels?: number;
  readonly viewportHeightPixels?: number;
  readonly signal?: AbortSignal;
}

export interface CopcPointCloudLayerHierarchyExpansionOptions {
  readonly camera: Camera;
  readonly viewportWidthPixels?: number;
  readonly viewportHeightPixels?: number;
  readonly maxPages?: number;
  readonly minDepth?: number;
  readonly maxDepth?: number;
  readonly signal?: AbortSignal;
}

export interface CopcPointCloudLayerAutomaticRenderOptions extends CopcPointCloudLayerCameraSelectionOptions {
  /** Include every available additive COPC ancestor for selected camera nodes. */
  readonly includeAncestorNodes?: boolean;
  readonly maxPointCountPerNode?: number;
  readonly maxRenderedPointCount?: number;
  readonly includePointsInResult?: boolean;
  readonly requestPriority?: number;
  readonly showBounds?: boolean;
  readonly expandHierarchy?: boolean;
  readonly maxHierarchyPages?: number;
  readonly maxHierarchyPageDepth?: number;
  readonly signal?: AbortSignal;
}

export interface CopcPointCloudLayerProgressiveAutomaticRenderOptions extends CopcPointCloudLayerAutomaticRenderOptions {
  readonly backgroundNodeResults?: readonly CopcNodePointSampleResult[];
  readonly continueLoadingAfterStop?: boolean;
  readonly initialNodeResults?: readonly CopcNodePointSampleResult[];
  readonly maxActiveProgressiveNodeRequests?: number;
  readonly nodeRequestOrder?: CopcPointCloudLayerProgressiveNodeOrder;
  readonly nodeRenderOrder?: CopcPointCloudLayerProgressiveNodeOrder;
  readonly postStopLoadingMode?: CopcPointCloudLayerPostStopLoadingMode;
  readonly postStopProgressMode?: CopcPointCloudLayerPostStopProgressMode;
  readonly progressBatchNodeCount?: number;
  readonly progressRenderMode?: CopcPointCloudLayerProgressiveRenderMode;
  readonly skipInitialProgressRender?: boolean;
  readonly onProgress?: (
    result: CopcPointCloudLayerAutomaticRenderResult,
  ) => void;
  readonly shouldStopAfterProgress?: (
    result: CopcPointCloudLayerAutomaticRenderResult,
  ) => boolean;
}

export interface CopcPointCloudLayerWarmupOptions {
  readonly workerCount?: number;
}

export interface CopcPointCloudLayerNodeRenderResult {
  readonly inspection: CopcInspection;
  readonly node: CopcHierarchyNodeSummary;
  readonly pointSamples: CopcNodePointSampleResult;
  readonly points: readonly PointSample[];
  readonly renderStats: CopcPointCloudLayerRenderStats;
}

export interface CopcPointCloudLayerNodesRenderResult {
  readonly inspection: CopcInspection;
  readonly nodes: readonly CopcHierarchyNodeSummary[];
  readonly pointSamples: CopcMultiNodePointSampleResult;
  readonly points: readonly PointSample[];
  readonly renderStats: CopcPointCloudLayerRenderStats;
}

export interface CopcPointCloudLayerPrepareNodesResult {
  readonly inspection: CopcInspection;
  readonly nodes: readonly CopcHierarchyNodeSummary[];
  readonly pointSamples: CopcMultiNodePointSampleResult;
}

export interface CopcPointCloudLayerAutomaticRenderResult extends CopcPointCloudLayerNodesRenderResult {
  readonly cameraSelection: CopcHierarchyNodeCameraSelection;
  readonly hierarchyExpansion:
    CopcPointCloudLayerHierarchyExpansionResult | undefined;
}

export interface CopcPointCloudLayerHierarchyExpansionResult {
  readonly hierarchy: CopcHierarchySummary;
  readonly pageSelection: CopcHierarchyPageTargetSelection;
  readonly loadedPageKeys: readonly string[];
  /** Pending hierarchy pages covering the camera target after this bounded expansion. */
  readonly pendingRelevantHierarchyPageCount: number;
  /** Stable residual-page identity used to stop cache-eviction/no-progress cycles. */
  readonly pendingRelevantHierarchyPageSignature: string | undefined;
  /** Whether the current camera target has no more hierarchy pages through the requested depth. */
  readonly isHierarchyCompleteForView: boolean;
}

interface LoadedNodePointGeometryBatchCacheEntry {
  readonly nodeKey: string;
  readonly maxPointCount: number;
  readonly transformKey: string;
  readonly promise: Promise<CopcNodePointGeometryBatchResult>;
  state: "pending" | "resolved";
  lastAccessSequence: number;
}

interface PointGeometryBufferAllocation {
  readonly byteSize: number;
  referenceCount: number;
}

type PointGeometryCacheKind = "loaded" | "transformed";

const DEFAULT_MAX_CACHED_POINT_GEOMETRY_BATCHES = 96;
const DEFAULT_MAX_CACHED_TRANSFORMED_POINT_GEOMETRY_BATCHES = 96;
const PROGRESSIVE_NODE_PRIORITY_BOOST = 0.9;

export class CopcPointCloudLayer {
  readonly source: CopcSource;

  private readonly scene: Scene;
  private readonly pointRenderer: CopcPointCloudRenderer;
  private readonly boundsRenderer: CesiumBoundsRenderer;
  private readonly pointGeometryWorkerPool: CesiumPointGeometryWorkerPool;
  private readonly copcPointGeometryWorkerPool: CesiumCopcPointGeometryWorkerPool;
  private readonly pointGeometryLoading: CesiumPointGeometryLoadingMode;
  private readonly pointColorMode: CopcPointColorMode;
  private readonly defaultMaxPointCountPerNode: number | undefined;
  private readonly defaultShowBounds: boolean;
  private readonly coordinateTransformFactory: CopcCoordinateTransformFactory;
  private coordinateTransforms: CopcCoordinateTransformSet | undefined;
  private coordinateTransformStatus: CopcCoordinateTransformStatus | undefined;
  private pointGeometryTransform: CesiumPointGeometryTransform | undefined;
  private pointColorStyle: ResolvedCopcPointColorStyle | undefined;
  // Hierarchy nodes are immutable snapshots. Identity-based caching keeps a
  // replacement hierarchy from reusing bounds transformed for an older node.
  private readonly cameraSelectionBoundsSphereCache = new WeakMap<
    CopcHierarchyNodeSummary,
    BoundingSphere
  >();
  private readonly transformedNodeResultPoints = new WeakMap<
    CopcNodePointSampleResult,
    readonly PointSample[]
  >();
  private readonly transformedNodeResultGeometryBatches = new Map<
    string,
    SharedAbortableTask<PointGeometryBatch>
  >();
  private readonly loadedNodePointGeometryBatches = new Map<
    string,
    LoadedNodePointGeometryBatchCacheEntry
  >();
  private readonly maxCachedPointGeometryBatches: number;
  private readonly maxCachedTransformedPointGeometryBatches: number;
  private readonly maxCachedPointGeometryBytes: number | undefined;
  private readonly maxDecodedPointDataViewBytesAcrossWorkers:
    number | undefined;
  private readonly loadedPointGeometryCacheBatches = new Map<
    string,
    PointGeometryBatch
  >();
  private readonly transformedPointGeometryCacheBatches = new Map<
    string,
    PointGeometryBatch
  >();
  private readonly pointGeometryBufferAllocations = new Map<
    ArrayBufferLike,
    PointGeometryBufferAllocation
  >();
  private readonly transformedPointGeometryCacheAccessSequences = new Map<
    string,
    number
  >();
  private pointGeometryCacheAccessSequence = 0;
  private cachedPointGeometryBytes = 0;
  private peakCachedPointGeometryBytes = 0;
  private pointGeometryCacheByteEvictionCount = 0;
  private pointGeometryCacheEvictedBytes = 0;
  private oversizedPointGeometryBatchCacheSkipCount = 0;
  private loadedBatchCacheHitCount = 0;
  private loadedBatchCacheMissCount = 0;
  private loadedBatchCacheReuseCount = 0;
  private loadedBatchCacheEvictionCount = 0;
  private transformedBatchCacheHitCount = 0;
  private transformedBatchCacheMissCount = 0;
  private transformedBatchCacheEvictionCount = 0;
  private loadPromise: Promise<void> | undefined;
  private loadedInspection: CopcInspection | undefined;
  private loadedHierarchy: CopcHierarchySummary | undefined;
  private rendererRevision = 0;
  private destroyed = false;

  constructor(scene: Scene, options: CopcPointCloudLayerOptions) {
    this.scene = scene;
    const sourceInput = options.source ?? options.url;

    if (!sourceInput) {
      throw new Error("CopcPointCloudLayer requires a COPC url or source.");
    }

    this.maxDecodedPointDataViewBytesAcrossWorkers =
      readOptionalPositiveIntegerOption(
        "maxDecodedPointDataViewBytesAcrossWorkers",
        options.maxDecodedPointDataViewBytesAcrossWorkers,
      );
    const decodedPointDataWorkerBudgets = allocateDecodedPointDataWorkerBudgets(
      {
        maxBytesAcrossWorkers: this.maxDecodedPointDataViewBytesAcrossWorkers,
        pointSampleWorkerSlotCount: getPointSampleWorkerSlotCount(options),
        integratedPointGeometryWorkerSlotCount:
          getIntegratedPointGeometryWorkerSlotCount(options),
      },
    );

    this.source = new CopcSource(sourceInput, {
      maxCachedHierarchyPages: options.maxCachedHierarchyPages,
      maxCachedHierarchyPageBytes: options.maxCachedHierarchyPageBytes,
      maxCachedSampleSets: options.maxCachedSampleSets,
      maxCachedPointSampleBytes: options.maxCachedPointSampleBytes,
      maxDecodedPointDataViewsPerWorker:
        options.maxDecodedPointDataViewsPerWorker,
      maxDecodedPointDataViewBytesPerWorker:
        options.maxDecodedPointDataViewBytesPerWorker,
      maxDecodedPointDataViewBytesAcrossWorkers:
        decodedPointDataWorkerBudgets.pointSample,
      maxConcurrentPointSampleWorkerRequests:
        options.maxConcurrentPointSampleWorkerRequests,
      pointSampleLoading: options.pointSampleLoading,
      createPointSampleWorker: options.createPointSampleWorker,
    });
    this.pointRenderer = (
      options.createPointRenderer ??
      ((scene) => new CesiumPrimitivePointRenderer(scene))
    )(scene);
    this.pointGeometryWorkerPool = new CesiumPointGeometryWorkerPool({
      pointGeometryLoading: options.pointGeometryLoading,
      maxConcurrentPointGeometryWorkerRequests:
        options.maxConcurrentPointGeometryWorkerRequests,
      createPointGeometryWorker: options.createPointGeometryWorker,
    });
    this.copcPointGeometryWorkerPool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: options.pointGeometryLoading,
      maxConcurrentPointGeometryWorkerRequests:
        options.maxConcurrentPointGeometryWorkerRequests,
      activeRequestCancellation: options.activePointGeometryWorkerCancellation,
      decodedNodeWorkerFallbackDelayMilliseconds:
        options.decodedNodeWorkerFallbackDelayMilliseconds,
      maxDecodedPointDataViewsPerWorker:
        options.maxDecodedPointDataViewsPerWorker,
      maxDecodedPointDataViewBytesPerWorker:
        options.maxDecodedPointDataViewBytesPerWorker,
      maxDecodedPointDataViewBytesAcrossWorkers:
        decodedPointDataWorkerBudgets.integratedPointGeometry,
      createCopcPointGeometryWorker: options.createCopcPointGeometryWorker,
    });
    this.boundsRenderer = new CesiumBoundsRenderer(scene);
    this.pointGeometryLoading = options.pointGeometryLoading ?? "main-thread";
    this.pointColorMode = readPointColorMode(options.pointColorMode);
    this.defaultMaxPointCountPerNode = options.maxPointCountPerNode;
    this.defaultShowBounds = options.showBounds ?? true;
    this.coordinateTransformFactory =
      options.coordinateTransforms ?? createDefaultCopcCoordinateTransforms;
    this.maxCachedPointGeometryBatches = readPositiveIntegerOption(
      "maxCachedPointGeometryBatches",
      options.maxCachedPointGeometryBatches,
      DEFAULT_MAX_CACHED_POINT_GEOMETRY_BATCHES,
    );
    this.maxCachedTransformedPointGeometryBatches = readPositiveIntegerOption(
      "maxCachedTransformedPointGeometryBatches",
      options.maxCachedTransformedPointGeometryBatches,
      DEFAULT_MAX_CACHED_TRANSFORMED_POINT_GEOMETRY_BATCHES,
    );
    this.maxCachedPointGeometryBytes = readOptionalPositiveIntegerOption(
      "maxCachedPointGeometryBytes",
      options.maxCachedPointGeometryBytes,
    );
  }

  get inspection(): CopcInspection | undefined {
    return this.loadedInspection;
  }

  get hierarchy(): CopcHierarchySummary | undefined {
    return this.loadedHierarchy;
  }

  get coordinateTransform(): CopcCoordinateTransformStatus | undefined {
    return this.coordinateTransformStatus;
  }

  getCameraHeightAbovePointCloudMeters(
    cameraHeightMeters: number,
  ): number | undefined {
    this.assertNotDestroyed();

    if (!this.loadedInspection) {
      return undefined;
    }

    return calculateCameraHeightAboveCopcBoundsMeters(
      cameraHeightMeters,
      this.loadedInspection.bounds,
      this.getCoordinateTransforms(this.loadedInspection).toCesium,
    );
  }

  async load(): Promise<CopcPointCloudLayerLoadResult> {
    this.assertNotDestroyed();

    let loadPromise = this.loadPromise;

    if (!loadPromise) {
      loadPromise = Promise.all([
        this.source.inspect(),
        this.source.loadHierarchySummary(),
      ]).then(([inspection, hierarchy]) => {
        this.assertNotDestroyed();
        this.loadedInspection = inspection;
        this.loadedHierarchy = hierarchy;
        this.pointColorStyle = resolveCopcPointColorStyle(
          this.pointColorMode,
          inspection.bounds,
        );
        this.getCoordinateTransformStatus(inspection);
      });
      this.loadPromise = loadPromise;
      void loadPromise.catch(() => {
        if (this.loadPromise === loadPromise) {
          this.loadPromise = undefined;
        }
      });
    }

    await loadPromise;
    this.assertNotDestroyed();

    return {
      inspection: this.requireInspection(),
      hierarchy: this.requireHierarchy(),
      coordinateTransform: this.requireCoordinateTransformStatus(),
    };
  }

  async loadHierarchyPage(pageKey: string): Promise<CopcHierarchySummary> {
    this.assertNotDestroyed();
    await this.load();
    this.loadedHierarchy = await this.source.loadHierarchyPage(pageKey);
    this.assertNotDestroyed();

    return this.loadedHierarchy;
  }

  async loadNextHierarchyPage(): Promise<CopcHierarchySummary | undefined> {
    this.assertNotDestroyed();
    await this.load();
    const hierarchy = await this.source.loadNextHierarchyPage();
    this.assertNotDestroyed();

    if (hierarchy) {
      this.loadedHierarchy = hierarchy;
    }

    return hierarchy;
  }

  async expandHierarchyForCamera(
    options: CopcPointCloudLayerHierarchyExpansionOptions,
  ): Promise<CopcPointCloudLayerHierarchyExpansionResult | undefined> {
    this.assertNotDestroyed();

    const {
      camera,
      maxPages: configuredMaxPages,
      signal,
      viewportWidthPixels,
      viewportHeightPixels,
      ...selectionOptions
    } = options;
    throwIfAborted(signal);
    const maxPages = configuredMaxPages ?? 2;
    if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
      throw new Error("maxPages must be a positive integer.");
    }
    const { inspection, hierarchy: initialHierarchy } = await this.load();
    throwIfAborted(signal);
    const target = this.cameraViewCenterToCopc(
      camera,
      inspection,
      viewportWidthPixels,
      viewportHeightPixels,
    );
    let remainingPageCount = maxPages;
    let hierarchy = initialHierarchy;
    const selectedPages: CopcHierarchyPageTargetSelection["pages"][number][] =
      [];
    const selectedPageKeys = new Set<string>();
    const loadedPageKeys: string[] = [];

    while (remainingPageCount > 0) {
      const currentViewPendingPages = this.selectCurrentViewHierarchyPages(
        hierarchy.pendingPages,
        camera,
        inspection,
        target,
        selectionOptions,
      );
      const pageSelection = selectHierarchyPagesForTarget(
        currentViewPendingPages.filter(
          (page) => !selectedPageKeys.has(page.key),
        ),
        {
          ...selectionOptions,
          maxPages: remainingPageCount,
          target,
        },
      );

      if (!pageSelection) {
        break;
      }

      for (const page of pageSelection.pages) {
        selectedPages.push(page);
        selectedPageKeys.add(page.key);
      }
      remainingPageCount -= pageSelection.pages.length;

      const result = await this.source.loadHierarchyPages(
        pageSelection.pages.map((page) => page.key),
        { signal },
      );
      throwIfAborted(signal);
      this.assertNotDestroyed();
      hierarchy = result.hierarchy;
      this.loadedHierarchy = hierarchy;

      for (const pageKey of result.loadedPageKeys) {
        if (!loadedPageKeys.includes(pageKey)) {
          loadedPageKeys.push(pageKey);
        }
      }

      if (result.loadedPageKeys.length === 0) {
        break;
      }
    }

    if (selectedPages.length === 0) {
      return undefined;
    }

    const pendingRelevantHierarchyPages = this.selectCurrentViewHierarchyPages(
      hierarchy.pendingPages,
      camera,
      inspection,
      target,
      selectionOptions,
    );

    return {
      hierarchy,
      pageSelection: {
        pages: selectedPages,
        reason: `Selected ${selectedPages.length} camera-target hierarchy pages across newly revealed levels.`,
      },
      loadedPageKeys,
      pendingRelevantHierarchyPageCount: pendingRelevantHierarchyPages.length,
      pendingRelevantHierarchyPageSignature: createHierarchyPageSignature(
        pendingRelevantHierarchyPages,
      ),
      isHierarchyCompleteForView: pendingRelevantHierarchyPages.length === 0,
    };
  }

  warmUpPointGeometryWorkers(
    options: CopcPointCloudLayerWarmupOptions = {},
  ): void {
    this.assertNotDestroyed();
    this.copcPointGeometryWorkerPool.warmUp({
      ...options,
      copc: this.source.getLoadedCopcMetadata(),
      source: this.source.getDescriptor(),
    });
  }

  async waitForPointGeometryWorkerWarmup(): Promise<void> {
    this.assertNotDestroyed();
    await this.copcPointGeometryWorkerPool.waitForWarmup();
    this.assertNotDestroyed();
  }

  warmUpPointSampleWorkers(
    options: CopcPointCloudLayerWarmupOptions = {},
  ): number {
    this.assertNotDestroyed();
    return this.source.warmUpPointSampleWorkers(options);
  }

  async prefetchNodePointDataViews(
    nodeKeys: readonly string[],
    options: CopcPointCloudLayerPrefetchNodePointDataOptions = {},
  ): Promise<CopcPointCloudLayerPrefetchNodePointDataResult> {
    this.assertNotDestroyed();

    const normalizedNodeKeys = uniqueNodeKeys(nodeKeys);

    if (normalizedNodeKeys.length === 0) {
      return {
        requestedNodeCount: 0,
        prefetchedNodeCount: 0,
        skippedNodeCount: 0,
      };
    }

    const { hierarchy } = await this.load();
    throwIfAborted(options.signal);
    this.assertNotDestroyed();

    if (this.pointGeometryLoading !== "integrated-worker") {
      const result = {
        requestedNodeCount: normalizedNodeKeys.length,
        prefetchedNodeCount: 0,
        skippedNodeCount: normalizedNodeKeys.length,
      };

      options.onProgress?.(result);
      return result;
    }

    const nodes = normalizedNodeKeys.map((nodeKey) =>
      findRequiredNode(hierarchy, nodeKey),
    );
    const requestPriorities = createProgressiveNodeRequestPriorities(
      nodes,
      options.requestPriority,
    );
    const maxConcurrentRequests = readPositiveInteger(
      options.maxConcurrentRequests,
      normalizedNodeKeys.length,
    );
    const source = this.source.getDescriptor();
    const copc = this.source.getLoadedCopcMetadata();
    let prefetchedNodeCount = 0;
    let skippedNodeCount = 0;
    let nextNodeIndex = 0;
    const reportProgress = (): void => {
      options.onProgress?.({
        requestedNodeCount: normalizedNodeKeys.length,
        prefetchedNodeCount,
        skippedNodeCount,
      });
    };
    const prefetchNextNodes = async (): Promise<void> => {
      while (nextNodeIndex < nodes.length) {
        throwIfAborted(options.signal);
        const index = nextNodeIndex;
        nextNodeIndex += 1;
        const node = nodes[index];

        if (
          this.copcPointGeometryWorkerPool.hasDecodedNodePointData({
            source,
            nodeKey: node.key,
          })
        ) {
          skippedNodeCount += 1;
          reportProgress();
          continue;
        }

        const result = this.copcPointGeometryWorkerPool.prefetchNodePointData({
          copc,
          source,
          nodeKey: node.key,
          node: createSourceHierarchyNode(node),
          priority: requestPriorities[index],
          signal: options.signal,
        });

        if (!result) {
          skippedNodeCount += 1;
          reportProgress();
          continue;
        }

        await result;
        prefetchedNodeCount += 1;
        reportProgress();
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(maxConcurrentRequests, nodes.length) },
        () => prefetchNextNodes(),
      ),
    );
    throwIfAborted(options.signal);

    return {
      requestedNodeCount: normalizedNodeKeys.length,
      prefetchedNodeCount,
      skippedNodeCount,
    };
  }

  async prefetchNodePointGeometryBatches(
    nodeKeys: readonly string[],
    options: CopcPointCloudLayerPrefetchNodePointGeometryOptions = {},
  ): Promise<CopcPointCloudLayerPrefetchNodePointGeometryResult> {
    this.assertNotDestroyed();

    const normalizedNodeKeys = uniqueNodeKeys(nodeKeys);

    if (normalizedNodeKeys.length === 0) {
      return {
        requestedNodeCount: 0,
        prefetchedNodeCount: 0,
        skippedNodeCount: 0,
      };
    }

    const { hierarchy } = await this.load();
    throwIfAborted(options.signal);
    this.assertNotDestroyed();

    if (
      this.pointGeometryLoading !== "integrated-worker" ||
      !this.pointGeometryTransform ||
      !isCopcPointCloudGeometryBatchRenderer(this.pointRenderer)
    ) {
      const result = {
        requestedNodeCount: normalizedNodeKeys.length,
        prefetchedNodeCount: 0,
        skippedNodeCount: normalizedNodeKeys.length,
      };

      options.onProgress?.(result);
      return result;
    }

    const nodes = normalizedNodeKeys.map((nodeKey) =>
      findRequiredNode(hierarchy, nodeKey),
    );
    const requestPriorities = createProgressiveNodeRequestPriorities(
      nodes,
      options.requestPriority,
    );
    const maxConcurrentRequests = readPositiveInteger(
      options.maxConcurrentRequests,
      normalizedNodeKeys.length,
    );
    const transformKey = createPointGeometryTransformCacheKey(
      this.pointGeometryTransform,
    );
    let prefetchedNodeCount = 0;
    let skippedNodeCount = 0;
    let nextNodeIndex = 0;
    const reportProgress = (): void => {
      options.onProgress?.({
        requestedNodeCount: normalizedNodeKeys.length,
        prefetchedNodeCount,
        skippedNodeCount,
      });
    };
    const prefetchNextNodes = async (): Promise<void> => {
      while (nextNodeIndex < nodes.length) {
        throwIfAborted(options.signal);
        const index = nextNodeIndex;
        nextNodeIndex += 1;
        const node = nodes[index];
        const maxPointCount = readPositiveInteger(
          options.maxPointCountPerNode,
          this.defaultMaxPointCountPerNode ?? node.pointCount,
        );

        if (
          this.findReusableLoadedNodePointGeometryBatch(
            node,
            maxPointCount,
            transformKey,
          )
        ) {
          skippedNodeCount += 1;
          reportProgress();
          continue;
        }

        await this.loadNodePointGeometryBatch(
          node,
          maxPointCount,
          options.signal,
          requestPriorities[index],
        );
        prefetchedNodeCount += 1;
        reportProgress();
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(maxConcurrentRequests, nodes.length) },
        () => prefetchNextNodes(),
      ),
    );
    throwIfAborted(options.signal);

    return {
      requestedNodeCount: normalizedNodeKeys.length,
      prefetchedNodeCount,
      skippedNodeCount,
    };
  }

  async renderNode(
    nodeKey: string,
    options: CopcPointCloudLayerRenderNodeOptions = {},
  ): Promise<CopcPointCloudLayerNodeRenderResult> {
    this.assertNotDestroyed();

    const { inspection, hierarchy } = await this.load();
    throwIfAborted(options.signal);
    this.assertNotDestroyed();

    const node = findRequiredNode(hierarchy, nodeKey);
    const pointSamples = await this.source.loadNodePointSamples({
      nodeKey,
      maxPointCount: options.maxPointCount ?? this.defaultMaxPointCountPerNode,
      requestPriority: options.requestPriority,
      signal: options.signal,
    });
    throwIfAborted(options.signal);
    this.assertNotDestroyed();

    const { points, renderStats } = this.renderPointSamples(
      pointSamples.points,
      inspection,
      options.showBounds,
      (coordinateTransforms) => {
        this.boundsRenderer.setBounds(
          node.bounds,
          inspection,
          coordinateTransforms.toCesium,
        );
      },
    );

    return {
      inspection,
      node,
      pointSamples,
      points,
      renderStats,
    };
  }

  async renderNodes(
    nodeKeys: readonly string[],
    options: CopcPointCloudLayerRenderNodesOptions = {},
  ): Promise<CopcPointCloudLayerNodesRenderResult> {
    this.assertNotDestroyed();

    const normalizedNodeKeys = uniqueNodeKeys(nodeKeys);
    const { inspection, hierarchy } = await this.load();
    throwIfAborted(options.signal);
    this.assertNotDestroyed();

    const nodes = normalizedNodeKeys.map((nodeKey) =>
      findRequiredNode(hierarchy, nodeKey),
    );
    this.getCoordinateTransforms(inspection);

    if (
      this.shouldUseIntegratedPointGeometryLoading(
        options.includePointsInResult,
      )
    ) {
      return await this.renderNodesWithIntegratedPointGeometry(
        inspection,
        nodes,
        options.maxPointCountPerNode ?? this.defaultMaxPointCountPerNode,
        options.maxRenderedPointCount,
        options.showBounds,
        options.signal,
        options.requestPriority,
      );
    }

    const pointSamples = await this.source.loadNodesPointSamples({
      nodeKeys: normalizedNodeKeys,
      maxPointCountPerNode:
        options.maxPointCountPerNode ?? this.defaultMaxPointCountPerNode,
      maxTotalSampledPointCount: options.maxRenderedPointCount,
      sampleFormat: this.getPreferredPointSampleFormat(
        options.includePointsInResult,
      ),
      requestPriority: options.requestPriority,
      signal: options.signal,
    });
    this.assertNotDestroyed();

    return await this.renderLoadedNodeSampleResults(
      inspection,
      nodes,
      pointSamples.nodeResults,
      options.includePointsInResult,
      options.maxPointCountPerNode ?? this.defaultMaxPointCountPerNode,
      options.maxRenderedPointCount,
      options.showBounds,
      options.signal,
    );
  }

  async renderNodeSampleResults(
    nodeResults: readonly CopcNodePointSampleResult[],
    options: CopcPointCloudLayerRenderNodeSampleResultsOptions = {},
  ): Promise<CopcPointCloudLayerNodesRenderResult> {
    this.assertNotDestroyed();

    const normalizedNodeResults = uniqueNodeSampleResults(nodeResults);
    const { inspection, hierarchy } = await this.load();
    throwIfAborted(options.signal);
    this.assertNotDestroyed();

    const nodes = normalizedNodeResults.map((nodeResult) =>
      findRequiredNode(hierarchy, nodeResult.nodeKey),
    );

    return await this.renderLoadedNodeSampleResults(
      inspection,
      nodes,
      normalizedNodeResults,
      options.includePointsInResult,
      options.maxPointCountPerNode,
      options.maxRenderedPointCount,
      options.showBounds,
      options.signal,
    );
  }

  canRenderNodeSampleResult(nodeResult: CopcNodePointSampleResult): boolean {
    return (
      !isTransferOnlyPointSampleResult(nodeResult) ||
      this.hasTransformedPointGeometryBatch(nodeResult)
    );
  }

  async prepareNodes(
    nodeKeys: readonly string[],
    options: CopcPointCloudLayerPrepareNodesOptions = {},
  ): Promise<CopcPointCloudLayerPrepareNodesResult> {
    this.assertNotDestroyed();

    const normalizedNodeKeys = uniqueNodeKeys(nodeKeys);

    if (normalizedNodeKeys.length === 0) {
      throw new Error("At least one COPC hierarchy node key is required.");
    }

    const { inspection, hierarchy } = await this.load();
    throwIfAborted(options.signal);
    this.assertNotDestroyed();

    const nodes = normalizedNodeKeys.map((nodeKey) =>
      findRequiredNode(hierarchy, nodeKey),
    );
    this.getCoordinateTransforms(inspection);
    const maxPointCountPerNode = readProgressiveMaxPointCountPerNode(
      normalizedNodeKeys.length,
      options.maxPointCountPerNode ?? this.defaultMaxPointCountPerNode,
      options.maxRenderedPointCount,
    );

    if (this.shouldUseIntegratedPointGeometryLoading(false)) {
      const geometryResults = await Promise.all(
        nodes.map((node) =>
          this.loadNodePointGeometryBatch(
            node,
            maxPointCountPerNode,
            options.signal,
            options.requestPriority,
          ),
        ),
      );

      return {
        inspection,
        nodes,
        pointSamples: createMultiNodePointSampleResult(
          geometryResults.map((result) => result.pointSamples),
          false,
        ),
      };
    }

    const pointSamples = await this.source.loadNodesPointSamples({
      nodeKeys: normalizedNodeKeys,
      maxPointCountPerNode:
        options.maxPointCountPerNode ?? this.defaultMaxPointCountPerNode,
      maxTotalSampledPointCount: options.maxRenderedPointCount,
      sampleFormat: this.getPreferredPointSampleFormat(false),
      requestPriority: options.requestPriority,
      signal: options.signal,
    });
    const coordinateTransforms = this.getCoordinateTransforms(inspection);

    if (isCopcPointCloudGeometryBatchRenderer(this.pointRenderer)) {
      await Promise.all(
        pointSamples.nodeResults.map((nodeResult) =>
          this.createPointGeometryBatch(
            nodeResult,
            coordinateTransforms.toCesium,
            options.signal,
          ),
        ),
      );
    }

    return {
      inspection,
      nodes,
      pointSamples,
    };
  }

  async prepareNodesProgressively(
    nodeKeys: readonly string[],
    options: CopcPointCloudLayerProgressivePrepareNodesOptions = {},
  ): Promise<CopcPointCloudLayerPrepareNodesResult> {
    this.assertNotDestroyed();

    const normalizedNodeKeys = uniqueNodeKeys(nodeKeys);
    const { inspection, hierarchy } = await this.load();
    throwIfAborted(options.signal);
    this.assertNotDestroyed();
    this.getCoordinateTransforms(inspection);

    if (!this.shouldUseIntegratedPointGeometryLoading(false)) {
      const result = await this.prepareNodes(nodeKeys, options);
      options.onProgress?.(result);
      return result;
    }

    const nodes = normalizedNodeKeys.map((nodeKey) =>
      findRequiredNode(hierarchy, nodeKey),
    );
    const maxPointCountPerNode = readProgressiveMaxPointCountPerNode(
      normalizedNodeKeys.length,
      options.maxPointCountPerNode ?? this.defaultMaxPointCountPerNode,
      options.maxRenderedPointCount,
    );
    const progressBatchNodeCount = readPositiveInteger(
      options.progressBatchNodeCount,
      normalizedNodeKeys.length,
    );
    const requestPriorities = createProgressiveNodeRequestPriorities(
      nodes,
      options.requestPriority,
    );
    const geometryResults: Array<CopcNodePointGeometryBatchResult | undefined> =
      new Array(nodes.length);
    const maxActiveProgressiveNodeRequests = readPositiveInteger(
      options.maxActiveProgressiveNodeRequests,
      nodes.length,
    );
    let pendingEntries: Array<
      ProgressivePendingEntry<CopcNodePointGeometryBatchResult>
    > = [];
    let nextPendingNodeIndex = 0;
    let completedSinceLastProgress = 0;
    let latestResult: CopcPointCloudLayerPrepareNodesResult | undefined;
    const enqueueNextProgressiveNodeRequests = (): void => {
      while (
        pendingEntries.length < maxActiveProgressiveNodeRequests &&
        nextPendingNodeIndex < nodes.length
      ) {
        const index = nextPendingNodeIndex;
        nextPendingNodeIndex += 1;
        pendingEntries.push({
          index,
          promise: this.loadNodePointGeometryBatch(
            nodes[index],
            maxPointCountPerNode,
            options.signal,
            requestPriorities[index],
          ),
        });
      }
    };
    const hasUnqueuedNodeRequests = (): boolean =>
      nextPendingNodeIndex < nodes.length;

    enqueueNextProgressiveNodeRequests();

    while (pendingEntries.length > 0) {
      const completed = await Promise.race(
        pendingEntries.map(({ index, promise }) =>
          promise.then((geometryResult) => ({ index, geometryResult })),
        ),
      );

      pendingEntries = pendingEntries.filter(
        (entry) => entry.index !== completed.index,
      );
      geometryResults[completed.index] = completed.geometryResult;
      completedSinceLastProgress += 1;
      throwIfAborted(options.signal);
      this.assertNotDestroyed();

      if (
        completedSinceLastProgress < progressBatchNodeCount &&
        (pendingEntries.length > 0 || hasUnqueuedNodeRequests())
      ) {
        enqueueNextProgressiveNodeRequests();
        continue;
      }

      latestResult = this.createPrepareNodesResult(
        inspection,
        nodes,
        geometryResults,
      );
      options.onProgress?.(latestResult);
      completedSinceLastProgress = 0;
      enqueueNextProgressiveNodeRequests();
    }

    return (
      latestResult ??
      this.createPrepareNodesResult(inspection, nodes, geometryResults)
    );
  }

  async renderNodesProgressively(
    nodeKeys: readonly string[],
    options: CopcPointCloudLayerProgressiveRenderNodesOptions = {},
  ): Promise<CopcPointCloudLayerNodesRenderResult> {
    this.assertNotDestroyed();

    const normalizedNodeKeys = uniqueNodeKeys(nodeKeys);
    const { inspection, hierarchy } = await this.load();
    throwIfAborted(options.signal);
    this.assertNotDestroyed();

    const nodes = normalizedNodeKeys.map((nodeKey) =>
      findRequiredNode(hierarchy, nodeKey),
    );
    this.getCoordinateTransforms(inspection);
    const maxPointCountPerNode = readProgressiveMaxPointCountPerNode(
      normalizedNodeKeys.length,
      options.maxPointCountPerNode ?? this.defaultMaxPointCountPerNode,
      options.maxRenderedPointCount,
      options.useSourcePointBudgetHeadroom === true,
    );
    const pointCountWeightByNodeKey = createPointCountWeightByNodeKey(
      normalizedNodeKeys,
      options.nodePointCountWeights,
    );
    if (
      this.shouldUseIntegratedPointGeometryLoading(
        options.includePointsInResult,
      )
    ) {
      return await this.renderNodesProgressivelyWithIntegratedPointGeometry(
        inspection,
        nodes,
        options,
        maxPointCountPerNode,
      );
    }

    const progressBatchNodeCount = readPositiveInteger(
      options.progressBatchNodeCount,
      normalizedNodeKeys.length,
    );
    const progressRenderMode = options.progressRenderMode ?? "incremental";
    const shouldRenderIncrementally = progressRenderMode === "incremental";
    const shouldContinueLoadingAfterStop =
      options.continueLoadingAfterStop === true;
    const shouldLoadPostStopInBackground =
      shouldContinueLoadingAfterStop &&
      options.postStopLoadingMode === "background";
    const postStopProgressMode = options.postStopProgressMode ?? "render";
    const shouldRenderPostStopProgress = postStopProgressMode === "render";
    const requestPriorities = createProgressiveNodeRequestPriorities(
      nodes,
      options.requestPriority,
      options.nodeRequestOrder,
    );
    const normalizedBackgroundNodeResults = uniqueOptionalNodeSampleResults(
      options.backgroundNodeResults ?? [],
    ).filter((nodeResult) => !normalizedNodeKeys.includes(nodeResult.nodeKey));
    const backgroundNodes = normalizedBackgroundNodeResults.map((nodeResult) =>
      findRequiredNode(hierarchy, nodeResult.nodeKey),
    );
    const initialNodeResultByKey = new Map(
      options.initialNodeResults?.map((result) => [result.nodeKey, result]) ??
        [],
    );
    const nodeResults: Array<CopcNodePointSampleResult | undefined> = new Array(
      normalizedNodeKeys.length,
    );
    normalizedNodeKeys.forEach((nodeKey, index) => {
      nodeResults[index] = initialNodeResultByKey.get(nodeKey);
    });
    const progressiveAbort = createLinkedAbortController(options.signal);
    let pendingEntries: Array<
      ProgressivePendingEntry<CopcNodePointSampleResult>
    > = [];
    let completedSinceLastProgress = 0;
    let latestResult: CopcPointCloudLayerNodesRenderResult | undefined;
    let stopProgressReached = false;
    let cleanupDeferredToBackground = false;

    try {
      const hasMissingInitialNodeResults = normalizedNodeKeys.some(
        (_nodeKey, index) =>
          !isNodeSampleResultFresh(nodeResults[index], maxPointCountPerNode),
      );
      const continuePendingEntriesInBackground = (): void => {
        if (pendingEntries.length === 0) {
          return;
        }

        cleanupDeferredToBackground = true;
        void settlePendingProgressiveEntriesInBackground(
          progressiveAbort,
          pendingEntries,
        );
      };
      const shouldStopProgressiveRender = (
        result: CopcPointCloudLayerNodesRenderResult,
      ): boolean => {
        if (!options.shouldStopAfterProgress?.(result)) {
          return false;
        }

        if (shouldContinueLoadingAfterStop) {
          stopProgressReached = true;
          if (shouldLoadPostStopInBackground) {
            continuePendingEntriesInBackground();
            return true;
          }

          return false;
        }

        abortPendingProgressiveEntries(
          progressiveAbort.controller,
          pendingEntries,
        );
        return true;
      };

      if (
        !options.skipInitialProgressRender &&
        shouldRenderIncrementally &&
        (nodeResults.some(isDefined) ||
          normalizedBackgroundNodeResults.length > 0)
      ) {
        const completedNodeResults = nodeResults.filter(isDefined);
        const initialBackgroundNodes = hasMissingInitialNodeResults
          ? backgroundNodes
          : [];
        const initialBackgroundNodeResults = hasMissingInitialNodeResults
          ? normalizedBackgroundNodeResults
          : [];
        let progressAccepted = true;
        const progressResult = await this.renderLoadedNodeSampleResults(
          inspection,
          [
            ...nodes.filter((_node, index) => nodeResults[index] !== undefined),
            ...initialBackgroundNodes,
          ],
          [...completedNodeResults, ...initialBackgroundNodeResults],
          options.includePointsInResult,
          maxPointCountPerNode,
          options.maxRenderedPointCount,
          options.showBounds,
          options.signal,
          completedNodeResults.length,
          hasMissingInitialNodeResults && options.shouldRenderProgress
            ? (candidate) => {
                progressAccepted = options.shouldRenderProgress!(candidate);
                return progressAccepted;
              }
            : undefined,
          pointCountWeightByNodeKey,
        );
        if (!progressAccepted) {
          latestResult = undefined;
        } else {
          latestResult = progressResult;
          options.onProgress?.(latestResult);

          if (shouldStopProgressiveRender(latestResult)) {
            return latestResult;
          }
        }
      }

      const pendingNodeIndexes = orderProgressivePendingNodeIndexes(
        nodes,
        normalizedNodeKeys.flatMap((_nodeKey, index) =>
          isNodeSampleResultFresh(nodeResults[index], maxPointCountPerNode)
            ? []
            : [index],
        ),
        options.nodeRequestOrder,
      );
      const maxActiveProgressiveNodeRequests = readPositiveInteger(
        options.maxActiveProgressiveNodeRequests,
        pendingNodeIndexes.length,
      );
      let nextPendingNodeIndex = 0;
      const enqueueNextProgressiveNodeRequests = (): void => {
        while (
          pendingEntries.length < maxActiveProgressiveNodeRequests &&
          nextPendingNodeIndex < pendingNodeIndexes.length
        ) {
          const index = pendingNodeIndexes[nextPendingNodeIndex];
          const nodeKey = normalizedNodeKeys[index];
          nextPendingNodeIndex += 1;
          pendingEntries.push({
            index,
            promise: this.source.loadNodePointSamples({
              nodeKey,
              maxPointCount: maxPointCountPerNode,
              sampleFormat: this.getPreferredPointSampleFormat(
                options.includePointsInResult,
              ),
              requestPriority: requestPriorities[index],
              signal: progressiveAbort.signal,
            }),
          });
        }
      };
      const hasRemainingProgressiveNodeRequests = (): boolean =>
        pendingEntries.length > 0 ||
        nextPendingNodeIndex < pendingNodeIndexes.length;
      enqueueNextProgressiveNodeRequests();

      while (pendingEntries.length > 0) {
        const completed = await Promise.race(
          pendingEntries.map(({ index, promise }) =>
            promise.then((pointSamples) => ({ index, pointSamples })),
          ),
        );
        pendingEntries = pendingEntries.filter(
          (entry) => entry.index !== completed.index,
        );
        nodeResults[completed.index] = completed.pointSamples;
        completedSinceLastProgress += 1;
        throwIfAborted(progressiveAbort.signal);
        this.assertNotDestroyed();

        if (
          completedSinceLastProgress < progressBatchNodeCount &&
          pendingEntries.length > 0
        ) {
          enqueueNextProgressiveNodeRequests();
          continue;
        }

        if (
          !shouldRenderIncrementally &&
          hasRemainingProgressiveNodeRequests()
        ) {
          completedSinceLastProgress = 0;
          enqueueNextProgressiveNodeRequests();
          continue;
        }

        if (stopProgressReached && !shouldRenderPostStopProgress) {
          completedSinceLastProgress = 0;
          enqueueNextProgressiveNodeRequests();
          continue;
        }

        const completedNodeResults = nodeResults.filter(isDefined);
        const isFinalProgress = !hasRemainingProgressiveNodeRequests();
        const progressNodes =
          normalizedBackgroundNodeResults.length > 0 && !isFinalProgress
            ? [
                ...nodes.filter(
                  (_node, index) => nodeResults[index] !== undefined,
                ),
                ...backgroundNodes,
              ]
            : nodes.filter((_node, index) => nodeResults[index] !== undefined);
        const progressNodeResults =
          normalizedBackgroundNodeResults.length > 0 && !isFinalProgress
            ? [...completedNodeResults, ...normalizedBackgroundNodeResults]
            : completedNodeResults;
        let progressAccepted = true;
        const progressResult = await this.renderLoadedNodeSampleResults(
          inspection,
          progressNodes,
          progressNodeResults,
          options.includePointsInResult,
          maxPointCountPerNode,
          options.maxRenderedPointCount,
          options.showBounds,
          options.signal,
          normalizedBackgroundNodeResults.length > 0 && !isFinalProgress
            ? completedNodeResults.length
            : undefined,
          !isFinalProgress && options.shouldRenderProgress
            ? (candidate) => {
                progressAccepted = options.shouldRenderProgress!(candidate);
                return progressAccepted;
              }
            : undefined,
          pointCountWeightByNodeKey,
        );
        if (progressAccepted) {
          latestResult = progressResult;
          options.onProgress?.(latestResult);

          if (shouldStopProgressiveRender(latestResult)) {
            return latestResult;
          }
        }

        completedSinceLastProgress = 0;
        enqueueNextProgressiveNodeRequests();
        if (hasRemainingProgressiveNodeRequests()) {
          await yieldToNextProgressiveRenderFrame(progressiveAbort.signal);
        }
      }

      if (!latestResult) {
        const completedNodeResults = nodeResults.filter(isDefined);
        latestResult = await this.renderLoadedNodeSampleResults(
          inspection,
          nodes.filter((_node, index) => nodeResults[index] !== undefined),
          completedNodeResults,
          options.includePointsInResult,
          maxPointCountPerNode,
          options.maxRenderedPointCount,
          options.showBounds,
          options.signal,
          undefined,
          undefined,
          pointCountWeightByNodeKey,
        );
        options.onProgress?.(latestResult);
      }

      return latestResult;
    } finally {
      if (!cleanupDeferredToBackground) {
        abortPendingProgressiveEntries(
          progressiveAbort.controller,
          pendingEntries,
        );
        progressiveAbort.cleanup();
      }
    }
  }

  async renderAutomatic(
    options: CopcPointCloudLayerAutomaticRenderOptions,
  ): Promise<CopcPointCloudLayerAutomaticRenderResult | undefined> {
    this.assertNotDestroyed();

    const {
      expandHierarchy,
      maxHierarchyPages,
      maxHierarchyPageDepth,
      includeAncestorNodes,
      maxPointCountPerNode,
      maxRenderedPointCount,
      includePointsInResult,
      requestPriority,
      signal,
      showBounds,
      ...selectionOptions
    } = options;
    throwIfAborted(signal);
    const hierarchyExpansion =
      (expandHierarchy ?? false)
        ? await this.expandHierarchyForCamera({
            camera: options.camera,
            viewportWidthPixels: selectionOptions.viewportWidthPixels,
            viewportHeightPixels: selectionOptions.viewportHeightPixels,
            maxPages: maxHierarchyPages,
            maxDepth: maxHierarchyPageDepth,
            signal,
          })
        : undefined;
    const cameraSelection = await this.selectNodesForCamera({
      ...selectionOptions,
      signal,
    });
    throwIfAborted(signal);

    if (!cameraSelection || cameraSelection.nodes.length === 0) {
      return undefined;
    }

    const automaticRenderNodes = includeAncestorNodes
      ? createAutomaticRenderNodesWithAncestors(
          cameraSelection.nodes,
          this.requireHierarchy(),
        )
      : cameraSelection.nodes;
    const renderResult = await this.renderNodes(
      automaticRenderNodes.map((node) => node.key),
      {
        maxPointCountPerNode,
        maxRenderedPointCount,
        includePointsInResult,
        requestPriority,
        signal,
        showBounds,
      },
    );

    return {
      ...renderResult,
      cameraSelection,
      hierarchyExpansion,
    };
  }

  async renderAutomaticProgressively(
    options: CopcPointCloudLayerProgressiveAutomaticRenderOptions,
  ): Promise<CopcPointCloudLayerAutomaticRenderResult | undefined> {
    this.assertNotDestroyed();

    const {
      expandHierarchy,
      maxHierarchyPages,
      maxHierarchyPageDepth,
      includeAncestorNodes,
      maxPointCountPerNode,
      maxRenderedPointCount,
      includePointsInResult,
      requestPriority,
      signal,
      showBounds,
      backgroundNodeResults,
      continueLoadingAfterStop,
      initialNodeResults,
      maxActiveProgressiveNodeRequests,
      nodeRequestOrder,
      nodeRenderOrder,
      postStopLoadingMode,
      postStopProgressMode,
      progressBatchNodeCount,
      progressRenderMode,
      onProgress,
      shouldStopAfterProgress,
      ...selectionOptions
    } = options;
    throwIfAborted(signal);
    const hierarchyExpansion =
      (expandHierarchy ?? false)
        ? await this.expandHierarchyForCamera({
            camera: options.camera,
            viewportWidthPixels: selectionOptions.viewportWidthPixels,
            viewportHeightPixels: selectionOptions.viewportHeightPixels,
            maxPages: maxHierarchyPages,
            maxDepth: maxHierarchyPageDepth,
            signal,
          })
        : undefined;
    const cameraSelection = await this.selectNodesForCamera({
      ...selectionOptions,
      signal,
    });
    throwIfAborted(signal);

    if (!cameraSelection || cameraSelection.nodes.length === 0) {
      return undefined;
    }

    const automaticRenderNodes = includeAncestorNodes
      ? createAutomaticRenderNodesWithAncestors(
          cameraSelection.nodes,
          this.requireHierarchy(),
        )
      : cameraSelection.nodes;
    const renderNodes = orderAutomaticProgressiveNodes(
      automaticRenderNodes,
      nodeRenderOrder ?? "lightweight-first",
    );
    const renderResult = await this.renderNodesProgressively(
      renderNodes.map((node) => node.key),
      {
        backgroundNodeResults,
        continueLoadingAfterStop,
        initialNodeResults,
        maxActiveProgressiveNodeRequests,
        maxPointCountPerNode,
        maxRenderedPointCount,
        includePointsInResult,
        nodeRequestOrder,
        postStopLoadingMode,
        postStopProgressMode,
        requestPriority,
        signal,
        showBounds,
        progressBatchNodeCount,
        progressRenderMode,
        onProgress: (progressResult) => {
          onProgress?.({
            ...progressResult,
            cameraSelection,
            hierarchyExpansion,
          });
        },
        shouldStopAfterProgress: shouldStopAfterProgress
          ? (progressResult) =>
              shouldStopAfterProgress({
                ...progressResult,
                cameraSelection,
                hierarchyExpansion,
              })
          : undefined,
      },
    );

    return {
      ...renderResult,
      cameraSelection,
      hierarchyExpansion,
    };
  }

  async selectNodesForCamera(
    options: CopcPointCloudLayerCameraSelectionOptions,
  ): Promise<CopcHierarchyNodeCameraSelection | undefined> {
    this.assertNotDestroyed();

    const {
      camera,
      viewportWidthPixels,
      viewportHeightPixels,
      spacing,
      signal,
      ...selectionOptions
    } = options;
    throwIfAborted(signal);
    const { inspection, hierarchy } = await this.load();
    throwIfAborted(signal);
    this.assertNotDestroyed();
    const target = this.cameraViewCenterToCopc(
      camera,
      inspection,
      viewportWidthPixels,
      viewportHeightPixels,
    );
    const cameraPosition = this.cameraPositionToCopc(camera, inspection);
    const frustumFiltered = this.filterNodesForCameraFrustum(
      hierarchy.nodes,
      camera,
      inspection,
      selectionOptions,
    );
    const viewDirection =
      selectionOptions.selectionMode === "coverage"
        ? undefined
        : this.cameraDirectionToCopc(camera, inspection, target);
    const selection = selectHierarchyNodesForCamera(frustumFiltered.nodes, {
      ...selectionOptions,
      spacing: spacing ?? inspection.spacing,
      target,
      cameraPosition,
      viewDirection,
      viewportHeightPixels:
        viewportHeightPixels ?? this.scene.canvas.clientHeight,
    });

    if (!selection) {
      return undefined;
    }

    return {
      ...selection,
      skippedByFrustumCount: frustumFiltered.skippedByFrustumCount,
      reason: appendFrustumSelectionReason(
        selection.reason,
        frustumFiltered.skippedByFrustumCount,
      ),
    };
  }

  suggestNodeForCamera(
    camera: Camera,
  ): CopcHierarchyNodeSuggestion | undefined {
    this.assertNotDestroyed();

    if (!this.loadedInspection || !this.loadedHierarchy) {
      return undefined;
    }

    return suggestHierarchyNode(this.loadedHierarchy.nodes, {
      target: this.cameraPositionToCopc(camera, this.loadedInspection),
    });
  }

  clear(): void {
    if (this.destroyed) {
      return;
    }

    this.pointRenderer.clear();
    this.rendererRevision += 1;
    this.boundsRenderer.clear();
  }

  /**
   * Monotonically increases after every successful point-renderer mutation.
   * Applications may use this to prove that a retained frame still matches a
   * previously committed render before skipping an equivalent submission.
   */
  getRendererRevision(): number {
    return this.rendererRevision;
  }

  clearPointSampleCache(): number {
    this.assertNotDestroyed();
    return this.source.clearPointSampleCache();
  }

  clearPointGeometryCache(): number {
    this.assertNotDestroyed();
    const clearedCount =
      this.loadedNodePointGeometryBatches.size +
      this.transformedNodeResultGeometryBatches.size;

    this.clearPointGeometryCacheEntries();
    return clearedCount;
  }

  resetStreamingCaches(): CopcPointCloudLayerStreamingCacheResetResult {
    this.assertNotDestroyed();
    const pointSampleWorkerCount = this.source.resetPointSampleWorkers();
    const pointGeometryWorkerCount =
      this.pointGeometryWorkerPool.reset() +
      this.copcPointGeometryWorkerPool.reset();
    const pointSampleSetCount = this.clearPointSampleCache();
    const pointGeometryBatchCount = this.clearPointGeometryCache();

    return {
      pointSampleSetCount,
      pointGeometryBatchCount,
      pointSampleWorkerCount,
      pointGeometryWorkerCount,
    };
  }

  getPointGeometryCacheStats(): CopcPointCloudLayerPointGeometryCacheStats {
    return {
      cachedLoadedBatchCount: this.loadedNodePointGeometryBatches.size,
      maxCachedLoadedBatchCount: this.maxCachedPointGeometryBatches,
      loadedBatchCacheHitCount: this.loadedBatchCacheHitCount,
      loadedBatchCacheMissCount: this.loadedBatchCacheMissCount,
      loadedBatchCacheReuseCount: this.loadedBatchCacheReuseCount,
      loadedBatchCacheEvictionCount: this.loadedBatchCacheEvictionCount,
      cachedTransformedBatchCount:
        this.transformedNodeResultGeometryBatches.size,
      maxCachedTransformedBatchCount:
        this.maxCachedTransformedPointGeometryBatches,
      transformedBatchCacheHitCount: this.transformedBatchCacheHitCount,
      transformedBatchCacheMissCount: this.transformedBatchCacheMissCount,
      transformedBatchCacheEvictionCount:
        this.transformedBatchCacheEvictionCount,
      cachedPointGeometryBytes: this.cachedPointGeometryBytes,
      maxCachedPointGeometryBytes: this.maxCachedPointGeometryBytes,
      peakCachedPointGeometryBytes: this.peakCachedPointGeometryBytes,
      pointGeometryCacheByteEvictionCount:
        this.pointGeometryCacheByteEvictionCount,
      pointGeometryCacheEvictedBytes: this.pointGeometryCacheEvictedBytes,
      oversizedPointGeometryBatchCacheSkipCount:
        this.oversizedPointGeometryBatchCacheSkipCount,
    };
  }

  getDecodedPointDataCacheStats(): CopcPointCloudLayerDecodedPointDataCacheStats {
    const pointSample = this.source.getDecodedPointDataCacheStats();
    const integratedPointGeometry =
      this.copcPointGeometryWorkerPool.getDecodedPointDataCacheStats();

    return {
      ...mergeDecodedPointDataCacheStats(
        [pointSample, integratedPointGeometry],
        this.maxDecodedPointDataViewBytesAcrossWorkers,
      ),
      pointSample,
      integratedPointGeometry,
    };
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.loadedInspection = undefined;
    this.loadedHierarchy = undefined;
    this.coordinateTransforms = undefined;
    this.coordinateTransformStatus = undefined;
    this.pointGeometryTransform = undefined;
    this.pointColorStyle = undefined;
    this.clearPointGeometryCacheEntries();
    this.source.destroy();
    this.pointGeometryWorkerPool.destroy();
    this.copcPointGeometryWorkerPool.destroy();
    this.pointRenderer.destroy();
    this.boundsRenderer.destroy();
  }

  private getCoordinateTransforms(
    inspection: CopcInspection,
  ): CopcCoordinateTransformSet {
    if (!this.coordinateTransforms) {
      this.coordinateTransforms = this.coordinateTransformFactory(inspection);
      this.coordinateTransformStatus = normalizeCoordinateTransformStatus(
        this.coordinateTransforms,
      );
      this.pointGeometryTransform = createCesiumPointGeometryTransform(
        inspection,
        this.coordinateTransformStatus,
      );
    }

    return this.coordinateTransforms;
  }

  private getCoordinateTransformStatus(
    inspection: CopcInspection,
  ): CopcCoordinateTransformStatus {
    this.getCoordinateTransforms(inspection);

    if (!this.coordinateTransformStatus) {
      throw new Error("COPC coordinate transform status was not initialized.");
    }

    return this.coordinateTransformStatus;
  }

  private cameraPositionToCopc(
    camera: Camera,
    inspection: CopcInspection,
  ): CopcTargetPoint {
    return this.cartesianToCopc(camera.positionWC, inspection);
  }

  private cameraViewCenterToCopc(
    camera: Camera,
    inspection: CopcInspection,
    viewportWidthPixels: number | undefined,
    viewportHeightPixels: number | undefined,
  ): CopcTargetPoint {
    const width =
      viewportWidthPixels ??
      this.scene.canvas?.clientWidth ??
      this.scene.canvas?.width;
    const height =
      viewportHeightPixels ??
      this.scene.canvas?.clientHeight ??
      this.scene.canvas?.height;
    const canPickCenter =
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0 &&
      typeof camera.pickEllipsoid === "function";

    if (canPickCenter) {
      const pickedCenter = camera.pickEllipsoid(
        new Cartesian2(width / 2, height / 2),
        this.scene.globe?.ellipsoid,
      );

      if (pickedCenter) {
        return this.cartesianToCopc(pickedCenter, inspection);
      }
    }

    return this.cameraPositionToCopc(camera, inspection);
  }

  private cartesianToCopc(
    position: Cartesian3,
    inspection: CopcInspection,
  ): CopcTargetPoint {
    const cartographic = Cartographic.fromCartesian(position);
    const transform = this.getCoordinateTransforms(inspection).toCopc;

    if (!transform) {
      throw new Error(
        "Camera-based COPC node selection requires coordinateTransforms to provide toCopc.",
      );
    }

    return transform(
      CesiumMath.toDegrees(cartographic.longitude),
      CesiumMath.toDegrees(cartographic.latitude),
      cartographic.height,
    );
  }

  private cameraDirectionToCopc(
    camera: Camera,
    inspection: CopcInspection,
    target: CopcTargetPoint,
  ): CopcTargetVector | undefined {
    if (!camera.directionWC) {
      return undefined;
    }

    const cartographic = Cartographic.fromCartesian(camera.positionWC);
    const transform = this.getCoordinateTransforms(inspection).toCopc;

    if (!transform) {
      return undefined;
    }

    const stepMeters = Math.min(
      10_000,
      Math.max(100, Math.abs(cartographic.height) * 0.02),
    );
    const directionEndpoint = Cartesian3.add(
      camera.positionWC,
      Cartesian3.multiplyByScalar(
        camera.directionWC,
        stepMeters,
        new Cartesian3(),
      ),
      new Cartesian3(),
    );
    const endpointCartographic = Cartographic.fromCartesian(directionEndpoint);
    const endpoint = transform(
      CesiumMath.toDegrees(endpointCartographic.longitude),
      CesiumMath.toDegrees(endpointCartographic.latitude),
      endpointCartographic.height,
    );
    const vector = {
      x: endpoint.x - target.x,
      y: endpoint.y - target.y,
      z: endpoint.z - target.z,
    };

    if (
      !Number.isFinite(vector.x) ||
      !Number.isFinite(vector.y) ||
      !Number.isFinite(vector.z) ||
      Math.hypot(vector.x, vector.y, vector.z) <= Number.EPSILON
    ) {
      return undefined;
    }

    return vector;
  }

  private filterNodesForCameraFrustum(
    nodes: readonly CopcHierarchyNodeSummary[],
    camera: Camera,
    inspection: CopcInspection,
    selectionDepth: SelectionDepthRange,
  ): {
    readonly nodes: readonly CopcHierarchyNodeSummary[];
    readonly skippedByFrustumCount: number;
  } {
    if (
      !camera.frustum ||
      !camera.directionWC ||
      !camera.upWC ||
      !camera.positionWC
    ) {
      return {
        nodes,
        skippedByFrustumCount: 0,
      };
    }

    const toCesium = this.getCoordinateTransforms(inspection).toCesium;
    const { frustumCandidateNodes, retainedNodes } = splitNodesBySelectionDepth(
      nodes,
      selectionDepth,
    );
    const cullingVolume = camera.frustum.computeCullingVolume(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    );
    const visibleNodes = frustumCandidateNodes.filter((node) => {
      const boundingSphere = this.getCameraSelectionBoundsSphere(
        node,
        toCesium,
      );

      return (
        cullingVolume.computeVisibility(boundingSphere) !== Intersect.OUTSIDE
      );
    });

    return {
      nodes:
        retainedNodes.length === 0
          ? visibleNodes
          : [...retainedNodes, ...visibleNodes],
      skippedByFrustumCount: frustumCandidateNodes.length - visibleNodes.length,
    };
  }

  private getCameraSelectionBoundsSphere(
    node: CopcHierarchyNodeSummary,
    transform: CopcToCesiumTransform,
  ): BoundingSphere {
    const cachedSphere = this.cameraSelectionBoundsSphereCache.get(node);

    if (cachedSphere) {
      return cachedSphere;
    }

    const boundingSphere = createCesiumBoundsSphere(node, transform);
    this.cameraSelectionBoundsSphereCache.set(node, boundingSphere);
    return boundingSphere;
  }

  private selectCurrentViewHierarchyPages(
    pages: CopcHierarchySummary["pendingPages"],
    camera: Camera,
    inspection: CopcInspection,
    target: CopcTargetPoint,
    depthRange: SelectionDepthRange,
  ): CopcHierarchySummary["pendingPages"] {
    if (
      !camera.frustum ||
      !camera.directionWC ||
      !camera.upWC ||
      !camera.positionWC
    ) {
      return selectHierarchyPagesCoveringTarget(pages, target, depthRange);
    }

    const toCesium = this.getCoordinateTransforms(inspection).toCesium;
    const cullingVolume = camera.frustum.computeCullingVolume(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    );

    return pages.filter(
      (page) =>
        isNodeInsideSelectionDepth(page, depthRange) &&
        cullingVolume.computeVisibility(
          createCesiumBoundsSphere(page, toCesium),
        ) !== Intersect.OUTSIDE,
    );
  }

  private shouldShowBounds(showBounds: boolean | undefined): boolean {
    return showBounds ?? this.defaultShowBounds;
  }

  private renderPointSamples(
    sourcePoints: readonly CopcNodePointSampleResult["points"][number][],
    inspection: CopcInspection,
    showBounds: boolean | undefined,
    renderBounds: (coordinateTransforms: CopcCoordinateTransformSet) => void,
  ): {
    readonly points: readonly PointSample[];
    readonly renderStats: CopcPointCloudLayerRenderStats;
  } {
    const coordinateTransforms = this.getCoordinateTransforms(inspection);
    const renderStartedAt = nowMilliseconds();
    const transformStartedAt = nowMilliseconds();
    const points = createPointSamplesFromCopc(
      sourcePoints,
      inspection,
      coordinateTransforms.toCesium,
      this.requirePointColorStyle(),
    );
    const transformEndedAt = nowMilliseconds();

    this.assertNotDestroyed();
    const rendererStartedAt = nowMilliseconds();
    this.pointRenderer.setPoints(points);
    this.rendererRevision += 1;
    const rendererEndedAt = nowMilliseconds();

    const boundsStartedAt = nowMilliseconds();
    if (this.shouldShowBounds(showBounds)) {
      renderBounds(coordinateTransforms);
    } else {
      this.boundsRenderer.clear();
    }
    const boundsEndedAt = nowMilliseconds();

    return {
      points,
      renderStats: {
        pointCount: points.length,
        estimatedRenderPayloadBytes: estimateRenderPayloadBytes(points.length),
        coordinateTransformMilliseconds: Math.max(
          0,
          transformEndedAt - transformStartedAt,
        ),
        rendererSetPointsMilliseconds: Math.max(
          0,
          rendererEndedAt - rendererStartedAt,
        ),
        boundsRenderMilliseconds: Math.max(0, boundsEndedAt - boundsStartedAt),
        totalRenderMilliseconds: Math.max(0, boundsEndedAt - renderStartedAt),
      },
    };
  }

  private async renderNodesWithIntegratedPointGeometry(
    inspection: CopcInspection,
    nodes: readonly CopcHierarchyNodeSummary[],
    maxPointCountPerNode: number | undefined,
    maxRenderedPointCount: number | undefined,
    showBounds: boolean | undefined,
    signal: AbortSignal | undefined,
    priority?: number,
  ): Promise<CopcPointCloudLayerNodesRenderResult> {
    const maxPointCount = readProgressiveMaxPointCountPerNode(
      nodes.length,
      maxPointCountPerNode,
      maxRenderedPointCount,
    );
    const geometryResults = await Promise.all(
      nodes.map((node) =>
        this.loadNodePointGeometryBatch(node, maxPointCount, signal, priority),
      ),
    );

    return this.renderPointGeometryBatchResults(
      inspection,
      nodes,
      geometryResults,
      showBounds,
      signal,
    );
  }

  private async renderNodesProgressivelyWithIntegratedPointGeometry(
    inspection: CopcInspection,
    nodes: readonly CopcHierarchyNodeSummary[],
    options: CopcPointCloudLayerProgressiveRenderNodesOptions,
    maxPointCountPerNode: number | undefined,
  ): Promise<CopcPointCloudLayerNodesRenderResult> {
    const coordinateTransforms = this.getCoordinateTransforms(inspection);
    const normalizedNodeKeys = nodes.map((node) => node.key);
    const progressBatchNodeCount = readPositiveInteger(
      options.progressBatchNodeCount,
      normalizedNodeKeys.length,
    );
    const progressRenderMode = options.progressRenderMode ?? "incremental";
    const shouldRenderIncrementally = progressRenderMode === "incremental";
    const shouldContinueLoadingAfterStop =
      options.continueLoadingAfterStop === true;
    const shouldLoadPostStopInBackground =
      shouldContinueLoadingAfterStop &&
      options.postStopLoadingMode === "background";
    const postStopProgressMode = options.postStopProgressMode ?? "render";
    const shouldRenderPostStopProgress = postStopProgressMode === "render";
    const requestPriorities = createProgressiveNodeRequestPriorities(
      nodes,
      options.requestPriority,
      options.nodeRequestOrder,
    );
    const backgroundGeometryResults = (
      await Promise.all(
        uniqueOptionalNodeSampleResults(options.backgroundNodeResults ?? [])
          .filter(
            (nodeResult) => !normalizedNodeKeys.includes(nodeResult.nodeKey),
          )
          .map((nodeResult) =>
            this.resolvePointGeometryBatchResult(
              nodeResult,
              findRequiredNode(this.requireHierarchy(), nodeResult.nodeKey),
              coordinateTransforms.toCesium,
              options.signal,
              options.requestPriority,
            ),
          ),
      )
    ).filter(isDefined);
    const initialNodeResultByKey = new Map(
      options.initialNodeResults?.map((result) => [result.nodeKey, result]) ??
        [],
    );
    const geometryResults: Array<CopcNodePointGeometryBatchResult | undefined> =
      new Array(normalizedNodeKeys.length);
    const initialGeometryResults: Array<
      CopcNodePointGeometryBatchResult | undefined
    > = new Array(normalizedNodeKeys.length);

    await Promise.all(
      nodes.map(async (node, index) => {
        const nodeResult = initialNodeResultByKey.get(node.key);

        if (!nodeResult) {
          return;
        }

        const isFresh = isNodeSampleResultFresh(
          nodeResult,
          maxPointCountPerNode,
        );

        if (
          !isFresh &&
          isTransferOnlyPointSampleResult(nodeResult) &&
          !this.hasTransformedPointGeometryBatch(nodeResult)
        ) {
          return;
        }

        const geometryResult = await this.resolvePointGeometryBatchResult(
          nodeResult,
          node,
          coordinateTransforms.toCesium,
          options.signal,
          options.requestPriority,
        );

        if (isFresh) {
          geometryResults[index] = geometryResult;
        } else {
          initialGeometryResults[index] = geometryResult;
        }
      }),
    );

    const progressiveAbort = createLinkedAbortController(options.signal);
    let pendingEntries: Array<
      ProgressivePendingEntry<CopcNodePointGeometryBatchResult>
    > = [];
    let completedSinceLastProgress = 0;
    let latestResult: CopcPointCloudLayerNodesRenderResult | undefined;
    let stopProgressReached = false;
    let cleanupDeferredToBackground = false;

    try {
      const hasMissingInitialGeometryResults = nodes.some(
        (_node, index) => geometryResults[index] === undefined,
      );
      const continuePendingEntriesInBackground = (): void => {
        if (pendingEntries.length === 0) {
          return;
        }

        cleanupDeferredToBackground = true;
        void settlePendingProgressiveEntriesInBackground(
          progressiveAbort,
          pendingEntries,
        );
      };
      const shouldStopProgressiveRender = (
        result: CopcPointCloudLayerNodesRenderResult,
      ): boolean => {
        if (!options.shouldStopAfterProgress?.(result)) {
          return false;
        }

        if (shouldContinueLoadingAfterStop) {
          stopProgressReached = true;
          if (shouldLoadPostStopInBackground) {
            continuePendingEntriesInBackground();
            return true;
          }

          return false;
        }

        abortPendingProgressiveEntries(
          progressiveAbort.controller,
          pendingEntries,
        );
        return true;
      };

      if (
        !options.skipInitialProgressRender &&
        shouldRenderIncrementally &&
        (geometryResults.some(isDefined) ||
          initialGeometryResults.some(isDefined) ||
          backgroundGeometryResults.length > 0)
      ) {
        const progress = createProgressPointGeometryResults({
          backgroundGeometryResults,
          hierarchy: this.requireHierarchy(),
          nodes,
          geometryResults,
          initialGeometryResults,
          includeBackground: hasMissingInitialGeometryResults,
          maxRenderedPointCount: options.maxRenderedPointCount,
          maxPointCountPerNode,
          nodePointCountWeights: options.nodePointCountWeights,
        });
        let progressAccepted = true;
        const progressResult = await this.renderPointGeometryBatchResults(
          inspection,
          progress.nodes,
          progress.geometryResults,
          options.showBounds,
          options.signal,
          hasMissingInitialGeometryResults && options.shouldRenderProgress
            ? (candidate) => {
                progressAccepted = options.shouldRenderProgress!(candidate);
                return progressAccepted;
              }
            : undefined,
        );
        if (!progressAccepted) {
          latestResult = undefined;
        } else {
          latestResult = progressResult;
          options.onProgress?.(latestResult);

          if (shouldStopProgressiveRender(latestResult)) {
            return latestResult;
          }
        }
      }

      const pendingNodeIndexes = orderProgressivePendingNodeIndexes(
        nodes,
        nodes.flatMap((_node, index) =>
          geometryResults[index] ? [] : [index],
        ),
        options.nodeRequestOrder,
      );
      const maxActiveProgressiveNodeRequests = readPositiveInteger(
        options.maxActiveProgressiveNodeRequests,
        pendingNodeIndexes.length,
      );
      let nextPendingNodeIndex = 0;
      const enqueueNextProgressiveNodeRequests = (): void => {
        while (
          pendingEntries.length < maxActiveProgressiveNodeRequests &&
          nextPendingNodeIndex < pendingNodeIndexes.length
        ) {
          const index = pendingNodeIndexes[nextPendingNodeIndex];
          nextPendingNodeIndex += 1;
          pendingEntries.push({
            index,
            promise: this.loadNodePointGeometryBatch(
              nodes[index],
              maxPointCountPerNode,
              progressiveAbort.signal,
              requestPriorities[index],
            ),
          });
        }
      };
      const hasRemainingProgressiveNodeRequests = (): boolean =>
        pendingEntries.length > 0 ||
        nextPendingNodeIndex < pendingNodeIndexes.length;
      enqueueNextProgressiveNodeRequests();

      while (pendingEntries.length > 0) {
        const completed = await Promise.race(
          pendingEntries.map(({ index, promise }) =>
            promise.then((geometryResult) => ({ index, geometryResult })),
          ),
        );
        pendingEntries = pendingEntries.filter(
          (entry) => entry.index !== completed.index,
        );
        geometryResults[completed.index] = completed.geometryResult;
        completedSinceLastProgress += 1;
        throwIfAborted(progressiveAbort.signal);
        this.assertNotDestroyed();

        if (
          completedSinceLastProgress < progressBatchNodeCount &&
          pendingEntries.length > 0
        ) {
          enqueueNextProgressiveNodeRequests();
          continue;
        }

        if (
          !shouldRenderIncrementally &&
          hasRemainingProgressiveNodeRequests()
        ) {
          completedSinceLastProgress = 0;
          enqueueNextProgressiveNodeRequests();
          continue;
        }

        if (stopProgressReached && !shouldRenderPostStopProgress) {
          completedSinceLastProgress = 0;
          enqueueNextProgressiveNodeRequests();
          continue;
        }

        const isFinalProgress = !hasRemainingProgressiveNodeRequests();
        const progress = createProgressPointGeometryResults({
          backgroundGeometryResults,
          hierarchy: this.requireHierarchy(),
          nodes,
          geometryResults,
          initialGeometryResults,
          includeBackground:
            backgroundGeometryResults.length > 0 && !isFinalProgress,
          maxRenderedPointCount: options.maxRenderedPointCount,
          maxPointCountPerNode,
          nodePointCountWeights: options.nodePointCountWeights,
        });

        let progressAccepted = true;
        const progressResult = await this.renderPointGeometryBatchResults(
          inspection,
          progress.nodes,
          progress.geometryResults,
          options.showBounds,
          options.signal,
          !isFinalProgress && options.shouldRenderProgress
            ? (candidate) => {
                progressAccepted = options.shouldRenderProgress!(candidate);
                return progressAccepted;
              }
            : undefined,
        );
        if (progressAccepted) {
          latestResult = progressResult;
          options.onProgress?.(latestResult);

          if (shouldStopProgressiveRender(latestResult)) {
            return latestResult;
          }
        }

        completedSinceLastProgress = 0;
        enqueueNextProgressiveNodeRequests();
        if (hasRemainingProgressiveNodeRequests()) {
          await yieldToNextProgressiveRenderFrame(progressiveAbort.signal);
        }
      }

      if (!latestResult) {
        const progress = createProgressPointGeometryResults({
          backgroundGeometryResults: [],
          hierarchy: this.requireHierarchy(),
          nodes,
          geometryResults,
          initialGeometryResults,
          includeBackground: false,
          maxRenderedPointCount: options.maxRenderedPointCount,
          maxPointCountPerNode,
          nodePointCountWeights: options.nodePointCountWeights,
        });
        latestResult = await this.renderPointGeometryBatchResults(
          inspection,
          progress.nodes,
          progress.geometryResults,
          options.showBounds,
          options.signal,
        );
        options.onProgress?.(latestResult);
      }

      return latestResult;
    } finally {
      if (!cleanupDeferredToBackground) {
        abortPendingProgressiveEntries(
          progressiveAbort.controller,
          pendingEntries,
        );
        progressiveAbort.cleanup();
      }
    }
  }

  private async renderPointGeometryBatchResults(
    inspection: CopcInspection,
    nodes: readonly CopcHierarchyNodeSummary[],
    geometryResults: readonly CopcNodePointGeometryBatchResult[],
    showBounds: boolean | undefined,
    signal: AbortSignal | undefined,
    shouldRenderProgress?: (
      candidate: CopcPointCloudLayerProgressiveRenderCandidate,
    ) => boolean,
  ): Promise<CopcPointCloudLayerNodesRenderResult> {
    const coordinateTransforms = this.getCoordinateTransforms(inspection);
    const nodeResults = geometryResults.map((result) => result.pointSamples);
    const pointSamples = createMultiNodePointSampleResult(nodeResults, false);
    const renderStartedAt = nowMilliseconds();
    const transformStartedAt = nowMilliseconds();
    const pointGeometryBatches = geometryResults.map((result, index) => {
      this.rememberPointGeometryBatch(
        result.pointSamples,
        result.geometryBatch,
      );
      const node = nodes[index];

      return node
        ? withCopcPointGeometryBatchRenderMetadata({
            batch: result.geometryBatch,
            inspection,
            node,
            coordinateTransform: coordinateTransforms.toCesium,
          })
        : result.geometryBatch;
    });
    throwIfAborted(signal);
    const renderPointCount = pointGeometryBatches.reduce(
      (total, batch) => total + batch.pointCount,
      0,
    );
    const transformEndedAt = nowMilliseconds();
    const shouldCommitRender =
      shouldRenderProgress?.({
        nodeKeys: pointSamples.nodeKeys,
        sampledPointCount: pointSamples.sampledPointCount,
        nodeSamples: createProgressiveRenderCandidateNodeSamples(pointSamples),
      }) ?? true;

    this.assertNotDestroyed();
    const rendererStartedAt = nowMilliseconds();
    if (shouldCommitRender) {
      if (!isCopcPointCloudGeometryBatchRenderer(this.pointRenderer)) {
        throw new Error("Point geometry batch renderer is required.");
      }
      this.pointRenderer.setPointGeometryBatches(pointGeometryBatches);
      this.rendererRevision += 1;
    }
    const rendererEndedAt = nowMilliseconds();

    const boundsStartedAt = nowMilliseconds();
    if (shouldCommitRender) {
      if (this.shouldShowBounds(showBounds)) {
        this.boundsRenderer.setBoundsList(
          nodes.map((node) => node.bounds),
          inspection,
          coordinateTransforms.toCesium,
        );
      } else {
        this.boundsRenderer.clear();
      }
    }
    const boundsEndedAt = nowMilliseconds();

    return {
      inspection,
      nodes,
      pointSamples,
      points: [],
      renderStats: {
        pointCount: renderPointCount,
        estimatedRenderPayloadBytes:
          estimateRenderPayloadBytes(renderPointCount),
        pointGeometryTimings: summarizePointGeometryBatchTimings(
          nodes,
          geometryResults,
        ),
        coordinateTransformMilliseconds: Math.max(
          0,
          transformEndedAt - transformStartedAt,
        ),
        rendererSetPointsMilliseconds: Math.max(
          0,
          rendererEndedAt - rendererStartedAt,
        ),
        boundsRenderMilliseconds: Math.max(0, boundsEndedAt - boundsStartedAt),
        totalRenderMilliseconds: Math.max(0, boundsEndedAt - renderStartedAt),
      },
    };
  }

  private async renderLoadedNodeSampleResults(
    inspection: CopcInspection,
    nodes: readonly CopcHierarchyNodeSummary[],
    nodeResults: readonly CopcNodePointSampleResult[],
    includePointsInResult: boolean | undefined,
    maxPointCountPerNode: number | undefined,
    maxRenderedPointCount: number | undefined,
    showBounds: boolean | undefined,
    signal: AbortSignal | undefined,
    priorityNodeResultCount?: number,
    shouldRenderProgress?: (
      candidate: CopcPointCloudLayerProgressiveRenderCandidate,
    ) => boolean,
    pointCountWeightByNodeKey?: ReadonlyMap<string, number>,
  ): Promise<CopcPointCloudLayerNodesRenderResult> {
    const entries = nodes.map((node, index) => ({
      node,
      nodeResult: nodeResults[index],
    }));
    const entryPointCountWeights = pointCountWeightByNodeKey
      ? entries.map((entry) => pointCountWeightByNodeKey.get(entry.node.key) ?? 1)
      : undefined;
    const shouldIncludePointsInResult = includePointsInResult ?? true;
    const coordinateTransforms = this.getCoordinateTransforms(inspection);
    const renderStartedAt = nowMilliseconds();
    const transformStartedAt = nowMilliseconds();
    const rendererSupportsGeometryBatches =
      isCopcPointCloudGeometryBatchRenderer(this.pointRenderer);
    const rendererSupportsBatches = isCopcPointCloudBatchRenderer(
      this.pointRenderer,
    );
    let points: readonly PointSample[] = [];
    let renderPointCount = 0;

    if (rendererSupportsGeometryBatches && !shouldIncludePointsInResult) {
      const geometryResults = (
        await Promise.all(
          entries.map((entry) =>
            this.resolvePointGeometryBatchResult(
              entry.nodeResult,
              entry.node,
              coordinateTransforms.toCesium,
              signal,
            ),
          ),
        )
      ).filter(isDefined);
      const limitedGeometryEntries = limitPointGeometryProgressEntries(
        geometryResults.map((geometryResult) => ({
          node: findRequiredNode(
            this.requireHierarchy(),
            geometryResult.pointSamples.nodeKey,
          ),
          geometryResult,
        })),
        maxRenderedPointCount,
        maxPointCountPerNode,
        priorityNodeResultCount,
        entryPointCountWeights,
      );
      const renderNodes = limitedGeometryEntries.map((entry) => entry.node);
      const renderGeometryResults = limitedGeometryEntries.map(
        (entry) => entry.geometryResult,
      );
      const pointSamples = createMultiNodePointSampleResult(
        renderGeometryResults.map((result) => result.pointSamples),
        false,
      );
      const pointGeometryBatches = renderGeometryResults.map((result, index) => {
        this.rememberPointGeometryBatch(
          result.pointSamples,
          result.geometryBatch,
        );
        const node = renderNodes[index];

        return node
          ? withCopcPointGeometryBatchRenderMetadata({
              batch: result.geometryBatch,
              inspection,
              node,
              coordinateTransform: coordinateTransforms.toCesium,
            })
          : result.geometryBatch;
      });
      throwIfAborted(signal);
      renderPointCount = pointGeometryBatches.reduce(
        (total, batch) => total + batch.pointCount,
        0,
      );
      const transformEndedAt = nowMilliseconds();
      const shouldCommitRender =
        shouldRenderProgress?.({
          nodeKeys: pointSamples.nodeKeys,
          sampledPointCount: pointSamples.sampledPointCount,
          nodeSamples: createProgressiveRenderCandidateNodeSamples(pointSamples),
        }) ?? true;

      this.assertNotDestroyed();
      const rendererStartedAt = nowMilliseconds();
      if (shouldCommitRender) {
        this.pointRenderer.setPointGeometryBatches(pointGeometryBatches);
        this.rendererRevision += 1;
      }
      const rendererEndedAt = nowMilliseconds();

      const boundsStartedAt = nowMilliseconds();
      if (shouldCommitRender) {
        if (this.shouldShowBounds(showBounds)) {
          this.boundsRenderer.setBoundsList(
            renderNodes.map((node) => node.bounds),
            inspection,
            coordinateTransforms.toCesium,
          );
        } else {
          this.boundsRenderer.clear();
        }
      }
      const boundsEndedAt = nowMilliseconds();

      return {
        inspection,
        nodes: renderNodes,
        pointSamples,
        points,
        renderStats: {
          pointCount: renderPointCount,
          estimatedRenderPayloadBytes:
            estimateRenderPayloadBytes(renderPointCount),
          pointGeometryTimings: summarizePointGeometryBatchTimings(
            renderNodes,
            renderGeometryResults,
          ),
          coordinateTransformMilliseconds: Math.max(
            0,
            transformEndedAt - transformStartedAt,
          ),
          rendererSetPointsMilliseconds: Math.max(
            0,
            rendererEndedAt - rendererStartedAt,
          ),
          boundsRenderMilliseconds: Math.max(
            0,
            boundsEndedAt - boundsStartedAt,
          ),
          totalRenderMilliseconds: Math.max(0, boundsEndedAt - renderStartedAt),
        },
      };
    }

    const limitedEntries = limitNodeSampleProgressEntries(
      entries,
      maxRenderedPointCount,
      maxPointCountPerNode,
      priorityNodeResultCount,
      entryPointCountWeights,
    );
    const renderNodes = limitedEntries.map((entry) => entry.node);
    const renderNodeResults = limitedEntries.map((entry) => entry.nodeResult);
    const pointSamples = createMultiNodePointSampleResult(
      renderNodeResults,
      shouldIncludePointsInResult,
    );

    const pointBatches = renderNodeResults.map((nodeResult) =>
      this.createPointSampleBatch(
        nodeResult,
        inspection,
        coordinateTransforms.toCesium,
      ),
    );
    renderPointCount = pointBatches.reduce(
      (total, batch) => total + batch.points.length,
      0,
    );
    points =
      shouldIncludePointsInResult || !rendererSupportsBatches
        ? pointBatches.flatMap((batch) => batch.points)
        : [];
    const transformEndedAt = nowMilliseconds();
    const shouldCommitRender =
      shouldRenderProgress?.({
        nodeKeys: pointSamples.nodeKeys,
        sampledPointCount: pointSamples.sampledPointCount,
        nodeSamples: createProgressiveRenderCandidateNodeSamples(pointSamples),
      }) ?? true;

    this.assertNotDestroyed();
    const rendererStartedAt = nowMilliseconds();
    if (shouldCommitRender) {
      if (rendererSupportsBatches) {
        this.pointRenderer.setPointBatches(pointBatches);
        this.rendererRevision += 1;
      } else {
        this.pointRenderer.setPoints(points);
        this.rendererRevision += 1;
      }
    }
    const rendererEndedAt = nowMilliseconds();

    const boundsStartedAt = nowMilliseconds();
    if (shouldCommitRender) {
      if (this.shouldShowBounds(showBounds)) {
        this.boundsRenderer.setBoundsList(
          renderNodes.map((node) => node.bounds),
          inspection,
          coordinateTransforms.toCesium,
        );
      } else {
        this.boundsRenderer.clear();
      }
    }
    const boundsEndedAt = nowMilliseconds();

    return {
      inspection,
      nodes: renderNodes,
      pointSamples,
      points: shouldIncludePointsInResult ? points : [],
      renderStats: {
        pointCount: renderPointCount,
        estimatedRenderPayloadBytes:
          estimateRenderPayloadBytes(renderPointCount),
        coordinateTransformMilliseconds: Math.max(
          0,
          transformEndedAt - transformStartedAt,
        ),
        rendererSetPointsMilliseconds: Math.max(
          0,
          rendererEndedAt - rendererStartedAt,
        ),
        boundsRenderMilliseconds: Math.max(0, boundsEndedAt - boundsStartedAt),
        totalRenderMilliseconds: Math.max(0, boundsEndedAt - renderStartedAt),
      },
    };
  }
  private createPointSampleBatch(
    nodeResult: CopcNodePointSampleResult,
    inspection: CopcInspection,
    coordinateTransform: CopcCoordinateTransformSet["toCesium"],
  ): PointSampleBatch {
    let points = this.transformedNodeResultPoints.get(nodeResult);

    if (!points) {
      points = createPointSamplesFromCopc(
        getPointDataSamples(nodeResult),
        inspection,
        coordinateTransform,
        this.requirePointColorStyle(),
      );
      this.transformedNodeResultPoints.set(nodeResult, points);
    }

    return {
      key: createNodePointSampleBatchKey(nodeResult),
      points,
    };
  }

  private loadNodePointGeometryBatch(
    node: CopcHierarchyNodeSummary,
    maxPointCount: number | undefined,
    signal: AbortSignal | undefined,
    priority?: number,
  ): Promise<CopcNodePointGeometryBatchResult> {
    const normalizedMaxPointCount =
      maxPointCount ?? this.defaultMaxPointCountPerNode ?? node.pointCount;
    const transformKey = createPointGeometryTransformCacheKey(
      this.pointGeometryTransform,
    );
    const cacheKey = createNodePointGeometryBatchCacheKey(
      node.key,
      normalizedMaxPointCount,
      this.pointGeometryTransform,
    );
    const cached = this.loadedNodePointGeometryBatches.get(cacheKey);

    if (cached?.state === "resolved") {
      this.loadedBatchCacheHitCount += 1;
      this.touchLoadedNodePointGeometryBatch(cacheKey, cached);
      return withAbortSignal(
        readLoadedNodePointGeometryBatchCacheResult(cached),
        signal,
      );
    }

    const reusable = this.findReusableLoadedNodePointGeometryBatch(
      node,
      normalizedMaxPointCount,
      transformKey,
    );

    if (reusable) {
      this.loadedBatchCacheReuseCount += 1;
      const resultPromise = reusable.promise.then((result) =>
        limitPointGeometryBatchResult(
          result,
          normalizedMaxPointCount,
          reusable.state === "resolved",
        ),
      );
      const entry: LoadedNodePointGeometryBatchCacheEntry = {
        nodeKey: node.key,
        maxPointCount: normalizedMaxPointCount,
        transformKey,
        promise: resultPromise,
        state: reusable.state,
        lastAccessSequence: 0,
      };

      this.trackLoadedNodePointGeometryBatchResolution(cacheKey, entry);
      this.setLoadedNodePointGeometryBatch(cacheKey, entry);

      return withAbortSignal(resultPromise, signal);
    }

    this.loadedBatchCacheMissCount += 1;
    const resultPromise = this.loadNodePointGeometryBatchWithoutCache(
      node,
      normalizedMaxPointCount,
      signal,
      priority,
    ).catch((error: unknown) => {
      const existing = this.loadedNodePointGeometryBatches.get(cacheKey);

      if (existing?.promise === resultPromise) {
        this.deleteLoadedNodePointGeometryBatch(cacheKey);
      }

      throw error;
    });
    const entry: LoadedNodePointGeometryBatchCacheEntry = {
      nodeKey: node.key,
      maxPointCount: normalizedMaxPointCount,
      transformKey,
      promise: resultPromise,
      state: "pending",
      lastAccessSequence: 0,
    };

    this.trackLoadedNodePointGeometryBatchResolution(cacheKey, entry);
    this.setLoadedNodePointGeometryBatch(cacheKey, entry);

    return withAbortSignal(resultPromise, signal);
  }

  private async loadNodePointGeometryBatchWithoutCache(
    node: CopcHierarchyNodeSummary,
    maxPointCount: number,
    signal: AbortSignal | undefined,
    priority: number | undefined,
  ): Promise<CopcNodePointGeometryBatchResult> {
    if (!this.pointGeometryTransform) {
      throw new Error("A serializable point geometry transform is required.");
    }

    const workerResult =
      this.copcPointGeometryWorkerPool.loadNodePointGeometryBatch({
        copc: this.source.getLoadedCopcMetadata(),
        source: this.source.getDescriptor(),
        nodeKey: node.key,
        node: createSourceHierarchyNode(node),
        maxPointCount,
        transform: this.pointGeometryTransform,
        pointColorStyle: this.requirePointColorStyle(),
        priority,
        signal,
      });

    if (workerResult) {
      const result = await workerResult;
      this.rememberPointGeometryBatch(
        result.pointSamples,
        result.geometryBatch,
      );
      return result;
    }

    const pointSamples = await this.source.loadNodePointSamples({
      nodeKey: node.key,
      maxPointCount,
      sampleFormat: "typed",
      requestPriority: priority,
      signal,
    });
    const geometryBatch = await this.createPointGeometryBatch(
      pointSamples,
      this.getCoordinateTransforms(this.requireInspection()).toCesium,
      signal,
    );

    return {
      pointSamples,
      geometryBatch,
    };
  }

  private async resolvePointGeometryBatchResult(
    nodeResult: CopcNodePointSampleResult | undefined,
    node: CopcHierarchyNodeSummary,
    coordinateTransform: CopcCoordinateTransformSet["toCesium"],
    signal: AbortSignal | undefined,
    priority?: number,
  ): Promise<CopcNodePointGeometryBatchResult | undefined> {
    if (!nodeResult) {
      return undefined;
    }

    if (
      isTransferOnlyPointSampleResult(nodeResult) &&
      !this.hasTransformedPointGeometryBatch(nodeResult)
    ) {
      return await this.loadNodePointGeometryBatch(
        node,
        nodeResult.sampledPointCount,
        signal,
        priority,
      );
    }

    const geometryBatch = await this.createPointGeometryBatch(
      nodeResult,
      coordinateTransform,
      signal,
    );

    if (geometryBatch.pointCount === 0 && nodeResult.sampledPointCount > 0) {
      return await this.loadNodePointGeometryBatch(
        node,
        nodeResult.sampledPointCount,
        signal,
        priority,
      );
    }

    return {
      pointSamples: nodeResult,
      geometryBatch,
    };
  }

  private hasTransformedPointGeometryBatch(
    nodeResult: CopcNodePointSampleResult,
  ): boolean {
    const key = createNodePointSampleBatchKey(nodeResult);
    const task = this.transformedNodeResultGeometryBatches.get(key);

    if (!task) {
      return false;
    }

    if (!isReusableSharedAbortableTask(task)) {
      this.deleteTransformedNodeResultGeometryBatch(key);
      return false;
    }

    return true;
  }

  private createPointGeometryBatch(
    nodeResult: CopcNodePointSampleResult,
    coordinateTransform: CopcCoordinateTransformSet["toCesium"],
    signal: AbortSignal | undefined,
  ): Promise<PointGeometryBatch> {
    throwIfAborted(signal);
    const key = createNodePointSampleBatchKey(nodeResult);
    const cachedTask = this.transformedNodeResultGeometryBatches.get(key);

    if (cachedTask && isReusableSharedAbortableTask(cachedTask)) {
      this.transformedBatchCacheHitCount += 1;
      this.touchTransformedNodeResultGeometryBatch(key, cachedTask);
      return consumeSharedAbortableTask(cachedTask, signal);
    }

    if (cachedTask) {
      this.deleteTransformedNodeResultGeometryBatch(key);
    }

    this.transformedBatchCacheMissCount += 1;
    const task = createSharedAbortableTask((taskSignal) =>
      this.createPointGeometryBatchWithoutCache(
        nodeResult,
        coordinateTransform,
        taskSignal,
      ),
    );

    this.setTransformedNodeResultGeometryBatch(key, task);

    return consumeSharedAbortableTask(task, signal);
  }

  private async createPointGeometryBatchWithoutCache(
    nodeResult: CopcNodePointSampleResult,
    coordinateTransform: CopcCoordinateTransformSet["toCesium"],
    signal: AbortSignal | undefined,
  ): Promise<PointGeometryBatch> {
    const key = createNodePointSampleBatchKey(nodeResult);
    const workerResult =
      nodeResult.pointData && this.pointGeometryTransform
        ? this.pointGeometryWorkerPool.buildPointGeometryBatch({
            key,
            pointData: nodeResult.pointData,
            transform: this.pointGeometryTransform,
            pointColorStyle: this.requirePointColorStyle(),
            signal,
          })
        : undefined;

    if (workerResult) {
      return workerResult;
    }

    if (
      nodeResult.sampledPointCount > 0 &&
      !nodeResult.pointData &&
      nodeResult.points.length === 0
    ) {
      throw new Error(
        `COPC point geometry data is not cached for node ${nodeResult.nodeKey}.`,
      );
    }

    return createPointGeometryBatchFromCopc(
      nodeResult,
      coordinateTransform,
      this.requirePointColorStyle(),
    );
  }

  private rememberPointGeometryBatch(
    nodeResult: CopcNodePointSampleResult,
    geometryBatch: PointGeometryBatch,
  ): void {
    this.setTransformedNodeResultGeometryBatch(
      createNodePointSampleBatchKey(nodeResult),
      createFulfilledSharedAbortableTask(geometryBatch),
    );
  }

  private createPrepareNodesResult(
    inspection: CopcInspection,
    nodes: readonly CopcHierarchyNodeSummary[],
    geometryResults: readonly (CopcNodePointGeometryBatchResult | undefined)[],
  ): CopcPointCloudLayerPrepareNodesResult {
    const completedNodeResults = geometryResults.filter(isDefined);

    return {
      inspection,
      nodes: nodes.filter(
        (_node, index) => geometryResults[index] !== undefined,
      ),
      pointSamples: createMultiNodePointSampleResult(
        completedNodeResults.map((result) => result.pointSamples),
        false,
      ),
    };
  }

  private findReusableLoadedNodePointGeometryBatch(
    node: CopcHierarchyNodeSummary,
    maxPointCount: number,
    transformKey: string,
  ): LoadedNodePointGeometryBatchCacheEntry | undefined {
    const requiredPointCount = Math.min(node.pointCount, maxPointCount);
    const candidates = [...this.loadedNodePointGeometryBatches.entries()]
      .filter(
        ([, entry]) =>
          entry.state === "resolved" &&
          entry.nodeKey === node.key &&
          entry.transformKey === transformKey &&
          entry.maxPointCount >= requiredPointCount,
      )
      .sort(
        ([, first], [, second]) => first.maxPointCount - second.maxPointCount,
      );

    const reusable = candidates[0];

    if (!reusable) {
      return undefined;
    }

    this.touchLoadedNodePointGeometryBatch(reusable[0], reusable[1]);
    return reusable[1];
  }

  private setLoadedNodePointGeometryBatch(
    key: string,
    entry: LoadedNodePointGeometryBatchCacheEntry,
  ): void {
    this.deleteLoadedNodePointGeometryBatch(key);
    entry.lastAccessSequence = this.nextPointGeometryCacheAccessSequence();
    this.loadedNodePointGeometryBatches.set(key, entry);
    this.evictLoadedNodePointGeometryBatchesIfNeeded(key);
  }

  private touchLoadedNodePointGeometryBatch(
    key: string,
    entry: LoadedNodePointGeometryBatchCacheEntry,
  ): void {
    this.loadedNodePointGeometryBatches.delete(key);
    entry.lastAccessSequence = this.nextPointGeometryCacheAccessSequence();
    this.loadedNodePointGeometryBatches.set(key, entry);
  }

  private trackLoadedNodePointGeometryBatchResolution(
    key: string,
    entry: LoadedNodePointGeometryBatchCacheEntry,
  ): void {
    void entry.promise.then(
      (result) => {
        if (this.loadedNodePointGeometryBatches.get(key) === entry) {
          entry.state = "resolved";
          this.retainResolvedPointGeometryBatch(
            "loaded",
            key,
            result.geometryBatch,
          );
        }
      },
      () => {
        if (this.loadedNodePointGeometryBatches.get(key) === entry) {
          this.deleteLoadedNodePointGeometryBatch(key);
        }
      },
    );
  }

  private evictLoadedNodePointGeometryBatchesIfNeeded(
    protectedKey: string,
  ): void {
    while (
      this.loadedNodePointGeometryBatches.size >
      this.maxCachedPointGeometryBatches
    ) {
      const oldestKey = [...this.loadedNodePointGeometryBatches.entries()].find(
        ([key, entry]) => key !== protectedKey && entry.state === "resolved",
      )?.[0];

      if (!oldestKey) {
        return;
      }

      this.pointGeometryCacheEvictedBytes +=
        this.deleteLoadedNodePointGeometryBatch(oldestKey);
      this.loadedBatchCacheEvictionCount += 1;
    }
  }

  private setTransformedNodeResultGeometryBatch(
    key: string,
    task: SharedAbortableTask<PointGeometryBatch>,
  ): void {
    this.deleteTransformedNodeResultGeometryBatch(key);
    this.transformedNodeResultGeometryBatches.set(key, task);
    this.transformedPointGeometryCacheAccessSequences.set(
      key,
      this.nextPointGeometryCacheAccessSequence(),
    );
    void task.promise.then(
      (batch) => {
        if (this.transformedNodeResultGeometryBatches.get(key) === task) {
          this.retainResolvedPointGeometryBatch("transformed", key, batch);
        }
      },
      () => {
        if (this.transformedNodeResultGeometryBatches.get(key) === task) {
          this.deleteTransformedNodeResultGeometryBatch(key);
        }
      },
    );
    this.evictTransformedNodeResultGeometryBatchesIfNeeded(key);
  }

  private touchTransformedNodeResultGeometryBatch(
    key: string,
    task: SharedAbortableTask<PointGeometryBatch>,
  ): void {
    this.transformedNodeResultGeometryBatches.delete(key);
    this.transformedNodeResultGeometryBatches.set(key, task);
    this.transformedPointGeometryCacheAccessSequences.set(
      key,
      this.nextPointGeometryCacheAccessSequence(),
    );
  }

  private evictTransformedNodeResultGeometryBatchesIfNeeded(
    protectedKey: string,
  ): void {
    while (
      this.transformedNodeResultGeometryBatches.size >
      this.maxCachedTransformedPointGeometryBatches
    ) {
      const oldestKey = [
        ...this.transformedNodeResultGeometryBatches.entries(),
      ].find(
        ([key, task]) => key !== protectedKey && task.state === "fulfilled",
      )?.[0];

      if (!oldestKey) {
        return;
      }

      this.pointGeometryCacheEvictedBytes +=
        this.deleteTransformedNodeResultGeometryBatch(oldestKey);
      this.transformedBatchCacheEvictionCount += 1;
    }
  }

  private retainResolvedPointGeometryBatch(
    cacheKind: PointGeometryCacheKind,
    key: string,
    batch: PointGeometryBatch,
  ): void {
    if (
      this.maxCachedPointGeometryBytes !== undefined &&
      estimatePointGeometryBatchByteSize(batch) >
        this.maxCachedPointGeometryBytes
    ) {
      this.oversizedPointGeometryBatchCacheSkipCount += 1;
      this.deletePointGeometryCacheEntry(cacheKind, key);
      this.incrementPointGeometryCacheEvictionCount(cacheKind);
      return;
    }

    const cacheBatches = this.getPointGeometryCacheBatches(cacheKind);
    const cachedBatch = cacheBatches.get(key);

    if (cachedBatch !== batch) {
      if (cachedBatch) {
        this.releasePointGeometryCacheBatch(cacheBatches, key);
      }

      cacheBatches.set(key, batch);
      for (const buffer of getPointGeometryBatchBackingBuffers(batch)) {
        const allocation = this.pointGeometryBufferAllocations.get(buffer);

        if (allocation) {
          allocation.referenceCount += 1;
          continue;
        }

        const byteSize = buffer.byteLength;
        this.pointGeometryBufferAllocations.set(buffer, {
          byteSize,
          referenceCount: 1,
        });
        this.cachedPointGeometryBytes += byteSize;
      }
      this.peakCachedPointGeometryBytes = Math.max(
        this.peakCachedPointGeometryBytes,
        this.cachedPointGeometryBytes,
      );
    }

    this.evictLoadedNodePointGeometryBatchesIfNeeded(
      cacheKind === "loaded" ? key : "",
    );
    this.evictTransformedNodeResultGeometryBatchesIfNeeded(
      cacheKind === "transformed" ? key : "",
    );
    this.evictPointGeometryBatchesByByteSizeIfNeeded();
  }

  private evictPointGeometryBatchesByByteSizeIfNeeded(): void {
    if (this.maxCachedPointGeometryBytes === undefined) {
      return;
    }

    while (this.cachedPointGeometryBytes > this.maxCachedPointGeometryBytes) {
      const candidate = this.findOldestRetainedPointGeometryCacheEntry();

      if (!candidate) {
        return;
      }

      const reclaimedByteSize = this.deletePointGeometryCacheEntry(
        candidate.cacheKind,
        candidate.key,
      );
      this.incrementPointGeometryCacheEvictionCount(candidate.cacheKind);
      this.pointGeometryCacheByteEvictionCount += 1;
      this.pointGeometryCacheEvictedBytes += reclaimedByteSize;
    }
  }

  private findOldestRetainedPointGeometryCacheEntry():
    | {
        readonly cacheKind: PointGeometryCacheKind;
        readonly key: string;
        readonly lastAccessSequence: number;
      }
    | undefined {
    const candidates = [
      ...[...this.loadedPointGeometryCacheBatches.keys()].flatMap((key) => {
        const entry = this.loadedNodePointGeometryBatches.get(key);

        return entry?.state === "resolved"
          ? [
              {
                cacheKind: "loaded" as const,
                key,
                lastAccessSequence: entry.lastAccessSequence,
              },
            ]
          : [];
      }),
      ...[...this.transformedPointGeometryCacheBatches.keys()].flatMap(
        (key) => {
          const task = this.transformedNodeResultGeometryBatches.get(key);
          const lastAccessSequence =
            this.transformedPointGeometryCacheAccessSequences.get(key);

          return task?.state === "fulfilled" && lastAccessSequence !== undefined
            ? [
                {
                  cacheKind: "transformed" as const,
                  key,
                  lastAccessSequence,
                },
              ]
            : [];
        },
      ),
    ];

    return candidates.reduce<(typeof candidates)[number] | undefined>(
      (oldest, candidate) =>
        !oldest || candidate.lastAccessSequence < oldest.lastAccessSequence
          ? candidate
          : oldest,
      undefined,
    );
  }

  private deletePointGeometryCacheEntry(
    cacheKind: PointGeometryCacheKind,
    key: string,
  ): number {
    return cacheKind === "loaded"
      ? this.deleteLoadedNodePointGeometryBatch(key)
      : this.deleteTransformedNodeResultGeometryBatch(key);
  }

  private deleteLoadedNodePointGeometryBatch(key: string): number {
    this.loadedNodePointGeometryBatches.delete(key);
    return this.releasePointGeometryCacheBatch(
      this.loadedPointGeometryCacheBatches,
      key,
    );
  }

  private deleteTransformedNodeResultGeometryBatch(key: string): number {
    this.transformedNodeResultGeometryBatches.delete(key);
    this.transformedPointGeometryCacheAccessSequences.delete(key);
    return this.releasePointGeometryCacheBatch(
      this.transformedPointGeometryCacheBatches,
      key,
    );
  }

  private releasePointGeometryCacheBatch(
    cacheBatches: Map<string, PointGeometryBatch>,
    key: string,
  ): number {
    const batch = cacheBatches.get(key);

    if (!batch) {
      return 0;
    }

    cacheBatches.delete(key);
    let reclaimedByteSize = 0;
    for (const buffer of getPointGeometryBatchBackingBuffers(batch)) {
      const allocation = this.pointGeometryBufferAllocations.get(buffer);

      if (!allocation) {
        continue;
      }

      allocation.referenceCount -= 1;
      if (allocation.referenceCount > 0) {
        continue;
      }

      this.pointGeometryBufferAllocations.delete(buffer);
      reclaimedByteSize += allocation.byteSize;
      this.cachedPointGeometryBytes -= allocation.byteSize;
    }

    return reclaimedByteSize;
  }

  private getPointGeometryCacheBatches(
    cacheKind: PointGeometryCacheKind,
  ): Map<string, PointGeometryBatch> {
    return cacheKind === "loaded"
      ? this.loadedPointGeometryCacheBatches
      : this.transformedPointGeometryCacheBatches;
  }

  private incrementPointGeometryCacheEvictionCount(
    cacheKind: PointGeometryCacheKind,
  ): void {
    if (cacheKind === "loaded") {
      this.loadedBatchCacheEvictionCount += 1;
    } else {
      this.transformedBatchCacheEvictionCount += 1;
    }
  }

  private clearPointGeometryCacheEntries(): void {
    this.loadedNodePointGeometryBatches.clear();
    this.transformedNodeResultGeometryBatches.clear();
    this.loadedPointGeometryCacheBatches.clear();
    this.transformedPointGeometryCacheBatches.clear();
    this.pointGeometryBufferAllocations.clear();
    this.transformedPointGeometryCacheAccessSequences.clear();
    this.cachedPointGeometryBytes = 0;
  }

  private nextPointGeometryCacheAccessSequence(): number {
    this.pointGeometryCacheAccessSequence += 1;
    return this.pointGeometryCacheAccessSequence;
  }

  private shouldUseIntegratedPointGeometryLoading(
    includePointsInResult: boolean | undefined,
  ): boolean {
    return (
      this.pointGeometryLoading === "integrated-worker" &&
      includePointsInResult === false &&
      this.pointGeometryTransform !== undefined &&
      isCopcPointCloudGeometryBatchRenderer(this.pointRenderer)
    );
  }

  private getPreferredPointSampleFormat(
    includePointsInResult: boolean | undefined,
  ): CopcPointSampleFormat {
    if (
      includePointsInResult === false &&
      isCopcPointCloudGeometryBatchRenderer(this.pointRenderer)
    ) {
      return "typed";
    }

    return "objects";
  }

  private requireInspection(): CopcInspection {
    if (!this.loadedInspection) {
      throw new Error("COPC inspection was not loaded.");
    }

    return this.loadedInspection;
  }

  private requirePointColorStyle(): ResolvedCopcPointColorStyle {
    if (!this.pointColorStyle) {
      this.pointColorStyle = resolveCopcPointColorStyle(
        this.pointColorMode,
        this.requireInspection().bounds,
      );
    }

    return this.pointColorStyle;
  }

  private requireHierarchy(): CopcHierarchySummary {
    if (!this.loadedHierarchy) {
      throw new Error("COPC hierarchy was not loaded.");
    }

    return this.loadedHierarchy;
  }

  private requireCoordinateTransformStatus(): CopcCoordinateTransformStatus {
    if (!this.coordinateTransformStatus) {
      throw new Error("COPC coordinate transform status was not initialized.");
    }

    return this.coordinateTransformStatus;
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error("CopcPointCloudLayer has been destroyed.");
    }
  }
}

function normalizeCoordinateTransformStatus(
  transforms: CopcCoordinateTransformSet,
): CopcCoordinateTransformStatus {
  return {
    ...transforms.status,
    kind: transforms.status?.kind ?? "custom",
    label: transforms.status?.label ?? "Custom coordinate transform",
    supportsCameraSelection: Boolean(transforms.toCopc),
  };
}

function nowMilliseconds(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function estimateRenderPayloadBytes(pointCount: number): number {
  const positionBytes = 3 * Float64Array.BYTES_PER_ELEMENT;
  const colorBytes = 4 * Uint8Array.BYTES_PER_ELEMENT;

  return pointCount * (positionBytes + colorBytes);
}

function summarizePointGeometryBatchTimings(
  nodes: readonly CopcHierarchyNodeSummary[],
  geometryResults: readonly CopcNodePointGeometryBatchResult[],
): CopcPointCloudLayerPointGeometryTimingStats | undefined {
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const nodeTimings = geometryResults
    .map((result) => {
      const timing = result.timing;

      if (!timing) {
        return undefined;
      }

      const node = nodeByKey.get(result.pointSamples.nodeKey);

      return {
        nodeKey: result.pointSamples.nodeKey,
        nodePointCount: result.pointSamples.nodePointCount,
        sampledPointCount: result.pointSamples.sampledPointCount,
        pointDataLength: node?.pointDataLength,
        pointDataViewMilliseconds: timing.pointDataViewMilliseconds,
        pointDataViewCacheHit: timing.pointDataViewCacheHit,
        sampleMilliseconds: timing.sampleMilliseconds,
        geometryMilliseconds: timing.geometryMilliseconds,
        workerTotalMilliseconds: timing.workerTotalMilliseconds,
        requestQueueMilliseconds: timing.requestQueueMilliseconds ?? 0,
        requestRoundTripMilliseconds: timing.requestRoundTripMilliseconds ?? 0,
      };
    })
    .filter(isDefined);

  if (nodeTimings.length === 0) {
    return undefined;
  }

  const timings = nodeTimings;

  return {
    nodeCount: timings.length,
    cacheHitCount: timings.filter((timing) => timing.pointDataViewCacheHit)
      .length,
    slowestNodes: [...nodeTimings]
      .sort(
        (left, right) =>
          right.pointDataViewMilliseconds - left.pointDataViewMilliseconds ||
          right.workerTotalMilliseconds - left.workerTotalMilliseconds,
      )
      .slice(0, 5),
    pointDataViewMilliseconds: sumPointGeometryTiming(
      timings,
      (timing) => timing.pointDataViewMilliseconds,
    ),
    sampleMilliseconds: sumPointGeometryTiming(
      timings,
      (timing) => timing.sampleMilliseconds,
    ),
    geometryMilliseconds: sumPointGeometryTiming(
      timings,
      (timing) => timing.geometryMilliseconds,
    ),
    workerTotalMilliseconds: sumPointGeometryTiming(
      timings,
      (timing) => timing.workerTotalMilliseconds,
    ),
    requestQueueMilliseconds: sumPointGeometryTiming(
      timings,
      (timing) => timing.requestQueueMilliseconds ?? 0,
    ),
    requestRoundTripMilliseconds: sumPointGeometryTiming(
      timings,
      (timing) => timing.requestRoundTripMilliseconds ?? 0,
    ),
    maxPointDataViewMilliseconds: maxPointGeometryTiming(
      timings,
      (timing) => timing.pointDataViewMilliseconds,
    ),
    maxSampleMilliseconds: maxPointGeometryTiming(
      timings,
      (timing) => timing.sampleMilliseconds,
    ),
    maxGeometryMilliseconds: maxPointGeometryTiming(
      timings,
      (timing) => timing.geometryMilliseconds,
    ),
    maxWorkerTotalMilliseconds: maxPointGeometryTiming(
      timings,
      (timing) => timing.workerTotalMilliseconds,
    ),
    maxRequestQueueMilliseconds: maxPointGeometryTiming(
      timings,
      (timing) => timing.requestQueueMilliseconds ?? 0,
    ),
    maxRequestRoundTripMilliseconds: maxPointGeometryTiming(
      timings,
      (timing) => timing.requestRoundTripMilliseconds ?? 0,
    ),
  };
}

function sumPointGeometryTiming(
  timings: readonly CopcPointGeometryBatchTiming[],
  readValue: (timing: CopcPointGeometryBatchTiming) => number,
): number {
  return timings.reduce((total, timing) => total + readValue(timing), 0);
}

function maxPointGeometryTiming(
  timings: readonly CopcPointGeometryBatchTiming[],
  readValue: (timing: CopcPointGeometryBatchTiming) => number,
): number {
  return timings.reduce(
    (maxValue, timing) => Math.max(maxValue, readValue(timing)),
    0,
  );
}

function createCesiumBoundsSphere(
  node: Pick<CopcHierarchyNodeSummary, "bounds">,
  transform: CopcToCesiumTransform,
): BoundingSphere {
  return BoundingSphere.fromPoints(createCesiumBoundsCorners(node, transform));
}

type CopcToCesiumTransform = CopcCoordinateTransformSet["toCesium"];

interface SelectionDepthRange {
  readonly minDepth?: number;
  readonly maxDepth?: number;
}

function isNodeInsideSelectionDepth(
  node: Pick<CopcHierarchyNodeSummary, "depth">,
  range: SelectionDepthRange,
): boolean {
  const minDepth = range.minDepth ?? 0;
  const maxDepth = range.maxDepth ?? Number.POSITIVE_INFINITY;

  return node.depth >= minDepth && node.depth <= maxDepth;
}

function splitNodesBySelectionDepth(
  nodes: readonly CopcHierarchyNodeSummary[],
  range: SelectionDepthRange,
): {
  readonly frustumCandidateNodes: readonly CopcHierarchyNodeSummary[];
  readonly retainedNodes: readonly CopcHierarchyNodeSummary[];
} {
  const frustumCandidateNodes: CopcHierarchyNodeSummary[] = [];
  const retainedNodes: CopcHierarchyNodeSummary[] = [];

  for (const node of nodes) {
    if (isNodeInsideSelectionDepth(node, range)) {
      frustumCandidateNodes.push(node);
    } else {
      retainedNodes.push(node);
    }
  }

  return { frustumCandidateNodes, retainedNodes };
}

function createCesiumBoundsCorners(
  node: Pick<CopcHierarchyNodeSummary, "bounds">,
  transform: CopcToCesiumTransform,
): Cartesian3[] {
  const { minX, minY, minZ, maxX, maxY, maxZ } = node.bounds;
  const corners: Cartesian3[] = [];

  for (const x of [minX, maxX]) {
    for (const y of [minY, maxY]) {
      for (const z of [minZ, maxZ]) {
        const coordinate = transform(x, y, z);
        corners.push(
          Cartesian3.fromDegrees(
            coordinate.longitudeDegrees,
            coordinate.latitudeDegrees,
            coordinate.heightMeters,
          ),
        );
      }
    }
  }

  return corners;
}

function appendFrustumSelectionReason(
  reason: string,
  skippedByFrustumCount: number,
): string {
  if (skippedByFrustumCount === 0) {
    return reason;
  }

  return `${reason} Frustum-culled ${skippedByFrustumCount.toLocaleString()} off-screen candidate nodes.`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  throw createAbortError(signal);
}

async function yieldToNextProgressiveRenderFrame(
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);

  if (typeof globalThis.requestAnimationFrame !== "function") {
    await Promise.resolve();
    throwIfAborted(signal);
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let frameId: number | undefined;
    let fallbackId: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (frameId !== undefined) {
        globalThis.cancelAnimationFrame?.(frameId);
      }
      if (fallbackId !== undefined) {
        globalThis.clearTimeout(fallbackId);
      }
      signal?.removeEventListener("abort", finish);
      resolve();
    };

    frameId = globalThis.requestAnimationFrame(finish);
    // Hidden or throttled documents may suspend animation frames. Keep
    // cancellation and headless callers bounded without turning this yield
    // into a fixed delay on an active Cesium canvas.
    fallbackId = globalThis.setTimeout(finish, 50);
    signal?.addEventListener("abort", finish, { once: true });
  });

  throwIfAborted(signal);
}

interface ProgressivePendingEntry<T> {
  readonly index: number;
  readonly promise: Promise<T>;
}

interface LinkedAbortController {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
}

function createLinkedAbortController(
  signal: AbortSignal | undefined,
): LinkedAbortController {
  const controller = new AbortController();

  if (!signal) {
    return {
      controller,
      signal: controller.signal,
      cleanup: () => undefined,
    };
  }

  const abort = (): void => {
    controller.abort(createAbortError(signal));
  };

  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }

  return {
    controller,
    signal: controller.signal,
    cleanup: () => {
      signal.removeEventListener("abort", abort);
    },
  };
}

function abortPendingProgressiveEntries(
  controller: AbortController,
  entries: readonly ProgressivePendingEntry<unknown>[],
): void {
  if (entries.length === 0) {
    return;
  }

  for (const entry of entries) {
    void entry.promise.catch(() => undefined);
  }

  if (!controller.signal.aborted) {
    controller.abort();
  }
}

async function settlePendingProgressiveEntriesInBackground(
  linkedAbortController: LinkedAbortController,
  entries: readonly ProgressivePendingEntry<unknown>[],
): Promise<void> {
  try {
    await Promise.allSettled(entries.map((entry) => entry.promise));
  } finally {
    linkedAbortController.cleanup();
  }
}

function withAbortSignal<T>(
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

function createAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }

  if (typeof DOMException !== "undefined") {
    return new DOMException(
      "COPC point sample request was aborted.",
      "AbortError",
    );
  }

  const error = new Error("COPC point sample request was aborted.");
  error.name = "AbortError";
  return error;
}

function findRequiredNode(
  hierarchy: CopcHierarchySummary,
  nodeKey: string,
): CopcHierarchyNodeSummary {
  const node = hierarchy.nodes.find((candidate) => candidate.key === nodeKey);

  if (!node) {
    throw new Error(`COPC hierarchy node was not found: ${nodeKey}`);
  }

  return node;
}

function uniqueNodeKeys(nodeKeys: readonly string[]): string[] {
  const normalizedNodeKeys = [...new Set(nodeKeys)];

  if (normalizedNodeKeys.length === 0) {
    throw new Error("At least one COPC hierarchy node key is required.");
  }

  return normalizedNodeKeys;
}

function uniqueNodeSampleResults(
  nodeResults: readonly CopcNodePointSampleResult[],
): CopcNodePointSampleResult[] {
  const normalizedNodeResults = uniqueOptionalNodeSampleResults(nodeResults);

  if (normalizedNodeResults.length === 0) {
    throw new Error("At least one COPC node point sample result is required.");
  }

  return normalizedNodeResults;
}

function uniqueOptionalNodeSampleResults(
  nodeResults: readonly CopcNodePointSampleResult[],
): CopcNodePointSampleResult[] {
  const resultByNodeKey = new Map(
    nodeResults.map((nodeResult) => [nodeResult.nodeKey, nodeResult]),
  );

  return [...resultByNodeKey.values()];
}

function isNodeSampleResultFresh(
  nodeResult: CopcNodePointSampleResult | undefined,
  maxPointCount: number | undefined,
): nodeResult is CopcNodePointSampleResult {
  if (!nodeResult) {
    return false;
  }

  if (maxPointCount === undefined) {
    return true;
  }

  return (
    nodeResult.sampledPointCount >=
    Math.min(nodeResult.nodePointCount, maxPointCount)
  );
}

function createMultiNodePointSampleResult(
  nodeResults: readonly CopcNodePointSampleResult[],
  includePoints: boolean,
): CopcMultiNodePointSampleResult {
  return {
    nodeKeys: nodeResults.map((result) => result.nodeKey),
    nodeResults,
    nodePointCount: nodeResults.reduce(
      (total, result) => total + result.nodePointCount,
      0,
    ),
    sampledPointCount: nodeResults.reduce(
      (total, result) => total + result.sampledPointCount,
      0,
    ),
    points: includePoints
      ? nodeResults.flatMap((result) => getPointDataSamples(result))
      : [],
  };
}

function createProgressiveRenderCandidateNodeSamples(
  pointSamples: CopcMultiNodePointSampleResult,
): CopcPointCloudLayerProgressiveRenderCandidate["nodeSamples"] {
  return pointSamples.nodeResults.map((nodeResult) => ({
    nodeKey: nodeResult.nodeKey,
    nodePointCount: nodeResult.nodePointCount,
    sampledPointCount: nodeResult.sampledPointCount,
  }));
}

function isTransferOnlyPointSampleResult(
  nodeResult: CopcNodePointSampleResult,
): boolean {
  return (
    nodeResult.sampledPointCount > 0 &&
    nodeResult.points.length === 0 &&
    !nodeResult.pointData
  );
}

function createSourceHierarchyNode(
  node: CopcHierarchyNodeSummary,
): Hierarchy.Node {
  return {
    pointCount: node.pointCount,
    pointDataOffset: node.pointDataOffset,
    pointDataLength: node.pointDataLength,
  } as Hierarchy.Node;
}

function createNodePointGeometryBatchCacheKey(
  nodeKey: string,
  maxPointCount: number,
  transform: CesiumPointGeometryTransform | undefined,
): string {
  return [
    nodeKey,
    maxPointCount,
    createPointGeometryTransformCacheKey(transform),
  ].join(":");
}

function createPointGeometryTransformCacheKey(
  transform: CesiumPointGeometryTransform | undefined,
): string {
  return [
    transform?.kind ?? "custom",
    transform?.heightScaleToMeters ?? 1,
    transform?.sourceCrs ?? "",
    transform?.sourceDefinition ?? "",
    transform?.targetCrs ?? "",
    transform?.targetDefinition ?? "",
  ].join(":");
}

function readLoadedNodePointGeometryBatchCacheResult(
  entry: LoadedNodePointGeometryBatchCacheEntry,
): Promise<CopcNodePointGeometryBatchResult> {
  return entry.state === "resolved"
    ? entry.promise.then(markPointGeometryBatchResultCacheHit)
    : entry.promise;
}

function selectHierarchyPagesCoveringTarget(
  pages: CopcHierarchySummary["pendingPages"],
  target: CopcTargetPoint,
  depthRange: Pick<
    CopcPointCloudLayerHierarchyExpansionOptions,
    "minDepth" | "maxDepth"
  >,
): CopcHierarchySummary["pendingPages"] {
  const minDepth = depthRange.minDepth ?? 0;
  const maxDepth = depthRange.maxDepth ?? Number.POSITIVE_INFINITY;
  const tolerance =
    Math.max(1, Math.abs(target.x), Math.abs(target.y)) * Number.EPSILON * 16;

  return pages.filter(
    (page) =>
      page.depth >= minDepth &&
      page.depth <= maxDepth &&
      distanceToRange(target.x, page.bounds.minX, page.bounds.maxX) <=
        tolerance &&
      distanceToRange(target.y, page.bounds.minY, page.bounds.maxY) <=
        tolerance,
  );
}

function distanceToRange(value: number, min: number, max: number): number {
  if (value < min) {
    return min - value;
  }

  return value > max ? value - max : 0;
}

function createHierarchyPageSignature(
  pages: CopcHierarchySummary["pendingPages"],
): string | undefined {
  if (pages.length === 0) {
    return undefined;
  }

  return [...pages]
    .map((page) => `${page.key}:${page.pageOffset}:${page.pageLength}`)
    .sort()
    .join("|");
}

function readProgressiveMaxPointCountPerNode(
  nodeCount: number,
  maxPointCountPerNode: number | undefined,
  maxRenderedPointCount: number | undefined,
  useSourcePointBudgetHeadroom = false,
): number | undefined {
  if (
    useSourcePointBudgetHeadroom ||
    maxRenderedPointCount === undefined ||
    nodeCount <= 0
  ) {
    return maxPointCountPerNode;
  }

  const budgetPointCountPerNode = Math.max(
    1,
    Math.ceil(maxRenderedPointCount / nodeCount),
  );

  return maxPointCountPerNode === undefined
    ? budgetPointCountPerNode
    : Math.min(maxPointCountPerNode, budgetPointCountPerNode);
}

function createPointCountWeightByNodeKey(
  nodeKeys: readonly string[],
  weights: readonly number[] | undefined,
): ReadonlyMap<string, number> | undefined {
  if (weights === undefined) {
    return undefined;
  }

  if (weights.length !== nodeKeys.length) {
    throw new Error("nodePointCountWeights must align with the requested nodes.");
  }

  if (weights.some((weight) => !Number.isFinite(weight) || weight <= 0)) {
    throw new Error("nodePointCountWeights must contain positive finite numbers.");
  }

  return new Map(nodeKeys.map((nodeKey, index) => [nodeKey, weights[index]]));
}

function createProgressiveNodeRequestPriorities(
  nodes: readonly CopcHierarchyNodeSummary[],
  basePriority: number | undefined,
  nodeRequestOrder: CopcPointCloudLayerProgressiveNodeOrder = "selection",
): readonly number[] {
  const normalizedBasePriority =
    basePriority !== undefined && Number.isFinite(basePriority)
      ? basePriority
      : 0;

  if (nodes.length === 0) {
    return [];
  }

  const denominator = Math.max(1, nodes.length - 1);
  const maxWeight = Math.max(1, ...nodes.map(readProgressiveNodeRequestWeight));
  const priorityRankByNodeKey = new Map(
    orderAutomaticProgressiveNodes(nodes, nodeRequestOrder).map(
      (node, index) => [node.key, index],
    ),
  );

  return nodes.map((node, index) => {
    const priorityRank = priorityRankByNodeKey.get(node.key) ?? index;
    const coverageOrderBoost =
      ((nodes.length - 1 - priorityRank) / denominator) *
      PROGRESSIVE_NODE_PRIORITY_BOOST;
    const lightweightTieBreakBoost =
      (1 - Math.min(1, readProgressiveNodeRequestWeight(node) / maxWeight)) *
      0.01;

    return (
      normalizedBasePriority + coverageOrderBoost + lightweightTieBreakBoost
    );
  });
}

function orderProgressivePendingNodeIndexes(
  nodes: readonly CopcHierarchyNodeSummary[],
  pendingNodeIndexes: readonly number[],
  nodeRequestOrder: CopcPointCloudLayerProgressiveNodeOrder = "selection",
): readonly number[] {
  if (nodeRequestOrder === "selection") {
    return pendingNodeIndexes;
  }

  const compare =
    nodeRequestOrder === "source-points-first"
      ? compareNodesByProgressiveSourcePoints
      : compareNodesByProgressiveWeight;

  return [...pendingNodeIndexes].sort(
    (leftIndex, rightIndex) =>
      compare(nodes[leftIndex], nodes[rightIndex]) || leftIndex - rightIndex,
  );
}

function readProgressiveNodeRequestWeight(
  node: CopcHierarchyNodeSummary,
): number {
  if (Number.isFinite(node.pointDataLength) && node.pointDataLength > 0) {
    return node.pointDataLength;
  }

  if (Number.isFinite(node.pointCount) && node.pointCount > 0) {
    return node.pointCount;
  }

  return Number.MAX_SAFE_INTEGER;
}

function readPositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : Math.max(1, fallback);
}

function getPointSampleWorkerSlotCount(
  options: CopcPointCloudLayerOptions,
): number {
  const pointSampleLoading =
    options.pointSampleLoading ??
    (options.createPointSampleWorker ? "worker" : "main-thread");

  if (pointSampleLoading !== "worker") {
    return 0;
  }

  return readPositiveIntegerOption(
    "maxConcurrentPointSampleWorkerRequests",
    options.maxConcurrentPointSampleWorkerRequests,
    DEFAULT_MAX_CONCURRENT_POINT_SAMPLE_WORKER_REQUESTS,
  );
}

function getIntegratedPointGeometryWorkerSlotCount(
  options: CopcPointCloudLayerOptions,
): number {
  if (options.pointGeometryLoading !== "integrated-worker") {
    return 0;
  }

  return readPositiveIntegerOption(
    "maxConcurrentPointGeometryWorkerRequests",
    options.maxConcurrentPointGeometryWorkerRequests,
    DEFAULT_MAX_CONCURRENT_COPC_POINT_GEOMETRY_WORKER_REQUESTS,
  );
}

function allocateDecodedPointDataWorkerBudgets(options: {
  readonly maxBytesAcrossWorkers: number | undefined;
  readonly pointSampleWorkerSlotCount: number;
  readonly integratedPointGeometryWorkerSlotCount: number;
}): {
  readonly pointSample: number | undefined;
  readonly integratedPointGeometry: number | undefined;
} {
  const {
    maxBytesAcrossWorkers,
    pointSampleWorkerSlotCount,
    integratedPointGeometryWorkerSlotCount,
  } = options;

  if (maxBytesAcrossWorkers === undefined) {
    return {
      pointSample: undefined,
      integratedPointGeometry: undefined,
    };
  }

  if (pointSampleWorkerSlotCount === 0) {
    return {
      pointSample: undefined,
      integratedPointGeometry:
        integratedPointGeometryWorkerSlotCount > 0
          ? maxBytesAcrossWorkers
          : undefined,
    };
  }

  if (integratedPointGeometryWorkerSlotCount === 0) {
    return {
      pointSample: maxBytesAcrossWorkers,
      integratedPointGeometry: undefined,
    };
  }

  if (maxBytesAcrossWorkers < 2) {
    throw new Error(
      "maxDecodedPointDataViewBytesAcrossWorkers must provide at least one byte for each active decoded point data worker pool.",
    );
  }

  const totalWorkerSlotCount =
    pointSampleWorkerSlotCount + integratedPointGeometryWorkerSlotCount;
  const proportionalPointSampleBytes = Math.floor(
    (maxBytesAcrossWorkers * pointSampleWorkerSlotCount) / totalWorkerSlotCount,
  );
  const pointSample = Math.max(
    1,
    Math.min(maxBytesAcrossWorkers - 1, proportionalPointSampleBytes),
  );

  return {
    pointSample,
    integratedPointGeometry: maxBytesAcrossWorkers - pointSample,
  };
}

function readPositiveIntegerOption(
  optionName: string,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return value;
}

function readOptionalPositiveIntegerOption(
  optionName: string,
  value: number | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return value;
}

function readPointColorMode(
  value: CopcPointColorMode | undefined,
): CopcPointColorMode {
  if (value === undefined || value === "attribute") {
    return "attribute";
  }

  if (value === "elevation") {
    return "elevation";
  }

  throw new Error('pointColorMode must be "attribute" or "elevation".');
}

function orderAutomaticProgressiveNodes(
  nodes: readonly CopcHierarchyNodeSummary[],
  nodeRenderOrder: CopcPointCloudLayerProgressiveNodeOrder,
): readonly CopcHierarchyNodeSummary[] {
  if (nodeRenderOrder === "selection") {
    return nodes;
  }

  return [...nodes].sort(
    nodeRenderOrder === "source-points-first"
      ? compareNodesByProgressiveSourcePoints
      : compareNodesByProgressiveWeight,
  );
}

function createAutomaticRenderNodesWithAncestors(
  selectedNodes: readonly CopcHierarchyNodeSummary[],
  hierarchy: CopcHierarchySummary,
): readonly CopcHierarchyNodeSummary[] {
  const nodesByKey = new Map(hierarchy.nodes.map((node) => [node.key, node]));
  const renderNodes = new Map<string, CopcHierarchyNodeSummary>();

  selectedNodes.forEach((selectedNode) => {
    createCopcNodeAncestorKeys(selectedNode.key).forEach((nodeKey) => {
      const node = nodesByKey.get(nodeKey);

      if (node) {
        renderNodes.set(nodeKey, node);
      }
    });
  });

  return [...renderNodes.values()];
}

function compareNodesByProgressiveWeight(
  left: CopcHierarchyNodeSummary,
  right: CopcHierarchyNodeSummary,
): number {
  return (
    left.pointDataLength - right.pointDataLength ||
    left.pointCount - right.pointCount ||
    left.depth - right.depth ||
    left.key.localeCompare(right.key)
  );
}

function compareNodesByProgressiveSourcePoints(
  left: CopcHierarchyNodeSummary,
  right: CopcHierarchyNodeSummary,
): number {
  return (
    right.pointCount - left.pointCount ||
    left.pointDataLength - right.pointDataLength ||
    left.depth - right.depth ||
    left.key.localeCompare(right.key)
  );
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
