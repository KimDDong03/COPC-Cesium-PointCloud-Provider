import type {
  CopcHierarchyNodeCameraSelection,
  CopcHierarchySummary,
} from "../core";
import type {
  CopcCameraStreamDetailProgressState,
  CopcCameraStreamFinalNodeWeight,
  CopcCameraStreamRendererKind,
} from "./CopcCameraStreamProgress";
import {
  createCopcCameraStreamRenderPlan,
  type CopcCameraStreamRenderPlan,
} from "./CopcCameraStreamRenderPlan";
import {
  createCopcCameraStreamRuntimeSettings,
  resolveCopcCameraStreamHierarchyExpansionDepth,
  type CopcCameraStreamLodSettings,
  type CopcCameraStreamRuntimeSettings,
} from "./CopcCameraStreamSettings";
import {
  runCopcCameraStreamTerminalRender,
} from "./CopcCameraStreamTerminalRender";
import {
  withCopcCameraStreamHierarchyQuality,
  type CopcCameraStreamVisualQualityState,
} from "./CopcCameraStreamVisualQuality";
import type {
  CopcPointCloudLayer,
  CopcPointCloudLayerAutomaticRenderResult,
  CopcPointCloudLayerHierarchyExpansionResult,
  CopcPointCloudLayerProgressiveRenderCandidate,
  CopcPointCloudLayerProgressiveAutomaticRenderOptions,
} from "./CopcPointCloudLayer";

/**
 * Internal layer capability used by the authoritative terminal camera-view
 * pipeline. It stays out of the package barrel until the pre-1.0 controller
 * contract is ready to be stabilized.
 */
export type CopcCameraStreamEngineLayer = Pick<
  CopcPointCloudLayer,
  | "expandHierarchyForCamera"
  | "renderNodesProgressively"
  | "selectNodesForCamera"
> & {
  readonly hierarchy: CopcHierarchySummary | undefined;
};

export type CopcCameraStreamEngineStage =
  | "preview"
  | "refining"
  | "interactive-ready"
  | "terminal";

export interface CopcCameraStreamEngineUpdate {
  readonly stage: Exclude<CopcCameraStreamEngineStage, "preview">;
  readonly result: CopcPointCloudLayerAutomaticRenderResult;
  readonly detailProgress: CopcCameraStreamDetailProgressState;
  readonly visualQuality: CopcCameraStreamVisualQualityState;
}

export interface CopcCameraStreamPreparedView {
  readonly cameraSelection: CopcHierarchyNodeCameraSelection;
  readonly finalNodeWeights: readonly CopcCameraStreamFinalNodeWeight[];
  readonly hierarchyExpansion:
    | CopcPointCloudLayerHierarchyExpansionResult
    | undefined;
  readonly pendingRelevantHierarchyPageCount: number;
  readonly pendingRelevantHierarchyPageSignature: string | undefined;
  readonly isHierarchyCompleteForView: boolean;
  readonly renderPlan: CopcCameraStreamRenderPlan;
}

export interface CopcCameraStreamEngineResult
  extends CopcCameraStreamPreparedView {
  readonly result: CopcPointCloudLayerAutomaticRenderResult;
  readonly detailProgress: CopcCameraStreamDetailProgressState;
  readonly visualQuality: CopcCameraStreamVisualQualityState;
}

export interface CopcCameraStreamEngineOptions {
  readonly layer: CopcCameraStreamEngineLayer;
  readonly lodSettings: CopcCameraStreamLodSettings;
  readonly renderOptions: CopcPointCloudLayerProgressiveAutomaticRenderOptions;
  readonly runtimeSettings?: CopcCameraStreamRuntimeSettings;
  readonly rendererKind?: CopcCameraStreamRendererKind;
  readonly shouldPublish?: () => boolean;
  readonly shouldRenderProgress?: (
    candidate: CopcPointCloudLayerProgressiveRenderCandidate,
    prepared: CopcCameraStreamPreparedView,
  ) => boolean;
  readonly onProgressCommitted?: () => void;
  readonly onUpdate?: (update: CopcCameraStreamEngineUpdate) => void;
}

