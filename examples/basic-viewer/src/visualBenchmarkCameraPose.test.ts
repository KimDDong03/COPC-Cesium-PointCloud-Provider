import { describe, expect, it } from "vitest";
import {
  assertVisualBenchmarkCameraPoseAccess,
  formatVisualBenchmarkCameraPoseFingerprint,
  parseVisualBenchmarkCameraPoseFingerprint,
} from "./visualBenchmarkCameraPose";

const EPTIUM_AUTZEN_CAMERA_POSE =
  "-2505572.94618036|-3848127.15457743|4413373.60468756|0.392131627297984|0.602246430491832|-0.695364669675187|0.379422248808840|0.582727020946622|0.718657064369034|0.838016434195343|-0.545644990830597|-1.72084568816899e-15|1600|900|1600|900|1|1.04719755119660|1.77777777777778|0.1|10000000000";

describe("visual benchmark camera pose", () => {
  it("round-trips the 21-field Eptium Autzen fingerprint", () => {
    const parsed = parseVisualBenchmarkCameraPoseFingerprint(
      EPTIUM_AUTZEN_CAMERA_POSE,
    );
    const roundTripped = parseVisualBenchmarkCameraPoseFingerprint(
      formatVisualBenchmarkCameraPoseFingerprint(parsed),
    );

    expect(roundTripped).toEqual(parsed);
    expect(
      formatVisualBenchmarkCameraPoseFingerprint(parsed).split("|"),
    ).toHaveLength(21);
  });

  it.each([
    ["too few fields", "1|2|3"],
    ["non-finite", EPTIUM_AUTZEN_CAMERA_POSE.replace("|0.1|", "|NaN|")],
    ["invalid canvas", EPTIUM_AUTZEN_CAMERA_POSE.replace("|1600|900|", "|0|900|")],
    ["invalid direction", EPTIUM_AUTZEN_CAMERA_POSE.replace("0.392131627297984", "0")],
    ["invalid frustum", EPTIUM_AUTZEN_CAMERA_POSE.replace("|0.1|10000000000", "|10|1")],
  ])("rejects %s input", (_name, fingerprint) => {
    expect(() =>
      parseVisualBenchmarkCameraPoseFingerprint(fingerprint),
    ).toThrow();
  });

  it("rejects camera injection outside visual benchmark mode", () => {
    expect(() => assertVisualBenchmarkCameraPoseAccess(false)).toThrow(
      "visualBenchmark=1",
    );
    expect(() => assertVisualBenchmarkCameraPoseAccess(true)).not.toThrow();
  });
});
