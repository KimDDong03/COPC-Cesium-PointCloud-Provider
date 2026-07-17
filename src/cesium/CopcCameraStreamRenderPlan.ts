import type { CopcHierarchyNodeCameraSelection } from "../core";
import {
  createCopcCameraStreamCoverageNodeKeys,
  createCopcCameraStreamFinalNodeKeys,
  createCopcCameraStreamPreviewNodeKeys,
  createCopcCameraStreamRenderNodeKeys,
  isRenderableCopcCameraStreamNode,
  orderCopcCameraStreamNodeKeysForAdditiveProgress,
  orderCopcCameraStreamNodeKeysForProgressiveCoverage,
  selectDistributedCopcCameraStreamNodeKeys,
  type CopcCameraStreamHierarchyLike,
} from "./CopcCameraStreamNodePlan";
import type { CopcCameraStreamLodSettings } from "./CopcCameraStreamSettings";

export interface CopcCameraStreamRenderPlanOptions {
  readonly cameraSelection: Pick<
    CopcHierarchyNodeCameraSelection,
    "coverageMode" | "nodes" | "selectedDepth"
  >;
  readonly configuredMaxPointCountPerNode: number;
  readonly effectiveNodePointDataLengthBudget: number;
  readonly effectivePointDataLengthBudget: number;
  readonly effectiveSourcePointBudget: number;
  readonly hierarchy: CopcCameraStreamHierarchyLike | undefined;
  readonly lodSettings: Pick<
    CopcCameraStreamLodSettings,
    "maxDepth" | "maxNodes" | "targetNodeScreenPixels"
  >;
  readonly minFinalNodeCount?: number;
  readonly minPointCountPerFinalNode?: number;
  readonly maxFinalNodeCount?: number;
  readonly maxPointCountPerFinalNode?: number;
  readonly previewMinFinalNodeCount?: number;
  readonly previewMaxNodeCount: number;
  readonly previewMaxPointDataLength: number;
  readonly renderedPointBudget: number;
}

export interface CopcCameraStreamRenderPlan {
  readonly coverageNodeKeys: readonly string[];
  readonly finalNodeKeys: readonly string[];
  readonly finalSelectedNodeCount: number;
  readonly maxPointCountPerNode: number;
  readonly nodeKeySignature: string;
  readonly previewNodeKeys: readonly string[];
  readonly renderNodeKeys: readonly string[];
  readonly renderSignature: string;
  readonly renderedPointBudget: number;
  readonly selectedNodeKeys: readonly string[];
  readonly useSourcePointBudgetHeadroom: boolean;
}

export function createCopcCameraStreamRenderPlan(
  options: CopcCameraStreamRenderPlanOptions,
): CopcCameraStreamRenderPlan {
  const renderableSelectedNodes = options.cameraSelection.nodes.filter(
    isRenderableCopcCameraStreamNode,
  );
  const selectedNodeKeys = renderableSelectedNodes.map(
    (node) => node.key,
  );
  const renderNodeKeys = createCopcCameraStreamRenderNodeKeys(
    renderableSelectedNodes,
    options.hierarchy,
  );
  const coverageNodeKeys = createCopcCameraStreamCoverageNodeKeys(
    renderNodeKeys,
    options.cameraSelection.selectedDepth,
  );
  const orderedFrontierNodeKeys = orderCopcCameraStreamNodeKeysForProgressiveCoverage(
    createCopcCameraStreamFinalNodeKeys(selectedNodeKeys, coverageNodeKeys),
  );
  const renderedPointBudget = normalizePositiveInteger(
    options.renderedPointBudget,
  );
  const terminalFrontierNodeKeys =
    options.cameraSelection.coverageMode !== "progressive"
      ? orderedFrontierNodeKeys
      : limitFinalNodeKeysForRenderedBudget(
          orderedFrontierNodeKeys,
          renderedPointBudget,
          options,
        );
  const terminalFrontierNodeKeySet = new Set(terminalFrontierNodeKeys);
  const terminalFrontierNodes = renderableSelectedNodes.filter((node) =>
    terminalFrontierNodeKeySet.has(node.key),
  );
  const finalNodeKeys = orderCopcCameraStreamNodeKeysForAdditiveProgress(
    createCopcCameraStreamRenderNodeKeys(
      terminalFrontierNodes,
      options.hierarchy,
    ),
  );
  const selectedNodeKeySet = new Set(selectedNodeKeys);
  const finalSelectedNodeCount = finalNodeKeys.filter((nodeKey) =>
    selectedNodeKeySet.has(nodeKey),
  ).length;
  // Mixed-depth selection budgets the full additive ancestor closure before
  // this render plan is created, so it is safe to load up to the configured
  // per-node source cap and apply the global render budget during composition.
  // Complete-depth selection budgets only its same-depth frontier; keep its
  // legacy render-budget-derived load cap until that selector also accounts
  // for the additive ancestors appended below.
  const useSourcePointBudgetHeadroom =
    options.cameraSelection.coverageMode === "mixed-depth";
  const maxPointCountPerNode = createCopcCameraStreamMaxPointCountPerNode({
    configuredMaxPointCountPerNode: options.configuredMaxPointCountPerNode,
    nodeCount: finalNodeKeys.length,
    renderedPointBudget,
    maxPointCountPerFinalNode:
      options.cameraSelection.coverageMode !== "progressive"
        ? undefined
        : options.maxPointCountPerFinalNode,
    useSourcePointBudgetHeadroom,
  });
  const previewNodeKeys =
    shouldCreatePreviewNodeKeys(
      terminalFrontierNodeKeys,
      options.previewMinFinalNodeCount,
    )
      ? createCopcCameraStreamPreviewNodeKeys(
          coverageNodeKeys,
          options.hierarchy,
          {
            detailNodeKeys: finalNodeKeys,
            maxNodeCount: options.previewMaxNodeCount,
            maxPointDataLength: options.previewMaxPointDataLength,
          },
        )
      : [];
  const nodeKeySignature = finalNodeKeys.join("|");
  const renderSignature = [
    nodeKeySignature,
    renderedPointBudget,
    maxPointCountPerNode,
    options.lodSettings.maxDepth,
    options.lodSettings.targetNodeScreenPixels,
    options.lodSettings.maxNodes,
    options.effectiveNodePointDataLengthBudget,
    options.effectiveSourcePointBudget,
    options.effectivePointDataLengthBudget,
    ...(useSourcePointBudgetHeadroom ? ["source-headroom"] : []),
  ].join("@");

  return {
    coverageNodeKeys,
    finalNodeKeys,
    finalSelectedNodeCount,
    maxPointCountPerNode,
    nodeKeySignature,
    previewNodeKeys,
    renderNodeKeys,
    renderSignature,
    renderedPointBudget,
    selectedNodeKeys,
    useSourcePointBudgetHeadroom,
  };
}

