import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const benchmarkScriptPath = path.join(scriptDir, "benchmark-smoothness.mjs");
const smoothnessQcScriptPath = path.join(scriptDir, "smoothness-qc.mjs");
const basicViewerMainPath = path.join(
  scriptDir,
  "..",
  "examples",
  "basic-viewer",
  "src",
  "main.ts",
);

test("generated flow binds measured status to the expected request and preserves it across prefetch", async () => {
  const flow = await createGeneratedFlow();

  assert.doesNotThrow(() => new Function(`return (${flow})`));
  assert.match(flow, /status\.cameraStreamRequestId < targetRequestId/);
  assert.match(flow, /status\.cameraStreamCameraEpoch !== targetCameraEpoch/);
  assert.match(
    flow,
    /status\.cameraStreamCameraPoseFingerprint !==\s*targetCameraPoseFingerprint/,
  );
  assert.match(
    flow,
    /status\.cameraStreamVisualQuality\?\.isTerminalReady === true/,
  );
  assert.match(
    flow,
    /status\.cameraStreamDetailProgress\?\.isComplete === true/,
  );
  assert.match(
    flow,
    /const prefetchStatus = await waitForCameraStreamPrefetch/,
  );
  assert.doesNotMatch(
    flow,
    /measurement\.status = await waitForCameraStreamPrefetch/,
  );
  assert.match(
    flow,
    /parseGeometryCacheCounters\(\s*measuredStatus\.geometryCache/,
  );
  assert.match(flow, /cameraStreamPrefetchText: prefetchStatus\./);
  assert.match(
    flow,
    /measuredStatus\.cameraStreamRenderDisposition\?\.startsWith\(\s*"retained-"/,
  );
  assert.match(
    flow,
    /\? measuredStatus\.cameraStreamRenderDisposition\s*: "camera-stream-node-sample-cache"/,
  );
  assert.match(
    flow,
    /cameraStreamNodeReuse\.freshCachedFinalNodeCount ===\s*cameraStreamNodeReuse\.finalNodeCount/,
  );
  assert.match(
    flow,
    /cacheHitCount: cameraStreamNodeReuse\.freshCachedFinalNodeCount/,
  );
  assert.doesNotMatch(flow, /evidenceSource: "geometry-cache-delta"/);
  assert.match(flow, /status: measuredStatus,/);
  assert.match(flow, /prefetchStatus,/);
  assert.match(flow, /postPrefetchRefinement,/);
  assert.match(
    flow,
    /initialStatus\?\.cameraStreamForegroundCompletionMilliseconds/,
  );
  assert.match(flow, /cameraStreamForegroundCompletionMilliseconds,/);
  assert.match(flow, /cacheReset = await benchmark\.clearStreamingCaches/);
  assert.match(
    flow,
    /expectedFirstResponseSource =\s*cameraStreamFirstResponseEvidence\?\.renderDisposition/,
  );
  assert.match(flow, /"app-render-retained"/);
  assert.match(
    flow,
    /Number\.isSafeInteger\(\s*cameraStreamFirstResponseEvidence\?\.rendererRevision/,
  );
  assert.match(
    flow,
    /cameraStreamFirstResponseEvidence\.appliedRequestId !==\s*expectedCameraStreamRequestId/,
  );
  assert.match(flow, /observedRequestId > initialRequestId/);
  assert.match(flow, /observedCameraEpoch === initialCameraEpoch/);
  assert.match(
    flow,
    /observedCameraPoseFingerprint === initialCameraPoseFingerprint/,
  );
  assert.match(
    flow,
    /renderedPointCount: parseCameraStreamPointCount\(status\?\.status\)/,
  );
  assert.match(
    flow,
    /measuredStatus\.cameraStreamRenderedPointCount \?\?\s*parseCameraStreamPointCount\(measuredStatus\.status\)/,
  );
  assert.match(flow, /selectedDepth: diagnostics\?\.selectedDepth/);
  assert.match(flow, /visualQuality,/);
  assert.match(
    flow,
    /hasFinalCameraStreamResult\(\s*measuredStatus,\s*expectedCameraStreamRequestId,\s*expectedCameraStreamCameraEpoch,\s*expectedCameraStreamCameraPoseFingerprint/,
  );
  assert.match(
    flow,
    /hasInteractiveCameraStreamResult\(\s*measuredStatus,\s*expectedCameraStreamRequestId,\s*expectedCameraStreamCameraEpoch,\s*expectedCameraStreamCameraPoseFingerprint/,
  );
  assert.match(
    flow,
    /createCameraStreamCompletion\(\s*measuredStatus,\s*expectedCameraStreamRequestId,\s*expectedCameraStreamCameraEpoch,\s*expectedCameraStreamCameraPoseFingerprint,\s*waitedForMeasuredStatus/,
  );
  assert.match(flow, /status\.includes\("Camera stream terminal rendered"\)/);
  assert.match(flow, /status\.includes\("Camera stream interactive-ready"\)/);
});

test("cold-detail waits for and gates the refined same-camera terminal", async () => {
  const benchmarkSource = await readFile(benchmarkScriptPath, "utf8");
  const qcSource = await readFile(smoothnessQcScriptPath, "utf8");
  const coldDetailStart = qcSource.indexOf("coldDetail: {");
  const zoomDetailStart = qcSource.indexOf("zoomDetail: {", coldDetailStart);
  const coldDetailPreset = qcSource.slice(coldDetailStart, zoomDetailStart);

  assert.match(benchmarkSource, /COPC_SMOOTHNESS_PREFETCH_WAIT_TIMEOUT_MS/);
  assert.match(
    coldDetailPreset,
    /COPC_SMOOTHNESS_PREFETCH_WAIT_TIMEOUT_MS: "30000"/,
  );
  assert.match(
    coldDetailPreset,
    /COPC_SMOOTHNESS_ASSERT_REQUIRE_POST_PREFETCH_REFINEMENT: "1"/,
  );
  assert.match(
    coldDetailPreset,
    /COPC_SMOOTHNESS_ASSERT_MIN_POST_PREFETCH_SELECTED_DEPTH: "5"/,
  );
  assert.match(
    coldDetailPreset,
    /COPC_SMOOTHNESS_ASSERT_MIN_POST_PREFETCH_RENDERED_POINTS: "300000"/,
  );
});

test("generated fallback parses the terminal additive camera-stream status", async () => {
  const flow = await createGeneratedFlow();
  const parseCameraStreamPointCount = extractGeneratedFunction(
    flow,
    "parseCameraStreamPointCount",
    "isCameraStreamInteractiveStatus",
  );
  const parseCameraStreamDetailProgress = extractGeneratedFunction(
    flow,
    "parseCameraStreamDetailProgress",
    "parseCameraStreamDiagnostics",
  );

  assert.deepEqual(
    parseCameraStreamDetailProgress(
      "Camera stream terminal rendered 340,708 points from the complete 17-node additive set (12 frontier nodes, wide zoom).",
    ),
    {
      finalNodeCount: 12,
      renderedFinalNodeCount: 12,
      renderedFinalNodeCoverageRatio: 1,
      reachedRenderBudget: false,
      isComplete: true,
    },
  );
  assert.equal(
    parseCameraStreamPointCount(
      "Camera stream hierarchy-refining with 352,441 points from the complete current 95-node additive set (60 frontier nodes, 3 visible hierarchy pages still loading, close zoom).",
    ),
    352_441,
  );
});

test("generated flow keeps one frame collector through measured request completion", async () => {
  const flow = await createGeneratedFlow();
  const measureStart = flow.indexOf("async function measureSmoothness(");
  const terminalWait = flow.indexOf(
    "measuredStatus = await waitForCameraStreamStatus(",
    measureStart,
  );
  const interactiveWait = flow.indexOf(
    "measuredStatus = await waitForCameraStreamInteractiveStatus(",
    measureStart,
  );
  const collectorStop = flow.indexOf(
    "frameCollection = await stopSmoothnessFrameCollector(",
    measureStart,
  );
  const prefetchWait = flow.indexOf(
    "const prefetchStatus = await waitForCameraStreamPrefetch(",
    measureStart,
  );

  assert.notEqual(measureStart, -1);
  assert.ok(terminalWait > measureStart);
  assert.ok(interactiveWait > terminalWait);
  assert.ok(collectorStop > terminalWait);
  assert.ok(collectorStop > interactiveWait);
  assert.ok(prefetchWait > collectorStop);
  assert.match(
    flow,
    /frameCollector\.markCameraMovementCompleted\(\s*status\?\.cameraMovementCompletedAtMilliseconds/,
  );
  assert.match(
    flow,
    /finally \{\s*frameCollection = await stopSmoothnessFrameCollector\(/,
  );
  assert.match(flow, /frameDeltas: frameCollection\.cameraMovementFrameDeltas/);
  assert.match(
    flow,
    /terminalRefinementFrameDeltas:\s*frameCollection\.terminalRefinementFrameDeltas/,
  );
  assert.match(
    flow,
    /terminalRefinementSummary: summarizeFrames\(\s*measurement\.terminalRefinementFrameDeltas/,
  );
  assert.match(flow, /summary: summarizeFrames\(measurement\.frameDeltas\)/);
  assert.match(flow, /window\.cancelAnimationFrame\(animationFrameId\)/);
  assert.match(flow, /delete window\.__copcSmoothnessFrameCollector/);
  assert.match(flow, /frameEndTimestamps\.push\(timestamp\)/);
  assert.match(flow, /frameDeltaMilliseconds > 50/);
  assert.match(flow, /longFrameEvidence\.push\(\{/);
  assert.match(flow, /phase:.*terminal-refinement/s);
  assert.match(flow, /longFrameEvidence: frameCollection\.longFrameEvidence/);
  assert.match(
    flow,
    /frameEndTimestamps\.findIndex\([\s\S]*timestamp > cameraMovementCompletedAtMilliseconds/,
  );
  assert.match(
    flow,
    /window\.__copcSmoothnessFrameCollectors = frameCollectorRegistry/,
  );
  assert.match(
    flow,
    /frameCollectorRegistry\?\.get\(expectedFrameCollectorId\)/,
  );
});

test("basic viewer marks camera movement complete before final stream refinement", async () => {
  const source = await readFile(basicViewerMainPath, "utf8");
  const movementLoop = source.indexOf(
    "for (let index = 0; index < steps; index += 1)",
  );
  const completionMarker = source.indexOf(
    "const cameraMovementCompletedAtMilliseconds = performance.now();",
    movementLoop,
  );
  const foregroundRender = source.indexOf(
    "await renderAutomaticNodeSetForCameraMove(",
    completionMarker,
  );
  const firstVisibleResponse = source.indexOf(
    "cameraStreamFirstResponseMilliseconds =",
    foregroundRender,
  );
  const foregroundCompletion = source.indexOf(
    "const cameraStreamForegroundCompletionMilliseconds =",
    firstVisibleResponse,
  );
  const firstResponseSettle = source.indexOf(
    "await delayForBenchmark(200)",
    foregroundCompletion,
  );
  const returnedMarker = source.indexOf(
    "cameraMovementCompletedAtMilliseconds,",
    firstResponseSettle,
  );

  assert.notEqual(movementLoop, -1);
  assert.ok(completionMarker > movementLoop);
  assert.ok(foregroundRender > completionMarker);
  assert.ok(firstVisibleResponse > foregroundRender);
  assert.ok(foregroundCompletion > firstVisibleResponse);
  assert.ok(firstResponseSettle > foregroundCompletion);
  assert.ok(returnedMarker > firstResponseSettle);
  assert.match(
    source,
    /renderDisposition !== "new-render"\s*\? "app-render-retained"\s*: "app-render-commit"/,
  );
  assert.match(source, /renderDisposition,/);
  assert.match(
    source,
    /rendererRevision:\s*responseStatus\.cameraStreamRendererRevision/,
  );
  assert.match(
    source,
    /appliedRequestId: responseStatus\.cameraStreamRequestId/,
  );
  assert.doesNotMatch(
    source,
    /cameraStreamFirstResponseMilliseconds \?\?=\s*cameraStreamForegroundCompletionMilliseconds/,
  );
  assert.match(
    source,
    /const canRetainCurrentGeometryUntilNewDetail =\s*hierarchyFollowup/,
  );
  assert.match(
    source,
    /skipInitialProgressRender: canRetainCurrentGeometryUntilNewDetail/,
  );
  assert.match(source, /const canRetainCachedCoverage =\s*hierarchyFollowup/);
  assert.match(
    source,
    /cachedProgressNodeResults\.length > 0 &&\s*!canRetainCachedCoverage/,
  );
  assert.match(
    source,
    /\.filter\(\(nodeResult\) => !finalNodeKeySet\.has\(nodeResult\.nodeKey\)\)/,
  );
  assert.match(source, /renderDisposition: "retained-progress-render"/);
  assert.match(source, /preserveCommittedRenderState: true/);
  assert.match(
    source,
    /options\.visualQuality && !options\.preserveCommittedRenderState/,
  );
  assert.match(
    source,
    /committedPointCountByNodeKey\.get\(candidate\.nodeKey\)/,
  );
  assert.match(
    source,
    /committedRender\.renderSignature === renderSignature &&\s*committedRender\.detailProgress\?\.isComplete === true/,
  );
  assert.match(
    source,
    /renderSignature: lastCameraStreamRenderSignature/,
  );
  assert.match(source, /detailProgress: options\.detailProgress/);
  assert.match(
    source,
    /canReuseCameraStreamCommittedRender\(\{/,
  );
  assert.match(
    source,
    /committedRender\.rendererRevision === layer\.getRendererRevision\(\)/,
  );
  assert.match(
    source,
    /abortSupersededRenderRequests\(previousRequest\)/,
  );
});

test("warm measurements hold one settled hierarchy across exact repeat signatures", async () => {
  const flow = await createGeneratedFlow({ warmupRunCount: 1 });
  const warmupMeasure = flow.indexOf(
    '"warmup",',
    flow.indexOf("for (const streamPointBudget"),
  );
  const warmupSettle = flow.indexOf(
    "const settle = await settleWarmupPrefetch();",
    warmupMeasure,
  );
  const hierarchyHold = flow.indexOf(
    "hierarchyHold = await holdWarmCameraHierarchy();",
    warmupSettle,
  );
  const measuredLoop = flow.indexOf(
    "for (let runIndex = 1; runIndex <= repeatCount; runIndex += 1)",
    hierarchyHold,
  );
  const hierarchyRelease = flow.indexOf(
    "await releaseWarmCameraHierarchy();",
    measuredLoop,
  );

  assert.ok(warmupMeasure > -1);
  assert.ok(warmupSettle > warmupMeasure);
  assert.ok(hierarchyHold > warmupSettle);
  assert.ok(measuredLoop > hierarchyHold);
  assert.ok(hierarchyRelease > measuredLoop);
  assert.match(flow, /prefetch\?\.state === "completed"/);
  assert.match(flow, /result\.cameraStreamRenderSignature/);
  assert.match(flow, /result\.cameraStreamSelectedNodeKeys/);
  assert.match(flow, /result\.hierarchyCacheAfterPrefetch/);
  assert.match(
    flow,
    /did not reuse the exact warm frontier and additive render signature/,
  );
  assert.match(
    flow,
    /finally \{[\s\S]*if \(hierarchyHold\) \{[\s\S]*releaseWarmCameraHierarchy/,
  );
});

test("basic viewer hierarchy hold skips only hierarchy growth", async () => {
  const source = await readFile(basicViewerMainPath, "utf8");
  const prefetchStart = source.indexOf(
    "async function prefetchCameraHierarchy(",
  );
  const holdBranch = source.indexOf(
    "benchmarkHierarchyHoldLayer === layer",
    prefetchStart,
  );
  const hierarchyExpansion = source.indexOf(
    "layer.expandHierarchyForCamera",
    holdBranch,
  );
  const geometryPrefetch = source.indexOf(
    "await prefetchCameraNodeSamples(",
    hierarchyExpansion,
  );

  assert.ok(prefetchStart > -1);
  assert.ok(holdBranch > prefetchStart);
  assert.ok(hierarchyExpansion > holdBranch);
  assert.ok(geometryPrefetch > hierarchyExpansion);
  assert.match(source, /lastCameraStreamRenderSignature = renderSignature/);
  assert.match(
    source,
    /cameraStreamSelectedNodeKeys: \[\.\.\.lastCameraStreamSelectedNodeKeys\]/,
  );
  assert.match(source, /cachedFinalNodeCount: initialNodeResults\.length/);
  assert.match(source, /freshCachedFinalNodeCount,/);
  assert.doesNotMatch(
    source,
    /if \(lastCameraStreamPrefetchStatus\?\.completed\) \{\s*return;/,
  );
});

test("benchmark report records the current artifact schema", async () => {
  const source = await readFile(benchmarkScriptPath, "utf8");

  assert.match(
    source,
    /const benchmarkArtifactSchema = "copc-viewer\.smoothness-benchmark";/,
  );
  assert.match(source, /const benchmarkArtifactSchemaVersion = 1;/);
  assert.match(
    source,
    /const report = \{[\s\S]*schema: benchmarkArtifactSchema,[\s\S]*schemaVersion: benchmarkArtifactSchemaVersion,/,
  );
});

test("generated frame summary safely represents an empty refinement interval", async () => {
  const flow = await createGeneratedFlow();
  const summarizeFrames = extractGeneratedFunction(
    flow,
    "summarizeFrames",
    "parseCameraStreamPointCount",
  );

  assert.deepEqual(summarizeFrames([]), {
    frameCount: 0,
    averageFrameMilliseconds: 0,
    medianFrameMilliseconds: 0,
    p95FrameMilliseconds: 0,
    maxFrameMilliseconds: 0,
    estimatedAverageFps: 0,
    frameDeltasOver50Milliseconds: 0,
    frameDeltasOver100Milliseconds: 0,
  });
});

async function createGeneratedFlow(options = {}) {
  const source = await readFile(benchmarkScriptPath, "utf8");
  const start = source.indexOf("function createSmoothnessFlow(");
  const end = source.indexOf("\nfunction average(", start);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const createSmoothnessFlow = eval(
    `${source.slice(start, end)}\ncreateSmoothnessFlow;`,
  );

  return createSmoothnessFlow(
    "http://localhost:4373",
    360_000,
    [360_000],
    "typed",
    [],
    "contest",
    1,
    options.warmupRunCount ?? 0,
    30_000,
    1_200,
    12,
    10,
    550,
    5,
    "none",
    true,
    120_000,
    120_000,
    5_000,
  );
}

function extractGeneratedFunction(flow, functionName, nextFunctionName) {
  const start = flow.indexOf(`function ${functionName}(`);
  const end = flow.indexOf(`function ${nextFunctionName}(`, start);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  return eval(`(${flow.slice(start, end)})`);
}
