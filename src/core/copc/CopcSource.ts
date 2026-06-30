import { Copc } from "copc";
import type { Copc as CopcData, Getter, Hierarchy } from "copc";
import { createHttpRangeGetter } from "./createHttpRangeGetter";
import { getSharedLazPerf } from "./createLazPerf";
import type {
  CopcHierarchyPageReference,
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
  CopcPointSampleCacheStats,
} from "./CopcPointDataSample";

export interface LoadNodePointSamplesOptions {
  readonly nodeKey?: string;
  readonly maxPointCount?: number;
}

export interface LoadNodesPointSamplesOptions {
  readonly nodeKeys: readonly string[];
  readonly maxPointCountPerNode?: number;
}

export interface LoadHierarchyPagesResult {
  readonly hierarchy: CopcHierarchySummary;
  readonly loadedPageKeys: readonly string[];
}

export interface CopcSourceOptions {
  readonly maxCachedSampleSets?: number;
  readonly maxCachedPointSampleBytes?: number;
}

const DEFAULT_MAX_POINT_COUNT = 5_000;
const DEFAULT_NODE_KEY = "0-0-0-0";
const DEFAULT_MAX_CACHED_SAMPLE_SETS = 32;
const DEFAULT_MAX_CACHED_POINT_SAMPLE_BYTES = 32 * 1024 * 1024;
const POINT_SAMPLE_COORDINATE_BYTES = 3 * 8;
const POINT_SAMPLE_COLOR_BYTES = 3;

interface PointSampleCacheEntry {
  readonly promise: Promise<CopcNodePointSampleResult>;
  estimatedByteSize: number;
}

export class CopcSource {
  readonly url: string;

  private readonly maxCachedSampleSets: number;
  private readonly maxCachedPointSampleBytes: number;
  private readonly getter: Getter;
  private readonly copcPromise: Promise<CopcData>;
  private hierarchyPromise: Promise<Hierarchy.Subtree> | undefined;
  private inspectionPromise: Promise<CopcInspection> | undefined;
  private readonly hierarchyPagePromises = new Map<
    string,
    Promise<Hierarchy.Subtree>
  >();
  private readonly loadedHierarchyPageIds = new Set<string>();
  private readonly nodePointSampleCache = new Map<
    string,
    PointSampleCacheEntry
  >();
  private cachedPointSampleBytes = 0;
  private pointSampleCacheHitCount = 0;
  private pointSampleCacheMissCount = 0;
  private pointSampleCacheEvictionCount = 0;

  constructor(url: string, options: CopcSourceOptions = {}) {
    const maxCachedSampleSets =
      options.maxCachedSampleSets ?? DEFAULT_MAX_CACHED_SAMPLE_SETS;
    const maxCachedPointSampleBytes =
      options.maxCachedPointSampleBytes ??
      DEFAULT_MAX_CACHED_POINT_SAMPLE_BYTES;

    if (
      !Number.isSafeInteger(maxCachedSampleSets) ||
      maxCachedSampleSets <= 0
    ) {
      throw new Error("maxCachedSampleSets must be a positive integer.");
    }

    if (
      !Number.isSafeInteger(maxCachedPointSampleBytes) ||
      maxCachedPointSampleBytes <= 0
    ) {
      throw new Error("maxCachedPointSampleBytes must be a positive integer.");
    }

    this.url = url;
    this.maxCachedSampleSets = maxCachedSampleSets;
    this.maxCachedPointSampleBytes = maxCachedPointSampleBytes;
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
    return Promise.all([
      this.copcPromise,
      this.loadHierarchy(),
    ]).then(([copc, hierarchy]) =>
      summarizeHierarchy(
        hierarchy,
        copc.info.cube,
        this.loadedHierarchyPageIds.size,
      ),
    );
  }

  async loadHierarchyPage(pageKey: string): Promise<CopcHierarchySummary> {
    const [copc, hierarchy] = await Promise.all([
      this.copcPromise,
      this.loadHierarchy(),
    ]);
    const page = hierarchy.pages[pageKey];

    if (!page) {
      if (hierarchy.nodes[pageKey]) {
        return summarizeHierarchy(
          hierarchy,
          copc.info.cube,
          this.loadedHierarchyPageIds.size,
        );
      }

      throw new Error(`COPC hierarchy page was not found: ${pageKey}`);
    }

    const subtree = await this.loadHierarchyPageData(page);
    this.loadedHierarchyPageIds.add(hierarchyPageId(page));
    delete hierarchy.pages[pageKey];
    mergeHierarchy(hierarchy, subtree);

    return summarizeHierarchy(
      hierarchy,
      copc.info.cube,
      this.loadedHierarchyPageIds.size,
    );
  }

