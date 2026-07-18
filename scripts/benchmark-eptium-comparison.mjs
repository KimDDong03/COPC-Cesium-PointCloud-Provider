import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import {
  AUTZEN_SOURCE_URL,
  EPTIUM_AUTZEN_CAMERA_POSE_FINGERPRINT,
  EPTIUM_STOCK_SCREEN_SPACE_ERROR,
  EXPECTED_AUTZEN_ETAG,
  classifyPointCountEquivalence,
  createExternalComparisonDefinitions,
  selectClosestEptiumCalibration,
  summarizeSourceRequestTraffic,
  summarizeSourceResponses,
} from "./eptium-comparison-contract.mjs";
import { runEptiumComparisonBrowserFlow } from "./eptium-comparison-browser-flow.mjs";
import {
  analyzePointCloudImagePair,
  comparePointCloudMaskSupport,
  createMaskRgba,
  createPointDifferenceMask,
} from "./point-cloud-image-metrics.mjs";
import { compareCameraPoseFingerprints } from "./quality-ab-equivalence.mjs";
import { resolveLocalPackageBinary } from "./resolve-local-package-binary.mjs";
import { createRunEvidence } from "./run-evidence.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const benchmarkRoot = path.join(repoRoot, "output", "eptium-comparison");
const flowPath = path.join(benchmarkRoot, "eptium-comparison-flow.mjs");
const resultPath = path.join(benchmarkRoot, "eptium-comparison-result.json");
const networkTracePath = path.join(
  benchmarkRoot,
  "eptium-comparison-network-trace.json",
);
const playwrightCliPath = resolveLocalPackageBinary(
  repoRoot,
  "@playwright/cli",
  "playwright-cli",
);
const viteCliPath = resolveLocalPackageBinary(repoRoot, "vite", "vite");
const playwrightConfigPath = path.join(
  scriptDir,
  "playwright.eptium-comparison.json",
);
const viewport = { width: 1600, height: 900 };
const repeats = readPositiveIntegerArgument("--repeats", 2);
const keepGeneratedFlow = process.argv.includes("--keep-generated-flow");
const oursBalancedBasePointBudget = 360_000;
const oursDetailBasePointBudget = 720_000;
const oursBalancedPointBudgetOverride = readOptionalPositiveIntegerArgument(
  "--balanced-point-budget",
);
const oursDetailPointBudgetOverride = readOptionalPositiveIntegerArgument(
  "--detail-point-budget",
);
const maxCoalescedRangeGapBytes = readOptionalNonNegativeSafeIntegerArgument(
  "--max-coalesced-range-gap-bytes",
);
const pointGeometryWorkerConcurrency = readOptionalPositiveIntegerArgument(
  "--point-geometry-worker-concurrency",
);

if (
  pointGeometryWorkerConcurrency !== undefined &&
  pointGeometryWorkerConcurrency > 8
) {
  throw new Error(
    "--point-geometry-worker-concurrency must be at most 8.",
  );
}
const fairTargetFrameRate = readPositiveNumberArgument(
  "--fair-target-frame-rate",
  60,
);
const calibrationScreenSpaceErrors = readPositiveNumberListArgument(
  "--calibration-sse",
  [32, 40, 48, 56, 64],
);
const performanceMovement = {
  steps: readPositiveIntegerArgument("--camera-steps", 12),
  durationMilliseconds: readPositiveNumberArgument(
    "--camera-duration-ms",
    1_200,
  ),
  moveMeters: readPositiveNumberArgument("--camera-move-meters", 1),
};
const isWindows = process.platform === "win32";
const runEvidence = await createRunEvidence({ repoRoot });

await mkdir(benchmarkRoot, { recursive: true });
await rm(flowPath, { force: true });

console.log("Building the local viewer for the external Eptium comparison...");
run("npm", ["run", "build:example"], repoRoot);

