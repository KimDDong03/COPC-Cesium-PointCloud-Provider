import type { CopcBounds } from "./CopcInspection";
import type { CopcHierarchyNodeSummary } from "./CopcHierarchySummary";
import {
  planMixedDepthHierarchyTraversal,
  type CopcMixedDepthNodeViewState,
} from "./planMixedDepthHierarchyTraversal";
import type { CopcTargetPoint } from "./suggestHierarchyNode";

export interface SelectHierarchyNodesForCameraOptions {
  readonly target: CopcTargetPoint;
  /**
   * Camera-eye position in COPC coordinates used only for screen-space size
   * estimates. `target` remains the view-center used to prioritize nodes.
   * Defaults to `target` for backwards compatibility.
   */
  readonly cameraPosition?: CopcTargetPoint;
  readonly viewDirection?: CopcTargetVector;
  readonly viewportHeightPixels: number;
  readonly selectionMode?: CopcHierarchyNodeSelectionMode;
  readonly coverageMode?: CopcHierarchyNodeCoverageMode;
  readonly maxNodes?: number;
  readonly minDepth?: number;
  readonly maxDepth?: number;
  readonly maxNodePointCount?: number;
  readonly maxNodePointDataLength?: number;
  readonly maxTotalPointCount?: number;
  readonly maxTotalPointDataLength?: number;
  readonly targetNodeScreenPixels?: number;
  readonly maxViewAngleDegrees?: number;
  readonly spacing?: number;
  readonly targetPointSpacingScreenPixels?: number;
  /** Previous mixed-depth frontier used only for refinement hysteresis. */
  readonly previousFrontierKeys?: readonly string[];
  /** Mixed-depth refinement entry threshold in screen pixels. */
  readonly refineScreenSpaceError?: number;
  /** Mixed-depth retention threshold in screen pixels. */
  readonly retainScreenSpaceError?: number;
}

export type CopcHierarchyNodeSelectionMode = "nearest" | "coverage";
export type CopcHierarchyNodeCoverageMode =
  | "complete-depth"
  | "progressive"
  | "mixed-depth";

