import { describe, expect, it } from "vitest";
import type {
  CopcHierarchyNodeSummary,
  CopcHierarchySummary,
} from "../core/copc/CopcHierarchySummary";
import type { CopcNodePointSampleResult } from "../core/copc/CopcPointDataSample";
import type { CopcNodePointGeometryBatchResult } from "./CesiumCopcPointGeometryWorkerProtocol";
import {
  allocateProgressEntryPointCounts,
  createProgressPointGeometryResults,
  limitNodePointSampleResult,
  limitNodeSampleProgressEntries,
  limitPointGeometryBatchResult,
} from "./progressivePointResultBudget";

describe("progressive point result budgeting", () => {
  it("distributes a constrained budget fairly across active entries", () => {
    expect(
      allocateProgressEntryPointCounts(
        [10, 10, 10],
        8,
        undefined,
        undefined,
      ),
    ).toEqual([3, 3, 2]);
  });

  it("applies per-node caps before allocating the total budget", () => {
    expect(
      allocateProgressEntryPointCounts([10, 2, 10], undefined, 5, undefined),
    ).toEqual([5, 2, 5]);
  });

  it("allocates a global render budget by aligned source-point weights", () => {
    expect(
      allocateProgressEntryPointCounts(
        [100, 100],
        40,
        100,
        undefined,
        [1, 3],
      ),
    ).toEqual([10, 30]);
  });

  it("redistributes weighted budget left over by an exhausted small entry", () => {
    expect(
      allocateProgressEntryPointCounts(
        [5, 100],
        40,
        100,
        undefined,
        [1, 3],
      ),
    ).toEqual([5, 35]);
  });

  it("uses the same weighted allocation for object, typed, and geometry entries", () => {
    const nodes = [createNode("0-0-0-0"), createNode("1-0-0-0")];
    const objectEntries = limitNodeSampleProgressEntries(
      nodes.map((node) => ({
        node,
        nodeResult: createObjectSampleResult(node.key, 4),
      })),
      4,
      4,
      undefined,
      [1, 3],
    );
    const typedEntries = limitNodeSampleProgressEntries(
      nodes.map((node) => ({
        node,
        nodeResult: createTypedSampleResult(node.key, 4),
      })),
      4,
      4,
      undefined,
      [1, 3],
    );
    const geometry = createProgressPointGeometryResults({
      backgroundGeometryResults: [],
      hierarchy: createHierarchy(nodes),
      nodes,
      geometryResults: nodes.map((node) => createGeometryResult(node.key, 4)),
      initialGeometryResults: [],
      includeBackground: false,
      maxRenderedPointCount: 4,
      maxPointCountPerNode: 4,
      nodePointCountWeights: [1, 3],
    });

    expect(
      objectEntries.map((entry) => entry.nodeResult.sampledPointCount),
    ).toEqual([1, 3]);
    expect(
      typedEntries.map((entry) => entry.nodeResult.sampledPointCount),
    ).toEqual([1, 3]);
    expect(
      geometry.geometryResults.map((result) => result.geometryBatch.pointCount),
    ).toEqual([1, 3]);
  });

  it("allocates foreground coverage before background detail", () => {
    const foregroundNodes = [createNode("0-0-0-0"), createNode("1-0-0-0")];
    const backgroundNodes = [createNode("2-0-0-0"), createNode("2-1-0-0")];
    const hierarchy = createHierarchy([...foregroundNodes, ...backgroundNodes]);
    const result = createProgressPointGeometryResults({
      backgroundGeometryResults: backgroundNodes.map((node) =>
        createGeometryResult(node.key, 4),
      ),
      hierarchy,
      nodes: foregroundNodes,
      geometryResults: foregroundNodes.map((node) =>
        createGeometryResult(node.key, 4),
      ),
      initialGeometryResults: [],
      includeBackground: true,
      maxRenderedPointCount: 10,
      maxPointCountPerNode: 4,
    });

    expect(result.nodes.map((node) => node.key)).toEqual([
      "0-0-0-0",
      "1-0-0-0",
      "2-0-0-0",
      "2-1-0-0",
    ]);
    expect(
      result.geometryResults.map(
        (geometryResult) => geometryResult.geometryBatch.pointCount,
      ),
    ).toEqual([4, 4, 1, 1]);
  });

  it("keeps available foreground samples ahead of background samples", () => {
    const foregroundNodes = [createNode("0-0-0-0"), createNode("1-0-0-0")];
    const backgroundNode = createNode("2-0-0-0");
    const entries = limitNodeSampleProgressEntries(
      [
        {
          node: foregroundNodes[0],
          nodeResult: createObjectSampleResult(foregroundNodes[0].key, 4),
        },
        {
          node: foregroundNodes[1],
          nodeResult: createObjectSampleResult(foregroundNodes[1].key, 4),
        },
        {
          node: backgroundNode,
          nodeResult: createObjectSampleResult(backgroundNode.key, 4),
        },
      ],
      6,
      undefined,
      2,
    );

    expect(entries.map((entry) => entry.node.key)).toEqual([
      "0-0-0-0",
      "1-0-0-0",
    ]);
    expect(entries.map((entry) => entry.nodeResult.sampledPointCount)).toEqual([
      3, 3,
    ]);
  });
});