function shouldCreatePreviewNodeKeys(
  finalNodeKeys: readonly string[],
  previewMinFinalNodeCount: number | undefined,
): boolean {
  if (
    previewMinFinalNodeCount === undefined ||
    !Number.isSafeInteger(previewMinFinalNodeCount) ||
    previewMinFinalNodeCount <= 1
  ) {
    return true;
  }

  return finalNodeKeys.length >= previewMinFinalNodeCount;
}

export interface CopcCameraStreamMaxPointCountPerNodeOptions {
  readonly configuredMaxPointCountPerNode: number;
  readonly nodeCount: number;
  readonly renderedPointBudget: number;
  readonly maxPointCountPerFinalNode?: number;
  readonly useSourcePointBudgetHeadroom?: boolean;
}

export function createCopcCameraStreamMaxPointCountPerNode(
  options: CopcCameraStreamMaxPointCountPerNodeOptions,
): number {
  const configuredMaxPointCountPerNode = normalizePositiveInteger(
    options.configuredMaxPointCountPerNode,
  );

  const maxPointCountPerFinalNode = normalizeOptionalPositiveInteger(
    options.maxPointCountPerFinalNode,
  );

  if (options.useSourcePointBudgetHeadroom === true) {
    return configuredMaxPointCountPerNode;
  }

  if (options.nodeCount <= 0) {
    return Math.min(
      configuredMaxPointCountPerNode,
      maxPointCountPerFinalNode ?? configuredMaxPointCountPerNode,
    );
  }

  const budgetPointCountPerNode = Math.max(
    1,
    Math.ceil(options.renderedPointBudget / options.nodeCount),
  );

  return Math.min(
    configuredMaxPointCountPerNode,
    budgetPointCountPerNode,
    maxPointCountPerFinalNode ?? budgetPointCountPerNode,
  );
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

function limitFinalNodeKeysForRenderedBudget(
  nodeKeys: readonly string[],
  renderedPointBudget: number,
  options: Pick<
    CopcCameraStreamRenderPlanOptions,
    "maxFinalNodeCount" | "minFinalNodeCount" | "minPointCountPerFinalNode"
  >,
): readonly string[] {
  const minFinalNodeCount = normalizePositiveInteger(
    options.minFinalNodeCount ?? 1,
  );
  let maxFinalNodeCount = nodeKeys.length;
  const minPointCountPerFinalNode = options.minPointCountPerFinalNode;

  if (
    minPointCountPerFinalNode !== undefined &&
    Number.isFinite(minPointCountPerFinalNode) &&
    minPointCountPerFinalNode > 0
  ) {
    maxFinalNodeCount = Math.min(
      maxFinalNodeCount,
      Math.max(
        minFinalNodeCount,
        Math.floor(renderedPointBudget / minPointCountPerFinalNode),
      ),
    );
  }

  if (
    options.maxFinalNodeCount !== undefined &&
    Number.isSafeInteger(options.maxFinalNodeCount) &&
    options.maxFinalNodeCount > 0
  ) {
    maxFinalNodeCount = Math.min(
      maxFinalNodeCount,
      Math.max(minFinalNodeCount, options.maxFinalNodeCount),
    );
  }

  if (maxFinalNodeCount >= nodeKeys.length) {
    return nodeKeys;
  }

  return selectDistributedCopcCameraStreamNodeKeys(
    nodeKeys,
    maxFinalNodeCount,
  );
}
