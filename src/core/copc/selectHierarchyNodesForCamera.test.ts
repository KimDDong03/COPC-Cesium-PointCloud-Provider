import { describe, expect, it } from "vitest";
import type { CopcHierarchyNodeSummary } from "./CopcHierarchySummary";
import { selectHierarchyNodesForCamera } from "./selectHierarchyNodesForCamera";

describe("selectHierarchyNodesForCamera", () => {
  it("returns undefined when no hierarchy nodes are available", () => {
    expect(
      selectHierarchyNodesForCamera([], {
        target: { x: 0, y: 0, z: 0 },
        viewportHeightPixels: 720,
      }),
    ).toBeUndefined();
  });

  it("ignores zero-point hierarchy entries during camera selection", () => {
    const selection = selectHierarchyNodesForCamera(
      [
        createNode("1-0-0-0", 1, 0, 0, 50),
        createNode("1-1-0-0", 1, 50, 0, 50, {
          pointCount: 0,
          pointDataLength: 0,
        }),
      ],
      {
        target: { x: 25, y: 25, z: 10 },
        viewportHeightPixels: 720,
        selectionMode: "coverage",
        minDepth: 1,
        maxDepth: 1,
        maxNodes: 2,
      },
    );

    expect(selection?.nodes.map((node) => node.key)).toEqual(["1-0-0-0"]);
    expect(selection?.depthEstimates).toEqual([
      expect.objectContaining({ depth: 1, nodeCount: 1 }),
    ]);
  });

  it("selects the nearest nodes at the camera-derived depth", () => {
    const selection = selectHierarchyNodesForCamera(createNodeGrid(), {
      target: { x: 62.5, y: 62.5, z: 10 },
      viewportHeightPixels: 720,
      maxNodes: 3,
      targetNodeScreenPixels: 220,
    });

    expect(selection?.targetDepth).toBe(2);
    expect(selection?.selectedDepth).toBe(2);
    expect(selection?.targetNodeScreenPixels).toBe(220);
    expect(selection?.estimatedSelectedDepthScreenPixels).toBe(720);
    expect(selection?.depthEstimates).toEqual([
      expect.objectContaining({
        depth: 0,
        nodeCount: 1,
        nearestNodeKey: "0-0-0-0",
        estimatedNodeScreenPixels: 720,
      }),
      expect.objectContaining({
        depth: 2,
        nodeCount: 16,
        nearestNodeKey: "2-2-2-0",
        estimatedNodeScreenPixels: 720,
      }),
    ]);
    expect(selection?.nodes.map((node) => node.key)).toEqual([
      "2-2-2-0",
      "2-1-2-0",
      "2-2-1-0",
    ]);
  });

  it("keeps target-based screen estimates when cameraPosition is omitted", () => {
    const target = { x: 200, y: 10, z: 10 };
    const options = {
      target,
      viewportHeightPixels: 720,
      maxNodes: 2,
      targetNodeScreenPixels: 220,
    } as const;
    const implicitCameraPosition = selectHierarchyNodesForCamera(
      createProgressiveDepthNodes(),
      options,
    );
    const explicitCameraPosition = selectHierarchyNodesForCamera(
      createProgressiveDepthNodes(),
      {
        ...options,
        cameraPosition: target,
      },
    );

    expect(explicitCameraPosition).toEqual(implicitCameraPosition);
  });

  it("does not reduce target or selected depth when the camera moves closer to the same view center", () => {
    const nodes = createProgressiveDepthNodes();
    const options = {
      target: { x: 95, y: 10, z: 0 },
      viewportHeightPixels: 720,
      maxNodes: 2,
      targetNodeScreenPixels: 220,
    } as const;
    const farSelection = selectHierarchyNodesForCamera(nodes, {
      ...options,
      cameraPosition: { x: 95, y: 10, z: 1_000 },
    });
    const nearSelection = selectHierarchyNodesForCamera(nodes, {
      ...options,
      cameraPosition: { x: 95, y: 10, z: 200 },
    });

    expect(farSelection).toBeDefined();
    expect(nearSelection).toBeDefined();
    expect(nearSelection?.targetDepth).toBeGreaterThanOrEqual(
      farSelection?.targetDepth ?? Number.POSITIVE_INFINITY,
    );
    expect(nearSelection?.selectedDepth).toBeGreaterThanOrEqual(
      farSelection?.selectedDepth ?? Number.POSITIVE_INFINITY,
    );
    expect(nearSelection?.targetDepth).toBeGreaterThan(
      farSelection?.targetDepth ?? Number.POSITIVE_INFINITY,
    );
    expect(nearSelection?.estimatedRootScreenPixels).toBeGreaterThan(
      farSelection?.estimatedRootScreenPixels ?? Number.POSITIVE_INFINITY,
    );
  });

  it("uses complete same-depth coverage when the node budget can cover the view", () => {
    const nearestSelection = selectHierarchyNodesForCamera(createNodeGrid(), {
      target: { x: 62.5, y: 62.5, z: 10 },
      viewportHeightPixels: 720,
      maxNodes: 4,
      targetNodeScreenPixels: 220,
    });
    const coverageSelection = selectHierarchyNodesForCamera(createNodeGrid(), {
      target: { x: 62.5, y: 62.5, z: 10 },
      viewportHeightPixels: 720,
      selectionMode: "coverage",
      maxNodes: 16,
      targetNodeScreenPixels: 220,
    });

    expect(coverageSelection?.selectionMode).toBe("coverage");
    expect(coverageSelection?.selectedDepth).toBe(2);
    expect(coverageSelection?.nodes).toHaveLength(16);
    expect(coverageSelection?.nodes.map((node) => node.key)).not.toEqual(
      nearestSelection?.nodes.map((node) => node.key),
    );
    expect(coverageSelection?.nodes.map((node) => node.key)).toContain(
      "2-0-0-0",
    );
    expect(coverageSelection?.reason).toContain("screen-coverage");
  });

  it("falls back to coarser coverage instead of leaving target-depth gaps", () => {
    const selection = selectHierarchyNodesForCamera(createNodeGrid(), {
      target: { x: 62.5, y: 62.5, z: 10 },
      viewportHeightPixels: 720,
      selectionMode: "coverage",
      maxNodes: 4,
      targetNodeScreenPixels: 220,
    });

    expect(selection?.targetDepth).toBe(2);
    expect(selection?.selectedDepth).toBe(0);
    expect(selection?.nodes.map((node) => node.key)).toEqual(["0-0-0-0"]);
    expect(selection?.skippedByBudgetCount).toBeGreaterThan(0);
  });

  it("can keep coarse coverage while adding distributed target-depth detail", () => {
    const selection = selectHierarchyNodesForCamera(createNodeGrid(), {
      target: { x: 62.5, y: 62.5, z: 10 },
      viewportHeightPixels: 720,
      selectionMode: "coverage",
      coverageMode: "progressive",
      maxNodes: 5,
      targetNodeScreenPixels: 220,
    });

    expect(selection?.coverageMode).toBe("progressive");
    expect(selection?.targetDepth).toBe(2);
    expect(selection?.selectedDepth).toBe(2);
    expect(selection?.nodes).toHaveLength(5);
    expect(selection?.nodes.map((node) => node.key)).toContain("0-0-0-0");
    expect(selection?.nodes.filter((node) => node.depth === 2)).toHaveLength(4);
    expect(selection?.reason).toContain("progressive screen-coverage");
  });

  it("selects a deterministic ancestor-free mixed-depth frontier", () => {
    const nodes = createMixedDepthTree();
    const options = {
      target: { x: 75, y: 25, z: 10 },
      cameraPosition: { x: 125, y: 25, z: 25 },
      viewportHeightPixels: 720,
      selectionMode: "coverage",
      coverageMode: "mixed-depth",
      maxNodes: 4,
      refineScreenSpaceError: 0,
    } as const;
    const selection = selectHierarchyNodesForCamera(nodes, options);
    const reversedSelection = selectHierarchyNodesForCamera(
      [...nodes].reverse(),
      options,
    );

    expect(selection?.coverageMode).toBe("mixed-depth");
    expect(selection?.nodes.map((node) => node.key)).toEqual([
      "1-0-0-0",
      "2-3-0-0",
    ]);
    expect(reversedSelection?.nodes.map((node) => node.key)).toEqual(
      selection?.nodes.map((node) => node.key),
    );
    expect(hasAncestorOverlap(selection?.nodes ?? [])).toBe(false);
    expect(selection?.selectedDepth).toBe(2);
    expect(selection?.reason).toContain("mixed-depth screen-coverage depths 1-2");
  });

  it("uses atomic visible sibling groups for mixed-depth refinement", () => {
    const nodes = createMixedDepthSiblingGroupTree();
    const options = {
      target: { x: 50, y: 25, z: 10 },
      cameraPosition: { x: 500, y: 25, z: 25 },
      viewportHeightPixels: 720,
      selectionMode: "coverage",
      coverageMode: "mixed-depth",
      targetNodeScreenPixels: 1_000,
      refineScreenSpaceError: 0,
    } as const;
    const partialBudgetSelection = selectHierarchyNodesForCamera(nodes, {
      ...options,
      maxNodes: 2,
      maxTotalPointCount: 2_000,
      maxTotalPointDataLength: 200,
    });
    const completeGroupSelection = selectHierarchyNodesForCamera(nodes, {
      ...options,
      maxNodes: 3,
      maxTotalPointCount: 3_000,
      maxTotalPointDataLength: 300,
    });
    const reversedSelection = selectHierarchyNodesForCamera(
      [...nodes].reverse(),
      {
        ...options,
        maxNodes: 3,
        maxTotalPointCount: 3_000,
        maxTotalPointDataLength: 300,
      },
    );

    expect(partialBudgetSelection?.targetDepth).toBe(0);
    expect(partialBudgetSelection?.nodes.map((node) => node.key)).toEqual([
      "0-0-0-0",
    ]);
    expect(completeGroupSelection?.nodes.map((node) => node.key)).toEqual([
      "1-0-0-0",
      "1-1-0-0",
    ]);
    expect(reversedSelection?.nodes.map((node) => node.key)).toEqual(
      completeGroupSelection?.nodes.map((node) => node.key),
    );
  });

  it("applies individual and aggregate budgets to the mixed-depth additive closure", () => {
    const nodes = createMixedDepthBudgetTree();
    const selection = selectHierarchyNodesForCamera(nodes, {
      target: { x: 75, y: 25, z: 10 },
      cameraPosition: { x: 125, y: 25, z: 25 },
      viewportHeightPixels: 720,
      selectionMode: "coverage",
      coverageMode: "mixed-depth",
      maxNodes: 4,
      maxNodePointCount: 200,
      maxNodePointDataLength: 100,
      maxTotalPointCount: 200,
      maxTotalPointDataLength: 80,
      refineScreenSpaceError: 0,
    });
    const tighterSelection = selectHierarchyNodesForCamera(nodes, {
      target: { x: 75, y: 25, z: 10 },
      cameraPosition: { x: 125, y: 25, z: 25 },
      viewportHeightPixels: 720,
      selectionMode: "coverage",
      coverageMode: "mixed-depth",
      maxNodes: 4,
      maxNodePointCount: 200,
      maxNodePointDataLength: 100,
      maxTotalPointCount: 199,
      maxTotalPointDataLength: 79,
      refineScreenSpaceError: 0,
    });

    expect(selection?.nodes.map((node) => node.key)).toEqual(["0-0-0-0"]);
    expect(selection?.skippedByBudgetCount).toBeGreaterThan(0);
    expect(
      selection?.nodes.reduce((total, node) => total + node.pointCount, 0),
    ).toBeLessThanOrEqual(200);
    expect(
      selection?.nodes.reduce(
        (total, node) => total + node.pointDataLength,
        0,
      ),
    ).toBeLessThanOrEqual(80);
    expect(tighterSelection?.nodes.map((node) => node.key)).toEqual([
      "0-0-0-0",
    ]);
  });

  it("passes previous mixed-depth frontiers through the hysteresis band", () => {
    const nodes = createMixedDepthHysteresisTree();
    const options = {
      target: { x: 75, y: 25, z: 10 },
      cameraPosition: { x: 200, y: 25, z: 25 },
      viewportHeightPixels: 720,
      selectionMode: "coverage",
      coverageMode: "mixed-depth",
      maxNodes: 4,
      refineScreenSpaceError: 400,
      retainScreenSpaceError: 300,
    } as const;
    const initialSelection = selectHierarchyNodesForCamera(nodes, options);
    const retainedSelection = selectHierarchyNodesForCamera(nodes, {
      ...options,
      previousFrontierKeys: ["2-3-0-0"],
    });
    const droppedSelection = selectHierarchyNodesForCamera(nodes, {
      ...options,
      cameraPosition: { x: 250, y: 25, z: 25 },
      previousFrontierKeys: ["2-3-0-0"],
    });

    expect(initialSelection?.nodes.map((node) => node.key)).toEqual([
      "1-0-0-0",
      "1-1-0-0",
    ]);
    expect(retainedSelection?.nodes.map((node) => node.key)).toEqual([
      "1-0-0-0",
      "2-3-0-0",
    ]);
    expect(droppedSelection?.nodes.map((node) => node.key)).toEqual([
      "1-0-0-0",
      "1-1-0-0",
    ]);
  });

  it("uses projected COPC spacing as mixed-depth screen-space error", () => {
    const nodes = createMixedDepthHysteresisTree();
    const options = {
      target: { x: 75, y: 25, z: 10 },
      cameraPosition: { x: 200, y: 25, z: 25 },
      viewportHeightPixels: 720,
      selectionMode: "coverage",
      coverageMode: "mixed-depth",
      maxNodes: 4,
      refineScreenSpaceError: 200,
    } as const;
    const lowerSpacingSelection = selectHierarchyNodesForCamera(nodes, {
      ...options,
      spacing: 32,
    });
    const targetSpacingSelection = selectHierarchyNodesForCamera(nodes, {
      ...options,
      spacing: 64,
    });
    const higherSpacingSelection = selectHierarchyNodesForCamera(nodes, {
      ...options,
      spacing: 128,
    });

    expect(lowerSpacingSelection?.nodes.map((node) => node.key)).toEqual([
      "1-0-0-0",
      "1-1-0-0",
    ]);
    expect(targetSpacingSelection?.nodes.map((node) => node.key)).toEqual([
      "1-0-0-0",
      "2-3-0-0",
    ]);
    expect(higherSpacingSelection?.nodes.map((node) => node.key)).toEqual([
      "1-0-0-0",
      "2-3-0-0",
    ]);
  });

  it("keeps the root baseline when the overview target is depth zero", () => {
    const selection = selectHierarchyNodesForCamera(
      createMixedDepthCoverageTree(),
      {
        target: { x: 50, y: 25, z: 10 },
        cameraPosition: { x: 500, y: 25, z: 25 },
        viewportHeightPixels: 720,
        selectionMode: "coverage",
        coverageMode: "mixed-depth",
        maxNodes: 3,
        maxTotalPointCount: 3_000,
        maxTotalPointDataLength: 300,
        targetNodeScreenPixels: 1_000,
        refineScreenSpaceError: 10_000,
      },
    );

    expect(selection?.targetDepth).toBe(0);
    expect(selection?.nodes.map((node) => node.key)).toEqual(["0-0-0-0"]);
    expect(hasAncestorOverlap(selection?.nodes ?? [])).toBe(false);
  });

  it("forms a visible-tree cut with shallower irregular terminal branches", () => {
    const nodes = createIrregularMixedDepthCoverageTree();
    const options = {
      target: { x: 10, y: 25, z: 10 },
      cameraPosition: { x: 125, y: 25, z: 25 },
      viewportHeightPixels: 720,
      selectionMode: "coverage",
      coverageMode: "mixed-depth",
      maxNodes: 4,
      targetNodeScreenPixels: 1,
      refineScreenSpaceError: 10_000,
    } as const;
    const selection = selectHierarchyNodesForCamera(nodes, options);
    const reversedSelection = selectHierarchyNodesForCamera(
      [...nodes].reverse(),
      options,
    );

    expect(selection?.targetDepth).toBe(3);
    expect(selection?.nodes.map((node) => node.key)).toEqual([
      "1-1-0-0",
      "2-0-0-0",
    ]);
    expect(reversedSelection?.nodes.map((node) => node.key)).toEqual(
      selection?.nodes.map((node) => node.key),
    );
    expect(hasAncestorOverlap(selection?.nodes ?? [])).toBe(false);
  });

  it("does not step two levels shallower when the intended baseline fits", () => {
    const selection = selectHierarchyNodesForCamera(
      createMixedDepthCoverageTree(),
      {
        target: { x: 100, y: 25, z: 10 },
        cameraPosition: { x: 125, y: 25, z: 25 },
        viewportHeightPixels: 720,
        selectionMode: "coverage",
        coverageMode: "mixed-depth",
        maxNodes: 7,
        maxTotalPointCount: 7_000,
        maxTotalPointDataLength: 700,
        targetNodeScreenPixels: 40,
        refineScreenSpaceError: 10_000,
      },
    );

    expect(selection?.targetDepth).toBe(4);
    expect(selection?.nodes.map((node) => node.key)).toEqual([
      "3-0-0-0",
      "3-7-0-0",
    ]);
    expect(hasAncestorOverlap(selection?.nodes ?? [])).toBe(false);
  });

  it("reserves a depth-three baseline before applying selective depth-four refinement", () => {
    const selection = selectHierarchyNodesForCamera(
      createMixedDepthCoverageTree(),
      {
        target: { x: 100, y: 25, z: 10 },
        cameraPosition: { x: 125, y: 25, z: 25 },
        viewportHeightPixels: 720,
        selectionMode: "coverage",
        coverageMode: "mixed-depth",
        maxNodes: 9,
        maxTotalPointCount: 9_000,
        maxTotalPointDataLength: 900,
        targetNodeScreenPixels: 40,
        refineScreenSpaceError: 100,
      },
    );

    expect(selection?.targetDepth).toBe(4);
    expect(selection?.nodes.map((node) => node.key)).toEqual([
      "3-0-0-0",
      "4-15-0-0",
    ]);
    expect(hasAncestorOverlap(selection?.nodes ?? [])).toBe(false);
    expect(selection?.reason).toContain("depths 3-4");
  });

  it("keeps coverage nodes at one depth instead of mixing sparse target-depth detail", () => {
    const selection = selectHierarchyNodesForCamera(
      createSparseCoverageDepthNodes(),
      {
        target: { x: 90, y: 90, z: 10 },
        viewportHeightPixels: 720,
        selectionMode: "coverage",
        maxNodes: 5,
        targetNodeScreenPixels: 220,
      },
    );

    expect(selection?.targetDepth).toBe(3);
    expect(selection?.selectedDepth).toBe(1);
    expect(selection?.nodes).toHaveLength(4);
    expect(selection?.nodes[0]?.key).toBe("1-1-1-0");
    expect(new Set(selection?.nodes.map((node) => node.key))).toEqual(
      new Set(["1-0-0-0", "1-0-1-0", "1-1-0-0", "1-1-1-0"]),
    );
    expect(new Set(selection?.nodes.map((node) => node.depth))).toEqual(
      new Set([1]),
    );
  });

  it("uses the nearest available depth when the target depth is missing", () => {
    const selection = selectHierarchyNodesForCamera(createSparseDepthNodes(), {
      target: { x: 150, y: 50, z: 10 },
      viewportHeightPixels: 720,
      maxNodes: 2,
      targetNodeScreenPixels: 220,
    });

    expect(selection?.targetDepth).toBe(3);
    expect(selection?.selectedDepth).toBe(3);
    expect(selection?.nodes).toHaveLength(2);
    expect(selection?.nodes.every((node) => node.depth === 3)).toBe(true);
  });

  it("culls nodes outside the camera view direction before applying budgets", () => {
    const selection = selectHierarchyNodesForCamera(createDirectionalNodes(), {
      target: { x: 0, y: 100, z: 25 },
      viewDirection: { x: 1, y: 0, z: 0 },
      maxViewAngleDegrees: 70,
      viewportHeightPixels: 720,
      minDepth: 1,
      maxDepth: 1,
      maxNodes: 4,
      targetNodeScreenPixels: 1_000,
    });

    expect(selection?.maxViewAngleDegrees).toBe(70);
    expect(selection?.skippedByViewCount).toBe(2);
    expect(selection?.depthEstimates).toEqual([
      expect.objectContaining({
        depth: 1,
        nodeCount: 2,
        nearestNodeKey: "1-1-0-0",
      }),
    ]);
    expect(selection?.nodes.map((node) => node.key)).toEqual([
      "1-1-0-0",
      "1-1-1-0",
    ]);
    expect(selection?.reason).toContain("Culled 2 off-camera candidate nodes.");
  });

  it("uses the shallowest depth that satisfies the target screen size", () => {
    const selection = selectHierarchyNodesForCamera(createProgressiveDepthNodes(), {
      target: { x: 200, y: 10, z: 10 },
      viewportHeightPixels: 720,
      maxNodes: 2,
      targetNodeScreenPixels: 220,
    });

    expect(selection?.targetDepth).toBe(2);
    expect(selection?.selectedDepth).toBe(2);
    expect(selection?.estimatedRootScreenPixels).toBe(720);
    expect(selection?.estimatedSelectedDepthScreenPixels).toBe(180);
    expect(selection?.depthEstimates.map((estimate) => ({
      depth: estimate.depth,
      nearestNodeKey: estimate.nearestNodeKey,
      estimatedNodeScreenPixels: estimate.estimatedNodeScreenPixels,
    }))).toEqual([
      {
        depth: 0,
        nearestNodeKey: "0-0-0-0",
        estimatedNodeScreenPixels: 720,
      },
      {
        depth: 1,
        nearestNodeKey: "1-1-0-0",
        estimatedNodeScreenPixels: 360,
      },
      {
        depth: 2,
        nearestNodeKey: "2-3-0-0",
        estimatedNodeScreenPixels: 180,
      },
      {
        depth: 3,
        nearestNodeKey: "3-7-0-0",
        estimatedNodeScreenPixels: 90,
      },
    ]);
  });

  it("uses COPC spacing as a point-spacing screen-space threshold", () => {
    const selection = selectHierarchyNodesForCamera(createProgressiveDepthNodes(), {
      target: { x: 200, y: 10, z: 10 },
      viewportHeightPixels: 720,
      maxNodes: 2,
      spacing: 64,
      targetNodeScreenPixels: 1_000,
      targetPointSpacingScreenPixels: 120,
    });

    expect(selection?.targetDepth).toBe(2);
    expect(selection?.selectedDepth).toBe(2);
    expect(selection?.spacing).toBe(64);
    expect(selection?.targetPointSpacingScreenPixels).toBe(120);
    expect(
      selection?.estimatedSelectedDepthPointSpacingScreenPixels,
    ).toBeCloseTo(115.2);
    expect(selection?.depthEstimates.map((estimate) => estimate.depth)).toEqual([
      0,
      1,
      2,
      3,
    ]);
    expect(selection?.depthEstimates[0]?.pointSpacing).toBe(64);
    expect(selection?.depthEstimates[1]?.pointSpacing).toBe(32);
    expect(selection?.depthEstimates[2]?.pointSpacing).toBe(16);
    expect(selection?.depthEstimates[3]?.pointSpacing).toBe(8);
    expect(
      selection?.depthEstimates[1]?.estimatedPointSpacingScreenPixels,
    ).toBeCloseTo(230.4);
    expect(
      selection?.depthEstimates[2]?.estimatedPointSpacingScreenPixels,
    ).toBeCloseTo(115.2);
  });

  it("falls back to a nearby depth when target-depth nodes exceed the node budget", () => {
    const selection = selectHierarchyNodesForCamera(createBudgetedDepthNodes(), {
      target: { x: 80, y: 80, z: 10 },
      viewportHeightPixels: 720,
      maxNodePointDataLength: 1_000,
      targetNodeScreenPixels: 220,
    });

    expect(selection?.targetDepth).toBe(2);
    expect(selection?.selectedDepth).toBe(1);
    expect(selection?.nodes.map((node) => node.key)).toEqual(["1-1-1-0"]);
  });

  it("limits selected nodes by total point-data budget", () => {
    const selection = selectHierarchyNodesForCamera(createNodeGrid(), {
      target: { x: 62.5, y: 62.5, z: 10 },
      viewportHeightPixels: 720,
      maxNodes: 4,
      maxTotalPointDataLength: 250,
      targetNodeScreenPixels: 220,
    });

    expect(selection?.nodes.map((node) => node.key)).toEqual([
      "2-2-2-0",
      "2-1-2-0",
    ]);
    expect(selection?.skippedByBudgetCount).toBe(14);
  });

  it("falls back to coarser coverage when target-depth point data exceeds the budget", () => {
    const selection = selectHierarchyNodesForCamera(createNodeGrid(), {
      target: { x: 62.5, y: 62.5, z: 10 },
      viewportHeightPixels: 720,
      selectionMode: "coverage",
      maxNodes: 16,
      maxTotalPointDataLength: 500,
      targetNodeScreenPixels: 220,
    });

    expect(selection?.targetDepth).toBe(2);
    expect(selection?.selectedDepth).toBe(0);
    expect(selection?.nodes.map((node) => node.key)).toEqual(["0-0-0-0"]);
    expect(selection?.skippedByBudgetCount).toBeGreaterThan(0);
  });

  it("rejects invalid selection limits", () => {
    expect(() =>
      selectHierarchyNodesForCamera(createSparseDepthNodes(), {
        target: { x: 0, y: 0, z: 0 },
        viewportHeightPixels: 720,
        maxNodes: 0,
      }),
    ).toThrow("maxNodes must be a positive integer.");

    expect(() =>
      selectHierarchyNodesForCamera(createSparseDepthNodes(), {
        target: { x: 0, y: 0, z: 0 },
        viewportHeightPixels: 720,
        selectionMode: "bad" as never,
      }),
    ).toThrow('selectionMode must be "nearest" or "coverage".');

    expect(() =>
      selectHierarchyNodesForCamera(createSparseDepthNodes(), {
        target: { x: 0, y: 0, z: 0 },
        viewportHeightPixels: 720,
        selectionMode: "coverage",
        coverageMode: "bad" as never,
      }),
    ).toThrow(
      'coverageMode must be "complete-depth", "progressive", or "mixed-depth".',
    );

    expect(() =>
      selectHierarchyNodesForCamera(createMixedDepthHysteresisTree(), {
        target: { x: 75, y: 25, z: 10 },
        cameraPosition: { x: 200, y: 25, z: 25 },
        viewportHeightPixels: 720,
        selectionMode: "coverage",
        coverageMode: "mixed-depth",
        maxNodes: 2,
        refineScreenSpaceError: 300,
        retainScreenSpaceError: 301,
      }),
    ).toThrow(
      "retainScreenSpaceError must be less than or equal to refineScreenSpaceError.",
    );

    expect(() =>
      selectHierarchyNodesForCamera(createMixedDepthHysteresisTree(), {
        target: { x: 75, y: 25, z: 10 },
        viewportHeightPixels: 720,
        selectionMode: "coverage",
        coverageMode: "mixed-depth",
        refineScreenSpaceError: -1,
      }),
    ).toThrow("refineScreenSpaceError must be a non-negative finite number.");
  });

  it("rejects invalid resource budgets", () => {
    expect(() =>
      selectHierarchyNodesForCamera(createSparseDepthNodes(), {
        target: { x: 0, y: 0, z: 0 },
        viewportHeightPixels: 720,
        maxNodePointDataLength: 0,
      }),
    ).toThrow("maxNodePointDataLength must be a positive finite number.");
  });

  it("rejects invalid spacing options", () => {
    expect(() =>
      selectHierarchyNodesForCamera(createSparseDepthNodes(), {
        target: { x: 0, y: 0, z: 0 },
        viewportHeightPixels: 720,
        spacing: 0,
      }),
    ).toThrow("spacing must be a positive finite number.");

    expect(() =>
      selectHierarchyNodesForCamera(createSparseDepthNodes(), {
        target: { x: 0, y: 0, z: 0 },
        viewportHeightPixels: 720,
        targetPointSpacingScreenPixels: 0,
      }),
    ).toThrow(
      "spacing is required when targetPointSpacingScreenPixels is provided.",
    );

    expect(() =>
      selectHierarchyNodesForCamera(createSparseDepthNodes(), {
        target: { x: 0, y: 0, z: 0 },
        viewportHeightPixels: 720,
        spacing: 64,
        targetPointSpacingScreenPixels: 0,
      }),
    ).toThrow(
      "targetPointSpacingScreenPixels must be a positive finite number.",
    );
  });

  it("rejects invalid view direction options", () => {
    expect(() =>
      selectHierarchyNodesForCamera(createSparseDepthNodes(), {
        target: { x: 0, y: 0, z: 0 },
        viewDirection: { x: 0, y: 0, z: 0 },
        viewportHeightPixels: 720,
      }),
    ).toThrow("viewDirection must be a non-zero vector.");

    expect(() =>
      selectHierarchyNodesForCamera(createSparseDepthNodes(), {
        target: { x: 0, y: 0, z: 0 },
        viewDirection: { x: 1, y: 0, z: 0 },
        viewportHeightPixels: 720,
        maxViewAngleDegrees: 180,
      }),
    ).toThrow("maxViewAngleDegrees must be between 0 and 180 degrees.");
  });
});

