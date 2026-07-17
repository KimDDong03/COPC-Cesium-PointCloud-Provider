import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { isExpectedNonFatalWebGlDriverWarning } from "./browser-console-policy.mjs";
import {
  analyzePointCloudImagePair,
  comparePointCloudMaskSupport,
  createMaskRgba,
  createPointDifferenceMask,
} from "./point-cloud-image-metrics.mjs";
import { resolveLocalPackageBinary } from "./resolve-local-package-binary.mjs";
import { createRunEvidence } from "./run-evidence.mjs";
import { compareCameraPoseFingerprints } from "./quality-ab-equivalence.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outputRoot = path.join(repoRoot, "output");
const benchmarkRoot = path.join(outputRoot, "quality-ab");
const flowPath = path.join(benchmarkRoot, "quality-ab-flow.mjs");
const resultPath = path.join(benchmarkRoot, "quality-ab-result.json");
const playwrightCliPath = resolveLocalPackageBinary(
  repoRoot,
  "@playwright/cli",
  "playwright-cli",
);
const viteCliPath = resolveLocalPackageBinary(repoRoot, "vite", "vite");
const playwrightConfigPath = path.join(
  scriptDir,
  "playwright.quality-ab.json",
);
const variants = ["legacy", "enhanced"];
const viewport = { width: 1600, height: 900 };
const quality = readStringArgument("--quality", "detail");
const pointBudget = readPositiveIntegerArgument("--point-budget", 720_000);
const maxPointCountPerNode = readPositiveIntegerArgument(
  "--max-points-per-node",
  pointBudget,
);
const cameraHeightMeters = readPositiveNumberArgument(
  "--camera-height",
  946,
);
const repeats = readPositiveIntegerArgument("--repeats", 2);
const cameraSteps = readPositiveIntegerArgument("--camera-steps", 12);
const cameraDurationMilliseconds = readPositiveIntegerArgument(
  "--camera-duration-ms",
  1_200,
);
const isWindows = process.platform === "win32";
const runEvidence = await createRunEvidence({ repoRoot });

await mkdir(benchmarkRoot, { recursive: true });
await rm(flowPath, { force: true });

console.log("Building example for renderer quality A/B...");
run("npm", ["run", "build:example"], repoRoot);

const port = await findAvailablePort(4473);
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

serverProcess.stdout.on("data", (data) => serverOutput.push(data.toString()));
serverProcess.stderr.on("data", (data) => serverOutput.push(data.toString()));

try {
  await waitForServer(baseUrl, serverProcess, serverOutput);
  const captures = createCapturePlan();
  await writeFile(
    flowPath,
    createQualityAbFlow({ baseUrl, captures }),
  );

  console.log(
    `Running strict renderer-only A/B: ${quality}, ${pointBudget.toLocaleString()} points, ${viewport.width}x${viewport.height}@1...`,
  );
  runPlaywrightCli([
    "--config",
    playwrightConfigPath,
    "open",
    "about:blank",
  ]);
  const output = runPlaywrightCli(["run-code", "--filename", flowPath]);
  const browserResult = extractPlaywrightResult(output);
  const analyzedCaptures = [];

  for (const capture of browserResult.captures) {
    analyzedCaptures.push(await analyzeCapture(capture));
  }

  const comparison = createComparison(analyzedCaptures, {
    consoleProblems: browserResult.consoleProblems,
    pageErrors: browserResult.pageErrors,
  });
  const report = {
    schema: "copc-viewer.renderer-quality-ab",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    configuration: {
      comparisonMode: "renderer-only",
      quality,
      pointBudget,
      maxPointCountPerNode,
      cameraHeightMeters,
      cameraSteps,
      cameraDurationMilliseconds,
      repeats,
      variants,
      viewport,
      deviceScaleFactor: 1,
    },
    environment: {
      browserGraphics: browserResult.browserGraphics,
      sourceResponses: browserResult.sourceResponses,
      consoleProblems: browserResult.consoleProblems,
      pageErrors: browserResult.pageErrors,
      runEvidence,
    },
    captures: analyzedCaptures.map(({ primaryMask: _primaryMask, ...capture }) =>
      capture,
    ),
    comparison,
    verdict: comparison.verdict,
  };

  await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  printComparison(comparison);
  console.log(`Renderer quality A/B result: ${resultPath}`);

  if (comparison.verdict !== "passed") {
    throw new Error(
      comparison.verdict === "invalid"
        ? `Renderer quality A/B equivalence failed: ${comparison.failures.join("; ")}`
        : "Renderer quality A/B gates need work; inspect the written report.",
    );
  }
} finally {
  try {
    runPlaywrightCli(["close"]);
  } catch {
    // The browser may already be closed after a startup failure.
  }
  stopServer(serverProcess);
  await rm(flowPath, { force: true });
}

