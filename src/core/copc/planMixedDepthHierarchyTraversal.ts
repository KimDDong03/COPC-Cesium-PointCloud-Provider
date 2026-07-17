import type { CopcHierarchyNodeSummary } from "./CopcHierarchySummary";

/**
 * View-dependent data supplied by a camera adapter. The core traversal does
 * not depend on Cesium (or any other renderer) and only consumes these values.
 */
export interface CopcMixedDepthNodeViewState {
  readonly key: string;
  readonly visible: boolean;
  readonly screenSpaceError: number;
  /**
   * Optional screen coverage used by the default visual-benefit estimate.
   * Defaults to one when the caller does not have a projected-area estimate.
   */
  readonly projectedAreaPixels?: number;
  /**
   * Overrides the default `screenSpaceError * projectedAreaPixels` benefit.
   * This lets a caller account for foveation, occlusion, or application value.
   */
  readonly visualBenefit?: number;
  /**
   * Whether decoded point data is ready to render. Omitted values default to
   * true so callers can use the planner before wiring a residency manager.
   */
  readonly ready?: boolean;
}

export type CopcMixedDepthRefinementMode =
  | "node"
  | "visible-sibling-group";

export interface PlanMixedDepthHierarchyTraversalOptions {
  readonly maxNodes: number;
  readonly maxPointCount?: number;
  readonly maxPointDataLength?: number;
  /**
   * Baseline coverage nodes that must survive refinement. Their complete
   * ancestor closure is reserved before benefit/cost candidates compete for
   * the remaining budget.
   */
  readonly requiredNodeKeys?: readonly string[];
  /**
   * `node` preserves the low-level greedy behavior. `visible-sibling-group`
   * refines one current frontier node only when all of its immediate visible,
   * renderable children fit as an atomic group.
   */
  readonly refinementMode?: CopcMixedDepthRefinementMode;
  /** New refinements enter at or above this screen-space error. Defaults to 16. */
  readonly refineScreenSpaceError?: number;
  /**
   * A previous frontier remains eligible down to this lower threshold.
   * Defaults to 75% of `refineScreenSpaceError`.
   */
  readonly retainScreenSpaceError?: number;
  readonly previousFrontierKeys?: readonly string[];
}

export interface CopcMixedDepthBudgetUsage {
  readonly nodeCount: number;
  readonly pointCount: number;
  readonly pointDataLength: number;
}

export interface CopcMixedDepthBudgetLimits {
  readonly maxNodes: number;
  readonly maxPointCount: number | undefined;
  readonly maxPointDataLength: number | undefined;
}

export interface CopcMixedDepthTraversalDiagnostics {
  readonly refinementMode: CopcMixedDepthRefinementMode;
  readonly requiredCoverageNodeCount: number;
  readonly requiredCoverageClosureNodeCount: number;
  readonly requiredCoverageBudgetUsage: CopcMixedDepthBudgetUsage;
  readonly eligibleCandidateCount: number;
  readonly selectedCandidateCount: number;
  readonly skippedByVisibilityCount: number;
  readonly skippedByScreenSpaceErrorCount: number;
  readonly skippedByMissingAncestorCount: number;
  readonly skippedByBudgetCount: number;
  readonly ignoredViewStateCount: number;
  readonly selectedVisualBenefit: number;
  readonly isBudgetLimited: boolean;
}

export type CopcMixedDepthRequiredCoverageErrorReason =
  | "unknown-node"
  | "non-renderable-node"
  | "missing-ancestor"
  | "budget-exceeded";

/**
 * Signals that the required baseline cannot be represented safely. Returning
 * a partial plan in these cases would leave visible regions uncovered, so the
 * planner fails before optional refinement begins.
 */
export class CopcMixedDepthRequiredCoverageError extends Error {
  readonly code = "COPC_MIXED_DEPTH_REQUIRED_COVERAGE" as const;
  readonly reason: CopcMixedDepthRequiredCoverageErrorReason;
  readonly nodeKey: string | undefined;
  readonly missingAncestorKey: string | undefined;
  readonly requiredBudgetUsage: CopcMixedDepthBudgetUsage | undefined;
  readonly budgetLimits: CopcMixedDepthBudgetLimits | undefined;

  constructor(options: {
    readonly reason: CopcMixedDepthRequiredCoverageErrorReason;
    readonly message: string;
    readonly nodeKey?: string;
    readonly missingAncestorKey?: string;
    readonly requiredBudgetUsage?: CopcMixedDepthBudgetUsage;
    readonly budgetLimits?: CopcMixedDepthBudgetLimits;
  }) {
    super(options.message);
    this.name = "CopcMixedDepthRequiredCoverageError";
    this.reason = options.reason;
    this.nodeKey = options.nodeKey;
    this.missingAncestorKey = options.missingAncestorKey;
    this.requiredBudgetUsage = options.requiredBudgetUsage;
    this.budgetLimits = options.budgetLimits;
  }
}

