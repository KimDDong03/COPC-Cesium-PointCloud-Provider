import { Cartesian3, Intersect, type Camera, type Scene } from "cesium";
import type { Copc as CopcData, Hierarchy } from "copc";
import { describe, expect, it } from "vitest";
import type {
  CopcHierarchySummary,
  CopcInspection,
  PointSample,
} from "../core";
import type { CopcNodePointSampleResult } from "../core/copc/CopcPointDataSample";
import { CopcPointCloudLayer } from "./CopcPointCloudLayer";
import type {
  CopcCoordinateTransformStatus,
  CopcToCesiumCoordinateTransform,
} from "./copcCoordinateTransform";
import type {
  CopcPointCloudBatchRenderer,
  CopcPointCloudGeometryBatchRenderer,
  CopcPointCloudRenderer,
  PointGeometryBatch,
  PointSampleBatch,
} from "./CopcPointCloudRenderer";
import type {
  CesiumPointGeometryWorkerRequest,
  CesiumPointGeometryWorkerResponse,
} from "./CesiumPointGeometryWorkerProtocol";
import type {
  CesiumCopcPointGeometryWorkerRequest,
  CesiumCopcPointGeometryWorkerResponse,
} from "./CesiumCopcPointGeometryWorkerProtocol";
import type {
  CopcPointSampleWorkerRequest,
  CopcPointSampleWorkerResponse,
} from "../core/copc/CopcPointSampleWorkerProtocol";

describe("CopcPointCloudLayer coordinate transforms", () => {
  it("passes the point sample cache limit to the owned COPC source", () => {
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      maxCachedHierarchyPages: 4,
      maxCachedHierarchyPageBytes: 2048,
      maxCachedSampleSets: 3,
      maxCachedPointSampleBytes: 1024,
      maxCachedPointGeometryBatches: 2,
      maxCachedTransformedPointGeometryBatches: 5,
    });

    expect(layer.source.getHierarchyCacheStats()).toEqual(
      expect.objectContaining({
        maxCachedPageCount: 4,
        maxCachedPageBytes: 2048,
      }),
    );
    expect(layer.source.getPointSampleCacheStats()).toEqual(
      expect.objectContaining({
        maxCachedSampleSetCount: 3,
        maxCachedPointSampleBytes: 1024,
      }),
    );
    expect(layer.getPointGeometryCacheStats()).toEqual(
      expect.objectContaining({
        maxCachedLoadedBatchCount: 2,
        maxCachedTransformedBatchCount: 5,
      }),
    );

    layer.destroy();
  });

  it("validates the point geometry cache limit options", () => {
    expect(
      () =>
        new CopcPointCloudLayer(createSceneStub(), {
          url: "https://example.com/sample.copc.laz",
          maxCachedPointGeometryBatches: 0,
        }),
    ).toThrow("maxCachedPointGeometryBatches");

    expect(
      () =>
        new CopcPointCloudLayer(createSceneStub(), {
          url: "https://example.com/sample.copc.laz",
          maxCachedTransformedPointGeometryBatches: 0,
        }),
    ).toThrow("maxCachedTransformedPointGeometryBatches");
  });

  it("passes the worker request concurrency option to the owned COPC source", () => {
    expect(
      () =>
        new CopcPointCloudLayer(createSceneStub(), {
          url: "https://example.com/sample.copc.laz",
          maxConcurrentPointSampleWorkerRequests: 0,
        }),
    ).toThrow("maxConcurrentPointSampleWorkerRequests");
  });

  it("warms the owned point sample workers before the first point request", () => {
    const workers: FakePointSampleWorker[] = [];
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      pointSampleLoading: "worker",
      maxConcurrentPointSampleWorkerRequests: 3,
      createPointSampleWorker: () => {
        const worker = new FakePointSampleWorker();
        workers.push(worker);

        return worker as unknown as Worker;
      },
    });

    expect(layer.warmUpPointSampleWorkers({ workerCount: 2 })).toBe(2);
    expect(workers).toHaveLength(2);
    expect(workers.flatMap((worker) => worker.requests)).toEqual([]);

    layer.destroy();
    expect(workers.map((worker) => worker.terminateCount)).toEqual([1, 1]);
  });

  it("resets streaming caches and worker pools without destroying the layer", () => {
    const pointSampleWorkers: FakePointSampleWorker[] = [];
    const geometryWorkers: FakeCopcPointGeometryWorker[] = [];
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      pointSampleLoading: "worker",
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointSampleWorkerRequests: 2,
      maxConcurrentPointGeometryWorkerRequests: 2,
      createPointSampleWorker: () => {
        const worker = new FakePointSampleWorker();
        pointSampleWorkers.push(worker);

        return worker as unknown as Worker;
      },
      createCopcPointGeometryWorker: () => {
        const worker = new FakeCopcPointGeometryWorker();
        geometryWorkers.push(worker);

        return worker as unknown as Worker;
      },
    });

    expect(layer.warmUpPointSampleWorkers({ workerCount: 2 })).toBe(2);
    layer.warmUpPointGeometryWorkers({ workerCount: 1 });

    expect(geometryWorkers[0]?.requests[0]).toMatchObject({
      type: "warmup",
      source: {
        key: "url:https://example.com/sample.copc.laz",
        input: "https://example.com/sample.copc.laz",
      },
    });

    const resetResult = layer.resetStreamingCaches();

    expect(resetResult).toEqual({
      pointSampleSetCount: 0,
      pointGeometryBatchCount: 0,
      pointSampleWorkerCount: 2,
      pointGeometryWorkerCount: 1,
    });
    expect(pointSampleWorkers.map((worker) => worker.terminateCount)).toEqual([
      1,
      1,
    ]);
    expect(geometryWorkers.map((worker) => worker.terminateCount)).toEqual([
      1,
      0,
    ]);
    expect(geometryWorkers[1]?.requests[0]).toMatchObject({
      type: "warmup",
      source: {
        key: "url:https://example.com/sample.copc.laz",
        input: "https://example.com/sample.copc.laz",
      },
    });

    expect(layer.warmUpPointSampleWorkers({ workerCount: 1 })).toBe(1);
    layer.warmUpPointGeometryWorkers({ workerCount: 1 });

    expect(pointSampleWorkers).toHaveLength(3);
    expect(geometryWorkers).toHaveLength(2);

    layer.destroy();
  });

  it("passes decoded worker cache limits to the owned point sample worker", async () => {
    const pointRendering = createRecordingPointRenderer();
    const pointSampleWorker = new FakePointSampleWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointSampleLoading: "worker",
      maxDecodedPointDataViewsPerWorker: 80,
      maxDecodedPointDataViewBytesPerWorker: 200 * 1024 * 1024,
      createPointSampleWorker: () => pointSampleWorker as unknown as Worker,
    });
    const mutableSource = layer.source as unknown as {
      copcPromise: Promise<CopcData>;
      loadHierarchyPageData: (
        page: Hierarchy.Page,
      ) => Promise<Hierarchy.Subtree>;
    };

    layer.source.inspect = async () => createInspection();
    mutableSource.copcPromise = Promise.resolve({
      info: {
        cube: [0, 0, 0, 1, 1, 1],
        rootHierarchyPage: { pageOffset: 0, pageLength: 1 },
      },
    } as CopcData);
    mutableSource.loadHierarchyPageData = async () => ({
      nodes: {
        "0-0-0-0": {
          pointCount: 1,
          pointDataOffset: 0,
          pointDataLength: 10,
        },
      },
      pages: {},
    });

    await layer.renderNode("0-0-0-0", { showBounds: false });

    expect(pointSampleWorker.requests).toEqual([
      expect.objectContaining({
        type: "loadNodePointSamples",
        maxDecodedPointDataViews: 80,
        maxDecodedPointDataViewBytes: 200 * 1024 * 1024,
      }),
    ]);
    expect(pointRendering.points).toHaveLength(1);
  });

  it("reports the default geographic transform status from load", async () => {
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
    });

    patchLayerSource(layer);

    const result = await layer.load();

    expect(result.coordinateTransform).toEqual({
      kind: "geographic",
      label: "Geographic coordinates",
      supportsCameraSelection: true,
    } satisfies CopcCoordinateTransformStatus);
    expect(layer.coordinateTransform).toEqual(result.coordinateTransform);
  });

  it("reports a custom transform status when no explicit status is provided", async () => {
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      coordinateTransforms: () => ({
        toCesium: (x, y, z) => ({
          longitudeDegrees: x,
          latitudeDegrees: y,
          heightMeters: z,
        }),
      }),
    });

    patchLayerSource(layer);

    const result = await layer.load();

    expect(result.coordinateTransform).toEqual({
      kind: "custom",
      label: "Custom coordinate transform",
      supportsCameraSelection: false,
    } satisfies CopcCoordinateTransformStatus);
  });

  it("applies the configured transform before sending points and bounds to renderers", async () => {
    const pointRendering = createRecordingPointRenderer();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      coordinateTransforms: () => ({
        toCesium: (x, y, z) => ({
          longitudeDegrees: x + 100,
          latitudeDegrees: y + 200,
          heightMeters: z + 300,
        }),
      }),
    });
    const boundsRendering = captureLayerBoundsRendering(layer);

    patchLayerSource(layer);

    const result = await layer.renderNode("0-0-0-0");

    expect(result.points).toEqual([
      {
        longitudeDegrees: 101,
        latitudeDegrees: 202,
        heightMeters: 303,
        color: {
          red: 10,
          green: 20,
          blue: 30,
        },
      },
    ]);
    expect(pointRendering.points).toEqual(result.points);
    expect(result.renderStats.pointCount).toBe(1);
    expect(result.renderStats.estimatedRenderPayloadBytes).toBe(28);
    expect(result.renderStats.coordinateTransformMilliseconds).toBeGreaterThanOrEqual(
      0,
    );
    expect(result.renderStats.rendererSetPointsMilliseconds).toBeGreaterThanOrEqual(
      0,
    );
    expect(result.renderStats.boundsRenderMilliseconds).toBeGreaterThanOrEqual(
      0,
    );
    expect(result.renderStats.totalRenderMilliseconds).toBeGreaterThanOrEqual(
      result.renderStats.rendererSetPointsMilliseconds,
    );
    expect(boundsRendering.boundsCoordinate).toEqual({
      longitudeDegrees: 100,
      latitudeDegrees: 200,
      heightMeters: 300,
    });

    layer.clear();
    layer.destroy();

    expect(pointRendering.clearCount).toBe(1);
    expect(pointRendering.destroyCount).toBe(1);
  });
});

