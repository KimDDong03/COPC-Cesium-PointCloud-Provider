export interface CopcCameraStreamLodQualitySettings {
  readonly cameraStreamMaxRenderedPointCount: number;
  readonly cameraStreamMaxSourcePointCount: number;
  readonly cameraStreamMaxNodePointCount: number;
  readonly cameraStreamMaxPointDataLength: number;
  readonly cameraStreamMaxNodePointDataLength: number;
  readonly cameraStreamMaxNodes: number;
  readonly cameraStreamMaxDepth: number;
  readonly cameraStreamTargetNodeScreenPixels: number;
  readonly cameraStreamTargetPointSpacingScreenPixels: number;
}

export interface CopcCameraStreamLodSettings {
  readonly label: string;
  readonly cameraHeightMeters: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly targetNodeScreenPixels: number;
  readonly targetPointSpacingScreenPixels: number;
  readonly maxRenderedPointCount: number;
  readonly maxSourcePointCount: number;
  readonly maxNodePointCount: number;
  readonly maxPointDataLength: number;
  readonly maxNodePointDataLength: number;
  readonly maxHierarchyPages: number;
  readonly detailMaxPointCountPerNode: number;
  readonly detailMinFinalNodeCount: number;
  readonly detailTargetPointCountPerNode: number;
}

export interface CopcCameraStreamLodSettingsOptions {
  readonly cameraHeightMeters: number;
  readonly qualitySettings: CopcCameraStreamLodQualitySettings;
  readonly baseMaxHierarchyPages?: number;
}

export interface CopcCameraStreamMixedDepthThresholdOptions {
  readonly cameraSettled: boolean;
  readonly targetPointSpacingScreenPixels: number;
}

export interface CopcCameraStreamMixedDepthThresholds {
  readonly refineScreenSpaceError: number | undefined;
  readonly retainScreenSpaceError: number | undefined;
}

const SETTLED_CAMERA_STREAM_HYSTERESIS_EDGE_RATIO = 0.75;

/**
 * Keeps motion hysteresis while making the final settled selection independent
 * of the previously rendered frontier. The settled threshold matches the
 * mixed-depth planner's default 75% retention boundary, so a fast request and a
 * slow chain of retained requests converge to the same quality high-water mark.
 */
export function createCopcCameraStreamMixedDepthThresholds(
  options: CopcCameraStreamMixedDepthThresholdOptions,
): CopcCameraStreamMixedDepthThresholds {
  const targetPointSpacingScreenPixels =
    options.targetPointSpacingScreenPixels;
  if (
    !Number.isFinite(targetPointSpacingScreenPixels) ||
    targetPointSpacingScreenPixels <= 0
  ) {
    throw new Error(
      "targetPointSpacingScreenPixels must be a positive finite number.",
    );
  }

  if (!options.cameraSettled) {
    return {
      refineScreenSpaceError: undefined,
      retainScreenSpaceError: undefined,
    };
  }

  const settledScreenSpaceError =
    targetPointSpacingScreenPixels *
    SETTLED_CAMERA_STREAM_HYSTERESIS_EDGE_RATIO;
  return {
    refineScreenSpaceError: settledScreenSpaceError,
    retainScreenSpaceError: settledScreenSpaceError,
  };
}

/**
 * Limits hierarchy refinement to the deepest complete frontier that the
 * current request can actually render. A screen-space target can be deeper
 * than the resource-bounded selected frontier; chasing that unreachable depth
 * can churn a bounded hierarchy cache without changing the visible frame.
 */
