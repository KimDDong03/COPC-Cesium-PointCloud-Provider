import { describe, expect, it } from "vitest";
import type { CopcHierarchyNodeSummary } from "./CopcHierarchySummary";
import {
  CopcMixedDepthRequiredCoverageError,
  planMixedDepthHierarchyTraversal,
  type CopcMixedDepthNodeViewState,
} from "./planMixedDepthHierarchyTraversal";

describe("planMixedDepthHierarchyTraversal", () => {
  it("keeps the parent frontier when only one visible sibling can fit", () => {
    const nodes = [
      node("0-0-0-0"),
      node("1-0-0-0"),
      node("1-1-0-0"),
    ];
    const viewStates = nodes.map((candidate) => view(candidate.key, 20));
    const baseOptions = {
      refineScreenSpaceError: 10,
      refinementMode: "visible-sibling-group",
      requiredNodeKeys: ["0-0-0-0"],
    } as const;
    const plan = planMixedDepthHierarchyTraversal(nodes, viewStates, {
      ...baseOptions,
      maxNodes: 2,
      maxPointCount: 100,
      maxPointDataLength: 100,
    });
    const pointLimitedPlan = planMixedDepthHierarchyTraversal(
      nodes,
      viewStates,
      {
        ...baseOptions,
        maxNodes: 3,
        maxPointCount: 20,
        maxPointDataLength: 100,
      },
    );
    const byteLimitedPlan = planMixedDepthHierarchyTraversal(
      nodes,
      viewStates,
      {
        ...baseOptions,
        maxNodes: 3,
        maxPointCount: 100,
        maxPointDataLength: 20,
      },
    );

    expect(keys(plan.plannedNodes)).toEqual(["0-0-0-0"]);
    expect(keys(plan.frontierNodes)).toEqual(["0-0-0-0"]);
    expect(keys(pointLimitedPlan.frontierNodes)).toEqual(["0-0-0-0"]);
    expect(keys(byteLimitedPlan.frontierNodes)).toEqual(["0-0-0-0"]);
    expect(plan.budgetUsage).toEqual({
      nodeCount: 1,
      pointCount: 10,
      pointDataLength: 10,
    });
    expect(plan.diagnostics).toMatchObject({
      refinementMode: "visible-sibling-group",
      eligibleCandidateCount: 1,
      selectedCandidateCount: 0,
      skippedByBudgetCount: 1,
      isBudgetLimited: true,
    });
  });

  it("atomically replaces a parent with every visible renderable sibling", () => {
    const nodes = [
      node("0-0-0-0"),
      node("1-0-0-0"),
      node("1-1-0-0"),
      node("1-0-1-0", { pointCount: 0, pointDataLength: 0 }),
      node("1-1-1-0"),
    ];
    const plan = planMixedDepthHierarchyTraversal(
      nodes,
      [
        view("0-0-0-0", 0),
        view("1-0-0-0", 20),
        view("1-1-0-0", 20),
        view("1-0-1-0", 20),
        view("1-1-1-0", 20, { visible: false }),
      ],
      {
        maxNodes: 3,
        maxPointCount: 30,
        maxPointDataLength: 30,
        refineScreenSpaceError: 10,
        refinementMode: "visible-sibling-group",
        requiredNodeKeys: ["0-0-0-0"],
      },
    );

    expect(keys(plan.plannedNodes)).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "1-1-0-0",
    ]);
    expect(keys(plan.frontierNodes)).toEqual([
      "1-0-0-0",
      "1-1-0-0",
    ]);
    expect(plan.budgetUsage).toEqual({
      nodeCount: 3,
      pointCount: 30,
      pointDataLength: 30,
    });
  });

  it("refines a high-error parent when its target-depth children are already below the threshold", () => {
    const nodes = [
      node("0-0-0-0"),
      node("1-0-0-0"),
      node("1-1-0-0"),
    ];
    const plan = planMixedDepthHierarchyTraversal(
      nodes,
      [
        view("0-0-0-0", 12),
        view("1-0-0-0", 5),
        view("1-1-0-0", 5),
      ],
      {
        maxNodes: 3,
        refineScreenSpaceError: 10,
        refinementMode: "visible-sibling-group",
        requiredNodeKeys: ["0-0-0-0"],
      },
    );

    expect(keys(plan.frontierNodes)).toEqual([
      "1-0-0-0",
      "1-1-0-0",
    ]);
  });

  it("keeps a below-threshold parent when its children are also below the threshold", () => {
    const nodes = [
      node("0-0-0-0"),
      node("1-0-0-0"),
      node("1-1-0-0"),
    ];
    const plan = planMixedDepthHierarchyTraversal(
      nodes,
      [
        view("0-0-0-0", 9),
        view("1-0-0-0", 5),
        view("1-1-0-0", 5),
      ],
      {
        maxNodes: 3,
        refineScreenSpaceError: 10,
        refinementMode: "visible-sibling-group",
        requiredNodeKeys: ["0-0-0-0"],
      },
    );

    expect(keys(plan.frontierNodes)).toEqual(["0-0-0-0"]);
  });

  it("retains a previous child frontier while its parent remains inside the hysteresis band", () => {
    const nodes = [
      node("0-0-0-0"),
      node("1-0-0-0"),
      node("1-1-0-0"),
    ];
    const plan = planMixedDepthHierarchyTraversal(
      nodes,
      [
        view("0-0-0-0", 9),
        view("1-0-0-0", 5),
        view("1-1-0-0", 5),
      ],
      {
        maxNodes: 3,
        refineScreenSpaceError: 10,
        retainScreenSpaceError: 8,
        refinementMode: "visible-sibling-group",
        requiredNodeKeys: ["0-0-0-0"],
        previousFrontierKeys: ["1-0-0-0"],
      },
    );

    expect(keys(plan.frontierNodes)).toEqual([
      "1-0-0-0",
      "1-1-0-0",
    ]);
    expect(plan.retainedPreviousFrontierKeys).toEqual(["1-0-0-0"]);
  });

  it("recursively refines atomic groups into a deterministic mixed-depth cut", () => {
    const nodes = createRecursiveSiblingGroupTree();
    const viewStates = createRecursiveSiblingGroupViewStates();
    const options = {
      maxNodes: 7,
      maxPointCount: 70,
      maxPointDataLength: 70,
      refineScreenSpaceError: 10,
      refinementMode: "visible-sibling-group",
      requiredNodeKeys: ["1-0-0-0", "1-1-0-0"],
    } as const;
    const plan = planMixedDepthHierarchyTraversal(nodes, viewStates, options);
    const reversedPlan = planMixedDepthHierarchyTraversal(
      [...nodes].reverse(),
      [...viewStates].reverse(),
      options,
    );

    expect(keys(plan.frontierNodes)).toEqual([
      "1-1-0-0",
      "2-1-0-0",
      "3-0-0-0",
      "3-1-0-0",
    ]);
    expect(isAntichain(plan.frontierNodes)).toBe(true);
    expect(plan.budgetUsage).toEqual({
      nodeCount: 7,
      pointCount: 70,
      pointDataLength: 70,
    });
    expect(plan.diagnostics).toMatchObject({
      eligibleCandidateCount: 3,
      selectedCandidateCount: 2,
      skippedByBudgetCount: 1,
    });
    expect(keys(reversedPlan.plannedNodes)).toEqual(keys(plan.plannedNodes));
    expect(keys(reversedPlan.frontierNodes)).toEqual(keys(plan.frontierNodes));
    expect(reversedPlan.budgetUsage).toEqual(plan.budgetUsage);
  });

  it("uses a previous descendant frontier to retain its complete sibling group", () => {
    const nodes = [
      node("0-0-0-0"),
      node("1-0-0-0"),
      node("1-1-0-0"),
    ];
    const plan = planMixedDepthHierarchyTraversal(
      nodes,
      [
        view("0-0-0-0", 0),
        view("1-0-0-0", 9),
        view("1-1-0-0", 9),
      ],
      {
        maxNodes: 3,
        refineScreenSpaceError: 10,
        retainScreenSpaceError: 8,
        refinementMode: "visible-sibling-group",
        requiredNodeKeys: ["0-0-0-0"],
        previousFrontierKeys: ["1-0-0-0"],
      },
    );

    expect(keys(plan.frontierNodes)).toEqual([
      "1-0-0-0",
      "1-1-0-0",
    ]);
    expect(plan.retainedPreviousFrontierKeys).toEqual(["1-0-0-0"]);
  });

  it("preserves a full spatial baseline while deeply refining one branch", () => {
    const baselineNodeKeys = createFullDepthOneNodeKeys();
    const deepRefinementNodeKey = "2-0-0-0";
    const nodes = [
      node("0-0-0-0"),
      ...baselineNodeKeys.map((key) => node(key)),
      node(deepRefinementNodeKey),
    ];
    const plan = planMixedDepthHierarchyTraversal(
      nodes,
      [
        view("0-0-0-0", 0),
        ...baselineNodeKeys.map((key) => view(key, 1)),
        view(deepRefinementNodeKey, 100, { visualBenefit: 1_000 }),
      ],
      {
        maxNodes: 10,
        maxPointCount: 100,
        maxPointDataLength: 100,
        refineScreenSpaceError: 10,
        requiredNodeKeys: baselineNodeKeys,
      },
    );
    const unrefinedBaselineNodeKeys = baselineNodeKeys.filter(
      (key) => key !== "1-0-0-0",
    );

    expect(keys(plan.plannedNodes)).toEqual([
      "0-0-0-0",
      ...baselineNodeKeys,
      deepRefinementNodeKey,
    ]);
    expect(keys(plan.frontierNodes)).toEqual([
      ...unrefinedBaselineNodeKeys,
      deepRefinementNodeKey,
    ]);
    expect(isAntichain(plan.frontierNodes)).toBe(true);
    expect(
      new Set(plan.frontierNodes.map((candidate) => candidate.depth)),
    ).toEqual(new Set([1, 2]));
    expect(plan.budgetUsage).toEqual({
      nodeCount: 10,
      pointCount: 100,
      pointDataLength: 100,
    });
    expect(plan.diagnostics).toMatchObject({
      requiredCoverageNodeCount: 8,
      requiredCoverageClosureNodeCount: 9,
      requiredCoverageBudgetUsage: {
        nodeCount: 9,
        pointCount: 90,
        pointDataLength: 90,
      },
    });
  });

  it("selects deterministic mixed-depth frontiers regardless of input order", () => {
    const nodes = createMixedDepthTree();
    const viewStates = [
      view("0-0-0-0", 1),
      view("1-0-0-0", 24, { visualBenefit: 40 }),
      view("2-0-0-0", 30, { visualBenefit: 100 }),
      view("1-1-0-0", 22, { visualBenefit: 70 }),
    ];
    const options = {
      maxNodes: 4,
      refineScreenSpaceError: 10,
    } as const;
    const forward = planMixedDepthHierarchyTraversal(
      nodes,
      viewStates,
      options,
    );
    const reversed = planMixedDepthHierarchyTraversal(
      [...nodes].reverse(),
      [...viewStates].reverse(),
      options,
    );

    expect(keys(forward.plannedNodes)).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "1-1-0-0",
      "2-0-0-0",
    ]);
    expect(keys(forward.frontierNodes)).toEqual([
      "1-1-0-0",
      "2-0-0-0",
    ]);
    expect(new Set(forward.frontierNodes.map((node) => node.depth))).toEqual(
      new Set([1, 2]),
    );
    expect(keys(forward.ancestorNodes)).toEqual([
      "0-0-0-0",
      "1-0-0-0",
    ]);
    expect(keys(reversed.plannedNodes)).toEqual(keys(forward.plannedNodes));
    expect(keys(reversed.frontierNodes)).toEqual(keys(forward.frontierNodes));
    expect(reversed.budgetUsage).toEqual(forward.budgetUsage);
  });

  it("ranks visual benefit per normalized resource cost", () => {
    const nodes = [
      node("0-0-0-0", { pointCount: 10, pointDataLength: 10 }),
      node("1-0-0-0", { pointCount: 10, pointDataLength: 10 }),
      node("1-1-0-0", { pointCount: 100, pointDataLength: 100 }),
    ];
    const plan = planMixedDepthHierarchyTraversal(
      nodes,
      [
        view("0-0-0-0", 1),
        view("1-0-0-0", 20, { visualBenefit: 60 }),
        view("1-1-0-0", 20, { visualBenefit: 100 }),
      ],
      {
        maxNodes: 3,
        maxPointCount: 111,
        maxPointDataLength: 111,
        refineScreenSpaceError: 10,
      },
    );

    expect(keys(plan.plannedNodes)).toEqual(["0-0-0-0", "1-0-0-0"]);
    expect(plan.budgetUsage).toEqual({
      nodeCount: 2,
      pointCount: 20,
      pointDataLength: 20,
    });
    expect(plan.diagnostics.refinementMode).toBe("node");
    expect(plan.diagnostics.skippedByBudgetCount).toBe(1);
    expect(plan.diagnostics.isBudgetLimited).toBe(true);
  });

  it("never exceeds node, point, or compressed-byte budgets", () => {
    const nodes = [
      node("0-0-0-0", { pointCount: 10, pointDataLength: 8 }),
      node("1-0-0-0", { pointCount: 15, pointDataLength: 12 }),
      node("1-1-0-0", { pointCount: 15, pointDataLength: 12 }),
      node("2-0-0-0", { pointCount: 20, pointDataLength: 16 }),
    ];
    const plan = planMixedDepthHierarchyTraversal(
      nodes,
      nodes.map((candidate, index) =>
        view(candidate.key, 20 + index, { visualBenefit: 20 + index }),
      ),
      {
        maxNodes: 3,
        maxPointCount: 40,
        maxPointDataLength: 32,
        refineScreenSpaceError: 10,
      },
    );

    expect(plan.budgetUsage.nodeCount).toBeLessThanOrEqual(3);
    expect(plan.budgetUsage.pointCount).toBeLessThanOrEqual(40);
    expect(plan.budgetUsage.pointDataLength).toBeLessThanOrEqual(32);
    expect(plan.plannedNodes.every((candidate) =>
      candidate.depth === 0 ||
      plan.plannedNodes.some(
        (parent) => parent.key === expectedParentKey(candidate),
      ),
    )).toBe(true);
  });

  it("retains a previous frontier inside the hysteresis band", () => {
    const nodes = [
      node("0-0-0-0"),
      node("1-0-0-0"),
      node("1-1-0-0"),
    ];
    const plan = planMixedDepthHierarchyTraversal(
      nodes,
      [
        view("0-0-0-0", 1),
        view("1-0-0-0", 9),
        view("1-1-0-0", 9),
      ],
      {
        maxNodes: 3,
        refineScreenSpaceError: 10,
        retainScreenSpaceError: 8,
        previousFrontierKeys: ["1-0-0-0"],
      },
    );

    expect(keys(plan.plannedNodes)).toEqual(["0-0-0-0", "1-0-0-0"]);
    expect(plan.retainedPreviousFrontierKeys).toEqual(["1-0-0-0"]);
    expect(plan.droppedPreviousFrontierKeys).toEqual([]);
    expect(plan.diagnostics.skippedByScreenSpaceErrorCount).toBe(1);
  });

  it("drops a previous frontier after it leaves the hysteresis band", () => {
    const plan = planMixedDepthHierarchyTraversal(
      [node("0-0-0-0"), node("1-0-0-0")],
      [view("0-0-0-0", 1), view("1-0-0-0", 7)],
      {
        maxNodes: 2,
        refineScreenSpaceError: 10,
        retainScreenSpaceError: 8,
        previousFrontierKeys: ["1-0-0-0"],
      },
    );

    expect(keys(plan.plannedNodes)).toEqual(["0-0-0-0"]);
    expect(plan.retainedPreviousFrontierKeys).toEqual([]);
    expect(plan.droppedPreviousFrontierKeys).toEqual(["1-0-0-0"]);
  });

  it("keeps visible root coverage when no refinement crosses the threshold", () => {
    const plan = planMixedDepthHierarchyTraversal(
      [node("0-0-0-0"), node("1-0-0-0")],
      [view("0-0-0-0", 0), view("1-0-0-0", 9)],
      {
        maxNodes: 2,
        refineScreenSpaceError: 10,
      },
    );

    expect(keys(plan.plannedNodes)).toEqual(["0-0-0-0"]);
    expect(keys(plan.frontierNodes)).toEqual(["0-0-0-0"]);
    expect(keys(plan.renderNodes)).toEqual(["0-0-0-0"]);
  });

  it("keeps the deepest ready parent while a planned child is not ready", () => {
    const nodes = [
      node("0-0-0-0"),
      node("1-0-0-0"),
      node("2-0-0-0"),
    ];
    const plan = planMixedDepthHierarchyTraversal(
      nodes,
      [
        view("0-0-0-0", 12, { ready: true }),
        view("1-0-0-0", 20, { ready: false }),
        view("2-0-0-0", 30, { ready: true }),
      ],
      {
        maxNodes: 3,
        refineScreenSpaceError: 10,
      },
    );

    expect(keys(plan.plannedNodes)).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "2-0-0-0",
    ]);
    expect(keys(plan.renderNodes)).toEqual(["0-0-0-0"]);
    expect(keys(plan.renderFrontierNodes)).toEqual(["0-0-0-0"]);
    expect(keys(plan.requestNodes)).toEqual(["1-0-0-0"]);
    expect(keys(plan.blockedNodes)).toEqual(["2-0-0-0"]);
    expect(keys(plan.retainedParentNodes)).toEqual(["0-0-0-0"]);
  });

  it("never renders a ready child through an unready parent", () => {
    const nodes = [node("0-0-0-0"), node("1-0-0-0")];
    const plan = planMixedDepthHierarchyTraversal(
      nodes,
      [
        view("0-0-0-0", 20, { ready: false }),
        view("1-0-0-0", 30, { ready: true }),
      ],
      {
        maxNodes: 2,
        refineScreenSpaceError: 10,
      },
    );

    expect(keys(plan.renderNodes)).toEqual([]);
    expect(keys(plan.requestNodes)).toEqual(["0-0-0-0"]);
    expect(keys(plan.blockedNodes)).toEqual(["1-0-0-0"]);
  });

  it("retains ready ancestors after descendants become renderable", () => {
    const nodes = [node("0-0-0-0"), node("1-0-0-0")];
    const plan = planMixedDepthHierarchyTraversal(
      nodes,
      [view("0-0-0-0", 20), view("1-0-0-0", 30)],
      {
        maxNodes: 2,
        refineScreenSpaceError: 10,
      },
    );

    expect(keys(plan.renderNodes)).toEqual(["0-0-0-0", "1-0-0-0"]);
    expect(keys(plan.ancestorNodes)).toEqual(["0-0-0-0"]);
    expect(keys(plan.renderFrontierNodes)).toEqual(["1-0-0-0"]);
  });

  it("rejects an orphan refinement instead of producing a coverage hole", () => {
    const nodes = [node("0-0-0-0"), node("2-0-0-0")];
    const plan = planMixedDepthHierarchyTraversal(
      nodes,
      [view("0-0-0-0", 1), view("2-0-0-0", 30)],
      {
        maxNodes: 3,
        refineScreenSpaceError: 10,
      },
    );

    expect(keys(plan.plannedNodes)).toEqual(["0-0-0-0"]);
    expect(keys(plan.renderNodes)).toEqual(["0-0-0-0"]);
    expect(plan.diagnostics.skippedByMissingAncestorCount).toBe(1);
  });

  it("validates hierarchy identity, budgets, and hysteresis thresholds", () => {
    expect(() =>
      planMixedDepthHierarchyTraversal(
        [{ ...node("1-0-0-0"), key: "1-1-0-0" }],
        [],
        { maxNodes: 1 },
      ),
    ).toThrow("does not match");
    expect(() =>
      planMixedDepthHierarchyTraversal([], [], { maxNodes: 0 }),
    ).toThrow("maxNodes must be a positive safe integer.");
    expect(() =>
      planMixedDepthHierarchyTraversal([], [], {
        maxNodes: 1,
        refineScreenSpaceError: 10,
        retainScreenSpaceError: 11,
      }),
    ).toThrow(
      "retainScreenSpaceError must be less than or equal to refineScreenSpaceError.",
    );
    expect(() =>
      planMixedDepthHierarchyTraversal([node("0-0-0-0")], [], {
        maxNodes: 1,
        refinementMode: "visible-sibling-group",
      }),
    ).toThrow(
      'requiredNodeKeys must contain a coverage baseline when refinementMode is "visible-sibling-group".',
    );
    expect(() =>
      planMixedDepthHierarchyTraversal([], [], {
        maxNodes: 1,
        refinementMode: "group" as never,
      }),
    ).toThrow('refinementMode must be "node" or "visible-sibling-group".');
  });

  it("fails safely when required coverage is orphaned or exceeds budget", () => {
    const orphanError = captureError(() =>
      planMixedDepthHierarchyTraversal(
        [node("0-0-0-0"), node("2-0-0-0")],
        [],
        {
          maxNodes: 3,
          requiredNodeKeys: ["2-0-0-0"],
        },
      ),
    );
    const budgetError = captureError(() =>
      planMixedDepthHierarchyTraversal(
        [node("0-0-0-0"), node("1-0-0-0")],
        [],
        {
          maxNodes: 1,
          requiredNodeKeys: ["1-0-0-0"],
        },
      ),
    );

    expect(orphanError).toBeInstanceOf(
      CopcMixedDepthRequiredCoverageError,
    );
    expect(orphanError).toMatchObject({
      code: "COPC_MIXED_DEPTH_REQUIRED_COVERAGE",
      reason: "missing-ancestor",
      nodeKey: "2-0-0-0",
      missingAncestorKey: "1-0-0-0",
    });
    expect(budgetError).toBeInstanceOf(
      CopcMixedDepthRequiredCoverageError,
    );
    expect(budgetError).toMatchObject({
      code: "COPC_MIXED_DEPTH_REQUIRED_COVERAGE",
      reason: "budget-exceeded",
      requiredBudgetUsage: {
        nodeCount: 2,
        pointCount: 20,
        pointDataLength: 20,
      },
    });
  });
});

