import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outputRoot = path.join(repoRoot, "output");
const benchmarkRoot = path.join(outputRoot, "smoothness-benchmark");
const benchmarkOutputName = readBenchmarkOutputName();
const benchmarkResultPath = path.join(
  benchmarkRoot,
  benchmarkOutputName,
);
const benchmarkFlowPath = path.join(
  benchmarkRoot,
  `${path.parse(benchmarkOutputName).name}-flow.mjs`,
);
const playwrightConfigPath = path.join(
  scriptDir,
  "playwright.high-performance-gpu.json",
);
const isWindows = process.platform === "win32";
const npmCommand = "npm";
const npxCommand = "npx";
const playwrightCliPackage = "@playwright/cli@0.1.14";

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
  "sofi-stadium": {
    id: "sofi-stadium",
    label: "SoFi Stadium",
    kind: "preset",
    sampleId: "sofi-stadium",
    expectedSourcePreset: "SoFi Stadium",
    expectedCoordinateTransformText: "EPSG:32611",
    expectedMinSelectedDepth: 2,
  },
  "custom-sofi": {
    id: "custom-sofi",
    label: "Custom SoFi URL",
    kind: "custom",
    url: "https://s3.amazonaws.com/hobu-lidar/sofi.copc.laz",
    sourceCrs: "EPSG:32611",
    sourceDefinition:
      "+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs",
    expectedSourcePreset: "Custom URL",
    expectedCoordinateTransformText: "EPSG:32611 to EPSG:4326",
    expectedMinSelectedDepth: 2,
  },
};
const benchmarkSampleCases = readSampleCasesEnv(
  "COPC_SMOOTHNESS_SAMPLES",
  ["autzen-classified", "sofi-stadium", "custom-sofi"],
);
const benchmarkMaxPointCountPerNode = readPositiveIntegerEnv(
  "COPC_SMOOTHNESS_POINT_COUNT",
  Math.max(...benchmarkStreamPointBudgets),
);
const benchmarkRepeats = readPositiveIntegerEnv("COPC_SMOOTHNESS_REPEATS", 2);
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
    throw new Error(`${name} must be a comma-separated list of positive integers.`);
  }

  return [...new Set(values)];
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

  if (rawValue !== "typed" && rawValue !== "primitive" && rawValue !== "buffer") {
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
  const unknownIds = uniqueIds.filter((id) => !(id in smoothnessSampleCaseById));

  if (unknownIds.length > 0) {
    throw new Error(
      `${name} contains unknown sample ids: ${unknownIds.join(", ")}`,
    );
  }

  return uniqueIds.map((id) => smoothnessSampleCaseById[id]);
}