function createCapturePlan() {
  const captures = [];

  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const orderedVariants = repeat % 2 === 1 ? variants : [...variants].reverse();

    for (const variant of orderedVariants) {
      const id = `autzen-${quality}-r${repeat}-${variant}`;
      captures.push({
        id,
        repeat,
        variant,
        pointImagePath: path.join(benchmarkRoot, `${id}-points.png`),
        backgroundImagePath: path.join(
          benchmarkRoot,
          `${id}-background.png`,
        ),
        maskImagePath: path.join(benchmarkRoot, `${id}-mask.png`),
      });
    }
  }

  return captures;
}

function createQualityAbFlow({ baseUrl, captures }) {
  return `async (page) => {
  const captures = ${JSON.stringify(captures)};
  const consoleProblems = [];
  const pageErrors = [];
  const results = [];
  const sourceResponseByUrl = new Map();
  const isExpectedNonFatalWebGlDriverWarning = ${isExpectedNonFatalWebGlDriverWarning.toString()};

  page.on("console", (message) => {
    const type = message.type();
    const text = message.text();
    if (isExpectedNonFatalWebGlDriverWarning(type, text)) {
      return;
    }
    if (type === "error" || type === "warning") {
      consoleProblems.push(type + ": " + text);
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    const url = response.url();
    if (!/\.copc\.laz(?:$|[?#])/i.test(url)) {
      return;
    }
    const headers = response.headers();
    sourceResponseByUrl.set(url, {
      url,
      status: response.status(),
      etag: headers.etag,
      lastModified: headers["last-modified"],
      rangeContentLength: headers["content-length"],
      acceptRanges: headers["accept-ranges"],
    });
  });

  async function waitForTerminal() {
    await page.waitForFunction(
      () => {
        const status = window.__copcBasicViewerBenchmark?.getStatus();
        return (
          status?.cameraStreamVisualQuality?.isTerminalReady === true &&
          status?.cameraStreamDetailProgress?.isComplete === true
        );
      },
      undefined,
      { timeout: 120_000 },
    );
    return page.evaluate(() =>
      window.__copcBasicViewerBenchmark?.getStatus(),
    );
  }

  async function readBrowserGraphics() {
    return page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!context) {
        throw new Error("WebGL is unavailable.");
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

  async function moveAndMeasure() {
    return page.evaluate(async (options) => {
      const benchmark = window.__copcBasicViewerBenchmark;
      if (!benchmark) {
        throw new Error("Basic viewer benchmark API was not installed.");
      }
      const frameTimes = [];
      let previousFrame;
      let measuring = true;
      const onFrame = (timestamp) => {
        if (previousFrame !== undefined) {
          frameTimes.push(timestamp - previousFrame);
        }
        previousFrame = timestamp;
        if (measuring) {
          requestAnimationFrame(onFrame);
        }
      };
      requestAnimationFrame(onFrame);
      const status = await benchmark.moveCameraForSmoothness(options);
      measuring = false;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const ordered = [...frameTimes].sort((left, right) => left - right);
      const percentile = (ratio) =>
        ordered.length === 0
          ? 0
          : ordered[Math.min(
              ordered.length - 1,
              Math.max(0, Math.ceil(ordered.length * ratio) - 1),
            )];
      const averageFrameMilliseconds =
        frameTimes.length === 0
          ? 0
          : frameTimes.reduce((total, value) => total + value, 0) /
            frameTimes.length;
      return {
        status,
        performance: {
          frameCount: frameTimes.length,
          averageFramesPerSecond:
            averageFrameMilliseconds > 0
              ? 1000 / averageFrameMilliseconds
              : 0,
          averageFrameMilliseconds,
          p95FrameMilliseconds: percentile(0.95),
          maximumFrameMilliseconds: ordered.at(-1) ?? 0,
        },
      };
    }, {
      steps: ${JSON.stringify(cameraSteps)},
      durationMilliseconds: ${JSON.stringify(cameraDurationMilliseconds)},
      heightAboveCloudMeters: ${JSON.stringify(cameraHeightMeters)},
      moveMeters: 1,
    });
  }

  await page.setViewportSize(${JSON.stringify(viewport)});
  const browserGraphics = await readBrowserGraphics();

  for (const capture of captures) {
    const url =
      ${JSON.stringify(`${baseUrl}/?quality=${encodeURIComponent(quality)}&renderer=typed&visualBenchmark=1&cameraStreamMaxPoints=${pointBudget}&maxPointCountPerNode=${maxPointCountPerNode}&renderVariant=`)} +
      capture.variant;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => window.__copcBasicViewerBenchmark !== undefined,
      undefined,
      { timeout: 30_000 },
    );
    await waitForTerminal();
    const movement = await moveAndMeasure();
    const status = await waitForTerminal();
    const canvas = page.locator("#cesium-container canvas");
    if ((await canvas.count()) !== 1) {
      throw new Error("Expected exactly one Cesium canvas.");
    }
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() =>
        requestAnimationFrame(resolve),
      ));
    });
    await canvas.screenshot({ path: capture.pointImagePath });
    const clearedRevision = await page.evaluate(() =>
      window.__copcBasicViewerBenchmark?.clearPointCloudForVisualBenchmark(),
    );
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() =>
        requestAnimationFrame(resolve),
      ));
    });
    await canvas.screenshot({ path: capture.backgroundImagePath });
    results.push({
      ...capture,
      status,
      movementStatus: movement.status,
      performance: movement.performance,
      clearedRevision,
    });
  }

  return {
    browserGraphics,
    captures: results,
    consoleProblems,
    pageErrors,
    sourceResponses: [...sourceResponseByUrl.values()],
  };
}`;
}

