export interface CopcWorkerPoolSettingsOptions {
  readonly hardwareConcurrency?: number;
  readonly decodedNodeWorkerFallbackDelayMilliseconds?: number;
}

export interface CopcWorkerPoolSettings {
  readonly pointSampleWorkerConcurrency: number;
  readonly pointSampleWorkerWarmupCount: number;
  readonly pointGeometryWorkerConcurrency: number;
  readonly pointGeometryWorkerWarmupCount: number;
  readonly decodedNodeWorkerFallbackDelayMilliseconds: number;
}

interface WorkerConcurrencyPolicy {
  readonly fallbackConcurrency: number;
  readonly minConcurrency: number;
  readonly maxConcurrency: number;
  readonly reservedThreads: number;
  readonly maxWarmupCount: number;
}

const POINT_SAMPLE_WORKER_POLICY: WorkerConcurrencyPolicy = {
  fallbackConcurrency: 4,
  minConcurrency: 2,
  maxConcurrency: 6,
  reservedThreads: 2,
  maxWarmupCount: 4,
};

const POINT_GEOMETRY_WORKER_POLICY: WorkerConcurrencyPolicy = {
  fallbackConcurrency: 5,
  minConcurrency: 2,
  maxConcurrency: 8,
  reservedThreads: 2,
  maxWarmupCount: 8,
};
// Decoded COPC views live inside one worker. Keep density upgrades on that
// cache-owning worker by default so an idle fallback worker does not repeat the
// same HTTP range read and LAZ decode. Applications can still opt into a
// finite delay when measured foreground latency matters more than reuse.
const DEFAULT_DECODED_NODE_WORKER_FALLBACK_DELAY_MILLISECONDS =
  Number.POSITIVE_INFINITY;

export function createCopcWorkerPoolSettings(
  options: CopcWorkerPoolSettingsOptions = {},
): CopcWorkerPoolSettings {
  const pointSampleWorkerConcurrency = selectWorkerConcurrency(
    options.hardwareConcurrency,
    POINT_SAMPLE_WORKER_POLICY,
  );
  const pointGeometryWorkerConcurrency = selectWorkerConcurrency(
    options.hardwareConcurrency,
    POINT_GEOMETRY_WORKER_POLICY,
  );

  return {
    pointSampleWorkerConcurrency,
    pointSampleWorkerWarmupCount: Math.min(
      pointSampleWorkerConcurrency,
      POINT_SAMPLE_WORKER_POLICY.maxWarmupCount,
    ),
    pointGeometryWorkerConcurrency,
    pointGeometryWorkerWarmupCount: Math.min(
      pointGeometryWorkerConcurrency,
      POINT_GEOMETRY_WORKER_POLICY.maxWarmupCount,
    ),
    decodedNodeWorkerFallbackDelayMilliseconds: readNonNegativeNumberOption(
      options.decodedNodeWorkerFallbackDelayMilliseconds,
      DEFAULT_DECODED_NODE_WORKER_FALLBACK_DELAY_MILLISECONDS,
    ),
  };
}

function selectWorkerConcurrency(
  hardwareConcurrency: number | undefined,
  policy: WorkerConcurrencyPolicy,
): number {
  if (
    hardwareConcurrency === undefined ||
    !Number.isSafeInteger(hardwareConcurrency) ||
    hardwareConcurrency <= 0
  ) {
    return policy.fallbackConcurrency;
  }

  return Math.min(
    policy.maxConcurrency,
    Math.max(
      policy.minConcurrency,
      hardwareConcurrency - policy.reservedThreads,
    ),
  );
}

function readNonNegativeNumberOption(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}
