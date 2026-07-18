import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBrowserGpuRendererAssertionSource,
  resolveBrowserGpuProfile,
} from "./browser-gpu-profile.mjs";
import { isExpectedNonFatalWebGlDriverWarning } from "./browser-console-policy.mjs";
import { summarizeRecoveredHttpRangeResponses } from "./http-range-response-policy.mjs";
import { resolveLocalPackageBinary } from "./resolve-local-package-binary.mjs";
import {
  createRunEvidence,
  validateRunEvidence,
  validateRunEvidenceSourceState,
} from "./run-evidence.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const playwrightCliPath = resolveLocalPackageBinary(
  repoRoot,
  "@playwright/cli",
  "playwright-cli",
);
const outputRoot = path.join(repoRoot, "output");
const smokeRoot = path.join(outputRoot, "package-smoke");
const consumerRoot = path.join(smokeRoot, "consumer");
const screenshotRoot = path.join(outputRoot, "playwright");
const browserFlowPath = path.join(smokeRoot, "smoke-package-browser-flow.mjs");
const browserResultPath = path.join(smokeRoot, "browser-result.json");
const browserScreenshotPath = path.join(
  screenshotRoot,
  "smoke-package-consumer.png",
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
// Keep total package growth bounded while allowing the required evidence docs
// and range-request runtime added since the original 600 KiB baseline.
const MAX_PACKAGE_TARBALL_BYTES = 650 * 1024;
const MAX_PACKED_WORKER_ASSET_BYTES = 600 * 1024;

const runEvidence = await createRunEvidence({ repoRoot });
const runEvidenceFailures = validateRunEvidence(
  runEvidence,
  "packageSmoke.runEvidence",
);

if (runEvidenceFailures.length > 0) {
  throw new Error(
    `Package smoke run evidence is invalid:\n${runEvidenceFailures.join("\n")}`,
  );
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

function runCapture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: isWindows,
    stdio: ["ignore", "pipe", "inherit"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }

  return result.stdout;
}

function runNodeBinary(binaryPath, args, cwd) {
  const result = spawnSync(process.execPath, [binaryPath, ...args], {
    cwd,
    shell: false,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${binaryPath} ${args.join(" ")} failed with exit code ${result.status}`,
    );
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
    const error = new Error(
      `playwright-cli ${args.join(" ")} failed with exit code ${result.status}`,
    );
    error.playwrightStdout = result.stdout;
    error.playwrightStderr = result.stderr;
    throw error;
  }

  if (`${result.stdout}\n${result.stderr}`.includes("### Error")) {
    const error = new Error(
      `playwright-cli ${args.join(" ")} reported an error`,
    );
    error.playwrightStdout = result.stdout;
    error.playwrightStderr = result.stderr;
    throw error;
  }

  return result.stdout;
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

  throw new Error(`No available package preview port found from ${startPort}.`);
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
        `Package preview server exited early with code ${serverProcess.exitCode}.\n${serverOutput.join("")}`,
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
      // Retry until the consumer preview server starts listening.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for package preview server: ${url}`);
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

function toFileDependency(filePath) {
  return `file:${filePath.replaceAll("\\", "/")}`;
}

function createPackageBrowserFlow(baseUrl) {
  return `async (page) => {
  const failures = [];
  const consoleProblems = [];
  const ignoredConsoleWarnings = [];
  const pageErrors = [];
  const browserSourceRangeRequests = [];
  const isExpectedNonFatalWebGlDriverWarning = ${isExpectedNonFatalWebGlDriverWarning.toString()};
${createBrowserGpuRendererAssertionSource(browserGpu.rendererPattern)}

  function recordFailure(condition, message) {
    if (!condition) {
      failures.push(message);
    }
  }

  async function readBrowserGraphics() {
    return page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");

      if (!context) {
        throw new Error("WebGL is unavailable in the package smoke test.");
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
    const type = message.type();
    const text = message.text();

    if (isExpectedNonFatalWebGlDriverWarning(type, text)) {
      ignoredConsoleWarnings.push(type + ": " + text);
      return;
    }

    if (type === "error" || type === "warning") {
      consoleProblems.push(type + ": " + text);
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.stack ?? error.message);
  });
  page.on("response", (response) => {
    if (!response.url().includes("/copc-samples/autzen-classified.copc.laz")) {
      return;
    }

    const request = response.request();
    const requestHeaders = request.headers();
    const responseHeaders = response.headers();
    browserSourceRangeRequests.push({
      contentRange: responseHeaders["content-range"] ?? null,
      method: request.method(),
      range: requestHeaders.range ?? null,
      status: response.status(),
      url: response.url(),
    });
  });

  await page.setViewportSize({ width: 1280, height: 720 });
  let runtimeResult;
  let cesiumStaticAssets;
  let packageWorkerResources;
  let zoomInputCount = 0;
  let zoomInputCameraHeightMeters;
  let zoomTargetCameraHeightMeters;

  try {
    await page.goto(${JSON.stringify(baseUrl)}, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(
      () => {
        const result = window.__COPC_PACKAGE_SMOKE_RESULT__;
        return result?.status === "ready" || result?.status === "failed";
      },
      undefined,
      { timeout: 120_000 },
    );
    const overviewRuntimeResult = await page.evaluate(
      () => window.__COPC_PACKAGE_SMOKE_RESULT__,
    );
    runtimeResult = overviewRuntimeResult;
    if (overviewRuntimeResult?.status === "failed") {
      throw new Error(
        "Installed-package overview stream failed: " +
          (overviewRuntimeResult.error ?? JSON.stringify(overviewRuntimeResult)),
      );
    }

    const overviewRequestId =
      overviewRuntimeResult?.overviewStream?.requestId;
    const overviewCameraHeightMeters = Number(
      overviewRuntimeResult?.overviewStream?.cameraHeightMeters,
    );
    const visibleCanvas = page.locator("#cesium-container canvas:visible");
    const visibleCanvasCountBeforeWheel = await visibleCanvas.count();
    const canvasBounds =
      visibleCanvasCountBeforeWheel === 1
        ? await visibleCanvas.boundingBox()
        : undefined;

    if (
      !canvasBounds ||
      !Number.isSafeInteger(overviewRequestId) ||
      !Number.isFinite(overviewCameraHeightMeters) ||
      overviewCameraHeightMeters <= 0
    ) {
      throw new Error(
        "Installed-package overview did not expose one visible Cesium canvas, a stream request id, and a positive dataset-relative camera height.",
      );
    }

    zoomTargetCameraHeightMeters = Math.min(
      650,
      overviewCameraHeightMeters * 0.25,
    );
    zoomInputCameraHeightMeters = overviewCameraHeightMeters;
    await page.mouse.move(
      canvasBounds.x + canvasBounds.width / 2,
      canvasBounds.y + canvasBounds.height / 2,
    );
    const minimumZoomInputCount = 3;
    const maximumZoomInputCount = 32;

    while (
      zoomInputCount < minimumZoomInputCount ||
      zoomInputCameraHeightMeters > zoomTargetCameraHeightMeters
    ) {
      if (zoomInputCount >= maximumZoomInputCount) {
        throw new Error(
          "Real wheel input did not reach the dataset-relative camera-height target after " +
            zoomInputCount +
            " bounded steps (" +
            zoomInputCameraHeightMeters +
            " m > " +
            zoomTargetCameraHeightMeters +
            " m).",
        );
      }

      await page.mouse.wheel(0, -60);
      zoomInputCount += 1;
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          }),
      );
      zoomInputCameraHeightMeters = await page.evaluate(() =>
        window.__COPC_PACKAGE_SMOKE_READ_CAMERA_HEIGHT_METERS__?.(),
      );

      if (!Number.isFinite(zoomInputCameraHeightMeters)) {
        throw new Error(
          "Installed package did not expose a finite dataset-relative camera height after real wheel input.",
        );
      }
    }

    await page.waitForFunction(
      ({ previousRequestId, targetCameraHeightMeters }) => {
        const result = window.__COPC_PACKAGE_SMOKE_RESULT__;

        return (
          result?.status === "failed" ||
          (result?.status === "passed" &&
            (result.wheelZoomStream?.requestId ?? -1) > previousRequestId &&
            (result.wheelZoomStream?.cameraHeightMeters ?? Infinity) <=
              targetCameraHeightMeters)
        );
      },
      {
        previousRequestId: overviewRequestId,
        targetCameraHeightMeters: zoomTargetCameraHeightMeters,
      },
      { timeout: 120_000 },
    );
    runtimeResult = await page.evaluate(
      () => window.__COPC_PACKAGE_SMOKE_RESULT__,
    );
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );
    cesiumStaticAssets = await page.evaluate(async () => {
      const assetPaths = [
        "/cesium/Cesium.js",
        "/cesium/Widgets/widgets.css",
        "/cesium/Assets/approximateTerrainHeights.json",
      ];

      return await Promise.all(
        assetPaths.map(async (assetPath) => {
          const response = await fetch(assetPath);
          return {
            assetPath,
            contentType: response.headers.get("content-type"),
            status: response.status,
            textLength: (await response.text()).length,
            url: response.url,
          };
        }),
      );
    });
    packageWorkerResources = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter(
          (entry) =>
            entry instanceof PerformanceResourceTiming &&
            entry.name.includes("/assets/") &&
            [
              "CopcPointSampleWorker-",
              "CesiumCopcPointGeometryWorker-",
              "CesiumPointGeometryWorker-",
            ].some((marker) => entry.name.includes(marker)) &&
            new URL(entry.name).pathname.endsWith(".js"),
        )
        .map((entry) => {
          const resource = entry;

          return {
            decodedBodySize: resource.decodedBodySize,
            duration: resource.duration,
            encodedBodySize: resource.encodedBodySize,
            initiatorType: resource.initiatorType,
            responseStatus: resource.responseStatus,
            transferSize: resource.transferSize,
            url: resource.name,
          };
        }),
    );
  } catch (error) {
    failures.push(
      "Browser runtime did not complete: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  const canvasCount = await page.locator("#cesium-container canvas").count();
  const visibleCanvasCount = await page
    .locator("#cesium-container canvas:visible")
    .count();

  try {
    await page.screenshot({
      path: ${JSON.stringify(browserScreenshotPath)},
      fullPage: false,
    });
  } catch (error) {
    failures.push(
      "Browser screenshot failed: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  recordFailure(
    runtimeResult?.status === "passed",
    "Installed-package runtime result did not pass: " +
      JSON.stringify(runtimeResult),
  );
  recordFailure(
    Number(runtimeResult?.renderedPointCount) > 0,
    "Installed package did not report a positive rendered point count.",
  );
  recordFailure(
    Number(runtimeResult?.sampledPointCount) > 0,
    "Installed package did not report a positive sampled point count.",
  );
  recordFailure(
    Number(runtimeResult?.integratedWorkerTimingNodeCount) > 0,
    "Integrated package worker timing evidence is missing.",
  );
  recordFailure(
    Number(runtimeResult?.pointSampleWorkerWarmupCount) > 0,
    "Point-sample package worker warmup evidence is missing.",
  );
  recordFailure(
    Number(runtimeResult?.pointSampleWorkerSampledPointCount) > 0,
    "The installed package point-sample worker did not return real points.",
  );
  const overviewStream = runtimeResult?.overviewStream;
  const wheelZoomStream = runtimeResult?.wheelZoomStream;
  for (const [label, streamResult] of [
    ["overview", overviewStream],
    ["wheel zoom", wheelZoomStream],
  ]) {
    recordFailure(
      streamResult?.coverageMode === "complete-depth",
      "Installed-package " + label + " stream did not use complete-depth coverage.",
    );
    recordFailure(
      streamResult?.visualQuality?.isTerminalReady === true &&
        streamResult.visualQuality.frontierDepthSpan === 0 &&
        streamResult.visualQuality.isFrontierAntichain === true &&
        streamResult.visualQuality.isAdditiveClosureComplete === true &&
        streamResult.visualQuality.missingRequiredNodeCount === 0 &&
        streamResult.visualQuality.unexpectedRenderedNodeCount === 0,
      "Installed-package " + label + " stream did not commit a clean additive terminal composition: " +
        JSON.stringify(streamResult?.visualQuality),
    );
    recordFailure(
      Number(streamResult?.renderedPointCount) > 0 &&
        Number(streamResult?.sampledPointCount) > 0,
      "Installed-package " + label + " stream rendered no real COPC points.",
    );
    recordFailure(
      Number(streamResult?.integratedWorkerTimingNodeCount) > 0,
      "Installed-package " + label + " stream exposed no integrated-worker timing evidence.",
    );
  }
  recordFailure(
    overviewStream?.lodLabel === "overview",
    "Installed-package initial camera stream was not an overview LOD: " +
      JSON.stringify(overviewStream),
  );
  recordFailure(
    zoomInputCount >= 3,
    "Installed-package zoom verification did not exercise a real wheel-input sequence.",
  );
  recordFailure(
    Number.isFinite(zoomInputCameraHeightMeters) &&
      Number.isFinite(zoomTargetCameraHeightMeters) &&
      zoomInputCameraHeightMeters <= zoomTargetCameraHeightMeters,
    "The real wheel-input sequence did not reach its dataset-relative camera-height target (" +
      zoomInputCameraHeightMeters +
      " m > " +
      zoomTargetCameraHeightMeters +
      " m).",
  );
  recordFailure(
    Number(wheelZoomStream?.requestId) > Number(overviewStream?.requestId),
    "The real wheel-input sequence did not complete a newer public camera-stream request.",
  );
  recordFailure(
    Number(wheelZoomStream?.cameraHeightMeters) <
      Number(overviewStream?.cameraHeightMeters),
    "The real wheel-input sequence did not lower dataset-relative camera height.",
  );
  recordFailure(
    Number(wheelZoomStream?.cameraHeightMeters) <=
      Number(zoomTargetCameraHeightMeters),
    "The terminal public camera stream did not reach the deterministic dataset-relative camera-height target.",
  );
  recordFailure(
    Number(wheelZoomStream?.selectedDepth) >
      Number(overviewStream?.selectedDepth),
    "The real wheel-input sequence did not refine to a deeper terminal depth.",
  );
  recordFailure(
    Number(wheelZoomStream?.renderedPointCount) >=
      Number(overviewStream?.renderedPointCount) * 1.25,
    "The overview-to-wheel public stream did not increase rendered points by at least 25%.",
  );
  recordFailure(
    Number(wheelZoomStream?.normalizedDensity) >
      Number(overviewStream?.normalizedDensity),
    "The real wheel-input sequence did not increase normalized current-view density.",
  );
  recordFailure(canvasCount > 0, "Cesium did not create a canvas.");
  recordFailure(visibleCanvasCount > 0, "Cesium canvas is not visible.");

  for (const marker of [
    "CopcPointSampleWorker-",
    "CesiumCopcPointGeometryWorker-",
  ]) {
    recordFailure(
      Array.isArray(packageWorkerResources) &&
        packageWorkerResources.some(
          (resource) =>
            resource.url.includes(marker) &&
            resource.responseStatus === 200 &&
            resource.decodedBodySize > 0,
        ),
      "No successful package worker resource was observed for " + marker,
    );
  }

  recordFailure(
    Array.isArray(runtimeResult?.sourceRangeRequests) &&
      runtimeResult.sourceRangeRequests.length > 0 &&
      runtimeResult.sourceRangeRequests.every(
        (request) =>
          request.url.startsWith(${JSON.stringify(baseUrl)}) &&
          request.method === "GET" &&
          typeof request.range === "string" &&
          request.range.startsWith("bytes=") &&
          request.status === 206 &&
          typeof request.contentRange === "string" &&
          request.contentRange.startsWith("bytes "),
      ),
    "Autzen did not complete same-origin HTTP Range requests with 206 and Content-Range.",
  );
  recordFailure(
    Array.isArray(runtimeResult?.directSourceRequests) &&
      runtimeResult.directSourceRequests.length === 0,
    "The consumer bypassed its same-origin COPC proxy: " +
      (runtimeResult?.directSourceRequests ?? []).join(", "),
  );
  recordFailure(
    Array.isArray(cesiumStaticAssets) &&
      cesiumStaticAssets.length === 3 &&
      cesiumStaticAssets.every(
        (asset) =>
          asset.status === 200 &&
          !asset.contentType?.includes("text/html") &&
          asset.textLength > 0,
      ),
    "Documented Cesium static assets were not served by the consumer build.",
  );

  if (consoleProblems.length > 0) {
    failures.push("Browser console problems:\\n" + consoleProblems.join("\\n"));
  }
  if (pageErrors.length > 0) {
    failures.push("Page errors:\\n" + pageErrors.join("\\n"));
  }
  const browserGraphics = await readBrowserGraphics();
  assertExpectedBrowserGpuRenderer(browserGraphics);

  return {
    status: failures.length === 0 ? "passed" : "failed",
    failures,
    browserGpuProfile: ${JSON.stringify(browserGpu.profile)},
    browserGpuConfigPath: ${JSON.stringify(playwrightConfigPath)},
    browserGpuRendererPattern: ${JSON.stringify(browserGpu.rendererPattern ?? null)},
    browserGraphics,
    runtimeResult,
    canvasCount,
    visibleCanvasCount,
    cesiumStaticAssets,
    packageWorkerResources,
    browserSourceRangeRequests,
    consoleProblems,
    ignoredConsoleWarnings,
    pageErrors,
    zoomInputCount,
    zoomInputCameraHeightMeters,
    zoomTargetCameraHeightMeters,
    screenshotPath: ${JSON.stringify(browserScreenshotPath)},
    userAgent: await page.evaluate(() => navigator.userAgent),
  };
}`;
}

await mkdir(outputRoot, { recursive: true });
assertInside(outputRoot, smokeRoot);
assertInside(outputRoot, screenshotRoot);
assertInside(screenshotRoot, browserScreenshotPath);
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(path.join(consumerRoot, "src"), { recursive: true });
await mkdir(screenshotRoot, { recursive: true });
await rm(browserScreenshotPath, { force: true });

console.log("Verifying committed license and SPDX evidence...");
run(npmCommand, ["run", "license:evidence:check"], repoRoot);

console.log("Building library and example...");
run(npmCommand, ["run", "build"], repoRoot);

console.log("Packing local package...");
const packOutput = runCapture(
  npmCommand,
  ["pack", "--json", "--ignore-scripts", "--pack-destination", smokeRoot],
  repoRoot,
);
const [packResult] = JSON.parse(packOutput);
const tarballName = packResult?.filename;

if (!tarballName) {
  throw new Error("npm pack did not return a tarball name.");
}

const packedPaths = new Set(
  packResult.files.map((entry) => entry.path),
);

for (const requiredPath of [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/API.md",
  "docs/ARCHITECTURE.md",
  "docs/COMPETITION.md",
  "docs/DATASETS.md",
  "docs/PERFORMANCE.md",
  "docs/RELEASE.md",
  "docs/sbom.spdx.json",
  "examples/minimal-layer.ts",
]) {
  if (!packedPaths.has(requiredPath)) {
    throw new Error(`Packed package is missing ${requiredPath}.`);
  }
}

for (const repositoryOnlyPath of [
  "docs/DEMO_SCRIPT_KO.md",
  "docs/SUBMISSION_CHECKLIST_KO.md",
]) {
  if (packedPaths.has(repositoryOnlyPath)) {
    throw new Error(
      `Packed package contains repository-only submission material ${repositoryOnlyPath}.`,
    );
  }
}

if (packResult.size > MAX_PACKAGE_TARBALL_BYTES) {
  throw new Error(
    `Packed package is ${packResult.size.toLocaleString()} bytes; expected at most ${MAX_PACKAGE_TARBALL_BYTES.toLocaleString()} bytes.`,
  );
}

const oversizedWorkerAsset = packResult.files.find(
  (entry) =>
    entry.path.includes("/assets/") &&
    entry.path.includes("Worker-") &&
    entry.path.endsWith(".js") &&
    entry.size > MAX_PACKED_WORKER_ASSET_BYTES,
);

if (oversizedWorkerAsset) {
  throw new Error(
    `Packed worker asset ${oversizedWorkerAsset.path} is ${oversizedWorkerAsset.size.toLocaleString()} bytes; expected at most ${MAX_PACKED_WORKER_ASSET_BYTES.toLocaleString()} bytes.`,
  );
}

if ([...packedPaths].some((filePath) => filePath.endsWith(".d.ts.map"))) {
  throw new Error(
    "Packed package contains declaration maps without packaged TypeScript sources.",
  );
}

const tarballPath = path.join(smokeRoot, tarballName);

if (!existsSync(tarballPath)) {
  throw new Error(`Packed tarball was not created: ${tarballPath}`);
}

const tarballBytes = await readFile(tarballPath);
const tarballSha256 = createHash("sha256").update(tarballBytes).digest("hex");

if (tarballBytes.byteLength !== packResult.size) {
  throw new Error(
    `Packed tarball byte length ${tarballBytes.byteLength.toLocaleString()} does not match npm pack metadata ${packResult.size.toLocaleString()}.`,
  );
}

const packagedSourceEvidence = await createRunEvidence({ repoRoot });
const sourceStateFailures = validateRunEvidenceSourceState(
  runEvidence,
  packagedSourceEvidence,
  "packageSmoke.sourceState",
);

if (sourceStateFailures.length > 0) {
  throw new Error(
    `Repository source state changed while creating the package candidate:\n${sourceStateFailures.join("\n")}`,
  );
}

const releaseCandidateArtifact = {
  kind: "npm-tarball",
  packageName: packResult.name,
  packageVersion: packResult.version,
  fileName: tarballName,
  byteCount: tarballBytes.byteLength,
  digest: {
    algorithm: "sha256",
    value: tarballSha256,
  },
};
const tarballChecksumPath = `${tarballPath}.sha256`;
await writeFile(
  tarballChecksumPath,
  `${tarballSha256}  ${path.basename(tarballPath)}\n`,
);

await writeFile(
  path.join(consumerRoot, "package.json"),
  `${JSON.stringify(
    {
      private: true,
      type: "module",
      scripts: {
        build: "vite build",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        cesium: "1.140.0",
        "copc-cesium": toFileDependency(tarballPath),
      },
      devDependencies: {
        typescript: "^5.9.3",
        vite: "^7.2.7",
        "vite-plugin-cesium": "1.2.23",
      },
      allowScripts: {
        "esbuild@0.28.1": true,
      },
    },
    null,
    2,
  )}\n`,
);

await writeFile(
  path.join(consumerRoot, "tsconfig.json"),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        useDefineForClassFields: true,
        module: "ESNext",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        skipLibCheck: false,
        moduleResolution: "Bundler",
        allowSyntheticDefaultImports: true,
        isolatedModules: true,
        moduleDetection: "force",
        noEmit: true,
        strict: true,
      },
      include: ["src"],
    },
    null,
    2,
  )}\n`,
);

await writeFile(
  path.join(consumerRoot, "tsconfig.nodenext.json"),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        skipLibCheck: false,
        moduleResolution: "NodeNext",
        isolatedModules: true,
        moduleDetection: "force",
        noEmit: true,
        strict: true,
      },
      include: ["src/nodenext.ts"],
    },
    null,
    2,
  )}\n`,
);

