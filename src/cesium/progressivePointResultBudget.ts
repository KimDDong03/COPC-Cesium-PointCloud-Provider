import type {
  CopcHierarchyNodeSummary,
  CopcHierarchySummary,
} from "../core/copc/CopcHierarchySummary";
import type { CopcNodePointSampleResult } from "../core/copc/CopcPointDataSample";
import type { PointGeometryBatch } from "./CopcPointCloudRenderer";
import type {
  CopcNodePointGeometryBatchResult,
  CopcPointGeometryBatchTiming,
} from "./CesiumCopcPointGeometryWorkerProtocol";
import { createNodePointSampleBatchKey } from "./pointGeometryBatch";

interface PointGeometryProgressEntry {
  readonly node: CopcHierarchyNodeSummary;
  readonly geometryResult: CopcNodePointGeometryBatchResult;
}

interface NodeSampleProgressEntry {
  readonly node: CopcHierarchyNodeSummary;
  readonly nodeResult: CopcNodePointSampleResult | undefined;
}

export function createProgressPointGeometryResults(options: {
  readonly backgroundGeometryResults: readonly CopcNodePointGeometryBatchResult[];
  readonly hierarchy: CopcHierarchySummary;
  readonly nodes: readonly CopcHierarchyNodeSummary[];
  readonly geometryResults: readonly (
    CopcNodePointGeometryBatchResult | undefined
  )[];
  readonly initialGeometryResults: readonly (
    CopcNodePointGeometryBatchResult | undefined
  )[];
  readonly includeBackground: boolean;
  readonly maxRenderedPointCount: number | undefined;
  readonly maxPointCountPerNode: number | undefined;
  readonly nodePointCountWeights?: readonly number[];
}): {
  readonly nodes: readonly CopcHierarchyNodeSummary[];
  readonly geometryResults: readonly CopcNodePointGeometryBatchResult[];
} {
  validateAlignedPositiveWeights(
    options.nodePointCountWeights,
    options.nodes.length,
  );
  const nodeEntries = options.nodes.flatMap((node, index) => {
    const geometryResult =
      options.geometryResults[index] ?? options.initialGeometryResults[index];

    return geometryResult
      ? [{
          node,
          geometryResult,
          pointCountWeight: options.nodePointCountWeights?.[index],
        }]
      : [];
  });
  const backgroundEntries = options.includeBackground
    ? options.backgroundGeometryResults.map((geometryResult) => ({
        node: findRequiredNode(
          options.hierarchy,
          geometryResult.pointSamples.nodeKey,
        ),
        geometryResult,
        pointCountWeight: options.nodePointCountWeights ? 1 : undefined,
      }))
    : [];
  const entries = limitPointGeometryProgressEntries(
    [...nodeEntries, ...backgroundEntries],
    options.maxRenderedPointCount,
    options.maxPointCountPerNode,
    nodeEntries.length,
    options.nodePointCountWeights
      ? entriesPointCountWeights([...nodeEntries, ...backgroundEntries])
      : undefined,
  );

  return {
    nodes: entries.map((entry) => entry.node),
    geometryResults: entries.map((entry) => entry.geometryResult),
  };
}

export function limitPointGeometryProgressEntries(
  entries: readonly PointGeometryProgressEntry[],
  maxRenderedPointCount: number | undefined,
  maxPointCountPerNode: number | undefined,
  priorityEntryCount?: number,
  entryPointCountWeights?: readonly number[],
): readonly PointGeometryProgressEntry[] {
  const pointCounts = allocateProgressEntryPointCounts(
    entries.map((entry) =>
      Math.min(
        entry.geometryResult.pointSamples.sampledPointCount,
        entry.geometryResult.geometryBatch.pointCount,
      ),
    ),
    maxRenderedPointCount,
    maxPointCountPerNode,
    priorityEntryCount,
    entryPointCountWeights,
  );

  return entries.flatMap((entry, index) => {
    const pointCount = pointCounts[index] ?? 0;

    return pointCount > 0
      ? [
          {
            node: entry.node,
            geometryResult: limitPointGeometryBatchResult(
              entry.geometryResult,
              pointCount,
              false,
            ),
          },
        ]
      : [];
  });
}

export function limitNodeSampleProgressEntries(
  entries: readonly NodeSampleProgressEntry[],
  maxRenderedPointCount: number | undefined,
  maxPointCountPerNode: number | undefined,
  priorityEntryCount?: number,
  entryPointCountWeights?: readonly number[],
): readonly {
  readonly node: CopcHierarchyNodeSummary;
  readonly nodeResult: CopcNodePointSampleResult;
}[] {
  const pointCounts = allocateProgressEntryPointCounts(
    entries.map((entry) => entry.nodeResult?.sampledPointCount ?? 0),
    maxRenderedPointCount,
    maxPointCountPerNode,
    priorityEntryCount,
    entryPointCountWeights,
  );

  return entries.flatMap((entry, index) => {
    const pointCount = pointCounts[index] ?? 0;

    return entry.nodeResult && pointCount > 0
      ? [
          {
            node: entry.node,
            nodeResult: limitNodePointSampleResult(
              entry.nodeResult,
              pointCount,
            ),
          },
        ]
      : [];
  });
}