  async loadHierarchyPages(
    pageKeys: readonly string[],
  ): Promise<LoadHierarchyPagesResult> {
    const loadedPageKeys: string[] = [];
    let hierarchy: CopcHierarchySummary | undefined;

    for (const pageKey of [...new Set(pageKeys)]) {
      const before = await this.loadHierarchySummary();

      if (!before.pendingPages.some((page) => page.key === pageKey)) {
        if (before.nodes.some((node) => node.key === pageKey)) {
          hierarchy = before;
          continue;
        }

        throw new Error(`COPC hierarchy page was not found: ${pageKey}`);
      }

      hierarchy = await this.loadHierarchyPage(pageKey);
      loadedPageKeys.push(pageKey);
    }

    return {
      hierarchy: hierarchy ?? (await this.loadHierarchySummary()),
      loadedPageKeys,
    };
  }

  async loadNextHierarchyPage(): Promise<CopcHierarchySummary | undefined> {
    const hierarchy = await this.loadHierarchy();
    const nextPageKey = Object.keys(hierarchy.pages).sort(compareNodeKeys)[0];

    if (!nextPageKey) {
      return undefined;
    }

    return this.loadHierarchyPage(nextPageKey);
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
    const cached = this.nodePointSampleCache.get(cacheKey);

    if (cached) {
      this.pointSampleCacheHitCount += 1;
      this.nodePointSampleCache.delete(cacheKey);
      this.nodePointSampleCache.set(cacheKey, cached);
      return cached.promise;
    }

    this.pointSampleCacheMissCount += 1;
    let entry: PointSampleCacheEntry;
    const promise = this.loadNodePointSamplesWithoutCache(
      nodeKey,
      maxPointCount,
    )
      .then((result) => {
        if (this.nodePointSampleCache.get(cacheKey) !== entry) {
          return result;
        }

        const estimatedByteSize = estimatePointSampleResultByteSize(result);
        this.cachedPointSampleBytes +=
          estimatedByteSize - entry.estimatedByteSize;
        entry.estimatedByteSize = estimatedByteSize;
        this.evictPointSampleCacheIfNeeded();
        return result;
      })
      .catch((error: unknown) => {
        if (this.nodePointSampleCache.get(cacheKey) === entry) {
          this.deletePointSampleCacheEntry(cacheKey, false);
        }

        throw error;
      });
    entry = {
      promise,
      estimatedByteSize: 0,
    };
    this.nodePointSampleCache.set(cacheKey, entry);
    this.evictPointSampleCacheIfNeeded();
    return promise;
  }

  getPointSampleCacheStats(): CopcPointSampleCacheStats {
    return {
      cachedSampleSetCount: this.nodePointSampleCache.size,
      maxCachedSampleSetCount: this.maxCachedSampleSets,
      cachedPointSampleBytes: this.cachedPointSampleBytes,
      maxCachedPointSampleBytes: this.maxCachedPointSampleBytes,
      cacheHitCount: this.pointSampleCacheHitCount,
      cacheMissCount: this.pointSampleCacheMissCount,
      cacheEvictionCount: this.pointSampleCacheEvictionCount,
    };
  }

  clearPointSampleCache(): number {
    const clearedCount = this.nodePointSampleCache.size;
    this.nodePointSampleCache.clear();
    this.cachedPointSampleBytes = 0;
    return clearedCount;
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
    this.hierarchyPromise ??= this.copcPromise.then(async (copc) => {
      const subtree = await this.loadHierarchyPageData(
        copc.info.rootHierarchyPage,
      );
      this.loadedHierarchyPageIds.add(
        hierarchyPageId(copc.info.rootHierarchyPage),
      );
      return subtree;
    });

    return this.hierarchyPromise;
  }

