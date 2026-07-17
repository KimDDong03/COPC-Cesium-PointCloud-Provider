import type { Camera } from "cesium";
import { describe, expect, it, vi } from "vitest";
import type {
  CopcHierarchyNodeCameraSelection,
  CopcHierarchySummary,
} from "../core";
import {
  isCopcCameraStreamEngineLayer,
  prepareCopcCameraStreamView,
  runCopcCameraStreamEngine,
  supportsCopcCameraStreamEngineOptions,
  type CopcCameraStreamEngineLayer,
} from "./CopcCameraStreamEngine";
import type { CopcCameraStreamLodSettings } from "./CopcCameraStreamSettings";
import type {
  CopcPointCloudLayerNodesRenderResult,
  CopcPointCloudLayerProgressiveAutomaticRenderOptions,
  CopcPointCloudLayerProgressiveRenderNodesOptions,
} from "./CopcPointCloudLayer";

describe("CopcCameraStreamEngine", () => {
  it("prepares one additive render plan and source-weighted terminal set", async () => {
    const { layer, selectNodesForCamera, expandHierarchyForCamera } =
      createEngineLayer();
    const prepared = await prepareCopcCameraStreamView({
      layer,
      lodSettings: createLodSettings(),
      renderOptions: createRenderOptions(),
    });

    expect(expandHierarchyForCamera).toHaveBeenCalledWith(
      expect.objectContaining({
        camera: createRenderOptions().camera,
        maxDepth: 1,
        maxPages: 3,
      }),
    );
    expect(selectNodesForCamera).toHaveBeenCalledWith(
      expect.objectContaining({
        coverageMode: "complete-depth",
        maxDepth: 4,
        maxNodes: 64,
        maxTotalPointCount: 900_000,
      }),
    );
    expect(prepared?.renderPlan.selectedNodeKeys).toEqual(["1-0-0-0"]);
    expect(prepared?.renderPlan.finalNodeKeys).toEqual([
      "0-0-0-0",
      "1-0-0-0",
    ]);
    expect(prepared?.renderPlan.maxPointCountPerNode).toBe(180_000);
    expect(prepared?.finalNodeWeights).toEqual([
      { nodeKey: "0-0-0-0", weight: 60_000 },
      { nodeKey: "1-0-0-0", weight: 120_000 },
    ]);
  });

  it("publishes refining then exact terminal updates through the shared executor", async () => {
    const { layer, renderNodesProgressively } = createEngineLayer();
    const stages: string[] = [];
    const result = await runCopcCameraStreamEngine({
      layer,
      lodSettings: createLodSettings(),
      renderOptions: createRenderOptions(),
      onUpdate: (update) => stages.push(update.stage),
    });

    expect(renderNodesProgressively).toHaveBeenCalledWith(
      ["0-0-0-0", "1-0-0-0"],
      expect.objectContaining({
        continueLoadingAfterStop: true,
        maxActiveProgressiveNodeRequests: 6,
        maxPointCountPerNode: 180_000,
        maxRenderedPointCount: 360_000,
        nodePointCountWeights: [60_000, 120_000],
        nodeRequestOrder: "selection",
        postStopLoadingMode: "await",
        postStopProgressMode: "render",
        progressRenderMode: "final-only",
        useSourcePointBudgetHeadroom: false,
      }),
    );
    expect(stages).toEqual(["refining", "terminal"]);
    expect(result?.result.cameraSelection.nodes.map((node) => node.key)).toEqual([
      "1-0-0-0",
    ]);
    expect(result?.result.pointSamples.nodeKeys).toEqual([
      "0-0-0-0",
      "1-0-0-0",
    ]);
    expect(result?.visualQuality).toMatchObject({
      isTerminalReady: true,
      missingRequiredNodeCount: 0,
      unexpectedRenderedNodeCount: 0,
    });
  });

  it("forwards mixed-depth hysteresis and verifies a mixed antichain terminal set", async () => {
    const hierarchy = createHierarchyForKeys(
      [
        "0-0-0-0",
        "1-0-0-0",
        "1-1-1-1",
        "2-0-0-0",
        "2-3-3-3",
        "3-7-7-7",
      ],
      [],
    );
    const frontierNodes = hierarchy.nodes.filter((node) =>
      ["2-0-0-0", "3-7-7-7"].includes(node.key),
    );
    const selectNodesForCamera = vi.fn(async () =>
      ({
        ...createCameraSelection(),
        nodes: frontierNodes,
        selectedDepth: 3,
        targetDepth: 3,
        coverageMode: "mixed-depth",
      }) as CopcHierarchyNodeCameraSelection,
    );
    const renderNodesProgressively = vi.fn(
      async (nodeKeys: readonly string[]) => createRenderResult(nodeKeys),
    );
    const layer = {
      hierarchy,
      expandHierarchyForCamera: vi.fn(async () => undefined),
      selectNodesForCamera,
      renderNodesProgressively,
    } as unknown as CopcCameraStreamEngineLayer;
    const previousFrontierKeys = ["2-0-0-0", "2-3-3-3"];
    const result = await runCopcCameraStreamEngine({
      layer,
      lodSettings: createLodSettings(),
      renderOptions: {
        ...createRenderOptions(),
        coverageMode: "mixed-depth",
        previousFrontierKeys,
        refineScreenSpaceError: 4,
        retainScreenSpaceError: 3,
      },
    });

    expect(selectNodesForCamera).toHaveBeenCalledWith(
      expect.objectContaining({
        coverageMode: "mixed-depth",
        previousFrontierKeys,
        refineScreenSpaceError: 4,
        retainScreenSpaceError: 3,
      }),
    );
    expect(result?.renderPlan.selectedNodeKeys).toEqual([
      "2-0-0-0",
      "3-7-7-7",
    ]);
    expect(result?.visualQuality).toMatchObject({
      terminalFrontierMode: "mixed-depth-antichain",
      frontierDepthSpan: 1,
      isFrontierAntichain: true,
      isFrontierDepthPolicySatisfied: true,
      isTerminalReady: true,
    });
  });

  it("reselects after hierarchy expansion and keeps a bounded incomplete view non-terminal", async () => {
    const initialHierarchy = createHierarchyForKeys(
      ["0-0-0-0", "1-0-0-0"],
      ["2-0-0-0"],
    );
    const expandedHierarchy = createHierarchyForKeys(
      ["0-0-0-0", "1-0-0-0", "2-0-0-0"],
      ["3-0-0-0"],
    );
    let hierarchy = initialHierarchy;
    const selectNodesForCamera = vi
      .fn()
      .mockResolvedValueOnce(createCameraSelectionForKey("1-0-0-0", 2))
      .mockResolvedValue(createCameraSelectionForKey("2-0-0-0", 2));
    const expandHierarchyForCamera = vi.fn(async () => {
      hierarchy = expandedHierarchy;
      return {
        hierarchy,
        pageSelection: {
          pages: expandedHierarchy.pendingPages,
          reason: "staged hierarchy expansion",
        },
        loadedPageKeys: ["2-0-0-0"],
        pendingRelevantHierarchyPageCount: 1,
        pendingRelevantHierarchyPageSignature: "3-0-0-0:300:30",
        isHierarchyCompleteForView: false,
      };
    });
    const renderNodesProgressively = vi.fn(
      async (
        nodeKeys: readonly string[],
        options: CopcPointCloudLayerProgressiveRenderNodesOptions,
      ) => {
        options.onProgress?.(createRenderResult(["0-0-0-0"]));
        return createRenderResult(nodeKeys);
      },
    );
    const layer = {
      get hierarchy() {
        return hierarchy;
      },
      expandHierarchyForCamera,
      selectNodesForCamera,
      renderNodesProgressively,
    } as unknown as CopcCameraStreamEngineLayer;
    const stages: string[] = [];

    const result = await runCopcCameraStreamEngine({
      layer,
      lodSettings: createLodSettings(),
      renderOptions: {
        ...createRenderOptions(),
        maxHierarchyPages: 1,
      },
      onUpdate: (update) => stages.push(update.stage),
    });

    expect(expandHierarchyForCamera).toHaveBeenCalledWith(
      expect.objectContaining({ maxDepth: 1, maxPages: 1 }),
    );
    expect(selectNodesForCamera).toHaveBeenCalledTimes(2);
    expect(result?.renderPlan.selectedNodeKeys).toEqual(["2-0-0-0"]);
    expect(result?.pendingRelevantHierarchyPageCount).toBe(1);
    expect(result?.pendingRelevantHierarchyPageSignature).toBe(
      "depth-advanced:1->2",
    );
    expect(result?.visualQuality).toMatchObject({
      isAdditiveClosureComplete: true,
      isHierarchyCompleteForView: false,
      isTerminalReady: false,
      pendingRelevantHierarchyPageCount: 1,
    });
    expect(stages).toEqual(["refining", "interactive-ready"]);
  });

  it("keeps a newly deeper frontier non-terminal until its own hierarchy pass completes", async () => {
    const initialHierarchy = createHierarchyForKeys(
      ["0-0-0-0", "1-0-0-0"],
      ["1-1-0-0"],
    );
    const expandedHierarchy = createHierarchyForKeys(
      ["0-0-0-0", "1-0-0-0", "2-0-0-0", "3-0-0-0"],
      [],
    );
    let hierarchy = initialHierarchy;
    const selectNodesForCamera = vi
      .fn()
      .mockResolvedValueOnce(createCameraSelectionForKey("1-0-0-0", 4))
      .mockResolvedValue(createCameraSelectionForKey("3-0-0-0", 4));
    const expandHierarchyForCamera = vi.fn(async () => {
      hierarchy = expandedHierarchy;
      return {
        hierarchy,
        pageSelection: {
          pages: initialHierarchy.pendingPages,
          reason: "one shallow page revealed a deeper renderable frontier",
        },
        loadedPageKeys: ["1-1-0-0"],
        pendingRelevantHierarchyPageCount: 0,
        pendingRelevantHierarchyPageSignature: undefined,
        isHierarchyCompleteForView: true,
      };
    });
    const renderNodesProgressively = vi.fn(
      async (nodeKeys: readonly string[]) => createRenderResult(nodeKeys),
    );
    const layer = {
      get hierarchy() {
        return hierarchy;
      },
      expandHierarchyForCamera,
      selectNodesForCamera,
      renderNodesProgressively,
    } as unknown as CopcCameraStreamEngineLayer;

    const result = await runCopcCameraStreamEngine({
      layer,
      lodSettings: createLodSettings(),
      renderOptions: createRenderOptions(),
    });

    expect(expandHierarchyForCamera).toHaveBeenCalledWith(
      expect.objectContaining({ maxDepth: 1 }),
    );
    expect(result).toMatchObject({
      pendingRelevantHierarchyPageCount: 1,
      pendingRelevantHierarchyPageSignature: "depth-advanced:1->3",
      isHierarchyCompleteForView: false,
      visualQuality: {
        pendingRelevantHierarchyPageCount: 1,
        isHierarchyCompleteForView: false,
        isTerminalReady: false,
      },
    });
  });

  it("reselects when another hierarchy waiter completed the selected page first", async () => {
    const initialHierarchy = createHierarchyForKeys(
      ["0-0-0-0", "1-0-0-0"],
      ["2-0-0-0"],
    );
    const concurrentlyExpandedHierarchy = createHierarchyForKeys(
      ["0-0-0-0", "1-0-0-0", "2-0-0-0"],
      [],
    );
    let hierarchy = initialHierarchy;
    const selectNodesForCamera = vi
      .fn()
      .mockResolvedValueOnce(createCameraSelectionForKey("1-0-0-0", 2))
      .mockResolvedValue(createCameraSelectionForKey("2-0-0-0", 2));
    const expandHierarchyForCamera = vi.fn(async () => {
      hierarchy = concurrentlyExpandedHierarchy;
      return {
        hierarchy,
        pageSelection: {
          pages: initialHierarchy.pendingPages,
          reason: "page was merged by a concurrent waiter",
        },
        // The selected page is no longer pending when this waiter reaches the
        // source, so its own loaded-page provenance is empty even though the
        // shared hierarchy changed underneath the pre-expansion selection.
        loadedPageKeys: [],
        pendingRelevantHierarchyPageCount: 0,
        pendingRelevantHierarchyPageSignature: undefined,
        isHierarchyCompleteForView: true,
      };
    });
    const layer = {
      get hierarchy() {
        return hierarchy;
      },
      expandHierarchyForCamera,
      selectNodesForCamera,
      renderNodesProgressively: vi.fn(),
    } as unknown as CopcCameraStreamEngineLayer;

    const prepared = await prepareCopcCameraStreamView({
      layer,
      lodSettings: createLodSettings(),
      renderOptions: {
        ...createRenderOptions(),
        maxHierarchyPages: 1,
      },
    });

    expect(expandHierarchyForCamera).toHaveBeenCalledTimes(1);
    expect(selectNodesForCamera).toHaveBeenCalledTimes(2);
    expect(prepared?.cameraSelection.nodes.map((node) => node.key)).toEqual([
      "2-0-0-0",
    ]);
    expect(prepared?.renderPlan.selectedNodeKeys).toEqual(["2-0-0-0"]);
    expect(prepared?.renderPlan.finalNodeKeys).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "2-0-0-0",
    ]);
    expect(prepared).toMatchObject({
      pendingRelevantHierarchyPageCount: 1,
      pendingRelevantHierarchyPageSignature: "depth-advanced:1->2",
      isHierarchyCompleteForView: false,
    });
  });

  it("keeps a hierarchy-disabled view non-terminal when completeness is unknown", async () => {
    const {
      layer,
      expandHierarchyForCamera,
      selectNodesForCamera,
    } = createEngineLayer();
    const stages: string[] = [];

    const result = await runCopcCameraStreamEngine({
      layer,
      lodSettings: createLodSettings(),
      renderOptions: {
        ...createRenderOptions(),
        expandHierarchy: false,
      },
      onUpdate: (update) => stages.push(update.stage),
    });

    expect(expandHierarchyForCamera).not.toHaveBeenCalled();
    expect(selectNodesForCamera).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isHierarchyCompleteForView: false,
      pendingRelevantHierarchyPageCount: 0,
      visualQuality: {
        isAdditiveClosureComplete: true,
        isHierarchyCompleteForView: false,
        isTerminalReady: false,
        pendingRelevantHierarchyPageCount: 0,
      },
    });
    expect(stages).toEqual(["refining", "interactive-ready"]);
  });

  it("keeps deliberate low-level progressive policies on the legacy adapter", () => {
    expect(
      supportsCopcCameraStreamEngineOptions({
        coverageMode: "progressive",
      }),
    ).toBe(false);
    expect(
      supportsCopcCameraStreamEngineOptions({
        includeAncestorNodes: false,
      }),
    ).toBe(false);
    expect(
      supportsCopcCameraStreamEngineOptions({
        shouldStopAfterProgress: () => true,
      }),
    ).toBe(false);
    expect(
      supportsCopcCameraStreamEngineOptions({
        maxNodes: 12,
        maxRenderedPointCount: 240_000,
      }),
    ).toBe(true);
    expect(
      supportsCopcCameraStreamEngineOptions({
        coverageMode: "mixed-depth",
        previousFrontierKeys: ["2-0-0-0", "3-7-7-7"],
      }),
    ).toBe(true);
    expect(isCopcCameraStreamEngineLayer({})).toBe(false);
  });
});

