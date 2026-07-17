import { describe, expect, it, vi } from "vitest";
import { createCopcCameraStreamRuntimeSettings } from "./CopcCameraStreamSettings";
import {
  CopcCameraStreamTerminalRenderError,
  runCopcCameraStreamTerminalRender,
  type CopcCameraStreamTerminalRenderLayer,
  type CopcCameraStreamTerminalRenderOptions,
  type CopcCameraStreamTerminalRenderUpdate,
} from "./CopcCameraStreamTerminalRender";
import type {
  CopcPointCloudLayerNodesRenderResult,
  CopcPointCloudLayerProgressiveRenderNodesOptions,
} from "./CopcPointCloudLayer";

const ROOT_NODE_KEY = "0-0-0-0";
const FRONTIER_NODE_KEYS = Array.from(
  { length: 9 },
  (_value, index) => `2-${index % 4}-${Math.floor(index / 4)}-0`,
);
const REQUIRED_NODE_KEYS = [ROOT_NODE_KEY, ...FRONTIER_NODE_KEYS];

describe("runCopcCameraStreamTerminalRender", () => {
  it("continues bounded detail work after interactive readiness and resolves one verified terminal update", async () => {
    const partialResult = createRenderResult(
      REQUIRED_NODE_KEYS.slice(0, 9),
      90,
    );
    const terminalResult = createRenderResult(REQUIRED_NODE_KEYS, 100);
    const gate = createDeferred<void>();
    const updates: CopcCameraStreamTerminalRenderUpdate[] = [];
    const shouldRenderProgress = () => false;
    let capturedOptions:
      CopcPointCloudLayerProgressiveRenderNodesOptions | undefined;
    let stopAfterPartial = false;
    const layer = createLayer(async (_nodeKeys, options) => {
      capturedOptions = options;
      options.onProgress?.(partialResult);
      stopAfterPartial =
        options.shouldStopAfterProgress?.(partialResult) ?? false;
      await gate.promise;
      options.onProgress?.(terminalResult);
      return terminalResult;
    });

    let settled = false;
    const renderPromise = runCopcCameraStreamTerminalRender({
      ...createOptions(layer),
      maxActiveNodeRequests: 3,
      requestPriority: 43,
      progressRenderMode: "incremental",
      skipInitialProgressRender: true,
      shouldRenderProgress,
      onUpdate: (update) => updates.push(update),
    }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(stopAfterPartial).toBe(true);
    expect(settled).toBe(false);
    expect(capturedOptions).toMatchObject({
      continueLoadingAfterStop: true,
      includePointsInResult: false,
      maxActiveProgressiveNodeRequests: 3,
      maxPointCountPerNode: 25,
      maxRenderedPointCount: 100,
      nodeRequestOrder: "selection",
      postStopLoadingMode: "await",
      postStopProgressMode: "render",
      progressRenderMode: "incremental",
      requestPriority: 43,
      showBounds: false,
      skipInitialProgressRender: true,
    });
    expect(capturedOptions?.shouldRenderProgress).toBe(shouldRenderProgress);

    gate.resolve();
    const result = await renderPromise;

    expect(result.result).toBe(terminalResult);
    expect(result.visualQuality.isTerminalReady).toBe(true);
    expect(updates.map((update) => update.stage)).toEqual([
      "interactive-ready",
      "terminal",
    ]);
    expect(updates.map((update) => update.becameInteractiveReady)).toEqual([
      true,
      false,
    ]);
  });

  it("verifies and publishes the returned final result even without a final progress callback", async () => {
    const terminalResult = createRenderResult(REQUIRED_NODE_KEYS, 100);
    const updates: CopcCameraStreamTerminalRenderUpdate[] = [];
    const layer = createLayer(async () => terminalResult);

    const result = await runCopcCameraStreamTerminalRender({
      ...createOptions(layer),
      onUpdate: (update) => updates.push(update),
    });

    expect(result.visualQuality.isTerminalReady).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      becameInteractiveReady: true,
      stage: "terminal",
      result: terminalResult,
    });
  });

  it("defaults typed terminal geometry to one final renderer commit", async () => {
    const terminalResult = createRenderResult(REQUIRED_NODE_KEYS, 100);
    let capturedOptions:
      | CopcPointCloudLayerProgressiveRenderNodesOptions
      | undefined;
    const layer = createLayer(async (_nodeKeys, options) => {
      capturedOptions = options;
      return terminalResult;
    });

    await runCopcCameraStreamTerminalRender(createOptions(layer));

    expect(capturedOptions?.progressRenderMode).toBe("final-only");
  });

  it("keeps adaptive incremental commits for non-typed renderers", async () => {
    const terminalResult = createRenderResult(REQUIRED_NODE_KEYS, 100);
    let capturedOptions:
      | CopcPointCloudLayerProgressiveRenderNodesOptions
      | undefined;
    const layer = createLayer(async (_nodeKeys, options) => {
      capturedOptions = options;
      return terminalResult;
    });

    await runCopcCameraStreamTerminalRender({
      ...createOptions(layer),
      rendererKind: "primitive",
    });

    expect(capturedOptions?.progressRenderMode).toBe("incremental");
  });

  it("allows typed callers to opt back into incremental commits", async () => {
    const terminalResult = createRenderResult(REQUIRED_NODE_KEYS, 100);
    let capturedOptions:
      | CopcPointCloudLayerProgressiveRenderNodesOptions
      | undefined;
    const layer = createLayer(async (_nodeKeys, options) => {
      capturedOptions = options;
      return terminalResult;
    });

    await runCopcCameraStreamTerminalRender({
      ...createOptions(layer),
      progressRenderMode: "incremental",
    });

    expect(capturedOptions?.progressRenderMode).toBe("incremental");
  });

  it("aligns terminal source weights to required nodes and opts into source headroom", async () => {
    const terminalResult = createRenderResult(REQUIRED_NODE_KEYS, 100);
    let capturedOptions:
      | CopcPointCloudLayerProgressiveRenderNodesOptions
      | undefined;
    const layer = createLayer(async (_nodeKeys, options) => {
      capturedOptions = options;
      return terminalResult;
    });

    await runCopcCameraStreamTerminalRender({
      ...createOptions(layer),
      finalNodeWeights: [
        { nodeKey: FRONTIER_NODE_KEYS[0]!, weight: 30 },
        { nodeKey: ROOT_NODE_KEY, weight: 10 },
      ],
      useSourcePointBudgetHeadroom: true,
    });

    expect(capturedOptions?.nodePointCountWeights).toEqual([
      10,
      30,
      ...Array(FRONTIER_NODE_KEYS.length - 1).fill(1),
    ]);
    expect(capturedOptions?.useSourcePointBudgetHeadroom).toBe(true);
  });

  it("rejects a returned result with a missing additive node", async () => {
    const missingNodeKey = REQUIRED_NODE_KEYS.at(-1)!;
    const incompleteResult = createRenderResult(
      REQUIRED_NODE_KEYS.slice(0, -1),
      100,
    );
    const layer = createLayer(async () => incompleteResult);

    const error = await captureError(
      runCopcCameraStreamTerminalRender(createOptions(layer)),
    );

    expect(error).toBeInstanceOf(CopcCameraStreamTerminalRenderError);
    expect(error).toMatchObject({
      code: "COPC_CAMERA_STREAM_NON_TERMINAL",
      missingRequiredNodeKeys: [missingNodeKey],
      unexpectedRenderedNodeKeys: [],
    });
  });

  it("rejects stale rendered nodes that are outside the required set", async () => {
    const staleNodeKey = "3-7-7-7";
    const staleResult = createRenderResult(
      [...REQUIRED_NODE_KEYS, staleNodeKey],
      100,
    );
    const layer = createLayer(async () => staleResult);

    const error = await captureError(
      runCopcCameraStreamTerminalRender(createOptions(layer)),
    );

    expect(error).toBeInstanceOf(CopcCameraStreamTerminalRenderError);
    expect(error).toMatchObject({
      missingRequiredNodeKeys: [],
      unexpectedRenderedNodeKeys: [staleNodeKey],
    });
  });

  it("rejects a frontier with an ancestor overlap", async () => {
    const overlappingFrontier = [ROOT_NODE_KEY, "1-0-0-0"];
    const result = createRenderResult(overlappingFrontier, 100);
    const layer = createLayer(async () => result);

    const error = await captureError(
      runCopcCameraStreamTerminalRender({
        ...createOptions(layer),
        frontierNodeKeys: overlappingFrontier,
        requiredNodeKeys: overlappingFrontier,
      }),
    );

    expect(error).toBeInstanceOf(CopcCameraStreamTerminalRenderError);
    expect(
      (error as CopcCameraStreamTerminalRenderError).visualQuality
        .frontierAncestorOverlapCount,
    ).toBe(1);
  });

  it("accepts an explicitly enabled mixed-depth antichain terminal render", async () => {
    const frontierNodeKeys = ["2-0-0-0", "3-7-7-7"];
    const requiredNodeKeys = [
      "0-0-0-0",
      "1-0-0-0",
      "1-1-1-1",
      "2-0-0-0",
      "2-3-3-3",
      "3-7-7-7",
    ];
    const terminalResult = createRenderResult(requiredNodeKeys, 100);
    const layer = createLayer(async () => terminalResult);

    const result = await runCopcCameraStreamTerminalRender({
      ...createOptions(layer),
      frontierNodeKeys,
      requiredNodeKeys,
      terminalFrontierMode: "mixed-depth-antichain",
    });

    expect(result.visualQuality).toMatchObject({
      terminalFrontierMode: "mixed-depth-antichain",
      frontierDepthSpan: 1,
      isFrontierAntichain: true,
      isFrontierDepthPolicySatisfied: true,
      isTerminalReady: true,
    });
  });

  it("preserves AbortError and never publishes a terminal update for an aborted render", async () => {
    const abortController = new AbortController();
    const abortError = new DOMException("Aborted", "AbortError");
    const updates: CopcCameraStreamTerminalRenderUpdate[] = [];
    const layer = createLayer(async (_nodeKeys, options) => {
      options.onProgress?.(createRenderResult([ROOT_NODE_KEY], 10));
      abortController.abort();
      throw abortError;
    });

    await expect(
      runCopcCameraStreamTerminalRender({
        ...createOptions(layer),
        signal: abortController.signal,
        onUpdate: (update) => updates.push(update),
      }),
    ).rejects.toBe(abortError);
    expect(updates.some((update) => update.stage === "terminal")).toBe(false);
  });

  it("rejects an aborted signal when a layer ignores cancellation and resolves", async () => {
    const abortController = new AbortController();
    const terminalResult = createRenderResult(REQUIRED_NODE_KEYS, 100);
    const updates: CopcCameraStreamTerminalRenderUpdate[] = [];
    const onProgressCommitted = vi.fn();
    const layer = createLayer(async (_nodeKeys, options) => {
      abortController.abort();
      options.onProgress?.(terminalResult);
      return terminalResult;
    });

    await expect(
      runCopcCameraStreamTerminalRender({
        ...createOptions(layer),
        signal: abortController.signal,
        onProgressCommitted,
        onUpdate: (update) => updates.push(update),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(updates).toEqual([]);
    expect(onProgressCommitted).not.toHaveBeenCalled();
  });

  it("suppresses publication without canceling or weakening terminal verification", async () => {
    const terminalResult = createRenderResult(REQUIRED_NODE_KEYS, 100);
    const updates: CopcCameraStreamTerminalRenderUpdate[] = [];
    const onProgressCommitted = vi.fn();
    const layer = createLayer(async (_nodeKeys, options) => {
      options.onProgress?.(terminalResult);
      return terminalResult;
    });

    const result = await runCopcCameraStreamTerminalRender({
      ...createOptions(layer),
      shouldPublish: () => false,
      onProgressCommitted,
      onUpdate: (update) => updates.push(update),
    });

    expect(result.visualQuality.isTerminalReady).toBe(true);
    expect(updates).toEqual([]);
    expect(onProgressCommitted).not.toHaveBeenCalled();
  });
});

function createOptions(
  layer: CopcCameraStreamTerminalRenderLayer,
): CopcCameraStreamTerminalRenderOptions {
  return {
    layer,
    frontierNodeKeys: FRONTIER_NODE_KEYS,
    requiredNodeKeys: REQUIRED_NODE_KEYS,
    renderedPointBudget: 100,
    maxPointCountPerNode: 25,
    rendererKind: "typed",
    lodSettings: {
      targetPointSpacingScreenPixels: 4,
    },
    runtimeSettings: createCopcCameraStreamRuntimeSettings(),
  };
}

function createLayer(
  render: (
    nodeKeys: readonly string[],
    options: CopcPointCloudLayerProgressiveRenderNodesOptions,
  ) => Promise<CopcPointCloudLayerNodesRenderResult>,
): CopcCameraStreamTerminalRenderLayer {
  return {
    renderNodesProgressively: render,
  };
}

function createRenderResult(
  nodeKeys: readonly string[],
  sampledPointCount: number,
): CopcPointCloudLayerNodesRenderResult {
  return {
    pointSamples: {
      nodeKeys,
      nodeResults: [],
      sampledPointCount,
    },
  } as unknown as CopcPointCloudLayerNodesRenderResult;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("Expected the terminal render to reject.");
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}
