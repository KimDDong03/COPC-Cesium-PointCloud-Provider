import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const assertionScriptPath = path.join(
  scriptDir,
  "assert-smoothness-benchmark.mjs",
);

test("checks measured geometry cache hits without asserting warmup evidence", async () => {
  const benchmark = createBenchmark(1);
  benchmark.warmups = [
    {
      sampleId: "millsite-reservoir",
      warmupIndex: 1,
      renderedPointCount: 0,
      pointGeometryTiming: { cacheHitCount: 0 },
    },
  ];

  const result = await runAssertion(benchmark);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.resultCount, 1);
  assert.equal(result.report.checkedResults[0].runIndex, 1);
  assert.equal(result.report.checkedResults[0].geometryCacheHitCount, 1);
  assert.equal(
    result.report.checkedResults[0].pointGeometryTimingEvidenceSource,
    "geometry-cache-delta",
  );
  assert.equal(result.report.checkedResults[0].geometryCacheHitDelta, 1);
  assert.deepEqual(result.report.failures, []);
});

test("rejects a measured result below the geometry cache-hit minimum", async () => {
  const result = await runAssertion(createBenchmark(0));

  assert.equal(result.status, 1);
  assert.match(result.report.failures.join("\n"), /geometry cache hits 0 < 1/);
});

test("accepts authoritative layer cache reuse when worker timing has no cache hit", async () => {
  const benchmark = createBenchmark(0);
  benchmark.results[0].geometryCacheDelta.hitCount = 4;
  benchmark.results[0].pointGeometryTiming.geometryCacheDelta.hitCount = 4;

  const result = await runAssertion(benchmark);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.checkedResults[0].geometryCacheHitCount, 4);
  assert.equal(result.report.checkedResults[0].pointGeometryCacheHitCount, 0);
  assert.equal(result.report.checkedResults[0].geometryCacheHitDelta, 4);
  assert.deepEqual(result.report.failures, []);
});

test("rejects missing run provenance and malformed browser metadata", async () => {
  const benchmark = createBenchmark(1);

  delete benchmark.runEvidence;
  benchmark.browserEnvironment.version = "latest";

  const result = await runAssertion(benchmark);
  const failures = result.report.failures.join("\n");

  assert.equal(result.status, 1);
  assert.match(failures, /benchmark\.runEvidence must be an object/);
  assert.match(
    failures,
    /benchmark\.browserEnvironment\.version must be a browser version string/,
  );
});

test("rejects stale or incomplete terminal visual composition", async () => {
  const benchmark = createBenchmark(1);
  benchmark.results[0].cameraStreamVisualQuality = {
    ...benchmark.results[0].cameraStreamVisualQuality,
    isTerminalReady: false,
    isAdditiveClosureComplete: false,
    missingRequiredNodeCount: 1,
    unexpectedRenderedNodeCount: 1,
  };

  const result = await runAssertion(benchmark);
  const failures = result.report.failures.join("\n");

  assert.equal(result.status, 1);
  assert.match(failures, /verified terminal visual composition/);
});

test("accepts completed post-prefetch same-camera refinement evidence", async () => {
  const benchmark = createBenchmark(1);
  addPostPrefetchRefinementEvidence(benchmark);

  const result = await runAssertion(
    benchmark,
    createPostPrefetchRefinementAssertionEnvironment(),
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.report.checkedResults[0].postPrefetchRefinement.selectedDepth,
    5,
  );
  assert.equal(
    result.report.checkedResults[0].postPrefetchRefinement.renderedPointCount,
    329_517,
  );
});

test("accepts a stable post-prefetch observation when the initial request was already terminal", async () => {
  const benchmark = createBenchmark(1);
  addPostPrefetchRefinementEvidence(benchmark);
  const result = benchmark.results[0];
  result.streamPointBudget = 360_000;
  result.appliedStreamPointBudget = 360_000;
  result.renderedPointCount = 329_517;
  result.postPrefetchRefinement = {
    ...result.postPrefetchRefinement,
    observedRequestId: result.postPrefetchRefinement.initialRequestId,
    requestAdvanced: false,
    sameCameraFollowup: false,
  };

  const assertion = await runAssertion(
    benchmark,
    createPostPrefetchRefinementAssertionEnvironment(),
  );

  assert.equal(assertion.status, 0, assertion.stderr);
  assert.deepEqual(assertion.report.failures, []);
});

