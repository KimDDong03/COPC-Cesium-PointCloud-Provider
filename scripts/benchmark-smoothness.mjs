import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_COPC_SAMPLE_URLS } from "../config/live-copc-sources.mjs";
import {
  createBrowserGpuRendererAssertionSource,
  resolveBrowserGpuProfile,
} from "./browser-gpu-profile.mjs";
import { isExpectedNonFatalWebGlDriverWarning } from "./browser-console-policy.mjs";
import { createRunEvidence } from "./run-evidence.mjs";
import { resolveLocalPackageBinary } from "./resolve-local-package-binary.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const playwrightCliPath = resolveLocalPackageBinary(
  repoRoot,
  "@playwright/cli",
  "playwright-cli",
);
const viteCliPath = resolveLocalPackageBinary(repoRoot, "vite", "vite");
const outputRoot = path.join(repoRoot, "output");
const benchmarkRoot = path.join(outputRoot, "smoothness-benchmark");
const benchmarkArtifactSchema = "copc-viewer.smoothness-benchmark";
const benchmarkArtifactSchemaVersion = 2;
const benchmarkOutputName = readBenchmarkOutputName();
const benchmarkProfile =
  process.env.COPC_SMOOTHNESS_QC_PRESET?.trim() || undefined;
const benchmarkResultPath = path.join(benchmarkRoot, benchmarkOutputName);
const benchmarkFlowPath = path.join(
  benchmarkRoot,
  `${path.parse(benchmarkOutputName).name}-flow.mjs`,
);
const basePlaywrightConfigPath = path.join(
  scriptDir,
  "playwright.high-performance-gpu.json",
);
const browserGpu = await resolveBrowserGpuProfile({
  baseConfigPath: basePlaywrightConfigPath,
  outputRoot,
});
const playwrightConfigPath = browserGpu.configPath;
const isWindows = process.platform === "win32";
const npmCommand = "npm";
const browserHeaded = readBooleanEnv("COPC_BROWSER_HEADED", false);

function readBenchmarkOutputName() {
  const outputName =
    process.env.COPC_SMOOTHNESS_OUTPUT_NAME?.trim() || "smoothness.json";

  if (
    path.basename(outputName) !== outputName ||
    !outputName.toLowerCase().endsWith(".json")
  ) {
    throw new Error(
      "COPC_SMOOTHNESS_OUTPUT_NAME must be a JSON filename without directories.",
    );
  }

  return outputName;
}
const benchmarkStreamPointBudgets = readPositiveIntegerListEnv(
  "COPC_SMOOTHNESS_POINT_BUDGETS",
  [2_500, 5_000, 10_000, 20_000],
);
const customMillsiteUrl = readOptionalHttpUrlEnv(
  "COPC_SMOOTHNESS_CUSTOM_MILLSITE_URL",
  LIVE_COPC_SAMPLE_URLS.millsiteReservoir,
);
const smoothnessSampleCaseById = {
  "autzen-classified": {
    id: "autzen-classified",
    label: "Autzen classified",
    kind: "preset",
    sampleId: "autzen-classified",
    expectedSourcePreset: "Autzen classified",
    expectedCoordinateTransformText: "EPSG:2992",
    expectedMinSelectedDepth: 2,
  },
  "millsite-reservoir": {
    id: "millsite-reservoir",
    label: "Millsite Reservoir (USGS 3DEP)",
    kind: "preset",
    sampleId: "millsite-reservoir",
    expectedSourcePreset: "Millsite Reservoir (USGS 3DEP)",
    expectedCoordinateTransformText: "EPSG:6341",
    expectedMinSelectedDepth: 2,
  },
  "custom-millsite": {
    id: "custom-millsite",
    label: "Custom Millsite URL",
    kind: "custom",
    url: customMillsiteUrl,
    sourceCrs: "EPSG:6341",
    sourceDefinition:
      "+proj=utm +zone=12 +ellps=GRS80 +units=m +no_defs +type=crs",
    expectedSourcePreset: "Custom URL",
    expectedCoordinateTransformText: "EPSG:6341 to EPSG:4326",
    expectedMinSelectedDepth: 2,
  },
};
const benchmarkSampleCases = readSampleCasesEnv("COPC_SMOOTHNESS_SAMPLES", [
  "autzen-classified",
  "millsite-reservoir",
  "custom-millsite",
]);
const benchmarkMaxPointCountPerNode = readPositiveIntegerEnv(
  "COPC_SMOOTHNESS_POINT_COUNT",
  Math.max(...benchmarkStreamPointBudgets),
);
const benchmarkRepeats = readPositiveIntegerEnv("COPC_SMOOTHNESS_REPEATS", 2);
const benchmarkWarmupRuns = readNonNegativeIntegerEnv(
  "COPC_SMOOTHNESS_WARMUP_RUNS",
  0,
);
const benchmarkWarmupSettleTimeoutMilliseconds = readNonNegativeIntegerEnv(
  "COPC_SMOOTHNESS_WARMUP_SETTLE_TIMEOUT_MS",
  30_000,
);
const benchmarkDurationMilliseconds = readPositiveIntegerEnv(
  "COPC_SMOOTHNESS_DURATION_MS",
  3000,
);
const benchmarkCameraSteps = readPositiveIntegerEnv(
  "COPC_SMOOTHNESS_CAMERA_STEPS",
  24,
);
const benchmarkMoveMeters = readPositiveIntegerEnv(
  "COPC_SMOOTHNESS_MOVE_METERS",
  25,
);
const benchmarkCameraHeightAboveCloudMeters = readPositiveNumberEnv(
  "COPC_SMOOTHNESS_CAMERA_HEIGHT_METERS",
  undefined,
);
const benchmarkMinSelectedDepthOverride = readNonNegativeIntegerEnv(
  "COPC_SMOOTHNESS_MIN_SELECTED_DEPTH",
  undefined,
);
const benchmarkPointRenderer = readPointRendererEnv(
  "COPC_SMOOTHNESS_RENDERER",
  "typed",
);
const benchmarkClearCachesBeforeRun = readBooleanEnv(
  "COPC_SMOOTHNESS_CLEAR_CACHES_BEFORE_RUN",
  false,
);
const benchmarkCacheResetMode = readCacheResetModeEnv(
  "COPC_SMOOTHNESS_CACHE_RESET_MODE",
  benchmarkClearCachesBeforeRun ? "app" : "none",
);
const benchmarkWaitForFinalDetail = readBooleanEnv(
  "COPC_SMOOTHNESS_WAIT_FOR_FINAL_DETAIL",
  true,
);
const benchmarkFinalDetailTimeoutMilliseconds = readPositiveIntegerEnv(
  "COPC_SMOOTHNESS_FINAL_DETAIL_TIMEOUT_MS",
  120_000,
);
const benchmarkInteractiveTimeoutMilliseconds = readPositiveIntegerEnv(
  "COPC_SMOOTHNESS_INTERACTIVE_TIMEOUT_MS",
  120_000,
);
const benchmarkPrefetchWaitTimeoutMilliseconds = readPositiveIntegerEnv(
  "COPC_SMOOTHNESS_PREFETCH_WAIT_TIMEOUT_MS",
  benchmarkWaitForFinalDetail ? 5_000 : 2_000,
);
const benchmarkMaxCoalescedPointDataRangeBytes = readPositiveIntegerEnv(
  "COPC_SMOOTHNESS_MAX_COALESCED_RANGE_BYTES",
  undefined,
);
const benchmarkMaxCoalescedPointDataRangeGapBytes = readNonNegativeIntegerEnv(
  "COPC_SMOOTHNESS_MAX_COALESCED_RANGE_GAP_BYTES",
  undefined,
);
const benchmarkPointGeometryWorkerConcurrency = readPositiveIntegerEnv(
  "COPC_SMOOTHNESS_POINT_GEOMETRY_WORKER_CONCURRENCY",
  undefined,
);
const benchmarkHierarchyPageLoadConcurrency = readPositiveIntegerEnv(
  "COPC_SMOOTHNESS_HIERARCHY_PAGE_LOAD_CONCURRENCY",
  undefined,
);

if (
  benchmarkPointGeometryWorkerConcurrency !== undefined &&
  benchmarkPointGeometryWorkerConcurrency > 8
) {
  throw new Error(
    "COPC_SMOOTHNESS_POINT_GEOMETRY_WORKER_CONCURRENCY must be at most 8.",
  );
}

if (
  benchmarkHierarchyPageLoadConcurrency !== undefined &&
  benchmarkHierarchyPageLoadConcurrency > 8
) {
  throw new Error(
    "COPC_SMOOTHNESS_HIERARCHY_PAGE_LOAD_CONCURRENCY must be at most 8.",
  );
}

if (benchmarkMaxPointCountPerNode < Math.max(...benchmarkStreamPointBudgets)) {
  throw new Error(
    "COPC_SMOOTHNESS_POINT_COUNT must be greater than or equal to every COPC_SMOOTHNESS_POINT_BUDGETS value.",
  );
}

function readPositiveIntegerEnv(name, fallback) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

function readPositiveIntegerListEnv(name, fallback) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const values = rawValue
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => value !== 0);

  if (
    values.length === 0 ||
    values.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new Error(
      `${name} must be a comma-separated list of positive integers.`,
    );
  }

  return [...new Set(values)];
}

function readOptionalHttpUrlEnv(name, fallback) {
  const rawValue = process.env[name];
  const candidate = rawValue?.trim() || fallback;

  let parsedUrl;
  try {
    parsedUrl = new URL(candidate);
  } catch {
    throw new Error(`${name} must be a valid http or https URL.`);
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`${name} must be a valid http or https URL.`);
  }

  return parsedUrl.toString();
}

function readNonNegativeIntegerEnv(name, fallback) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }

  return value;
}

function readPositiveNumberEnv(name, fallback) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return value;
}

function readPointRendererEnv(name, fallback) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  if (
    rawValue !== "typed" &&
    rawValue !== "primitive" &&
    rawValue !== "buffer"
  ) {
    throw new Error(`${name} must be one of: typed, primitive, buffer.`);
  }

  return rawValue;
}

function readBooleanEnv(name, fallback) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalizedValue)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalizedValue)) {
    return false;
  }

  throw new Error(`${name} must be a boolean value.`);
}

function readCacheResetModeEnv(name, fallback) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (
    normalizedValue !== "none" &&
    normalizedValue !== "app" &&
    normalizedValue !== "layer"
  ) {
    throw new Error(`${name} must be one of: none, app, layer.`);
  }

  return normalizedValue;
}

function readSampleCasesEnv(name, fallbackIds) {
  const rawValue = process.env[name];
  const ids = rawValue
    ? rawValue
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : fallbackIds;
  const uniqueIds = [...new Set(ids)];
  const unknownIds = uniqueIds.filter(
    (id) => !(id in smoothnessSampleCaseById),
  );

  if (unknownIds.length > 0) {
    throw new Error(
      `${name} contains unknown sample ids: ${unknownIds.join(", ")}`,
    );
  }

  return uniqueIds.map((id) => smoothnessSampleCaseById[id]);
}

function assertInside(parent, target) {
  const relative = path.relative(parent, target);

  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Refusing to operate outside ${parent}: ${target}`);
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: isWindows,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}`,
    );
  }
}

function runPlaywrightCli(args) {
  const result = spawnSync(process.execPath, [playwrightCliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `playwright-cli ${args.join(" ")} failed with exit code ${result.status}`,
    );
  }

  if (`${result.stdout}\n${result.stderr}`.includes("### Error")) {
    throw new Error(`playwright-cli ${args.join(" ")} reported an error`);
  }

  return `${result.stdout}\n${result.stderr}`;
}

