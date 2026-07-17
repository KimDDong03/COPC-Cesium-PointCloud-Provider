import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateBrowserEnvironment,
  validateRunEvidence,
} from "./run-evidence.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outputRoot = path.join(repoRoot, "output");
const defaultBenchmarkRoot = path.join(outputRoot, "smoothness-benchmark");
const defaultInputPath = path.join(defaultBenchmarkRoot, "smoothness.json");
const defaultOutputPath = path.join(
  defaultBenchmarkRoot,
  "smoothness-assertion.json",
);
const benchmarkArtifactSchema = "copc-viewer.smoothness-benchmark";
const benchmarkArtifactSchemaVersion = 1;

const inputPath = readStringArg("--input") ?? defaultInputPath;
const outputPath = readStringArg("--output") ?? defaultOutputPath;
const expectedBrowserGraphicsPattern = readOptionalStringEnv(
  "COPC_SMOOTHNESS_ASSERT_GPU_PATTERN",
);
const expectedBrowserGraphicsRegex = expectedBrowserGraphicsPattern
  ? new RegExp(expectedBrowserGraphicsPattern, "i")
  : undefined;
const thresholds = {
  minAverageFps: readNumberEnv("COPC_SMOOTHNESS_ASSERT_MIN_AVG_FPS", 30),
  maxP95FrameMilliseconds: readNumberEnv(
    "COPC_SMOOTHNESS_ASSERT_MAX_P95_FRAME_MS",
    67,
  ),
  maxFrameMilliseconds: readNumberEnv(
    "COPC_SMOOTHNESS_ASSERT_MAX_FRAME_MS",
    100,
  ),
  maxFramesOver50Milliseconds: readIntegerEnv(
    "COPC_SMOOTHNESS_ASSERT_MAX_FRAMES_OVER_50",
    10,
  ),
  maxTerminalRefinementFramesOver100Milliseconds: readNonNegativeIntegerEnv(
    "COPC_SMOOTHNESS_ASSERT_MAX_TERMINAL_REFINEMENT_FRAMES_OVER_100",
    0,
  ),
  maxCameraStreamInteractiveMilliseconds: readNumberEnv(
    "COPC_SMOOTHNESS_ASSERT_MAX_INTERACTIVE_STREAM_MS",
    readNumberEnv("COPC_SMOOTHNESS_ASSERT_MAX_STREAM_TOTAL_MS", 250),
  ),
  maxCameraStreamFinalDetailMilliseconds: readNumberEnv(
    "COPC_SMOOTHNESS_ASSERT_MAX_FINAL_DETAIL_MS",
    readNumberEnv("COPC_SMOOTHNESS_ASSERT_MAX_STREAM_TOTAL_MS", 250),
  ),
  maxCameraStreamFirstResponseMilliseconds: readNumberEnv(
    "COPC_SMOOTHNESS_ASSERT_MAX_FIRST_RESPONSE_MS",
    readNumberEnv(
      "COPC_SMOOTHNESS_ASSERT_MAX_INTERACTIVE_STREAM_MS",
      readNumberEnv("COPC_SMOOTHNESS_ASSERT_MAX_STREAM_TOTAL_MS", 250),
    ),
  ),
  maxMeasuredDurationOverrunMilliseconds: readNumberEnv(
    "COPC_SMOOTHNESS_ASSERT_MAX_MEASURED_DURATION_OVER_MS",
    2_000,
  ),
  minRenderedPointCount: readIntegerEnv(
    "COPC_SMOOTHNESS_ASSERT_MIN_RENDERED_POINTS",
    1_000,
  ),
  minRenderedFinalNodeCoverageRatio: readNumberEnv(
    "COPC_SMOOTHNESS_ASSERT_MIN_RENDERED_NODE_COVERAGE_RATIO",
    1,
  ),
  minRenderedFinalNodeWeightCoverageRatio: readNumberEnv(
    "COPC_SMOOTHNESS_ASSERT_MIN_RENDERED_WEIGHTED_NODE_COVERAGE_RATIO",
    0,
  ),
  minFinalNodeCount: readOptionalIntegerEnv(
    "COPC_SMOOTHNESS_ASSERT_MIN_FINAL_NODES",
  ),
  minRenderedFinalNodeCount: readOptionalIntegerEnv(
    "COPC_SMOOTHNESS_ASSERT_MIN_RENDERED_FINAL_NODES",
  ),
  minRenderedPointsPerFinalNode: readOptionalNumberEnv(
    "COPC_SMOOTHNESS_ASSERT_MIN_RENDERED_POINTS_PER_FINAL_NODE",
  ),
  minGeometryCacheHitCount: readOptionalIntegerEnv(
    "COPC_SMOOTHNESS_ASSERT_MIN_GEOMETRY_CACHE_HITS",
  ),
  requirePointGeometryTiming: readBooleanEnv(
    "COPC_SMOOTHNESS_ASSERT_REQUIRE_GEOMETRY_TIMING",
    false,
  ),
  requireCameraStreamPrefetch: readBooleanEnv(
    "COPC_SMOOTHNESS_ASSERT_REQUIRE_PREFETCH",
    true,
  ),
  minPrefetchRequestedNodeCount: readOptionalIntegerEnv(
    "COPC_SMOOTHNESS_ASSERT_MIN_PREFETCH_REQUESTED_NODES",
  ),
  requirePostPrefetchRefinement: readBooleanEnv(
    "COPC_SMOOTHNESS_ASSERT_REQUIRE_POST_PREFETCH_REFINEMENT",
    false,
  ),
  minPostPrefetchSelectedDepth: readOptionalIntegerEnv(
    "COPC_SMOOTHNESS_ASSERT_MIN_POST_PREFETCH_SELECTED_DEPTH",
  ),
  minPostPrefetchRenderedPointCount: readOptionalIntegerEnv(
    "COPC_SMOOTHNESS_ASSERT_MIN_POST_PREFETCH_RENDERED_POINTS",
  ),
  maxGeometryRoundTripMilliseconds: readOptionalNumberEnv(
    "COPC_SMOOTHNESS_ASSERT_MAX_GEOMETRY_ROUNDTRIP_MS",
  ),
  maxGeometryDecodeMilliseconds: readOptionalNumberEnv(
    "COPC_SMOOTHNESS_ASSERT_MAX_GEOMETRY_DECODE_MS",
  ),
  maxGeometryWorkerMilliseconds: readOptionalNumberEnv(
    "COPC_SMOOTHNESS_ASSERT_MAX_GEOMETRY_WORKER_MS",
  ),
  maxGeometryQueueMilliseconds: readOptionalNumberEnv(
    "COPC_SMOOTHNESS_ASSERT_MAX_GEOMETRY_QUEUE_MS",
  ),
  maxAverageGeometryQueueMilliseconds: readOptionalNumberEnv(
    "COPC_SMOOTHNESS_ASSERT_MAX_AVG_GEOMETRY_QUEUE_MS",
  ),
  minSelectedDepthOverride: readOptionalIntegerEnv(
    "COPC_SMOOTHNESS_ASSERT_MIN_SELECTED_DEPTH",
  ),
};

const benchmark = JSON.parse(await readFile(inputPath, "utf8"));
const benchmarkArtifact = validateBenchmarkArtifact(benchmark);
const results = readBenchmarkResults(benchmark);
const benchmarkDurationMilliseconds = Number(benchmark.durationMilliseconds);
const waitForFinalDetail = benchmark.waitForFinalDetail !== false;
const requireWarmHierarchyHold =
  benchmarkArtifact.isCurrent &&
  Number(benchmark.warmupRunCount) > 0 &&
  benchmark.cacheResetMode === "none";
