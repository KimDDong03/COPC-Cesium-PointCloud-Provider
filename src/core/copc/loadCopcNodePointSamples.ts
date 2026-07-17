import { Copc } from "copc";
import type { Copc as CopcData, Getter, Hierarchy } from "copc";
import { getSharedLazPerf } from "./createLazPerf";
import { createSpatiallyDistributedPointIndices } from "./createSpatiallyDistributedPointIndices";
import type {
  CopcNodePointSampleResult,
  CopcPointColor,
  CopcPointDataSampleArrays,
  CopcPointDataSample,
  CopcPointSampleFormat,
} from "./CopcPointDataSample";

export interface LoadCopcNodePointSamplesOptions {
  readonly getter: Getter;
  readonly copc: CopcData;
  readonly nodeKey: string;
  readonly node: Hierarchy.Node;
  readonly maxPointCount: number;
  readonly sampleFormat?: CopcPointSampleFormat;
  readonly signal?: AbortSignal;
}

export interface LoadCopcNodePointDataViewOptions {
  readonly getter: Getter;
  readonly copc: CopcData;
  readonly node: Hierarchy.Node;
}

export interface SampleCopcPointDataViewOptions {
  readonly nodeKey: string;
  readonly view: CopcPointDataView;
  readonly maxPointCount: number;
  readonly sampleFormat?: CopcPointSampleFormat;
  readonly spatialPointOrder?: Uint32Array;
  readonly signal?: AbortSignal;
}

export interface CopcPointDataView {
  readonly pointCount: number;
  readonly dimensions: Record<string, unknown>;
  getter(name: string): (index: number) => number;
}

export async function loadCopcNodePointSamples(
  options: LoadCopcNodePointSamplesOptions,
): Promise<CopcNodePointSampleResult> {
  throwIfAborted(options.signal);
  const view = await loadCopcNodePointDataView(options);
  throwIfAborted(options.signal);

  return sampleCopcPointDataView({
    nodeKey: options.nodeKey,
    view,
    maxPointCount: options.maxPointCount,
    sampleFormat: options.sampleFormat,
    signal: options.signal,
  });
}

export async function loadCopcNodePointDataView(
  options: LoadCopcNodePointDataViewOptions,
): Promise<CopcPointDataView> {
  return Copc.loadPointDataView(
    options.getter,
    options.copc,
    options.node,
    {
      lazPerf: await getSharedLazPerf(),
      include: [
        "X",
        "Y",
        "Z",
        "Red",
        "Green",
        "Blue",
        "Classification",
        "Intensity",
      ],
    },
  );
}

export function sampleCopcPointDataView(
  options: SampleCopcPointDataViewOptions,
): CopcNodePointSampleResult {
  const { view } = options;
  validatePointCount("view.pointCount", view.pointCount);
  validatePointCount("maxPointCount", options.maxPointCount);
  validateSpatialPointOrder(options.spatialPointOrder, view.pointCount);
  throwIfAborted(options.signal);

  const sampledPointCount = Math.min(view.pointCount, options.maxPointCount);

  if (sampledPointCount === 0) {
    return {
      nodeKey: options.nodeKey,
      nodePointCount: view.pointCount,
      sampledPointCount: 0,
      points: [],
      ...(options.sampleFormat === "typed"
        ? {
            pointData: createPointDataSampleArrays(
              0,
              hasColorDimensions(view),
              "Classification" in view.dimensions,
              "Intensity" in view.dimensions,
            ),
          }
        : {}),
    };
  }

  const getX = view.getter("X");
  const getY = view.getter("Y");
  const getZ = view.getter("Z");
  const colorGetters = getColorGetters(view);
  const getClassification = getOptionalDimensionGetter(view, "Classification");
  const getIntensity = getOptionalDimensionGetter(view, "Intensity");
  const pointIndices =
    options.spatialPointOrder ??
    createSpatiallyDistributedPointIndices({
      pointCount: view.pointCount,
      sampleCount: sampledPointCount,
      getX,
      getY,
      getZ,
      signal: options.signal,
    });

  if (options.sampleFormat === "typed") {
    return sampleCopcPointDataViewAsTypedArrays({
      nodeKey: options.nodeKey,
      getX,
      getY,
      getZ,
      colorGetters,
      getClassification,
      getIntensity,
      nodePointCount: view.pointCount,
      sampledPointCount,
      pointIndices,
      signal: options.signal,
    });
  }

  const points: CopcPointDataSample[] = [];

  for (let sampleIndex = 0; sampleIndex < sampledPointCount; sampleIndex += 1) {
    checkForAbort(options.signal, sampleIndex);
    const pointIndex = readSpatialPointIndex(
      pointIndices,
      sampleIndex,
      view.pointCount,
    );

    points.push({
      x: getX(pointIndex),
      y: getY(pointIndex),
      z: getZ(pointIndex),
      color: colorGetters ? colorAt(colorGetters, pointIndex) : undefined,
      ...(getClassification
        ? {
            classification: normalizeClassification(
              getClassification(pointIndex),
            ),
          }
        : {}),
      ...(getIntensity
        ? { intensity: normalizeIntensity(getIntensity(pointIndex)) }
        : {}),
    });
  }

  throwIfAborted(options.signal);

  return {
    nodeKey: options.nodeKey,
    nodePointCount: view.pointCount,
    sampledPointCount,
    points,
  };
}

