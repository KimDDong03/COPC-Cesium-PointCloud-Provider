import type { Camera } from "cesium";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CopcPointCloudLayerAutomaticRenderResult,
  CopcPointCloudLayerNodesRenderResult,
  CopcPointCloudLayerProgressiveAutomaticRenderOptions,
  CopcPointCloudLayerProgressiveRenderNodesOptions,
} from "./CopcPointCloudLayer";
import {
  CopcPointCloudCameraStream,
  type CopcPointCloudCameraStreamLayer,
  type CopcPointCloudCameraStreamUpdate,
} from "./CopcPointCloudCameraStream";

describe("CopcPointCloudCameraStream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a camera view with reusable LOD defaults", async () => {
    const camera = createCameraStub(3_000);
    const calls: CopcPointCloudLayerProgressiveAutomaticRenderOptions[] = [];
    const updates: CopcPointCloudCameraStreamUpdate[] = [];
    const result = createRenderResult();
    const layer = createLayerStub(async (options) => {
      calls.push(options);
      options.onProgress?.(result);
      return result;
    });
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer,
      quality: "balanced",
      onUpdate: (update) => updates.push(update),
    });

    await expect(stream.render()).resolves.toBe(result);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      camera: camera.camera,
      selectionMode: "coverage",
      coverageMode: "complete-depth",
      expandHierarchy: true,
      includeAncestorNodes: true,
      includePointsInResult: false,
      maxActiveProgressiveNodeRequests: 6,
      maxPointCountPerNode: 180_000,
      maxRenderedPointCount: 360_000,
      nodeRenderOrder: "selection",
      nodeRequestOrder: "selection",
      progressBatchNodeCount: 2,
      progressRenderMode: "incremental",
      showBounds: false,
    });
    expect(calls[0].maxNodes).toBeGreaterThan(0);
    expect(calls[0].maxRenderedPointCount).toBeGreaterThan(0);
    expect(calls[0].signal?.aborted).toBe(false);
    expect(updates.map((update) => update.phase)).toEqual([
      "progress",
      "complete",
    ]);
    expect(stream.lastResult).toBe(result);
  });

  it("uses dataset-relative height for a high-altitude point cloud", async () => {
    const camera = createCameraStub(3_354);
    const updates: CopcPointCloudCameraStreamUpdate[] = [];
    const getCameraHeightAbovePointCloudMeters = vi.fn(() => 550);
    const layer: CopcPointCloudCameraStreamLayer = {
      ...createLayerStub(async () => createRenderResult()),
      getCameraHeightAbovePointCloudMeters,
    };
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer,
      quality: "balanced",
      onUpdate: (update) => updates.push(update),
    });

    await stream.render();

    expect(getCameraHeightAbovePointCloudMeters).toHaveBeenCalledWith(3_354);
    expect(updates.at(-1)?.lodSettings).toEqual(
      expect.objectContaining({
        label: "close zoom",
        cameraHeightMeters: 550,
      }),
    );
  });

  it("uses the shared terminal engine for a real layer capability", async () => {
    const camera = createCameraStub(3_000);
    const updates: CopcPointCloudCameraStreamUpdate[] = [];
    const automaticRender = vi.fn(async () => {
      throw new Error("legacy automatic renderer must not run");
    });
    const selectNodesForCamera = vi.fn(async () =>
      createCameraSelection(["1-0-0-0"]),
    );
    const renderNodesProgressively = vi.fn(
      async (
        _nodeKeys: readonly string[],
        options: CopcPointCloudLayerProgressiveRenderNodesOptions,
      ) => {
        options.onProgress?.(createNodeRenderResult(["0-0-0-0"]));
        return createNodeRenderResult(["0-0-0-0", "1-0-0-0"]);
      },
    );
    const layer = {
      renderAutomaticProgressively: automaticRender,
      expandHierarchyForCamera: vi.fn(async () => undefined),
      selectNodesForCamera,
      renderNodesProgressively,
      hierarchy: createHierarchy(),
    } as unknown as CopcPointCloudCameraStreamLayer;
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer,
      quality: "balanced",
      onUpdate: (update) => updates.push(update),
    });

    const result = await stream.render();

    expect(automaticRender).not.toHaveBeenCalled();
    expect(selectNodesForCamera).toHaveBeenCalledWith(
      expect.objectContaining({
        camera: camera.camera,
        coverageMode: "complete-depth",
        selectionMode: "coverage",
      }),
    );
    expect(renderNodesProgressively).toHaveBeenCalledWith(
      ["0-0-0-0", "1-0-0-0"],
      expect.objectContaining({
        continueLoadingAfterStop: true,
        postStopLoadingMode: "await",
        postStopProgressMode: "render",
      }),
    );
    expect(result?.pointSamples.nodeKeys).toEqual([
      "0-0-0-0",
      "1-0-0-0",
    ]);
    expect(updates.map((update) => update.phase)).toEqual([
      "progress",
      "complete",
    ]);
    expect(updates.map((update) => update.stage)).toEqual([
      "refining",
      "terminal",
    ]);
    expect(stream.lastVisualQuality?.isTerminalReady).toBe(true);
  });

  it("reuses a verified mixed-depth frontier as hysteresis input", async () => {
    const camera = createCameraStub(550);
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
    const frontierKeys = ["2-0-0-0", "3-7-7-7"];
    const selectNodesForCamera = vi.fn(async () => ({
      nodes: hierarchy.nodes.filter((node) => frontierKeys.includes(node.key)),
      selectedDepth: 3,
      targetDepth: 3,
      coverageMode: "mixed-depth",
    }));
    const updates: CopcPointCloudCameraStreamUpdate[] = [];
    const layer = createEngineLayerStub({
      getHierarchy: () => hierarchy,
      expandHierarchyForCamera: vi.fn(async () => undefined),
      selectNodesForCamera,
    });
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer,
      renderOptions: { coverageMode: "mixed-depth" },
      onUpdate: (update) => updates.push(update),
    });

    await stream.render();
    await stream.render();

    expect(selectNodesForCamera).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        coverageMode: "mixed-depth",
        previousFrontierKeys: [],
      }),
    );
    expect(selectNodesForCamera).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        coverageMode: "mixed-depth",
        previousFrontierKeys: frontierKeys,
      }),
    );
    expect(updates.at(-1)).toMatchObject({
      stage: "terminal",
      visualQuality: {
        terminalFrontierMode: "mixed-depth-antichain",
        frontierDepthSpan: 1,
        isTerminalReady: true,
      },
    });
  });

  it("settles a hierarchy-disabled engine request without claiming terminal quality", async () => {
    const camera = createCameraStub(3_000);
    const updates: CopcPointCloudCameraStreamUpdate[] = [];
    const hierarchy = createHierarchyForKeys(
      ["0-0-0-0", "1-0-0-0"],
      ["2-0-0-0"],
    );
    const expandHierarchyForCamera = vi.fn();
    const layer = createEngineLayerStub({
      getHierarchy: () => hierarchy,
      expandHierarchyForCamera,
      selectNodesForCamera: vi.fn(async () =>
        createCameraSelection(["1-0-0-0"]),
      ),
    });
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer,
      renderOptions: { expandHierarchy: false },
      onUpdate: (update) => updates.push(update),
    });

    await stream.render();

    expect(expandHierarchyForCamera).not.toHaveBeenCalled();
    expect(updates.some((update) => update.stage === "terminal")).toBe(false);
    expect(updates.at(-1)).toMatchObject({
      phase: "complete",
      stage: "interactive-ready",
      visualQuality: {
        isHierarchyCompleteForView: false,
        isTerminalReady: false,
        pendingRelevantHierarchyPageCount: 0,
      },
    });
  });

  it("schedules bounded same-camera hierarchy follow-up cycles until the view is terminal", async () => {
    vi.useFakeTimers();
    const camera = createCameraStub(3_000);
    const updates: CopcPointCloudCameraStreamUpdate[] = [];
    let hierarchy = createHierarchyForKeys(
      ["0-0-0-0", "1-0-0-0"],
      ["2-0-0-0"],
    );
    let expansionCount = 0;
    const selectNodesForCamera = vi.fn(async () =>
      createCameraSelection([
        hierarchy.nodes.some((node) => node.key === "2-0-0-0")
          ? "2-0-0-0"
          : "1-0-0-0",
      ]),
    );
    const expandHierarchyForCamera = vi.fn(async () => {
      expansionCount += 1;

      if (expansionCount === 1) {
        hierarchy = createHierarchyForKeys(
          ["0-0-0-0", "1-0-0-0"],
          ["2-0-0-0"],
        );
        return createHierarchyExpansionResult(hierarchy, {
          loadedPageKeys: ["1-0-0-0"],
          pendingRelevantHierarchyPageCount: 1,
          pendingRelevantHierarchyPageSignature: "2-0-0-0:200:20",
        });
      }

      hierarchy = createHierarchyForKeys(
        ["0-0-0-0", "1-0-0-0", "2-0-0-0"],
        [],
      );
      return createHierarchyExpansionResult(hierarchy, {
        loadedPageKeys: ["2-0-0-0"],
        pendingRelevantHierarchyPageCount: 0,
      });
    });
    const layer = createEngineLayerStub({
      getHierarchy: () => hierarchy,
      expandHierarchyForCamera,
      selectNodesForCamera,
    });
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer,
      debounceMilliseconds: 5,
      renderOnStart: false,
      onUpdate: (update) => updates.push(update),
    });

    stream.start();
    await stream.render();

    expect(expandHierarchyForCamera).toHaveBeenCalledTimes(1);
    expect(updates.some((update) => update.stage === "terminal")).toBe(false);
    expect(updates.at(-1)?.visualQuality).toMatchObject({
      isHierarchyCompleteForView: false,
      isTerminalReady: false,
    });

    await vi.advanceTimersByTimeAsync(5);

    expect(expandHierarchyForCamera).toHaveBeenCalledTimes(2);
    expect(selectNodesForCamera).toHaveBeenCalledTimes(4);
    expect(updates.at(-1)).toMatchObject({
      phase: "complete",
      stage: "terminal",
      visualQuality: {
        isHierarchyCompleteForView: true,
        isTerminalReady: true,
      },
    });
    stream.destroy();
  });

  it("stops hierarchy follow-up scheduling when the residual page signature makes no progress", async () => {
    vi.useFakeTimers();
    const camera = createCameraStub(3_000);
    const hierarchy = createHierarchyForKeys(
      ["0-0-0-0", "1-0-0-0"],
      ["2-0-0-0"],
    );
    const expandHierarchyForCamera = vi.fn(async () =>
      createHierarchyExpansionResult(hierarchy, {
        loadedPageKeys: ["1-0-0-0"],
        pendingRelevantHierarchyPageCount: 1,
        pendingRelevantHierarchyPageSignature: "2-0-0-0:200:20",
      }),
    );
    const layer = createEngineLayerStub({
      getHierarchy: () => hierarchy,
      expandHierarchyForCamera,
      selectNodesForCamera: vi.fn(async () =>
        createCameraSelection(["1-0-0-0"]),
      ),
    });
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer,
      debounceMilliseconds: 5,
      renderOnStart: false,
    });

    stream.start();
    await stream.render();
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(50);

    expect(expandHierarchyForCamera).toHaveBeenCalledTimes(2);
    expect(stream.lastVisualQuality).toMatchObject({
      isHierarchyCompleteForView: false,
      isTerminalReady: false,
    });
    stream.destroy();
  });

  it("schedules one follow-up for an unseen residual signature after a concurrent page merge", async () => {
    vi.useFakeTimers();
    const camera = createCameraStub(3_000);
    const updates: CopcPointCloudCameraStreamUpdate[] = [];
    const hierarchy = createHierarchyForKeys(
      ["0-0-0-0", "1-0-0-0"],
      ["2-0-0-0"],
    );
    const expandHierarchyForCamera = vi.fn(async () =>
      createHierarchyExpansionResult(hierarchy, {
        // A concurrent waiter can merge the selected page before this request
        // records its own source-load provenance. The residual signature still
        // proves that one bounded same-camera refinement cycle is useful.
        loadedPageKeys: [],
        pendingRelevantHierarchyPageCount: 1,
        pendingRelevantHierarchyPageSignature: "2-0-0-0:200:20",
      }),
    );
    const layer = createEngineLayerStub({
      getHierarchy: () => hierarchy,
      expandHierarchyForCamera,
      selectNodesForCamera: vi.fn(async () =>
        createCameraSelection(["1-0-0-0"]),
      ),
    });
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer,
      debounceMilliseconds: 5,
      renderOnStart: false,
      onUpdate: (update) => updates.push(update),
    });

    stream.start();
    await stream.render();

    expect(expandHierarchyForCamera).toHaveBeenCalledTimes(1);
    expect(updates.at(-1)).toMatchObject({
      phase: "complete",
      stage: "interactive-ready",
    });

    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(50);

    expect(expandHierarchyForCamera).toHaveBeenCalledTimes(2);
    expect(
      updates
        .filter((update) => update.phase === "complete")
        .map((update) => update.requestId),
    ).toEqual([1, 2]);
    expect(updates.at(-1)).toMatchObject({
      phase: "complete",
      stage: "interactive-ready",
      visualQuality: {
        isHierarchyCompleteForView: false,
        isTerminalReady: false,
      },
    });
    stream.destroy();
  });

  it("stops an eviction cycle when a previously seen residual signature returns", async () => {
    vi.useFakeTimers();
    const camera = createCameraStub(3_000);
    const hierarchy = createHierarchyForKeys(
      ["0-0-0-0", "1-0-0-0"],
      ["2-0-0-0"],
    );
    const residualSignatures = [
      "2-0-0-0:200:20",
      "2-1-0-0:220:20",
      "2-0-0-0:200:20",
    ];
    const expandHierarchyForCamera = vi.fn(async () => {
      const callIndex = Math.min(
        expandHierarchyForCamera.mock.calls.length - 1,
        residualSignatures.length - 1,
      );

      return createHierarchyExpansionResult(hierarchy, {
        loadedPageKeys: [`loaded-${callIndex}`],
        pendingRelevantHierarchyPageCount: 1,
        pendingRelevantHierarchyPageSignature:
          residualSignatures[callIndex],
      });
    });
    const layer = createEngineLayerStub({
      getHierarchy: () => hierarchy,
      expandHierarchyForCamera,
      selectNodesForCamera: vi.fn(async () =>
        createCameraSelection(["1-0-0-0"]),
      ),
    });
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer,
      debounceMilliseconds: 5,
      renderOnStart: false,
    });

    stream.start();
    await stream.render();
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(50);

    expect(expandHierarchyForCamera).toHaveBeenCalledTimes(3);
    expect(stream.lastVisualQuality).toMatchObject({
      isHierarchyCompleteForView: false,
      isTerminalReady: false,
    });
    stream.destroy();
  });

  it("does not lower the per-node render cap when zooming from close to near", async () => {
    const camera = createCameraStub(650);
    const calls: CopcPointCloudLayerProgressiveAutomaticRenderOptions[] = [];
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer: createLayerStub(async (options) => {
        calls.push(options);
        return createRenderResult();
      }),
      quality: "balanced",
    });

    await stream.render();
    (camera.camera.positionCartographic as { height: number }).height = 300;
    await stream.render();

    expect(calls).toHaveLength(2);
    expect(calls[1].maxPointCountPerNode).toBeGreaterThanOrEqual(
      calls[0].maxPointCountPerNode ?? Number.POSITIVE_INFINITY,
    );
    expect(calls[1].maxRenderedPointCount).toBeGreaterThanOrEqual(
      calls[0].maxRenderedPointCount ?? Number.POSITIVE_INFINITY,
    );
  });

  it("lets complete-depth streaming distribute the full zoom render budget", async () => {
    const camera = createCameraStub(3_000);
    const calls: CopcPointCloudLayerProgressiveAutomaticRenderOptions[] = [];
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer: createLayerStub(async (options) => {
        calls.push(options);
        return createRenderResult();
      }),
      quality: "balanced",
    });

    await stream.render();
    (camera.camera.positionCartographic as { height: number }).height = 300;
    await stream.render();

    expect(calls[0]).toMatchObject({
      coverageMode: "complete-depth",
      maxPointCountPerNode: 180_000,
      maxRenderedPointCount: 360_000,
    });
    expect(calls[1]).toMatchObject({
      coverageMode: "complete-depth",
      maxPointCountPerNode: 180_000,
      maxRenderedPointCount: 720_000,
    });
  });

  it("allows callers to opt into transient progressive selection explicitly", async () => {
    const camera = createCameraStub(1_000);
    const calls: CopcPointCloudLayerProgressiveAutomaticRenderOptions[] = [];
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer: createLayerStub(async (options) => {
        calls.push(options);
        return createRenderResult();
      }),
      renderOptions: {
        coverageMode: "progressive",
        includeAncestorNodes: false,
      },
    });

    await stream.render();

    expect(calls[0]).toMatchObject({
      coverageMode: "progressive",
      includeAncestorNodes: false,
      maxPointCountPerNode: 6_000,
    });
  });

  it("keeps explicit progressive policies on the legacy adapter", async () => {
    const camera = createCameraStub(1_000);
    const automaticRender = vi.fn(async () => createRenderResult());
    const selectNodesForCamera = vi.fn(async () =>
      createCameraSelection(["1-0-0-0"]),
    );
    const layer = {
      renderAutomaticProgressively: automaticRender,
      expandHierarchyForCamera: vi.fn(async () => undefined),
      selectNodesForCamera,
      renderNodesProgressively: vi.fn(),
      hierarchy: createHierarchy(),
    } as unknown as CopcPointCloudCameraStreamLayer;
    const updates: CopcPointCloudCameraStreamUpdate[] = [];
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer,
      renderOptions: {
        coverageMode: "progressive",
        includeAncestorNodes: false,
      },
      onUpdate: (update) => updates.push(update),
    });

    await stream.render();

    expect(automaticRender).toHaveBeenCalledTimes(1);
    expect(selectNodesForCamera).not.toHaveBeenCalled();
    expect(updates.at(-1)?.phase).toBe("complete");
    expect(updates.at(-1)?.stage).toBe("preview");
  });

  it("does not label an ancestor-omitting preview as additive terminal quality", async () => {
    const camera = createCameraStub(1_000);
    const updates: CopcPointCloudCameraStreamUpdate[] = [];
    const result = createRenderResult({
      frontierNodeKeys: ["1-0-0-0"],
      renderedNodeKeys: ["1-0-0-0"],
    });
    const layer = {
      ...createLayerStub(async () => result),
      hierarchy: {
        nodes: [
          { key: "0-0-0-0", pointCount: 1, pointDataLength: 1 },
          { key: "1-0-0-0", pointCount: 1, pointDataLength: 1 },
        ],
      },
    } as unknown as CopcPointCloudCameraStreamLayer;
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer,
      renderOptions: {
        coverageMode: "progressive",
        includeAncestorNodes: false,
      },
      onUpdate: (update) => updates.push(update),
    });

    await stream.render();

    expect(updates.at(-1)?.visualQuality).toMatchObject({
      isTerminalReady: false,
      requiredNodeCount: 2,
      missingRequiredNodeCount: 1,
      unexpectedRenderedNodeCount: 0,
    });
  });

  it("falls back to absolute height for backward-compatible layer mocks", async () => {
    const camera = createCameraStub(3_500);
    const updates: CopcPointCloudCameraStreamUpdate[] = [];
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer: createLayerStub(async () => createRenderResult()),
      quality: "balanced",
      onUpdate: (update) => updates.push(update),
    });

    await stream.render();

    expect(updates.at(-1)?.lodSettings).toEqual(
      expect.objectContaining({
        label: "overview",
        cameraHeightMeters: 3_500,
      }),
    );
  });

  it("reports a verified additive terminal composition for real layer results", async () => {
    const camera = createCameraStub(3_000);
    const updates: CopcPointCloudCameraStreamUpdate[] = [];
    const result = createRenderResult({
      frontierNodeKeys: ["1-0-0-0"],
      renderedNodeKeys: ["0-0-0-0", "1-0-0-0"],
    });
    const layer = {
      ...createLayerStub(async () => result),
      hierarchy: {
        nodes: [
          { key: "0-0-0-0", pointCount: 1, pointDataLength: 1 },
          { key: "1-0-0-0", pointCount: 1, pointDataLength: 1 },
        ],
      },
    } as unknown as CopcPointCloudCameraStreamLayer;
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer,
      onUpdate: (update) => updates.push(update),
    });

    await stream.render();

    expect(updates.at(-1)?.visualQuality).toMatchObject({
      isTerminalReady: true,
      requiredNodeCount: 2,
      renderedNodeCount: 2,
      missingRequiredNodeCount: 0,
      unexpectedRenderedNodeCount: 0,
    });
    expect(stream.lastVisualQuality?.isTerminalReady).toBe(true);
  });

  it("debounces camera events and removes listeners when stopped", async () => {
    vi.useFakeTimers();
    const camera = createCameraStub(1_000);
    const render = vi.fn(async () => createRenderResult());
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer: createLayerStub(render),
      debounceMilliseconds: 25,
      renderOnStart: false,
    });

    stream.start();
    camera.changed.raise();
    camera.changed.raise();
    await vi.advanceTimersByTimeAsync(24);
    expect(render).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(render).toHaveBeenCalledTimes(1);

    stream.stop();
    expect(stream.isRunning).toBe(false);
    expect(camera.changed.listenerCount).toBe(0);
    expect(camera.moveEnd.listenerCount).toBe(0);
    expect(camera.moveStart.listenerCount).toBe(0);

    camera.moveEnd.raise();
    await vi.advanceTimersByTimeAsync(25);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("aborts stale renders and ignores their late progress", async () => {
    const camera = createCameraStub(500);
    const requests: Array<{
      options: CopcPointCloudLayerProgressiveAutomaticRenderOptions;
      resolve: (
        result: CopcPointCloudLayerAutomaticRenderResult | undefined,
      ) => void;
    }> = [];
    const updates: CopcPointCloudCameraStreamUpdate[] = [];
    const layer = createLayerStub(
      (options) =>
        new Promise((resolve) => {
          requests.push({ options, resolve });
        }),
    );
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer,
      onUpdate: (update) => updates.push(update),
    });
    const firstRender = stream.render();
    const secondRender = stream.render();
    const firstResult = createRenderResult();
    const secondResult = createRenderResult();

    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal?.aborted).toBe(true);
    requests[0].options.onProgress?.(firstResult);
    requests[0].resolve(firstResult);
    requests[1].options.onProgress?.(secondResult);
    requests[1].resolve(secondResult);

    await expect(firstRender).resolves.toBeUndefined();
    await expect(secondRender).resolves.toBe(secondResult);
    expect(updates.map((update) => update.requestId)).toEqual([2, 2]);
  });

  it("aborts a render immediately when the camera changes before debounce", async () => {
    vi.useFakeTimers();
    const camera = createCameraStub(500);
    let activeSignal: AbortSignal | undefined;
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer: createLayerStub(
        (options) =>
          new Promise(() => {
            activeSignal = options.signal;
          }),
      ),
      debounceMilliseconds: 25,
      renderOnStart: false,
    });

    stream.start();
    void stream.render();
    expect(activeSignal?.aborted).toBe(false);

    camera.changed.raise();

    expect(activeSignal?.aborted).toBe(true);
    stream.destroy();
  });

  it("holds a committed frame until progressive spatial coverage is safe", async () => {
    const camera = createCameraStub(500);
    const hierarchy = createHierarchyForKeys(
      ["0-0-0-0", "1-0-0-0"],
      [],
    );
    const progressDecisions: boolean[] = [];
    const updates: CopcPointCloudCameraStreamUpdate[] = [];
    let rendererRevision = 0;
    let renderCount = 0;
    const layer = {
      renderAutomaticProgressively: vi.fn(async () => createRenderResult()),
      hierarchy,
      getRendererRevision: () => rendererRevision,
      expandHierarchyForCamera: vi.fn(async () => undefined),
      selectNodesForCamera: vi.fn(async () =>
        createCameraSelection(["1-0-0-0"]),
      ),
      renderNodesProgressively: vi.fn(
        async (
          nodeKeys: readonly string[],
          options: CopcPointCloudLayerProgressiveRenderNodesOptions,
        ) => {
          renderCount += 1;
          const progressResults =
            renderCount === 1
              ? [createNodeRenderResult(["0-0-0-0"])]
              : [
                  createNodeRenderResult(["0-0-0-0"]),
                  createNodeRenderResult(nodeKeys),
                ];

          for (const progressResult of progressResults) {
            const candidate = {
              nodeKeys: progressResult.pointSamples.nodeKeys,
              sampledPointCount:
                progressResult.pointSamples.sampledPointCount,
              nodeSamples: progressResult.pointSamples.nodeResults.map(
                (nodeResult) => ({
                  nodeKey: nodeResult.nodeKey,
                  nodePointCount: nodeResult.nodePointCount,
                  sampledPointCount: nodeResult.sampledPointCount,
                }),
              ),
            };
            const accepted =
              options.shouldRenderProgress?.(candidate) ?? true;

            if (renderCount === 2) {
              progressDecisions.push(accepted);
            }
            if (accepted) {
              rendererRevision += 1;
              options.onProgress?.(progressResult);
            }
          }

          rendererRevision += 1;
          return createNodeRenderResult(nodeKeys);
        },
      ),
    } as unknown as CopcPointCloudCameraStreamLayer;
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer,
      quality: "balanced",
      renderOptions: { coverageMode: "complete-depth" },
      onUpdate: (update) => updates.push(update),
    });

    await stream.render();
    const firstRequestUpdateCount = updates.length;
    await stream.render();

    expect(progressDecisions).toEqual([false, true]);
    expect(
      updates.slice(firstRequestUpdateCount).map((update) => update.phase),
    ).toEqual(["complete"]);
    expect(stream.lastVisualQuality?.isTerminalReady).toBe(true);
  });

  it("does not ratchet the safe-swap point floor through superseded progress", async () => {
    const camera = createCameraStub(500);
    const hierarchy = createHierarchyForKeys(
      ["0-0-0-0", "1-0-0-0"],
      [],
    );
    const progressDecisions: boolean[] = [];
    let rendererRevision = 0;
    let renderCount = 0;
    const layer = {
      renderAutomaticProgressively: vi.fn(async () => createRenderResult()),
      hierarchy,
      getRendererRevision: () => rendererRevision,
      expandHierarchyForCamera: vi.fn(async () => undefined),
      selectNodesForCamera: vi.fn(async () =>
        createCameraSelection(["1-0-0-0"]),
      ),
      renderNodesProgressively: vi.fn(
        async (
          nodeKeys: readonly string[],
          options: CopcPointCloudLayerProgressiveRenderNodesOptions,
        ) => {
          renderCount += 1;
          const terminalResult = createNodeRenderResultWithPointCounts(
            nodeKeys,
            [60_000, 60_000],
          );

          if (renderCount === 1) {
            rendererRevision += 1;
            return terminalResult;
          }

          const progressResult =
            renderCount === 2
              ? createNodeRenderResultWithPointCounts(nodeKeys, [36_000, 36_000])
              : createNodeRenderResultWithPointCounts(nodeKeys, [22_000, 22_000]);
          const candidate = {
            nodeKeys: progressResult.pointSamples.nodeKeys,
            sampledPointCount: progressResult.pointSamples.sampledPointCount,
            nodeSamples: progressResult.pointSamples.nodeResults.map(
              (nodeResult) => ({
                nodeKey: nodeResult.nodeKey,
                nodePointCount: nodeResult.nodePointCount,
                sampledPointCount: nodeResult.sampledPointCount,
              }),
            ),
          };
          const accepted = options.shouldRenderProgress?.(candidate) ?? true;

          progressDecisions.push(accepted);
          if (accepted) {
            rendererRevision += 1;
            options.onProgress?.(progressResult);
          }

          if (renderCount === 2) {
            return new Promise<CopcPointCloudLayerNodesRenderResult>(
              (_resolve, reject) => {
                options.signal?.addEventListener(
                  "abort",
                  () => reject(new DOMException("Aborted", "AbortError")),
                  { once: true },
                );
              },
            );
          }

          rendererRevision += 1;
          return terminalResult;
        },
      ),
    } as unknown as CopcPointCloudCameraStreamLayer;
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer,
      quality: "balanced",
      renderOptions: { coverageMode: "complete-depth" },
    });

    await stream.render();
    const supersededRender = stream.render();
    await vi.waitFor(() => expect(progressDecisions).toEqual([true]));
    const finalRender = stream.render();

    await expect(supersededRender).resolves.toBeUndefined();
    await expect(finalRender).resolves.toBeDefined();
    expect(progressDecisions).toEqual([true, false]);
  });

  it("reports render failures and rejects use after destroy", async () => {
    const camera = createCameraStub(1_000);
    const failure = new Error("render failed");
    const errors: unknown[] = [];
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer: createLayerStub(async () => {
        throw failure;
      }),
      onError: (error) => errors.push(error),
    });

    await expect(stream.render()).rejects.toBe(failure);
    expect(errors).toEqual([failure]);
    expect(stream.lastError).toBe(failure);

    stream.destroy();
    expect(stream.isDestroyed).toBe(true);
    await expect(stream.render()).rejects.toThrow(
      "CopcPointCloudCameraStream has been destroyed.",
    );
  });
});