function createNodeGrid(): CopcHierarchyNodeSummary[] {
  const nodes: CopcHierarchyNodeSummary[] = [createNode("0-0-0-0", 0, 0, 0, 100)];

  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      nodes.push(createNode(`2-${x}-${y}-0`, 2, x * 25, y * 25, 25));
    }
  }

  return nodes;
}

function createSparseDepthNodes(): CopcHierarchyNodeSummary[] {
  return [
    createNode("0-0-0-0", 0, 0, 0, 100),
    createNode("3-6-3-0", 3, 75, 37.5, 12.5),
    createNode("3-6-4-0", 3, 75, 50, 12.5),
    createNode("3-7-3-0", 3, 87.5, 37.5, 12.5),
    createNode("3-7-4-0", 3, 87.5, 50, 12.5),
  ];
}

function createSparseCoverageDepthNodes(): CopcHierarchyNodeSummary[] {
  return [
    createNode("0-0-0-0", 0, 0, 0, 100),
    createNode("1-0-0-0", 1, 0, 0, 50),
    createNode("1-1-0-0", 1, 50, 0, 50),
    createNode("1-0-1-0", 1, 0, 50, 50),
    createNode("1-1-1-0", 1, 50, 50, 50),
    createNode("3-7-7-0", 3, 87.5, 87.5, 12.5),
  ];
}

