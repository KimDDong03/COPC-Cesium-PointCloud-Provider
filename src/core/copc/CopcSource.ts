import { Copc } from "copc";
import type { Copc as CopcData, Getter, Hierarchy } from "copc";
import { createHttpRangeGetter } from "./createHttpRangeGetter";
import { getSharedLazPerf } from "./createLazPerf";
import type {
  CopcHierarchyNodeSummary,
  CopcHierarchySummary,
} from "./CopcHierarchySummary";
import type {
  CopcBounds,
  CopcInspection,
  CopcVlrSummary,
} from "./CopcInspection";
import type {
  CopcMultiNodePointSampleResult,
  CopcNodePointSampleResult,
  CopcPointColor,
  CopcPointDataSample,
} from "./CopcPointDataSample";

export interface LoadNodePointSamplesOptions {
  readonly nodeKey?: string;
  readonly maxPointCount?: number;
}

export interface LoadNodesPointSamplesOptions {
  readonly nodeKeys: readonly string[];
  readonly maxPointCountPerNode?: number;
}

const DEFAULT_MAX_POINT_COUNT = 5_000;
const DEFAULT_NODE_KEY = "0-0-0-0";

export class CopcSource {
  readonly url: string;

  private readonly getter: Getter;
  private readonly copcPromise: Promise<CopcData>;
  private hierarchyPromise: Promise<Hierarchy.Subtree> | undefined;
  private inspectionPromise: Promise<CopcInspection> | undefined;
  private hierarchySummaryPromise: Promise<CopcHierarchySummary> | undefined;
  private readonly nodePointSamplePromises = new Map<
    string,
    Promise<CopcNodePointSampleResult>
  >();

  constructor(url: string) {
    this.url = url;
    this.getter = createHttpRangeGetter(url);
    this.copcPromise = Copc.create(this.getter);
  }

  inspect(): Promise<CopcInspection> {
    this.inspectionPromise ??= this.copcPromise.then((copc) =>
      createInspection(this.url, copc),
    );

    return this.inspectionPromise;
  }

  loadHierarchySummary(): Promise<CopcHierarchySummary> {
    this.hierarchySummaryPromise ??= Promise.all([
      this.copcPromise,
      this.loadHierarchy(),
    ]).then(([copc, hierarchy]) => ({
      nodes: summarizeNodes(hierarchy.nodes, copc.info.cube),
      pageCount: Object.values(hierarchy.pages).filter(Boolean).length,
    }));

    return this.hierarchySummaryPromise;
  }

  loadNodePointSamples(
    options: LoadNodePointSamplesOptions = {},
  ): Promise<CopcNodePointSampleResult> {
    const maxPointCount = options.maxPointCount ?? DEFAULT_MAX_POINT_COUNT;
    const nodeKey = options.nodeKey ?? DEFAULT_NODE_KEY;

    if (!Number.isSafeInteger(maxPointCount) || maxPointCount <= 0) {
      throw new Error("maxPointCount must be a positive integer.");
    }

    const cacheKey = `${nodeKey}:${maxPointCount}`;
    const cached = this.nodePointSamplePromises.get(cacheKey);

    if (cached) {
      return cached;
    }

    const promise = this.loadNodePointSamplesWithoutCache(nodeKey, maxPointCount);
    this.nodePointSamplePromises.set(cacheKey, promise);
    return promise;
  }

  async loadNodesPointSamples(
    options: LoadNodesPointSamplesOptions,
  ): Promise<CopcMultiNodePointSampleResult> {
    const nodeKeys = [...new Set(options.nodeKeys)];

    if (nodeKeys.length === 0) {
      throw new Error("At least one COPC hierarchy node key is required.");
    }

    const nodeResults = await Promise.all(
      nodeKeys.map((nodeKey) =>
        this.loadNodePointSamples({
          nodeKey,
          maxPointCount: options.maxPointCountPerNode,
        }),
      ),
    );

    return {
      nodeKeys,
      nodeResults,
      nodePointCount: nodeResults.reduce(
        (total, result) => total + result.nodePointCount,
        0,
      ),
      sampledPointCount: nodeResults.reduce(
        (total, result) => total + result.sampledPointCount,
        0,
      ),
      points: nodeResults.flatMap((result) => result.points),
    };
  }

  private loadHierarchy(): Promise<Hierarchy.Subtree> {
    this.hierarchyPromise ??= this.copcPromise.then((copc) =>
      Copc.loadHierarchyPage(this.getter, copc.info.rootHierarchyPage),
    );

    return this.hierarchyPromise;
  }