async function analyzeCapture(capture) {
  const [pointBuffer, backgroundBuffer] = await Promise.all([
    readFile(capture.pointImagePath),
    readFile(capture.backgroundImagePath),
  ]);
  const pointImage = PNG.sync.read(pointBuffer);
  const backgroundImage = PNG.sync.read(backgroundBuffer);
  const metrics = analyzePointCloudImagePair(pointImage, backgroundImage);
  const mask = createPointDifferenceMask(
    pointImage,
    backgroundImage,
    metrics.primaryColorDeltaThreshold,
  );
  const maskPng = new PNG({ width: pointImage.width, height: pointImage.height });
  maskPng.data = Buffer.from(
    createMaskRgba(mask, pointImage.width, pointImage.height),
  );
  await writeFile(capture.maskImagePath, PNG.sync.write(maskPng));

  return {
    ...capture,
    primaryMask: mask,
    evidence: {
      pointImage: await createFileEvidence(capture.pointImagePath),
      backgroundImage: await createFileEvidence(
        capture.backgroundImagePath,
      ),
      maskImage: await createFileEvidence(capture.maskImagePath),
    },
    visual: metrics,
  };
}

function createComparison(captures, diagnostics = {}) {
  const baselineCaptures = captures.filter(
    (capture) => capture.variant === "legacy",
  );
  const candidateCaptures = captures.filter(
    (capture) => capture.variant === "enhanced",
  );
  const failures = [];
  for (const problem of diagnostics.consoleProblems ?? []) {
    failures.push(`browser console: ${problem}`);
  }
  for (const error of diagnostics.pageErrors ?? []) {
    failures.push(`page error: ${error}`);
  }
  const equivalence = [];
  const shapeSupport = [];

  if (
    baselineCaptures.length !== candidateCaptures.length ||
    baselineCaptures.length !== repeats
  ) {
    failures.push(
      `capture count equivalence (legacy ${baselineCaptures.length}, enhanced ${candidateCaptures.length}, expected ${repeats})`,
    );
  }

  for (let index = 0; index < Math.min(
    baselineCaptures.length,
    candidateCaptures.length,
  ); index += 1) {
    const baseline = baselineCaptures[index];
    const candidate = candidateCaptures[index];
    const cameraPose = compareCameraPoseFingerprints(
      baseline.status.cameraStreamCameraPoseFingerprint,
      candidate.status.cameraStreamCameraPoseFingerprint,
    );
    const checks = {
      cameraPose: cameraPose.matches,
      canvas:
        baseline.status.canvasDrawingBufferWidth ===
          candidate.status.canvasDrawingBufferWidth &&
        baseline.status.canvasDrawingBufferHeight ===
          candidate.status.canvasDrawingBufferHeight &&
        baseline.status.devicePixelRatio === candidate.status.devicePixelRatio,
      renderSignature:
        baseline.status.cameraStreamRenderSignature ===
        candidate.status.cameraStreamRenderSignature,
      renderedPointCount:
        baseline.status.cameraStreamRenderedPointCount ===
        candidate.status.cameraStreamRenderedPointCount,
      selectedNodeKeys:
        JSON.stringify(baseline.status.cameraStreamSelectedNodeKeys) ===
        JSON.stringify(candidate.status.cameraStreamSelectedNodeKeys),
      terminal:
        baseline.status.cameraStreamVisualQuality?.isTerminalReady === true &&
        candidate.status.cameraStreamVisualQuality?.isTerminalReady === true &&
        baseline.status.cameraStreamDetailProgress?.isComplete === true &&
        candidate.status.cameraStreamDetailProgress?.isComplete === true,
    };
    equivalence.push({ repeat: baseline.repeat, checks, cameraPose });
    shapeSupport.push({
      repeat: baseline.repeat,
      ...comparePointCloudMaskSupport(
        baseline.primaryMask,
        candidate.primaryMask,
        baseline.visual.primary.width,
        baseline.visual.primary.height,
        { supportRadius: 3 },
      ),
    });
    for (const [name, passed] of Object.entries(checks)) {
      if (!passed) {
        failures.push(`repeat ${baseline.repeat} ${name} equivalence`);
      }
    }
  }

  const baseline = aggregateVariant(baselineCaptures);
  const candidate = aggregateVariant(candidateCaptures);
  const coverageRatio = safeRatio(
    candidate.visual.canvasCoverageRatio,
    baseline.visual.canvasCoverageRatio,
  );
  const boundedGapRatio = safeRatio(
    candidate.visual.boundedGapRatio,
    baseline.visual.boundedGapRatio,
  );
  const isolatedRatio = safeRatio(
    candidate.visual.isolatedForegroundRatio,
    baseline.visual.isolatedForegroundRatio,
  );
  const edgeRatio = safeRatio(
    candidate.visual.edgePerimeterPerForegroundPixel,
    baseline.visual.edgePerimeterPerForegroundPixel,
  );
  const p95Ratio = safeRatio(
    candidate.performance.p95FrameMilliseconds,
    baseline.performance.p95FrameMilliseconds,
  );
  const shapeSupportSummary = {
    supportRadius: shapeSupport[0]?.supportRadius ?? 3,
    minimumBaselineForegroundRetentionRatio:
      shapeSupport.length > 0
        ? Math.min(
            ...shapeSupport.map(
              (comparison) => comparison.baselineForegroundRetentionRatio,
            ),
          )
        : 0,
    maximumUnsupportedCandidateForegroundRatio:
      shapeSupport.length > 0
        ? Math.max(
            ...shapeSupport.map(
              (comparison) =>
                comparison.unsupportedCandidateForegroundRatio,
            ),
          )
        : 1,
    maximumLargeVoidIntrusionRatio:
      shapeSupport.length > 0
        ? Math.max(
            ...shapeSupport.map(
              (comparison) => comparison.largeVoidIntrusionRatio,
            ),
          )
        : 1,
  };
  const gates = {
    coverageImproved: coverageRatio >= 1.05,
    boundedGapsReduced:
      baseline.visual.boundedGapRatio === 0
        ? candidate.visual.boundedGapRatio === 0
        : boundedGapRatio <= 0.95,
    isolatedPixelsNotWorse: isolatedRatio <= 1.05,
    edgeComplexityReduced: edgeRatio <= 0.95,
    baselineShapeRetained:
      shapeSupport.length === repeats &&
      shapeSupportSummary.minimumBaselineForegroundRetentionRatio >= 0.95,
    candidateExpansionWithinSupport:
      shapeSupport.length === repeats &&
      shapeSupportSummary.maximumUnsupportedCandidateForegroundRatio <= 0.001,
    largeVoidsPreserved:
      shapeSupport.length === repeats &&
      shapeSupportSummary.maximumLargeVoidIntrusionRatio <= 0.001,
    p95FrameTimeWithinBudget:
      candidate.performance.p95FrameMilliseconds <=
      Math.max(
        baseline.performance.p95FrameMilliseconds * 1.25,
        baseline.performance.p95FrameMilliseconds + 2,
      ),
  };
  const equivalent = failures.length === 0;
  const qualityGatePassed =
    gates.coverageImproved &&
    gates.boundedGapsReduced &&
    gates.isolatedPixelsNotWorse &&
    gates.edgeComplexityReduced &&
    gates.baselineShapeRetained &&
    gates.candidateExpansionWithinSupport &&
    gates.largeVoidsPreserved;

  return {
    baseline,
    candidate,
    deltas: {
      coverageRatio,
      boundedGapRatio,
      isolatedRatio,
      edgeRatio,
      p95Ratio,
    },
    equivalence,
    shapeSupport,
    shapeSupportSummary,
    gates,
    failures,
    verdict: !equivalent
      ? "invalid"
      : qualityGatePassed && gates.p95FrameTimeWithinBudget
        ? "passed"
        : "needs-work",
  };
}