function createBudgetedDepthNodes(): CopcHierarchyNodeSummary[] {
  return [
    createNode("0-0-0-0", 0, 0, 0, 100, {
      pointDataLength: 1_000,
    }),
    createNode("1-1-1-0", 1, 50, 50, 50, {
      pointDataLength: 800,
    }),
    createNode("2-3-3-0", 2, 75, 75, 25, {
      pointDataLength: 2_000,
    }),
  ];
}

function createDirectionalNodes(): CopcHierarchyNodeSummary[] {
  return [
    createNode("0-0-0-0", 0, -100, 0, 200),
    createNode("1-0-0-0", 1, -100, 50, 50),
    createNode("1-0-1-0", 1, -100, 100, 50),
    createNode("1-1-0-0", 1, 50, 50, 50),
    createNode("1-1-1-0", 1, 50, 100, 50),
  ];
}

function createProgressiveDepthNodes(): CopcHierarchyNodeSummary[] {
  return [
    createNode("0-0-0-0", 0, 0, 0, 100),
    createNode("1-1-0-0", 1, 50, 0, 50),
    createNode("2-3-0-0", 2, 75, 0, 25),
    createNode("3-7-0-0", 3, 87.5, 0, 12.5),
  ];
}

function createMixedDepthTree(): CopcHierarchyNodeSummary[] {
  return [
    createNode("0-0-0-0", 0, 0, 0, 100),
    createNode("1-0-0-0", 1, 0, 0, 50),
    createNode("1-1-0-0", 1, 50, 0, 50),
    createNode("2-3-0-0", 2, 75, 0, 25),
  ];
}