  private async loadNodePointSamplesWithoutCache(
    nodeKey: string,
    maxPointCount: number,
  ): Promise<CopcNodePointSampleResult> {
    const [copc, hierarchy] = await Promise.all([
      this.copcPromise,
      this.loadHierarchy(),
    ]);
    const node = hierarchy.nodes[nodeKey];

    if (!node) {
      throw new Error(`COPC hierarchy node was not found: ${nodeKey}`);
    }

    const view = await Copc.loadPointDataView(this.getter, copc, node, {
      lazPerf: await getSharedLazPerf(),
      include: ["X", "Y", "Z", "Red", "Green", "Blue"],
    });

    const getX = view.getter("X");
    const getY = view.getter("Y");
    const getZ = view.getter("Z");
    const colorGetters = getColorGetters(view);
    const sampledPointCount = Math.min(view.pointCount, maxPointCount);
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
      nodeKey,
      nodePointCount: view.pointCount,
      sampledPointCount,
      points,
    };
  }
}

function createInspection(sourceUrl: string, copc: CopcData): CopcInspection {
  return {
    sourceUrl,
    pointCount: copc.header.pointCount,
    lasVersion: `${copc.header.majorVersion}.${copc.header.minorVersion}`,
    pointDataRecordFormat: copc.header.pointDataRecordFormat,
    pointDataRecordLength: copc.header.pointDataRecordLength,
    bounds: boundsFromTuple([...copc.header.min, ...copc.header.max]),
    cube: boundsFromTuple(copc.info.cube),
    scale: copc.header.scale,
    offset: copc.header.offset,
    spacing: copc.info.spacing,
    gpsTimeRange: copc.info.gpsTimeRange,
    rootHierarchyPage: {
      pageOffset: copc.info.rootHierarchyPage.pageOffset,
      pageLength: copc.info.rootHierarchyPage.pageLength,
    },
    vlrs: summarizeVlrs(copc),
    wkt: copc.wkt ?? null,
  };
}

function summarizeVlrs(copc: CopcData): CopcVlrSummary[] {
  return copc.vlrs.map((vlr) => ({
    userId: vlr.userId,
    recordId: vlr.recordId,
    description: vlr.description,
    contentLength: vlr.contentLength,
    isExtended: vlr.isExtended,
  }));
}

function summarizeNodes(
  nodes: Hierarchy.Node.Map,
  cube: readonly number[],
): CopcHierarchyNodeSummary[] {
  return Object.entries(nodes)
    .flatMap(([key, node]) => {
      if (!node) {
        return [];
      }

      return [
        {
          ...createNodeSummary(key, node, cube),
          key,
        },
      ];
    })
    .sort(compareNodes);
}

function createNodeSummary(
  key: string,
  node: Hierarchy.Node,
  cube: readonly number[],
): Omit<CopcHierarchyNodeSummary, "key"> {
  const parsedKey = parseNodeKey(key);
  const bounds = boundsForNode(cube, parsedKey);
  const volume = Math.max(
    (bounds.maxX - bounds.minX) *
      (bounds.maxY - bounds.minY) *
      (bounds.maxZ - bounds.minZ),
    Number.EPSILON,
  );

  return {
    ...parsedKey,
    bounds,
    pointCount: node.pointCount,
    pointDensity: node.pointCount / volume,
    pointDataOffset: node.pointDataOffset,
    pointDataLength: node.pointDataLength,
  };
}

function parseNodeKey(
  key: string,
): Pick<CopcHierarchyNodeSummary, "depth" | "x" | "y" | "z"> {
  const parts = key.split("-").map(Number);

  if (parts.length !== 4 || parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`Invalid COPC hierarchy node key: ${key}`);
  }

  const [depth, x, y, z] = parts;

  return {
    depth,
    x,
    y,
    z,
  };
}

function boundsForNode(
  cube: readonly number[],
  key: Pick<CopcHierarchyNodeSummary, "depth" | "x" | "y" | "z">,
): CopcBounds {
  const cubeBounds = boundsFromTuple(cube);
  const divisions = 2 ** key.depth;
  const width = (cubeBounds.maxX - cubeBounds.minX) / divisions;
  const depth = (cubeBounds.maxY - cubeBounds.minY) / divisions;
  const height = (cubeBounds.maxZ - cubeBounds.minZ) / divisions;
  const minX = cubeBounds.minX + key.x * width;
  const minY = cubeBounds.minY + key.y * depth;
  const minZ = cubeBounds.minZ + key.z * height;

  return {
    minX,
    minY,
    minZ,
    maxX: minX + width,
    maxY: minY + depth,
    maxZ: minZ + height,
  };
}

function compareNodes(
  left: CopcHierarchyNodeSummary,
  right: CopcHierarchyNodeSummary,
): number {
  return (
    left.depth - right.depth ||
    left.z - right.z ||
    left.y - right.y ||
    left.x - right.x
  );
}

function boundsFromTuple(bounds: readonly number[]): CopcBounds {
  if (bounds.length !== 6) {
    throw new Error(`Expected six bound values, received ${bounds.length}.`);
  }

  return {
    minX: bounds[0],
    minY: bounds[1],
    minZ: bounds[2],
    maxX: bounds[3],
    maxY: bounds[4],
    maxZ: bounds[5],
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
  index: number,
): CopcPointColor {
  return {
    red: toByteColor(getters.red(index)),
    green: toByteColor(getters.green(index)),
    blue: toByteColor(getters.blue(index)),
  };
}

function toByteColor(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value / 257)));
}
