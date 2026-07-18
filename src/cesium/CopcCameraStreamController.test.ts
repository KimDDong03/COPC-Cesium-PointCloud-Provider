import { describe, expect, it } from "vitest";
import {
  CopcCameraStreamNodeSampleCache,
  CopcCameraStreamPrefetchController,
  CopcCameraStreamRequestController,
  canReuseCopcCameraStreamCommittedRender,
  hasFreshCopcCameraStreamNodeSamples,
  mergeCopcCameraStreamNodeSamples,
  shouldRenderCopcCameraStreamProgress,
  type CopcCameraStreamNodeSampleLike,
  type CopcCameraStreamTimeoutScheduler,
} from "./CopcCameraStreamController";

describe("CopcCameraStreamRequestController", () => {
  it("starts a request and exposes the previous active request", () => {
    const controller = createRequestController();
    const firstRequest = controller.startRequest();
    controller.setActiveNodeKeys(["3-4-0-0"]);

    const secondRequest = controller.startRequest();

    expect(secondRequest.requestId).toBe(firstRequest.requestId + 1);
    expect(secondRequest.previousRequest).toEqual({
      abortController: firstRequest.abortController,
      nodeKeys: ["3-4-0-0"],
    });
    expect(firstRequest.abortController.signal.aborted).toBe(false);
  });

  it("keeps overlapping previous requests alive for background reuse", () => {
    const controller = createRequestController();
    const firstRequest = controller.startRequest();
    controller.setActiveNodeKeys(["3-4-0-0"]);
    const secondRequest = controller.startRequest();

    controller.reconcilePreviousRequestForNodeReuse(
      secondRequest.previousRequest,
      ["4-8-0-0"],
    );

    expect(firstRequest.abortController.signal.aborted).toBe(false);
    expect(controller.reusedRequestCount).toBe(1);
  });

  it("aborts reused background requests after the configured grace period", () => {
    const scheduler = new FakeScheduler();
    const controller = createRequestController({
      reusedBackgroundRequestGraceMilliseconds: 50,
      scheduler,
    });
    const firstRequest = controller.startRequest();
    controller.setActiveNodeKeys(["3-4-0-0"]);
    const secondRequest = controller.startRequest();

    controller.reconcilePreviousRequestForNodeReuse(
      secondRequest.previousRequest,
      ["4-8-0-0"],
    );

    expect(firstRequest.abortController.signal.aborted).toBe(false);
    expect(controller.reusedRequestCount).toBe(1);

    scheduler.flushAll();

    expect(firstRequest.abortController.signal.aborted).toBe(true);
    expect(controller.reusedRequestCount).toBe(0);
  });

  it("clears a reused background grace timer when the request completes", () => {
    const scheduler = new FakeScheduler();
    const controller = createRequestController({
      reusedBackgroundRequestGraceMilliseconds: 50,
      scheduler,
    });
    const firstRequest = controller.startRequest();
    controller.setActiveNodeKeys(["3-4-0-0"]);
    const secondRequest = controller.startRequest();

    controller.reconcilePreviousRequestForNodeReuse(
      secondRequest.previousRequest,
      ["4-8-0-0"],
    );
    controller.completeRequest(firstRequest.abortController);
    scheduler.flushAll();

    expect(firstRequest.abortController.signal.aborted).toBe(false);
    expect(controller.reusedRequestCount).toBe(0);
    expect(scheduler.clearedHandles).toEqual([1]);
  });

  it("aborts reused requests immediately when the grace period is zero", () => {
    const controller = createRequestController({
      reusedBackgroundRequestGraceMilliseconds: 0,
    });
    const firstRequest = controller.startRequest();
    controller.setActiveNodeKeys(["3-4-0-0"]);
    const secondRequest = controller.startRequest();

    controller.reconcilePreviousRequestForNodeReuse(
      secondRequest.previousRequest,
      ["4-8-0-0"],
    );

    expect(firstRequest.abortController.signal.aborted).toBe(true);
    expect(controller.reusedRequestCount).toBe(0);
  });

  it("aborts unrelated previous requests", () => {
    const controller = createRequestController();
    const firstRequest = controller.startRequest();
    controller.setActiveNodeKeys(["3-4-0-0"]);
    const secondRequest = controller.startRequest();

    controller.reconcilePreviousRequestForNodeReuse(
      secondRequest.previousRequest,
      ["4-0-0-0"],
    );

    expect(firstRequest.abortController.signal.aborted).toBe(true);
    expect(controller.reusedRequestCount).toBe(0);
  });

  it("aborts every superseded render request while preserving the current request", () => {
    const controller = createRequestController();
    const firstRequest = controller.startRequest();
    controller.setActiveNodeKeys(["3-4-0-0"]);
    const secondRequest = controller.startRequest();
    controller.reconcilePreviousRequestForNodeReuse(
      secondRequest.previousRequest,
      ["3-4-0-0"],
    );
    controller.setActiveNodeKeys(["3-4-0-0"]);
    const thirdRequest = controller.startRequest();

    controller.abortSupersededRenderRequests(thirdRequest.previousRequest);

    expect(firstRequest.signal.aborted).toBe(true);
    expect(secondRequest.signal.aborted).toBe(true);
    expect(thirdRequest.signal.aborted).toBe(false);
    expect(controller.reusedRequestCount).toBe(0);
    expect(
      controller.isCurrentRequest(thirdRequest.requestId, thirdRequest.signal),
    ).toBe(true);
  });

  it("aborts family-overlapping previous requests when exact overlap is too low", () => {
    const controller = createRequestController({
      minExactNodeOverlapRatio: 0.5,
    });
    const firstRequest = controller.startRequest();
    controller.setActiveNodeKeys(["3-4-0-0", "3-5-0-0"]);
    const secondRequest = controller.startRequest();

    controller.reconcilePreviousRequestForNodeReuse(
      secondRequest.previousRequest,
      ["4-8-0-0", "4-10-0-0"],
    );

    expect(firstRequest.abortController.signal.aborted).toBe(true);
    expect(controller.reusedRequestCount).toBe(0);
  });

  it("trims old reused background requests", () => {
    const controller = createRequestController({
      maxReusedBackgroundRequests: 1,
    });
    const firstRequest = controller.startRequest();
    controller.setActiveNodeKeys(["3-4-0-0"]);
    const secondRequest = controller.startRequest();
    controller.reconcilePreviousRequestForNodeReuse(
      secondRequest.previousRequest,
      ["4-8-0-0"],
    );
    controller.setActiveNodeKeys(["3-4-0-0"]);
    const thirdRequest = controller.startRequest();

    controller.reconcilePreviousRequestForNodeReuse(
      thirdRequest.previousRequest,
      ["4-8-0-0"],
    );

    expect(firstRequest.abortController.signal.aborted).toBe(true);
    expect(secondRequest.abortController.signal.aborted).toBe(false);
    expect(controller.reusedRequestCount).toBe(1);
  });

  it("invalidates and aborts active and reused requests on cancel", () => {
    const controller = createRequestController();
    const firstRequest = controller.startRequest();
    controller.setActiveNodeKeys(["3-4-0-0"]);
    const secondRequest = controller.startRequest();
    controller.reconcilePreviousRequestForNodeReuse(
      secondRequest.previousRequest,
      ["4-8-0-0"],
    );

    controller.cancelRequest();

    expect(firstRequest.abortController.signal.aborted).toBe(true);
    expect(secondRequest.abortController.signal.aborted).toBe(true);
    expect(controller.isCurrentRequest(secondRequest.requestId, secondRequest.signal))
      .toBe(false);
  });

  it("invalidates completed active requests so late background progress cannot apply", () => {
    const controller = createRequestController();
    const request = controller.startRequest();

    expect(controller.isActive).toBe(true);
    expect(controller.isCurrentRequest(request.requestId, request.signal))
      .toBe(true);

    controller.completeRequest(request.abortController);

    expect(request.signal.aborted).toBe(true);
    expect(controller.isActive).toBe(false);
    expect(controller.isCurrentRequest(request.requestId, request.signal))
      .toBe(false);
  });

  it("reports active state while a request is started until it is cancelled", () => {
    const controller = createRequestController();

    expect(controller.isActive).toBe(false);

    const request = controller.startRequest();

    expect(controller.isActive).toBe(true);

    controller.cancelRequest();

    expect(request.signal.aborted).toBe(true);
    expect(controller.isActive).toBe(false);
  });

  it("queues only the latest render callback", () => {
    const scheduler = new FakeScheduler();
    const controller = createRequestController({ scheduler });
    let renderCount = 0;

    controller.queueRender(30, () => {
      renderCount += 1;
    });
    expect(controller.isActive).toBe(true);

    controller.queueRender(30, () => {
      renderCount += 10;
    });
    expect(controller.isActive).toBe(true);

    scheduler.flushAll();

    expect(renderCount).toBe(10);
    expect(controller.isActive).toBe(false);
    expect(scheduler.clearedHandles).toEqual([1]);
  });

  it("clears queued render active state explicitly", () => {
    const scheduler = new FakeScheduler();
    const controller = createRequestController({ scheduler });

    controller.queueRender(30, () => undefined);

    expect(controller.isActive).toBe(true);

    controller.clearQueuedRender();

    expect(controller.isActive).toBe(false);
    expect(scheduler.clearedHandles).toEqual([1]);
  });

  it("keeps active work available for overlap reuse while a move render is queued", () => {
    const scheduler = new FakeScheduler();
    const controller = createRequestController({ scheduler });
    const activeRequest = controller.startRequest();
    controller.setActiveNodeKeys(["3-4-0-0"]);

    controller.queueRender(30, () => undefined);

    expect(controller.isActive).toBe(true);
    expect(controller.isCurrentRequest(activeRequest.requestId, activeRequest.signal))
      .toBe(false);
    expect(activeRequest.signal.aborted).toBe(false);

    const nextRequest = controller.startRequest();

    expect(nextRequest.previousRequest).toEqual({
      abortController: activeRequest.abortController,
      nodeKeys: ["3-4-0-0"],
    });
  });

  it("tracks the last render signature explicitly", () => {
    const controller = createRequestController();

    expect(controller.hasRenderSignature("nodes@budget")).toBe(false);
    controller.rememberRenderSignature("nodes@budget");
    expect(controller.hasRenderSignature("nodes@budget")).toBe(true);
    controller.clearRenderSignature();
    expect(controller.hasRenderSignature("nodes@budget")).toBe(false);
  });
});