function createFullDepthOneNodeKeys(): string[] {
  const nodeKeys: string[] = [];

  for (let z = 0; z < 2; z += 1) {
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        nodeKeys.push(`1-${x}-${y}-${z}`);
      }
    }
  }

  return nodeKeys;
}

function createRecursiveSiblingGroupTree(): CopcHierarchyNodeSummary[] {
  return [
    node("0-0-0-0"),
    node("1-0-0-0"),
    node("1-1-0-0"),
    node("2-0-0-0"),
    node("2-1-0-0"),
    node("2-2-0-0"),
    node("2-3-0-0"),
    node("3-0-0-0"),
    node("3-1-0-0"),
  ];
}

function createRecursiveSiblingGroupViewStates(): CopcMixedDepthNodeViewState[] {
  return [
    view("0-0-0-0", 0),
    view("1-0-0-0", 1),
    view("1-1-0-0", 1),
    view("2-0-0-0", 20, { visualBenefit: 100 }),
    view("2-1-0-0", 20, { visualBenefit: 100 }),
    view("2-2-0-0", 20, { visualBenefit: 10 }),
    view("2-3-0-0", 20, { visualBenefit: 10 }),
    view("3-0-0-0", 20, { visualBenefit: 200 }),
    view("3-1-0-0", 20, { visualBenefit: 200 }),
  ];
}

