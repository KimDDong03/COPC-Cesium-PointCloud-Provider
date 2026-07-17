import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(
  new URL("./benchmark-quality-ab.mjs", import.meta.url),
  "utf8",
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
});
