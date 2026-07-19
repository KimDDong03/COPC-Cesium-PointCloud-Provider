import { Copc } from "copc";
import type { Copc as CopcData, Hierarchy } from "copc";
import { describe, expect, it, vi } from "vitest";
import { CopcSource } from "./CopcSource";
import { createCopcRangeGetter } from "./createCopcRangeGetter";
import type { CopcDecodedPointDataCacheSnapshot } from "./CopcDecodedPointDataCache";
import type { CopcNodePointSampleResult } from "./CopcPointDataSample";
import type {
  CopcPointSampleWorkerLoadRequest,
  CopcPointSampleWorkerRequest,
  CopcPointSampleWorkerResponse,
} from "./CopcPointSampleWorkerProtocol";

vi.mock("./createCopcRangeGetter", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./createCopcRangeGetter")>();

  return {
    ...actual,
    createCopcRangeGetter: vi.fn(actual.createCopcRangeGetter),
  };
});

describe("CopcSource point sample cache", () => {
  it("stores Blob-backed source descriptors for local file inputs", () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]) as Blob & {
      readonly name: string;
    };
    Object.defineProperty(blob, "name", {
      value: "local-sample.copc.laz",
    });
    const source = new CopcSource(blob);

    expect(source.input).toBe(blob);
    expect(source.url).toBe("local-sample.copc.laz");
    expect(source.getDescriptor().input).toBe(blob);
    expect(source.getDescriptor().key).toMatch(/^blob:\d+$/);
  });

  it("passes range getter options when constructing the source getter", () => {
    const input = "https://example.com/sample.copc.laz";
    const rangeGetterOptions = { maxRangeByteLength: 17 };
    const createGetter = vi.mocked(createCopcRangeGetter);

    createGetter.mockClear();
    new CopcSource(input, { rangeGetterOptions });

    expect(createGetter).toHaveBeenCalledWith(input, rangeGetterOptions);
  });

  it("reports cache hits and misses for sampled hierarchy nodes", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz");
    const mutableSource = source as unknown as {
      loadNodePointSamplesWithoutCache: (
        nodeKey: string,
        maxPointCount: number,
      ) => Promise<CopcNodePointSampleResult>;
    };
    let loadCount = 0;

    mutableSource.loadNodePointSamplesWithoutCache = async (
      nodeKey,
      maxPointCount,
    ) => {
      loadCount += 1;

      return {
        nodeKey,
        nodePointCount: 10,
        sampledPointCount: maxPointCount,
        points: [],
      };
    };

    await source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
    });
    await source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
    });
    await source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 6,
    });

    expect(loadCount).toBe(2);
    expect(source.getPointSampleCacheStats()).toEqual({
      cachedSampleSetCount: 2,
      maxCachedSampleSetCount: 32,
      cachedPointSampleBytes: 0,
      maxCachedPointSampleBytes: 33_554_432,
      cacheHitCount: 1,
      cacheMissCount: 2,
      cacheEvictionCount: 0,
    });
  });

  it("reuses a denser sampled node cache for a lower point count request", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz");
    const mutableSource = source as unknown as {
      loadNodePointSamplesWithoutCache: (
        nodeKey: string,
        maxPointCount: number,
      ) => Promise<CopcNodePointSampleResult>;
    };
    let loadCount = 0;

    mutableSource.loadNodePointSamplesWithoutCache = async (
      nodeKey,
      maxPointCount,
    ) => {
      loadCount += 1;

      return {
        nodeKey,
        nodePointCount: 10,
        sampledPointCount: maxPointCount,
        points: createSamplePoints(maxPointCount),
      };
    };

    await source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 8,
    });
    const reused = await source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 3,
    });

    expect(loadCount).toBe(1);
    expect(reused.sampledPointCount).toBe(3);
    expect(reused.points.map((point) => point.x)).toEqual([0, 1, 2]);
    expect(source.getPointSampleCacheStats()).toEqual(
      expect.objectContaining({
        cachedSampleSetCount: 1,
        cacheHitCount: 1,
        cacheMissCount: 1,
      }),
    );
  });

  it("downsamples and accounts for typed classification and intensity data", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz");
    const mutableSource = source as unknown as {
      loadNodePointSamplesWithoutCache: (
        nodeKey: string,
        maxPointCount: number,
      ) => Promise<CopcNodePointSampleResult>;
    };

    mutableSource.loadNodePointSamplesWithoutCache = async (
      nodeKey,
      maxPointCount,
    ) => ({
      nodeKey,
      nodePointCount: maxPointCount,
      sampledPointCount: maxPointCount,
      points: [],
      pointData: {
        x: new Float64Array([2, 0, 3, 1]),
        y: new Float64Array([12, 10, 13, 11]),
        z: new Float64Array([22, 20, 23, 21]),
        classification: new Uint8Array([6, 2, 9, 3]),
        intensity: new Uint16Array([300, 100, 400, 200]),
      },
    });

    await source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 4,
      sampleFormat: "typed",
    });
    const reused = await source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 2,
      sampleFormat: "typed",
    });

    expect(reused.pointData?.x).toEqual(new Float64Array([2, 0]));
    expect(reused.pointData?.classification).toEqual(new Uint8Array([6, 2]));
    expect(reused.pointData?.intensity).toEqual(new Uint16Array([300, 100]));
    expect(source.getPointSampleCacheStats()).toEqual(
      expect.objectContaining({
        cachedPointSampleBytes: 108,
        cacheHitCount: 1,
      }),
    );
  });

  it("counts object classification and intensity fields toward cache limits", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      maxCachedPointSampleBytes: 26,
    });
    const mutableSource = source as unknown as {
      loadNodePointSamplesWithoutCache: (
        nodeKey: string,
      ) => Promise<CopcNodePointSampleResult>;
    };

    mutableSource.loadNodePointSamplesWithoutCache = async (nodeKey) => ({
      nodeKey,
      nodePointCount: 1,
      sampledPointCount: 1,
      points: [{ x: 0, y: 0, z: 0, classification: 2, intensity: 1_000 }],
    });

    await source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 1,
    });

    expect(source.getPointSampleCacheStats()).toEqual(
      expect.objectContaining({
        cachedSampleSetCount: 0,
        cachedPointSampleBytes: 0,
        cacheEvictionCount: 1,
      }),
    );
  });

  it("evicts least recently used sampled node caches when the limit is reached", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      maxCachedSampleSets: 2,
    });
    const mutableSource = source as unknown as {
      loadNodePointSamplesWithoutCache: (
        nodeKey: string,
        maxPointCount: number,
      ) => Promise<CopcNodePointSampleResult>;
    };
    const loadedCacheKeys: string[] = [];

    mutableSource.loadNodePointSamplesWithoutCache = async (
      nodeKey,
      maxPointCount,
    ) => {
      loadedCacheKeys.push(`${nodeKey}:${maxPointCount}`);

      return {
        nodeKey,
        nodePointCount: 10,
        sampledPointCount: maxPointCount,
        points: [],
      };
    };

    await source.loadNodePointSamples({ nodeKey: "0-0-0-0", maxPointCount: 5 });
    await source.loadNodePointSamples({ nodeKey: "1-0-0-0", maxPointCount: 5 });
    await source.loadNodePointSamples({ nodeKey: "0-0-0-0", maxPointCount: 5 });
    await source.loadNodePointSamples({ nodeKey: "1-1-0-0", maxPointCount: 5 });
    await source.loadNodePointSamples({ nodeKey: "1-0-0-0", maxPointCount: 5 });

    expect(loadedCacheKeys).toEqual([
      "0-0-0-0:5",
      "1-0-0-0:5",
      "1-1-0-0:5",
      "1-0-0-0:5",
    ]);
    expect(source.getPointSampleCacheStats()).toEqual({
      cachedSampleSetCount: 2,
      maxCachedSampleSetCount: 2,
      cachedPointSampleBytes: 0,
      maxCachedPointSampleBytes: 33_554_432,
      cacheHitCount: 1,
      cacheMissCount: 4,
      cacheEvictionCount: 2,
    });
  });

  it("evicts least recently used sampled node caches when the byte limit is reached", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      maxCachedSampleSets: 10,
      maxCachedPointSampleBytes: 60,
    });
    const mutableSource = source as unknown as {
      loadNodePointSamplesWithoutCache: (
        nodeKey: string,
        maxPointCount: number,
      ) => Promise<CopcNodePointSampleResult>;
    };
    const loadedCacheKeys: string[] = [];

    mutableSource.loadNodePointSamplesWithoutCache = async (
      nodeKey,
      maxPointCount,
    ) => {
      loadedCacheKeys.push(`${nodeKey}:${maxPointCount}`);

      return {
        nodeKey,
        nodePointCount: 10,
        sampledPointCount: 2,
        points: createSamplePoints(2),
      };
    };

    await source.loadNodePointSamples({ nodeKey: "0-0-0-0", maxPointCount: 5 });
    await source.loadNodePointSamples({ nodeKey: "1-0-0-0", maxPointCount: 5 });
    await source.loadNodePointSamples({ nodeKey: "0-0-0-0", maxPointCount: 5 });

    expect(loadedCacheKeys).toEqual([
      "0-0-0-0:5",
      "1-0-0-0:5",
      "0-0-0-0:5",
    ]);
    expect(source.getPointSampleCacheStats()).toEqual({
      cachedSampleSetCount: 1,
      maxCachedSampleSetCount: 10,
      cachedPointSampleBytes: 54,
      maxCachedPointSampleBytes: 60,
      cacheHitCount: 0,
      cacheMissCount: 3,
      cacheEvictionCount: 2,
    });
  });

  it("clears cached point samples without resetting cache counters", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz");
    const mutableSource = source as unknown as {
      loadNodePointSamplesWithoutCache: (
        nodeKey: string,
        maxPointCount: number,
      ) => Promise<CopcNodePointSampleResult>;
    };

    mutableSource.loadNodePointSamplesWithoutCache = async (
      nodeKey,
      maxPointCount,
    ) => ({
      nodeKey,
      nodePointCount: 10,
      sampledPointCount: maxPointCount,
      points: [],
    });

    await source.loadNodePointSamples({ nodeKey: "0-0-0-0", maxPointCount: 5 });

    expect(source.clearPointSampleCache()).toBe(1);
    expect(source.getPointSampleCacheStats()).toEqual({
      cachedSampleSetCount: 0,
      maxCachedSampleSetCount: 32,
      cachedPointSampleBytes: 0,
      maxCachedPointSampleBytes: 33_554_432,
      cacheHitCount: 0,
      cacheMissCount: 1,
      cacheEvictionCount: 0,
    });
  });

  it("rejects invalid point sample cache limits", () => {
    expect(
      () =>
        new CopcSource("https://example.com/sample.copc.laz", {
          maxCachedSampleSets: 0,
        }),
    ).toThrow("maxCachedSampleSets must be a positive integer.");

    expect(
      () =>
        new CopcSource("https://example.com/sample.copc.laz", {
          maxCachedPointSampleBytes: 0,
        }),
    ).toThrow("maxCachedPointSampleBytes must be a positive integer.");

    expect(
      () =>
        new CopcSource("https://example.com/sample.copc.laz", {
          maxCachedHierarchyPages: 0,
        }),
    ).toThrow("maxCachedHierarchyPages must be a positive integer.");

    expect(
      () =>
        new CopcSource("https://example.com/sample.copc.laz", {
          maxCachedHierarchyPageBytes: 0,
        }),
    ).toThrow("maxCachedHierarchyPageBytes must be a positive integer.");

    expect(
      () =>
        new CopcSource("https://example.com/sample.copc.laz", {
          maxConcurrentHierarchyPageLoads: 0,
        }),
    ).toThrow("maxConcurrentHierarchyPageLoads must be a positive integer.");

    expect(
      () =>
        new CopcSource("https://example.com/sample.copc.laz", {
          maxConcurrentPointSampleWorkerRequests: 0,
        }),
    ).toThrow(
      "maxConcurrentPointSampleWorkerRequests must be a positive integer.",
    );

    expect(
      () =>
        new CopcSource("https://example.com/sample.copc.laz", {
          maxDecodedPointDataViewsPerWorker: 0,
        }),
    ).toThrow("maxDecodedPointDataViewsPerWorker must be a positive integer.");

    expect(
      () =>
        new CopcSource("https://example.com/sample.copc.laz", {
          maxDecodedPointDataViewBytesPerWorker: 0,
        }),
    ).toThrow(
      "maxDecodedPointDataViewBytesPerWorker must be a positive integer.",
    );

    expect(
      () =>
        new CopcSource("https://example.com/sample.copc.laz", {
          maxDecodedPointDataViewBytesAcrossWorkers: 0,
        }),
    ).toThrow(
      "maxDecodedPointDataViewBytesAcrossWorkers must be a positive integer.",
    );

    expect(
      () =>
        new CopcSource("https://example.com/sample.copc.laz", {
          pointSampleLoading: "invalid",
        } as never),
    ).toThrow("pointSampleLoading must be either 'main-thread' or 'worker'.");
  });

  it("warms point sample workers without dispatching point requests", () => {
    const workers: FakePointSampleWorker[] = [];
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "worker",
      maxConcurrentPointSampleWorkerRequests: 3,
      createPointSampleWorker: () => {
        const worker = new FakePointSampleWorker();
        workers.push(worker);

        return worker as unknown as Worker;
      },
    });

    expect(source.warmUpPointSampleWorkers({ workerCount: 2 })).toBe(2);
    expect(workers).toHaveLength(2);
    expect(workers.flatMap((worker) => worker.requests)).toEqual([]);

    expect(source.warmUpPointSampleWorkers({ workerCount: 10 })).toBe(3);
    expect(workers).toHaveLength(3);

    source.destroy();
    expect(workers.map((worker) => worker.terminateCount)).toEqual([1, 1, 1]);
  });

  it("resets active point sample worker requests without destroying the source", async () => {
    const workers: FakePointSampleWorker[] = [];
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "worker",
      createPointSampleWorker: () => {
        const worker = new FakePointSampleWorker();
        workers.push(worker);

        return worker as unknown as Worker;
      },
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async () => ({
      nodes: {
        "0-0-0-0": createNode(100),
      },
      pages: {},
    });

    const pendingResult = source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
    });
    await waitForWorkerPoolLoadRequestCount(workers, 1);

    const rejects = expect(pendingResult).rejects.toThrow(
      "COPC point sample worker was reset.",
    );

    expect(source.resetPointSampleWorkers()).toBe(1);
    expect(workers[0]?.terminateCount).toBe(1);
    await rejects;
    expect(source.getPointSampleCacheStats()).toEqual(
      expect.objectContaining({
        cachedSampleSetCount: 0,
      }),
    );

    const nextResult = source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
    });
    await waitForWorkerPoolLoadRequestCount(workers, 2);

    const nextRequest = workers[1]?.requests.find(isLoadRequest);

    if (!nextRequest) {
      throw new Error("Expected a new worker request after reset.");
    }

    workers[1]?.emit(createWorkerSuccessResponse(nextRequest));
    await expect(nextResult).resolves.toMatchObject({
      nodeKey: "0-0-0-0",
    });
  });

  it("skips point sample worker warmup when worker loading is disabled", () => {
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "main-thread",
    });

    expect(source.warmUpPointSampleWorkers()).toBe(0);
    expect(() =>
      source.warmUpPointSampleWorkers({ workerCount: 0 }),
    ).not.toThrow();
  });

  it("loads sampled hierarchy node points through a worker when configured", async () => {
    const worker = new FakePointSampleWorker((request) => ({
      id: request.id,
      type: "loadNodePointSamples:success",
      result: {
        nodeKey: request.nodeKey,
        nodePointCount: request.node.pointCount,
        sampledPointCount: 1,
        points: [
          {
            x: 1,
            y: 2,
            z: 3,
          },
        ],
      },
      cache: createDecodedPointDataCacheSnapshot({
        retainedViewCount: 1,
        retainedBytes: 20 * 1024 * 1024,
        peakRetainedBytes: 20 * 1024 * 1024,
        cacheMissCount: 1,
        requestedNodeRetained: true,
      }),
    }));
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "worker",
      maxDecodedPointDataViewsPerWorker: 80,
      maxDecodedPointDataViewBytesPerWorker: 200 * 1024 * 1024,
      maxDecodedPointDataViewBytesAcrossWorkers: 75 * 1024 * 1024,
      maxConcurrentPointSampleWorkerRequests: 3,
      createPointSampleWorker: () => worker as unknown as Worker,
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async () => ({
      nodes: {
        "0-0-0-0": createNode(100),
      },
      pages: {},
    });

    const result = await source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
    });

    expect(worker.requests).toEqual([
      expect.objectContaining({
        copc: expect.objectContaining({
          info: expect.objectContaining({
            cube: [0, 0, 0, 8, 8, 8],
          }),
        }),
        source: {
          key: "url:https://example.com/sample.copc.laz",
          input: "https://example.com/sample.copc.laz",
        },
        nodeKey: "0-0-0-0",
        node: createNode(100),
        maxPointCount: 5,
        maxDecodedPointDataViews: 80,
        maxDecodedPointDataViewBytes: 25 * 1024 * 1024,
      }),
    ]);
    expect(result).toEqual({
      nodeKey: "0-0-0-0",
      nodePointCount: 100,
      sampledPointCount: 1,
      points: [
        {
          x: 1,
          y: 2,
          z: 3,
        },
      ],
    });
    expect(source.getPointSampleCacheStats()).toEqual(
      expect.objectContaining({
        cachedSampleSetCount: 1,
        cacheMissCount: 1,
      }),
    );
    expect(source.getDecodedPointDataCacheStats()).toEqual({
      workerCount: 1,
      retainedViewCount: 1,
      retainedBytes: 20 * 1024 * 1024,
      peakRetainedBytes: 20 * 1024 * 1024,
      cacheHitCount: 0,
      cacheMissCount: 1,
      cacheEvictionCount: 0,
      oversizedEntrySkipCount: 0,
      affinityEntryCount: 1,
      maxDecodedPointDataViewBytesPerWorker: 25 * 1024 * 1024,
      maxDecodedPointDataViewBytesAcrossWorkers: 75 * 1024 * 1024,
    });
  });

  it("limits concurrent worker point sample requests", async () => {
    const workers: FakePointSampleWorker[] = [];
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "worker",
      maxConcurrentPointSampleWorkerRequests: 2,
      createPointSampleWorker: () => {
        const worker = new FakePointSampleWorker();
        workers.push(worker);

        return worker as unknown as Worker;
      },
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };
    const nodeKeys = ["0-0-0-0", "1-0-0-0", "1-1-0-0"];

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async () => ({
      nodes: {
        "0-0-0-0": createNode(100),
        "1-0-0-0": createNode(50),
        "1-1-0-0": createNode(25),
      },
      pages: {},
    });

    const promise = source.loadNodesPointSamples({
      nodeKeys,
      maxPointCountPerNode: 5,
    });
    await waitForWorkerPoolLoadRequestCount(workers, 2);
    expect(workers).toHaveLength(2);
    expect(
      workers[0]?.requests.filter(isLoadRequest).map((request) => request.nodeKey),
    ).toEqual(["0-0-0-0"]);
    expect(
      workers[1]?.requests.filter(isLoadRequest).map((request) => request.nodeKey),
    ).toEqual(["1-0-0-0"]);

    const firstRequest = workers[0]?.requests.find(isLoadRequest);

    if (!firstRequest) {
      throw new Error("Expected first worker load request.");
    }

    workers[0]?.emit(createWorkerSuccessResponse(firstRequest));
    await waitForWorkerPoolLoadRequestCount(workers, 3);

    const loadRequests = workers
      .flatMap((worker) => worker.requests.filter(isLoadRequest))
      .sort((first, second) => first.id - second.id);
    expect(loadRequests.map((request) => request.nodeKey)).toEqual(nodeKeys);

    for (const request of loadRequests.slice(1)) {
      const worker = workers.find((candidate) =>
        candidate.requests.includes(request),
      );
      worker?.emit(createWorkerSuccessResponse(request));
    }

    const result = await promise;
    expect(result.nodeKeys).toEqual(nodeKeys);
    expect(result.sampledPointCount).toBe(3);
  });

  it("records decoded-node affinity after success and removes worker evictions", async () => {
    const worker = new FakePointSampleWorker();
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "worker",
      maxConcurrentPointSampleWorkerRequests: 1,
      createPointSampleWorker: () => worker as unknown as Worker,
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
      decodedNodePointSampleWorkers: Map<string, Worker>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async () => ({
      nodes: {
        "0-0-0-0": createNode(100),
        "1-0-0-0": createNode(50),
      },
      pages: {},
    });

    const firstResult = source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
    });
    await waitForWorkerLoadRequestCount(worker, 1);
    expect(source.getDecodedPointDataCacheStats().affinityEntryCount).toBe(0);

    const firstRequest = worker.requests.find(isLoadRequest);
    if (!firstRequest) {
      throw new Error("Expected first point sample worker request.");
    }
    worker.emit(
      createWorkerSuccessResponse(
        firstRequest,
        createDecodedPointDataCacheSnapshot({
          retainedViewCount: 1,
          retainedBytes: 1_600,
          peakRetainedBytes: 1_600,
          cacheMissCount: 1,
          requestedNodeRetained: true,
        }),
      ),
    );
    await firstResult;
    expect([...mutableSource.decodedNodePointSampleWorkers.keys()]).toEqual([
      "0-0-0-0",
    ]);

    const secondResult = source.loadNodePointSamples({
      nodeKey: "1-0-0-0",
      maxPointCount: 5,
    });
    await waitForWorkerLoadRequestCount(worker, 2);
    const secondRequest = worker.requests.filter(isLoadRequest)[1];
    if (!secondRequest) {
      throw new Error("Expected second point sample worker request.");
    }
    worker.emit(
      createWorkerSuccessResponse(
        secondRequest,
        createDecodedPointDataCacheSnapshot({
          retainedViewCount: 1,
          retainedBytes: 800,
          peakRetainedBytes: 1_600,
          cacheMissCount: 2,
          cacheEvictionCount: 1,
          requestedNodeRetained: true,
          evictedNodeKeys: [
            {
              sourceKey: source.sourceKey,
              nodeKey: "0-0-0-0",
            },
          ],
        }),
      ),
    );
    await secondResult;

    expect([...mutableSource.decodedNodePointSampleWorkers.keys()]).toEqual([
      "1-0-0-0",
    ]);
    expect(source.getDecodedPointDataCacheStats()).toEqual(
      expect.objectContaining({
        retainedViewCount: 1,
        retainedBytes: 800,
        cacheMissCount: 2,
        cacheEvictionCount: 1,
        affinityEntryCount: 1,
      }),
    );
  });

  it("applies worker error snapshots without creating affinity for the failed request", async () => {
    const worker = new FakePointSampleWorker();
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "worker",
      maxConcurrentPointSampleWorkerRequests: 1,
      createPointSampleWorker: () => worker as unknown as Worker,
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
      decodedNodePointSampleWorkers: Map<string, Worker>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async () => ({
      nodes: {
        "0-0-0-0": createNode(100),
        "1-0-0-0": createNode(50),
      },
      pages: {},
    });

    const firstResult = source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
    });
    await waitForWorkerLoadRequestCount(worker, 1);
    const firstRequest = worker.requests.find(isLoadRequest);
    if (!firstRequest) {
      throw new Error("Expected first point sample worker request.");
    }
    worker.emit(
      createWorkerSuccessResponse(
        firstRequest,
        createDecodedPointDataCacheSnapshot({
          retainedViewCount: 1,
          retainedBytes: 1_600,
          peakRetainedBytes: 1_600,
          cacheMissCount: 1,
          requestedNodeRetained: true,
        }),
      ),
    );
    await firstResult;

    const failedResult = source.loadNodePointSamples({
      nodeKey: "1-0-0-0",
      maxPointCount: 5,
    });
    await waitForWorkerLoadRequestCount(worker, 2);
    const secondRequest = worker.requests.filter(isLoadRequest)[1];
    if (!secondRequest) {
      throw new Error("Expected second point sample worker request.");
    }
    worker.emit({
      id: secondRequest.id,
      type: "loadNodePointSamples:error",
      cache: createDecodedPointDataCacheSnapshot({
        retainedViewCount: 1,
        retainedBytes: 800,
        peakRetainedBytes: 1_600,
        cacheMissCount: 2,
        cacheEvictionCount: 1,
        requestedNodeRetained: true,
        evictedNodeKeys: [
          {
            sourceKey: source.sourceKey,
            nodeKey: "0-0-0-0",
          },
        ],
      }),
      error: { message: "sampling failed" },
    });
    await expect(failedResult).rejects.toThrow("sampling failed");

    expect([...mutableSource.decodedNodePointSampleWorkers.keys()]).toEqual([]);
    expect(source.getDecodedPointDataCacheStats()).toEqual(
      expect.objectContaining({
        retainedViewCount: 1,
        retainedBytes: 800,
        cacheMissCount: 2,
        cacheEvictionCount: 1,
        affinityEntryCount: 0,
      }),
    );
  });

  it("sends queued worker point sample requests to the worker that became idle", async () => {
    const workers: FakePointSampleWorker[] = [];
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "worker",
      maxConcurrentPointSampleWorkerRequests: 2,
      createPointSampleWorker: () => {
        const worker = new FakePointSampleWorker();
        workers.push(worker);

        return worker as unknown as Worker;
      },
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };
    const nodeKeys = ["0-0-0-0", "1-0-0-0", "1-1-0-0"];

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async () => ({
      nodes: {
        "0-0-0-0": createNode(100),
        "1-0-0-0": createNode(50),
        "1-1-0-0": createNode(25),
      },
      pages: {},
    });

    const promise = source.loadNodesPointSamples({
      nodeKeys,
      maxPointCountPerNode: 5,
    });
    await waitForWorkerPoolLoadRequestCount(workers, 2);

    const secondRequest = workers[1]?.requests.find(isLoadRequest);

    if (!secondRequest) {
      throw new Error("Expected second worker load request.");
    }

    workers[1]?.emit(createWorkerSuccessResponse(secondRequest));
    await waitForWorkerPoolLoadRequestCount(workers, 3);

    expect(
      workers[0]?.requests.filter(isLoadRequest).map((request) => request.nodeKey),
    ).toEqual(["0-0-0-0"]);
    expect(
      workers[1]?.requests.filter(isLoadRequest).map((request) => request.nodeKey),
    ).toEqual(["1-0-0-0", "1-1-0-0"]);

    const remainingRequests = workers
      .flatMap((worker) => worker.requests.filter(isLoadRequest))
      .filter((request) => request.id !== secondRequest.id);

    for (const request of remainingRequests) {
      const worker = workers.find((candidate) =>
        candidate.requests.includes(request),
      );
      worker?.emit(createWorkerSuccessResponse(request));
    }

    const result = await promise;
    expect(result.nodeKeys).toEqual(nodeKeys);
    expect(result.sampledPointCount).toBe(3);
  });

  it("waits for the active same-node point sample worker while dispatching other nodes", async () => {
    const workers: FakePointSampleWorker[] = [];
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "worker",
      maxConcurrentPointSampleWorkerRequests: 2,
      createPointSampleWorker: () => {
        const worker = new FakePointSampleWorker();
        workers.push(worker);

        return worker as unknown as Worker;
      },
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async () => ({
      nodes: {
        "0-0-0-0": createNode(100),
        "1-0-0-0": createNode(50),
      },
      pages: {},
    });

    const firstSameNodeResult = source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
    });
    await waitForWorkerPoolLoadRequestCount(workers, 1);

    const secondSameNodeResult = source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 8,
    });
    const otherNodeResult = source.loadNodePointSamples({
      nodeKey: "1-0-0-0",
      maxPointCount: 5,
    });

    await waitForWorkerPoolLoadRequestCount(workers, 2);
    expect(workers).toHaveLength(2);
    expect(
      workers[0]?.requests.filter(isLoadRequest).map((request) => [
        request.nodeKey,
        request.maxPointCount,
      ]),
    ).toEqual([["0-0-0-0", 5]]);
    expect(
      workers[1]?.requests.filter(isLoadRequest).map((request) => [
        request.nodeKey,
        request.maxPointCount,
      ]),
    ).toEqual([["1-0-0-0", 5]]);

    const otherRequest = workers[1]?.requests.find(isLoadRequest);

    if (!otherRequest) {
      throw new Error("Expected other node worker request.");
    }

    workers[1]?.emit(createWorkerSuccessResponse(otherRequest));
    await expect(otherNodeResult).resolves.toMatchObject({
      nodeKey: "1-0-0-0",
      sampledPointCount: 1,
    });
    expect(workers[1]?.requests.filter(isLoadRequest)).toHaveLength(1);

    const firstSameNodeRequest = workers[0]?.requests.find(isLoadRequest);

    if (!firstSameNodeRequest) {
      throw new Error("Expected first same-node worker request.");
    }

    workers[0]?.emit(createWorkerSuccessResponse(firstSameNodeRequest));
    await expect(firstSameNodeResult).resolves.toMatchObject({
      nodeKey: "0-0-0-0",
      sampledPointCount: 1,
    });
    await waitForWorkerPoolLoadRequestCount(workers, 3);
    expect(
      workers[0]?.requests.filter(isLoadRequest).map((request) => [
        request.nodeKey,
        request.maxPointCount,
      ]),
    ).toEqual([
      ["0-0-0-0", 5],
      ["0-0-0-0", 8],
    ]);

    const secondSameNodeRequest = workers[0]?.requests
      .filter(isLoadRequest)
      .find((request) => request.maxPointCount === 8);

    if (!secondSameNodeRequest) {
      throw new Error("Expected second same-node worker request.");
    }

    workers[0]?.emit(createWorkerSuccessResponse(secondSameNodeRequest));
    await expect(secondSameNodeResult).resolves.toMatchObject({
      nodeKey: "0-0-0-0",
      sampledPointCount: 1,
    });
  });

  it("upgrades a queued lower-density point sample worker request when a denser same-node request arrives", async () => {
    const worker = new FakePointSampleWorker();
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "worker",
      maxConcurrentPointSampleWorkerRequests: 1,
      createPointSampleWorker: () => worker as unknown as Worker,
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async () => ({
      nodes: {
        "0-0-0-0": createNode(100),
        "1-0-0-0": createNode(80),
      },
      pages: {},
    });

    const activeResult = source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
    });
    await waitForWorkerLoadRequestCount(worker, 1);

    const lowerDensityResult = source.loadNodePointSamples({
      nodeKey: "1-0-0-0",
      maxPointCount: 5,
    });
    const higherDensityResult = source.loadNodePointSamples({
      nodeKey: "1-0-0-0",
      maxPointCount: 8,
    });
    await waitForWorkerLoadRequestCount(worker, 1);
    await waitForAsyncPointSampleScheduling();

    const activeRequest = worker.requests.find(isLoadRequest);

    if (!activeRequest) {
      throw new Error("Expected active worker request.");
    }

    worker.emit(createWorkerSuccessResponse(activeRequest));
    await expect(activeResult).resolves.toMatchObject({
      nodeKey: "0-0-0-0",
    });
    await waitForWorkerLoadRequestCount(worker, 2);

    const upgradedRequest = worker.requests.filter(isLoadRequest)[1];

    if (!upgradedRequest) {
      throw new Error("Expected upgraded worker request.");
    }

    expect(upgradedRequest).toMatchObject({
      nodeKey: "1-0-0-0",
      maxPointCount: 8,
    });

    worker.emit(createWorkerSuccessResponseWithPointCount(upgradedRequest, 8));

    await expect(lowerDensityResult).resolves.toMatchObject({
      nodeKey: "1-0-0-0",
      sampledPointCount: 5,
      points: expect.arrayContaining([
        expect.objectContaining({ x: 0 }),
      ]),
    });
    await expect(higherDensityResult).resolves.toMatchObject({
      nodeKey: "1-0-0-0",
      sampledPointCount: 8,
    });
    expect(worker.requests.filter(isLoadRequest)).toHaveLength(2);
  });

  it("dispatches higher-priority queued point sample worker requests before older lower-priority work", async () => {
    const worker = new FakePointSampleWorker();
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "worker",
      maxConcurrentPointSampleWorkerRequests: 1,
      createPointSampleWorker: () => worker as unknown as Worker,
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async () => ({
      nodes: {
        "0-0-0-0": createNode(100),
        "1-0-0-0": createNode(50),
        "2-0-0-0": createNode(25),
      },
      pages: {},
    });

    const activeResult = source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
      requestPriority: 0,
    });
    await waitForWorkerLoadRequestCount(worker, 1);

    const backgroundResult = source.loadNodePointSamples({
      nodeKey: "1-0-0-0",
      maxPointCount: 5,
      requestPriority: -10,
    });
    const currentViewResult = source.loadNodePointSamples({
      nodeKey: "2-0-0-0",
      maxPointCount: 5,
      requestPriority: 20,
    });
    await waitForAsyncPointSampleScheduling();

    const activeRequest = worker.requests.find(isLoadRequest);

    if (!activeRequest) {
      throw new Error("Expected active worker request.");
    }

    worker.emit(createWorkerSuccessResponse(activeRequest));
    await expect(activeResult).resolves.toMatchObject({
      nodeKey: "0-0-0-0",
    });
    await waitForWorkerLoadRequestCount(worker, 2);

    const currentViewRequest = worker.requests.filter(isLoadRequest)[1];

    if (!currentViewRequest) {
      throw new Error("Expected current-view worker request.");
    }

    expect(currentViewRequest.nodeKey).toBe("2-0-0-0");
    worker.emit(createWorkerSuccessResponse(currentViewRequest));
    await expect(currentViewResult).resolves.toMatchObject({
      nodeKey: "2-0-0-0",
    });
    await waitForWorkerLoadRequestCount(worker, 3);

    const backgroundRequest = worker.requests.filter(isLoadRequest)[2];

    if (!backgroundRequest) {
      throw new Error("Expected background worker request.");
    }

    expect(backgroundRequest.nodeKey).toBe("1-0-0-0");
    worker.emit(createWorkerSuccessResponse(backgroundRequest));
    await expect(backgroundResult).resolves.toMatchObject({
      nodeKey: "1-0-0-0",
    });
    expect(worker.requests.filter(isLoadRequest).map((request) => request.nodeKey))
      .toEqual(["0-0-0-0", "2-0-0-0", "1-0-0-0"]);
  });

  it("raises a pending point sample cache hit above older queued work", async () => {
    const worker = new FakePointSampleWorker();
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "worker",
      maxConcurrentPointSampleWorkerRequests: 1,
      createPointSampleWorker: () => worker as unknown as Worker,
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async () => ({
      nodes: {
        "0-0-0-0": createNode(100),
        "1-0-0-0": createNode(50),
        "2-0-0-0": createNode(25),
      },
      pages: {},
    });

    const activeResult = source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
      requestPriority: 0,
    });
    await waitForWorkerLoadRequestCount(worker, 1);

    const backgroundResult = source.loadNodePointSamples({
      nodeKey: "1-0-0-0",
      maxPointCount: 5,
      requestPriority: -10,
    });
    const middlePriorityResult = source.loadNodePointSamples({
      nodeKey: "2-0-0-0",
      maxPointCount: 5,
      requestPriority: 0,
    });
    await waitForAsyncPointSampleScheduling();

    const currentViewResult = source.loadNodePointSamples({
      nodeKey: "1-0-0-0",
      maxPointCount: 5,
      requestPriority: 20,
    });
    await waitForAsyncPointSampleScheduling();

    const activeRequest = worker.requests.find(isLoadRequest);

    if (!activeRequest) {
      throw new Error("Expected active worker request.");
    }

    worker.emit(createWorkerSuccessResponse(activeRequest));
    await expect(activeResult).resolves.toMatchObject({
      nodeKey: "0-0-0-0",
    });
    await waitForWorkerLoadRequestCount(worker, 2);

    const raisedRequest = worker.requests.filter(isLoadRequest)[1];

    if (!raisedRequest) {
      throw new Error("Expected raised worker request.");
    }

    expect(raisedRequest.nodeKey).toBe("1-0-0-0");
    worker.emit(createWorkerSuccessResponse(raisedRequest));
    await expect(backgroundResult).resolves.toMatchObject({
      nodeKey: "1-0-0-0",
    });
    await expect(currentViewResult).resolves.toMatchObject({
      nodeKey: "1-0-0-0",
    });
    await waitForWorkerLoadRequestCount(worker, 3);

    const middlePriorityRequest = worker.requests.filter(isLoadRequest)[2];

    if (!middlePriorityRequest) {
      throw new Error("Expected middle-priority worker request.");
    }

    expect(middlePriorityRequest.nodeKey).toBe("2-0-0-0");
    worker.emit(createWorkerSuccessResponse(middlePriorityRequest));
    await expect(middlePriorityResult).resolves.toMatchObject({
      nodeKey: "2-0-0-0",
    });
  });

  it("does not let lower-priority dense point sample work upgrade queued current-view warmup", async () => {
    const worker = new FakePointSampleWorker();
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "worker",
      maxConcurrentPointSampleWorkerRequests: 1,
      createPointSampleWorker: () => worker as unknown as Worker,
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async () => ({
      nodes: {
        "0-0-0-0": createNode(100),
        "1-0-0-0": createNode(80),
      },
      pages: {},
    });

    const activeResult = source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
      requestPriority: 0,
    });
    await waitForWorkerLoadRequestCount(worker, 1);

    const warmupResult = source.loadNodePointSamples({
      nodeKey: "1-0-0-0",
      maxPointCount: 5,
      requestPriority: 20,
    });
    const denseDetailResult = source.loadNodePointSamples({
      nodeKey: "1-0-0-0",
      maxPointCount: 8,
      requestPriority: 10,
    });
    await waitForAsyncPointSampleScheduling();

    const activeRequest = worker.requests.find(isLoadRequest);

    if (!activeRequest) {
      throw new Error("Expected active worker request.");
    }

    worker.emit(createWorkerSuccessResponse(activeRequest));
    await expect(activeResult).resolves.toMatchObject({
      nodeKey: "0-0-0-0",
    });
    await waitForWorkerLoadRequestCount(worker, 2);

    const warmupRequest = worker.requests.filter(isLoadRequest)[1];

    if (!warmupRequest) {
      throw new Error("Expected warmup worker request.");
    }

    expect(warmupRequest).toMatchObject({
      nodeKey: "1-0-0-0",
      maxPointCount: 5,
    });
    worker.emit(createWorkerSuccessResponseWithPointCount(warmupRequest, 5));
    await expect(warmupResult).resolves.toMatchObject({
      nodeKey: "1-0-0-0",
      sampledPointCount: 5,
    });
    await waitForWorkerLoadRequestCount(worker, 3);

    const denseDetailRequest = worker.requests.filter(isLoadRequest)[2];

    if (!denseDetailRequest) {
      throw new Error("Expected dense detail worker request.");
    }

    expect(denseDetailRequest).toMatchObject({
      nodeKey: "1-0-0-0",
      maxPointCount: 8,
    });
    worker.emit(createWorkerSuccessResponseWithPointCount(denseDetailRequest, 8));
    await expect(denseDetailResult).resolves.toMatchObject({
      nodeKey: "1-0-0-0",
      sampledPointCount: 8,
    });
  });

  it("distributes a total sampled point budget across multiple nodes", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz");
    const mutableSource = source as unknown as {
      loadNodePointSamplesWithoutCache: (
        nodeKey: string,
        maxPointCount: number,
      ) => Promise<CopcNodePointSampleResult>;
    };
    const loadedCacheKeys: string[] = [];

    mutableSource.loadNodePointSamplesWithoutCache = async (
      nodeKey,
      maxPointCount,
    ) => {
      loadedCacheKeys.push(`${nodeKey}:${maxPointCount}`);

      return {
        nodeKey,
        nodePointCount: 100,
        sampledPointCount: maxPointCount,
        points: createSamplePoints(maxPointCount),
      };
    };

    const result = await source.loadNodesPointSamples({
      nodeKeys: ["0-0-0-0", "1-0-0-0", "1-1-0-0"],
      maxPointCountPerNode: 5,
      maxTotalSampledPointCount: 8,
    });

    expect(loadedCacheKeys).toEqual([
      "0-0-0-0:3",
      "1-0-0-0:3",
      "1-1-0-0:2",
    ]);
    expect(result.sampledPointCount).toBe(8);
    expect(result.points).toHaveLength(8);
  });

  it("rejects a total sampled point budget smaller than the node count", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz");

    await expect(
      source.loadNodesPointSamples({
        nodeKeys: ["0-0-0-0", "1-0-0-0", "1-1-0-0"],
        maxTotalSampledPointCount: 2,
      }),
    ).rejects.toThrow(
      "maxTotalSampledPointCount must be greater than or equal to the number of COPC hierarchy nodes.",
    );
  });

  it("keeps a shared same-node load alive when its first consumer aborts", async () => {
    const worker = new FakePointSampleWorker();
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "worker",
      createPointSampleWorker: () => worker as unknown as Worker,
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async () => ({
      nodes: {
        "0-0-0-0": createNode(100),
      },
      pages: {},
    });

    const firstAbort = new AbortController();
    const firstResult = source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
      signal: firstAbort.signal,
    });
    await waitForWorkerLoadRequestCount(worker, 1);

    const secondResult = source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
    });
    const firstRejects = expect(firstResult).rejects.toMatchObject({
      name: "AbortError",
    });

    firstAbort.abort();
    await firstRejects;
    expect(worker.terminateCount).toBe(0);
    expect(worker.requests.filter(isLoadRequest)).toHaveLength(1);

    const request = worker.requests.find(isLoadRequest);

    if (!request) {
      throw new Error("Expected a shared worker load request.");
    }

    worker.emit(createWorkerSuccessResponse(request));
    await expect(secondResult).resolves.toMatchObject({
      nodeKey: "0-0-0-0",
      sampledPointCount: 1,
    });
    expect(source.getPointSampleCacheStats()).toEqual(
      expect.objectContaining({
        cacheMissCount: 1,
        cacheHitCount: 1,
      }),
    );
  });

  it("starts a fresh same-node load after the previous shared task is abandoned", async () => {
    const worker = new FakePointSampleWorker();
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "worker",
      createPointSampleWorker: () => worker as unknown as Worker,
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async () => ({
      nodes: {
        "0-0-0-0": createNode(100),
      },
      pages: {},
    });

    const abortController = new AbortController();
    const firstResult = source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
      signal: abortController.signal,
    });
    await waitForWorkerLoadRequestCount(worker, 1);
    const firstRejects = expect(firstResult).rejects.toMatchObject({
      name: "AbortError",
    });
    let secondResult: Promise<CopcNodePointSampleResult> | undefined;

    abortController.abort();
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        secondResult = source.loadNodePointSamples({
          nodeKey: "0-0-0-0",
          maxPointCount: 5,
        });
        resolve();
      });
    });
    await firstRejects;

    if (!secondResult) {
      throw new Error("Expected a replacement same-node load.");
    }

    await waitForWorkerLoadRequestCount(worker, 2);
    const replacementRequest = worker.requests.filter(isLoadRequest)[1];

    if (!replacementRequest) {
      throw new Error("Expected a replacement worker load request.");
    }

    worker.emit(createWorkerSuccessResponse(replacementRequest));
    await expect(secondResult).resolves.toMatchObject({
      nodeKey: "0-0-0-0",
      sampledPointCount: 1,
    });
    expect(worker.terminateCount).toBe(1);
  });

  it("does not send queued worker point sample requests after abort", async () => {
    const worker = new FakePointSampleWorker();
    const abortController = new AbortController();
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "worker",
      maxConcurrentPointSampleWorkerRequests: 1,
      createPointSampleWorker: () => worker as unknown as Worker,
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async () => ({
      nodes: {
        "0-0-0-0": createNode(100),
        "1-0-0-0": createNode(50),
      },
      pages: {},
    });

    const firstPromise = source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
      signal: abortController.signal,
    });
    const secondPromise = source.loadNodePointSamples({
      nodeKey: "1-0-0-0",
      maxPointCount: 5,
      signal: abortController.signal,
    });
    await waitForWorkerLoadRequestCount(worker, 1);

    const firstRequest = worker.requests.find(isLoadRequest);

    if (!firstRequest) {
      throw new Error("Expected first worker load request.");
    }

    abortController.abort();

    const results = await Promise.allSettled([firstPromise, secondPromise]);
    expect(results).toEqual([
      {
        status: "rejected",
        reason: expect.objectContaining({ name: "AbortError" }),
      },
      {
        status: "rejected",
        reason: expect.objectContaining({ name: "AbortError" }),
      },
    ]);
    expect(
      worker.requests.filter(isLoadRequest).map((request) => request.nodeKey),
    ).toEqual(["0-0-0-0"]);
    expect(worker.terminateCount).toBe(1);
  });

  it("cancels in-flight worker point sample requests when aborted", async () => {
    const worker = new FakePointSampleWorker();
    const abortController = new AbortController();
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "worker",
      createPointSampleWorker: () => worker as unknown as Worker,
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async () => ({
      nodes: {
        "0-0-0-0": createNode(100),
      },
      pages: {},
    });

    const promise = source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
      signal: abortController.signal,
    });
    await waitForWorkerRequestCount(worker, 1);
    const request = worker.requests[0];

    if (!request || request.type !== "loadNodePointSamples") {
      throw new Error("Expected worker load request.");
    }

    abortController.abort();

    await expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(worker.terminateCount).toBe(1);

    worker.emit({
      id: request.id,
      type: "loadNodePointSamples:success",
      result: {
        nodeKey: request.nodeKey,
        nodePointCount: request.node.pointCount,
        sampledPointCount: 1,
        points: [{ x: 1, y: 2, z: 3 }],
      },
    });

    expect(source.getPointSampleCacheStats()).toEqual(
      expect.objectContaining({
        cachedSampleSetCount: 0,
        cacheMissCount: 1,
      }),
    );
  });

  it("aborts a hierarchy page waiter without canceling or merging the shared page load", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz");
    const childPage = createDeferred<Hierarchy.Subtree>();
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
    };
    let childPageLoadCount = 0;

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    const pageSpy = vi
      .spyOn(Copc, "loadHierarchyPage")
      .mockImplementation(async (_getter, page) => {
        if (page.pageOffset === 10) {
          return {
            nodes: {
              "0-0-0-0": createNode(100),
            },
            pages: {
              "1-0-0-0": { pageOffset: 30, pageLength: 40 },
            },
          };
        }

        childPageLoadCount += 1;
        return childPage.promise;
      });

    try {
      await source.loadHierarchySummary();
      const abortController = new AbortController();
      const abortedLoad = source.loadHierarchyPage("1-0-0-0", {
        signal: abortController.signal,
      });
      await waitForValue(() => childPageLoadCount, 1);

      abortController.abort();

      await expect(abortedLoad).rejects.toMatchObject({ name: "AbortError" });
      const afterAbort = await source.loadHierarchySummary();

      expect(afterAbort.nodes.map(({ key }) => key)).toEqual(["0-0-0-0"]);
      expect(afterAbort.pendingPages.map(({ key }) => key)).toEqual([
        "1-0-0-0",
      ]);

      childPage.resolve({
        nodes: {
          "1-0-0-0": createNode(50),
        },
        pages: {},
      });
      await childPage.promise;
      await Promise.resolve();

      const beforeRetry = await source.loadHierarchySummary();

      expect(beforeRetry.nodes.map(({ key }) => key)).toEqual(["0-0-0-0"]);
      expect(beforeRetry.pendingPages.map(({ key }) => key)).toEqual([
        "1-0-0-0",
      ]);

      const retried = await source.loadHierarchyPage("1-0-0-0");

      expect(childPageLoadCount).toBe(1);
      expect(retried.nodes.map(({ key }) => key)).toEqual([
        "0-0-0-0",
        "1-0-0-0",
      ]);
      expect(source.getHierarchyPageLoadStats()).toEqual(
        expect.objectContaining({
          loadCount: 2,
          cacheHitCount: 1,
          sharedTaskReuseCount: 0,
          completedLoadCount: 2,
          activeLoadCount: 0,
        }),
      );
    } finally {
      pageSpy.mockRestore();
    }
  });

  it("caps default parallel hierarchy page batches and records raw page load stats", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz");
    const childPages = new Map<number, Deferred<Hierarchy.Subtree>>();
    const activeChildPageOffsets: number[] = [];
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    const pageSpy = vi
      .spyOn(Copc, "loadHierarchyPage")
      .mockImplementation(async (_getter, page) => {
        if (page.pageOffset === 10) {
          return {
            nodes: {
              "0-0-0-0": createNode(100),
            },
            pages: {
              "1-0-0-0": { pageOffset: 30, pageLength: 40 },
              "1-1-0-0": { pageOffset: 90, pageLength: 10 },
              "1-0-1-0": { pageOffset: 110, pageLength: 11 },
              "1-1-1-0": { pageOffset: 130, pageLength: 13 },
              "1-0-0-1": { pageOffset: 150, pageLength: 15 },
            },
          };
        }

        const deferred = createDeferred<Hierarchy.Subtree>();

        childPages.set(page.pageOffset, deferred);
        activeChildPageOffsets.push(page.pageOffset);
        return deferred.promise;
      });

    try {
      const resultPromise = source.loadHierarchyPages([
        "1-0-0-0",
        "1-1-0-0",
        "1-0-1-0",
        "1-1-1-0",
        "1-0-0-1",
      ]);

      await waitForValue(() => activeChildPageOffsets.length, 2);

      expect(source.getHierarchyPageLoadStats()).toEqual(
        expect.objectContaining({
          loadCount: 3,
          activeLoadCount: 2,
          maxConcurrentLoadCount: 2,
          requestedByteCount: 70,
          batchLoadCount: 1,
          lastBatchRequestedPageCount: 5,
          maxBatchRequestedPageCount: 5,
        }),
      );

      childPages.get(30)?.resolve({
        nodes: {
          "1-0-0-0": createNode(50),
        },
        pages: {},
      });
      await waitForValue(() => activeChildPageOffsets.length, 3);
      childPages.get(90)?.resolve({
        nodes: {
          "1-1-0-0": createNode(90),
        },
        pages: {},
      });
      await waitForValue(() => activeChildPageOffsets.length, 4);
      childPages.get(110)?.resolve({
        nodes: {
          "1-0-1-0": createNode(110),
        },
        pages: {},
      });
      await waitForValue(() => activeChildPageOffsets.length, 5);

      for (const [pageOffset, deferred] of childPages) {
        if (pageOffset === 30 || pageOffset === 90 || pageOffset === 110) {
          continue;
        }

        deferred.resolve({
          nodes: {
            [pageOffsetToNodeKey(pageOffset)]: createNode(pageOffset),
          },
          pages: {},
        });
      }

      const result = await resultPromise;

      expect(result.loadedPageKeys).toEqual([
        "1-0-0-0",
        "1-1-0-0",
        "1-0-1-0",
        "1-1-1-0",
        "1-0-0-1",
      ]);
      expect(source.getHierarchyPageLoadStats()).toEqual(
        expect.objectContaining({
          loadCount: 6,
          cacheHitCount: 0,
          sharedTaskReuseCount: 0,
          completedLoadCount: 6,
          failedLoadCount: 0,
          activeLoadCount: 0,
          maxConcurrentLoadCount: 2,
          requestedByteCount: 109,
          batchLoadCount: 1,
          lastBatchRequestedPageCount: 5,
          maxBatchRequestedPageCount: 5,
        }),
      );
      expect(
        source.getHierarchyPageLoadStats().totalLoadMilliseconds,
      ).toBeGreaterThanOrEqual(
        source.getHierarchyPageLoadStats().maxLoadMilliseconds,
      );
      expect(
        source.getHierarchyPageLoadStats().totalBatchLoadMilliseconds,
      ).toBeGreaterThanOrEqual(
        source.getHierarchyPageLoadStats().maxBatchLoadMilliseconds,
      );
    } finally {
      pageSpy.mockRestore();
    }
  });

  it("preserves input-order loaded hierarchy page keys despite out-of-order parallel completion", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      maxConcurrentHierarchyPageLoads: 2,
    });
    const childPages = new Map<number, Deferred<Hierarchy.Subtree>>();
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    const pageSpy = vi
      .spyOn(Copc, "loadHierarchyPage")
      .mockImplementation(async (_getter, page) => {
        if (page.pageOffset === 10) {
          return {
            nodes: {
              "0-0-0-0": createNode(100),
            },
            pages: {
              "1-0-0-0": { pageOffset: 30, pageLength: 40 },
              "1-1-0-0": { pageOffset: 90, pageLength: 10 },
            },
          };
        }

        const deferred = createDeferred<Hierarchy.Subtree>();

        childPages.set(page.pageOffset, deferred);
        return deferred.promise;
      });

    try {
      const resultPromise = source.loadHierarchyPages([
        "1-1-0-0",
        "1-0-0-0",
        "1-1-0-0",
        "0-0-0-0",
      ]);

      await waitForValue(() => childPages.size, 2);
      childPages.get(30)?.resolve({
        nodes: {
          "1-0-0-0": createNode(50),
        },
        pages: {},
      });
      childPages.get(90)?.resolve({
        nodes: {
          "1-1-0-0": createNode(40),
        },
        pages: {},
      });

      const result = await resultPromise;

      expect(result.loadedPageKeys).toEqual(["1-1-0-0", "1-0-0-0"]);
      expect(result.hierarchy.nodes.map(({ key }) => key)).toEqual([
        "0-0-0-0",
        "1-0-0-0",
        "1-1-0-0",
      ]);
      expect(pageSpy).toHaveBeenCalledTimes(3);
      expect(source.getHierarchyPageLoadStats()).toEqual(
        expect.objectContaining({
          loadCount: 3,
          completedLoadCount: 3,
          maxConcurrentLoadCount: 2,
          requestedByteCount: 70,
          batchLoadCount: 1,
          lastBatchRequestedPageCount: 2,
        }),
      );
    } finally {
      pageSpy.mockRestore();
    }
  });

  it("loads later requested child pages after an earlier requested parent reveals them", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      maxConcurrentHierarchyPageLoads: 2,
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
    };
    const loadedOffsets: number[] = [];

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    const pageSpy = vi
      .spyOn(Copc, "loadHierarchyPage")
      .mockImplementation(async (_getter, page) => {
        loadedOffsets.push(page.pageOffset);

        if (page.pageOffset === 10) {
          return {
            nodes: {
              "0-0-0-0": createNode(100),
            },
            pages: {
              "1-0-0-0": { pageOffset: 30, pageLength: 40 },
              "1-1-0-0": { pageOffset: 90, pageLength: 10 },
            },
          };
        }

        if (page.pageOffset === 30) {
          return {
            nodes: {
              "1-0-0-0": createNode(50),
            },
            pages: {
              "2-0-0-0": { pageOffset: 70, pageLength: 80 },
            },
          };
        }

        if (page.pageOffset === 90) {
          return {
            nodes: {
              "1-1-0-0": createNode(40),
            },
            pages: {},
          };
        }

        return {
          nodes: {
            "2-0-0-0": createNode(25),
          },
          pages: {},
        };
      });

    try {
      const result = await source.loadHierarchyPages([
        "1-0-0-0",
        "2-0-0-0",
        "1-1-0-0",
      ]);

      expect(result.loadedPageKeys).toEqual([
        "1-0-0-0",
        "2-0-0-0",
        "1-1-0-0",
      ]);
      expect(result.hierarchy.nodes.map(({ key }) => key)).toEqual([
        "0-0-0-0",
        "1-0-0-0",
        "1-1-0-0",
        "2-0-0-0",
      ]);
      expect(loadedOffsets).toEqual([10, 30, 70, 90]);
      expect(source.getHierarchyPageLoadStats()).toEqual(
        expect.objectContaining({
          batchLoadCount: 2,
          lastBatchRequestedPageCount: 2,
          maxBatchRequestedPageCount: 2,
        }),
      );
    } finally {
      pageSpy.mockRestore();
    }
  });

  it("throws for an unavailable requested hierarchy page only after earlier valid pages load", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz");
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
    };
    const loadedOffsets: number[] = [];

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    const pageSpy = vi
      .spyOn(Copc, "loadHierarchyPage")
      .mockImplementation(async (_getter, page) => {
        loadedOffsets.push(page.pageOffset);

        if (page.pageOffset === 10) {
          return {
            nodes: {
              "0-0-0-0": createNode(100),
            },
            pages: {
              "1-0-0-0": { pageOffset: 30, pageLength: 40 },
            },
          };
        }

        return {
          nodes: {
            "1-0-0-0": createNode(50),
          },
          pages: {},
        };
      });

    try {
      await expect(
        source.loadHierarchyPages(["1-0-0-0", "2-0-0-0"]),
      ).rejects.toThrow("COPC hierarchy page was not found: 2-0-0-0");

      expect(loadedOffsets).toEqual([10, 30]);
      await expect(source.loadHierarchySummary()).resolves.toMatchObject({
        nodes: expect.arrayContaining([
          expect.objectContaining({ key: "1-0-0-0" }),
        ]),
      });
    } finally {
      pageSpy.mockRestore();
    }
  });

  it("normalizes reverse-completed hierarchy batch eviction to serial input-order LRU", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      maxCachedHierarchyPages: 2,
      maxConcurrentHierarchyPageLoads: 2,
    });
    const firstPage = createDeferred<Hierarchy.Subtree>();
    const secondPage = createDeferred<Hierarchy.Subtree>();
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    const pageSpy = vi
      .spyOn(Copc, "loadHierarchyPage")
      .mockImplementation(async (_getter, page) => {
        if (page.pageOffset === 10) {
          return {
            nodes: {
              "0-0-0-0": createNode(100),
            },
            pages: {
              "1-0-0-0": { pageOffset: 30, pageLength: 40 },
              "1-1-0-0": { pageOffset: 90, pageLength: 10 },
            },
          };
        }

        if (page.pageOffset === 30) {
          return firstPage.promise;
        }

        return secondPage.promise;
      });

    try {
      const resultPromise = source.loadHierarchyPages([
        "1-0-0-0",
        "1-1-0-0",
      ]);

      await waitForValue(
        () => source.getHierarchyPageLoadStats().activeLoadCount,
        2,
      );
      secondPage.resolve({
        nodes: {
          "1-1-0-0": createNode(40),
        },
        pages: {},
      });
      firstPage.resolve({
        nodes: {
          "1-0-0-0": createNode(50),
        },
        pages: {},
      });

      const result = await resultPromise;

      expect(result.hierarchy.nodes.map(({ key }) => key)).toEqual([
        "0-0-0-0",
        "1-1-0-0",
      ]);
      expect(result.hierarchy.pendingPages).toEqual([
        expect.objectContaining({
          key: "1-0-0-0",
          sourceHierarchyPageId: "10:20",
        }),
      ]);
      expect(source.getHierarchyCacheStats()).toEqual(
        expect.objectContaining({
          loadedPageCount: 2,
          cacheEvictionCount: 1,
          isOverLimit: false,
        }),
      );
    } finally {
      pageSpy.mockRestore();
    }
  });

  it("normalizes overlapping hierarchy batches by batch start order before eviction", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      maxCachedHierarchyPages: 3,
      maxConcurrentHierarchyPageLoads: 2,
    });
    const childPages = new Map<number, Deferred<Hierarchy.Subtree>>();
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    const pageSpy = vi
      .spyOn(Copc, "loadHierarchyPage")
      .mockImplementation(async (_getter, page) => {
        if (page.pageOffset === 10) {
          return {
            nodes: {
              "0-0-0-0": createNode(100),
            },
            pages: {
              "1-0-0-0": { pageOffset: 30, pageLength: 40 },
              "1-1-0-0": { pageOffset: 90, pageLength: 10 },
              "1-0-1-0": { pageOffset: 110, pageLength: 11 },
              "1-1-1-0": { pageOffset: 130, pageLength: 13 },
            },
          };
        }

        const deferred = createDeferred<Hierarchy.Subtree>();

        childPages.set(page.pageOffset, deferred);
        return deferred.promise;
      });

    try {
      await source.loadHierarchySummary();
      const firstBatch = source.loadHierarchyPages([
        "1-0-0-0",
        "1-1-0-0",
      ]);
      const secondBatch = source.loadHierarchyPages([
        "1-0-1-0",
        "1-1-1-0",
      ]);

      await waitForValue(() => childPages.size, 4);

      for (const pageOffset of [110, 130, 90, 30]) {
        childPages.get(pageOffset)?.resolve({
          nodes: {
            [pageOffsetToNodeKey(pageOffset)]: createNode(pageOffset),
          },
          pages: {},
        });
      }

      await Promise.all([firstBatch, secondBatch]);
      const finalHierarchy = await source.loadHierarchySummary();

      expect(finalHierarchy.nodes.map(({ key }) => key)).toEqual([
        "0-0-0-0",
        "1-0-1-0",
        "1-1-1-0",
      ]);
      expect(finalHierarchy.pendingPages.map(({ key }) => key)).toEqual([
        "1-0-0-0",
        "1-1-0-0",
      ]);
      expect(source.getHierarchyCacheStats()).toEqual(
        expect.objectContaining({
          loadedPageCount: 3,
          cacheEvictionCount: 2,
          isOverLimit: false,
        }),
      );
    } finally {
      pageSpy.mockRestore();
    }
  });

  it("keeps successful parallel hierarchy pages and retries failed pages without launching later work", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      maxConcurrentHierarchyPageLoads: 2,
    });
    const firstPage = createDeferred<Hierarchy.Subtree>();
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
    };
    const pageAttempts = new Map<number, number>();

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    const pageSpy = vi
      .spyOn(Copc, "loadHierarchyPage")
      .mockImplementation(async (_getter, page) => {
        pageAttempts.set(
          page.pageOffset,
          (pageAttempts.get(page.pageOffset) ?? 0) + 1,
        );

        if (page.pageOffset === 10) {
          return {
            nodes: {
              "0-0-0-0": createNode(100),
            },
            pages: {
              "1-0-0-0": { pageOffset: 30, pageLength: 40 },
              "1-1-0-0": { pageOffset: 90, pageLength: 10 },
              "1-0-1-0": { pageOffset: 110, pageLength: 11 },
            },
          };
        }

        if (page.pageOffset === 30) {
          return firstPage.promise;
        }

        if (
          page.pageOffset === 90 &&
          (pageAttempts.get(page.pageOffset) ?? 0) === 1
        ) {
          throw new Error("child page failed");
        }

        return {
          nodes: {
            [pageOffsetToNodeKey(page.pageOffset)]: createNode(page.pageOffset),
          },
          pages: {},
        };
      });

    try {
      const rejectedBatch = expect(
        source.loadHierarchyPages([
          "1-0-0-0",
          "1-1-0-0",
          "1-0-1-0",
        ]),
      ).rejects.toThrow("child page failed");

      await waitForValue(() => pageAttempts.get(90) ?? 0, 1);
      firstPage.resolve({
        nodes: {
          "1-0-0-0": createNode(50),
        },
        pages: {},
      });
      await rejectedBatch;

      const afterFailure = await source.loadHierarchySummary();

      expect(afterFailure.nodes.map(({ key }) => key)).toEqual([
        "0-0-0-0",
        "1-0-0-0",
      ]);
      expect(afterFailure.pendingPages.map(({ key }) => key)).toEqual([
        "1-1-0-0",
        "1-0-1-0",
      ]);
      expect(pageAttempts.get(110)).toBeUndefined();
      expect(source.getHierarchyPageLoadStats()).toEqual(
        expect.objectContaining({
          loadCount: 3,
          completedLoadCount: 2,
          failedLoadCount: 1,
          activeLoadCount: 0,
          batchLoadCount: 1,
          lastBatchRequestedPageCount: 3,
          maxBatchRequestedPageCount: 3,
        }),
      );

      await expect(
        source.loadHierarchyPages(["1-1-0-0", "1-0-1-0"]),
      ).resolves.toMatchObject({
        loadedPageKeys: ["1-1-0-0", "1-0-1-0"],
      });
      expect(pageAttempts.get(90)).toBe(2);
      expect(pageAttempts.get(110)).toBe(1);
      expect(source.getHierarchyPageLoadStats()).toEqual(
        expect.objectContaining({
          loadCount: 5,
          completedLoadCount: 4,
          failedLoadCount: 1,
          activeLoadCount: 0,
          batchLoadCount: 2,
          lastBatchRequestedPageCount: 2,
          maxBatchRequestedPageCount: 3,
        }),
      );
    } finally {
      pageSpy.mockRestore();
    }
  });

  it("preserves a hierarchy batch load error when final cleanup also fails", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      maxConcurrentHierarchyPageLoads: 1,
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchy: () => Promise<Hierarchy.Subtree>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    const pageSpy = vi
      .spyOn(Copc, "loadHierarchyPage")
      .mockImplementation(async (_getter, page) => {
        if (page.pageOffset === 10) {
          return {
            nodes: {
              "0-0-0-0": createNode(100),
            },
            pages: {
              "1-0-0-0": { pageOffset: 30, pageLength: 40 },
            },
          };
        }

        mutableSource.loadHierarchy = async () => {
          throw new Error("cleanup failed");
        };
        throw new Error("child page failed");
      });

    try {
      await expect(source.loadHierarchyPages(["1-0-0-0"])).rejects.toThrow(
        "child page failed",
      );
      expect(source.getHierarchyPageLoadStats()).toEqual(
        expect.objectContaining({
          failedLoadCount: 1,
          activeLoadCount: 0,
        }),
      );
    } finally {
      pageSpy.mockRestore();
    }
  });

  it("releases batch eviction hold and restores hierarchy cache limits after failure", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      maxCachedHierarchyPages: 1,
      maxConcurrentHierarchyPageLoads: 2,
    });
    const firstPage = createDeferred<Hierarchy.Subtree>();
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    const pageSpy = vi
      .spyOn(Copc, "loadHierarchyPage")
      .mockImplementation(async (_getter, page) => {
        if (page.pageOffset === 10) {
          return {
            nodes: {
              "0-0-0-0": createNode(100),
            },
            pages: {
              "1-0-0-0": { pageOffset: 30, pageLength: 40 },
              "1-1-0-0": { pageOffset: 90, pageLength: 10 },
            },
          };
        }

        if (page.pageOffset === 30) {
          return firstPage.promise;
        }

        throw new Error("child page failed");
      });

    try {
      const rejectedBatch = expect(
        source.loadHierarchyPages(["1-0-0-0", "1-1-0-0"]),
      ).rejects.toThrow("child page failed");

      await waitForValue(
        () => source.getHierarchyPageLoadStats().activeLoadCount,
        1,
      );
      firstPage.resolve({
        nodes: {
          "1-0-0-0": createNode(50),
        },
        pages: {},
      });
      await rejectedBatch;

      expect(source.getHierarchyCacheStats()).toEqual(
        expect.objectContaining({
          loadedPageCount: 1,
          cacheEvictionCount: 1,
          isOverLimit: false,
        }),
      );
      await expect(source.loadHierarchySummary()).resolves.toMatchObject({
        pendingPages: expect.arrayContaining([
          expect.objectContaining({ key: "1-0-0-0" }),
          expect.objectContaining({ key: "1-1-0-0" }),
        ]),
      });
    } finally {
      pageSpy.mockRestore();
    }
  });

  it("counts shared hierarchy task reuse separately from raw page promise reuse", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz");
    const childPage = createDeferred<Hierarchy.Subtree>();
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
    };
    let childPageLoadCount = 0;

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    const pageSpy = vi
      .spyOn(Copc, "loadHierarchyPage")
      .mockImplementation(async (_getter, page) => {
        if (page.pageOffset === 10) {
          return {
            nodes: {
              "0-0-0-0": createNode(100),
            },
            pages: {
              "1-0-0-0": { pageOffset: 30, pageLength: 40 },
            },
          };
        }

        childPageLoadCount += 1;
        return childPage.promise;
      });

    try {
      await source.loadHierarchySummary();
      const firstLoad = source.loadHierarchyPages(["1-0-0-0"]);
      const secondLoad = source.loadHierarchyPages(["1-0-0-0"]);
      await waitForValue(() => childPageLoadCount, 1);

      childPage.resolve({
        nodes: {
          "1-0-0-0": createNode(50),
        },
        pages: {},
      });
      await Promise.all([firstLoad, secondLoad]);

      expect(childPageLoadCount).toBe(1);
      expect(source.getHierarchyPageLoadStats()).toEqual(
        expect.objectContaining({
          loadCount: 2,
          cacheHitCount: 0,
          sharedTaskReuseCount: 1,
          completedLoadCount: 2,
          activeLoadCount: 0,
          batchLoadCount: 2,
          lastBatchRequestedPageCount: 1,
          maxBatchRequestedPageCount: 1,
        }),
      );
    } finally {
      pageSpy.mockRestore();
    }
  });

  it("merges concurrent hierarchy page waiters once and preserves eviction ancestry", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      maxCachedHierarchyPages: 3,
    });
    const deepPage = createDeferred<Hierarchy.Subtree>();
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
    };
    let deepPageLoadCount = 0;

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    const pageSpy = vi
      .spyOn(Copc, "loadHierarchyPage")
      .mockImplementation(async (_getter, page) => {
        if (page.pageOffset === 10) {
          return {
            nodes: {
              "0-0-0-0": createNode(100),
            },
            pages: {
              "1-0-0-0": { pageOffset: 30, pageLength: 40 },
              "1-1-0-0": { pageOffset: 90, pageLength: 10 },
            },
          };
        }

        if (page.pageOffset === 30) {
          return {
            nodes: {
              "1-0-0-0": createNode(50),
            },
            pages: {
              "2-0-0-0": { pageOffset: 70, pageLength: 80 },
            },
          };
        }

        if (page.pageOffset === 70) {
          deepPageLoadCount += 1;
          return deepPage.promise;
        }

        return {
          nodes: {
            "1-1-0-0": createNode(40),
          },
          pages: {},
        };
      });

    try {
      await source.loadHierarchySummary();
      await source.loadHierarchyPage("1-0-0-0");
      const firstLoad = source.loadHierarchyPage("2-0-0-0");
      const secondLoad = source.loadHierarchyPage("2-0-0-0");
      await waitForValue(() => deepPageLoadCount, 1);

      deepPage.resolve({
        nodes: {
          "2-0-0-0": createNode(25),
        },
        pages: {},
      });
      await Promise.all([firstLoad, secondLoad]);

      expect(deepPageLoadCount).toBe(1);

      const hierarchy = await source.loadHierarchyPage("1-1-0-0");

      expect(hierarchy.nodes.map(({ key }) => key)).toEqual([
        "0-0-0-0",
        "1-0-0-0",
        "1-1-0-0",
      ]);
      expect(hierarchy.pendingPages.map(({ key }) => key)).toEqual([
        "2-0-0-0",
      ]);
      expect(hierarchy.pendingPages[0]?.sourceHierarchyPageId).toBe("30:40");
      expect(source.getHierarchyCacheStats()).toEqual(
        expect.objectContaining({
          loadedPageCount: 3,
          cacheEvictionCount: 1,
          isOverLimit: false,
        }),
      );
    } finally {
      pageSpy.mockRestore();
    }
  });

  it("keeps a shared hierarchy merge alive when only one waiter aborts", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz");
    const childPage = createDeferred<Hierarchy.Subtree>();
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
    };
    let childPageLoadCount = 0;

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    const pageSpy = vi
      .spyOn(Copc, "loadHierarchyPage")
      .mockImplementation(async (_getter, page) => {
        if (page.pageOffset === 10) {
          return {
            nodes: {
              "0-0-0-0": createNode(100),
            },
            pages: {
              "1-0-0-0": { pageOffset: 30, pageLength: 40 },
            },
          };
        }

        childPageLoadCount += 1;
        return childPage.promise;
      });

    try {
      await source.loadHierarchySummary();
      const abortController = new AbortController();
      const abortedLoad = source.loadHierarchyPage("1-0-0-0", {
        signal: abortController.signal,
      });
      const activeLoad = source.loadHierarchyPage("1-0-0-0");
      await waitForValue(() => childPageLoadCount, 1);

      abortController.abort();
      await expect(abortedLoad).rejects.toMatchObject({ name: "AbortError" });

      childPage.resolve({
        nodes: {
          "1-0-0-0": createNode(50),
        },
        pages: {
          "2-0-0-0": { pageOffset: 70, pageLength: 80 },
        },
      });

      const hierarchy = await activeLoad;

      expect(childPageLoadCount).toBe(1);
      expect(hierarchy.nodes.map(({ key }) => key)).toEqual([
        "0-0-0-0",
        "1-0-0-0",
      ]);
      expect(hierarchy.pendingPages).toEqual([
        expect.objectContaining({
          key: "2-0-0-0",
          sourceHierarchyPageId: "30:40",
        }),
      ]);
    } finally {
      pageSpy.mockRestore();
    }
  });

  it("retries metadata and root hierarchy loads after a rejected shared promise", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz");
    const copc = {
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData;
    const createSpy = vi
      .spyOn(Copc, "create")
      .mockRejectedValueOnce(new Error("metadata failed"))
      .mockResolvedValueOnce(copc);
    const pageSpy = vi.spyOn(Copc, "loadHierarchyPage").mockResolvedValue({
      nodes: {
        "0-0-0-0": createNode(100),
      },
      pages: {},
    });

    try {
      await expect(source.loadHierarchySummary()).rejects.toThrow(
        "metadata failed",
      );
      expect(source.getLoadedCopcMetadata()).toBeUndefined();
      await expect(source.loadHierarchySummary()).resolves.toMatchObject({
        loadedPageCount: 1,
        pendingPageCount: 0,
      });
      expect(source.getLoadedCopcMetadata()).toBe(copc);
      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(pageSpy).toHaveBeenCalledTimes(1);
    } finally {
      createSpy.mockRestore();
      pageSpy.mockRestore();
    }
  });

  it("retries a rejected hierarchy page without losing the pending page", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz");
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
    };
    let childPageAttemptCount = 0;

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    const pageSpy = vi
      .spyOn(Copc, "loadHierarchyPage")
      .mockImplementation(async (_getter, page) => {
        if (page.pageOffset === 10) {
          return {
            nodes: {
              "0-0-0-0": createNode(100),
            },
            pages: {
              "1-0-0-0": { pageOffset: 30, pageLength: 40 },
            },
          };
        }

        childPageAttemptCount += 1;

        if (childPageAttemptCount === 1) {
          throw new Error("child page failed");
        }

        return {
          nodes: {
            "1-0-0-0": createNode(50),
          },
          pages: {},
        };
      });

    try {
      await source.loadHierarchySummary();
      await expect(source.loadHierarchyPage("1-0-0-0")).rejects.toThrow(
        "child page failed",
      );
      const afterFailure = await source.loadHierarchySummary();

      expect(afterFailure.nodes.map(({ key }) => key)).toEqual(["0-0-0-0"]);
      expect(afterFailure.pendingPages.map(({ key }) => key)).toEqual([
        "1-0-0-0",
      ]);

      await expect(source.loadHierarchyPage("1-0-0-0")).resolves.toMatchObject({
        loadedPageCount: 2,
        pendingPageCount: 0,
      });
      expect(childPageAttemptCount).toBe(2);
      expect(pageSpy).toHaveBeenCalledTimes(3);
    } finally {
      pageSpy.mockRestore();
    }
  });

  it("loads and merges additional hierarchy pages on demand", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz");
    const loadedPageOffsets: number[] = [];
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async (page) => {
      loadedPageOffsets.push(page.pageOffset);

      if (page.pageOffset === 10) {
        return {
          nodes: {
            "0-0-0-0": createNode(100),
          },
          pages: {
            "1-0-0-0": { pageOffset: 30, pageLength: 40 },
          },
        };
      }

      return {
        nodes: {
          "1-0-0-0": createNode(50),
          "2-0-0-0": createNode(25),
        },
        pages: {
          "2-1-0-0": { pageOffset: 70, pageLength: 80 },
        },
      };
    };

    const rootHierarchy = await source.loadHierarchySummary();

    expect(rootHierarchy.nodes.map((node) => node.key)).toEqual(["0-0-0-0"]);
    expect(rootHierarchy.nodes[0]?.sourceHierarchyPageId).toBe("10:20");
    expect(rootHierarchy.loadedPageCount).toBe(1);
    expect(rootHierarchy.pendingPageCount).toBe(1);
    expect(rootHierarchy.pageCount).toBe(1);
    expect(rootHierarchy.pendingPages).toEqual([
      expect.objectContaining({
        key: "1-0-0-0",
        depth: 1,
        x: 0,
        y: 0,
        z: 0,
        bounds: {
          minX: 0,
          minY: 0,
          minZ: 0,
          maxX: 4,
          maxY: 4,
          maxZ: 4,
        },
        pageOffset: 30,
        pageLength: 40,
        sourceHierarchyPageId: "10:20",
      }),
    ]);
    expect(source.getHierarchyCacheStats()).toEqual({
      loadedPageCount: 1,
      maxCachedPageCount: 64,
      loadedPageBytes: 20,
      maxCachedPageBytes: 16_777_216,
      pendingPageCount: 1,
      trackedNodeCount: 1,
      trackedPendingPageCount: 1,
      cacheEvictionCount: 0,
      isOverLimit: false,
    });

    const expandedHierarchy = await source.loadHierarchyPage("1-0-0-0");

    expect(loadedPageOffsets).toEqual([10, 30]);
    expect(expandedHierarchy.nodes.map((node) => node.key)).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "2-0-0-0",
    ]);
    expect(
      expandedHierarchy.nodes.map((node) => [
        node.key,
        node.sourceHierarchyPageId,
      ]),
    ).toEqual([
      ["0-0-0-0", "10:20"],
      ["1-0-0-0", "30:40"],
      ["2-0-0-0", "30:40"],
    ]);
    expect(expandedHierarchy.loadedPageCount).toBe(2);
    expect(expandedHierarchy.pendingPageCount).toBe(1);
    expect(expandedHierarchy.pendingPages).toEqual([
      expect.objectContaining({
        key: "2-1-0-0",
        depth: 2,
        x: 1,
        y: 0,
        z: 0,
        bounds: {
          minX: 2,
          minY: 0,
          minZ: 0,
          maxX: 4,
          maxY: 2,
          maxZ: 2,
        },
        pageOffset: 70,
        pageLength: 80,
        sourceHierarchyPageId: "30:40",
      }),
    ]);
    expect(source.getHierarchyCacheStats()).toEqual({
      loadedPageCount: 2,
      maxCachedPageCount: 64,
      loadedPageBytes: 60,
      maxCachedPageBytes: 16_777_216,
      pendingPageCount: 1,
      trackedNodeCount: 3,
      trackedPendingPageCount: 1,
      cacheEvictionCount: 0,
      isOverLimit: false,
    });
  });

  it("evicts loaded hierarchy pages back to pending pages when the page limit is reached", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      maxCachedHierarchyPages: 1,
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async (page) => {
      if (page.pageOffset === 10) {
        return {
          nodes: {
            "0-0-0-0": createNode(100),
          },
          pages: {
            "1-0-0-0": { pageOffset: 30, pageLength: 40 },
          },
        };
      }

      return {
        nodes: {
          "1-0-0-0": createNode(50),
        },
        pages: {},
      };
    };

    const hierarchy = await source.loadHierarchyPage("1-0-0-0");

    expect(hierarchy.nodes.map((node) => node.key)).toEqual(["0-0-0-0"]);
    expect(hierarchy.pendingPages).toEqual([
      expect.objectContaining({
        key: "1-0-0-0",
        pageOffset: 30,
        pageLength: 40,
        sourceHierarchyPageId: "10:20",
      }),
    ]);
    expect(source.getHierarchyCacheStats()).toEqual({
      loadedPageCount: 1,
      maxCachedPageCount: 1,
      loadedPageBytes: 20,
      maxCachedPageBytes: 16_777_216,
      pendingPageCount: 1,
      trackedNodeCount: 1,
      trackedPendingPageCount: 1,
      cacheEvictionCount: 1,
      isOverLimit: false,
    });
  });

  it("evicts loaded hierarchy pages back to pending pages when the byte limit is reached", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      maxCachedHierarchyPages: 10,
      maxCachedHierarchyPageBytes: 50,
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async (page) => {
      if (page.pageOffset === 10) {
        return {
          nodes: {
            "0-0-0-0": createNode(100),
          },
          pages: {
            "1-0-0-0": { pageOffset: 30, pageLength: 40 },
          },
        };
      }

      return {
        nodes: {
          "1-0-0-0": createNode(50),
        },
        pages: {},
      };
    };

    const hierarchy = await source.loadHierarchyPage("1-0-0-0");

    expect(hierarchy.nodes.map((node) => node.key)).toEqual(["0-0-0-0"]);
    expect(hierarchy.pendingPages).toEqual([
      expect.objectContaining({
        key: "1-0-0-0",
        pageOffset: 30,
        pageLength: 40,
        sourceHierarchyPageId: "10:20",
      }),
    ]);
    expect(source.getHierarchyCacheStats()).toEqual({
      loadedPageCount: 1,
      maxCachedPageCount: 10,
      loadedPageBytes: 20,
      maxCachedPageBytes: 50,
      pendingPageCount: 1,
      trackedNodeCount: 1,
      trackedPendingPageCount: 1,
      cacheEvictionCount: 1,
      isOverLimit: false,
    });
  });

  it("evicts loaded leaf hierarchy pages before their loaded parents", async () => {
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      maxCachedHierarchyPages: 2,
    });
    const mutableSource = source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };

    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 8, 8, 8],
        rootHierarchyPage: { pageOffset: 10, pageLength: 20 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async (page) => {
      if (page.pageOffset === 10) {
        return {
          nodes: {
            "0-0-0-0": createNode(100),
          },
          pages: {
            "1-0-0-0": { pageOffset: 30, pageLength: 40 },
            "1-1-0-0": { pageOffset: 90, pageLength: 10 },
          },
        };
      }

      if (page.pageOffset === 30) {
        return {
          nodes: {
            "1-0-0-0": createNode(50),
          },
          pages: {
            "2-0-0-0": { pageOffset: 70, pageLength: 80 },
          },
        };
      }

      return {
        nodes: {
          "2-0-0-0": createNode(25),
        },
        pages: {},
      };
    };

    await source.loadHierarchyPage("1-0-0-0");
    const hierarchy = await source.loadHierarchyPage("2-0-0-0");

    expect(hierarchy.nodes.map((node) => node.key)).toEqual([
      "0-0-0-0",
      "1-0-0-0",
    ]);
    expect(hierarchy.pendingPages.map((page) => page.key)).toEqual([
      "1-1-0-0",
      "2-0-0-0",
    ]);
    expect(
      hierarchy.pendingPages.map((page) => [
        page.key,
        page.sourceHierarchyPageId,
      ]),
    ).toEqual([
      ["1-1-0-0", "10:20"],
      ["2-0-0-0", "30:40"],
    ]);
    expect(source.getHierarchyCacheStats()).toEqual({
      loadedPageCount: 2,
      maxCachedPageCount: 2,
      loadedPageBytes: 60,
      maxCachedPageBytes: 16_777_216,
      pendingPageCount: 2,
      trackedNodeCount: 2,
      trackedPendingPageCount: 2,
      cacheEvictionCount: 1,
      isOverLimit: false,
    });
  });
});

