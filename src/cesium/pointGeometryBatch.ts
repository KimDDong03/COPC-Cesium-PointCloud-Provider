import proj4 from "proj4";
import type {
  CopcNodePointSampleResult,
  CopcPointDataSample,
  CopcPointDataSampleArrays,
} from "../core/copc/CopcPointDataSample";
import {
  checkForCopcPointSamplingAbort,
  normalizeCopcPointClassification,
  normalizeCopcPointColorComponent,
  normalizeCopcPointIntensity,
  readCopcSpatialPointIndex,
  throwIfCopcPointSamplingAborted,
  validateCopcPointCount,
  validateCopcSpatialPointOrder,
  type CopcPointDataView,
} from "../core/copc/loadCopcNodePointSamples";
import type { CopcHierarchyNodeSummary } from "../core/copc/CopcHierarchySummary";
import type { CopcInspection } from "../core/copc/CopcInspection";
import type { PointGeometryBatch } from "./CopcPointCloudRenderer";
import {
  colorizeCopcPointComponents,
  colorizeCopcPoint,
  type ResolvedCopcPointColorStyle,
} from "./copcPointColorizer";
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

export function getPointGeometryBatchBackingBuffers(
  batch: PointGeometryBatch,
): readonly ArrayBufferLike[] {
  const buffers = new Set<ArrayBufferLike>([
    batch.positions.buffer,
    batch.colors.buffer,
  ]);

  return [...buffers];
}

export function estimatePointGeometryBatchByteSize(
  batch: PointGeometryBatch,
): number {
  return getPointGeometryBatchBackingBuffers(batch).reduce(
    (byteSize, buffer) => byteSize + buffer.byteLength,
    0,
  );
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
  pointColorStyle?: ResolvedCopcPointColorStyle,
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
    pointColorStyle,
  });
}

/**
 * Adds the world-space sampling metadata used by adaptive point renderers.
 *
 * COPC spacing is expressed in the source CRS and halves at every hierarchy
 * depth. Measuring one source-spacing step through the configured coordinate
 * transform keeps the renderer independent from the source CRS (including
 * geographic coordinates and projected units such as US survey feet).
 */
export function withCopcPointGeometryBatchRenderMetadata(options: {
  readonly batch: PointGeometryBatch;
  readonly inspection: CopcInspection;
  readonly node: CopcHierarchyNodeSummary;
  readonly coordinateTransform: CopcCoordinateTransformSet["toCesium"];
}): PointGeometryBatch {
  const pointSpacingMeters = estimateCopcNodePointSpacingMeters(
    options.inspection,
    options.node,
    options.coordinateTransform,
  );
  const pointDensityScale =
    options.node.pointCount > 0 && options.batch.pointCount > 0
      ? Math.min(1, options.batch.pointCount / options.node.pointCount)
      : undefined;

  if (pointSpacingMeters === undefined && pointDensityScale === undefined) {
    return options.batch;
  }

  return {
    ...options.batch,
    pointSpacingMeters,
    pointDensityScale,
  };
}

export function estimateCopcNodePointSpacingMeters(
  inspection: CopcInspection,
  node: Pick<CopcHierarchyNodeSummary, "bounds" | "depth">,
  coordinateTransform: CopcCoordinateTransformSet["toCesium"],
): number | undefined {
  const sourceSpacing = inspection.spacing / 2 ** node.depth;

  if (!Number.isFinite(sourceSpacing) || sourceSpacing <= 0) {
    return undefined;
  }

  try {
    const centerX = (node.bounds.minX + node.bounds.maxX) / 2;
    const centerY = (node.bounds.minY + node.bounds.maxY) / 2;
    const centerZ = (node.bounds.minZ + node.bounds.maxZ) / 2;
    const origin = coordinateTransform(centerX, centerY, centerZ);
    const xStep = coordinateTransform(
      centerX + sourceSpacing,
      centerY,
      centerZ,
    );
    const yStep = coordinateTransform(
      centerX,
      centerY + sourceSpacing,
      centerZ,
    );
    const originCartesian = cartesianFromDegrees(
      origin.longitudeDegrees,
      origin.latitudeDegrees,
      origin.heightMeters,
    );
    const distances = [xStep, yStep]
      .map((coordinate) =>
        distanceBetweenCartesianCoordinates(
          originCartesian,
          cartesianFromDegrees(
            coordinate.longitudeDegrees,
            coordinate.latitudeDegrees,
            coordinate.heightMeters,
          ),
        ),
      )
      .filter((distance) => Number.isFinite(distance) && distance > 0);

    if (distances.length === 0) {
      return undefined;
    }

    return (
      distances.reduce((total, distance) => total + distance, 0) /
      distances.length
    );
  } catch {
    // Spacing is optional render metadata. A domain-limited application
    // transform may accept every source point yet reject this synthetic probe.
    return undefined;
  }
}