const port = await findAvailablePort(4573);
const oursBaseUrl = `http://localhost:${port}`;
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
  await waitForServer(oursBaseUrl, serverProcess, serverOutput);
  const capturePaths = createCapturePaths();
  const browserConfiguration = {
    browserSessionId: randomUUID(),
    oursBaseUrl,
    eptiumBaseUrl: "https://eptium.com",
    sourceUrl: AUTZEN_SOURCE_URL,
    cameraPoseFingerprint: EPTIUM_AUTZEN_CAMERA_POSE_FINGERPRINT,
    stockScreenSpaceError: EPTIUM_STOCK_SCREEN_SPACE_ERROR,
    calibrationScreenSpaceErrors,
    oursBalancedPointBudgetOverride,
    oursDetailPointBudgetOverride,
    maxCoalescedRangeGapBytes,
    pointGeometryWorkerConcurrency,
    fairTargetFrameRate,
    performanceMovement,
    repeats,
    capturePaths,
  };
  await writeFile(
    flowPath,
    `async (page) => {\n  const run = ${runEptiumComparisonBrowserFlow.toString()};\n  return run(page, ${JSON.stringify(browserConfiguration)});\n}\n`,
  );

  console.log(
    `Running Eptium comparison at ${viewport.width}x${viewport.height}@1 (${repeats} AB/BA repeats)...`,
  );
  runPlaywrightCli([
    "--config",
    playwrightConfigPath,
    "open",
    "about:blank",
  ]);
  const browserOutput = runPlaywrightCli(["run-code", "--filename", flowPath]);
  const browserResult = extractPlaywrightResult(browserOutput);
  const sourceTraffic = summarizeSourceRequestTraffic(
    browserResult.sourceRequests,
    AUTZEN_SOURCE_URL,
  );
  const capturesWithTraffic = attachCaptureTraffic(
    browserResult.captures,
    sourceTraffic,
  );
  const analyzedCaptures = [];
  for (const capture of capturesWithTraffic) {
    analyzedCaptures.push(await analyzeCapture(capture));
  }

  await writeFile(
    networkTracePath,
    `${JSON.stringify(
      {
        schema: "copc-viewer.eptium-network-trace",
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        browserSessionId: browserResult.browserSessionId,
        sourceUrl: AUTZEN_SOURCE_URL,
        requests: browserResult.sourceRequests,
      },
      null,
      2,
    )}\n`,
  );
  const networkTraceEvidence = await createFileEvidence(networkTracePath);

  const provenance = createProvenance(browserResult);
  const validity = createValidity(browserResult, analyzedCaptures, provenance);
  const comparisons = createComparisons(analyzedCaptures, validity);
  const observedHighDetailPointCount = median(
    analyzedCaptures
      .filter((capture) => capture.id === "ours-high-detail")
      .map((capture) => capture.status.pointCount),
  );
  const closestCalibration = selectClosestEptiumCalibration(
    browserResult.calibration.samples.map((sample) => ({
      screenSpaceError: sample.screenSpaceError,
      pointCount: sample.pointCount,
    })),
    observedHighDetailPointCount,
  );
  const calibrationPointCountEquivalence = classifyPointCountEquivalence(
    observedHighDetailPointCount,
    closestCalibration.pointCount,
  );
  const equalCountComparison = comparisons.find(
    (comparison) => comparison.id === "equal-count",
  );
  const verdict =
    validity.failures.length > 0
      ? "invalid"
      : equalCountComparison?.verdict ?? "invalid";
  const report = {
    schema: "copc-viewer.eptium-external-comparison",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    configuration: {
      sourceUrl: AUTZEN_SOURCE_URL,
      expectedSourceEtag: EXPECTED_AUTZEN_ETAG,
      eptiumStockScreenSpaceError: EPTIUM_STOCK_SCREEN_SPACE_ERROR,
      localQualityPresetBaseBudgets: {
        balanced: oursBalancedBasePointBudget,
        detail: oursDetailBasePointBudget,
      },
      localPointBudgetOverrides: {
        balanced: oursBalancedPointBudgetOverride,
        detail: oursDetailPointBudgetOverride,
      },
      maxCoalescedPointDataRangeGapBytes: maxCoalescedRangeGapBytes,
      pointGeometryWorkerConcurrency,
      fairTargetFrameRate,
      performanceMovement: {
        ...performanceMovement,
        settleAfterMovementMilliseconds: 200,
        metricSource: "Cesium.Scene.postRender/performance.now",
      },
      repeats,
      orderControl: "AB/BA reverse order on alternating repeats",
      viewport,
      deviceScaleFactor: 1,
      cameraPoseFingerprint: EPTIUM_AUTZEN_CAMERA_POSE_FINGERPRINT,
      captureMode:
        "stock visual output (EDL on) is preserved separately; geometry metrics use EDL off for both viewers, paired point-on/off subtraction, and all non-canvas overlays hidden",
      geometryMetricBackgroundContract:
        "the Cesium base scene is configured opaque black, but Eptium's deterministic canvas baseline is intrinsically nonblack; pre/post counterfactual stability is a hard gate while pixel blackness is diagnostic only",
    },
    calibration: {
      ...browserResult.calibration,
      targetPointCount: observedHighDetailPointCount,
      targetName: "observed ours-high-detail terminal point count",
      closestToOursHighDetail: closestCalibration,
      pointCountEquivalence: calibrationPointCountEquivalence,
      interpretation:
        calibrationPointCountEquivalence.classification === "non-equivalent"
          ? "Eptium's discrete SSE levels cannot exactly match the requested local detail budget; this is non-equivalent, not an invalid run."
          : "A calibrated Eptium SSE is within the declared point-count tolerance.",
    },
    eptiumApplication: {
      runtime: browserResult.eptiumRuntime,
      assetResponses: browserResult.eptiumAppResponses,
    },
    environment: {
      browserSessionId: browserResult.browserSessionId,
      runEvidence,
      provenance,
      sourceTraffic,
      networkTraceEvidence,
      consoleProblems: browserResult.consoleProblems,
      pageErrors: browserResult.pageErrors,
    },
    validity,
    captures: analyzedCaptures.map(({ primaryMask: _mask, ...capture }) =>
      capture,
    ),
    comparisons,
    verdict,
  };
  await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  printReport(report);
  console.log(`Eptium comparison result: ${resultPath}`);

  if (verdict === "invalid") {
    throw new Error(
      `External comparison validity failed: ${validity.failures.join("; ")}`,
    );
  }
  if (verdict !== "passed") {
    process.exitCode = 1;
  }
} finally {
  try {
    runPlaywrightCli(["close"]);
  } catch {
    // The browser may already be closed after a startup failure.
  }
  stopServer(serverProcess);
  if (!keepGeneratedFlow) {
    await rm(flowPath, { force: true });
  }
}

