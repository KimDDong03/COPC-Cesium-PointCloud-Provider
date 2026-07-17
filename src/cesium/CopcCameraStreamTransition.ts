import type { CopcCameraStreamFinalNodeWeight } from "./CopcCameraStreamProgress";
import type { CopcPointCloudLayerProgressiveRenderCandidate } from "./CopcPointCloudLayer";

const DEFAULT_MIN_WEIGHTED_NODE_COVERAGE_RATIO = 0.65;
const DEFAULT_MIN_POINT_RETENTION_RATIO = 0.6;

export interface CopcCameraStreamSafeSwapOptions {
  readonly candidate: CopcPointCloudLayerProgressiveRenderCandidate;
  readonly coverageNodeKeys: readonly string[];
  readonly finalNodeKeys: readonly string[];
  readonly finalNodeWeights?: readonly CopcCameraStreamFinalNodeWeight[];
  readonly renderedPointBudget: number;
  readonly retainedRendererPointCount: number;
  readonly minWeightedNodeCoverageRatio?: number;
  readonly minPointRetentionRatio?: number;
}

export interface CopcCameraStreamSafeSwapState {
  readonly canSwap: boolean;
  readonly coverageNodeCount: number;
  readonly coveredCoverageNodeCount: number;
  readonly isCoverageBaselineComplete: boolean;
  readonly minimumCandidatePointCount: number;
  readonly pointRetentionRatio: number;
  readonly weightedFinalNodeCoverageRatio: number;
}

/**
 * Proves that an intermediate frame is spatially complete enough to replace
 * the previously committed camera frame.
 *
 * Exact terminal composition remains the terminal renderer's responsibility;
 * this gate only controls intermediate renderer mutations.
 */
export function createCopcCameraStreamSafeSwapState(
  options: CopcCameraStreamSafeSwapOptions,
): CopcCameraStreamSafeSwapState {
  const sampledPointCountByNodeKey = new Map(
    options.candidate.nodeSamples.map((nodeSample) => [
      nodeSample.nodeKey,
      Math.max(0, nodeSample.sampledPointCount),
    ]),
  );
  const renderedNodeKeys = new Set(
    [...sampledPointCountByNodeKey]
      .filter(([, sampledPointCount]) => sampledPointCount > 0)
      .map(([nodeKey]) => nodeKey),
  );
  const coverageNodeKeys = uniqueNonEmptyNodeKeys(options.coverageNodeKeys);
  const coveredCoverageNodeCount = coverageNodeKeys.filter((nodeKey) =>
    renderedNodeKeys.has(nodeKey),
  ).length;
  const isCoverageBaselineComplete =
    coverageNodeKeys.length === 0 ||
    coveredCoverageNodeCount === coverageNodeKeys.length;
  const weightedFinalNodeCoverageRatio =
    createWeightedFinalNodeCoverageRatio({
      finalNodeKeys: options.finalNodeKeys,
      finalNodeWeights: options.finalNodeWeights,
      renderedNodeKeys,
    });
  const minWeightedNodeCoverageRatio = normalizeRatio(
    options.minWeightedNodeCoverageRatio,
    DEFAULT_MIN_WEIGHTED_NODE_COVERAGE_RATIO,
  );
  const minPointRetentionRatio = normalizeRatio(
    options.minPointRetentionRatio,
    DEFAULT_MIN_POINT_RETENTION_RATIO,
  );
  const targetComparablePointCount = Math.max(
    1,
    Math.min(
      normalizeNonNegativeInteger(options.retainedRendererPointCount),
      normalizeNonNegativeInteger(options.renderedPointBudget),
    ),
  );
  const minimumCandidatePointCount = Math.max(
    1,
    Math.ceil(targetComparablePointCount * minPointRetentionRatio),
  );
  const pointRetentionRatio = Math.min(
    1,
    Math.max(0, options.candidate.sampledPointCount) /
      targetComparablePointCount,
  );
  const canSwap =
    options.candidate.sampledPointCount >= minimumCandidatePointCount &&
    isCoverageBaselineComplete &&
    weightedFinalNodeCoverageRatio >= minWeightedNodeCoverageRatio;

  return {
    canSwap,
    coverageNodeCount: coverageNodeKeys.length,
    coveredCoverageNodeCount,
    isCoverageBaselineComplete,
    minimumCandidatePointCount,
    pointRetentionRatio,
    weightedFinalNodeCoverageRatio,
  };
}

function createWeightedFinalNodeCoverageRatio(options: {
  readonly finalNodeKeys: readonly string[];
  readonly finalNodeWeights:
    | readonly CopcCameraStreamFinalNodeWeight[]
    | undefined;
  readonly renderedNodeKeys: ReadonlySet<string>;
}): number {
  const finalNodeKeys = uniqueNonEmptyNodeKeys(options.finalNodeKeys);

  if (finalNodeKeys.length === 0) {
    return options.renderedNodeKeys.size > 0 ? 1 : 0;
  }

  const weightByNodeKey = new Map(
    options.finalNodeWeights?.map(({ nodeKey, weight }) => [
      nodeKey,
      normalizePositiveWeight(weight),
    ]) ?? [],
  );
  let totalWeight = 0;
  let renderedWeight = 0;

  finalNodeKeys.forEach((nodeKey) => {
    const weight = weightByNodeKey.get(nodeKey) ?? 1;

    totalWeight += weight;
    if (options.renderedNodeKeys.has(nodeKey)) {
      renderedWeight += weight;
    }
  });

  return totalWeight > 0 ? renderedWeight / totalWeight : 0;
}

function uniqueNonEmptyNodeKeys(nodeKeys: readonly string[]): string[] {
  return [...new Set(nodeKeys.filter((nodeKey) => nodeKey.length > 0))];
}

function normalizePositiveWeight(weight: number): number {
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeRatio(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}