export interface CopcTargetVector {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface CopcHierarchyNodeCameraSelection {
  readonly nodes: readonly CopcHierarchyNodeSummary[];
  readonly targetDepth: number;
  readonly selectedDepth: number;
  readonly selectionMode: CopcHierarchyNodeSelectionMode;
  readonly coverageMode: CopcHierarchyNodeCoverageMode | undefined;
  readonly estimatedRootScreenPixels: number;
  readonly estimatedSelectedDepthScreenPixels: number;
  readonly targetNodeScreenPixels: number;
  readonly estimatedSelectedDepthPointSpacingScreenPixels: number | undefined;
  readonly targetPointSpacingScreenPixels: number | undefined;
  readonly maxViewAngleDegrees: number | undefined;
  readonly spacing: number | undefined;
  readonly depthEstimates: readonly CopcHierarchyNodeDepthEstimate[];
  readonly skippedByFrustumCount: number;
  readonly skippedByViewCount: number;
  readonly skippedByBudgetCount: number;
  readonly reason: string;
}

export interface CopcHierarchyNodeDepthEstimate {
  readonly depth: number;
  readonly nodeCount: number;
  readonly nearestNodeKey: string;
  readonly estimatedNodeScreenPixels: number;
  readonly pointSpacing: number | undefined;
  readonly estimatedPointSpacingScreenPixels: number | undefined;
}

const DEFAULT_MAX_NODES = 4;
const DEFAULT_SELECTION_MODE: CopcHierarchyNodeSelectionMode = "nearest";
const DEFAULT_COVERAGE_MODE: CopcHierarchyNodeCoverageMode = "complete-depth";
const DEFAULT_TARGET_NODE_SCREEN_PIXELS = 220;
const DEFAULT_TARGET_POINT_SPACING_SCREEN_PIXELS = 4;
const DEFAULT_MAX_VIEW_ANGLE_DEGREES = 80;

export function selectHierarchyNodesForCamera(
  nodes: readonly CopcHierarchyNodeSummary[],
  options: SelectHierarchyNodesForCameraOptions,
): CopcHierarchyNodeCameraSelection | undefined {
  if (nodes.length === 0) {
    return undefined;
  }

  assertFiniteTarget(options.target, "target");
  if (options.cameraPosition !== undefined) {
    assertFiniteTarget(options.cameraPosition, "cameraPosition");
  }
  assertFiniteViewDirection(options.viewDirection);

  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const selectionMode = options.selectionMode ?? DEFAULT_SELECTION_MODE;
  const coverageMode = options.coverageMode ?? DEFAULT_COVERAGE_MODE;
  const viewportHeightPixels = options.viewportHeightPixels;
  const targetNodeScreenPixels =
    options.targetNodeScreenPixels ?? DEFAULT_TARGET_NODE_SCREEN_PIXELS;
  const targetPointSpacingScreenPixels =
    options.spacing === undefined
      ? undefined
      : options.targetPointSpacingScreenPixels ??
        DEFAULT_TARGET_POINT_SPACING_SCREEN_PIXELS;
  const maxViewAngleDegrees =
    options.viewDirection === undefined
      ? undefined
      : options.maxViewAngleDegrees ?? DEFAULT_MAX_VIEW_ANGLE_DEGREES;
  const screenSpaceOrigin = options.cameraPosition ?? options.target;

  if (!Number.isSafeInteger(maxNodes) || maxNodes <= 0) {
    throw new Error("maxNodes must be a positive integer.");
  }

  if (selectionMode !== "nearest" && selectionMode !== "coverage") {
    throw new Error('selectionMode must be "nearest" or "coverage".');
  }

  if (
    coverageMode !== "complete-depth" &&
    coverageMode !== "progressive" &&
    coverageMode !== "mixed-depth"
  ) {
    throw new Error(
      'coverageMode must be "complete-depth", "progressive", or "mixed-depth".',
    );
  }

  if (!Number.isFinite(viewportHeightPixels) || viewportHeightPixels <= 0) {
    throw new Error("viewportHeightPixels must be a positive finite number.");
  }

  if (!Number.isFinite(targetNodeScreenPixels) || targetNodeScreenPixels <= 0) {
    throw new Error("targetNodeScreenPixels must be a positive finite number.");
  }

  validateViewAngle(maxViewAngleDegrees);

  if (options.spacing !== undefined) {
    validatePositiveFiniteBudget(options.spacing, "spacing");
  }

  if (
    options.targetPointSpacingScreenPixels !== undefined &&
    options.spacing === undefined
  ) {
    throw new Error(
      "spacing is required when targetPointSpacingScreenPixels is provided.",
    );
  }

  validatePositiveFiniteBudget(
    options.targetPointSpacingScreenPixels,
    "targetPointSpacingScreenPixels",
  );
  validatePositiveFiniteBudget(
    options.maxNodePointCount,
    "maxNodePointCount",
  );
  validatePositiveFiniteBudget(
    options.maxNodePointDataLength,
    "maxNodePointDataLength",
  );
  validatePositiveFiniteBudget(
    options.maxTotalPointCount,
    "maxTotalPointCount",
  );
  validatePositiveFiniteBudget(
    options.maxTotalPointDataLength,
    "maxTotalPointDataLength",
  );
  validateNonNegativeFiniteOption(
    options.refineScreenSpaceError,
    "refineScreenSpaceError",
  );
  validateNonNegativeFiniteOption(
    options.retainScreenSpaceError,
    "retainScreenSpaceError",
  );
  const effectiveMixedDepthRefineScreenSpaceError =
    options.refineScreenSpaceError ??
    (options.spacing === undefined
      ? targetNodeScreenPixels
      : (targetPointSpacingScreenPixels ??
        DEFAULT_TARGET_POINT_SPACING_SCREEN_PIXELS));

  if (
    options.retainScreenSpaceError !== undefined &&
    options.retainScreenSpaceError >
      effectiveMixedDepthRefineScreenSpaceError
  ) {
    throw new Error(
      "retainScreenSpaceError must be less than or equal to refineScreenSpaceError.",
    );
  }

  const hierarchyMaxDepth = maxNodeDepth(nodes);
  const minDepth = options.minDepth ?? 0;
  const maxDepth = options.maxDepth ?? hierarchyMaxDepth;

  if (!Number.isSafeInteger(minDepth) || minDepth < 0) {
    throw new Error("minDepth must be a non-negative integer.");
  }

  if (!Number.isSafeInteger(maxDepth) || maxDepth < minDepth) {
    throw new Error("maxDepth must be an integer greater than or equal to minDepth.");
  }

  const boundedMinDepth = Math.min(minDepth, hierarchyMaxDepth);
  const boundedMaxDepth = Math.min(maxDepth, hierarchyMaxDepth);
  const candidateNodes = filterNodesForView(
    nodes,
    boundedMinDepth,
    boundedMaxDepth,
    {
      target: options.target,
      viewDirection: options.viewDirection,
      maxViewAngleDegrees,
    },
  );
  const availableDepths = sortedAvailableDepths(
    candidateNodes.nodes,
    boundedMinDepth,
    boundedMaxDepth,
  );

  if (availableDepths.length === 0) {
    return undefined;
  }

  const rootBounds = boundsForHierarchy(nodes);
  const estimatedRootScreenPixels = estimateBoundsScreenPixels(
    rootBounds,
    screenSpaceOrigin,
    viewportHeightPixels,
  );
  const depthEstimates = estimateAvailableDepthsScreenSize(
    candidateNodes.nodes,
    availableDepths,
    screenSpaceOrigin,
    viewportHeightPixels,
    options.spacing,
  );
  const targetDepth = chooseTargetDepth(
    depthEstimates,
    targetNodeScreenPixels,
    targetPointSpacingScreenPixels,
  );
  const budgetOptions = {
    target: options.target,
    selectionMode,
    coverageMode,
    maxNodes,
    maxNodePointCount: options.maxNodePointCount,
    maxNodePointDataLength: options.maxNodePointDataLength,
    maxTotalPointCount: options.maxTotalPointCount,
    maxTotalPointDataLength: options.maxTotalPointDataLength,
  };
  const selection =
    selectionMode === "coverage"
      ? coverageMode === "mixed-depth"
        ? selectMixedDepthCoverageNodes(
            nodes,
            candidateNodes.nodes,
            availableDepths,
            targetDepth,
            {
              ...budgetOptions,
              minDepth: boundedMinDepth,
              maxDepth: boundedMaxDepth,
              screenSpaceOrigin,
              viewportHeightPixels,
              spacing: options.spacing,
              targetNodeScreenPixels,
              targetPointSpacingScreenPixels,
              previousFrontierKeys: options.previousFrontierKeys,
              refineScreenSpaceError: options.refineScreenSpaceError,
              retainScreenSpaceError: options.retainScreenSpaceError,
            },
          )
        : selectBudgetedCoverageNodes(
            candidateNodes.nodes,
            availableDepths,
            targetDepth,
            budgetOptions,
          )
      : selectBudgetedNodes(
          candidateNodes.nodes,
          availableDepths,
          targetDepth,
          budgetOptions,
        );

  if (!selection) {
    return undefined;
  }

  const selectedDepthEstimate = findDepthEstimate(
    depthEstimates,
    selection.selectedDepth,
  );

  return {
    nodes: selection.nodes,
    targetDepth,
    selectedDepth: selection.selectedDepth,
    selectionMode,
    coverageMode: selectionMode === "coverage" ? coverageMode : undefined,
    estimatedRootScreenPixels,
    estimatedSelectedDepthScreenPixels:
      selectedDepthEstimate.estimatedNodeScreenPixels,
    targetNodeScreenPixels,
    estimatedSelectedDepthPointSpacingScreenPixels:
      selectedDepthEstimate.estimatedPointSpacingScreenPixels,
    targetPointSpacingScreenPixels,
    maxViewAngleDegrees,
    spacing: options.spacing,
    depthEstimates,
    skippedByFrustumCount: 0,
    skippedByViewCount: candidateNodes.skippedByViewCount,
    skippedByBudgetCount: selection.skippedByBudgetCount,
    reason: createSelectionReason(
      selection,
      selectedDepthEstimate,
      targetNodeScreenPixels,
      targetPointSpacingScreenPixels,
      candidateNodes.skippedByViewCount,
      selectionMode,
      selectionMode === "coverage" ? coverageMode : undefined,
    ),
  };
}

function assertFiniteTarget(target: CopcTargetPoint, label: string): void {
  if (
    !Number.isFinite(target.x) ||
    !Number.isFinite(target.y) ||
    !Number.isFinite(target.z)
  ) {
    throw new Error(`${label} must contain finite x, y, and z values.`);
  }
}

function assertFiniteViewDirection(
  viewDirection: CopcTargetVector | undefined,
): void {
  if (viewDirection === undefined) {
    return;
  }

  if (
    !Number.isFinite(viewDirection.x) ||
    !Number.isFinite(viewDirection.y) ||
    !Number.isFinite(viewDirection.z)
  ) {
    throw new Error("viewDirection must contain finite x, y, and z values.");
  }

  if (vectorLength(viewDirection) <= Number.EPSILON) {
    throw new Error("viewDirection must be a non-zero vector.");
  }
}

function maxNodeDepth(nodes: readonly CopcHierarchyNodeSummary[]): number {
  return nodes.reduce((depth, node) => Math.max(depth, node.depth), 0);
}

function sortedAvailableDepths(
  nodes: readonly CopcHierarchyNodeSummary[],
  minDepth: number,
  maxDepth: number,
): number[] {
  return [...new Set(nodes.map((node) => node.depth))]
    .filter((depth) => depth >= minDepth && depth <= maxDepth)
    .sort((left, right) => left - right);
}

function estimateAvailableDepthsScreenSize(
  nodes: readonly CopcHierarchyNodeSummary[],
  availableDepths: readonly number[],
  screenSpaceOrigin: CopcTargetPoint,
  viewportHeightPixels: number,
  spacing: number | undefined,
): CopcHierarchyNodeDepthEstimate[] {
  return availableDepths.map((depth) => {
    const nodesAtDepth = nodes.filter((node) => node.depth === depth);
    const nearestNode = nodesAtDepth
      .map((node) => ({
        node,
        distanceToBounds: distanceToBounds3d(screenSpaceOrigin, node.bounds),
      }))
      .sort(
        (left, right) =>
          left.distanceToBounds - right.distanceToBounds ||
          right.node.pointCount - left.node.pointCount ||
          left.node.key.localeCompare(right.node.key),
      )[0]?.node;

    if (!nearestNode) {
      throw new Error(`No COPC hierarchy nodes were found at depth ${depth}.`);
    }

    const pointSpacing =
      spacing === undefined ? undefined : spacing / 2 ** depth;
    const estimatedPointSpacingScreenPixels =
      pointSpacing === undefined
        ? undefined
        : estimateLinearScreenPixels(
            pointSpacing,
            nearestNode.bounds,
            screenSpaceOrigin,
            viewportHeightPixels,
          );

    return {
      depth,
      nodeCount: nodesAtDepth.length,
      nearestNodeKey: nearestNode.key,
      estimatedNodeScreenPixels: estimateBoundsScreenPixels(
        nearestNode.bounds,
        screenSpaceOrigin,
        viewportHeightPixels,
      ),
      pointSpacing,
      estimatedPointSpacingScreenPixels,
    };
  });
}

function chooseTargetDepth(
  depthEstimates: readonly CopcHierarchyNodeDepthEstimate[],
  targetNodeScreenPixels: number,
  targetPointSpacingScreenPixels: number | undefined,
): number {
  const satisfyingDepth = [...depthEstimates]
    .filter(
      (estimate) =>
        estimate.estimatedNodeScreenPixels <= targetNodeScreenPixels &&
        satisfiesPointSpacingTarget(estimate, targetPointSpacingScreenPixels),
    )
    .sort((left, right) => left.depth - right.depth)[0];

  if (satisfyingDepth) {
    return satisfyingDepth.depth;
  }

  return [...depthEstimates].sort(
    (left, right) => right.depth - left.depth,
  )[0].depth;
}

function satisfiesPointSpacingTarget(
  estimate: CopcHierarchyNodeDepthEstimate,
  targetPointSpacingScreenPixels: number | undefined,
): boolean {
  if (targetPointSpacingScreenPixels === undefined) {
    return true;
  }

  return (
    estimate.estimatedPointSpacingScreenPixels !== undefined &&
    estimate.estimatedPointSpacingScreenPixels <=
      targetPointSpacingScreenPixels
  );
}

function findDepthEstimate(
  depthEstimates: readonly CopcHierarchyNodeDepthEstimate[],
  depth: number,
): CopcHierarchyNodeDepthEstimate {
  const estimate = depthEstimates.find((candidate) => candidate.depth === depth);

  if (!estimate) {
    throw new Error(`No COPC hierarchy depth estimate was found for ${depth}.`);
  }

  return estimate;
}

function createSelectionReason(
  selection: BudgetedNodeSelection,
  selectedDepthEstimate: CopcHierarchyNodeDepthEstimate,
  targetNodeScreenPixels: number,
  targetPointSpacingScreenPixels: number | undefined,
  skippedByViewCount: number,
  selectionMode: CopcHierarchyNodeSelectionMode,
  coverageMode: CopcHierarchyNodeCoverageMode | undefined,
): string {
  const pointSpacingReason =
    targetPointSpacingScreenPixels === undefined ||
    selectedDepthEstimate.estimatedPointSpacingScreenPixels === undefined
      ? ""
      : ` and point spacing ${selectedDepthEstimate.estimatedPointSpacingScreenPixels.toLocaleString(undefined, { maximumFractionDigits: 1 })} px against a ${targetPointSpacingScreenPixels.toLocaleString(undefined, { maximumFractionDigits: 1 })} px target`;
  const viewReason =
    skippedByViewCount === 0
      ? ""
      : ` Culled ${skippedByViewCount.toLocaleString()} off-camera candidate nodes.`;
  const modeReason =
    selectionMode === "coverage"
      ? coverageMode === "mixed-depth"
        ? "mixed-depth screen-coverage"
        : coverageMode === "progressive"
          ? "progressive screen-coverage"
          : "screen-coverage"
      : "nearest";
  const minimumSelectedDepth = selection.nodes.reduce(
    (minimum, node) => Math.min(minimum, node.depth),
    selection.selectedDepth,
  );
  const selectedDepthReason =
    minimumSelectedDepth === selection.selectedDepth
      ? `depth ${selection.selectedDepth}`
      : `depths ${minimumSelectedDepth}-${selection.selectedDepth}`;

  return `Selected ${selection.nodes.length} ${modeReason} ${selectedDepthReason} nodes; nearest depth ${selection.selectedDepth} node is estimated at ${selectedDepthEstimate.estimatedNodeScreenPixels.toLocaleString(undefined, { maximumFractionDigits: 0 })} px against a ${targetNodeScreenPixels.toLocaleString(undefined, { maximumFractionDigits: 0 })} px target${pointSpacingReason}.${viewReason}`;
}

interface SelectBudgetedNodesOptions {
  readonly target: CopcTargetPoint;
  readonly selectionMode: CopcHierarchyNodeSelectionMode;
  readonly coverageMode: CopcHierarchyNodeCoverageMode;
  readonly maxNodes: number;
  readonly maxNodePointCount: number | undefined;
  readonly maxNodePointDataLength: number | undefined;
  readonly maxTotalPointCount: number | undefined;
  readonly maxTotalPointDataLength: number | undefined;
}

interface SelectMixedDepthCoverageNodesOptions
  extends SelectBudgetedNodesOptions {
  readonly minDepth: number;
  readonly maxDepth: number;
  readonly screenSpaceOrigin: CopcTargetPoint;
  readonly viewportHeightPixels: number;
  readonly spacing: number | undefined;
  readonly targetNodeScreenPixels: number;
  readonly targetPointSpacingScreenPixels: number | undefined;
  readonly previousFrontierKeys: readonly string[] | undefined;
  readonly refineScreenSpaceError: number | undefined;
  readonly retainScreenSpaceError: number | undefined;
}

interface BudgetedNodeSelection {
  readonly nodes: readonly CopcHierarchyNodeSummary[];
  readonly selectedDepth: number;
  readonly skippedByBudgetCount: number;
}

interface ViewFilteredNodeSelection {
  readonly nodes: readonly CopcHierarchyNodeSummary[];
  readonly skippedByViewCount: number;
}

interface NodeDistanceCandidate {
  readonly node: CopcHierarchyNodeSummary;
  readonly distanceToBounds: number;
}

function filterNodesForView(
  nodes: readonly CopcHierarchyNodeSummary[],
  minDepth: number,
  maxDepth: number,
  options: {
    readonly target: CopcTargetPoint;
    readonly viewDirection: CopcTargetVector | undefined;
    readonly maxViewAngleDegrees: number | undefined;
  },
): ViewFilteredNodeSelection {
  const depthFilteredNodes = nodes.filter(
    (node) =>
      node.pointCount > 0 &&
      node.pointDataLength > 0 &&
      node.depth >= minDepth &&
      node.depth <= maxDepth,
  );

  if (
    options.viewDirection === undefined ||
    options.maxViewAngleDegrees === undefined
  ) {
    return {
      nodes: depthFilteredNodes,
      skippedByViewCount: 0,
    };
  }

  const viewDirection = options.viewDirection;
  const cosMaxViewAngle = Math.cos(degreesToRadians(options.maxViewAngleDegrees));
  const visibleNodes = depthFilteredNodes.filter((node) =>
    isBoundsInsideViewCone(
      node.bounds,
      options.target,
      viewDirection,
      cosMaxViewAngle,
    ),
  );

  return {
    nodes: visibleNodes,
    skippedByViewCount: depthFilteredNodes.length - visibleNodes.length,
  };
}

function selectBudgetedNodes(
  nodes: readonly CopcHierarchyNodeSummary[],
  availableDepths: readonly number[],
  targetDepth: number,
  options: SelectBudgetedNodesOptions,
): BudgetedNodeSelection | undefined {
  for (const depth of depthsByTargetDistance(availableDepths, targetDepth)) {
    const candidates = orderNodeCandidates(
      nodes
        .filter((node) => node.depth === depth)
        .map((node) => ({
          node,
          distanceToBounds: distanceToBounds3d(options.target, node.bounds),
        })),
    );
    const selection = selectWithinBudget(
      candidates.map(({ node }) => node),
      options,
    );

    if (selection.nodes.length > 0) {
      return {
        ...selection,
        selectedDepth: depth,
      };
    }
  }

  return undefined;
}

function selectBudgetedCoverageNodes(
  nodes: readonly CopcHierarchyNodeSummary[],
  availableDepths: readonly number[],
  targetDepth: number,
  options: SelectBudgetedNodesOptions,
): BudgetedNodeSelection | undefined {
  const candidatesByDepth = new Map(
    availableDepths.map((depth) => [
      depth,
      [...nodes]
        .filter((node) => node.depth === depth)
        .sort(compareNodesByCoverageOrder),
    ]),
  );
  const completeSelection = selectCompleteCoverageDepth(
    candidatesByDepth,
    availableDepths,
    targetDepth,
    options,
  );

  if (options.coverageMode === "complete-depth") {
    return completeSelection;
  }

  return addProgressiveCoverageDetail(
    completeSelection,
    candidatesByDepth,
    availableDepths,
    targetDepth,
    options,
  );
}

function selectMixedDepthCoverageNodes(
  hierarchyNodes: readonly CopcHierarchyNodeSummary[],
  visibleCandidateNodes: readonly CopcHierarchyNodeSummary[],
  availableDepths: readonly number[],
  targetDepth: number,
  options: SelectMixedDepthCoverageNodesOptions,
): BudgetedNodeSelection | undefined {
  const maxPointCount = normalizeMixedDepthTotalBudget(
    options.maxTotalPointCount,
  );
  const maxPointDataLength = normalizeMixedDepthTotalBudget(
    options.maxTotalPointDataLength,
  );

  if (maxPointCount === 0 || maxPointDataLength === 0) {
    return undefined;
  }

  const visibleCandidateKeys = new Set(
    visibleCandidateNodes.map((node) => node.key),
  );
  const individuallyBudgetedNodes = hierarchyNodes.filter(
    (node) =>
      node.pointCount > 0 &&
      node.pointDataLength > 0 &&
      node.depth <= options.maxDepth &&
      !isNodeOverIndividualBudget(node, options),
  );
  const individuallySkippedVisibleNodeCount = visibleCandidateNodes.filter(
    (node) => isNodeOverIndividualBudget(node, options),
  ).length;
  const blockedRefinementParentKeys = new Set(
    visibleCandidateNodes
      .filter(
        (node) =>
          node.depth > 0 && isNodeOverIndividualBudget(node, options),
      )
      .map(createParentNodeKey),
  );
  const baselineCoverage = selectMixedDepthBaselineCoverage(
    individuallyBudgetedNodes,
    visibleCandidateNodes,
    availableDepths,
    targetDepth,
    {
      ...options,
      maxTotalPointCount: maxPointCount,
      maxTotalPointDataLength: maxPointDataLength,
    },
  );

  if (!baselineCoverage) {
    return undefined;
  }

  const viewStates = individuallyBudgetedNodes.map((node) =>
    createMixedDepthNodeViewState(
      node,
      visibleCandidateKeys,
      blockedRefinementParentKeys,
      options,
    ),
  );
  const refineScreenSpaceError =
    options.refineScreenSpaceError ??
    (options.spacing === undefined
      ? options.targetNodeScreenPixels
      : (options.targetPointSpacingScreenPixels ??
        DEFAULT_TARGET_POINT_SPACING_SCREEN_PIXELS));
  const plan = planMixedDepthHierarchyTraversal(
    individuallyBudgetedNodes,
    viewStates,
    {
      maxNodes: options.maxNodes,
      maxPointCount: maxPointCount,
      maxPointDataLength,
      refineScreenSpaceError,
      retainScreenSpaceError: options.retainScreenSpaceError,
      previousFrontierKeys: options.previousFrontierKeys,
      requiredNodeKeys: baselineCoverage.nodes.map((node) => node.key),
      refinementMode: "visible-sibling-group",
    },
  );

  if (plan.frontierNodes.length === 0) {
    return undefined;
  }

  return {
    nodes: plan.frontierNodes,
    selectedDepth: maxNodeDepth(plan.frontierNodes),
    skippedByBudgetCount:
      individuallySkippedVisibleNodeCount +
      baselineCoverage.skippedByBudgetCount +
      plan.diagnostics.skippedByBudgetCount,
  };
}

function selectMixedDepthBaselineCoverage(
  planningNodes: readonly CopcHierarchyNodeSummary[],
  visibleCandidateNodes: readonly CopcHierarchyNodeSummary[],
  availableDepths: readonly number[],
  targetDepth: number,
  options: SelectBudgetedNodesOptions,
): BudgetedNodeSelection | undefined {
  const planningNodeByKey = new Map(
    planningNodes.map((node) => [node.key, node]),
  );
  const desiredBaselineDepth =
    targetDepth > 0 ? Math.max(1, targetDepth - 1) : 0;
  const baselineDepths = mixedDepthBaselineDepths(
    availableDepths,
    desiredBaselineDepth,
  );
  let skippedByBudgetCount = 0;

  for (const depth of baselineDepths) {
    const frontierNodes = createVisibleTreeCut(
      visibleCandidateNodes,
      depth,
    );

    if (frontierNodes.length === 0) {
      continue;
    }

    const additiveClosure = createMixedDepthAdditiveClosure(
      frontierNodes,
      planningNodeByKey,
    );

    if (
      additiveClosure === undefined ||
      !fitsMixedDepthAdditiveBudget(additiveClosure, options)
    ) {
      skippedByBudgetCount += frontierNodes.length;
      continue;
    }

    return {
      nodes: orderCoverageNodesByTarget(frontierNodes, options.target),
      selectedDepth: maxNodeDepth(frontierNodes),
      skippedByBudgetCount,
    };
  }

  return undefined;
}

function mixedDepthBaselineDepths(
  availableDepths: readonly number[],
  desiredDepth: number,
): readonly number[] {
  if (availableDepths.length === 0) {
    return [];
  }

  const minimumDepth = Math.min(...availableDepths);
  const maximumDepth = Math.max(...availableDepths);
  const clampedDesiredDepth = Math.max(
    minimumDepth,
    Math.min(maximumDepth, desiredDepth),
  );
  const initialDepth = [...availableDepths]
    .filter((depth) => depth <= clampedDesiredDepth)
    .sort((left, right) => right - left)[0];

  if (initialDepth === undefined) {
    return [];
  }

  return [...availableDepths]
    .filter((depth) => depth <= initialDepth)
    .sort((left, right) => right - left);
}

/**
 * Creates an antichain through the visible portion of the loaded hierarchy.
 * Branches that reach `depth` contribute their exact-depth node, while an
 * irregular branch that ends sooner contributes its deepest visible terminal
 * node. Additive ancestors are validated separately and remain renderable
 * behind this frontier.
 */
function createVisibleTreeCut(
  visibleNodes: readonly CopcHierarchyNodeSummary[],
  depth: number,
): readonly CopcHierarchyNodeSummary[] {
  const uniqueNodes = [
    ...new Map(
      visibleNodes
        .filter((node) => node.depth <= depth)
        .map((node) => [node.key, node]),
    ).values(),
  ].sort(
    (left, right) =>
      right.depth - left.depth || compareNodesByCoverageOrder(left, right),
  );
  const frontierNodes: CopcHierarchyNodeSummary[] = [];
  const frontierAncestorKeys = new Set<string>();

  for (const node of uniqueNodes) {
    if (frontierAncestorKeys.has(node.key)) {
      continue;
    }

    frontierNodes.push(node);
    let ancestorDepth = node.depth;
    let ancestorX = node.x;
    let ancestorY = node.y;
    let ancestorZ = node.z;

    while (ancestorDepth > 0) {
      ancestorDepth -= 1;
      ancestorX = Math.floor(ancestorX / 2);
      ancestorY = Math.floor(ancestorY / 2);
      ancestorZ = Math.floor(ancestorZ / 2);
      frontierAncestorKeys.add(
        `${ancestorDepth}-${ancestorX}-${ancestorY}-${ancestorZ}`,
      );
    }
  }

  return frontierNodes.sort(compareNodesByCoverageOrder);
}

function createMixedDepthAdditiveClosure(
  frontierNodes: readonly CopcHierarchyNodeSummary[],
  nodeByKey: ReadonlyMap<string, CopcHierarchyNodeSummary>,
): readonly CopcHierarchyNodeSummary[] | undefined {
  const closureByKey = new Map<string, CopcHierarchyNodeSummary>();

  for (const frontierNode of frontierNodes) {
    let current: CopcHierarchyNodeSummary | undefined = frontierNode;

    while (current) {
      closureByKey.set(current.key, current);

      if (current.depth === 0) {
        break;
      }

      current = nodeByKey.get(createParentNodeKey(current));

      if (!current) {
        return undefined;
      }
    }
  }

  return [...closureByKey.values()];
}

function createParentNodeKey(node: CopcHierarchyNodeSummary): string {
  return `${node.depth - 1}-${Math.floor(node.x / 2)}-${Math.floor(
    node.y / 2,
  )}-${Math.floor(node.z / 2)}`;
}

function fitsMixedDepthAdditiveBudget(
  nodes: readonly CopcHierarchyNodeSummary[],
  options: SelectBudgetedNodesOptions,
): boolean {
  if (
    nodes.length > options.maxNodes ||
    nodes.some((node) => isNodeOverIndividualBudget(node, options))
  ) {
    return false;
  }

  const pointCount = nodes.reduce(
    (total, node) => total + node.pointCount,
    0,
  );
  const pointDataLength = nodes.reduce(
    (total, node) => total + node.pointDataLength,
    0,
  );

  return (
    (options.maxTotalPointCount === undefined ||
      pointCount <= options.maxTotalPointCount) &&
    (options.maxTotalPointDataLength === undefined ||
      pointDataLength <= options.maxTotalPointDataLength)
  );
}

function createMixedDepthNodeViewState(
  node: CopcHierarchyNodeSummary,
  visibleCandidateKeys: ReadonlySet<string>,
  blockedRefinementParentKeys: ReadonlySet<string>,
  options: SelectMixedDepthCoverageNodesOptions,
): CopcMixedDepthNodeViewState {
  const estimatedNodeScreenPixels = estimateBoundsScreenPixels(
    node.bounds,
    options.screenSpaceOrigin,
    options.viewportHeightPixels,
  );
  const screenSpaceError =
    options.spacing === undefined
      ? estimatedNodeScreenPixels
      : estimateLinearScreenPixels(
          options.spacing / 2 ** node.depth,
          node.bounds,
          options.screenSpaceOrigin,
          options.viewportHeightPixels,
        );
  const boundedScreenPixels = Math.min(
    estimatedNodeScreenPixels,
    Math.sqrt(Number.MAX_SAFE_INTEGER),
  );
  const projectedAreaPixels = Math.max(
    1,
    boundedScreenPixels * boundedScreenPixels,
  );
  const visualBenefit = Math.min(
    Number.MAX_SAFE_INTEGER,
    screenSpaceError * projectedAreaPixels,
  );

  return {
    key: node.key,
    visible:
      node.depth >= options.minDepth &&
      visibleCandidateKeys.has(node.key) &&
      (node.depth === 0 ||
        !blockedRefinementParentKeys.has(createParentNodeKey(node))),
    screenSpaceError,
    projectedAreaPixels,
    visualBenefit,
  };
}

function normalizeMixedDepthTotalBudget(
  value: number | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function selectCompleteCoverageDepth(
  candidatesByDepth: ReadonlyMap<
    number,
    readonly CopcHierarchyNodeSummary[]
  >,
  availableDepths: readonly number[],
  targetDepth: number,
  options: SelectBudgetedNodesOptions,
): BudgetedNodeSelection | undefined {
  let skippedByBudgetCount = 0;

  for (const depth of coverageDepthsByTarget(availableDepths, targetDepth)) {
    const candidates = candidatesByDepth.get(depth) ?? [];

    if (candidates.length === 0) {
      continue;
    }

    if (isSparseCoverageDepth(candidatesByDepth, depth, candidates.length)) {
      skippedByBudgetCount += candidates.length;
      continue;
    }

    if (candidates.length > options.maxNodes) {
      skippedByBudgetCount += candidates.length - options.maxNodes;
      continue;
    }

    const selection = selectCompleteDepthWithinBudget(candidates, options);

    skippedByBudgetCount += selection.skippedByBudgetCount;

    if (selection.nodes.length === candidates.length) {
      return {
        nodes: orderCoverageNodesByTarget(selection.nodes, options.target),
        selectedDepth: depth,
        skippedByBudgetCount,
      };
    }
  }

  return undefined;
}

function addProgressiveCoverageDetail(
  completeSelection: BudgetedNodeSelection | undefined,
  candidatesByDepth: ReadonlyMap<
    number,
    readonly CopcHierarchyNodeSummary[]
  >,
  availableDepths: readonly number[],
  targetDepth: number,
  options: SelectBudgetedNodesOptions,
): BudgetedNodeSelection | undefined {
  const remainingOptions = subtractSelectedNodeBudget(
    options,
    completeSelection?.nodes ?? [],
  );

  if (remainingOptions.maxNodes <= 0) {
    return completeSelection;
  }

  const detailSelection = selectProgressiveCoverageDetail(
    candidatesByDepth,
    availableDepths,
    targetDepth,
    completeSelection?.selectedDepth,
    remainingOptions,
  );

  if (!detailSelection) {
    return completeSelection;
  }

  if (!completeSelection) {
    return detailSelection;
  }

  return mergeBudgetedSelections(completeSelection, detailSelection);
}

function selectProgressiveCoverageDetail(
  candidatesByDepth: ReadonlyMap<
    number,
    readonly CopcHierarchyNodeSummary[]
  >,
  availableDepths: readonly number[],
  targetDepth: number,
  completeCoverageDepth: number | undefined,
  options: SelectBudgetedNodesOptions,
): BudgetedNodeSelection | undefined {
  for (const depth of progressiveCoverageDepthsByTarget(
    availableDepths,
    targetDepth,
    completeCoverageDepth,
  )) {
    const candidates = candidatesByDepth.get(depth) ?? [];

    if (candidates.length === 0) {
      continue;
    }

    const selection = selectWithinBudget(
      orderPartialCoverageNodes(candidates, options.target, options.maxNodes),
      options,
    );

    if (selection.nodes.length > 0) {
      return {
        ...selection,
        selectedDepth: depth,
      };
    }
  }

  return undefined;
}

function subtractSelectedNodeBudget(
  options: SelectBudgetedNodesOptions,
  nodes: readonly CopcHierarchyNodeSummary[],
): SelectBudgetedNodesOptions {
  const selectedPointCount = nodes.reduce(
    (total, node) => total + node.pointCount,
    0,
  );
  const selectedPointDataLength = nodes.reduce(
    (total, node) => total + node.pointDataLength,
    0,
  );

  return {
    ...options,
    maxNodes: Math.max(0, options.maxNodes - nodes.length),
    maxTotalPointCount:
      options.maxTotalPointCount === undefined
        ? undefined
        : Math.max(0, options.maxTotalPointCount - selectedPointCount),
    maxTotalPointDataLength:
      options.maxTotalPointDataLength === undefined
        ? undefined
        : Math.max(0, options.maxTotalPointDataLength - selectedPointDataLength),
  };
}

function mergeBudgetedSelections(
  coverageSelection: BudgetedNodeSelection,
  detailSelection: BudgetedNodeSelection,
): BudgetedNodeSelection {
  const nodesByKey = new Map<string, CopcHierarchyNodeSummary>();

  coverageSelection.nodes.forEach((node) => nodesByKey.set(node.key, node));
  detailSelection.nodes.forEach((node) => nodesByKey.set(node.key, node));

  const nodes = [...nodesByKey.values()];

  return {
    nodes,
    selectedDepth: maxNodeDepth(nodes),
    skippedByBudgetCount:
      coverageSelection.skippedByBudgetCount +
      detailSelection.skippedByBudgetCount,
  };
}

function selectCompleteDepthWithinBudget(
  nodes: readonly CopcHierarchyNodeSummary[],
  options: SelectBudgetedNodesOptions,
): Omit<BudgetedNodeSelection, "selectedDepth"> {
  const selectedNodes: CopcHierarchyNodeSummary[] = [];
  let selectedPointCount = 0;
  let selectedPointDataLength = 0;
  let skippedByBudgetCount = 0;

  for (const node of nodes) {
    if (
      isNodeOverIndividualBudget(node, options) ||
      isNodeOverTotalBudget(
        node,
        selectedPointCount,
        selectedPointDataLength,
        options,
      )
    ) {
      skippedByBudgetCount = nodes.length;
      return {
        nodes: [],
        skippedByBudgetCount,
      };
    }

    selectedNodes.push(node);
    selectedPointCount += node.pointCount;
    selectedPointDataLength += node.pointDataLength;
  }

  return {
    nodes: selectedNodes,
    skippedByBudgetCount,
  };
}

function isSparseCoverageDepth(
  candidatesByDepth: ReadonlyMap<number, readonly CopcHierarchyNodeSummary[]>,
  depth: number,
  candidateCount: number,
): boolean {
  const nearestShallowerDepth = [...candidatesByDepth.keys()]
    .filter((candidateDepth) => candidateDepth < depth)
    .sort((left, right) => right - left)[0];

  if (nearestShallowerDepth === undefined) {
    return false;
  }

  const shallowerCount = candidatesByDepth.get(nearestShallowerDepth)?.length ?? 0;

  return shallowerCount > 0 && candidateCount < shallowerCount;
}

function coverageDepthsByTarget(
  availableDepths: readonly number[],
  targetDepth: number,
): number[] {
  const shallowerOrTarget = [...availableDepths]
    .filter((depth) => depth <= targetDepth)
    .sort((left, right) => right - left);
  const deeperFallbacks = [...availableDepths]
    .filter((depth) => depth > targetDepth)
    .sort((left, right) => left - right);

  return [...shallowerOrTarget, ...deeperFallbacks];
}

function progressiveCoverageDepthsByTarget(
  availableDepths: readonly number[],
  targetDepth: number,
  completeCoverageDepth: number | undefined,
): number[] {
  return [...availableDepths]
    .filter(
      (depth) =>
        completeCoverageDepth === undefined || depth > completeCoverageDepth,
    )
    .sort(
      (left, right) =>
        Math.abs(left - targetDepth) - Math.abs(right - targetDepth) ||
        right - left,
    );
}

function compareNodesByCoverageOrder(
  left: CopcHierarchyNodeSummary,
  right: CopcHierarchyNodeSummary,
): number {
  return (
    left.x - right.x ||
    left.y - right.y ||
    left.z - right.z ||
    left.key.localeCompare(right.key)
  );
}

function orderPartialCoverageNodes(
  nodes: readonly CopcHierarchyNodeSummary[],
  target: CopcTargetPoint,
  maxNodes: number,
): readonly CopcHierarchyNodeSummary[] {
  if (nodes.length <= maxNodes) {
    return orderCoverageNodesByTarget(nodes, target);
  }

  const buckets = new Map<string, CopcHierarchyNodeSummary[]>();
  const bucketAxisCount = Math.max(1, Math.ceil(Math.sqrt(maxNodes)));
  const xValues = nodes.map((node) => node.x);
  const yValues = nodes.map((node) => node.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);

  nodes.forEach((node) => {
    const bucketKey = createCoverageBucketKey(
      node,
      minX,
      maxX,
      minY,
      maxY,
      bucketAxisCount,
    );
    buckets.set(bucketKey, [...(buckets.get(bucketKey) ?? []), node]);
  });

  const orderedBucketKeys = [...buckets.entries()]
    .map(([bucketKey, bucketNodes]) => ({
      bucketKey,
      distanceToTarget: Math.min(
        ...bucketNodes.map((node) => distanceToBounds3d(target, node.bounds)),
      ),
    }))
    .sort(
      (left, right) =>
        left.distanceToTarget - right.distanceToTarget ||
        left.bucketKey.localeCompare(right.bucketKey),
    )
    .map(({ bucketKey }) => bucketKey);

  buckets.forEach((bucketNodes, bucketKey) => {
    buckets.set(bucketKey, [...orderCoverageNodesByTarget(bucketNodes, target)]);
  });

  const orderedNodes: CopcHierarchyNodeSummary[] = [];
  let hasRemainingNodes = true;

  while (hasRemainingNodes) {
    hasRemainingNodes = false;

    orderedBucketKeys.forEach((bucketKey) => {
      const bucket = buckets.get(bucketKey);
      const node = bucket?.shift();

      if (node) {
        orderedNodes.push(node);
        hasRemainingNodes = true;
      }
    });
  }

  return orderedNodes;
}

function createCoverageBucketKey(
  node: CopcHierarchyNodeSummary,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  bucketAxisCount: number,
): string {
  const bucketX = normalizeCoverageBucketCoordinate(
    node.x,
    minX,
    maxX,
    bucketAxisCount,
  );
  const bucketY = normalizeCoverageBucketCoordinate(
    node.y,
    minY,
    maxY,
    bucketAxisCount,
  );

  return `${bucketX}:${bucketY}`;
}

function normalizeCoverageBucketCoordinate(
  value: number,
  min: number,
  max: number,
  bucketAxisCount: number,
): number {
  if (max <= min) {
    return 0;
  }

  return Math.max(
    0,
    Math.min(
      bucketAxisCount - 1,
      Math.floor(((value - min) / (max - min + 1)) * bucketAxisCount),
    ),
  );
}

function orderCoverageNodesByTarget(
  nodes: readonly CopcHierarchyNodeSummary[],
  target: CopcTargetPoint,
): readonly CopcHierarchyNodeSummary[] {
  return [...nodes].sort(
    (left, right) =>
      distanceToBounds3d(target, left.bounds) -
        distanceToBounds3d(target, right.bounds) ||
      compareNodesByCoverageOrder(left, right),
  );
}

function orderNodeCandidates(
  candidates: readonly NodeDistanceCandidate[],
): readonly NodeDistanceCandidate[] {
  return [...candidates].sort(compareNodeCandidatesByNearest);
}

function compareNodeCandidatesByNearest(
  left: NodeDistanceCandidate,
  right: NodeDistanceCandidate,
): number {
  return (
    left.distanceToBounds - right.distanceToBounds ||
    right.node.depth - left.node.depth ||
    right.node.pointCount - left.node.pointCount ||
    left.node.key.localeCompare(right.node.key)
  );
}

function depthsByTargetDistance(
  availableDepths: readonly number[],
  targetDepth: number,
): number[] {
  return [...availableDepths].sort(
    (left, right) =>
      Math.abs(left - targetDepth) - Math.abs(right - targetDepth) ||
      right - left,
  );
}

function selectWithinBudget(
  nodes: readonly CopcHierarchyNodeSummary[],
  options: SelectBudgetedNodesOptions,
): Omit<BudgetedNodeSelection, "selectedDepth"> {
  const selectedNodes: CopcHierarchyNodeSummary[] = [];
  let selectedPointCount = 0;
  let selectedPointDataLength = 0;
  let skippedByBudgetCount = 0;

  for (const node of nodes) {
    if (selectedNodes.length >= options.maxNodes) {
      break;
    }

    if (
      isNodeOverIndividualBudget(node, options) ||
      isNodeOverTotalBudget(
        node,
        selectedPointCount,
        selectedPointDataLength,
        options,
      )
    ) {
      skippedByBudgetCount += 1;
      continue;
    }

    selectedNodes.push(node);
    selectedPointCount += node.pointCount;
    selectedPointDataLength += node.pointDataLength;
  }

  return {
    nodes: selectedNodes,
    skippedByBudgetCount,
  };
}

function isNodeOverIndividualBudget(
  node: CopcHierarchyNodeSummary,
  options: SelectBudgetedNodesOptions,
): boolean {
  return (
    (options.maxNodePointCount !== undefined &&
      node.pointCount > options.maxNodePointCount) ||
    (options.maxNodePointDataLength !== undefined &&
      node.pointDataLength > options.maxNodePointDataLength)
  );
}

function isNodeOverTotalBudget(
  node: CopcHierarchyNodeSummary,
  selectedPointCount: number,
  selectedPointDataLength: number,
  options: SelectBudgetedNodesOptions,
): boolean {
  return (
    (options.maxTotalPointCount !== undefined &&
      selectedPointCount + node.pointCount > options.maxTotalPointCount) ||
    (options.maxTotalPointDataLength !== undefined &&
      selectedPointDataLength + node.pointDataLength >
        options.maxTotalPointDataLength)
  );
}

function validatePositiveFiniteBudget(
  value: number | undefined,
  name: string,
): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
}

function validateNonNegativeFiniteOption(
  value: number | undefined,
  name: string,
): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }
}