/**
 * A mixed-depth additive plan.
 *
 * `plannedNodes` is ancestor-closed and is the set a residency manager should
 * keep or request. `frontierNodes` is the deepest selected node on each chosen
 * branch, while `ancestorNodes` contains the additive coarse samples that must
 * remain alongside those frontiers.
 *
 * `renderNodes` is also ancestor-closed, but only includes ready prefixes. A
 * ready descendant behind an unready parent is placed in `blockedNodes` rather
 * than rendered with a coverage hole. `retainedParentNodes` identifies the
 * ready coarse frontier held while deeper planned data is not ready.
 */
export interface CopcMixedDepthHierarchyTraversalPlan {
  readonly plannedNodes: readonly CopcHierarchyNodeSummary[];
  readonly frontierNodes: readonly CopcHierarchyNodeSummary[];
  readonly ancestorNodes: readonly CopcHierarchyNodeSummary[];
  readonly renderNodes: readonly CopcHierarchyNodeSummary[];
  readonly renderFrontierNodes: readonly CopcHierarchyNodeSummary[];
  readonly requestNodes: readonly CopcHierarchyNodeSummary[];
  readonly blockedNodes: readonly CopcHierarchyNodeSummary[];
  readonly retainedParentNodes: readonly CopcHierarchyNodeSummary[];
  readonly retainedPreviousFrontierKeys: readonly string[];
  readonly droppedPreviousFrontierKeys: readonly string[];
  readonly budgetUsage: CopcMixedDepthBudgetUsage;
  readonly budgetLimits: CopcMixedDepthBudgetLimits;
  readonly diagnostics: CopcMixedDepthTraversalDiagnostics;
}

interface EligibleCandidate {
  readonly node: CopcHierarchyNodeSummary;
  readonly visualBenefit: number;
}

interface ScoredCandidate {
  readonly candidate: EligibleCandidate;
  readonly missingNodes: readonly CopcHierarchyNodeSummary[];
  readonly usage: CopcMixedDepthBudgetUsage;
  readonly marginalVisualBenefit: number;
  readonly normalizedCost: number;
  readonly score: number;
}

interface ScoredSiblingGroup {
  readonly parent: CopcHierarchyNodeSummary;
  readonly children: readonly CopcHierarchyNodeSummary[];
  readonly missingNodes: readonly CopcHierarchyNodeSummary[];
  readonly usage: CopcMixedDepthBudgetUsage;
  readonly marginalVisualBenefit: number;
  readonly normalizedCost: number;
  readonly score: number;
}

interface RefinementSelectionResult {
  readonly budgetUsage: CopcMixedDepthBudgetUsage;
  readonly eligibleCandidateCount: number;
  readonly selectedCandidateCount: number;
  readonly skippedByMissingAncestorCount: number;
  readonly skippedByBudgetCount: number;
  readonly selectedVisualBenefit: number;
}

interface RequiredCoverageSelection {
  readonly requiredNodeCount: number;
  readonly closureNodes: readonly CopcHierarchyNodeSummary[];
  readonly usage: CopcMixedDepthBudgetUsage;
}

const DEFAULT_REFINE_SCREEN_SPACE_ERROR = 16;
const DEFAULT_RETAIN_SCREEN_SPACE_ERROR_RATIO = 0.75;
const DEFAULT_REFINEMENT_MODE: CopcMixedDepthRefinementMode = "node";

