import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRunEvidence } from "./run-evidence.mjs";
import { resolveLocalPackageBinary } from "./resolve-local-package-binary.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const benchmarkMode = process.argv.includes("--edge-range-cache")
  ? "edge-range-cache"
  : "persistent-range-cache";
const isEdgeRangeCacheMode = benchmarkMode === "edge-range-cache";
const outputRoot = path.join(repoRoot, "output", benchmarkMode);
const resultPath = path.join(outputRoot, `${benchmarkMode}-result.json`);
const flowPath = path.join(outputRoot, `${benchmarkMode}-flow.mjs`);
const playwrightCliPath = resolveLocalPackageBinary(
  repoRoot,
  "@playwright/cli",
  "playwright-cli",
);
const viteCliPath = resolveLocalPackageBinary(repoRoot, "vite", "vite");
const playwrightConfigPath = path.join(
  scriptDir,
  "playwright.high-performance-gpu.json",
);
const isWindows = process.platform === "win32";
const browserRunTimeoutMilliseconds = 300_000;

await mkdir(outputRoot, { recursive: true });
runCommand("npm", [
  "run",
  "build:example",
]);

const port = await findAvailablePort(4389);
const edgePort = isEdgeRangeCacheMode ? await findAvailablePort(4489) : undefined;
const baseUrl = `http://localhost:${port}`;
const edgeBaseUrl = edgePort === undefined ? undefined : `http://localhost:${edgePort}`;
const exampleUrl =
  `${baseUrl}/?persistentRangeCache=1&terminalRenderInputHash=1`;
const sourceUrl = `${baseUrl}/copc-samples/millsite.copc.laz`;
const edgeStatsUrl = edgeBaseUrl === undefined
  ? undefined
  : `${edgeBaseUrl}/__copc_edge_cache_stats`;
const edgeSampleProxyRoot = edgeBaseUrl === undefined
  ? undefined
  : `${edgeBaseUrl}/hobu-lidar`;
const edgeCacheServer = isEdgeRangeCacheMode
  ? await startEdgeRangeCacheServer(edgePort)
  : undefined;
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
    env: {
      ...process.env,
      ...(edgeSampleProxyRoot === undefined
        ? {}
        : { COPC_SAMPLE_PROXY_ROOT: edgeSampleProxyRoot }),
    },
  },
);
serverProcess.stdout.on("data", (data) => serverOutput.push(data.toString()));
serverProcess.stderr.on("data", (data) => serverOutput.push(data.toString()));

