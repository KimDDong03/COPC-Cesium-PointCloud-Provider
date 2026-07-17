import type { CopcNodePointSampleResult } from "../core";
import {
  createCopcCameraStreamDetailProgressState,
  selectCopcCameraStreamDetailProgressPolicy,
  type CopcCameraStreamDetailProgressState,
  type CopcCameraStreamFinalNodeWeight,
  type CopcCameraStreamRendererKind,
} from "./CopcCameraStreamProgress";
import {
  createCopcCameraStreamDetailCompletionSettings,
  createCopcCameraStreamRuntimeSettings,
  type CopcCameraStreamLodSettings,
  type CopcCameraStreamRuntimeSettings,
} from "./CopcCameraStreamSettings";
import {
  createCopcCameraStreamVisualQualityState,
  type CopcCameraStreamTerminalFrontierMode,
  type CopcCameraStreamVisualQualityState,
} from "./CopcCameraStreamVisualQuality";
import type {
  CopcPointCloudLayer,
  CopcPointCloudLayerNodesRenderResult,
  CopcPointCloudLayerProgressiveRenderCandidate,
  CopcPointCloudLayerProgressiveRenderMode,
} from "./CopcPointCloudLayer";

export type CopcCameraStreamTerminalRenderLayer = Pick<
  CopcPointCloudLayer,
  "renderNodesProgressively"
>;

export type CopcCameraStreamTerminalRenderStage =
  "refining" | "interactive-ready" | "terminal";

export interface CopcCameraStreamTerminalRenderUpdate {
  readonly stage: CopcCameraStreamTerminalRenderStage;
  readonly result: CopcPointCloudLayerNodesRenderResult;
  readonly detailProgress: CopcCameraStreamDetailProgressState;
  readonly visualQuality: CopcCameraStreamVisualQualityState;
  readonly becameInteractiveReady: boolean;
}

export type CopcCameraStreamTerminalVisualQualityState = Omit<
  CopcCameraStreamVisualQualityState,
  "isTerminalReady"
> & {
  readonly isTerminalReady: true;
};

export interface CopcCameraStreamTerminalRenderResult {
  readonly result: CopcPointCloudLayerNodesRenderResult;
  readonly detailProgress: CopcCameraStreamDetailProgressState;
  readonly visualQuality: CopcCameraStreamTerminalVisualQualityState;
}

export interface CopcCameraStreamTerminalRenderOptions {
  readonly layer: CopcCameraStreamTerminalRenderLayer;
  /** Leaf/frontier nodes selected for the current camera view. */
  readonly frontierNodeKeys: readonly string[];
  /** Complete additive node set that must be present in the terminal render. */
  readonly requiredNodeKeys: readonly string[];
  /** Defaults to the existing same-depth terminal frontier contract. */
  readonly terminalFrontierMode?: CopcCameraStreamTerminalFrontierMode;
  readonly finalNodeWeights?: readonly CopcCameraStreamFinalNodeWeight[];
  readonly initialNodeResults?: readonly CopcNodePointSampleResult[];
  readonly backgroundNodeResults?: readonly CopcNodePointSampleResult[];
  readonly renderedPointBudget: number;
  readonly maxPointCountPerNode: number;
  readonly useSourcePointBudgetHeadroom?: boolean;
  readonly maxActiveNodeRequests?: number;
  readonly rendererKind: CopcCameraStreamRendererKind;
  readonly lodSettings: Pick<
    CopcCameraStreamLodSettings,
    "targetPointSpacingScreenPixels"
  >;
  readonly runtimeSettings?: CopcCameraStreamRuntimeSettings;
  readonly requestPriority?: number;
  readonly skipInitialProgressRender?: boolean;
  /**
   * Controls renderer commits while terminal geometry is still loading.
   * Typed geometry defaults to `final-only` so the retained preview remains
   * stable and the full point budget is uploaded exactly once. Other renderer
   * kinds retain the adaptive progress-policy default.
   */
  readonly progressRenderMode?: CopcPointCloudLayerProgressiveRenderMode;
  readonly shouldRenderProgress?: (
    candidate: CopcPointCloudLayerProgressiveRenderCandidate,
  ) => boolean;
  readonly signal?: AbortSignal;
  /**
   * Controls publication only. Returning false must not cancel or take
   * ownership of a retained overlapping request.
   */
  readonly shouldPublish?: () => boolean;
  /** Called after an accepted progressive frame has mutated the renderer. */
  readonly onProgressCommitted?: () => void;
  readonly onUpdate?: (update: CopcCameraStreamTerminalRenderUpdate) => void;
}