test("rejects stale, shallow, sparse, or non-terminal post-prefetch refinement", async () => {
  const benchmark = createBenchmark(1);
  addPostPrefetchRefinementEvidence(benchmark);
  benchmark.results[0].postPrefetchRefinement = {
    ...benchmark.results[0].postPrefetchRefinement,
    observedRequestId: 41,
    requestAdvanced: false,
    observedCameraEpoch: 8,
    observedCameraPoseFingerprint: "moved-camera-pose",
    sameCameraFollowup: false,
    prefetchCompleted: false,
    prefetchState: "pending",
    selectedDepth: 4,
    renderedPointCount: 299_999,
    isTerminalReady: false,
    visualQuality: {
      ...benchmark.results[0].postPrefetchRefinement.visualQuality,
      isTerminalReady: false,
    },
  };

  const result = await runAssertion(
    benchmark,
    createPostPrefetchRefinementAssertionEnvironment(),
  );
  const failures = result.report.failures.join("\n");

  assert.equal(result.status, 1);
  assert.match(failures, /did not prove a newer same-camera follow-up request/);
  assert.match(failures, /post-prefetch camera epoch changed from 7 to 8/);
  assert.match(failures, /camera pose fingerprint did not remain identical/);
  assert.match(failures, /post-prefetch wait did not reach completed state/);
  assert.match(failures, /post-prefetch selected depth 4 < 5/);
  assert.match(failures, /post-prefetch rendered 299,999 points < 300000/);
  assert.match(
    failures,
    /post-prefetch same-camera refinement was not terminal ready/,
  );
});

test("rejects an applied stream budget above the configured hard cap", async () => {
  const benchmark = createBenchmark(1);
  benchmark.results[0].appliedStreamPointBudget = 40_000;

  const result = await runAssertion(benchmark);
  const failures = result.report.failures.join("\n");

  assert.equal(result.status, 1);
  assert.match(failures, /applied 40,000 points > configured 20,000 point cap/);
});

test("accepts decoded worker cache telemetry within its aggregate envelope", async () => {
  const result = await runAssertion(createBenchmark(1));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.report.checkedResults[0].decodedPointDataCache.retainedBytes,
    600,
  );
});

test("rejects decoded worker cache bytes above the configured envelope", async () => {
  const benchmark = createBenchmark(1);
  benchmark.results[0].decodedPointDataCache.peakRetainedBytes = 1_001;

  const result = await runAssertion(benchmark);

  assert.equal(result.status, 1);
  assert.match(
    result.report.failures.join("\n"),
    /aggregate peak retained bytes 1,001 exceeds 1,000 byte limit/,
  );
});

test("requires current artifact terminal and decoded-cache evidence", async () => {
  const benchmark = createBenchmark(1);
  delete benchmark.results[0].terminalRefinementDurationMilliseconds;
  delete benchmark.results[0].terminalRefinementFrameDeltas;
  delete benchmark.results[0].terminalRefinementSummary;
  delete benchmark.results[0].decodedPointDataCache;

  const result = await runAssertion(benchmark);
  const failures = result.report.failures.join("\n");

  assert.equal(result.status, 1);
  assert.match(
    failures,
    /current benchmark artifact is missing terminal refinement evidence/,
  );
  assert.match(failures, /did not report decoded point-data cache stats/);
});

test("rejects partially versioned artifacts instead of treating them as legacy", async () => {
  const benchmark = createBenchmark(1);
  delete benchmark.schemaVersion;

  const result = await runAssertion(benchmark);

  assert.equal(result.status, 1);
  assert.match(
    result.report.failures.join("\n"),
    /benchmark\.schemaVersion must be 1; received undefined/,
  );
  assert.equal(result.report.benchmarkArtifact.isLegacyUnversioned, false);
});

test("requires the current aggregate decoded-cache byte limit", async () => {
  const benchmark = createBenchmark(1);
  delete benchmark.results[0].decodedPointDataCache
    .maxDecodedPointDataViewBytesAcrossWorkers;

  const result = await runAssertion(benchmark);

  assert.equal(result.status, 1);
  assert.match(
    result.report.failures.join("\n"),
    /decoded point-data aggregate byte limit was not reported/,
  );
});

test("rejects malformed decoded-cache counters in each worker pool", async () => {
  const benchmark = createBenchmark(1);
  benchmark.results[0].decodedPointDataCache.pointSample.peakRetainedBytes =
    "NaN";

  const result = await runAssertion(benchmark);

  assert.equal(result.status, 1);
  assert.match(
    result.report.failures.join("\n"),
    /point-sample cache peak retained bytes NaN must be a non-negative safe integer/,
  );
});

