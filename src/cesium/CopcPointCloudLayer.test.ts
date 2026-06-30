import type { Scene } from "cesium";
import { describe, expect, it } from "vitest";
import type {
  CopcHierarchySummary,
  CopcInspection,
  PointSample,
} from "../core";
import { CopcPointCloudLayer } from "./CopcPointCloudLayer";
import type { CopcToCesiumCoordinateTransform } from "./copcCoordinateTransform";

describe("CopcPointCloudLayer coordinate transforms", () => {
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

function createInspection(): CopcInspection {
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
    spacing: 1,
    gpsTimeRange: [0, 0],
    rootHierarchyPage: {
      pageOffset: 0,
      pageLength: 0,
    },
    vlrs: [],
    wkt: null,
  };
}

function createHierarchy(): CopcHierarchySummary {
  return {
    pageCount: 1,
    nodes: [
      {
        key: "0-0-0-0",
        depth: 0,
        x: 0,
        y: 0,
        z: 0,
        bounds: createBounds(),
        pointCount: 1,
        pointDensity: 1,
        pointDataOffset: 0,
        pointDataLength: 10,
      },
    ],
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