try {
  await waitForServer(baseUrl, serverProcess, serverOutput);
  if (edgeStatsUrl !== undefined) {
    await waitForUrl(edgeStatsUrl, edgeCacheServer.output);
  }
  await writeFile(
    flowPath,
    createBrowserFlow(exampleUrl, sourceUrl, {
      mode: benchmarkMode,
      edgeStatsUrl,
    }),
  );
  runPlaywrightCli(["--config", playwrightConfigPath, "open", "about:blank"]);
  const browserOutput = await runPlaywrightCliAsync([
    "run-code",
    "--filename",
    flowPath,
  ], browserRunTimeoutMilliseconds);
  const browserResult = extractPlaywrightResult(browserOutput);
  const failures = validateResult(browserResult);
  const result = {
    schema: isEdgeRangeCacheMode
      ? "copc-viewer.edge-range-cache-benchmark"
      : "copc-viewer.persistent-range-cache-benchmark",
    schemaVersion: 2,
    verdict: failures.length === 0 ? "passed" : "failed",
    failures,
    mode: benchmarkMode,
    ...browserResult,
    runEvidence: await createRunEvidence({ repoRoot }),
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  printSummary(result);
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  try {
    runPlaywrightCli(["close"]);
  } catch {
    // The browser may already be closed after a failed flow.
  }
  stopServer(serverProcess);
  if (edgeCacheServer !== undefined) {
    await edgeCacheServer.close();
  }
  await rm(flowPath, { force: true });
}

function createBrowserFlow(exampleUrl, sourceUrl, options = {}) {
  return `async (page) => {
  const exampleUrl = ${JSON.stringify(exampleUrl)};
  const sourceUrl = ${JSON.stringify(sourceUrl)};
  const benchmarkMode = ${JSON.stringify(options.mode ?? "persistent-range-cache")};
  const isEdgeRangeCacheMode = benchmarkMode === "edge-range-cache";
  const edgeStatsUrl = ${JSON.stringify(options.edgeStatsUrl)};
  const phaseTimeoutMilliseconds = 120_000;
  const qualityGates = {
    minSelectedDepth: 5,
    minRenderedPointCount: 300_000,
    minRequiredNodeCount: 64,
  };
  const rangeRequests = [];
  const consoleProblems = [];
  const pageErrors = [];
  const phaseProgress = [];
  let scope = "startup";

  page.on("request", (request) => {
    if (request.url() !== sourceUrl) return;
    const range = request.headers().range;
    if (!range) return;
    rangeRequests.push({
      scope,
      range,
      requestedRange: parseRange(range),
      requestedByteLength: parseRangeByteLength(range),
      startedAtMilliseconds: Date.now(),
      outcome: "pending",
    });
  });
  page.on("response", (response) => {
    if (response.url() !== sourceUrl) return;
    const requestRange = response.request().headers().range;
    const record = [...rangeRequests].reverse().find(
      (candidate) => candidate.range === requestRange && candidate.outcome === "pending",
    );
    if (!record) return;
    const headers = response.headers();
    record.status = response.status();
    record.etag = headers.etag;
    record.contentRange = headers["content-range"];
    record.contentLength = parseOptionalInteger(headers["content-length"]);
    record.contentRangeRange = parseContentRange(headers["content-range"]);
    record.responseConfirmedByteLength = response.status() === 206
      ? record.contentRangeRange?.byteLength ?? record.contentLength
      : undefined;
    record.responseValidation = validateRangeResponse(record);
  });
  page.on("requestfinished", (request) => {
    if (request.url() !== sourceUrl) return;
    const requestRange = request.headers().range;
    const record = [...rangeRequests].reverse().find(
      (candidate) => candidate.range === requestRange && candidate.outcome === "pending",
    );
    if (record) {
      record.outcome = "finished";
      record.finishedAtMilliseconds = Date.now();
      record.durationMilliseconds =
        record.finishedAtMilliseconds - record.startedAtMilliseconds;
    }
  });
  page.on("requestfailed", (request) => {
    if (request.url() !== sourceUrl) return;
    const requestRange = request.headers().range;
    const record = [...rangeRequests].reverse().find(
      (candidate) => candidate.range === requestRange && candidate.outcome === "pending",
    );
    if (record) {
      record.outcome = "failed";
      record.failure = request.failure()?.errorText ?? "unknown";
    }
  });
  page.on("console", (message) => {
    const type = message.type();
    const text = message.text();
    const expectedWebGlWarning =
      type === "warning" && text.includes("GL Driver Message");
    if (!expectedWebGlWarning && (type === "warning" || type === "error")) {
      consoleProblems.push({ scope, type, text });
    }
  });
  page.on("pageerror", (error) => pageErrors.push({ scope, message: error.message }));

  await page.goto(exampleUrl, { waitUntil: "domcontentloaded" });
  await waitForBenchmarkApi();
  const cleared = await page.evaluate(() =>
    window.__copcBasicViewerBenchmark.clearPersistentRangeCache(),
  );
  if (!cleared) throw new Error("Persistent range cache was not enabled.");
  const afterClearCacheStats = await page.evaluate(() =>
    window.__copcBasicViewerBenchmark.getPersistentRangeCacheStats(),
  );
  await clearBrowserHttpCache();
  const afterClearStatus = await readStatusSnapshot();
  recordPhase("cache-clear", "completed", afterClearStatus, {
    cacheStats: afterClearCacheStats,
  });
  const cacheClearEvidence = {
    cleared,
    browserHttpCacheCleared: true,
    stats: afterClearCacheStats,
    isZeroed: afterClearCacheStats?.hits === 0 &&
      afterClearCacheStats?.misses === 0 &&
      afterClearCacheStats?.cachedRangeCount === 0 &&
      afterClearCacheStats?.cachedRangeBytes === 0,
  };

  const edgeCacheSnapshots = [];
  if (isEdgeRangeCacheMode) {
    edgeCacheSnapshots.push(await readEdgeCacheSnapshot("after-browser-cache-clear"));
  }
  const cold = await loadTerminalView("cold");
  if (isEdgeRangeCacheMode) {
    edgeCacheSnapshots.push(await readEdgeCacheSnapshot("after-cold"));
    const browserCacheResetEvidence = await clearBrowserAndPersistentCachesForEdgeWarm();
    edgeCacheSnapshots.push(await readEdgeCacheSnapshot("after-browser-cache-reset"));
    scope = "edge-warm/browser-cold";
    const beforeReloadStatus = await readStatusSnapshot();
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForBenchmarkApi();
    const afterReloadStatus = await readStatusSnapshot();
    recordPhase("edge-warm/browser-cold-reload", "completed", afterReloadStatus, {
      beforeReloadStatus,
      browserCacheResetEvidence,
    });
    const repeat = await loadTerminalView("edge-warm/browser-cold");
    edgeCacheSnapshots.push(await readEdgeCacheSnapshot("after-edge-warm-browser-cold"));
    scope = "complete";

    return {
      exampleUrl,
      sourceUrl,
      benchmarkMode,
      phaseTimeoutMilliseconds,
      qualityGates,
      cacheClearEvidence,
      browserCacheResetEvidence,
      reloadEvidence: {
        beforeReloadStatus,
        afterReloadStatus,
        freshCameraSignal: compareFreshCameraSignal(beforeReloadStatus, afterReloadStatus),
      },
      cold,
      repeat,
      edgeWarmBrowserCold: repeat,
      edgeCacheSnapshots,
      edgeCacheSummary: summarizeEdgeCache(edgeCacheSnapshots),
      rangeRequests,
      rangeSummary: {
        cold: summarizeRanges("cold"),
        repeat: summarizeRanges("edge-warm/browser-cold"),
      },
      phaseProgress,
      consoleProblems,
      pageErrors,
    };
  }
  scope = "reload";
  const beforeReloadStatus = await readStatusSnapshot();
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForBenchmarkApi();
  const afterReloadStatus = await readStatusSnapshot();
  recordPhase("reload", "completed", afterReloadStatus, {
    beforeReloadStatus,
  });
  const repeat = await loadTerminalView("repeat");
  scope = "complete";

  return {
    exampleUrl,
    sourceUrl,
    benchmarkMode,
    phaseTimeoutMilliseconds,
    qualityGates,
    cacheClearEvidence,
    reloadEvidence: {
      beforeReloadStatus,
      afterReloadStatus,
      freshCameraSignal: compareFreshCameraSignal(beforeReloadStatus, afterReloadStatus),
    },
    cold,
    repeat,
    rangeRequests,
    rangeSummary: {
      cold: summarizeRanges("cold"),
      repeat: summarizeRanges("repeat"),
    },
    phaseProgress,
    consoleProblems,
    pageErrors,
  };

  async function waitForBenchmarkApi() {
    await page.waitForFunction(
      () => Boolean(window.__copcBasicViewerBenchmark),
      undefined,
      { timeout: 30_000 },
    );
  }

  async function clearBrowserAndPersistentCachesForEdgeWarm() {
    const cleared = await page.evaluate(() =>
      window.__copcBasicViewerBenchmark.clearPersistentRangeCache(),
    );
    const persistentStats = await page.evaluate(() =>
      window.__copcBasicViewerBenchmark.getPersistentRangeCacheStats(),
    );
    await clearBrowserHttpCache();
    return {
      persistentRangeCacheCleared: cleared,
      persistentRangeCacheStats: persistentStats,
      browserHttpCacheCleared: true,
      isPersistentStoreZeroed: persistentStats?.cachedRangeCount === 0 &&
        persistentStats?.cachedRangeBytes === 0,
    };
  }

  async function clearBrowserHttpCache() {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Network.enable");
      await session.send("Network.clearBrowserCache");
    } finally {
      await session.detach();
    }
  }

  async function readEdgeCacheSnapshot(label) {
    if (typeof edgeStatsUrl !== "string") return { label, unavailable: true };
    const result = await page.evaluate(async (url) => {
      const response = await fetch(url, { cache: "no-store" });
      return {
        ok: response.ok,
        status: response.status,
        stats: response.ok ? await response.json() : undefined,
      };
    }, edgeStatsUrl);
    if (!result.ok) {
      throw new Error("Edge cache stats endpoint returned HTTP " + result.status);
    }
    return {
      label,
      atMilliseconds: Date.now(),
      stats: result.stats,
    };
  }

  async function loadTerminalView(nextScope) {
    scope = nextScope;
    const startedAtMilliseconds = Date.now();
    recordPhase(nextScope, "started");
    await page.evaluate((url) => {
      const sampleSelect = document.querySelector("#copc-sample-select");
      const rendererSelect = document.querySelector("#copc-renderer-select");
      const maxPointCountInput = document.querySelector("#copc-max-point-count");
      const streamBudgetInput = document.querySelector(
        "#copc-camera-stream-point-budget",
      );
      const urlInput = document.querySelector("#copc-url");
      const sourceCrsInput = document.querySelector("#copc-source-crs");
      const sourceDefinitionInput = document.querySelector(
        "#copc-source-definition",
      );
      const autoStream = document.querySelector("#copc-auto-stream");
      const form = document.querySelector("#copc-form");
      if (
        !(sampleSelect instanceof HTMLSelectElement) ||
        !(rendererSelect instanceof HTMLSelectElement) ||
        !(maxPointCountInput instanceof HTMLInputElement) ||
        !(streamBudgetInput instanceof HTMLInputElement) ||
        !(urlInput instanceof HTMLInputElement) ||
        !(sourceCrsInput instanceof HTMLInputElement) ||
        !(sourceDefinitionInput instanceof HTMLTextAreaElement) ||
        !(autoStream instanceof HTMLInputElement) ||
        !(form instanceof HTMLFormElement)
      ) {
        throw new Error("Persistent cache benchmark controls were not found.");
      }
      if (autoStream.checked) {
        autoStream.checked = false;
        autoStream.dispatchEvent(new Event("change", { bubbles: true }));
      }
      rendererSelect.value = "typed";
      maxPointCountInput.value = "20000";
      streamBudgetInput.value = "360000";
      sampleSelect.value = "custom";
      sampleSelect.dispatchEvent(new Event("change", { bubbles: true }));
      urlInput.value = url;
      sourceCrsInput.value = "EPSG:6341";
      sourceDefinitionInput.value =
        "+proj=utm +zone=12 +ellps=GRS80 +units=m +no_defs +type=crs";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }, sourceUrl);

    const loadSettled = await waitForConditionWithProgress(
      nextScope + ":source-load",
      Math.min(60_000, remainingPhaseMilliseconds(startedAtMilliseconds)),
      async () => page.evaluate(() => {
        const form = document.querySelector("#copc-form");
        const metadata = document.querySelector("#copc-metadata");
        return form?.getAttribute("aria-busy") !== "true" &&
          metadata?.textContent?.includes("Custom URL");
      }),
    );
    if (!loadSettled.ok) {
      return createFailedPhaseResult(
        nextScope,
        startedAtMilliseconds,
        "source-load-timeout",
        loadSettled,
      );
    }
    await page.evaluate(() => {
      const autoStream = document.querySelector("#copc-auto-stream");
      if (!(autoStream instanceof HTMLInputElement) || autoStream.disabled) {
        throw new Error("Camera streaming was not available.");
      }
      autoStream.checked = true;
      autoStream.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const initialStatus = await readStatusSnapshot();
    recordPhase(nextScope, "stream-enabled", initialStatus);
    const movement = await page.evaluate(() =>
      window.__copcBasicViewerBenchmark.moveCameraForSmoothness({
        steps: 1,
        durationMilliseconds: 1,
        heightAboveCloudMeters: 550,
        moveMeters: 1,
      }),
    );
    recordPhase(nextScope, "camera-moved", movement);
    const convergence = await waitForConditionWithProgress(
      nextScope + ":terminal-quality",
      remainingPhaseMilliseconds(startedAtMilliseconds),
      async () => {
        const status = await readStatusSnapshot();
        return isHighQualityTerminal(status) &&
          status?.cameraStreamPrefetchData?.state === "completed";
      },
    );
    const status = await page.evaluate(() =>
      window.__copcBasicViewerBenchmark.getStatus(),
    );
    const cacheStats = await page.evaluate(() =>
      window.__copcBasicViewerBenchmark.getPersistentRangeCacheStats(),
    );
    const completed = convergence.ok && isHighQualityTerminal(status);
    const selectedNodeKeys = status?.cameraStreamSelectedNodeKeys ?? [];
    const terminalRenderInputHash = status?.terminalRenderInputHash;
    const exactPointHashAvailable =
      typeof terminalRenderInputHash === "string" &&
      /^[0-9a-f]{16}$/.test(terminalRenderInputHash);
    const pointHashEvidence = {
      exactPointHashAvailable,
      hashKind: "terminal-render-geometry-input:v1:dual32",
      terminalRenderInputHash,
      inference: exactPointHashAvailable
        ? "The terminal hash covers the ordered renderer geometry batches, including keys, point counts, density metadata, raw transformed positions, and raw colors."
        : "The benchmark API did not expose a valid terminal render-input hash.",
      sourceUrl,
      cameraPoseFingerprint: status?.cameraStreamCameraPoseFingerprint,
      selectedNodeKeys,
      renderedPointCount: status?.cameraStreamRenderedPointCount,
      renderSignature: status?.cameraStreamRenderSignature,
    };
    recordPhase(nextScope, completed ? "completed" : "failed", status, {
      cacheStats,
      reason: completed ? undefined : "terminal-quality-timeout",
    });
    return {
      completed,
      failureReason: completed ? undefined : "terminal-quality-timeout",
      elapsedMilliseconds: Date.now() - startedAtMilliseconds,
      movement,
      initialStatus,
      convergence,
      status,
      cacheStats,
      poseFingerprint: status?.cameraStreamCameraPoseFingerprint,
      selectedDepth: status?.cameraStreamSelectionEvidence?.selectedDepth ??
        status?.cameraStreamDiagnosticsData?.selectedDepth,
      frontierNodeCount: status?.cameraStreamVisualQuality?.frontierNodeCount,
      selectedNodeKeys,
      renderedPointCount: status?.cameraStreamRenderedPointCount,
      sourceEvidence: {
        sourceUrl,
        renderer: status?.pointRenderer,
        sourceLabel: readMetadataValue(status, "Source"),
        sourcePreset: readMetadataValue(status, "Source preset"),
      },
      validatorEvidence: {
        etags: uniqueDefined(
          rangeRequests
            .filter((record) => record.scope === nextScope)
            .map((record) => record.etag),
        ),
        contentRangeTotals: uniqueDefined(
          rangeRequests
            .filter((record) => record.scope === nextScope)
            .map((record) => record.contentRangeRange?.total),
        ),
      },
      pointHashEvidence,
    };
  }

  function createFailedPhaseResult(
    phase,
    startedAtMilliseconds,
    failureReason,
    waitResult,
  ) {
    const status = waitResult.lastStatus;
    recordPhase(phase, "failed", status, { reason: failureReason });
    return {
      completed: false,
      failureReason,
      elapsedMilliseconds: Date.now() - startedAtMilliseconds,
      convergence: waitResult,
      status,
      cacheStats: undefined,
      poseFingerprint: status?.cameraStreamCameraPoseFingerprint,
      selectedDepth: status?.cameraStreamSelectionEvidence?.selectedDepth ??
        status?.cameraStreamDiagnosticsData?.selectedDepth,
      frontierNodeCount: status?.cameraStreamVisualQuality?.frontierNodeCount,
      selectedNodeKeys: status?.cameraStreamSelectedNodeKeys ?? [],
      renderedPointCount: status?.cameraStreamRenderedPointCount,
      pointHashEvidence: {
        exactPointHashAvailable: false,
        hashKind: "terminal-render-geometry-input:v1:dual32",
        terminalRenderInputHash: status?.terminalRenderInputHash,
        inference:
          "This phase did not converge, so terminal render-input equality was not established.",
        sourceUrl,
        cameraPoseFingerprint: status?.cameraStreamCameraPoseFingerprint,
        selectedNodeKeys: status?.cameraStreamSelectedNodeKeys ?? [],
        renderedPointCount: status?.cameraStreamRenderedPointCount,
      },
    };
  }

  async function waitForConditionWithProgress(label, timeoutMilliseconds, test) {
    const startedAtMilliseconds = Date.now();
    let lastStatus;
    let lastSnapshotAtMilliseconds = 0;
    let lastSignature = "";
    while (Date.now() - startedAtMilliseconds <= timeoutMilliseconds) {
      let ok = false;
      try {
        ok = Boolean(await test());
      } catch (error) {
        recordPhase(label, "poll-error", lastStatus, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      lastStatus = await readStatusSnapshot();
      const signature = createStatusProgressSignature(lastStatus);
      const now = Date.now();
      if (
        signature !== lastSignature ||
        now - lastSnapshotAtMilliseconds >= 5_000
      ) {
        recordPhase(label, ok ? "condition-met" : "poll", lastStatus);
        lastSnapshotAtMilliseconds = now;
        lastSignature = signature;
      }
      if (ok) {
        return {
          ok: true,
          elapsedMilliseconds: Date.now() - startedAtMilliseconds,
          lastStatus,
        };
      }
      await page.waitForTimeout(1_000);
    }
    return {
      ok: false,
      elapsedMilliseconds: Date.now() - startedAtMilliseconds,
      timeoutMilliseconds,
      lastStatus,
    };
  }

  async function readStatusSnapshot() {
    return page.evaluate(() =>
      window.__copcBasicViewerBenchmark?.getStatus(),
    );
  }

  function recordPhase(phase, event, status, extra = {}) {
    phaseProgress.push({
      phase,
      event,
      atMilliseconds: Date.now(),
      status: compactStatus(status),
      ...extra,
    });
  }

  function compactStatus(status) {
    if (!status) return undefined;
    return {
      status: status.status,
      cameraStreamRequestId: status.cameraStreamRequestId,
      expectedCameraStreamRequestId: status.expectedCameraStreamRequestId,
      cameraStreamCameraEpoch: status.cameraStreamCameraEpoch,
      cameraStreamCameraPoseFingerprint:
        status.cameraStreamCameraPoseFingerprint,
      cameraStreamRenderedPointCount: status.cameraStreamRenderedPointCount,
      selectedDepth: status.cameraStreamSelectionEvidence?.selectedDepth ??
        status.cameraStreamDiagnosticsData?.selectedDepth,
      frontierNodeCount: status.cameraStreamVisualQuality?.frontierNodeCount,
      selectedNodeCount: status.cameraStreamSelectedNodeKeys?.length,
      requiredNodeCount: status.cameraStreamVisualQuality?.requiredNodeCount,
      renderedNodeCount: status.cameraStreamVisualQuality?.renderedNodeCount,
      isTerminalReady: status.cameraStreamVisualQuality?.isTerminalReady,
      prefetchState: status.cameraStreamPrefetchData?.state,
      prefetchCompleted: status.cameraStreamPrefetchData?.completed,
      renderSignature: status.cameraStreamRenderSignature,
      rendererRevision: status.cameraStreamRendererRevision,
    };
  }

  function createStatusProgressSignature(status) {
    const compact = compactStatus(status);
    return JSON.stringify(compact ?? {});
  }

  function isHighQualityTerminal(status) {
    return status?.cameraStreamVisualQuality?.isTerminalReady === true &&
      (status.cameraStreamSelectionEvidence?.selectedDepth ??
        status.cameraStreamDiagnosticsData?.selectedDepth ?? 0) >=
        qualityGates.minSelectedDepth &&
      (status.cameraStreamRenderedPointCount ?? 0) >=
        qualityGates.minRenderedPointCount &&
      (status.cameraStreamVisualQuality?.requiredNodeCount ?? 0) >=
        qualityGates.minRequiredNodeCount &&
      (status.cameraStreamVisualQuality?.renderedNodeCount ?? 0) >=
        qualityGates.minRequiredNodeCount;
  }

  function remainingPhaseMilliseconds(startedAtMilliseconds) {
    return Math.max(
      1_000,
      phaseTimeoutMilliseconds - (Date.now() - startedAtMilliseconds),
    );
  }

  function compareFreshCameraSignal(before, after) {
    return {
      beforeRequestId: before?.cameraStreamRequestId,
      afterRequestId: after?.cameraStreamRequestId,
      beforeCameraEpoch: before?.cameraStreamCameraEpoch,
      afterCameraEpoch: after?.cameraStreamCameraEpoch,
      beforePoseFingerprint: before?.cameraStreamCameraPoseFingerprint,
      afterPoseFingerprint: after?.cameraStreamCameraPoseFingerprint,
      requestReset:
        Number.isFinite(before?.cameraStreamRequestId) &&
        Number.isFinite(after?.cameraStreamRequestId)
          ? after.cameraStreamRequestId <= before.cameraStreamRequestId
          : undefined,
      cameraEpochReset:
        Number.isFinite(before?.cameraStreamCameraEpoch) &&
        Number.isFinite(after?.cameraStreamCameraEpoch)
          ? after.cameraStreamCameraEpoch <= before.cameraStreamCameraEpoch
          : undefined,
      poseChanged:
        typeof before?.cameraStreamCameraPoseFingerprint === "string" &&
        typeof after?.cameraStreamCameraPoseFingerprint === "string"
          ? after.cameraStreamCameraPoseFingerprint !==
            before.cameraStreamCameraPoseFingerprint
          : undefined,
    };
  }

  function summarizeRanges(targetScope) {
    const records = rangeRequests.filter((record) => record.scope === targetScope);
    return {
      requestCount: records.length,
      requestedBytes: records.reduce(
        (sum, record) => sum + (record.requestedByteLength ?? 0),
        0,
      ),
      responseConfirmedBytes: records.reduce(
        (sum, record) => sum + (record.responseConfirmedByteLength ?? 0),
        0,
      ),
      failedCount: records.filter((record) => record.outcome === "failed").length,
      unfinishedCount: records.filter(
        (record) => record.outcome === "pending",
      ).length,
      invalidResponseCount: records.filter(
        (record) =>
          record.outcome === "finished" &&
          record.responseValidation?.valid !== true,
      ).length,
      statuses: records.map((record) => record.status),
      etags: uniqueDefined(records.map((record) => record.etag)),
      contentRangeTotals: uniqueDefined(
        records.map((record) => record.contentRangeRange?.total),
      ),
    };
  }

  function summarizeEdgeCache(snapshots) {
    const afterCold = snapshots.find((snapshot) => snapshot.label === "after-cold")?.stats;
    const afterWarm = snapshots.find((snapshot) => snapshot.label === "after-edge-warm-browser-cold")?.stats;
    if (!afterCold || !afterWarm) {
      return { available: false };
    }
    return {
      available: true,
      coldOriginRequests: afterCold.originRequests,
      coldValidationRequests: afterCold.validationRequests,
      coldOriginOperations:
        (afterCold.originRequests ?? 0) + (afterCold.validationRequests ?? 0),
      warmCumulativeOriginRequests: afterWarm.originRequests,
      warmCumulativeValidationRequests: afterWarm.validationRequests,
      warmOriginRequests:
        (afterWarm.originRequests ?? 0) - (afterCold.originRequests ?? 0),
      warmValidationRequests:
        (afterWarm.validationRequests ?? 0) - (afterCold.validationRequests ?? 0),
      warmOriginOperations:
        ((afterWarm.originRequests ?? 0) + (afterWarm.validationRequests ?? 0)) -
        ((afterCold.originRequests ?? 0) + (afterCold.validationRequests ?? 0)),
      coldOriginBytes: afterCold.originBytes,
      warmCumulativeOriginBytes: afterWarm.originBytes,
      warmOriginBytes: (afterWarm.originBytes ?? 0) - (afterCold.originBytes ?? 0),
      coldBlockHits: afterCold.blockHits,
      warmCumulativeBlockHits: afterWarm.blockHits,
      warmBlockHits: (afterWarm.blockHits ?? 0) - (afterCold.blockHits ?? 0),
      coldBlockMisses: afterCold.blockMisses,
      warmCumulativeBlockMisses: afterWarm.blockMisses,
      warmBlockMisses: (afterWarm.blockMisses ?? 0) - (afterCold.blockMisses ?? 0),
    };
  }

  function validateRangeResponse(record) {
    const failures = [];
    if (record.outcome === "failed") {
      failures.push("request failed: " + String(record.failure ?? "unknown"));
    }
    if (record.status !== 206) {
      failures.push("status " + String(record.status) + " is not 206");
    }
    if (!record.requestedRange) {
      failures.push("request Range header was malformed");
    }
    if (!record.contentRangeRange) {
      failures.push("Content-Range header was missing or malformed");
    }
    if (record.contentLength === undefined) {
      failures.push("Content-Length header was missing or malformed");
    }
    if (
      record.requestedRange &&
      record.contentRangeRange &&
      (record.contentRangeRange.begin !== record.requestedRange.begin ||
        record.contentRangeRange.end !== record.requestedRange.end)
    ) {
      failures.push("Content-Range does not match requested Range");
    }
    if (
      record.requestedByteLength !== undefined &&
      record.contentLength !== undefined &&
      record.contentLength !== record.requestedByteLength
    ) {
      failures.push("Content-Length does not match requested Range length");
    }
    if (
      record.responseConfirmedByteLength !== undefined &&
      record.requestedByteLength !== undefined &&
      record.responseConfirmedByteLength !== record.requestedByteLength
    ) {
      failures.push("response-confirmed byte length does not match requested Range length");
    }
    return {
      valid: failures.length === 0,
      failures,
    };
  }

  function parseRange(range) {
    const match = /^bytes=(\\d+)-(\\d+)$/.exec(range ?? "");
    if (!match) return undefined;
    return {
      begin: Number(match[1]),
      end: Number(match[2]),
      byteLength: Number(match[2]) - Number(match[1]) + 1,
    };
  }

  function parseRangeByteLength(range) {
    return parseRange(range)?.byteLength;
  }

  function parseContentRange(contentRange) {
    const match = /^bytes (\\d+)-(\\d+)\\/(\\d+|\\*)$/i.exec(contentRange ?? "");
    if (!match) return undefined;
    return {
      begin: Number(match[1]),
      end: Number(match[2]),
      total: match[3] === "*" ? undefined : Number(match[3]),
      byteLength: Number(match[2]) - Number(match[1]) + 1,
    };
  }

  function parseOptionalInteger(value) {
    if (value === undefined) return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
  }

  function uniqueDefined(values) {
    return [...new Set(values.filter((value) => value !== undefined))];
  }

  function readMetadataValue(status, label) {
    const payload = status?.rendererPayload;
    if (typeof payload !== "string") return undefined;
    const line = payload
      .split("\\n")
      .find((candidate) => candidate.startsWith(label + ":"));
    return line?.slice(label.length + 1).trim();
  }
}`;
}

function validateResult(result) {
  const failures = [];
  const isEdgeRangeCacheMode = result.benchmarkMode === "edge-range-cache" ||
    result.mode === "edge-range-cache";
  const coldStatus = result.cold?.status;
  const repeatStatus = result.repeat?.status;
  const coldRanges = result.rangeSummary?.cold;
  const repeatRanges = result.rangeSummary?.repeat;
  const coldNodes = coldStatus?.cameraStreamSelectedNodeKeys ?? [];
  const repeatNodes = repeatStatus?.cameraStreamSelectedNodeKeys ?? [];

  if (result.cacheClearEvidence?.isZeroed !== true) {
    failures.push(
      "Persistent range-cache stats were not zero immediately after clear.",
    );
  }
  if (result.cacheClearEvidence?.browserHttpCacheCleared !== true) {
    failures.push("Cold phase did not report browser HTTP cache clearing.");
  }
  if (result.cold?.completed !== true) {
    failures.push(
      `Cold phase did not complete: ${result.cold?.failureReason ?? "unknown"}.`,
    );
  }
  if (result.repeat?.completed !== true) {
    failures.push(
      `Repeat phase did not complete: ${result.repeat?.failureReason ?? "unknown"}.`,
    );
  }
  if (!coldStatus?.cameraStreamVisualQuality?.isTerminalReady) {
    failures.push("Cold view did not reach terminal visual quality.");
  }
  if (!repeatStatus?.cameraStreamVisualQuality?.isTerminalReady) {
    failures.push("Repeat view did not reach terminal visual quality.");
  }
  failures.push(...validateQualityGates(coldStatus, "Cold"));
  failures.push(...validateQualityGates(repeatStatus, "Repeat"));
  failures.push(...validateFreshReloadSignal(result.reloadEvidence));
  if (
    typeof result.cold?.poseFingerprint !== "string" ||
    result.cold.poseFingerprint.length === 0 ||
    typeof result.repeat?.poseFingerprint !== "string" ||
    result.repeat.poseFingerprint !== result.cold.poseFingerprint
  ) {
    failures.push("Cold and repeat views used different camera pose fingerprints.");
  }
  if (JSON.stringify(coldNodes) !== JSON.stringify(repeatNodes)) {
    failures.push("Cold and repeat views selected different terminal node keys.");
  }
  if (
    typeof coldStatus?.cameraStreamRenderSignature !== "string" ||
    coldStatus.cameraStreamRenderSignature.length === 0 ||
    coldStatus.cameraStreamRenderSignature !==
      repeatStatus?.cameraStreamRenderSignature
  ) {
    failures.push("Cold and repeat views used different render signatures.");
  }
  if (
    coldStatus?.cameraStreamRenderedPointCount !==
    repeatStatus?.cameraStreamRenderedPointCount
  ) {
    failures.push("Cold and repeat views rendered different point counts.");
  }
  if (result.cold?.selectedDepth !== result.repeat?.selectedDepth) {
    failures.push("Cold and repeat views selected different terminal depths.");
  }
  if (result.cold?.frontierNodeCount !== result.repeat?.frontierNodeCount) {
    failures.push("Cold and repeat views reported different frontier node counts.");
  }
  if (
    coldStatus?.cameraStreamVisualQuality?.requiredNodeCount !==
      repeatStatus?.cameraStreamVisualQuality?.requiredNodeCount ||
    coldStatus?.cameraStreamVisualQuality?.renderedNodeCount !==
      repeatStatus?.cameraStreamVisualQuality?.renderedNodeCount
  ) {
    failures.push("Cold and repeat views reported different required/rendered node counts.");
  }
  if (
    result.cold?.sourceEvidence?.sourceUrl !==
    result.repeat?.sourceEvidence?.sourceUrl
  ) {
    failures.push("Cold and repeat views used different source URLs.");
  }
  failures.push(
    ...validateMatchingOptionalArray(
      result.cold?.validatorEvidence?.etags,
      result.repeat?.validatorEvidence?.etags,
      "Cold and repeat Range validators differed.",
    ),
  );
  failures.push(
    ...validateMatchingOptionalArray(
      result.cold?.validatorEvidence?.contentRangeTotals,
      result.repeat?.validatorEvidence?.contentRangeTotals,
      "Cold and repeat source byte lengths differed.",
    ),
  );
  if (!(result.repeat?.cacheStats?.hits > 0)) {
    failures.push("Repeat view reported no persistent range-cache hits.");
  }
  if (!(coldRanges?.requestCount > 0) || !(coldRanges?.requestedBytes > 0)) {
    failures.push("Cold view recorded no upstream Range traffic.");
  }
  if (!(coldRanges?.responseConfirmedBytes > 0)) {
    failures.push("Cold view recorded no response-confirmed upstream bytes.");
  }
  if ((coldRanges?.invalidResponseCount ?? 0) > 0) {
    failures.push("Cold view recorded invalid HTTP Range response metadata.");
  }
  if ((repeatRanges?.invalidResponseCount ?? 0) > 0) {
    failures.push("Repeat view recorded invalid HTTP Range response metadata.");
  }
  if ((coldRanges?.failedCount ?? 0) > 0 || (repeatRanges?.failedCount ?? 0) > 0) {
    failures.push("A measured upstream Range request failed.");
  }
  if (
    (coldRanges?.unfinishedCount ?? 0) > 0 ||
    (repeatRanges?.unfinishedCount ?? 0) > 0
  ) {
    failures.push("A measured upstream Range request did not finish.");
  }
  if (
    !isEdgeRangeCacheMode &&
    !(repeatRanges?.requestedBytes <= coldRanges?.requestedBytes * 0.1)
  ) {
    failures.push("Repeat upstream Range bytes were not reduced by at least 90%.");
  }
  if (
    !isEdgeRangeCacheMode &&
    !(
      repeatRanges?.responseConfirmedBytes <=
      coldRanges?.responseConfirmedBytes * 0.1
    )
  ) {
    failures.push(
      "Repeat response-confirmed Range bytes were not reduced by at least 90%.",
    );
  }
  if (isEdgeRangeCacheMode) {
    failures.push(...validateEdgeRangeCacheResult(result, coldRanges, repeatRanges));
  }
  if (!hasExactPointHashEvidence(result.cold?.pointHashEvidence)) {
    failures.push("Cold view did not report an exact terminal render-input hash.");
  }
  if (!hasExactPointHashEvidence(result.repeat?.pointHashEvidence)) {
    failures.push("Repeat view did not report an exact terminal render-input hash.");
  }
  if (
    hasExactPointHashEvidence(result.cold?.pointHashEvidence) &&
    hasExactPointHashEvidence(result.repeat?.pointHashEvidence) &&
    result.cold.pointHashEvidence.terminalRenderInputHash !==
      result.repeat.pointHashEvidence.terminalRenderInputHash
  ) {
    failures.push("Cold and repeat views produced different terminal render-input hashes.");
  }
  if (result.consoleProblems?.length > 0) {
    failures.push("Browser console warnings or errors were recorded.");
  }
  if (result.pageErrors?.length > 0) {
    failures.push("Browser page errors were recorded.");
  }

  return failures;
}

function validateEdgeRangeCacheResult(result, coldRanges, repeatRanges) {
  const failures = [];
  const edge = result.edgeCacheSummary;

  if (result.browserCacheResetEvidence?.browserHttpCacheCleared !== true) {
    failures.push("Edge warm phase did not report browser HTTP cache clearing.");
  }
  if (result.browserCacheResetEvidence?.isPersistentStoreZeroed !== true) {
    failures.push("Edge warm phase did not start from a zeroed persistent range-cache store.");
  }
  if (!(repeatRanges?.requestCount > 0) || !(repeatRanges?.requestedBytes > 0)) {
    failures.push("Edge warm/browser-cold phase recorded no browser Range traffic.");
  }
  if (!(repeatRanges?.requestCount >= coldRanges?.requestCount * 0.9)) {
    failures.push(
      "Edge warm/browser-cold Range request volume was below 90% of cold.",
    );
  }
  if (
    !(
      repeatRanges?.responseConfirmedBytes >=
      coldRanges?.responseConfirmedBytes * 0.9
    )
  ) {
    failures.push(
      "Edge warm/browser-cold response-confirmed bytes were below 90% of cold.",
    );
  }
  if (edge?.available !== true) {
    failures.push("Edge cache stats were not recorded.");
    return failures;
  }
  if (!(edge.coldOriginRequests > 0) || !(edge.coldOriginBytes > 0)) {
    failures.push("Edge cold phase recorded no origin Range traffic.");
  }
  if (!(edge.warmBlockHits > 0)) {
    failures.push("Edge warm/browser-cold phase reported no edge block hits.");
  }
  if (!(edge.warmOriginOperations <= edge.coldOriginOperations * 0.1)) {
    failures.push("Edge warm origin operations were not reduced by at least 90%.");
  }
  if (!(edge.warmOriginBytes <= edge.coldOriginBytes * 0.1)) {
    failures.push("Edge warm origin bytes were not reduced by at least 90%.");
  }
  if (
    !(
      Number.isFinite(result.cold?.elapsedMilliseconds) &&
      Number.isFinite(result.repeat?.elapsedMilliseconds) &&
      result.repeat.elapsedMilliseconds <= result.cold.elapsedMilliseconds * 0.2
    )
  ) {
    failures.push("Edge warm/browser-cold elapsed time was not reduced by at least 80%.");
  }

  return failures;
}

function validateQualityGates(status, label) {
  const failures = [];
  const selectedDepth =
    status?.cameraStreamSelectionEvidence?.selectedDepth ??
    status?.cameraStreamDiagnosticsData?.selectedDepth;
  const renderedPointCount = status?.cameraStreamRenderedPointCount;
  const requiredNodeCount =
    status?.cameraStreamVisualQuality?.requiredNodeCount;
  const renderedNodeCount =
    status?.cameraStreamVisualQuality?.renderedNodeCount;

  if (!(selectedDepth >= 5)) {
    failures.push(`${label} selected depth ${formatValue(selectedDepth)} < 5.`);
  }
  if (!(renderedPointCount >= 300_000)) {
    failures.push(
      `${label} rendered point count ${formatValue(renderedPointCount)} < 300000.`,
    );
  }
  if (!(requiredNodeCount >= 64)) {
    failures.push(
      `${label} required node count ${formatValue(requiredNodeCount)} < 64.`,
    );
  }
  if (!(renderedNodeCount >= 64)) {
    failures.push(
      `${label} rendered node count ${formatValue(renderedNodeCount)} < 64.`,
    );
  }

  return failures;
}

function validateFreshReloadSignal(reloadEvidence) {
  const signal = reloadEvidence?.freshCameraSignal;
  if (!signal || typeof signal !== "object") {
    return ["Reload did not report fresh camera/request signal evidence."];
  }

  const checks = [
    signal.requestReset,
    signal.cameraEpochReset,
  ].filter((value) => value !== undefined);

  if (checks.length === 0) {
    return [
      "Reload fresh camera/request signal could not be asserted from exposed status fields.",
    ];
  }

  if (!checks.some((value) => value === true)) {
    return [
      "Reload did not reset or change any exposed camera/request/layer status signal.",
    ];
  }

  return [];
}

function validateMatchingOptionalArray(left, right, message) {
  if (!Array.isArray(left) || !Array.isArray(right)) return [];
  if (left.length === 0 || right.length === 0) return [];
  return JSON.stringify(left) === JSON.stringify(right) ? [] : [message];
}

function hasExactPointHashEvidence(evidence) {
  return evidence?.exactPointHashAvailable === true &&
    evidence.hashKind === "terminal-render-geometry-input:v1:dual32" &&
    typeof evidence.terminalRenderInputHash === "string" &&
    /^[0-9a-f]{16}$/.test(evidence.terminalRenderInputHash) &&
    typeof evidence.sourceUrl === "string" &&
    typeof evidence.cameraPoseFingerprint === "string" &&
    Array.isArray(evidence.selectedNodeKeys) &&
    Number.isFinite(evidence.renderedPointCount);
}

function formatValue(value) {
  return value === undefined ? "missing" : String(value);
}

function printSummary(result) {
  const cold = result.rangeSummary.cold;
  const repeat = result.rangeSummary.repeat;
  const repeatLabel = result.benchmarkMode === "edge-range-cache"
    ? "edge-warm/browser-cold"
    : "repeat";
  const reduction = cold.requestedBytes > 0
    ? (1 - repeat.requestedBytes / cold.requestedBytes) * 100
    : 0;
  console.log(`${result.benchmarkMode ?? "persistent-range-cache"} benchmark: ${result.verdict}`);
  console.log(
    `- cold: ${result.cold.elapsedMilliseconds.toLocaleString()} ms, ` +
      `${cold.requestCount} ranges, ${cold.requestedBytes.toLocaleString()} bytes`,
  );
  console.log(
    `- ${repeatLabel}: ${result.repeat.elapsedMilliseconds.toLocaleString()} ms, ` +
      `${repeat.requestCount} ranges, ${repeat.requestedBytes.toLocaleString()} bytes`,
  );
  console.log(`- browser Range byte reduction: ${reduction.toFixed(2)}%`);
  if (result.edgeCacheSummary?.available === true) {
    console.log(
      `- edge origin operations: ${result.edgeCacheSummary.coldOriginOperations} cold, ` +
        `${result.edgeCacheSummary.warmOriginOperations} warm`,
    );
    console.log(
      `- edge origin GET requests: ${result.edgeCacheSummary.coldOriginRequests} cold, ` +
        `${result.edgeCacheSummary.warmOriginRequests} warm`,
    );
    console.log(
      `- edge origin bytes: ${result.edgeCacheSummary.coldOriginBytes.toLocaleString()} cold, ` +
        `${result.edgeCacheSummary.warmOriginBytes.toLocaleString()} warm`,
    );
  }
  console.log(`- result: ${resultPath}`);
  for (const failure of result.failures) console.error(`- ${failure}`);
}

async function startEdgeRangeCacheServer(port) {
  const { createCopcEdgeRangeCache } = await import("./copc-edge-range-cache.mjs");
  const cache = createCopcEdgeRangeCache({
    routes: {
      "/hobu-lidar/millsite.copc.laz":
        "https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz",
    },
    blockByteLength: 64 * 1024,
    onError: (error) => {
      output.push(`${error?.stack ?? error}\n`);
    },
  });
  const output = [];
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === "/__copc_edge_cache_stats") {
        await writeNodeResponse(
          response,
          new Response(JSON.stringify(cache.getStats()), {
            status: 200,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "no-store",
              "Content-Type": "application/json; charset=utf-8",
            },
          }),
        );
        return;
      }

      const handled = await cache.handle(createWebRequest(request, port));
      await writeNodeResponse(response, handled);
    } catch (error) {
      output.push(`${error?.stack ?? error}\n`);
      response.writeHead(500, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Edge range cache server error");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "localhost", resolve);
  });

  return {
    output,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function createWebRequest(request, port) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return new Request(`http://localhost:${port}${request.url}`, {
    method: request.method,
    headers,
  });
}