function createMixedDepthSiblingGroupTree(): CopcHierarchyNodeSummary[] {
  return [
    createNode("0-0-0-0", 0, 0, 0, 100),
    createNode("1-0-0-0", 1, 0, 0, 50),
    createNode("1-1-0-0", 1, 50, 0, 50),
  ];
}

function createMixedDepthBudgetTree(): CopcHierarchyNodeSummary[] {
  return [
    createNode("0-0-0-0", 0, 0, 0, 100, {
      pointCount: 100,
      pointDataLength: 40,
    }),
    createNode("1-0-0-0", 1, 0, 0, 50, {
      pointCount: 100,
      pointDataLength: 40,
    }),
    createNode("1-1-0-0", 1, 50, 0, 50, {
      pointCount: 500,
      pointDataLength: 200,
    }),
    createNode("2-3-0-0", 2, 75, 0, 25, {
      pointCount: 50,
      pointDataLength: 20,
    }),
  ];
}

function createMixedDepthHysteresisTree(): CopcHierarchyNodeSummary[] {
  return [
    createNode("0-0-0-0", 0, 0, 0, 100),
    createNode("1-0-0-0", 1, 0, 0, 50),
    createNode("1-1-0-0", 1, 50, 0, 50),
    createNode("2-3-0-0", 2, 75, 0, 25),
  ];
}