export function planMixedDepthHierarchyTraversal(
  nodes: readonly CopcHierarchyNodeSummary[],
  viewStates: readonly CopcMixedDepthNodeViewState[],
  options: PlanMixedDepthHierarchyTraversalOptions,
): CopcMixedDepthHierarchyTraversalPlan {
  const budgetLimits = validateOptions(options);
  const refinementMode = readRefinementMode(options.refinementMode);
  const nodeByKey = indexNodes(nodes);
  const viewStateByKey = indexViewStates(viewStates);
  const requiredCoverage = createRequiredCoverageSelection(
    options.requiredNodeKeys ?? [],
    nodeByKey,
    budgetLimits,
  );

  if (
    refinementMode === "visible-sibling-group" &&
    requiredCoverage.requiredNodeCount === 0
  ) {
    throw new Error(
      'requiredNodeKeys must contain a coverage baseline when refinementMode is "visible-sibling-group".',
    );
  }
  const previousFrontierKeys = new Set(options.previousFrontierKeys ?? []);
  const refineScreenSpaceError =
    options.refineScreenSpaceError ?? DEFAULT_REFINE_SCREEN_SPACE_ERROR;
  const retainScreenSpaceError =
    options.retainScreenSpaceError ??
    refineScreenSpaceError * DEFAULT_RETAIN_SCREEN_SPACE_ERROR_RATIO;
  const candidateBenefitByKey = new Map<string, number>();
  const visualBenefitByKey = new Map<string, number>();
  const candidates: EligibleCandidate[] = [];
  let skippedByVisibilityCount = 0;
  let skippedByScreenSpaceErrorCount = 0;

  for (const node of nodes) {
    const viewState = viewStateByKey.get(node.key);

    if (
      viewState === undefined ||
      !viewState.visible ||
      node.pointCount <= 0 ||
      node.pointDataLength <= 0
    ) {
      skippedByVisibilityCount += 1;
      continue;
    }

    // A visible root is coarse coverage, not a refinement decision. Keep it
    // eligible even after its own error falls below the refinement threshold.
    const isCoverageRoot = node.depth === 0;
    const screenSpaceErrorThreshold = previousFrontierKeys.has(node.key)
      ? retainScreenSpaceError
      : refineScreenSpaceError;
    const visualBenefit = Math.max(
      estimateVisualBenefit(viewState),
      isCoverageRoot ? Number.EPSILON : 0,
    );
    visualBenefitByKey.set(node.key, visualBenefit);

    if (
      (!isCoverageRoot &&
        viewState.screenSpaceError < screenSpaceErrorThreshold) ||
      visualBenefit <= 0
    ) {
      skippedByScreenSpaceErrorCount += 1;
      continue;
    }

    candidateBenefitByKey.set(node.key, visualBenefit);
    candidates.push({ node, visualBenefit });
  }

  const ancestorPathByKey = new Map<
    string,
    readonly CopcHierarchyNodeSummary[] | undefined
  >();
  const selectableCandidates: EligibleCandidate[] = [];
  let skippedByMissingAncestorCount = 0;

  for (const candidate of candidates) {
    const path = findAncestorPath(candidate.node, nodeByKey);
    ancestorPathByKey.set(candidate.node.key, path);

    if (path === undefined) {
      skippedByMissingAncestorCount += 1;
    } else {
      selectableCandidates.push(candidate);
    }
  }

  const selectedKeys = new Set(
    requiredCoverage.closureNodes.map((node) => node.key),
  );
  const refinementSelection =
    refinementMode === "visible-sibling-group"
      ? selectVisibleSiblingGroupRefinements({
          nodeByKey,
          viewStateByKey,
          visualBenefitByKey,
          selectedKeys,
          initialBudgetUsage: requiredCoverage.usage,
          budgetLimits,
          refineScreenSpaceError,
          retainScreenSpaceError,
          previousFrontierKeys,
        })
      : selectNodeRefinements({
          candidates,
          selectableCandidates,
          skippedByMissingAncestorCount,
          ancestorPathByKey,
          candidateBenefitByKey,
          selectedKeys,
          initialBudgetUsage: requiredCoverage.usage,
          budgetLimits,
        });
  const budgetUsage = refinementSelection.budgetUsage;

  const plannedNodes = sortNodes(
    nodes.filter((node) => selectedKeys.has(node.key)),
  );
  const frontierNodes = findFrontierNodes(plannedNodes);
  const frontierKeys = new Set(frontierNodes.map((node) => node.key));
  const ancestorNodes = plannedNodes.filter(
    (node) => !frontierKeys.has(node.key),
  );
  const renderNodes = findRenderableNodes(
    plannedNodes,
    viewStateByKey,
  );
  const renderFrontierNodes = findFrontierNodes(renderNodes);
  const renderKeys = new Set(renderNodes.map((node) => node.key));
  const requestNodes = plannedNodes.filter(
    (node) => !(viewStateByKey.get(node.key)?.ready ?? true),
  );
  const blockedNodes = plannedNodes.filter(
    (node) =>
      (viewStateByKey.get(node.key)?.ready ?? true) &&
      !renderKeys.has(node.key),
  );
  const retainedParentNodes = renderFrontierNodes.filter(
    (node) => !frontierKeys.has(node.key),
  );
  const retainedPreviousFrontierKeys = sortKnownKeys(
    [...previousFrontierKeys].filter((key) => selectedKeys.has(key)),
    nodeByKey,
  );
  const droppedPreviousFrontierKeys = sortKnownKeys(
    [...previousFrontierKeys].filter((key) => !selectedKeys.has(key)),
    nodeByKey,
  );
  return {
    plannedNodes,
    frontierNodes,
    ancestorNodes,
    renderNodes,
    renderFrontierNodes,
    requestNodes,
    blockedNodes,
    retainedParentNodes,
    retainedPreviousFrontierKeys,
    droppedPreviousFrontierKeys,
    budgetUsage,
    budgetLimits,
    diagnostics: {
      refinementMode,
      requiredCoverageNodeCount: requiredCoverage.requiredNodeCount,
      requiredCoverageClosureNodeCount:
        requiredCoverage.closureNodes.length,
      requiredCoverageBudgetUsage: requiredCoverage.usage,
      eligibleCandidateCount:
        refinementSelection.eligibleCandidateCount,
      selectedCandidateCount:
        refinementSelection.selectedCandidateCount,
      skippedByVisibilityCount,
      skippedByScreenSpaceErrorCount,
      skippedByMissingAncestorCount:
        refinementSelection.skippedByMissingAncestorCount,
      skippedByBudgetCount: refinementSelection.skippedByBudgetCount,
      ignoredViewStateCount: viewStates.filter(
        (viewState) => !nodeByKey.has(viewState.key),
      ).length,
      selectedVisualBenefit: refinementSelection.selectedVisualBenefit,
      isBudgetLimited: refinementSelection.skippedByBudgetCount > 0,
    },
  };
}

