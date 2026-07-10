import proj4 from "proj4";
import type {
  CopcNodePointSampleResult,
  CopcPointDataSample,
  CopcPointDataSampleArrays,
} from "../core/copc/CopcPointDataSample";
import type { CopcInspection } from "../core/copc/CopcInspection";
import type { PointGeometryBatch } from "./CopcPointCloudRenderer";
import {
  configureKnownCopcProjections,
  EPSG_2992,
  getDefaultCopcHeightScaleToMeters,
  type CopcCoordinateTransformStatus,
  type CopcCoordinateTransformSet,
} from "./copcCoordinateTransform";

const WGS84 = "EPSG:4326";
const WGS84_SEMI_MAJOR_AXIS = 6_378_137.0;
const WGS84_FIRST_ECCENTRICITY_SQUARED = 6.6943799901413165e-3;

const DEFAULT_GEOMETRY_POINT_COLOR = {
  red: 0,
  green: 255,
  blue: 255,
  alpha: 255,
} as const;

export type CesiumPointGeometryTransformKind =
  | "geographic"
  | "epsg:2992"
  | "proj4";

export interface CesiumPointGeometryTransform {
  readonly kind: CesiumPointGeometryTransformKind;
  readonly heightScaleToMeters: number;
  readonly sourceCrs?: string;
  readonly sourceDefinition?: string;
  readonly targetCrs?: string;
  readonly targetDefinition?: string;
}

export function createCesiumPointGeometryTransform(
  inspection: CopcInspection,
  status: CopcCoordinateTransformStatus,
): CesiumPointGeometryTransform | undefined {
  if (status.kind === "geographic" || status.kind === "epsg:2992") {
    return {
      kind: status.kind,
      heightScaleToMeters: getDefaultCopcHeightScaleToMeters(inspection),
    };
  }

  if (status.sourceCrs) {
    return {
      kind: "proj4",
      sourceCrs: status.sourceCrs,
      sourceDefinition: status.sourceDefinition,
      targetCrs: status.targetCrs ?? WGS84,
      targetDefinition: status.targetDefinition,
      heightScaleToMeters:
        status.heightScaleToMeters ??
        getDefaultCopcHeightScaleToMeters(inspection),
    };
  }

  return undefined;
}

export function createPointGeometryBatchFromCopc(
  nodeResult: CopcNodePointSampleResult,
  coordinateTransform: CopcCoordinateTransformSet["toCesium"],
): PointGeometryBatch {
  return createPointGeometryBatchFromPointData({
    key: createNodePointSampleBatchKey(nodeResult),
    pointData:
      nodeResult.pointData ??
      createPointDataSampleArraysFromPoints(nodeResult.points),
    coordinateTransform: (x, y, z) => {
      const coordinate = coordinateTransform(x, y, z);

      return cartesianFromDegrees(
        coordinate.longitudeDegrees,
        coordinate.latitudeDegrees,
        coordinate.heightMeters,
      );
    },
  });
}

export function createPointGeometryBatchFromSerializableTransform(options: {
  readonly key: string;
  readonly pointData: CopcPointDataSampleArrays;
  readonly transform: CesiumPointGeometryTransform;
}): PointGeometryBatch {
  const coordinateTransform = createSerializableCoordinateTransform(
    options.pointData,
    options.transform,
  );

  return createPointGeometryBatchFromPointData({
    key: options.key,
    pointData: options.pointData,
    coordinateTransform,
  });
}

