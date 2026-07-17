import {
  isCopcNodeKeyAncestorOf,
  readCopcNodeKeyDepth,
} from "./CopcCameraStreamNodePlan";

export type CopcCameraStreamTerminalFrontierMode =
  | "same-depth"
  | "mixed-depth-antichain";

export interface CopcCameraStreamVisualQualityOptions {
  /** Leaf/frontier nodes selected for the current camera view. */
  readonly frontierNodeKeys: readonly string[];
  /** Complete additive node set required to render that frontier. */
  readonly requiredNodeKeys: readonly string[];
  /** Node set currently submitted to the renderer. */
  readonly renderedNodeKeys: readonly string[];
  /** Current-view hierarchy pages still needed before this plan can be final. */
  readonly pendingRelevantHierarchyPageCount?: number;
  /**
   * Controls the terminal frontier depth contract. The default preserves the
   * existing complete-depth requirement. Mixed depths are accepted only when
   * explicitly requested; antichain and additive-completeness checks remain.
   */
  readonly terminalFrontierMode?: CopcCameraStreamTerminalFrontierMode;
}

export interface CopcCameraStreamVisualQualityState {
  readonly terminalFrontierMode: CopcCameraStreamTerminalFrontierMode;
  readonly frontierNodeCount: number;
  readonly frontierMinDepth: number | undefined;
  readonly frontierMaxDepth: number | undefined;
  readonly frontierDepthSpan: number;
  readonly frontierAncestorOverlapCount: number;
  readonly requiredNodeCount: number;
  readonly renderedNodeCount: number;
  readonly renderedFrontierNodeCount: number;
  readonly missingFrontierNodeCount: number;
  readonly missingRequiredNodeCount: number;
  readonly unexpectedRenderedNodeCount: number;
  readonly pendingRelevantHierarchyPageCount: number;
  readonly isHierarchyCompleteForView: boolean;
  readonly isFrontierAntichain: boolean;
  readonly isFrontierDepthPolicySatisfied: boolean;
  readonly isAdditiveClosureComplete: boolean;
  readonly isTerminalReady: boolean;
}

/**
 * Describes whether a camera-stream render is a complete terminal composition.
 *
 * COPC follows EPT's additive hierarchy: the visible frontier is not enough on
 * its own, because every available lower-resolution ancestor in the planned
 * closure also contributes unique points. A terminal frame must therefore
 * contain the complete required set, while excluding stale nodes from an older
 * camera request. Same-depth antichains remain the default terminal contract.
 * A caller that has produced a complete view-dependent traversal may opt in to
 * a mixed-depth antichain without weakening the other terminal checks.
 */
export function createCopcCameraStreamVisualQualityState(
  options: CopcCameraStreamVisualQualityOptions,
): CopcCameraStreamVisualQualityState {
  const frontierNodeKeys = uniqueNodeKeys(options.frontierNodeKeys);
  const requiredNodeKeys = uniqueNodeKeys(options.requiredNodeKeys);
  const renderedNodeKeys = uniqueNodeKeys(options.renderedNodeKeys);
  const terminalFrontierMode = readTerminalFrontierMode(
    options.terminalFrontierMode,
  );
  const pendingRelevantHierarchyPageCount =
    readPendingRelevantHierarchyPageCount(
      options.pendingRelevantHierarchyPageCount,
    );
  const isHierarchyCompleteForView =
    pendingRelevantHierarchyPageCount === 0;
  const frontierNodeKeySet = new Set(frontierNodeKeys);
  const requiredNodeKeySet = new Set(requiredNodeKeys);
  const renderedNodeKeySet = new Set(renderedNodeKeys);
  const frontierDepths = frontierNodeKeys.map(readCopcNodeKeyDepth);
  const frontierMinDepth =
    frontierDepths.length > 0 ? Math.min(...frontierDepths) : undefined;
  const frontierMaxDepth =
    frontierDepths.length > 0 ? Math.max(...frontierDepths) : undefined;
  const frontierAncestorOverlapCount = countAncestorOverlaps(frontierNodeKeys);
  const frontierDepthSpan =
    frontierMinDepth === undefined || frontierMaxDepth === undefined
      ? 0
      : frontierMaxDepth - frontierMinDepth;
  const renderedFrontierNodeCount = frontierNodeKeys.filter((nodeKey) =>
    renderedNodeKeySet.has(nodeKey),
  ).length;
  const missingFrontierNodeCount =
    frontierNodeKeys.length - renderedFrontierNodeCount;
  const missingRequiredNodeCount = requiredNodeKeys.filter(
    (nodeKey) => !renderedNodeKeySet.has(nodeKey),
  ).length;
  const unexpectedRenderedNodeCount = renderedNodeKeys.filter(
    (nodeKey) => !requiredNodeKeySet.has(nodeKey),
  ).length;
  const requiredSetContainsFrontier = frontierNodeKeys.every((nodeKey) =>
    requiredNodeKeySet.has(nodeKey),
  );
  const isFrontierAntichain = frontierAncestorOverlapCount === 0;
  const isFrontierDepthPolicySatisfied =
    terminalFrontierMode === "mixed-depth-antichain" ||
    frontierDepthSpan === 0;
  const isAdditiveClosureComplete =
    requiredSetContainsFrontier &&
    missingRequiredNodeCount === 0 &&
    missingFrontierNodeCount === 0;

  return {
    terminalFrontierMode,
    frontierNodeCount: frontierNodeKeySet.size,
    frontierMinDepth,
    frontierMaxDepth,
    frontierDepthSpan,
    frontierAncestorOverlapCount,
    requiredNodeCount: requiredNodeKeySet.size,
    renderedNodeCount: renderedNodeKeySet.size,
    renderedFrontierNodeCount,
    missingFrontierNodeCount,
    missingRequiredNodeCount,
    unexpectedRenderedNodeCount,
    pendingRelevantHierarchyPageCount,
    isHierarchyCompleteForView,
    isFrontierAntichain,
    isFrontierDepthPolicySatisfied,
    isAdditiveClosureComplete,
    isTerminalReady:
      frontierNodeKeySet.size > 0 &&
      requiredNodeKeySet.size > 0 &&
      isFrontierDepthPolicySatisfied &&
      isFrontierAntichain &&
      isAdditiveClosureComplete &&
      isHierarchyCompleteForView &&
      unexpectedRenderedNodeCount === 0,
  };
}

