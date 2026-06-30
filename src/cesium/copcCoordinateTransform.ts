import proj4 from "proj4";
import type { CopcInspection } from "../core/copc/CopcInspection";

const EPSG_2992 = "EPSG:2992";
const WGS84 = "EPSG:4326";
const US_SURVEY_FOOT_TO_METER = 0.304800609601219;

let projectionsConfigured = false;

export interface CesiumCoordinate {
  readonly longitudeDegrees: number;
  readonly latitudeDegrees: number;
  readonly heightMeters: number;
}

export interface CopcCoordinate {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type CopcToCesiumCoordinateTransform = (
  x: number,
  y: number,
  z: number,
) => CesiumCoordinate;

export type CesiumToCopcCoordinateTransform = (
  longitudeDegrees: number,
  latitudeDegrees: number,
  heightMeters: number,
) => CopcCoordinate;

export interface CopcCoordinateTransformSet {
  readonly toCesium: CopcToCesiumCoordinateTransform;
  readonly toCopc?: CesiumToCopcCoordinateTransform;
}

export type CopcCoordinateTransformFactory = (
  inspection: CopcInspection,
) => CopcCoordinateTransformSet;

export function createDefaultCopcCoordinateTransforms(
  inspection: CopcInspection,
): CopcCoordinateTransformSet {
  return {
    toCesium: createCopcCoordinateTransform(inspection),
    toCopc: createCesiumToCopcCoordinateTransform(inspection),
  };
}

export function createCopcCoordinateTransform(
  inspection: CopcInspection,
): CopcToCesiumCoordinateTransform {
  const horizontalTransform = createHorizontalTransform(inspection);

  return (x, y, z) => {
    const [longitudeDegrees, latitudeDegrees] = horizontalTransform(x, y);

    return {
      longitudeDegrees,
      latitudeDegrees,
      heightMeters: heightToMeters(z, inspection),
    };
  };
}

export function createCesiumToCopcCoordinateTransform(
  inspection: CopcInspection,
): CesiumToCopcCoordinateTransform {
  const horizontalTransform = createInverseHorizontalTransform(inspection);

  return (longitudeDegrees, latitudeDegrees, heightMeters) => {
    const [x, y] = horizontalTransform(longitudeDegrees, latitudeDegrees);

    return {
      x,
      y,
      z: heightFromMeters(heightMeters, inspection),
    };
  };
}

function createHorizontalTransform(
  inspection: CopcInspection,
): (x: number, y: number) => [number, number] {
  if (isLikelyGeographic(inspection)) {
    return (x, y) => [x, y];
  }

  if (inspection.wkt?.includes('AUTHORITY["EPSG","2992"]')) {
    configureKnownProjections();
    return (x, y) => proj4(EPSG_2992, WGS84, [x, y]) as [number, number];
  }

  throw new Error(
    "This prototype can only render geographic coordinates or the sample EPSG:2992 COPC CRS.",
  );
}

function createInverseHorizontalTransform(
  inspection: CopcInspection,
): (longitudeDegrees: number, latitudeDegrees: number) => [number, number] {
  if (isLikelyGeographic(inspection)) {
    return (longitudeDegrees, latitudeDegrees) => [
      longitudeDegrees,
      latitudeDegrees,
    ];
  }

  if (inspection.wkt?.includes('AUTHORITY["EPSG","2992"]')) {
    configureKnownProjections();
    return (longitudeDegrees, latitudeDegrees) =>
      proj4(WGS84, EPSG_2992, [longitudeDegrees, latitudeDegrees]) as [
        number,
        number,
      ];
  }

  throw new Error(
    "This prototype can only render geographic coordinates or the sample EPSG:2992 COPC CRS.",
  );
}

function configureKnownProjections(): void {
  if (projectionsConfigured) {
    return;
  }

  proj4.defs(
    EPSG_2992,
    "+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 +x_0=400000 +y_0=0 +datum=NAD83 +units=ft +no_defs +type=crs",
  );
  projectionsConfigured = true;
}

function isLikelyGeographic(inspection: CopcInspection): boolean {
  const { bounds } = inspection;

  return (
    bounds.minX >= -180 &&
    bounds.maxX <= 180 &&
    bounds.minY >= -90 &&
    bounds.maxY <= 90
  );
}

function heightToMeters(z: number, inspection: CopcInspection): number {
  if (inspection.wkt?.includes('VERT_CS["NAVD88 height (ftUS)"')) {
    return z * US_SURVEY_FOOT_TO_METER;
  }

  return z;
}

function heightFromMeters(heightMeters: number, inspection: CopcInspection): number {
  if (inspection.wkt?.includes('VERT_CS["NAVD88 height (ftUS)"')) {
    return heightMeters / US_SURVEY_FOOT_TO_METER;
  }

  return heightMeters;
}