function assertInside(parent, target) {
  const relative = path.relative(parent, target);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
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
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function runPlaywrightCli(args) {
  const result = spawnSync(
    npxCommand,
    ["--yes", "--package", playwrightCliPackage, "playwright-cli", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      shell: isWindows,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

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
      } else if (character === "\"") {
        isInsideString = false;
      }

      continue;
    }

    if (character === "\"") {
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

function createSmoothnessFlow(
  baseUrl,
  maxPointCountPerNode,
  streamPointBudgets,
  pointRenderer,
  sampleCases,
  repeatCount,
  durationMilliseconds,
  cameraSteps,
  moveMeters,
  cameraHeightAboveCloudMeters,
  minSelectedDepthOverride,
  cacheResetMode,
  waitForFinalDetail,
) {
  return `async (page) => {
  const maxPointCountPerNode = ${JSON.stringify(maxPointCountPerNode)};
  const streamPointBudgets = ${JSON.stringify(streamPointBudgets)};
  const pointRenderer = ${JSON.stringify(pointRenderer)};
  const sampleCases = ${JSON.stringify(sampleCases)};
  const repeatCount = ${JSON.stringify(repeatCount)};
  const durationMilliseconds = ${JSON.stringify(durationMilliseconds)};
  const cameraSteps = ${JSON.stringify(cameraSteps)};
  const moveMeters = ${JSON.stringify(moveMeters)};
  const cameraHeightAboveCloudMeters = ${JSON.stringify(cameraHeightAboveCloudMeters)};
  const minSelectedDepthOverride = ${JSON.stringify(minSelectedDepthOverride)};
  const cacheResetMode = ${JSON.stringify(cacheResetMode)};
  const waitForFinalDetail = ${JSON.stringify(waitForFinalDetail)};
  const clearCachesBeforeRun = cacheResetMode !== "none";
  const failures = [];
  const consoleProblems = [];
  const pageErrors = [];
  const results = [];

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

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleProblems.push(\`\${message.type()}: \${message.text()}\`);
    }
  });

  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
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
      "Camera stream rendered",
      "Camera stream previewed",
      "Camera stream partial render",
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

  async function waitForCameraStreamStatus() {
    try {
      await page.waitForFunction(
        () => document.querySelector("#copc-status")?.textContent?.includes("Camera stream rendered"),
        undefined,
        { timeout: 120_000 },
      );
    } catch (error) {
      const currentStatus = await page.locator("#copc-status").textContent();
      throw new Error(
        \`Timed out waiting for a camera stream render. Current status: "\${currentStatus}". \${error.message}\`,
      );
    }
  }

  async function waitForCameraStreamInteractiveStatus() {
    try {
      await page.waitForFunction(
        () => {
          const status = document.querySelector("#copc-status")?.textContent ?? "";
          return (
            status.includes("Camera stream rendered") ||
            status.includes("Camera stream previewed") ||
            status.includes("Camera stream partial render")
          );
        },
        undefined,
        { timeout: 120_000 },
      );
    } catch (error) {
      const currentStatus = await page.locator("#copc-status").textContent();
      throw new Error(
        \`Timed out waiting for an interactive camera stream render. Current status: "\${currentStatus}". \${error.message}\`,
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
    await waitForCameraStreamInteractiveStatus();

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
    await waitForCameraStreamInteractiveStatus();
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
    const match = statusText.match(
      /Camera stream (?:rendered|previewed|partial render) ([\\d,]+) points/,
    );

    if (!match) {
      return undefined;
    }

    return Number(match[1].replaceAll(",", ""));
  }

  function isCameraStreamInteractiveStatus(statusText) {
    return (
      statusText.includes("Camera stream rendered") ||
      statusText.includes("Camera stream previewed") ||
      statusText.includes("Camera stream partial render")
    );
  }

  function parseCameraStreamDetailProgress(statusText) {
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

  function parsePointGeometryTiming(timingText) {
    const match = timingText?.match(
      /([\\d,]+) nodes, ([\\d,]+) cache hits, max round trip ([\\d,.]+) ms, max decode ([\\d,.]+) ms, max worker ([\\d,.]+) ms(?:, max queue ([\\d,.]+) ms)?, sum decode ([\\d,.]+) ms, sum worker ([\\d,.]+) ms, sum queue ([\\d,.]+) ms/,
    );

    if (!match) {
      return undefined;
    }

    return {
      nodeCount: Number(match[1].replaceAll(",", "")),
      cacheHitCount: Number(match[2].replaceAll(",", "")),
      maxRequestRoundTripMilliseconds: Number(match[3].replaceAll(",", "")),
      maxDecodeMilliseconds: Number(match[4].replaceAll(",", "")),
      maxWorkerMilliseconds: Number(match[5].replaceAll(",", "")),
      maxQueueMilliseconds: match[6] === undefined
        ? undefined
        : Number(match[6].replaceAll(",", "")),
      sumDecodeMilliseconds: Number(match[7].replaceAll(",", "")),
      sumWorkerMilliseconds: Number(match[8].replaceAll(",", "")),
      sumQueueMilliseconds: Number(match[9].replaceAll(",", "")),
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

  async function measureSmoothness(sampleSnapshot, streamPointBudget, runIndex) {
    const measurement = await page.evaluate(
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

          cacheReset = benchmark.clearStreamingCaches({
            resetLayerCaches: cacheResetMode === "layer",
          });
        }

        const frameDeltas = [];
        let previousFrameTimestamp;
        let isRunning = true;

        function onFrame(timestamp) {
          if (previousFrameTimestamp !== undefined) {
            frameDeltas.push(timestamp - previousFrameTimestamp);
          }

          previousFrameTimestamp = timestamp;

          if (isRunning) {
            window.requestAnimationFrame(onFrame);
          }
        }

        window.requestAnimationFrame(onFrame);
        const startedAt = performance.now();
        const status = await benchmark.moveCameraForSmoothness({
          steps: cameraSteps,
          durationMilliseconds,
          heightAboveCloudMeters: cameraHeightAboveCloudMeters,
          moveMeters,
        });
        const completedAt = performance.now();
        await new Promise((resolve) => {
          window.requestAnimationFrame(() => {
            isRunning = false;
            resolve(undefined);
          });
        });

        return {
          measuredDurationMilliseconds: completedAt - startedAt,
          cacheReset,
          frameDeltas,
          status,
        };
      },
      { durationMilliseconds, cameraSteps, moveMeters, cameraHeightAboveCloudMeters, clearCachesBeforeRun, cacheResetMode },
    );
    const cameraStreamFirstResponseMilliseconds =
      measurement.status.cameraStreamFirstResponseMilliseconds;

    if (
      waitForFinalDetail &&
      !measurement.status.status.includes("Camera stream rendered")
    ) {
      await waitForCameraStreamStatus();
      measurement.status = await benchmarkStatus();
    } else if (
      !waitForFinalDetail &&
      !isCameraStreamInteractiveStatus(measurement.status.status)
    ) {
      await waitForCameraStreamInteractiveStatus();
      measurement.status = await benchmarkStatus();
    }

    measurement.status = await waitForCameraStreamPrefetch(
      waitForFinalDetail ? 5_000 : 2_000,
    );

    if (measurement.frameDeltas.length < Math.max(10, cameraSteps / 2)) {
      failures.push(
        \`run \${runIndex} collected only \${measurement.frameDeltas.length} frames during camera movement.\`,
      );
    }

    if (
      waitForFinalDetail &&
      !measurement.status.status.includes("Camera stream rendered")
    ) {
      failures.push(
        \`run \${runIndex} ended with unexpected status: \${measurement.status.status}\`,
      );
    } else if (
      !waitForFinalDetail &&
      !isCameraStreamInteractiveStatus(measurement.status.status)
    ) {
      failures.push(
        \`run \${runIndex} ended without an interactive camera stream status: \${measurement.status.status}\`,
      );
    }

    if (!measurement.status.rendererTiming || measurement.status.rendererTiming.includes("Not rendered")) {
      failures.push(\`run \${runIndex} did not expose renderer timing after camera movement.\`);
    }

    const renderedPointCount = parseCameraStreamPointCount(measurement.status.status);
    const cameraStreamDetailProgress =
      measurement.status.cameraStreamDetailProgress ??
      parseCameraStreamDetailProgress(measurement.status.status);
    const cameraStreamDiagnostics =
      measurement.status.cameraStreamDiagnosticsData ??
      parseCameraStreamDiagnostics(measurement.status.cameraStreamDiagnostics);
    const pointGeometryTiming = parsePointGeometryTiming(
      measurement.status.pointGeometryTiming,
    );
    const appliedStreamPointBudget =
      parseAppliedCameraStreamBudget(measurement.status.cameraStreamBudget) ??
      streamPointBudget;

    if (renderedPointCount === undefined) {
      failures.push(\`run \${runIndex} did not report a camera stream point count.\`);
    } else if (renderedPointCount > appliedStreamPointBudget) {
      failures.push(
        \`run \${runIndex} rendered \${renderedPointCount} points with a \${appliedStreamPointBudget} point budget.\`,
      );
    }

    if (!cameraStreamDiagnostics) {
      failures.push(\`run \${runIndex} did not expose camera stream diagnostics.\`);
    } else {
      const expectedMinSelectedDepth =
        minSelectedDepthOverride ?? sampleSnapshot.expectedMinSelectedDepth;

      if (
        expectedMinSelectedDepth !== undefined &&
        cameraStreamDiagnostics.selectedDepth < expectedMinSelectedDepth
      ) {
        failures.push(
          \`run \${runIndex} selected depth \${cameraStreamDiagnostics.selectedDepth}; expected at least \${expectedMinSelectedDepth}.\`,
        );
      }
    }

    if (waitForFinalDetail && !cameraStreamDetailProgress) {
      failures.push(\`run \${runIndex} did not expose camera stream detail progress.\`);
    }

    if (
      cameraStreamFirstResponseMilliseconds === undefined ||
      !Number.isFinite(cameraStreamFirstResponseMilliseconds)
    ) {
      failures.push(\`run \${runIndex} did not expose camera stream first-response timing.\`);
    }

    return {
      sampleId: sampleSnapshot.sampleId,
      sampleLabel: sampleSnapshot.label,
      sourcePreset: sampleSnapshot.sourcePreset,
      coordinateTransform: sampleSnapshot.coordinateTransform,
      runIndex,
      streamPointBudget,
      appliedStreamPointBudget,
      renderedPointCount,
      cameraStreamDetailProgress,
      finalNodeCount: cameraStreamDetailProgress?.finalNodeCount,
      renderedFinalNodeCount:
        cameraStreamDetailProgress?.renderedFinalNodeCount,
      renderedFinalNodeCoverageRatio:
        cameraStreamDetailProgress?.renderedFinalNodeCoverageRatio,
      renderedFinalNodeWeightCoverageRatio:
        cameraStreamDetailProgress?.renderedFinalNodeWeightCoverageRatio,
      cameraStreamDiagnosticsText: measurement.status.cameraStreamDiagnostics,
      cameraStreamDiagnostics,
      cameraStreamPrefetchText: measurement.status.cameraStreamPrefetch,
      cameraStreamPrefetch: measurement.status.cameraStreamPrefetchData,
      pointGeometryTimingText: measurement.status.pointGeometryTiming,
      pointGeometryTiming,
      cameraStreamFirstResponseMilliseconds,
      cacheReset: measurement.cacheReset,
      ...measurement,
      summary: summarizeFrames(measurement.frameDeltas),
    };
  }

  await page.goto(${JSON.stringify(baseUrl)}, { waitUntil: "domcontentloaded" });
  await waitForBenchmarkApi();

  for (const sampleCase of sampleCases) {
    const sampleSnapshot = await prepareViewer(sampleCase, streamPointBudgets[0]);

    for (const streamPointBudget of streamPointBudgets) {
      await setStreamPointBudget(streamPointBudget);

      for (let runIndex = 1; runIndex <= repeatCount; runIndex += 1) {
        results.push(
          await measureSmoothness(sampleSnapshot, streamPointBudget, runIndex),
        );
      }
    }
  }

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

  return {
    maxPointCountPerNode,
    streamPointBudgets,
    requestedPointRenderer: pointRenderer,
    sampleCases: sampleCases.map((sampleCase) => ({
      id: sampleCase.id,
      label: sampleCase.label,
      kind: sampleCase.kind,
      expectedMinSelectedDepth:
        minSelectedDepthOverride ?? sampleCase.expectedMinSelectedDepth,
    })),
    repeatCount,
    durationMilliseconds,
    cameraSteps,
    moveMeters,
    cameraHeightAboveCloudMeters,
    clearCachesBeforeRun,
    cacheResetMode,
    waitForFinalDetail,
    browserGraphics: await readBrowserGraphics(),
    pointRenderer: await metadataValue("Point renderer"),
    results,
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
      const cacheResets = runs
        .map((run) => run.cacheReset)
        .filter(Boolean);
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
          : `geometry avg max decode/worker/roundtrip ${average(
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
const serverOutput = [];
const serverProcess = spawn(
  npxCommand,
  [
    "vite",
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
    shell: isWindows,
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
  console.log(`Starting example preview at ${baseUrl}...`);
  await waitForServer(baseUrl, serverProcess, serverOutput);

  await writeFile(
    benchmarkFlowPath,
    createSmoothnessFlow(
      baseUrl,
      benchmarkMaxPointCountPerNode,
      benchmarkStreamPointBudgets,
      benchmarkPointRenderer,
      benchmarkSampleCases,
      benchmarkRepeats,
      benchmarkDurationMilliseconds,
      benchmarkCameraSteps,
      benchmarkMoveMeters,
      benchmarkCameraHeightAboveCloudMeters,
      benchmarkMinSelectedDepthOverride,
      benchmarkCacheResetMode,
      benchmarkWaitForFinalDetail,
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
      `${benchmarkRepeats.toLocaleString()} repeats,`,
      `${benchmarkCameraSteps.toLocaleString()} camera steps,`,
      benchmarkCameraHeightAboveCloudMeters === undefined
        ? ""
        : `${benchmarkCameraHeightAboveCloudMeters.toLocaleString()} m camera height,`,
      benchmarkCacheResetMode !== "none"
        ? `${benchmarkCacheResetMode} cache reset,`
        : "",
      benchmarkMinSelectedDepthOverride === undefined
        ? "sample depth targets"
        : `min selected depth ${benchmarkMinSelectedDepthOverride}`,
    ].filter(Boolean).join(" "),
  );
  runPlaywrightCli([
    "--config",
    playwrightConfigPath,
    "open",
    "about:blank",
  ]);
  const output = runPlaywrightCli(["run-code", "--filename", benchmarkFlowPath]);
  const result = extractPlaywrightResult(output);
  await writeFile(benchmarkResultPath, `${JSON.stringify(result, null, 2)}\n`);
  printBenchmarkSummary(result);
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