test("accepts measured terminal refinement frames within the interactive frame gates", async () => {
  const result = await runAssertion(createBenchmark(1));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.report.thresholds.maxTerminalRefinementFramesOver100Milliseconds,
    0,
  );
  assert.equal(
    result.report.checkedResults[0].terminalRefinementDurationMilliseconds,
    120,
  );
  assert.deepEqual(
    result.report.checkedResults[0].terminalRefinementSummary,
    createTerminalRefinementSummary(),
  );
});

test("allows one bounded cold terminal tail frame but rejects a second or a frame above 150 ms", async () => {
  const coldEnvironment = {
    COPC_SMOOTHNESS_ASSERT_MAX_FRAME_MS: "150",
    COPC_SMOOTHNESS_ASSERT_MAX_TERMINAL_REFINEMENT_FRAMES_OVER_100: "1",
  };
  const oneTailFrame = createBenchmark(1);
  setTerminalRefinementFrames(oneTailFrame, [
    ...Array(999).fill(16),
    120,
  ]);
  const accepted = await runAssertion(oneTailFrame, coldEnvironment);

  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(
    accepted.report.thresholds
      .maxTerminalRefinementFramesOver100Milliseconds,
    1,
  );

  const twoTailFrames = createBenchmark(1);
  setTerminalRefinementFrames(twoTailFrames, [
    ...Array(998).fill(16),
    120,
    120,
  ]);
  const tooMany = await runAssertion(twoTailFrames, coldEnvironment);

  assert.equal(tooMany.status, 1);
  assert.match(
    tooMany.report.failures.join("\n"),
    /terminal refinement 2 frames over 100 ms > 1/,
  );

  const severeTailFrame = createBenchmark(1);
  setTerminalRefinementFrames(severeTailFrame, [
    ...Array(999).fill(16),
    151,
  ]);
  const tooLong = await runAssertion(severeTailFrame, coldEnvironment);

  assert.equal(tooLong.status, 1);
  assert.match(
    tooLong.report.failures.join("\n"),
    /terminal refinement max frame 151\.0 ms > 150 ms/,
  );
});

test("rejects terminal refinement frame stalls after camera movement", async () => {
  const benchmark = createBenchmark(1);
  benchmark.results[0].terminalRefinementFrameDeltas = [
    16, 16, 16, 16, 16, 68, 120,
  ];
  benchmark.results[0].terminalRefinementSummary = {
    ...createTerminalRefinementSummary(),
    averageFrameMilliseconds: 38.29,
    p95FrameMilliseconds: 120,
    maxFrameMilliseconds: 120,
    estimatedAverageFps: 26.12,
    frameDeltasOver50Milliseconds: 2,
    frameDeltasOver100Milliseconds: 1,
  };

  const result = await runAssertion(benchmark);
  const failures = result.report.failures.join("\n");

  assert.equal(result.status, 1);
  assert.match(failures, /terminal refinement p95 frame 120\.0 ms > 67 ms/);
  assert.match(failures, /terminal refinement max frame 120\.0 ms > 100 ms/);
  assert.match(failures, /terminal refinement 1 frames over 100 ms > 0/);
});

test("allows immediate terminal completion without refinement frames", async () => {
  const benchmark = createBenchmark(1);
  benchmark.results[0].terminalRefinementDurationMilliseconds = 0;
  benchmark.results[0].terminalRefinementFrameDeltas = [];
  benchmark.results[0].terminalRefinementSummary =
    createTerminalRefinementSummary(0);

  const result = await runAssertion(benchmark);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.failures, []);
});

test("rejects a long zero-frame terminal refinement interval", async () => {
  const benchmark = createBenchmark(1);
  benchmark.results[0].terminalRefinementDurationMilliseconds = 120_000;
  benchmark.results[0].terminalRefinementFrameDeltas = [];
  benchmark.results[0].terminalRefinementSummary =
    createTerminalRefinementSummary(0);

  const result = await runAssertion(benchmark);

  assert.equal(result.status, 1);
  assert.match(
    result.report.failures.join("\n"),
    /recorded no frames over 120000\.0 ms; zero-frame completion must be at most 67 ms/,
  );
});