export function isCopcCameraStreamEngineLayer(
  layer: unknown,
): layer is CopcCameraStreamEngineLayer {
  if (typeof layer !== "object" || layer === null) {
    return false;
  }

  const candidate = layer as Partial<CopcCameraStreamEngineLayer>;

  return (
    typeof candidate.expandHierarchyForCamera === "function" &&
    typeof candidate.renderNodesProgressively === "function" &&
    typeof candidate.selectNodesForCamera === "function"
  );
}

/**
 * Returns false when a caller deliberately selected a low-level progressive
 * behavior whose completion semantics must remain owned by the legacy
 * `renderAutomaticProgressively()` adapter.
 */
export function supportsCopcCameraStreamEngineOptions(
  options: Partial<CopcPointCloudLayerProgressiveAutomaticRenderOptions>,
): boolean {
  const coverageMode = options.coverageMode ?? "complete-depth";

  return (
    (coverageMode === "complete-depth" || coverageMode === "mixed-depth") &&
    options.includeAncestorNodes !== false &&
    options.includePointsInResult !== true &&
    options.showBounds !== true &&
    options.continueLoadingAfterStop === undefined &&
    options.nodeRenderOrder === undefined &&
    options.nodeRequestOrder === undefined &&
    options.postStopLoadingMode === undefined &&
    options.postStopProgressMode === undefined &&
    options.progressBatchNodeCount === undefined &&
    options.progressRenderMode === undefined &&
    options.shouldStopAfterProgress === undefined
  );
}

