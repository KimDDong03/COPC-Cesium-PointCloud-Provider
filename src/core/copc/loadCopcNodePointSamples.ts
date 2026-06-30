import { Copc } from "copc";
import type { Copc as CopcData, Getter, Hierarchy } from "copc";
import { getSharedLazPerf } from "./createLazPerf";
import type {
  CopcNodePointSampleResult,
  CopcPointColor,
  CopcPointDataSample,
} from "./CopcPointDataSample";

export interface LoadCopcNodePointSamplesOptions {
  readonly getter: Getter;
  readonly copc: CopcData;
  readonly nodeKey: string;
  readonly node: Hierarchy.Node;
  readonly maxPointCount: number;
}

export async function loadCopcNodePointSamples(
  options: LoadCopcNodePointSamplesOptions,
): Promise<CopcNodePointSampleResult> {
  const view = await Copc.loadPointDataView(
    options.getter,
    options.copc,
    options.node,
    {
      lazPerf: await getSharedLazPerf(),
      include: ["X", "Y", "Z", "Red", "Green", "Blue"],
    },
  );

  const getX = view.getter("X");
  const getY = view.getter("Y");
  const getZ = view.getter("Z");
  const colorGetters = getColorGetters(view);
  const sampledPointCount = Math.min(view.pointCount, options.maxPointCount);
  const step = view.pointCount / sampledPointCount;
  const points: CopcPointDataSample[] = [];

  for (let sampleIndex = 0; sampleIndex < sampledPointCount; sampleIndex += 1) {
    const pointIndex = Math.min(
      view.pointCount - 1,
      Math.floor(sampleIndex * step),
    );

    points.push({
      x: getX(pointIndex),
      y: getY(pointIndex),
      z: getZ(pointIndex),
      color: colorGetters ? colorAt(colorGetters, pointIndex) : undefined,
    });
  }

  return {
    nodeKey: options.nodeKey,
    nodePointCount: view.pointCount,
    sampledPointCount,
    points,
  };
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
  if (!("Red" in view.dimensions) || !("Green" in view.dimensions) || !("Blue" in view.dimensions)) {
    return undefined;
  }

  return {
    red: view.getter("Red"),
    green: view.getter("Green"),
    blue: view.getter("Blue"),
  };
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
