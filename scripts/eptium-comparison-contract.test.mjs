import { describe, expect, it } from "vitest";
import {
  AUTZEN_SOURCE_URL,
  EPTIUM_STOCK_SCREEN_SPACE_ERROR,
  classifyPointCountEquivalence,
  createExternalCaptureConfigurations,
  createExternalCapturePlan,
  createExternalComparisonDefinitions,
  selectClosestEptiumCalibration,
  summarizeSourceRequestTraffic,
  summarizeSourceResponses,
} from "./eptium-comparison-contract.mjs";

describe("external Eptium comparison contract", () => {
  it("keeps shipped-default and equal-count comparisons separate", () => {
    const configurations = createExternalCaptureConfigurations({
      oursBalancedPointBudget: 360_000,
      oursDetailPointBudget: 720_000,
      stockEptiumPointCount: 1_047_575,
    });
    expect(configurations).toEqual([
      expect.objectContaining({
        id: "eptium-stock",
        screenSpaceError: EPTIUM_STOCK_SCREEN_SPACE_ERROR,
      }),
      expect.objectContaining({
        id: "ours-shipped-default",
        quality: "balanced",
        presetBasePointBudget: 360_000,
      }),
      expect.objectContaining({
        id: "ours-high-detail",
        quality: "detail",
        presetBasePointBudget: 720_000,
      }),
      expect.objectContaining({
        id: "ours-equal-count",
        pointBudget: 1_047_575,
      }),
    ]);
    expect(createExternalComparisonDefinitions()).toEqual([
      expect.objectContaining({
        id: "shipped-defaults",
        pointCountExpectation: "descriptive-non-equivalent-allowed",
      }),
      expect.objectContaining({
        id: "high-detail",
        pointCountExpectation: "descriptive-non-equivalent-allowed",
      }),
      expect.objectContaining({
        id: "equal-count",
        pointCountExpectation: "strict-equivalent",
      }),
    ]);
  });

  it("uses AB/BA-style reverse order on alternating repeats", () => {
    const configurations = createExternalCaptureConfigurations({
      oursBalancedPointBudget: 360_000,
      oursDetailPointBudget: 720_000,
      stockEptiumPointCount: 1_047_575,
    });
    const plan = createExternalCapturePlan(configurations, 2);
    expect(plan.slice(0, 4).map((capture) => capture.id)).toEqual([
      "eptium-stock",
      "ours-shipped-default",
      "ours-high-detail",
      "ours-equal-count",
    ]);
    expect(plan.slice(4).map((capture) => capture.id)).toEqual([
      "ours-equal-count",
      "ours-high-detail",
      "ours-shipped-default",
      "eptium-stock",
    ]);
  });

  it("labels a discrete closest SSE miss as non-equivalent, not invalid", () => {
    const closest = selectClosestEptiumCalibration(
      [
        { screenSpaceError: 32, pointCount: 1_047_575 },
        { screenSpaceError: 56, pointCount: 432_106 },
        { screenSpaceError: 64, pointCount: 336_364 },
      ],
      720_000,
    );
    expect(closest.screenSpaceError).toBe(56);
    expect(
      classifyPointCountEquivalence(720_000, closest.pointCount),
    ).toMatchObject({ classification: "non-equivalent" });
  });

  it("summarizes range provenance without calling partial bytes file size", () => {
    const summary = summarizeSourceResponses([
      {
        url: AUTZEN_SOURCE_URL,
        status: 206,
        etag: '"etag"',
        lastModified: "date",
        contentRange: "bytes 0-65535/81123042",
        rangeContentLength: "65536",
        acceptRanges: "bytes",
      },
    ]);
    expect(summary).toMatchObject({
      responseCount: 1,
      statuses: { 206: 1 },
      etags: ['"etag"'],
      totalLengths: [81_123_042],
      acceptsRanges: ["bytes"],
    });
    expect(summary.firstResponse).toHaveProperty(
      "rangeContentLength",
      "65536",
    );
    expect(summary.firstResponse).not.toHaveProperty("contentLength");
  });

  it("summarizes request traffic by scope and overall", () => {
    const otherUrl = "https://example.invalid/other.copc.laz";
    const summary = summarizeSourceRequestTraffic(
      [
        {
          scope: "metadata",
          url: AUTZEN_SOURCE_URL,
          requestRange: "bytes=0-99",
          status: 206,
          outcome: "finished",
          rangeContentLength: "100",
          sizes: { responseHeadersSize: 20 },
        },
        {
          scope: "metadata",
          url: AUTZEN_SOURCE_URL,
          requestRange: "bytes=0-99",
          status: 206,
          outcome: "finished",
          sizes: { responseBodySize: 100, responseHeadersSize: 30 },
        },
        {
          scope: "metadata",
          url: AUTZEN_SOURCE_URL,
          requestRange: "bytes=100-199",
          status: 206,
          outcome: "pending",
          sizes: { responseBodySize: 100, responseHeadersSize: 10 },
        },
        {
          scope: "points",
          url: AUTZEN_SOURCE_URL,
          requestRange: "bytes=150-249",
          status: 206,
          outcome: "failed",
          sizes: { responseBodySize: 100 },
        },
        {
          scope: "points",
          url: AUTZEN_SOURCE_URL,
          requestRange: "bytes=300-399",
          status: 500,
          outcome: "finished",
          rangeContentLength: Number.MAX_SAFE_INTEGER + 1,
          sizes: { responseHeadersSize: 5 },
        },
        {
          scope: "points",
          url: AUTZEN_SOURCE_URL,
          requestRange: "bytes=4500-4599",
          status: 206,
          outcome: "finished",
          sizes: { responseBodySize: 100, responseHeadersSize: 7 },
        },
        {
          scope: "points",
          url: AUTZEN_SOURCE_URL,
          requestRange: "bytes=900-",
          status: 0,
          outcome: "pending",
          sizes: { responseBodySize: -1, responseHeadersSize: 4 },
        },
        {
          scope: "metadata",
          url: otherUrl,
          requestRange: "bytes=0-9",
          status: 206,
          outcome: "finished",
          sizes: { responseBodySize: 10, responseHeadersSize: 10 },
        },
      ],
      AUTZEN_SOURCE_URL,
    );

    expect(summary.sourceUrl).toBe(AUTZEN_SOURCE_URL);
    expect(summary.overall).toMatchObject({
      requestCount: 7,
      finishedCount: 4,
      failedCount: 1,
      pendingCount: 2,
      statusCounts: { 0: 1, 206: 5, 500: 1 },
      requestedBytes: 600,
      receivedBodyBytes: 500,
      receivedHeaderBytes: 76,
      transferBytes: 576,
      validRangeCount: 6,
      unparsedRangeCount: 1,
      uniqueExactRangeCount: 5,
      exactDuplicateRequestCount: 1,
      exactDuplicateBytes: 100,
      unionUniqueRequestedBytes: 450,
      redundantOverlapBytes: 150,
    });
    expect(summary.overall.amplificationRatio).toBeCloseTo(600 / 450);
    expect(summary.overall.adjacentRanges).toEqual([
      { previous: "0-99", next: "100-199" },
    ]);
    expect(summary.overall.coalescingEstimates).toEqual({
      0: {
        spanCount: 3,
        requestReduction: 2,
        fetchedBytes: 450,
        overfetchBytes: 0,
      },
      4096: {
        spanCount: 2,
        requestReduction: 3,
        fetchedBytes: 500,
        overfetchBytes: 50,
      },
      16384: {
        spanCount: 1,
        requestReduction: 4,
        fetchedBytes: 4600,
        overfetchBytes: 4150,
      },
      65536: {
        spanCount: 1,
        requestReduction: 4,
        fetchedBytes: 4600,
        overfetchBytes: 4150,
      },
    });
    expect(summary.byScope.metadata).toMatchObject({
      requestCount: 3,
      validRangeCount: 3,
      uniqueExactRangeCount: 2,
      exactDuplicateRequestCount: 1,
      unionUniqueRequestedBytes: 200,
    });
    expect(summary.byScope.points).toMatchObject({
      requestCount: 4,
      validRangeCount: 3,
      unparsedRangeCount: 1,
      unionUniqueRequestedBytes: 300,
    });
  });

  it("treats missing sourceUrl as all request traffic", () => {
    const summary = summarizeSourceRequestTraffic([
      {
        url: AUTZEN_SOURCE_URL,
        requestRange: "bytes=0-9",
        outcome: "finished",
      },
      {
        url: "https://example.invalid/other.copc.laz",
        requestRange: "bytes=10-19",
        outcome: "finished",
      },
    ]);

    expect(summary.overall).toMatchObject({
      requestCount: 2,
      requestedBytes: 20,
      unionUniqueRequestedBytes: 20,
    });
  });

  it("keeps abandoned range intent separate from received response bytes", () => {
    const summary = summarizeSourceRequestTraffic(
      [
        {
          scope: "product",
          url: AUTZEN_SOURCE_URL,
          requestRange: "bytes=0-99",
          status: 206,
          outcome: "finished",
          rangeContentLength: "100",
        },
        {
          scope: "product",
          url: AUTZEN_SOURCE_URL,
          requestRange: "bytes=100-199",
          outcome: "abandoned",
        },
      ],
      AUTZEN_SOURCE_URL,
    );

    expect(summary.overall).toMatchObject({
      requestCount: 2,
      finishedCount: 1,
      abandonedCount: 1,
      pendingCount: 0,
      requestedBytes: 200,
      respondedRequestedBytes: 100,
      receivedBodyBytes: 100,
    });
  });
});