describe("CopcPointCloudLayer hierarchy loading", () => {
  it("keeps load results in sync after loading another hierarchy page", async () => {
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
    });
    const expandedHierarchy = createHierarchy([
      createHierarchyNode("0-0-0-0"),
      createHierarchyNode("1-0-0-0"),
    ]);

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([createHierarchyNode("0-0-0-0")]);
    layer.source.loadNextHierarchyPage = async () => expandedHierarchy;

    await layer.load();
    const hierarchy = await layer.loadNextHierarchyPage();
    const loadResult = await layer.load();

    expect(hierarchy).toBe(expandedHierarchy);
    expect(layer.hierarchy).toBe(expandedHierarchy);
    expect(loadResult.hierarchy).toBe(expandedHierarchy);
  });

  it("passes the rendered point budget to multi-node point sampling", async () => {
    const pointRendering = createRecordingPointRenderer();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
    });
    let capturedOptions:
      | Parameters<typeof layer.source.loadNodesPointSamples>[0]
      | undefined;

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
      ]);
    layer.source.loadNodesPointSamples = async (options) => {
      capturedOptions = options;

      return {
        nodeKeys: options.nodeKeys,
        nodeResults: [],
        nodePointCount: 0,
        sampledPointCount: 0,
        points: [],
      };
    };

    await layer.renderNodes(["0-0-0-0", "1-0-0-0"], {
      maxPointCountPerNode: 5,
      maxRenderedPointCount: 7,
      showBounds: false,
    });

    expect(capturedOptions).toEqual({
      nodeKeys: ["0-0-0-0", "1-0-0-0"],
      maxPointCountPerNode: 5,
      maxTotalSampledPointCount: 7,
      sampleFormat: "objects",
      signal: undefined,
    });
  });

  it("renders supplied node sample results without loading point samples", async () => {
    const pointRendering = createRecordingPointRenderer();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([createHierarchyNode("0-0-0-0")]);
    layer.source.loadNodePointSamples = async () => {
      throw new Error("Should not load point samples.");
    };

    const result = await layer.renderNodeSampleResults(
      [createNodePointSampleResult("0-0-0-0", 1)],
      { showBounds: false },
    );

    expect(result.pointSamples.nodeKeys).toEqual(["0-0-0-0"]);
    expect(pointRendering.points).toHaveLength(1);
  });

  it("distributes supplied node sample results across the rendered point budget", async () => {
    const pointRendering = createRecordingPointRenderer();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
      ]);

    const result = await layer.renderNodeSampleResults(
      [
        createNodePointSampleResultWithCount("0-0-0-0", 0, 5),
        createNodePointSampleResultWithCount("1-0-0-0", 10, 5),
      ],
      {
        maxPointCountPerNode: 4,
        maxRenderedPointCount: 6,
        showBounds: false,
      },
    );

    expect(result.pointSamples.sampledPointCount).toBe(6);
    expect(result.pointSamples.nodeResults.map((node) => node.sampledPointCount))
      .toEqual([3, 3]);
    expect(pointRendering.points.map((point) => point.longitudeDegrees))
      .toEqual([0, 1, 2, 10, 11, 12]);
  });

  it("passes supplied node sample results as renderer batches when supported", async () => {
    const pointRendering = createRecordingBatchPointRenderer();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
      ]);

    const result = await layer.renderNodeSampleResults(
      [
        createNodePointSampleResult("0-0-0-0", 1),
        createNodePointSampleResult("1-0-0-0", 2),
      ],
      { showBounds: false },
    );

    expect(pointRendering.setPointsCount).toBe(0);
    expect(pointRendering.batches.map((batch) => batch.key)).toEqual([
      "0-0-0-0:1:1:1",
      "1-0-0-0:1:1:1",
    ]);
    expect(pointRendering.batches.map((batch) => batch.points.length)).toEqual([
      1,
      1,
    ]);
    expect(result.points).toHaveLength(2);
  });

  it("can skip aggregate point arrays when a batch renderer is used", async () => {
    const pointRendering = createRecordingBatchPointRenderer();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
      ]);

    const result = await layer.renderNodeSampleResults(
      [
        createNodePointSampleResult("0-0-0-0", 1),
        createNodePointSampleResult("1-0-0-0", 2),
      ],
      {
        includePointsInResult: false,
        showBounds: false,
      },
    );

    expect(pointRendering.setPointsCount).toBe(0);
    expect(pointRendering.batches).toHaveLength(2);
    expect(result.points).toEqual([]);
    expect(result.pointSamples.points).toEqual([]);
    expect(result.renderStats.pointCount).toBe(2);
  });

  it("requests typed samples and renders geometry batches when supported", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
    });
    let sampleFormat: string | undefined;

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
      ]);
    layer.source.loadNodesPointSamples = async (options) => {
      sampleFormat = options.sampleFormat;

      return {
        nodeKeys: [...options.nodeKeys],
        nodeResults: [
          createTypedNodePointSampleResult("0-0-0-0", 1),
          createTypedNodePointSampleResult("1-0-0-0", 2),
        ],
        nodePointCount: 2,
        sampledPointCount: 2,
        points: [],
      };
    };

    const result = await layer.renderNodes(["0-0-0-0", "1-0-0-0"], {
      includePointsInResult: false,
      showBounds: false,
    });

    expect(sampleFormat).toBe("typed");
    expect(pointRendering.setPointsCount).toBe(0);
    expect(pointRendering.setPointBatchesCount).toBe(0);
    expect(pointRendering.geometryBatches.map((batch) => batch.key)).toEqual([
      "0-0-0-0:1:1:1",
      "1-0-0-0:1:1:1",
    ]);
    expect(
      pointRendering.geometryBatches.map((batch) => batch.pointCount),
    ).toEqual([1, 1]);
    expect(result.points).toEqual([]);
    expect(result.pointSamples.points).toEqual([]);
    expect(result.renderStats.pointCount).toBe(2);
  });

  it("uses the Cesium geometry worker for typed built-in coordinate transforms", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new FakePointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "worker",
      createPointGeometryWorker: () => geometryWorker as unknown as Worker,
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([createHierarchyNode("0-0-0-0")]);
    layer.source.loadNodesPointSamples = async (options) => ({
      nodeKeys: [...options.nodeKeys],
      nodeResults: [createTypedNodePointSampleResult("0-0-0-0", 7)],
      nodePointCount: 1,
      sampledPointCount: 1,
      points: [],
    });

    const result = await layer.renderNodes(["0-0-0-0"], {
      includePointsInResult: false,
      showBounds: false,
    });

    expect(geometryWorker.requests).toHaveLength(1);
    expect(geometryWorker.requests[0]).toEqual(
      expect.objectContaining({
        type: "buildPointGeometryBatch",
        key: "0-0-0-0:1:1:1",
        transform: {
          kind: "geographic",
          heightScaleToMeters: 1,
        },
      }),
    );
    expect(pointRendering.geometryBatches[0]?.positions).toEqual(
      new Float64Array([7, 8, 9]),
    );
    expect(result.renderStats.pointCount).toBe(1);
  });

  it("uses the integrated COPC geometry worker when requested", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new FakeCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      maxDecodedPointDataViewsPerWorker: 80,
      maxDecodedPointDataViewBytesPerWorker: 200 * 1024 * 1024,
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });
    let loadNodesPointSamplesCalled = false;

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([createHierarchyNode("0-0-0-0")]);
    layer.source.loadNodesPointSamples = async () => {
      loadNodesPointSamplesCalled = true;
      throw new Error("Expected integrated geometry worker path.");
    };

    const result = await layer.renderNodes(["0-0-0-0"], {
      includePointsInResult: false,
      maxPointCountPerNode: 5,
      showBounds: false,
    });

    expect(loadNodesPointSamplesCalled).toBe(false);
    expect(geometryWorker.requests).toHaveLength(1);
    expect(geometryWorker.requests[0]).toEqual(
      expect.objectContaining({
        type: "loadNodePointGeometry",
        source: {
          key: "url:https://example.com/sample.copc.laz",
          input: "https://example.com/sample.copc.laz",
        },
        nodeKey: "0-0-0-0",
        maxPointCount: 5,
        maxDecodedPointDataViews: 80,
        maxDecodedPointDataViewBytes: 200 * 1024 * 1024,
        transform: {
          kind: "geographic",
          heightScaleToMeters: 1,
        },
      }),
    );
    expect(pointRendering.geometryBatches[0]?.positions).toEqual(
      new Float64Array([11, 12, 13]),
    );
    expect(result.pointSamples.nodeKeys).toEqual(["0-0-0-0"]);
    expect(result.pointSamples.sampledPointCount).toBe(1);
    expect(result.renderStats.pointCount).toBe(1);
  });

  it("prefetches decoded COPC node data without rendering geometry", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new FakeCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([createHierarchyNode("0-0-0-0")]);

    const result = await layer.prefetchNodePointDataViews(["0-0-0-0"], {
      requestPriority: -100,
    });

    expect(result).toEqual({
      requestedNodeCount: 1,
      prefetchedNodeCount: 1,
      skippedNodeCount: 0,
    });
    expect(geometryWorker.requests).toEqual([
      expect.objectContaining({
        type: "prefetchNodePointData",
        nodeKey: "0-0-0-0",
      }),
    ]);
    expect(pointRendering.geometryBatches).toEqual([]);
  });

  it("reports decoded COPC node data prefetch progress per completed node", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });
    const progressCounts: Array<[number, number]> = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
      ]);

    const result = await layer.prefetchNodePointDataViews(
      ["0-0-0-0", "1-0-0-0"],
      {
        requestPriority: -100,
        onProgress: (progress) => {
          progressCounts.push([
            progress.prefetchedNodeCount,
            progress.skippedNodeCount,
          ]);
        },
      },
    );

    expect(result).toEqual({
      requestedNodeCount: 2,
      prefetchedNodeCount: 2,
      skippedNodeCount: 0,
    });
    expect(progressCounts).toEqual([
      [1, 0],
      [2, 0],
    ]);
    expect(pointRendering.geometryBatches).toEqual([]);
  });

  it("continues decoded COPC prefetch after cached nodes are skipped", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
        createHierarchyNode("1-1-0-0"),
      ]);

    await layer.prefetchNodePointDataViews(["0-0-0-0"], {
      requestPriority: -100,
    });

    const result = await layer.prefetchNodePointDataViews(
      ["0-0-0-0", "1-0-0-0", "1-1-0-0"],
      {
        maxConcurrentRequests: 1,
        requestPriority: -100,
      },
    );

    expect(result).toEqual({
      requestedNodeCount: 3,
      prefetchedNodeCount: 2,
      skippedNodeCount: 1,
    });
    expect(
      geometryWorker.requests
        .filter((request) => request.type === "prefetchNodePointData")
        .map((request) => request.nodeKey),
    ).toEqual(["0-0-0-0", "1-0-0-0", "1-1-0-0"]);
    expect(pointRendering.geometryBatches).toEqual([]);
  });

  it("limits decoded COPC prefetch concurrency so background work cannot occupy every worker", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const workers: ManualCopcPointGeometryWorker[] = [];
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 4,
      createCopcPointGeometryWorker: () => {
        const worker = new ManualCopcPointGeometryWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
        createHierarchyNode("1-1-0-0"),
        createHierarchyNode("1-0-1-0"),
      ]);

    const result = layer.prefetchNodePointDataViews(
      ["0-0-0-0", "1-0-0-0", "1-1-0-0", "1-0-1-0"],
      {
        maxConcurrentRequests: 2,
        requestPriority: -100,
      },
    );

    await waitForCopcGeometryWorkerPrefetchRequestCount(workers, 2);

    expect(workers).toHaveLength(2);
    expect(
      workers.flatMap((worker) => worker.prefetchRequests.map((request) => request.nodeKey)),
    ).toEqual(["0-0-0-0", "1-0-0-0"]);

    workers[0]?.dispatchPrefetchSuccess(1, "0-0-0-0");
    await waitForCopcGeometryWorkerPrefetchRequestCount(workers, 3);

    expect(
      workers.flatMap((worker) => worker.prefetchRequests.map((request) => request.nodeKey)),
    ).toEqual(["0-0-0-0", "1-1-0-0", "1-0-0-0"]);

    workers[1]?.dispatchPrefetchSuccess(2, "1-0-0-0");
    await waitForCopcGeometryWorkerPrefetchRequestCount(workers, 4);

    workers[0]?.dispatchPrefetchSuccess(3, "1-1-0-0");
    workers[1]?.dispatchPrefetchSuccess(4, "1-0-1-0");

    await expect(result).resolves.toEqual({
      requestedNodeCount: 4,
      prefetchedNodeCount: 4,
      skippedNodeCount: 0,
    });
    expect(pointRendering.geometryBatches).toEqual([]);
  });

  it("prefetches integrated geometry batches without rendering them", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([{
        ...createHierarchyNode("0-0-0-0"),
        pointCount: 10,
      }]);

    const prefetchResult = await layer.prefetchNodePointGeometryBatches(
      ["0-0-0-0"],
      {
        maxPointCountPerNode: 6,
        requestPriority: -100,
      },
    );

    expect(prefetchResult).toEqual({
      requestedNodeCount: 1,
      prefetchedNodeCount: 1,
      skippedNodeCount: 0,
    });
    expect(geometryWorker.loadRequests).toEqual([
      expect.objectContaining({
        type: "loadNodePointGeometry",
        nodeKey: "0-0-0-0",
        maxPointCount: 6,
      }),
    ]);
    expect(pointRendering.geometryBatches).toEqual([]);

    const secondPrefetchResult = await layer.prefetchNodePointGeometryBatches(
      ["0-0-0-0"],
      {
        maxPointCountPerNode: 4,
        requestPriority: -100,
      },
    );

    expect(secondPrefetchResult).toEqual({
      requestedNodeCount: 1,
      prefetchedNodeCount: 0,
      skippedNodeCount: 1,
    });
    expect(geometryWorker.loadRequests).toHaveLength(1);

    const renderResult = await layer.renderNodes(["0-0-0-0"], {
      includePointsInResult: false,
      maxPointCountPerNode: 4,
      showBounds: false,
    });

    expect(geometryWorker.loadRequests).toHaveLength(1);
    expect(pointRendering.geometryBatches[0]?.pointCount).toBe(4);
    expect(renderResult.renderStats.pointGeometryTimings?.cacheHitCount).toBe(1);
    expect(renderResult.pointSamples.sampledPointCount).toBe(4);
  });

  it("reuses a denser integrated geometry batch for a lower detail request", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([{
        ...createHierarchyNode("0-0-0-0"),
        pointCount: 10,
      }]);

    await layer.renderNodes(["0-0-0-0"], {
      includePointsInResult: false,
      maxPointCountPerNode: 10,
      showBounds: false,
    });
    const fullDetailBatch = pointRendering.geometryBatches[0];
    const result = await layer.renderNodes(["0-0-0-0"], {
      includePointsInResult: false,
      maxPointCountPerNode: 4,
      showBounds: false,
    });
    const lowerDetailBatch = pointRendering.geometryBatches[0];

    expect(geometryWorker.loadRequests).toHaveLength(1);
    expect(lowerDetailBatch?.pointCount).toBe(4);
    expect(lowerDetailBatch?.positions.buffer).toBe(
      fullDetailBatch?.positions.buffer,
    );
    expect(lowerDetailBatch?.colors.buffer).toBe(fullDetailBatch?.colors.buffer);
    expect(result.pointSamples.sampledPointCount).toBe(4);
    expect(result.renderStats.pointCount).toBe(4);
    expect(result.renderStats.pointGeometryTimings?.cacheHitCount).toBe(1);
    expect(layer.getPointGeometryCacheStats()).toEqual(
      expect.objectContaining({
        loadedBatchCacheMissCount: 1,
        loadedBatchCacheReuseCount: 1,
      }),
    );
  });

  it("preserves timing when overlapping renders share a pending geometry request", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([{
        ...createHierarchyNode("0-0-0-0"),
        pointCount: 10,
      }]);

    const [firstResult, secondResult] = await Promise.all([
      layer.renderNodes(["0-0-0-0"], {
        includePointsInResult: false,
        maxPointCountPerNode: 10,
        showBounds: false,
      }),
      layer.renderNodes(["0-0-0-0"], {
        includePointsInResult: false,
        maxPointCountPerNode: 10,
        showBounds: false,
      }),
    ]);

    expect(geometryWorker.loadRequests).toHaveLength(1);
    expect(firstResult.renderStats.pointGeometryTimings).toEqual(
      expect.objectContaining({
        cacheHitCount: 0,
        pointDataViewMilliseconds: 100,
        workerTotalMilliseconds: 200,
      }),
    );
    expect(secondResult.renderStats.pointGeometryTimings).toEqual(
      expect.objectContaining({
        cacheHitCount: 0,
        pointDataViewMilliseconds: 100,
        workerTotalMilliseconds: 200,
      }),
    );
  });

  it("keeps a newer pending geometry consumer alive when an older render aborts", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new ManualCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      activePointGeometryWorkerCancellation: "terminate",
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([{
        ...createHierarchyNode("0-0-0-0"),
        pointCount: 10,
      }]);

    const firstAbort = new AbortController();
    const firstResult = layer.renderNodes(["0-0-0-0"], {
      includePointsInResult: false,
      maxPointCountPerNode: 10,
      showBounds: false,
      signal: firstAbort.signal,
    });

    await waitForCopcGeometryWorkerRequestCount(geometryWorker, 1);

    const secondResult = layer.renderNodes(["0-0-0-0"], {
      includePointsInResult: false,
      maxPointCountPerNode: 10,
      showBounds: false,
    });

    await waitForPointGeometryCacheMissCount(layer, 2);

    const firstRejects = expect(firstResult).rejects.toMatchObject({
      name: "AbortError",
    });
    firstAbort.abort();
    await firstRejects;

    expect(geometryWorker.terminateCount).toBe(0);
    expect(geometryWorker.loadRequests).toHaveLength(1);

    const request = geometryWorker.loadRequests[0];
    geometryWorker.dispatchSuccess(request.id, request.nodeKey, 10);

    await expect(secondResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKeys: ["0-0-0-0"],
        sampledPointCount: 10,
      }),
      renderStats: expect.objectContaining({
        pointCount: 10,
      }),
    });
  });

  it("prepares integrated geometry batches without rendering and reuses them", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([{
        ...createHierarchyNode("0-0-0-0"),
        pointCount: 10,
      }]);

    const prepared = await layer.prepareNodes(["0-0-0-0"], {
      maxPointCountPerNode: 6,
    });

    expect(prepared.pointSamples.sampledPointCount).toBe(6);
    expect(pointRendering.geometryBatches).toHaveLength(0);
    expect(geometryWorker.loadRequests).toHaveLength(1);

    const result = await layer.renderNodes(["0-0-0-0"], {
      includePointsInResult: false,
      maxPointCountPerNode: 6,
      showBounds: false,
    });

    expect(geometryWorker.loadRequests).toHaveLength(1);
    expect(pointRendering.geometryBatches[0]?.pointCount).toBe(6);
    expect(result.renderStats.pointGeometryTimings?.cacheHitCount).toBe(1);
    expect(layer.getPointGeometryCacheStats()).toEqual(
      expect.objectContaining({
        loadedBatchCacheHitCount: 1,
        loadedBatchCacheMissCount: 1,
      }),
    );
  });

  it("prepares integrated geometry batches progressively without rendering", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });
    const progressNodeKeys: string[][] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        {
          ...createHierarchyNode("0-0-0-0"),
          pointCount: 3,
        },
        {
          ...createHierarchyNode("1-0-0-0"),
          pointCount: 5,
        },
      ]);

    const prepared = await layer.prepareNodesProgressively(
      ["0-0-0-0", "1-0-0-0"],
      {
        maxPointCountPerNode: 5,
        progressBatchNodeCount: 1,
        onProgress: (progress) => {
          progressNodeKeys.push([...progress.pointSamples.nodeKeys]);
        },
      },
    );

    expect(progressNodeKeys).toEqual([
      ["0-0-0-0"],
      ["0-0-0-0", "1-0-0-0"],
    ]);
    expect(prepared.nodes.map((node) => node.key)).toEqual([
      "0-0-0-0",
      "1-0-0-0",
    ]);
    expect(prepared.pointSamples.sampledPointCount).toBe(8);
    expect(pointRendering.geometryBatches).toHaveLength(0);
    expect(geometryWorker.loadRequests).toHaveLength(2);
  });

  it("limits active progressive integrated prepare requests", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorkers: ManualCopcPointGeometryWorker[] = [];
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 2,
      createCopcPointGeometryWorker: () => {
        const worker = new ManualCopcPointGeometryWorker();
        geometryWorkers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const progressNodeKeys: string[][] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
        createHierarchyNode("1-1-0-0"),
      ]);

    const promise = layer.prepareNodesProgressively(
      ["0-0-0-0", "1-0-0-0", "1-1-0-0"],
      {
        maxActiveProgressiveNodeRequests: 1,
        maxPointCountPerNode: 1,
        progressBatchNodeCount: 1,
        onProgress: (progress) => {
          progressNodeKeys.push([...progress.pointSamples.nodeKeys]);
        },
      },
    );

    await waitForCopcGeometryWorkerLoadRequestCount(geometryWorkers, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(countCopcGeometryWorkerLoadRequests(geometryWorkers)).toBe(1);

    dispatchLatestCopcGeometryWorkerSuccess(geometryWorkers, 1);
    await waitForCopcGeometryWorkerLoadRequestCount(geometryWorkers, 2);
    expect(countCopcGeometryWorkerLoadRequests(geometryWorkers)).toBe(2);

    dispatchLatestCopcGeometryWorkerSuccess(geometryWorkers, 1);
    await waitForCopcGeometryWorkerLoadRequestCount(geometryWorkers, 3);
    dispatchLatestCopcGeometryWorkerSuccess(geometryWorkers, 1);

    const prepared = await promise;

    expect(progressNodeKeys).toEqual([
      ["0-0-0-0"],
      ["0-0-0-0", "1-0-0-0"],
      ["0-0-0-0", "1-0-0-0", "1-1-0-0"],
    ]);
    expect(prepared.pointSamples.nodeKeys).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "1-1-0-0",
    ]);
    expect(pointRendering.geometryBatches).toHaveLength(0);
  });

  it("reports summed and max integrated geometry worker timings separately", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        {
          ...createHierarchyNode("0-0-0-0"),
          pointCount: 3,
        },
        {
          ...createHierarchyNode("1-0-0-0"),
          pointCount: 5,
        },
      ]);

    const result = await layer.renderNodes(["0-0-0-0", "1-0-0-0"], {
      includePointsInResult: false,
      maxPointCountPerNode: 5,
      showBounds: false,
    });

    expect(result.renderStats.pointGeometryTimings).toEqual(
      expect.objectContaining({
        nodeCount: 2,
        pointDataViewMilliseconds: 80,
        maxPointDataViewMilliseconds: 50,
        workerTotalMilliseconds: 160,
        maxWorkerTotalMilliseconds: 100,
        slowestNodes: [
          expect.objectContaining({
            nodeKey: "1-0-0-0",
            nodePointCount: 5,
            sampledPointCount: 5,
            pointDataLength: 10,
            pointDataViewMilliseconds: 50,
          }),
          expect.objectContaining({
            nodeKey: "0-0-0-0",
            nodePointCount: 3,
            sampledPointCount: 3,
            pointDataLength: 10,
            pointDataViewMilliseconds: 30,
          }),
        ],
      }),
    );
  });

  it("reloads transfer-only retained samples when the geometry cache entry was evicted", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([{
        ...createHierarchyNode("0-0-0-0"),
        pointCount: 10,
      }]);

    const result = await layer.renderNodesProgressively(["0-0-0-0"], {
      includePointsInResult: false,
      initialNodeResults: [{
        nodeKey: "0-0-0-0",
        nodePointCount: 10,
        sampledPointCount: 6,
        points: [],
      }],
      maxPointCountPerNode: 6,
      showBounds: false,
    });

    expect(geometryWorker.loadRequests).toHaveLength(1);
    expect(geometryWorker.loadRequests[0]).toEqual(
      expect.objectContaining({
        type: "loadNodePointGeometry",
        nodeKey: "0-0-0-0",
        maxPointCount: 6,
      }),
    );
    expect(pointRendering.geometryBatches[0]?.pointCount).toBe(6);
    expect(result.pointSamples.sampledPointCount).toBe(6);
  });

  it("reports whether retained transfer-only samples can be rendered without reload", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });
    const transferOnlySample = {
      nodeKey: "0-0-0-0",
      nodePointCount: 10,
      sampledPointCount: 2,
      points: [],
    };

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([{
        ...createHierarchyNode("0-0-0-0"),
        pointCount: 10,
      }]);

    expect(layer.canRenderNodeSampleResult(transferOnlySample)).toBe(false);

    const prepared = await layer.prepareNodes(["0-0-0-0"], {
      maxPointCountPerNode: 2,
    });
    const preparedSample = prepared.pointSamples.nodeResults[0];

    if (!preparedSample) {
      throw new Error("Expected prepared transfer-only sample.");
    }

    expect(preparedSample).toMatchObject({
      nodeKey: "0-0-0-0",
      sampledPointCount: 2,
      points: [],
    });
    expect(layer.canRenderNodeSampleResult(preparedSample)).toBe(true);
  });

  it("renders partial integrated initial geometry before denser replacement arrives", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });
    const progressPointCounts: number[] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([{
        ...createHierarchyNode("0-0-0-0"),
        pointCount: 10,
      }]);

    const prepared = await layer.prepareNodes(["0-0-0-0"], {
      maxPointCountPerNode: 2,
    });
    geometryWorker.requests.length = 0;

    const result = await layer.renderNodesProgressively(["0-0-0-0"], {
      includePointsInResult: false,
      initialNodeResults: prepared.pointSamples.nodeResults,
      maxPointCountPerNode: 6,
      progressBatchNodeCount: 1,
      showBounds: false,
      onProgress: (progress) => {
        progressPointCounts.push(progress.renderStats.pointCount);
      },
    });

    expect(progressPointCounts).toEqual([2, 6]);
    expect(geometryWorker.loadRequests).toMatchObject([{
      nodeKey: "0-0-0-0",
      maxPointCount: 6,
    }]);
    expect(pointRendering.geometryBatches[0]?.pointCount).toBe(6);
    expect(result.pointSamples.sampledPointCount).toBe(6);
  });

  it("keeps integrated progressive background geometry within the total rendered point budget", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });
    const progressPointCounts: number[] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        {
          ...createHierarchyNode("0-0-0-0"),
          pointCount: 10,
        },
        {
          ...createHierarchyNode("1-0-0-0"),
          pointCount: 10,
        },
      ]);

    const background = await layer.prepareNodes(["0-0-0-0"], {
      maxPointCountPerNode: 6,
    });
    geometryWorker.requests.length = 0;

    const result = await layer.renderNodesProgressively(["1-0-0-0"], {
      includePointsInResult: false,
      backgroundNodeResults: background.pointSamples.nodeResults,
      maxPointCountPerNode: 6,
      maxRenderedPointCount: 8,
      progressBatchNodeCount: 1,
      showBounds: false,
      onProgress: (progress) => {
        progressPointCounts.push(progress.renderStats.pointCount);
      },
    });

    expect(progressPointCounts.every((pointCount) => pointCount <= 8)).toBe(
      true,
    );
    expect(pointRendering.geometryBatches.reduce(
      (total, batch) => total + batch.pointCount,
      0,
    )).toBeLessThanOrEqual(8);
    expect(result.pointSamples.sampledPointCount).toBeLessThanOrEqual(8);
  });

  it("prioritizes integrated current detail geometry before background coverage under the point budget", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });
    const progressNodeKeys: string[][] = [];
    const progressPointCounts: number[][] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy(
        [
          "0-0-0-0",
          "0-1-0-0",
          "1-0-0-0",
          "1-1-0-0",
        ].map((key) => ({
          ...createHierarchyNode(key),
          pointCount: 6,
        })),
      );

    const background = await layer.prepareNodes(["0-0-0-0", "0-1-0-0"], {
      maxPointCountPerNode: 6,
    });
    geometryWorker.requests.length = 0;

    const result = await layer.renderNodesProgressively(
      ["1-0-0-0", "1-1-0-0"],
      {
        includePointsInResult: false,
        backgroundNodeResults: background.pointSamples.nodeResults,
        maxPointCountPerNode: 6,
        maxRenderedPointCount: 10,
        progressBatchNodeCount: 1,
        showBounds: false,
        onProgress: (progressResult) => {
          progressNodeKeys.push([...progressResult.pointSamples.nodeKeys]);
          progressPointCounts.push(
            progressResult.pointSamples.nodeResults.map(
              (nodeResult) => nodeResult.sampledPointCount,
            ),
          );
        },
      },
    );

    expect(progressNodeKeys[0]).toEqual(["0-0-0-0", "0-1-0-0"]);
    expect(progressPointCounts[0]).toEqual([5, 5]);
    expect(progressNodeKeys[1]).toEqual([
      "1-0-0-0",
      "0-0-0-0",
      "0-1-0-0",
    ]);
    expect(progressPointCounts[1]).toEqual([5, 3, 2]);
    expect(result.pointSamples.nodeKeys).toEqual(["1-0-0-0", "1-1-0-0"]);
    expect(result.pointSamples.nodeResults.map((node) => node.sampledPointCount))
      .toEqual([5, 5]);
    expect(pointRendering.geometryBatches.map((batch) => batch.pointCount))
      .toEqual([5, 5]);
  });

  it("keeps integrated progressive coverage order before lightweight tie-breaking", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });
    const nodeKeys = ["4-0-0-0", "4-1-0-0", "4-2-0-0"];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        {
          ...createHierarchyNode("4-0-0-0"),
          pointCount: 10,
          pointDataLength: 3_000,
        },
        {
          ...createHierarchyNode("4-1-0-0"),
          pointCount: 10,
          pointDataLength: 30,
        },
        {
          ...createHierarchyNode("4-2-0-0"),
          pointCount: 10,
          pointDataLength: 300,
        },
      ]);

    await layer.renderNodesProgressively(nodeKeys, {
      includePointsInResult: false,
      maxPointCountPerNode: 10,
      progressBatchNodeCount: 1,
      showBounds: false,
    });

    expect(
      geometryWorker.loadRequests.map((request) =>
        request.type === "loadNodePointGeometry" ? request.nodeKey : undefined,
      ),
    ).toEqual(["4-0-0-0", "4-1-0-0", "4-2-0-0"]);
  });

  it("can prioritize lightweight integrated progressive requests without changing render order", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });
    const nodeKeys = ["4-0-0-0", "4-1-0-0", "4-2-0-0"];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        {
          ...createHierarchyNode("4-0-0-0"),
          pointCount: 10,
          pointDataLength: 3_000,
        },
        {
          ...createHierarchyNode("4-1-0-0"),
          pointCount: 10,
          pointDataLength: 30,
        },
        {
          ...createHierarchyNode("4-2-0-0"),
          pointCount: 10,
          pointDataLength: 300,
        },
      ]);

    const result = await layer.renderNodesProgressively(nodeKeys, {
      includePointsInResult: false,
      maxPointCountPerNode: 10,
      maxActiveProgressiveNodeRequests: 1,
      nodeRequestOrder: "lightweight-first",
      progressBatchNodeCount: 1,
      showBounds: false,
    });

    expect(
      geometryWorker.loadRequests.map((request) =>
        request.type === "loadNodePointGeometry" ? request.nodeKey : undefined,
      ),
    ).toEqual(["4-1-0-0", "4-2-0-0", "4-0-0-0"]);
    expect(result.pointSamples.nodeKeys).toEqual(nodeKeys);
  });

  it("can prioritize source-point-heavy integrated progressive requests without changing render order", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });
    const nodeKeys = ["4-0-0-0", "4-1-0-0", "4-2-0-0", "4-3-0-0"];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        {
          ...createHierarchyNode("4-0-0-0"),
          pointCount: 10,
          pointDataLength: 3_000,
        },
        {
          ...createHierarchyNode("4-1-0-0"),
          pointCount: 90,
          pointDataLength: 30,
        },
        {
          ...createHierarchyNode("4-2-0-0"),
          pointCount: 40,
          pointDataLength: 300,
        },
        {
          ...createHierarchyNode("4-3-0-0"),
          pointCount: 90,
          pointDataLength: 10,
        },
      ]);

    const result = await layer.renderNodesProgressively(nodeKeys, {
      includePointsInResult: false,
      maxPointCountPerNode: 100,
      maxActiveProgressiveNodeRequests: 1,
      nodeRequestOrder: "source-points-first",
      progressBatchNodeCount: 1,
      showBounds: false,
    });

    expect(
      geometryWorker.loadRequests.map((request) =>
        request.type === "loadNodePointGeometry" ? request.nodeKey : undefined,
      ),
    ).toEqual(["4-3-0-0", "4-1-0-0", "4-2-0-0", "4-0-0-0"]);
    expect(result.pointSamples.nodeKeys).toEqual(nodeKeys);
  });

  it("continues integrated progressive loading after stop progress when requested", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new ManualCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });
    const progressNodeKeys: string[][] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
      ]);

    const promise = layer.renderNodesProgressively(
      ["0-0-0-0", "1-0-0-0"],
      {
        includePointsInResult: false,
        continueLoadingAfterStop: true,
        progressBatchNodeCount: 1,
        showBounds: false,
        shouldStopAfterProgress: (result) =>
          result.pointSamples.nodeKeys.includes("0-0-0-0"),
        onProgress: (result) => {
          progressNodeKeys.push([...result.pointSamples.nodeKeys]);
        },
      },
    );

    await waitForCopcGeometryWorkerRequestCount(geometryWorker, 1);
    const firstRequest = geometryWorker.loadRequests[0];
    if (!firstRequest) {
      throw new Error("Expected first geometry request.");
    }
    geometryWorker.dispatchSuccess(
      firstRequest.id,
      firstRequest.nodeKey,
      1,
    );

    await waitForProgressCount(progressNodeKeys, 1);
    expect(progressNodeKeys).toEqual([["0-0-0-0"]]);
    expect(
      geometryWorker.requests.filter((request) => request.type === "cancel"),
    ).toHaveLength(0);

    await waitForCopcGeometryWorkerRequestCount(geometryWorker, 2);
    const secondRequest = geometryWorker.loadRequests[1];
    if (!secondRequest) {
      throw new Error("Expected second geometry request.");
    }
    geometryWorker.dispatchSuccess(
      secondRequest.id,
      secondRequest.nodeKey,
      1,
    );

    const result = await promise;

    expect(progressNodeKeys).toEqual([
      ["0-0-0-0"],
      ["0-0-0-0", "1-0-0-0"],
    ]);
    expect(result.pointSamples.nodeKeys).toEqual(["0-0-0-0", "1-0-0-0"]);
    expect(pointRendering.geometryBatches).toHaveLength(2);
  });

  it("can continue integrated progressive loading after stop without rendering post-stop progress", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new ManualCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });
    const progressNodeKeys: string[][] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
      ]);

    const promise = layer.renderNodesProgressively(
      ["0-0-0-0", "1-0-0-0"],
      {
        includePointsInResult: false,
        continueLoadingAfterStop: true,
        postStopProgressMode: "load-only",
        progressBatchNodeCount: 1,
        showBounds: false,
        shouldStopAfterProgress: (result) =>
          result.pointSamples.nodeKeys.includes("0-0-0-0"),
        onProgress: (result) => {
          progressNodeKeys.push([...result.pointSamples.nodeKeys]);
        },
      },
    );

    await waitForCopcGeometryWorkerRequestCount(geometryWorker, 1);
    const firstRequest = geometryWorker.loadRequests[0];
    if (!firstRequest) {
      throw new Error("Expected first geometry request.");
    }
    geometryWorker.dispatchSuccess(
      firstRequest.id,
      firstRequest.nodeKey,
      1,
    );

    await waitForProgressCount(progressNodeKeys, 1);
    expect(progressNodeKeys).toEqual([["0-0-0-0"]]);
    expect(
      geometryWorker.requests.filter((request) => request.type === "cancel"),
    ).toHaveLength(0);

    await waitForCopcGeometryWorkerRequestCount(geometryWorker, 2);
    const secondRequest = geometryWorker.loadRequests[1];
    if (!secondRequest) {
      throw new Error("Expected second geometry request.");
    }
    geometryWorker.dispatchSuccess(
      secondRequest.id,
      secondRequest.nodeKey,
      1,
    );

    const result = await promise;

    expect(progressNodeKeys).toEqual([["0-0-0-0"]]);
    expect(result.pointSamples.nodeKeys).toEqual(["0-0-0-0"]);
    expect(pointRendering.geometryBatches).toHaveLength(1);
  });

  it("can resolve integrated progressive rendering while post-stop work fills caches in the background", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new ManualCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });
    const progressNodeKeys: string[][] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
      ]);

    const promise = layer.renderNodesProgressively(
      ["0-0-0-0", "1-0-0-0"],
      {
        includePointsInResult: false,
        continueLoadingAfterStop: true,
        postStopLoadingMode: "background",
        postStopProgressMode: "load-only",
        progressBatchNodeCount: 1,
        showBounds: false,
        shouldStopAfterProgress: (result) =>
          result.pointSamples.nodeKeys.includes("0-0-0-0"),
        onProgress: (result) => {
          progressNodeKeys.push([...result.pointSamples.nodeKeys]);
        },
      },
    );

    await waitForCopcGeometryWorkerRequestCount(geometryWorker, 1);
    const firstRequest = geometryWorker.loadRequests[0];
    if (!firstRequest) {
      throw new Error("Expected first geometry request.");
    }
    geometryWorker.dispatchSuccess(
      firstRequest.id,
      firstRequest.nodeKey,
      1,
    );

    await waitForProgressCount(progressNodeKeys, 1);
    const result = await promise;

    expect(progressNodeKeys).toEqual([["0-0-0-0"]]);
    expect(result.pointSamples.nodeKeys).toEqual(["0-0-0-0"]);
    expect(
      geometryWorker.requests.filter((request) => request.type === "cancel"),
    ).toHaveLength(0);

    await waitForCopcGeometryWorkerRequestCount(geometryWorker, 2);
    const secondRequest = geometryWorker.loadRequests[1];
    if (!secondRequest) {
      throw new Error("Expected second geometry request.");
    }
    geometryWorker.dispatchSuccess(
      secondRequest.id,
      secondRequest.nodeKey,
      1,
    );
    await waitForCopcGeometryBatchCacheCount(layer, 2);

    await layer.renderNodes(["1-0-0-0"], {
      includePointsInResult: false,
      maxPointCountPerNode: 1,
      showBounds: false,
    });

    expect(geometryWorker.loadRequests).toHaveLength(2);
    expect(progressNodeKeys).toEqual([["0-0-0-0"]]);
  });

  it("does not start unqueued integrated post-stop background tail work when active progressive requests are limited", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new ManualCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });
    const progressNodeKeys: string[][] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
        createHierarchyNode("1-1-0-0"),
      ]);

    const promise = layer.renderNodesProgressively(
      ["0-0-0-0", "1-0-0-0", "1-1-0-0"],
      {
        includePointsInResult: false,
        continueLoadingAfterStop: true,
        postStopLoadingMode: "background",
        postStopProgressMode: "load-only",
        maxActiveProgressiveNodeRequests: 1,
        progressBatchNodeCount: 1,
        showBounds: false,
        shouldStopAfterProgress: (result) =>
          result.pointSamples.nodeKeys.includes("0-0-0-0"),
        onProgress: (result) => {
          progressNodeKeys.push([...result.pointSamples.nodeKeys]);
        },
      },
    );

    await waitForCopcGeometryWorkerRequestCount(geometryWorker, 1);
    const firstRequest = geometryWorker.loadRequests[0];
    if (!firstRequest) {
      throw new Error("Expected first geometry request.");
    }
    geometryWorker.dispatchSuccess(
      firstRequest.id,
      firstRequest.nodeKey,
      1,
    );

    const result = await promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(progressNodeKeys).toEqual([["0-0-0-0"]]);
    expect(result.pointSamples.nodeKeys).toEqual(["0-0-0-0"]);
    expect(geometryWorker.loadRequests).toHaveLength(1);
  });

  it("distributes integrated progressive detail across the rendered point budget", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });
    const nodeKeys = ["0-0-0-0", "1-0-0-0", "1-1-0-0"];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy(
        nodeKeys.map((key) => ({
          ...createHierarchyNode(key),
          pointCount: 10,
        })),
      );

    const prepared = await layer.prepareNodes(nodeKeys, {
      maxPointCountPerNode: 10,
    });
    geometryWorker.requests.length = 0;

    const result = await layer.renderNodesProgressively(nodeKeys, {
      includePointsInResult: false,
      initialNodeResults: prepared.pointSamples.nodeResults,
      maxPointCountPerNode: 10,
      maxRenderedPointCount: 10,
      progressBatchNodeCount: 1,
      showBounds: false,
    });

    expect(geometryWorker.loadRequests).toHaveLength(0);
    expect(pointRendering.geometryBatches.map((batch) => batch.pointCount))
      .toEqual([4, 3, 3]);
    expect(result.pointSamples.nodeResults.map((node) => node.sampledPointCount))
      .toEqual([4, 3, 3]);
    expect(result.pointSamples.sampledPointCount).toBe(10);
    expect(result.renderStats.pointCount).toBe(10);
  });

  it("caps cached integrated progressive geometry per node before applying the total budget", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });
    const nodeKeys = ["0-0-0-0", "1-0-0-0", "1-1-0-0"];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy(
        nodeKeys.map((key) => ({
          ...createHierarchyNode(key),
          pointCount: 10,
        })),
      );

    const prepared = await layer.prepareNodes(nodeKeys, {
      maxPointCountPerNode: 10,
    });
    geometryWorker.requests.length = 0;

    const result = await layer.renderNodesProgressively(nodeKeys, {
      includePointsInResult: false,
      initialNodeResults: prepared.pointSamples.nodeResults,
      maxPointCountPerNode: 4,
      maxRenderedPointCount: 12,
      progressBatchNodeCount: 1,
      showBounds: false,
    });

    expect(geometryWorker.loadRequests).toHaveLength(0);
    expect(pointRendering.geometryBatches.map((batch) => batch.pointCount))
      .toEqual([4, 4, 4]);
    expect(result.pointSamples.nodeKeys).toEqual(nodeKeys);
    expect(result.pointSamples.sampledPointCount).toBe(12);
    expect(result.renderStats.pointCount).toBe(12);
  });

  it("skips stale transfer-only initial geometry when its cached batch is gone", async () => {
    const pointRendering = createRecordingGeometryBatchPointRenderer();
    const geometryWorker = new CountingCopcPointGeometryWorker();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      pointGeometryLoading: "integrated-worker",
      createCopcPointGeometryWorker: () =>
        geometryWorker as unknown as Worker,
    });
    const progressPointCounts: number[] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([{
        ...createHierarchyNode("0-0-0-0"),
        pointCount: 10,
      }]);

    const result = await layer.renderNodesProgressively(["0-0-0-0"], {
      includePointsInResult: false,
      initialNodeResults: [{
        nodeKey: "0-0-0-0",
        nodePointCount: 10,
        sampledPointCount: 2,
        points: [],
      }],
      maxPointCountPerNode: 6,
      progressBatchNodeCount: 1,
      showBounds: false,
      onProgress: (progress) => {
        progressPointCounts.push(progress.renderStats.pointCount);
      },
    });

    expect(progressPointCounts).toEqual([6]);
    expect(geometryWorker.loadRequests).toMatchObject([{
      nodeKey: "0-0-0-0",
      maxPointCount: 6,
    }]);
    expect(result.pointSamples.sampledPointCount).toBe(6);
  });

  it("renders progressive node batches as their point samples finish", async () => {
    const pointRendering = createRecordingPointRenderer();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
    });
    const resolvers = new Map<
      string,
      (result: CopcNodePointSampleResult) => void
    >();
    const progressNodeKeys: string[][] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
      ]);
    layer.source.loadNodePointSamples = (options = {}) =>
      new Promise((resolve) => {
        resolvers.set(options.nodeKey ?? "0-0-0-0", resolve);
      });

    const promise = layer.renderNodesProgressively(
      ["0-0-0-0", "1-0-0-0"],
      {
        progressBatchNodeCount: 1,
        showBounds: false,
        onProgress: (result) => {
          progressNodeKeys.push([...result.pointSamples.nodeKeys]);
        },
      },
    );

    await waitForResolverCount(resolvers, 2);
    resolvers.get("1-0-0-0")?.(
      createNodePointSampleResult("1-0-0-0", 2),
    );
    await waitForProgressCount(progressNodeKeys, 1);

    resolvers.get("0-0-0-0")?.(
      createNodePointSampleResult("0-0-0-0", 1),
    );

    const result = await promise;

    expect(progressNodeKeys).toEqual([
      ["1-0-0-0"],
      ["0-0-0-0", "1-0-0-0"],
    ]);
    expect(result.pointSamples.nodeKeys).toEqual(["0-0-0-0", "1-0-0-0"]);
    expect(pointRendering.points).toHaveLength(2);
  });

  it("can delay progressive rendering until all requested nodes are loaded", async () => {
    const pointRendering = createRecordingPointRenderer();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
    });
    const resolvers = new Map<
      string,
      (result: CopcNodePointSampleResult) => void
    >();
    const progressNodeKeys: string[][] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
      ]);
    layer.source.loadNodePointSamples = (options = {}) =>
      new Promise((resolve) => {
        resolvers.set(options.nodeKey ?? "0-0-0-0", resolve);
      });

    const promise = layer.renderNodesProgressively(
      ["0-0-0-0", "1-0-0-0"],
      {
        progressBatchNodeCount: 1,
        progressRenderMode: "final-only",
        showBounds: false,
        onProgress: (result) => {
          progressNodeKeys.push([...result.pointSamples.nodeKeys]);
        },
      },
    );

    await waitForResolverCount(resolvers, 2);
    resolvers.get("1-0-0-0")?.(
      createNodePointSampleResult("1-0-0-0", 2),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(progressNodeKeys).toEqual([]);
    expect(pointRendering.points).toHaveLength(0);

    resolvers.get("0-0-0-0")?.(
      createNodePointSampleResult("0-0-0-0", 1),
    );

    const result = await promise;

    expect(progressNodeKeys).toEqual([["0-0-0-0", "1-0-0-0"]]);
    expect(result.pointSamples.nodeKeys).toEqual(["0-0-0-0", "1-0-0-0"]);
    expect(pointRendering.points).toHaveLength(2);
  });

  it("keeps background node samples visible while progressive detail nodes load", async () => {
    const pointRendering = createRecordingPointRenderer();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
    });
    const resolvers = new Map<
      string,
      (result: CopcNodePointSampleResult) => void
    >();
    const progressNodeKeys: string[][] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
        createHierarchyNode("1-1-0-0"),
      ]);
    layer.source.loadNodePointSamples = (options = {}) =>
      new Promise((resolve) => {
        resolvers.set(options.nodeKey ?? "0-0-0-0", resolve);
      });

    const promise = layer.renderNodesProgressively(
      ["1-0-0-0", "1-1-0-0"],
      {
        backgroundNodeResults: [createNodePointSampleResult("0-0-0-0", 1)],
        progressBatchNodeCount: 1,
        showBounds: false,
        onProgress: (result) => {
          progressNodeKeys.push([...result.pointSamples.nodeKeys]);
        },
      },
    );

    await waitForResolverCount(resolvers, 2);
    resolvers.get("1-0-0-0")?.(
      createNodePointSampleResult("1-0-0-0", 2),
    );
    await waitForProgressCount(progressNodeKeys, 2);

    resolvers.get("1-1-0-0")?.(
      createNodePointSampleResult("1-1-0-0", 3),
    );

    const result = await promise;

    expect(progressNodeKeys).toEqual([
      ["0-0-0-0"],
      ["1-0-0-0", "0-0-0-0"],
      ["1-0-0-0", "1-1-0-0"],
    ]);
    expect(result.pointSamples.nodeKeys).toEqual(["1-0-0-0", "1-1-0-0"]);
    expect(pointRendering.points).toHaveLength(2);
  });

  it("reuses initial progressive node samples and loads only missing nodes", async () => {
    const pointRendering = createRecordingPointRenderer();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
    });
    const loadedNodeKeys: string[] = [];
    const progressNodeKeys: string[][] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
      ]);
    layer.source.loadNodePointSamples = async (options = {}) => {
      const nodeKey = options.nodeKey ?? "0-0-0-0";
      loadedNodeKeys.push(nodeKey);

      return createNodePointSampleResult(nodeKey, 2);
    };

    const result = await layer.renderNodesProgressively(
      ["0-0-0-0", "1-0-0-0"],
      {
        initialNodeResults: [createNodePointSampleResult("0-0-0-0", 1)],
        progressBatchNodeCount: 1,
        showBounds: false,
        onProgress: (progressResult) => {
          progressNodeKeys.push([...progressResult.pointSamples.nodeKeys]);
        },
      },
    );

    expect(loadedNodeKeys).toEqual(["1-0-0-0"]);
    expect(progressNodeKeys).toEqual([
      ["0-0-0-0"],
      ["0-0-0-0", "1-0-0-0"],
    ]);
    expect(result.pointSamples.nodeKeys).toEqual(["0-0-0-0", "1-0-0-0"]);
    expect(pointRendering.points).toHaveLength(2);
  });

  it("prioritizes current detail samples before background coverage under the point budget", async () => {
    const pointRendering = createRecordingPointRenderer();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
    });
    const resolvers = new Map<
      string,
      (result: CopcNodePointSampleResult) => void
    >();
    const progressNodeKeys: string[][] = [];
    const progressPointCounts: number[][] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        {
          ...createHierarchyNode("0-0-0-0"),
          pointCount: 6,
        },
        {
          ...createHierarchyNode("0-1-0-0"),
          pointCount: 6,
        },
        {
          ...createHierarchyNode("1-0-0-0"),
          pointCount: 6,
        },
        {
          ...createHierarchyNode("1-1-0-0"),
          pointCount: 6,
        },
      ]);
    layer.source.loadNodePointSamples = (options = {}) => {
      const nodeKey = options.nodeKey ?? "1-0-0-0";

      return new Promise<CopcNodePointSampleResult>((resolve) => {
        resolvers.set(nodeKey, resolve);
      });
    };

    const promise = layer.renderNodesProgressively(
      ["1-0-0-0", "1-1-0-0"],
      {
        backgroundNodeResults: [
          createNodePointSampleResultWithCount("0-0-0-0", 0, 6),
          createNodePointSampleResultWithCount("0-1-0-0", 30, 6),
        ],
        maxPointCountPerNode: 6,
        maxRenderedPointCount: 10,
        progressBatchNodeCount: 1,
        showBounds: false,
        onProgress: (progressResult) => {
          progressNodeKeys.push([...progressResult.pointSamples.nodeKeys]);
          progressPointCounts.push(
            progressResult.pointSamples.nodeResults.map(
              (nodeResult) => nodeResult.sampledPointCount,
            ),
          );
        },
      },
    );

    await waitForResolverCount(resolvers, 2);
    resolvers.get("1-0-0-0")?.(
      createNodePointSampleResultWithCount("1-0-0-0", 10, 6),
    );
    await waitForProgressCount(progressNodeKeys, 2);

    expect(progressNodeKeys[0]).toEqual(["0-0-0-0", "0-1-0-0"]);
    expect(progressPointCounts[0]).toEqual([5, 5]);
    expect(progressNodeKeys[1]).toEqual([
      "1-0-0-0",
      "0-0-0-0",
      "0-1-0-0",
    ]);
    expect(progressPointCounts[1]).toEqual([5, 3, 2]);

    resolvers.get("1-1-0-0")?.(
      createNodePointSampleResultWithCount("1-1-0-0", 20, 6),
    );
    const result = await promise;

    expect(result.pointSamples.nodeKeys).toEqual(["1-0-0-0", "1-1-0-0"]);
    expect(result.pointSamples.nodeResults.map((node) => node.sampledPointCount))
      .toEqual([5, 5]);
    expect(pointRendering.points).toHaveLength(10);
  });

  it("can stop progressive rendering after enough current progress", async () => {
    const pointRendering = createRecordingPointRenderer();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
    });
    const resolvers = new Map<
      string,
      (result: CopcNodePointSampleResult) => void
    >();
    const signals = new Map<string, AbortSignal | undefined>();
    const progressNodeKeys: string[][] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
      ]);
    layer.source.loadNodePointSamples = (options = {}) => {
      const nodeKey = options.nodeKey ?? "0-0-0-0";
      signals.set(nodeKey, options.signal);

      return new Promise<CopcNodePointSampleResult>((resolve, reject) => {
        resolvers.set(nodeKey, resolve);
        options.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    };

    const promise = layer.renderNodesProgressively(
      ["0-0-0-0", "1-0-0-0"],
      {
        progressBatchNodeCount: 1,
        showBounds: false,
        shouldStopAfterProgress: (result) =>
          result.pointSamples.nodeKeys.includes("0-0-0-0"),
        onProgress: (result) => {
          progressNodeKeys.push([...result.pointSamples.nodeKeys]);
        },
      },
    );

    await waitForResolverCount(resolvers, 2);
    resolvers.get("0-0-0-0")?.(
      createNodePointSampleResult("0-0-0-0", 1),
    );

    const result = await promise;

    expect(progressNodeKeys).toEqual([["0-0-0-0"]]);
    expect(result.pointSamples.nodeKeys).toEqual(["0-0-0-0"]);
    expect(signals.get("1-0-0-0")?.aborted).toBe(true);
    expect(pointRendering.points).toHaveLength(1);
  });

  it("limits active progressive point-sample requests", async () => {
    const pointRendering = createRecordingPointRenderer();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
    });
    const resolvers = new Map<
      string,
      (result: CopcNodePointSampleResult) => void
    >();
    const requestedNodeKeys: string[] = [];
    const progressNodeKeys: string[][] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
        createHierarchyNode("1-1-0-0"),
      ]);
    layer.source.loadNodePointSamples = (options = {}) => {
      const nodeKey = options.nodeKey ?? "0-0-0-0";
      requestedNodeKeys.push(nodeKey);

      return new Promise<CopcNodePointSampleResult>((resolve) => {
        resolvers.set(nodeKey, resolve);
      });
    };

    const promise = layer.renderNodesProgressively(
      ["0-0-0-0", "1-0-0-0", "1-1-0-0"],
      {
        maxActiveProgressiveNodeRequests: 1,
        progressBatchNodeCount: 1,
        showBounds: false,
        onProgress: (result) => {
          progressNodeKeys.push([...result.pointSamples.nodeKeys]);
        },
      },
    );

    await waitForResolverCount(resolvers, 1);
    expect(requestedNodeKeys).toEqual(["0-0-0-0"]);

    resolvers.get("0-0-0-0")?.(
      createNodePointSampleResult("0-0-0-0", 1),
    );
    await waitForResolverCount(resolvers, 2);
    expect(requestedNodeKeys).toEqual(["0-0-0-0", "1-0-0-0"]);

    resolvers.get("1-0-0-0")?.(
      createNodePointSampleResult("1-0-0-0", 1),
    );
    await waitForResolverCount(resolvers, 3);
    expect(requestedNodeKeys).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "1-1-0-0",
    ]);

    resolvers.get("1-1-0-0")?.(
      createNodePointSampleResult("1-1-0-0", 1),
    );
    const result = await promise;

    expect(progressNodeKeys).toEqual([
      ["0-0-0-0"],
      ["0-0-0-0", "1-0-0-0"],
      ["0-0-0-0", "1-0-0-0", "1-1-0-0"],
    ]);
    expect(result.pointSamples.nodeKeys).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "1-1-0-0",
    ]);
  });

  it("does not start missing progressive loads when cached progress is enough", async () => {
    const pointRendering = createRecordingPointRenderer();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNode("0-0-0-0"),
        createHierarchyNode("1-0-0-0"),
      ]);
    layer.source.loadNodePointSamples = async () => {
      throw new Error("Should not load missing nodes after stop progress.");
    };

    const result = await layer.renderNodesProgressively(
      ["0-0-0-0", "1-0-0-0"],
      {
        initialNodeResults: [createNodePointSampleResult("0-0-0-0", 1)],
        progressBatchNodeCount: 1,
        showBounds: false,
        shouldStopAfterProgress: () => true,
      },
    );

    expect(result.pointSamples.nodeKeys).toEqual(["0-0-0-0"]);
    expect(pointRendering.points).toHaveLength(1);
  });

  it("renders stale initial progressive samples before refreshing them", async () => {
    const pointRendering = createRecordingPointRenderer();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
    });
    const loadedNodeKeys: string[] = [];
    const progressPointCounts: number[] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([createHierarchyNode("0-0-0-0")]);
    layer.source.loadNodePointSamples = async (options = {}) => {
      const nodeKey = options.nodeKey ?? "0-0-0-0";
      loadedNodeKeys.push(nodeKey);

      return {
        ...createNodePointSampleResult(nodeKey, 2),
        nodePointCount: 10,
        sampledPointCount: 5,
        points: [
          { x: 2, y: 0, z: 0 },
          { x: 3, y: 0, z: 0 },
        ],
      };
    };

    const result = await layer.renderNodesProgressively(["0-0-0-0"], {
      initialNodeResults: [{
        ...createNodePointSampleResult("0-0-0-0", 1),
        nodePointCount: 10,
        sampledPointCount: 1,
      }],
      maxPointCountPerNode: 5,
      progressBatchNodeCount: 1,
      showBounds: false,
      onProgress: (progressResult) => {
        progressPointCounts.push(progressResult.pointSamples.sampledPointCount);
      },
    });

    expect(loadedNodeKeys).toEqual(["0-0-0-0"]);
    expect(progressPointCounts).toEqual([1, 5]);
    expect(result.pointSamples.sampledPointCount).toBe(5);
    expect(pointRendering.points).toHaveLength(2);
  });

  it("renders automatic camera selections progressively", async () => {
    const pointRendering = createRecordingPointRenderer();
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      createPointRenderer: () => pointRendering.renderer,
      coordinateTransforms: () => ({
        toCesium: (x, y, z) => ({
          longitudeDegrees: x,
          latitudeDegrees: y,
          heightMeters: z,
        }),
        toCopc: () => ({
          x: 0,
          y: 0,
          z: 0,
        }),
      }),
    });
    const loadedNodeKeys: string[] = [];
    const progressNodeKeys: string[][] = [];
    const completionCheckNodeKeys: string[][] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy(
        [
          {
            ...createHierarchyNodeWithBounds("1-0-0-0", 1, 0, 0, 1),
            pointCount: 10_000,
            pointDataLength: 10_000,
          },
          {
            ...createHierarchyNodeWithBounds("1-1-0-0", 1, 1, 0, 1),
            pointCount: 1,
            pointDataLength: 1,
          },
        ],
        [],
      );
    layer.source.loadNodePointSamples = async (options = {}) => {
      const nodeKey = options.nodeKey ?? "1-0-0-0";
      loadedNodeKeys.push(nodeKey);

      return createNodePointSampleResult(
        nodeKey,
        nodeKey === "1-0-0-0" ? 1 : 2,
      );
    };

    const result = await layer.renderAutomaticProgressively({
      camera: {
        positionWC: Cartesian3.fromDegrees(0, 0, 1_000),
      } as unknown as Camera,
      viewportHeightPixels: 720,
      minDepth: 1,
      maxDepth: 1,
      maxNodes: 2,
      selectionMode: "coverage",
      targetNodeScreenPixels: 10_000,
      maxActiveProgressiveNodeRequests: 1,
      nodeRequestOrder: "lightweight-first",
      progressBatchNodeCount: 1,
      showBounds: false,
      onProgress: (progressResult) => {
        progressNodeKeys.push([...progressResult.pointSamples.nodeKeys]);
      },
      shouldStopAfterProgress: (progressResult) => {
        completionCheckNodeKeys.push([
          ...progressResult.pointSamples.nodeKeys,
        ]);
        return false;
      },
    });

    expect(loadedNodeKeys).toEqual(["1-1-0-0", "1-0-0-0"]);
    expect(progressNodeKeys).toEqual([
      ["1-1-0-0"],
      ["1-1-0-0", "1-0-0-0"],
    ]);
    expect(completionCheckNodeKeys).toEqual(progressNodeKeys);
    expect(result?.cameraSelection.nodes.map((node) => node.key)).toEqual([
      "1-0-0-0",
      "1-1-0-0",
    ]);
    expect(result?.pointSamples.nodeKeys).toEqual([
      "1-1-0-0",
      "1-0-0-0",
    ]);
    expect(pointRendering.points).toHaveLength(2);
  });

  it("expands hierarchy pages near the current camera", async () => {
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      coordinateTransforms: () => ({
        toCesium: (x, y, z) => ({
          longitudeDegrees: x,
          latitudeDegrees: y,
          heightMeters: z,
        }),
        toCopc: (longitudeDegrees, latitudeDegrees, heightMeters) => ({
          x: longitudeDegrees,
          y: latitudeDegrees,
          z: heightMeters,
        }),
      }),
    });
    const initialHierarchy = createHierarchy([createHierarchyNode("0-0-0-0")], [
      createHierarchyPage("2-0-0-0", 0, 0, 25),
      createHierarchyPage("2-3-3-0", 75, 75, 25),
    ]);
    const expandedHierarchy = createHierarchy([
      createHierarchyNode("0-0-0-0"),
      createHierarchyNode("2-3-3-0"),
    ]);
    let requestedPageKeys: readonly string[] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () => initialHierarchy;
    layer.source.loadHierarchyPages = async (pageKeys) => {
      requestedPageKeys = pageKeys;

      return {
        hierarchy: expandedHierarchy,
        loadedPageKeys: pageKeys,
      };
    };

    const result = await layer.expandHierarchyForCamera({
      camera: {
        positionWC: Cartesian3.fromDegrees(80, 80, 100),
      } as unknown as Camera,
      maxPages: 1,
    });

    expect(result?.loadedPageKeys).toEqual(["2-3-3-0"]);
    expect(requestedPageKeys).toEqual(["2-3-3-0"]);
    expect(layer.hierarchy).toBe(expandedHierarchy);
  });

  it("passes inspection spacing into camera node selection", async () => {
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      coordinateTransforms: () => ({
        toCesium: (x, y, z) => ({
          longitudeDegrees: x,
          latitudeDegrees: y,
          heightMeters: z,
        }),
        toCopc: () => ({
          x: 200,
          y: 10,
          z: 10,
        }),
      }),
    });

    layer.source.inspect = async () => createInspection({ spacing: 64 });
    layer.source.loadHierarchySummary = async () =>
      createHierarchy([
        createHierarchyNodeWithBounds("0-0-0-0", 0, 0, 0, 100),
        createHierarchyNodeWithBounds("1-1-0-0", 1, 50, 0, 50),
        createHierarchyNodeWithBounds("2-3-0-0", 2, 75, 0, 25),
        createHierarchyNodeWithBounds("3-7-0-0", 3, 87.5, 0, 12.5),
      ]);

    const selection = await layer.selectNodesForCamera({
      camera: {
        positionWC: Cartesian3.fromDegrees(0, 0, 100),
      } as unknown as Camera,
      viewportHeightPixels: 720,
      maxNodes: 2,
      targetNodeScreenPixels: 1_000,
      targetPointSpacingScreenPixels: 120,
    });

    expect(selection?.spacing).toBe(64);
    expect(selection?.targetDepth).toBe(2);
    expect(selection?.selectedDepth).toBe(2);
    expect(
      selection?.estimatedSelectedDepthPointSpacingScreenPixels,
    ).toBeCloseTo(115.2);
  });

  it("selects camera nodes around the viewport center pick when available", async () => {
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      coordinateTransforms: () => ({
        toCesium: (x, y, z) => ({
          longitudeDegrees: x,
          latitudeDegrees: y,
          heightMeters: z,
        }),
        toCopc: (longitudeDegrees, latitudeDegrees, heightMeters) => ({
          x: longitudeDegrees,
          y: latitudeDegrees,
          z: heightMeters,
        }),
      }),
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy(
        [
          createHierarchyNodeWithBounds("0-0-0-0", 0, 0, 0, 100),
          createHierarchyNodeWithBounds("1-0-0-0", 1, 0, 0, 1),
          createHierarchyNodeWithBounds("1-1-1-0", 1, 80, 80, 1),
        ],
        [],
      );

    const selection = await layer.selectNodesForCamera({
      camera: createPickingCameraStub(Cartesian3.fromDegrees(80.5, 80.5, 0)),
      viewportWidthPixels: 1000,
      viewportHeightPixels: 720,
      minDepth: 1,
      maxDepth: 1,
      maxNodes: 1,
      targetNodeScreenPixels: 10_000,
    });

    expect(selection?.nodes.map((node) => node.key)).toEqual(["1-1-1-0"]);
  });

  it("expands hierarchy pages around the viewport center pick when available", async () => {
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      coordinateTransforms: () => ({
        toCesium: (x, y, z) => ({
          longitudeDegrees: x,
          latitudeDegrees: y,
          heightMeters: z,
        }),
        toCopc: (longitudeDegrees, latitudeDegrees, heightMeters) => ({
          x: longitudeDegrees,
          y: latitudeDegrees,
          z: heightMeters,
        }),
      }),
    });
    const initialHierarchy = createHierarchy([createHierarchyNode("0-0-0-0")], [
      createHierarchyPage("2-0-0-0", 0, 0, 25),
      createHierarchyPage("2-3-3-0", 75, 75, 25),
    ]);
    const expandedHierarchy = createHierarchy([
      createHierarchyNode("0-0-0-0"),
      createHierarchyNode("2-3-3-0"),
    ]);
    let requestedPageKeys: readonly string[] = [];

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () => initialHierarchy;
    layer.source.loadHierarchyPages = async (pageKeys) => {
      requestedPageKeys = pageKeys;

      return {
        hierarchy: expandedHierarchy,
        loadedPageKeys: pageKeys,
      };
    };

    const result = await layer.expandHierarchyForCamera({
      camera: createPickingCameraStub(Cartesian3.fromDegrees(80, 80, 0)),
      viewportWidthPixels: 1000,
      viewportHeightPixels: 720,
      maxPages: 1,
    });

    expect(result?.loadedPageKeys).toEqual(["2-3-3-0"]);
    expect(requestedPageKeys).toEqual(["2-3-3-0"]);
  });

  it("filters camera node selection through the Cesium frustum", async () => {
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      coordinateTransforms: () => ({
        toCesium: (x, y, z) => ({
          longitudeDegrees: x,
          latitudeDegrees: y,
          heightMeters: z,
        }),
        toCopc: () => ({
          x: 0,
          y: 0,
          z: 0,
        }),
      }),
    });

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy(
        [
          createHierarchyNodeWithBounds("0-0-0-0", 0, -2, 0, 5),
          createHierarchyNodeWithBounds("1-0-0-0", 1, -2, 0, 1),
          createHierarchyNodeWithBounds("1-1-0-0", 1, 1, 0, 1),
          createHierarchyNodeWithBounds("1-1-1-0", 1, 2, 0, 1),
        ],
        [],
      );

    const selection = await layer.selectNodesForCamera({
      camera: createFrustumCameraStub(),
      viewportHeightPixels: 720,
      minDepth: 1,
      maxDepth: 1,
      maxNodes: 4,
      targetNodeScreenPixels: 10_000,
    });

    expect(selection?.skippedByFrustumCount).toBe(1);
    expect(selection?.nodes.map((node) => node.key)).toEqual([
      "1-1-0-0",
      "1-1-1-0",
    ]);
    expect(selection?.reason).toContain(
      "Frustum-culled 1 off-screen candidate nodes.",
    );
  });

  it("limits frustum checks to the requested camera selection depth range", async () => {
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      coordinateTransforms: () => ({
        toCesium: (x, y, z) => ({
          longitudeDegrees: x,
          latitudeDegrees: y,
          heightMeters: z,
        }),
        toCopc: () => ({
          x: 0,
          y: 0,
          z: 0,
        }),
      }),
    });
    let frustumCheckCount = 0;

    layer.source.inspect = async () => createInspection();
    layer.source.loadHierarchySummary = async () =>
      createHierarchy(
        [
          createHierarchyNodeWithBounds("0-0-0-0", 0, 0, 0, 4),
          createHierarchyNodeWithBounds("1-0-0-0", 1, 0, 0, 2),
          createHierarchyNodeWithBounds("1-1-0-0", 1, 2, 0, 2),
          createHierarchyNodeWithBounds("2-0-0-0", 2, 0, 0, 1),
        ],
        [],
      );

    const selection = await layer.selectNodesForCamera({
      camera: createCountingFrustumCameraStub(() => {
        frustumCheckCount += 1;

        return Intersect.INSIDE;
      }),
      viewportHeightPixels: 720,
      maxDepth: 0,
      maxNodes: 4,
      targetNodeScreenPixels: 10_000,
    });

    expect(selection?.nodes.map((node) => node.key)).toEqual(["0-0-0-0"]);
    expect(frustumCheckCount).toBe(1);
  });
});