function selectNodeRefinements(options: {
  readonly candidates: readonly EligibleCandidate[];
  readonly selectableCandidates: readonly EligibleCandidate[];
  readonly skippedByMissingAncestorCount: number;
  readonly ancestorPathByKey: ReadonlyMap<
    string,
    readonly CopcHierarchyNodeSummary[] | undefined
  >;
  readonly candidateBenefitByKey: ReadonlyMap<string, number>;
  readonly selectedKeys: Set<string>;
  readonly initialBudgetUsage: CopcMixedDepthBudgetUsage;
  readonly budgetLimits: CopcMixedDepthBudgetLimits;
}): RefinementSelectionResult {
  let budgetUsage = options.initialBudgetUsage;

  while (true) {
    const scoredCandidates = options.selectableCandidates
      .filter((candidate) => !options.selectedKeys.has(candidate.node.key))
      .map((candidate) =>
        scoreCandidate(
          candidate,
          options.ancestorPathByKey.get(candidate.node.key),
          options.selectedKeys,
          options.candidateBenefitByKey,
          options.budgetLimits,
        ),
      )
      .filter(
        (candidate): candidate is ScoredCandidate =>
          candidate !== undefined &&
          fitsBudget(budgetUsage, candidate.usage, options.budgetLimits),
      )
      .sort(compareScoredCandidates);
    const bestCandidate = scoredCandidates[0];

    if (bestCandidate === undefined) {
      break;
    }

    for (const node of bestCandidate.missingNodes) {
      options.selectedKeys.add(node.key);
    }

    budgetUsage = addBudgetUsage(budgetUsage, bestCandidate.usage);
  }

  const selectedCandidateCount = options.selectableCandidates.filter(
    (candidate) => options.selectedKeys.has(candidate.node.key),
  ).length;

  return {
    budgetUsage,
    eligibleCandidateCount: options.candidates.length,
    selectedCandidateCount,
    skippedByMissingAncestorCount: options.skippedByMissingAncestorCount,
    skippedByBudgetCount:
      options.selectableCandidates.length - selectedCandidateCount,
    selectedVisualBenefit: options.selectableCandidates.reduce(
      (total, candidate) =>
        total +
        (options.selectedKeys.has(candidate.node.key)
          ? candidate.visualBenefit
          : 0),
      0,
    ),
  };
}

function selectVisibleSiblingGroupRefinements(options: {
  readonly nodeByKey: ReadonlyMap<string, CopcHierarchyNodeSummary>;
  readonly viewStateByKey: ReadonlyMap<
    string,
    CopcMixedDepthNodeViewState
  >;
  readonly visualBenefitByKey: ReadonlyMap<string, number>;
  readonly selectedKeys: Set<string>;
  readonly initialBudgetUsage: CopcMixedDepthBudgetUsage;
  readonly budgetLimits: CopcMixedDepthBudgetLimits;
  readonly refineScreenSpaceError: number;
  readonly retainScreenSpaceError: number;
  readonly previousFrontierKeys: ReadonlySet<string>;
}): RefinementSelectionResult {
  const childrenByParentKey = createVisibleRenderableChildrenByParentKey(
    options.nodeByKey,
    options.viewStateByKey,
  );
  const previousFrontierPathKeys = createPreviousFrontierPathKeys(
    options.previousFrontierKeys,
  );
  const eligibleGroupParentKeys = new Set<string>();
  const selectedGroupParentKeys = new Set<string>();
  const missingAncestorGroupParentKeys = new Set<string>();
  let selectedVisualBenefit = 0;
  let budgetUsage = options.initialBudgetUsage;

  while (true) {
    const frontierNodes = findFrontierNodes(
      sortNodes(
        [...options.selectedKeys]
          .map((key) => options.nodeByKey.get(key))
          .filter(
            (node): node is CopcHierarchyNodeSummary => node !== undefined,
          ),
      ),
    );
    const scoredGroups: ScoredSiblingGroup[] = [];

    for (const parent of frontierNodes) {
      const children = childrenByParentKey.get(parent.key) ?? [];

      if (
        children.length === 0 ||
        !isVisibleSiblingGroupTriggered(
          parent,
          children,
          options.viewStateByKey,
          options.visualBenefitByKey,
          previousFrontierPathKeys,
          options.refineScreenSpaceError,
          options.retainScreenSpaceError,
        )
      ) {
        continue;
      }

      eligibleGroupParentKeys.add(parent.key);
      const missingNodes = createMissingAncestorClosure(
        children,
        options.nodeByKey,
        options.selectedKeys,
      );

      if (missingNodes === undefined) {
        missingAncestorGroupParentKeys.add(parent.key);
        continue;
      }

      const usage = usageForNodes(missingNodes);
      const marginalVisualBenefit = children.reduce(
        (total, child) =>
          total + (options.visualBenefitByKey.get(child.key) ?? 0),
        0,
      );
      const normalizedCost = calculateNormalizedCost(
        usage,
        options.budgetLimits,
      );

      scoredGroups.push({
        parent,
        children,
        missingNodes,
        usage,
        marginalVisualBenefit,
        normalizedCost,
        score: marginalVisualBenefit / normalizedCost,
      });
    }

    const bestGroup = scoredGroups
      .filter((group) =>
        fitsBudget(budgetUsage, group.usage, options.budgetLimits),
      )
      .sort(compareScoredSiblingGroups)[0];

    if (bestGroup === undefined) {
      break;
    }

    for (const node of bestGroup.missingNodes) {
      options.selectedKeys.add(node.key);
    }

    selectedGroupParentKeys.add(bestGroup.parent.key);
    selectedVisualBenefit += bestGroup.marginalVisualBenefit;
    budgetUsage = addBudgetUsage(budgetUsage, bestGroup.usage);
  }

  const skippedByBudgetCount = [...eligibleGroupParentKeys].filter(
    (parentKey) =>
      !selectedGroupParentKeys.has(parentKey) &&
      !missingAncestorGroupParentKeys.has(parentKey),
  ).length;

  return {
    budgetUsage,
    eligibleCandidateCount: eligibleGroupParentKeys.size,
    selectedCandidateCount: selectedGroupParentKeys.size,
    skippedByMissingAncestorCount: missingAncestorGroupParentKeys.size,
    skippedByBudgetCount,
    selectedVisualBenefit,
  };
}

