import { describe, expect, it } from "vitest";
import type {
  CopcHierarchyNodeCameraSelection,
  CopcHierarchyNodeSummary,
} from "../core";
import {
  createCopcCameraStreamMaxPointCountPerNode,
  createCopcCameraStreamRenderPlan,
} from "./CopcCameraStreamRenderPlan";
import type { CopcCameraStreamHierarchyLike } from "./CopcCameraStreamNodePlan";

describe("createCopcCameraStreamRenderPlan", () => {
  it("builds selected, coverage, final, preview, and signature values in one reusable plan", () => {
    const plan = createCopcCameraStreamRenderPlan({
      cameraSelection: cameraSelection([
        node("5-8-0-0", 20_000, 8_000),
        node("5-9-0-0", 20_000, 8_000),
      ]),
      configuredMaxPointCountPerNode: 12_000,
      effectiveNodePointDataLengthBudget: 2_048,
      effectivePointDataLengthBudget: 16_384,
      effectiveSourcePointBudget: 900_000,
      hierarchy: hierarchy([
        "0-0-0-0",
        "1-0-0-0",
        "2-1-0-0",
        "3-2-0-0",
        "4-4-0-0",
        "5-8-0-0",
        "5-9-0-0",
      ]),
      lodSettings: {
        maxDepth: 5,
        maxNodes: 96,
        targetNodeScreenPixels: 80,
      },
      previewMaxNodeCount: 8,
      previewMaxPointDataLength: 8_000,
      renderedPointBudget: 20_000,
    });

    expect(plan.selectedNodeKeys).toEqual(["5-8-0-0", "5-9-0-0"]);
    expect(plan.renderNodeKeys).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "2-1-0-0",
      "3-2-0-0",
      "4-4-0-0",
      "5-8-0-0",
      "5-9-0-0",
    ]);
    expect(plan.coverageNodeKeys).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "2-1-0-0",
    ]);
    expect(plan.finalNodeKeys).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "2-1-0-0",
      "3-2-0-0",
      "4-4-0-0",
      "5-8-0-0",
      "5-9-0-0",
    ]);
    expect(plan.finalSelectedNodeCount).toBe(2);
    expect(plan.maxPointCountPerNode).toBe(2_858);
    expect(plan.previewNodeKeys).toEqual(["2-1-0-0"]);
    expect(plan.nodeKeySignature).toBe(
      "0-0-0-0|1-0-0-0|2-1-0-0|3-2-0-0|4-4-0-0|5-8-0-0|5-9-0-0",
    );
    expect(plan.renderSignature).toBe(
      "0-0-0-0|1-0-0-0|2-1-0-0|3-2-0-0|4-4-0-0|5-8-0-0|5-9-0-0@20000@2858@5@80@96@2048@900000@16384",
    );
    expect(plan.useSourcePointBudgetHeadroom).toBe(false);
  });

  it("uses coverage nodes as final nodes when camera selection has no detail node keys", () => {
    const plan = createCopcCameraStreamRenderPlan({
      cameraSelection: cameraSelection([]),
      configuredMaxPointCountPerNode: 10_000,
      effectiveNodePointDataLengthBudget: 2_048,
      effectivePointDataLengthBudget: 16_384,
      effectiveSourcePointBudget: 900_000,
      hierarchy: hierarchy(["0-0-0-0"]),
      lodSettings: {
        maxDepth: 5,
        maxNodes: 96,
        targetNodeScreenPixels: 80,
      },
      previewMaxNodeCount: 8,
      previewMaxPointDataLength: 8_000,
      renderedPointBudget: 20_000,
    });

    expect(plan.selectedNodeKeys).toEqual([]);
    expect(plan.finalNodeKeys).toEqual([]);
    expect(plan.finalSelectedNodeCount).toBe(0);
    expect(plan.maxPointCountPerNode).toBe(10_000);
  });

  it("changes render signatures when budgets or LOD constraints change", () => {
    const baseOptions = {
      cameraSelection: cameraSelection([node("2-1-0-0")]),
      configuredMaxPointCountPerNode: 10_000,
      effectiveNodePointDataLengthBudget: 2_048,
      effectivePointDataLengthBudget: 16_384,
      effectiveSourcePointBudget: 900_000,
      hierarchy: hierarchy(["0-0-0-0", "1-0-0-0", "2-1-0-0"]),
      lodSettings: {
        maxDepth: 5,
        maxNodes: 96,
        targetNodeScreenPixels: 80,
      },
      previewMaxNodeCount: 8,
      previewMaxPointDataLength: 8_000,
      renderedPointBudget: 20_000,
    };

    const baseSignature =
      createCopcCameraStreamRenderPlan(baseOptions).renderSignature;
    const tighterSignature = createCopcCameraStreamRenderPlan({
      ...baseOptions,
      lodSettings: {
        ...baseOptions.lodSettings,
        targetNodeScreenPixels: 48,
      },
    }).renderSignature;

    expect(tighterSignature).not.toBe(baseSignature);
  });

  it("skips the coverage preview when the final detail set is already small", () => {
    const plan = createCopcCameraStreamRenderPlan({
      cameraSelection: cameraSelection([
        node("5-8-0-0", 20_000, 8_000),
        node("5-9-0-0", 20_000, 8_000),
      ]),
      configuredMaxPointCountPerNode: 12_000,
      effectiveNodePointDataLengthBudget: 2_048,
      effectivePointDataLengthBudget: 16_384,
      effectiveSourcePointBudget: 900_000,
      hierarchy: hierarchy([
        "0-0-0-0",
        "1-0-0-0",
        "2-1-0-0",
        "3-2-0-0",
        "4-4-0-0",
        "5-8-0-0",
        "5-9-0-0",
      ]),
      lodSettings: {
        maxDepth: 5,
        maxNodes: 96,
        targetNodeScreenPixels: 80,
      },
      previewMinFinalNodeCount: 3,
      previewMaxNodeCount: 8,
      previewMaxPointDataLength: 8_000,
      renderedPointBudget: 20_000,
    });

    expect(plan.finalNodeKeys).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "2-1-0-0",
      "3-2-0-0",
      "4-4-0-0",
      "5-8-0-0",
      "5-9-0-0",
    ]);
    expect(plan.previewNodeKeys).toEqual([]);
  });

  it("limits final detail nodes across the view when the point budget would make each node too sparse", () => {
    const plan = createCopcCameraStreamRenderPlan({
      cameraSelection: cameraSelection([
        node("5-0-0-0"),
        node("5-1-0-0"),
        node("5-2-0-0"),
        node("5-3-0-0"),
        node("5-4-0-0"),
        node("5-5-0-0"),
      ]),
      configuredMaxPointCountPerNode: 12_000,
      effectiveNodePointDataLengthBudget: 2_048,
      effectivePointDataLengthBudget: 16_384,
      effectiveSourcePointBudget: 900_000,
      hierarchy: hierarchy([
        "0-0-0-0",
        "1-0-0-0",
        "2-1-0-0",
        "5-0-0-0",
        "5-1-0-0",
        "5-2-0-0",
        "5-3-0-0",
        "5-4-0-0",
        "5-5-0-0",
      ]),
      lodSettings: {
        maxDepth: 5,
        maxNodes: 96,
        targetNodeScreenPixels: 80,
      },
      minFinalNodeCount: 2,
      minPointCountPerFinalNode: 2_000,
      previewMaxNodeCount: 8,
      previewMaxPointDataLength: 8_000,
      renderedPointBudget: 6_000,
    });

    expect(plan.finalNodeKeys).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "5-0-0-0",
      "5-5-0-0",
      "5-3-0-0",
    ]);
    expect(plan.maxPointCountPerNode).toBe(1_200);
  });

  it("preserves the complete frontier and additive closure without bypassing the legacy load cap", () => {
    const selectedNodes = [
      node("2-0-0-0"),
      node("2-1-0-0"),
      node("2-0-1-0"),
      node("2-1-1-0"),
    ];
    const plan = createCopcCameraStreamRenderPlan({
      cameraSelection: cameraSelection(selectedNodes, "complete-depth"),
      configuredMaxPointCountPerNode: 12_000,
      effectiveNodePointDataLengthBudget: 2_048,
      effectivePointDataLengthBudget: 16_384,
      effectiveSourcePointBudget: 900_000,
      hierarchy: hierarchy([
        "0-0-0-0",
        "1-0-0-0",
        ...selectedNodes.map((selectedNode) => selectedNode.key),
      ]),
      lodSettings: {
        maxDepth: 5,
        maxNodes: 96,
        targetNodeScreenPixels: 80,
      },
      maxFinalNodeCount: 2,
      minFinalNodeCount: 1,
      minPointCountPerFinalNode: 10_000,
      previewMaxNodeCount: 8,
      previewMaxPointDataLength: 8_000,
      renderedPointBudget: 20_000,
    });

    expect(plan.selectedNodeKeys).toHaveLength(4);
    expect(plan.finalSelectedNodeCount).toBe(4);
    expect(plan.finalNodeKeys).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "2-0-0-0",
      "2-1-0-0",
      "2-0-1-0",
      "2-1-1-0",
    ]);
    expect(plan.maxPointCountPerNode).toBe(3_334);
    expect(plan.useSourcePointBudgetHeadroom).toBe(false);
    expect(plan.renderSignature).not.toContain("@source-headroom");
  });

  it("uses configured source headroom for an ancestor-budgeted mixed-depth closure", () => {
    const selectedNodes = [
      node("2-0-0-0"),
      node("2-1-0-0"),
      node("2-0-1-0"),
      node("2-1-1-0"),
    ];
    const plan = createCopcCameraStreamRenderPlan({
      cameraSelection: cameraSelection(selectedNodes, "mixed-depth"),
      configuredMaxPointCountPerNode: 12_000,
      effectiveNodePointDataLengthBudget: 2_048,
      effectivePointDataLengthBudget: 16_384,
      effectiveSourcePointBudget: 900_000,
      hierarchy: hierarchy([
        "0-0-0-0",
        "1-0-0-0",
        ...selectedNodes.map((selectedNode) => selectedNode.key),
      ]),
      lodSettings: {
        maxDepth: 5,
        maxNodes: 96,
        targetNodeScreenPixels: 80,
      },
      previewMaxNodeCount: 8,
      previewMaxPointDataLength: 8_000,
      renderedPointBudget: 20_000,
    });

    expect(plan.finalNodeKeys).toHaveLength(6);
    expect(plan.maxPointCountPerNode).toBe(12_000);
    expect(plan.useSourcePointBudgetHeadroom).toBe(true);
    expect(plan.renderSignature).toContain("@source-headroom");
  });

  it("keeps the legacy rendered-budget load cap for a non-coverage selection", () => {
    const plan = createCopcCameraStreamRenderPlan({
      cameraSelection: {
        ...cameraSelection([node("2-0-0-0"), node("2-1-0-0")]),
        coverageMode: undefined,
      },
      configuredMaxPointCountPerNode: 12_000,
      effectiveNodePointDataLengthBudget: 2_048,
      effectivePointDataLengthBudget: 16_384,
      effectiveSourcePointBudget: 900_000,
      hierarchy: hierarchy([
        "0-0-0-0",
        "1-0-0-0",
        "2-0-0-0",
        "2-1-0-0",
      ]),
      lodSettings: {
        maxDepth: 5,
        maxNodes: 96,
        targetNodeScreenPixels: 80,
      },
      previewMaxNodeCount: 8,
      previewMaxPointDataLength: 8_000,
      renderedPointBudget: 10_000,
    });

    expect(plan.finalNodeKeys).toHaveLength(4);
    expect(plan.maxPointCountPerNode).toBe(2_500);
    expect(plan.useSourcePointBudgetHeadroom).toBe(false);
  });

  it("excludes zero-point selections from the terminal frontier and closure", () => {
    const renderableNode = node("2-0-0-0", 10_000, 8_000);
    const emptyNode = node("2-1-0-0", 0, 0);
    const plan = createCopcCameraStreamRenderPlan({
      cameraSelection: cameraSelection(
        [renderableNode, emptyNode],
        "complete-depth",
      ),
      configuredMaxPointCountPerNode: 12_000,
      effectiveNodePointDataLengthBudget: 2_048,
      effectivePointDataLengthBudget: 16_384,
      effectiveSourcePointBudget: 900_000,
      hierarchy: {
        nodes: [
          node("0-0-0-0"),
          node("1-0-0-0"),
          renderableNode,
          emptyNode,
        ],
      },
      lodSettings: {
        maxDepth: 5,
        maxNodes: 96,
        targetNodeScreenPixels: 80,
      },
      previewMaxNodeCount: 8,
      previewMaxPointDataLength: 8_000,
      renderedPointBudget: 20_000,
    });

    expect(plan.selectedNodeKeys).toEqual(["2-0-0-0"]);
    expect(plan.finalNodeKeys).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "2-0-0-0",
    ]);
    expect(plan.finalSelectedNodeCount).toBe(1);
  });

  it("caps final detail nodes across the view without concentrating them in one area", () => {
    const plan = createCopcCameraStreamRenderPlan({
      cameraSelection: cameraSelection([
        node("5-0-0-0"),
        node("5-4-0-0"),
        node("5-8-0-0"),
        node("5-12-0-0"),
        node("5-16-0-0"),
        node("5-20-0-0"),
        node("5-24-0-0"),
        node("5-28-0-0"),
      ]),
      configuredMaxPointCountPerNode: 12_000,
      effectiveNodePointDataLengthBudget: 2_048,
      effectivePointDataLengthBudget: 16_384,
      effectiveSourcePointBudget: 900_000,
      hierarchy: hierarchy([
        "0-0-0-0",
        "1-0-0-0",
        "2-1-0-0",
        "5-0-0-0",
        "5-4-0-0",
        "5-8-0-0",
        "5-12-0-0",
        "5-16-0-0",
        "5-20-0-0",
        "5-24-0-0",
        "5-28-0-0",
      ]),
      lodSettings: {
        maxDepth: 5,
        maxNodes: 96,
        targetNodeScreenPixels: 80,
      },
      maxFinalNodeCount: 4,
      minFinalNodeCount: 2,
      previewMaxNodeCount: 8,
      previewMaxPointDataLength: 8_000,
      renderedPointBudget: 96_000,
    });

    expect(plan.finalNodeKeys).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "2-1-0-0",
      "5-0-0-0",
      "5-8-0-0",
      "5-20-0-0",
      "5-28-0-0",
    ]);
    expect(plan.maxPointCountPerNode).toBe(12_000);
  });

  it("uses the LOD max point count as the final detail per-node cap", () => {
    const plan = createCopcCameraStreamRenderPlan({
      cameraSelection: cameraSelection([
        node("5-0-0-0", 20_000),
        node("5-1-0-0", 20_000),
        node("5-2-0-0", 20_000),
      ]),
      configuredMaxPointCountPerNode: 12_000,
      effectiveNodePointDataLengthBudget: 2_048,
      effectivePointDataLengthBudget: 16_384,
      effectiveSourcePointBudget: 900_000,
      hierarchy: hierarchy([
        "0-0-0-0",
        "1-0-0-0",
        "2-1-0-0",
        "5-0-0-0",
        "5-1-0-0",
        "5-2-0-0",
      ]),
      lodSettings: {
        maxDepth: 5,
        maxNodes: 96,
        targetNodeScreenPixels: 80,
      },
      previewMaxNodeCount: 8,
      previewMaxPointDataLength: 8_000,
      renderedPointBudget: 60_000,
      maxPointCountPerFinalNode: 2_500,
    });

    expect(plan.finalNodeKeys).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "5-0-0-0",
      "5-1-0-0",
      "5-2-0-0",
    ]);
    expect(plan.maxPointCountPerNode).toBe(2_500);
    expect(plan.renderSignature).toContain("@2500@");
  });
});