function patchLayerSource(layer: CopcPointCloudLayer): void {
  layer.source.inspect = async () => createInspection();
  layer.source.loadHierarchySummary = async () => createHierarchy();
  layer.source.loadNodePointSamples = async () => ({
    nodeKey: "0-0-0-0",
    nodePointCount: 1,
    sampledPointCount: 1,
    points: [
      {
        x: 1,
        y: 2,
        z: 3,
        color: {
          red: 10,
          green: 20,
          blue: 30,
        },
      },
    ],
  });
}

function captureLayerBoundsRendering(layer: CopcPointCloudLayer): {
  boundsCoordinate: unknown;
} {
  const captured: {
    boundsCoordinate: unknown;
  } = {
    boundsCoordinate: undefined,
  };
  const mutableLayer = layer as unknown as {
    boundsRenderer: {
      setBounds: (
        bounds: { minX: number; minY: number; minZ: number },
        inspection: CopcInspection,
        transform: CopcToCesiumCoordinateTransform,
      ) => void;
      clear: () => void;
      destroy: () => void;
    };
  };

  mutableLayer.boundsRenderer = {
    setBounds: (bounds, _inspection, transform) => {
      captured.boundsCoordinate = transform(bounds.minX, bounds.minY, bounds.minZ);
    },
    clear: () => undefined,
    destroy: () => undefined,
  };

  return captured;
}