describe("progressive point result limiting", () => {
  it("limits object samples to a stable nested prefix", () => {
    const result = createObjectSampleResult("object-node", 3);

    const limited = limitNodePointSampleResult(result, 2);

    expect(limited.sampledPointCount).toBe(2);
    expect(limited.points).toEqual([result.points[0], result.points[1]]);
    expect(limited.pointData).toBeUndefined();
  });

  it("limits every typed sample channel consistently", () => {
    const result = createTypedSampleResult("typed-node", 4);

    const limited = limitNodePointSampleResult(result, 2);

    expect(limited.sampledPointCount).toBe(2);
    expect(limited.points).toEqual([]);
    expect(readPointDataArrays(limited)).toEqual({
      x: [0, 1],
      y: [10, 11],
      z: [20, 21],
      red: [30, 31],
      green: [40, 41],
      blue: [50, 51],
      classification: [2, 6],
      intensity: [100, 200],
    });
  });

  it("limits geometry and sample payloads to one shared count", () => {
    const result = createGeometryResult("geometry-node", 4);

    const limited = limitPointGeometryBatchResult(result, 2, false);

    expect(limited.pointSamples.sampledPointCount).toBe(2);
    expect(limited.geometryBatch).toEqual({
      key: "geometry-node:4:2:2",
      pointCount: 2,
      positions: new Float64Array([0, 1, 2, 3, 4, 5]),
      colors: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
    });
    expect(limited.timing).toBe(result.timing);
  });

  it("keeps lower point budgets as prefixes and updates adaptive density", () => {
    const result = createGeometryResult("nested-node", 4);
    const geometryBatch = {
      ...result.geometryBatch,
      pointSpacingMeters: 2,
      pointDensityScale: 0.5,
    };
    const dense = limitPointGeometryBatchResult(
      { ...result, geometryBatch },
      3,
      false,
    );
    const sparse = limitPointGeometryBatchResult(
      { ...result, geometryBatch },
      2,
      false,
    );

    expect([...sparse.geometryBatch.positions]).toEqual(
      [...dense.geometryBatch.positions].slice(0, 6),
    );
    expect([...sparse.geometryBatch.colors]).toEqual(
      [...dense.geometryBatch.colors].slice(0, 8),
    );
    expect(sparse.geometryBatch.pointSpacingMeters).toBe(2);
    expect(sparse.geometryBatch.pointDensityScale).toBe(0.25);
  });

  it("marks reused geometry as a cache hit without mutating its payload", () => {
    const result = createGeometryResult("cached-node", 2);

    const limited = limitPointGeometryBatchResult(result, 2, true);

    expect(limited.pointSamples).toBe(result.pointSamples);
    expect(limited.geometryBatch).toBe(result.geometryBatch);
    expect(limited.timing).toEqual({
      pointDataViewMilliseconds: 0,
      pointDataViewCacheHit: true,
      sampleMilliseconds: 0,
      geometryMilliseconds: 0,
      workerTotalMilliseconds: 0,
      requestQueueMilliseconds: 0,
      requestRoundTripMilliseconds: 0,
    });
  });
});

