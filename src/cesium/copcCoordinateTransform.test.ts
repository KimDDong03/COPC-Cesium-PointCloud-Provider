import { describe, expect, it } from "vitest";
import type { CopcInspection } from "../core";
import {
  createDefaultCopcCoordinateTransforms,
  createProj4CoordinateTransforms,
  getDefaultCopcHeightScaleToMeters,
} from "./copcCoordinateTransform";

const EPSG_32611_WKT =
  'PROJCS["WGS 84 / UTM zone 11N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-117],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","32611"]]';
const EPSG_32611_COMPOUND_WKT =
  `COMPD_CS["WGS 84 / UTM zone 11N",${EPSG_32611_WKT},VERT_CS["Ellipsoidal Heights",VERT_DATUM["Ellipsoidal Heights",2002],UNIT["metre",1]]]`;

describe("createProj4CoordinateTransforms", () => {
  it("creates a reusable proj4-backed COPC/Cesium transform factory", () => {
    const factory = createProj4CoordinateTransforms({
      sourceCrs: "EPSG:32611",
      sourceDefinition:
        "+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs",
      label: "EPSG:32611 to WGS84",
    });
    const transforms = factory({} as CopcInspection);

    const cesiumCoordinate = transforms.toCesium(375_764.094, 3_757_204.382, 25);
    const copiedCoordinate = transforms.toCopc?.(
      cesiumCoordinate.longitudeDegrees,
      cesiumCoordinate.latitudeDegrees,
      cesiumCoordinate.heightMeters,
    );

    expect(transforms.status).toEqual({
      heightScaleToMeters: 1,
      kind: "custom",
      label: "EPSG:32611 to WGS84",
      sourceCrs: "EPSG:32611",
      sourceDefinition:
        "+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs",
      targetCrs: "EPSG:4326",
      targetDefinition: undefined,
    });
    expect(cesiumCoordinate.longitudeDegrees).toBeGreaterThan(-119);
    expect(cesiumCoordinate.longitudeDegrees).toBeLessThan(-118);
    expect(cesiumCoordinate.latitudeDegrees).toBeGreaterThan(33);
    expect(cesiumCoordinate.latitudeDegrees).toBeLessThan(35);
    expect(cesiumCoordinate.heightMeters).toBe(25);
    expect(copiedCoordinate?.x).toBeCloseTo(375_764.094, 3);
    expect(copiedCoordinate?.y).toBeCloseTo(3_757_204.382, 3);
    expect(copiedCoordinate?.z).toBeCloseTo(25, 6);
  });

  it.each([
    [
      "empty source CRS",
      { sourceCrs: "  " },
      "sourceCrs must be a non-empty CRS identifier.",
    ],
    [
      "empty target CRS",
      { sourceCrs: "EPSG:32611", targetCrs: "" },
      "targetCrs must be a non-empty CRS identifier.",
    ],
    [
      "zero height scale",
      { sourceCrs: "EPSG:32611", heightScaleToMeters: 0 },
      "heightScaleToMeters must be a positive finite number.",
    ],
  ])("rejects an invalid %s", (_label, options, expectedMessage) => {
    expect(() => createProj4CoordinateTransforms(options)).toThrow(
      expectedMessage,
    );
  });

  it("uses the COPC WKT as the default projected-coordinate transform", () => {
    const inspection = createProjectedInspection(EPSG_32611_COMPOUND_WKT);
    const transforms = createDefaultCopcCoordinateTransforms(inspection);
    const cesiumCoordinate = transforms.toCesium(
      375_764.094,
      3_757_204.382,
      25,
    );
    const copiedCoordinate = transforms.toCopc?.(
      cesiumCoordinate.longitudeDegrees,
      cesiumCoordinate.latitudeDegrees,
      cesiumCoordinate.heightMeters,
    );

    expect(transforms.status).toMatchObject({
      heightScaleToMeters: 1,
      kind: "wkt",
      label: "EPSG:32611 WKT to WGS84",
      sourceCrs: "EPSG:32611",
      sourceDefinition: EPSG_32611_WKT,
      targetCrs: "EPSG:4326",
    });
    expect(cesiumCoordinate.longitudeDegrees).toBeGreaterThan(-119);
    expect(cesiumCoordinate.longitudeDegrees).toBeLessThan(-118);
    expect(cesiumCoordinate.latitudeDegrees).toBeGreaterThan(33);
    expect(cesiumCoordinate.latitudeDegrees).toBeLessThan(35);
    expect(cesiumCoordinate.heightMeters).toBe(25);
    expect(copiedCoordinate?.x).toBeCloseTo(375_764.094, 3);
    expect(copiedCoordinate?.y).toBeCloseTo(3_757_204.382, 3);
    expect(copiedCoordinate?.z).toBeCloseTo(25, 6);
  });

  it("reads the vertical WKT unit conversion for COPC heights", () => {
    const inspection = createProjectedInspection(
      `${EPSG_32611_WKT},VERT_CS["Local height",VERT_DATUM["Local",2005],UNIT["US survey foot",0.3048006096012192]]`,
    );

    expect(getDefaultCopcHeightScaleToMeters(inspection)).toBeCloseTo(
      0.3048006096012192,
      15,
    );
  });

  it("prefers an explicit projected WKT over geographic-looking bounds", () => {
    const projectedInspection = createProjectedInspection(EPSG_32611_WKT);
    const inspection: CopcInspection = {
      ...projectedInspection,
      bounds: {
        ...projectedInspection.bounds,
        minX: 10,
        minY: 20,
        maxX: 20,
        maxY: 30,
      },
    };
    const transforms = createDefaultCopcCoordinateTransforms(inspection);
    const cesiumCoordinate = transforms.toCesium(15, 25, 5);

    expect(transforms.status?.kind).toBe("wkt");
    expect(cesiumCoordinate.longitudeDegrees).not.toBeCloseTo(15, 6);
    expect(cesiumCoordinate.latitudeDegrees).not.toBeCloseTo(25, 6);
    expect(cesiumCoordinate.longitudeDegrees).toBeGreaterThanOrEqual(-180);
    expect(cesiumCoordinate.longitudeDegrees).toBeLessThanOrEqual(180);
    expect(cesiumCoordinate.latitudeDegrees).toBeGreaterThanOrEqual(-90);
    expect(cesiumCoordinate.latitudeDegrees).toBeLessThanOrEqual(90);
  });
});

function createProjectedInspection(wkt: string): CopcInspection {
  return {
    sourceUrl: "https://example.com/projected.copc.laz",
    pointCount: 1,
    lasVersion: "1.4",
    pointDataRecordFormat: 7,
    pointDataRecordLength: 36,
    bounds: {
      minX: 375_000,
      minY: 3_757_000,
      minZ: 0,
      maxX: 376_000,
      maxY: 3_758_000,
      maxZ: 100,
    },
    cube: {
      minX: 375_000,
      minY: 3_757_000,
      minZ: 0,
      maxX: 376_000,
      maxY: 3_758_000,
      maxZ: 100,
    },
    scale: [0.01, 0.01, 0.01],
    offset: [0, 0, 0],
    spacing: 1,
    gpsTimeRange: [0, 0],
    rootHierarchyPage: {
      pageOffset: 0,
      pageLength: 0,
    },
    vlrs: [],
    wkt,
  };
}