function attachCaptureTraffic(captures, sourceTraffic) {
  return captures.map((capture) => ({
    ...capture,
    networkTraffic: {
      product: sourceTraffic.byScope[capture.networkScopes?.product],
      measurement: capture.networkScopes?.measurement
        ? sourceTraffic.byScope[capture.networkScopes.measurement]
        : undefined,
    },
  }));
}

function createCapturePaths() {
  const result = {};
  const configurationIds = [
    "eptium-stock",
    "ours-shipped-default",
    "ours-high-detail",
    "ours-equal-count",
  ];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const id of configurationIds) {
      const captureId = `${id}-r${repeat}`;
      result[captureId] = {
        visualOutputImagePath: path.join(
          benchmarkRoot,
          `${captureId}-visual-output.png`,
        ),
        pointImagePath: path.join(benchmarkRoot, `${captureId}-points.png`),
        backgroundImagePath: path.join(
          benchmarkRoot,
          `${captureId}-background.png`,
        ),
        backgroundVerificationImagePath: path.join(
          benchmarkRoot,
          `${captureId}-background-verification.png`,
        ),
        maskImagePath: path.join(benchmarkRoot, `${captureId}-mask.png`),
      };
    }
  }
  return result;
}

async function analyzeCapture(capture) {
  const [pointBuffer, backgroundBuffer, backgroundVerificationBuffer] = await Promise.all([
    readFile(capture.paths.pointImagePath),
    readFile(capture.paths.backgroundImagePath),
    readFile(capture.paths.backgroundVerificationImagePath),
  ]);
  const pointImage = PNG.sync.read(pointBuffer);
  const backgroundImage = PNG.sync.read(backgroundBuffer);
  const visual = analyzePointCloudImagePair(pointImage, backgroundImage);
  const backgroundVerificationImage = PNG.sync.read(
    backgroundVerificationBuffer,
  );
  const backgroundStability = compareExactImages(
    backgroundImage,
    backgroundVerificationImage,
  );
  const backgroundBlackness = analyzeOpaqueBlackImage(backgroundImage);
  const primaryMask = createPointDifferenceMask(
    pointImage,
    backgroundImage,
    visual.primaryColorDeltaThreshold,
  );
  const maskPng = new PNG({ width: pointImage.width, height: pointImage.height });
  maskPng.data = Buffer.from(
    createMaskRgba(primaryMask, pointImage.width, pointImage.height),
  );
  await writeFile(capture.paths.maskImagePath, PNG.sync.write(maskPng));
  return {
    ...capture,
    primaryMask,
    visual,
    backgroundStability,
    backgroundBlackness,
    evidence: {
      visualOutputImage: await createFileEvidence(
        capture.paths.visualOutputImagePath,
      ),
      pointImage: await createFileEvidence(capture.paths.pointImagePath),
      backgroundImage: await createFileEvidence(
        capture.paths.backgroundImagePath,
      ),
      backgroundVerificationImage: await createFileEvidence(
        capture.paths.backgroundVerificationImagePath,
      ),
      maskImage: await createFileEvidence(capture.paths.maskImagePath),
    },
  };
}

function createProvenance(browserResult) {
  const eptiumResponses = browserResult.sourceResponses.filter(
    (response) => response.scope.startsWith("eptium") ||
      response.scope === "eptium-calibration",
  );
  const oursResponses = browserResult.sourceResponses.filter((response) =>
    response.scope.startsWith("ours"),
  );
  return {
    eptium: summarizeSourceResponses(eptiumResponses),
    ours: summarizeSourceResponses(oursResponses),
  };
}

