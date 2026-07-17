import { describe, expect, it } from "vitest";
import {
  COPC_POINT_CLOUD_QUALITY_SETTINGS,
  DEFAULT_COPC_POINT_CLOUD_QUALITY_PRESET,
  createCopcPointCloudQualitySettings,
} from "./CopcPointCloudQualitySettings";

describe("createCopcPointCloudQualitySettings", () => {
  it("returns the balanced preset by default", () => {
    expect(DEFAULT_COPC_POINT_CLOUD_QUALITY_PRESET).toBe("balanced");
    expect(createCopcPointCloudQualitySettings()).toEqual(
      COPC_POINT_CLOUD_QUALITY_SETTINGS.balanced,
    );
  });

  it("keeps preview, detail, and ultra presets ordered by render budget", () => {
    expect(
      COPC_POINT_CLOUD_QUALITY_SETTINGS.preview
        .cameraStreamMaxRenderedPointCount,
    ).toBeLessThan(
      COPC_POINT_CLOUD_QUALITY_SETTINGS.balanced
        .cameraStreamMaxRenderedPointCount,
    );
    expect(
      COPC_POINT_CLOUD_QUALITY_SETTINGS.balanced
        .cameraStreamMaxRenderedPointCount,
    ).toBeLessThan(
      COPC_POINT_CLOUD_QUALITY_SETTINGS.detail
        .cameraStreamMaxRenderedPointCount,
    );
    expect(
      COPC_POINT_CLOUD_QUALITY_SETTINGS.detail
        .cameraStreamMaxRenderedPointCount,
    ).toBeLessThan(
      COPC_POINT_CLOUD_QUALITY_SETTINGS.ultra
        .cameraStreamMaxRenderedPointCount,
    );
  });

  it("uses bounded adaptive point sizing for every quality preset", () => {
    for (const settings of Object.values(COPC_POINT_CLOUD_QUALITY_SETTINGS)) {
      expect(settings.pointSizeMode).toBe("adaptive");
      expect(settings.maxGeometryBatchesPerPrimitive).toBeGreaterThan(0);
      expect(Number.isSafeInteger(settings.maxGeometryBatchesPerPrimitive)).toBe(
        true,
      );
      expect(settings.minimumPointPixelSize).toBeGreaterThan(0);
      expect(settings.maximumPointPixelSize).toBeGreaterThanOrEqual(
        settings.minimumPointPixelSize,
      );
      expect(settings.adaptivePointSizeScale).toBeGreaterThan(0);
      expect(settings.splatCoverageScale).toBeGreaterThan(0);
      expect(settings.splatSafetyHaloPixels).toBeGreaterThanOrEqual(0);
      expect(["screen-circle", "ground-ellipse"]).toContain(
        settings.pointSplatShape,
      );
      expect(settings.eyeDomeLightingStrength).toBeGreaterThanOrEqual(0);
      expect(settings.eyeDomeLightingRadius).toBeGreaterThan(0);
    }
    expect(COPC_POINT_CLOUD_QUALITY_SETTINGS.preview.eyeDomeLighting).toBe(
      false,
    );
    expect(COPC_POINT_CLOUD_QUALITY_SETTINGS.balanced.eyeDomeLighting).toBe(
      true,
    );
    expect(
      COPC_POINT_CLOUD_QUALITY_SETTINGS.balanced.minimumPointPixelSize,
    ).toBe(1.75);
    expect(COPC_POINT_CLOUD_QUALITY_SETTINGS.balanced.pointSplatShape).toBe(
      "ground-ellipse",
    );
    expect(COPC_POINT_CLOUD_QUALITY_SETTINGS.balanced.sceneFxaa).toBe(false);
    expect(
      COPC_POINT_CLOUD_QUALITY_SETTINGS.balanced.splatSafetyHaloPixels,
    ).toBe(1.25);
    expect(
      COPC_POINT_CLOUD_QUALITY_SETTINGS.balanced
        .maxGeometryBatchesPerPrimitive,
    ).toBe(4);
    expect(
      COPC_POINT_CLOUD_QUALITY_SETTINGS.balanced.temporalLodSafeSwap,
    ).toBe(true);
  });

  it("returns a copy so callers can override locally", () => {
    const quality = createCopcPointCloudQualitySettings("preview");
    const mutableQuality = quality as {
      cameraStreamMaxRenderedPointCount: number;
    };

    mutableQuality.cameraStreamMaxRenderedPointCount = 1;

    expect(
      COPC_POINT_CLOUD_QUALITY_SETTINGS.preview
        .cameraStreamMaxRenderedPointCount,
    ).toBe(10_000);
  });
});