test("rejects sustained low FPS during terminal refinement", async () => {
  const benchmark = createBenchmark(1);
  benchmark.results[0].terminalRefinementDurationMilliseconds = 600;
  benchmark.results[0].terminalRefinementFrameDeltas = Array(10).fill(60);
  benchmark.results[0].terminalRefinementSummary = {
    frameCount: 10,
    averageFrameMilliseconds: 60,
    medianFrameMilliseconds: 60,
    p95FrameMilliseconds: 60,
    maxFrameMilliseconds: 60,
    estimatedAverageFps: 1000 / 60,
    frameDeltasOver50Milliseconds: 10,
    frameDeltasOver100Milliseconds: 0,
  };

  const result = await runAssertion(benchmark);

  assert.equal(result.status, 1);
  assert.match(
    result.report.failures.join("\n"),
    /terminal refinement average FPS 16\.667 < 30/,
  );
});

test("recomputes terminal refinement thresholds from raw frame deltas", async () => {
  const benchmark = createBenchmark(1);
  benchmark.results[0].terminalRefinementDurationMilliseconds = 1_096;
  benchmark.results[0].terminalRefinementFrameDeltas = [
    1_000, 16, 16, 16, 16, 16, 16,
  ];

  const result = await runAssertion(benchmark);
  const failures = result.report.failures.join("\n");

  assert.equal(result.status, 1);
  assert.match(failures, /does not match recomputed/);
  assert.match(failures, /terminal refinement max frame 1000\.0 ms > 100 ms/);
  assert.match(failures, /terminal refinement 1 frames over 100 ms > 0/);
});

test("rejects non-finite and structurally inconsistent terminal refinement evidence", async () => {
  const benchmark = createBenchmark(1);
  benchmark.results[0].terminalRefinementDurationMilliseconds = "Infinity";
  benchmark.results[0].terminalRefinementSummary = {
    ...createTerminalRefinementSummary(),
    frameCount: 8,
    p95FrameMilliseconds: "NaN",
    frameDeltasOver50Milliseconds: 1,
    frameDeltasOver100Milliseconds: 2,
  };

  const result = await runAssertion(benchmark);
  const failures = result.report.failures.join("\n");

  assert.equal(result.status, 1);
  assert.match(
    failures,
    /terminal refinement duration Infinity must be a finite non-negative number/,
  );
  assert.match(
    failures,
    /terminal refinement p95 frame NaN must be a finite non-negative number/,
  );
  assert.match(
    failures,
    /frame count 8 does not match 7 recorded frame deltas/,
  );
  assert.match(failures, /frames over 100 ms 2 exceeds frames over 50 ms 1/);
});

test("keeps legacy measured results and warmup-only refinement evidence compatible", async () => {
  const benchmark = createBenchmark(1);
  delete benchmark.schema;
  delete benchmark.schemaVersion;
  delete benchmark.results[0].terminalRefinementDurationMilliseconds;
  delete benchmark.results[0].terminalRefinementFrameDeltas;
  delete benchmark.results[0].terminalRefinementSummary;
  delete benchmark.results[0].decodedPointDataCache;
  benchmark.warmups = [
    {
      sampleId: "millsite-reservoir",
      warmupIndex: 1,
      terminalRefinementDurationMilliseconds: "Infinity",
      terminalRefinementSummary: null,
    },
  ];

  const result = await runAssertion(benchmark);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.failures, []);
});

test("accepts exact warm hierarchy hold evidence across measured repeats", async () => {
  const benchmark = createWarmHierarchyBenchmark();
  const secondResult = structuredClone(benchmark.results[0]);
  secondResult.runIndex = 2;
  benchmark.results.push(secondResult);
  benchmark.repeatCount = 2;

  const result = await runAssertion(benchmark);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.failures, []);
  assert.equal(result.report.requireWarmHierarchyHold, true);
});

test("rejects warm repeats whose exact hierarchy or additive signature changes", async () => {
  const benchmark = createWarmHierarchyBenchmark();
  const secondResult = structuredClone(benchmark.results[0]);
  secondResult.runIndex = 2;
  secondResult.cameraStreamRenderSignature = "different-additive-signature";
  secondResult.hierarchyCacheAfterPrefetch.trackedNodeCount += 1;
  benchmark.results.push(secondResult);
  benchmark.repeatCount = 2;

  const result = await runAssertion(benchmark);
  const failures = result.report.failures.join("\n");

  assert.equal(result.status, 1);
  assert.match(
    failures,
    /hierarchy cache changed during held geometry prefetch/,
  );
  assert.match(
    failures,
    /exact warm frontier or additive render signature changed between repeats/,
  );
});