function createRecordingPointRenderer(): {
  readonly renderer: CopcPointCloudRenderer;
  readonly points: readonly PointSample[];
  readonly clearCount: number;
  readonly destroyCount: number;
} {
  const recording: {
    renderer: CopcPointCloudRenderer;
    points: readonly PointSample[];
    clearCount: number;
    destroyCount: number;
  } = {
    renderer: {
      setPoints: (points) => {
        recording.points = points;
      },
      clear: () => {
        recording.clearCount += 1;
      },
      destroy: () => {
        recording.destroyCount += 1;
      },
    },
    points: [],
    clearCount: 0,
    destroyCount: 0,
  };

  return recording;
}

function createRecordingBatchPointRenderer(): {
  readonly renderer: CopcPointCloudBatchRenderer;
  readonly points: readonly PointSample[];
  readonly batches: readonly PointSampleBatch[];
  readonly setPointsCount: number;
  readonly clearCount: number;
  readonly destroyCount: number;
} {
  const recording: {
    renderer: CopcPointCloudBatchRenderer;
    points: readonly PointSample[];
    batches: readonly PointSampleBatch[];
    setPointsCount: number;
    clearCount: number;
    destroyCount: number;
  } = {
    renderer: {
      setPoints: (points) => {
        recording.points = points;
        recording.setPointsCount += 1;
      },
      setPointBatches: (batches) => {
        recording.batches = batches;
      },
      clear: () => {
        recording.clearCount += 1;
      },
      destroy: () => {
        recording.destroyCount += 1;
      },
    },
    points: [],
    batches: [],
    setPointsCount: 0,
    clearCount: 0,
    destroyCount: 0,
  };

  return recording;
}

