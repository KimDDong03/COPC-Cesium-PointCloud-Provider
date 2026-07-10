import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outputRoot = path.join(repoRoot, "output");
const defaultBenchmarkRoot = path.join(outputRoot, "smoothness-benchmark");
const defaultInputPath = path.join(defaultBenchmarkRoot, "smoothness-assertion.json");
const defaultOutputPath = path.join(
  defaultBenchmarkRoot,
  "smoothness-regression.json",
);

const inputPath = readStringArg("--input") ?? defaultInputPath;
const baselinePath = readStringArg("--baseline") ?? readFirstPositionalArg();
const outputPath = readStringArg("--output") ?? defaultOutputPath;

if (!baselinePath) {
  throw new Error(
    "A baseline report is required. Pass <path-to-smoothness-assertion.json> or --baseline <path>.",
  );
}

const thresholds = {
  minAverageFpsRatio: readNumberEnv(
    "COPC_SMOOTHNESS_REGRESSION_MIN_AVG_FPS_RATIO",
    0.9,
  ),
  maxP95FrameRatio: readNumberEnv(
    "COPC_SMOOTHNESS_REGRESSION_MAX_P95_FRAME_RATIO",
    1.2,
  ),
  maxFrameRatio: readNumberEnv(
    "COPC_SMOOTHNESS_REGRESSION_MAX_FRAME_RATIO",
    1.35,
  ),
  maxFramesOver50Ratio: readNumberEnv(
    "COPC_SMOOTHNESS_REGRESSION_MAX_FRAMES_OVER_50_RATIO",
    1.5,
  ),
  maxCameraStreamTotalRatio: readNumberEnv(
    "COPC_SMOOTHNESS_REGRESSION_MAX_STREAM_TOTAL_RATIO",
    1.2,
  ),
  maxCameraStreamFirstResponseRatio: readNumberEnv(
    "COPC_SMOOTHNESS_REGRESSION_MAX_FIRST_RESPONSE_RATIO",
    1.2,
  ),
  maxAverageGeometryQueueRatio: readNumberEnv(
    "COPC_SMOOTHNESS_REGRESSION_MAX_AVG_GEOMETRY_QUEUE_RATIO",
    1.3,
  ),
  minRenderedPointRatio: readNumberEnv(
    "COPC_SMOOTHNESS_REGRESSION_MIN_RENDERED_POINT_RATIO",
    0.85,
  ),
  maxCoverageDrop: readNumberEnv(
    "COPC_SMOOTHNESS_REGRESSION_MAX_COVERAGE_DROP",
    0.05,
  ),
  requireSameBrowserGraphics: readBooleanEnv(
    "COPC_SMOOTHNESS_REGRESSION_REQUIRE_SAME_GPU",
    true,
  ),
};

const current = JSON.parse(await readFile(inputPath, "utf8"));
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const currentGroups = groupResults(readSmoothnessResults(current));
const baselineGroups = groupResults(readSmoothnessResults(baseline));
const currentBrowserGraphics = current.browserGraphics;
const baselineBrowserGraphics = baseline.browserGraphics;
const failures = [];
const comparisons = [];

compareBrowserGraphics(
  currentBrowserGraphics,
  baselineBrowserGraphics,
  failures,
);

for (const [key, baselineGroup] of baselineGroups) {
  const currentGroup = currentGroups.get(key);

  if (!currentGroup) {
    failures.push(`${key}: missing current benchmark group.`);
    comparisons.push({
      key,
      baseline: baselineGroup,
      current: undefined,
      passed: false,
      failures: [`${key}: missing current benchmark group.`],
    });
    continue;
  }

  const groupFailures = compareGroup(key, currentGroup, baselineGroup);

  failures.push(...groupFailures);
  comparisons.push({
    key,
    baseline: baselineGroup,
    current: currentGroup,
    passed: groupFailures.length === 0,
    failures: groupFailures,
  });
}

