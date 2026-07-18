import { afterEach, describe, expect, it, vi } from "vitest";
import type { Copc as CopcData } from "copc";
import type {
  CesiumCopcPointGeometryWorkerInboundMessage,
  CesiumCopcPointGeometryWorkerLoadRequest,
  CesiumCopcPointGeometryWorkerOutboundMessage,
} from "./CesiumCopcPointGeometryWorkerProtocol";

const mocks = vi.hoisted(() => ({
  createHttpRangeGetter: vi.fn(() => async () => new Uint8Array()),
  createCopc: vi.fn(async (_getter?: unknown) => ({
    header: {
      pointDataRecordLength: 16,
    },
  })),
  getSharedLazPerf: vi.fn(async () => undefined),
  loadCopcNodePointDataView: vi.fn(async (options: {
    readonly getter?: (begin: number, end: number) => Promise<Uint8Array>;
    readonly node: { readonly pointCount: number };
    readonly timing?: {
      onLazPerfInitialized(milliseconds: number): void;
    };
  }) => ({
    pointCount: options.node.pointCount,
    dimensions: {
      X: {},
      Y: {},
      Z: {},
    },
    getter: () => (index: number) => index,
  })),
  createSpatiallyDistributedPointIndices: vi.fn(
    (options: { readonly pointCount: number }) =>
      Uint32Array.from(
        { length: options.pointCount },
        (_value, index) => index,
      ),
  ),
  sampleCopcPointDataView: vi.fn((options: {
    readonly nodeKey: string;
    readonly view: { readonly pointCount: number };
    readonly maxPointCount: number;
    readonly spatialPointOrder?: Uint32Array;
  }) => {
    const sampledPointCount = Math.min(
      options.view.pointCount,
      options.maxPointCount,
    );

    return {
      nodeKey: options.nodeKey,
      nodePointCount: options.view.pointCount,
      sampledPointCount,
      points: [],
      pointData: {
        x: new Float64Array(sampledPointCount),
        y: new Float64Array(sampledPointCount),
        z: new Float64Array(sampledPointCount),
        red: new Uint8Array(sampledPointCount),
        green: new Uint8Array(sampledPointCount),
        blue: new Uint8Array(sampledPointCount),
      },
    };
  }),
  createNodePointSampleBatchKey: vi.fn((sample: { readonly nodeKey: string }) =>
    sample.nodeKey
  ),
  createPointGeometryBatchFromSerializableTransform: vi.fn((options: {
    readonly key: string;
    readonly pointData: { readonly x: Float64Array };
  }) => ({
    key: options.key,
    pointCount: options.pointData.x.length,
    positions: new Float64Array(options.pointData.x.length * 3),
    colors: new Uint8Array(options.pointData.x.length * 4),
  })),
}));

vi.mock("copc", () => ({
  Copc: {
    create: mocks.createCopc,
  },
}));

vi.mock("../core/copc/createHttpRangeGetter", () => ({
  createHttpRangeGetter: mocks.createHttpRangeGetter,
}));

vi.mock("../core/copc/createLazPerf", () => ({
  getSharedLazPerf: mocks.getSharedLazPerf,
}));

vi.mock("../core/copc/loadCopcNodePointSamples", () => ({
  loadCopcNodePointDataView: mocks.loadCopcNodePointDataView,
  sampleCopcPointDataView: mocks.sampleCopcPointDataView,
}));

vi.mock("../core/copc/createSpatiallyDistributedPointIndices", () => ({
  createSpatiallyDistributedPointIndices:
    mocks.createSpatiallyDistributedPointIndices,
  SPATIAL_POINT_ORDER_BYTES_PER_POINT: Uint32Array.BYTES_PER_ELEMENT,
}));

vi.mock("./pointGeometryBatch", () => ({
  createNodePointSampleBatchKey: mocks.createNodePointSampleBatchKey,
  createPointGeometryBatchFromSerializableTransform:
    mocks.createPointGeometryBatchFromSerializableTransform,
}));