export class CopcCameraStreamTerminalRenderError extends Error {
  readonly code = "COPC_CAMERA_STREAM_NON_TERMINAL" as const;
  readonly result: CopcPointCloudLayerNodesRenderResult;
  readonly visualQuality: CopcCameraStreamVisualQualityState;
  readonly missingRequiredNodeKeys: readonly string[];
  readonly unexpectedRenderedNodeKeys: readonly string[];

  constructor(options: {
    readonly result: CopcPointCloudLayerNodesRenderResult;
    readonly requiredNodeKeys: readonly string[];
    readonly visualQuality: CopcCameraStreamVisualQualityState;
  }) {
    const renderedNodeKeySet = new Set(options.result.pointSamples.nodeKeys);
    const requiredNodeKeySet = new Set(options.requiredNodeKeys);
    const missingRequiredNodeKeys = uniqueNodeKeys(
      options.requiredNodeKeys,
    ).filter((nodeKey) => !renderedNodeKeySet.has(nodeKey));
    const unexpectedRenderedNodeKeys = uniqueNodeKeys(
      options.result.pointSamples.nodeKeys,
    ).filter((nodeKey) => !requiredNodeKeySet.has(nodeKey));

    super(
      `Camera stream did not reach a terminal additive composition (${options.visualQuality.missingRequiredNodeCount.toLocaleString()} missing required nodes, ${options.visualQuality.unexpectedRenderedNodeCount.toLocaleString()} stale or unexpected nodes, ${options.visualQuality.frontierAncestorOverlapCount.toLocaleString()} frontier overlaps).`,
    );
    this.name = "CopcCameraStreamTerminalRenderError";
    this.result = options.result;
    this.visualQuality = options.visualQuality;
    this.missingRequiredNodeKeys = missingRequiredNodeKeys;
    this.unexpectedRenderedNodeKeys = unexpectedRenderedNodeKeys;
  }
}

/**
 * Renders one already-planned camera view through bounded progressive request
 * windows and resolves only after the exact additive terminal set is committed.
 *
 * Request identity, cancellation, hierarchy expansion, and prefetch remain
 * caller-owned. In particular, this function never schedules a follow-up
 * render when background work completes.
 */
export async function runCopcCameraStreamTerminalRender(
  options: CopcCameraStreamTerminalRenderOptions,
): Promise<CopcCameraStreamTerminalRenderResult> {
  options.signal?.throwIfAborted();
  const runtimeSettings =
    options.runtimeSettings ?? createCopcCameraStreamRuntimeSettings();
  const detailCompletionSettings =
    createCopcCameraStreamDetailCompletionSettings({
      lodSettings: options.lodSettings,
      runtimeSettings,
    });
  const detailProgressPolicy = selectCopcCameraStreamDetailProgressPolicy({
    finalNodeKeys: options.requiredNodeKeys,
    initialNodeResults: options.initialNodeResults ?? [],
    rendererKind: options.rendererKind,
    fastRendererProgressBatchNodeCount:
      runtimeSettings.fastRendererProgressBatchNodeCount,
    pointPrimitiveProgressBatchNodeCount:
      runtimeSettings.pointPrimitiveProgressBatchNodeCount,
    minInitialPointCount: runtimeSettings.detailWarmupPointCountPerNode,
    balancedBatchDivisor: runtimeSettings.detailProgressBatchDivisor,
    minBalancedBatchNodeCount: runtimeSettings.detailProgressMinBatchNodeCount,
    maxBalancedBatchNodeCount: runtimeSettings.detailProgressMaxBatchNodeCount,
  });
  let interactiveReadyPublished = false;

  const createUpdate = (
    result: CopcPointCloudLayerNodesRenderResult,
    allowTerminalStage: boolean,
  ): CopcCameraStreamTerminalRenderUpdate => {
    const detailProgress = createDetailProgressState(
      result,
      options,
      detailCompletionSettings,
    );
    const visualQuality = createCopcCameraStreamVisualQualityState({
      frontierNodeKeys: options.frontierNodeKeys,
      requiredNodeKeys: options.requiredNodeKeys,
      renderedNodeKeys: result.pointSamples.nodeKeys,
      terminalFrontierMode: options.terminalFrontierMode,
    });
    const becameInteractiveReady =
      detailProgress.isComplete && !interactiveReadyPublished;

    return {
      stage:
        allowTerminalStage && visualQuality.isTerminalReady
          ? "terminal"
          : detailProgress.isComplete
            ? "interactive-ready"
            : "refining",
      result,
      detailProgress,
      visualQuality,
      becameInteractiveReady,
    };
  };
  const publish = (update: CopcCameraStreamTerminalRenderUpdate): void => {
    if (options.signal?.aborted || options.shouldPublish?.() === false) {
      return;
    }

    options.onUpdate?.(update);

    if (update.detailProgress.isComplete) {
      interactiveReadyPublished = true;
    }
  };

  const result = await options.layer.renderNodesProgressively(
    options.requiredNodeKeys,
    {
      initialNodeResults: options.initialNodeResults,
      backgroundNodeResults: options.backgroundNodeResults,
      includePointsInResult: false,
      requestPriority: options.requestPriority,
      maxPointCountPerNode: options.maxPointCountPerNode,
      maxRenderedPointCount: options.renderedPointBudget,
      nodePointCountWeights: createAlignedPointCountWeights(
        options.requiredNodeKeys,
        options.finalNodeWeights,
      ),
      useSourcePointBudgetHeadroom: options.useSourcePointBudgetHeadroom,
      maxActiveProgressiveNodeRequests:
        options.maxActiveNodeRequests ??
        runtimeSettings.detailMaxActiveNodeRequests,
      progressBatchNodeCount: detailProgressPolicy.progressBatchNodeCount,
      progressRenderMode:
        options.progressRenderMode ??
        (options.rendererKind === "typed"
          ? "final-only"
          : detailProgressPolicy.progressRenderMode),
      skipInitialProgressRender: options.skipInitialProgressRender,
      shouldRenderProgress: options.shouldRenderProgress,
      nodeRequestOrder: "selection",
      continueLoadingAfterStop: true,
      postStopLoadingMode: "await",
      postStopProgressMode: "render",
      showBounds: false,
      signal: options.signal,
      shouldStopAfterProgress: (progressResult) =>
        createDetailProgressState(
          progressResult,
          options,
          detailCompletionSettings,
        ).isComplete,
      onProgress: (progressResult) => {
        const update = createUpdate(progressResult, false);

        if (
          !options.signal?.aborted &&
          options.shouldPublish?.() !== false
        ) {
          options.onProgressCommitted?.();
        }

        // Terminal publication is intentionally deferred until the returned
        // final result is independently verified below.
        if (!update.visualQuality.isTerminalReady) {
          publish(update);
        }
      },
    },
  );
  // A custom layer-like adapter may ignore its signal and still resolve. Never
  // let that stale result publish or satisfy the terminal contract.
  options.signal?.throwIfAborted();
  const finalUpdate = createUpdate(result, true);

  if (!finalUpdate.visualQuality.isTerminalReady) {
    throw new CopcCameraStreamTerminalRenderError({
      result,
      requiredNodeKeys: options.requiredNodeKeys,
      visualQuality: finalUpdate.visualQuality,
    });
  }

  publish(finalUpdate);

  return {
    result,
    detailProgress: finalUpdate.detailProgress,
    visualQuality:
      finalUpdate.visualQuality as CopcCameraStreamTerminalVisualQualityState,
  };
}