describe("createCopcCameraStreamMaxPointCountPerNode", () => {
  it("divides the rendered point budget across final nodes while respecting the configured cap", () => {
    expect(
      createCopcCameraStreamMaxPointCountPerNode({
        configuredMaxPointCountPerNode: 12_000,
        nodeCount: 4,
        renderedPointBudget: 20_000,
        maxPointCountPerFinalNode: 3_000,
      }),
    ).toBe(3_000);
    expect(
      createCopcCameraStreamMaxPointCountPerNode({
        configuredMaxPointCountPerNode: 12_000,
        nodeCount: 4,
        renderedPointBudget: 20_000,
        maxPointCountPerFinalNode: 8_000,
      }),
    ).toBe(5_000);
    expect(
      createCopcCameraStreamMaxPointCountPerNode({
        configuredMaxPointCountPerNode: 4_000,
        nodeCount: 4,
        renderedPointBudget: 20_000,
      }),
    ).toBe(4_000);
  });

  it("falls back to the configured per-node cap when there are no final nodes", () => {
    expect(
      createCopcCameraStreamMaxPointCountPerNode({
        configuredMaxPointCountPerNode: 12_000,
        nodeCount: 0,
        renderedPointBudget: 20_000,
      }),
    ).toBe(12_000);
  });

  it("respects the LOD max per-node cap when there are no final nodes", () => {
    expect(
      createCopcCameraStreamMaxPointCountPerNode({
        configuredMaxPointCountPerNode: 12_000,
        nodeCount: 0,
        renderedPointBudget: 20_000,
        maxPointCountPerFinalNode: 3_000,
      }),
    ).toBe(3_000);
  });

  it("keeps configured source headroom when explicitly enabled", () => {
    expect(
      createCopcCameraStreamMaxPointCountPerNode({
        configuredMaxPointCountPerNode: 12_000,
        nodeCount: 8,
        renderedPointBudget: 20_000,
        maxPointCountPerFinalNode: 1_000,
        useSourcePointBudgetHeadroom: true,
      }),
    ).toBe(12_000);
  });
});

