import { describe, expect, it } from "vitest";
import { createCameraHierarchyFollowupSignature } from "./createCameraHierarchyFollowupSignature";

describe("createCameraHierarchyFollowupSignature", () => {
  it("keeps hierarchy-complete followups distinct across refined depths", () => {
    const depthFour = createCameraHierarchyFollowupSignature(
      {
        pendingRelevantHierarchyPageCount: 0,
        pendingRelevantHierarchyPageSignature: undefined,
        isHierarchyCompleteForView: true,
        refinedThroughDepth: 4,
      },
      ["5-1-2-3", "4-0-1-2"],
    );
    const depthFive = createCameraHierarchyFollowupSignature(
      {
        pendingRelevantHierarchyPageCount: 0,
        pendingRelevantHierarchyPageSignature: undefined,
        isHierarchyCompleteForView: true,
        refinedThroughDepth: 5,
      },
      ["4-0-1-2", "5-1-2-3"],
    );

    expect(depthFour).not.toBe(depthFive);
    expect(depthFour).toContain("depth:4|complete");
    expect(depthFive).toContain("depth:5|complete");
  });

  it("remains stable when selected node order changes at the same depth", () => {
    const refinement = {
      pendingRelevantHierarchyPageCount: 1,
      pendingRelevantHierarchyPageSignature: "5-1-2-3:100:32",
      isHierarchyCompleteForView: false,
      refinedThroughDepth: 5,
    } as const;

    expect(
      createCameraHierarchyFollowupSignature(refinement, ["5-1-2-3", "4-0-1-2"]),
    ).toBe(
      createCameraHierarchyFollowupSignature(refinement, ["4-0-1-2", "5-1-2-3"]),
    );
  });
});