function createEngineLayer(): {
  readonly layer: CopcCameraStreamEngineLayer;
  readonly expandHierarchyForCamera: ReturnType<typeof vi.fn>;
  readonly renderNodesProgressively: ReturnType<typeof vi.fn>;
  readonly selectNodesForCamera: ReturnType<typeof vi.fn>;
} {
  const hierarchy = createHierarchy();
  const selection = createCameraSelection();
  const expandHierarchyForCamera = vi.fn(async () => undefined);
  const selectNodesForCamera = vi.fn(async () => selection);
  const renderNodesProgressively = vi.fn(
    async (
      _nodeKeys: readonly string[],
      options: CopcPointCloudLayerProgressiveRenderNodesOptions,
    ) => {
      options.onProgress?.(createRenderResult(["0-0-0-0"]));
      return createRenderResult(["0-0-0-0", "1-0-0-0"]);
    },
  );
  const layer = {
    hierarchy,
    expandHierarchyForCamera,
    selectNodesForCamera,
    renderNodesProgressively,
  } as unknown as CopcCameraStreamEngineLayer;

  return {
    layer,
    expandHierarchyForCamera,
    renderNodesProgressively,
    selectNodesForCamera,
  };
}

function createHierarchy(): CopcHierarchySummary {
  return {
    nodes: [
      { key: "0-0-0-0", pointCount: 60_000, pointDataLength: 1_000 },
      { key: "1-0-0-0", pointCount: 120_000, pointDataLength: 2_000 },
    ],
    pendingPages: [],
  } as unknown as CopcHierarchySummary;
}