function createRecordingGeometryBatchPointRenderer(): {
  readonly renderer: CopcPointCloudGeometryBatchRenderer;
  readonly points: readonly PointSample[];
  readonly batches: readonly PointSampleBatch[];
  readonly geometryBatches: readonly PointGeometryBatch[];
  readonly setPointsCount: number;
  readonly setPointBatchesCount: number;
  readonly clearCount: number;
  readonly destroyCount: number;
} {
  const recording: {
    renderer: CopcPointCloudGeometryBatchRenderer;
    points: readonly PointSample[];
    batches: readonly PointSampleBatch[];
    geometryBatches: readonly PointGeometryBatch[];
    setPointsCount: number;
    setPointBatchesCount: number;
    clearCount: number;
    destroyCount: number;
  } = {
    renderer: {
      setPoints: (points) => {
        recording.points = points;
        recording.setPointsCount += 1;
      },
      setPointBatches: (batches) => {
        recording.batches = batches;
        recording.setPointBatchesCount += 1;
      },
      setPointGeometryBatches: (batches) => {
        recording.geometryBatches = batches;
      },
      clear: () => {
        recording.clearCount += 1;
      },
      destroy: () => {
        recording.destroyCount += 1;
      },
    },
    points: [],
    batches: [],
    geometryBatches: [],
    setPointsCount: 0,
    setPointBatchesCount: 0,
    clearCount: 0,
    destroyCount: 0,
  };

  return recording;
}