function createNode(key: string): CopcHierarchyNodeSummary {
  return {
    key,
    depth: Number(key.split("-")[0]),
    x: 0,
    y: 0,
    z: 0,
    bounds: {
      minX: 0,
      minY: 0,
      minZ: 0,
      maxX: 1,
      maxY: 1,
      maxZ: 1,
    },
    pointCount: 4,
    pointDensity: 1,
    pointDataOffset: 0,
    pointDataLength: 100,
  };
}

function createHierarchy(
  nodes: readonly CopcHierarchyNodeSummary[],
): CopcHierarchySummary {
  return {
    nodes,
    pendingPages: [],
    pageCount: 1,
    loadedPageCount: 1,
    pendingPageCount: 0,
  };
}

function createObjectSampleResult(
  nodeKey: string,
  pointCount: number,
): CopcNodePointSampleResult {
  return {
    nodeKey,
    nodePointCount: pointCount,
    sampledPointCount: pointCount,
    points: Array.from({ length: pointCount }, (_value, index) => ({
      x: index,
      y: index + 10,
      z: index + 20,
      classification: index,
      intensity: index * 100,
    })),
  };
}

function createTypedSampleResult(
  nodeKey: string,
  pointCount: number,
): CopcNodePointSampleResult {
  return {
    nodeKey,
    nodePointCount: pointCount,
    sampledPointCount: pointCount,
    points: [],
    pointData: {
      x: new Float64Array([0, 1, 2, 3].slice(0, pointCount)),
      y: new Float64Array([10, 11, 12, 13].slice(0, pointCount)),
      z: new Float64Array([20, 21, 22, 23].slice(0, pointCount)),
      red: new Uint8Array([30, 31, 32, 33].slice(0, pointCount)),
      green: new Uint8Array([40, 41, 42, 43].slice(0, pointCount)),
      blue: new Uint8Array([50, 51, 52, 53].slice(0, pointCount)),
      classification: new Uint8Array([2, 6, 9, 11].slice(0, pointCount)),
      intensity: new Uint16Array([100, 200, 300, 400].slice(0, pointCount)),
    },
  };
}

function createGeometryResult(
  nodeKey: string,
  pointCount: number,
): CopcNodePointGeometryBatchResult {
  return {
    pointSamples: createTypedSampleResult(nodeKey, pointCount),
    geometryBatch: {
      key: `${nodeKey}:${pointCount}`,
      pointCount,
      positions: Float64Array.from(
        { length: pointCount * 3 },
        (_value, index) => index,
      ),
      colors: Uint8Array.from(
        { length: pointCount * 4 },
        (_value, index) => index,
      ),
    },
    timing: {
      pointDataViewMilliseconds: 1,
      pointDataViewCacheHit: false,
      sampleMilliseconds: 2,
      geometryMilliseconds: 3,
      workerTotalMilliseconds: 6,
      requestQueueMilliseconds: 4,
      requestRoundTripMilliseconds: 10,
    },
  };
}

function readPointDataArrays(result: CopcNodePointSampleResult): object {
  const pointData = result.pointData;

  if (!pointData) {
    throw new Error("Expected typed point data.");
  }

  return {
    x: [...pointData.x],
    y: [...pointData.y],
    z: [...pointData.z],
    red: pointData.red ? [...pointData.red] : undefined,
    green: pointData.green ? [...pointData.green] : undefined,
    blue: pointData.blue ? [...pointData.blue] : undefined,
    classification: pointData.classification
      ? [...pointData.classification]
      : undefined,
    intensity: pointData.intensity ? [...pointData.intensity] : undefined,
  };
}