export function resolveCopcCameraStreamHierarchyExpansionDepth(
  configuredMaxDepth: number,
  selectedDepth: number,
): number {
  if (!Number.isSafeInteger(configuredMaxDepth) || configuredMaxDepth < 0) {
    throw new Error("configuredMaxDepth must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(selectedDepth) || selectedDepth < 0) {
    throw new Error("selectedDepth must be a non-negative integer.");
  }

  return Math.min(configuredMaxDepth, selectedDepth);
}

export type CopcCameraStreamZoomRefinementSettings = Pick<
  CopcCameraStreamLodSettings,
  | "cameraHeightMeters"
  | "maxDepth"
  | "targetNodeScreenPixels"
  | "targetPointSpacingScreenPixels"
>;

export interface CopcCameraStreamPrefetchLodSettingsLike {
  readonly maxNodePointCount: number;
  readonly maxRenderedPointCount: number;
  readonly targetPointSpacingScreenPixels: number;
}

export interface CopcCameraStreamPrefetchSettingsOptions {
  readonly baseMaxRenderedPointCount: number;
  readonly basePointCountPerNode: number;
  readonly baseTargetPointSpacingScreenPixels?: number;
  readonly lodSettings: CopcCameraStreamPrefetchLodSettingsLike;
  readonly maxDensityMultiplier?: number;
  readonly maxRenderedPointBudgetRatio?: number;
  readonly minPointCountPerNode?: number;
  readonly minRenderedPointCount?: number;
  readonly nodeCount: number;
}

export interface CopcCameraStreamPrefetchSettings {
  readonly maxPointCountPerNode: number;
  readonly maxRenderedPointCount: number;
}

export interface CopcCameraStreamPrefetchNodeCountOptions {
  readonly baseTargetPointSpacingScreenPixels?: number;
  readonly lodSettings: Pick<
    CopcCameraStreamLodSettings,
    "maxNodes" | "targetPointSpacingScreenPixels"
  >;
  readonly maxDensityMultiplier?: number;
  readonly runtimeSettings: Pick<
    CopcCameraStreamRuntimeSettings,
    "prefetchMaxNodeCount"
  >;
}

export interface CopcCameraStreamRuntimeSettingsOptions {
  readonly backgroundPrefetchDelayMilliseconds?: number;
  readonly backgroundPrefetchMaxConcurrentRequests?: number;
  readonly backgroundPrefetchRequestPriority?: number;
  readonly coldDetailCompletionBudgetFillRatio?: number;
  readonly coldDetailCompletionNodeCoverageRatio?: number;
  readonly coldDetailMaxInitialCoverageRatio?: number;
  readonly detailMaxFinalNodeCount?: number;
  readonly detailMaxActiveNodeRequests?: number;
  readonly detailMinFinalNodeCount?: number;
  readonly detailProgressBatchDivisor?: number;
  readonly detailProgressMaxBatchNodeCount?: number;
  readonly detailProgressMinBatchNodeCount?: number;
  readonly detailTargetPointCountPerNode?: number;
  readonly detailWarmupMaxNodeCount?: number;
  readonly detailWarmupMinInitialCoverageRatio?: number;
  readonly detailWarmupPointCountPerNode?: number;
  readonly fastRendererProgressBatchNodeCount?: number;
  readonly maxReusedBackgroundStreams?: number;
  readonly reusedBackgroundStreamGraceMilliseconds?: number;
  readonly reuseMinExactNodeOverlapRatio?: number;
  readonly moveDebounceMilliseconds?: number;
  readonly pointPrimitiveProgressBatchNodeCount?: number;
  readonly prefetchMaxNodeCount?: number;
  readonly prefetchMaxRenderedPointCount?: number;
  readonly prefetchPointCountPerNode?: number;
  readonly previewCompletionNodeCount?: number;
  readonly previewCompletionPointCount?: number;
  readonly previewMinFinalNodeCount?: number;
  readonly previewMaxNodeCount?: number;
  readonly previewMaxPointDataLength?: number;
  readonly previewMaxRenderedPointCount?: number;
  readonly previewPointCountPerNode?: number;
  readonly retainedNodeSampleLimit?: number;
  readonly reuseMinNodeFamilyOverlapRatio?: number;
}

export interface CopcCameraStreamRuntimeSettings {
  readonly backgroundPrefetchDelayMilliseconds: number;
  readonly backgroundPrefetchMaxConcurrentRequests: number;
  readonly backgroundPrefetchRequestPriority: number;
  readonly coldDetailCompletionBudgetFillRatio: number;
  readonly coldDetailCompletionNodeCoverageRatio: number;
  readonly coldDetailMaxInitialCoverageRatio: number;
  readonly detailMaxFinalNodeCount: number;
  readonly detailMaxActiveNodeRequests: number;
  readonly detailMinFinalNodeCount: number;
  readonly detailProgressBatchDivisor: number;
  readonly detailProgressMaxBatchNodeCount: number;
  readonly detailProgressMinBatchNodeCount: number;
  readonly detailTargetPointCountPerNode: number;
  readonly detailWarmupMaxNodeCount: number;
  readonly detailWarmupMinInitialCoverageRatio: number;
  readonly detailWarmupPointCountPerNode: number;
  readonly fastRendererProgressBatchNodeCount: number;
  readonly maxReusedBackgroundStreams: number;
  readonly reusedBackgroundStreamGraceMilliseconds: number;
  readonly reuseMinExactNodeOverlapRatio: number;
  readonly moveDebounceMilliseconds: number;
  readonly pointPrimitiveProgressBatchNodeCount: number;
  readonly prefetchMaxNodeCount: number;
  readonly prefetchMaxRenderedPointCount: number;
  readonly prefetchPointCountPerNode: number;
  readonly previewCompletionNodeCount: number;
  readonly previewCompletionPointCount: number;
  readonly previewMinFinalNodeCount: number;
  readonly previewMaxNodeCount: number;
  readonly previewMaxPointDataLength: number;
  readonly previewMaxRenderedPointCount: number;
  readonly previewPointCountPerNode: number;
  readonly retainedNodeSampleLimit: number;
  readonly reuseMinNodeFamilyOverlapRatio: number;
}

export interface CopcCameraStreamDetailCompletionSettingsOptions {
  readonly lodSettings: Pick<
    CopcCameraStreamLodSettings,
    "targetPointSpacingScreenPixels"
  >;
  readonly runtimeSettings: Pick<
    CopcCameraStreamRuntimeSettings,
    "coldDetailCompletionBudgetFillRatio" | "coldDetailCompletionNodeCoverageRatio"
  >;
}

export interface CopcCameraStreamDetailCompletionSettings {
  readonly minBudgetFillRatio: number;
  readonly minBudgetCompletionNodeCoverageRatio: number;
  readonly minNodeCoverageRatio: number;
}

export interface CopcCameraStreamPreviewPointCountOptions {
  readonly previewNodeCount: number;
  readonly runtimeSettings: Pick<
    CopcCameraStreamRuntimeSettings,
    | "previewCompletionNodeCount"
    | "previewCompletionPointCount"
    | "previewPointCountPerNode"
  >;
}

const DEFAULT_CAMERA_STREAM_MAX_HIERARCHY_PAGES = 3;
const DEFAULT_BASE_TARGET_POINT_SPACING_SCREEN_PIXELS = 4;
const DEFAULT_MAX_PREFETCH_DENSITY_MULTIPLIER = 4;
const DEFAULT_PREFETCH_RENDERED_POINT_BUDGET_RATIO = 0.35;
const DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS: CopcCameraStreamRuntimeSettings = {
  backgroundPrefetchDelayMilliseconds: 80,
  backgroundPrefetchMaxConcurrentRequests: 4,
  backgroundPrefetchRequestPriority: -1_000,
  coldDetailCompletionBudgetFillRatio: 0.65,
  coldDetailCompletionNodeCoverageRatio: 0.85,
  coldDetailMaxInitialCoverageRatio: 0.2,
  detailMaxFinalNodeCount: 48,
  detailMaxActiveNodeRequests: 6,
  detailMinFinalNodeCount: 8,
  detailProgressBatchDivisor: 16,
  detailProgressMaxBatchNodeCount: 8,
  detailProgressMinBatchNodeCount: 2,
  detailTargetPointCountPerNode: 2_500,
  detailWarmupMaxNodeCount: 64,
  detailWarmupMinInitialCoverageRatio: 0.35,
  detailWarmupPointCountPerNode: 2_000,
  fastRendererProgressBatchNodeCount: 2,
  maxReusedBackgroundStreams: 1,
  reusedBackgroundStreamGraceMilliseconds: 350,
  reuseMinExactNodeOverlapRatio: 0.25,
  moveDebounceMilliseconds: 30,
  pointPrimitiveProgressBatchNodeCount: 4,
  prefetchMaxNodeCount: 24,
  prefetchMaxRenderedPointCount: 120_000,
  prefetchPointCountPerNode: 2_500,
  previewCompletionNodeCount: 4,
  previewCompletionPointCount: 5_500,
  previewMinFinalNodeCount: 5,
  previewMaxNodeCount: 32,
  previewMaxPointDataLength: 256_000,
  previewMaxRenderedPointCount: 64_000,
  previewPointCountPerNode: 8_000,
  retainedNodeSampleLimit: 1_024,
  reuseMinNodeFamilyOverlapRatio: 0.35,
};

const CAMERA_STREAM_LOD_LEVELS = [
  {
    maxCameraHeightMeters: 350,
    label: "near zoom",
    minMaxDepth: 6,
    targetNodeScreenPixels: 48,
    targetPointSpacingScreenPixels: 1.5,
    nodeMultiplier: 3,
    pointBudgetMultiplier: 2,
    nodePointBudgetMultiplier: 1,
    nodePointDataLengthMultiplier: 1,
    maxHierarchyPages: 5,
    detailMaxPointCountPerNode: 6_500,
    detailMinFinalNodeCount: 16,
    detailTargetPointCountPerNode: 1_500,
  },
  {
    maxCameraHeightMeters: 700,
    label: "close zoom",
    minMaxDepth: 5,
    targetNodeScreenPixels: 64,
    targetPointSpacingScreenPixels: 2.25,
    nodeMultiplier: 2,
    pointBudgetMultiplier: 2,
    nodePointBudgetMultiplier: 1,
    nodePointDataLengthMultiplier: 1,
    maxHierarchyPages: 4,
    detailMaxPointCountPerNode: 6_500,
    detailMinFinalNodeCount: 12,
    detailTargetPointCountPerNode: 2_000,
  },
  {
    maxCameraHeightMeters: 1_500,
    label: "medium zoom",
    minMaxDepth: 5,
    targetNodeScreenPixels: 80,
    targetPointSpacingScreenPixels: 3.5,
    nodeMultiplier: 1,
    pointBudgetMultiplier: 2,
    nodePointBudgetMultiplier: 1,
    nodePointDataLengthMultiplier: 1,
    maxHierarchyPages: 4,
    detailMaxPointCountPerNode: 6_000,
    detailMinFinalNodeCount: 8,
    detailTargetPointCountPerNode: 2_500,
  },
  {
    maxCameraHeightMeters: 3_000,
    label: "wide zoom",
    minMaxDepth: 4,
    targetNodeScreenPixels: 110,
    targetPointSpacingScreenPixels: 5,
    nodeMultiplier: 1,
    pointBudgetMultiplier: 1,
    nodePointBudgetMultiplier: 1,
    nodePointDataLengthMultiplier: 1,
    maxHierarchyPages: 3,
    detailMaxPointCountPerNode: 6_000,
    detailMinFinalNodeCount: 6,
    detailTargetPointCountPerNode: 3_500,
  },
] as const;

export function createCopcCameraStreamLodSettings(
  options: CopcCameraStreamLodSettingsOptions,
): CopcCameraStreamLodSettings {
  const cameraHeightMeters = normalizeCameraHeightMeters(
    options.cameraHeightMeters,
  );
  const qualitySettings = options.qualitySettings;
  const maxNodePointCount = qualitySettings.cameraStreamMaxNodePointCount;
  const baseMaxHierarchyPages =
    options.baseMaxHierarchyPages ?? DEFAULT_CAMERA_STREAM_MAX_HIERARCHY_PAGES;
  const lodLevel = CAMERA_STREAM_LOD_LEVELS.find(
    (level) => cameraHeightMeters <= level.maxCameraHeightMeters,
  );

  if (!lodLevel) {
    return {
      label: "overview",
      cameraHeightMeters,
      maxNodes: qualitySettings.cameraStreamMaxNodes,
      maxDepth: qualitySettings.cameraStreamMaxDepth,
      targetNodeScreenPixels: qualitySettings.cameraStreamTargetNodeScreenPixels,
      targetPointSpacingScreenPixels:
        qualitySettings.cameraStreamTargetPointSpacingScreenPixels,
      maxRenderedPointCount:
        qualitySettings.cameraStreamMaxRenderedPointCount,
      maxSourcePointCount: qualitySettings.cameraStreamMaxSourcePointCount,
      maxNodePointCount,
      maxPointDataLength: qualitySettings.cameraStreamMaxPointDataLength,
      maxNodePointDataLength:
        qualitySettings.cameraStreamMaxNodePointDataLength,
      maxHierarchyPages: baseMaxHierarchyPages,
      detailMaxPointCountPerNode: 5_000,
      detailMinFinalNodeCount: 4,
      detailTargetPointCountPerNode: 5_000,
    };
  }

  return {
    label: lodLevel.label,
    cameraHeightMeters,
    maxNodes: Math.max(
      qualitySettings.cameraStreamMaxNodes,
      Math.ceil(qualitySettings.cameraStreamMaxNodes * lodLevel.nodeMultiplier),
    ),
    maxDepth: Math.max(
      qualitySettings.cameraStreamMaxDepth,
      lodLevel.minMaxDepth,
    ),
    targetNodeScreenPixels: Math.min(
      qualitySettings.cameraStreamTargetNodeScreenPixels,
      lodLevel.targetNodeScreenPixels,
    ),
    targetPointSpacingScreenPixels: Math.min(
      qualitySettings.cameraStreamTargetPointSpacingScreenPixels,
      lodLevel.targetPointSpacingScreenPixels,
    ),
    maxRenderedPointCount: Math.max(
      qualitySettings.cameraStreamMaxRenderedPointCount,
      Math.ceil(
        qualitySettings.cameraStreamMaxRenderedPointCount *
          lodLevel.pointBudgetMultiplier,
      ),
    ),
    maxSourcePointCount: Math.max(
      qualitySettings.cameraStreamMaxSourcePointCount,
      Math.ceil(
        qualitySettings.cameraStreamMaxSourcePointCount *
          lodLevel.pointBudgetMultiplier,
      ),
    ),
    maxNodePointCount: Math.max(
      1,
      Math.floor(maxNodePointCount * lodLevel.nodePointBudgetMultiplier),
    ),
    maxPointDataLength: Math.max(
      qualitySettings.cameraStreamMaxPointDataLength,
      Math.ceil(
        qualitySettings.cameraStreamMaxPointDataLength *
          lodLevel.pointBudgetMultiplier,
      ),
    ),
    maxNodePointDataLength: Math.max(
      1,
      Math.floor(
        qualitySettings.cameraStreamMaxNodePointDataLength *
          lodLevel.nodePointDataLengthMultiplier,
      ),
    ),
    maxHierarchyPages: Math.max(
      baseMaxHierarchyPages,
      lodLevel.maxHierarchyPages,
    ),
    detailMaxPointCountPerNode: Math.max(
      lodLevel.detailTargetPointCountPerNode,
      lodLevel.detailMaxPointCountPerNode,
    ),
    detailMinFinalNodeCount: lodLevel.detailMinFinalNodeCount,
    detailTargetPointCountPerNode: lodLevel.detailTargetPointCountPerNode,
  };
}

export function isCopcCameraStreamZoomRefinement(
  previous: CopcCameraStreamZoomRefinementSettings | undefined,
  next: CopcCameraStreamZoomRefinementSettings,
): boolean {
  if (!previous) {
    return false;
  }

  const hasStricterLodTarget =
    next.maxDepth > previous.maxDepth ||
    next.targetNodeScreenPixels < previous.targetNodeScreenPixels ||
    next.targetPointSpacingScreenPixels <
      previous.targetPointSpacingScreenPixels;
  const isSignificantlyCloser =
    Number.isFinite(next.cameraHeightMeters) &&
    (!Number.isFinite(previous.cameraHeightMeters) ||
      next.cameraHeightMeters < previous.cameraHeightMeters * 0.9);

  return hasStricterLodTarget || isSignificantlyCloser;
}

export function createCopcCameraStreamPrefetchSettings(
  options: CopcCameraStreamPrefetchSettingsOptions,
): CopcCameraStreamPrefetchSettings {
  const nodeCount = normalizeNonNegativeInteger(options.nodeCount);

  if (nodeCount === 0) {
    return {
      maxPointCountPerNode: 0,
      maxRenderedPointCount: 0,
    };
  }

  const densityMultiplier = createCameraStreamPrefetchDensityMultiplier(
    options,
  );
  const maxNodePointCount = normalizePositiveInteger(
    options.lodSettings.maxNodePointCount,
  );
  const maxPointCountPerNode = Math.min(
    maxNodePointCount,
    Math.max(
      normalizePositiveInteger(options.basePointCountPerNode) *
        densityMultiplier,
      normalizeOptionalPositiveInteger(options.minPointCountPerNode) ?? 1,
    ),
  );
  const baseMaxRenderedPointCount = normalizePositiveInteger(
    options.baseMaxRenderedPointCount,
  );
  const lodRenderedBudget = normalizePositiveInteger(
    options.lodSettings.maxRenderedPointCount,
  );
  const renderedBudgetRatio =
    options.maxRenderedPointBudgetRatio ??
    DEFAULT_PREFETCH_RENDERED_POINT_BUDGET_RATIO;
  const maxRenderedPointBudget = Math.max(
    nodeCount,
    Math.floor(lodRenderedBudget * Math.max(0, renderedBudgetRatio)),
  );
  const minRenderedPointCount = Math.min(
    nodeCount * maxPointCountPerNode,
    normalizeOptionalPositiveInteger(options.minRenderedPointCount) ?? 0,
  );

  return {
    maxPointCountPerNode,
    maxRenderedPointCount: Math.max(
      nodeCount,
      minRenderedPointCount,
      Math.min(
        nodeCount * maxPointCountPerNode,
        baseMaxRenderedPointCount * densityMultiplier,
        maxRenderedPointBudget,
      ),
    ),
  };
}

export function createCopcCameraStreamPrefetchNodeCount(
  options: CopcCameraStreamPrefetchNodeCountOptions,
): number {
  const baseNodeCount = normalizePositiveIntegerOption(
    options.runtimeSettings.prefetchMaxNodeCount,
    DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.prefetchMaxNodeCount,
  );
  const maxNodes = normalizePositiveIntegerOption(
    options.lodSettings.maxNodes,
    baseNodeCount,
  );
  const targetPointSpacingScreenPixels = normalizePositiveNumberOption(
    options.lodSettings.targetPointSpacingScreenPixels,
    DEFAULT_BASE_TARGET_POINT_SPACING_SCREEN_PIXELS,
  );
  const baseTargetPointSpacingScreenPixels = normalizePositiveNumberOption(
    options.baseTargetPointSpacingScreenPixels,
    DEFAULT_BASE_TARGET_POINT_SPACING_SCREEN_PIXELS,
  );
  const maxDensityMultiplier = normalizePositiveIntegerOption(
    options.maxDensityMultiplier,
    3,
  );
  const densityMultiplier = Math.min(
    maxDensityMultiplier,
    Math.max(
      1,
      Math.ceil(
        baseTargetPointSpacingScreenPixels /
          targetPointSpacingScreenPixels,
      ),
    ),
  );

  return Math.min(maxNodes, baseNodeCount * densityMultiplier);
}

export function createCopcCameraStreamDetailCompletionSettings(
  options: CopcCameraStreamDetailCompletionSettingsOptions,
): CopcCameraStreamDetailCompletionSettings {
  const targetPointSpacingScreenPixels = normalizePositiveNumberOption(
    options.lodSettings.targetPointSpacingScreenPixels,
    DEFAULT_BASE_TARGET_POINT_SPACING_SCREEN_PIXELS,
  );
  const runtimeNodeCoverageRatio = normalizePositiveRatio(
    options.runtimeSettings.coldDetailCompletionNodeCoverageRatio,
    DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.coldDetailCompletionNodeCoverageRatio,
  );
  const minNodeCoverageRatio = Math.max(
    runtimeNodeCoverageRatio,
    estimateDetailCompletionNodeCoverageRatio(targetPointSpacingScreenPixels),
  );

  return {
    minBudgetFillRatio: normalizePositiveRatio(
      options.runtimeSettings.coldDetailCompletionBudgetFillRatio,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.coldDetailCompletionBudgetFillRatio,
    ),
    minBudgetCompletionNodeCoverageRatio: minNodeCoverageRatio,
    minNodeCoverageRatio,
  };
}

export function createCopcCameraStreamRuntimeSettings(
  options: CopcCameraStreamRuntimeSettingsOptions = {},
): CopcCameraStreamRuntimeSettings {
  return {
    backgroundPrefetchDelayMilliseconds: normalizeNonNegativeNumberOption(
      options.backgroundPrefetchDelayMilliseconds,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.backgroundPrefetchDelayMilliseconds,
    ),
    backgroundPrefetchMaxConcurrentRequests: normalizePositiveIntegerOption(
      options.backgroundPrefetchMaxConcurrentRequests,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.backgroundPrefetchMaxConcurrentRequests,
    ),
    backgroundPrefetchRequestPriority: normalizeFiniteNumberOption(
      options.backgroundPrefetchRequestPriority,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.backgroundPrefetchRequestPriority,
    ),
    coldDetailCompletionBudgetFillRatio: normalizePositiveRatio(
      options.coldDetailCompletionBudgetFillRatio,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.coldDetailCompletionBudgetFillRatio,
    ),
    coldDetailCompletionNodeCoverageRatio: normalizePositiveRatio(
      options.coldDetailCompletionNodeCoverageRatio,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.coldDetailCompletionNodeCoverageRatio,
    ),
    coldDetailMaxInitialCoverageRatio: normalizeNonNegativeRatio(
      options.coldDetailMaxInitialCoverageRatio,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.coldDetailMaxInitialCoverageRatio,
    ),
    detailMaxFinalNodeCount: normalizePositiveIntegerOption(
      options.detailMaxFinalNodeCount,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.detailMaxFinalNodeCount,
    ),
    detailMaxActiveNodeRequests: normalizePositiveIntegerOption(
      options.detailMaxActiveNodeRequests,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.detailMaxActiveNodeRequests,
    ),
    detailMinFinalNodeCount: normalizePositiveIntegerOption(
      options.detailMinFinalNodeCount,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.detailMinFinalNodeCount,
    ),
    detailProgressBatchDivisor: normalizePositiveIntegerOption(
      options.detailProgressBatchDivisor,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.detailProgressBatchDivisor,
    ),
    detailProgressMaxBatchNodeCount: normalizePositiveIntegerOption(
      options.detailProgressMaxBatchNodeCount,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.detailProgressMaxBatchNodeCount,
    ),
    detailProgressMinBatchNodeCount: normalizePositiveIntegerOption(
      options.detailProgressMinBatchNodeCount,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.detailProgressMinBatchNodeCount,
    ),
    detailTargetPointCountPerNode: normalizePositiveIntegerOption(
      options.detailTargetPointCountPerNode,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.detailTargetPointCountPerNode,
    ),
    detailWarmupMaxNodeCount: normalizePositiveIntegerOption(
      options.detailWarmupMaxNodeCount,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.detailWarmupMaxNodeCount,
    ),
    detailWarmupMinInitialCoverageRatio: normalizeNonNegativeRatio(
      options.detailWarmupMinInitialCoverageRatio,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.detailWarmupMinInitialCoverageRatio,
    ),
    detailWarmupPointCountPerNode: normalizePositiveIntegerOption(
      options.detailWarmupPointCountPerNode,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.detailWarmupPointCountPerNode,
    ),
    fastRendererProgressBatchNodeCount: normalizePositiveIntegerOption(
      options.fastRendererProgressBatchNodeCount,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.fastRendererProgressBatchNodeCount,
    ),
    maxReusedBackgroundStreams: normalizeNonNegativeIntegerOption(
      options.maxReusedBackgroundStreams,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.maxReusedBackgroundStreams,
    ),
    reusedBackgroundStreamGraceMilliseconds: normalizeNonNegativeNumberOption(
      options.reusedBackgroundStreamGraceMilliseconds,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS
        .reusedBackgroundStreamGraceMilliseconds,
    ),
    reuseMinExactNodeOverlapRatio: normalizeNonNegativeRatio(
      options.reuseMinExactNodeOverlapRatio,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.reuseMinExactNodeOverlapRatio,
    ),
    moveDebounceMilliseconds: normalizeNonNegativeNumberOption(
      options.moveDebounceMilliseconds,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.moveDebounceMilliseconds,
    ),
    pointPrimitiveProgressBatchNodeCount: normalizePositiveIntegerOption(
      options.pointPrimitiveProgressBatchNodeCount,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.pointPrimitiveProgressBatchNodeCount,
    ),
    prefetchMaxNodeCount: normalizePositiveIntegerOption(
      options.prefetchMaxNodeCount,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.prefetchMaxNodeCount,
    ),
    prefetchMaxRenderedPointCount: normalizePositiveIntegerOption(
      options.prefetchMaxRenderedPointCount,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.prefetchMaxRenderedPointCount,
    ),
    prefetchPointCountPerNode: normalizePositiveIntegerOption(
      options.prefetchPointCountPerNode,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.prefetchPointCountPerNode,
    ),
    previewCompletionNodeCount: normalizePositiveIntegerOption(
      options.previewCompletionNodeCount,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.previewCompletionNodeCount,
    ),
    previewCompletionPointCount: normalizePositiveIntegerOption(
      options.previewCompletionPointCount,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.previewCompletionPointCount,
    ),
    previewMinFinalNodeCount: normalizePositiveIntegerOption(
      options.previewMinFinalNodeCount,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.previewMinFinalNodeCount,
    ),
    previewMaxNodeCount: normalizePositiveIntegerOption(
      options.previewMaxNodeCount,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.previewMaxNodeCount,
    ),
    previewMaxPointDataLength: normalizePositiveIntegerOption(
      options.previewMaxPointDataLength,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.previewMaxPointDataLength,
    ),
    previewMaxRenderedPointCount: normalizePositiveIntegerOption(
      options.previewMaxRenderedPointCount,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.previewMaxRenderedPointCount,
    ),
    previewPointCountPerNode: normalizePositiveIntegerOption(
      options.previewPointCountPerNode,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.previewPointCountPerNode,
    ),
    retainedNodeSampleLimit: normalizePositiveIntegerOption(
      options.retainedNodeSampleLimit,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.retainedNodeSampleLimit,
    ),
    reuseMinNodeFamilyOverlapRatio: normalizeNonNegativeRatio(
      options.reuseMinNodeFamilyOverlapRatio,
      DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.reuseMinNodeFamilyOverlapRatio,
    ),
  };
}

export function createCopcCameraStreamPreviewPointCountPerNode(
  options: CopcCameraStreamPreviewPointCountOptions,
): number {
  const previewNodeCount = normalizePositiveIntegerOption(
    options.previewNodeCount,
    1,
  );
  const targetNodeCount = Math.min(
    previewNodeCount,
    options.runtimeSettings.previewCompletionNodeCount,
  );

  return Math.min(
    options.runtimeSettings.previewPointCountPerNode,
    Math.max(
      1,
      Math.ceil(
        options.runtimeSettings.previewCompletionPointCount / targetNodeCount,
      ),
    ),
  );
}

function createCameraStreamPrefetchDensityMultiplier(
  options: CopcCameraStreamPrefetchSettingsOptions,
): number {
  const baseTargetPointSpacingScreenPixels =
    options.baseTargetPointSpacingScreenPixels ??
    DEFAULT_BASE_TARGET_POINT_SPACING_SCREEN_PIXELS;
  const targetPointSpacingScreenPixels =
    options.lodSettings.targetPointSpacingScreenPixels;

  if (
    !Number.isFinite(baseTargetPointSpacingScreenPixels) ||
    !Number.isFinite(targetPointSpacingScreenPixels) ||
    baseTargetPointSpacingScreenPixels <= 0 ||
    targetPointSpacingScreenPixels <= 0
  ) {
    return 1;
  }

  return Math.max(
    1,
    Math.min(
      options.maxDensityMultiplier ??
        DEFAULT_MAX_PREFETCH_DENSITY_MULTIPLIER,
      Math.round(
        baseTargetPointSpacingScreenPixels / targetPointSpacingScreenPixels,
      ),
    ),
  );
}

function normalizeCameraHeightMeters(cameraHeightMeters: number): number {
  return Number.isFinite(cameraHeightMeters)
    ? Math.max(0, cameraHeightMeters)
    : Number.POSITIVE_INFINITY;
}

function normalizePositiveInteger(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function normalizeOptionalPositiveInteger(
  value: number | undefined,
): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function normalizePositiveIntegerOption(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function normalizeNonNegativeIntegerOption(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function normalizeFiniteNumberOption(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function normalizePositiveNumberOption(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function normalizeNonNegativeNumberOption(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function normalizePositiveRatio(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(1, value)
    : fallback;
}

function estimateDetailCompletionNodeCoverageRatio(
  targetPointSpacingScreenPixels: number,
): number {
  if (targetPointSpacingScreenPixels <= 1.5) {
    return 0.95;
  }

  if (targetPointSpacingScreenPixels <= 2.25) {
    return 0.9;
  }

  if (targetPointSpacingScreenPixels <= 3.5) {
    return 0.9;
  }

  return DEFAULT_CAMERA_STREAM_RUNTIME_SETTINGS.coldDetailCompletionNodeCoverageRatio;
}

function normalizeNonNegativeRatio(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(1, value)
    : fallback;
}
