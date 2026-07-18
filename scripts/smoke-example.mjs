import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { LIVE_COPC_SAMPLE_URLS } from "../config/live-copc-sources.mjs";
import {
  createBrowserGpuRendererAssertionSource,
  resolveBrowserGpuProfile,
} from "./browser-gpu-profile.mjs";
import { isExpectedNonFatalWebGlDriverWarning } from "./browser-console-policy.mjs";
import { isInteractiveRenderReady } from "./interactive-render-status-policy.mjs";
import { hasExpectedPointGeometryTimingMetadata } from "./point-geometry-timing-contract.mjs";
import { resolveLocalPackageBinary } from "./resolve-local-package-binary.mjs";
import {
  createRunEvidence,
  validateRunEvidenceSourceState,
} from "./run-evidence.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const playwrightCliPath = resolveLocalPackageBinary(
  repoRoot,
  "@playwright/cli",
  "playwright-cli",
);
const viteCliPath = resolveLocalPackageBinary(repoRoot, "vite", "vite");
const outputRoot = path.join(repoRoot, "output");
const smokeRoot = path.join(outputRoot, "example-smoke");
const localFileSampleRoot = path.join(outputRoot, "local-copc-samples");
const screenshotDir = path.join(outputRoot, "playwright");
const smokeFlowPath = path.join(smokeRoot, "smoke-example-flow.mjs");
const smokeResultPath = path.join(smokeRoot, "smoke-example-result.json");
const autzenScreenshotPath = path.join(
  screenshotDir,
  "smoke-example-autzen-stream.png",
);
const millsiteScreenshotPath = path.join(
  screenshotDir,
  "smoke-example-millsite-stream.png",
);
const verificationScreenshotPath = path.join(
  screenshotDir,
  "smoke-example-final-verification.png",
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
const localFileSampleUrl = LIVE_COPC_SAMPLE_URLS.autzenClassified;
const localFileSamplePath = path.join(
  localFileSampleRoot,
  "autzen-classified.copc.laz",
);
const isWindows = process.platform === "win32";
const npmCommand = "npm";
const shouldRunLocalFileSmoke =
  process.argv.includes("--local-file") ||
  process.env.COPC_SMOKE_LOCAL_FILE === "1";
const runEvidence = await createRunEvidence({ repoRoot });

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
    process.execPath,
    [playwrightCliPath, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
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

function parsePlaywrightResult(output) {
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

function createSmokeFlow(baseUrl) {
  const localFilePath = shouldRunLocalFileSmoke
    ? JSON.stringify(localFileSamplePath)
    : "undefined";

  return `async (page) => {
  const failures = [];
  const consoleProblems = [];
  const ignoredConsoleWarnings = [];
  const pageErrors = [];
  const isExpectedNonFatalWebGlDriverWarning = ${isExpectedNonFatalWebGlDriverWarning.toString()};
  const hasExpectedPointGeometryTimingMetadata = ${hasExpectedPointGeometryTimingMetadata.toString()};

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

  const expectedRenderedStatuses = [
    "Camera stream terminal rendered",
    "Camera stream interactive-ready",
    "Camera stream previewed",
    "Camera stream partial render",
    "Auto LOD rendered",
  ];
  const isInteractiveRenderReady = ${isInteractiveRenderReady.toString()};
  const minDefaultInteractivePointCount = 4_000;
  const millsiteUrl = ${JSON.stringify(`${baseUrl}/copc-samples/millsite.copc.laz`)};
  const millsiteDefinition =
    "+proj=utm +zone=12 +ellps=GRS80 +units=m +no_defs +type=crs";
  const localFilePath = ${localFilePath};
  let primitiveRendererTiming = "";
  let primitiveRendererPayload = "";
  let typedRendererTiming = "";
  let typedRendererPayload = "";
  let typedPointGeometryTiming = "";
  let typedPointGeometryTimingData;
  let typedPointGeometryCache = "";
  let localFileRendererTiming = "";
  let cameraStreamControllerSmoke;
  let autzenOverviewStatus;
  let autzenZoomStatus;
  let autzenWheelZoomStatus;
  let autzenPrefetchStatus;
  let autzenTerminalVisualQuality;
  let millsiteTerminalVisualQuality;
  let browserGraphics;
${createBrowserGpuRendererAssertionSource(browserGpu.rendererPattern)}

  async function readBrowserGraphics() {
    return page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");

      if (!context) {
        throw new Error("WebGL is unavailable in the browser smoke test.");
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

  async function metadataValue(label) {
    return page.evaluate((targetLabel) => {
      const rows = [...document.querySelectorAll("#copc-metadata dt")];
      return rows.find((row) => row.textContent === targetLabel)
        ?.nextElementSibling?.textContent;
    }, label);
  }

  async function waitForSourcePreset(expectedSourcePreset) {
    try {
      await page.waitForFunction(
        (expectedSourcePreset) => {
          const rows = [...document.querySelectorAll("#copc-metadata dt")];
          const sourcePreset = rows.find(
            (row) => row.textContent === "Source preset",
          )?.nextElementSibling?.textContent;
          const form = document.querySelector("#copc-form");

          return (
            sourcePreset === expectedSourcePreset &&
            form?.getAttribute("aria-busy") !== "true"
          );
        },
        expectedSourcePreset,
        { timeout: 120_000 },
      );
    } catch (error) {
      throw new Error(
        "Timed out waiting for source preset " +
          '"' +
          expectedSourcePreset +
          '". Current source: "' +
          (await metadataValue("Source preset")) +
          '". ' +
          error.message,
      );
    }
  }

  async function waitForRenderedStatus() {
    try {
      await page.waitForFunction(
        (statusTexts) => {
          const isInteractiveRenderReady = ${isInteractiveRenderReady.toString()};
          const status = window.__copcBasicViewerBenchmark?.getStatus();
          const currentStatus =
            document.querySelector("#copc-status")?.textContent ?? "";
          return isInteractiveRenderReady(
            status,
            currentStatus,
            statusTexts,
          );
        },
        expectedRenderedStatuses,
        { timeout: 60_000 },
      );
    } catch (error) {
      const currentStatus = await page.locator("#copc-status").textContent();
      throw new Error(
        "Timed out waiting for a rendered status. Current status: " +
          '"' +
          currentStatus +
          '". ' +
          error.message,
      );
    }
  }

  async function waitForCameraStreamCompleteStatus() {
    try {
      await page.waitForFunction(
        () => {
          const status = window.__copcBasicViewerBenchmark?.getStatus();
          const visualQuality = status?.cameraStreamVisualQuality;

          return visualQuality
            ? visualQuality.isTerminalReady === true &&
                (visualQuality.isFrontierDepthPolicySatisfied ??
                  visualQuality.frontierDepthSpan === 0) &&
                visualQuality.isFrontierAntichain === true &&
                visualQuality.isAdditiveClosureComplete === true &&
                visualQuality.missingRequiredNodeCount === 0 &&
                visualQuality.unexpectedRenderedNodeCount === 0
            : document
                .querySelector("#copc-status")
                ?.textContent?.includes("Camera stream terminal rendered");
        },
        undefined,
        { timeout: 120_000 },
      );
      return page.evaluate(
        () => window.__copcBasicViewerBenchmark?.getStatus(),
      );
    } catch (error) {
      const currentStatus = await page.locator("#copc-status").textContent();
      throw new Error(
        \`Timed out waiting for camera-stream completion. Current status: "\${currentStatus}". \${error.message}\`,
      );
    }
  }

  async function waitForCameraStreamTerminalAfterRequest(
    previousRequestId,
    maximumCameraHeightMeters,
  ) {
    await page.waitForFunction(
      ({ maximumCameraHeightMeters, previousRequestId }) => {
        const status = window.__copcBasicViewerBenchmark?.getStatus();
        const visualQuality = status?.cameraStreamVisualQuality;

        return (
          (status?.cameraStreamRequestId ?? -1) > previousRequestId &&
          (status?.cameraStreamLodData?.cameraHeightMeters ??
            Number.POSITIVE_INFINITY) < maximumCameraHeightMeters &&
          visualQuality?.isTerminalReady === true &&
          (visualQuality.isFrontierDepthPolicySatisfied ??
            visualQuality.frontierDepthSpan === 0) &&
          visualQuality.isFrontierAntichain === true &&
          visualQuality.isAdditiveClosureComplete === true &&
          visualQuality.missingRequiredNodeCount === 0 &&
          visualQuality.unexpectedRenderedNodeCount === 0
        );
      },
      { maximumCameraHeightMeters, previousRequestId },
      { timeout: 120_000 },
    );

    return page.evaluate(
      () => window.__copcBasicViewerBenchmark?.getStatus(),
    );
  }

  async function waitForSceneReady() {
    await page.evaluate(async () => {
      const benchmark = window.__copcBasicViewerBenchmark;

      if (!benchmark) {
        throw new Error("Basic viewer benchmark API was not installed.");
      }

      await benchmark.waitForSceneReady();
    });
  }

  async function waitForInteractivePointCount(minPointCount) {
    try {
      await page.waitForFunction(
        ({ minPointCount, statusTexts }) => {
          const isInteractiveRenderReady = ${isInteractiveRenderReady.toString()};
          const status = window.__copcBasicViewerBenchmark?.getStatus();
          const currentStatus =
            document.querySelector("#copc-status")?.textContent ?? "";
          const rows = [...document.querySelectorAll("#copc-metadata dt")];
          const rendererTiming =
            rows.find((row) => row.textContent === "Renderer timing")
              ?.nextElementSibling?.textContent ?? "";
          const pointCountText = currentStatus + " " + rendererTiming;
          const match = pointCountText.match(
            /(?:rendered\\s+|previewed\\s+)?([\\d,]+)\\s+(?:pts|points)/i,
          );
          const pointCount = match
            ? Number(match[1].replaceAll(",", ""))
            : 0;

          return (
            isInteractiveRenderReady(status, currentStatus, statusTexts) &&
            pointCount >= minPointCount
          );
        },
        { minPointCount, statusTexts: expectedRenderedStatuses },
        { timeout: 120_000 },
      );
    } catch (error) {
      const currentStatus = await page.locator("#copc-status").textContent();
      const rendererTiming = await metadataValue("Renderer timing");
      throw new Error(
        \`Timed out waiting for the example to display at least \${minPointCount.toLocaleString()} interactive points. Current status: "\${currentStatus}". Renderer timing: "\${rendererTiming}". \${error.message}\`,
      );
    }
  }

  function isRenderedStatus(statusText, status) {
    return isInteractiveRenderReady(
      status,
      statusText,
      expectedRenderedStatuses,
    );
  }

  function parsePointCount(text) {
    const match = text.match(/(?:rendered\\s+)?([\\d,]+)\\s+(?:pts|points)/i);

    return match ? Number(match[1].replaceAll(",", "")) : 0;
  }

  async function hudText(selector) {
    return (await page.locator(selector).textContent())?.trim() ?? "";
  }

  async function hudCount(selector) {
    const text = await hudText(selector);
    return Number(text.replaceAll(",", ""));
  }

  async function isFullyInViewport(selector) {
    const bounds = await page.locator(selector).boundingBox();
    const viewport = page.viewportSize();

    return Boolean(
      bounds &&
        viewport &&
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= viewport.width &&
        bounds.y + bounds.height <= viewport.height,
    );
  }

  async function waitForTerminalRequestAfter(previousRequestId) {
    await page.waitForFunction(
      (previousRequestId) => {
        const status = window.__copcBasicViewerBenchmark?.getStatus();
        return (
          (status?.cameraStreamRequestId ?? -1) > previousRequestId &&
          status?.cameraStreamVisualQuality?.isTerminalReady === true
        );
      },
      previousRequestId,
      { timeout: 120_000 },
    );

    return page.evaluate(
      () => window.__copcBasicViewerBenchmark?.getStatus(),
    );
  }

  function normalizedCameraStreamDensity(status) {
    const pointCount = parsePointCount(status?.rendererTiming ?? "");
    const frontierNodeCount =
      status?.cameraStreamVisualQuality?.frontierNodeCount ?? 0;
    const selectedDepth =
      status?.cameraStreamDiagnosticsData?.selectedDepth ?? -1;

    if (
      pointCount <= 0 ||
      frontierNodeCount <= 0 ||
      selectedDepth < 0
    ) {
      return 0;
    }

    return (pointCount / frontierNodeCount) * 4 ** selectedDepth;
  }

  async function check(condition, message) {
    if (!(await condition())) {
      failures.push(message);
    }
  }

  await page.goto(${JSON.stringify(baseUrl)}, { waitUntil: "domcontentloaded" });
  browserGraphics = await readBrowserGraphics();
  assertExpectedBrowserGpuRenderer(browserGraphics);
  await waitForInteractivePointCount(minDefaultInteractivePointCount);
  await check(
    async () =>
      (await page.title()) ===
      "copc-cesium | Direct COPC streaming for CesiumJS",
    "Example page title did not identify the copc-cesium library.",
  );

  await check(
    async () => (await metadataValue("Source preset")) === "Autzen classified",
    "Autzen preset did not load as the initial source.",
  );
  await check(
    async () => {
      const sourceNote = (await metadataValue("Source note")) ?? "";

      return (
        sourceNote.includes("CC BY 4.0") &&
        sourceNote.includes("Aaron Reyna/Watershed Sciences") &&
        sourceNote.includes("Max Sampson/Hobu") &&
        sourceNote.includes("github.com/PDAL/data/blob/main/LICENSE")
      );
    },
    "Autzen visible attribution, contributors, or license URL was not reported.",
  );
  await check(
    async () =>
      (await metadataValue("Coordinate transform"))?.includes("EPSG:2992"),
    "Autzen coordinate transform was not reported.",
  );
  await check(
    async () =>
      (await metadataValue("Point renderer")) ===
      "Primitive typed arrays",
    "Default typed-array primitive renderer was not reported.",
  );
  typedRendererTiming = (await metadataValue("Renderer timing")) ?? "";
  typedRendererPayload = (await metadataValue("Renderer payload")) ?? "";
  typedPointGeometryTiming =
    (await metadataValue("Point geometry timing")) ?? "";
  typedPointGeometryTimingData = await page.evaluate(
    () =>
      window.__copcBasicViewerBenchmark?.getStatus()
        .pointGeometryTimingData,
  );
  typedPointGeometryCache =
    (await metadataValue("Point geometry cache")) ?? "";
  await check(
    async () => parsePointCount(typedRendererTiming) >= minDefaultInteractivePointCount,
    "Default renderer timing did not report the expected interactive point count.",
  );
  await check(
    async () => typedRendererPayload.includes("estimated coordinate/color payload"),
    "Default renderer payload estimate was not reported.",
  );
  await check(
    async () =>
      hasExpectedPointGeometryTimingMetadata(
        typedPointGeometryTiming,
        typedPointGeometryTimingData,
      ),
    "Default point geometry timing metadata was not reported.",
  );
  await check(
    async () =>
      typedPointGeometryCache.includes("loaded batches") &&
      typedPointGeometryCache.includes("density reuses"),
    "Default point geometry cache stats were not reported.",
  );
  autzenOverviewStatus = await waitForCameraStreamCompleteStatus();
  await check(
    async () => (await hudText("#copc-hud-dataset")) === "Autzen classified",
    "Compact HUD did not identify the initial dataset.",
  );
  await check(
    async () => (await hudText("#copc-hud-stage")) === "Ready",
    "Compact HUD did not report the terminal Ready stage.",
  );
  await check(
    async () =>
      (await hudCount("#copc-hud-total-points")) > 0 &&
      (await hudCount("#copc-hud-source-points")) > 0 &&
      (await hudCount("#copc-hud-rendered-samples")) >=
        minDefaultInteractivePointCount &&
      (await hudCount("#copc-hud-node-count")) > 0,
    "Compact HUD did not expose positive total, source, rendered, and node counts.",
  );
  await check(
    async () =>
      (await hudText("#copc-hud-compressed-bytes")) !== "—" &&
      (await hudText("#copc-hud-coverage")) === "100%",
    "Compact HUD did not expose compressed-byte and terminal coverage evidence.",
  );
  await check(
    async () =>
      (await page.locator("#copc-status").getAttribute("role")) === "status" &&
      (await page.locator("#copc-status").getAttribute("aria-live")) ===
        "polite",
    "COPC status is not exposed as a polite live region.",
  );
  await check(
    async () =>
      (await isFullyInViewport("#copc-demo-hud")) &&
      (await isFullyInViewport("#copc-status")),
    "Compact HUD or live status was outside the initial viewport.",
  );
  await check(
    async () =>
      !(await page.locator("#copc-advanced-controls").evaluate(
        (details) => details.open,
      )),
    "Advanced controls should be collapsed on the presentation-first view.",
  );
  await check(
    async () => page.locator("#copc-fit-cloud").isEnabled(),
    "Fit cloud should be enabled after COPC metadata loads.",
  );

  await page.locator("#copc-panel-toggle").click();
  await check(
    async () =>
      (await page.locator("#copc-panel-toggle").getAttribute("aria-expanded")) ===
        "false" &&
      (await page.locator("#copc-panel-body").isHidden()),
    "Panel collapse did not hide the body or update aria-expanded.",
  );
  await page.locator("#copc-panel-toggle").click();
  await check(
    async () =>
      (await page.locator("#copc-panel-toggle").getAttribute("aria-expanded")) ===
        "true" &&
      (await page.locator("#copc-panel-body").isVisible()),
    "Panel expand did not restore the body or update aria-expanded.",
  );

  const preFitRequestId = autzenOverviewStatus?.cameraStreamRequestId ?? -1;
  await page.locator("#copc-fit-cloud").click();
  autzenOverviewStatus = await waitForTerminalRequestAfter(preFitRequestId);
  await check(
    async () => (await hudText("#copc-hud-stage")) === "Ready",
    "Fit cloud did not converge back to a terminal Ready view.",
  );
  await check(
    async () => page.locator("#copc-source-crs").isDisabled(),
    "Projection controls should be disabled for sample presets.",
  );

  cameraStreamControllerSmoke = await page.evaluate(async () => {
    const benchmark = window.__copcBasicViewerBenchmark;

    if (!benchmark) {
      throw new Error("Basic viewer benchmark API was not installed.");
    }

    return benchmark.verifyCameraStreamController();
  });
  await check(
    async () => cameraStreamControllerSmoke.completedPointCount > 0,
    "High-level camera stream controller did not render COPC points.",
  );
  await check(
    async () => cameraStreamControllerSmoke.listenerCountRestored,
    "High-level camera stream controller leaked Cesium camera listeners.",
  );
  await check(
    async () => cameraStreamControllerSmoke.updatePhases.includes("complete"),
    "High-level camera stream controller did not report completion.",
  );
  await page.evaluate(async () => {
    const benchmark = window.__copcBasicViewerBenchmark;

    if (!benchmark) {
      throw new Error("Basic viewer benchmark API was not installed.");
    }

    await benchmark.moveCameraForSmoothness({
      steps: 1,
      durationMilliseconds: 16,
      heightAboveCloudMeters: 946,
      moveMeters: 1,
    });
  });
  autzenZoomStatus = await waitForCameraStreamCompleteStatus();
  autzenTerminalVisualQuality = autzenZoomStatus?.cameraStreamVisualQuality;
  await waitForSceneReady();
  await waitForInteractivePointCount(10_000);
  await page.screenshot({
    path: ${JSON.stringify(autzenScreenshotPath)},
    fullPage: false,
  });

  await check(
    async () => autzenTerminalVisualQuality?.isTerminalReady === true,
    "Autzen camera stream did not commit a verified terminal visual composition.",
  );
  await check(
    async () => autzenTerminalVisualQuality?.missingRequiredNodeCount === 0,
    "Autzen terminal composition is missing additive nodes.",
  );
  await check(
    async () => autzenTerminalVisualQuality?.unexpectedRenderedNodeCount === 0,
    "Autzen terminal composition retained stale or unexpected nodes.",
  );
  await check(
    async () =>
      (autzenZoomStatus?.cameraStreamDiagnosticsData?.selectedDepth ?? -1) >
      (autzenOverviewStatus?.cameraStreamDiagnosticsData?.selectedDepth ??
        Number.POSITIVE_INFINITY),
    \`Autzen camera zoom did not refine to a deeper terminal frontier (depth \${autzenOverviewStatus?.cameraStreamDiagnosticsData?.selectedDepth ?? "missing"} -> \${autzenZoomStatus?.cameraStreamDiagnosticsData?.selectedDepth ?? "missing"}).\`,
  );
  await check(
    async () =>
      (autzenZoomStatus?.cameraStreamVisualQuality?.frontierNodeCount ?? 0) >
      (autzenOverviewStatus?.cameraStreamVisualQuality?.frontierNodeCount ??
        Number.POSITIVE_INFINITY),
    \`Autzen camera zoom did not increase current-view frontier coverage (\${autzenOverviewStatus?.cameraStreamVisualQuality?.frontierNodeCount ?? "missing"} -> \${autzenZoomStatus?.cameraStreamVisualQuality?.frontierNodeCount ?? "missing"} frontier nodes).\`,
  );
  await check(
    async () =>
      (autzenZoomStatus?.cameraStreamLodData?.maxRenderedPointCount ?? 0) >
      (autzenOverviewStatus?.cameraStreamLodData?.maxRenderedPointCount ??
        Number.POSITIVE_INFINITY),
    \`Autzen camera zoom did not raise the rendered-point ceiling (\${autzenOverviewStatus?.cameraStreamLodData?.maxRenderedPointCount ?? "missing"} -> \${autzenZoomStatus?.cameraStreamLodData?.maxRenderedPointCount ?? "missing"}).\`,
  );
  await check(
    async () =>
      parsePointCount(autzenZoomStatus?.rendererTiming ?? "") >=
      parsePointCount(autzenOverviewStatus?.rendererTiming ?? "") * 1.25,
    \`Autzen camera zoom did not produce a meaningful terminal point-density increase (\${parsePointCount(autzenOverviewStatus?.rendererTiming ?? "")} -> \${parsePointCount(autzenZoomStatus?.rendererTiming ?? "")} points).\`,
  );
  const cesiumCanvas = page.locator("#cesium-container canvas");
  const cesiumCanvasCount = await cesiumCanvas.count();
  const cesiumCanvasBounds =
    cesiumCanvasCount === 1 ? await cesiumCanvas.boundingBox() : undefined;

  if (!cesiumCanvasBounds) {
    failures.push(
      \`Expected one visible Cesium canvas for wheel-zoom verification; found \${cesiumCanvasCount}.\`,
    );
  } else {
    const previousRequestId = autzenZoomStatus?.cameraStreamRequestId ?? -1;
    const previousCameraHeightMeters =
      autzenZoomStatus?.cameraStreamLodData?.cameraHeightMeters ??
      Number.POSITIVE_INFINITY;
    await page.mouse.move(
      cesiumCanvasBounds.x + cesiumCanvasBounds.width / 2,
      cesiumCanvasBounds.y + cesiumCanvasBounds.height / 2,
    );
    await page.mouse.wheel(0, -300);
    autzenWheelZoomStatus = await waitForCameraStreamTerminalAfterRequest(
      previousRequestId,
      previousCameraHeightMeters,
    );

    await check(
      async () =>
        (autzenWheelZoomStatus?.cameraStreamDiagnosticsData?.selectedDepth ??
          -1) >=
        (autzenZoomStatus?.cameraStreamDiagnosticsData?.selectedDepth ??
          Number.POSITIVE_INFINITY),
      \`Autzen wheel zoom regressed the terminal frontier depth (\${autzenZoomStatus?.cameraStreamDiagnosticsData?.selectedDepth ?? "missing"} -> \${autzenWheelZoomStatus?.cameraStreamDiagnosticsData?.selectedDepth ?? "missing"}; LOD: \${autzenWheelZoomStatus?.cameraStreamLod ?? "missing"}; budget: \${autzenWheelZoomStatus?.cameraStreamBudget ?? "missing"}; selection: \${autzenWheelZoomStatus?.autoLod ?? "missing"}).\`,
    );
    await check(
      async () =>
        normalizedCameraStreamDensity(autzenWheelZoomStatus) >
        normalizedCameraStreamDensity(autzenZoomStatus),
      \`Autzen wheel zoom did not increase normalized current-view density (\${normalizedCameraStreamDensity(autzenZoomStatus)} -> \${normalizedCameraStreamDensity(autzenWheelZoomStatus)}).\`,
    );
    await page.screenshot({
      path: ${JSON.stringify(autzenScreenshotPath)},
      fullPage: false,
    });
  }
  autzenPrefetchStatus = await page.evaluate(async () => {
    const benchmark = window.__copcBasicViewerBenchmark;

    if (!benchmark) {
      throw new Error("Basic viewer benchmark API was not installed.");
    }

    return benchmark.waitForCameraStreamPrefetch(120_000);
  });
  await check(
    async () => autzenPrefetchStatus?.cameraStreamPrefetchData?.completed === true,
    \`Autzen camera-stream prefetch did not settle: \${autzenPrefetchStatus?.cameraStreamPrefetch ?? "missing"}.\`,
  );
  await check(
    async () =>
      (await metadataValue("Camera stream prefetch")) ===
      autzenPrefetchStatus?.cameraStreamPrefetch,
    \`Visible camera-stream prefetch metadata did not match the settled runtime status (visible: \${await metadataValue("Camera stream prefetch") ?? "missing"}; runtime: \${autzenPrefetchStatus?.cameraStreamPrefetch ?? "missing"}).\`,
  );
  await page.locator("#copc-advanced-controls").evaluate((details) => {
    details.open = true;
  });
  await page.getByLabel("Renderer").selectOption("primitive");
  await waitForInteractivePointCount(minDefaultInteractivePointCount);
  primitiveRendererTiming = (await metadataValue("Renderer timing")) ?? "";
  primitiveRendererPayload = (await metadataValue("Renderer payload")) ?? "";
  await check(
    async () => (await metadataValue("Point renderer")) === "PointPrimitiveCollection",
    "Point primitive renderer was not reported after switching renderer.",
  );
  await check(
    async () => parsePointCount(primitiveRendererTiming) >= minDefaultInteractivePointCount,
    "Primitive renderer timing did not report the expected interactive point count.",
  );
  await check(
    async () => primitiveRendererPayload.includes("estimated coordinate/color payload"),
    "Primitive renderer payload estimate was not reported.",
  );

  await page.getByLabel("Renderer").selectOption("typed");
  await page.locator("#copc-advanced-controls").evaluate((details) => {
    details.open = false;
  });
  await page.getByLabel("Sample").selectOption("millsite-reservoir");
  await waitForSourcePreset("Millsite Reservoir (USGS 3DEP)");
  await waitForRenderedStatus();

  await check(
    async () =>
      (await metadataValue("Source preset")) ===
      "Millsite Reservoir (USGS 3DEP)",
    "Millsite Reservoir preset did not load.",
  );
  await check(
    async () =>
      (await metadataValue("Coordinate transform"))?.includes("EPSG:6341"),
    "Millsite Reservoir coordinate transform was not reported.",
  );
  await page.evaluate(() => {
    const checkbox = document.querySelector("#copc-auto-stream");

    if (!(checkbox instanceof HTMLInputElement)) {
      throw new Error("Stream on camera move checkbox was not found.");
    }

    if (!checkbox.checked) {
      checkbox.checked = true;
    }

    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitForRenderedStatus();
  await check(
    async () => (await metadataValue("Point cache"))?.includes("hits"),
    "Point sample cache stats were not reported after camera streaming.",
  );
  await check(
    async () =>
      (await metadataValue("Point geometry cache"))?.includes("loaded batches"),
    "Point geometry cache stats were not reported after camera streaming.",
  );
  await check(
    async () => (await metadataValue("Point loader"))?.includes("Web Worker"),
    "Worker point loader status was not reported.",
  );
  await check(
    async () => (await metadataValue("Hierarchy pages"))?.includes("evictions"),
    "Hierarchy page cache stats were not reported after camera streaming.",
  );
  await check(
    async () => (await metadataValue("Camera stream diagnostics"))?.includes("depth"),
    "Camera stream diagnostics did not report selected depth.",
  );
  await check(
    async () => (await metadataValue("Camera stream prefetch")) !== undefined,
    "Camera stream prefetch metadata was not reported.",
  );
  await check(
    async () =>
      ((await page.locator("#copc-status").textContent()) ?? "").includes(
        "Camera stream previewed",
      ) ||
      ((await metadataValue("Camera stream coverage")) ?? "").includes(
        "current-view",
      ) ||
      ((await metadataValue("Camera stream coverage")) ?? "").includes(
        "detail",
      ),
    "Camera stream coverage did not report preview or current-view detail coverage.",
  );
  await check(
    async () =>
      (await metadataValue("Auto LOD"))?.includes("coverage nodes at depth"),
    "Camera selection did not report complete-depth coverage selection.",
  );
  await page.evaluate(async () => {
    const benchmark = window.__copcBasicViewerBenchmark;

    if (!benchmark) {
      throw new Error("Basic viewer benchmark API was not installed.");
    }

    await benchmark.moveCameraForSmoothness({
      steps: 1,
      durationMilliseconds: 16,
      heightAboveCloudMeters: 1_600,
      moveMeters: 1,
    });
  });
  millsiteTerminalVisualQuality = (
    await waitForCameraStreamCompleteStatus()
  )?.cameraStreamVisualQuality;
  await check(
    async () =>
      (await hudText("#copc-hud-dataset")) ===
        "Millsite Reservoir (USGS 3DEP)" &&
      (await hudText("#copc-hud-total-points")) === "374,609,447" &&
      (await hudText("#copc-hud-stage")) === "Ready",
    "Millsite compact HUD did not report its exact dataset total and terminal stage.",
  );
  await check(
    async () =>
      (await hudCount("#copc-hud-source-points")) >=
        (await hudCount("#copc-hud-rendered-samples")) &&
      (await hudText("#copc-hud-coverage")) === "100%",
    "Millsite compact HUD did not distinguish selected source points from rendered samples at full coverage.",
  );
  await waitForSceneReady();
  await waitForInteractivePointCount(10_000);
  await page.screenshot({
    path: ${JSON.stringify(millsiteScreenshotPath)},
    fullPage: false,
  });
  await page.locator("#copc-advanced-controls").evaluate((details) => {
    details.open = true;
  });
  await page.getByRole("checkbox", { name: "Stream on camera move" }).uncheck();

  const preservedHudBeforeInvalidSource = await page.evaluate(() => ({
    dataset: document.querySelector("#copc-hud-dataset")?.textContent,
    totalPoints: document.querySelector("#copc-hud-total-points")?.textContent,
    renderedSamples: document.querySelector("#copc-hud-rendered-samples")?.textContent,
  }));
  await page.getByLabel("Sample").selectOption("custom");
  await page
    .getByRole("textbox", { name: "COPC URL" })
    .fill(millsiteUrl);
  await page.getByRole("textbox", { name: "Source CRS" }).fill("EPSG:6341");
  await page
    .getByRole("textbox", { name: "proj4 definition" })
    .fill(millsiteDefinition);
  const pendingSourceWasBusy = await page.evaluate(() => {
    const form = document.querySelector("#copc-form");
    const sourceCrs = document.querySelector("#copc-source-crs");

    if (!(form instanceof HTMLFormElement)) {
      throw new Error("COPC form was not found for the source race smoke.");
    }

    if (!(sourceCrs instanceof HTMLInputElement)) {
      throw new Error("Source CRS input was not found for the source race smoke.");
    }

    form.requestSubmit();
    const wasBusy = form.getAttribute("aria-busy") === "true";
    sourceCrs.value = "";
    form.requestSubmit();
    return wasBusy;
  });
  await page.waitForTimeout(250);
  const preservedHudAfterInvalidSource = await page.evaluate(() => ({
    dataset: document.querySelector("#copc-hud-dataset")?.textContent,
    totalPoints: document.querySelector("#copc-hud-total-points")?.textContent,
    renderedSamples: document.querySelector("#copc-hud-rendered-samples")?.textContent,
  }));
  const pendingSourceRaceStage = await hudText("#copc-hud-stage");
  const pendingSourceRaceStatus =
    (await page.locator("#copc-status").textContent()) ?? "";
  const pendingSourceRaceAriaBusy =
    await page.locator("#copc-form").getAttribute("aria-busy");
  const pendingSourceRaceCanvasCount = await page.locator("canvas").count();
  await check(
    async () =>
        pendingSourceWasBusy &&
        JSON.stringify(preservedHudAfterInvalidSource) ===
          JSON.stringify(preservedHudBeforeInvalidSource) &&
        pendingSourceRaceStage === "Needs attention" &&
        pendingSourceRaceStatus.includes(
          "Keeping the last valid view.",
        ) &&
        pendingSourceRaceAriaBusy === null &&
        pendingSourceRaceCanvasCount > 0,
    \`Invalid source input did not supersede the pending load while preserving the last valid cloud and HUD evidence: \${JSON.stringify({
      pendingSourceWasBusy,
      preservedHudBeforeInvalidSource,
      preservedHudAfterInvalidSource,
      stage: pendingSourceRaceStage,
      status: pendingSourceRaceStatus,
      ariaBusy: pendingSourceRaceAriaBusy,
      canvasCount: pendingSourceRaceCanvasCount,
    })}\`,
  );

  await page.getByRole("textbox", { name: "COPC URL" }).fill(millsiteUrl);
  await page.getByRole("textbox", { name: "Source CRS" }).fill("EPSG:6341");
  await page
    .getByRole("textbox", { name: "proj4 definition" })
    .fill(millsiteDefinition);
  await page.getByRole("button", { name: "Inspect" }).click();
  await waitForSourcePreset("Custom URL");
  await waitForRenderedStatus();
  await waitForInteractivePointCount(minDefaultInteractivePointCount);

  await check(
    async () =>
      (await page.locator("#copc-sample-select").inputValue()) === "custom",
    "Custom URL selection was not preserved after loading.",
  );
  await check(
    async () => !(await page.locator("#copc-source-crs").isDisabled()),
    "Projection controls should stay enabled for Custom URL.",
  );
  await check(
    async () => (await metadataValue("Source preset")) === "Custom URL",
    "Custom URL source label was not reported.",
  );
  await check(
    async () =>
      (await metadataValue("Coordinate transform"))?.includes(
        "EPSG:6341 to EPSG:4326",
      ),
    "Custom proj4 coordinate transform was not reported.",
  );
  await check(
    async () => {
      const statusText =
        (await page.locator("#copc-status").textContent()) ?? "";
      const status = await page.evaluate(
        () => window.__copcBasicViewerBenchmark?.getStatus(),
      );

      return isRenderedStatus(statusText, status);
    },
    "Custom URL did not render the expected COPC result.",
  );
  await check(
    async () => (await page.locator("canvas").count()) > 0,
    "Cesium canvas was not rendered.",
  );

  if (localFilePath) {
    await page.getByRole("textbox", { name: "Source CRS" }).fill("");
    await page
      .getByRole("textbox", { name: "proj4 definition" })
      .fill("");
    await page.locator("#copc-file").setInputFiles(localFilePath);
    await waitForSourcePreset("Local file");
    await waitForInteractivePointCount(minDefaultInteractivePointCount);

    localFileRendererTiming = (await metadataValue("Renderer timing")) ?? "";
    await check(
      async () => (await metadataValue("Source preset")) === "Local file",
      "Local COPC file source label was not reported.",
    );
    await check(
      async () =>
        (await metadataValue("Source note"))?.includes(
          "Browser-selected COPC file",
        ),
      "Local COPC file source note was not reported.",
    );
    await check(
      async () =>
        (await metadataValue("Coordinate transform"))?.includes("EPSG:2992"),
      "Local COPC file did not use the expected default Autzen transform.",
    );
    await check(
      async () => parsePointCount(localFileRendererTiming) >= minDefaultInteractivePointCount,
      "Local COPC file renderer timing did not report the expected interactive point count.",
    );
  }

  // The preset path above already proves full camera-stream completion with
  // 10,000 points. The custom URL contract is manual proj4 plus an interactive
  // render, so it must not depend on finishing the dataset's background tail.
  await waitForSceneReady();

  await page.screenshot({
    path: ${JSON.stringify(verificationScreenshotPath)},
    fullPage: false,
  });

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
    status: await page.locator("#copc-status").textContent(),
    coordinateTransform: await metadataValue("Coordinate transform"),
    sourcePreset: await metadataValue("Source preset"),
    primitiveRendererTiming,
    primitiveRendererPayload,
    typedRendererTiming,
    typedRendererPayload,
    typedPointGeometryTiming,
    typedPointGeometryTimingData,
    typedPointGeometryCache,
    cameraStreamControllerSmoke,
    autzenOverviewStatus,
    autzenZoomStatus,
    autzenWheelZoomStatus,
    autzenTerminalVisualQuality,
    millsiteTerminalVisualQuality,
    browserGpuProfile: ${JSON.stringify(browserGpu.profile)},
    browserGpuConfigPath: ${JSON.stringify(playwrightConfigPath)},
    browserGraphics,
    ignoredConsoleWarnings,
    localFileRendererTiming,
    autzenScreenshotPath: ${JSON.stringify(autzenScreenshotPath)},
    millsiteScreenshotPath: ${JSON.stringify(millsiteScreenshotPath)},
    verificationScreenshotPath: ${JSON.stringify(verificationScreenshotPath)},
  };
}
`;
}

await mkdir(outputRoot, { recursive: true });
assertInside(outputRoot, smokeRoot);
assertInside(outputRoot, localFileSampleRoot);
assertInside(outputRoot, screenshotDir);
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });
await mkdir(screenshotDir, { recursive: true });

if (shouldRunLocalFileSmoke) {
  await ensureLocalFileSmokeSample();
}

console.log("Building example...");
run(npmCommand, ["run", "build:example"], repoRoot);

const port = await findAvailablePort(4173);
const baseUrl = `http://localhost:${port}`;
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
  console.log(`Starting example preview at ${baseUrl}...`);
  await waitForServer(baseUrl, serverProcess, serverOutput);

  await writeFile(smokeFlowPath, createSmokeFlow(baseUrl));

  console.log("Running browser smoke flow...");
  runPlaywrightCli([
    "--config",
    playwrightConfigPath,
    "open",
    "about:blank",
  ]);
  const playwrightOutput = runPlaywrightCli([
    "run-code",
    "--filename",
    smokeFlowPath,
  ]);
  const browserResult = parsePlaywrightResult(playwrightOutput);

  const completedRunEvidence = await createRunEvidence({ repoRoot });
  const sourceStateFailures = validateRunEvidenceSourceState(
    runEvidence,
    completedRunEvidence,
    "exampleSmoke.sourceState",
  );

  if (sourceStateFailures.length > 0) {
    throw new Error(
      `Repository source state changed during the example smoke flow:\n${sourceStateFailures.join("\n")}`,
    );
  }

  const screenshots = await Promise.all([
    createScreenshotEvidence("autzen-stream", autzenScreenshotPath),
    createScreenshotEvidence("millsite-stream", millsiteScreenshotPath),
    createScreenshotEvidence("final-verification", verificationScreenshotPath),
  ]);
  await writeFile(
    smokeResultPath,
    `${JSON.stringify(
      {
        schema: "copc-viewer.example-smoke-evidence",
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        status: "passed",
        mode: shouldRunLocalFileSmoke ? "url-and-local-file" : "url",
        browser: {
          gpuProfile: browserResult.browserGpuProfile,
          gpuConfigPath: path
            .relative(repoRoot, browserResult.browserGpuConfigPath)
            .replaceAll("\\", "/"),
          rendererPattern: browserGpu.rendererPattern ?? null,
          graphics: browserResult.browserGraphics,
        },
        runEvidence,
        screenshots,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `Example smoke test passed: ${autzenScreenshotPath}, ${millsiteScreenshotPath}, ${verificationScreenshotPath}; evidence: ${smokeResultPath}`,
  );
} finally {
  try {
    runPlaywrightCli(["close"]);
  } catch {
    // The browser may already be closed if startup failed.
  }
  stopServer(serverProcess);
}

async function createScreenshotEvidence(id, absolutePath) {
  const bytes = await readFile(absolutePath);

  return {
    id,
    path: path.relative(repoRoot, absolutePath).replaceAll("\\", "/"),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function ensureLocalFileSmokeSample() {
  await mkdir(localFileSampleRoot, { recursive: true });

  const headResponse = await fetch(localFileSampleUrl, {
    method: "HEAD",
    signal: AbortSignal.timeout(30_000),
  });

  if (!headResponse.ok) {
    throw new Error(
      `Failed to inspect local-file smoke COPC sample: ${headResponse.status} ${headResponse.statusText}`,
    );
  }

  const expectedBytes = Number(headResponse.headers.get("content-length"));

  if (Number.isSafeInteger(expectedBytes) && expectedBytes > 0) {
    try {
      const current = await stat(localFileSamplePath);

      if (current.size === expectedBytes) {
        console.log(`Using cached local-file smoke sample: ${localFileSamplePath}`);
        return;
      }
    } catch {
      // Download below when the sample is missing or incomplete.
    }
  }

  console.log(`Downloading local-file smoke sample: ${localFileSampleUrl}`);
  const response = await fetch(localFileSampleUrl, {
    signal: AbortSignal.timeout(180_000),
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download local-file smoke COPC sample: ${response.status} ${response.statusText}`,
    );
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(localFileSamplePath));

  if (Number.isSafeInteger(expectedBytes) && expectedBytes > 0) {
    const downloaded = await stat(localFileSamplePath);

    if (downloaded.size !== expectedBytes) {
      throw new Error(
        `Downloaded local-file smoke sample size mismatch: ${downloaded.size} !== ${expectedBytes}`,
      );
    }
  }
}
