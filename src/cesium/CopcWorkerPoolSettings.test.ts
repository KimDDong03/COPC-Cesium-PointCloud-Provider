import { describe, expect, it } from "vitest";
import { createCopcWorkerPoolSettings } from "./CopcWorkerPoolSettings";

describe("createCopcWorkerPoolSettings", () => {
  it("uses conservative fallbacks when hardware concurrency is unavailable", () => {
    expect(createCopcWorkerPoolSettings()).toEqual({
      pointSampleWorkerConcurrency: 4,
      pointSampleWorkerWarmupCount: 4,
      pointGeometryWorkerConcurrency: 5,
      pointGeometryWorkerWarmupCount: 5,
      decodedNodeWorkerFallbackDelayMilliseconds: Number.POSITIVE_INFINITY,
    });
  });

  it("keeps one hardware thread free while staying above the minimum", () => {
    expect(createCopcWorkerPoolSettings({ hardwareConcurrency: 8 })).toEqual({
      pointSampleWorkerConcurrency: 6,
      pointSampleWorkerWarmupCount: 4,
      pointGeometryWorkerConcurrency: 6,
      pointGeometryWorkerWarmupCount: 6,
      decodedNodeWorkerFallbackDelayMilliseconds: Number.POSITIVE_INFINITY,
    });
  });

  it("caps high-core machines so the viewer does not create unbounded workers", () => {
    expect(createCopcWorkerPoolSettings({ hardwareConcurrency: 32 })).toEqual({
      pointSampleWorkerConcurrency: 6,
      pointSampleWorkerWarmupCount: 4,
      pointGeometryWorkerConcurrency: 8,
      pointGeometryWorkerWarmupCount: 8,
      decodedNodeWorkerFallbackDelayMilliseconds: Number.POSITIVE_INFINITY,
    });
  });

  it("ignores invalid hardware concurrency values", () => {
    expect(createCopcWorkerPoolSettings({ hardwareConcurrency: 0 })).toEqual(
      createCopcWorkerPoolSettings(),
    );
    expect(createCopcWorkerPoolSettings({ hardwareConcurrency: 3.5 })).toEqual(
      createCopcWorkerPoolSettings(),
    );
  });

  it("allows latency-first decoded-node fallback tuning", () => {
    expect(
      createCopcWorkerPoolSettings({
        decodedNodeWorkerFallbackDelayMilliseconds: 0,
      }).decodedNodeWorkerFallbackDelayMilliseconds,
    ).toBe(0);
    expect(
      createCopcWorkerPoolSettings({
        decodedNodeWorkerFallbackDelayMilliseconds: -1,
      }).decodedNodeWorkerFallbackDelayMilliseconds,
    ).toBe(Number.POSITIVE_INFINITY);
  });
});