function cameraSelection(
  nodes: readonly CopcHierarchyNodeSummary[],
  coverageMode: CopcHierarchyNodeCameraSelection["coverageMode"] = "progressive",
): CopcHierarchyNodeCameraSelection {
  return {
    nodes,
    targetDepth: 5,
    selectedDepth: 5,
    selectionMode: "coverage",
    coverageMode,
    estimatedRootScreenPixels: 720,
    estimatedSelectedDepthScreenPixels: 83,
    targetNodeScreenPixels: 80,
    estimatedSelectedDepthPointSpacingScreenPixels: 0.6,
    targetPointSpacingScreenPixels: 4,
    maxViewAngleDegrees: 80,
    spacing: undefined,
    depthEstimates: [],
    skippedByFrustumCount: 0,
    skippedByViewCount: 0,
    skippedByBudgetCount: 0,
    reason: "test",
  };
}

function hierarchy(nodeKeys: readonly string[]): CopcCameraStreamHierarchyLike {
  return {
    nodes: nodeKeys.map((nodeKey) => ({
      key: nodeKey,
      pointDataLength: 4_000,
    })),
  };
}

function node(
  key: string,
  pointCount = 1_000,
  pointDataLength = 4_000,
): CopcHierarchyNodeSummary {
  return {
    key,
    depth: Number(key.split("-")[0] ?? 0),
    x: 0,
    y: 0,
    z: 0,
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
    pointCount,
    pointDensity: pointCount,
    pointDataOffset: 0,
    pointDataLength,
  };
}