export function createPointGeometryBatchFromSerializableTransform(options: {
  readonly key: string;
  readonly pointData: CopcPointDataSampleArrays;
  readonly transform: CesiumPointGeometryTransform;
  readonly pointColorStyle?: ResolvedCopcPointColorStyle;
}): PointGeometryBatch {
  const coordinateTransform = createSerializableCoordinateTransform(
    options.pointData,
    options.transform,
  );

  return createPointGeometryBatchFromPointData({
    key: options.key,
    pointData: options.pointData,
    coordinateTransform,
    pointColorStyle: options.pointColorStyle,
  });
}

export function createPointGeometryBatchFromCopcPointDataView(options: {
  readonly nodeKey: string;
  readonly view: CopcPointDataView;
  readonly maxPointCount: number;
  readonly spatialPointOrder: Uint32Array;
  readonly transform: CesiumPointGeometryTransform;
  readonly pointColorStyle?: ResolvedCopcPointColorStyle;
  readonly signal?: AbortSignal;
}): {
  readonly pointSamples: CopcNodePointSampleResult;
  readonly geometryBatch: PointGeometryBatch;
} {
  const { view } = options;
  validateCopcPointCount("view.pointCount", view.pointCount);
  validateCopcPointCount("maxPointCount", options.maxPointCount);
  validateCopcSpatialPointOrder(options.spatialPointOrder, view.pointCount);
  throwIfCopcPointSamplingAborted(options.signal);

  const sampledPointCount = Math.min(view.pointCount, options.maxPointCount);
  const pointSamples: CopcNodePointSampleResult = {
    nodeKey: options.nodeKey,
    nodePointCount: view.pointCount,
    sampledPointCount,
    points: [],
  };

  if (sampledPointCount === 0) {
    return {
      pointSamples,
      geometryBatch: {
        key: createNodePointSampleBatchKey(pointSamples),
        pointCount: 0,
        positions: new Float64Array(0),
        colors: new Uint8Array(0),
        positionBounds: undefined,
        hasTranslucentColors: false,
      },
    };
  }

  return {
    pointSamples,
    geometryBatch: createPointGeometryBatchFromCopcPointDataViewData({
      key: createNodePointSampleBatchKey(pointSamples),
      view,
      sampledPointCount,
      spatialPointOrder: options.spatialPointOrder,
      transform: options.transform,
      pointColorStyle: options.pointColorStyle,
      signal: options.signal,
    }),
  };
}

export function createPointDataSampleArraysFromPoints(
  points: readonly CopcPointDataSample[],
): CopcPointDataSampleArrays {
  const hasAnyColor = points.some((point) => point.color);
  const hasAnyClassification = points.some(
    (point) => point.classification !== undefined,
  );
  const hasAnyIntensity = points.some(
    (point) => point.intensity !== undefined,
  );
  const pointData: CopcPointDataSampleArrays = {
    x: new Float64Array(points.length),
    y: new Float64Array(points.length),
    z: new Float64Array(points.length),
    red: hasAnyColor ? new Uint8Array(points.length) : undefined,
    green: hasAnyColor ? new Uint8Array(points.length) : undefined,
    blue: hasAnyColor ? new Uint8Array(points.length) : undefined,
    classification: hasAnyClassification
      ? new Uint8Array(points.length)
      : undefined,
    intensity: hasAnyIntensity ? new Uint16Array(points.length) : undefined,
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

    if (pointData.classification) {
      pointData.classification[pointIndex] = point.classification ?? 0;
    }

    if (pointData.intensity) {
      pointData.intensity[pointIndex] = point.intensity ?? 0;
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
      ...(pointData.classification
        ? { classification: pointData.classification[pointIndex] }
        : {}),
      ...(pointData.intensity
        ? { intensity: pointData.intensity[pointIndex] }
        : {}),
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
  readonly pointColorStyle?: ResolvedCopcPointColorStyle;
}): PointGeometryBatch {
  const pointCount = options.pointData.x.length;
  const positions = new Float64Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    const position = options.coordinateTransform(
      options.pointData.x[pointIndex],
      options.pointData.y[pointIndex],
      options.pointData.z[pointIndex],
    );
    const positionOffset = pointIndex * 3;
    const colorOffset = pointIndex * 4;
    const packedColor = colorizeCopcPoint(
      options.pointData,
      pointIndex,
      options.pointColorStyle,
    );

    positions[positionOffset] = position[0];
    positions[positionOffset + 1] = position[1];
    positions[positionOffset + 2] = position[2];
    if (
      Number.isFinite(position[0]) &&
      Number.isFinite(position[1]) &&
      Number.isFinite(position[2])
    ) {
      minX = Math.min(minX, position[0]);
      minY = Math.min(minY, position[1]);
      minZ = Math.min(minZ, position[2]);
      maxX = Math.max(maxX, position[0]);
      maxY = Math.max(maxY, position[1]);
      maxZ = Math.max(maxZ, position[2]);
    }
    colors[colorOffset] = (packedColor >> 16) & 255;
    colors[colorOffset + 1] = (packedColor >> 8) & 255;
    colors[colorOffset + 2] = packedColor & 255;
    colors[colorOffset + 3] = DEFAULT_GEOMETRY_POINT_COLOR.alpha;
  }

  return {
    key: options.key,
    pointCount,
    positions,
    colors,
    positionBounds:
      minX <= maxX && minY <= maxY && minZ <= maxZ
        ? { minX, minY, minZ, maxX, maxY, maxZ }
        : undefined,
    hasTranslucentColors: false,
  };
}

