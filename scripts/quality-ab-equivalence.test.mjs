import { describe, expect, it } from "vitest";
import { compareCameraPoseFingerprints } from "./quality-ab-equivalence.mjs";

describe("renderer quality A/B camera equivalence", () => {
  it("accepts sub-picoradian floating-point orientation noise", () => {
    const baseline = createFingerprint({ directionX: 0.392131627297986 });
    const candidate = createFingerprint({ directionX: 0.392131627297984 });
    const comparison = compareCameraPoseFingerprints(baseline, candidate);

    expect(comparison.matches).toBe(true);
    expect(comparison.maxOrientationDelta).toBeLessThan(2.1e-15);
    expect(comparison.positionToleranceMeters).toBe(0.00001);
    expect(comparison.relativeTolerance).toBe(1e-12);
  });

  it("rejects a camera position shifted by more than ten micrometres", () => {
    const baseline = createFingerprint({ positionX: -2_505_572 });
    const candidate = createFingerprint({ positionX: -2_505_571.999 });

    expect(
      compareCameraPoseFingerprints(baseline, candidate).matches,
    ).toBe(false);
  });

  it("rejects canvas and projection changes", () => {
    const baseline = createFingerprint({});
    const differentCanvas = createFingerprint({ canvasWidth: 1599 });
    const differentFov = createFingerprint({ fov: 1.0473 });

    expect(
      compareCameraPoseFingerprints(baseline, differentCanvas).matches,
    ).toBe(false);
    expect(
      compareCameraPoseFingerprints(baseline, differentFov).matches,
    ).toBe(false);
  });
});

function createFingerprint(options) {
  return [
    options.positionX ?? -2_505_572,
    -3_848_127,
    4_413_373,
    options.directionX ?? 0.392131627297986,
    0.602246430491831,
    -0.695364669675187,
    0.37942224880884,
    0.582727020946622,
    0.718657064369034,
    0.838016434195343,
    -0.545644990830598,
    0,
    options.canvasWidth ?? 1600,
    900,
    options.canvasWidth ?? 1600,
    900,
    1,
    options.fov ?? 1.0471975511966,
    1.77777777777778,
    0.1,
    10_000_000_000,
  ].join("|");
}
