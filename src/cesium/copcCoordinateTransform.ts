import proj4 from "proj4";
import type { CopcInspection } from "../core/copc/CopcInspection";

export const EPSG_2992 = "EPSG:2992";
const WGS84 = "EPSG:4326";
const UNSUPPORTED_CRS_MESSAGE =
  "COPC coordinates are neither geographic nor described by a usable WKT CRS. Pass a coordinateTransforms factory for this source.";
export const US_SURVEY_FOOT_TO_METER = 0.304800609601219;

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

export type CopcCoordinateTransformKind =
  | "geographic"
  | "epsg:2992"
  | "wkt"
  | "custom";

export interface CopcCoordinateTransformStatus {
  readonly kind: CopcCoordinateTransformKind;
  readonly label: string;
  readonly supportsCameraSelection: boolean;
  readonly sourceCrs?: string;
  readonly sourceDefinition?: string;
  readonly targetCrs?: string;
  readonly targetDefinition?: string;
  readonly heightScaleToMeters?: number;
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

export interface Proj4CoordinateTransformOptions {
  readonly sourceCrs: string;
  readonly sourceDefinition?: string;
  readonly targetCrs?: string;
  readonly targetDefinition?: string;
  readonly label?: string;
  readonly heightScaleToMeters?: number;
}

export function createDefaultCopcCoordinateTransforms(
  inspection: CopcInspection,
): CopcCoordinateTransformSet {
  return {
    toCesium: createCopcCoordinateTransform(inspection),
    toCopc: createCesiumToCopcCoordinateTransform(inspection),
    status: detectDefaultCoordinateTransformStatus(inspection),
  };
}

export function createProj4CoordinateTransforms(
  options: Proj4CoordinateTransformOptions,
): CopcCoordinateTransformFactory {
  const sourceCrs = requireCoordinateReferenceSystem(
    options.sourceCrs,
    "sourceCrs",
  );
  const targetCrs = requireCoordinateReferenceSystem(
    options.targetCrs ?? WGS84,
    "targetCrs",
  );
  const heightScaleToMeters = options.heightScaleToMeters ?? 1;

  if (!Number.isFinite(heightScaleToMeters) || heightScaleToMeters <= 0) {
    throw new Error("heightScaleToMeters must be a positive finite number.");
  }

  const label = options.label ?? `${sourceCrs} to ${targetCrs}`;

  return () => {
    configureProjectionDefinition(sourceCrs, options.sourceDefinition);
    configureProjectionDefinition(targetCrs, options.targetDefinition);
    const projection = proj4(sourceCrs, targetCrs);

    return {
      toCesium: (x, y, z) => {
        const [longitudeDegrees, latitudeDegrees] = projection.forward([
          x,
          y,
        ]) as [number, number];

        return {
          longitudeDegrees,
          latitudeDegrees,
          heightMeters: z * heightScaleToMeters,
        };
      },
      toCopc: (longitudeDegrees, latitudeDegrees, heightMeters) => {
        const [x, y] = projection.inverse([
          longitudeDegrees,
          latitudeDegrees,
        ]) as [number, number];

        return {
          x,
          y,
          z: heightMeters / heightScaleToMeters,
        };
      },
      status: {
        kind: "custom",
        label,
        sourceCrs,
        sourceDefinition: options.sourceDefinition,
        targetCrs,
        targetDefinition: options.targetDefinition,
        heightScaleToMeters,
      },
    };
  };
}

function requireCoordinateReferenceSystem(value: string, name: string): string {
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    throw new Error(`${name} must be a non-empty CRS identifier.`);
  }

  return normalizedValue;
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
  if (isEpsg2992(inspection)) {
    configureKnownProjections();
    const projection = proj4(EPSG_2992, WGS84);
    return (x, y) => projection.forward([x, y]) as [number, number];
  }

  if (inspection.wkt) {
    const projection = proj4(extractHorizontalWkt(inspection.wkt), WGS84);
    return (x, y) => projection.forward([x, y]) as [number, number];
  }

  if (isLikelyGeographic(inspection)) {
    return (x, y) => [x, y];
  }

  throw new Error(UNSUPPORTED_CRS_MESSAGE);
}

