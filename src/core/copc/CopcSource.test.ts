import { describe, expect, it } from "vitest";
import type { Copc as CopcData, Hierarchy } from "copc";
import { CopcSource } from "./CopcSource";
import type { CopcNodePointSampleResult } from "./CopcPointDataSample";
import type {
  CopcPointSampleWorkerLoadRequest,
  CopcPointSampleWorkerRequest,
  CopcPointSampleWorkerResponse,
} from "./CopcPointSampleWorkerProtocol";

describe("CopcSource point sample cache", () => {
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
          maxConcurrentPointSampleWorkerRequests: 0,
        }),
    ).toThrow(
      "maxConcurrentPointSampleWorkerRequests must be a positive integer.",
    );

    expect(
      () =>
        new CopcSource("https://example.com/sample.copc.laz", {
          pointSampleLoading: "invalid",
        } as never),
    ).toThrow("pointSampleLoading must be either 'main-thread' or 'worker'.");
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
    }));
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

    const result = await source.loadNodePointSamples({
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
    });

    expect(worker.requests).toEqual([
      expect.objectContaining({
        url: "https://example.com/sample.copc.laz",
        nodeKey: "0-0-0-0",
        node: createNode(100),
        maxPointCount: 5,
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
  });

  it("limits concurrent worker point sample requests", async () => {
    const worker = new FakePointSampleWorker();
    const source = new CopcSource("https://example.com/sample.copc.laz", {
      pointSampleLoading: "worker",
      maxConcurrentPointSampleWorkerRequests: 2,
      createPointSampleWorker: () => worker as unknown as Worker,
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
    await waitForWorkerLoadRequestCount(worker, 2);
    expect(
      worker.requests.filter(isLoadRequest).map((request) => request.nodeKey),
    ).toEqual(["0-0-0-0", "1-0-0-0"]);

    const firstRequest = worker.requests.find(isLoadRequest);

    if (!firstRequest) {
      throw new Error("Expected first worker load request.");
    }

    worker.emit(createWorkerSuccessResponse(firstRequest));
    await waitForWorkerLoadRequestCount(worker, 3);

    const loadRequests = worker.requests.filter(isLoadRequest);
    expect(loadRequests.map((request) => request.nodeKey)).toEqual(nodeKeys);

    for (const request of loadRequests.slice(1)) {
      worker.emit(createWorkerSuccessResponse(request));
    }

    const result = await promise;
    expect(result.nodeKeys).toEqual(nodeKeys);
    expect(result.sampledPointCount).toBe(3);
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
    expect(worker.requests).toContainEqual({
      id: firstRequest.id,
      type: "cancel",
    });
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
    expect(worker.requests).toContainEqual({
      id: request.id,
      type: "cancel",
    });

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

function isLoadRequest(
  request: CopcPointSampleWorkerRequest,
): request is CopcPointSampleWorkerLoadRequest {
  return request.type === "loadNodePointSamples";
}

function createWorkerSuccessResponse(
  request: CopcPointSampleWorkerLoadRequest,
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
  };
}

class FakePointSampleWorker {
  readonly requests: CopcPointSampleWorkerRequest[] = [];
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
    this.messageListener = undefined;
  }
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
