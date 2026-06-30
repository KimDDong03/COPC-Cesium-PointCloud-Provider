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

  it("rejects invalid selection limits", () => {
    expect(() =>
      selectHierarchyNodesForCamera(createSparseDepthNodes(), {
        target: { x: 0, y: 0, z: 0 },
        viewportHeightPixels: 720,
        maxNodes: 0,
      }),
    ).toThrow("maxNodes must be a positive integer.");
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

function createProgressiveDepthNodes(): CopcHierarchyNodeSummary[] {
  return [
    createNode("0-0-0-0", 0, 0, 0, 100),
    createNode("1-1-0-0", 1, 50, 0, 50),
    createNode("2-3-0-0", 2, 75, 0, 25),
    createNode("3-7-0-0", 3, 87.5, 0, 12.5),
  ];
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
