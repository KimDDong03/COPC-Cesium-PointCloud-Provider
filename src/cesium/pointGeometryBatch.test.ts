import { Cartesian3 } from "cesium";
import { describe, expect, it } from "vitest";
import type { CopcInspection } from "../core";
import type { CopcNodePointSampleResult } from "../core/copc/CopcPointDataSample";
import {
  createCesiumPointGeometryTransform,
  createPointGeometryBatchFromCopc,
  createPointGeometryBatchFromSerializableTransform,
} from "./pointGeometryBatch";
import {
  createDefaultCopcCoordinateTransforms,
  createProj4CoordinateTransforms,
  type CopcCoordinateTransformStatus,
} from "./copcCoordinateTransform";

describe("point geometry batch creation", () => {
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