function validateViewAngle(maxViewAngleDegrees: number | undefined): void {
  if (maxViewAngleDegrees === undefined) {
    return;
  }

  if (
    !Number.isFinite(maxViewAngleDegrees) ||
    maxViewAngleDegrees <= 0 ||
    maxViewAngleDegrees >= 180
  ) {
    throw new Error("maxViewAngleDegrees must be between 0 and 180 degrees.");
  }
}

function boundsForHierarchy(
  nodes: readonly CopcHierarchyNodeSummary[],
): CopcBounds {
  const rootNode = nodes.find((node) => node.depth === 0);

  if (rootNode) {
    return rootNode.bounds;
  }

  return nodes.reduce<CopcBounds>(
    (bounds, node) => ({
      minX: Math.min(bounds.minX, node.bounds.minX),
      minY: Math.min(bounds.minY, node.bounds.minY),
      minZ: Math.min(bounds.minZ, node.bounds.minZ),
      maxX: Math.max(bounds.maxX, node.bounds.maxX),
      maxY: Math.max(bounds.maxY, node.bounds.maxY),
      maxZ: Math.max(bounds.maxZ, node.bounds.maxZ),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    },
  );
}

function horizontalSpan(bounds: CopcBounds): number {
  return Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
}

function estimateBoundsScreenPixels(
  bounds: CopcBounds,
  target: CopcTargetPoint,
  viewportHeightPixels: number,
): number {
  return estimateLinearScreenPixels(
    horizontalSpan(bounds),
    bounds,
    target,
    viewportHeightPixels,
  );
}

function estimateLinearScreenPixels(
  size: number,
  bounds: CopcBounds,
  target: CopcTargetPoint,
  viewportHeightPixels: number,
): number {
  const safeSize = Math.max(size, Number.EPSILON);
  const distance = Math.max(distanceToBounds3d(target, bounds), safeSize);

  return (safeSize / distance) * viewportHeightPixels;
}

function distanceToBounds3d(target: CopcTargetPoint, bounds: CopcBounds): number {
  return Math.hypot(
    distanceToRange(target.x, bounds.minX, bounds.maxX),
    distanceToRange(target.y, bounds.minY, bounds.maxY),
    distanceToRange(target.z, bounds.minZ, bounds.maxZ),
  );
}

function distanceToRange(value: number, min: number, max: number): number {
  if (value < min) {
    return min - value;
  }

  if (value > max) {
    return value - max;
  }

  return 0;
}

function isBoundsInsideViewCone(
  bounds: CopcBounds,
  target: CopcTargetPoint,
  viewDirection: CopcTargetVector,
  cosMaxViewAngle: number,
): boolean {
  if (isPointInsideBounds(target, bounds)) {
    return true;
  }

  const center = boundsCenter(bounds);
  const toCenter = {
    x: center.x - target.x,
    y: center.y - target.y,
    z: center.z - target.z,
  };
  const centerDistance = vectorLength(toCenter);

  if (centerDistance <= Number.EPSILON) {
    return true;
  }

  const directionLength = vectorLength(viewDirection);
  const alignment =
    dotVectors(toCenter, viewDirection) / (centerDistance * directionLength);
  const angularRadiusSlack =
    boundsRadius(bounds) / Math.max(centerDistance, Number.EPSILON);

  return alignment >= cosMaxViewAngle - angularRadiusSlack;
}

function isPointInsideBounds(
  point: CopcTargetPoint,
  bounds: CopcBounds,
): boolean {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY &&
    point.z >= bounds.minZ &&
    point.z <= bounds.maxZ
  );
}

function boundsCenter(bounds: CopcBounds): CopcTargetPoint {
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    z: (bounds.minZ + bounds.maxZ) / 2,
  };
}

function boundsRadius(bounds: CopcBounds): number {
  return (
    Math.hypot(
      bounds.maxX - bounds.minX,
      bounds.maxY - bounds.minY,
      bounds.maxZ - bounds.minZ,
    ) / 2
  );
}

function dotVectors(
  left: CopcTargetVector,
  right: CopcTargetVector,
): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function vectorLength(vector: CopcTargetVector): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function degreesToRadians(degrees: number): number {
  return (degrees / 180) * Math.PI;
}