function createNode(pointCount: number): Hierarchy.Node {
  return {
    pointCount,
    pointDataOffset: pointCount,
    pointDataLength: pointCount * 10,
  };
}

function createSamplePoints(
  pointCount: number,
): CopcNodePointSampleResult["points"] {
  return Array.from({ length: pointCount }, (_, index) => ({
    x: index,
    y: index,
    z: index,
    color: {
      red: 1,
      green: 2,
      blue: 3,
    },
  }));
}

function pageOffsetToNodeKey(pageOffset: number): string {
  switch (pageOffset) {
    case 30:
      return "1-0-0-0";
    case 90:
      return "1-1-0-0";
    case 110:
      return "1-0-1-0";
    case 130:
      return "1-1-1-0";
    case 150:
      return "1-0-0-1";
    default:
      throw new Error(`Unexpected test page offset: ${pageOffset}`);
  }
}

function isLoadRequest(
  request: CopcPointSampleWorkerRequest,
): request is CopcPointSampleWorkerLoadRequest {
  return request.type === "loadNodePointSamples";
}

function createWorkerSuccessResponse(
  request: CopcPointSampleWorkerLoadRequest,
  cache?: CopcDecodedPointDataCacheSnapshot,
): CopcPointSampleWorkerResponse {
  return {
    id: request.id,
    type: "loadNodePointSamples:success",
    result: {
      nodeKey: request.nodeKey,
      nodePointCount: request.node.pointCount,
      sampledPointCount: 1,
      points: [{ x: request.id, y: request.id, z: request.id }],
    },
    cache,
  };
}