function createMixedDepthCoverageTree(): CopcHierarchyNodeSummary[] {
  return [
    createNode("0-0-0-0", 0, 0, 0, 100),
    createNode("1-0-0-0", 1, 0, 0, 50),
    createNode("1-1-0-0", 1, 50, 0, 50),
    createNode("2-0-0-0", 2, 0, 0, 25),
    createNode("2-3-0-0", 2, 75, 0, 25),
    createNode("3-0-0-0", 3, 0, 0, 12.5),
    createNode("3-7-0-0", 3, 87.5, 0, 12.5),
    createNode("4-0-0-0", 4, 0, 0, 6.25),
    createNode("4-15-0-0", 4, 93.75, 0, 6.25),
  ];
}

function createIrregularMixedDepthCoverageTree(): CopcHierarchyNodeSummary[] {
  return [
    createNode("0-0-0-0", 0, 0, 0, 100),
    createNode("1-0-0-0", 1, 0, 0, 50),
    createNode("1-1-0-0", 1, 50, 0, 50),
    createNode("2-0-0-0", 2, 0, 0, 25),
    createNode("3-0-0-0", 3, 0, 0, 12.5),
  ];
}

function hasAncestorOverlap(
  nodes: readonly CopcHierarchyNodeSummary[],
): boolean {
  return nodes.some((node, nodeIndex) =>
    nodes.some(
      (candidate, candidateIndex) =>
        candidateIndex !== nodeIndex && isAncestor(node, candidate),
    ),
  );
}

function isAncestor(
  ancestor: CopcHierarchyNodeSummary,
  descendant: CopcHierarchyNodeSummary,
): boolean {
  if (ancestor.depth >= descendant.depth) {
    return false;
  }

  const scale = 2 ** (descendant.depth - ancestor.depth);

  return (
    Math.floor(descendant.x / scale) === ancestor.x &&
    Math.floor(descendant.y / scale) === ancestor.y &&
    Math.floor(descendant.z / scale) === ancestor.z
  );
}

function createNode(
  key: string,
  depth: number,
  minX: number,
  minY: number,
  size: number,
  options: {
    readonly pointCount?: number;
    readonly pointDataLength?: number;
  } = {},
): CopcHierarchyNodeSummary {
  const bounds = {
    minX,
    minY,
    minZ: 0,
    maxX: minX + size,
    maxY: minY + size,
    maxZ: size,
  };

  return {
    key,
    depth,
    x: minX / size,
    y: minY / size,
    z: 0,
    bounds,
    pointCount: options.pointCount ?? 1000,
    pointDensity: 1,
    pointDataOffset: 0,
    pointDataLength: options.pointDataLength ?? 100,
  };
}