function createInverseHorizontalTransform(
  inspection: CopcInspection,
): (longitudeDegrees: number, latitudeDegrees: number) => [number, number] {
  if (isEpsg2992(inspection)) {
    configureKnownProjections();
    const projection = proj4(EPSG_2992, WGS84);
    return (longitudeDegrees, latitudeDegrees) =>
      projection.inverse([longitudeDegrees, latitudeDegrees]) as [number, number];
  }

  if (inspection.wkt) {
    const projection = proj4(extractHorizontalWkt(inspection.wkt), WGS84);
    return (longitudeDegrees, latitudeDegrees) =>
      projection.inverse([longitudeDegrees, latitudeDegrees]) as [number, number];
  }

  if (isLikelyGeographic(inspection)) {
    return (longitudeDegrees, latitudeDegrees) => [
      longitudeDegrees,
      latitudeDegrees,
    ];
  }

  throw new Error(UNSUPPORTED_CRS_MESSAGE);
}

function configureKnownProjections(): void {
  configureKnownCopcProjections();
}

export function configureKnownCopcProjections(): void {
  if (projectionsConfigured) {
    return;
  }

  proj4.defs(
    EPSG_2992,
    "+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 +x_0=400000 +y_0=0 +datum=NAD83 +units=ft +no_defs +type=crs",
  );
  projectionsConfigured = true;
}

function configureProjectionDefinition(
  crs: string,
  definition: string | undefined,
): void {
  if (definition) {
    proj4.defs(crs, definition);
  }
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
  if (isEpsg2992(inspection)) {
    return {
      kind: "epsg:2992",
      label: "EPSG:2992 to WGS84",
    };
  }

  if (inspection.wkt) {
    const sourceDefinition = extractHorizontalWkt(inspection.wkt);
    const sourceCrs = findWktEpsgCode(sourceDefinition) ?? "COPC:WKT";
    return {
      kind: "wkt",
      label:
        sourceCrs === "COPC:WKT"
          ? "COPC WKT to WGS84"
          : `${sourceCrs} WKT to WGS84`,
      sourceCrs,
      sourceDefinition,
      targetCrs: WGS84,
      heightScaleToMeters: getDefaultCopcHeightScaleToMeters(inspection),
    };
  }

  if (isLikelyGeographic(inspection)) {
    return {
      kind: "geographic",
      label: "Geographic coordinates",
    };
  }

  throw new Error(UNSUPPORTED_CRS_MESSAGE);
}

function extractHorizontalWkt(wkt: string): string {
  const trimmedWkt = wkt.trim();
  const normalizedWkt = trimmedWkt.toUpperCase();
  const rootNames = ["PROJCS", "PROJCRS", "GEOGCS", "GEOGCRS", "GEODCRS"];

  for (const rootName of rootNames) {
    const startIndex = normalizedWkt.indexOf(`${rootName}[`);

    if (startIndex < 0) {
      continue;
    }

    let bracketDepth = 0;
    let insideQuotedText = false;

    for (let index = startIndex; index < trimmedWkt.length; index += 1) {
      const character = trimmedWkt[index];

      if (character === '"') {
        if (insideQuotedText && trimmedWkt[index + 1] === '"') {
          index += 1;
          continue;
        }

        insideQuotedText = !insideQuotedText;
        continue;
      }

      if (insideQuotedText) {
        continue;
      }

      if (character === "[") {
        bracketDepth += 1;
      } else if (character === "]") {
        bracketDepth -= 1;

        if (bracketDepth === 0) {
          return trimmedWkt.slice(startIndex, index + 1);
        }
      }
    }

    throw new Error(`COPC ${rootName} WKT block is not balanced.`);
  }

  return trimmedWkt;
}

function findWktEpsgCode(wkt: string): string | undefined {
  const matches = [
    ...wkt.matchAll(
      /(?:AUTHORITY|ID)\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?/gi,
    ),
  ];
  const code = matches.at(-1)?.[1];
  return code ? `EPSG:${code}` : undefined;
}

function heightToMeters(z: number, inspection: CopcInspection): number {
  return z * getDefaultCopcHeightScaleToMeters(inspection);
}

function heightFromMeters(heightMeters: number, inspection: CopcInspection): number {
  return heightMeters / getDefaultCopcHeightScaleToMeters(inspection);
}

export function getDefaultCopcHeightScaleToMeters(
  inspection: CopcInspection,
): number {
  const verticalUnitScale = inspection.wkt?.match(
    /VERT_(?:CS|CRS)[\s\S]*?(?:LENGTH)?UNIT\s*\[\s*"[^"]+"\s*,\s*([\d.eE+-]+)/i,
  )?.[1];

  if (verticalUnitScale) {
    const scale = Number(verticalUnitScale);
    if (Number.isFinite(scale) && scale > 0) {
      return scale;
    }
  }

  return inspection.wkt?.includes('VERT_CS["NAVD88 height (ftUS)"')
    ? US_SURVEY_FOOT_TO_METER
    : 1;
}
