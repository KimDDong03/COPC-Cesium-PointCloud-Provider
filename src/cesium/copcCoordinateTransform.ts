import proj4 from "proj4";
import type { CopcInspection } from "../core/copc/CopcInspection";

const EPSG_2992 = "EPSG:2992";
const WGS84 = "EPSG:4326";
const UNSUPPORTED_CRS_MESSAGE =
  "This prototype can only render geographic coordinates or the sample EPSG:2992 COPC CRS.";
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

export type CopcCoordinateTransformKind = "geographic" | "epsg:2992" | "custom";

export interface CopcCoordinateTransformStatus {
  readonly kind: CopcCoordinateTransformKind;
  readonly label: string;
  readonly supportsCameraSelection: boolean;
}

export interface CopcCoordinateTransformSet {
  readonly toCesium: CopcToCesiumCoordinateTransform;
  readonly toCopc?: CesiumToCopcCoordinateTransform;
  readonly status?: Omit<
    CopcCoordinateTransformStatus,
    "supportsCameraSelection"
  >;
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
    status: detectDefaultCoordinateTransformStatus(inspection),
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

  if (isEpsg2992(inspection)) {
    configureKnownProjections();
    return (x, y) => proj4(EPSG_2992, WGS84, [x, y]) as [number, number];
  }

  throw new Error(UNSUPPORTED_CRS_MESSAGE);
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

  if (isEpsg2992(inspection)) {
    configureKnownProjections();
    return (longitudeDegrees, latitudeDegrees) =>
      proj4(WGS84, EPSG_2992, [longitudeDegrees, latitudeDegrees]) as [
        number,
        number,
      ];
  }

  throw new Error(UNSUPPORTED_CRS_MESSAGE);
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

function isEpsg2992(inspection: CopcInspection): boolean {
  return inspection.wkt?.includes('AUTHORITY["EPSG","2992"]') ?? false;
}

function detectDefaultCoordinateTransformStatus(
  inspection: CopcInspection,
): Omit<CopcCoordinateTransformStatus, "supportsCameraSelection"> {
  if (isLikelyGeographic(inspection)) {
    return {
      kind: "geographic",
      label: "Geographic coordinates",
    };
  }

  if (isEpsg2992(inspection)) {
    return {
      kind: "epsg:2992",
      label: "EPSG:2992 to WGS84",
    };
  }

  throw new Error(UNSUPPORTED_CRS_MESSAGE);
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