export function createPointDataSampleArraysFromPoints(
  points: readonly CopcPointDataSample[],
): CopcPointDataSampleArrays {
  const hasAnyColor = points.some((point) => point.color);
  const pointData: CopcPointDataSampleArrays = {
    x: new Float64Array(points.length),
    y: new Float64Array(points.length),
    z: new Float64Array(points.length),
    red: hasAnyColor ? new Uint8Array(points.length) : undefined,
    green: hasAnyColor ? new Uint8Array(points.length) : undefined,
    blue: hasAnyColor ? new Uint8Array(points.length) : undefined,
  };

  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const point = points[pointIndex];
    pointData.x[pointIndex] = point.x;
    pointData.y[pointIndex] = point.y;
    pointData.z[pointIndex] = point.z;

    if (pointData.red && pointData.green && pointData.blue) {
      const color = point.color ?? DEFAULT_GEOMETRY_POINT_COLOR;
      pointData.red[pointIndex] = color.red;
      pointData.green[pointIndex] = color.green;
      pointData.blue[pointIndex] = color.blue;
    }
  }

  return pointData;
}

export function createPointDataSamplesFromArrays(
  pointData: CopcPointDataSampleArrays,
): CopcPointDataSample[] {
  const pointCount = pointData.x.length;
  const hasColor = pointData.red && pointData.green && pointData.blue;
  const points = new Array<CopcPointDataSample>(pointCount);

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    points[pointIndex] = {
      x: pointData.x[pointIndex],
      y: pointData.y[pointIndex],
      z: pointData.z[pointIndex],
      color: hasColor
        ? {
            red: pointData.red[pointIndex],
            green: pointData.green[pointIndex],
            blue: pointData.blue[pointIndex],
          }
        : undefined,
    };
  }

  return points;
}

export function getPointDataSamples(
  nodeResult: CopcNodePointSampleResult,
): readonly CopcPointDataSample[] {
  if (nodeResult.points.length > 0 || !nodeResult.pointData) {
    return nodeResult.points;
  }

  return createPointDataSamplesFromArrays(nodeResult.pointData);
}

export function createNodePointSampleBatchKey(
  nodeResult: CopcNodePointSampleResult,
): string {
  return [
    nodeResult.nodeKey,
    nodeResult.nodePointCount,
    nodeResult.sampledPointCount,
    nodeResult.pointData?.x.length ??
      (nodeResult.points.length > 0
        ? nodeResult.points.length
        : nodeResult.sampledPointCount),
  ].join(":");
}

function createPointGeometryBatchFromPointData(options: {
  readonly key: string;
  readonly pointData: CopcPointDataSampleArrays;
  readonly coordinateTransform: (
    x: number,
    y: number,
    z: number,
  ) => readonly [number, number, number];
}): PointGeometryBatch {
  const pointCount = options.pointData.x.length;
  const positions = new Float64Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    const position = options.coordinateTransform(
      options.pointData.x[pointIndex],
      options.pointData.y[pointIndex],
      options.pointData.z[pointIndex],
    );
    const positionOffset = pointIndex * 3;
    const colorOffset = pointIndex * 4;

    positions[positionOffset] = position[0];
    positions[positionOffset + 1] = position[1];
    positions[positionOffset + 2] = position[2];
    colors[colorOffset] =
      options.pointData.red?.[pointIndex] ?? DEFAULT_GEOMETRY_POINT_COLOR.red;
    colors[colorOffset + 1] =
      options.pointData.green?.[pointIndex] ??
      DEFAULT_GEOMETRY_POINT_COLOR.green;
    colors[colorOffset + 2] =
      options.pointData.blue?.[pointIndex] ?? DEFAULT_GEOMETRY_POINT_COLOR.blue;
    colors[colorOffset + 3] = DEFAULT_GEOMETRY_POINT_COLOR.alpha;
  }

  return {
    key: options.key,
    pointCount,
    positions,
    colors,
  };
}

function createSerializableCoordinateTransform(
  pointData: CopcPointDataSampleArrays,
  transform: CesiumPointGeometryTransform,
): (x: number, y: number, z: number) => readonly [number, number, number] {
  if (transform.kind === "geographic") {
    return (x, y, z) =>
      cartesianFromDegrees(
        x,
        y,
        z * transform.heightScaleToMeters,
      );
  }

  const horizontalTransform =
    transform.kind === "epsg:2992"
      ? createEpsg2992LocalLinearTransform(pointData)
      : createProj4LocalLinearTransform(pointData, transform);

  return (x, y, z) => {
    const [longitudeDegrees, latitudeDegrees] = horizontalTransform(x, y);

    return cartesianFromDegrees(
      longitudeDegrees,
      latitudeDegrees,
      z * transform.heightScaleToMeters,
    );
  };
}