function createValidity(browserResult, captures, provenance) {
  const failures = [];
  const cameraChecks = [];
  const localStockMetricWorkloadChecks = [];
  const networkMeasurementChecks = [];
  const expectedGraphics = JSON.stringify(captures[0]?.browserGraphics);
  for (const calibration of browserResult.calibration.samples) {
    const cameraPose = compareCameraPoseFingerprints(
      EPTIUM_AUTZEN_CAMERA_POSE_FINGERPRINT,
      calibration.cameraPoseFingerprint,
    );
    if (!cameraPose.matches) {
      failures.push(`Eptium calibration SSE ${calibration.screenSpaceError} camera pose`);
    }
    if (!calibrationScreenSpaceErrors.includes(calibration.screenSpaceError)) {
      failures.push(`unexpected Eptium calibration SSE ${calibration.screenSpaceError}`);
    }
  }
  for (const problem of browserResult.consoleProblems) {
    failures.push(
      `browser console (${problem.scope}): ${problem.type}: ${problem.text}`,
    );
  }
  for (const error of browserResult.pageErrors) {
    failures.push(`page error (${error.scope}): ${error.message}`);
  }
  for (const capture of captures) {
    let cameraPose;
    try {
      cameraPose = compareCameraPoseFingerprints(
        EPTIUM_AUTZEN_CAMERA_POSE_FINGERPRINT,
        capture.status.cameraPoseFingerprint,
      );
    } catch (error) {
      cameraPose = { matches: false, error: String(error) };
    }
    cameraChecks.push({ captureId: capture.captureId, ...cameraPose });
    if (!cameraPose.matches) failures.push(`${capture.captureId} camera pose`);
    if (
      capture.status.canvasDrawingBufferWidth !== viewport.width ||
      capture.status.canvasDrawingBufferHeight !== viewport.height ||
      capture.status.devicePixelRatio !== 1
    ) {
      failures.push(`${capture.captureId} canvas/DPR`);
    }
    if (
      capture.cleanCapture.cleanViewport !== true ||
      capture.pointOffCleanCapture.cleanViewport !== true ||
      capture.pointOffVerificationCleanCapture?.cleanViewport !== true ||
      JSON.stringify(capture.cleanCapture.visibleOverlays) !==
        JSON.stringify(capture.pointOffCleanCapture.visibleOverlays) ||
      JSON.stringify(capture.pointOffCleanCapture.visibleOverlays) !==
        JSON.stringify(
          capture.pointOffVerificationCleanCapture?.visibleOverlays,
        )
    ) {
      failures.push(`${capture.captureId} clean canvas capture`);
    }
    if (capture.backgroundStability.changedPixelCount !== 0) {
      failures.push(`${capture.captureId} point-off background is unstable`);
    }
    if (capture.metricMode !== "geometry-mask/EDL-off") {
      failures.push(`${capture.captureId} geometry metric mode`);
    }
    if (
      capture.vendor === "eptium" &&
      capture.pointOffMechanism !==
        "Cesium3DTileStyle.show=false/makeStyleDirty"
    ) {
      failures.push(`${capture.captureId} Eptium point-off counterfactual`);
    }
    for (const [phase, cleanState] of [
      ["point-on", capture.cleanCapture],
      ["point-off-pre", capture.pointOffCleanCapture],
      ["point-off-post", capture.pointOffVerificationCleanCapture],
    ]) {
      if (
        cleanState.canvasCssWidth !== viewport.width ||
        cleanState.canvasCssHeight !== viewport.height ||
        cleanState.canvasDrawingBufferWidth !== viewport.width ||
        cleanState.canvasDrawingBufferHeight !== viewport.height ||
        cleanState.devicePixelRatio !== 1
      ) {
        failures.push(`${capture.captureId} ${phase} clean canvas dimensions`);
      }
    }
    if (JSON.stringify(capture.browserGraphics) !== expectedGraphics) {
      failures.push(`${capture.captureId} browser GPU/WebGL equality`);
    }
    if (
      capture.browserGraphics?.evidenceSource !== "active-Cesium-canvas" ||
      capture.browserGraphics?.canvasDrawingBufferWidth !== viewport.width ||
      capture.browserGraphics?.canvasDrawingBufferHeight !== viewport.height
    ) {
      failures.push(`${capture.captureId} active Cesium canvas GPU evidence`);
    }
    if (
      capture.stockBrowserGraphics !== undefined &&
      JSON.stringify(capture.stockBrowserGraphics) !==
        JSON.stringify(capture.browserGraphics)
    ) {
      failures.push(`${capture.captureId} stock/metric browser GPU equality`);
    }
    if (
      capture.isolatedScene?.background !== "opaque-black" ||
      capture.isolatedScene?.globeShown !== false ||
      capture.isolatedScene?.fogEnabled !== false
    ) {
      failures.push(`${capture.captureId} isolated scene`);
    }
    if (
      capture.metricIsolatedScene?.background !== "opaque-black" ||
      capture.metricIsolatedScene?.globeShown !== false ||
      capture.metricIsolatedScene?.fogEnabled !== false
    ) {
      failures.push(`${capture.captureId} geometry metric isolated scene`);
    }
    if (capture.vendor === "eptium") {
      const expectedSettings = {
        targetFrameRate: 10,
        msaaSamples: 4,
        fxaaEnabled: false,
        maximumScreenSpaceError: EPTIUM_STOCK_SCREEN_SPACE_ERROR,
        attenuation: true,
        eyeDomeLighting: true,
        eyeDomeLightingStrength: 2.4,
        eyeDomeLightingRadius: 0.8,
        geometricErrorScale: 1,
      };
      const actual = {
        targetFrameRate: capture.settings.targetFrameRate,
        msaaSamples: capture.settings.msaaSamples,
        fxaaEnabled: capture.settings.fxaaEnabled,
        maximumScreenSpaceError: capture.settings.maximumScreenSpaceError,
        attenuation: capture.settings.pointCloudShading.attenuation,
        eyeDomeLighting: capture.settings.pointCloudShading.eyeDomeLighting,
        eyeDomeLightingStrength:
          capture.settings.pointCloudShading.eyeDomeLightingStrength,
        eyeDomeLightingRadius:
          capture.settings.pointCloudShading.eyeDomeLightingRadius,
        geometricErrorScale:
          capture.settings.pointCloudShading.geometricErrorScale,
      };
      if (JSON.stringify(actual) !== JSON.stringify(expectedSettings)) {
        failures.push(`${capture.captureId} Eptium stock settings drift`);
      }
      if (
        ![3, "3"].includes(capture.settings.stylePointSizeExpression)
      ) {
        failures.push(`${capture.captureId} Eptium point-size style drift`);
      }
      if (
        capture.status.tilesLoaded !== true ||
        capture.status.pendingRequestCount !== 0 ||
        capture.status.processingTileCount !== 0
      ) {
        failures.push(`${capture.captureId} Eptium terminal state`);
      }
    } else {
      if (
        capture.status.terminalReady !== true ||
        capture.status.detailComplete !== true ||
        capture.stockWorkloadStatus?.terminalReady !== true ||
        capture.stockWorkloadStatus?.detailComplete !== true
      ) {
        failures.push(`${capture.captureId} local terminal state`);
      }
      let stockMetricCameraPose;
      try {
        stockMetricCameraPose = compareCameraPoseFingerprints(
          capture.stockWorkloadStatus.cameraPoseFingerprint,
          capture.status.cameraPoseFingerprint,
        );
      } catch (error) {
        stockMetricCameraPose = { matches: false, error: String(error) };
      }
      const workloadCheck = {
        captureId: capture.captureId,
        cameraPose: stockMetricCameraPose,
        pointCountMatches:
          capture.stockWorkloadStatus?.pointCount === capture.status.pointCount,
        renderSignatureMatches:
          capture.stockWorkloadStatus?.renderSignature ===
          capture.status.renderSignature,
        selectedNodeKeysMatch:
          JSON.stringify(capture.stockWorkloadStatus?.selectedNodeKeys) ===
          JSON.stringify(capture.status.selectedNodeKeys),
        canvasMatches:
          capture.stockWorkloadStatus?.canvasDrawingBufferWidth ===
            capture.status.canvasDrawingBufferWidth &&
          capture.stockWorkloadStatus?.canvasDrawingBufferHeight ===
            capture.status.canvasDrawingBufferHeight &&
          capture.stockWorkloadStatus?.devicePixelRatio ===
            capture.status.devicePixelRatio,
      };
      localStockMetricWorkloadChecks.push(workloadCheck);
      if (
        workloadCheck.cameraPose.matches !== true ||
        workloadCheck.pointCountMatches !== true ||
        workloadCheck.renderSignatureMatches !== true ||
        workloadCheck.selectedNodeKeysMatch !== true ||
        workloadCheck.canvasMatches !== true
      ) {
        failures.push(`${capture.captureId} stock/geometry workload equality`);
      }
    }
    if (
      capture.performance.fairness.metricSource !==
        "Cesium.Scene.postRender/performance.now" ||
      capture.performance.fairness.targetFrameRate !== fairTargetFrameRate ||
      !Number.isSafeInteger(capture.performance.fairness.frameCount) ||
      capture.performance.fairness.frameCount < 5
    ) {
      failures.push(`${capture.captureId} performance metric contract`);
    }
    const productTraffic = capture.networkTraffic?.product;
    const networkMeasurementCheck = {
      captureId: capture.captureId,
      scope: capture.networkScopes?.product,
      hasRequests: (productTraffic?.requestCount ?? 0) > 0,
      allRequestsAccounted:
        productTraffic !== undefined &&
        productTraffic.finishedCount +
          productTraffic.failedCount +
          productTraffic.abandonedCount ===
          productTraffic.requestCount &&
        productTraffic.failedCount === 0 &&
        productTraffic.pendingCount === 0 &&
        productTraffic.unknownOutcomeCount === 0,
      abandonedRequestCount: productTraffic?.abandonedCount,
      allRangesParsed:
        productTraffic !== undefined &&
        productTraffic.validRangeCount === productTraffic.requestCount &&
        productTraffic.unparsedRangeCount === 0,
      allResponsesArePartial:
        productTraffic !== undefined &&
        productTraffic.statusCounts[206] === productTraffic.finishedCount,
      responseBodyMatchesRequestedRange:
        productTraffic !== undefined &&
        productTraffic.receivedBodyBytes ===
          productTraffic.respondedRequestedBytes,
    };
    networkMeasurementChecks.push(networkMeasurementCheck);
    if (
      !networkMeasurementCheck.hasRequests ||
      !networkMeasurementCheck.allRequestsAccounted ||
      !networkMeasurementCheck.allRangesParsed ||
      !networkMeasurementCheck.allResponsesArePartial ||
      !networkMeasurementCheck.responseBodyMatchesRequestedRange
    ) {
      failures.push(`${capture.captureId} product network measurement`);
    }
  }

  for (const [vendor, source] of Object.entries(provenance)) {
    if (
      source.sourceUrl !== AUTZEN_SOURCE_URL ||
      source.responseCount === 0 ||
      source.statuses[206] === undefined ||
      source.etags.length !== 1 ||
      source.etags[0] !== EXPECTED_AUTZEN_ETAG ||
      source.totalLengths.length !== 1 ||
      source.totalLengths[0] !== 81_123_042
    ) {
      failures.push(`${vendor} COPC URL/ETag/range provenance`);
    }
  }
  if (
    !browserResult.eptiumAppResponses.some(
      (response) =>
        /\/assets\/main-/i.test(response.url) && response.status === 200,
    )
  ) {
    failures.push("Eptium application bundle provenance");
  }
  const calibratedStockPointCount = browserResult.calibration.stock.pointCount;
  for (const capture of captures.filter((item) => item.id === "eptium-stock")) {
    if (
      classifyPointCountEquivalence(
        calibratedStockPointCount,
        capture.status.pointCount,
      ).classification !== "equivalent"
    ) {
      failures.push(`${capture.captureId} differs from stock calibration point count`);
    }
  }

  return {
    valid: failures.length === 0,
    failures,
    cameraChecks,
    localStockMetricWorkloadChecks,
    networkMeasurementChecks,
    browserGraphics: captures[0]?.browserGraphics,
    sameBrowserSession: browserResult.browserSessionId,
  };
}

