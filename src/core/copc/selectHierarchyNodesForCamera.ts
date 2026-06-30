import type { CopcBounds } from "./CopcInspection";
import type { CopcHierarchyNodeSummary } from "./CopcHierarchySummary";
import type { CopcTargetPoint } from "./suggestHierarchyNode";

export interface SelectHierarchyNodesForCameraOptions {
  readonly target: CopcTargetPoint;
  readonly viewDirection?: CopcTargetVector;
  readonly viewportHeightPixels: number;
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
}

export interface CopcTargetVector {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface CopcHierarchyNodeCameraSelection {
  readonly nodes: readonly CopcHierarchyNodeSummary[];
  readonly targetDepth: number;
  readonly selectedDepth: number;
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

  assertFiniteTarget(options.target);
  assertFiniteViewDirection(options.viewDirection);

  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
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

  if (!Number.isSafeInteger(maxNodes) || maxNodes <= 0) {
    throw new Error("maxNodes must be a positive integer.");
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
    options.target,
    viewportHeightPixels,
  );
  const depthEstimates = estimateAvailableDepthsScreenSize(
    candidateNodes.nodes,
    availableDepths,
    options.target,
    viewportHeightPixels,
    options.spacing,
  );
  const targetDepth = chooseTargetDepth(
    depthEstimates,
    targetNodeScreenPixels,
    targetPointSpacingScreenPixels,
  );
  const selection = selectBudgetedNodes(
    candidateNodes.nodes,
    availableDepths,
    targetDepth,
    {
      target: options.target,
      maxNodes,
      maxNodePointCount: options.maxNodePointCount,
      maxNodePointDataLength: options.maxNodePointDataLength,
      maxTotalPointCount: options.maxTotalPointCount,
      maxTotalPointDataLength: options.maxTotalPointDataLength,
    },
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
    ),
  };
}

function assertFiniteTarget(target: CopcTargetPoint): void {
  if (
    !Number.isFinite(target.x) ||
    !Number.isFinite(target.y) ||
    !Number.isFinite(target.z)
  ) {
    throw new Error("target must contain finite x, y, and z values.");
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
  target: CopcTargetPoint,
  viewportHeightPixels: number,
  spacing: number | undefined,
): CopcHierarchyNodeDepthEstimate[] {
  return availableDepths.map((depth) => {
    const nodesAtDepth = nodes.filter((node) => node.depth === depth);
    const nearestNode = nodesAtDepth
      .map((node) => ({
        node,
        distanceToBounds: distanceToBounds3d(target, node.bounds),
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
            target,
            viewportHeightPixels,
          );

    return {
      depth,
      nodeCount: nodesAtDepth.length,
      nearestNodeKey: nearestNode.key,
      estimatedNodeScreenPixels: estimateBoundsScreenPixels(
        nearestNode.bounds,
        target,
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

  return `Selected ${selection.nodes.length} nearest depth ${selection.selectedDepth} nodes; nearest depth ${selection.selectedDepth} node is estimated at ${selectedDepthEstimate.estimatedNodeScreenPixels.toLocaleString(undefined, { maximumFractionDigits: 0 })} px against a ${targetNodeScreenPixels.toLocaleString(undefined, { maximumFractionDigits: 0 })} px target${pointSpacingReason}.${viewReason}`;
}

interface SelectBudgetedNodesOptions {
  readonly target: CopcTargetPoint;
  readonly maxNodes: number;
  readonly maxNodePointCount: number | undefined;
  readonly maxNodePointDataLength: number | undefined;
  readonly maxTotalPointCount: number | undefined;
  readonly maxTotalPointDataLength: number | undefined;
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
    (node) => node.depth >= minDepth && node.depth <= maxDepth,
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
    const candidates = nodes
      .filter((node) => node.depth === depth)
      .map((node) => ({
        node,
        distanceToBounds: distanceToBounds3d(options.target, node.bounds),
      }))
      .sort(
        (left, right) =>
          left.distanceToBounds - right.distanceToBounds ||
          right.node.depth - left.node.depth ||
          right.node.pointCount - left.node.pointCount ||
          left.node.key.localeCompare(right.node.key),
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