async function writeNodeResponse(nodeResponse, webResponse) {
  const headers = {};
  webResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });
  nodeResponse.writeHead(webResponse.status, headers);
  if (webResponse.body === null) {
    nodeResponse.end();
    return;
  }
  const bytes = new Uint8Array(await webResponse.arrayBuffer());
  nodeResponse.end(bytes);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: isWindows,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}.`);
  }
}

function runPlaywrightCli(args) {
  const result = spawnSync(process.execPath, [playwrightCliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `playwright-cli ${args.join(" ")} failed.\n${result.stdout}\n${result.stderr}`,
    );
  }
  return `${result.stdout}\n${result.stderr}`;
}

function runPlaywrightCliAsync(args, timeoutMilliseconds) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCliPath, ...args], {
      cwd: repoRoot,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    let outputBytes = 0;
    let settled = false;
    const maxOutputBytes = 32 * 1024 * 1024;
    const timeout = setTimeout(() => {
      terminateProcessTree(child);
      settle(() => reject(new Error(
        `playwright-cli ${args.join(" ")} timed out after ${timeoutMilliseconds} ms.`,
      )));
    }, timeoutMilliseconds);
    child.stdout.on("data", collectOutput);
    child.stderr.on("data", collectOutput);
    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (status) => {
      settle(() => {
        const text = output.join("");
        if (status !== 0) {
          reject(
            new Error(
              `playwright-cli ${args.join(" ")} failed.\n${text}`,
            ),
          );
          return;
        }
        resolve(text);
      });
    });

    function settle(action) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      action();
    }

    function collectOutput(data) {
      if (settled) return;
      outputBytes += data.byteLength;
      if (outputBytes > maxOutputBytes) {
        terminateProcessTree(child);
        settle(() => reject(
          new Error(
            `playwright-cli ${args.join(" ")} exceeded ${maxOutputBytes} output bytes.`,
          ),
        ));
        return;
      }
      output.push(data.toString());
    }
  });
}

function extractPlaywrightResult(output) {
  const marker = "### Result";
  const index = output.lastIndexOf(marker);
  if (index < 0) throw new Error(`Playwright result marker was missing.\n${output}`);
  const outputAfterMarker = output.slice(index + marker.length);
  const jsonStart = outputAfterMarker.search(/[\[{]/);
  if (jsonStart < 0) throw new Error(`Playwright JSON result was missing.\n${output}`);
  const jsonText = outputAfterMarker.slice(jsonStart);
  let depth = 0;
  let isInsideString = false;
  let isEscaped = false;
  for (let offset = 0; offset < jsonText.length; offset += 1) {
    const character = jsonText[offset];
    if (isInsideString) {
      if (isEscaped) isEscaped = false;
      else if (character === "\\") isEscaped = true;
      else if (character === '"') isInsideString = false;
      continue;
    }
    if (character === '"') {
      isInsideString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return JSON.parse(jsonText.slice(0, offset + 1));
    }
  }
  throw new Error(`Playwright JSON result was incomplete.\n${output}`);
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error("No available benchmark port was found.");
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function waitForServer(url, processHandle, output) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Preview server exited.\n${output.join("")}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Retry while Vite starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function waitForUrl(url, output = []) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Retry while the local server starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}.\n${output.join("")}`);
}

function stopServer(processHandle) {
  terminateProcessTree(processHandle);
}

function terminateProcessTree(processHandle) {
  if (!processHandle.pid || processHandle.exitCode !== null) return;
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(processHandle.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 10_000,
    });
  } else {
    processHandle.kill("SIGTERM");
  }
}