test("validates camera-stream node-sample reuse as zero-worker cache evidence", async () => {
  const benchmark = createBenchmark(24);
  benchmark.results[0].cameraStreamNodeReuse = {
    finalNodeCount: 24,
    cachedFinalNodeCount: 24,
    freshCachedFinalNodeCount: 24,
    cachedCoverageNodeCount: 4,
  };
  benchmark.results[0].pointGeometryTiming.nodeCount = 24;
  benchmark.results[0].pointGeometryTiming.cacheHitCount = 24;
  benchmark.results[0].pointGeometryTiming.evidenceSource =
    "camera-stream-node-sample-cache";

  const valid = await runAssertion(benchmark);
  assert.equal(valid.status, 0, valid.stderr);

  benchmark.results[0].pointGeometryTiming.cacheHitCount = 23;
  const invalid = await runAssertion(benchmark);

  assert.equal(invalid.status, 1);
  assert.match(
    invalid.report.failures.join("\n"),
    /node-sample cache timing hit count does not match fresh reuse evidence/,
  );
});

test("rejects partial or stale node-sample reuse as zero-worker evidence", async () => {
  const benchmark = createBenchmark(12);
  benchmark.results[0].cameraStreamNodeReuse = {
    finalNodeCount: 24,
    cachedFinalNodeCount: 12,
    freshCachedFinalNodeCount: 11,
    cachedCoverageNodeCount: 4,
  };
  benchmark.results[0].pointGeometryTiming.nodeCount = 24;
  benchmark.results[0].pointGeometryTiming.cacheHitCount = 11;
  benchmark.results[0].pointGeometryTiming.evidenceSource =
    "camera-stream-node-sample-cache";

  const partial = await runAssertion(benchmark);

  assert.equal(partial.status, 1);
  assert.match(
    partial.report.failures.join("\n"),
    /requires every final node to have a fresh cached sample/,
  );
});

function createBenchmark(cacheHitCount) {
  return {
    schema: "copc-viewer.smoothness-benchmark",
    schemaVersion: 1,
    profile: "warm-zoom-detail",
    repeatCount: 1,
    warmupRunCount: 1,
    durationMilliseconds: 1_200,
    waitForFinalDetail: true,
    browserGraphics: {
      renderer: "Test GPU Renderer",
    },
    browserEnvironment: createBrowserEnvironment(),
    runEvidence: createRunEvidence(),
    sampleCases: [
      {
        id: "millsite-reservoir",
        expectedMinSelectedDepth: 5,
      },
    ],
    results: [
      {
        sampleId: "millsite-reservoir",
        runIndex: 1,
        streamPointBudget: 20_000,
        appliedStreamPointBudget: 20_000,
        renderedPointCount: 10_000,
        renderedFinalNodeCoverageRatio: 1,
        renderedFinalNodeWeightCoverageRatio: 1,
        cameraStreamVisualQuality: {
          frontierNodeCount: 12,
          frontierDepthSpan: 0,
          requiredNodeCount: 17,
          renderedNodeCount: 17,
          missingRequiredNodeCount: 0,
          unexpectedRenderedNodeCount: 0,
          isFrontierAntichain: true,
          isAdditiveClosureComplete: true,
          isTerminalReady: true,
        },
        measuredDurationMilliseconds: 1_200,
        cameraStreamFirstResponseMilliseconds: 10,
        cameraStreamDiagnostics: {
          totalMilliseconds: 100,
          selectedDepth: 5,
        },
        cameraStreamPrefetch: {
          state: "completed",
          requestedNodeCount: 16,
        },
        pointGeometryTiming: {
          nodeCount: 1,
          cacheHitCount,
          maxRequestRoundTripMilliseconds: 0,
          maxDecodeMilliseconds: 0,
          maxWorkerMilliseconds: 0,
          maxQueueMilliseconds: 0,
          sumQueueMilliseconds: 0,
          evidenceSource: "geometry-cache-delta",
          geometryCacheDelta: {
            hitCount: cacheHitCount,
          },
        },
        geometryCacheDelta: {
          hitCount: cacheHitCount,
        },
        decodedPointDataCache: createDecodedPointDataCacheStats(),
        terminalRefinementDurationMilliseconds: 120,
        terminalRefinementFrameDeltas: [16, 16, 17, 16, 17, 18, 20],
        terminalRefinementSummary: createTerminalRefinementSummary(),
        summary: {
          frameCount: 72,
          estimatedAverageFps: 60,
          p95FrameMilliseconds: 16.7,
          maxFrameMilliseconds: 17,
          frameDeltasOver50Milliseconds: 0,
        },
      },
    ],
  };
}

