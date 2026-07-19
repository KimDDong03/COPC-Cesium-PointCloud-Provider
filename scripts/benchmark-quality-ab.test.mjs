import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(
  new URL("./benchmark-quality-ab.mjs", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

describe("renderer quality A/B benchmark contract", () => {
  it("captures paired point-on and point-off Cesium canvases", () => {
    expect(source).toContain("canvas.screenshot({ path: capture.pointImagePath })");
    expect(source).toContain("clearPointCloudForVisualBenchmark");
    expect(source).toContain(
      "canvas.screenshot({ path: capture.backgroundImagePath })",
    );
    expect(source).toContain("createPointDifferenceMask");
  });

  it("hard-gates renderer-only camera and render equivalence", () => {
    expect(source).toContain("compareCameraPoseFingerprints");
    expect(source).toContain("cameraPose:");
    expect(source).toContain("renderSignature:");
    expect(source).toContain("renderedPointCount:");
    expect(source).toContain("selectedNodeKeys:");
    expect(source).toContain('verdict: !equivalent\n      ? "invalid"');
    expect(source).toContain(
      'comparisonMode === "renderer" ? "renderer-only" : comparisonMode',
    );
    expect(source).toContain(
      '...(comparisonMode === "edl" ? { comparisonMode } : {})',
    );
  });

  it("labels partial COPC response sizes as range lengths", () => {
    expect(source).toContain("rangeContentLength:");
    expect(source).not.toContain("contentLength:");
  });

  it("records screen-door quality and frame-time gates", () => {
    expect(source).toContain("coverageImproved");
    expect(source).toContain("boundedGapsReduced");
    expect(source).toContain("edgeComplexityReduced");
    expect(source).toContain("baselineShapeRetained");
    expect(source).toContain("candidateExpansionWithinSupport");
    expect(source).toContain("largeVoidsPreserved");
    expect(source).toContain("p95FrameTimeWithinBudget");
  });

  it("uses AB/BA repeats by default and exits on a needs-work verdict", () => {
    expect(source).toContain('readPositiveIntegerArgument("--repeats", 2)');
    expect(source).toContain('comparison.verdict !== "passed"');
  });

  it("supports an opt-in low-oblique fixed-pose regression mode", () => {
    expect(source).toContain('readEnumStringArgument("--camera-pose", "default"');
    expect(source).toContain('"low-oblique"');
    expect(source).toContain(
      "-2505623.54836943|-3848204.87079724|4412348.74858553",
    );
    expect(source).toContain("isolateSceneForVisualBenchmark");
    expect(source).toContain("setCameraPoseForVisualBenchmark");
    expect(source).toContain("measurePostRenderForVisualBenchmark");
    expect(source).toContain("cameraPoseMode");
    expect(source).toContain("fixedCameraPoseFingerprint");
    expect(source).toContain("artifactBaseName");
  });

  it("supports opt-in geometry-mask evidence without overwriting default artifacts", () => {
    expect(source).toContain('readBooleanArgument("--geometry-mask", false)');
    expect(source).toContain("geometryMaskBenchmark=1");
    expect(source).toContain("geometryMaskMode");
    expect(source).toContain("artifactNameParts");
    expect(source).toContain("${artifactBaseName}-flow${artifactSuffix}.mjs");
    expect(source).toContain("autzen-${quality}${idModeSuffix}");
  });

  it("supports specialized EDL geometry-vs-appearance comparison", () => {
    expect(source).toContain(
      'readEnumStringArgument("--comparison-mode", "renderer"',
    );
    expect(source).toContain('"edl"');
    expect(source).toContain(
      "--comparison-mode edl requires --camera-pose low-oblique.",
    );
    expect(source).toContain('variant: "geometry"');
    expect(source).toContain('variant: "appearance"');
    expect(source).toContain('renderVariant: "enhanced"');
    expect(source).toContain("capture.renderVariant");
    expect(source).toContain("capture.renderVariant ?? capture.variant");
    expect(source).toContain("capture.geometryMask");
    expect(source).toContain('geometryMask: true');
    expect(source).toContain('geometryMask: false');
    expect(source).toContain(
      'comparisonMode === "edl" ? "quality-edl" : "quality-ab"',
    );
  });

  it("records EDL mode config and applies appearance-specific gates", () => {
    expect(source).toContain("comparisonRoles");
    expect(source).toContain("geometryForegroundRetained");
    expect(source).toContain(
      "shapeSupportSummary.minimumBaselineForegroundRetentionRatio >= 0.95",
    );
    expect(source).toContain("unsupportedExpansionWithinSupport");
    expect(source).toContain(
      "shapeSupportSummary.maximumUnsupportedCandidateForegroundRatio <=",
    );
    expect(source).toContain("largeVoidIntrusionLimited");
    expect(source).toContain("appearanceCanvasCoverageRetained");
    expect(source).toContain(
      "baseline.visual.canvasCoverageRatio * 0.95",
    );
    expect(source).toContain("boundedGapsWithinBudget");
    expect(source).toContain("baseline.visual.boundedGapRatio + 0.035");
    expect(source).toContain("edgeComplexityWithinBudget");
    expect(source).toContain(
      "baseline.visual.edgePerimeterPerForegroundPixel + 0.1",
    );
    expect(source).toContain("p95FrameTimeWithinBudget");
  });

  it("defines a direct low-oblique EDL benchmark alias", () => {
    expect(packageJson.scripts["benchmark:quality-oblique"]).toBe(
      "node scripts/benchmark-quality-ab.mjs --camera-pose low-oblique --comparison-mode edl --quality balanced --point-budget 720000 --max-points-per-node 180000",
    );
  });
});