function extractPlaywrightResult(output) {
  const marker = "### Result";
  const markerIndex = output.lastIndexOf(marker);

  if (markerIndex === -1) {
    throw new Error("Could not find Playwright result output.");
  }

  const outputAfterMarker = output.slice(markerIndex + marker.length);
  const jsonStart = outputAfterMarker.search(/[\[{]/);

  if (jsonStart === -1) {
    throw new Error("Could not find Playwright result JSON.");
  }

  const jsonText = outputAfterMarker.slice(jsonStart);
  let depth = 0;
  let isInsideString = false;
  let isEscaped = false;

  for (let index = 0; index < jsonText.length; index += 1) {
    const character = jsonText[index];

    if (isInsideString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (character === "\\") {
        isEscaped = true;
      } else if (character === '"') {
        isInsideString = false;
      }

      continue;
    }

    if (character === '"') {
      isInsideString = true;
      continue;
    }

    if (character === "{" || character === "[") {
      depth += 1;
      continue;
    }

    if (character === "}" || character === "]") {
      depth -= 1;

      if (depth === 0) {
        return JSON.parse(jsonText.slice(0, index + 1));
      }
    }
  }

  throw new Error("Could not parse complete Playwright result JSON.");
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No available preview port found from ${startPort}.`);
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "localhost");
  });
}

async function waitForServer(url, serverProcess, serverOutput) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(
        `Example preview server exited early with code ${serverProcess.exitCode}.\n${serverOutput.join("")}`,
      );
    }

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });

      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the Vite preview server starts listening.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for example preview server: ${url}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stopServer(serverProcess) {
  if (!serverProcess.pid || serverProcess.exitCode !== null) {
    return;
  }

  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(serverProcess.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }

  serverProcess.kill("SIGTERM");
}

function createExampleUrl(baseUrl) {
  const url = new URL(baseUrl);

  if (benchmarkMaxCoalescedPointDataRangeBytes !== undefined) {
    url.searchParams.set(
      "maxCoalescedPointDataRangeBytes",
      String(benchmarkMaxCoalescedPointDataRangeBytes),
    );
  }

  if (benchmarkMaxCoalescedPointDataRangeGapBytes !== undefined) {
    url.searchParams.set(
      "maxCoalescedPointDataRangeGapBytes",
      String(benchmarkMaxCoalescedPointDataRangeGapBytes),
    );
  }

  if (benchmarkPointGeometryWorkerConcurrency !== undefined) {
    url.searchParams.set(
      "pointGeometryWorkerConcurrency",
      String(benchmarkPointGeometryWorkerConcurrency),
    );
  }

  if (benchmarkHierarchyPageLoadConcurrency !== undefined) {
    url.searchParams.set(
      "hierarchyPageLoadConcurrency",
      String(benchmarkHierarchyPageLoadConcurrency),
    );
  }

  return url.toString();
}

function createSmoothnessFlow(
  baseUrl,
  maxPointCountPerNode,
  streamPointBudgets,
  pointRenderer,
  sampleCases,
  profile,
  repeatCount,
  warmupRunCount,
  warmupSettleTimeoutMilliseconds,
  durationMilliseconds,
  cameraSteps,
  moveMeters,
  cameraHeightAboveCloudMeters,
  minSelectedDepthOverride,
  cacheResetMode,
  waitForFinalDetail,
  finalDetailTimeoutMilliseconds,
  interactiveTimeoutMilliseconds,
  prefetchWaitTimeoutMilliseconds,
  maxCoalescedPointDataRangeBytes,
  maxCoalescedPointDataRangeGapBytes,
  pointGeometryWorkerConcurrency,
  hierarchyPageLoadConcurrency,
  browserGpuProfile = "high-performance",
  browserGpuConfigPath = "",
  browserGpuRendererPattern = null,
  browserGpuRendererAssertionSource =
    "function assertExpectedBrowserGpuRenderer() {}",
  browserIsHeaded = false,
) {
  return `async (page) => {
  const maxPointCountPerNode = ${JSON.stringify(maxPointCountPerNode)};
  const streamPointBudgets = ${JSON.stringify(streamPointBudgets)};
  const pointRenderer = ${JSON.stringify(pointRenderer)};
  const sampleCases = ${JSON.stringify(sampleCases)};
  const profile = ${JSON.stringify(profile)};
  const repeatCount = ${JSON.stringify(repeatCount)};
  const warmupRunCount = ${JSON.stringify(warmupRunCount)};
  const warmupSettleTimeoutMilliseconds = ${JSON.stringify(warmupSettleTimeoutMilliseconds)};
  const durationMilliseconds = ${JSON.stringify(durationMilliseconds)};
  const cameraSteps = ${JSON.stringify(cameraSteps)};
  const moveMeters = ${JSON.stringify(moveMeters)};
  const cameraHeightAboveCloudMeters = ${JSON.stringify(cameraHeightAboveCloudMeters)};
  const minSelectedDepthOverride = ${JSON.stringify(minSelectedDepthOverride)};
  const cacheResetMode = ${JSON.stringify(cacheResetMode)};
  const waitForFinalDetail = ${JSON.stringify(waitForFinalDetail)};
  const finalDetailTimeoutMilliseconds = ${JSON.stringify(finalDetailTimeoutMilliseconds)};
  const interactiveTimeoutMilliseconds = ${JSON.stringify(interactiveTimeoutMilliseconds)};
  const prefetchWaitTimeoutMilliseconds = ${JSON.stringify(prefetchWaitTimeoutMilliseconds)};
  const maxCoalescedPointDataRangeBytes = ${JSON.stringify(maxCoalescedPointDataRangeBytes)};
  const maxCoalescedPointDataRangeGapBytes = ${JSON.stringify(maxCoalescedPointDataRangeGapBytes)};
  const pointGeometryWorkerConcurrency = ${JSON.stringify(pointGeometryWorkerConcurrency)};
  const hierarchyPageLoadConcurrency = ${JSON.stringify(hierarchyPageLoadConcurrency)};
  const clearCachesBeforeRun = cacheResetMode !== "none";
  const httpRangePhases = [
    "camera-movement",
    "terminal-refinement",
    "post-terminal-prefetch",
  ];
  const failures = [];
  const consoleProblems = [];
  const ignoredConsoleWarnings = [];
  const pageErrors = [];
  const results = [];
  const warmups = [];
  const hierarchyHolds = [];
  const httpRangeRequests = [];
  const activeHttpRangeRequests = new Map();
  const pendingHttpRangeFinalizers = new Set();
  let activeHttpRangeScope;
  const isExpectedNonFatalWebGlDriverWarning = ${isExpectedNonFatalWebGlDriverWarning.toString()};
${browserGpuRendererAssertionSource}

  async function readBrowserGraphics() {
    return page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");

      if (!context) {
        throw new Error("WebGL is unavailable in the smoothness benchmark.");
      }

      const debugInfo = context.getExtension("WEBGL_debug_renderer_info");

      return {
        vendor: debugInfo
          ? context.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
          : context.getParameter(context.VENDOR),
        renderer: debugInfo
          ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
          : context.getParameter(context.RENDERER),
        version: context.getParameter(context.VERSION),
      };
    });
  }

  async function readBrowserEnvironment() {
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const version = page.context().browser()?.version() ?? "";

    if (!userAgent || !version) {
      throw new Error("Browser user agent and version metadata are required.");
    }

    return { userAgent, version };
  }

  page.on("console", (message) => {
    const type = message.type();
    const text = message.text();

    if (isExpectedNonFatalWebGlDriverWarning(type, text)) {
      ignoredConsoleWarnings.push(\`\${type}: \${text}\`);
      return;
    }

    if (type === "error" || type === "warning") {
      consoleProblems.push(\`\${type}: \${text}\`);
    }
  });

  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  function timestampMilliseconds() {
    return Date.now();
  }

  function cloneScope(scope) {
    return scope === undefined
      ? undefined
      : {
          id: scope.id,
          sampleId: scope.sampleId,
          sampleLabel: scope.sampleLabel,
          measurementType: scope.measurementType,
          runIndex: scope.runIndex,
          streamPointBudget: scope.streamPointBudget,
          phase: scope.phase,
          startedAtMilliseconds: scope.startedAtMilliseconds,
        };
  }

  function readHeader(headers, name) {
    const lowerName = name.toLowerCase();
    return Object.entries(headers ?? {}).find(
      ([key]) => key.toLowerCase() === lowerName,
    )?.[1];
  }

  function readRequestTiming(request) {
    try {
      return typeof request.timing === "function" ? request.timing() : undefined;
    } catch {
      return undefined;
    }
  }

  async function readRequestSizes(request) {
    try {
      return typeof request.sizes === "function"
        ? await request.sizes()
        : undefined;
    } catch {
      return undefined;
    }
  }

  function parseRangeHeader(rangeHeader) {
    const match = rangeHeader?.match(/^bytes=(\\d+)-(\\d+)$/i);

    if (!match) {
      return undefined;
    }

    const start = Number(match[1]);
    const end = Number(match[2]);

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      end < start
    ) {
      return undefined;
    }

    return {
      start,
      end,
      byteLength: end - start + 1,
    };
  }

  function parseContentRangeHeader(contentRangeHeader) {
    const match = contentRangeHeader?.match(/^bytes\\s+(\\d+)-(\\d+)\\/(\\d+|[*])$/i);

    if (!match) {
      return undefined;
    }

    const start = Number(match[1]);
    const end = Number(match[2]);
    const completeLength =
      match[3] === "*" ? undefined : Number(match[3]);

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      end < start ||
      (completeLength !== undefined && !Number.isSafeInteger(completeLength))
    ) {
      return undefined;
    }

    return {
      start,
      end,
      byteLength: end - start + 1,
      completeLength,
    };
  }

  function percentileRank(values, percentileRankValue) {
    const finiteValues = values
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right);

    if (finiteValues.length === 0) {
      return undefined;
    }

    const index = Math.ceil((percentileRankValue / 100) * finiteValues.length) - 1;
    return finiteValues[Math.max(0, Math.min(finiteValues.length - 1, index))];
  }

  function summarizeRanges(ranges) {
    const normalizedRanges = ranges
      .filter(Boolean)
      .sort((left, right) => left.start - right.start || left.end - right.end);
    let unionBytes = 0;
    let requestedBytes = 0;
    let duplicateBytes = 0;
    let duplicateRangeCount = 0;
    let currentStart;
    let currentEnd;
    const seenRanges = new Map();

    for (const range of normalizedRanges) {
      requestedBytes += range.byteLength;
      const key = \`\${range.start}-\${range.end}\`;
      const previousCount = seenRanges.get(key) ?? 0;
      seenRanges.set(key, previousCount + 1);

      if (previousCount > 0) {
        duplicateRangeCount += 1;
        duplicateBytes += range.byteLength;
      }

      if (currentStart === undefined) {
        currentStart = range.start;
        currentEnd = range.end;
        continue;
      }

      if (range.start <= currentEnd + 1) {
        currentEnd = Math.max(currentEnd, range.end);
        continue;
      }

      unionBytes += currentEnd - currentStart + 1;
      currentStart = range.start;
      currentEnd = range.end;
    }

    if (currentStart !== undefined) {
      unionBytes += currentEnd - currentStart + 1;
    }

    return {
      unionBytes,
      overlapBytes: Math.max(0, requestedBytes - unionBytes),
      duplicateBytes,
      duplicateRangeCount,
    };
  }

  function summarizeHttpRangeRequests(records) {
    const statusCounts = {};
    let requestedRangeBytes = 0;
    let finishedRangeBytes = 0;
    let contentLengthBytes = 0;
    let transferSizeBytes = 0;
    let requestHeadersSizeBytes = 0;
    let responseHeadersSizeBytes = 0;
    let responseBodySizeBytes = 0;
    let requestBodySizeBytes = 0;
    let sizeRecordCount = 0;

    for (const record of records) {
      if (Number.isFinite(record.status)) {
        statusCounts[record.status] = (statusCounts[record.status] ?? 0) + 1;
      }

      requestedRangeBytes += record.parsedRange?.byteLength ?? 0;

      if (record.outcome === "finished") {
        finishedRangeBytes +=
          record.parsedContentRange?.byteLength ??
          record.contentLengthBytes ??
          record.parsedRange?.byteLength ??
          0;
      }

      contentLengthBytes += record.contentLengthBytes ?? 0;

      if (record.sizes) {
        sizeRecordCount += 1;
        requestBodySizeBytes += record.sizes.requestBodySize ?? 0;
        requestHeadersSizeBytes += record.sizes.requestHeadersSize ?? 0;
        responseBodySizeBytes += record.sizes.responseBodySize ?? 0;
        responseHeadersSizeBytes += record.sizes.responseHeadersSize ?? 0;
        transferSizeBytes +=
          (record.sizes.responseHeadersSize ?? 0) +
          (record.sizes.responseBodySize ?? 0);
      }
    }

    const durations = records.map((record) => record.durationMilliseconds);
    const rangeSummary = summarizeRanges(
      records.map((record) => record.parsedRange),
    );

    return {
      requestCount: records.length,
      finishedCount: records.filter((record) => record.outcome === "finished").length,
      failedCount: records.filter((record) => record.outcome === "failed").length,
      abandonedCount: records.filter((record) => record.outcome === "abandoned").length,
      statusCounts,
      requestedRangeBytes,
      finishedRangeBytes,
      contentLengthBytes,
      sizeRecordCount,
      requestBodySizeBytes,
      requestHeadersSizeBytes,
      responseBodySizeBytes,
      responseHeadersSizeBytes,
      transferSizeBytes,
      maxDurationMilliseconds: percentileRank(durations, 100),
      p95DurationMilliseconds: percentileRank(durations, 95),
      duplicateRangeCount: rangeSummary.duplicateRangeCount,
      duplicateRangeBytes: rangeSummary.duplicateBytes,
      overlapRangeBytes: rangeSummary.overlapBytes,
      unionRangeBytes: rangeSummary.unionBytes,
      evidenceScope: "browser-http-range-headers",
      bytesCaveat:
        "HTTP byte counts are browser-observed request/response metadata and do not include inner worker payload inference.",
      phaseCaveat:
        "HTTP range phases are classified by request start against benchmark controller boundaries; requests that race a boundary can be attributed to the previous or next phase.",
    };
  }

  function summarizeHttpRangeRequestsByPhase(records) {
    return Object.fromEntries(
      httpRangePhases.map((phase) => [
        phase,
        summarizeHttpRangeRequests(
          records.filter((record) => record.phase === phase),
        ),
      ]),
    );
  }

  function beginHttpRangeScope(scope) {
    activeHttpRangeScope = {
      ...scope,
      id: \`\${scope.sampleId}:\${scope.streamPointBudget}:\${scope.measurementType}:\${scope.runIndex}\`,
      phase: "camera-movement",
      startedAtMilliseconds: timestampMilliseconds(),
    };
    return activeHttpRangeScope;
  }

  function setHttpRangeScopePhase(scope, phase) {
    if (!httpRangePhases.includes(phase)) {
      throw new Error(\`Unknown HTTP range phase: \${phase}\`);
    }

    if (activeHttpRangeScope?.id === scope.id) {
      activeHttpRangeScope.phase = phase;
    }

    scope.phase = phase;
    scope.phaseUpdatedAtMilliseconds = timestampMilliseconds();
  }

  async function endHttpRangeScope(scope) {
    await page.waitForTimeout(0);
    while (pendingHttpRangeFinalizers.size > 0) {
      await Promise.all([...pendingHttpRangeFinalizers]);
    }
    const endedAtMilliseconds = timestampMilliseconds();

    for (const [request, record] of activeHttpRangeRequests) {
      if (
        record.scope?.id === scope.id &&
        !record.finishedAtMilliseconds &&
        !record.failedAtMilliseconds
      ) {
        record.outcome = "abandoned";
        record.abandonedAtMilliseconds = endedAtMilliseconds;
        record.durationMilliseconds =
          endedAtMilliseconds - record.startedAtMilliseconds;
        activeHttpRangeRequests.delete(request);
      }
    }

    if (activeHttpRangeScope?.id === scope.id) {
      activeHttpRangeScope = undefined;
    }

    const records = httpRangeRequests.filter(
      (record) => record.scope?.id === scope.id,
    );

    return {
      records,
      summary: summarizeHttpRangeRequests(records),
      phaseSummaries: summarizeHttpRangeRequestsByPhase(records),
    };
  }

  page.on("request", (request) => {
    const headers = request.headers();
    const range = readHeader(headers, "range");

    if (!range) {
      return;
    }

    const record = {
      id: \`\${httpRangeRequests.length + 1}\`,
      url: request.url(),
      range,
      parsedRange: parseRangeHeader(range),
      method: request.method(),
      resourceType: request.resourceType(),
      scope: cloneScope(activeHttpRangeScope),
      phase: activeHttpRangeScope?.phase,
      startedAtMilliseconds: timestampMilliseconds(),
      timing: readRequestTiming(request),
      outcome: "requested",
    };

    httpRangeRequests.push(record);
    activeHttpRangeRequests.set(request, record);
  });

  page.on("response", (response) => {
    const request = response.request();
    const record = activeHttpRangeRequests.get(request);

    if (!record) {
      return;
    }

    const headers = response.headers();
    const contentLength = Number(readHeader(headers, "content-length"));

    record.respondedAtMilliseconds = timestampMilliseconds();
    record.status = response.status();
    record.statusText = response.statusText();
    record.contentRange = readHeader(headers, "content-range");
    record.parsedContentRange = parseContentRangeHeader(record.contentRange);
    record.contentLength = readHeader(headers, "content-length");
    record.contentLengthBytes = Number.isFinite(contentLength)
      ? contentLength
      : undefined;
    record.etag = readHeader(headers, "etag");
  });

  page.on("requestfinished", (request) => {
    const record = activeHttpRangeRequests.get(request);

    if (!record) {
      return;
    }

    const finalizer = (async () => {
      record.finishedAtMilliseconds = timestampMilliseconds();
      record.durationMilliseconds =
        record.finishedAtMilliseconds - record.startedAtMilliseconds;
      record.outcome =
        record.outcome === "abandoned" ? "abandoned" : "finished";
      record.timing ??= readRequestTiming(request);
      record.sizes = await readRequestSizes(request);
      activeHttpRangeRequests.delete(request);
    })();
    pendingHttpRangeFinalizers.add(finalizer);
    void finalizer.finally(() => pendingHttpRangeFinalizers.delete(finalizer));
  });

  page.on("requestfailed", (request) => {
    const record = activeHttpRangeRequests.get(request);

    if (!record) {
      return;
    }

    record.failedAtMilliseconds = timestampMilliseconds();
    record.durationMilliseconds =
      record.failedAtMilliseconds - record.startedAtMilliseconds;
    record.outcome = record.outcome === "abandoned" ? "abandoned" : "failed";
    record.failure = request.failure()?.errorText;
    record.timing ??= readRequestTiming(request);
    activeHttpRangeRequests.delete(request);
  });

  async function metadataValue(label) {
    return page.evaluate((targetLabel) => {
      const rows = [...document.querySelectorAll("#copc-metadata dt")];
      return rows.find((row) => row.textContent === targetLabel)
        ?.nextElementSibling?.textContent;
    }, label);
  }

  async function waitForRenderedStatus() {
    const renderedStatusTexts = [
      "Rendered ",
      "Auto LOD rendered",
      "Camera stream terminal rendered",
      "Camera stream hierarchy-refining",
      "Camera stream interactive-ready",
      "Camera stream previewed",
      "Camera stream partial render",
      "Camera stream retained",
    ];

    try {
      await page.waitForFunction(
        (statusTexts) => {
          const currentStatus =
            document.querySelector("#copc-status")?.textContent ?? "";
          return statusTexts.some((statusText) =>
            currentStatus.includes(statusText),
          );
        },
        renderedStatusTexts,
        { timeout: 120_000 },
      );
    } catch (error) {
      const currentStatus = await page.locator("#copc-status").textContent();
      throw new Error(
        \`Timed out waiting for a rendered status. Current status: "\${currentStatus}". \${error.message}\`,
      );
    }
  }

  function isExpectedCameraStreamRequest(status, expectedRequestId) {
    return status?.cameraStreamRequestId === expectedRequestId;
  }

  function isSameCameraStreamRequestLineage(
    status,
    expectedRequestId,
    expectedCameraEpoch,
    expectedCameraPoseFingerprint,
  ) {
    return (
      Number.isSafeInteger(status?.cameraStreamRequestId) &&
      status.cameraStreamRequestId >= expectedRequestId &&
      status.cameraStreamCameraEpoch === expectedCameraEpoch &&
      typeof expectedCameraPoseFingerprint === "string" &&
      expectedCameraPoseFingerprint.length > 0 &&
      status.cameraStreamCameraPoseFingerprint ===
        expectedCameraPoseFingerprint
    );
  }

  function hasFinalCameraStreamResult(
    status,
    expectedRequestId,
    expectedCameraEpoch,
    expectedCameraPoseFingerprint,
  ) {
    if (
      !isSameCameraStreamRequestLineage(
        status,
        expectedRequestId,
        expectedCameraEpoch,
        expectedCameraPoseFingerprint,
      )
    ) {
      return false;
    }

    return (
      status.cameraStreamVisualQuality?.isTerminalReady === true &&
      status.cameraStreamDetailProgress?.isComplete === true
    );
  }

  function hasInteractiveCameraStreamResult(
    status,
    expectedRequestId,
    expectedCameraEpoch,
    expectedCameraPoseFingerprint,
  ) {
    return (
      isSameCameraStreamRequestLineage(
        status,
        expectedRequestId,
        expectedCameraEpoch,
        expectedCameraPoseFingerprint,
      ) &&
      isCameraStreamInteractiveStatus(status.status)
    );
  }

  function createCameraStreamCompletion(
    status,
    expectedRequestId,
    expectedCameraEpoch,
    expectedCameraPoseFingerprint,
    waited,
  ) {
    const mode = waitForFinalDetail ? "final-detail" : "interactive";
    const requestMatched = isExpectedCameraStreamRequest(
      status,
      expectedRequestId,
    );
    const sameCameraRequestLineage = isSameCameraStreamRequestLineage(
      status,
      expectedRequestId,
      expectedCameraEpoch,
      expectedCameraPoseFingerprint,
    );
    const structuredCompletion =
      status.cameraStreamVisualQuality?.isTerminalReady === true &&
      status.cameraStreamDetailProgress?.isComplete === true;
    const evidenceSource =
      waitForFinalDetail && typeof structuredCompletion === "boolean"
        ? "visual-quality"
        : "status-text";
    const isComplete = waitForFinalDetail
      ? hasFinalCameraStreamResult(
          status,
          expectedRequestId,
          expectedCameraEpoch,
          expectedCameraPoseFingerprint,
        )
      : hasInteractiveCameraStreamResult(
          status,
          expectedRequestId,
          expectedCameraEpoch,
          expectedCameraPoseFingerprint,
        );

    return {
      mode,
      isComplete,
      requestMatched,
      sameCameraRequestLineage,
      expectedRequestId,
      expectedCameraEpoch,
      expectedCameraPoseFingerprint,
      observedRequestId: status?.cameraStreamRequestId,
      observedCameraEpoch: status?.cameraStreamCameraEpoch,
      observedCameraPoseFingerprint:
        status?.cameraStreamCameraPoseFingerprint,
      waited,
      timedOut: false,
      timeoutMilliseconds: waitForFinalDetail
        ? finalDetailTimeoutMilliseconds
        : interactiveTimeoutMilliseconds,
      statusText: status?.status,
      evidenceSource,
    };
  }

  async function waitForCameraStreamStatus(
    expectedRequestId,
    expectedCameraEpoch,
    expectedCameraPoseFingerprint,
  ) {
    try {
      const statusHandle = await page.waitForFunction(
        ({
          targetRequestId,
          targetCameraEpoch,
          targetCameraPoseFingerprint,
        }) => {
          const benchmark = window.__copcBasicViewerBenchmark;
          const status = benchmark?.getStatus();

          if (
            !Number.isSafeInteger(status?.cameraStreamRequestId) ||
            status.cameraStreamRequestId < targetRequestId ||
            status.cameraStreamCameraEpoch !== targetCameraEpoch ||
            status.cameraStreamCameraPoseFingerprint !==
              targetCameraPoseFingerprint
          ) {
            return undefined;
          }

          const isComplete =
            status.cameraStreamVisualQuality?.isTerminalReady === true &&
            status.cameraStreamDetailProgress?.isComplete === true;
          const hasFailed = status.status?.startsWith(
            "COPC inspection failed:",
          );

          return isComplete || hasFailed ? status : undefined;
        },
        {
          targetRequestId: expectedRequestId,
          targetCameraEpoch: expectedCameraEpoch,
          targetCameraPoseFingerprint: expectedCameraPoseFingerprint,
        },
        { timeout: finalDetailTimeoutMilliseconds },
      );
      const status = await statusHandle.jsonValue();
      await statusHandle.dispose();
      if (status?.status?.startsWith("COPC inspection failed:")) {
        throw new Error(
          \`Camera stream request \${expectedRequestId} failed before terminal completion: \${status.status}\`,
        );
      }
      return status;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Camera stream request ")
      ) {
        throw error;
      }
      const currentStatus = await benchmarkStatus();
      const timeoutEvidence = {
        expectedRequestId,
        expectedCameraEpoch,
        expectedCameraPoseFingerprint,
        observedRequestId: currentStatus.cameraStreamRequestId,
        observedCameraEpoch: currentStatus.cameraStreamCameraEpoch,
        observedCameraPoseFingerprint:
          currentStatus.cameraStreamCameraPoseFingerprint,
        sameCameraLineage: isSameCameraStreamRequestLineage(
          currentStatus,
          expectedRequestId,
          expectedCameraEpoch,
          expectedCameraPoseFingerprint,
        ),
        visualQuality: currentStatus.cameraStreamVisualQuality,
        detailProgress: currentStatus.cameraStreamDetailProgress,
        diagnostics: currentStatus.cameraStreamDiagnosticsData,
        lod: currentStatus.cameraStreamLodData,
        prefetch: currentStatus.cameraStreamPrefetchData,
        hierarchyCache: currentStatus.hierarchyCacheStats,
        hierarchyRefinement: currentStatus.cameraHierarchyRefinement,
        hierarchyExpansion: currentStatus.cameraHierarchyExpansion,
        statusText: currentStatus.status,
      };
      throw new Error(
        \`Timed out after \${finalDetailTimeoutMilliseconds} ms waiting for final camera stream lineage from request \${expectedRequestId}. Evidence: \${JSON.stringify(timeoutEvidence)}. \${error.message}\`,
      );
    }
  }

  async function waitForCameraStreamInteractiveStatus(
    expectedRequestId,
    expectedCameraEpoch,
    expectedCameraPoseFingerprint,
  ) {
    try {
      const statusHandle = await page.waitForFunction(
        ({
          targetRequestId,
          targetCameraEpoch,
          targetCameraPoseFingerprint,
        }) => {
          const benchmark = window.__copcBasicViewerBenchmark;
          const status = benchmark?.getStatus();

          if (
            !Number.isSafeInteger(status?.cameraStreamRequestId) ||
            status.cameraStreamRequestId < targetRequestId ||
            status.cameraStreamCameraEpoch !== targetCameraEpoch ||
            status.cameraStreamCameraPoseFingerprint !==
              targetCameraPoseFingerprint
          ) {
            return undefined;
          }

          const statusText = status.status ?? "";
          const isInteractive =
            statusText.includes("Camera stream terminal rendered") ||
            statusText.includes("Camera stream hierarchy-refining") ||
            statusText.includes("Camera stream interactive-ready") ||
            statusText.includes("Camera stream previewed") ||
            statusText.includes("Camera stream partial render") ||
            statusText.includes("Camera stream retained");

          return isInteractive ? status : undefined;
        },
        {
          targetRequestId: expectedRequestId,
          targetCameraEpoch: expectedCameraEpoch,
          targetCameraPoseFingerprint: expectedCameraPoseFingerprint,
        },
        { timeout: interactiveTimeoutMilliseconds },
      );
      const status = await statusHandle.jsonValue();
      await statusHandle.dispose();
      return status;
    } catch (error) {
      const currentStatus = await benchmarkStatus();
      throw new Error(
        \`Timed out after \${interactiveTimeoutMilliseconds} ms waiting for interactive camera stream lineage from request \${expectedRequestId}. Current request: \${currentStatus.cameraStreamRequestId}; epoch: \${currentStatus.cameraStreamCameraEpoch}; pose match: \${currentStatus.cameraStreamCameraPoseFingerprint === expectedCameraPoseFingerprint}; status: "\${currentStatus.status}". \${error.message}\`,
      );
    }
  }

  async function waitForAnyCameraStreamInteractiveStatus() {
    try {
      await page.waitForFunction(
        () => {
          const status = document.querySelector("#copc-status")?.textContent ?? "";
          return (
            status.includes("Camera stream terminal rendered") ||
            status.includes("Camera stream hierarchy-refining") ||
            status.includes("Camera stream interactive-ready") ||
            status.includes("Camera stream previewed") ||
            status.includes("Camera stream partial render") ||
            status.includes("Camera stream retained")
          );
        },
        undefined,
        { timeout: interactiveTimeoutMilliseconds },
      );
    } catch (error) {
      const currentStatus = await page.locator("#copc-status").textContent();
      throw new Error(
        \`Timed out after \${interactiveTimeoutMilliseconds} ms waiting for any interactive camera stream render. Current status: "\${currentStatus}". \${error.message}\`,
      );
    }
  }

  async function waitForBenchmarkApi() {
    try {
      await page.waitForFunction(
        () => Boolean(window.__copcBasicViewerBenchmark),
        undefined,
        { timeout: 60_000 },
      );
    } catch (error) {
      const currentStatus = await page.locator("#copc-status").textContent();
      throw new Error(
        \`Timed out waiting for the basic viewer benchmark API. Current status: "\${currentStatus}". \${error.message}\`,
      );
    }
  }

  async function benchmarkStatus() {
    return page.evaluate(() => {
      const benchmark = window.__copcBasicViewerBenchmark;

      if (!benchmark) {
        throw new Error("Basic viewer benchmark API was not installed.");
      }

      return benchmark.getStatus();
    });
  }

  async function waitForCameraStreamPrefetch(timeoutMilliseconds) {
    return page.evaluate((timeoutMilliseconds) => {
      const benchmark = window.__copcBasicViewerBenchmark;

      if (!benchmark) {
        throw new Error("Basic viewer benchmark API was not installed.");
      }

      if (typeof benchmark.waitForCameraStreamPrefetch !== "function") {
        return benchmark.getStatus();
      }

      return benchmark.waitForCameraStreamPrefetch(timeoutMilliseconds);
    }, timeoutMilliseconds);
  }

  function createPostPrefetchRefinementEvidence(
    status,
    initialStatus,
    initialRequestId,
  ) {
    const observedRequestId = status?.cameraStreamRequestId;
    const initialCameraEpoch = initialStatus?.cameraStreamCameraEpoch;
    const observedCameraEpoch = status?.cameraStreamCameraEpoch;
    const initialCameraPoseFingerprint =
      initialStatus?.cameraStreamCameraPoseFingerprint;
    const observedCameraPoseFingerprint =
      status?.cameraStreamCameraPoseFingerprint;
    const diagnostics =
      status?.cameraStreamDiagnosticsData ??
      parseCameraStreamDiagnostics(status?.cameraStreamDiagnostics);
    const visualQuality = status?.cameraStreamVisualQuality;
    const prefetch = status?.cameraStreamPrefetchData;
    const requestAdvanced =
      Number.isSafeInteger(initialRequestId) &&
      Number.isSafeInteger(observedRequestId) &&
      observedRequestId > initialRequestId;
    const sameCameraFollowup =
      requestAdvanced &&
      Number.isSafeInteger(initialCameraEpoch) &&
      observedCameraEpoch === initialCameraEpoch &&
      typeof initialCameraPoseFingerprint === "string" &&
      initialCameraPoseFingerprint.length > 0 &&
      observedCameraPoseFingerprint === initialCameraPoseFingerprint;

    return {
      timeoutMilliseconds: prefetchWaitTimeoutMilliseconds,
      initialRequestId,
      observedRequestId,
      requestAdvanced,
      initialCameraEpoch,
      observedCameraEpoch,
      initialCameraPoseFingerprint,
      observedCameraPoseFingerprint,
      sameCameraFollowup,
      prefetchCompleted:
        prefetch?.state === "completed" && prefetch.completed === true,
      prefetchState: prefetch?.state ?? "not-reported",
      renderedPointCount: parseCameraStreamPointCount(status?.status),
      selectedDepth: diagnostics?.selectedDepth,
      isTerminalReady: visualQuality?.isTerminalReady === true,
      visualQuality,
      statusText: status?.status,
    };
  }

  async function settleWarmupPrefetch() {
    const startedAt = Date.now();
    const status = await waitForCameraStreamPrefetch(
      warmupSettleTimeoutMilliseconds,
    );
    const prefetch = status.cameraStreamPrefetchData;
    const isComplete =
      prefetch?.state === "completed" && prefetch.completed === true;

    return {
      timeoutMilliseconds: warmupSettleTimeoutMilliseconds,
      durationMilliseconds: Date.now() - startedAt,
      isComplete,
      timedOut: prefetch?.state === "pending",
      state: prefetch?.state ?? "not-reported",
      statusText: status.cameraStreamPrefetch,
      prefetch,
    };
  }

  async function holdWarmCameraHierarchy() {
    return page.evaluate(async () => {
      const benchmark = window.__copcBasicViewerBenchmark;

      if (!benchmark) {
        throw new Error("Basic viewer benchmark API was not installed.");
      }

      if (typeof benchmark.holdCameraHierarchyForSmoothness !== "function") {
        throw new Error("Warm hierarchy hold API was not installed.");
      }

      return benchmark.holdCameraHierarchyForSmoothness();
    });
  }

  async function releaseWarmCameraHierarchy() {
    await page.evaluate(() => {
      const benchmark = window.__copcBasicViewerBenchmark;

      if (!benchmark) {
        throw new Error("Basic viewer benchmark API was not installed.");
      }

      benchmark.releaseCameraHierarchyForSmoothness?.();
    });
  }

  async function prepareViewer(sampleCase, initialStreamPointBudget) {
    await page.evaluate(({ maxPointCountPerNode, pointRenderer, sampleCase, initialStreamPointBudget }) => {
      const sampleSelect = document.querySelector("#copc-sample-select");
      const rendererSelect = document.querySelector("#copc-renderer-select");
      const maxPointCountInput = document.querySelector("#copc-max-point-count");
      const streamPointBudgetInput = document.querySelector(
        "#copc-camera-stream-point-budget",
      );
      const urlInput = document.querySelector("#copc-url");
      const sourceCrsInput = document.querySelector("#copc-source-crs");
      const sourceDefinitionInput = document.querySelector("#copc-source-definition");
      const checkbox = document.querySelector("#copc-auto-stream");
      const form = document.querySelector("#copc-form");
      const status = document.querySelector("#copc-status");

      if (!(sampleSelect instanceof HTMLSelectElement)) {
        throw new Error("Sample select was not found.");
      }

      if (!(rendererSelect instanceof HTMLSelectElement)) {
        throw new Error("Renderer select was not found.");
      }

      if (!(maxPointCountInput instanceof HTMLInputElement)) {
        throw new Error("Max point count input was not found.");
      }

      if (!(streamPointBudgetInput instanceof HTMLInputElement)) {
        throw new Error("Camera stream point budget input was not found.");
      }

      if (!(urlInput instanceof HTMLInputElement)) {
        throw new Error("COPC URL input was not found.");
      }

      if (!(sourceCrsInput instanceof HTMLInputElement)) {
        throw new Error("Source CRS input was not found.");
      }

      if (!(sourceDefinitionInput instanceof HTMLTextAreaElement)) {
        throw new Error("Source definition input was not found.");
      }

      if (!(checkbox instanceof HTMLInputElement)) {
        throw new Error("Stream on camera move checkbox was not found.");
      }

      if (!(form instanceof HTMLFormElement)) {
        throw new Error("COPC form was not found.");
      }

      if (checkbox.checked) {
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      }

      if (![...rendererSelect.options].some((option) => option.value === pointRenderer)) {
        throw new Error(\`Point renderer was not found: \${pointRenderer}\`);
      }

      rendererSelect.value = pointRenderer;
      maxPointCountInput.value = String(maxPointCountPerNode);
      streamPointBudgetInput.value = String(initialStreamPointBudget);

      if (status) {
        status.textContent = "Smoothness benchmark render pending...";
      }

      if (sampleCase.kind === "preset") {
        sampleSelect.value = sampleCase.sampleId;
        sampleSelect.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }

      sampleSelect.value = "custom";
      sampleSelect.dispatchEvent(new Event("change", { bubbles: true }));
      urlInput.value = sampleCase.url;
      sourceCrsInput.value = sampleCase.sourceCrs ?? "";
      sourceDefinitionInput.value = sampleCase.sourceDefinition ?? "";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }, { maxPointCountPerNode, pointRenderer, sampleCase, initialStreamPointBudget });
    await waitForRenderedStatus();

    const loadedSourcePreset = await metadataValue("Source preset");
    const loadedCoordinateTransform = await metadataValue("Coordinate transform");

    if (loadedSourcePreset !== sampleCase.expectedSourcePreset) {
      failures.push(
        \`\${sampleCase.id} loaded unexpected source preset: \${loadedSourcePreset}\`,
      );
    }

    if (!loadedCoordinateTransform?.includes(sampleCase.expectedCoordinateTransformText)) {
      failures.push(
        \`\${sampleCase.id} loaded unexpected coordinate transform: \${loadedCoordinateTransform}\`,
      );
    }

    await page.evaluate(() => {
      const checkbox = document.querySelector("#copc-auto-stream");
      const status = document.querySelector("#copc-status");

      if (!(checkbox instanceof HTMLInputElement)) {
        throw new Error("Stream on camera move checkbox was not found.");
      }

      if (checkbox.disabled) {
        throw new Error("Stream on camera move is disabled.");
      }

      if (status) {
        status.textContent = "Smoothness benchmark camera stream pending...";
      }

      if (!checkbox.checked) {
        checkbox.checked = true;
      }

      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitForAnyCameraStreamInteractiveStatus();

    return {
      sampleId: sampleCase.id,
      label: sampleCase.label,
      sourcePreset: loadedSourcePreset,
      coordinateTransform: loadedCoordinateTransform,
      pointRenderer: await metadataValue("Point renderer"),
      expectedMinSelectedDepth: sampleCase.expectedMinSelectedDepth,
    };
  }

  async function setStreamPointBudget(streamPointBudget) {
    await page.evaluate((streamPointBudget) => {
      const input = document.querySelector("#copc-camera-stream-point-budget");
      const status = document.querySelector("#copc-status");

      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Camera stream point budget input was not found.");
      }

      input.value = String(streamPointBudget);

      if (status) {
        status.textContent = "Smoothness benchmark stream budget pending...";
      }

      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, streamPointBudget);
    await waitForAnyCameraStreamInteractiveStatus();
  }

  function average(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function percentile(values, ratio) {
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
    return sorted[index] ?? 0;
  }

  function summarizeFrames(frameDeltas) {
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

    return {
      frameCount: frameDeltas.length,
      averageFrameMilliseconds: average(frameDeltas),
      medianFrameMilliseconds: percentile(frameDeltas, 0.5),
      p95FrameMilliseconds: percentile(frameDeltas, 0.95),
      maxFrameMilliseconds: Math.max(...frameDeltas),
      estimatedAverageFps: 1000 / average(frameDeltas),
      frameDeltasOver50Milliseconds: frameDeltas.filter((delta) => delta > 50).length,
      frameDeltasOver100Milliseconds: frameDeltas.filter((delta) => delta > 100).length,
    };
  }

  function parseCameraStreamPointCount(statusText) {
    const match =
      statusText.match(
        /Camera stream (?:terminal rendered|hierarchy-refining with|interactive-ready with|previewed|partial render) ([\\d,]+) points/,
      ) ??
      statusText.match(
        /Camera stream retained [^.]*? with ([\\d,]+) points/,
      );

    if (!match) {
      return undefined;
    }

    return Number(match[1].replaceAll(",", ""));
  }

  function isCameraStreamInteractiveStatus(statusText) {
    return (
      statusText.includes("Camera stream terminal rendered") ||
      statusText.includes("Camera stream hierarchy-refining") ||
      statusText.includes("Camera stream interactive-ready") ||
      statusText.includes("Camera stream previewed") ||
      statusText.includes("Camera stream partial render") ||
      statusText.includes("Camera stream retained")
    );
  }

  function parseCameraStreamDetailProgress(statusText) {
    const terminalMatch = statusText.match(
      /Camera stream terminal rendered [\\d,]+ points from the complete [\\d,]+-node additive set [(]([\\d,]+) frontier nodes/,
    );

    if (terminalMatch) {
      const finalNodeCount = Number(terminalMatch[1].replaceAll(",", ""));

      return {
        finalNodeCount,
        renderedFinalNodeCount: finalNodeCount,
        renderedFinalNodeCoverageRatio: finalNodeCount > 0 ? 1 : 0,
        reachedRenderBudget: statusText.includes("render budget filled"),
        isComplete: true,
      };
    }

    const renderedMatch = statusText.match(
      /Camera stream rendered [\\d,]+ points from ([\\d,]+) COPC nodes/,
    );
    const finalMatch = statusText.match(
      /([\\d,]+) selected detail nodes for the current view/,
    );

    if (!renderedMatch || !finalMatch) {
      return undefined;
    }

    const finalNodeCount = Number(finalMatch[1].replaceAll(",", ""));
    const renderedFinalNodeCount = Math.min(
      finalNodeCount,
      Number(renderedMatch[1].replaceAll(",", "")),
    );

    return {
      finalNodeCount,
      renderedFinalNodeCount,
      renderedFinalNodeCoverageRatio:
        finalNodeCount > 0 ? renderedFinalNodeCount / finalNodeCount : 0,
      reachedRenderBudget: statusText.includes("render budget filled"),
      isComplete: true,
    };
  }

  function parseCameraStreamDiagnostics(diagnosticsText) {
    const match = diagnosticsText?.match(
      /expand ([\\d,.]+) ms, apply ([\\d,.]+) ms, select ([\\d,.]+) ms, render ([\\d,.]+) ms, total ([\\d,.]+) ms, ([\\d,]+) pages, ([\\d,]+) nodes, depth ([\\d,]+)/,
    );

    if (!match) {
      return undefined;
    }

    return {
      expandHierarchyMilliseconds: Number(match[1].replaceAll(",", "")),
      applyHierarchyMilliseconds: Number(match[2].replaceAll(",", "")),
      selectNodesMilliseconds: Number(match[3].replaceAll(",", "")),
      renderNodesMilliseconds: Number(match[4].replaceAll(",", "")),
      totalMilliseconds: Number(match[5].replaceAll(",", "")),
      loadedHierarchyPageCount: Number(match[6].replaceAll(",", "")),
      selectedNodeCount: Number(match[7].replaceAll(",", "")),
      selectedDepth: Number(match[8].replaceAll(",", "")),
    };
  }

  function readFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }

  function parseFormattedNumber(value) {
    return value === undefined
      ? undefined
      : Number(value.replaceAll(",", ""));
  }

  function normalizePointGeometryTiming(timingData) {
    if (!timingData || typeof timingData !== "object") {
      return undefined;
    }

    const nodeCount = readFiniteNumber(timingData.nodeCount);
    const cacheHitCount = readFiniteNumber(timingData.cacheHitCount);
    const maxRequestRoundTripMilliseconds = readFiniteNumber(
      timingData.maxRequestRoundTripMilliseconds,
    );
    const maxViewMilliseconds = readFiniteNumber(
      timingData.maxPointDataViewMilliseconds,
    );
    const maxWorkerMilliseconds = readFiniteNumber(
      timingData.maxWorkerTotalMilliseconds,
    );
    const maxQueueMilliseconds = readFiniteNumber(
      timingData.maxRequestQueueMilliseconds,
    );
    const sumViewMilliseconds = readFiniteNumber(
      timingData.pointDataViewMilliseconds,
    );
    const sumWorkerMilliseconds = readFiniteNumber(
      timingData.workerTotalMilliseconds,
    );
    const sumQueueMilliseconds = readFiniteNumber(
      timingData.requestQueueMilliseconds,
    );

    if (
      nodeCount === undefined ||
      cacheHitCount === undefined ||
      maxRequestRoundTripMilliseconds === undefined ||
      maxViewMilliseconds === undefined ||
      maxWorkerMilliseconds === undefined ||
      sumViewMilliseconds === undefined ||
      sumWorkerMilliseconds === undefined ||
      sumQueueMilliseconds === undefined
    ) {
      return undefined;
    }

    return {
      nodeCount,
      cacheHitCount,
      maxRequestRoundTripMilliseconds,
      maxDecodeMilliseconds: maxViewMilliseconds,
      maxViewMilliseconds,
      maxWorkerMilliseconds,
      maxQueueMilliseconds,
      sumDecodeMilliseconds: sumViewMilliseconds,
      sumViewMilliseconds,
      sumWorkerMilliseconds,
      sumQueueMilliseconds,
      pointDataViewRangeWaitMilliseconds: readFiniteNumber(
        timingData.pointDataViewRangeWaitMilliseconds,
      ),
      maxPointDataViewRangeWaitMilliseconds: readFiniteNumber(
        timingData.maxPointDataViewRangeWaitMilliseconds,
      ),
      pointDataViewRangeRequestCount: readFiniteNumber(
        timingData.pointDataViewRangeRequestCount,
      ),
      pointDataViewRangeBytes: readFiniteNumber(
        timingData.pointDataViewRangeBytes,
      ),
      pointDataViewLazPerfMilliseconds: readFiniteNumber(
        timingData.pointDataViewLazPerfMilliseconds,
      ),
      maxPointDataViewLazPerfMilliseconds: readFiniteNumber(
        timingData.maxPointDataViewLazPerfMilliseconds,
      ),
      pointDataViewNonRangeMilliseconds: readFiniteNumber(
        timingData.pointDataViewNonRangeMilliseconds,
      ),
      maxPointDataViewNonRangeMilliseconds: readFiniteNumber(
        timingData.maxPointDataViewNonRangeMilliseconds,
      ),
      pointDataViewCacheWaitMilliseconds: readFiniteNumber(
        timingData.pointDataViewCacheWaitMilliseconds,
      ),
      maxPointDataViewCacheWaitMilliseconds: readFiniteNumber(
        timingData.maxPointDataViewCacheWaitMilliseconds,
      ),
      evidenceSource: "point-geometry-timing-data",
    };
  }

  function parsePointGeometryTiming(timingText, timingData) {
    const structuredTiming = normalizePointGeometryTiming(timingData);
    if (structuredTiming) {
      return structuredTiming;
    }

    const match = timingText?.match(
      /([\\d,]+) nodes, ([\\d,]+) cache hits, max round trip ([\\d,.]+) ms, max (?:view|decode) ([\\d,.]+) ms, max worker ([\\d,.]+) ms(?:, max queue ([\\d,.]+) ms)?, sum (?:view|decode) ([\\d,.]+) ms, sum worker ([\\d,.]+) ms, sum queue ([\\d,.]+) ms/,
    );

    if (!match) {
      return undefined;
    }

    const maxViewMilliseconds = parseFormattedNumber(match[4]);
    const sumViewMilliseconds = parseFormattedNumber(match[7]);

    return {
      nodeCount: parseFormattedNumber(match[1]),
      cacheHitCount: parseFormattedNumber(match[2]),
      maxRequestRoundTripMilliseconds: parseFormattedNumber(match[3]),
      maxDecodeMilliseconds: maxViewMilliseconds,
      maxViewMilliseconds,
      maxWorkerMilliseconds: parseFormattedNumber(match[5]),
      maxQueueMilliseconds: parseFormattedNumber(match[6]),
      sumDecodeMilliseconds: sumViewMilliseconds,
      sumViewMilliseconds,
      sumWorkerMilliseconds: parseFormattedNumber(match[8]),
      sumQueueMilliseconds: parseFormattedNumber(match[9]),
      evidenceSource: "point-geometry-timing",
    };
  }

  function parseGeometryCacheCounters(cacheText) {
    const match = cacheText?.match(
      /([0-9,]+)[ ]*[/][ ]*[0-9,]+ loaded batches, ([0-9,]+) hits, ([0-9,]+) density reuses, ([0-9,]+) misses, ([0-9,]+) evictions/,
    );

    if (!match) {
      return undefined;
    }

    return {
      loadedBatchCount: Number(match[1].replaceAll(",", "")),
      hitCount: Number(match[2].replaceAll(",", "")),
      densityReuseCount: Number(match[3].replaceAll(",", "")),
      missCount: Number(match[4].replaceAll(",", "")),
      evictionCount: Number(match[5].replaceAll(",", "")),
    };
  }

  function subtractGeometryCacheCounters(before, after) {
    if (!before || !after) {
      return undefined;
    }

    return {
      loadedBatchCount: after.loadedBatchCount - before.loadedBatchCount,
      hitCount: after.hitCount - before.hitCount,
      densityReuseCount:
        after.densityReuseCount - before.densityReuseCount,
      missCount: after.missCount - before.missCount,
      evictionCount: after.evictionCount - before.evictionCount,
    };
  }

  function subtractNonnegativeCounter(before, after, name) {
    const beforeValue = before?.[name];
    const afterValue = after?.[name];

    if (!Number.isFinite(beforeValue) || !Number.isFinite(afterValue)) {
      return undefined;
    }

    return Math.max(0, afterValue - beforeValue);
  }

  function createHierarchyPageLoadStatsDelta(before, after) {
    if (!before || !after) {
      return undefined;
    }

    return {
      loadCount: subtractNonnegativeCounter(before, after, "loadCount"),
      cacheHitCount: subtractNonnegativeCounter(
        before,
        after,
        "cacheHitCount",
      ),
      sharedTaskReuseCount: subtractNonnegativeCounter(
        before,
        after,
        "sharedTaskReuseCount",
      ),
      completedLoadCount: subtractNonnegativeCounter(
        before,
        after,
        "completedLoadCount",
      ),
      failedLoadCount: subtractNonnegativeCounter(
        before,
        after,
        "failedLoadCount",
      ),
      requestedByteCount: subtractNonnegativeCounter(
        before,
        after,
        "requestedByteCount",
      ),
      totalLoadMilliseconds: subtractNonnegativeCounter(
        before,
        after,
        "totalLoadMilliseconds",
      ),
      batchLoadCount: subtractNonnegativeCounter(
        before,
        after,
        "batchLoadCount",
      ),
      totalBatchLoadMilliseconds: subtractNonnegativeCounter(
        before,
        after,
        "totalBatchLoadMilliseconds",
      ),
      maxLoadMillisecondsBefore: before.maxLoadMilliseconds,
      maxLoadMillisecondsAfter: after.maxLoadMilliseconds,
      maxLoadMillisecondsIncrease: subtractNonnegativeCounter(
        before,
        after,
        "maxLoadMilliseconds",
      ),
      maxBatchLoadMillisecondsBefore: before.maxBatchLoadMilliseconds,
      maxBatchLoadMillisecondsAfter: after.maxBatchLoadMilliseconds,
      maxBatchLoadMillisecondsIncrease: subtractNonnegativeCounter(
        before,
        after,
        "maxBatchLoadMilliseconds",
      ),
      maxConcurrentLoadCountBefore: before.maxConcurrentLoadCount,
      maxConcurrentLoadCountAfter: after.maxConcurrentLoadCount,
      maxConcurrentLoadCountIncrease: subtractNonnegativeCounter(
        before,
        after,
        "maxConcurrentLoadCount",
      ),
      activeLoadCountBefore: before.activeLoadCount,
      activeLoadCountAfter: after.activeLoadCount,
      lastBatchRequestedPageCountBefore: before.lastBatchRequestedPageCount,
      lastBatchRequestedPageCountAfter: after.lastBatchRequestedPageCount,
      maxBatchRequestedPageCountBefore: before.maxBatchRequestedPageCount,
      maxBatchRequestedPageCountAfter: after.maxBatchRequestedPageCount,
      maxBatchRequestedPageCountIncrease: subtractNonnegativeCounter(
        before,
        after,
        "maxBatchRequestedPageCount",
      ),
    };
  }

  function parseAppliedCameraStreamBudget(budgetText) {
    const capMatch = budgetText?.match(/([\\d,]+)\\s+render pts cap/i);

    if (capMatch) {
      return Number(capMatch[1].replaceAll(",", ""));
    }

    const budgetMatch = budgetText?.match(/^([\\d,]+) points/);

    return budgetMatch ? Number(budgetMatch[1].replaceAll(",", "")) : undefined;
  }

  async function stopSmoothnessFrameCollector(frameCollectorId) {
    return page.evaluate((expectedFrameCollectorId) => {
      const observedFrameCollector = window.__copcSmoothnessFrameCollector;
      const frameCollectorRegistry =
        window.__copcSmoothnessFrameCollectors instanceof Map
          ? window.__copcSmoothnessFrameCollectors
          : undefined;
      const frameCollector =
        frameCollectorRegistry?.get(expectedFrameCollectorId) ??
        (observedFrameCollector?.id === expectedFrameCollectorId
          ? observedFrameCollector
          : undefined);
      const observedFrameCollectorId = observedFrameCollector?.id;

      if (
        observedFrameCollector &&
        observedFrameCollector !== frameCollector &&
        typeof observedFrameCollector.stop === "function"
      ) {
        observedFrameCollector.stop("stale-collector-cleanup");
      }

      if (!frameCollector) {
        return {
          collectorMatched: false,
          expectedFrameCollectorId,
          observedFrameCollectorId,
          cameraMovementFrameDeltas: [],
          terminalRefinementFrameDeltas: [],
          terminalRefinementDurationMilliseconds: 0,
          collectedFrameCount: 0,
          stopReason: "collector-missing",
        };
      }

      const collectorMatched =
        observedFrameCollector === frameCollector &&
        frameCollector.id === expectedFrameCollectorId;
      const snapshot = frameCollector.stop(
        collectorMatched
          ? "measured-status-confirmed"
          : "detached-collector-cleanup",
      );

      return {
        ...snapshot,
        collectorMatched,
        expectedFrameCollectorId,
        observedFrameCollectorId,
      };
    }, frameCollectorId);
  }

  async function measureSmoothness(
    sampleSnapshot,
    streamPointBudget,
    runIndex,
    measurementType = "measured",
  ) {
    const runLabel =
      measurementType === "warmup"
        ? \`warmup \${runIndex}\`
        : \`run \${runIndex}\`;
    const httpRangeScope = beginHttpRangeScope({
      sampleId: sampleSnapshot.sampleId,
      sampleLabel: sampleSnapshot.label,
      measurementType,
      runIndex,
      streamPointBudget,
    });
    let httpRangeEvidence = { records: [], summary: summarizeHttpRangeRequests([]) };
    let measurement;

    measurement = await page.evaluate(
      async ({ durationMilliseconds, cameraSteps, moveMeters, cameraHeightAboveCloudMeters, clearCachesBeforeRun, cacheResetMode }) => {
        const benchmark = window.__copcBasicViewerBenchmark;

        if (!benchmark) {
          throw new Error("Basic viewer benchmark API was not installed.");
        }

        let cacheReset;

        if (clearCachesBeforeRun) {
          if (typeof benchmark.clearStreamingCaches !== "function") {
            throw new Error("Basic viewer benchmark cache reset API was not installed.");
          }

          cacheReset = await benchmark.clearStreamingCaches({
            resetLayerCaches: cacheResetMode === "layer",
          });
        }

        const statusBeforeCameraMovement = benchmark.getStatus();
        const geometryCacheBeforeText =
          statusBeforeCameraMovement.geometryCache;
        const hierarchyPageLoadStatsBeforeCameraMovement =
          statusBeforeCameraMovement.hierarchyPageLoadStats;

        const staleFrameCollectorRegistry =
          window.__copcSmoothnessFrameCollectors instanceof Map
            ? window.__copcSmoothnessFrameCollectors
            : undefined;

        if (staleFrameCollectorRegistry) {
          for (const staleFrameCollector of [
            ...staleFrameCollectorRegistry.values(),
          ]) {
            if (typeof staleFrameCollector?.stop === "function") {
              staleFrameCollector.stop("superseded-by-next-measurement");
            }
          }
        } else {
          const staleFrameCollector = window.__copcSmoothnessFrameCollector;

          if (typeof staleFrameCollector?.stop === "function") {
            staleFrameCollector.stop("superseded-by-next-measurement");
          }
        }

        const frameCollectorId =
          Date.now() + "-" + Math.random().toString(36).slice(2);
        const frameDeltas = [];
        const frameEndTimestamps = [];
        const longFrameEvidence = [];
        let previousFrameTimestamp;
        let isRunning = true;
        let animationFrameId;
        let cameraMovementCompletedAtMilliseconds;
        let stoppedAtMilliseconds;

        function onFrame(timestamp) {
          if (!isRunning) {
            return;
          }

          if (previousFrameTimestamp !== undefined) {
            const frameDeltaMilliseconds = timestamp - previousFrameTimestamp;
            frameDeltas.push(frameDeltaMilliseconds);
            frameEndTimestamps.push(timestamp);

            if (frameDeltaMilliseconds > 50) {
              const status = window.__copcBasicViewerBenchmark?.getStatus();
              longFrameEvidence.push({
                frameIndex: frameDeltas.length - 1,
                frameDeltaMilliseconds,
                frameEndTimestampMilliseconds: timestamp,
                cameraStreamRequestId: status?.cameraStreamRequestId,
                status: status?.status,
                rendererTiming: status?.rendererTiming,
                pointGeometryTiming: status?.pointGeometryTiming,
                pointGeometryTimingData: status?.pointGeometryTimingData,
                cameraStreamDiagnostics:
                  status?.cameraStreamDiagnosticsData,
                cameraStreamVisualQuality:
                  status?.cameraStreamVisualQuality,
                cameraStreamApplyTiming: status?.cameraStreamApplyTiming,
              });
            }
          }

          previousFrameTimestamp = timestamp;
          animationFrameId = window.requestAnimationFrame(onFrame);
        }

        const frameCollector = {
          id: frameCollectorId,
          markCameraMovementCompleted(timestamp) {
            if (!Number.isFinite(timestamp)) {
              throw new Error(
                "Smoothness benchmark camera movement completion timestamp was not finite.",
              );
            }

            cameraMovementCompletedAtMilliseconds = timestamp;
          },
          stop(stopReason = "measurement-complete") {
            if (isRunning) {
              isRunning = false;

              if (animationFrameId !== undefined) {
                window.cancelAnimationFrame(animationFrameId);
              }
            }

            stoppedAtMilliseconds ??= performance.now();
            const firstRefinementFrameIndex =
              cameraMovementCompletedAtMilliseconds === undefined
                ? -1
                : frameEndTimestamps.findIndex(
                    (timestamp) =>
                      timestamp > cameraMovementCompletedAtMilliseconds,
                  );
            const movementFrameCount =
              firstRefinementFrameIndex === -1
                ? frameDeltas.length
                : firstRefinementFrameIndex;

            if (window.__copcSmoothnessFrameCollector === frameCollector) {
              delete window.__copcSmoothnessFrameCollector;
            }
            const activeFrameCollectorRegistry =
              window.__copcSmoothnessFrameCollectors instanceof Map
                ? window.__copcSmoothnessFrameCollectors
                : undefined;

            if (
              activeFrameCollectorRegistry?.get(frameCollectorId) ===
              frameCollector
            ) {
              activeFrameCollectorRegistry.delete(frameCollectorId);
            }

            if (activeFrameCollectorRegistry?.size === 0) {
              delete window.__copcSmoothnessFrameCollectors;
            }

            return {
              frameCollectorId,
              cameraMovementFrameDeltas: frameDeltas.slice(
                0,
                movementFrameCount,
              ),
              terminalRefinementFrameDeltas: frameDeltas.slice(
                movementFrameCount,
              ),
              terminalRefinementDurationMilliseconds:
                cameraMovementCompletedAtMilliseconds === undefined
                  ? 0
                  : Math.max(
                      0,
                      stoppedAtMilliseconds -
                        cameraMovementCompletedAtMilliseconds,
                    ),
              longFrameEvidence: longFrameEvidence.map((evidence) => ({
                ...evidence,
                phase:
                  evidence.frameIndex < movementFrameCount
                    ? "camera-movement"
                    : "terminal-refinement",
                phaseFrameIndex:
                  evidence.frameIndex < movementFrameCount
                    ? evidence.frameIndex
                    : evidence.frameIndex - movementFrameCount,
              })),
              collectedFrameCount: frameDeltas.length,
              cameraMovementCompletedAtMilliseconds,
              stopReason,
            };
          },
        };

        const frameCollectorRegistry = new Map();
        frameCollectorRegistry.set(frameCollectorId, frameCollector);
        window.__copcSmoothnessFrameCollectors = frameCollectorRegistry;
        window.__copcSmoothnessFrameCollector = frameCollector;
        animationFrameId = window.requestAnimationFrame(onFrame);

        try {
          const startedAt = performance.now();
          const status = await benchmark.moveCameraForSmoothness({
            steps: cameraSteps,
            durationMilliseconds,
            heightAboveCloudMeters: cameraHeightAboveCloudMeters,
            moveMeters,
          });
          const completedAt = performance.now();
          frameCollector.markCameraMovementCompleted(
            status?.cameraMovementCompletedAtMilliseconds,
          );

          return {
            measuredDurationMilliseconds: completedAt - startedAt,
            cacheReset,
            geometryCacheBeforeText,
            hierarchyPageLoadStatsBeforeCameraMovement,
            frameCollectorId,
            status,
          };
        } catch (error) {
          frameCollector.stop("camera-movement-error");
          throw error;
        }
      },
      { durationMilliseconds, cameraSteps, moveMeters, cameraHeightAboveCloudMeters, clearCachesBeforeRun, cacheResetMode },
    );
    setHttpRangeScopePhase(httpRangeScope, "terminal-refinement");

    const initialStatus = measurement.status;
    const expectedCameraStreamRequestId =
      initialStatus?.expectedCameraStreamRequestId;
    const expectedCameraStreamCameraEpoch =
      initialStatus?.cameraStreamCameraEpoch;
    const expectedCameraStreamCameraPoseFingerprint =
      initialStatus?.cameraStreamCameraPoseFingerprint;

    const cameraStreamFirstResponseMilliseconds =
      initialStatus?.cameraStreamFirstResponseMilliseconds;
    const cameraStreamForegroundCompletionMilliseconds =
      initialStatus?.cameraStreamForegroundCompletionMilliseconds;
    const cameraStreamFirstResponseEvidence =
      initialStatus?.cameraStreamFirstResponseEvidence;
    let measuredStatus = initialStatus;
    let waitedForMeasuredStatus = false;
    let frameCollection;

    try {
      if (!Number.isSafeInteger(expectedCameraStreamRequestId)) {
        throw new Error(
          \`\${runLabel} did not report an expected camera stream request ID.\`,
        );
      }
      if (!Number.isSafeInteger(expectedCameraStreamCameraEpoch)) {
        throw new Error(
          \`\${runLabel} did not report an expected camera stream epoch.\`,
        );
      }
      if (
        typeof expectedCameraStreamCameraPoseFingerprint !== "string" ||
        expectedCameraStreamCameraPoseFingerprint.length === 0
      ) {
        throw new Error(
          \`\${runLabel} did not report an expected camera pose fingerprint.\`,
        );
      }

      if (
        waitForFinalDetail &&
        !hasFinalCameraStreamResult(
          measuredStatus,
          expectedCameraStreamRequestId,
          expectedCameraStreamCameraEpoch,
          expectedCameraStreamCameraPoseFingerprint,
        )
      ) {
        measuredStatus = await waitForCameraStreamStatus(
          expectedCameraStreamRequestId,
          expectedCameraStreamCameraEpoch,
          expectedCameraStreamCameraPoseFingerprint,
        );
        waitedForMeasuredStatus = true;
      } else if (
        !waitForFinalDetail &&
        !hasInteractiveCameraStreamResult(
          measuredStatus,
          expectedCameraStreamRequestId,
          expectedCameraStreamCameraEpoch,
          expectedCameraStreamCameraPoseFingerprint,
        )
      ) {
        measuredStatus = await waitForCameraStreamInteractiveStatus(
          expectedCameraStreamRequestId,
          expectedCameraStreamCameraEpoch,
          expectedCameraStreamCameraPoseFingerprint,
        );
        waitedForMeasuredStatus = true;
      }
    } finally {
      frameCollection = await stopSmoothnessFrameCollector(
        measurement.frameCollectorId,
      );
    }
    setHttpRangeScopePhase(httpRangeScope, "post-terminal-prefetch");

    measurement = {
      ...measurement,
      frameCollection,
      frameDeltas: frameCollection.cameraMovementFrameDeltas,
      terminalRefinementFrameDeltas:
        frameCollection.terminalRefinementFrameDeltas,
      terminalRefinementDurationMilliseconds:
        frameCollection.terminalRefinementDurationMilliseconds,
      longFrameEvidence: frameCollection.longFrameEvidence,
    };

    if (!frameCollection.collectorMatched) {
      failures.push(
        \`\${runLabel} frame collector did not match: expected \${frameCollection.expectedFrameCollectorId}, observed \${frameCollection.observedFrameCollectorId ?? "none"}.\`,
      );
    }

    const cameraStreamCompletion = createCameraStreamCompletion(
      measuredStatus,
      expectedCameraStreamRequestId,
      expectedCameraStreamCameraEpoch,
      expectedCameraStreamCameraPoseFingerprint,
      waitedForMeasuredStatus,
    );
    const prefetchStatus = await waitForCameraStreamPrefetch(
      prefetchWaitTimeoutMilliseconds,
    );
    const postPrefetchRefinement = createPostPrefetchRefinementEvidence(
      prefetchStatus,
      initialStatus,
      expectedCameraStreamRequestId,
    );

    if (measurement.frameDeltas.length < Math.max(10, cameraSteps / 2)) {
      failures.push(
        \`\${runLabel} collected only \${measurement.frameDeltas.length} frames during camera movement.\`,
      );
    }

    if (waitForFinalDetail && !cameraStreamCompletion.isComplete) {
      failures.push(
        \`\${runLabel} did not complete final camera stream request \${expectedCameraStreamRequestId}: \${measuredStatus.status}\`,
      );
    } else if (
      !waitForFinalDetail &&
      !cameraStreamCompletion.isComplete
    ) {
      failures.push(
        \`\${runLabel} did not produce an interactive result for camera stream request \${expectedCameraStreamRequestId}: \${measuredStatus.status}\`,
      );
    }

    if (!measuredStatus.rendererTiming || measuredStatus.rendererTiming.includes("Not rendered")) {
      failures.push(\`\${runLabel} did not expose renderer timing after camera movement.\`);
    }

    const renderedPointCount =
      measuredStatus.cameraStreamRenderedPointCount ??
      parseCameraStreamPointCount(measuredStatus.status);
    const cameraStreamDetailProgress =
      measuredStatus.cameraStreamDetailProgress ??
      parseCameraStreamDetailProgress(measuredStatus.status);
    const cameraStreamVisualQuality = measuredStatus.cameraStreamVisualQuality;
    const cameraStreamNodeReuse = measuredStatus.cameraStreamNodeReuse;
    const cameraStreamDiagnostics =
      measuredStatus.cameraStreamDiagnosticsData ??
      parseCameraStreamDiagnostics(measuredStatus.cameraStreamDiagnostics);
    const geometryCacheBefore = parseGeometryCacheCounters(
      measurement.geometryCacheBeforeText,
    );
    const geometryCacheAfter = parseGeometryCacheCounters(
      measuredStatus.geometryCache,
    );
    const geometryCacheDelta = subtractGeometryCacheCounters(
      geometryCacheBefore,
      geometryCacheAfter,
    );
    const hierarchyPageLoadStatsBeforeCameraMovement =
      measurement.hierarchyPageLoadStatsBeforeCameraMovement;
    const hierarchyPageLoadStatsFinal =
      measuredStatus.hierarchyPageLoadStats;
    const hierarchyPageLoadStatsDelta = createHierarchyPageLoadStatsDelta(
      hierarchyPageLoadStatsBeforeCameraMovement,
      hierarchyPageLoadStatsFinal,
    );
    let pointGeometryTiming = parsePointGeometryTiming(
      measuredStatus.pointGeometryTiming,
      measuredStatus.pointGeometryTimingData,
    );

    if (
      (!pointGeometryTiming ||
        measuredStatus.cameraStreamRenderDisposition?.startsWith(
          "retained-",
        )) &&
      cacheResetMode === "none" &&
      Number.isSafeInteger(cameraStreamNodeReuse?.finalNodeCount) &&
      cameraStreamNodeReuse.finalNodeCount > 0 &&
      Number.isSafeInteger(cameraStreamNodeReuse?.freshCachedFinalNodeCount) &&
      cameraStreamNodeReuse.freshCachedFinalNodeCount ===
        cameraStreamNodeReuse.finalNodeCount
    ) {
      pointGeometryTiming = {
        nodeCount: cameraStreamNodeReuse.finalNodeCount,
        cacheHitCount: cameraStreamNodeReuse.freshCachedFinalNodeCount,
        maxRequestRoundTripMilliseconds: 0,
        maxDecodeMilliseconds: 0,
        maxViewMilliseconds: 0,
        maxWorkerMilliseconds: 0,
        maxQueueMilliseconds: 0,
        sumDecodeMilliseconds: 0,
        sumViewMilliseconds: 0,
        sumWorkerMilliseconds: 0,
        sumQueueMilliseconds: 0,
        evidenceSource:
          measuredStatus.cameraStreamRenderDisposition?.startsWith(
            "retained-",
          )
            ? measuredStatus.cameraStreamRenderDisposition
            : "camera-stream-node-sample-cache",
        geometryCacheBefore,
        geometryCacheAfter,
        geometryCacheDelta,
      };
    }
    const appliedStreamPointBudget =
      parseAppliedCameraStreamBudget(measuredStatus.cameraStreamBudget) ??
      streamPointBudget;

    if (appliedStreamPointBudget > streamPointBudget) {
      failures.push(
        \`\${runLabel} applied \${appliedStreamPointBudget} points above the configured \${streamPointBudget} point cap.\`,
      );
    }

    if (renderedPointCount === undefined) {
      failures.push(
        \`\${runLabel} did not report a camera stream point count. Status: \${JSON.stringify(measuredStatus.status)}; render disposition: \${measuredStatus.cameraStreamRenderDisposition ?? "not-reported"}.\`,
      );
    } else if (renderedPointCount > appliedStreamPointBudget) {
      failures.push(
        \`\${runLabel} rendered \${renderedPointCount} points with a \${appliedStreamPointBudget} point budget.\`,
      );
    }

    if (!cameraStreamDiagnostics) {
      failures.push(\`\${runLabel} did not expose camera stream diagnostics.\`);
    } else {
      const expectedMinSelectedDepth =
        minSelectedDepthOverride ?? sampleSnapshot.expectedMinSelectedDepth;
      const shouldEnforceAbsoluteDepth =
        minSelectedDepthOverride !== undefined ||
        cameraStreamVisualQuality?.terminalFrontierMode !==
          "mixed-depth-antichain";

      if (
        shouldEnforceAbsoluteDepth &&
        expectedMinSelectedDepth !== undefined &&
        cameraStreamDiagnostics.selectedDepth < expectedMinSelectedDepth
      ) {
        failures.push(
          \`\${runLabel} selected depth \${cameraStreamDiagnostics.selectedDepth}; expected at least \${expectedMinSelectedDepth}.\`,
        );
      }
    }

    if (waitForFinalDetail && !cameraStreamDetailProgress) {
      failures.push(
        \`\${runLabel} did not expose camera stream detail progress. Visual quality: \${JSON.stringify(cameraStreamVisualQuality)}.\`,
      );
    }
    if (waitForFinalDetail && !cameraStreamVisualQuality?.isTerminalReady) {
      failures.push(
        \`\${runLabel} did not expose a verified terminal visual composition.\`,
      );
    }

    if (
      cameraStreamFirstResponseMilliseconds === undefined ||
      !Number.isFinite(cameraStreamFirstResponseMilliseconds)
    ) {
      failures.push(\`\${runLabel} did not expose camera stream first-response timing.\`);
    }
    const expectedFirstResponseSource =
      cameraStreamFirstResponseEvidence?.renderDisposition?.startsWith(
        "retained-",
      )
        ? "app-render-retained"
        : "app-render-commit";
    if (
      cameraStreamFirstResponseEvidence?.source !==
        expectedFirstResponseSource ||
      !Number.isSafeInteger(
        cameraStreamFirstResponseEvidence?.rendererRevision,
      ) ||
      cameraStreamFirstResponseEvidence.requestId !==
        expectedCameraStreamRequestId ||
      cameraStreamFirstResponseEvidence.appliedRequestId !==
        expectedCameraStreamRequestId ||
      cameraStreamFirstResponseEvidence.elapsedMilliseconds !==
        cameraStreamFirstResponseMilliseconds
    ) {
      failures.push(
        \`\${runLabel} did not bind first response to the expected applied render request.\`,
      );
    }
    if (
      cameraStreamForegroundCompletionMilliseconds === undefined ||
      !Number.isFinite(cameraStreamForegroundCompletionMilliseconds)
    ) {
      failures.push(
        \`\${runLabel} did not expose camera stream foreground-completion timing.\`,
      );
    } else if (
      Number.isFinite(cameraStreamFirstResponseMilliseconds) &&
      cameraStreamForegroundCompletionMilliseconds <
        cameraStreamFirstResponseMilliseconds
    ) {
      failures.push(
        \`\${runLabel} reported foreground completion before its first visible response.\`,
      );
    }

    httpRangeEvidence = await endHttpRangeScope(httpRangeScope);

    return {
      sampleId: sampleSnapshot.sampleId,
      sampleLabel: sampleSnapshot.label,
      sourcePreset: sampleSnapshot.sourcePreset,
      coordinateTransform: sampleSnapshot.coordinateTransform,
      measurementType,
      runIndex,
      streamPointBudget,
      appliedStreamPointBudget,
      renderedPointCount,
      cameraStreamDetailProgress,
      cameraStreamVisualQuality,
      cameraStreamNodeReuse,
      finalNodeCount: cameraStreamDetailProgress?.finalNodeCount,
      renderedFinalNodeCount:
        cameraStreamDetailProgress?.renderedFinalNodeCount,
      renderedFinalNodeCoverageRatio:
        cameraStreamDetailProgress?.renderedFinalNodeCoverageRatio,
      renderedFinalNodeWeightCoverageRatio:
        cameraStreamDetailProgress?.renderedFinalNodeWeightCoverageRatio,
      expectedCameraStreamRequestId,
      expectedCameraStreamCameraEpoch,
      expectedCameraStreamCameraPoseFingerprint,
      cameraStreamDiagnosticsText: measuredStatus.cameraStreamDiagnostics,
      cameraStreamDiagnostics,
      cameraStreamSelectionEvidence:
        measuredStatus.cameraStreamSelectionEvidence,
      cameraStreamRenderSignature:
        measuredStatus.cameraStreamRenderSignature,
      cameraStreamRenderDisposition:
        measuredStatus.cameraStreamRenderDisposition,
      cameraStreamRendererRevision:
        measuredStatus.cameraStreamRendererRevision,
      cameraStreamApplyTiming: measuredStatus.cameraStreamApplyTiming,
      cameraStreamSelectedNodeKeys:
        measuredStatus.cameraStreamSelectedNodeKeys,
      cameraStreamHierarchyHeld:
        measuredStatus.cameraStreamHierarchyHeld === true,
      cameraStreamPrefetchText: prefetchStatus.cameraStreamPrefetch,
      cameraStreamPrefetch: prefetchStatus.cameraStreamPrefetchData,
      pointGeometryTimingText: measuredStatus.pointGeometryTiming,
      pointGeometryTiming,
      httpRangeRequests: httpRangeEvidence.records,
      httpRangeSummary: httpRangeEvidence.summary,
      httpRangePhaseSummaries: httpRangeEvidence.phaseSummaries,
      geometryCacheBefore,
      geometryCacheAfter,
      geometryCacheDelta,
      decodedPointDataCache: measuredStatus.decodedPointDataCache,
      hierarchyCacheStats: measuredStatus.hierarchyCacheStats,
      hierarchyPageLoadStatsBeforeCameraMovement,
      hierarchyPageLoadStatsFinal,
      hierarchyPageLoadStatsDelta,
      hierarchyCacheAfterPrefetch: prefetchStatus.hierarchyCacheStats,
      cameraStreamCompletion,
      postPrefetchRefinement,
      cameraStreamFirstResponseMilliseconds,
      cameraStreamForegroundCompletionMilliseconds,
      cameraStreamFirstResponseEvidence,
      cacheReset: measurement.cacheReset,
      ...measurement,
      status: measuredStatus,
      prefetchStatus,
      terminalRefinementSummary: summarizeFrames(
        measurement.terminalRefinementFrameDeltas,
      ),
      summary: summarizeFrames(measurement.frameDeltas),
    };
  }

  function summarizeWarmup(warmup, settle) {
    return {
      sampleId: warmup.sampleId,
      sampleLabel: warmup.sampleLabel,
      warmupIndex: warmup.runIndex,
      streamPointBudget: warmup.streamPointBudget,
      appliedStreamPointBudget: warmup.appliedStreamPointBudget,
      renderedPointCount: warmup.renderedPointCount,
      finalNodeCount: warmup.finalNodeCount,
      renderedFinalNodeCount: warmup.renderedFinalNodeCount,
      renderedFinalNodeCoverageRatio:
        warmup.renderedFinalNodeCoverageRatio,
      renderedFinalNodeWeightCoverageRatio:
        warmup.renderedFinalNodeWeightCoverageRatio,
      measuredDurationMilliseconds: warmup.measuredDurationMilliseconds,
      terminalRefinementDurationMilliseconds:
        warmup.terminalRefinementDurationMilliseconds,
      terminalRefinementSummary: warmup.terminalRefinementSummary,
      cameraStreamFirstResponseMilliseconds:
        warmup.cameraStreamFirstResponseMilliseconds,
      cameraStreamForegroundCompletionMilliseconds:
        warmup.cameraStreamForegroundCompletionMilliseconds,
      cameraStreamFirstResponseEvidence:
        warmup.cameraStreamFirstResponseEvidence,
      cameraStreamCompletion: warmup.cameraStreamCompletion,
      cameraStreamDiagnostics: warmup.cameraStreamDiagnostics,
      cameraStreamPrefetch: warmup.cameraStreamPrefetch,
      pointGeometryTiming: warmup.pointGeometryTiming,
      httpRangeSummary: warmup.httpRangeSummary,
      httpRangePhaseSummaries: warmup.httpRangePhaseSummaries,
      httpRangeRequests: warmup.httpRangeRequests,
      cacheReset: warmup.cacheReset,
      settle,
      summary: warmup.summary,
    };
  }

  function createWarmHierarchyIdentity(result) {
    return JSON.stringify({
      selectedDepth: result.cameraStreamDiagnostics?.selectedDepth,
      selectedNodeKeys: [...(result.cameraStreamSelectedNodeKeys ?? [])].sort(),
      renderSignature: result.cameraStreamRenderSignature,
      hierarchyCacheStats: result.hierarchyCacheStats,
      cameraPoseFingerprint:
        result.expectedCameraStreamCameraPoseFingerprint,
      selectionEvidence: result.cameraStreamSelectionEvidence,
    });
  }

  function hasWarmHierarchyEvidence(result) {
    return (
      typeof result.cameraStreamRenderSignature === "string" &&
      result.cameraStreamRenderSignature.length > 0 &&
      Array.isArray(result.cameraStreamSelectedNodeKeys) &&
      result.cameraStreamSelectedNodeKeys.length > 0 &&
      result.hierarchyCacheStats &&
      typeof result.hierarchyCacheStats === "object"
    );
  }

  function validateMixedDepthBudgetProgression() {
    for (const sampleCase of sampleCases) {
      for (let runIndex = 1; runIndex <= repeatCount; runIndex += 1) {
        const orderedRuns = results
          .filter(
            (result) =>
              result.sampleId === sampleCase.id &&
              result.runIndex === runIndex &&
              result.measurementType === "measurement",
          )
          .sort(
            (left, right) =>
              left.streamPointBudget - right.streamPointBudget,
          );

        for (let index = 1; index < orderedRuns.length; index += 1) {
          const previous = orderedRuns[index - 1];
          const current = orderedRuns[index];
          const previousDepth =
            previous.cameraStreamDiagnostics?.selectedDepth;
          const currentDepth = current.cameraStreamDiagnostics?.selectedDepth;

          if (
            previous.cameraStreamVisualQuality?.terminalFrontierMode ===
              "mixed-depth-antichain" &&
            current.cameraStreamVisualQuality?.terminalFrontierMode ===
              "mixed-depth-antichain" &&
            current.streamPointBudget > previous.streamPointBudget &&
            Number.isFinite(previousDepth) &&
            Number.isFinite(currentDepth) &&
            currentDepth < previousDepth
          ) {
            failures.push(
              \`\${sampleCase.id} run \${runIndex} mixed-depth selection regressed from depth \${previousDepth} at \${previous.streamPointBudget.toLocaleString()} points to depth \${currentDepth} at \${current.streamPointBudget.toLocaleString()} points.\`,
            );
          }
        }
      }
    }
  }

  await page.goto(${JSON.stringify(baseUrl)}, { waitUntil: "domcontentloaded" });
  await waitForBenchmarkApi();

  for (const sampleCase of sampleCases) {
    const sampleSnapshot = await prepareViewer(sampleCase, streamPointBudgets[0]);

    for (const streamPointBudget of streamPointBudgets) {
      await releaseWarmCameraHierarchy();
      await setStreamPointBudget(streamPointBudget);
      let lastWarmupSettle;

      for (
        let warmupIndex = 1;
        warmupIndex <= warmupRunCount;
        warmupIndex += 1
      ) {
        const warmup = await measureSmoothness(
          sampleSnapshot,
          streamPointBudget,
          warmupIndex,
          "warmup",
        );
        const settle = await settleWarmupPrefetch();
        lastWarmupSettle = settle;

        warmups.push(
          summarizeWarmup(warmup, settle),
        );
      }

      let hierarchyHold;

      if (warmupRunCount > 0) {
        if (!lastWarmupSettle?.isComplete) {
          failures.push(
            \`\${sampleSnapshot.sampleId} \${streamPointBudget} point warm hierarchy did not reach a completed prefetch before measurement (state \${lastWarmupSettle?.state ?? "missing"}).\`,
          );
        } else {
          try {
            hierarchyHold = await holdWarmCameraHierarchy();
            hierarchyHolds.push({
              sampleId: sampleSnapshot.sampleId,
              streamPointBudget,
              warmupSettle: lastWarmupSettle,
              ...hierarchyHold,
            });
          } catch (error) {
            failures.push(
              \`\${sampleSnapshot.sampleId} \${streamPointBudget} point warm hierarchy hold failed: \${error.message}\`,
            );
          }
        }
      }

      let measuredWarmHierarchyIdentity;

      try {
        for (let runIndex = 1; runIndex <= repeatCount; runIndex += 1) {
          const result = await measureSmoothness(
            sampleSnapshot,
            streamPointBudget,
            runIndex,
          );

          if (hierarchyHold) {
            const runLabel = \`\${sampleSnapshot.sampleId} \${streamPointBudget} point run \${runIndex}\`;

            if (!result.cameraStreamHierarchyHeld) {
              failures.push(\`\${runLabel} did not retain the warm hierarchy hold.\`);
            }

            if (!hasWarmHierarchyEvidence(result)) {
              failures.push(\`\${runLabel} did not report exact warm hierarchy evidence.\`);
            } else {
              const hierarchyIdentity = createWarmHierarchyIdentity(result);
              const terminalCacheIdentity = JSON.stringify(
                result.hierarchyCacheStats,
              );
              const postPrefetchCacheIdentity = JSON.stringify(
                result.hierarchyCacheAfterPrefetch,
              );
              const heldCacheIdentity = JSON.stringify(
                hierarchyHold.hierarchyCacheStats,
              );

              if (terminalCacheIdentity !== heldCacheIdentity) {
                failures.push(
                  \`\${runLabel} changed hierarchy cache state after the warm hold was captured.\`,
                );
              }

              if (postPrefetchCacheIdentity !== terminalCacheIdentity) {
                failures.push(
                  \`\${runLabel} changed hierarchy cache state during held geometry prefetch.\`,
                );
              }

              if (
                measuredWarmHierarchyIdentity !== undefined &&
                hierarchyIdentity !== measuredWarmHierarchyIdentity
              ) {
                const expectedIdentity = JSON.parse(
                  measuredWarmHierarchyIdentity,
                );
                const actualIdentity = JSON.parse(hierarchyIdentity);
                const expectedNodeKeys = new Set(
                  expectedIdentity.selectedNodeKeys,
                );
                const actualNodeKeys = new Set(actualIdentity.selectedNodeKeys);
                const missingNodeKeys = expectedIdentity.selectedNodeKeys.filter(
                  (nodeKey) => !actualNodeKeys.has(nodeKey),
                );
                const extraNodeKeys = actualIdentity.selectedNodeKeys.filter(
                  (nodeKey) => !expectedNodeKeys.has(nodeKey),
                );
                failures.push(
                  runLabel +
                    " did not reuse the exact warm frontier and additive render signature (depth " +
                    expectedIdentity.selectedDepth +
                    "/" +
                    actualIdentity.selectedDepth +
                    "; node keys " +
                    (missingNodeKeys.length === 0 && extraNodeKeys.length === 0
                      ? "match"
                      : "missing " +
                        (missingNodeKeys.join(",") || "none") +
                        ", extra " +
                        (extraNodeKeys.join(",") || "none")) +
                    "; render signature " +
                    (expectedIdentity.renderSignature ===
                    actualIdentity.renderSignature
                      ? "matches"
                      : "differs") +
                    " [" +
                    expectedIdentity.renderSignature.split("@").slice(1).join("@") +
                    "/" +
                    actualIdentity.renderSignature.split("@").slice(1).join("@") +
                    "]; camera pose " +
                    (expectedIdentity.cameraPoseFingerprint ===
                    actualIdentity.cameraPoseFingerprint
                      ? "matches"
                      : "differs") +
                    "; selection " +
                    JSON.stringify(expectedIdentity.selectionEvidence) +
                    "/" +
                    JSON.stringify(actualIdentity.selectionEvidence) +
                    "; hierarchy cache " +
                    (JSON.stringify(expectedIdentity.hierarchyCacheStats) ===
                    JSON.stringify(actualIdentity.hierarchyCacheStats)
                      ? "matches"
                      : "differs") +
                    ").",
                );
              }

              measuredWarmHierarchyIdentity ??= hierarchyIdentity;
            }
          }

          results.push(result);
        }
      } finally {
        if (hierarchyHold) {
          await releaseWarmCameraHierarchy();
        }
      }
    }
  }

  validateMixedDepthBudgetProgression();

  if (consoleProblems.length > 0 || pageErrors.length > 0) {
    failures.push(
      [
        ...consoleProblems.map((message) => \`console \${message}\`),
        ...pageErrors.map((message) => \`pageerror: \${message}\`),
      ].join("\\n"),
    );
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\\n"));
  }

  const browserGraphics = await readBrowserGraphics();
  assertExpectedBrowserGpuRenderer(browserGraphics);

  return {
    profile,
    browserGpuProfile: ${JSON.stringify(browserGpuProfile)},
    browserGpuConfigPath: ${JSON.stringify(browserGpuConfigPath)},
    browserGpuRendererPattern: ${JSON.stringify(browserGpuRendererPattern)},
    browserIsHeaded: ${JSON.stringify(browserIsHeaded)},
    maxPointCountPerNode,
    streamPointBudgets,
    requestedPointRenderer: pointRenderer,
    maxCoalescedPointDataRangeBytes,
    maxCoalescedPointDataRangeGapBytes,
    pointGeometryWorkerConcurrency,
    hierarchyPageLoadConcurrency,
    sampleCases: sampleCases.map((sampleCase) => ({
      id: sampleCase.id,
      label: sampleCase.label,
      kind: sampleCase.kind,
      expectedMinSelectedDepth: minSelectedDepthOverride,
      sameDepthExpectedMinSelectedDepth: sampleCase.expectedMinSelectedDepth,
    })),
    repeatCount,
    warmupRunCount,
    warmupSettleTimeoutMilliseconds,
    durationMilliseconds,
    cameraSteps,
    moveMeters,
    cameraHeightAboveCloudMeters,
    clearCachesBeforeRun,
    cacheResetMode,
    waitForFinalDetail,
    finalDetailTimeoutMilliseconds,
    interactiveTimeoutMilliseconds,
    prefetchWaitTimeoutMilliseconds,
    browserGraphics,
    browserEnvironment: await readBrowserEnvironment(),
    pointRenderer: await metadataValue("Point renderer"),
    warmups,
    hierarchyHolds,
    results,
    httpRangeRequests,
    ignoredConsoleWarnings,
  };
}
`;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function printBenchmarkSummary(result) {
  console.log("Smoothness benchmark summary:");
  console.log(`- GPU: ${result.browserGraphics.renderer}`);

  console.log(
    `- ${result.maxPointCountPerNode.toLocaleString()} max points / node, ${result.cameraSteps.toLocaleString()} camera steps`,
  );
  console.log(
    `- coalesced range settings: ${
      result.maxCoalescedPointDataRangeBytes === undefined
        ? "default span"
        : `max span ${result.maxCoalescedPointDataRangeBytes.toLocaleString()} bytes`
    }${
      result.maxCoalescedPointDataRangeGapBytes === undefined
        ? ""
        : `, max coalesced range gap ${result.maxCoalescedPointDataRangeGapBytes.toLocaleString()} bytes`
    }${
      result.pointGeometryWorkerConcurrency === undefined
        ? ""
        : `, geometry workers ${result.pointGeometryWorkerConcurrency.toLocaleString()}`
    }${
      result.hierarchyPageLoadConcurrency === undefined
        ? ""
        : `, hierarchy page loads ${result.hierarchyPageLoadConcurrency.toLocaleString()}`
    }`,
  );

  for (const sampleCase of result.sampleCases) {
    const depthTarget =
      sampleCase.expectedMinSelectedDepth === undefined
        ? ""
        : `, min selected depth ${sampleCase.expectedMinSelectedDepth}`;
    console.log(`- ${sampleCase.label}${depthTarget}`);

    for (const streamPointBudget of result.streamPointBudgets) {
      const runs = result.results.filter(
        (run) =>
          run.sampleId === sampleCase.id &&
          run.streamPointBudget === streamPointBudget,
      );

      if (runs.length === 0) {
        console.log(
          `  - ${streamPointBudget.toLocaleString()} point stream budget: no runs`,
        );
        continue;
      }

      const averageFps = average(
        runs.map((run) => run.summary.estimatedAverageFps),
      );
      const averageP95 = average(
        runs.map((run) => run.summary.p95FrameMilliseconds),
      );
      const maxFrame = Math.max(
        ...runs.map((run) => run.summary.maxFrameMilliseconds),
      );
      const over50 = runs.reduce(
        (sum, run) => sum + run.summary.frameDeltasOver50Milliseconds,
        0,
      );
      const renderedPoints = runs.map((run) => run.renderedPointCount ?? 0);
      const cacheResets = runs.map((run) => run.cacheReset).filter(Boolean);
      const diagnostics = runs
        .map((run) => run.cameraStreamDiagnostics)
        .filter(Boolean);
      const detailProgresses = runs
        .map((run) => run.cameraStreamDetailProgress)
        .filter(Boolean);
      const averageExpandMilliseconds = average(
        diagnostics.map((run) => run.expandHierarchyMilliseconds),
      );
      const averageApplyMilliseconds = average(
        diagnostics.map((run) => run.applyHierarchyMilliseconds),
      );
      const averageSelectMilliseconds = average(
        diagnostics.map((run) => run.selectNodesMilliseconds),
      );
      const averageRenderMilliseconds = average(
        diagnostics.map((run) => run.renderNodesMilliseconds),
      );
      const averageTotalStreamMilliseconds = average(
        diagnostics.map((run) => run.totalMilliseconds),
      );
      const averageSelectedDepth = average(
        diagnostics.map((run) => run.selectedDepth),
      );
      const geometryTimings = runs
        .map((run) => run.pointGeometryTiming)
        .filter(Boolean);
      const firstResponseTimings = runs
        .map((run) => run.cameraStreamFirstResponseMilliseconds)
        .filter((value) => Number.isFinite(value));
      const firstResponseSummary =
        firstResponseTimings.length === 0
          ? undefined
          : `first response avg ${average(firstResponseTimings).toFixed(1)} ms`;
      const geometrySummary =
        geometryTimings.length === 0
          ? undefined
          : `geometry avg max view/worker/roundtrip ${average(
              geometryTimings.map((run) => run.maxDecodeMilliseconds),
            ).toFixed(1)}/${average(
              geometryTimings.map((run) => run.maxWorkerMilliseconds),
            ).toFixed(1)}/${average(
              geometryTimings.map((run) => run.maxRequestRoundTripMilliseconds),
            ).toFixed(1)} ms, avg queue/node ${average(
              geometryTimings.map(
                (run) => run.sumQueueMilliseconds / Math.max(1, run.nodeCount),
              ),
            ).toFixed(1)} ms, cache hits avg ${average(
              geometryTimings.map((run) => run.cacheHitCount),
            ).toFixed(1)}/${average(
              geometryTimings.map((run) => run.nodeCount),
            ).toFixed(1)} nodes`;
      const detailCoverageSummary =
        detailProgresses.length === 0
          ? undefined
          : `current-view node coverage avg ${(
              average(
                detailProgresses.map(
                  (progress) => progress.renderedFinalNodeCoverageRatio,
                ),
              ) * 100
            ).toFixed(1)}%`;
      const prefetches = runs
        .map((run) => run.cameraStreamPrefetch)
        .filter(Boolean);
      const prefetchSummary =
        prefetches.length === 0
          ? undefined
          : `prefetch avg ${average(
              prefetches.map((prefetch) => prefetch.prefetchedNodeCount),
            ).toFixed(1)}/${average(
              prefetches.map((prefetch) => prefetch.requestedNodeCount),
            ).toFixed(1)} nodes, skipped avg ${average(
              prefetches.map((prefetch) => prefetch.skippedNodeCount),
            ).toFixed(1)}`;
      const httpRangeSummaries = runs
        .map((run) => run.httpRangeSummary)
        .filter(Boolean);
      const httpRangeSummary =
        httpRangeSummaries.length === 0
          ? undefined
          : `http range avg ${average(
              httpRangeSummaries.map((summary) => summary.requestCount),
            ).toFixed(1)} req, finished bytes avg ${average(
              httpRangeSummaries.map((summary) => summary.finishedRangeBytes),
            ).toFixed(0)}, union bytes avg ${average(
              httpRangeSummaries.map((summary) => summary.unionRangeBytes),
            ).toFixed(0)}`;
      const summaryParts = [
        `  - ${streamPointBudget.toLocaleString()} point stream budget`,
        `${runs.length.toLocaleString()} runs`,
        `${Math.min(...renderedPoints).toLocaleString()}-${Math.max(...renderedPoints).toLocaleString()} rendered pts`,
        `avg ${averageFps.toFixed(1)} fps`,
        `p95 ${averageP95.toFixed(2)} ms`,
        `max ${maxFrame.toFixed(2)} ms`,
        `${over50.toLocaleString()} frames > 50 ms`,
        `depth avg ${averageSelectedDepth.toFixed(1)}`,
        `stream avg expand/apply/select/render/total ${averageExpandMilliseconds.toFixed(1)}/${averageApplyMilliseconds.toFixed(1)}/${averageSelectMilliseconds.toFixed(1)}/${averageRenderMilliseconds.toFixed(1)}/${averageTotalStreamMilliseconds.toFixed(1)} ms`,
      ];

      if (cacheResets.length > 0) {
        summaryParts.push(
          `cache reset avg ${average(
            cacheResets.map((reset) => reset.pointSampleSetCount),
          ).toFixed(1)} sample sets / ${average(
            cacheResets.map((reset) => reset.pointGeometryBatchCount),
          ).toFixed(1)} geometry batches / ${average(
            cacheResets.map((reset) => reset.pointSampleWorkerCount ?? 0),
          ).toFixed(1)} sample workers / ${average(
            cacheResets.map((reset) => reset.pointGeometryWorkerCount ?? 0),
          ).toFixed(1)} geometry workers`,
        );
      }

      if (geometrySummary) {
        summaryParts.push(geometrySummary);
      }

      if (firstResponseSummary) {
        summaryParts.push(firstResponseSummary);
      }

      if (detailCoverageSummary) {
        summaryParts.push(detailCoverageSummary);
      }

      if (prefetchSummary) {
        summaryParts.push(prefetchSummary);
      }

      if (httpRangeSummary) {
        summaryParts.push(httpRangeSummary);
      }

      console.log(summaryParts.join(", "));
    }
  }
}

await mkdir(outputRoot, { recursive: true });
assertInside(outputRoot, benchmarkRoot);
await mkdir(benchmarkRoot, { recursive: true });
await rm(benchmarkFlowPath, { force: true });
await rm(benchmarkResultPath, { force: true });

console.log("Building example...");
run(npmCommand, ["run", "build:example"], repoRoot);

const port = await findAvailablePort(4373);
const baseUrl = `http://localhost:${port}`;
const exampleUrl = createExampleUrl(baseUrl);
const serverOutput = [];
const serverProcess = spawn(
  process.execPath,
  [
    viteCliPath,
    "preview",
    "examples/basic-viewer",
    "--config",
    "vite.config.ts",
    "--host",
    "localhost",
    "--port",
    String(port),
    "--strictPort",
    "--outDir",
    "../../dist/example",
  ],
  {
    cwd: repoRoot,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

serverProcess.stdout.on("data", (data) => {
  serverOutput.push(data.toString());
});
serverProcess.stderr.on("data", (data) => {
  serverOutput.push(data.toString());
});

try {
  console.log(`Starting example preview at ${exampleUrl}...`);
  await waitForServer(baseUrl, serverProcess, serverOutput);

  await writeFile(
    benchmarkFlowPath,
    createSmoothnessFlow(
      exampleUrl,
      benchmarkMaxPointCountPerNode,
      benchmarkStreamPointBudgets,
      benchmarkPointRenderer,
      benchmarkSampleCases,
      benchmarkProfile,
      benchmarkRepeats,
      benchmarkWarmupRuns,
      benchmarkWarmupSettleTimeoutMilliseconds,
      benchmarkDurationMilliseconds,
      benchmarkCameraSteps,
      benchmarkMoveMeters,
      benchmarkCameraHeightAboveCloudMeters,
      benchmarkMinSelectedDepthOverride,
      benchmarkCacheResetMode,
      benchmarkWaitForFinalDetail,
      benchmarkFinalDetailTimeoutMilliseconds,
      benchmarkInteractiveTimeoutMilliseconds,
      benchmarkPrefetchWaitTimeoutMilliseconds,
      benchmarkMaxCoalescedPointDataRangeBytes,
      benchmarkMaxCoalescedPointDataRangeGapBytes,
      benchmarkPointGeometryWorkerConcurrency,
      benchmarkHierarchyPageLoadConcurrency,
      browserGpu.profile,
      playwrightConfigPath,
      browserGpu.rendererPattern ?? null,
      createBrowserGpuRendererAssertionSource(browserGpu.rendererPattern),
      browserHeaded,
    ),
  );

  console.log(
    [
      "Running smoothness benchmark:",
      `${benchmarkMaxPointCountPerNode.toLocaleString()} max points / node,`,
      `${benchmarkStreamPointBudgets
        .map((value) => value.toLocaleString())
        .join("/")} stream budgets,`,
      `${benchmarkPointRenderer} renderer,`,
      `${benchmarkSampleCases.map((sample) => sample.id).join("/")} samples,`,
      benchmarkProfile === undefined ? "" : `${benchmarkProfile} profile,`,
      `${benchmarkRepeats.toLocaleString()} repeats,`,
      benchmarkWarmupRuns === 0
        ? ""
        : `${benchmarkWarmupRuns.toLocaleString()} warmup runs,`,
      benchmarkWarmupRuns === 0
        ? ""
        : `${benchmarkWarmupSettleTimeoutMilliseconds.toLocaleString()} ms warmup settle,`,
      `${benchmarkCameraSteps.toLocaleString()} camera steps,`,
      benchmarkCameraHeightAboveCloudMeters === undefined
        ? ""
        : `${benchmarkCameraHeightAboveCloudMeters.toLocaleString()} m camera height,`,
      benchmarkCacheResetMode !== "none"
        ? `${benchmarkCacheResetMode} cache reset,`
        : "",
      benchmarkMaxCoalescedPointDataRangeBytes === undefined
        ? ""
        : `${benchmarkMaxCoalescedPointDataRangeBytes.toLocaleString()} max coalesced range bytes,`,
      benchmarkMaxCoalescedPointDataRangeGapBytes === undefined
        ? ""
        : `${benchmarkMaxCoalescedPointDataRangeGapBytes.toLocaleString()} max coalesced range gap bytes,`,
      benchmarkPointGeometryWorkerConcurrency === undefined
        ? ""
        : `${benchmarkPointGeometryWorkerConcurrency.toLocaleString()} point geometry workers,`,
      benchmarkHierarchyPageLoadConcurrency === undefined
        ? ""
        : `${benchmarkHierarchyPageLoadConcurrency.toLocaleString()} hierarchy page loads,`,
      benchmarkMinSelectedDepthOverride === undefined
        ? "same-depth sample targets; mixed-depth budget progression"
        : `min selected depth ${benchmarkMinSelectedDepthOverride}`,
    ]
      .filter(Boolean)
      .join(" "),
  );
  runPlaywrightCli([
    "--config",
    playwrightConfigPath,
    "open",
    ...(browserHeaded ? ["--headed"] : []),
    "about:blank",
  ]);
  const output = runPlaywrightCli([
    "run-code",
    "--filename",
    benchmarkFlowPath,
  ]);
  const result = extractPlaywrightResult(output);
  const report = {
    ...result,
    schema: benchmarkArtifactSchema,
    schemaVersion: benchmarkArtifactSchemaVersion,
    runEvidence: await createRunEvidence({ repoRoot }),
  };
  await writeFile(benchmarkResultPath, `${JSON.stringify(report, null, 2)}\n`);
  printBenchmarkSummary(report);
  console.log(`Smoothness benchmark result written: ${benchmarkResultPath}`);
} finally {
  try {
    runPlaywrightCli(["close"]);
  } catch {
    // The browser may already be closed if startup failed.
  }
  stopServer(serverProcess);
  await rm(benchmarkFlowPath, { force: true });
}