export async function prepareCopcCameraStreamView(
  options: CopcCameraStreamEngineOptions,
): Promise<CopcCameraStreamPreparedView | undefined> {
  const { layer, lodSettings, renderOptions } = options;
  const { signal } = renderOptions;
  signal?.throwIfAborted();

  const cameraSelectionOptions = createCameraSelectionOptions(renderOptions);
  let cameraSelection = await layer.selectNodesForCamera(
    cameraSelectionOptions,
  );
  signal?.throwIfAborted();

  if (!cameraSelection || cameraSelection.nodes.length === 0) {
    return undefined;
  }

  const configuredHierarchyDepth =
    renderOptions.maxHierarchyPageDepth ?? lodSettings.maxDepth;
  const targetHierarchyDepth =
    resolveCopcCameraStreamHierarchyExpansionDepth(
      configuredHierarchyDepth,
      cameraSelection.selectedDepth,
    );
  const shouldExpandHierarchy = renderOptions.expandHierarchy ?? true;
  const hierarchyExpansion = shouldExpandHierarchy
    ? await layer.expandHierarchyForCamera({
        camera: renderOptions.camera,
        viewportWidthPixels: renderOptions.viewportWidthPixels,
        viewportHeightPixels: renderOptions.viewportHeightPixels,
        maxPages:
          renderOptions.maxHierarchyPages ?? lodSettings.maxHierarchyPages,
        maxDepth: targetHierarchyDepth,
        signal,
      })
    : undefined;
  signal?.throwIfAborted();

  if (hierarchyExpansion) {
    cameraSelection = await layer.selectNodesForCamera(cameraSelectionOptions);
    signal?.throwIfAborted();

    if (!cameraSelection || cameraSelection.nodes.length === 0) {
      return undefined;
    }
  }

  const hierarchyDepthAdvanced =
    hierarchyExpansion !== undefined &&
    cameraSelection.selectedDepth > targetHierarchyDepth;
  const pendingRelevantHierarchyPageCount = hierarchyDepthAdvanced
    ? Math.max(
        1,
        hierarchyExpansion?.pendingRelevantHierarchyPageCount ?? 0,
      )
    : hierarchyExpansion?.pendingRelevantHierarchyPageCount ?? 0;
  const pendingRelevantHierarchyPageSignature = hierarchyDepthAdvanced
    ? `depth-advanced:${targetHierarchyDepth}->${cameraSelection.selectedDepth}`
    : hierarchyExpansion?.pendingRelevantHierarchyPageSignature;
  const isHierarchyCompleteForView =
    shouldExpandHierarchy &&
    !hierarchyDepthAdvanced &&
    (hierarchyExpansion?.isHierarchyCompleteForView ?? true);

  const runtimeSettings =
    options.runtimeSettings ?? createCopcCameraStreamRuntimeSettings();
  const renderedPointBudget = readPositiveInteger(
    renderOptions.maxRenderedPointCount,
    lodSettings.maxRenderedPointCount,
  );
  const activeHierarchy = hierarchyExpansion?.hierarchy ?? layer.hierarchy;
  const renderPlan = createCopcCameraStreamRenderPlan({
    cameraSelection,
    configuredMaxPointCountPerNode: readPositiveInteger(
      renderOptions.maxPointCountPerNode,
      lodSettings.detailMaxPointCountPerNode,
    ),
    effectiveNodePointDataLengthBudget: readPositiveInteger(
      renderOptions.maxNodePointDataLength,
      lodSettings.maxNodePointDataLength,
    ),
    effectivePointDataLengthBudget: readPositiveInteger(
      renderOptions.maxTotalPointDataLength,
      lodSettings.maxPointDataLength,
    ),
    effectiveSourcePointBudget: readPositiveInteger(
      renderOptions.maxTotalPointCount,
      lodSettings.maxSourcePointCount,
    ),
    hierarchy: activeHierarchy,
    lodSettings,
    maxFinalNodeCount: runtimeSettings.detailMaxFinalNodeCount,
    minFinalNodeCount: lodSettings.detailMinFinalNodeCount,
    minPointCountPerFinalNode: lodSettings.detailTargetPointCountPerNode,
    maxPointCountPerFinalNode: lodSettings.detailMaxPointCountPerNode,
    previewMinFinalNodeCount: runtimeSettings.previewMinFinalNodeCount,
    previewMaxNodeCount: runtimeSettings.previewMaxNodeCount,
    previewMaxPointDataLength: runtimeSettings.previewMaxPointDataLength,
    renderedPointBudget,
  });

  if (renderPlan.finalNodeKeys.length === 0) {
    return undefined;
  }

  const sourcePointCountByNodeKey = new Map(
    activeHierarchy?.nodes.map((node) => [node.key, node.pointCount]) ?? [],
  );
  const finalNodeWeights = renderPlan.finalNodeKeys.map((nodeKey) => ({
    nodeKey,
    weight: normalizePointCountWeight(sourcePointCountByNodeKey.get(nodeKey)),
  }));

  return {
    cameraSelection,
    finalNodeWeights,
    hierarchyExpansion,
    pendingRelevantHierarchyPageCount,
    pendingRelevantHierarchyPageSignature,
    isHierarchyCompleteForView,
    renderPlan,
  };
}

