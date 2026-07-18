import { Cartesian3 } from "cesium";
import { describe, expect, it } from "vitest";
import type { CopcInspection } from "../core";
import type { CopcNodePointSampleResult } from "../core/copc/CopcPointDataSample";
import {
  createCesiumPointGeometryTransform,
  createPointGeometryBatchFromCopc,
  createPointGeometryBatchFromSerializableTransform,
  estimateCopcNodePointSpacingMeters,
  estimatePointGeometryBatchByteSize,
  getPointGeometryBatchBackingBuffers,
  withCopcPointGeometryBatchRenderMetadata,
} from "./pointGeometryBatch";
import {
  createDefaultCopcCoordinateTransforms,
  createProj4CoordinateTransforms,
  type CopcCoordinateTransformStatus,
} from "./copcCoordinateTransform";

describe("point geometry batch creation", () => {
  it("measures distinct geometry backing buffers instead of typed array views", () => {
    const sharedBuffer = new ArrayBuffer(64);
    const sharedBatch = {
      key: "shared",
      pointCount: 2,
      positions: new Float64Array(sharedBuffer, 0, 6),
      colors: new Uint8Array(sharedBuffer, 48, 8),
    };
    const separateBatch = {
      key: "separate",
      pointCount: 2,
      positions: new Float64Array(6),
      colors: new Uint8Array(8),
    };

    expect(getPointGeometryBatchBackingBuffers(sharedBatch)).toEqual([
      sharedBuffer,
    ]);
    expect(estimatePointGeometryBatchByteSize(sharedBatch)).toBe(64);
    expect(estimatePointGeometryBatchByteSize(separateBatch)).toBe(56);
  });

  it("matches Cesium Cartesian positions for geographic coordinates", () => {
    const inspection = createGeographicInspection();
    const transforms = createDefaultCopcCoordinateTransforms(inspection);
    const result = createPointGeometryBatchFromCopc(
      createTypedNodePointSampleResult(),
      transforms.toCesium,
    );
    const expected = Cartesian3.fromDegrees(127, 37, 10);

    expect(result.positions[0]).toBeCloseTo(expected.x, 6);
    expect(result.positions[1]).toBeCloseTo(expected.y, 6);
    expect(result.positions[2]).toBeCloseTo(expected.z, 6);
    expect(result.colors).toEqual(new Uint8Array([10, 20, 30, 255]));
    expect(result.positionBounds).toEqual({
      minX: result.positions[0],
      minY: result.positions[1],
      minZ: result.positions[2],
      maxX: result.positions[0],
      maxY: result.positions[1],
      maxZ: result.positions[2],
    });
    expect(result.hasTranslucentColors).toBe(false);
  });

  it("uses classification colors when RGB is unavailable", () => {
    const inspection = createGeographicInspection();
    const transforms = createDefaultCopcCoordinateTransforms(inspection);
    const result = createPointGeometryBatchFromCopc(
      {
        nodeKey: "0-0-0-0",
        nodePointCount: 1,
        sampledPointCount: 1,
        points: [],
        pointData: {
          x: new Float64Array([127]),
          y: new Float64Array([37]),
          z: new Float64Array([10]),
          classification: new Uint8Array([2]),
          intensity: new Uint16Array([65_535]),
        },
      },
      transforms.toCesium,
    );

    expect(result.colors).toEqual(new Uint8Array([166, 124, 82, 255]));
  });

  it("builds the same batch from a serializable geographic transform", () => {
    const transform = createCesiumPointGeometryTransform(
      createGeographicInspection(),
      {
        kind: "geographic",
        label: "Geographic coordinates",
        supportsCameraSelection: true,
      } satisfies CopcCoordinateTransformStatus,
    );

    if (!transform) {
      throw new Error("Expected a serializable point geometry transform.");
    }

    const result = createPointGeometryBatchFromSerializableTransform({
      key: "0-0-0-0:1:1:1",
      pointData: createTypedNodePointSampleResult().pointData!,
      transform,
    });
    const expected = Cartesian3.fromDegrees(127, 37, 10);

    expect(result.positions[0]).toBeCloseTo(expected.x, 6);
    expect(result.positions[1]).toBeCloseTo(expected.y, 6);
    expect(result.positions[2]).toBeCloseTo(expected.z, 6);
    expect(result.colors).toEqual(new Uint8Array([10, 20, 30, 255]));
  });

  it("applies the resolved elevation style with a serializable transform", () => {
    const result = createPointGeometryBatchFromSerializableTransform({
      key: "0-0-0-0:3:3:3",
      pointData: {
        x: new Float64Array([127, 127, 127]),
        y: new Float64Array([37, 37, 37]),
        z: new Float64Array([0, 50, 100]),
        red: new Uint8Array([255, 255, 255]),
        green: new Uint8Array([0, 0, 0]),
        blue: new Uint8Array([0, 0, 0]),
      },
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
      pointColorStyle: {
        mode: "elevation",
        minimumZ: 0,
        inverseZRange: 0.01,
      },
    });

    expect(result.colors).toEqual(
      new Uint8Array([
        68, 1, 84, 255,
        38, 144, 137, 255,
        253, 231, 37, 255,
      ]),
    );
  });

  it("approximates EPSG:2992 serializable transforms near exact projected coordinates", () => {
    const inspection = createEpsg2992Inspection();
    const transform = createCesiumPointGeometryTransform(inspection, {
      kind: "epsg:2992",
      label: "EPSG:2992 to WGS84",
      supportsCameraSelection: true,
    } satisfies CopcCoordinateTransformStatus);

    if (!transform) {
      throw new Error("Expected a serializable point geometry transform.");
    }

    const pointData = {
      x: new Float64Array([4_245_000, 4_245_120]),
      y: new Float64Array([880_000, 880_080]),
      z: new Float64Array([100, 110]),
      red: new Uint8Array([10, 40]),
      green: new Uint8Array([20, 50]),
      blue: new Uint8Array([30, 60]),
    };
    const result = createPointGeometryBatchFromSerializableTransform({
      key: "0-0-0-0:2:2:2",
      pointData,
      transform,
    });
    const exactTransforms = createDefaultCopcCoordinateTransforms(inspection);

    for (let pointIndex = 0; pointIndex < pointData.x.length; pointIndex += 1) {
      const exactCoordinate = exactTransforms.toCesium(
        pointData.x[pointIndex],
        pointData.y[pointIndex],
        pointData.z[pointIndex],
      );
      const expected = Cartesian3.fromDegrees(
        exactCoordinate.longitudeDegrees,
        exactCoordinate.latitudeDegrees,
        exactCoordinate.heightMeters,
      );
      const offset = pointIndex * 3;

      expect(Math.abs(result.positions[offset] - expected.x)).toBeLessThan(0.5);
      expect(Math.abs(result.positions[offset + 1] - expected.y)).toBeLessThan(
        0.5,
      );
      expect(Math.abs(result.positions[offset + 2] - expected.z)).toBeLessThan(
        0.5,
      );
    }
  });

  it("approximates serializable proj4 transforms near exact projected coordinates", () => {
    const inspection = createUtmInspection();
    const sourceDefinition =
      "+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs";
    const transform = createCesiumPointGeometryTransform(inspection, {
      kind: "custom",
      label: "EPSG:32611 to WGS84",
      supportsCameraSelection: true,
      sourceCrs: "EPSG:32611",
      sourceDefinition,
      targetCrs: "EPSG:4326",
      heightScaleToMeters: 1,
    } satisfies CopcCoordinateTransformStatus);

    if (!transform) {
      throw new Error("Expected a serializable proj4 point geometry transform.");
    }

    const pointData = {
      x: new Float64Array([381_000, 381_120]),
      y: new Float64Array([3_764_000, 3_764_080]),
      z: new Float64Array([20, 30]),
      red: new Uint8Array([10, 40]),
      green: new Uint8Array([20, 50]),
      blue: new Uint8Array([30, 60]),
    };
    const result = createPointGeometryBatchFromSerializableTransform({
      key: "0-0-0-0:2:2:2",
      pointData,
      transform,
    });
    const exactTransforms = createProj4CoordinateTransforms({
      sourceCrs: "EPSG:32611",
      sourceDefinition,
      label: "EPSG:32611 to WGS84",
    })(inspection);

    for (let pointIndex = 0; pointIndex < pointData.x.length; pointIndex += 1) {
      const exactCoordinate = exactTransforms.toCesium(
        pointData.x[pointIndex],
        pointData.y[pointIndex],
        pointData.z[pointIndex],
      );
      const expected = Cartesian3.fromDegrees(
        exactCoordinate.longitudeDegrees,
        exactCoordinate.latitudeDegrees,
        exactCoordinate.heightMeters,
      );
      const offset = pointIndex * 3;

      expect(Math.abs(result.positions[offset] - expected.x)).toBeLessThan(0.5);
      expect(Math.abs(result.positions[offset + 1] - expected.y)).toBeLessThan(
        0.5,
      );
      expect(Math.abs(result.positions[offset + 2] - expected.z)).toBeLessThan(
        0.5,
      );
    }
  });

  it("uses a WKT source definition for serializable worker geometry", () => {
    const inspection = createUtmInspection();
    const sourceDefinition =
      'PROJCS["WGS 84 / UTM zone 11N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-117],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","32611"]]';
    const transform = createCesiumPointGeometryTransform(inspection, {
      kind: "wkt",
      label: "EPSG:32611 WKT to WGS84",
      supportsCameraSelection: true,
      sourceCrs: "EPSG:32611",
      sourceDefinition,
      targetCrs: "EPSG:4326",
      heightScaleToMeters: 1,
    } satisfies CopcCoordinateTransformStatus);

    if (!transform) {
      throw new Error("Expected a serializable WKT point geometry transform.");
    }

    const result = createPointGeometryBatchFromSerializableTransform({
      key: "0-0-0-0:2:2:2:wkt",
      pointData: {
        x: new Float64Array([381_000, 381_120]),
        y: new Float64Array([3_764_000, 3_764_080]),
        z: new Float64Array([20, 30]),
      },
      transform,
    });

    expect(result.positions).toHaveLength(6);
    expect([...result.positions].every(Number.isFinite)).toBe(true);
  });

  it("derives adaptive render spacing in meters and records sampling density", () => {
    const inspection = {
      ...createGeographicInspection(),
      spacing: 8,
    };
    const node = {
      key: "2-0-0-0",
      depth: 2,
      x: 0,
      y: 0,
      z: 0,
      bounds: {
        minX: 0,
        minY: 0,
        minZ: 0,
        maxX: 100,
        maxY: 100,
        maxZ: 10,
      },
      pointCount: 100,
      pointDensity: 1,
      pointDataOffset: 0,
      pointDataLength: 1_000,
    };
    const coordinateTransform = (x: number, y: number, z: number) => ({
      longitudeDegrees: x / 111_319.49079327357,
      latitudeDegrees: y / 110_574.2727,
      heightMeters: z,
    });
    const batch = {
      key: "2-0-0-0:25",
      pointCount: 25,
      positions: new Float64Array(75),
      colors: new Uint8Array(100),
    };

    expect(
      estimateCopcNodePointSpacingMeters(
        inspection,
        node,
        coordinateTransform,
      ),
    ).toBeCloseTo(2, 2);
    expect(
      withCopcPointGeometryBatchRenderMetadata({
        batch,
        inspection,
        node,
        coordinateTransform,
      }),
    ).toMatchObject({
      key: batch.key,
      pointCount: batch.pointCount,
      pointSpacingMeters: expect.closeTo(2, 2),
      pointDensityScale: 0.25,
    });

    const metadataWithoutSpacing = withCopcPointGeometryBatchRenderMetadata({
      batch,
      inspection,
      node,
      coordinateTransform: (x, y, z) => {
        if (x > 50 || y > 50) {
          throw new Error("Synthetic spacing probe is outside the domain.");
        }

        return coordinateTransform(x, y, z);
      },
    });

    expect(metadataWithoutSpacing.pointSpacingMeters).toBeUndefined();
    expect(metadataWithoutSpacing.pointDensityScale).toBe(0.25);
  });
});

