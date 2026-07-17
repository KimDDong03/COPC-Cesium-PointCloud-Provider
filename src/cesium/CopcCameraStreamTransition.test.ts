import { describe, expect, it } from "vitest";
import { createCopcCameraStreamSafeSwapState } from "./CopcCameraStreamTransition";

describe("createCopcCameraStreamSafeSwapState", () => {
  it("holds a dense previous frame while the coverage baseline is incomplete", () => {
    const state = createCopcCameraStreamSafeSwapState({
      candidate: createCandidate([
        ["0-0-0-0", 200],
        ["2-0-0-0", 5_800],
      ]),
      coverageNodeKeys: ["0-0-0-0", "1-0-0-0"],
      finalNodeKeys: ["0-0-0-0", "1-0-0-0", "2-0-0-0"],
      renderedPointBudget: 10_000,
      retainedRendererPointCount: 10_000,
    });

    expect(state).toMatchObject({
      canSwap: false,
      coverageNodeCount: 2,
      coveredCoverageNodeCount: 1,
      isCoverageBaselineComplete: false,
      minimumCandidatePointCount: 6_000,
    });
  });

  it("rejects a point-heavy frame concentrated in low-weight nodes", () => {
    const state = createCopcCameraStreamSafeSwapState({
      candidate: createCandidate([
        ["0-0-0-0", 1_000],
        ["1-0-0-0", 5_500],
      ]),
      coverageNodeKeys: ["0-0-0-0"],
      finalNodeKeys: ["0-0-0-0", "1-0-0-0", "1-1-0-0"],
      finalNodeWeights: [
        { nodeKey: "0-0-0-0", weight: 1 },
        { nodeKey: "1-0-0-0", weight: 1 },
        { nodeKey: "1-1-0-0", weight: 8 },
      ],
      renderedPointBudget: 10_000,
      retainedRendererPointCount: 10_000,
    });

    expect(state.pointRetentionRatio).toBe(0.65);
    expect(state.weightedFinalNodeCoverageRatio).toBe(0.2);
    expect(state.canSwap).toBe(false);
  });

  it("accepts a spatially complete candidate at the target density floor", () => {
    const state = createCopcCameraStreamSafeSwapState({
      candidate: createCandidate([
        ["0-0-0-0", 1_000],
        ["1-0-0-0", 2_000],
        ["1-1-0-0", 3_000],
      ]),
      coverageNodeKeys: ["0-0-0-0"],
      finalNodeKeys: ["0-0-0-0", "1-0-0-0", "1-1-0-0"],
      finalNodeWeights: [
        { nodeKey: "0-0-0-0", weight: 1 },
        { nodeKey: "1-0-0-0", weight: 1 },
        { nodeKey: "1-1-0-0", weight: 2 },
      ],
      renderedPointBudget: 10_000,
      retainedRendererPointCount: 10_000,
    });

    expect(state).toMatchObject({
      canSwap: true,
      isCoverageBaselineComplete: true,
      minimumCandidatePointCount: 6_000,
      pointRetentionRatio: 0.6,
      weightedFinalNodeCoverageRatio: 1,
    });
  });

  it("uses the smaller new-view budget when zooming out", () => {
    const state = createCopcCameraStreamSafeSwapState({
      candidate: createCandidate([["0-0-0-0", 3_000]]),
      coverageNodeKeys: ["0-0-0-0"],
      finalNodeKeys: ["0-0-0-0"],
      renderedPointBudget: 5_000,
      retainedRendererPointCount: 100_000,
    });

    expect(state.minimumCandidatePointCount).toBe(3_000);
    expect(state.canSwap).toBe(true);
  });
});

function createCandidate(
  nodeSamples: ReadonlyArray<readonly [nodeKey: string, pointCount: number]>,
) {
  return {
    nodeKeys: nodeSamples.map(([nodeKey]) => nodeKey),
    sampledPointCount: nodeSamples.reduce(
      (total, [, pointCount]) => total + pointCount,
      0,
    ),
    nodeSamples: nodeSamples.map(([nodeKey, pointCount]) => ({
      nodeKey,
      nodePointCount: Math.max(pointCount, 10_000),
      sampledPointCount: pointCount,
    })),
  };
}
