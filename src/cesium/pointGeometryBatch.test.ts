import { Cartesian3 } from "cesium";
import { describe, expect, it } from "vitest";
import type { CopcInspection } from "../core";
import type { CopcNodePointSampleResult } from "../core/copc/CopcPointDataSample";
import {
  sampleCopcPointDataView,
  type CopcPointDataView,
} from "../core/copc/loadCopcNodePointSamples";
import {
  createCesiumPointGeometryTransform,
  createPointGeometryBatchFromCopcPointDataView,
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

    const pointData = {
      x: new Float64Array([381_000, 381_120]),
      y: new Float64Array([3_764_000, 3_764_080]),
      z: new Float64Array([20, 30]),
    };
    const result = createPointGeometryBatchFromSerializableTransform({
      key: "0-0-0-0:2:2:2:wkt",
      pointData,
      transform,
    });
    const fused = createPointGeometryBatchFromCopcPointDataView({
      nodeKey: "0-0-0-0",
      view: createPointDataView({
        X: [...pointData.x],
        Y: [...pointData.y],
        Z: [...pointData.z],
      }),
      maxPointCount: 2,
      spatialPointOrder: new Uint32Array([0, 1]),
      transform,
    });

    expect(result.positions).toHaveLength(6);
    expect([...result.positions].every(Number.isFinite)).toBe(true);
    expect(fused.geometryBatch).toEqual({
      ...result,
      key: "0-0-0-0:2:2:2",
    });
  });

  it("builds fused geographic worker geometry exactly like typed sampling plus serializable geometry", () => {
    const view = createPointDataView({
      X: [127, 127.001, 127.002, 127.003],
      Y: [37, 37.001, 37.002, 37.003],
      Z: [10, 20, 30, 40],
      Red: [10, 65_535, 32_768, 257],
      Green: [20, 32_768, 65_535, 0],
      Blue: [30, 257, 0, 32_768],
      Classification: [2, 6, 9, 5],
      Intensity: [0, 65_535, 32_768, 257],
    });
    const spatialPointOrder = new Uint32Array([2, 0, 3, 1]);
    const transform = {
      kind: "geographic",
      heightScaleToMeters: 1,
    } as const;
    const sampled = sampleCopcPointDataView({
      nodeKey: "2-1-0-1",
      view,
      maxPointCount: 3,
      sampleFormat: "typed",
      spatialPointOrder,
    });
    const expected = createPointGeometryBatchFromSerializableTransform({
      key: "2-1-0-1:4:3:3",
      pointData: sampled.pointData!,
      transform,
    });
    const fused = createPointGeometryBatchFromCopcPointDataView({
      nodeKey: "2-1-0-1",
      view,
      maxPointCount: 3,
      spatialPointOrder,
      transform,
    });

    expect(fused.pointSamples).toEqual({
      nodeKey: "2-1-0-1",
      nodePointCount: 4,
      sampledPointCount: 3,
      points: [],
    });
    expect(fused.geometryBatch).toEqual(expected);
  });

  it("preserves classification and intensity fallback colors without materialized RGB samples", () => {
    const view = createPointDataView({
      X: [127, 127.001, 127.002],
      Y: [37, 37.001, 37.002],
      Z: [10, 20, 30],
      Classification: [6, 255, 42],
      Intensity: [65_535, 16_384, 0],
    });
    const spatialPointOrder = new Uint32Array([1, 2, 0]);
    const transform = {
      kind: "geographic",
      heightScaleToMeters: 1,
    } as const;
    const sampled = sampleCopcPointDataView({
      nodeKey: "2-1-0-1",
      view,
      maxPointCount: 3,
      sampleFormat: "typed",
      spatialPointOrder,
    });
    const expected = createPointGeometryBatchFromSerializableTransform({
      key: "2-1-0-1:3:3:3",
      pointData: sampled.pointData!,
      transform,
    });
    const fused = createPointGeometryBatchFromCopcPointDataView({
      nodeKey: "2-1-0-1",
      view,
      maxPointCount: 3,
      spatialPointOrder,
      transform,
    });

    expect(fused.geometryBatch.colors).toEqual(expected.colors);
    expect(fused.geometryBatch.positions).toEqual(expected.positions);
    expect(fused.geometryBatch).toEqual(expected);
  });

  it("preserves elevation colors, empty results, and non-finite position bounds", () => {
    const transform = {
      kind: "geographic",
      heightScaleToMeters: 1,
    } as const;
    const fused = createPointGeometryBatchFromCopcPointDataView({
      nodeKey: "2-1-0-1",
      view: createPointDataView({
        X: [127, Number.NaN, 127.002],
        Y: [37, 37.001, Number.POSITIVE_INFINITY],
        Z: [0, 50, 100],
        Red: [255, 255, 255],
        Green: [0, 0, 0],
        Blue: [0, 0, 0],
      }),
      maxPointCount: 3,
      spatialPointOrder: new Uint32Array([0, 1, 2]),
      transform,
      pointColorStyle: {
        mode: "elevation",
        minimumZ: 0,
        inverseZRange: 0.01,
      },
    });
    const empty = createPointGeometryBatchFromCopcPointDataView({
      nodeKey: "empty",
      view: createPointDataView({
        X: [127],
        Y: [37],
        Z: [10],
        Classification: [2],
      }),
      maxPointCount: 0,
      spatialPointOrder: new Uint32Array([0]),
      transform,
    });

    expect(fused.geometryBatch.colors).toEqual(
      new Uint8Array([
        68, 1, 84, 255,
        38, 144, 137, 255,
        253, 231, 37, 255,
      ]),
    );
    expect(fused.geometryBatch.positionBounds).toEqual({
      minX: fused.geometryBatch.positions[0],
      minY: fused.geometryBatch.positions[1],
      minZ: fused.geometryBatch.positions[2],
      maxX: fused.geometryBatch.positions[0],
      maxY: fused.geometryBatch.positions[1],
      maxZ: fused.geometryBatch.positions[2],
    });
    expect(empty).toEqual({
      pointSamples: {
        nodeKey: "empty",
        nodePointCount: 1,
        sampledPointCount: 0,
        points: [],
      },
      geometryBatch: {
        key: "empty:1:0:0",
        pointCount: 0,
        positions: new Float64Array(0),
        colors: new Uint8Array(0),
        positionBounds: undefined,
        hasTranslucentColors: false,
      },
    });
  });

  it("uses the first finite sampled projected point as the fused local origin", () => {
    const inspection = createEpsg2992Inspection();
    const epsg2992Transform = createCesiumPointGeometryTransform(inspection, {
      kind: "epsg:2992",
      label: "EPSG:2992 to WGS84",
      supportsCameraSelection: true,
    } satisfies CopcCoordinateTransformStatus);

    if (!epsg2992Transform) {
      throw new Error("Expected EPSG:2992 transform.");
    }

    assertFusedPointDataViewGeometryMatchesTypedPath(
      createPointDataView({
        X: [Number.NaN, 4_245_000, 4_245_120],
        Y: [880_000, 880_000, 880_080],
        Z: [100, 110, 120],
        Red: [10, 40, 70],
        Green: [20, 50, 80],
        Blue: [30, 60, 90],
      }),
      new Uint32Array([0, 2, 1]),
      epsg2992Transform,
    );

    const proj4Transform = createCesiumPointGeometryTransform(
      createUtmInspection(),
      {
        kind: "custom",
        label: "EPSG:32611 to WGS84",
        supportsCameraSelection: true,
        sourceCrs: "EPSG:32611",
        sourceDefinition:
          "+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs",
        targetCrs: "EPSG:4326",
        heightScaleToMeters: 1,
      } satisfies CopcCoordinateTransformStatus,
    );

    if (!proj4Transform) {
      throw new Error("Expected proj4 transform.");
    }

    assertFusedPointDataViewGeometryMatchesTypedPath(
      createPointDataView({
        X: [Number.NaN, 381_000, 381_120],
        Y: [3_764_000, 3_764_000, 3_764_080],
        Z: [20, 30, 40],
      }),
      new Uint32Array([0, 2, 1]),
      proj4Transform,
    );

    const wktTransform = createCesiumPointGeometryTransform(
      createUtmInspection(),
      {
        kind: "wkt",
        label: "EPSG:32611 WKT to WGS84",
        supportsCameraSelection: true,
        sourceCrs: "EPSG:32611",
        sourceDefinition:
          'PROJCS["WGS 84 / UTM zone 11N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-117],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","32611"]]',
        targetCrs: "EPSG:4326",
        heightScaleToMeters: 1,
      } satisfies CopcCoordinateTransformStatus,
    );

    if (!wktTransform) {
      throw new Error("Expected WKT transform.");
    }

    assertFusedPointDataViewGeometryMatchesTypedPath(
      createPointDataView({
        X: [Number.NaN, 381_000, 381_120],
        Y: [3_764_000, 3_764_000, 3_764_080],
        Z: [20, 30, 40],
      }),
      new Uint32Array([0, 2, 1]),
      wktTransform,
    );
  });

  it("rejects invalid fused worker sampling inputs like the existing sampler", () => {
    const view = createPointDataView({
      X: [127, 128],
      Y: [37, 38],
      Z: [10, 20],
    });
    const transform = {
      kind: "geographic",
      heightScaleToMeters: 1,
    } as const;

    expect(() =>
      createPointGeometryBatchFromCopcPointDataView({
        nodeKey: "bad",
        view,
        maxPointCount: 1,
        spatialPointOrder: new Uint32Array([0]),
        transform,
      }),
    ).toThrow("spatialPointOrder length must match view.pointCount.");
    expect(() =>
      createPointGeometryBatchFromCopcPointDataView({
        nodeKey: "bad",
        view,
        maxPointCount: 1,
        spatialPointOrder: new Uint32Array([2, 0]),
        transform,
      }),
    ).toThrow("spatialPointOrder contains an invalid point index.");
  });

  it("does not read point data getters for empty fused worker results", () => {
    const view: CopcPointDataView = {
      pointCount: 1,
      dimensions: {},
      getter: () => {
        throw new Error("No dimension should be read for an empty sample.");
      },
    };
    const fused = createPointGeometryBatchFromCopcPointDataView({
      nodeKey: "empty",
      view,
      maxPointCount: 0,
      spatialPointOrder: new Uint32Array([0]),
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    expect(fused).toEqual({
      pointSamples: {
        nodeKey: "empty",
        nodePointCount: 1,
        sampledPointCount: 0,
        points: [],
      },
      geometryBatch: {
        key: "empty:1:0:0",
        pointCount: 0,
        positions: new Float64Array(0),
        colors: new Uint8Array(0),
        positionBounds: undefined,
        hasTranslucentColors: false,
      },
    });
  });

  it("stops fused geometry work when sampling is aborted mid-loop", () => {
    const pointCount = 2_050;
    const spatialPointOrder = new Uint32Array(pointCount);
    const controller = new AbortController();
    let maximumReadIndex = -1;

    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      spatialPointOrder[pointIndex] = pointIndex;
    }

    const view: CopcPointDataView = {
      pointCount,
      dimensions: { X: true, Y: true, Z: true },
      getter: (name) => (pointIndex) => {
        maximumReadIndex = Math.max(maximumReadIndex, pointIndex);

        if (name === "X" && pointIndex === 2_047) {
          controller.abort(new Error("Stop fused geometry."));
        }

        if (name === "X") {
          return 127 + pointIndex / 1_000_000;
        }

        return name === "Y" ? 37 : pointIndex;
      },
    };

    expect(() =>
      createPointGeometryBatchFromCopcPointDataView({
        nodeKey: "aborted",
        view,
        maxPointCount: pointCount,
        spatialPointOrder,
        transform: {
          kind: "geographic",
          heightScaleToMeters: 1,
        },
        signal: controller.signal,
      }),
    ).toThrow("Stop fused geometry.");
    expect(maximumReadIndex).toBe(2_047);
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

function assertFusedPointDataViewGeometryMatchesTypedPath(
  view: CopcPointDataView,
  spatialPointOrder: Uint32Array,
  transform: NonNullable<
    ReturnType<typeof createCesiumPointGeometryTransform>
  >,
): void {
  const sampled = sampleCopcPointDataView({
    nodeKey: "projected",
    view,
    maxPointCount: 3,
    sampleFormat: "typed",
    spatialPointOrder,
  });
  const expected = createPointGeometryBatchFromSerializableTransform({
    key: "projected:3:3:3",
    pointData: sampled.pointData!,
    transform,
  });
  const fused = createPointGeometryBatchFromCopcPointDataView({
    nodeKey: "projected",
    view,
    maxPointCount: 3,
    spatialPointOrder,
    transform,
  });

  expect(fused.geometryBatch).toEqual(expected);
}

function createPointDataView(
  dimensions: Record<string, readonly number[]>,
): CopcPointDataView {
  const pointCount = Object.values(dimensions)[0]?.length ?? 0;

  return {
    pointCount,
    dimensions,
    getter: (name) => {
      const values = dimensions[name];

      if (!values) {
        throw new Error(`No test dimension: ${name}`);
      }

      return (index) => {
        const value = values[index];

        if (value === undefined) {
          throw new Error(`No test value at ${index} for ${name}`);
        }

        return value;
      };
    },
  };
}