function createVisibleRenderableChildrenByParentKey(
  nodeByKey: ReadonlyMap<string, CopcHierarchyNodeSummary>,
  viewStateByKey: ReadonlyMap<string, CopcMixedDepthNodeViewState>,
): ReadonlyMap<string, readonly CopcHierarchyNodeSummary[]> {
  const childrenByParentKey = new Map<
    string,
    CopcHierarchyNodeSummary[]
  >();

  for (const node of nodeByKey.values()) {
    if (
      node.depth === 0 ||
      node.pointCount <= 0 ||
      node.pointDataLength <= 0 ||
      viewStateByKey.get(node.key)?.visible !== true
    ) {
      continue;
    }

    const parentKey = parentKeyForNode(node);
    childrenByParentKey.set(parentKey, [
      ...(childrenByParentKey.get(parentKey) ?? []),
      node,
    ]);
  }

  for (const children of childrenByParentKey.values()) {
    children.sort(compareNodes);
  }

  return childrenByParentKey;
}

function isVisibleSiblingGroupTriggered(
  parent: CopcHierarchyNodeSummary,
  children: readonly CopcHierarchyNodeSummary[],
  viewStateByKey: ReadonlyMap<string, CopcMixedDepthNodeViewState>,
  visualBenefitByKey: ReadonlyMap<string, number>,
  previousFrontierPathKeys: ReadonlySet<string>,
  refineScreenSpaceError: number,
  retainScreenSpaceError: number,
): boolean {
  const parentViewState = viewStateByKey.get(parent.key);
  const parentThreshold = previousFrontierPathKeys.has(parent.key)
    ? retainScreenSpaceError
    : refineScreenSpaceError;

  // The current frontier represents the error being replaced. Its children
  // can already be below the target threshold, which is exactly when the
  // parent needs to refine into them. Retain the child predicate below as a
  // compatibility fallback for callers that only provide child view states.
  if (
    parentViewState !== undefined &&
    parentViewState.visible &&
    (visualBenefitByKey.get(parent.key) ?? 0) > 0 &&
    parentViewState.screenSpaceError >= parentThreshold
  ) {
    return true;
  }

  return children.some((child) => {
    const viewState = viewStateByKey.get(child.key);

    if (viewState === undefined || (visualBenefitByKey.get(child.key) ?? 0) <= 0) {
      return false;
    }

    const threshold = previousFrontierPathKeys.has(child.key)
      ? retainScreenSpaceError
      : refineScreenSpaceError;

    return viewState.screenSpaceError >= threshold;
  });
}

function createPreviousFrontierPathKeys(
  previousFrontierKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  const pathKeys = new Set<string>();

  for (const nodeKey of previousFrontierKeys) {
    const [depth, x, y, z] = nodeKey.split("-").map(Number);

    if (
      !Number.isSafeInteger(depth) ||
      !Number.isSafeInteger(x) ||
      !Number.isSafeInteger(y) ||
      !Number.isSafeInteger(z) ||
      depth < 0
    ) {
      pathKeys.add(nodeKey);
      continue;
    }

    for (let ancestorDepth = depth; ancestorDepth >= 0; ancestorDepth -= 1) {
      const scale = 2 ** (depth - ancestorDepth);
      pathKeys.add(
        `${ancestorDepth}-${Math.floor(x / scale)}-${Math.floor(
          y / scale,
        )}-${Math.floor(z / scale)}`,
      );
    }
  }

  return pathKeys;
}

function createMissingAncestorClosure(
  nodes: readonly CopcHierarchyNodeSummary[],
  nodeByKey: ReadonlyMap<string, CopcHierarchyNodeSummary>,
  selectedKeys: ReadonlySet<string>,
): readonly CopcHierarchyNodeSummary[] | undefined {
  const missingNodeByKey = new Map<string, CopcHierarchyNodeSummary>();

  for (const node of nodes) {
    const path = findAncestorPath(node, nodeByKey);

    if (path === undefined) {
      return undefined;
    }

    for (const pathNode of path) {
      if (!selectedKeys.has(pathNode.key)) {
        missingNodeByKey.set(pathNode.key, pathNode);
      }
    }
  }

  return sortNodes([...missingNodeByKey.values()]);
}