const regression = {
  inputPath,
  baselinePath,
  currentBrowserGraphics,
  baselineBrowserGraphics,
  thresholds,
  comparedGroupCount: comparisons.length,
  failureCount: failures.length,
  comparisons,
  failures,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(regression, null, 2)}\n`);

if (failures.length > 0) {
  console.error(
    [
      `Smoothness regression assertion failed with ${failures.length} issue(s).`,
      ...failures.map((failure) => `- ${failure}`),
      `Regression report: ${outputPath}`,
    ].join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(
    `Smoothness regression assertion passed for ${comparisons.length} group(s): ${outputPath}`,
  );
}

function compareBrowserGraphics(currentGraphics, baselineGraphics, failures) {
  if (!thresholds.requireSameBrowserGraphics) {
    return;
  }

  const currentRenderer = currentGraphics?.renderer?.trim();
  const baselineRenderer = baselineGraphics?.renderer?.trim();

  if (!currentRenderer || !baselineRenderer) {
    failures.push(
      "Current and baseline reports must both include browserGraphics.renderer.",
    );
    return;
  }

  if (currentRenderer !== baselineRenderer) {
    failures.push(
      `Browser WebGL renderer changed from "${baselineRenderer}" to "${currentRenderer}"; performance reports are not comparable.`,
    );
  }
}

function readSmoothnessResults(report) {
  if (Array.isArray(report.checkedResults)) {
    return report.checkedResults.map(normalizeAssertionResult);
  }

  if (Array.isArray(report.results)) {
    return report.results.map(normalizeBenchmarkResult);
  }

  throw new Error(
    "Smoothness report must contain checkedResults or raw benchmark results.",
  );
}

function normalizeAssertionResult(result) {
  return {
    sampleId: result.sampleId ?? "unknown-sample",
    streamPointBudget: readFiniteNumber(result.streamPointBudget, 0),
    renderedPointCount: readFiniteNumber(result.renderedPointCount, 0),
    renderedFinalNodeCoverageRatio: readFiniteNumber(
      result.renderedFinalNodeCoverageRatio,
      0,
    ),
    renderedFinalNodeWeightCoverageRatio: readFiniteNumber(
      result.renderedFinalNodeWeightCoverageRatio,
      result.renderedFinalNodeCoverageRatio,
    ),
    averageFps: readFiniteNumber(result.averageFps, 0),
    p95FrameMilliseconds: readFiniteNumber(result.p95FrameMilliseconds, 0),
    maxFrameMilliseconds: readFiniteNumber(result.maxFrameMilliseconds, 0),
    framesOver50Milliseconds: readFiniteNumber(
      result.framesOver50Milliseconds,
      0,
    ),
    cameraStreamTotalMilliseconds: readFiniteNumber(
      result.cameraStreamTotalMilliseconds,
      0,
    ),
    cameraStreamFirstResponseMilliseconds: readOptionalFiniteNumber(
      result.cameraStreamFirstResponseMilliseconds,
    ),
    averageGeometryQueueMilliseconds: readOptionalFiniteNumber(
      result.averageGeometryQueueMilliseconds,
    ),
  };
}

function normalizeBenchmarkResult(result) {
  const summary = result.summary ?? {};
  const diagnostics =
    result.cameraStreamDiagnostics ??
    result.status?.cameraStreamDiagnosticsData ??
    {};
  const pointGeometryTiming = result.pointGeometryTiming;

  return {
    sampleId: result.sampleId ?? "unknown-sample",
    streamPointBudget: readFiniteNumber(result.streamPointBudget, 0),
    renderedPointCount: readFiniteNumber(result.renderedPointCount, 0),
    renderedFinalNodeCoverageRatio: readFiniteNumber(
      result.renderedFinalNodeCoverageRatio,
      0,
    ),
    renderedFinalNodeWeightCoverageRatio: readFiniteNumber(
      result.renderedFinalNodeWeightCoverageRatio,
      result.renderedFinalNodeCoverageRatio,
    ),
    averageFps: readFiniteNumber(summary.estimatedAverageFps, 0),
    p95FrameMilliseconds: readFiniteNumber(summary.p95FrameMilliseconds, 0),
    maxFrameMilliseconds: readFiniteNumber(summary.maxFrameMilliseconds, 0),
    framesOver50Milliseconds: readFiniteNumber(
      summary.frameDeltasOver50Milliseconds,
      0,
    ),
    cameraStreamTotalMilliseconds: readFiniteNumber(
      diagnostics.totalMilliseconds,
      0,
    ),
    cameraStreamFirstResponseMilliseconds: readOptionalFiniteNumber(
      result.cameraStreamFirstResponseMilliseconds,
    ),
    averageGeometryQueueMilliseconds: pointGeometryTiming
      ? readFiniteNumber(pointGeometryTiming.sumQueueMilliseconds, 0) /
        Math.max(1, readFiniteNumber(pointGeometryTiming.nodeCount, 0))
      : undefined,
  };
}

function groupResults(results) {
  const groupedValues = new Map();

  for (const result of results) {
    const key = createGroupKey(result);
    groupedValues.set(key, [...(groupedValues.get(key) ?? []), result]);
  }

  return new Map(
    [...groupedValues].map(([key, groupResults]) => [
      key,
      summarizeGroup(groupResults),
    ]),
  );
}

function summarizeGroup(results) {
  return {
    sampleId: results[0]?.sampleId ?? "unknown-sample",
    streamPointBudget: results[0]?.streamPointBudget ?? 0,
    runCount: results.length,
    averageFps: average(results.map((result) => result.averageFps)),
    p95FrameMilliseconds: average(
      results.map((result) => result.p95FrameMilliseconds),
    ),
    maxFrameMilliseconds: Math.max(
      ...results.map((result) => result.maxFrameMilliseconds),
    ),
    framesOver50Milliseconds: results.reduce(
      (sum, result) => sum + result.framesOver50Milliseconds,
      0,
    ),
    cameraStreamTotalMilliseconds: average(
      results.map((result) => result.cameraStreamTotalMilliseconds),
    ),
    cameraStreamFirstResponseMilliseconds: averageDefined(
      results.map((result) => result.cameraStreamFirstResponseMilliseconds),
    ),
    averageGeometryQueueMilliseconds: averageDefined(
      results.map((result) => result.averageGeometryQueueMilliseconds),
    ),
    renderedPointCount: average(
      results.map((result) => result.renderedPointCount),
    ),
    renderedFinalNodeCoverageRatio: average(
      results.map((result) => result.renderedFinalNodeCoverageRatio),
    ),
    renderedFinalNodeWeightCoverageRatio: average(
      results.map((result) => result.renderedFinalNodeWeightCoverageRatio),
    ),
  };
}

function compareGroup(key, current, baseline) {
  const failures = [];

  checkMinimumRatio(
    failures,
    key,
    "average FPS",
    current.averageFps,
    baseline.averageFps,
    thresholds.minAverageFpsRatio,
  );
  checkMaximumRatio(
    failures,
    key,
    "p95 frame",
    current.p95FrameMilliseconds,
    baseline.p95FrameMilliseconds,
    thresholds.maxP95FrameRatio,
  );
  checkMaximumRatio(
    failures,
    key,
    "max frame",
    current.maxFrameMilliseconds,
    baseline.maxFrameMilliseconds,
    thresholds.maxFrameRatio,
  );
  checkMaximumRatio(
    failures,
    key,
    "frames over 50 ms",
    current.framesOver50Milliseconds,
    baseline.framesOver50Milliseconds,
    thresholds.maxFramesOver50Ratio,
  );
  checkMaximumRatio(
    failures,
    key,
    "camera stream total",
    current.cameraStreamTotalMilliseconds,
    baseline.cameraStreamTotalMilliseconds,
    thresholds.maxCameraStreamTotalRatio,
  );
  checkOptionalMaximumRatio(
    failures,
    key,
    "camera stream first response",
    current.cameraStreamFirstResponseMilliseconds,
    baseline.cameraStreamFirstResponseMilliseconds,
    thresholds.maxCameraStreamFirstResponseRatio,
  );
  checkOptionalMaximumRatio(
    failures,
    key,
    "average geometry queue",
    current.averageGeometryQueueMilliseconds,
    baseline.averageGeometryQueueMilliseconds,
    thresholds.maxAverageGeometryQueueRatio,
  );
  checkMinimumRatio(
    failures,
    key,
    "rendered points",
    current.renderedPointCount,
    baseline.renderedPointCount,
    thresholds.minRenderedPointRatio,
  );

  if (
    current.renderedFinalNodeCoverageRatio <
    baseline.renderedFinalNodeCoverageRatio - thresholds.maxCoverageDrop
  ) {
    failures.push(
      `${key}: current-view coverage ${formatPercent(
        current.renderedFinalNodeCoverageRatio,
      )} dropped below baseline ${formatPercent(
        baseline.renderedFinalNodeCoverageRatio,
      )} by more than ${formatPercent(thresholds.maxCoverageDrop)}.`,
    );
  }

  if (
    current.renderedFinalNodeWeightCoverageRatio <
    baseline.renderedFinalNodeWeightCoverageRatio - thresholds.maxCoverageDrop
  ) {
    failures.push(
      `${key}: weighted current-view coverage ${formatPercent(
        current.renderedFinalNodeWeightCoverageRatio,
      )} dropped below baseline ${formatPercent(
        baseline.renderedFinalNodeWeightCoverageRatio,
      )} by more than ${formatPercent(thresholds.maxCoverageDrop)}.`,
    );
  }

  return failures;
}

function checkMinimumRatio(
  failures,
  key,
  label,
  currentValue,
  baselineValue,
  minRatio,
) {
  if (!Number.isFinite(currentValue) || !Number.isFinite(baselineValue)) {
    failures.push(`${key}: ${label} could not be compared.`);
    return;
  }

  if (baselineValue <= 0) {
    return;
  }

  const ratio = currentValue / baselineValue;

  if (ratio < minRatio) {
    failures.push(
      `${key}: ${label} ${formatNumber(currentValue)} is ${formatRatio(
        ratio,
      )} of baseline ${formatNumber(baselineValue)}, below ${formatRatio(
        minRatio,
      )}.`,
    );
  }
}

function checkMaximumRatio(
  failures,
  key,
  label,
  currentValue,
  baselineValue,
  maxRatio,
) {
  if (!Number.isFinite(currentValue) || !Number.isFinite(baselineValue)) {
    failures.push(`${key}: ${label} could not be compared.`);
    return;
  }

  if (baselineValue <= 0) {
    if (currentValue > 0) {
      failures.push(
        `${key}: ${label} increased from 0 to ${formatNumber(currentValue)}.`,
      );
    }
    return;
  }

  const ratio = currentValue / baselineValue;

  if (ratio > maxRatio) {
    failures.push(
      `${key}: ${label} ${formatNumber(currentValue)} is ${formatRatio(
        ratio,
      )} of baseline ${formatNumber(baselineValue)}, above ${formatRatio(
        maxRatio,
      )}.`,
    );
  }
}

function checkOptionalMaximumRatio(
  failures,
  key,
  label,
  currentValue,
  baselineValue,
  maxRatio,
) {
  if (currentValue === undefined && baselineValue === undefined) {
    return;
  }

  checkMaximumRatio(failures, key, label, currentValue, baselineValue, maxRatio);
}

function createGroupKey(result) {
  return `${result.sampleId}:budget=${result.streamPointBudget}`;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function averageDefined(values) {
  const definedValues = values.filter((value) => value !== undefined);

  return definedValues.length === 0 ? undefined : average(definedValues);
}

function readFiniteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function readOptionalFiniteNumber(value) {
  return Number.isFinite(value) ? value : undefined;
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

function readFirstPositionalArg() {
  const valueOptions = new Set(["--baseline", "--input", "--output"]);

  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];

    if (valueOptions.has(value)) {
      index += 1;
      continue;
    }

    if (!value.startsWith("--")) {
      return path.resolve(value);
    }
  }

  return undefined;
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

function readBooleanEnv(name, fallback) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  return rawValue === "1" || rawValue.toLowerCase() === "true";
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : String(value);
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : String(value);
}

function formatRatio(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}x` : String(value);
}