function createWarmHierarchyBenchmark() {
  const benchmark = createBenchmark(1);
  const hierarchyCacheStats = createHierarchyCacheStats();
  benchmark.cacheResetMode = "none";
  benchmark.results[0].cameraStreamHierarchyHeld = true;
  benchmark.results[0].cameraStreamRenderSignature =
    "5-1-2-3|5-1-2-4@360000@10000@5";
  benchmark.results[0].cameraStreamSelectedNodeKeys = ["5-1-2-3", "5-1-2-4"];
  benchmark.results[0].hierarchyCacheStats = hierarchyCacheStats;
  benchmark.results[0].hierarchyCacheAfterPrefetch =
    structuredClone(hierarchyCacheStats);
  benchmark.hierarchyHolds = [
    {
      sampleId: "millsite-reservoir",
      streamPointBudget: 20_000,
      held: true,
      hierarchyCacheStats: structuredClone(hierarchyCacheStats),
      warmupSettle: {
        state: "completed",
        isComplete: true,
      },
    },
  ];
  return benchmark;
}

function addPostPrefetchRefinementEvidence(benchmark) {
  const result = benchmark.results[0];
  result.expectedCameraStreamRequestId = 41;
  result.postPrefetchRefinement = {
    timeoutMilliseconds: 30_000,
    initialRequestId: 41,
    observedRequestId: 42,
    requestAdvanced: true,
    initialCameraEpoch: 7,
    observedCameraEpoch: 7,
    initialCameraPoseFingerprint: "camera-pose-7",
    observedCameraPoseFingerprint: "camera-pose-7",
    sameCameraFollowup: true,
    prefetchCompleted: true,
    prefetchState: "completed",
    renderedPointCount: 329_517,
    selectedDepth: 5,
    isTerminalReady: true,
    visualQuality: structuredClone(result.cameraStreamVisualQuality),
    statusText:
      "Camera stream terminal rendered 329,517 points from the complete 51-node additive set (28 frontier nodes, medium zoom).",
  };
}

function createPostPrefetchRefinementAssertionEnvironment() {
  return {
    COPC_SMOOTHNESS_ASSERT_REQUIRE_POST_PREFETCH_REFINEMENT: "1",
    COPC_SMOOTHNESS_ASSERT_MIN_POST_PREFETCH_SELECTED_DEPTH: "5",
    COPC_SMOOTHNESS_ASSERT_MIN_POST_PREFETCH_RENDERED_POINTS: "300000",
  };
}

function createHierarchyCacheStats() {
  return {
    loadedPageCount: 6,
    maxCachedPageCount: 64,
    loadedPageBytes: 8_700,
    maxCachedPageBytes: 16_777_216,
    pendingPageCount: 136,
    trackedNodeCount: 3_850,
    trackedPendingPageCount: 136,
    cacheEvictionCount: 0,
    isOverLimit: false,
  };
}

function createDecodedPointDataCacheStats() {
  const pointSample = {
    workerCount: 2,
    retainedViewCount: 2,
    retainedBytes: 200,
    peakRetainedBytes: 250,
    cacheHitCount: 1,
    cacheMissCount: 2,
    cacheEvictionCount: 0,
    oversizedEntrySkipCount: 0,
    affinityEntryCount: 2,
    maxDecodedPointDataViewBytesPerWorker: 200,
    maxDecodedPointDataViewBytesAcrossWorkers: 400,
  };
  const integratedPointGeometry = {
    workerCount: 3,
    retainedViewCount: 4,
    retainedBytes: 400,
    peakRetainedBytes: 500,
    cacheHitCount: 3,
    cacheMissCount: 4,
    cacheEvictionCount: 1,
    oversizedEntrySkipCount: 0,
    affinityEntryCount: 4,
    maxDecodedPointDataViewBytesPerWorker: 200,
    maxDecodedPointDataViewBytesAcrossWorkers: 600,
  };

  return {
    workerCount: 5,
    retainedViewCount: 6,
    retainedBytes: 600,
    peakRetainedBytes: 750,
    cacheHitCount: 4,
    cacheMissCount: 6,
    cacheEvictionCount: 1,
    oversizedEntrySkipCount: 0,
    affinityEntryCount: 6,
    maxDecodedPointDataViewBytesAcrossWorkers: 1_000,
    pointSample,
    integratedPointGeometry,
  };
}