class FakePointGeometryWorker {
  readonly requests: CesiumPointGeometryWorkerRequest[] = [];
  terminateCount = 0;
  private messageListener:
    | ((event: MessageEvent<CesiumPointGeometryWorkerResponse>) => void)
    | undefined;

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (type !== "message" || typeof listener !== "function") {
      return;
    }

    this.messageListener = listener as (
      event: MessageEvent<CesiumPointGeometryWorkerResponse>,
    ) => void;
  }

  postMessage(message: CesiumPointGeometryWorkerRequest): void {
    this.requests.push(message);

    if (message.type === "cancel") {
      return;
    }

    queueMicrotask(() => {
      this.emit({
        id: message.id,
        type: "buildPointGeometryBatch:success",
        batch: {
          key: message.key,
          pointCount: message.pointData.x.length,
          positions: new Float64Array([7, 8, 9]),
          colors: new Uint8Array([1, 2, 3, 255]),
        },
      });
    });
  }

  terminate(): void {
    this.terminateCount += 1;
    this.messageListener = undefined;
  }

  private emit(response: CesiumPointGeometryWorkerResponse): void {
    this.messageListener?.({
      data: response,
    } as MessageEvent<CesiumPointGeometryWorkerResponse>);
  }
}

class FakePointSampleWorker {
  readonly requests: CopcPointSampleWorkerRequest[] = [];
  terminateCount = 0;
  private messageListener:
    | ((event: MessageEvent<CopcPointSampleWorkerResponse>) => void)
    | undefined;

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

