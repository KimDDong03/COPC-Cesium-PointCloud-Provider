import { afterEach, describe, expect, it, vi } from "vitest";
import type { Copc as CopcData } from "copc";
import type {
  CopcPointSampleWorkerLoadRequest,
  CopcPointSampleWorkerRequest,
  CopcPointSampleWorkerResponse,
} from "./CopcPointSampleWorkerProtocol";

const mocks = vi.hoisted(() => ({
  createHttpRangeGetter: vi.fn(() => async () => new Uint8Array()),
  createCopc: vi.fn(async () => ({
    header: {
      pointDataRecordLength: 16,
    },
  })),
  loadCopcNodePointDataView: vi.fn(async (options: {
    readonly node: { readonly pointCount: number };
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
    readonly sampleFormat?: string;
    readonly spatialPointOrder?: Uint32Array;
  }) => {
    const sampledPointCount = Math.min(
      options.view.pointCount,
      options.maxPointCount,
    );

    const result = {
      nodeKey: options.nodeKey,
      nodePointCount: options.view.pointCount,
      sampledPointCount,
      points: Array.from({ length: sampledPointCount }, (_value, index) => ({
        x: index,
        y: index,
        z: index,
      })),
    };

    if (options.sampleFormat !== "typed") {
      return result;
    }

    return {
      ...result,
      points: [],
      pointData: {
        x: new Float64Array(sampledPointCount),
        y: new Float64Array(sampledPointCount),
        z: new Float64Array(sampledPointCount),
        red: new Uint8Array(sampledPointCount),
        green: new Uint8Array(sampledPointCount),
        blue: new Uint8Array(sampledPointCount),
        classification: new Uint8Array(sampledPointCount),
        intensity: new Uint16Array(sampledPointCount),
      },
    };
  }),
}));

vi.mock("copc", () => ({
  Copc: {
    create: mocks.createCopc,
  },
}));

vi.mock("./createHttpRangeGetter", () => ({
  createHttpRangeGetter: mocks.createHttpRangeGetter,
}));

vi.mock("./loadCopcNodePointSamples", () => ({
  loadCopcNodePointDataView: mocks.loadCopcNodePointDataView,
  sampleCopcPointDataView: mocks.sampleCopcPointDataView,
}));

vi.mock("./createSpatiallyDistributedPointIndices", () => ({
  createSpatiallyDistributedPointIndices:
    mocks.createSpatiallyDistributedPointIndices,
  SPATIAL_POINT_ORDER_BYTES_PER_POINT: Uint32Array.BYTES_PER_ELEMENT,
}));

describe("CopcPointSampleWorker decoded view cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("uses supplied COPC metadata without reopening the source", async () => {
    const worker = await importWorker();
    const copc = {
      header: {
        pointDataRecordLength: 16,
      },
    } as CopcData;

    worker.dispatch({
      ...createLoadRequest(1, "1-0-0-0", 100),
      copc,
    });
    await worker.waitForMessageCount(1);

    expect(mocks.createCopc).not.toHaveBeenCalled();
    expect(mocks.loadCopcNodePointDataView).toHaveBeenCalledWith(
      expect.objectContaining({ copc }),
    );
  });

  it("reuses a decoded node view for repeated sample requests", async () => {
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
    expect(
      mocks.sampleCopcPointDataView.mock.calls.map(
        ([options]) => options.maxPointCount,
      ),
    ).toEqual([100, 500]);
    const firstSpatialPointOrder =
      mocks.sampleCopcPointDataView.mock.calls[0]?.[0].spatialPointOrder;

    expect(firstSpatialPointOrder).toBeInstanceOf(Uint32Array);
    expect(
      mocks.sampleCopcPointDataView.mock.calls[1]?.[0].spatialPointOrder,
    ).toBe(firstSpatialPointOrder);
    expect(worker.messages.map((message) => message.type)).toEqual([
      "loadNodePointSamples:success",
      "loadNodePointSamples:success",
    ]);
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

  it("passes the requested sample format to the decoded view sampler", async () => {
    const worker = await importWorker();

    worker.dispatch({
      ...createLoadRequest(1, "1-0-0-0", 100),
      sampleFormat: "typed",
    });
    await worker.waitForMessageCount(1);

    expect(mocks.sampleCopcPointDataView).toHaveBeenCalledWith(
      expect.objectContaining({
        sampleFormat: "typed",
      }),
    );
    expect(worker.transferLists[0]).toHaveLength(8);
    const spatialPointOrder = mocks.createSpatiallyDistributedPointIndices.mock
      .results[0]?.value as Uint32Array | undefined;

    expect(spatialPointOrder).toBeInstanceOf(Uint32Array);
    expect(worker.transferLists[0]).not.toContain(spatialPointOrder?.buffer);
    expect(spatialPointOrder?.byteLength).toBe(4_000);
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
      "loadNodePointSamples:success",
      "loadNodePointSamples:success",
      "loadNodePointSamples:success",
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
      type: "loadNodePointSamples:success",
      cache: {
        retainedViewCount: 0,
        retainedBytes: 0,
        cacheMissCount: 2,
        oversizedEntrySkipCount: 2,
        requestedNodeRetained: false,
      },
    });
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
      type: "loadNodePointSamples:error",
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
      type: "loadNodePointSamples:canceled",
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
  readonly messages: CopcPointSampleWorkerResponse[];
  readonly transferLists: readonly Transferable[][];
  dispatch(request: CopcPointSampleWorkerRequest): void;
  waitForMessageCount(count: number): Promise<void>;
}> {
  let listener:
    | ((event: { readonly data: CopcPointSampleWorkerRequest }) => void)
    | undefined;
  const messages: CopcPointSampleWorkerResponse[] = [];
  const transferLists: Transferable[][] = [];

  vi.resetModules();
  vi.stubGlobal(
    "addEventListener",
    (
      type: string,
      nextListener: (
        event: { readonly data: CopcPointSampleWorkerRequest },
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
      message: CopcPointSampleWorkerResponse,
      transfer: readonly Transferable[] = [],
    ) => {
      messages.push(message);
      transferLists.push([...transfer]);
    },
  );

  await import("./CopcPointSampleWorker");

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
): CopcPointSampleWorkerLoadRequest {
  return {
    id,
    type: "loadNodePointSamples",
    url: "https://example.com/sample.copc.laz",
    nodeKey,
    node: {
      pointCount: 1_000,
      pointDataOffset: 100,
      pointDataLength: 2_000,
    },
    maxPointCount,
  };
}