function createTerminalRefinementSummary(frameCount = 7) {
  if (frameCount === 0) {
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
    frameCount,
    averageFrameMilliseconds: 17.14,
    medianFrameMilliseconds: 17,
    p95FrameMilliseconds: 20,
    maxFrameMilliseconds: 20,
    estimatedAverageFps: 58.33,
    frameDeltasOver50Milliseconds: 0,
    frameDeltasOver100Milliseconds: 0,
  };
}

function setTerminalRefinementFrames(benchmark, frameDeltas) {
  const sorted = [...frameDeltas].sort((left, right) => left - right);
  const average =
    frameDeltas.reduce((sum, value) => sum + value, 0) /
    frameDeltas.length;
  const percentile = (ratio) =>
    sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
  const result = benchmark.results[0];

  result.terminalRefinementDurationMilliseconds = frameDeltas.reduce(
    (sum, value) => sum + value,
    0,
  );
  result.terminalRefinementFrameDeltas = frameDeltas;
  result.terminalRefinementSummary = {
    frameCount: frameDeltas.length,
    averageFrameMilliseconds: average,
    medianFrameMilliseconds: percentile(0.5),
    p95FrameMilliseconds: percentile(0.95),
    maxFrameMilliseconds: Math.max(...frameDeltas),
    estimatedAverageFps: 1000 / average,
    frameDeltasOver50Milliseconds: frameDeltas.filter((delta) => delta > 50)
      .length,
    frameDeltasOver100Milliseconds: frameDeltas.filter((delta) => delta > 100)
      .length,
  };
}

function createBrowserEnvironment() {
  return {
    userAgent: "Mozilla/5.0 Chrome/141.0.7390.76 Safari/537.36",
    version: "141.0.7390.76",
  };
}

function createRunEvidence() {
  return {
    schema: "copc-viewer.run-evidence",
    schemaVersion: 1,
    generatedAt: "2026-07-10T03:04:05.678Z",
    git: {
      headSha: "0".repeat(40),
      worktreeState: "dirty",
      fingerprint: {
        algorithm: "sha256",
        value: "1".repeat(64),
        trackedDiffByteLength: 10,
        trackedDiffSha256: "2".repeat(64),
        untrackedFileCount: 0,
        untrackedContentByteLength: 0,
        untrackedManifestSha256: "3".repeat(64),
        exclusions: ["output/**", "benchmarks/baselines/**"],
      },
    },
    runtime: {
      nodeVersion: "v22.17.0",
      platform: "win32",
      architecture: "x64",
      npm: {
        lifecycleEvent: "benchmark:smoothness",
        lifecycleScript: "node scripts/benchmark-smoothness.mjs",
        packageName: "@gaia3d/copc-cesium",
        packageVersion: "0.1.0",
        userAgent: "npm/11.4.2 node/v22.17.0 win32 x64",
      },
    },
  };
}

async function runAssertion(benchmark, assertionEnvironment = {}) {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "copc-smoothness-assertion-"),
  );
  const inputPath = path.join(temporaryRoot, "benchmark.json");
  const outputPath = path.join(temporaryRoot, "assertion.json");

  try {
    await writeFile(inputPath, `${JSON.stringify(benchmark, null, 2)}\n`);
    const processResult = spawnSync(
      process.execPath,
      [assertionScriptPath, "--input", inputPath, "--output", outputPath],
      {
        encoding: "utf8",
        env: createCleanAssertionEnvironment(assertionEnvironment),
      },
    );
    const report = JSON.parse(await readFile(outputPath, "utf8"));

    return {
      status: processResult.status,
      stderr: processResult.stderr,
      report,
    };
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

function createCleanAssertionEnvironment(assertionEnvironment = {}) {
  const env = { ...process.env };

  for (const name of Object.keys(env)) {
    if (name.startsWith("COPC_SMOOTHNESS_ASSERT_")) {
      delete env[name];
    }
  }

  env.COPC_SMOOTHNESS_ASSERT_MIN_GEOMETRY_CACHE_HITS = "1";

  return {
    ...env,
    ...assertionEnvironment,
  };
}