export function allocateProgressEntryPointCounts(
  entryPointCounts: readonly number[],
  maxRenderedPointCount: number | undefined,
  maxPointCountPerNode: number | undefined,
  priorityEntryCount: number | undefined,
  entryPointCountWeights?: readonly number[],
): readonly number[] {
  const limits = entryPointCounts.map((pointCount) =>
    Math.max(
      0,
      Math.min(
        Math.floor(pointCount),
        maxPointCountPerNode ?? Number.POSITIVE_INFINITY,
      ),
    ),
  );
  validateAlignedPositiveWeights(entryPointCountWeights, limits.length);

  if (maxRenderedPointCount === undefined) {
    return limits;
  }

  const normalizedPriorityEntryCount =
    priorityEntryCount !== undefined
      ? Math.max(0, Math.min(limits.length, priorityEntryCount))
      : limits.length;
  const allocations = new Array<number>(limits.length).fill(0);
  let remainingPointCount = Math.max(0, Math.floor(maxRenderedPointCount));

  const allocatePointCounts = entryPointCountWeights
    ? allocateWeightedProgressPointCounts
    : allocateFairProgressPointCounts;

  remainingPointCount = allocatePointCounts(
    limits,
    allocations,
    0,
    normalizedPriorityEntryCount,
    remainingPointCount,
    entryPointCountWeights,
  );
  allocatePointCounts(
    limits,
    allocations,
    normalizedPriorityEntryCount,
    limits.length,
    remainingPointCount,
    entryPointCountWeights,
  );

  return allocations;
}

function allocateFairProgressPointCounts(
  limits: readonly number[],
  allocations: number[],
  startIndex: number,
  endIndex: number,
  pointBudget: number,
  _weights?: readonly number[],
): number {
  let remainingPointCount = pointBudget;
  let activeIndexes = limits
    .map((_limit, index) => index)
    .slice(startIndex, endIndex)
    .filter((index) => limits[index] > allocations[index]);

  while (remainingPointCount > 0 && activeIndexes.length > 0) {
    const share = Math.max(
      1,
      Math.floor(remainingPointCount / activeIndexes.length),
    );
    const nextActiveIndexes: number[] = [];

    for (const index of activeIndexes) {
      if (remainingPointCount <= 0) {
        nextActiveIndexes.push(index);
        continue;
      }

      const pointCount = Math.min(
        share,
        remainingPointCount,
        limits[index] - allocations[index],
      );

      allocations[index] += pointCount;
      remainingPointCount -= pointCount;

      if (limits[index] > allocations[index]) {
        nextActiveIndexes.push(index);
      }
    }

    if (nextActiveIndexes.length === activeIndexes.length && share <= 0) {
      break;
    }

    activeIndexes = nextActiveIndexes;
  }

  return remainingPointCount;
}

function allocateWeightedProgressPointCounts(
  limits: readonly number[],
  allocations: number[],
  startIndex: number,
  endIndex: number,
  pointBudget: number,
  weights: readonly number[] = [],
): number {
  let remainingPointCount = pointBudget;
  let activeIndexes = limits
    .map((_limit, index) => index)
    .slice(startIndex, endIndex)
    .filter((index) => limits[index] > allocations[index]);

  while (remainingPointCount > 0 && activeIndexes.length > 0) {
    const maxWeight = Math.max(...activeIndexes.map((index) => weights[index]));
    const scaledWeightTotal = activeIndexes.reduce(
      (total, index) => total + weights[index] / maxWeight,
      0,
    );
    const quotas = activeIndexes.map((index) => ({
      index,
      quota:
        (remainingPointCount * (weights[index] / maxWeight)) /
        scaledWeightTotal,
    }));
    const saturatedIndexes = quotas
      .filter(
        ({ index, quota }) =>
          limits[index] - allocations[index] <= quota,
      )
      .map(({ index }) => index);

    if (saturatedIndexes.length > 0) {
      const saturatedIndexSet = new Set(saturatedIndexes);

      for (const index of saturatedIndexes) {
        const pointCount = Math.min(
          remainingPointCount,
          limits[index] - allocations[index],
        );
        allocations[index] += pointCount;
        remainingPointCount -= pointCount;
      }

      activeIndexes = activeIndexes.filter(
        (index) => !saturatedIndexSet.has(index),
      );
      continue;
    }

    const remainders: Array<{
      readonly index: number;
      readonly remainder: number;
    }> = [];

    for (const { index, quota } of quotas) {
      const pointCount = Math.min(
        Math.floor(quota),
        limits[index] - allocations[index],
      );
      allocations[index] += pointCount;
      remainingPointCount -= pointCount;
      remainders.push({
        index,
        remainder: quota - pointCount,
      });
    }

    remainders.sort(
      (left, right) =>
        right.remainder - left.remainder || left.index - right.index,
    );
    for (const { index } of remainders) {
      if (
        remainingPointCount <= 0 ||
        allocations[index] >= limits[index]
      ) {
        continue;
      }

      allocations[index] += 1;
      remainingPointCount -= 1;
    }

    break;
  }

  return remainingPointCount;
}

