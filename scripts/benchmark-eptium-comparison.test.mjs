import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const [orchestrator, browserFlow] = await Promise.all([
  readFile(new URL("./benchmark-eptium-comparison.mjs", import.meta.url), "utf8"),
  readFile(new URL("./eptium-comparison-browser-flow.mjs", import.meta.url), "utf8"),
]);

describe("external Eptium comparison benchmark contract", () => {
  it("uses the same source entity, camera, canvas, browser GPU, and clean capture as hard validity gates", () => {
    expect(orchestrator).toContain("EXPECTED_AUTZEN_ETAG");
    expect(orchestrator).toContain("compareCameraPoseFingerprints");
    expect(orchestrator).toContain("browser GPU/WebGL equality");
    expect(orchestrator).toContain("clean canvas capture");
    expect(orchestrator).toContain("canvas/DPR");
    expect(orchestrator).toContain('verdict === "invalid"');
    expect(orchestrator).toContain('if (verdict !== "passed")');
  });

  it("separates stock visual output from EDL-off geometry masks and requires a stable counterfactual background", () => {
    expect(browserFlow).toContain("prepareCleanCanvasCapture");
    expect(browserFlow).toContain("visibleOverlays");
    expect(browserFlow).toContain("clearPointCloudForVisualBenchmark");
    expect(browserFlow).toContain("tileset.style.show = nextVisible");
    expect(browserFlow).toContain("tileset.makeStyleDirty()");
    expect(browserFlow).toContain(
      "tileset.pointCloudShading.eyeDomeLighting = false",
    );
    expect(browserFlow).toContain("geometryMaskBenchmark=1");
    expect(browserFlow).toContain("visualOutputImagePath");
    expect(browserFlow).toContain("backgroundImagePath");
    expect(orchestrator).toContain("analyzeOpaqueBlackImage");
    expect(orchestrator).toContain("point-off background is unstable");
    expect(orchestrator).toContain("blackness is diagnostic only");
  });

  it("records stable Eptium tileset statistics and stock/fair postRender performance separately", () => {
    expect(browserFlow).toContain("numberOfPointsSelected");
    expect(browserFlow).toContain("numberOfPendingRequests");
    expect(browserFlow).toContain("numberOfTilesProcessing");
    expect(browserFlow).toContain("stableCount < 8");
    expect(browserFlow).toContain('metricSource: "Cesium.Scene.postRender/performance.now"');
    expect(browserFlow).toContain("stock: stockPerformance");
    expect(browserFlow).toContain("fairness: fairnessPerformance");
  });

  it("does not treat rendered Eptium support as source-truth overfill", () => {
    expect(orchestrator).toContain("referenceSupportAssumption");
    expect(orchestrator).toContain("blocking: false");
    expect(orchestrator).toContain("Different LOD samples may contain different point IDs");
  });

  it("binds GPU evidence to the active Cesium canvas and applies both point-budget overrides to URLs", () => {
    expect(browserFlow).toContain('evidenceSource: "active-Cesium-canvas"');
    expect(browserFlow).toContain("window.viewer?.scene?.canvas");
    expect(browserFlow).toContain("configuration.oursBalancedPointBudgetOverride");
    expect(browserFlow).toContain("configuration.oursDetailPointBudgetOverride");
    expect(browserFlow).toContain("cameraStreamMaxPoints=");
    expect(orchestrator).toContain("readOptionalPositiveIntegerArgument");
    expect(orchestrator).toContain("observed ours-high-detail terminal point count");
    expect(orchestrator).toContain(
      "browserGpuRendererPattern: browserGpu.rendererPattern ?? null",
    );
  });

  it("accepts an optional non-negative coalesced-range gap and threads it through local benchmark evidence", () => {
    expect(orchestrator).toContain(
      "readOptionalNonNegativeSafeIntegerArgument(",
    );
    expect(orchestrator).toContain('"--max-coalesced-range-gap-bytes"');
    expect(orchestrator).toContain("maxCoalescedRangeGapBytes");
    expect(orchestrator).toContain("maxCoalescedPointDataRangeGapBytes");
    expect(browserFlow).toContain("configuration.maxCoalescedRangeGapBytes");
    expect(browserFlow).toContain(
      "maxCoalescedPointDataRangeGapBytes=",
    );
    expect(browserFlow).toContain("geometryMask: geometryMaskUrl");
    expect(browserFlow).toContain("product: oursUrl");
  });

  it("threads an optional point-geometry worker count through local comparison URLs and evidence", () => {
    expect(orchestrator).toContain(
      '"--point-geometry-worker-concurrency"',
    );
    expect(orchestrator).toContain("pointGeometryWorkerConcurrency");
    expect(orchestrator).toContain(
      "--point-geometry-worker-concurrency must be at most 8",
    );
    expect(browserFlow).toContain(
      "configuration.pointGeometryWorkerConcurrency",
    );
    expect(browserFlow).toContain("pointGeometryWorkerConcurrency=");
  });

  it("hard-gates local stock visual/performance and geometry-mask reloads to the same terminal workload", () => {
    expect(browserFlow).toContain("stockWorkloadStatus");
    expect(browserFlow).toContain("summarizeOursWorkloadStatus");
    expect(orchestrator).toContain("localStockMetricWorkloadChecks");
    expect(orchestrator).toContain("stock/geometry workload equality");
    expect(orchestrator).toContain("renderSignatureMatches");
    expect(orchestrator).toContain("selectedNodeKeysMatch");
  });

  it("records product-only request traffic without charging local geometry-mask evidence to the product", () => {
    expect(browserFlow).toContain('page.on("request"');
    expect(browserFlow).toContain('page.on("requestfinished"');
    expect(browserFlow).toContain('page.on("requestfailed"');
    expect(browserFlow).toContain('capture.captureId + ":product"');
    expect(browserFlow).toContain('capture.captureId + ":geometry-mask"');
    expect(browserFlow).toContain("sourceRequestState.get(request)");
    expect(orchestrator).toContain("summarizeSourceRequestTraffic");
    expect(orchestrator).toContain("product network measurement");
    expect(orchestrator).toContain(
      "local geometry-mask measurement reload excluded",
    );
    expect(orchestrator).toContain("eptium-comparison-network-trace.json");
  });

  it("separates first terminal observation from the stable terminal evidence wait", () => {
    expect(browserFlow).toContain("terminalObservation");
    expect(browserFlow).toContain("firstReadyWaitMilliseconds");
    expect(browserFlow).toContain("stableWaitMilliseconds");
    expect(browserFlow).toContain("productFirstReadyMilliseconds");
    expect(orchestrator).toContain("sharedPoseFirstTerminalMilliseconds");
  });
});