class CameraEventStub {
  readonly #listeners = new Set<() => void>();

  addEventListener(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  raise(): void {
    [...this.#listeners].forEach((listener) => listener());
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}

function createCameraStub(height: number): {
  readonly camera: Camera;
  readonly changed: CameraEventStub;
  readonly moveEnd: CameraEventStub;
  readonly moveStart: CameraEventStub;
} {
  const changed = new CameraEventStub();
  const moveEnd = new CameraEventStub();
  const moveStart = new CameraEventStub();
  const camera = {
    changed,
    moveEnd,
    moveStart,
    positionCartographic: { height },
  } as unknown as Camera;

  return { camera, changed, moveEnd, moveStart };
}

function createLayerStub(
  render: (
    options: CopcPointCloudLayerProgressiveAutomaticRenderOptions,
  ) => Promise<CopcPointCloudLayerAutomaticRenderResult | undefined>,
): CopcPointCloudCameraStreamLayer {
  return {
    renderAutomaticProgressively: render,
  };
}

function createRenderResult(options?: {
  readonly frontierNodeKeys: readonly string[];
  readonly renderedNodeKeys: readonly string[];
}): CopcPointCloudLayerAutomaticRenderResult {
  if (!options) {
    return {} as CopcPointCloudLayerAutomaticRenderResult;
  }

  return {
    cameraSelection: {
      nodes: options.frontierNodeKeys.map((key) => ({
        key,
        pointCount: 1,
        pointDataLength: 1,
      })),
    },
    pointSamples: {
      nodeKeys: options.renderedNodeKeys,
    },
  } as unknown as CopcPointCloudLayerAutomaticRenderResult;
}

function createHierarchy() {
  return {
    nodes: [
      { key: "0-0-0-0", pointCount: 60_000, pointDataLength: 1_000 },
      { key: "1-0-0-0", pointCount: 120_000, pointDataLength: 2_000 },
    ],
    pendingPages: [],
  };
}

function createCameraSelection(nodeKeys: readonly string[]) {
  return {
    nodes: nodeKeys.map((key) => ({
      key,
      pointCount: 120_000,
      pointDataLength: 2_000,
    })),
    selectedDepth: 1,
    targetDepth: 2,
    coverageMode: "complete-depth",
  };
}

function createHierarchyForKeys(
  nodeKeys: readonly string[],
  pendingPageKeys: readonly string[],
) {
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
      pageOffset: (index + 1) * 200,
      pageLength: 20,
    })),
  };
}

