import { describe, expect, it } from "vitest";
import type { Copc as CopcData, Hierarchy } from "copc";
import { CopcSource } from "./CopcSource";
import type { CopcNodePointSampleResult } from "./CopcPointDataSample";

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
      }),
    ]);

    const expandedHierarchy = await source.loadHierarchyPage("1-0-0-0");

    expect(loadedPageOffsets).toEqual([10, 30]);
    expect(expandedHierarchy.nodes.map((node) => node.key)).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "2-0-0-0",
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
      }),
    ]);
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
