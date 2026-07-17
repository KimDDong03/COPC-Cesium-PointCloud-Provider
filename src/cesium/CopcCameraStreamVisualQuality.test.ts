import { describe, expect, it } from "vitest";
import {
  createCopcCameraStreamVisualQualityState,
  formatCopcCameraStreamVisualQuality,
  withCopcCameraStreamHierarchyQuality,
} from "./CopcCameraStreamVisualQuality";

describe("createCopcCameraStreamVisualQualityState", () => {
  it("accepts a complete additive closure for an antichain frontier", () => {
    const state = createCopcCameraStreamVisualQualityState({
      frontierNodeKeys: ["2-0-0-0", "2-1-0-0"],
      requiredNodeKeys: [
        "0-0-0-0",
        "1-0-0-0",
        "2-0-0-0",
        "2-1-0-0",
      ],
      renderedNodeKeys: [
        "0-0-0-0",
        "1-0-0-0",
        "2-0-0-0",
        "2-1-0-0",
      ],
    });

    expect(state).toMatchObject({
      terminalFrontierMode: "same-depth",
      frontierNodeCount: 2,
      frontierDepthSpan: 0,
      frontierAncestorOverlapCount: 0,
      requiredNodeCount: 4,
      renderedNodeCount: 4,
      missingRequiredNodeCount: 0,
      unexpectedRenderedNodeCount: 0,
      isFrontierAntichain: true,
      isFrontierDepthPolicySatisfied: true,
      isAdditiveClosureComplete: true,
      isTerminalReady: true,
    });
    expect(formatCopcCameraStreamVisualQuality(state)).toContain(
      "terminal-ready",
    );
  });

  it("rejects mixed frontier depths even when the branches do not overlap", () => {
    const state = createCopcCameraStreamVisualQualityState({
      frontierNodeKeys: ["2-0-0-0", "3-7-7-7"],
      requiredNodeKeys: [
        "0-0-0-0",
        "1-0-0-0",
        "1-1-1-1",
        "2-0-0-0",
        "2-3-3-3",
        "3-7-7-7",
      ],
      renderedNodeKeys: [
        "0-0-0-0",
        "1-0-0-0",
        "1-1-1-1",
        "2-0-0-0",
        "2-3-3-3",
        "3-7-7-7",
      ],
    });

    expect(state.frontierDepthSpan).toBe(1);
    expect(state.terminalFrontierMode).toBe("same-depth");
    expect(state.isFrontierAntichain).toBe(true);
    expect(state.isFrontierDepthPolicySatisfied).toBe(false);
    expect(state.isTerminalReady).toBe(false);
  });

  it("accepts a complete mixed-depth antichain only when explicitly enabled", () => {
    const state = createCopcCameraStreamVisualQualityState({
      frontierNodeKeys: ["2-0-0-0", "3-7-7-7"],
      requiredNodeKeys: [
        "0-0-0-0",
        "1-0-0-0",
        "1-1-1-1",
        "2-0-0-0",
        "2-3-3-3",
        "3-7-7-7",
      ],
      renderedNodeKeys: [
        "0-0-0-0",
        "1-0-0-0",
        "1-1-1-1",
        "2-0-0-0",
        "2-3-3-3",
        "3-7-7-7",
      ],
      terminalFrontierMode: "mixed-depth-antichain",
    });

    expect(state).toMatchObject({
      terminalFrontierMode: "mixed-depth-antichain",
      frontierDepthSpan: 1,
      isFrontierAntichain: true,
      isFrontierDepthPolicySatisfied: true,
      isAdditiveClosureComplete: true,
      isHierarchyCompleteForView: true,
      isTerminalReady: true,
    });
  });

  it("keeps antichain, additive, and hierarchy checks in mixed-depth mode", () => {
    const overlap = createCopcCameraStreamVisualQualityState({
      frontierNodeKeys: ["1-0-0-0", "2-0-0-0"],
      requiredNodeKeys: ["0-0-0-0", "1-0-0-0", "2-0-0-0"],
      renderedNodeKeys: ["0-0-0-0", "1-0-0-0", "2-0-0-0"],
      terminalFrontierMode: "mixed-depth-antichain",
    });
    const incompleteAdditiveClosure =
      createCopcCameraStreamVisualQualityState({
        frontierNodeKeys: ["2-0-0-0", "3-7-7-7"],
        requiredNodeKeys: ["0-0-0-0", "2-0-0-0", "3-7-7-7"],
        renderedNodeKeys: ["2-0-0-0", "3-7-7-7"],
        terminalFrontierMode: "mixed-depth-antichain",
      });
    const pendingHierarchy = createCopcCameraStreamVisualQualityState({
      frontierNodeKeys: ["2-0-0-0", "3-7-7-7"],
      requiredNodeKeys: ["0-0-0-0", "2-0-0-0", "3-7-7-7"],
      renderedNodeKeys: ["0-0-0-0", "2-0-0-0", "3-7-7-7"],
      pendingRelevantHierarchyPageCount: 1,
      terminalFrontierMode: "mixed-depth-antichain",
    });

    expect(overlap).toMatchObject({
      isFrontierDepthPolicySatisfied: true,
      isFrontierAntichain: false,
      isTerminalReady: false,
    });
    expect(incompleteAdditiveClosure).toMatchObject({
      isFrontierDepthPolicySatisfied: true,
      isAdditiveClosureComplete: false,
      isTerminalReady: false,
    });
    expect(pendingHierarchy).toMatchObject({
      isFrontierDepthPolicySatisfied: true,
      isHierarchyCompleteForView: false,
      isTerminalReady: false,
    });
  });

  it("rejects a progressive coarse/detail mixture as a terminal frontier", () => {
    const state = createCopcCameraStreamVisualQualityState({
      frontierNodeKeys: ["0-0-0-0", "2-1-0-0"],
      requiredNodeKeys: ["0-0-0-0", "1-0-0-0", "2-1-0-0"],
      renderedNodeKeys: ["0-0-0-0", "1-0-0-0", "2-1-0-0"],
    });

    expect(state.frontierAncestorOverlapCount).toBe(1);
    expect(state.isFrontierAntichain).toBe(false);
    expect(state.isTerminalReady).toBe(false);
  });

  it("rejects missing additive ancestors and stale rendered nodes", () => {
    const state = createCopcCameraStreamVisualQualityState({
      frontierNodeKeys: ["2-1-0-0"],
      requiredNodeKeys: ["0-0-0-0", "1-0-0-0", "2-1-0-0"],
      renderedNodeKeys: ["1-0-0-0", "2-1-0-0", "4-9-9-9"],
    });

    expect(state.missingRequiredNodeCount).toBe(1);
    expect(state.unexpectedRenderedNodeCount).toBe(1);
    expect(state.isAdditiveClosureComplete).toBe(false);
    expect(state.isTerminalReady).toBe(false);
  });

  it("does not call a complete additive plan terminal while the current view still has hierarchy pages", () => {
    const state = createCopcCameraStreamVisualQualityState({
      frontierNodeKeys: ["2-0-0-0"],
      requiredNodeKeys: ["0-0-0-0", "1-0-0-0", "2-0-0-0"],
      renderedNodeKeys: ["0-0-0-0", "1-0-0-0", "2-0-0-0"],
      pendingRelevantHierarchyPageCount: 1,
    });

    expect(state).toMatchObject({
      isAdditiveClosureComplete: true,
      isHierarchyCompleteForView: false,
      isTerminalReady: false,
      pendingRelevantHierarchyPageCount: 1,
    });
    expect(formatCopcCameraStreamVisualQuality(state)).toContain(
      "1 pending hierarchy page",
    );
  });

  it("does not call an additive plan terminal when hierarchy completeness is unknown", () => {
    const additiveState = createCopcCameraStreamVisualQualityState({
      frontierNodeKeys: ["1-0-0-0"],
      requiredNodeKeys: ["0-0-0-0", "1-0-0-0"],
      renderedNodeKeys: ["0-0-0-0", "1-0-0-0"],
    });
    const state = withCopcCameraStreamHierarchyQuality(
      additiveState,
      0,
      false,
    );

    expect(state).toMatchObject({
      isAdditiveClosureComplete: true,
      isHierarchyCompleteForView: false,
      isTerminalReady: false,
      pendingRelevantHierarchyPageCount: 0,
    });
    expect(formatCopcCameraStreamVisualQuality(state)).toContain(
      "hierarchy completeness unknown",
    );
  });

  it("rejects unsupported terminal frontier modes", () => {
    expect(() =>
      createCopcCameraStreamVisualQualityState({
        frontierNodeKeys: ["0-0-0-0"],
        requiredNodeKeys: ["0-0-0-0"],
        renderedNodeKeys: ["0-0-0-0"],
        terminalFrontierMode: "mixed" as never,
      }),
    ).toThrow(
      'terminalFrontierMode must be "same-depth" or "mixed-depth-antichain".',
    );
  });
});
