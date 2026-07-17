import { describe, expect, it } from "vitest";
import {
  analyzePointCloudImagePair,
  analyzePointCloudMask,
  comparePointCloudMaskSupport,
  createMaskRgba,
  createPointDifferenceMask,
} from "./point-cloud-image-metrics.mjs";

describe("point cloud image metrics", () => {
  it("creates a point mask from a paired background image", () => {
    const background = createImage(2, 1, [0, 0, 0, 255, 10, 10, 10, 255]);
    const points = createImage(2, 1, [20, 0, 0, 255, 15, 15, 15, 255]);

    expect([...createPointDifferenceMask(points, background, 12)]).toEqual([
      1, 0,
    ]);
    expect(
      analyzePointCloudImagePair(points, background).primary
        .foregroundPixelCount,
    ).toBe(1);
  });

  it("reports complete coverage and a finite perimeter for a solid mask", () => {
    const mask = new Uint8Array(25).fill(1);
    const metrics = analyzePointCloudMask(mask, 5, 5, {
      gridColumns: 1,
      gridRows: 1,
    });

    expect(metrics.canvasCoverageRatio).toBe(1);
    expect(metrics.occupiedCellRatio).toBe(1);
    expect(metrics.boundedGapRatio).toBe(0);
    expect(metrics.isolatedForegroundRatio).toBe(0);
    expect(metrics.edgePerimeterPerForegroundPixel).toBe(0.8);
  });

  it("detects bounded one-to-three pixel screen-door gaps", () => {
    const mask = new Uint8Array([
      1, 0, 0, 1, 0, 0, 0, 0,
    ]);
    const metrics = analyzePointCloudMask(mask, 8, 1, {
      gridColumns: 1,
      gridRows: 1,
      gapRadius: 3,
      includeMorphology: false,
    });

    expect(metrics.boundedGapPixelCount).toBe(2);
    expect(metrics.boundedGapRatio).toBe(0.5);
  });

  it("measures a one-pixel interior hole with morphology closing", () => {
    const mask = new Uint8Array(49).fill(1);
    mask[3 * 7 + 3] = 0;
    const metrics = analyzePointCloudMask(mask, 7, 7, {
      gridColumns: 1,
      gridRows: 1,
    });

    expect(metrics.microHoleRatioByRadius["1"]).toEqual({
      filledPixelCount: 1,
      ratio: 1 / 49,
    });
  });

  it("writes a stable black-and-white RGBA mask", () => {
    expect([...createMaskRgba(new Uint8Array([0, 1]), 2, 1)]).toEqual([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]);
  });

  it("permits local splat growth but rejects large-void overfill", () => {
    const baseline = new Uint8Array(9 * 9);
    baseline[4 * 9 + 4] = 1;
    const localExpansion = new Uint8Array(baseline);
    localExpansion[4 * 9 + 5] = 1;
    const fullCanvas = new Uint8Array(9 * 9).fill(1);

    const local = comparePointCloudMaskSupport(
      baseline,
      localExpansion,
      9,
      9,
      { supportRadius: 1 },
    );
    const overfilled = comparePointCloudMaskSupport(
      baseline,
      fullCanvas,
      9,
      9,
      { supportRadius: 1 },
    );

    expect(local.unsupportedCandidateForegroundPixelCount).toBe(0);
    expect(local.largeVoidIntrusionRatio).toBe(0);
    expect(overfilled.unsupportedCandidateForegroundRatio).toBe(72 / 81);
    expect(overfilled.largeVoidIntrusionRatio).toBe(1);
  });
});

function createImage(width, height, values) {
  return {
    width,
    height,
    data: new Uint8Array(values),
  };
}