describe("CopcCameraStreamPrefetchController", () => {
  it("starts one prefetch task and clears it after completion", async () => {
    const controller = new CopcCameraStreamPrefetchController();
    const task = createDeferredTask();

    expect(controller.start(task.run)).toBe(true);
    expect(controller.isActive).toBe(true);

    task.resolve();
    await task.settled;
    await flushPromises();

    expect(controller.isActive).toBe(false);
  });

  it("does not start another prefetch while one is active", () => {
    const controller = new CopcCameraStreamPrefetchController();
    const firstTask = createDeferredTask();
    const secondTask = createDeferredTask();

    expect(controller.start(firstTask.run)).toBe(true);
    expect(controller.start(secondTask.run)).toBe(false);

    expect(firstTask.runCount).toBe(1);
    expect(secondTask.runCount).toBe(0);
  });

  it("cancels an active prefetch and allows a new one", () => {
    const controller = new CopcCameraStreamPrefetchController();
    const firstTask = createDeferredTask();
    const secondTask = createDeferredTask();

    controller.start(firstTask.run);
    controller.cancel();

    expect(firstTask.signal?.aborted).toBe(true);
    expect(controller.isActive).toBe(false);
    expect(controller.start(secondTask.run)).toBe(true);
  });

  it("does not let an older completion clear a newer prefetch", async () => {
    const controller = new CopcCameraStreamPrefetchController();
    const firstTask = createDeferredTask();
    const secondTask = createDeferredTask();

    controller.start(firstTask.run);
    controller.cancel();
    controller.start(secondTask.run);

    firstTask.resolve();
    await firstTask.settled;
    await flushPromises();

    expect(controller.isActive).toBe(true);

    secondTask.resolve();
    await secondTask.settled;
    await flushPromises();

    expect(controller.isActive).toBe(false);
  });

  it("clears failed prefetch tasks without throwing", async () => {
    const controller = new CopcCameraStreamPrefetchController();
    const task = createDeferredTask();

    controller.start(task.run);
    task.reject(new Error("prefetch failed"));
    await task.settled;
    await flushPromises();

    expect(controller.isActive).toBe(false);
  });

  it("waits for the active prefetch task to settle", async () => {
    const controller = new CopcCameraStreamPrefetchController();
    const task = createDeferredTask();
    let settled = false;

    controller.start(task.run);
    const idle = controller.waitForIdle().then(() => {
      settled = true;
    });

    await flushPromises();
    expect(settled).toBe(false);

    task.resolve();
    await idle;

    expect(settled).toBe(true);
    expect(controller.isActive).toBe(false);
  });
});