function compareExactImages(first, second) {
  if (
    first.width !== second.width ||
    first.height !== second.height ||
    first.data.length !== second.data.length
  ) {
    throw new Error("Background verification images must have equal dimensions.");
  }
  let changedPixelCount = 0;
  let maximumChannelDelta = 0;
  for (let offset = 0; offset < first.data.length; offset += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(first.data[offset + channel] - second.data[offset + channel]);
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      changed ||= delta !== 0;
    }
    changedPixelCount += changed ? 1 : 0;
  }
  const pixelCount = first.width * first.height;
  return {
    pixelCount,
    changedPixelCount,
    changedPixelRatio: pixelCount > 0 ? changedPixelCount / pixelCount : 1,
    maximumChannelDelta,
  };
}

function analyzeOpaqueBlackImage(image) {
  let nonBlackPixelCount = 0;
  let nonOpaquePixelCount = 0;
  let maximumRgbValue = 0;
  let minimumAlpha = 255;
  let maximumAlpha = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset];
    const green = image.data[offset + 1];
    const blue = image.data[offset + 2];
    const alpha = image.data[offset + 3];
    const maximumPixelRgb = Math.max(red, green, blue);
    maximumRgbValue = Math.max(maximumRgbValue, maximumPixelRgb);
    nonBlackPixelCount += maximumPixelRgb > 0 ? 1 : 0;
    nonOpaquePixelCount += alpha !== 255 ? 1 : 0;
    minimumAlpha = Math.min(minimumAlpha, alpha);
    maximumAlpha = Math.max(maximumAlpha, alpha);
  }
  const pixelCount = image.width * image.height;
  return {
    pixelCount,
    nonBlackPixelCount,
    nonBlackPixelRatio:
      pixelCount > 0 ? nonBlackPixelCount / pixelCount : 1,
    maximumRgbValue,
    nonOpaquePixelCount,
    nonOpaquePixelRatio:
      pixelCount > 0 ? nonOpaquePixelCount / pixelCount : 1,
    minimumAlpha,
    maximumAlpha,
  };
}