describe("CesiumCopcPointGeometryWorker decoded point data cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("opens the COPC source during source-aware warmup", async () => {
    const worker = await importWorker();

    worker.dispatch({
      id: 1,
      type: "warmup",
      url: "https://example.com/sample.copc.laz",
    });
    await worker.waitForMessageCount(1);
    worker.dispatch(createLoadRequest(2, "1-0-0-0", 100));
    await worker.waitForMessageCount(2);

    expect(mocks.getSharedLazPerf).toHaveBeenCalled();
    expect(mocks.createCopc).toHaveBeenCalledTimes(1);
    expect(worker.messages.map((message) => message.type)).toEqual([
      "warmup:success",
      "loadNodePointGeometry:success",
    ]);
  });

  it("opens a brokered COPC source through main-thread range responses", async () => {
    const worker = await importWorker();
    mocks.createCopc.mockImplementationOnce(
      async (nextGetter?: unknown) => {
        const getter = nextGetter as (
          begin: number,
          end: number,
        ) => Promise<Uint8Array>;
        await getter(0, 16);
        return {
          header: {
            pointDataRecordLength: 16,
          },
        };
      },
    );

    worker.dispatch({
      id: 1,
      type: "warmup",
      url: "https://example.com/sample.copc.laz",
      brokeredRangeRequests: true,
    });
    await worker.waitForMessageCount(1);

    expect(worker.messages[0]).toMatchObject({
      type: "range:request",
      sourceKey: "url:https://example.com/sample.copc.laz",
      begin: 0,
      end: 16,
    });
    expect(mocks.createHttpRangeGetter).not.toHaveBeenCalled();

    worker.dispatch({
      type: "range:success",
      rangeRequestId:
        worker.messages[0].type === "range:request"
          ? worker.messages[0].rangeRequestId
          : -1,
      buffer: new ArrayBuffer(16),
    });
    await worker.waitForMessageCount(2);

    expect(worker.messages[1]).toMatchObject({
      type: "warmup:success",
    });
  });

  it("restores brokered range errors into worker request errors", async () => {
    const worker = await importWorker();
    mocks.createCopc.mockImplementationOnce(
      async (nextGetter?: unknown) => {
        const getter = nextGetter as (
          begin: number,
          end: number,
        ) => Promise<Uint8Array>;
        await getter(0, 16);
        return {
          header: {
            pointDataRecordLength: 16,
          },
        };
      },
    );

    worker.dispatch({
      id: 1,
      type: "warmup",
      url: "https://example.com/sample.copc.laz",
      brokeredRangeRequests: true,
    });
    await worker.waitForMessageCount(1);
    worker.dispatch({
      type: "range:error",
      rangeRequestId:
        worker.messages[0].type === "range:request"
          ? worker.messages[0].rangeRequestId
          : -1,
      error: {
        name: "RangeError",
        message: "broker range failed",
        stack: "RangeError: broker range failed",
      },
    });
    await worker.waitForMessageCount(2);

    expect(worker.messages[1]).toMatchObject({
      type: "warmup:error",
      error: {
        name: "RangeError",
        message: "broker range failed",
        stack: "RangeError: broker range failed",
      },
    });
  });

  it("passes preferred broker fetch ranges for contained node point reads", async () => {
    const worker = await importWorker();
    mocks.loadCopcNodePointDataView.mockImplementationOnce(
      async (options: {
        readonly getter?: (
          begin: number,
          end: number,
        ) => Promise<Uint8Array>;
        readonly node: { readonly pointCount: number };
      }) => {
        if (!options.getter) {
          throw new Error("Expected a brokered getter.");
        }

        await options.getter(120, 150);
        return createDecodedPointDataView(options.node.pointCount);
      },
    );

    worker.dispatch({
      ...createLoadRequest(1, "1-0-0-0", 100),
      brokeredRangeRequests: true,
      pointDataRange: {
        begin: 100,
        end: 200,
      },
    });
    await worker.waitForMessageCount(1);

    expect(worker.messages[0]).toMatchObject({
      type: "range:request",
      sourceKey: "url:https://example.com/sample.copc.laz",
      begin: 120,
      end: 150,
      fetchBegin: 100,
      fetchEnd: 200,
    });

    worker.dispatch({
      type: "range:success",
      rangeRequestId:
        worker.messages[0].type === "range:request"
          ? worker.messages[0].rangeRequestId
          : -1,
      buffer: new ArrayBuffer(30),
    });
    await worker.waitForMessageCount(2);

    expect(worker.messages[1]).toMatchObject({
      type: "loadNodePointGeometry:success",
    });
  });

  it("reports point-data range and decode timing breakdowns on cache misses", async () => {
    stubMonotonicPerformanceNow();
    const worker = await importWorker();
    mocks.loadCopcNodePointDataView.mockImplementationOnce(
      async (options: {
        readonly getter?: (
          begin: number,
          end: number,
        ) => Promise<Uint8Array>;
        readonly node: { readonly pointCount: number };
        readonly timing?: {
          onLazPerfInitialized(milliseconds: number): void;
        };
      }) => {
        options.timing?.onLazPerfInitialized(4);

        if (!options.getter) {
          throw new Error("Expected a brokered getter.");
        }

        await options.getter(120, 132);
        return createDecodedPointDataView(options.node.pointCount);
      },
    );

    worker.dispatch({
      ...createLoadRequest(1, "1-0-0-0", 100),
      brokeredRangeRequests: true,
      pointDataRange: {
        begin: 100,
        end: 200,
      },
    });
    await worker.waitForMessageCount(1);
    worker.dispatch({
      type: "range:success",
      rangeRequestId:
        worker.messages[0].type === "range:request"
          ? worker.messages[0].rangeRequestId
          : -1,
      buffer: new ArrayBuffer(12),
    });
    await worker.waitForMessageCount(2);

    expect(worker.messages[1]).toMatchObject({
      type: "loadNodePointGeometry:success",
      result: {
        timing: {
          pointDataViewCacheHit: false,
          pointDataViewRangeRequestCount: 1,
          pointDataViewRangeBytes: 12,
          pointDataViewLazPerfMilliseconds: 4,
          pointDataViewCacheWaitMilliseconds: 0,
        },
      },
    });

    if (worker.messages[1].type !== "loadNodePointGeometry:success") {
      throw new Error("Expected geometry success.");
    }

    expect(
      worker.messages[1].result.timing?.pointDataViewRangeWaitMilliseconds,
    ).toBeGreaterThan(0);
    expect(
      worker.messages[1].result.timing?.pointDataViewNonRangeMilliseconds,
    ).toBeGreaterThanOrEqual(0);
  });

  it("attributes in-flight decoded view reuse to cache wait without duplicate range work", async () => {
    stubMonotonicPerformanceNow();
    const worker = await importWorker();
    let resolveDecodedView!: (
      view: ReturnType<typeof createDecodedPointDataView>,
    ) => void;
    const pendingDecodedView = new Promise<
      ReturnType<typeof createDecodedPointDataView>
    >((resolve) => {
      resolveDecodedView = resolve;
    });
    mocks.loadCopcNodePointDataView.mockReturnValueOnce(pendingDecodedView);

    worker.dispatch(createLoadRequest(1, "1-0-0-0", 100));
    await Promise.resolve();
    await Promise.resolve();
    worker.dispatch(createLoadRequest(2, "1-0-0-0", 100));
    resolveDecodedView(createDecodedPointDataView(1_000));
    await worker.waitForMessageCount(2);

    expect(mocks.loadCopcNodePointDataView).toHaveBeenCalledTimes(1);

    const first = worker.messages.find(
      (message) =>
        message.type === "loadNodePointGeometry:success" && message.id === 1,
    );
    const second = worker.messages.find(
      (message) =>
        message.type === "loadNodePointGeometry:success" && message.id === 2,
    );

    expect(first).toMatchObject({
      result: {
        timing: {
          pointDataViewCacheHit: false,
        },
      },
    });
    expect(second).toMatchObject({
      result: {
        timing: {
          pointDataViewCacheHit: true,
          pointDataViewRangeRequestCount: 0,
          pointDataViewRangeBytes: 0,
          pointDataViewRangeWaitMilliseconds: 0,
          pointDataViewLazPerfMilliseconds: 0,
          pointDataViewNonRangeMilliseconds: 0,
        },
      },
    });

    if (second?.type !== "loadNodePointGeometry:success") {
      throw new Error("Expected second geometry success.");
    }

    expect(
      second.result.timing?.pointDataViewCacheWaitMilliseconds,
    ).toBeGreaterThan(0);
  });

  it("uses supplied COPC metadata during source-aware warmup", async () => {
    const worker = await importWorker();
    const copc = {
      header: {
        pointDataRecordLength: 16,
      },
    } as CopcData;

    worker.dispatch({
      id: 1,
      type: "warmup",
      url: "https://example.com/sample.copc.laz",
      copc,
    });
    await worker.waitForMessageCount(1);
    worker.dispatch(createLoadRequest(2, "1-0-0-0", 100));
    await worker.waitForMessageCount(2);

    expect(mocks.createCopc).not.toHaveBeenCalled();
    expect(mocks.loadCopcNodePointDataView).toHaveBeenCalledWith(
      expect.objectContaining({ copc }),
    );
  });

  it("recovers an existing failed source when later geometry supplies COPC metadata", async () => {
    const worker = await importWorker();
    const copc = {
      header: {
        pointDataRecordLength: 24,
      },
    } as CopcData;

    mocks.createCopc.mockRejectedValueOnce(new Error("fallback metadata failed"));
    worker.dispatch(createLoadRequest(1, "1-0-0-0", 100));
    await worker.waitForMessageCount(1);
    worker.dispatch({
      ...createLoadRequest(2, "1-0-0-0", 100),
      copc,
    });
    await worker.waitForMessageCount(2);

    expect(worker.messages[0]).toMatchObject({
      type: "loadNodePointGeometry:error",
      error: {
        message: "fallback metadata failed",
      },
    });
    expect(worker.messages[1]).toMatchObject({
      type: "loadNodePointGeometry:success",
    });
    expect(mocks.createCopc).toHaveBeenCalledTimes(1);
    expect(mocks.loadCopcNodePointDataView).toHaveBeenCalledWith(
      expect.objectContaining({ copc }),
    );
  });

  it("reuses one non-transferred spatial order across density requests", async () => {
    const worker = await importWorker();

    worker.dispatch(createLoadRequest(1, "1-0-0-0", 100));
    await worker.waitForMessageCount(1);
    worker.dispatch(createLoadRequest(2, "1-0-0-0", 500));
    await worker.waitForMessageCount(2);

    expect(mocks.loadCopcNodePointDataView).toHaveBeenCalledTimes(1);
    expect(mocks.createSpatiallyDistributedPointIndices).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.sampleCopcPointDataView).toHaveBeenCalledTimes(2);
    const spatialPointOrder = mocks.createSpatiallyDistributedPointIndices.mock
      .results[0]?.value as Uint32Array | undefined;

    expect(spatialPointOrder).toBeInstanceOf(Uint32Array);
    expect(
      mocks.sampleCopcPointDataView.mock.calls[0]?.[0].spatialPointOrder,
    ).toBe(spatialPointOrder);
    expect(
      mocks.sampleCopcPointDataView.mock.calls[1]?.[0].spatialPointOrder,
    ).toBe(spatialPointOrder);
    expect(worker.transferLists[0]).toHaveLength(2);
    expect(worker.transferLists[1]).toHaveLength(2);
    expect(worker.transferLists.flat()).not.toContain(spatialPointOrder?.buffer);
    expect(spatialPointOrder?.byteLength).toBe(4_000);
    expect(worker.messages[1]).toMatchObject({
      cache: {
        retainedViewCount: 1,
        retainedBytes: 20_000,
        cacheHitCount: 1,
        cacheMissCount: 1,
        requestedNodeRetained: true,
      },
    });
  });

  it("evicts decoded node views using the per-request cache limits", async () => {
    const worker = await importWorker();

    worker.dispatch({
      ...createLoadRequest(1, "1-0-0-0", 100),
      maxDecodedPointDataViews: 1,
    });
    await worker.waitForMessageCount(1);
    worker.dispatch({
      ...createLoadRequest(2, "1-1-0-0", 100),
      maxDecodedPointDataViews: 1,
    });
    await worker.waitForMessageCount(2);
    worker.dispatch({
      ...createLoadRequest(3, "1-0-0-0", 100),
      maxDecodedPointDataViews: 1,
    });
    await worker.waitForMessageCount(3);

    expect(mocks.loadCopcNodePointDataView).toHaveBeenCalledTimes(3);
    expect(mocks.createSpatiallyDistributedPointIndices).toHaveBeenCalledTimes(
      3,
    );
    expect(worker.messages.map((message) => message.type)).toEqual([
      "loadNodePointGeometry:success",
      "loadNodePointGeometry:success",
      "loadNodePointGeometry:success",
    ]);
  });

  it("enforces one decoded-view LRU across COPC sources", async () => {
    const worker = await importWorker();

    worker.dispatch({
      ...createLoadRequest(1, "1-0-0-0", 100),
      url: "https://example.com/first.copc.laz",
      maxDecodedPointDataViews: 1,
    });
    await worker.waitForMessageCount(1);
    worker.dispatch({
      ...createLoadRequest(2, "1-0-0-0", 100),
      url: "https://example.com/second.copc.laz",
      maxDecodedPointDataViews: 1,
    });
    await worker.waitForMessageCount(2);
    worker.dispatch({
      ...createLoadRequest(3, "1-0-0-0", 100),
      url: "https://example.com/first.copc.laz",
      maxDecodedPointDataViews: 1,
    });
    await worker.waitForMessageCount(3);

    expect(mocks.loadCopcNodePointDataView).toHaveBeenCalledTimes(3);
    expect(worker.messages[1]).toMatchObject({
      cache: {
        retainedViewCount: 1,
        retainedBytes: 20_000,
        cacheEvictionCount: 1,
        evictedNodeKeys: [
          {
            sourceKey: "url:https://example.com/first.copc.laz",
            nodeKey: "1-0-0-0",
          },
        ],
      },
    });
  });

  it("serves oversized decoded views without retaining them", async () => {
    const worker = await importWorker();

    worker.dispatch({
      ...createLoadRequest(1, "1-0-0-0", 100),
      maxDecodedPointDataViewBytes: 19_999,
    });
    await worker.waitForMessageCount(1);
    worker.dispatch({
      ...createLoadRequest(2, "1-0-0-0", 100),
      maxDecodedPointDataViewBytes: 19_999,
    });
    await worker.waitForMessageCount(2);

    expect(mocks.loadCopcNodePointDataView).toHaveBeenCalledTimes(2);
    expect(mocks.createSpatiallyDistributedPointIndices).toHaveBeenCalledTimes(
      2,
    );
    expect(worker.messages[1]).toMatchObject({
      type: "loadNodePointGeometry:success",
      cache: {
        retainedViewCount: 0,
        retainedBytes: 0,
        cacheMissCount: 2,
        oversizedEntrySkipCount: 2,
        requestedNodeRetained: false,
      },
    });
  });

  it("prefetches decoded node views without sampling or geometry payloads", async () => {
    const worker = await importWorker();

    worker.dispatch(createPrefetchRequest(1, "1-0-0-0"));
    await worker.waitForMessageCount(1);
    worker.dispatch(createLoadRequest(2, "1-0-0-0", 100));
    await worker.waitForMessageCount(2);

    expect(mocks.loadCopcNodePointDataView).toHaveBeenCalledTimes(1);
    expect(mocks.sampleCopcPointDataView).toHaveBeenCalledTimes(1);
    expect(
      mocks.createPointGeometryBatchFromSerializableTransform,
    ).toHaveBeenCalledTimes(1);
    expect(worker.messages[0]).toMatchObject({
      type: "prefetchNodePointData:success",
      result: {
        nodeKey: "1-0-0-0",
      },
      cache: {
        retainedViewCount: 1,
        cacheMissCount: 1,
        requestedNodeRetained: true,
      },
    });
    expect(worker.messages.map((message) => message.type)).toEqual([
      "prefetchNodePointData:success",
      "loadNodePointGeometry:success",
    ]);
  });

  it("forwards the resolved color style into integrated geometry creation", async () => {
    const worker = await importWorker();
    const request = {
      ...createLoadRequest(1, "1-0-0-0", 100),
      pointColorStyle: {
        mode: "elevation",
        minimumZ: 10,
        inverseZRange: 0.01,
      },
    } as const;

    worker.dispatch(request);
    await worker.waitForMessageCount(1);

    expect(
      mocks.createPointGeometryBatchFromSerializableTransform,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        pointColorStyle: request.pointColorStyle,
      }),
    );
  });

  it("reports evictions and rollback state when a decoded view fails", async () => {
    const worker = await importWorker();

    worker.dispatch({
      ...createLoadRequest(1, "1-0-0-0", 100),
      maxDecodedPointDataViews: 1,
    });
    await worker.waitForMessageCount(1);
    mocks.loadCopcNodePointDataView.mockRejectedValueOnce(
      new Error("decoded view failed"),
    );
    worker.dispatch({
      ...createLoadRequest(2, "1-1-0-0", 100),
      maxDecodedPointDataViews: 1,
    });
    await worker.waitForMessageCount(2);

    expect(worker.messages[1]).toMatchObject({
      type: "loadNodePointGeometry:error",
      cache: {
        retainedViewCount: 0,
        retainedBytes: 0,
        cacheMissCount: 2,
        cacheEvictionCount: 1,
        requestedNodeRetained: false,
        evictedNodeKeys: [
          {
            sourceKey: "url:https://example.com/sample.copc.laz",
            nodeKey: "1-0-0-0",
          },
        ],
      },
      error: {
        message: "decoded view failed",
      },
    });
  });

  it("reports retained cache state after an in-flight request is canceled", async () => {
    const worker = await importWorker();
    let resolveDecodedView!: (
      view: ReturnType<typeof createDecodedPointDataView>,
    ) => void;
    const pendingDecodedView = new Promise<
      ReturnType<typeof createDecodedPointDataView>
    >((resolve) => {
      resolveDecodedView = resolve;
    });

    worker.dispatch({
      ...createLoadRequest(1, "1-0-0-0", 100),
      maxDecodedPointDataViews: 1,
    });
    await worker.waitForMessageCount(1);
    mocks.loadCopcNodePointDataView.mockReturnValueOnce(pendingDecodedView);
    worker.dispatch({
      ...createLoadRequest(2, "1-1-0-0", 100),
      maxDecodedPointDataViews: 1,
    });
    worker.dispatch({ id: 2, type: "cancel" });
    resolveDecodedView(createDecodedPointDataView(1_000));
    await worker.waitForMessageCount(2);

    expect(worker.messages[1]).toMatchObject({
      type: "loadNodePointGeometry:canceled",
      cache: {
        retainedViewCount: 1,
        retainedBytes: 20_000,
        cacheEvictionCount: 1,
        requestedNodeRetained: true,
        evictedNodeKeys: [
          {
            sourceKey: "url:https://example.com/sample.copc.laz",
            nodeKey: "1-0-0-0",
          },
        ],
      },
    });
  });
});

