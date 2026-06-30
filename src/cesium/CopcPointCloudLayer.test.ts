import { Cartesian3, type Camera, type Scene } from "cesium";
import { describe, expect, it } from "vitest";
import type {
  CopcHierarchySummary,
  CopcInspection,
  PointSample,
} from "../core";
import { CopcPointCloudLayer } from "./CopcPointCloudLayer";
import type {
  CopcCoordinateTransformStatus,
  CopcToCesiumCoordinateTransform,
} from "./copcCoordinateTransform";

describe("CopcPointCloudLayer coordinate transforms", () => {
  it("passes the point sample cache limit to the owned COPC source", () => {
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      maxCachedSampleSets: 3,
    });

    expect(layer.source.getPointSampleCacheStats().maxCachedSampleSetCount).toBe(
      3,
    );

    layer.destroy();
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
    const layer = new CopcPointCloudLayer(createSceneStub(), {
      url: "https://example.com/sample.copc.laz",
      coordinateTransforms: () => ({
        toCesium: (x, y, z) => ({
          longitudeDegrees: x + 100,
          latitudeDegrees: y + 200,
          heightMeters: z + 300,
        }),
      }),
    });
    const rendered = captureLayerRendering(layer);

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
    expect(rendered.points).toEqual(result.points);
    expect(rendered.boundsCoordinate).toEqual({
      longitudeDegrees: 100,
      latitudeDegrees: 200,
      heightMeters: 300,
    });
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

function captureLayerRendering(layer: CopcPointCloudLayer): {
  boundsCoordinate: unknown;
  points: readonly PointSample[];
} {
  const captured: {
    boundsCoordinate: unknown;
    points: readonly PointSample[];
  } = {
    boundsCoordinate: undefined,
    points: [],
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
    pointRenderer: {
      setPoints: (points: readonly PointSample[]) => void;
      clear: () => void;
      destroy: () => void;
    };
  };

  mutableLayer.pointRenderer = {
    setPoints: (points) => {
      captured.points = points;
    },
    clear: () => undefined,
    destroy: () => undefined,
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

function createSceneStub(): Scene {
  return {
    primitives: {
      add: <T>(primitive: T): T => primitive,
      remove: () => true,
    },
  } as unknown as Scene;
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