function compareScoredSiblingGroups(
  left: ScoredSiblingGroup,
  right: ScoredSiblingGroup,
): number {
  return (
    right.score - left.score ||
    right.marginalVisualBenefit - left.marginalVisualBenefit ||
    left.normalizedCost - right.normalizedCost ||
    right.parent.depth - left.parent.depth ||
    compareNodes(left.parent, right.parent)
  );
}

function createRequiredCoverageSelection(
  requiredNodeKeys: readonly string[],
  nodeByKey: ReadonlyMap<string, CopcHierarchyNodeSummary>,
  budgetLimits: CopcMixedDepthBudgetLimits,
): RequiredCoverageSelection {
  const uniqueRequiredNodeKeys = [...new Set(requiredNodeKeys)];
  const closureNodeByKey = new Map<string, CopcHierarchyNodeSummary>();

  for (const requiredNodeKey of uniqueRequiredNodeKeys) {
    const requiredNode = nodeByKey.get(requiredNodeKey);

    if (requiredNode === undefined) {
      throw new CopcMixedDepthRequiredCoverageError({
        reason: "unknown-node",
        message: `Required COPC coverage node is not present in the hierarchy: ${requiredNodeKey}`,
        nodeKey: requiredNodeKey,
      });
    }

    if (
      requiredNode.pointCount <= 0 ||
      requiredNode.pointDataLength <= 0
    ) {
      throw new CopcMixedDepthRequiredCoverageError({
        reason: "non-renderable-node",
        message: `Required COPC coverage node is not renderable: ${requiredNodeKey}`,
        nodeKey: requiredNodeKey,
      });
    }

    const ancestorPath = findAncestorPath(requiredNode, nodeByKey);

    if (ancestorPath === undefined) {
      const missingAncestorKey = findFirstMissingAncestorKey(
        requiredNode,
        nodeByKey,
      );

      throw new CopcMixedDepthRequiredCoverageError({
        reason: "missing-ancestor",
        message: `Required COPC coverage node ${requiredNodeKey} is missing ancestor ${missingAncestorKey ?? "unknown"}.`,
        nodeKey: requiredNodeKey,
        missingAncestorKey,
      });
    }

    for (const ancestorNode of ancestorPath) {
      closureNodeByKey.set(ancestorNode.key, ancestorNode);
    }
  }

  const closureNodes = sortNodes([...closureNodeByKey.values()]);
  const usage = usageForNodes(closureNodes);

  if (!fitsBudget(emptyBudgetUsage(), usage, budgetLimits)) {
    throw new CopcMixedDepthRequiredCoverageError({
      reason: "budget-exceeded",
      message: createRequiredCoverageBudgetErrorMessage(usage, budgetLimits),
      requiredBudgetUsage: usage,
      budgetLimits,
    });
  }

  return {
    requiredNodeCount: uniqueRequiredNodeKeys.length,
    closureNodes,
    usage,
  };
}

function createRequiredCoverageBudgetErrorMessage(
  usage: CopcMixedDepthBudgetUsage,
  limits: CopcMixedDepthBudgetLimits,
): string {
  const exceededBudgets = [
    usage.nodeCount > limits.maxNodes
      ? `${usage.nodeCount.toLocaleString()} nodes / ${limits.maxNodes.toLocaleString()} max`
      : undefined,
    limits.maxPointCount !== undefined &&
    usage.pointCount > limits.maxPointCount
      ? `${usage.pointCount.toLocaleString()} points / ${limits.maxPointCount.toLocaleString()} max`
      : undefined,
    limits.maxPointDataLength !== undefined &&
    usage.pointDataLength > limits.maxPointDataLength
      ? `${usage.pointDataLength.toLocaleString()} bytes / ${limits.maxPointDataLength.toLocaleString()} max`
      : undefined,
  ].filter((value): value is string => value !== undefined);

  return `Required COPC coverage closure exceeds the traversal budget (${exceededBudgets.join(
    ", ",
  )}).`;
}

function validateOptions(
  options: PlanMixedDepthHierarchyTraversalOptions,
): CopcMixedDepthBudgetLimits {
  validatePositiveSafeInteger(options.maxNodes, "maxNodes");
  validateOptionalPositiveSafeInteger(
    options.maxPointCount,
    "maxPointCount",
  );
  validateOptionalPositiveSafeInteger(
    options.maxPointDataLength,
    "maxPointDataLength",
  );

  const refineScreenSpaceError =
    options.refineScreenSpaceError ?? DEFAULT_REFINE_SCREEN_SPACE_ERROR;
  const retainScreenSpaceError =
    options.retainScreenSpaceError ??
    refineScreenSpaceError * DEFAULT_RETAIN_SCREEN_SPACE_ERROR_RATIO;

  validateNonNegativeFiniteNumber(
    refineScreenSpaceError,
    "refineScreenSpaceError",
  );
  validateNonNegativeFiniteNumber(
    retainScreenSpaceError,
    "retainScreenSpaceError",
  );

  if (retainScreenSpaceError > refineScreenSpaceError) {
    throw new Error(
      "retainScreenSpaceError must be less than or equal to refineScreenSpaceError.",
    );
  }

  return {
    maxNodes: options.maxNodes,
    maxPointCount: options.maxPointCount,
    maxPointDataLength: options.maxPointDataLength,
  };
}