function createEpsg2992LocalLinearTransform(
  pointData: CopcPointDataSampleArrays,
): (x: number, y: number) => readonly [number, number] {
  configureKnownCopcProjections();
  const projection = proj4(EPSG_2992, WGS84);
  return createProjectedLocalLinearTransform(
    pointData,
    (x, y) => projection.forward([x, y]) as [number, number],
  );
}

function createProj4LocalLinearTransform(
  pointData: CopcPointDataSampleArrays,
  transform: CesiumPointGeometryTransform,
): (x: number, y: number) => readonly [number, number] {
  const sourceCrs = transform.sourceCrs;
  const targetCrs = transform.targetCrs ?? WGS84;

  if (!sourceCrs) {
    throw new Error("Serializable proj4 point geometry transform requires a source CRS.");
  }

  const sourceProjection = transform.sourceDefinition ?? sourceCrs;
  const targetProjection = transform.targetDefinition ?? targetCrs;
  const projection = proj4(sourceProjection, targetProjection);

  return createProjectedLocalLinearTransform(
    pointData,
    (x, y) => projection.forward([x, y]) as [number, number],
  );
}

function createProjectedLocalLinearTransform(
  pointData: CopcPointDataSampleArrays,
  project: (x: number, y: number) => readonly [number, number],
): (x: number, y: number) => readonly [number, number] {
  const [originX, originY] = findFinitePointDataOrigin(pointData);
  const [originLongitude, originLatitude] = project(originX, originY);
  const [xStepLongitude, xStepLatitude] = project(originX + 1, originY);
  const [yStepLongitude, yStepLatitude] = project(originX, originY + 1);
  const longitudePerX = xStepLongitude - originLongitude;
  const latitudePerX = xStepLatitude - originLatitude;
  const longitudePerY = yStepLongitude - originLongitude;
  const latitudePerY = yStepLatitude - originLatitude;

  return (x, y) => {
    const deltaX = x - originX;
    const deltaY = y - originY;

    return [
      originLongitude + deltaX * longitudePerX + deltaY * longitudePerY,
      originLatitude + deltaX * latitudePerX + deltaY * latitudePerY,
    ];
  };
}

function findFinitePointDataOrigin(
  pointData: CopcPointDataSampleArrays,
): readonly [number, number] {
  for (let pointIndex = 0; pointIndex < pointData.x.length; pointIndex += 1) {
    const x = pointData.x[pointIndex];
    const y = pointData.y[pointIndex];

    if (Number.isFinite(x) && Number.isFinite(y)) {
      return [x, y];
    }
  }

  return [0, 0];
}

function cartesianFromDegrees(
  longitudeDegrees: number,
  latitudeDegrees: number,
  heightMeters: number,
): readonly [number, number, number] {
  const longitude = degreesToRadians(longitudeDegrees);
  const latitude = degreesToRadians(latitudeDegrees);
  const cosLatitude = Math.cos(latitude);
  const sinLatitude = Math.sin(latitude);
  const normalRadius =
    WGS84_SEMI_MAJOR_AXIS /
    Math.sqrt(1 - WGS84_FIRST_ECCENTRICITY_SQUARED * sinLatitude * sinLatitude);

  return [
    (normalRadius + heightMeters) * cosLatitude * Math.cos(longitude),
    (normalRadius + heightMeters) * cosLatitude * Math.sin(longitude),
    (normalRadius * (1 - WGS84_FIRST_ECCENTRICITY_SQUARED) + heightMeters) *
      sinLatitude,
  ];
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