function sampleCopcPointDataViewAsTypedArrays(options: {
  readonly nodeKey: string;
  readonly getX: (index: number) => number;
  readonly getY: (index: number) => number;
  readonly getZ: (index: number) => number;
  readonly colorGetters:
    | {
        readonly red: (index: number) => number;
        readonly green: (index: number) => number;
        readonly blue: (index: number) => number;
      }
    | undefined;
  readonly getClassification: ((index: number) => number) | undefined;
  readonly getIntensity: ((index: number) => number) | undefined;
  readonly nodePointCount: number;
  readonly sampledPointCount: number;
  readonly pointIndices: Uint32Array;
  readonly signal: AbortSignal | undefined;
}): CopcNodePointSampleResult {
  const pointData = createPointDataSampleArrays(
    options.sampledPointCount,
    options.colorGetters !== undefined,
    options.getClassification !== undefined,
    options.getIntensity !== undefined,
  );

  for (
    let sampleIndex = 0;
    sampleIndex < options.sampledPointCount;
    sampleIndex += 1
  ) {
    checkForAbort(options.signal, sampleIndex);
    const pointIndex = readSpatialPointIndex(
      options.pointIndices,
      sampleIndex,
      options.nodePointCount,
    );
    pointData.x[sampleIndex] = options.getX(pointIndex);
    pointData.y[sampleIndex] = options.getY(pointIndex);
    pointData.z[sampleIndex] = options.getZ(pointIndex);

    if (
      pointData.red &&
      pointData.green &&
      pointData.blue &&
      options.colorGetters
    ) {
      pointData.red[sampleIndex] = normalizeColor(
        options.colorGetters.red(pointIndex),
      );
      pointData.green[sampleIndex] = normalizeColor(
        options.colorGetters.green(pointIndex),
      );
      pointData.blue[sampleIndex] = normalizeColor(
        options.colorGetters.blue(pointIndex),
      );
    }

    if (pointData.classification && options.getClassification) {
      pointData.classification[sampleIndex] = normalizeClassification(
        options.getClassification(pointIndex),
      );
    }

    if (pointData.intensity && options.getIntensity) {
      pointData.intensity[sampleIndex] = normalizeIntensity(
        options.getIntensity(pointIndex),
      );
    }
  }

  throwIfAborted(options.signal);

  return {
    nodeKey: options.nodeKey,
    nodePointCount: options.nodePointCount,
    sampledPointCount: options.sampledPointCount,
    points: [],
    pointData,
  };
}

function createPointDataSampleArrays(
  pointCount: number,
  includeColor: boolean,
  includeClassification: boolean,
  includeIntensity: boolean,
): CopcPointDataSampleArrays {
  return {
    x: new Float64Array(pointCount),
    y: new Float64Array(pointCount),
    z: new Float64Array(pointCount),
    red: includeColor ? new Uint8Array(pointCount) : undefined,
    green: includeColor ? new Uint8Array(pointCount) : undefined,
    blue: includeColor ? new Uint8Array(pointCount) : undefined,
    classification: includeClassification
      ? new Uint8Array(pointCount)
      : undefined,
    intensity: includeIntensity ? new Uint16Array(pointCount) : undefined,
  };
}

function getOptionalDimensionGetter(
  view: CopcPointDataView,
  name: string,
): ((index: number) => number) | undefined {
  return name in view.dimensions ? view.getter(name) : undefined;
}

function getColorGetters(view: {
  readonly dimensions: Record<string, unknown>;
  getter(name: string): (index: number) => number;
}):
  | {
      readonly red: (index: number) => number;
      readonly green: (index: number) => number;
      readonly blue: (index: number) => number;
    }
  | undefined {
  if (!hasColorDimensions(view)) {
    return undefined;
  }

  return {
    red: view.getter("Red"),
    green: view.getter("Green"),
    blue: view.getter("Blue"),
  };
}

function hasColorDimensions(view: {
  readonly dimensions: Record<string, unknown>;
}): boolean {
  return (
    "Red" in view.dimensions &&
    "Green" in view.dimensions &&
    "Blue" in view.dimensions
  );
}

function colorAt(
  getters: {
    readonly red: (index: number) => number;
    readonly green: (index: number) => number;
    readonly blue: (index: number) => number;
  },
  pointIndex: number,
): CopcPointColor {
  return {
    red: normalizeColor(getters.red(pointIndex)),
    green: normalizeColor(getters.green(pointIndex)),
    blue: normalizeColor(getters.blue(pointIndex)),
  };
}

function normalizeColor(value: number): number {
  const byteValue = value > 255 ? Math.round(value / 257) : Math.round(value);
  return Math.max(0, Math.min(255, byteValue));
}

function normalizeClassification(value: number): number {
  return normalizeUnsignedInteger(value, 255);
}

function normalizeIntensity(value: number): number {
  return normalizeUnsignedInteger(value, 65_535);
}

function normalizeUnsignedInteger(value: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(maximum, Math.round(value)));
}

function validatePointCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

function validateSpatialPointOrder(
  spatialPointOrder: Uint32Array | undefined,
  pointCount: number,
): void {
  if (spatialPointOrder && spatialPointOrder.length !== pointCount) {
    throw new RangeError(
      "spatialPointOrder length must match view.pointCount.",
    );
  }
}

function readSpatialPointIndex(
  spatialPointOrder: Uint32Array,
  sampleIndex: number,
  pointCount: number,
): number {
  const pointIndex = spatialPointOrder[sampleIndex];

  if (pointIndex === undefined || pointIndex >= pointCount) {
    throw new RangeError("spatialPointOrder contains an invalid point index.");
  }

  return pointIndex;
}

function checkForAbort(
  signal: AbortSignal | undefined,
  iteration: number,
): void {
  if ((iteration & 2_047) === 0) {
    throwIfAborted(signal);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }

  if (typeof DOMException !== "undefined") {
    throw new DOMException("COPC point sampling was aborted.", "AbortError");
  }

  const error = new Error("COPC point sampling was aborted.");
  error.name = "AbortError";
  throw error;
}