function createHierarchyExpansionResult(
  hierarchy: ReturnType<typeof createHierarchyForKeys>,
  options: {
    readonly loadedPageKeys: readonly string[];
    readonly pendingRelevantHierarchyPageCount: number;
    readonly pendingRelevantHierarchyPageSignature?: string;
  },
) {
  return {
    hierarchy,
    pageSelection: {
      pages: hierarchy.pendingPages,
      reason: "staged hierarchy expansion",
    },
    loadedPageKeys: options.loadedPageKeys,
    pendingRelevantHierarchyPageCount:
      options.pendingRelevantHierarchyPageCount,
    pendingRelevantHierarchyPageSignature:
      options.pendingRelevantHierarchyPageSignature,
    isHierarchyCompleteForView:
      options.pendingRelevantHierarchyPageCount === 0,
  };
}

function createEngineLayerStub(options: {
  readonly getHierarchy: () => ReturnType<typeof createHierarchyForKeys>;
  readonly expandHierarchyForCamera: ReturnType<typeof vi.fn>;
  readonly selectNodesForCamera: ReturnType<typeof vi.fn>;
}): CopcPointCloudCameraStreamLayer {
  return {
    renderAutomaticProgressively: vi.fn(async () => createRenderResult()),
    get hierarchy() {
      return options.getHierarchy();
    },
    expandHierarchyForCamera: options.expandHierarchyForCamera,
    selectNodesForCamera: options.selectNodesForCamera,
    renderNodesProgressively: vi.fn(
      async (
        nodeKeys: readonly string[],
        renderOptions: CopcPointCloudLayerProgressiveRenderNodesOptions,
      ) => {
        renderOptions.onProgress?.(createNodeRenderResult(["0-0-0-0"]));
        return createNodeRenderResult(nodeKeys);
      },
    ),
  } as unknown as CopcPointCloudCameraStreamLayer;
}

function createNodeRenderResult(
  nodeKeys: readonly string[],
): CopcPointCloudLayerNodesRenderResult {
  return {
    nodes: nodeKeys.map((key) => ({
      key,
      pointCount: 120_000,
      pointDataLength: 2_000,
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

function createNodeRenderResultWithPointCounts(
  nodeKeys: readonly string[],
  sampledPointCounts: readonly number[],
): CopcPointCloudLayerNodesRenderResult {
  if (nodeKeys.length !== sampledPointCounts.length) {
    throw new Error("Node keys and sampled point counts must align.");
  }

  return {
    nodes: nodeKeys.map((key) => ({
      key,
      pointCount: 120_000,
      pointDataLength: 2_000,
    })),
    pointSamples: {
      nodeKeys,
      nodeResults: nodeKeys.map((nodeKey, index) => ({
        nodeKey,
        nodePointCount: 120_000,
        sampledPointCount: sampledPointCounts[index],
      })),
      sampledPointCount: sampledPointCounts.reduce(
        (total, pointCount) => total + pointCount,
        0,
      ),
    },
  } as unknown as CopcPointCloudLayerNodesRenderResult;
}