/** Runs one camera snapshot through the shared exact-terminal pipeline. */
export async function runCopcCameraStreamEngine(
  options: CopcCameraStreamEngineOptions,
): Promise<CopcCameraStreamEngineResult | undefined> {
  const prepared = await prepareCopcCameraStreamView(options);

  if (!prepared) {
    return undefined;
  }

  const runtimeSettings =
    options.runtimeSettings ?? createCopcCameraStreamRuntimeSettings();
  const { renderOptions } = options;
  const terminal = await runCopcCameraStreamTerminalRender({
    layer: options.layer,
    frontierNodeKeys: prepared.renderPlan.selectedNodeKeys,
    requiredNodeKeys: prepared.renderPlan.finalNodeKeys,
    terminalFrontierMode:
      prepared.cameraSelection.coverageMode === "mixed-depth"
        ? "mixed-depth-antichain"
        : "same-depth",
    finalNodeWeights: prepared.finalNodeWeights,
    initialNodeResults: renderOptions.initialNodeResults,
    backgroundNodeResults: renderOptions.backgroundNodeResults,
    renderedPointBudget: prepared.renderPlan.renderedPointBudget,
    maxPointCountPerNode: prepared.renderPlan.maxPointCountPerNode,
    useSourcePointBudgetHeadroom:
      prepared.renderPlan.useSourcePointBudgetHeadroom,
    maxActiveNodeRequests:
      renderOptions.maxActiveProgressiveNodeRequests ??
      runtimeSettings.detailMaxActiveNodeRequests,
    rendererKind: options.rendererKind ?? "typed",
    lodSettings: options.lodSettings,
    runtimeSettings,
    requestPriority: renderOptions.requestPriority,
    skipInitialProgressRender: renderOptions.skipInitialProgressRender,
    shouldRenderProgress: options.shouldRenderProgress
      ? (candidate) => options.shouldRenderProgress!(candidate, prepared)
      : undefined,
    signal: renderOptions.signal,
    shouldPublish: options.shouldPublish,
    onProgressCommitted: options.onProgressCommitted,
    onUpdate: (update) => {
      const visualQuality = withCopcCameraStreamHierarchyQuality(
        update.visualQuality,
        prepared.pendingRelevantHierarchyPageCount,
        renderOptions.expandHierarchy !== false,
      );
      options.onUpdate?.({
        stage:
          update.stage === "terminal" && !visualQuality.isTerminalReady
            ? "interactive-ready"
            : update.stage,
        result: createAutomaticRenderResult(update.result, prepared),
        detailProgress: update.detailProgress,
        visualQuality,
      });
    },
  });
  const visualQuality = withCopcCameraStreamHierarchyQuality(
    terminal.visualQuality,
    prepared.pendingRelevantHierarchyPageCount,
    renderOptions.expandHierarchy !== false,
  );

  return {
    ...prepared,
    result: createAutomaticRenderResult(terminal.result, prepared),
    detailProgress: terminal.detailProgress,
    visualQuality,
  };
}

function createCameraSelectionOptions(
  options: CopcPointCloudLayerProgressiveAutomaticRenderOptions,
): Parameters<CopcCameraStreamEngineLayer["selectNodesForCamera"]>[0] {
  return {
    camera: options.camera,
    viewportWidthPixels: options.viewportWidthPixels,
    viewportHeightPixels: options.viewportHeightPixels,
    selectionMode: options.selectionMode,
    coverageMode: options.coverageMode,
    maxNodes: options.maxNodes,
    minDepth: options.minDepth,
    maxDepth: options.maxDepth,
    maxNodePointCount: options.maxNodePointCount,
    maxNodePointDataLength: options.maxNodePointDataLength,
    maxTotalPointCount: options.maxTotalPointCount,
    maxTotalPointDataLength: options.maxTotalPointDataLength,
    targetNodeScreenPixels: options.targetNodeScreenPixels,
    maxViewAngleDegrees: options.maxViewAngleDegrees,
    spacing: options.spacing,
    targetPointSpacingScreenPixels:
      options.targetPointSpacingScreenPixels,
    previousFrontierKeys: options.previousFrontierKeys,
    refineScreenSpaceError: options.refineScreenSpaceError,
    retainScreenSpaceError: options.retainScreenSpaceError,
    signal: options.signal,
  };
}

function createAutomaticRenderResult(
  result: Omit<
    CopcPointCloudLayerAutomaticRenderResult,
    "cameraSelection" | "hierarchyExpansion"
  >,
  prepared: CopcCameraStreamPreparedView,
): CopcPointCloudLayerAutomaticRenderResult {
  return {
    ...result,
    cameraSelection: prepared.cameraSelection,
    hierarchyExpansion: prepared.hierarchyExpansion,
  };
}

function readPositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function normalizePointCountWeight(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 1;
}
