import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outputRoot = path.join(repoRoot, "output");
const defaultBenchmarkRoot = path.join(outputRoot, "smoothness-benchmark");
const defaultInputPath = path.join(defaultBenchmarkRoot, "smoothness.json");
const defaultOutputPath = path.join(defaultBenchmarkRoot, "smoothness-assertion.json");

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
    0.9,
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
const results = readBenchmarkResults(benchmark);
const benchmarkDurationMilliseconds = Number(benchmark.durationMilliseconds);
const waitForFinalDetail = benchmark.waitForFinalDetail !== false;
const browserGraphics = benchmark.browserGraphics;
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
const failures = [];
checkBrowserGraphics(browserGraphics, failures);
const checkedResults = results.map((result) => {
  const resultFailures = checkResult(
    result,
    sampleMinimumDepthById,
    benchmarkDurationMilliseconds,
    waitForFinalDetail,
  );

  failures.push(...resultFailures);

  return summarizeResult(result, resultFailures);
});
const assertion = {
  inputPath,
  waitForFinalDetail,
  browserGraphics,
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

function checkResult(
  result,
  sampleMinimumDepthById,
  benchmarkDurationMilliseconds,
  waitForFinalDetail,
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

  const pointBudget = Number.isFinite(result.appliedStreamPointBudget)
    ? result.appliedStreamPointBudget
    : result.streamPointBudget;

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
    cameraStreamFirstResponseMilliseconds:
      result.cameraStreamFirstResponseMilliseconds,
    cameraStreamTotalMilliseconds: diagnostics.totalMilliseconds,
    cameraStreamMode: waitForFinalDetail ? "final-detail" : "interactive",
    cameraStreamPrefetch: result.cameraStreamPrefetch,
    maxGeometryRoundTripMilliseconds:
      result.pointGeometryTiming?.maxRequestRoundTripMilliseconds,
    maxGeometryDecodeMilliseconds:
      result.pointGeometryTiming?.maxDecodeMilliseconds,
    maxGeometryWorkerMilliseconds:
      result.pointGeometryTiming?.maxWorkerMilliseconds,
    maxGeometryQueueMilliseconds:
      result.pointGeometryTiming?.maxQueueMilliseconds,
    averageGeometryQueueMilliseconds:
      result.pointGeometryTiming
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
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : String(value);
}