  private loadHierarchyPageData(
    page: Hierarchy.Page,
  ): Promise<Hierarchy.Subtree> {
    const pageId = hierarchyPageId(page);
    let promise = this.hierarchyPagePromises.get(pageId);

    if (!promise) {
      promise = Copc.loadHierarchyPage(this.getter, page);
      this.hierarchyPagePromises.set(pageId, promise);
    }

    return promise;
  }

  private evictPointSampleCacheIfNeeded(): void {
    while (
      this.nodePointSampleCache.size > this.maxCachedSampleSets ||
      this.cachedPointSampleBytes > this.maxCachedPointSampleBytes
    ) {
      const oldestCacheKey = this.nodePointSampleCache.keys().next().value;

      if (!oldestCacheKey) {
        return;
      }

      this.deletePointSampleCacheEntry(oldestCacheKey, true);
    }
  }

  private deletePointSampleCacheEntry(
    cacheKey: string,
    countEviction: boolean,
  ): boolean {
    const entry = this.nodePointSampleCache.get(cacheKey);

    if (!entry) {
      return false;
    }

    this.nodePointSampleCache.delete(cacheKey);
    this.cachedPointSampleBytes -= entry.estimatedByteSize;

    if (countEviction) {
      this.pointSampleCacheEvictionCount += 1;
    }

    return true;
  }

  private async loadNodePointSamplesWithoutCache(
    nodeKey: string,
    maxPointCount: number,
  ): Promise<CopcNodePointSampleResult> {
    const [copc, hierarchy] = await Promise.all([
      this.copcPromise,
      this.loadHierarchy(),
    ]);
    let node = hierarchy.nodes[nodeKey];

    if (!node && hierarchy.pages[nodeKey]) {
      await this.loadHierarchyPage(nodeKey);
      node = hierarchy.nodes[nodeKey];
    }

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

function summarizeHierarchy(
  hierarchy: Hierarchy.Subtree,
  cube: readonly number[],
  loadedPageCount: number,
): CopcHierarchySummary {
  const pendingPages = summarizePendingPages(hierarchy.pages, cube);

  return {
    nodes: summarizeNodes(hierarchy.nodes, cube),
    pendingPages,
    pageCount: pendingPages.length,
    loadedPageCount,
    pendingPageCount: pendingPages.length,
  };
}

function summarizePendingPages(
  pages: Hierarchy.Page.Map,
  cube: readonly number[],
): CopcHierarchyPageReference[] {
  return Object.entries(pages)
    .flatMap(([key, page]) => {
      if (!page) {
        return [];
      }

      return [
        {
          ...createPageReferenceSummary(key, cube),
          key,
          pageOffset: page.pageOffset,
          pageLength: page.pageLength,
        },
      ];
    })
    .sort((left, right) => compareNodeKeys(left.key, right.key));
}

function createPageReferenceSummary(
  key: string,
  cube: readonly number[],
): Pick<CopcHierarchyPageReference, "depth" | "x" | "y" | "z" | "bounds"> {
  const parsedKey = parseNodeKey(key);

  return {
    ...parsedKey,
    bounds: boundsForNode(cube, parsedKey),
  };
}

function mergeHierarchy(
  target: Hierarchy.Subtree,
  source: Hierarchy.Subtree,
): void {
  Object.assign(target.nodes, source.nodes);
  Object.assign(target.pages, source.pages);
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
  return compareParsedNodeKeys(left, right);
}

function compareNodeKeys(leftKey: string, rightKey: string): number {
  return compareParsedNodeKeys(parseNodeKey(leftKey), parseNodeKey(rightKey));
}

function compareParsedNodeKeys(
  left: Pick<CopcHierarchyNodeSummary, "depth" | "x" | "y" | "z">,
  right: Pick<CopcHierarchyNodeSummary, "depth" | "x" | "y" | "z">,
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

function estimatePointSampleResultByteSize(
  result: CopcNodePointSampleResult,
): number {
  return result.points.reduce(
    (total, point) => total + estimatePointSampleByteSize(point),
    0,
  );
}

function estimatePointSampleByteSize(point: CopcPointDataSample): number {
  return (
    POINT_SAMPLE_COORDINATE_BYTES +
    (point.color ? POINT_SAMPLE_COLOR_BYTES : 0)
  );
}

function hierarchyPageId(page: Hierarchy.Page): string {
  return `${page.pageOffset}:${page.pageLength}`;
}