function createTypedNodePointSampleResult(): CopcNodePointSampleResult {
  return {
    nodeKey: "0-0-0-0",
    nodePointCount: 1,
    sampledPointCount: 1,
    points: [],
    pointData: {
      x: new Float64Array([127]),
      y: new Float64Array([37]),
      z: new Float64Array([10]),
      red: new Uint8Array([10]),
      green: new Uint8Array([20]),
      blue: new Uint8Array([30]),
      classification: new Uint8Array([2]),
      intensity: new Uint16Array([65_535]),
    },
  };
}

function createGeographicInspection(): CopcInspection {
  return {
    sourceUrl: "https://example.com/sample.copc.laz",
    pointCount: 1,
    lasVersion: "1.4",
    pointDataRecordFormat: 7,
    pointDataRecordLength: 36,
    bounds: {
      minX: 126,
      minY: 36,
      minZ: 0,
      maxX: 128,
      maxY: 38,
      maxZ: 20,
    },
    cube: {
      minX: 126,
      minY: 36,
      minZ: 0,
      maxX: 128,
      maxY: 38,
      maxZ: 20,
    },
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

function createEpsg2992Inspection(): CopcInspection {
  return {
    ...createGeographicInspection(),
    bounds: {
      minX: 4_245_000,
      minY: 880_000,
      minZ: 0,
      maxX: 4_245_120,
      maxY: 880_080,
      maxZ: 120,
    },
    cube: {
      minX: 4_245_000,
      minY: 880_000,
      minZ: 0,
      maxX: 4_245_120,
      maxY: 880_080,
      maxZ: 120,
    },
    wkt: 'PROJCS["NAD83(HARN) / Oregon South (ft)",AUTHORITY["EPSG","2992"]],VERT_CS["NAVD88 height (ftUS)"]',
  };
}

function createUtmInspection(): CopcInspection {
  return {
    ...createGeographicInspection(),
    bounds: {
      minX: 381_000,
      minY: 3_764_000,
      minZ: 0,
      maxX: 381_120,
      maxY: 3_764_080,
      maxZ: 40,
    },
    cube: {
      minX: 381_000,
      minY: 3_764_000,
      minZ: 0,
      maxX: 381_120,
      maxY: 3_764_080,
      maxZ: 40,
    },
    wkt: 'PROJCS["WGS 84 / UTM zone 11N",AUTHORITY["EPSG","32611"]]',
  };
}