function createDecodedPointDataView(pointCount: number) {
  return {
    pointCount,
    dimensions: {
      X: {},
      Y: {},
      Z: {},
    },
    getter: () => (index: number) => index,
  };
}

async function importWorker(): Promise<{
  readonly messages: CesiumCopcPointGeometryWorkerOutboundMessage[];
  readonly transferLists: readonly Transferable[][];
  dispatch(request: CesiumCopcPointGeometryWorkerInboundMessage): void;
  waitForMessageCount(count: number): Promise<void>;
}> {
  let listener:
    | ((
        event: { readonly data: CesiumCopcPointGeometryWorkerInboundMessage },
      ) => void)
    | undefined;
  const messages: CesiumCopcPointGeometryWorkerOutboundMessage[] = [];
  const transferLists: Transferable[][] = [];

  vi.resetModules();
  vi.stubGlobal(
    "addEventListener",
    (
      type: string,
      nextListener: (
        event: { readonly data: CesiumCopcPointGeometryWorkerInboundMessage },
      ) => void,
    ) => {
      if (type === "message") {
        listener = nextListener;
      }
    },
  );
  vi.stubGlobal(
    "postMessage",
    (
      message: CesiumCopcPointGeometryWorkerOutboundMessage,
      transfer: readonly Transferable[] = [],
    ) => {
      messages.push(message);
      transferLists.push([...transfer]);
    },
  );

  await import("./CesiumCopcPointGeometryWorker");

  if (!listener) {
    throw new Error("Expected the worker message listener to be registered.");
  }

  return {
    messages,
    transferLists,
    dispatch: (request) => {
      listener?.({ data: request });
    },
    waitForMessageCount: async (count) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (messages.length >= count) {
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      throw new Error(`Timed out waiting for ${count} worker messages.`);
    },
  };
}

function createLoadRequest(
  id: number,
  nodeKey: string,
  maxPointCount: number,
): CesiumCopcPointGeometryWorkerLoadRequest {
  return {
    id,
    type: "loadNodePointGeometry",
    url: "https://example.com/sample.copc.laz",
    nodeKey,
    node: {
      pointCount: 1_000,
      pointDataOffset: 100,
      pointDataLength: 2_000,
    },
    maxPointCount,
    transform: {
      kind: "geographic",
      heightScaleToMeters: 1,
    },
  };
}

function createPrefetchRequest(
  id: number,
  nodeKey: string,
): CesiumCopcPointGeometryWorkerInboundMessage {
  return {
    id,
    type: "prefetchNodePointData",
    url: "https://example.com/sample.copc.laz",
    nodeKey,
    node: {
      pointCount: 1_000,
      pointDataOffset: 100,
      pointDataLength: 2_000,
    },
  };
}

function stubMonotonicPerformanceNow(): void {
  let time = 0;
  vi.stubGlobal("performance", {
    now: vi.fn(() => {
      time += 5;
      return time;
    }),
  });
}