function createCameraSelection(): CopcHierarchyNodeCameraSelection {
  return {
    nodes: [
      { key: "1-0-0-0", pointCount: 120_000, pointDataLength: 2_000 },
    ],
    selectedDepth: 1,
    targetDepth: 4,
    coverageMode: "complete-depth",
  } as unknown as CopcHierarchyNodeCameraSelection;
}

function createCameraSelectionForKey(
  key: string,
  targetDepth: number,
): CopcHierarchyNodeCameraSelection {
  return {
    nodes: [{ key, pointCount: 120_000, pointDataLength: 2_000 }],
    selectedDepth: Number(key.split("-")[0]),
    targetDepth,
    coverageMode: "complete-depth",
  } as unknown as CopcHierarchyNodeCameraSelection;
}

function createHierarchyForKeys(
  nodeKeys: readonly string[],
  pendingPageKeys: readonly string[],
): CopcHierarchySummary {
  return {
    nodes: nodeKeys.map((key) => ({
      key,
      pointCount: key === "0-0-0-0" ? 60_000 : 120_000,
      pointDataLength: 2_000,
    })),
    pendingPages: pendingPageKeys.map((key, index) => ({
      key,
      depth: Number(key.split("-")[0]),
      x: 0,
      y: 0,
      z: 0,
      bounds: {
        minX: 0,
        minY: 0,
        minZ: 0,
        maxX: 100,
        maxY: 100,
        maxZ: 100,
      },
      pageOffset: (index + 1) * 300,
      pageLength: 30,
    })),
  } as unknown as CopcHierarchySummary;
}