await writeFile(
  path.join(consumerRoot, "vite.config.ts"),
  `import { defineConfig, type ProxyOptions } from "vite";
import cesium from "vite-plugin-cesium";

export default defineConfig({
  plugins: [cesium()],
  server: {
    proxy: createCopcSampleProxy(),
  },
  preview: {
    proxy: createCopcSampleProxy(),
  },
});

function createCopcSampleProxy(): Record<string, string | ProxyOptions> {
  return {
    "/copc-samples": {
      target: "https://s3.amazonaws.com",
      changeOrigin: true,
      rewrite: (requestPath: string) =>
        requestPath.replace(/^\\/copc-samples/, "/hobu-lidar"),
    },
  };
}
`,
);

await writeFile(
  path.join(consumerRoot, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" href="data:," />
    <title>Installed copc-cesium package smoke</title>
    <style>
      html, body, #cesium-container { width: 100%; height: 100%; margin: 0; }
      body { overflow: hidden; background: #05070a; }
      #smoke-status {
        position: fixed;
        z-index: 10;
        top: 12px;
        left: 12px;
        max-width: calc(100% - 48px);
        padding: 8px 12px;
        border-radius: 6px;
        color: #f5f7fa;
        background: rgba(5, 7, 10, 0.86);
        font: 13px/1.4 system-ui, sans-serif;
      }
    </style>
  </head>
  <body>
    <div id="cesium-container"></div>
    <output id="smoke-status" role="status">Loading installed package...</output>
    <div id="app" hidden></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
);

await writeFile(
  path.join(consumerRoot, "src", "nodenext.ts"),
  `import { CopcPointCloudLayer } from "copc-cesium";
import { CopcSource } from "copc-cesium/core";
import { CesiumPrimitivePointRenderer } from "copc-cesium/cesium";

export const nodeNextEntryPointEvidence = [
  CopcPointCloudLayer,
  CopcSource,
  CesiumPrimitivePointRenderer,
] as const;
`,
);

await writeFile(
  path.join(consumerRoot, "src", "main.ts"),
  `import { Math as CesiumMath, Viewer } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import {
  CopcPointCloudCameraStream,
  CopcPointCloudLayer,
  CopcCameraStreamNodeSampleCache,
  CopcCameraStreamPrefetchController,
  CopcCameraStreamRequestController,
  createCopcCameraStreamEffectiveBudget,
  createCopcWorkerPoolSettings,
  createCopcCameraStreamCoverageNodeKeys,
  createCopcCameraStreamFinalNodeKeys,
  createCopcCameraStreamDetailProgressState,
  createCopcCameraStreamLodSettings,
  createCopcCameraStreamPrefetchPlan,
  createCopcCameraStreamPrefetchNodeKeys,
  createCopcCameraStreamPrefetchSelectionPlan,
  createCopcCameraStreamPreviewNodeKeys,
  createCopcCameraStreamPrefetchSettings,
  createCopcCameraStreamRenderPlan,
  createCopcCameraStreamRenderNodeKeys,
  createCopcCameraStreamVisualQualityState,
  createCopcCameraDestination,
  createDefaultCopcCoordinateTransforms,
  createProj4CoordinateTransforms,
  estimateCopcNodeFamilyOverlapRatio,
  formatCopcCameraStreamBudgetSummary,
  formatCopcCameraStreamDiagnostics,
  formatCopcCameraStreamDetailProgress,
  formatCopcCameraStreamFinalNodeMix,
  formatCopcCameraStreamLodSummary,
  formatCopcHierarchyNodeCameraSelection,
  formatCopcLoadedHierarchyPages,
  hasFreshCopcCameraStreamNodeSamples,
  maxCopcNodeKeyDepth,
  mergeCopcCameraStreamNodeSamples,
  orderCopcCameraStreamNodeKeysForProgressiveCoverage,
  runCopcCameraStreamTerminalRender,
  selectCopcCameraStreamDetailProgressPolicy,
  selectCopcCameraStreamDetailWarmupPolicy,
  selectCopcCameraStreamRequestPriorityOffsets,
  selectHierarchyPagesForTarget,
  shouldCompleteCopcCameraStreamDetailProgress,
  shouldReuseCopcCameraStreamNodeKeys,
  summarizeCopcCameraStreamSourceNodes,
  updateCopcCameraStreamAdaptiveBudget,
  type CopcCameraStreamAdaptiveBudgetState,
  type CopcCameraStreamBudgetLimits,
  type CopcCameraStreamDetailProgressPolicy,
  type CopcCameraStreamDetailWarmupPolicy,
  type CopcCameraStreamDiagnostics,
  type CopcCameraStreamLodQualitySettings,
  type CopcCameraStreamLodSettings,
  type CopcCameraStreamNodeSampleLike,
  type CopcCameraStreamNodeSummaryLike,
  type CopcCameraStreamPrefetchSettings,
  type CopcCameraStreamTimeoutScheduler,
  type CopcCameraStreamTerminalRenderOptions,
  type CopcCameraStreamTerminalRenderResult,
  type CopcCameraStreamTerminalRenderUpdate,
  type CopcCameraStreamVisualQualityState,
  type CopcWorkerPoolSettings,
  type CopcHierarchyNodeCameraSelection,
  type CopcHierarchyNodeDepthEstimate,
  type CopcPointCloudLayerCameraSelectionOptions,
  type CopcCoordinateTransformStatus,
  type CopcHierarchyPageReference,
  type CopcHierarchyPageTargetSelection,
  type CopcInspection,
  type CopcPointCloudLayerOptions,
  type CopcPointCloudLayerHierarchyExpansionOptions,
  type CopcPointCloudLayerRenderStats,
  type CopcPointCloudCameraStreamUpdate,
} from "copc-cesium";
import {
  CopcSource,
  createCopcPointSampleWorker,
  type CopcHierarchyCacheStats,
  type CopcHierarchyNodeSelectionMode,
  type LoadNodePointSamplesOptions,
  type CopcPointSampleLoadingMode,
  type CopcPointSampleCacheStats,
  type CopcTargetVector,
  type CopcSourceInput,
  type CopcSourceOptions,
} from "copc-cesium/core";
import {
  CesiumBufferPointRenderer,
  CesiumPointPrimitiveRenderer,
  CesiumPointRenderer,
  CesiumPrimitivePointRenderer,
  type CesiumBufferPointRendererOptions,
  type CesiumPointPrimitiveRendererOptions,
  type CesiumPrimitivePointRendererOptions,
  type CopcPointCloudRendererFactory,
} from "copc-cesium/cesium";

const exportedConstructors = [
  CopcPointCloudCameraStream,
  CopcPointCloudLayer,
  CopcCameraStreamNodeSampleCache,
  CopcCameraStreamPrefetchController,
  CopcCameraStreamRequestController,
  createCopcWorkerPoolSettings,
  CopcSource,
  CesiumBufferPointRenderer,
  CesiumPointRenderer,
  CesiumPointPrimitiveRenderer,
  CesiumPrimitivePointRenderer,
  createDefaultCopcCoordinateTransforms,
  createProj4CoordinateTransforms,
  createCopcCameraStreamEffectiveBudget,
  createCopcCameraStreamCoverageNodeKeys,
  createCopcCameraStreamDetailProgressState,
  createCopcCameraStreamFinalNodeKeys,
  createCopcCameraStreamLodSettings,
  createCopcCameraStreamPrefetchPlan,
  createCopcCameraStreamPrefetchNodeKeys,
  createCopcCameraStreamPrefetchSelectionPlan,
  createCopcCameraStreamRenderPlan,
  createCopcCameraStreamPreviewNodeKeys,
  createCopcCameraStreamPrefetchSettings,
  createCopcCameraStreamRenderNodeKeys,
  createCopcCameraStreamVisualQualityState,
  estimateCopcNodeFamilyOverlapRatio,
  formatCopcCameraStreamBudgetSummary,
  formatCopcCameraStreamDiagnostics,
  formatCopcCameraStreamDetailProgress,
  formatCopcCameraStreamFinalNodeMix,
  formatCopcCameraStreamLodSummary,
  formatCopcHierarchyNodeCameraSelection,
  formatCopcLoadedHierarchyPages,
  maxCopcNodeKeyDepth,
  orderCopcCameraStreamNodeKeysForProgressiveCoverage,
  runCopcCameraStreamTerminalRender,
  selectCopcCameraStreamDetailProgressPolicy,
  selectCopcCameraStreamDetailWarmupPolicy,
  selectCopcCameraStreamRequestPriorityOffsets,
  shouldCompleteCopcCameraStreamDetailProgress,
  summarizeCopcCameraStreamSourceNodes,
  updateCopcCameraStreamAdaptiveBudget,
  createCopcPointSampleWorker,
  selectHierarchyPagesForTarget,
  shouldReuseCopcCameraStreamNodeKeys,
] as const;
const pointSampleLoadingMode: CopcPointSampleLoadingMode = "worker";
const inspection: CopcInspection | undefined = undefined;
const transformStatus: CopcCoordinateTransformStatus | undefined = undefined;
const hierarchyCacheStats: CopcHierarchyCacheStats = {
  loadedPageCount: 1,
  maxCachedPageCount: 3,
  loadedPageBytes: 512,
  maxCachedPageBytes: 1024,
  pendingPageCount: 0,
  trackedNodeCount: 1,
  trackedPendingPageCount: 0,
  cacheEvictionCount: 0,
  isOverLimit: false,
};
const cacheStats: CopcPointSampleCacheStats | undefined = undefined;
const sourceOptions: CopcSourceOptions = {
  maxCachedHierarchyPages: 3,
  maxCachedHierarchyPageBytes: 1024,
  maxCachedSampleSets: 2,
  maxCachedPointSampleBytes: 1024,
  maxConcurrentPointSampleWorkerRequests: 2,
  pointSampleLoading: pointSampleLoadingMode,
};
const nodeSampleOptions: LoadNodePointSamplesOptions = {
  nodeKey: "0-0-0-0",
  signal: new AbortController().signal,
};
const viewDirection: CopcTargetVector = { x: 1, y: 0, z: 0 };
const selectionMode: CopcHierarchyNodeSelectionMode = "coverage";
const pointRendererFactory: CopcPointCloudRendererFactory = () => ({
  setPoints: () => undefined,
  clear: () => undefined,
  destroy: () => undefined,
});
const primitiveRendererOptions: CesiumPointPrimitiveRendererOptions = {
  pixelSize: 3,
  outlineWidth: 0,
};
const bufferRendererOptions: CesiumBufferPointRendererOptions = {
  pointSize: 3,
  outlineWidth: 0,
};
const primitiveTypedArrayRendererOptions: CesiumPrimitivePointRendererOptions = {
  pointSize: 3,
};
const streamQualitySettings: CopcCameraStreamLodQualitySettings = {
  cameraStreamMaxRenderedPointCount: 360_000,
  cameraStreamMaxSourcePointCount: 900_000,
  cameraStreamMaxNodePointCount: 80_000,
  cameraStreamMaxPointDataLength: 16 * 1024 * 1024,
  cameraStreamMaxNodePointDataLength: 2 * 1024 * 1024,
  cameraStreamMaxNodes: 96,
  cameraStreamMaxDepth: 5,
  cameraStreamTargetNodeScreenPixels: 80,
  cameraStreamTargetPointSpacingScreenPixels: 4,
};
const streamTerminalRenderTypeEvidence: {
  readonly options?: CopcCameraStreamTerminalRenderOptions;
  readonly result?: CopcCameraStreamTerminalRenderResult;
  readonly update?: CopcCameraStreamTerminalRenderUpdate;
} = {};
const streamLodSettings: CopcCameraStreamLodSettings =
  createCopcCameraStreamLodSettings({
    cameraHeightMeters: 300,
    qualitySettings: streamQualitySettings,
  });
const streamBudgetLimits: CopcCameraStreamBudgetLimits = {
  maxRenderedPointCount: streamLodSettings.maxRenderedPointCount,
  maxSourcePointCount: streamLodSettings.maxSourcePointCount,
  maxNodePointCount: streamLodSettings.maxNodePointCount,
  maxPointDataLength: streamLodSettings.maxPointDataLength,
  maxNodePointDataLength: streamLodSettings.maxNodePointDataLength,
};
let streamAdaptiveBudgetState: CopcCameraStreamAdaptiveBudgetState = {};
const streamEffectiveBudget = createCopcCameraStreamEffectiveBudget({
  limits: streamBudgetLimits,
  state: streamAdaptiveBudgetState,
});
const streamAdaptiveBudgetUpdate = updateCopcCameraStreamAdaptiveBudget({
  limits: streamBudgetLimits,
  state: streamAdaptiveBudgetState,
  timings: {
    totalMilliseconds: 1_000,
    renderMilliseconds: 3_000,
  },
});
streamAdaptiveBudgetState = streamAdaptiveBudgetUpdate.state;
const streamPrefetchSettings: CopcCameraStreamPrefetchSettings =
  createCopcCameraStreamPrefetchSettings({
    nodeCount: 24,
    basePointCountPerNode: 2_000,
    baseMaxRenderedPointCount: 96_000,
    minPointCountPerNode: 2_500,
    minRenderedPointCount: 24 * 2_500,
    lodSettings: streamLodSettings,
  });
const streamPrefetchSelectionPlan =
  createCopcCameraStreamPrefetchSelectionPlan({
    lodSettings: streamLodSettings,
    maxNodeCount: 24,
    maxNodePointCount: streamLodSettings.maxNodePointCount,
    maxNodePointDataLength: streamLodSettings.maxNodePointDataLength,
    maxTotalPointCount: streamLodSettings.maxSourcePointCount,
    maxTotalPointDataLength: streamLodSettings.maxPointDataLength,
  });
const streamNodes: readonly CopcCameraStreamNodeSummaryLike[] = [
  { key: "2-0-0-0", pointDataLength: 4_000 },
  { key: "2-1-0-0", pointDataLength: 4_000 },
];
const streamRenderNodeKeys = createCopcCameraStreamRenderNodeKeys(streamNodes, {
  nodes: [{ key: "0-0-0-0", pointDataLength: 1_000 }, ...streamNodes],
});
const streamCoverageNodeKeys = createCopcCameraStreamCoverageNodeKeys(
  streamRenderNodeKeys,
  2,
);
const streamFinalNodeKeys = createCopcCameraStreamFinalNodeKeys(
  streamNodes.map((node) => node.key),
  streamCoverageNodeKeys,
);
const streamPreviewNodeKeys = createCopcCameraStreamPreviewNodeKeys(
  streamCoverageNodeKeys,
  { nodes: streamNodes },
  { maxNodeCount: 2, maxPointDataLength: 8_000 },
);
const streamRenderPlan = createCopcCameraStreamRenderPlan({
  cameraSelection: {
    coverageMode: "complete-depth",
    nodes: streamNodes.map((node) => ({
      ...node,
      depth: 2,
      x: 0,
      y: 0,
      z: 0,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
      pointCount: 10_000,
      pointDensity: 10_000,
      pointDataOffset: 0,
    })),
    selectedDepth: 2,
  },
  configuredMaxPointCountPerNode: 20_000,
  effectiveNodePointDataLengthBudget: 2 * 1024 * 1024,
  effectivePointDataLengthBudget: 16 * 1024 * 1024,
  effectiveSourcePointBudget: 900_000,
  hierarchy: { nodes: streamNodes },
  lodSettings: streamLodSettings,
  previewMaxNodeCount: 2,
  previewMaxPointDataLength: 8_000,
  renderedPointBudget: 20_000,
});
const streamOrderedNodeKeys =
  orderCopcCameraStreamNodeKeysForProgressiveCoverage(streamFinalNodeKeys);
const streamNodeFamilyOverlapRatio = estimateCopcNodeFamilyOverlapRatio(
  streamRenderNodeKeys,
  streamFinalNodeKeys,
);
const canReuseStreamNodeKeys = shouldReuseCopcCameraStreamNodeKeys(
  streamRenderNodeKeys,
  streamFinalNodeKeys,
  0.25,
);
const streamMaxDepth = maxCopcNodeKeyDepth(streamFinalNodeKeys);
const streamScheduler: CopcCameraStreamTimeoutScheduler = {
  setTimeout: (callback) => {
    callback();
    return 1;
  },
  clearTimeout: () => undefined,
};
const streamRequestController = new CopcCameraStreamRequestController({
  maxReusedBackgroundRequests: 2,
  minNodeFamilyOverlapRatio: 0.25,
  scheduler: streamScheduler,
});
const streamRequest = streamRequestController.startRequest();
streamRequestController.setActiveNodeKeys(streamFinalNodeKeys);
const streamPrefetchController = new CopcCameraStreamPrefetchController();
const didStartPrefetch = streamPrefetchController.start(async () => undefined);
streamPrefetchController.cancel();
const streamPrefetchNodeKeys = createCopcCameraStreamPrefetchNodeKeys({
  selectedNodeKeys: streamFinalNodeKeys,
  coverageNodeKeys: streamCoverageNodeKeys,
  hasUsableNodeSample: (nodeKey) => nodeKey === "2-0-0-0",
  maxNodeCount: 2,
});
const streamPrefetchPlan = createCopcCameraStreamPrefetchPlan({
  selectedNodeKeys: streamFinalNodeKeys,
  coverageNodeKeys: streamCoverageNodeKeys,
  maxNodeCount: 2,
  basePointCountPerNode: 2_000,
  baseMaxRenderedPointCount: 96_000,
  minPointCountPerNode: streamRenderPlan.maxPointCountPerNode,
  lodSettings: streamLodSettings,
  hasUsableNodeSample: (nodeKey, maxPointCountPerNode) =>
    nodeKey === "2-0-0-0" && maxPointCountPerNode <= 8_000,
});
interface ConsumerNodeSample extends CopcCameraStreamNodeSampleLike {
  readonly source: "consumer";
}
const streamNodeSampleCache =
  new CopcCameraStreamNodeSampleCache<ConsumerNodeSample>({
    maxSampleSetCount: 4,
  });
const streamNodeSamples: readonly ConsumerNodeSample[] = [
  {
    nodeKey: "2-0-0-0",
    nodePointCount: 10_000,
    sampledPointCount: 2_000,
    source: "consumer",
  },
];
streamNodeSampleCache.remember(streamNodeSamples);
const hasFreshStreamNodeSamples = hasFreshCopcCameraStreamNodeSamples(
  ["2-0-0-0"],
  streamNodeSamples,
  2_000,
);
const mergedStreamNodeSamples = mergeCopcCameraStreamNodeSamples(
  streamNodeSamples,
  [
    {
      nodeKey: "2-0-0-0",
      nodePointCount: 10_000,
      sampledPointCount: 4_000,
      source: "consumer",
    },
  ],
);
const streamRequestPriorityOffsets = selectCopcCameraStreamRequestPriorityOffsets();
const streamDetailProgressPolicy: CopcCameraStreamDetailProgressPolicy =
  selectCopcCameraStreamDetailProgressPolicy({
    finalNodeKeys: streamFinalNodeKeys,
    initialNodeResults: streamNodeSamples,
    rendererKind: "typed",
    fastRendererProgressBatchNodeCount: 1,
    pointPrimitiveProgressBatchNodeCount: 4,
    minInitialPointCount: 2_000,
  });
const streamDetailWarmupPolicy: CopcCameraStreamDetailWarmupPolicy =
  selectCopcCameraStreamDetailWarmupPolicy({
    finalNodeKeys: streamFinalNodeKeys,
    initialNodeResults: streamNodeSamples,
    detailMaxPointCountPerNode: 6_000,
    warmupPointCountPerNode: 2_000,
  });
const didCompleteStreamDetailProgress =
  shouldCompleteCopcCameraStreamDetailProgress({
    finalNodeCount: streamFinalNodeKeys.length,
    renderedFinalNodeCount: streamFinalNodeKeys.length - 1,
    renderedPointBudget: 20_000,
    renderedPointCount: 18_000,
  });
const streamDetailProgress = createCopcCameraStreamDetailProgressState({
  finalNodeKeys: streamFinalNodeKeys,
  renderedNodeKeys: streamFinalNodeKeys.slice(0, -1),
  renderedPointBudget: 20_000,
  renderedPointCount: 18_000,
});
const streamDetailProgressSummary =
  formatCopcCameraStreamDetailProgress(streamDetailProgress);
const streamBudgetSummary = formatCopcCameraStreamBudgetSummary({
  configuredRenderedPointBudget: 20_000,
  effectiveRenderedPointBudget: 20_000,
  effectiveSourcePointBudget: 900_000,
  maxSourcePointBudget: 900_000,
  effectiveNodePointBudget: 80_000,
  maxNodePointBudget: 80_000,
  effectivePointDataLengthBudget: 16 * 1024 * 1024,
  maxPointDataLengthBudget: 16 * 1024 * 1024,
  effectiveNodePointDataLengthBudget: 2 * 1024 * 1024,
  maxNodePointDataLengthBudget: 2 * 1024 * 1024,
  lastRenderedPointBudget: 19_892,
  formatBytes: (byteCount) => \`\${byteCount.toLocaleString()} B\`,
});
const workerPoolSettings: CopcWorkerPoolSettings =
  createCopcWorkerPoolSettings({
    hardwareConcurrency: 8,
  });
const streamDiagnostics: CopcCameraStreamDiagnostics = {
  expandHierarchyMilliseconds: 0,
  applyHierarchyMilliseconds: 0,
  selectNodesMilliseconds: 1,
  renderNodesMilliseconds: 2,
  totalMilliseconds: 3,
  loadedHierarchyPageCount: 1,
  selectedNodeCount: 2,
  selectedDepth: 2,
  selectedSourcePointCount: 3_000,
  selectedPointDataLength: 4_000,
};
const streamDiagnosticsText =
  formatCopcCameraStreamDiagnostics(streamDiagnostics);
const streamLodText = formatCopcCameraStreamLodSummary({
  lodSettings: streamLodSettings,
  effectiveSourcePointBudget: streamLodSettings.maxSourcePointCount,
  effectiveNodePointBudget: streamLodSettings.maxNodePointCount,
  effectivePointDataLengthBudget: streamLodSettings.maxPointDataLength,
  effectiveNodePointDataLengthBudget: streamLodSettings.maxNodePointDataLength,
});
const streamPageText = formatCopcLoadedHierarchyPages(["0"]);
const streamNodeMixText = formatCopcCameraStreamFinalNodeMix(1, 2);
const streamCameraSelectionText = formatCopcHierarchyNodeCameraSelection({
  nodes: [],
  targetDepth: 2,
  selectedDepth: 1,
  selectionMode: "coverage",
  coverageMode: "progressive",
  estimatedRootScreenPixels: 100,
  estimatedSelectedDepthScreenPixels: 50,
  targetNodeScreenPixels: 80,
  estimatedSelectedDepthPointSpacingScreenPixels: undefined,
  targetPointSpacingScreenPixels: undefined,
  maxViewAngleDegrees: undefined,
  spacing: undefined,
  depthEstimates: [],
  skippedByFrustumCount: 0,
  skippedByViewCount: 0,
  skippedByBudgetCount: 0,
  reason: "consumer",
});
const streamSourceSummary = summarizeCopcCameraStreamSourceNodes([]);
const createSource = (): CopcSource =>
  new CopcSource("https://example.com/sample.copc.laz", sourceOptions);
const blobSourceInput: CopcSourceInput = new Blob([
  new Uint8Array([1, 2, 3, 4]),
]);
const createBlobSource = (): CopcSource =>
  new CopcSource(blobSourceInput, sourceOptions);
const layerOptionsWithBlobSource: CopcPointCloudLayerOptions = {
  source: blobSourceInput,
  createPointRenderer: pointRendererFactory,
};
const depthEstimate: CopcHierarchyNodeDepthEstimate | undefined = undefined;
const hierarchyPage: CopcHierarchyPageReference | undefined = undefined;
const pageSelection: CopcHierarchyPageTargetSelection | undefined = undefined;
const hierarchyExpansionOptions:
  | CopcPointCloudLayerHierarchyExpansionOptions
  | undefined = undefined;
const cameraSelectionOptions:
  | CopcPointCloudLayerCameraSelectionOptions
  | undefined = {
    camera: {} as CopcPointCloudLayerCameraSelectionOptions["camera"],
    maxViewAngleDegrees: 80,
  };
const cameraSelectionStats:
  | Pick<
      CopcHierarchyNodeCameraSelection,
      "selectionMode" | "skippedByFrustumCount" | "skippedByViewCount"
    >
  | undefined = undefined;
const renderStats: CopcPointCloudLayerRenderStats = {
  pointCount: 1,
  estimatedRenderPayloadBytes: 28,
  coordinateTransformMilliseconds: 0,
  rendererSetPointsMilliseconds: 0,
  boundsRenderMilliseconds: 0,
  totalRenderMilliseconds: 0,
};
const app = document.querySelector<HTMLDivElement>("#app");

if (app) {
  app.textContent = [
    exportedConstructors.map((constructor) => constructor.name).join(", "),
    String(Boolean(createSource)),
    String(Boolean(createBlobSource)),
    String(Boolean(layerOptionsWithBlobSource.source)),
    pointSampleLoadingMode,
    String(sourceOptions.maxCachedHierarchyPages),
    String(sourceOptions.maxCachedHierarchyPageBytes),
    String(sourceOptions.maxCachedSampleSets),
    String(sourceOptions.maxCachedPointSampleBytes),
    String(sourceOptions.maxConcurrentPointSampleWorkerRequests),
    String(Boolean(nodeSampleOptions.signal)),
    String(Boolean(viewDirection)),
    selectionMode,
    String(Boolean(pointRendererFactory)),
    String(Boolean(depthEstimate)),
    String(Boolean(inspection)),
    String(Boolean(transformStatus)),
    String(hierarchyCacheStats.cacheEvictionCount),
    String(hierarchyCacheStats.loadedPageBytes),
    String(Boolean(cacheStats)),
    String(Boolean(hierarchyPage)),
    String(Boolean(pageSelection)),
    String(Boolean(hierarchyExpansionOptions)),
    String(Boolean(cameraSelectionOptions)),
    String(Boolean(cameraSelectionStats)),
    String(renderStats.estimatedRenderPayloadBytes),
    String(primitiveRendererOptions.pixelSize),
    String(bufferRendererOptions.pointSize),
    String(primitiveTypedArrayRendererOptions.pointSize),
    streamLodSettings.label,
    String(streamEffectiveBudget.renderedPointCount),
    streamAdaptiveBudgetUpdate.action,
    String(streamAdaptiveBudgetState.renderedPointBudget),
    String(streamPrefetchSettings.maxPointCountPerNode),
    String(streamPrefetchSettings.maxRenderedPointCount),
    String(streamPrefetchSelectionPlan.maxDepth),
    String(streamPrefetchSelectionPlan.targetPointSpacingScreenPixels),
    streamRenderNodeKeys.join(","),
    streamCoverageNodeKeys.join(","),
    streamFinalNodeKeys.join(","),
    streamPreviewNodeKeys.join(","),
    streamRenderPlan.renderSignature,
    streamOrderedNodeKeys.join(","),
    String(streamNodeFamilyOverlapRatio),
    String(canReuseStreamNodeKeys),
    String(streamMaxDepth),
    String(streamRequest.requestId),
    String(didStartPrefetch),
    streamPrefetchNodeKeys.join(","),
    String(streamPrefetchPlan.shouldPrefetch),
    String(streamPrefetchPlan.maxPointCountPerNode),
    String(streamNodeSampleCache.size),
    String(hasFreshStreamNodeSamples),
    String(mergedStreamNodeSamples[0]?.sampledPointCount),
    String(streamRequestPriorityOffsets.preview),
    String(Boolean(streamTerminalRenderTypeEvidence.options)),
    String(streamDetailProgressPolicy.progressBatchNodeCount),
    String(streamDetailWarmupPolicy.maxRenderedPointCount),
    String(didCompleteStreamDetailProgress),
    streamDetailProgressSummary,
    streamBudgetSummary,
    String(workerPoolSettings.pointGeometryWorkerConcurrency),
    streamDiagnosticsText,
    streamLodText,
    streamPageText,
    streamNodeMixText,
    streamCameraSelectionText,
    String(streamSourceSummary.selectedSourcePointCount),
  ].join(" | ");
}

interface SourceRangeRequestEvidence {
  readonly contentRange: string | null;
  readonly method: string;
  readonly range: string | null;
  readonly status: number;
  readonly url: string;
}

interface InstalledPackageCameraStreamEvidence {
  readonly requestId: number;
  readonly stage: CopcPointCloudCameraStreamUpdate["stage"];
  readonly cameraHeightMeters: number;
  readonly lodLabel: string;
  readonly maxRenderedPointCount: number;
  readonly selectedDepth: number;
  readonly coverageMode: string;
  readonly frontierNodeKeys: readonly string[];
  readonly requiredNodeKeys: readonly string[];
  readonly renderedNodeKeys: readonly string[];
  readonly renderedPointCount: number;
  readonly sampledPointCount: number;
  readonly normalizedDensity: number;
  readonly integratedWorkerTimingNodeCount: number;
  readonly pointGeometryWorkerCacheHitCount: number;
  readonly visualQuality: CopcCameraStreamVisualQualityState;
}

interface InstalledPackageRuntimeResult {
  readonly status: "running" | "ready" | "passed" | "failed";
  readonly sourceUrl: string;
  readonly elapsedMilliseconds?: number;
  readonly error?: string;
  readonly hierarchyNodeCount?: number;
  readonly integratedWorkerTimingNodeCount?: number;
  readonly pointGeometryWorkerCacheHitCount?: number;
  readonly pointSampleWorkerWarmupCount?: number;
  readonly pointSampleWorkerSampledPointCount?: number;
  readonly renderedNodeKey?: string;
  readonly renderedPointCount?: number;
  readonly sampledPointCount?: number;
  readonly canvasWidth?: number;
  readonly canvasHeight?: number;
  readonly coordinateTransformKind?: string;
  readonly overviewStream?: InstalledPackageCameraStreamEvidence;
  readonly wheelZoomStream?: InstalledPackageCameraStreamEvidence;
  readonly sourceRangeRequests?: readonly SourceRangeRequestEvidence[];
  readonly directSourceRequests?: readonly string[];
}

type InstalledPackageSmokeWindow = Window & {
  __COPC_PACKAGE_SMOKE_RESULT__?: InstalledPackageRuntimeResult;
  __COPC_PACKAGE_SMOKE_READ_CAMERA_HEIGHT_METERS__?: () => number | undefined;
};

const runtimeSourceUrl = "/copc-samples/autzen-classified.copc.laz";
const runtimeWindow = window as InstalledPackageSmokeWindow;
const runtimeStatus = document.querySelector<HTMLOutputElement>("#smoke-status");
const runtimeSourceRangeRequests: SourceRangeRequestEvidence[] = [];
const runtimeDirectSourceRequests: string[] = [];
const nativeFetch = window.fetch.bind(window);
let runtimeLayer: CopcPointCloudLayer | undefined;
let runtimeCameraStream: CopcPointCloudCameraStream | undefined;
let runtimeViewer: Viewer | undefined;

window.fetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const request = new Request(input, init);
  const url = request.url;
  const isAutzenRequest = url.includes(
    "/copc-samples/autzen-classified.copc.laz",
  );

  if (
    url.includes("s3.amazonaws.com/hobu-lidar/") ||
    url.includes("hobu-lidar.s3.amazonaws.com/")
  ) {
    runtimeDirectSourceRequests.push(url);
  }

  const response = await nativeFetch(request);

  if (isAutzenRequest) {
    runtimeSourceRangeRequests.push({
      contentRange: response.headers.get("content-range"),
      method: request.method,
      range: request.headers.get("range"),
      status: response.status,
      url,
    });
  }

  return response;
};

runtimeWindow.__COPC_PACKAGE_SMOKE_RESULT__ = {
  status: "running",
  sourceUrl: runtimeSourceUrl,
};

void runInstalledPackageRuntimeSmoke();

window.addEventListener("pagehide", () => {
  destroyInstalledPackageRuntime();
});

async function runInstalledPackageRuntimeSmoke(): Promise<void> {
  const startedAt = performance.now();

  try {
    runtimeStatus?.replaceChildren("Loading Autzen through the installed package...");
    const viewer = new Viewer("cesium-container", {
      animation: false,
      baseLayer: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      scene3DOnly: true,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
    });
    runtimeViewer = viewer;
    viewer.scene.globe.show = false;
    viewer.camera.percentageChanged = 0.01;

    const layer = new CopcPointCloudLayer(viewer.scene, {
      url: runtimeSourceUrl,
      maxPointCountPerNode: 5_000,
      maxConcurrentPointSampleWorkerRequests: 1,
      maxConcurrentPointGeometryWorkerRequests: 1,
      pointSampleLoading: "worker",
      pointGeometryLoading: "integrated-worker",
      showBounds: false,
    });
    runtimeLayer = layer;

    const loadResult = await layer.load();
    const coordinateTransforms = createDefaultCopcCoordinateTransforms(
      loadResult.inspection,
    );
    runtimeWindow.__COPC_PACKAGE_SMOKE_READ_CAMERA_HEIGHT_METERS__ = () =>
      layer.getCameraHeightAbovePointCloudMeters(
        viewer.camera.positionCartographic.height,
      );
    viewer.camera.setView({
      destination: createCopcCameraDestination(
        loadResult.inspection,
        coordinateTransforms.toCesium,
      ),
      orientation: {
        heading: 0,
        pitch: -CesiumMath.PI_OVER_TWO,
        roll: 0,
      },
    });

    const pointSampleWorkerWarmupCount = layer.warmUpPointSampleWorkers({
      workerCount: 1,
    });
    layer.warmUpPointGeometryWorkers({ workerCount: 1 });
    await layer.waitForPointGeometryWorkerWarmup();

    if (pointSampleWorkerWarmupCount < 1) {
      throw new Error("The installed package did not create its point-sample worker.");
    }

    const renderNode = loadResult.hierarchy.nodes.find(
      (node) => node.pointCount > 0 && node.pointDataLength > 0,
    );

    if (!renderNode) {
      throw new Error("Autzen did not expose a renderable COPC hierarchy node.");
    }

    const pointSampleSource = new CopcSource(runtimeSourceUrl, {
      maxConcurrentPointSampleWorkerRequests: 1,
      pointSampleLoading: "worker",
    });
    let pointSampleWorkerSampledPointCount = 0;

    try {
      const pointSampleWorkerResult =
        await pointSampleSource.loadNodePointSamples({
          nodeKey: renderNode.key,
          maxPointCount: 32,
          sampleFormat: "typed",
        });
      pointSampleWorkerSampledPointCount =
        pointSampleWorkerResult.sampledPointCount;
    } finally {
      pointSampleSource.destroy();
    }

    if (pointSampleWorkerSampledPointCount <= 0) {
      throw new Error(
        "The installed package point-sample worker returned no Autzen points.",
      );
    }

    const renderResult = await layer.renderNodes([renderNode.key], {
      includePointsInResult: false,
      maxPointCountPerNode: 5_000,
      maxRenderedPointCount: 5_000,
      showBounds: false,
    });
    const geometryTimings = renderResult.renderStats.pointGeometryTimings;
    const renderedPointCount = renderResult.renderStats.pointCount;
    const sampledPointCount = renderResult.pointSamples.sampledPointCount;

    if (renderedPointCount <= 0 || sampledPointCount <= 0) {
      throw new Error("The installed package rendered no Autzen COPC points.");
    }

    if (!geometryTimings || geometryTimings.nodeCount <= 0) {
      throw new Error(
        "The installed package did not report integrated worker geometry timing.",
      );
    }

    viewer.scene.requestRender();
    await waitForAnimationFrames(2);

    if (viewer.canvas.width <= 0 || viewer.canvas.height <= 0) {
      throw new Error("The installed-package Cesium canvas has no drawable size.");
    }

    const baseRuntimeEvidence = {
      sourceUrl: runtimeSourceUrl,
      hierarchyNodeCount: loadResult.hierarchy.nodes.length,
      integratedWorkerTimingNodeCount: geometryTimings.nodeCount,
      pointGeometryWorkerCacheHitCount: geometryTimings.cacheHitCount,
      pointSampleWorkerWarmupCount,
      pointSampleWorkerSampledPointCount,
      renderedNodeKey: renderNode.key,
      renderedPointCount,
      sampledPointCount,
      canvasWidth: viewer.canvas.width,
      canvasHeight: viewer.canvas.height,
      coordinateTransformKind: loadResult.coordinateTransform.kind,
    };
    const publishRuntimeResult = (
      status: InstalledPackageRuntimeResult["status"],
      additionalEvidence: Partial<InstalledPackageRuntimeResult> = {},
    ): void => {
      runtimeWindow.__COPC_PACKAGE_SMOKE_RESULT__ = {
        ...baseRuntimeEvidence,
        ...additionalEvidence,
        status,
        elapsedMilliseconds: performance.now() - startedAt,
        sourceRangeRequests: [...runtimeSourceRangeRequests],
        directSourceRequests: [...runtimeDirectSourceRequests],
      };
    };
    let latestCompleteStream:
      | InstalledPackageCameraStreamEvidence
      | undefined;
    let overviewStream: InstalledPackageCameraStreamEvidence | undefined;

    viewer.camera.setView({
      destination: createCopcCameraDestination(
        loadResult.inspection,
        coordinateTransforms.toCesium,
        {
          minHeightAboveCloudMeters: 3_600,
          extentHeightMultiplier: 0,
          verticalHeightMultiplier: 0,
        },
      ),
      orientation: {
        heading: 0,
        pitch: -CesiumMath.PI_OVER_TWO,
        roll: 0,
      },
    });
    viewer.scene.requestRender();
    await waitForAnimationFrames(2);

    const cameraStream = new CopcPointCloudCameraStream({
      camera: viewer.camera,
      layer,
      quality: "balanced",
      debounceMilliseconds: 30,
      renderOnStart: false,
      onUpdate: (update) => {
        if (update.phase !== "complete") {
          return;
        }

        try {
          const streamEvidence = createInstalledPackageCameraStreamEvidence(
            layer,
            update,
          );
          assertInstalledPackageTerminalStream(
            streamEvidence,
            update.phase,
            update.stage,
          );
          latestCompleteStream = streamEvidence;

          if (
            overviewStream &&
            streamEvidence.requestId > overviewStream.requestId &&
            streamEvidence.cameraHeightMeters < overviewStream.cameraHeightMeters
          ) {
            const isMeaningfulZoomRefinement =
              streamEvidence.selectedDepth > overviewStream.selectedDepth &&
              streamEvidence.renderedPointCount >=
                overviewStream.renderedPointCount * 1.25 &&
              streamEvidence.normalizedDensity > overviewStream.normalizedDensity;

            publishRuntimeResult(
              isMeaningfulZoomRefinement ? "passed" : "ready",
              {
                overviewStream,
                wheelZoomStream: streamEvidence,
              },
            );
            runtimeStatus?.replaceChildren(
              isMeaningfulZoomRefinement
                ? "Installed public camera stream completed the real wheel-input sequence from " +
                    overviewStream.renderedPointCount.toLocaleString() +
                    " to " +
                    streamEvidence.renderedPointCount.toLocaleString() +
                    " points with clean additive terminal composition."
                : "Installed public camera stream completed an intermediate wheel-input terminal at depth " +
                    streamEvidence.selectedDepth.toLocaleString() +
                    "; continuing toward the deterministic zoom target.",
            );
          }
        } catch (error) {
          const message =
            error instanceof Error
              ? error.name + ": " + error.message
              : String(error);
          publishRuntimeResult("failed", {
            error: message,
            overviewStream,
          });
          runtimeStatus?.replaceChildren(
            "Installed public camera stream failed: " + message,
          );
          runtimeCameraStream?.stop();
        }
      },
      onError: (error) => {
        const message =
          error instanceof Error
            ? error.name + ": " + error.message
            : String(error);
        publishRuntimeResult("failed", {
          error: message,
          overviewStream,
        });
        runtimeStatus?.replaceChildren(
          "Installed public camera stream failed: " + message,
        );
      },
    });
    runtimeCameraStream = cameraStream;
    const overviewRenderResult = await cameraStream.render();

    if (!overviewRenderResult || !latestCompleteStream) {
      throw new Error(
        "Installed public camera stream did not complete its overview render.",
      );
    }
    overviewStream = latestCompleteStream;
    if (overviewStream.lodLabel !== "overview") {
      throw new Error(
        "Installed public camera stream initial LOD was " +
          overviewStream.lodLabel +
          '; expected "overview".',
      );
    }

    cameraStream.start();
    publishRuntimeResult("ready", { overviewStream });
    runtimeStatus?.replaceChildren(
      "Installed public camera stream rendered an overview terminal frame; waiting for the real wheel-input sequence.",
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name + ": " + error.message
        : String(error);
    runtimeWindow.__COPC_PACKAGE_SMOKE_RESULT__ = {
      status: "failed",
      sourceUrl: runtimeSourceUrl,
      elapsedMilliseconds: performance.now() - startedAt,
      error: message,
      sourceRangeRequests: [...runtimeSourceRangeRequests],
      directSourceRequests: [...runtimeDirectSourceRequests],
    };
    runtimeStatus?.replaceChildren("Installed package smoke failed: " + message);
    destroyInstalledPackageRuntime();
  }
}

function createInstalledPackageCameraStreamEvidence(
  layer: CopcPointCloudLayer,
  update: CopcPointCloudCameraStreamUpdate,
): InstalledPackageCameraStreamEvidence {
  const hierarchy = update.result.hierarchyExpansion?.hierarchy ?? layer.hierarchy;

  if (!hierarchy) {
    throw new Error(
      "Installed public camera stream did not expose its hierarchy for terminal verification.",
    );
  }

  const frontierNodeKeys = update.result.cameraSelection.nodes
    .filter((node) => node.pointCount > 0 && node.pointDataLength > 0)
    .map((node) => node.key);
  const requiredNodeKeys = createCopcCameraStreamRenderNodeKeys(
    update.result.cameraSelection.nodes,
    hierarchy,
  );
  const renderedNodeKeys = update.result.pointSamples.nodeKeys;
  const recomputedVisualQuality = createCopcCameraStreamVisualQualityState({
    frontierNodeKeys,
    requiredNodeKeys,
    renderedNodeKeys,
  });
  const visualQuality = update.visualQuality;

  if (!visualQuality) {
    throw new Error(
      "Installed public camera stream complete update omitted visualQuality.",
    );
  }
  if (
    JSON.stringify(visualQuality) !== JSON.stringify(recomputedVisualQuality)
  ) {
    throw new Error(
      "Installed public camera stream visualQuality disagreed with the public structural helpers.",
    );
  }
  const renderedPointCount = update.result.renderStats.pointCount;
  const sampledPointCount = update.result.pointSamples.sampledPointCount;
  const integratedWorkerTimings =
    update.result.renderStats.pointGeometryTimings;
  const normalizedDensity =
    visualQuality.frontierNodeCount > 0
      ? (renderedPointCount / visualQuality.frontierNodeCount) *
        4 ** update.result.cameraSelection.selectedDepth
      : 0;

  return {
    requestId: update.requestId,
    stage: update.stage,
    cameraHeightMeters: update.lodSettings.cameraHeightMeters,
    lodLabel: update.lodSettings.label,
    maxRenderedPointCount: update.lodSettings.maxRenderedPointCount,
    selectedDepth: update.result.cameraSelection.selectedDepth,
    coverageMode:
      update.result.cameraSelection.coverageMode ?? "progressive",
    frontierNodeKeys,
    requiredNodeKeys,
    renderedNodeKeys,
    renderedPointCount,
    sampledPointCount,
    normalizedDensity,
    integratedWorkerTimingNodeCount: integratedWorkerTimings?.nodeCount ?? 0,
    pointGeometryWorkerCacheHitCount:
      integratedWorkerTimings?.cacheHitCount ?? 0,
    visualQuality,
  };
}

function assertInstalledPackageTerminalStream(
  evidence: InstalledPackageCameraStreamEvidence,
  phase: string,
  stage: CopcPointCloudCameraStreamUpdate["stage"],
): void {
  if (stage !== "terminal" || evidence.stage !== "terminal") {
    throw new Error(
      "Installed public camera stream settled without the shared terminal-engine stage: " +
        stage,
    );
  }
  if (evidence.coverageMode !== "complete-depth") {
    throw new Error(
      "Installed public camera stream " +
        phase +
        " result did not use complete-depth coverage.",
    );
  }
  if (
    !evidence.visualQuality.isTerminalReady ||
    evidence.visualQuality.frontierDepthSpan !== 0 ||
    !evidence.visualQuality.isFrontierAntichain ||
    !evidence.visualQuality.isAdditiveClosureComplete ||
    evidence.visualQuality.missingRequiredNodeCount !== 0 ||
    evidence.visualQuality.unexpectedRenderedNodeCount !== 0
  ) {
    throw new Error(
      "Installed public camera stream " +
        phase +
        " result did not reach clean additive terminal quality: " +
        JSON.stringify(evidence.visualQuality),
    );
  }
  if (evidence.renderedPointCount <= 0 || evidence.sampledPointCount <= 0) {
    throw new Error(
      "Installed public camera stream " + phase + " result rendered no points.",
    );
  }
  if (evidence.integratedWorkerTimingNodeCount <= 0) {
    throw new Error(
      "Installed public camera stream " +
        phase +
        " result exposed no integrated-worker timing evidence.",
    );
  }
}

async function waitForAnimationFrames(frameCount: number): Promise<void> {
  for (let frame = 0; frame < frameCount; frame += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
}

function destroyInstalledPackageRuntime(): void {
  delete runtimeWindow.__COPC_PACKAGE_SMOKE_READ_CAMERA_HEIGHT_METERS__;

  runtimeCameraStream?.destroy();
  runtimeCameraStream = undefined;

  runtimeLayer?.destroy();
  runtimeLayer = undefined;

  if (runtimeViewer && !runtimeViewer.isDestroyed()) {
    runtimeViewer.destroy();
  }

  runtimeViewer = undefined;
}
`,
);

console.log("Installing packed package into temporary consumer...");
run(npmCommand, ["install"], consumerRoot);

const consumerDependencyTree = JSON.parse(
  runCapture(npmCommand, ["ls", "cesium", "--depth=0", "--json"], consumerRoot),
);
const installedMinimumCesiumVersion =
  consumerDependencyTree.dependencies?.cesium?.version;
if (installedMinimumCesiumVersion !== "1.140.0") {
  throw new Error(
    `Minimum Cesium consumer resolved ${installedMinimumCesiumVersion ?? "<missing>"}; expected 1.140.0.`,
  );
}

console.log("Type-checking temporary consumer...");
const consumerTscPath = resolveLocalPackageBinary(
  consumerRoot,
  "typescript",
  "tsc",
);
const consumerVitePath = resolveLocalPackageBinary(
  consumerRoot,
  "vite",
  "vite",
);
runNodeBinary(consumerTscPath, ["--noEmit"], consumerRoot);

console.log("Type-checking temporary consumer with NodeNext resolution...");
runNodeBinary(
  consumerTscPath,
  ["--project", "tsconfig.nodenext.json"],
  consumerRoot,
);

console.log("Building temporary consumer...");
runNodeBinary(consumerVitePath, ["build"], consumerRoot);

console.log("Running installed-package browser smoke...");
const previewPort = await findAvailablePort(4473);
const previewBaseUrl = `http://localhost:${previewPort}`;
const serverOutput = [];
const serverProcess = spawn(
  process.execPath,
  [
    consumerVitePath,
    "preview",
    "--config",
    "vite.config.ts",
    "--host",
    "localhost",
    "--port",
    String(previewPort),
    "--strictPort",
  ],
  {
    cwd: consumerRoot,
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
  await waitForServer(previewBaseUrl, serverProcess, serverOutput);
  await writeFile(browserFlowPath, createPackageBrowserFlow(previewBaseUrl));
  runPlaywrightCli([
    "--config",
    playwrightConfigPath,
    "open",
    "about:blank",
  ]);
  const playwrightOutput = runPlaywrightCli([
    "run-code",
    "--filename",
    browserFlowPath,
  ]);
  let browserResult = parsePlaywrightResult(playwrightOutput);
  const browserRangeResponseSummary = summarizeRecoveredHttpRangeResponses(
    browserResult.browserSourceRangeRequests ?? [],
    previewBaseUrl,
  );
  browserResult = {
    ...browserResult,
    browserRangeResponseSummary,
  };
  if (!browserRangeResponseSummary.passed) {
    browserResult = {
      ...browserResult,
      status: "failed",
      failures: [
        ...(browserResult.failures ?? []),
        "The browser did not observe valid same-origin Autzen 206 Range responses, or a transient HTTP failure was not recovered by a later identical range request.",
      ],
    };
  }
  const screenshotBytes = existsSync(browserScreenshotPath)
    ? await readFile(browserScreenshotPath)
    : undefined;
  const screenshotByteCount = screenshotBytes?.byteLength ?? 0;
  const screenshotSha256 = screenshotBytes
    ? createHash("sha256").update(screenshotBytes).digest("hex")
    : undefined;

  if (screenshotByteCount <= 0) {
    browserResult = {
      ...browserResult,
      status: "failed",
      failures: [
        ...(browserResult.failures ?? []),
        "Installed-package browser screenshot is missing or empty.",
      ],
    };
  }

  const installedVitePluginTree = JSON.parse(
    runCapture(
      npmCommand,
      ["ls", "vite-plugin-cesium", "--depth=0", "--json"],
      consumerRoot,
    ),
  );
  const packedWorkerAssets = packResult.files
    .filter(
      (entry) =>
        entry.path.includes("/assets/") &&
        entry.path.includes("Worker-") &&
        entry.path.endsWith(".js"),
    )
    .map((entry) => ({ path: entry.path, size: entry.size }));
  const evidence = {
    schemaVersion: 1,
    status: browserResult.status,
    generatedAtUtc: new Date().toISOString(),
    runEvidence,
    releaseCandidateArtifact,
    package: {
      name: packResult.name,
      version: packResult.version,
      tarball: tarballName,
      tarballByteCount: packResult.size,
      tarballSha256,
      packedWorkerAssets,
    },
    consumer: {
      cesiumVersion: installedMinimumCesiumVersion,
      vitePluginCesiumVersion:
        installedVitePluginTree.dependencies?.["vite-plugin-cesium"]?.version,
    },
    artifacts: {
      browserResultPath,
      screenshotPath: browserScreenshotPath,
      screenshotRelativePath: path
        .relative(repoRoot, browserScreenshotPath)
        .replaceAll("\\", "/"),
      screenshotByteCount,
      screenshotSha256,
    },
    browser: browserResult,
  };
  await writeFile(browserResultPath, `${JSON.stringify(evidence, null, 2)}\n`);

  if (browserResult.status !== "passed") {
    throw new Error(
      `Installed-package browser smoke failed:\n${(browserResult.failures ?? []).join("\n")}`,
    );
  }
} catch (error) {
  if (!existsSync(browserResultPath)) {
    await writeFile(
      browserResultPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: "failed",
          generatedAtUtc: new Date().toISOString(),
          runEvidence,
          releaseCandidateArtifact,
          package: {
            name: packResult.name,
            version: packResult.version,
            tarball: tarballName,
            tarballByteCount: packResult.size,
            tarballSha256,
          },
          error: error instanceof Error ? error.message : String(error),
          playwrightStdout: error?.playwrightStdout,
          playwrightStderr: error?.playwrightStderr,
          previewServerOutput: serverOutput,
          artifacts: {
            browserResultPath,
            screenshotPath: browserScreenshotPath,
            screenshotExists: existsSync(browserScreenshotPath),
          },
        },
        null,
        2,
      )}\n`,
    );
  }

  throw error;
} finally {
  try {
    runPlaywrightCli(["close"]);
  } catch {
    // The browser may already be closed if startup or the flow failed.
  }
  stopServer(serverProcess);
}

console.log(
  `Package smoke test passed: ${tarballPath} (SHA-256 ${tarballSha256}, checksum ${tarballChecksumPath}, browser evidence ${browserResultPath}, screenshot ${browserScreenshotPath})`,
);
