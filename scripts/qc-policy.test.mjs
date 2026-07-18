import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  classifyQcStepFailure,
  getQcFailureGuidance,
} from "./qc-policy.mjs";

describe("QC policy", () => {
  test("preserves product and range classifications", () => {
    assert.equal(
      classifyQcStepFailure("product", "Unit tests", {
        status: 1,
        output: "assertion failed",
      }),
      "product-regression",
    );
    assert.equal(
      classifyQcStepFailure("release-functional", "Live COPC HTTP Range evidence", {
        status: 2,
        output: "range source unavailable",
      }),
      "external-source-unavailable",
    );
    assert.equal(
      classifyQcStepFailure("release-functional", "Live COPC HTTP Range evidence", {
        status: 1,
        output: "range contract failed",
      }),
      "live-source-contract-failure",
    );
  });

  test("keeps full live benchmark classification semantics unchanged", () => {
    assert.equal(
      classifyQcStepFailure("live", "Contest camera-stream smoothness QC", {
        status: 1,
        output: "Smoothness benchmark assertion failed: p95 frame time exceeded",
      }),
      "performance-regression",
    );
    assert.equal(
      classifyQcStepFailure("live", "Renderer benchmark", {
        status: 1,
        output: "Unexpected renderer invariant failure",
      }),
      "benchmark-execution-failure",
    );
  });

  test("classifies release package smoke failures separately from live benchmarks", () => {
    assert.equal(
      classifyQcStepFailure("release-functional", "Package consumer smoke", {
        status: 1,
        output: "TypeError: package export missing",
      }),
      "package-functional-regression",
    );
  });

  test("classifies release renderer and browser non-network failures as functional regressions", () => {
    for (const label of [
      "Renderer benchmark",
      "Browser example smoke",
      "Browser local-file smoke",
    ]) {
      assert.equal(
        classifyQcStepFailure("release-functional", label, {
          status: 1,
          output: "Unexpected renderer invariant failure",
        }),
        "live-functional-regression",
      );
    }
  });

  test("only preserves release external outage when the output classifier proves it", () => {
    assert.equal(
      classifyQcStepFailure("release-functional", "Browser example smoke", {
        status: 1,
        output: "net::ERR_NAME_NOT_RESOLVED",
      }),
      "external-source-unavailable",
    );
    assert.equal(
      classifyQcStepFailure("release-functional", "Browser example smoke", {
        status: 2,
        output: "Playwright assertion failed",
      }),
      "live-functional-regression",
    );
  });

  test("uses hosted release functional guidance for release failures", () => {
    assert.equal(
      getQcFailureGuidance(
        "release-functional",
        "live-functional-regression",
      ),
      "A hosted release functional check failed.",
    );
    assert.equal(
      getQcFailureGuidance("live", "benchmark-execution-failure"),
      "The live source was reachable, so this remains a blocking live-evidence failure.",
    );
    assert.equal(
      getQcFailureGuidance("product", "product-regression"),
      "A deterministic product check failed.",
    );
  });
});