function createDetailProgressState(
  result: CopcPointCloudLayerNodesRenderResult,
  options: Pick<
    CopcCameraStreamTerminalRenderOptions,
    "finalNodeWeights" | "renderedPointBudget" | "requiredNodeKeys"
  >,
  completionSettings: ReturnType<
    typeof createCopcCameraStreamDetailCompletionSettings
  >,
): CopcCameraStreamDetailProgressState {
  return createCopcCameraStreamDetailProgressState({
    finalNodeKeys: options.requiredNodeKeys,
    finalNodeWeights: options.finalNodeWeights,
    renderedNodeKeys: result.pointSamples.nodeKeys,
    minBudgetFillRatio: completionSettings.minBudgetFillRatio,
    minBudgetCompletionNodeCoverageRatio:
      completionSettings.minBudgetCompletionNodeCoverageRatio,
    minNodeCoverageRatio: completionSettings.minNodeCoverageRatio,
    minWeightedCompletionNodeCoverageRatio: Math.max(
      0,
      completionSettings.minNodeCoverageRatio,
    ),
    minWeightedNodeCoverageRatio: completionSettings.minNodeCoverageRatio,
    renderedPointBudget: options.renderedPointBudget,
    renderedPointCount: result.pointSamples.sampledPointCount,
  });
}

function uniqueNodeKeys(nodeKeys: readonly string[]): readonly string[] {
  return [...new Set(nodeKeys.filter((nodeKey) => nodeKey.length > 0))];
}

function createAlignedPointCountWeights(
  nodeKeys: readonly string[],
  finalNodeWeights: readonly CopcCameraStreamFinalNodeWeight[] | undefined,
): readonly number[] | undefined {
  if (!finalNodeWeights || finalNodeWeights.length === 0) {
    return undefined;
  }

  const weightByNodeKey = new Map(
    finalNodeWeights.map(({ nodeKey, weight }) => [
      nodeKey,
      Number.isFinite(weight) && weight > 0 ? weight : 1,
    ]),
  );

  return nodeKeys.map((nodeKey) => weightByNodeKey.get(nodeKey) ?? 1);
}