    queueMicrotask(() => {
      this.emit({
        id: message.id,
        type: "loadNodePointSamples:success",
        result: {
          nodeKey: message.nodeKey,
          nodePointCount: message.node.pointCount,
          sampledPointCount: 1,
          points: [
            {
              x: 1,
              y: 2,
              z: 3,
            },
          ],
        },
      });
    });
  }

  terminate(): void {
    this.terminateCount += 1;
    this.messageListener = undefined;
  }

  private emit(response: CopcPointSampleWorkerResponse): void {
    this.messageListener?.({
      data: response,
    } as MessageEvent<CopcPointSampleWorkerResponse>);
  }
}

class CountingCopcPointGeometryWorker {
  readonly requests: CesiumCopcPointGeometryWorkerRequest[] = [];
  terminateCount = 0;
  private messageListener:
    | ((event: MessageEvent<CesiumCopcPointGeometryWorkerResponse>) => void)
    | undefined;

  get loadRequests(): readonly CesiumCopcPointGeometryWorkerRequest[] {
    return this.requests.filter(
      (request) => request.type === "loadNodePointGeometry",
    );
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (type !== "message") {
      return;
    }

    this.messageListener = listener as (
      event: MessageEvent<CesiumCopcPointGeometryWorkerResponse>,
    ) => void;
  }

  postMessage(message: CesiumCopcPointGeometryWorkerRequest): void {
    this.requests.push(message);

    if (message.type === "warmup" || message.type === "cancel") {
      return;
    }

    if (message.type === "prefetchNodePointData") {
      queueMicrotask(() => {
        this.emit({
          id: message.id,
          type: "prefetchNodePointData:success",
          result: {
            nodeKey: message.nodeKey,
          },
        });
      });
      return;
    }

    const pointCount = Math.min(message.node.pointCount, message.maxPointCount);

    queueMicrotask(() => {
      this.emit({
        id: message.id,
        type: "loadNodePointGeometry:success",
        result: {
          pointSamples: {
            nodeKey: message.nodeKey,
            nodePointCount: message.node.pointCount,
            sampledPointCount: pointCount,
            points: [],
          },
          geometryBatch: {
            key: `${message.nodeKey}:${message.node.pointCount}:${pointCount}:${pointCount}`,
            pointCount,
            positions: new Float64Array(pointCount * 3),
            colors: new Uint8Array(pointCount * 4),
          },
          timing: {
            pointDataViewMilliseconds: pointCount * 10,
            pointDataViewCacheHit: false,
            sampleMilliseconds: pointCount,
            geometryMilliseconds: pointCount * 2,
            workerTotalMilliseconds: pointCount * 20,
          },
        },
      });
    });
  }