function createLodSettings(): CopcCameraStreamLodSettings {
  return {
    label: "overview",
    cameraHeightMeters: 3_000,
    maxNodes: 64,
    maxDepth: 4,
    targetNodeScreenPixels: 96,
    targetPointSpacingScreenPixels: 4,
    maxRenderedPointCount: 360_000,
    maxSourcePointCount: 900_000,
    maxNodePointCount: 180_000,
    maxPointDataLength: 16_000_000,
    maxNodePointDataLength: 2_000_000,
    maxHierarchyPages: 3,
    detailMaxPointCountPerNode: 5_000,
    detailMinFinalNodeCount: 8,
    detailTargetPointCountPerNode: 2_500,
  };
}

function createRenderOptions(): CopcPointCloudLayerProgressiveAutomaticRenderOptions {
  return {
    camera: {} as Camera,
    selectionMode: "coverage",
    coverageMode: "complete-depth",
    maxNodes: 64,
    maxDepth: 4,
    maxNodePointCount: 180_000,
    maxNodePointDataLength: 2_000_000,
    maxTotalPointCount: 900_000,
    maxTotalPointDataLength: 16_000_000,
    targetNodeScreenPixels: 96,
    targetPointSpacingScreenPixels: 4,
    maxPointCountPerNode: 180_000,
    maxRenderedPointCount: 360_000,
    maxActiveProgressiveNodeRequests: 6,
    expandHierarchy: true,
    maxHierarchyPages: 3,
    maxHierarchyPageDepth: 4,
    includeAncestorNodes: true,
    includePointsInResult: false,
    showBounds: false,
  };
}

function createRenderResult(
  nodeKeys: readonly string[],
): CopcPointCloudLayerNodesRenderResult {
  return {
    nodes: nodeKeys.map((key) => ({
      key,
      pointCount: key === "0-0-0-0" ? 60_000 : 120_000,
      pointDataLength: 1_000,
    })),
    pointSamples: {
      nodeKeys,
      nodeResults: nodeKeys.map((nodeKey) => ({
        nodeKey,
        nodePointCount: 120_000,
        sampledPointCount: 60_000,
      })),
      sampledPointCount: nodeKeys.length * 60_000,
    },
  } as unknown as CopcPointCloudLayerNodesRenderResult;
}