function createWorkerSuccessResponseWithPointCount(
  request: CopcPointSampleWorkerLoadRequest,
  pointCount: number,
): CopcPointSampleWorkerResponse {
  return {
    id: request.id,
    type: "loadNodePointSamples:success",
    result: {
      nodeKey: request.nodeKey,
      nodePointCount: request.node.pointCount,
      sampledPointCount: pointCount,
      points: createSamplePoints(pointCount),
    },
  };
}

function createDecodedPointDataCacheSnapshot(
  overrides: Partial<CopcDecodedPointDataCacheSnapshot> = {},
): CopcDecodedPointDataCacheSnapshot {
  return {
    retainedViewCount: 0,
    retainedBytes: 0,
    peakRetainedBytes: 0,
    cacheHitCount: 0,
    cacheMissCount: 0,
    cacheEvictionCount: 0,
    oversizedEntrySkipCount: 0,
    requestedNodeRetained: false,
    evictedNodeKeys: [],
    ...overrides,
  };
}

class FakePointSampleWorker {
  readonly requests: CopcPointSampleWorkerRequest[] = [];
  terminateCount = 0;
  private messageListener:
    | ((event: MessageEvent<CopcPointSampleWorkerResponse>) => void)
    | undefined;

  constructor(
    private readonly respond?: (
      request: CopcPointSampleWorkerLoadRequest,
    ) => CopcPointSampleWorkerResponse,
  ) {}

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (type !== "message" || typeof listener !== "function") {
      return;
    }