function createMixedDepthTree(): CopcHierarchyNodeSummary[] {
  return [
    node("0-0-0-0"),
    node("1-0-0-0"),
    node("1-1-0-0"),
    node("2-0-0-0"),
  ];
}

function node(
  key: string,
  options: {
    readonly pointCount?: number;
    readonly pointDataLength?: number;
  } = {},
): CopcHierarchyNodeSummary {
  const [depth = 0, x = 0, y = 0, z = 0] = key.split("-").map(Number);
  const size = 100 / 2 ** depth;

  return {
    key,
    depth,
    x,
    y,
    z,
    bounds: {
      minX: x * size,
      minY: y * size,
      minZ: z * size,
      maxX: (x + 1) * size,
      maxY: (y + 1) * size,
      maxZ: (z + 1) * size,
    },
    pointCount: options.pointCount ?? 10,
    pointDensity: 1,
    pointDataOffset: 0,
    pointDataLength: options.pointDataLength ?? 10,
  };
}

function view(
  key: string,
  screenSpaceError: number,
  options: {
    readonly visible?: boolean;
    readonly projectedAreaPixels?: number;
    readonly visualBenefit?: number;
    readonly ready?: boolean;
  } = {},
): CopcMixedDepthNodeViewState {
  return {
    key,
    visible: options.visible ?? true,
    screenSpaceError,
    projectedAreaPixels: options.projectedAreaPixels,
    visualBenefit: options.visualBenefit,
    ready: options.ready,
  };
}

function keys(nodes: readonly CopcHierarchyNodeSummary[]): string[] {
  return nodes.map((candidate) => candidate.key);
}

function expectedParentKey(node: CopcHierarchyNodeSummary): string {
  return `${node.depth - 1}-${Math.floor(node.x / 2)}-${Math.floor(
    node.y / 2,
  )}-${Math.floor(node.z / 2)}`;
}

function isAntichain(nodes: readonly CopcHierarchyNodeSummary[]): boolean {
  return nodes.every((candidate, index) =>
    nodes.every(
      (other, otherIndex) =>
        (index === otherIndex && candidate.key === other.key) ||
        !isAncestorOf(candidate, other),
    ),
  );
}

function isAncestorOf(
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

function captureError(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }

  throw new Error("Expected callback to throw.");
}