function aggregateVariant(captures) {
  return {
    variant: captures[0]?.variant,
    captureCount: captures.length,
    visual: {
      canvasCoverageRatio: median(
        captures.map((capture) =>
          capture.visual.primary.canvasCoverageRatio,
        ),
      ),
      boundedGapRatio: median(
        captures.map((capture) => capture.visual.primary.boundedGapRatio),
      ),
      isolatedForegroundRatio: median(
        captures.map(
          (capture) => capture.visual.primary.isolatedForegroundRatio,
        ),
      ),
      edgePerimeterPerForegroundPixel: median(
        captures.map(
          (capture) =>
            capture.visual.primary.edgePerimeterPerForegroundPixel,
        ),
      ),
    },
    performance: {
      averageFramesPerSecond: median(
        captures.map(
          (capture) => capture.performance.averageFramesPerSecond,
        ),
      ),
      p95FrameMilliseconds: median(
        captures.map((capture) => capture.performance.p95FrameMilliseconds),
      ),
      maximumFrameMilliseconds: median(
        captures.map(
          (capture) => capture.performance.maximumFrameMilliseconds,
        ),
      ),
    },
  };
}

function printComparison(comparison) {
  const baseline = comparison.baseline;
  const candidate = comparison.candidate;
  console.log(
    [
      `Quality A/B ${comparison.verdict.toUpperCase()}:`,
      `coverage ${(baseline.visual.canvasCoverageRatio * 100).toFixed(2)}% -> ${(candidate.visual.canvasCoverageRatio * 100).toFixed(2)}%,`,
      `bounded gaps ${(baseline.visual.boundedGapRatio * 100).toFixed(2)}% -> ${(candidate.visual.boundedGapRatio * 100).toFixed(2)}%,`,
      `edge/pixel ${baseline.visual.edgePerimeterPerForegroundPixel.toFixed(3)} -> ${candidate.visual.edgePerimeterPerForegroundPixel.toFixed(3)},`,
      `unsupported expansion ${(comparison.shapeSupportSummary.maximumUnsupportedCandidateForegroundRatio * 100).toFixed(3)}%,`,
      `large-void intrusion ${(comparison.shapeSupportSummary.maximumLargeVoidIntrusionRatio * 100).toFixed(3)}%,`,
      `p95 ${baseline.performance.p95FrameMilliseconds.toFixed(1)} -> ${candidate.performance.p95FrameMilliseconds.toFixed(1)} ms.`,
    ].join(" "),
  );
}