  terminate(): void {
    this.terminateCount += 1;
    this.messageListener = undefined;
  }

  private emit(response: CesiumCopcPointGeometryWorkerResponse): void {
    this.messageListener?.({
      data: response,
    } as MessageEvent<CesiumCopcPointGeometryWorkerResponse>);
  }
}

class ManualCopcPointGeometryWorker {
  readonly requests: CesiumCopcPointGeometryWorkerRequest[] = [];
  terminateCount = 0;
  private messageListener:
    | ((event: MessageEvent<CesiumCopcPointGeometryWorkerResponse>) => void)
    | undefined;

  get loadRequests(): readonly Extract<
    CesiumCopcPointGeometryWorkerRequest,
    { readonly type: "loadNodePointGeometry" }
  >[] {
    return this.requests.filter(
      (request): request is Extract<
        CesiumCopcPointGeometryWorkerRequest,
        { readonly type: "loadNodePointGeometry" }
      > => request.type === "loadNodePointGeometry",
    );
  }

  get prefetchRequests(): readonly Extract<
    CesiumCopcPointGeometryWorkerRequest,
    { readonly type: "prefetchNodePointData" }
  >[] {
    return this.requests.filter(
      (request): request is Extract<
        CesiumCopcPointGeometryWorkerRequest,
        { readonly type: "prefetchNodePointData" }
      > => request.type === "prefetchNodePointData",
    );
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (type !== "message" || typeof listener !== "function") {
      return;
    }

    this.messageListener = listener as (
      event: MessageEvent<CesiumCopcPointGeometryWorkerResponse>,
    ) => void;
  }

  postMessage(message: CesiumCopcPointGeometryWorkerRequest): void {
    this.requests.push(message);
  }

  terminate(): void {
    this.terminateCount += 1;
    this.messageListener = undefined;
  }

  dispatchSuccess(id: number, nodeKey: string, pointCount: number): void {
    this.emit({
      id,
      type: "loadNodePointGeometry:success",
      result: {
        pointSamples: {
          nodeKey,
          nodePointCount: pointCount,
          sampledPointCount: pointCount,
          points: [],
        },
        geometryBatch: {
          key: `${nodeKey}:${pointCount}:${pointCount}:${pointCount}`,
          pointCount,
          positions: new Float64Array(pointCount * 3),
          colors: new Uint8Array(pointCount * 4),
        },
      },
    });
  }

  dispatchPrefetchSuccess(id: number, nodeKey: string): void {
    this.emit({
      id,
      type: "prefetchNodePointData:success",
      result: {
        nodeKey,
      },
    });
  }

  private emit(response: CesiumCopcPointGeometryWorkerResponse): void {
    this.messageListener?.({
      data: response,
    } as MessageEvent<CesiumCopcPointGeometryWorkerResponse>);
  }
}

class FakeCopcPointGeometryWorker {
  readonly requests: CesiumCopcPointGeometryWorkerRequest[] = [];
  terminateCount = 0;
  private messageListener:
    | ((event: MessageEvent<CesiumCopcPointGeometryWorkerResponse>) => void)
    | undefined;

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (type !== "message" || typeof listener !== "function") {
      return;
    }

    this.messageListener = listener as (
      event: MessageEvent<CesiumCopcPointGeometryWorkerResponse>,
    ) => void;
  }

  postMessage(message: CesiumCopcPointGeometryWorkerRequest): void {
    this.requests.push(message);

    if (message.type === "warmup") {
      queueMicrotask(() => {
        this.emit({
          id: message.id,
          type: "warmup:success",
        });
      });
      return;
    }

    if (message.type === "cancel") {
      return;
    }

    if (message.type === "prefetchNodePointData") {
      queueMicrotask(() => {
        this.emit({
          id: message.id,
          type: "prefetchNodePointData:success",
          result: {
            nodeKey: message.nodeKey,
          },
        });
      });
      return;
    }

    queueMicrotask(() => {
      this.emit({
        id: message.id,
        type: "loadNodePointGeometry:success",
        result: {
          pointSamples: {
            nodeKey: message.nodeKey,
            nodePointCount: 1,
            sampledPointCount: 1,
            points: [],
          },
          geometryBatch: {
            key: `${message.nodeKey}:1:1:1`,
            pointCount: 1,
            positions: new Float64Array([11, 12, 13]),
            colors: new Uint8Array([1, 2, 3, 255]),
          },
        },
      });
    });
  }

  terminate(): void {
    this.terminateCount += 1;
    this.messageListener = undefined;
  }

  private emit(response: CesiumCopcPointGeometryWorkerResponse): void {
    this.messageListener?.({
      data: response,
    } as MessageEvent<CesiumCopcPointGeometryWorkerResponse>);
  }
}

function createSceneStub(): Scene {
  return {
    primitives: {
      add: <T>(primitive: T): T => primitive,
      remove: () => true,
    },
  } as unknown as Scene;
}

function createFrustumCameraStub(): Camera {
  return {
    positionWC: Cartesian3.fromDegrees(0, 0, 1_000),
    directionWC: new Cartesian3(0, 1, 0),
    upWC: new Cartesian3(0, 0, 1),
    frustum: {
      computeCullingVolume: () => ({
        computeVisibility: (boundingSphere: { readonly center: Cartesian3 }) =>
          boundingSphere.center.y >= 0 ? Intersect.INSIDE : Intersect.OUTSIDE,
      }),
    },
  } as unknown as Camera;
}

function createCountingFrustumCameraStub(
  computeVisibility: () => Intersect,
): Camera {
  return {
    positionWC: Cartesian3.fromDegrees(0, 0, 1_000),
    directionWC: new Cartesian3(0, 1, 0),
    upWC: new Cartesian3(0, 0, 1),
    frustum: {
      computeCullingVolume: () => ({
        computeVisibility,
      }),
    },
  } as unknown as Camera;
}

function createPickingCameraStub(pickedCenter: Cartesian3 | undefined): Camera {
  return {
    positionWC: Cartesian3.fromDegrees(0, 0, 1_000),
    pickEllipsoid: () => pickedCenter,
  } as unknown as Camera;
}

function createInspection(
  options: {
    readonly spacing?: number;
  } = {},
): CopcInspection {
  return {
    sourceUrl: "https://example.com/sample.copc.laz",
    pointCount: 1,
    lasVersion: "1.4",
    pointDataRecordFormat: 7,
    pointDataRecordLength: 36,
    bounds: createBounds(),
    cube: createBounds(),
    scale: [1, 1, 1],
    offset: [0, 0, 0],
    spacing: options.spacing ?? 1,
    gpsTimeRange: [0, 0],
    rootHierarchyPage: {
      pageOffset: 0,
      pageLength: 0,
    },
    vlrs: [],
    wkt: null,
  };
}

function createNodePointSampleResult(
  nodeKey: string,
  x: number,
): CopcNodePointSampleResult {
  return {
    nodeKey,
    nodePointCount: 1,
    sampledPointCount: 1,
    points: [
      {
        x,
        y: 0,
        z: 0,
      },
    ],
  };
}

function createNodePointSampleResultWithCount(
  nodeKey: string,
  firstX: number,
  sampledPointCount: number,
): CopcNodePointSampleResult {
  return {
    nodeKey,
    nodePointCount: sampledPointCount,
    sampledPointCount,
    points: Array.from({ length: sampledPointCount }, (_value, index) => ({
      x: firstX + index,
      y: 0,
      z: 0,
    })),
  };
}

function createTypedNodePointSampleResult(
  nodeKey: string,
  x: number,
): CopcNodePointSampleResult {
  return {
    nodeKey,
    nodePointCount: 1,
    sampledPointCount: 1,
    points: [],
    pointData: {
      x: new Float64Array([x]),
      y: new Float64Array([0]),
      z: new Float64Array([0]),
      red: new Uint8Array([1]),
      green: new Uint8Array([2]),
      blue: new Uint8Array([3]),
    },
  };
}

function createHierarchy(
  nodes: readonly CopcHierarchySummary["nodes"][number][] = [
    createHierarchyNode("0-0-0-0"),
  ],
  pendingPages: readonly CopcHierarchySummary["pendingPages"][number][] = [
    createHierarchyPage("1-0-0-0", 0, 0, 1),
  ],
): CopcHierarchySummary {
  return {
    pageCount: pendingPages.length,
    loadedPageCount: 1,
    pendingPageCount: pendingPages.length,
    pendingPages,
    nodes,
  };
}

async function waitForProgressCount(
  progressNodeKeys: readonly string[][],
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (progressNodeKeys.length >= expectedCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Timed out waiting for ${expectedCount} progress renders.`);
}

async function waitForResolverCount(
  resolvers: ReadonlyMap<string, unknown>,
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (resolvers.size >= expectedCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Timed out waiting for ${expectedCount} point requests.`);
}

async function waitForCopcGeometryWorkerRequestCount(
  worker: { readonly loadRequests: readonly unknown[] },
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (worker.loadRequests.length >= expectedCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(
    `Timed out waiting for ${expectedCount} COPC geometry worker requests.`,
  );
}

async function waitForCopcGeometryBatchCacheCount(
  layer: CopcPointCloudLayer,
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      layer.getPointGeometryCacheStats().cachedLoadedBatchCount >=
      expectedCount
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(
    `Timed out waiting for ${expectedCount} cached COPC geometry batches.`,
  );
}

async function waitForCopcGeometryWorkerPrefetchRequestCount(
  workers: readonly {
    readonly prefetchRequests: readonly unknown[];
  }[],
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const requestCount = workers.reduce(
      (count, worker) => count + worker.prefetchRequests.length,
      0,
    );

    if (requestCount >= expectedCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(
    `Timed out waiting for ${expectedCount} COPC geometry worker prefetch requests.`,
  );
}

async function waitForCopcGeometryWorkerLoadRequestCount(
  workers: readonly {
    readonly loadRequests: readonly unknown[];
  }[],
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (countCopcGeometryWorkerLoadRequests(workers) >= expectedCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(
    `Timed out waiting for ${expectedCount} COPC geometry worker load requests.`,
  );
}

function countCopcGeometryWorkerLoadRequests(
  workers: readonly {
    readonly loadRequests: readonly unknown[];
  }[],
): number {
  return workers.reduce(
    (count, worker) => count + worker.loadRequests.length,
    0,
  );
}

function dispatchLatestCopcGeometryWorkerSuccess(
  workers: readonly ManualCopcPointGeometryWorker[],
  pointCount: number,
): void {
  const worker = [...workers]
    .reverse()
    .find((candidate) => candidate.loadRequests.length > 0);
  const request = worker?.loadRequests.at(-1);

  if (!worker || !request) {
    throw new Error("Expected a COPC geometry worker load request.");
  }

  worker.dispatchSuccess(request.id, request.nodeKey, pointCount);
}

async function waitForPointGeometryCacheMissCount(
  layer: CopcPointCloudLayer,
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      layer.getPointGeometryCacheStats().loadedBatchCacheMissCount >=
      expectedCount
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(
    `Timed out waiting for ${expectedCount} point geometry cache misses.`,
  );
}

function createHierarchyNode(key: string): CopcHierarchySummary["nodes"][number] {
  const [depth, x, y, z] = key.split("-").map(Number);

  return {
    key,
    depth: depth ?? 0,
    x: x ?? 0,
    y: y ?? 0,
    z: z ?? 0,
    bounds: createBounds(),
    pointCount: 1,
    pointDensity: 1,
    pointDataOffset: 0,
    pointDataLength: 10,
  };
}

function createHierarchyNodeWithBounds(
  key: string,
  depth: number,
  minX: number,
  minY: number,
  size: number,
): CopcHierarchySummary["nodes"][number] {
  const [, x, y, z] = key.split("-").map(Number);

  return {
    key,
    depth,
    x: x ?? 0,
    y: y ?? 0,
    z: z ?? 0,
    bounds: {
      minX,
      minY,
      minZ: 0,
      maxX: minX + size,
      maxY: minY + size,
      maxZ: size,
    },
    pointCount: 1,
    pointDensity: 1,
    pointDataOffset: 0,
    pointDataLength: 10,
  };
}

function createHierarchyPage(
  key: string,
  minX: number,
  minY: number,
  size: number,
): CopcHierarchySummary["pendingPages"][number] {
  const [depth, x, y, z] = key.split("-").map(Number);

  return {
    key,
    depth: depth ?? 0,
    x: x ?? 0,
    y: y ?? 0,
    z: z ?? 0,
    bounds: {
      minX,
      minY,
      minZ: 0,
      maxX: minX + size,
      maxY: minY + size,
      maxZ: size,
    },
    pageOffset: minX,
    pageLength: size,
  };
}

function createBounds(): CopcInspection["bounds"] {
  return {
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: 1,
    maxY: 1,
    maxZ: 1,
  };
}