function readRefinementMode(
  value: CopcMixedDepthRefinementMode | undefined,
): CopcMixedDepthRefinementMode {
  const mode = value ?? DEFAULT_REFINEMENT_MODE;

  if (mode !== "node" && mode !== "visible-sibling-group") {
    throw new Error(
      'refinementMode must be "node" or "visible-sibling-group".',
    );
  }

  return mode;
}

function indexNodes(
  nodes: readonly CopcHierarchyNodeSummary[],
): Map<string, CopcHierarchyNodeSummary> {
  const nodeByKey = new Map<string, CopcHierarchyNodeSummary>();

  for (const node of nodes) {
    validateNode(node);

    if (nodeByKey.has(node.key)) {
      throw new Error(`Duplicate COPC hierarchy node key: ${node.key}`);
    }

    nodeByKey.set(node.key, node);
  }

  return nodeByKey;
}

function validateNode(node: CopcHierarchyNodeSummary): void {
  if (!Number.isSafeInteger(node.depth) || node.depth < 0) {
    throw new Error(`COPC hierarchy node ${node.key} has an invalid depth.`);
  }

  for (const [axis, value] of [
    ["x", node.x],
    ["y", node.y],
    ["z", node.z],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `COPC hierarchy node ${node.key} has an invalid ${axis} index.`,
      );
    }
  }

  const expectedKey = `${node.depth}-${node.x}-${node.y}-${node.z}`;

  if (node.key !== expectedKey) {
    throw new Error(
      `COPC hierarchy node key ${node.key} does not match ${expectedKey}.`,
    );
  }

  validateNonNegativeSafeInteger(
    node.pointCount,
    `pointCount for ${node.key}`,
  );
  validateNonNegativeSafeInteger(
    node.pointDataLength,
    `pointDataLength for ${node.key}`,
  );
}

function indexViewStates(
  viewStates: readonly CopcMixedDepthNodeViewState[],
): Map<string, CopcMixedDepthNodeViewState> {
  const viewStateByKey = new Map<string, CopcMixedDepthNodeViewState>();

  for (const viewState of viewStates) {
    if (viewStateByKey.has(viewState.key)) {
      throw new Error(`Duplicate mixed-depth view state key: ${viewState.key}`);
    }

    validateNonNegativeFiniteNumber(
      viewState.screenSpaceError,
      `screenSpaceError for ${viewState.key}`,
    );
    validateOptionalNonNegativeFiniteNumber(
      viewState.projectedAreaPixels,
      `projectedAreaPixels for ${viewState.key}`,
    );
    validateOptionalNonNegativeFiniteNumber(
      viewState.visualBenefit,
      `visualBenefit for ${viewState.key}`,
    );
    viewStateByKey.set(viewState.key, viewState);
  }

  return viewStateByKey;
}

function estimateVisualBenefit(
  viewState: CopcMixedDepthNodeViewState,
): number {
  return (
    viewState.visualBenefit ??
    viewState.screenSpaceError * (viewState.projectedAreaPixels ?? 1)
  );
}

function findAncestorPath(
  node: CopcHierarchyNodeSummary,
  nodeByKey: ReadonlyMap<string, CopcHierarchyNodeSummary>,
): readonly CopcHierarchyNodeSummary[] | undefined {
  const reversedPath: CopcHierarchyNodeSummary[] = [node];
  let current = node;

  while (current.depth > 0) {
    const parentKey = parentKeyForNode(current);
    const parent = nodeByKey.get(parentKey);

    if (parent === undefined) {
      return undefined;
    }

    reversedPath.push(parent);
    current = parent;
  }

  return reversedPath.reverse();
}

function findFirstMissingAncestorKey(
  node: CopcHierarchyNodeSummary,
  nodeByKey: ReadonlyMap<string, CopcHierarchyNodeSummary>,
): string | undefined {
  let current = node;

  while (current.depth > 0) {
    const parentKey = parentKeyForNode(current);
    const parent = nodeByKey.get(parentKey);

    if (parent === undefined) {
      return parentKey;
    }

    current = parent;
  }

  return undefined;
}

function parentKeyForNode(node: CopcHierarchyNodeSummary): string {
  return `${node.depth - 1}-${Math.floor(node.x / 2)}-${Math.floor(
    node.y / 2,
  )}-${Math.floor(node.z / 2)}`;
}

function scoreCandidate(
  candidate: EligibleCandidate,
  path: readonly CopcHierarchyNodeSummary[] | undefined,
  selectedKeys: ReadonlySet<string>,
  candidateBenefitByKey: ReadonlyMap<string, number>,
  limits: CopcMixedDepthBudgetLimits,
): ScoredCandidate | undefined {
  if (path === undefined) {
    return undefined;
  }

  const missingNodes = path.filter((node) => !selectedKeys.has(node.key));

  if (missingNodes.length === 0) {
    return undefined;
  }

  const usage = usageForNodes(missingNodes);
  const marginalVisualBenefit = missingNodes.reduce(
    (total, node) => total + (candidateBenefitByKey.get(node.key) ?? 0),
    0,
  );
  const normalizedCost = calculateNormalizedCost(usage, limits);

  return {
    candidate,
    missingNodes,
    usage,
    marginalVisualBenefit,
    normalizedCost,
    score: marginalVisualBenefit / normalizedCost,
  };
}

