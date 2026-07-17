import { describe, expect, it } from "vitest";
import { isInteractiveRenderReady } from "./interactive-render-status-policy.mjs";

const expectedRenderedStatuses = [
  "Camera stream terminal rendered",
  "Camera stream interactive-ready",
  "Camera stream previewed",
  "Camera stream partial render",
  "Auto LOD rendered",
];

function retainedTerminalStatus(overrides = {}) {
  return {
    cameraStreamRenderDisposition: "retained-exact-render",
    cameraStreamVisualQuality: {
      isTerminalReady: true,
      frontierDepthSpan: 0,
      isFrontierAntichain: true,
      isAdditiveClosureComplete: true,
      missingRequiredNodeCount: 0,
      unexpectedRenderedNodeCount: 0,
      pendingRelevantHierarchyPageCount: 0,
      ...overrides,
    },
  };
}

describe("interactive render status policy", () => {
  it("accepts the established rendered status messages", () => {
    expect(
      isInteractiveRenderReady(
        undefined,
        "Camera stream terminal rendered 20,000 points.",
        expectedRenderedStatuses,
      ),
    ).toBe(true);
  });

  it("accepts an exact retained render only with a clean terminal contract", () => {
    expect(
      isInteractiveRenderReady(
        retainedTerminalStatus(),
        "Camera stream retained the exact 53-node terminal render with 716,118 points.",
        expectedRenderedStatuses,
      ),
    ).toBe(true);
  });

  it("accepts an explicitly verified mixed-depth antichain", () => {
    expect(
      isInteractiveRenderReady(
        retainedTerminalStatus({
          terminalFrontierMode: "mixed-depth-antichain",
          frontierDepthSpan: 2,
          isFrontierDepthPolicySatisfied: true,
        }),
        "Camera stream retained the exact mixed-depth terminal render.",
        expectedRenderedStatuses,
      ),
    ).toBe(true);
  });

  it.each([
    ["nonterminal", { isTerminalReady: false }],
    ["mixed frontier", { frontierDepthSpan: 1 }],
    ["failed depth policy", { isFrontierDepthPolicySatisfied: false }],
    ["missing node", { missingRequiredNodeCount: 1 }],
    ["unexpected node", { unexpectedRenderedNodeCount: 1 }],
    ["visible hierarchy pending", { pendingRelevantHierarchyPageCount: 1 }],
  ])("rejects a retained render with %s evidence", (_label, overrides) => {
    expect(
      isInteractiveRenderReady(
        retainedTerminalStatus(overrides),
        "Camera stream retained the exact render.",
        expectedRenderedStatuses,
      ),
    ).toBe(false);
  });

  it("does not accept stale terminal evidence without exact-render disposition", () => {
    expect(
      isInteractiveRenderReady(
        {
          ...retainedTerminalStatus(),
          cameraStreamRenderDisposition: "new-render",
        },
        "Inspecting COPC source...",
        expectedRenderedStatuses,
      ),
    ).toBe(false);
  });

  it("does not treat a retained progress frame as an exact terminal render", () => {
    expect(
      isInteractiveRenderReady(
        {
          ...retainedTerminalStatus(),
          cameraStreamRenderDisposition: "retained-progress-render",
        },
        "Camera stream retained 120,000 points while target density loads.",
        expectedRenderedStatuses,
      ),
    ).toBe(false);
  });

  it("does not accept a previous exact render while a new stream is pending", () => {
    expect(
      isInteractiveRenderReady(
        retainedTerminalStatus(),
        "Streaming 53 COPC nodes for the new camera position...",
        expectedRenderedStatuses,
      ),
    ).toBe(false);
  });
});