function createPointGeometryBatchFromCopcPointDataViewData(options: {
  readonly key: string;
  readonly view: CopcPointDataView;
  readonly sampledPointCount: number;
  readonly spatialPointOrder: Uint32Array;
  readonly transform: CesiumPointGeometryTransform;
  readonly pointColorStyle?: ResolvedCopcPointColorStyle;
  readonly signal: AbortSignal | undefined;
}): PointGeometryBatch {
  const pointCount = options.sampledPointCount;
  const positions = new Float64Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);
  const getX = options.view.getter("X");
  const getY = options.view.getter("Y");
  const getZ = options.view.getter("Z");
  const colorGetters = getCopcPointDataViewColorGetters(options.view);
  const getClassification = getOptionalCopcPointDataViewGetter(
    options.view,
    "Classification",
  );
  const getIntensity = getOptionalCopcPointDataViewGetter(
    options.view,
    "Intensity",
  );
  const coordinateTransform = createSerializableCoordinateTransformForSource(
    {
      pointCount,
      getPointIndex: (sampleIndex) =>
        readCopcSpatialPointIndex(
          options.spatialPointOrder,
          sampleIndex,
          options.view.pointCount,
        ),
      getX,
      getY,
    },
    options.transform,
  );
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let sampleIndex = 0; sampleIndex < pointCount; sampleIndex += 1) {
    checkForCopcPointSamplingAbort(options.signal, sampleIndex);
    const pointIndex = readCopcSpatialPointIndex(
      options.spatialPointOrder,
      sampleIndex,
      options.view.pointCount,
    );
    const x = getX(pointIndex);
    const y = getY(pointIndex);
    const z = getZ(pointIndex);
    const position = coordinateTransform(x, y, z);
    const packedColor = colorizeCopcPointComponents(
      z,
      colorGetters
        ? normalizeCopcPointColorComponent(colorGetters.red(pointIndex))
        : undefined,
      colorGetters
        ? normalizeCopcPointColorComponent(colorGetters.green(pointIndex))
        : undefined,
      colorGetters
        ? normalizeCopcPointColorComponent(colorGetters.blue(pointIndex))
        : undefined,
      getClassification
        ? normalizeCopcPointClassification(getClassification(pointIndex))
        : undefined,
      getIntensity
        ? normalizeCopcPointIntensity(getIntensity(pointIndex))
        : undefined,
      options.pointColorStyle,
    );
    const positionOffset = sampleIndex * 3;
    const colorOffset = sampleIndex * 4;

    positions[positionOffset] = position[0];
    positions[positionOffset + 1] = position[1];
    positions[positionOffset + 2] = position[2];
    if (
      Number.isFinite(position[0]) &&
      Number.isFinite(position[1]) &&
      Number.isFinite(position[2])
    ) {
      minX = Math.min(minX, position[0]);
      minY = Math.min(minY, position[1]);
      minZ = Math.min(minZ, position[2]);
      maxX = Math.max(maxX, position[0]);
      maxY = Math.max(maxY, position[1]);
      maxZ = Math.max(maxZ, position[2]);
    }
    colors[colorOffset] = (packedColor >> 16) & 255;
    colors[colorOffset + 1] = (packedColor >> 8) & 255;
    colors[colorOffset + 2] = packedColor & 255;
    colors[colorOffset + 3] = DEFAULT_GEOMETRY_POINT_COLOR.alpha;
  }

  throwIfCopcPointSamplingAborted(options.signal);

  return {
    key: options.key,
    pointCount,
    positions,
    colors,
    positionBounds:
      minX <= maxX && minY <= maxY && minZ <= maxZ
        ? { minX, minY, minZ, maxX, maxY, maxZ }
        : undefined,
    hasTranslucentColors: false,
  };
}