function createComparisons(captures, validity) {
  return createExternalComparisonDefinitions().map((definition) => {
    const baselineCaptures = captures.filter(
      (capture) => capture.id === definition.baselineCaptureId,
    );
    const candidateCaptures = captures.filter(
      (capture) => capture.id === definition.candidateCaptureId,
    );
    const baseline = aggregateCaptures(baselineCaptures);
    const candidate = aggregateCaptures(candidateCaptures);
    const pointCountPairs = [];
    const supportDiagnostics = [];
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const baselineCapture = baselineCaptures.find(
        (capture) => capture.repeat === repeat,
      );
      const candidateCapture = candidateCaptures.find(
        (capture) => capture.repeat === repeat,
      );
      if (!baselineCapture || !candidateCapture) continue;
      pointCountPairs.push({
        repeat,
        ...classifyPointCountEquivalence(
          baselineCapture.status.pointCount,
          candidateCapture.status.pointCount,
        ),
      });
      supportDiagnostics.push({
        repeat,
        ...comparePointCloudMaskSupport(
          baselineCapture.primaryMask,
          candidateCapture.primaryMask,
          baselineCapture.visual.primary.width,
          baselineCapture.visual.primary.height,
          { supportRadius: 3 },
        ),
      });
    }
    const pointCountsEquivalent =
      pointCountPairs.length === repeats &&
      pointCountPairs.every((pair) => pair.classification === "equivalent");
    const referenceSupportGate = {
      blocking: false,
      referenceSupportAssumption:
        "The Eptium mask is only a rendered reference, not source-truth coverage. Different LOD samples may contain different point IDs, so outside-reference pixels are divergence diagnostics and are not automatically real overfill.",
      supportRadius: 3,
      minimumEptiumForegroundRetentionRatio: minimum(
        supportDiagnostics.map(
          (diagnostic) => diagnostic.baselineForegroundRetentionRatio,
        ),
      ),
      maximumOutsideEptiumSupportRatio: maximum(
        supportDiagnostics.map(
          (diagnostic) => diagnostic.unsupportedCandidateForegroundRatio,
        ),
      ),
      maximumEptiumLargeVoidIntrusionRatio: maximum(
        supportDiagnostics.map(
          (diagnostic) => diagnostic.largeVoidIntrusionRatio,
        ),
      ),
    };
    const gates = {
      coverageAtLeastReference:
        candidate.visual.canvasCoverageRatio >=
        baseline.visual.canvasCoverageRatio * 0.99,
      boundedGapsNotWorse:
        candidate.visual.boundedGapRatio <=
        Math.max(
          baseline.visual.boundedGapRatio * 1.1,
          baseline.visual.boundedGapRatio + 0.001,
        ),
      edgeComplexityNotWorse:
        candidate.visual.edgePerimeterPerForegroundPixel <=
        baseline.visual.edgePerimeterPerForegroundPixel * 1.1,
      fairPostRenderP95WithinBudget:
        candidate.performance.p95FrameMilliseconds <=
        Math.max(
          baseline.performance.p95FrameMilliseconds * 1.25,
          baseline.performance.p95FrameMilliseconds + 2,
        ),
    };
    const qualityPassed = Object.values(gates).every(Boolean);
    const verdict =
      validity.failures.length > 0
        ? "invalid"
        : !pointCountsEquivalent
          ? "non-equivalent"
          : qualityPassed
            ? "passed"
            : "needs-work";
    return {
      ...definition,
      baseline,
      candidate,
      pointCountPairs,
      pointCountsEquivalent,
      supportDiagnostics,
      referenceSupportGate,
      gates,
      verdict,
    };
  });
}