function readTerminalFrontierMode(
  value: CopcCameraStreamTerminalFrontierMode | undefined,
): CopcCameraStreamTerminalFrontierMode {
  const mode = value ?? "same-depth";

  if (mode !== "same-depth" && mode !== "mixed-depth-antichain") {
    throw new Error(
      'terminalFrontierMode must be "same-depth" or "mixed-depth-antichain".',
    );
  }

  return mode;
}

export function withCopcCameraStreamHierarchyQuality(
  state: CopcCameraStreamVisualQualityState,
  pendingRelevantHierarchyPageCount: number,
  isHierarchyCompletenessKnown = true,
): CopcCameraStreamVisualQualityState {
  const pendingCount = readPendingRelevantHierarchyPageCount(
    pendingRelevantHierarchyPageCount,
  );
  const isHierarchyCompleteForView =
    isHierarchyCompletenessKnown && pendingCount === 0;

  return {
    ...state,
    pendingRelevantHierarchyPageCount: pendingCount,
    isHierarchyCompleteForView,
    isTerminalReady: state.isTerminalReady && isHierarchyCompleteForView,
  };
}

export function formatCopcCameraStreamVisualQuality(
  state: CopcCameraStreamVisualQualityState | undefined,
): string {
  if (!state) {
    return "Not streamed yet";
  }

  const frontierDepthSummary =
    state.frontierMinDepth === undefined || state.frontierMaxDepth === undefined
      ? "no frontier"
      : state.frontierMinDepth === state.frontierMaxDepth
        ? `frontier depth ${state.frontierMinDepth.toLocaleString()}`
        : `frontier depth ${state.frontierMinDepth.toLocaleString()}-${state.frontierMaxDepth.toLocaleString()}`;

  const hierarchySummary = state.isHierarchyCompleteForView
    ? "hierarchy complete for view"
    : state.pendingRelevantHierarchyPageCount === 0
      ? "hierarchy completeness unknown"
      : `${state.pendingRelevantHierarchyPageCount.toLocaleString()} pending hierarchy ${state.pendingRelevantHierarchyPageCount === 1 ? "page" : "pages"}`;

  return `${state.isTerminalReady ? "terminal-ready" : "refining"}, ${state.renderedNodeCount.toLocaleString()} / ${state.requiredNodeCount.toLocaleString()} additive nodes, ${state.renderedFrontierNodeCount.toLocaleString()} / ${state.frontierNodeCount.toLocaleString()} frontier nodes, ${frontierDepthSummary}, ${state.missingRequiredNodeCount.toLocaleString()} missing, ${state.unexpectedRenderedNodeCount.toLocaleString()} stale/unexpected, ${state.frontierAncestorOverlapCount.toLocaleString()} frontier overlaps, ${hierarchySummary}`;
}

function uniqueNodeKeys(nodeKeys: readonly string[]): string[] {
  return [...new Set(nodeKeys.filter((nodeKey) => nodeKey.length > 0))];
}

function readPendingRelevantHierarchyPageCount(
  value: number | undefined,
): number {
  const count = value ?? 0;

  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(
      "pendingRelevantHierarchyPageCount must be a non-negative integer.",
    );
  }

  return count;
}

function countAncestorOverlaps(nodeKeys: readonly string[]): number {
  let overlapCount = 0;

  for (let leftIndex = 0; leftIndex < nodeKeys.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < nodeKeys.length;
      rightIndex += 1
    ) {
      const leftNodeKey = nodeKeys[leftIndex];
      const rightNodeKey = nodeKeys[rightIndex];

      if (
        isCopcNodeKeyAncestorOf(leftNodeKey, rightNodeKey) ||
        isCopcNodeKeyAncestorOf(rightNodeKey, leftNodeKey)
      ) {
        overlapCount += 1;
      }
    }
  }

  return overlapCount;
}