function createSerializableCoordinateTransform(
  pointData: CopcPointDataSampleArrays,
  transform: CesiumPointGeometryTransform,
): (x: number, y: number, z: number) => readonly [number, number, number] {
  return createSerializableCoordinateTransformForSource(
    {
      pointCount: pointData.x.length,
      getX: (pointIndex) => pointData.x[pointIndex],
      getY: (pointIndex) => pointData.y[pointIndex],
    },
    transform,
  );
}

interface SampledHorizontalCoordinateSource {
  readonly pointCount: number;
  readonly getPointIndex?: (sampleIndex: number) => number;
  readonly getX: (index: number) => number;
  readonly getY: (index: number) => number;
}

function createSerializableCoordinateTransformForSource(
  source: SampledHorizontalCoordinateSource,
  transform: CesiumPointGeometryTransform,
): (x: number, y: number, z: number) => readonly [number, number, number] {
  if (transform.kind === "geographic") {
    return (x, y, z) =>
      cartesianFromDegrees(x, y, z * transform.heightScaleToMeters);
  }

  let project: (x: number, y: number) => readonly [number, number];

  if (transform.kind === "epsg:2992") {
    configureKnownCopcProjections();
    const projection = proj4(EPSG_2992, WGS84);
    project = (x, y) => projection.forward([x, y]) as [number, number];
  } else {
    const sourceCrs = transform.sourceCrs;
    const targetCrs = transform.targetCrs ?? WGS84;

    if (!sourceCrs) {
      throw new Error(
        "Serializable proj4 point geometry transform requires a source CRS.",
      );
    }

    const projection = proj4(
      transform.sourceDefinition ?? sourceCrs,
      transform.targetDefinition ?? targetCrs,
    );
    project = (x, y) => projection.forward([x, y]) as [number, number];
  }

  const [originX, originY] = findFiniteHorizontalPoint(source);
  const [originLongitude, originLatitude] = project(originX, originY);
  const [xStepLongitude, xStepLatitude] = project(originX + 1, originY);
  const [yStepLongitude, yStepLatitude] = project(originX, originY + 1);
  const longitudePerX = xStepLongitude - originLongitude;
  const latitudePerX = xStepLatitude - originLatitude;
  const longitudePerY = yStepLongitude - originLongitude;
  const latitudePerY = yStepLatitude - originLatitude;

  return (x, y, z) => {
    const deltaX = x - originX;
    const deltaY = y - originY;
    const longitudeDegrees =
      originLongitude + deltaX * longitudePerX + deltaY * longitudePerY;
    const latitudeDegrees =
      originLatitude + deltaX * latitudePerX + deltaY * latitudePerY;

    return cartesianFromDegrees(
      longitudeDegrees,
      latitudeDegrees,
      z * transform.heightScaleToMeters,
    );
  };
}

function findFiniteHorizontalPoint(
  source: SampledHorizontalCoordinateSource,
): readonly [number, number] {
  for (let sampleIndex = 0; sampleIndex < source.pointCount; sampleIndex += 1) {
    const pointIndex = source.getPointIndex?.(sampleIndex) ?? sampleIndex;
    const x = source.getX(pointIndex);
    const y = source.getY(pointIndex);

    if (Number.isFinite(x) && Number.isFinite(y)) {
      return [x, y];
    }
  }

  return [0, 0];
}

function getOptionalCopcPointDataViewGetter(
  view: CopcPointDataView,
  name: string,
): ((index: number) => number) | undefined {
  return name in view.dimensions ? view.getter(name) : undefined;
}

function getCopcPointDataViewColorGetters(
  view: CopcPointDataView,
):
  | {
      readonly red: (index: number) => number;
      readonly green: (index: number) => number;
      readonly blue: (index: number) => number;
    }
  | undefined {
  if (
    !(
      "Red" in view.dimensions &&
      "Green" in view.dimensions &&
      "Blue" in view.dimensions
    )
  ) {
    return undefined;
  }

  return {
    red: view.getter("Red"),
    green: view.getter("Green"),
    blue: view.getter("Blue"),
  };
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

function distanceBetweenCartesianCoordinates(
  first: readonly [number, number, number],
  second: readonly [number, number, number],
): number {
  return Math.hypot(
    second[0] - first[0],
    second[1] - first[1],
    second[2] - first[2],
  );
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