async function createFileEvidence(filePath) {
  const [buffer, fileStat] = await Promise.all([readFile(filePath), stat(filePath)]);
  return {
    path: filePath,
    byteLength: fileStat.size,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: isWindows,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function runPlaywrightCli(args) {
  const result = spawnSync(process.execPath, [playwrightCliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`playwright-cli ${args.join(" ")} failed with exit code ${result.status}`);
  }
  if (`${result.stdout}\n${result.stderr}`.includes("### Error")) {
    throw new Error(`playwright-cli ${args.join(" ")} reported an error`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

function extractPlaywrightResult(output) {
  const marker = "### Result";
  const markerIndex = output.lastIndexOf(marker);
  if (markerIndex === -1) throw new Error("Could not find Playwright result output.");
  const text = output.slice(markerIndex + marker.length);
  const jsonStart = text.search(/[\[{]/);
  if (jsonStart === -1) throw new Error("Could not find Playwright result JSON.");
  const jsonText = text.slice(jsonStart);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < jsonText.length; index += 1) {
    const character = jsonText[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return JSON.parse(jsonText.slice(0, index + 1));
    }
  }
  throw new Error("Could not parse complete Playwright result JSON.");
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available preview port found from ${startPort}.`);
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "localhost");
  });
}

async function waitForServer(url, serverProcess, serverOutput) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Preview server exited early.\n${serverOutput.join("")}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Retry until Vite is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function stopServer(serverProcess) {
  if (!serverProcess.pid || serverProcess.exitCode !== null) return;
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(serverProcess.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    serverProcess.kill("SIGTERM");
  }
}

function median(values) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (ordered.length === 0) return 0;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function safeRatio(value, baseline) {
  if (baseline === 0) return value === 0 ? 1 : Number.POSITIVE_INFINITY;
  return value / baseline;
}

function readStringArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }

  const inlinePrefix = `${name}=`;
  const inlineArgument = process.argv.find((argument) =>
    argument.startsWith(inlinePrefix),
  );
  return inlineArgument?.slice(inlinePrefix.length) || fallback;
}

function readPositiveIntegerArgument(name, fallback) {
  const value = Number(readStringArgument(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function readPositiveNumberArgument(name, fallback) {
  const value = Number(readStringArgument(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}
