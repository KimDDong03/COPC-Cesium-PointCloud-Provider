import { describe, expect, it } from "vitest";
import { hasExpectedPointGeometryTimingMetadata } from "./point-geometry-timing-contract.mjs";

describe("point geometry timing smoke contract", () => {
  it("accepts the current view-based timing wording", () => {
    expect(
      hasExpectedPointGeometryTimingMetadata(
        "5 nodes, 4 cache hits, max view 29.8 ms, max worker 52.1 ms",
      ),
    ).toBe(true);
  });

  it("keeps accepting the legacy decode-based timing wording", () => {
    expect(
      hasExpectedPointGeometryTimingMetadata(
        "5 nodes, 0 cache hits, max decode 29.8 ms, max worker 52.1 ms",
      ),
    ).toBe(true);
  });

  it("validates structured timing evidence when it is available", () => {
    expect(
      hasExpectedPointGeometryTimingMetadata(
        "5 nodes, 5 cache hits, max view 0 ms, max worker 0 ms",
        {
          nodeCount: 5,
          cacheHitCount: 5,
          workerTotalMilliseconds: 0,
          slowestNodes: [],
        },
      ),
    ).toBe(true);
  });

  it("retains the explicit unavailable fallback", () => {
    expect(
      hasExpectedPointGeometryTimingMetadata("Not available"),
    ).toBe(true);
  });

  it("rejects incomplete timing labels", () => {
    expect(
      hasExpectedPointGeometryTimingMetadata("5 nodes, timing pending"),
    ).toBe(false);
  });

  it("rejects missing visible metadata even when structured data exists", () => {
    expect(
      hasExpectedPointGeometryTimingMetadata("", {
        nodeCount: 5,
        cacheHitCount: 5,
        workerTotalMilliseconds: 0,
      }),
    ).toBe(false);
  });

  it("rejects malformed worker timing labels", () => {
    expect(
      hasExpectedPointGeometryTimingMetadata(
        "5 nodes, 4 cache hits, max view 20 ms, worker unavailable",
      ),
    ).toBe(false);
  });

  it("rejects impossible structured cache counts", () => {
    expect(
      hasExpectedPointGeometryTimingMetadata(
        "5 nodes, 6 cache hits, max view 20 ms, max worker 30 ms",
        {
          nodeCount: 5,
          cacheHitCount: 6,
          workerTotalMilliseconds: 30,
        },
      ),
    ).toBe(false);
  });

  it("rejects negative structured worker timing", () => {
    expect(
      hasExpectedPointGeometryTimingMetadata(
        "5 nodes, 4 cache hits, max view 20 ms, max worker -1 ms",
        {
          nodeCount: 5,
          cacheHitCount: 4,
          workerTotalMilliseconds: -1,
        },
      ),
    ).toBe(false);
  });
});