function validateAlignedPositiveWeights(
  weights: readonly number[] | undefined,
  expectedLength: number,
): void {
  if (weights === undefined) {
    return;
  }

  if (weights.length !== expectedLength) {
    throw new Error("point count weights must align with the node entries.");
  }

  if (weights.some((weight) => !Number.isFinite(weight) || weight <= 0)) {
    throw new Error("point count weights must be positive finite numbers.");
  }
}

function entriesPointCountWeights(
  entries: readonly { readonly pointCountWeight: number | undefined }[],
): readonly number[] {
  return entries.map((entry) => entry.pointCountWeight ?? 1);
}

export function limitPointGeometryBatchResult(
  result: CopcNodePointGeometryBatchResult,
  maxPointCount: number,
  markAsCacheHit: boolean,
): CopcNodePointGeometryBatchResult {
  const pointCount = Math.min(
    result.pointSamples.nodePointCount,
    result.pointSamples.sampledPointCount,
    result.geometryBatch.pointCount,
    maxPointCount,
  );

  if (
    pointCount >= result.pointSamples.sampledPointCount &&
    pointCount >= result.geometryBatch.pointCount
  ) {
    return markAsCacheHit
      ? markPointGeometryBatchResultCacheHit(result)
      : result;
  }

  const pointSamples = limitNodePointSampleResult(
    result.pointSamples,
    pointCount,
  );

  return {
    pointSamples,
    geometryBatch: limitPointGeometryBatch(
      result.geometryBatch,
      pointCount,
      createNodePointSampleBatchKey(pointSamples),
    ),
    timing: markAsCacheHit
      ? createPointGeometryBatchCacheHitTiming()
      : result.timing,
  };
}

export function limitNodePointSampleResult(
  result: CopcNodePointSampleResult,
  pointCount: number,
): CopcNodePointSampleResult {
  if (pointCount >= result.sampledPointCount) {
    return result;
  }

  const availablePointCount =
    result.pointData?.x.length ??
    (result.points.length > 0
      ? result.points.length
      : result.sampledPointCount);
  const prefixPointCount = Math.min(
    result.sampledPointCount,
    availablePointCount,
    pointCount,
  );

  return {
    nodeKey: result.nodeKey,
    nodePointCount: result.nodePointCount,
    sampledPointCount: prefixPointCount,
    points:
      result.points.length > 0
        ? result.points.slice(0, prefixPointCount)
        : [],
    pointData: result.pointData
      ? {
          x: result.pointData.x.slice(0, prefixPointCount),
          y: result.pointData.y.slice(0, prefixPointCount),
          z: result.pointData.z.slice(0, prefixPointCount),
          red: result.pointData.red?.slice(0, prefixPointCount),
          green: result.pointData.green?.slice(0, prefixPointCount),
          blue: result.pointData.blue?.slice(0, prefixPointCount),
          classification: result.pointData.classification?.slice(
            0,
            prefixPointCount,
          ),
          intensity: result.pointData.intensity?.slice(0, prefixPointCount),
        }
      : undefined,
  };
}

function limitPointGeometryBatch(
  batch: PointGeometryBatch,
  pointCount: number,
  key: string,
): PointGeometryBatch {
  if (pointCount >= batch.pointCount) {
    return key === batch.key ? batch : { ...batch, key };
  }

  const positions = batch.positions.slice(0, pointCount * 3);
  const colors = batch.colors.slice(0, pointCount * 4);

  return {
    ...batch,
    key,
    pointCount,
    positions,
    colors,
    pointDensityScale:
      batch.pointDensityScale === undefined
        ? undefined
        : batch.pointDensityScale * (pointCount / batch.pointCount),
  };
}

export function markPointGeometryBatchResultCacheHit(
  result: CopcNodePointGeometryBatchResult,
): CopcNodePointGeometryBatchResult {
  return {
    ...result,
    timing: createPointGeometryBatchCacheHitTiming(),
  };
}

function createPointGeometryBatchCacheHitTiming(): CopcPointGeometryBatchTiming {
  return {
    pointDataViewMilliseconds: 0,
    pointDataViewCacheHit: true,
    sampleMilliseconds: 0,
    geometryMilliseconds: 0,
    workerTotalMilliseconds: 0,
    requestQueueMilliseconds: 0,
    requestRoundTripMilliseconds: 0,
    pointDataViewRangeWaitMilliseconds: 0,
    pointDataViewRangeRequestCount: 0,
    pointDataViewRangeBytes: 0,
    pointDataViewLazPerfMilliseconds: 0,
    pointDataViewNonRangeMilliseconds: 0,
    pointDataViewCacheWaitMilliseconds: 0,
  };
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
