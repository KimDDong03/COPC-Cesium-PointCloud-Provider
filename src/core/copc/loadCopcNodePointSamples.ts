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
  readonly timing?: LoadCopcNodePointDataViewTiming;
}

export interface LoadCopcNodePointDataViewTiming {
  onLazPerfInitialized(milliseconds: number): void;
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
  throwIfCopcPointSamplingAborted(options.signal);
  const view = await loadCopcNodePointDataView(options);
  throwIfCopcPointSamplingAborted(options.signal);

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
  const lazPerfStartedAt = nowMilliseconds();
  const lazPerf = await getSharedLazPerf();
  const lazPerfEndedAt = nowMilliseconds();
  options.timing?.onLazPerfInitialized(
    Math.max(0, lazPerfEndedAt - lazPerfStartedAt),
  );

  return Copc.loadPointDataView(
    options.getter,
    options.copc,
    options.node,
    {
      lazPerf,
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

function nowMilliseconds(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function sampleCopcPointDataView(
  options: SampleCopcPointDataViewOptions,
): CopcNodePointSampleResult {
  const { view } = options;
  validateCopcPointCount("view.pointCount", view.pointCount);
  validateCopcPointCount("maxPointCount", options.maxPointCount);
  validateCopcSpatialPointOrder(options.spatialPointOrder, view.pointCount);
  throwIfCopcPointSamplingAborted(options.signal);

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
    checkForCopcPointSamplingAbort(options.signal, sampleIndex);
    const pointIndex = readCopcSpatialPointIndex(
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
            classification: normalizeCopcPointClassification(
              getClassification(pointIndex),
            ),
          }
        : {}),
      ...(getIntensity
        ? { intensity: normalizeCopcPointIntensity(getIntensity(pointIndex)) }
        : {}),
    });
  }

  throwIfCopcPointSamplingAborted(options.signal);

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
    checkForCopcPointSamplingAbort(options.signal, sampleIndex);
    const pointIndex = readCopcSpatialPointIndex(
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
      pointData.red[sampleIndex] = normalizeCopcPointColorComponent(
        options.colorGetters.red(pointIndex),
      );
      pointData.green[sampleIndex] = normalizeCopcPointColorComponent(
        options.colorGetters.green(pointIndex),
      );
      pointData.blue[sampleIndex] = normalizeCopcPointColorComponent(
        options.colorGetters.blue(pointIndex),
      );
    }

    if (pointData.classification && options.getClassification) {
      pointData.classification[sampleIndex] = normalizeCopcPointClassification(
        options.getClassification(pointIndex),
      );
    }

    if (pointData.intensity && options.getIntensity) {
      pointData.intensity[sampleIndex] = normalizeCopcPointIntensity(
        options.getIntensity(pointIndex),
      );
    }
  }

  throwIfCopcPointSamplingAborted(options.signal);

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
    red: normalizeCopcPointColorComponent(getters.red(pointIndex)),
    green: normalizeCopcPointColorComponent(getters.green(pointIndex)),
    blue: normalizeCopcPointColorComponent(getters.blue(pointIndex)),
  };
}

export function normalizeCopcPointColorComponent(value: number): number {
  const byteValue = value > 255 ? Math.round(value / 257) : Math.round(value);
  return Math.max(0, Math.min(255, byteValue));
}

export function normalizeCopcPointClassification(value: number): number {
  return normalizeUnsignedInteger(value, 255);
}

export function normalizeCopcPointIntensity(value: number): number {
  return normalizeUnsignedInteger(value, 65_535);
}

function normalizeUnsignedInteger(value: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(maximum, Math.round(value)));
}

export function validateCopcPointCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

export function validateCopcSpatialPointOrder(
  spatialPointOrder: Uint32Array | undefined,
  pointCount: number,
): void {
  if (spatialPointOrder && spatialPointOrder.length !== pointCount) {
    throw new RangeError(
      "spatialPointOrder length must match view.pointCount.",
    );
  }
}

export function readCopcSpatialPointIndex(
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

export function checkForCopcPointSamplingAbort(
  signal: AbortSignal | undefined,
  iteration: number,
): void {
  if ((iteration & 2_047) === 0) {
    throwIfCopcPointSamplingAborted(signal);
  }
}

export function throwIfCopcPointSamplingAborted(
  signal: AbortSignal | undefined,
): void {
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
