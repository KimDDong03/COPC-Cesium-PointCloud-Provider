import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const benchmark = await readFile(
  new URL("./benchmark-persistent-range-cache.mjs", import.meta.url),
  "utf8",
);

describe("persistent range-cache browser benchmark contract", () => {
  it("starts cold from a verified empty persistent store and reloads the page", () => {
    expect(benchmark).toContain("clearPersistentRangeCache()");
    expect(benchmark).toContain("afterClearCacheStats?.cachedRangeCount === 0");
    expect(benchmark).toContain("afterClearCacheStats?.cachedRangeBytes === 0");
    expect(benchmark).toContain("Cold phase did not report browser HTTP cache clearing");
    expect(benchmark).toContain('page.reload({ waitUntil: "domcontentloaded" })');
    expect(benchmark).toContain("validateFreshReloadSignal");
  });

  it("uses bounded diagnostic waits and the additive high-detail terminal gate", () => {
    expect(benchmark).toContain("const phaseTimeoutMilliseconds = 120_000");
    expect(benchmark).toContain("page.waitForTimeout(1_000)");
    expect(benchmark).toContain("minSelectedDepth: 5");
    expect(benchmark).toContain("minRenderedPointCount: 300_000");
    expect(benchmark).toContain("minRequiredNodeCount: 64");
    expect(benchmark).toContain(
      "status.cameraStreamVisualQuality?.requiredNodeCount",
    );
    expect(benchmark).toContain(
      "status.cameraStreamVisualQuality?.renderedNodeCount",
    );
    expect(benchmark).toContain(
      'status?.cameraStreamPrefetchData?.state === "completed"',
    );
  });

  it("requires the cold and repeat phases to reproduce one visual workload", () => {
    expect(benchmark).toContain("camera pose fingerprints");
    expect(benchmark).toContain("different terminal node keys");
    expect(benchmark).toContain("different render signatures");
    expect(benchmark).toContain("different required/rendered node counts");
    expect(benchmark).toContain("Range validators differed");
    expect(benchmark).toContain("source byte lengths differed");
    expect(benchmark).toContain("terminalRenderInputHash=1");
    expect(benchmark).toContain("hasExactPointHashEvidence");
    expect(benchmark).toContain(
      "different terminal render-input hashes",
    );
  });

  it("validates response-confirmed Range traffic and repeat reduction", () => {
    expect(benchmark).toContain("validateRangeResponse(record)");
    expect(benchmark).toContain("Content-Range does not match requested Range");
    expect(benchmark).toContain(
      "Content-Length does not match requested Range length",
    );
    expect(benchmark).toContain("responseConfirmedBytes");
    expect(benchmark).toContain("Repeat upstream Range bytes were not reduced");
    expect(benchmark).toContain(
      "Repeat response-confirmed Range bytes were not reduced",
    );
  });

  it("keeps the persistent benchmark as the default mode and adds an edge mode", () => {
    expect(benchmark).toContain('process.argv.includes("--edge-range-cache")');
    expect(benchmark).toContain('"copc-viewer.persistent-range-cache-benchmark"');
    expect(benchmark).toContain('"copc-viewer.edge-range-cache-benchmark"');
    expect(benchmark).toContain("benchmarkMode === \"edge-range-cache\"");
  });

  it("runs edge mode through a fixed allowlisted Millsite route", () => {
    expect(benchmark).toContain("createCopcEdgeRangeCache");
    expect(benchmark).toContain('"/hobu-lidar/millsite.copc.laz"');
    expect(benchmark).toContain(
      '"https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz"',
    );
    expect(benchmark).toContain("COPC_SAMPLE_PROXY_ROOT");
    expect(benchmark).toContain("edgeSampleProxyRoot");
  });

  it("proves browser-cold edge warmup instead of relying on browser cache", () => {
    expect(benchmark).toContain("Network.clearBrowserCache");
    expect(benchmark).toContain("browserHttpCacheCleared: true");
    expect(benchmark).toContain("isPersistentStoreZeroed");
    expect(benchmark).toContain("edge-warm/browser-cold");
    expect(benchmark).toContain("Edge warm/browser-cold phase recorded no browser Range traffic");
    expect(benchmark).toContain(
      "Range request volume was below 90% of cold",
    );
    expect(benchmark).toContain(
      "response-confirmed bytes were below 90% of cold",
    );
  });

  it("requires edge origin and elapsed reductions from edge stats", () => {
    expect(benchmark).toContain("__copc_edge_cache_stats");
    expect(benchmark).toContain("edgeCacheSnapshots");
    expect(benchmark).toContain("warmBlockHits");
    expect(benchmark).toContain("validationRequests");
    expect(benchmark).toContain("warmOriginOperations");
    expect(benchmark).toContain("Edge warm origin operations were not reduced by at least 90%");
    expect(benchmark).toContain("Edge warm origin bytes were not reduced by at least 90%");
    expect(benchmark).toContain("Edge warm/browser-cold elapsed time was not reduced by at least 80%");
  });

  it("keeps the event loop live while browser run-code exercises the local edge server", () => {
    expect(benchmark).toContain("await runPlaywrightCliAsync([");
    expect(benchmark).toContain('"run-code"');
    expect(benchmark).toContain(
      "function runPlaywrightCliAsync(args, timeoutMilliseconds)",
    );
    expect(benchmark).toContain("browserRunTimeoutMilliseconds = 300_000");
    expect(benchmark).toContain("terminateProcessTree(child)");
    expect(benchmark).not.toContain('const browserOutput = runPlaywrightCli([\\n    "run-code"');
  });
});