describe("CopcCameraStreamNodeSampleCache", () => {
  it("returns the densest cached sample for a node", () => {
    const cache = new CopcCameraStreamNodeSampleCache<NodeSample>({
      maxSampleSetCount: 8,
    });

    cache.remember([
      nodeSample("4-1-0-0", 10_000, 2_000),
      nodeSample("4-1-0-0", 10_000, 6_000),
    ]);

    expect(cache.find("4-1-0-0", 8_000)?.sampledPointCount).toBe(6_000);
  });

  it("prefers a fresh sample over a denser but still insufficient sample", () => {
    const cache = new CopcCameraStreamNodeSampleCache<NodeSample>({
      maxSampleSetCount: 8,
    });

    cache.remember([
      nodeSample("4-1-0-0", 10_000, 4_000),
      nodeSample("4-1-0-0", 5_000, 5_000),
    ]);

    expect(cache.find("4-1-0-0", 8_000)?.nodePointCount).toBe(5_000);
  });

  it("removes samples that can no longer be rendered", () => {
    const cache = new CopcCameraStreamNodeSampleCache<NodeSample>({
      maxSampleSetCount: 8,
      canRenderNodeSample: (sample) => sample.renderable,
    });

    cache.remember([
      nodeSample("4-1-0-0", 10_000, 8_000, false),
      nodeSample("4-1-0-0", 10_000, 4_000, true),
    ]);

    expect(cache.find("4-1-0-0", 8_000)?.sampledPointCount).toBe(4_000);
    expect(cache.size).toBe(1);
  });

  it("trims the oldest cached samples when the limit is exceeded", () => {
    const cache = new CopcCameraStreamNodeSampleCache<NodeSample>({
      maxSampleSetCount: 2,
    });

    cache.remember([
      nodeSample("4-0-0-0", 10_000, 1_000),
      nodeSample("4-1-0-0", 10_000, 1_000),
      nodeSample("4-2-0-0", 10_000, 1_000),
    ]);

    expect(cache.find("4-0-0-0", 1_000)).toBeUndefined();
    expect(cache.find("4-1-0-0", 1_000)).toBeDefined();
    expect(cache.find("4-2-0-0", 1_000)).toBeDefined();
  });

  it("reads requested nodes in request order", () => {
    const cache = new CopcCameraStreamNodeSampleCache<NodeSample>({
      maxSampleSetCount: 8,
    });

    cache.remember([
      nodeSample("4-2-0-0", 10_000, 1_000),
      nodeSample("4-1-0-0", 10_000, 1_000),
    ]);

    expect(
      cache
        .read(["4-1-0-0", "4-2-0-0"], 1_000)
        .map((sample) => sample.nodeKey),
    ).toEqual(["4-1-0-0", "4-2-0-0"]);
  });

  it("checks whether every node has a fresh sample", () => {
    expect(
      hasFreshCopcCameraStreamNodeSamples(
        ["4-1-0-0", "4-2-0-0"],
        [
          nodeSample("4-1-0-0", 10_000, 8_000),
          nodeSample("4-2-0-0", 4_000, 4_000),
        ],
        8_000,
      ),
    ).toBe(true);

    expect(
      hasFreshCopcCameraStreamNodeSamples(
        ["4-1-0-0", "4-2-0-0"],
        [
          nodeSample("4-1-0-0", 10_000, 7_999),
          nodeSample("4-2-0-0", 4_000, 4_000),
        ],
        8_000,
      ),
    ).toBe(false);
  });

  it("merges node samples by keeping the densest result per node", () => {
    expect(
      mergeCopcCameraStreamNodeSamples(
        [
          nodeSample("4-1-0-0", 10_000, 2_000),
          nodeSample("4-2-0-0", 10_000, 3_000),
        ],
        [
          nodeSample("4-1-0-0", 10_000, 8_000),
          nodeSample("4-3-0-0", 10_000, 1_000),
        ],
      ).map((sample) => [sample.nodeKey, sample.sampledPointCount]),
    ).toEqual([
      ["4-1-0-0", 8_000],
      ["4-2-0-0", 3_000],
      ["4-3-0-0", 1_000],
    ]);
  });
});