const browserGraphics = benchmark.browserGraphics;
const browserEnvironment = benchmark.browserEnvironment;
const sourceRunEvidence = benchmark.runEvidence;
const sampleMinimumDepthById = new Map(
  (Array.isArray(benchmark.sampleCases) ? benchmark.sampleCases : []).map(
    (sampleCase) => [
      sampleCase.id,
      Number.isFinite(sampleCase.expectedMinSelectedDepth)
        ? sampleCase.expectedMinSelectedDepth
        : 0,
    ],
  ),
);
const failures = [...benchmarkArtifact.failures];
failures.push(
  ...validateRunEvidence(sourceRunEvidence, "benchmark.runEvidence"),
  ...validateBrowserEnvironment(
    browserEnvironment,
    "benchmark.browserEnvironment",
  ),
);
checkBrowserGraphics(browserGraphics, failures);
const checkedResults = results.map((result) => {
  const resultFailures = checkResult(
    result,
    sampleMinimumDepthById,
    benchmarkDurationMilliseconds,
    waitForFinalDetail,
    benchmarkArtifact.isCurrent,
    requireWarmHierarchyHold,
  );

  failures.push(...resultFailures);

  return summarizeResult(result, resultFailures);
});
if (requireWarmHierarchyHold) {
  failures.push(...checkWarmHierarchyConsistency(benchmark, results));
}
const assertion = {
  inputPath,
  waitForFinalDetail,
  requireWarmHierarchyHold,
  browserGraphics,
  browserEnvironment,
  sourceRunEvidence,
  benchmarkArtifact: {
    schema: benchmark.schema,
    schemaVersion: benchmark.schemaVersion,
    isCurrent: benchmarkArtifact.isCurrent,
    isLegacyUnversioned: benchmarkArtifact.isLegacyUnversioned,
  },
  expectedBrowserGraphicsPattern,
  thresholds,
  resultCount: results.length,
  failureCount: failures.length,
  checkedResults,
  failures,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(assertion, null, 2)}\n`);

if (failures.length > 0) {
  console.error(
    [
      `Smoothness benchmark assertion failed with ${failures.length} issue(s).`,
      ...failures.map((failure) => `- ${failure}`),
      `Assertion report: ${outputPath}`,
    ].join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(
    `Smoothness benchmark assertion passed for ${results.length} result(s): ${outputPath}`,
  );
}

function readBenchmarkResults(benchmark) {
  if (!benchmark || !Array.isArray(benchmark.results)) {
    throw new Error("Smoothness benchmark JSON must contain a results array.");
  }

  if (benchmark.results.length === 0) {
    throw new Error("Smoothness benchmark results array is empty.");
  }

  return benchmark.results;
}

function validateBenchmarkArtifact(benchmark) {
  const hasSchema = Object.prototype.hasOwnProperty.call(benchmark, "schema");
  const hasSchemaVersion = Object.prototype.hasOwnProperty.call(
    benchmark,
    "schemaVersion",
  );

  if (!hasSchema && !hasSchemaVersion) {
    return {
      failures: [],
      isCurrent: false,
      isLegacyUnversioned: true,
    };
  }

  const failures = [];

  if (benchmark.schema !== benchmarkArtifactSchema) {
    failures.push(
      `benchmark.schema must be ${benchmarkArtifactSchema}; received ${String(benchmark.schema)}.`,
    );
  }
  if (benchmark.schemaVersion !== benchmarkArtifactSchemaVersion) {
    failures.push(
      `benchmark.schemaVersion must be ${benchmarkArtifactSchemaVersion}; received ${String(benchmark.schemaVersion)}.`,
    );
  }

  return {
    failures,
    isCurrent: failures.length === 0,
    isLegacyUnversioned: false,
  };
}

function checkBrowserGraphics(graphics, failures) {
  const renderer = graphics?.renderer;

  if (typeof renderer !== "string" || !renderer.trim()) {
    failures.push("Browser WebGL renderer metadata was not reported.");
    return;
  }

  if (
    expectedBrowserGraphicsRegex &&
    !expectedBrowserGraphicsRegex.test(renderer)
  ) {
    failures.push(
      `Browser WebGL renderer "${renderer}" did not match ${expectedBrowserGraphicsPattern}.`,
    );
  }
}

function checkWarmHierarchyResult(result, label) {
  const failures = [];
  const renderSignature =
    result.cameraStreamRenderSignature ??
    result.status?.cameraStreamRenderSignature;
  const selectedNodeKeys =
    result.cameraStreamSelectedNodeKeys ??
    result.status?.cameraStreamSelectedNodeKeys;
  const hierarchyCacheStats =
    result.hierarchyCacheStats ?? result.status?.hierarchyCacheStats;
  const hierarchyCacheAfterPrefetch = result.hierarchyCacheAfterPrefetch;

  if (result.cameraStreamHierarchyHeld !== true) {
    failures.push(`${label}: warm hierarchy hold was not active.`);
  }

  if (typeof renderSignature !== "string" || renderSignature.length === 0) {
    failures.push(
      `${label}: exact additive render signature was not reported.`,
    );
  }

  if (!Array.isArray(selectedNodeKeys) || selectedNodeKeys.length === 0) {
    failures.push(
      `${label}: exact selected frontier node keys were not reported.`,
    );
  }

  failures.push(
    ...validateHierarchyCacheStats(
      hierarchyCacheStats,
      `${label}.hierarchyCacheStats`,
    ),
    ...validateHierarchyCacheStats(
      hierarchyCacheAfterPrefetch,
      `${label}.hierarchyCacheAfterPrefetch`,
    ),
  );

  if (
    createHierarchyCacheIdentity(hierarchyCacheStats) !==
    createHierarchyCacheIdentity(hierarchyCacheAfterPrefetch)
  ) {
    failures.push(
      `${label}: hierarchy cache changed during held geometry prefetch.`,
    );
  }

  return failures;
}

function checkWarmHierarchyConsistency(benchmark, results) {
  const failures = [];
  const holds = Array.isArray(benchmark.hierarchyHolds)
    ? benchmark.hierarchyHolds
    : [];
  const holdByCase = new Map(
    holds.map((hold) => [`${hold.sampleId}:${hold.streamPointBudget}`, hold]),
  );
  const identityByCase = new Map();

  for (const result of results) {
    const label = createResultLabel(result);
    const caseKey = `${result.sampleId}:${result.streamPointBudget}`;
    const hold = holdByCase.get(caseKey);

    if (!hold || hold.held !== true) {
      failures.push(
        `${label}: matching warm hierarchy hold evidence is missing.`,
      );
      continue;
    }

    if (hold.warmupSettle?.state !== "completed") {
      failures.push(
        `${label}: warm hierarchy hold did not follow a completed prefetch settle.`,
      );
    }

    const resultCacheStats =
      result.hierarchyCacheStats ?? result.status?.hierarchyCacheStats;

    if (
      createHierarchyCacheIdentity(hold.hierarchyCacheStats) !==
      createHierarchyCacheIdentity(resultCacheStats)
    ) {
      failures.push(
        `${label}: hierarchy cache no longer matches the captured warm hold.`,
      );
    }

    const identity = createWarmHierarchyIdentity(result);
    const previousIdentity = identityByCase.get(caseKey);

    if (previousIdentity !== undefined && previousIdentity !== identity) {
      failures.push(
        `${label}: exact warm frontier or additive render signature changed between repeats.`,
      );
    }

    identityByCase.set(caseKey, identity);
  }

  return failures;
}

function createWarmHierarchyIdentity(result) {
  const selectedNodeKeys =
    result.cameraStreamSelectedNodeKeys ??
    result.status?.cameraStreamSelectedNodeKeys ??
    [];
  const selectedDepth =
    result.cameraStreamDiagnostics?.selectedDepth ??
    result.status?.cameraStreamDiagnosticsData?.selectedDepth;

  return JSON.stringify({
    selectedDepth,
    selectedNodeKeys: [...selectedNodeKeys].sort(),
    renderSignature:
      result.cameraStreamRenderSignature ??
      result.status?.cameraStreamRenderSignature,
    hierarchyCache: createHierarchyCacheIdentity(
      result.hierarchyCacheStats ?? result.status?.hierarchyCacheStats,
    ),
  });
}

function readHierarchyCacheStatKeys() {
  return [
    "loadedPageCount",
    "maxCachedPageCount",
    "loadedPageBytes",
    "maxCachedPageBytes",
    "pendingPageCount",
    "trackedNodeCount",
    "trackedPendingPageCount",
    "cacheEvictionCount",
  ];
}

function validateHierarchyCacheStats(stats, valuePath) {
  if (!stats || typeof stats !== "object") {
    return [`${valuePath} must be an object.`];
  }

  const failures = [];

  for (const key of readHierarchyCacheStatKeys()) {
    if (!Number.isSafeInteger(stats[key]) || stats[key] < 0) {
      failures.push(`${valuePath}.${key} must be a non-negative safe integer.`);
    }
  }

  if (typeof stats.isOverLimit !== "boolean") {
    failures.push(`${valuePath}.isOverLimit must be a boolean.`);
  }

  return failures;
}

function createHierarchyCacheIdentity(stats) {
  if (!stats || typeof stats !== "object") {
    return "missing";
  }

  return JSON.stringify([
    ...readHierarchyCacheStatKeys().map((key) => stats[key]),
    stats.isOverLimit,
  ]);
}

function checkResult(
  result,
  sampleMinimumDepthById,
  benchmarkDurationMilliseconds,
  waitForFinalDetail,
  requireCurrentEvidence,
  requireWarmHierarchyHold,
) {
  const label = createResultLabel(result);
  const summary = result.summary ?? {};
  const diagnostics =
    result.cameraStreamDiagnostics ??
    result.status?.cameraStreamDiagnosticsData ??
    {};
  const minimumSelectedDepth =
    thresholds.minSelectedDepthOverride ??
    sampleMinimumDepthById.get(result.sampleId) ??
    0;
  const resultFailures = [];
  const visualQuality =
    result.cameraStreamVisualQuality ??
    result.status?.cameraStreamVisualQuality;

  if (requireWarmHierarchyHold) {
    resultFailures.push(...checkWarmHierarchyResult(result, label));
  }

  if (!Number.isFinite(summary.frameCount) || summary.frameCount <= 0) {
    resultFailures.push(`${label}: no animation frames were measured.`);
  }

  if (
    !Number.isFinite(summary.estimatedAverageFps) ||
    summary.estimatedAverageFps < thresholds.minAverageFps
  ) {
    resultFailures.push(
      `${label}: average FPS ${formatNumber(summary.estimatedAverageFps)} < ${thresholds.minAverageFps}.`,
    );
  }

  if (
    !Number.isFinite(summary.p95FrameMilliseconds) ||
    summary.p95FrameMilliseconds > thresholds.maxP95FrameMilliseconds
  ) {
    resultFailures.push(
      `${label}: p95 frame ${formatMilliseconds(summary.p95FrameMilliseconds)} > ${thresholds.maxP95FrameMilliseconds} ms.`,
    );
  }

  if (
    !Number.isFinite(summary.maxFrameMilliseconds) ||
    summary.maxFrameMilliseconds > thresholds.maxFrameMilliseconds
  ) {
    resultFailures.push(
      `${label}: max frame ${formatMilliseconds(summary.maxFrameMilliseconds)} > ${thresholds.maxFrameMilliseconds} ms.`,
    );
  }

  if (
    !Number.isFinite(summary.frameDeltasOver50Milliseconds) ||
    summary.frameDeltasOver50Milliseconds >
      thresholds.maxFramesOver50Milliseconds
  ) {
    resultFailures.push(
      `${label}: ${formatNumber(summary.frameDeltasOver50Milliseconds)} frames over 50 ms > ${thresholds.maxFramesOver50Milliseconds}.`,
    );
  }

  const terminalRefinementEvidenceKeys = [
    "terminalRefinementDurationMilliseconds",
    "terminalRefinementFrameDeltas",
    "terminalRefinementSummary",
  ];
  const missingTerminalRefinementEvidenceKeys = requireCurrentEvidence
    ? terminalRefinementEvidenceKeys.filter(
        (key) => !Object.prototype.hasOwnProperty.call(result, key),
      )
    : [];

  if (missingTerminalRefinementEvidenceKeys.length > 0) {
    resultFailures.push(
      `${label}: current benchmark artifact is missing terminal refinement evidence: ${missingTerminalRefinementEvidenceKeys.join(", ")}.`,
    );
  }

  if (waitForFinalDetail && hasTerminalRefinementEvidence(result)) {
    checkTerminalRefinementSummary(resultFailures, label, result);
  }

  const decodedPointDataCache =
    result.decodedPointDataCache ?? result.status?.decodedPointDataCache;
  if (decodedPointDataCache !== undefined) {
    checkDecodedPointDataCacheStats(
      resultFailures,
      label,
      decodedPointDataCache,
      requireCurrentEvidence,
    );
  } else if (requireCurrentEvidence) {
    resultFailures.push(
      `${label}: current benchmark artifact did not report decoded point-data cache stats.`,
    );
  }

  const maxCameraStreamMilliseconds = waitForFinalDetail
    ? thresholds.maxCameraStreamFinalDetailMilliseconds
    : thresholds.maxCameraStreamInteractiveMilliseconds;
  const cameraStreamTimingLabel = waitForFinalDetail
    ? "camera stream final detail total"
    : "camera stream interactive total";

  if (
    !Number.isFinite(diagnostics.totalMilliseconds) ||
    diagnostics.totalMilliseconds > maxCameraStreamMilliseconds
  ) {
    resultFailures.push(
      `${label}: ${cameraStreamTimingLabel} ${formatMilliseconds(diagnostics.totalMilliseconds)} > ${maxCameraStreamMilliseconds} ms.`,
    );
  }

  if (
    !Number.isFinite(result.cameraStreamFirstResponseMilliseconds) ||
    result.cameraStreamFirstResponseMilliseconds >
      thresholds.maxCameraStreamFirstResponseMilliseconds
  ) {
    resultFailures.push(
      `${label}: camera stream first response ${formatMilliseconds(result.cameraStreamFirstResponseMilliseconds)} > ${thresholds.maxCameraStreamFirstResponseMilliseconds} ms.`,
    );
  }

  if (!Number.isFinite(result.measuredDurationMilliseconds)) {
    resultFailures.push(`${label}: measured duration was not reported.`);
  } else if (Number.isFinite(benchmarkDurationMilliseconds)) {
    const measuredDurationOverrunMilliseconds =
      result.measuredDurationMilliseconds - benchmarkDurationMilliseconds;

    if (
      measuredDurationOverrunMilliseconds >
      thresholds.maxMeasuredDurationOverrunMilliseconds
    ) {
      resultFailures.push(
        `${label}: measured duration overrun ${formatMilliseconds(measuredDurationOverrunMilliseconds)} > ${thresholds.maxMeasuredDurationOverrunMilliseconds} ms.`,
      );
    }
  }

  if (
    !Number.isFinite(diagnostics.selectedDepth) ||
    diagnostics.selectedDepth < minimumSelectedDepth
  ) {
    resultFailures.push(
      `${label}: selected depth ${formatNumber(diagnostics.selectedDepth)} < ${minimumSelectedDepth}.`,
    );
  }

  if (
    !Number.isFinite(result.renderedPointCount) ||
    result.renderedPointCount < thresholds.minRenderedPointCount
  ) {
    resultFailures.push(
      `${label}: rendered ${formatNumber(result.renderedPointCount)} points < ${thresholds.minRenderedPointCount}.`,
    );
  }

  if (
    thresholds.minRenderedFinalNodeCoverageRatio > 0 &&
    (!Number.isFinite(result.renderedFinalNodeCoverageRatio) ||
      result.renderedFinalNodeCoverageRatio <
        thresholds.minRenderedFinalNodeCoverageRatio)
  ) {
    resultFailures.push(
      `${label}: rendered current-view node coverage ${formatPercent(result.renderedFinalNodeCoverageRatio)} < ${formatPercent(thresholds.minRenderedFinalNodeCoverageRatio)}.`,
    );
  }

  if (waitForFinalDetail) {
    if (!visualQuality || visualQuality.isTerminalReady !== true) {
      resultFailures.push(
        `${label}: verified terminal visual composition was not reported.`,
      );
    } else {
      if (
        (visualQuality.isFrontierDepthPolicySatisfied ??
          visualQuality.frontierDepthSpan === 0) !== true
      ) {
        resultFailures.push(
          `${label}: terminal frontier violates its ${visualQuality.terminalFrontierMode ?? "same-depth"} depth policy with a ${formatNumber(visualQuality.frontierDepthSpan)}-level span.`,
        );
      }
      if (visualQuality.isFrontierAntichain !== true) {
        resultFailures.push(`${label}: terminal frontier is not an antichain.`);
      }
      if (visualQuality.isAdditiveClosureComplete !== true) {
        resultFailures.push(
          `${label}: terminal additive ancestor closure is incomplete.`,
        );
      }
      if (visualQuality.missingRequiredNodeCount !== 0) {
        resultFailures.push(
          `${label}: terminal composition is missing ${formatNumber(visualQuality.missingRequiredNodeCount)} required nodes.`,
        );
      }
      if (visualQuality.unexpectedRenderedNodeCount !== 0) {
        resultFailures.push(
          `${label}: terminal composition contains ${formatNumber(visualQuality.unexpectedRenderedNodeCount)} stale or unexpected nodes.`,
        );
      }
    }
  }

  if (
    thresholds.minRenderedFinalNodeWeightCoverageRatio > 0 &&
    (!Number.isFinite(result.renderedFinalNodeWeightCoverageRatio) ||
      result.renderedFinalNodeWeightCoverageRatio <
        thresholds.minRenderedFinalNodeWeightCoverageRatio)
  ) {
    resultFailures.push(
      `${label}: rendered weighted current-view node coverage ${formatPercent(result.renderedFinalNodeWeightCoverageRatio)} < ${formatPercent(thresholds.minRenderedFinalNodeWeightCoverageRatio)}.`,
    );
  }

  if (
    thresholds.minFinalNodeCount !== undefined &&
    (!Number.isFinite(result.finalNodeCount) ||
      result.finalNodeCount < thresholds.minFinalNodeCount)
  ) {
    resultFailures.push(
      `${label}: selected current-view final nodes ${formatNumber(result.finalNodeCount)} < ${thresholds.minFinalNodeCount}.`,
    );
  }

  if (
    thresholds.minRenderedFinalNodeCount !== undefined &&
    (!Number.isFinite(result.renderedFinalNodeCount) ||
      result.renderedFinalNodeCount < thresholds.minRenderedFinalNodeCount)
  ) {
    resultFailures.push(
      `${label}: rendered current-view final nodes ${formatNumber(result.renderedFinalNodeCount)} < ${thresholds.minRenderedFinalNodeCount}.`,
    );
  }

  if (thresholds.minRenderedPointsPerFinalNode !== undefined) {
    const renderedPointsPerFinalNode =
      Number.isFinite(result.renderedPointCount) &&
      Number.isFinite(result.renderedFinalNodeCount) &&
      result.renderedFinalNodeCount > 0
        ? result.renderedPointCount / result.renderedFinalNodeCount
        : Number.NaN;

    if (
      !Number.isFinite(renderedPointsPerFinalNode) ||
      renderedPointsPerFinalNode < thresholds.minRenderedPointsPerFinalNode
    ) {
      resultFailures.push(
        `${label}: rendered points per current-view final node ${formatNumber(renderedPointsPerFinalNode)} < ${thresholds.minRenderedPointsPerFinalNode}.`,
      );
    }
  }

  if (thresholds.requirePointGeometryTiming && !result.pointGeometryTiming) {
    resultFailures.push(
      `${label}: point geometry timing was required but not reported.`,
    );
  }

  if (
    result.pointGeometryTiming?.evidenceSource ===
    "camera-stream-node-sample-cache"
  ) {
    resultFailures.push(
      ...validateCameraStreamNodeReuse(
        result.cameraStreamNodeReuse ?? result.status?.cameraStreamNodeReuse,
        result.pointGeometryTiming,
        label,
      ),
    );
  }

  checkOptionalPointGeometryTimingThreshold(
    resultFailures,
    label,
    result.pointGeometryTiming,
    "maxRequestRoundTripMilliseconds",
    thresholds.maxGeometryRoundTripMilliseconds,
    "geometry max round trip",
  );
  checkOptionalPointGeometryTimingThreshold(
    resultFailures,
    label,
    result.pointGeometryTiming,
    "maxDecodeMilliseconds",
    thresholds.maxGeometryDecodeMilliseconds,
    "geometry max decode",
  );
  checkOptionalPointGeometryTimingThreshold(
    resultFailures,
    label,
    result.pointGeometryTiming,
    "maxWorkerMilliseconds",
    thresholds.maxGeometryWorkerMilliseconds,
    "geometry max worker",
  );
  checkOptionalPointGeometryTimingThreshold(
    resultFailures,
    label,
    result.pointGeometryTiming,
    "maxQueueMilliseconds",
    thresholds.maxGeometryQueueMilliseconds,
    "geometry max queue",
  );
  checkOptionalAveragePointGeometryTimingThreshold(
    resultFailures,
    label,
    result.pointGeometryTiming,
    "sumQueueMilliseconds",
    thresholds.maxAverageGeometryQueueMilliseconds,
    "geometry average queue per node",
  );
  checkOptionalMinimumGeometryCacheHitThreshold(
    resultFailures,
    label,
    result,
    thresholds.minGeometryCacheHitCount,
    "geometry cache hits",
  );

  if (waitForFinalDetail && thresholds.requireCameraStreamPrefetch) {
    if (!result.cameraStreamPrefetch) {
      resultFailures.push(
        `${label}: camera stream prefetch status was required but not reported.`,
      );
    } else if (result.cameraStreamPrefetch.state === "failed") {
      resultFailures.push(
        `${label}: camera stream prefetch failed: ${result.cameraStreamPrefetch.reason ?? "unknown error"}.`,
      );
    }
  }

  if (thresholds.minPrefetchRequestedNodeCount !== undefined) {
    const requestedNodeCount =
      result.cameraStreamPrefetch?.requestedNodeCount ??
      result.status?.cameraStreamPrefetchData?.requestedNodeCount;

    if (
      !Number.isFinite(requestedNodeCount) ||
      requestedNodeCount < thresholds.minPrefetchRequestedNodeCount
    ) {
      resultFailures.push(
        `${label}: prefetch requested ${formatNumber(requestedNodeCount)} nodes < ${thresholds.minPrefetchRequestedNodeCount}.`,
      );
    }
  }

  if (
    thresholds.requirePostPrefetchRefinement ||
    thresholds.minPostPrefetchSelectedDepth !== undefined ||
    thresholds.minPostPrefetchRenderedPointCount !== undefined
  ) {
    resultFailures.push(...checkPostPrefetchRefinement(result, label));
  }

  const pointBudget = Number.isFinite(result.appliedStreamPointBudget)
    ? result.appliedStreamPointBudget
    : result.streamPointBudget;

  if (
    Number.isFinite(result.appliedStreamPointBudget) &&
    Number.isFinite(result.streamPointBudget) &&
    result.appliedStreamPointBudget > result.streamPointBudget
  ) {
    resultFailures.push(
      `${label}: applied ${formatNumber(result.appliedStreamPointBudget)} points > configured ${formatNumber(result.streamPointBudget)} point cap.`,
    );
  }

  if (
    Number.isFinite(result.renderedPointCount) &&
    Number.isFinite(pointBudget) &&
    result.renderedPointCount > pointBudget
  ) {
    resultFailures.push(
      `${label}: rendered ${formatNumber(result.renderedPointCount)} points > ${formatNumber(pointBudget)} point budget.`,
    );
  }

  return resultFailures;
}

function checkPostPrefetchRefinement(result, label) {
  const evidence = result.postPrefetchRefinement;

  if (!evidence || typeof evidence !== "object") {
    return [
      `${label}: post-prefetch same-camera refinement evidence was required but not reported.`,
    ];
  }

  const failures = [];
  const expectedInitialRequestId = result.expectedCameraStreamRequestId;

  if (!Number.isSafeInteger(evidence.initialRequestId)) {
    failures.push(
      `${label}: post-prefetch initial request ID ${formatNumber(evidence.initialRequestId)} must be a safe integer.`,
    );
  } else if (
    Number.isSafeInteger(expectedInitialRequestId) &&
    evidence.initialRequestId !== expectedInitialRequestId
  ) {
    failures.push(
      `${label}: post-prefetch initial request ID ${evidence.initialRequestId} does not match measured request ${expectedInitialRequestId}.`,
    );
  }

  if (!Number.isSafeInteger(evidence.observedRequestId)) {
    failures.push(
      `${label}: post-prefetch observed request ID ${formatNumber(evidence.observedRequestId)} must be a safe integer.`,
    );
  }

  if (
    !Number.isSafeInteger(evidence.initialCameraEpoch) ||
    !Number.isSafeInteger(evidence.observedCameraEpoch) ||
    evidence.observedCameraEpoch !== evidence.initialCameraEpoch
  ) {
    failures.push(
      `${label}: post-prefetch camera epoch changed from ${formatNumber(evidence.initialCameraEpoch)} to ${formatNumber(evidence.observedCameraEpoch)}.`,
    );
  }

  if (
    typeof evidence.initialCameraPoseFingerprint !== "string" ||
    evidence.initialCameraPoseFingerprint.length === 0 ||
    typeof evidence.observedCameraPoseFingerprint !== "string" ||
    evidence.observedCameraPoseFingerprint !==
      evidence.initialCameraPoseFingerprint
  ) {
    failures.push(
      `${label}: post-prefetch camera pose fingerprint did not remain identical.`,
    );
  }

  if (
    evidence.requestAdvanced !== true ||
    evidence.sameCameraFollowup !== true ||
    !Number.isSafeInteger(evidence.initialRequestId) ||
    !Number.isSafeInteger(evidence.observedRequestId) ||
    evidence.observedRequestId <= evidence.initialRequestId
  ) {
    failures.push(
      `${label}: post-prefetch evidence did not prove a newer same-camera follow-up request.`,
    );
  }

  if (
    evidence.prefetchCompleted !== true ||
    evidence.prefetchState !== "completed"
  ) {
    failures.push(
      `${label}: post-prefetch wait did not reach completed state (state ${String(evidence.prefetchState)}).`,
    );
  }

  if (
    !Number.isSafeInteger(evidence.timeoutMilliseconds) ||
    evidence.timeoutMilliseconds <= 0
  ) {
    failures.push(
      `${label}: post-prefetch wait timeout ${formatNumber(evidence.timeoutMilliseconds)} must be a positive safe integer.`,
    );
  }

  if (
    thresholds.minPostPrefetchSelectedDepth !== undefined &&
    (!Number.isFinite(evidence.selectedDepth) ||
      evidence.selectedDepth < thresholds.minPostPrefetchSelectedDepth)
  ) {
    failures.push(
      `${label}: post-prefetch selected depth ${formatNumber(evidence.selectedDepth)} < ${thresholds.minPostPrefetchSelectedDepth}.`,
    );
  }

  if (
    thresholds.minPostPrefetchRenderedPointCount !== undefined &&
    (!Number.isFinite(evidence.renderedPointCount) ||
      evidence.renderedPointCount <
        thresholds.minPostPrefetchRenderedPointCount)
  ) {
    failures.push(
      `${label}: post-prefetch rendered ${formatNumber(evidence.renderedPointCount)} points < ${thresholds.minPostPrefetchRenderedPointCount}.`,
    );
  }

  const visualQuality = evidence.visualQuality;

  if (
    evidence.isTerminalReady !== true ||
    !visualQuality ||
    visualQuality.isTerminalReady !== true
  ) {
    failures.push(
      `${label}: post-prefetch same-camera refinement was not terminal ready.`,
    );
  } else {
    if (
      (visualQuality.isFrontierDepthPolicySatisfied ??
        visualQuality.frontierDepthSpan === 0) !== true
    ) {
      failures.push(
        `${label}: post-prefetch terminal frontier violates its ${visualQuality.terminalFrontierMode ?? "same-depth"} depth policy with a ${formatNumber(visualQuality.frontierDepthSpan)}-level span.`,
      );
    }
    if (visualQuality.isFrontierAntichain !== true) {
      failures.push(
        `${label}: post-prefetch terminal frontier is not an antichain.`,
      );
    }
    if (visualQuality.isAdditiveClosureComplete !== true) {
      failures.push(
        `${label}: post-prefetch terminal additive ancestor closure is incomplete.`,
      );
    }
    if (visualQuality.missingRequiredNodeCount !== 0) {
      failures.push(
        `${label}: post-prefetch terminal composition is missing ${formatNumber(visualQuality.missingRequiredNodeCount)} required nodes.`,
      );
    }
    if (visualQuality.unexpectedRenderedNodeCount !== 0) {
      failures.push(
        `${label}: post-prefetch terminal composition contains ${formatNumber(visualQuality.unexpectedRenderedNodeCount)} stale or unexpected nodes.`,
      );
    }
  }

  return failures;
}

function validateCameraStreamNodeReuse(reuse, timing, label) {
  if (!reuse || typeof reuse !== "object") {
    return [
      `${label}: camera-stream node-sample cache timing requires structured reuse evidence.`,
    ];
  }

  const failures = [];
  const fields = [
    "finalNodeCount",
    "cachedFinalNodeCount",
    "freshCachedFinalNodeCount",
    "cachedCoverageNodeCount",
  ];

  for (const field of fields) {
    if (!Number.isSafeInteger(reuse[field]) || reuse[field] < 0) {
      failures.push(
        `${label}: camera stream node reuse ${field} must be a non-negative safe integer.`,
      );
    }
  }

  if (reuse.cachedFinalNodeCount > reuse.finalNodeCount) {
    failures.push(
      `${label}: cached final node count exceeds the final node count.`,
    );
  }

  if (reuse.freshCachedFinalNodeCount > reuse.cachedFinalNodeCount) {
    failures.push(
      `${label}: fresh cached final node count exceeds the cached final node count.`,
    );
  }

  if (reuse.freshCachedFinalNodeCount !== reuse.finalNodeCount) {
    failures.push(
      `${label}: zero-worker node-sample cache evidence requires every final node to have a fresh cached sample.`,
    );
  }

  if (timing.nodeCount !== reuse.finalNodeCount) {
    failures.push(
      `${label}: node-sample cache timing node count does not match reuse evidence.`,
    );
  }

  if (timing.cacheHitCount !== reuse.freshCachedFinalNodeCount) {
    failures.push(
      `${label}: node-sample cache timing hit count does not match fresh reuse evidence.`,
    );
  }

  return failures;
}

function checkOptionalPointGeometryTimingThreshold(
  failures,
  label,
  pointGeometryTiming,
  timingKey,
  threshold,
  timingLabel,
) {
  if (threshold === undefined) {
    return;
  }

  if (!pointGeometryTiming) {
    failures.push(
      `${label}: ${timingLabel} threshold was configured but point geometry timing was not reported.`,
    );
    return;
  }

  const value = pointGeometryTiming[timingKey];

  if (!Number.isFinite(value) || value > threshold) {
    failures.push(
      `${label}: ${timingLabel} ${formatMilliseconds(value)} > ${threshold} ms.`,
    );
  }
}

function checkDecodedPointDataCacheStats(
  failures,
  label,
  stats,
  requireAggregateLimit,
) {
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) {
    failures.push(
      `${label}: decoded point-data cache stats were not reported as an object.`,
    );
    return;
  }

  checkDecodedPointDataCacheScopeStats(
    failures,
    label,
    "aggregate",
    stats,
    requireAggregateLimit,
  );

  const poolStats = [
    ["point-sample", stats.pointSample],
    ["integrated-geometry", stats.integratedPointGeometry],
  ];

  for (const [poolLabel, pool] of poolStats) {
    if (!pool || typeof pool !== "object" || Array.isArray(pool)) {
      failures.push(
        `${label}: decoded point-data ${poolLabel} cache stats were not reported as an object.`,
      );
      continue;
    }

    checkDecodedPointDataCacheScopeStats(
      failures,
      label,
      poolLabel,
      pool,
      false,
    );
  }

  if (
    poolStats.every(([, pool]) => pool && typeof pool === "object") &&
    Number.isSafeInteger(stats.retainedBytes)
  ) {
    const poolRetainedByteValues = poolStats.map(
      ([, pool]) => pool.retainedBytes,
    );

    if (poolRetainedByteValues.every(Number.isSafeInteger)) {
      const poolRetainedBytes = poolRetainedByteValues.reduce(
        (total, retainedBytes) => total + retainedBytes,
        0,
      );

      if (poolRetainedBytes !== stats.retainedBytes) {
        failures.push(
          `${label}: decoded point-data aggregate retained bytes ${formatNumber(stats.retainedBytes)} do not match pool total ${formatNumber(poolRetainedBytes)}.`,
        );
      }
    }
  }
}

function checkDecodedPointDataCacheScopeStats(
  failures,
  label,
  scopeLabel,
  stats,
  requireLimit,
) {
  const fieldPrefix =
    scopeLabel === "aggregate"
      ? "decoded point-data cache"
      : `decoded point-data ${scopeLabel} cache`;

  for (const [key, fieldLabel] of [
    ["workerCount", "worker count"],
    ["retainedViewCount", "retained view count"],
    ["retainedBytes", "retained bytes"],
    ["peakRetainedBytes", "peak retained bytes"],
    ["cacheHitCount", "cache hit count"],
    ["cacheMissCount", "cache miss count"],
    ["cacheEvictionCount", "cache eviction count"],
    ["oversizedEntrySkipCount", "oversized entry skip count"],
    ["affinityEntryCount", "affinity entry count"],
  ]) {
    if (!Number.isSafeInteger(stats[key]) || stats[key] < 0) {
      failures.push(
        `${label}: ${fieldPrefix} ${fieldLabel} ${formatNumber(stats[key])} must be a non-negative safe integer.`,
      );
    }
  }

  checkDecodedPointDataCacheByteLimit(
    failures,
    label,
    scopeLabel,
    stats,
    requireLimit,
  );
}

function checkDecodedPointDataCacheByteLimit(
  failures,
  label,
  scopeLabel,
  stats,
  requireLimit,
) {
  const limit = stats.maxDecodedPointDataViewBytesAcrossWorkers;

  if (limit === undefined) {
    if (requireLimit) {
      failures.push(
        `${label}: decoded point-data ${scopeLabel} byte limit was not reported.`,
      );
    }
    return;
  }

  if (!Number.isSafeInteger(limit) || limit <= 0) {
    failures.push(
      `${label}: decoded point-data ${scopeLabel} byte limit ${formatNumber(limit)} must be a positive safe integer.`,
    );
    return;
  }

  for (const [key, fieldLabel] of [
    ["retainedBytes", "retained bytes"],
    ["peakRetainedBytes", "peak retained bytes"],
  ]) {
    const value = stats[key];

    if (Number.isSafeInteger(value) && value > limit) {
      failures.push(
        `${label}: decoded point-data ${scopeLabel} ${fieldLabel} ${formatNumber(value)} exceeds ${formatNumber(limit)} byte limit.`,
      );
    }
  }
}

function hasTerminalRefinementEvidence(result) {
  return [
    "terminalRefinementDurationMilliseconds",
    "terminalRefinementFrameDeltas",
    "terminalRefinementSummary",
  ].some((key) => Object.prototype.hasOwnProperty.call(result, key));
}

function checkTerminalRefinementSummary(failures, label, result) {
  const durationMilliseconds = result.terminalRefinementDurationMilliseconds;
  const summary = result.terminalRefinementSummary;

  if (!Number.isFinite(durationMilliseconds) || durationMilliseconds < 0) {
    failures.push(
      `${label}: terminal refinement duration ${formatMilliseconds(durationMilliseconds)} must be a finite non-negative number.`,
    );
  }

  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    failures.push(
      `${label}: terminal refinement frame summary was not reported as an object.`,
    );
    return;
  }

  const finiteNonNegativeFields = [
    ["averageFrameMilliseconds", "average frame"],
    ["medianFrameMilliseconds", "median frame"],
    ["p95FrameMilliseconds", "p95 frame"],
    ["maxFrameMilliseconds", "max frame"],
    ["estimatedAverageFps", "estimated average FPS"],
  ];
  const nonNegativeIntegerFields = [
    ["frameCount", "frame count"],
    ["frameDeltasOver50Milliseconds", "frames over 50 ms"],
    ["frameDeltasOver100Milliseconds", "frames over 100 ms"],
  ];

  for (const [key, fieldLabel] of finiteNonNegativeFields) {
    const value = summary[key];

    if (!Number.isFinite(value) || value < 0) {
      failures.push(
        `${label}: terminal refinement ${fieldLabel} ${formatNumber(value)} must be a finite non-negative number.`,
      );
    }
  }

  for (const [key, fieldLabel] of nonNegativeIntegerFields) {
    const value = summary[key];

    if (!Number.isInteger(value) || value < 0) {
      failures.push(
        `${label}: terminal refinement ${fieldLabel} ${formatNumber(value)} must be a non-negative integer.`,
      );
    }
  }

  const frameCount = summary.frameCount;
  const framesOver50Milliseconds = summary.frameDeltasOver50Milliseconds;
  const framesOver100Milliseconds = summary.frameDeltasOver100Milliseconds;
  const hasValidFrameCount = Number.isInteger(frameCount) && frameCount >= 0;

  if (hasValidFrameCount) {
    for (const [value, fieldLabel] of [
      [framesOver50Milliseconds, "frames over 50 ms"],
      [framesOver100Milliseconds, "frames over 100 ms"],
    ]) {
      if (Number.isInteger(value) && value > frameCount) {
        failures.push(
          `${label}: terminal refinement ${fieldLabel} ${value} exceeds frame count ${frameCount}.`,
        );
      }
    }
  }

  if (
    Number.isInteger(framesOver50Milliseconds) &&
    Number.isInteger(framesOver100Milliseconds) &&
    framesOver100Milliseconds > framesOver50Milliseconds
  ) {
    failures.push(
      `${label}: terminal refinement frames over 100 ms ${framesOver100Milliseconds} exceeds frames over 50 ms ${framesOver50Milliseconds}.`,
    );
  }

  const frameDeltas = result.terminalRefinementFrameDeltas;
  let recomputedSummary;

  if (frameDeltas !== undefined) {
    if (!Array.isArray(frameDeltas)) {
      failures.push(
        `${label}: terminal refinement frame deltas were not reported as an array.`,
      );
    } else {
      const invalidFrameDeltaIndex = frameDeltas.findIndex(
        (value) => !Number.isFinite(value) || value < 0,
      );

      if (invalidFrameDeltaIndex !== -1) {
        failures.push(
          `${label}: terminal refinement frame delta ${invalidFrameDeltaIndex} must be a finite non-negative number.`,
        );
      } else {
        recomputedSummary = summarizeTerminalRefinementFrames(frameDeltas);

        if (hasValidFrameCount && frameDeltas.length !== frameCount) {
          failures.push(
            `${label}: terminal refinement frame count ${frameCount} does not match ${frameDeltas.length} recorded frame deltas.`,
          );
        }

        for (const [key, fieldLabel] of [
          ["averageFrameMilliseconds", "average frame"],
          ["medianFrameMilliseconds", "median frame"],
          ["p95FrameMilliseconds", "p95 frame"],
          ["maxFrameMilliseconds", "max frame"],
          ["estimatedAverageFps", "estimated average FPS"],
        ]) {
          const reportedValue = summary[key];
          const recomputedValue = recomputedSummary[key];

          if (
            Number.isFinite(reportedValue) &&
            Number.isFinite(recomputedValue) &&
            Math.abs(reportedValue - recomputedValue) > 0.01
          ) {
            failures.push(
              `${label}: terminal refinement ${fieldLabel} ${formatNumber(reportedValue)} does not match recomputed ${formatNumber(recomputedValue)}.`,
            );
          }
        }

        for (const [key, fieldLabel] of [
          ["frameDeltasOver50Milliseconds", "frames over 50 ms"],
          ["frameDeltasOver100Milliseconds", "frames over 100 ms"],
        ]) {
          const reportedValue = summary[key];
          const recomputedValue = recomputedSummary[key];

          if (
            Number.isInteger(reportedValue) &&
            reportedValue !== recomputedValue
          ) {
            failures.push(
              `${label}: terminal refinement ${fieldLabel} ${reportedValue} does not match recomputed ${recomputedValue}.`,
            );
          }
        }
      }
    }
  }

  if (!hasValidFrameCount) {
    return;
  }

  if (frameCount === 0) {
    for (const [key, fieldLabel] of [
      ...finiteNonNegativeFields,
      ["frameDeltasOver50Milliseconds", "frames over 50 ms"],
      ["frameDeltasOver100Milliseconds", "frames over 100 ms"],
    ]) {
      const value = summary[key];

      if (Number.isFinite(value) && value !== 0) {
        failures.push(
          `${label}: terminal refinement ${fieldLabel} ${formatNumber(value)} must be 0 when no refinement frames were recorded.`,
        );
      }
    }

    if (
      Number.isFinite(durationMilliseconds) &&
      durationMilliseconds > thresholds.maxP95FrameMilliseconds
    ) {
      failures.push(
        `${label}: terminal refinement recorded no frames over ${formatMilliseconds(durationMilliseconds)}; zero-frame completion must be at most ${thresholds.maxP95FrameMilliseconds} ms.`,
      );
    }

    return;
  }

  if (Number.isFinite(durationMilliseconds) && durationMilliseconds === 0) {
    failures.push(
      `${label}: terminal refinement duration must be positive when ${frameCount} refinement frames were recorded.`,
    );
  }

  for (const [key, fieldLabel] of finiteNonNegativeFields) {
    const value = summary[key];

    if (Number.isFinite(value) && value === 0) {
      failures.push(
        `${label}: terminal refinement ${fieldLabel} must be positive when refinement frames were recorded.`,
      );
    }
  }

  if (
    Number.isFinite(summary.medianFrameMilliseconds) &&
    Number.isFinite(summary.p95FrameMilliseconds) &&
    summary.medianFrameMilliseconds > summary.p95FrameMilliseconds
  ) {
    failures.push(
      `${label}: terminal refinement median frame ${formatMilliseconds(summary.medianFrameMilliseconds)} exceeds p95 frame ${formatMilliseconds(summary.p95FrameMilliseconds)}.`,
    );
  }

  for (const [key, fieldLabel] of [
    ["averageFrameMilliseconds", "average frame"],
    ["medianFrameMilliseconds", "median frame"],
    ["p95FrameMilliseconds", "p95 frame"],
  ]) {
    const value = summary[key];

    if (
      Number.isFinite(value) &&
      Number.isFinite(summary.maxFrameMilliseconds) &&
      value > summary.maxFrameMilliseconds
    ) {
      failures.push(
        `${label}: terminal refinement ${fieldLabel} ${formatMilliseconds(value)} exceeds max frame ${formatMilliseconds(summary.maxFrameMilliseconds)}.`,
      );
    }
  }

  const thresholdSummary = recomputedSummary ?? summary;

  if (
    !Number.isFinite(thresholdSummary.estimatedAverageFps) ||
    thresholdSummary.estimatedAverageFps < thresholds.minAverageFps
  ) {
    failures.push(
      `${label}: terminal refinement average FPS ${formatNumber(thresholdSummary.estimatedAverageFps)} < ${thresholds.minAverageFps}.`,
    );
  }

  if (
    Number.isFinite(thresholdSummary.p95FrameMilliseconds) &&
    thresholdSummary.p95FrameMilliseconds > thresholds.maxP95FrameMilliseconds
  ) {
    failures.push(
      `${label}: terminal refinement p95 frame ${formatMilliseconds(thresholdSummary.p95FrameMilliseconds)} > ${thresholds.maxP95FrameMilliseconds} ms.`,
    );
  }

  if (
    Number.isFinite(thresholdSummary.maxFrameMilliseconds) &&
    thresholdSummary.maxFrameMilliseconds > thresholds.maxFrameMilliseconds
  ) {
    failures.push(
      `${label}: terminal refinement max frame ${formatMilliseconds(thresholdSummary.maxFrameMilliseconds)} > ${thresholds.maxFrameMilliseconds} ms.`,
    );
  }

  if (
    Number.isInteger(thresholdSummary.frameDeltasOver100Milliseconds) &&
    thresholdSummary.frameDeltasOver100Milliseconds >
      thresholds.maxTerminalRefinementFramesOver100Milliseconds
  ) {
    failures.push(
      `${label}: terminal refinement ${thresholdSummary.frameDeltasOver100Milliseconds} frames over 100 ms > ${thresholds.maxTerminalRefinementFramesOver100Milliseconds}.`,
    );
  }
}

function summarizeTerminalRefinementFrames(frameDeltas) {
  if (frameDeltas.length === 0) {
    return {
      frameCount: 0,
      averageFrameMilliseconds: 0,
      medianFrameMilliseconds: 0,
      p95FrameMilliseconds: 0,
      maxFrameMilliseconds: 0,
      estimatedAverageFps: 0,
      frameDeltasOver50Milliseconds: 0,
      frameDeltasOver100Milliseconds: 0,
    };
  }

  const averageFrameMilliseconds =
    frameDeltas.reduce((sum, value) => sum + value, 0) / frameDeltas.length;
  const sortedFrameDeltas = [...frameDeltas].sort(
    (left, right) => left - right,
  );
  const percentile = (ratio) => {
    const index = Math.max(0, Math.ceil(sortedFrameDeltas.length * ratio) - 1);
    return sortedFrameDeltas[index] ?? 0;
  };

  return {
    frameCount: frameDeltas.length,
    averageFrameMilliseconds,
    medianFrameMilliseconds: percentile(0.5),
    p95FrameMilliseconds: percentile(0.95),
    maxFrameMilliseconds: Math.max(...frameDeltas),
    estimatedAverageFps: 1000 / averageFrameMilliseconds,
    frameDeltasOver50Milliseconds: frameDeltas.filter((delta) => delta > 50)
      .length,
    frameDeltasOver100Milliseconds: frameDeltas.filter((delta) => delta > 100)
      .length,
  };
}

function checkOptionalAveragePointGeometryTimingThreshold(
  failures,
  label,
  pointGeometryTiming,
  timingKey,
  threshold,
  timingLabel,
) {
  if (threshold === undefined) {
    return;
  }

  if (!pointGeometryTiming) {
    failures.push(
      `${label}: ${timingLabel} threshold was configured but point geometry timing was not reported.`,
    );
    return;
  }

  const nodeCount = pointGeometryTiming.nodeCount;
  const value = pointGeometryTiming[timingKey];
  const averageValue =
    Number.isFinite(value) && Number.isFinite(nodeCount) && nodeCount > 0
      ? value / nodeCount
      : Number.NaN;

  if (!Number.isFinite(averageValue) || averageValue > threshold) {
    failures.push(
      `${label}: ${timingLabel} ${formatMilliseconds(averageValue)} > ${threshold} ms.`,
    );
  }
}

function checkOptionalMinimumGeometryCacheHitThreshold(
  failures,
  label,
  result,
  threshold,
  timingLabel,
) {
  if (threshold === undefined) {
    return;
  }

  const value = readObservedGeometryCacheHitCount(result);

  if (!Number.isFinite(value)) {
    failures.push(
      `${label}: ${timingLabel} threshold was configured but neither point-geometry timing nor the layer cache delta reported a hit count.`,
    );
    return;
  }

  if (value < threshold) {
    failures.push(
      `${label}: ${timingLabel} ${formatNumber(value)} < ${threshold}.`,
    );
  }
}

function readObservedGeometryCacheHitCount(result) {
  const timingHitCount = result.pointGeometryTiming?.cacheHitCount;
  const layerCacheHitDelta =
    result.geometryCacheDelta?.hitCount ??
    result.pointGeometryTiming?.geometryCacheDelta?.hitCount;
  const observedCounts = [timingHitCount, layerCacheHitDelta].filter(
    Number.isFinite,
  );

  return observedCounts.length > 0 ? Math.max(...observedCounts) : undefined;
}

function summarizeResult(result, failures) {
  const summary = result.summary ?? {};
  const diagnostics =
    result.cameraStreamDiagnostics ??
    result.status?.cameraStreamDiagnosticsData ??
    {};
  const measuredDurationOverrunMilliseconds = Number.isFinite(
    result.measuredDurationMilliseconds,
  )
    ? result.measuredDurationMilliseconds - benchmarkDurationMilliseconds
    : undefined;

  return {
    sampleId: result.sampleId,
    runIndex: result.runIndex,
    streamPointBudget: result.streamPointBudget,
    appliedStreamPointBudget: result.appliedStreamPointBudget,
    renderedPointCount: result.renderedPointCount,
    finalNodeCount: result.finalNodeCount,
    renderedFinalNodeCount: result.renderedFinalNodeCount,
    renderedFinalNodeCoverageRatio: result.renderedFinalNodeCoverageRatio,
    renderedFinalNodeWeightCoverageRatio:
      result.renderedFinalNodeWeightCoverageRatio,
    cameraStreamVisualQuality:
      result.cameraStreamVisualQuality ??
      result.status?.cameraStreamVisualQuality,
    renderedPointsPerFinalNode:
      Number.isFinite(result.renderedPointCount) &&
      Number.isFinite(result.renderedFinalNodeCount) &&
      result.renderedFinalNodeCount > 0
        ? result.renderedPointCount / result.renderedFinalNodeCount
        : undefined,
    measuredDurationMilliseconds: result.measuredDurationMilliseconds,
    measuredDurationOverrunMilliseconds,
    averageFps: summary.estimatedAverageFps,
    p95FrameMilliseconds: summary.p95FrameMilliseconds,
    maxFrameMilliseconds: summary.maxFrameMilliseconds,
    framesOver50Milliseconds: summary.frameDeltasOver50Milliseconds,
    terminalRefinementDurationMilliseconds:
      result.terminalRefinementDurationMilliseconds,
    terminalRefinementSummary: result.terminalRefinementSummary,
    cameraStreamFirstResponseMilliseconds:
      result.cameraStreamFirstResponseMilliseconds,
    cameraStreamTotalMilliseconds: diagnostics.totalMilliseconds,
    cameraStreamMode: waitForFinalDetail ? "final-detail" : "interactive",
    cameraStreamPrefetch: result.cameraStreamPrefetch,
    postPrefetchRefinement: result.postPrefetchRefinement,
    maxGeometryRoundTripMilliseconds:
      result.pointGeometryTiming?.maxRequestRoundTripMilliseconds,
    maxGeometryDecodeMilliseconds:
      result.pointGeometryTiming?.maxDecodeMilliseconds,
    maxGeometryWorkerMilliseconds:
      result.pointGeometryTiming?.maxWorkerMilliseconds,
    maxGeometryQueueMilliseconds:
      result.pointGeometryTiming?.maxQueueMilliseconds,
    geometryCacheHitCount: readObservedGeometryCacheHitCount(result),
    pointGeometryCacheHitCount: result.pointGeometryTiming?.cacheHitCount,
    pointGeometryTimingEvidenceSource:
      result.pointGeometryTiming?.evidenceSource,
    geometryCacheHitDelta:
      result.geometryCacheDelta?.hitCount ??
      result.pointGeometryTiming?.geometryCacheDelta?.hitCount,
    decodedPointDataCache:
      result.decodedPointDataCache ?? result.status?.decodedPointDataCache,
    averageGeometryQueueMilliseconds: result.pointGeometryTiming
      ? result.pointGeometryTiming.sumQueueMilliseconds /
        Math.max(1, result.pointGeometryTiming.nodeCount)
      : undefined,
    selectedDepth: diagnostics.selectedDepth,
    passed: failures.length === 0,
    failures,
  };
}

function createResultLabel(result) {
  return [
    result.sampleId ?? "unknown-sample",
    `budget=${formatNumber(result.streamPointBudget)}`,
    `run=${formatNumber(result.runIndex)}`,
  ].join(" ");
}

function readStringArg(name) {
  const index = process.argv.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  const value = process.argv[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a path value.`);
  }

  return path.resolve(value);
}

function readNumberEnv(name, fallback) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }

  return value;
}

function readOptionalStringEnv(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function readBooleanEnv(name, fallback) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  return rawValue === "1" || rawValue.toLowerCase() === "true";
}

function readIntegerEnv(name, fallback) {
  const value = readNumberEnv(name, fallback);

  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer.`);
  }

  return value;
}

function readNonNegativeIntegerEnv(name, fallback) {
  const value = readIntegerEnv(name, fallback);

  if (value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }

  return value;
}

function readOptionalIntegerEnv(name) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return undefined;
  }

  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }

  return value;
}

function readOptionalNumberEnv(name) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return undefined;
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }

  return value;
}

function formatMilliseconds(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} ms` : String(value);
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : String(value);
}

function formatPercent(value) {
  return Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : String(value);
}