    this.messageListener = listener as (
      event: MessageEvent<CopcPointSampleWorkerResponse>,
    ) => void;
  }

  postMessage(message: CopcPointSampleWorkerRequest): void {
    this.requests.push(message);
    if (message.type === "cancel") {
      return;
    }

    const response = this.respond?.(message);
    if (!response) {
      return;
    }

    queueMicrotask(() => {
      this.emit(response);
    });
  }

  emit(response: CopcPointSampleWorkerResponse): void {
    this.messageListener?.({
      data: response,
    } as MessageEvent<CopcPointSampleWorkerResponse>);
  }

  terminate(): void {
    this.terminateCount += 1;
    this.messageListener = undefined;
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

async function waitForWorkerRequestCount(
  worker: FakePointSampleWorker,
  requestCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (worker.requests.length >= requestCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Timed out waiting for ${requestCount} worker requests.`);
}

async function waitForAsyncPointSampleScheduling(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForWorkerLoadRequestCount(
  worker: FakePointSampleWorker,
  requestCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (worker.requests.filter(isLoadRequest).length >= requestCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(
    `Timed out waiting for ${requestCount} worker load requests.`,
  );
}

async function waitForWorkerPoolLoadRequestCount(
  workers: readonly FakePointSampleWorker[],
  requestCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const loadRequestCount = workers.reduce(
      (count, worker) => count + worker.requests.filter(isLoadRequest).length,
      0,
    );

    if (loadRequestCount >= requestCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(
    `Timed out waiting for ${requestCount} worker pool load requests.`,
  );
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

async function waitForValue(
  readValue: () => number,
  expectedValue: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (readValue() === expectedValue) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Timed out waiting for value ${expectedValue}.`);
}