function calculateNormalizedCost(
  usage: CopcMixedDepthBudgetUsage,
  limits: CopcMixedDepthBudgetLimits,
): number {
  return (
    usage.nodeCount / limits.maxNodes +
    (limits.maxPointCount === undefined
      ? 0
      : usage.pointCount / limits.maxPointCount) +
    (limits.maxPointDataLength === undefined
      ? 0
      : usage.pointDataLength / limits.maxPointDataLength)
  );
}

function compareScoredCandidates(
  left: ScoredCandidate,
  right: ScoredCandidate,
): number {
  return (
    right.score - left.score ||
    right.marginalVisualBenefit - left.marginalVisualBenefit ||
    left.normalizedCost - right.normalizedCost ||
    right.candidate.node.depth - left.candidate.node.depth ||
    compareNodes(left.candidate.node, right.candidate.node)
  );
}

function usageForNodes(
  nodes: readonly CopcHierarchyNodeSummary[],
): CopcMixedDepthBudgetUsage {
  return nodes.reduce(
    (usage, node) => ({
      nodeCount: usage.nodeCount + 1,
      pointCount: usage.pointCount + node.pointCount,
      pointDataLength: usage.pointDataLength + node.pointDataLength,
    }),
    emptyBudgetUsage(),
  );
}

function emptyBudgetUsage(): CopcMixedDepthBudgetUsage {
  return {
    nodeCount: 0,
    pointCount: 0,
    pointDataLength: 0,
  };
}

function addBudgetUsage(
  current: CopcMixedDepthBudgetUsage,
  incremental: CopcMixedDepthBudgetUsage,
): CopcMixedDepthBudgetUsage {
  return {
    nodeCount: current.nodeCount + incremental.nodeCount,
    pointCount: current.pointCount + incremental.pointCount,
    pointDataLength:
      current.pointDataLength + incremental.pointDataLength,
  };
}

function fitsBudget(
  current: CopcMixedDepthBudgetUsage,
  incremental: CopcMixedDepthBudgetUsage,
  limits: CopcMixedDepthBudgetLimits,
): boolean {
  return (
    current.nodeCount + incremental.nodeCount <= limits.maxNodes &&
    (limits.maxPointCount === undefined ||
      current.pointCount + incremental.pointCount <= limits.maxPointCount) &&
    (limits.maxPointDataLength === undefined ||
      current.pointDataLength + incremental.pointDataLength <=
        limits.maxPointDataLength)
  );
}

function findRenderableNodes(
  plannedNodes: readonly CopcHierarchyNodeSummary[],
  viewStateByKey: ReadonlyMap<string, CopcMixedDepthNodeViewState>,
): CopcHierarchyNodeSummary[] {
  const renderKeys = new Set<string>();
  const renderNodes: CopcHierarchyNodeSummary[] = [];

  for (const node of plannedNodes) {
    const isReady = viewStateByKey.get(node.key)?.ready ?? true;
    const parentIsRenderable =
      node.depth === 0 || renderKeys.has(parentKeyForNode(node));

    if (isReady && parentIsRenderable) {
      renderKeys.add(node.key);
      renderNodes.push(node);
    }
  }

  return renderNodes;
}

function findFrontierNodes(
  nodes: readonly CopcHierarchyNodeSummary[],
): CopcHierarchyNodeSummary[] {
  const parentKeys = new Set(
    nodes
      .filter((node) => node.depth > 0)
      .map((node) => parentKeyForNode(node)),
  );

  return nodes.filter((node) => !parentKeys.has(node.key));
}

function sortNodes(
  nodes: readonly CopcHierarchyNodeSummary[],
): CopcHierarchyNodeSummary[] {
  return [...nodes].sort(compareNodes);
}

function compareNodes(
  left: CopcHierarchyNodeSummary,
  right: CopcHierarchyNodeSummary,
): number {
  return (
    left.depth - right.depth ||
    left.z - right.z ||
    left.y - right.y ||
    left.x - right.x ||
    compareStrings(left.key, right.key)
  );
}

function sortKnownKeys(
  keys: readonly string[],
  nodeByKey: ReadonlyMap<string, CopcHierarchyNodeSummary>,
): string[] {
  return [...keys].sort((left, right) => {
    const leftNode = nodeByKey.get(left);
    const rightNode = nodeByKey.get(right);

    if (leftNode !== undefined && rightNode !== undefined) {
      return compareNodes(leftNode, rightNode);
    }

    if (leftNode !== undefined) {
      return -1;
    }

    if (rightNode !== undefined) {
      return 1;
    }

    return compareStrings(left, right);
  });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validatePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function validateOptionalPositiveSafeInteger(
  value: number | undefined,
  label: string,
): void {
  if (value !== undefined) {
    validatePositiveSafeInteger(value, label);
  }
}

function validateNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function validateNonNegativeFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }
}

function validateOptionalNonNegativeFiniteNumber(
  value: number | undefined,
  label: string,
): void {
  if (value !== undefined) {
    validateNonNegativeFiniteNumber(value, label);
  }
}