function aggregateCaptures(captures) {
  const productTraffic = captures
    .map((capture) => capture.networkTraffic?.product)
    .filter(Boolean);
  return {
    id: captures[0]?.id,
    captureCount: captures.length,
    pointCount: median(captures.map((capture) => capture.status.pointCount)),
    visual: {
      canvasCoverageRatio: median(
        captures.map((capture) => capture.visual.primary.canvasCoverageRatio),
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
      metricSource: "Cesium.Scene.postRender/performance.now",
      targetFrameRate: fairTargetFrameRate,
      averageFramesPerSecond: median(
        captures.map(
          (capture) =>
            capture.performance.fairness.averageFramesPerSecond,
        ),
      ),
      p95FrameMilliseconds: median(
        captures.map(
          (capture) => capture.performance.fairness.p95FrameMilliseconds,
        ),
      ),
      maximumFrameMilliseconds: median(
        captures.map(
          (capture) => capture.performance.fairness.maximumFrameMilliseconds,
        ),
      ),
    },
    loadTiming: {
      semantics: captures[0]?.loadTiming?.semantics,
      navigationReadyMilliseconds: median(
        captures.map(
          (capture) => capture.loadTiming?.navigationReadyMilliseconds,
        ),
      ),
      initialFirstTerminalMilliseconds: median(
        captures.map(
          (capture) => capture.loadTiming?.initialFirstTerminalMilliseconds,
        ),
      ),
      sharedPoseFirstTerminalMilliseconds: median(
        captures.map(
          (capture) =>
            capture.loadTiming?.sharedPoseFirstTerminalMilliseconds,
        ),
      ),
      productFirstReadyMilliseconds: median(
        captures.map(
          (capture) => capture.loadTiming?.productFirstReadyMilliseconds,
        ),
      ),
      productReadyMilliseconds: median(
        captures.map(
          (capture) => capture.loadTiming?.productReadyMilliseconds,
        ),
      ),
    },
    networkTraffic: {
      scope: "product page only; local geometry-mask measurement reload excluded",
      requestCount: median(productTraffic.map((traffic) => traffic.requestCount)),
      requestedBytes: median(
        productTraffic.map((traffic) => traffic.requestedBytes),
      ),
      respondedRequestedBytes: median(
        productTraffic.map((traffic) => traffic.respondedRequestedBytes),
      ),
      receivedBodyBytes: median(
        productTraffic.map((traffic) => traffic.receivedBodyBytes),
      ),
      receivedHeaderBytes: median(
        productTraffic.map((traffic) => traffic.receivedHeaderBytes),
      ),
      uniqueExactRangeCount: median(
        productTraffic.map((traffic) => traffic.uniqueExactRangeCount),
      ),
      exactDuplicateRequestCount: median(
        productTraffic.map((traffic) => traffic.exactDuplicateRequestCount),
      ),
      exactDuplicateBytes: median(
        productTraffic.map((traffic) => traffic.exactDuplicateBytes),
      ),
      abandonedRequestCount: median(
        productTraffic.map((traffic) => traffic.abandonedCount),
      ),
      unionUniqueRequestedBytes: median(
        productTraffic.map((traffic) => traffic.unionUniqueRequestedBytes),
      ),
      redundantOverlapBytes: median(
        productTraffic.map((traffic) => traffic.redundantOverlapBytes),
      ),
      amplificationRatio: median(
        productTraffic.map((traffic) => traffic.amplificationRatio),
      ),
      coalescingAt64KiB: {
        spanCount: median(
          productTraffic.map(
            (traffic) => traffic.coalescingEstimates[65536]?.spanCount,
          ),
        ),
        requestReduction: median(
          productTraffic.map(
            (traffic) => traffic.coalescingEstimates[65536]?.requestReduction,
          ),
        ),
        overfetchBytes: median(
          productTraffic.map(
            (traffic) => traffic.coalescingEstimates[65536]?.overfetchBytes,
          ),
        ),
      },
    },
  };
}

function printReport(report) {
  console.log(`External comparison ${report.verdict.toUpperCase()}:`);
  for (const comparison of report.comparisons) {
    console.log(
      [
        `${comparison.id}: ${comparison.verdict}`,
        `points ${comparison.baseline.pointCount.toLocaleString()} vs ${comparison.candidate.pointCount.toLocaleString()},`,
        `coverage ${(comparison.baseline.visual.canvasCoverageRatio * 100).toFixed(2)}% vs ${(comparison.candidate.visual.canvasCoverageRatio * 100).toFixed(2)}%,`,
        `gaps ${(comparison.baseline.visual.boundedGapRatio * 100).toFixed(3)}% vs ${(comparison.candidate.visual.boundedGapRatio * 100).toFixed(3)}%,`,
        `fair p95 ${comparison.baseline.performance.p95FrameMilliseconds.toFixed(2)} vs ${comparison.candidate.performance.p95FrameMilliseconds.toFixed(2)} ms,`,
        `product ready ${comparison.baseline.loadTiming.productFirstReadyMilliseconds.toFixed(1)} vs ${comparison.candidate.loadTiming.productFirstReadyMilliseconds.toFixed(1)} ms,`,
        `ranges ${comparison.baseline.networkTraffic.requestCount.toFixed(0)} vs ${comparison.candidate.networkTraffic.requestCount.toFixed(0)}`,
      ].join(" "),
    );
  }
}

async function createFileEvidence(filePath) {
  const [buffer, fileStat] = await Promise.all([
    readFile(filePath),
    stat(filePath),
  ]);
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
    maxBuffer: 64 * 1024 * 1024,
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

function minimum(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? Math.min(...finite) : 0;
}

function maximum(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? Math.max(...finite) : 1;
}

function readStringArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  const inlinePrefix = `${name}=`;
  const inline = process.argv.find((argument) =>
    argument.startsWith(inlinePrefix),
  );
  return inline?.slice(inlinePrefix.length) || fallback;
}

function readPositiveIntegerArgument(name, fallback) {
  const value = Number(readStringArgument(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function readOptionalPositiveIntegerArgument(name) {
  const index = process.argv.indexOf(name);
  const inlinePrefix = `${name}=`;
  const inline = process.argv.find((argument) =>
    argument.startsWith(inlinePrefix),
  );
  if (index === -1 && inline === undefined) return undefined;
  const rawValue =
    index !== -1 && process.argv[index + 1] &&
      !process.argv[index + 1].startsWith("--")
      ? process.argv[index + 1]
      : inline?.slice(inlinePrefix.length);
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer when provided.`);
  }
  return value;
}

function readOptionalNonNegativeSafeIntegerArgument(name) {
  const index = process.argv.indexOf(name);
  const inlinePrefix = `${name}=`;
  const inline = process.argv.find((argument) =>
    argument.startsWith(inlinePrefix),
  );
  if (index === -1 && inline === undefined) return undefined;
  const rawValue =
    index !== -1 && process.argv[index + 1] &&
      !process.argv[index + 1].startsWith("--")
      ? process.argv[index + 1]
      : inline?.slice(inlinePrefix.length);
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer when provided.`);
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

function readPositiveNumberListArgument(name, fallback) {
  const value = readStringArgument(name, fallback.join(","));
  const numbers = value.split(",").map(Number);
  if (numbers.length === 0 || numbers.some((entry) => !Number.isFinite(entry) || entry <= 0)) {
    throw new Error(`${name} must be a comma-separated list of positive numbers.`);
  }
  if (!numbers.includes(EPTIUM_STOCK_SCREEN_SPACE_ERROR)) {
    throw new Error(`${name} must include stock SSE ${EPTIUM_STOCK_SCREEN_SPACE_ERROR}.`);
  }
  return [...new Set(numbers)];
}