describe("canReuseCopcCameraStreamCommittedRender", () => {
  const completeRender = [
    nodeSample("4-1-0-0", 10_000, 8_000),
    nodeSample("4-2-0-0", 4_000, 4_000),
  ];

  it("reuses an exact fresh terminal composition with unchanged budgets", () => {
    expect(
      canReuseCopcCameraStreamCommittedRender({
        requiredNodeKeys: ["4-2-0-0", "4-1-0-0"],
        renderedNodeSamples: completeRender,
        maxPointCountPerNode: 8_000,
        previousMaxPointCountPerNode: 8_000,
        renderedPointBudget: 360_000,
        previousRenderedPointBudget: 360_000,
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "missing node",
      requiredNodeKeys: ["4-1-0-0", "4-2-0-0", "4-3-0-0"],
      renderedNodeSamples: completeRender,
      maxPointCountPerNode: 8_000,
      previousMaxPointCountPerNode: 8_000,
      renderedPointBudget: 360_000,
      previousRenderedPointBudget: 360_000,
    },
    {
      name: "unexpected node",
      requiredNodeKeys: ["4-1-0-0"],
      renderedNodeSamples: completeRender,
      maxPointCountPerNode: 8_000,
      previousMaxPointCountPerNode: 8_000,
      renderedPointBudget: 360_000,
      previousRenderedPointBudget: 360_000,
    },
    {
      name: "stale density",
      requiredNodeKeys: ["4-1-0-0", "4-2-0-0"],
      renderedNodeSamples: [
        nodeSample("4-1-0-0", 10_000, 7_999),
        nodeSample("4-2-0-0", 4_000, 4_000),
      ],
      maxPointCountPerNode: 8_000,
      previousMaxPointCountPerNode: 8_000,
      renderedPointBudget: 360_000,
      previousRenderedPointBudget: 360_000,
    },
    {
      name: "changed per-node density",
      requiredNodeKeys: ["4-1-0-0", "4-2-0-0"],
      renderedNodeSamples: completeRender,
      maxPointCountPerNode: 8_000,
      previousMaxPointCountPerNode: 4_000,
      renderedPointBudget: 360_000,
      previousRenderedPointBudget: 360_000,
    },
    {
      name: "changed total budget",
      requiredNodeKeys: ["4-1-0-0", "4-2-0-0"],
      renderedNodeSamples: completeRender,
      maxPointCountPerNode: 8_000,
      previousMaxPointCountPerNode: 8_000,
      renderedPointBudget: 360_000,
      previousRenderedPointBudget: 300_000,
    },
  ])("rejects a $name composition", (options) => {
    expect(canReuseCopcCameraStreamCommittedRender(options)).toBe(false);
  });
});

describe("shouldRenderCopcCameraStreamProgress", () => {
  it("rejects a sparse new-request candidate while a denser previous-request frame is still committed", () => {
    expect(
      shouldRenderCopcCameraStreamProgress({
        candidateRenderedPointCount: 2,
        currentRendererPointCount: 6,
        retainsCurrentRendererFrame: true,
        isComplete: false,
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: "complete candidate",
      candidateRenderedPointCount: 2,
      currentRendererPointCount: 6,
      retainsCurrentRendererFrame: true,
      isComplete: true,
    },
    {
      name: "density-preserving candidate",
      candidateRenderedPointCount: 6,
      currentRendererPointCount: 6,
      retainsCurrentRendererFrame: true,
      isComplete: false,
    },
    {
      name: "unrelated new-view candidate",
      candidateRenderedPointCount: 2,
      currentRendererPointCount: 6,
      retainsCurrentRendererFrame: false,
      isComplete: false,
    },
  ])("accepts a $name", ({ name: _name, ...options }) => {
    expect(shouldRenderCopcCameraStreamProgress(options)).toBe(true);
  });
});

function createRequestController(
  options: Partial<{
    maxReusedBackgroundRequests: number;
    minExactNodeOverlapRatio: number;
    reusedBackgroundRequestGraceMilliseconds: number;
    scheduler: CopcCameraStreamTimeoutScheduler;
  }> = {},
): CopcCameraStreamRequestController {
  return new CopcCameraStreamRequestController({
    maxReusedBackgroundRequests: options.maxReusedBackgroundRequests ?? 2,
    minExactNodeOverlapRatio: options.minExactNodeOverlapRatio,
    minNodeFamilyOverlapRatio: 0.5,
    reusedBackgroundRequestGraceMilliseconds:
      options.reusedBackgroundRequestGraceMilliseconds,
    scheduler: options.scheduler ?? new FakeScheduler(),
  });
}

class FakeScheduler implements CopcCameraStreamTimeoutScheduler {
  readonly clearedHandles: unknown[] = [];
  readonly #callbacks = new Map<number, () => void>();
  #nextHandle = 1;

  setTimeout(callback: () => void): unknown {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#callbacks.set(handle, callback);
    return handle;
  }

  clearTimeout(timeoutHandle: unknown): void {
    this.clearedHandles.push(timeoutHandle);

    if (typeof timeoutHandle === "number") {
      this.#callbacks.delete(timeoutHandle);
    }
  }

  flushAll(): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    callbacks.forEach((callback) => callback());
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferredTask(): {
  readonly run: (signal: AbortSignal) => Promise<void>;
  readonly settled: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly runCount: number;
  readonly signal: AbortSignal | undefined;
} {
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  let runCount = 0;
  let signal: AbortSignal | undefined;
  const settled = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  }).catch(() => undefined);

  return {
    run: (nextSignal) => {
      runCount += 1;
      signal = nextSignal;
      return settled;
    },
    settled,
    resolve: () => resolvePromise?.(),
    reject: (error) => rejectPromise?.(error),
    get runCount() {
      return runCount;
    },
    get signal() {
      return signal;
    },
  };
}

interface NodeSample extends CopcCameraStreamNodeSampleLike {
  readonly renderable: boolean;
}

function nodeSample(
  nodeKey: string,
  nodePointCount: number,
  sampledPointCount: number,
  renderable = true,
): NodeSample {
  return {
    nodeKey,
    nodePointCount,
    sampledPointCount,
    renderable,
  };
}
