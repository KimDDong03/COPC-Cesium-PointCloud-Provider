import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { LIVE_COPC_SAMPLE_URLS } from "../config/live-copc-sources.mjs";
import {
  isExpectedNonFatalWebGlDriverWarning as expectedNonFatalWebGlDriverWarning,
} from "./browser-console-policy.mjs";

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

test("Playwright output buffering covers repeated smoothness evidence", async () => {
  const benchmarkSource = await readFile(benchmarkScriptPath, "utf8");

  assert.match(benchmarkSource, /maxBuffer: 64 \* 1024 \* 1024/);
});

test("smoothness benchmark can record an explicit headed hardware run", async () => {
  const benchmarkSource = await readFile(benchmarkScriptPath, "utf8");

  assert.match(benchmarkSource, /COPC_BROWSER_HEADED/);
  assert.match(benchmarkSource, /browserIsHeaded:/);
  assert.match(benchmarkSource, /browserGpuRendererPattern:/);
  assert.match(benchmarkSource, /browserHeaded \? \["--headed"\] : \[\]/);
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

test("camera stream commits update dynamic metadata without rebuilding the inspection panel", async () => {
  const source = await readFile(basicViewerMainPath, "utf8");
  const benchmarkSource = await readFile(benchmarkScriptPath, "utf8");
  const applyStart = source.indexOf(
    "function applyCameraStreamRenderResult(options:",
  );
  const applyEnd = source.indexOf(
    "function updateCameraStreamMetadataRows(",
    applyStart,
  );
  const applySource = source.slice(applyStart, applyEnd);
  const metadataEnd = source.indexOf(
    "function recordCameraStreamApplyTiming(",
    applyEnd,
  );
  const metadataSource = source.slice(applyEnd, metadataEnd);

  assert.notEqual(applyStart, -1);
  assert.ok(applyEnd > applyStart);
  assert.ok(metadataEnd > applyEnd);
  assert.doesNotMatch(applySource, /renderInspection\(/);
  assert.doesNotMatch(applySource, /updateSuggestedNode\(/);
  assert.match(applySource, /updateCameraStreamMetadataRows\(options\)/);
  assert.match(applySource, /recordCameraStreamApplyTiming\(\{/);
  for (const rowLabel of [
    "Point renderer",
    "Renderer timing",
    "Renderer payload",
    "Point geometry timing",
    "Point geometry cache",
    "Decoded worker cache",
    "Camera stream diagnostics",
    "Camera stream coverage",
    "Camera stream visual quality",
    "Camera stream prefetch",
    "Camera stream budget",
    "Camera stream LOD",
    "Hierarchy pages",
    "Point cache",
    "Render set",
    "Auto LOD",
  ]) {
    assert.match(metadataSource, new RegExp(`"${rowLabel}"`));
  }
  assert.match(
    source,
    /cameraStreamApplyTiming: lastCameraStreamApplyTiming/,
  );
  assert.match(
    source,
    /hierarchyPageLoadStats: currentLayer\?\.source\.getHierarchyPageLoadStats\(\)/,
  );
  assert.match(
    benchmarkSource,
    /cameraStreamApplyTiming: status\?\.cameraStreamApplyTiming/,
  );
});

test("basic viewer keeps a committed render stable during movement", async () => {
  const source = await readFile(basicViewerMainPath, "utf8");
  const retainDuringMove = source.indexOf(
    "const canRetainCommittedRenderDuringMove =",
  );
  const cachedProgressFallback = source.indexOf(
    "const committedPointCountByNodeKey =",
    retainDuringMove,
  );

  assert.ok(retainDuringMove > -1);
  assert.ok(cachedProgressFallback > retainDuringMove);
  assert.match(
    source,
    /const canRetainCommittedRenderDuringMove =\s*automaticCameraMoveInProgress[\s\S]*?committedRender\.rendererRevision === layer\.getRendererRevision\(\)/,
  );
  assert.match(
    source,
    /canRetainCommittedRenderDuringMove[\s\S]*?preserveCommittedRenderState: true[\s\S]*?current-view detail is warming without replacing GPU buffers/,
  );
  assert.match(
    source,
    /canRetainCommittedRenderDuringMove[\s\S]*?queueCameraHierarchyPrefetch\(layer, \{[\s\S]*?prefetchGeometryBatches: true[\s\S]*?return foregroundRenderReady/,
  );
  assert.match(
    source,
    /viewer\.camera\.moveEnd\.addEventListener\([\s\S]*?cancelAutomaticCameraStreamRender\(\);[\s\S]*?queueAutomaticStreamRenderForCameraMove\(false\)/,
  );
  assert.match(
    source,
    /cameraMovementCompletedAtMilliseconds[\s\S]*?cancelAutomaticCameraStreamRender\(\);[\s\S]*?renderAutomaticNodeSetForCameraMove\(/,
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
    /benchmarkHierarchyHoldFrontierKeys = \[\.\.\.lastCameraStreamSelectedNodeKeys\]/,
  );
  assert.match(
    source,
    /lastCameraStreamSelectedNodeKeys =\s*benchmarkHierarchyHoldLayer === currentLayer\s*\? \(benchmarkHierarchyHoldFrontierKeys \?\? \[\]\)\s*: \[\]/,
  );
  assert.match(
    source,
    /benchmarkHierarchyHoldFrontierKeys = undefined/,
  );
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

test("basic viewer forwards the coalesced range gap query without changing post-terminal geometry prefetch", async () => {
  const source = await readFile(basicViewerMainPath, "utf8");
  const detailRenderPromise = source.indexOf(
    "const detailRenderPromise = runCameraStreamTerminalRender({",
  );
  const postTerminalThen = source.indexOf(
    "void detailRenderPromise\n      .then(() => {",
    detailRenderPromise,
  );
  const postTerminalPrefetch = source.indexOf(
    "queueCameraHierarchyPrefetch(layer, {",
    postTerminalThen,
  );
  const postTerminalGeometry = source.indexOf(
    "prefetchGeometryBatches: true,",
    postTerminalPrefetch,
  );
  const postTerminalResolve = source.indexOf(
    "resolveForegroundRenderOnce();",
    postTerminalPrefetch,
  );

  assert.notEqual(detailRenderPromise, -1);
  assert.ok(postTerminalThen > detailRenderPromise);
  assert.ok(postTerminalPrefetch > postTerminalThen);
  assert.ok(postTerminalGeometry > postTerminalPrefetch);
  assert.ok(postTerminalGeometry < postTerminalResolve);
  assert.match(source, /"maxCoalescedPointDataRangeGapBytes"/);
  assert.match(source, /"pointGeometryWorkerConcurrency"/);
  assert.match(source, /"hierarchyPageLoadConcurrency"/);
  assert.match(
    source,
    /POINT_GEOMETRY_WORKER_CONCURRENCY_OVERRIDE\s*=\s*\n\s*readPointGeometryWorkerConcurrencyOverride\(\)/,
  );
  assert.match(
    source,
    /HIERARCHY_PAGE_LOAD_CONCURRENCY\s*=\s*\n\s*readHierarchyPageLoadConcurrencyOverride\(\)/,
  );
  assert.match(
    source,
    /POINT_GEOMETRY_WORKER_WARMUP_COUNT\s*=\s*\n\s*POINT_GEOMETRY_WORKER_CONCURRENCY_OVERRIDE\s*\?\?/,
  );
  assert.match(
    source,
    /CAMERA_STREAM_BACKGROUND_PREFETCH_MAX_CONCURRENT_REQUESTS\s*=\s*Math\.max\([\s\S]*POINT_GEOMETRY_WORKER_CONCURRENCY - 1/,
  );
  assert.equal(
    source.match(/CAMERA_STREAM_BACKGROUND_PREFETCH_MAX_CONCURRENT_REQUESTS/g)
      ?.length,
    3,
  );
  assert.match(source, /workerCount <= 8/);
});

test("benchmark report records the current artifact schema", async () => {
  const source = await readFile(benchmarkScriptPath, "utf8");

  assert.match(
    source,
    /const benchmarkArtifactSchema = "copc-viewer\.smoothness-benchmark";/,
  );
  assert.match(source, /const benchmarkArtifactSchemaVersion = 2;/);
  assert.match(
    source,
    /const report = \{[\s\S]*schema: benchmarkArtifactSchema,[\s\S]*schemaVersion: benchmarkArtifactSchemaVersion,/,
  );
});

test("smoothness benchmark records prefetch and coalesced range config plus scoped HTTP range evidence", async () => {
  const source = await readFile(benchmarkScriptPath, "utf8");
  const flow = await createGeneratedFlow();

  assert.match(source, /COPC_SMOOTHNESS_MAX_COALESCED_RANGE_BYTES/);
  assert.match(source, /COPC_SMOOTHNESS_MAX_COALESCED_RANGE_GAP_BYTES/);
  assert.match(
    source,
    /COPC_SMOOTHNESS_POINT_GEOMETRY_WORKER_CONCURRENCY/,
  );
  assert.match(
    source,
    /COPC_SMOOTHNESS_HIERARCHY_PAGE_LOAD_CONCURRENCY/,
  );
  assert.match(
    source,
    /COPC_SMOOTHNESS_POINT_GEOMETRY_WORKER_CONCURRENCY must be at most 8/,
  );
  assert.match(
    source,
    /COPC_SMOOTHNESS_HIERARCHY_PAGE_LOAD_CONCURRENCY must be at most 8/,
  );
  assert.match(
    source,
    /"maxCoalescedPointDataRangeBytes",\s*String\(benchmarkMaxCoalescedPointDataRangeBytes\)/,
  );
  assert.match(
    source,
    /"maxCoalescedPointDataRangeGapBytes",\s*String\(benchmarkMaxCoalescedPointDataRangeGapBytes\)/,
  );
  assert.match(
    source,
    /"pointGeometryWorkerConcurrency",\s*String\(benchmarkPointGeometryWorkerConcurrency\)/,
  );
  assert.match(
    source,
    /"hierarchyPageLoadConcurrency",\s*String\(benchmarkHierarchyPageLoadConcurrency\)/,
  );
  assert.match(flow, /page\.on\("request", \(request\) =>/);
  assert.match(flow, /const range = readHeader\(headers, "range"\)/);
  assert.match(flow, /page\.on\("requestfinished", \(request\) =>/);
  assert.match(flow, /pendingHttpRangeFinalizers\.add\(finalizer\)/);
  assert.match(
    flow,
    /while \(pendingHttpRangeFinalizers\.size > 0\) \{\s*await Promise\.all\(\[\.\.\.pendingHttpRangeFinalizers\]\);\s*\}/,
  );
  assert.match(flow, /page\.on\("requestfailed", \(request\) =>/);
  assert.match(flow, /beginHttpRangeScope\(\{/);
  assert.match(flow, /httpRangeEvidence = await endHttpRangeScope/);
  assert.match(flow, /httpRangeRequests: httpRangeEvidence\.records/);
  assert.match(flow, /httpRangeSummary: httpRangeEvidence\.summary/);
  assert.match(flow, /function percentileRank\(values, percentileRankValue\)/);
  assert.equal(flow.match(/function percentile\(values, ratio\)/g)?.length, 1);
  assert.match(flow, /activeHttpRangeRequests\.delete\(request\)/);
  assert.match(flow, /bytesCaveat:/);
  assert.match(flow, /phaseCaveat:/);
  assert.match(flow, /maxCoalescedPointDataRangeBytes,/);
  assert.match(flow, /maxCoalescedPointDataRangeGapBytes,/);
  assert.match(flow, /pointGeometryWorkerConcurrency,/);
  assert.match(flow, /hierarchyPageLoadConcurrency,/);
  assert.match(flow, /const statusBeforeCameraMovement = benchmark\.getStatus\(\)/);
  assert.match(flow, /hierarchyPageLoadStatsBeforeCameraMovement/);
  assert.match(flow, /hierarchyPageLoadStatsFinal/);
  assert.match(flow, /hierarchyPageLoadStatsDelta/);
  assert.match(flow, /function createHierarchyPageLoadStatsDelta/);
  assert.match(flow, /httpRangePhaseSummaries: httpRangeEvidence\.phaseSummaries/);
  assert.match(flow, /phase: activeHttpRangeScope\?\.phase/);
  assert.match(flow, /setHttpRangeScopePhase\(httpRangeScope, "terminal-refinement"\)/);
  assert.match(flow, /setHttpRangeScopePhase\(httpRangeScope, "post-terminal-prefetch"\)/);
});

test("generated hierarchy page load stats delta subtracts only cumulative counters", async () => {
  const flow = await createGeneratedFlow();
  const helpers = extractGeneratedHelpers(
    flow,
    "function subtractNonnegativeCounter(",
    "function parseAppliedCameraStreamBudget(",
  );
  const createHierarchyPageLoadStatsDelta = eval(
    `${helpers}\ncreateHierarchyPageLoadStatsDelta;`,
  );

  assert.deepEqual(
    createHierarchyPageLoadStatsDelta(
      {
        loadCount: 10,
        cacheHitCount: 3,
        sharedTaskReuseCount: 2,
        completedLoadCount: 7,
        failedLoadCount: 1,
        activeLoadCount: 2,
        maxConcurrentLoadCount: 4,
        requestedByteCount: 1000,
        totalLoadMilliseconds: 80,
        maxLoadMilliseconds: 60,
        batchLoadCount: 5,
        totalBatchLoadMilliseconds: 120,
        maxBatchLoadMilliseconds: 90,
        lastBatchRequestedPageCount: 2,
        maxBatchRequestedPageCount: 3,
      },
      {
        loadCount: 14,
        cacheHitCount: 6,
        sharedTaskReuseCount: 5,
        completedLoadCount: 10,
        failedLoadCount: 1,
        activeLoadCount: 0,
        maxConcurrentLoadCount: 5,
        requestedByteCount: 1800,
        totalLoadMilliseconds: 140,
        maxLoadMilliseconds: 60,
        batchLoadCount: 7,
        totalBatchLoadMilliseconds: 210,
        maxBatchLoadMilliseconds: 110,
        lastBatchRequestedPageCount: 4,
        maxBatchRequestedPageCount: 4,
      },
    ),
    {
      loadCount: 4,
      cacheHitCount: 3,
      sharedTaskReuseCount: 3,
      completedLoadCount: 3,
      failedLoadCount: 0,
      requestedByteCount: 800,
      totalLoadMilliseconds: 60,
      batchLoadCount: 2,
      totalBatchLoadMilliseconds: 90,
      maxLoadMillisecondsBefore: 60,
      maxLoadMillisecondsAfter: 60,
      maxLoadMillisecondsIncrease: 0,
      maxBatchLoadMillisecondsBefore: 90,
      maxBatchLoadMillisecondsAfter: 110,
      maxBatchLoadMillisecondsIncrease: 20,
      maxConcurrentLoadCountBefore: 4,
      maxConcurrentLoadCountAfter: 5,
      maxConcurrentLoadCountIncrease: 1,
      activeLoadCountBefore: 2,
      activeLoadCountAfter: 0,
      lastBatchRequestedPageCountBefore: 2,
      lastBatchRequestedPageCountAfter: 4,
      maxBatchRequestedPageCountBefore: 3,
      maxBatchRequestedPageCountAfter: 4,
      maxBatchRequestedPageCountIncrease: 1,
    },
  );
  assert.equal(createHierarchyPageLoadStatsDelta(undefined, {}), undefined);
});

test("generated HTTP range summary counts wire metadata without worker-byte inference and groups phases", async () => {
  const flow = await createGeneratedFlow();
  const helpers = extractGeneratedHelpers(
    flow,
    "function parseRangeHeader(",
    "function beginHttpRangeScope(",
  );
  const summarizeHttpRangeRequests = eval(
    `${helpers}\nsummarizeHttpRangeRequests;`,
  );
  const summarizeHttpRangeRequestsByPhase = eval(
    `const httpRangePhases = ["camera-movement", "terminal-refinement", "post-terminal-prefetch"];\n${helpers}\nsummarizeHttpRangeRequestsByPhase;`,
  );
  const parseRangeHeader = eval(`${helpers}\nparseRangeHeader;`);
  const parseContentRangeHeader = eval(`${helpers}\nparseContentRangeHeader;`);

  assert.deepEqual(
    summarizeHttpRangeRequests([
      {
        outcome: "finished",
        status: 206,
        parsedRange: parseRangeHeader("bytes=0-99"),
        parsedContentRange: parseContentRangeHeader("bytes 0-99/1000"),
        durationMilliseconds: 10,
        sizes: {
          requestBodySize: 0,
          requestHeadersSize: 40,
          responseBodySize: 100,
          responseHeadersSize: 60,
        },
      },
      {
        outcome: "finished",
        status: 206,
        parsedRange: parseRangeHeader("bytes=50-149"),
        contentLengthBytes: 100,
        durationMilliseconds: 30,
        sizes: {
          requestBodySize: 0,
          requestHeadersSize: 41,
          responseBodySize: 100,
          responseHeadersSize: 61,
        },
      },
      {
        outcome: "abandoned",
        parsedRange: parseRangeHeader("bytes=0-99"),
        durationMilliseconds: 20,
      },
    ]),
    {
      requestCount: 3,
      finishedCount: 2,
      failedCount: 0,
      abandonedCount: 1,
      statusCounts: { 206: 2 },
      requestedRangeBytes: 300,
      finishedRangeBytes: 200,
      contentLengthBytes: 100,
      sizeRecordCount: 2,
      requestBodySizeBytes: 0,
      requestHeadersSizeBytes: 81,
      responseBodySizeBytes: 200,
      responseHeadersSizeBytes: 121,
      transferSizeBytes: 321,
      maxDurationMilliseconds: 30,
      p95DurationMilliseconds: 30,
      duplicateRangeCount: 1,
      duplicateRangeBytes: 100,
      overlapRangeBytes: 150,
      unionRangeBytes: 150,
      evidenceScope: "browser-http-range-headers",
      bytesCaveat:
        "HTTP byte counts are browser-observed request/response metadata and do not include inner worker payload inference.",
      phaseCaveat:
        "HTTP range phases are classified by request start against benchmark controller boundaries; requests that race a boundary can be attributed to the previous or next phase.",
    },
  );

  const phaseSummaries = summarizeHttpRangeRequestsByPhase([
    {
      phase: "camera-movement",
      outcome: "finished",
      parsedRange: parseRangeHeader("bytes=0-9"),
    },
    {
      phase: "terminal-refinement",
      outcome: "finished",
      parsedRange: parseRangeHeader("bytes=10-29"),
    },
    {
      phase: "post-terminal-prefetch",
      outcome: "finished",
      parsedRange: parseRangeHeader("bytes=30-59"),
    },
  ]);
  assert.equal(phaseSummaries["camera-movement"].requestCount, 1);
  assert.equal(phaseSummaries["camera-movement"].requestedRangeBytes, 10);
  assert.equal(phaseSummaries["terminal-refinement"].requestCount, 1);
  assert.equal(phaseSummaries["terminal-refinement"].requestedRangeBytes, 20);
  assert.equal(phaseSummaries["post-terminal-prefetch"].requestCount, 1);
  assert.equal(phaseSummaries["post-terminal-prefetch"].requestedRangeBytes, 30);

  const nestedOverlap = summarizeHttpRangeRequests([
    { parsedRange: parseRangeHeader("bytes=0-99") },
    { parsedRange: parseRangeHeader("bytes=0-49") },
    { parsedRange: parseRangeHeader("bytes=50-99") },
  ]);
  assert.equal(nestedOverlap.requestedRangeBytes, 200);
  assert.equal(nestedOverlap.unionRangeBytes, 100);
  assert.equal(nestedOverlap.overlapRangeBytes, 100);
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

test("custom-millsite URL override falls back on blank input and rejects invalid protocols", async () => {
  const source = await readFile(benchmarkScriptPath, "utf8");
  const start = source.indexOf("function readOptionalHttpUrlEnv(");
  const end = source.indexOf("\nfunction readNonNegativeIntegerEnv(", start);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const readOptionalHttpUrlEnv = eval(
    `${source.slice(start, end)}\nreadOptionalHttpUrlEnv;`,
  );

  const originalValue = process.env.COPC_SMOOTHNESS_CUSTOM_MILLSITE_URL;

  try {
    process.env.COPC_SMOOTHNESS_CUSTOM_MILLSITE_URL = "   ";
    assert.equal(
      readOptionalHttpUrlEnv(
        "COPC_SMOOTHNESS_CUSTOM_MILLSITE_URL",
        LIVE_COPC_SAMPLE_URLS.millsiteReservoir,
      ),
      LIVE_COPC_SAMPLE_URLS.millsiteReservoir,
    );

    process.env.COPC_SMOOTHNESS_CUSTOM_MILLSITE_URL = "file:///tmp/millsite.copc.laz";
    assert.throws(
      () =>
        readOptionalHttpUrlEnv(
          "COPC_SMOOTHNESS_CUSTOM_MILLSITE_URL",
          LIVE_COPC_SAMPLE_URLS.millsiteReservoir,
        ),
      /COPC_SMOOTHNESS_CUSTOM_MILLSITE_URL must be a valid http or https URL\./,
    );

    process.env.COPC_SMOOTHNESS_CUSTOM_MILLSITE_URL =
      "https://example.com/millsite.copc.laz?token=abc";
    assert.equal(
      readOptionalHttpUrlEnv(
        "COPC_SMOOTHNESS_CUSTOM_MILLSITE_URL",
        LIVE_COPC_SAMPLE_URLS.millsiteReservoir,
      ),
      "https://example.com/millsite.copc.laz?token=abc",
    );
  } finally {
    if (originalValue === undefined) {
      delete process.env.COPC_SMOOTHNESS_CUSTOM_MILLSITE_URL;
    } else {
      process.env.COPC_SMOOTHNESS_CUSTOM_MILLSITE_URL = originalValue;
    }
  }
});

async function createGeneratedFlow(options = {}) {
  const source = await readFile(benchmarkScriptPath, "utf8");
  const start = source.indexOf("function createSmoothnessFlow(");
  const end = source.indexOf("\nfunction average(", start);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const createSmoothnessFlow = eval(
    `const isExpectedNonFatalWebGlDriverWarning = ${expectedNonFatalWebGlDriverWarning.toString()};\n${source.slice(start, end)}\ncreateSmoothnessFlow;`,
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
    undefined,
    undefined,
  );
}

function extractGeneratedFunction(flow, functionName, nextFunctionName) {
  const start = flow.indexOf(`function ${functionName}(`);
  const end = flow.indexOf(`function ${nextFunctionName}(`, start);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  return eval(`(${flow.slice(start, end)})`);
}

function extractGeneratedHelpers(flow, startNeedle, endNeedle) {
  const start = flow.indexOf(startNeedle);
  const end = flow.indexOf(endNeedle, start);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  return flow.slice(start, end);
}
