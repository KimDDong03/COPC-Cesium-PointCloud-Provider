import {
  BoundingSphere,
  Cartesian3,
  Cartographic,
  Intersect,
  Math as CesiumMath,
  type Camera,
  type Scene,
} from "cesium";
import type {
  CopcHierarchyNodeSummary,
  CopcHierarchySummary,
} from "../core/copc/CopcHierarchySummary";
import type { CopcInspection } from "../core/copc/CopcInspection";
import type {
  CopcMultiNodePointSampleResult,
  CopcNodePointSampleResult,
} from "../core/copc/CopcPointDataSample";
import {
  CopcSource,
  type CopcPointSampleLoadingMode,
} from "../core/copc/CopcSource";
import {
  selectHierarchyPagesForTarget,
  type CopcHierarchyPageTargetSelection,
} from "../core/copc/selectHierarchyPagesForTarget";
import {
  selectHierarchyNodesForCamera,
  type CopcHierarchyNodeCameraSelection,
  type CopcTargetVector,
  type SelectHierarchyNodesForCameraOptions,
} from "../core/copc/selectHierarchyNodesForCamera";
import {
  suggestHierarchyNode,
  type CopcHierarchyNodeSuggestion,
  type CopcTargetPoint,
} from "../core/copc/suggestHierarchyNode";
import type { PointSample } from "../core/PointSample";
import { CesiumBoundsRenderer } from "./CesiumBoundsRenderer";
import { CesiumPointPrimitiveRenderer } from "./CesiumPointPrimitiveRenderer";
import type {
  CopcPointCloudRenderer,
  CopcPointCloudRendererFactory,
} from "./CopcPointCloudRenderer";
import {
  createDefaultCopcCoordinateTransforms,
  type CopcCoordinateTransformFactory,
  type CopcCoordinateTransformSet,
  type CopcCoordinateTransformStatus,
} from "./copcCoordinateTransform";
import { createPointSamplesFromCopc } from "./createPointSamplesFromCopc";

export interface CopcPointCloudLayerOptions {
  readonly url: string;
  readonly maxPointCountPerNode?: number;
  readonly maxCachedHierarchyPages?: number;
  readonly maxCachedSampleSets?: number;
  readonly maxCachedPointSampleBytes?: number;
  readonly pointSampleLoading?: CopcPointSampleLoadingMode;
  readonly createPointSampleWorker?: () => Worker;
  readonly createPointRenderer?: CopcPointCloudRendererFactory;
  readonly showBounds?: boolean;
  readonly coordinateTransforms?: CopcCoordinateTransformFactory;
}

export interface CopcPointCloudLayerLoadResult {
  readonly inspection: CopcInspection;
  readonly hierarchy: CopcHierarchySummary;
  readonly coordinateTransform: CopcCoordinateTransformStatus;
}

export interface CopcPointCloudLayerRenderStats {
  readonly pointCount: number;
  readonly estimatedRenderPayloadBytes: number;
  readonly coordinateTransformMilliseconds: number;
  readonly rendererSetPointsMilliseconds: number;
  readonly boundsRenderMilliseconds: number;
  readonly totalRenderMilliseconds: number;
}

export interface CopcPointCloudLayerRenderNodeOptions {
  readonly maxPointCount?: number;
  readonly showBounds?: boolean;
  readonly signal?: AbortSignal;
}

export interface CopcPointCloudLayerRenderNodesOptions {
  readonly maxPointCountPerNode?: number;
  readonly maxRenderedPointCount?: number;
  readonly showBounds?: boolean;
  readonly signal?: AbortSignal;
}

export interface CopcPointCloudLayerCameraSelectionOptions
  extends Omit<
    SelectHierarchyNodesForCameraOptions,
    "target" | "viewDirection" | "viewportHeightPixels"
  > {
  readonly camera: Camera;
  readonly viewportHeightPixels?: number;
  readonly signal?: AbortSignal;
}

export interface CopcPointCloudLayerHierarchyExpansionOptions {
  readonly camera: Camera;
  readonly maxPages?: number;
  readonly minDepth?: number;
  readonly maxDepth?: number;
  readonly signal?: AbortSignal;
}

export interface CopcPointCloudLayerAutomaticRenderOptions
  extends CopcPointCloudLayerCameraSelectionOptions {
  readonly maxPointCountPerNode?: number;
  readonly maxRenderedPointCount?: number;
  readonly showBounds?: boolean;
  readonly expandHierarchy?: boolean;
  readonly maxHierarchyPages?: number;
  readonly maxHierarchyPageDepth?: number;
  readonly signal?: AbortSignal;
}

export interface CopcPointCloudLayerNodeRenderResult {
  readonly inspection: CopcInspection;
  readonly node: CopcHierarchyNodeSummary;
  readonly pointSamples: CopcNodePointSampleResult;
  readonly points: readonly PointSample[];
  readonly renderStats: CopcPointCloudLayerRenderStats;
}

export interface CopcPointCloudLayerNodesRenderResult {
  readonly inspection: CopcInspection;
  readonly nodes: readonly CopcHierarchyNodeSummary[];
  readonly pointSamples: CopcMultiNodePointSampleResult;
  readonly points: readonly PointSample[];
  readonly renderStats: CopcPointCloudLayerRenderStats;
}

export interface CopcPointCloudLayerAutomaticRenderResult
  extends CopcPointCloudLayerNodesRenderResult {
  readonly cameraSelection: CopcHierarchyNodeCameraSelection;
  readonly hierarchyExpansion:
    | CopcPointCloudLayerHierarchyExpansionResult
    | undefined;
}

export interface CopcPointCloudLayerHierarchyExpansionResult {
  readonly hierarchy: CopcHierarchySummary;
  readonly pageSelection: CopcHierarchyPageTargetSelection;
  readonly loadedPageKeys: readonly string[];
}

export class CopcPointCloudLayer {
  readonly source: CopcSource;

  private readonly scene: Scene;
  private readonly pointRenderer: CopcPointCloudRenderer;
  private readonly boundsRenderer: CesiumBoundsRenderer;
  private readonly defaultMaxPointCountPerNode: number | undefined;
  private readonly defaultShowBounds: boolean;
  private readonly coordinateTransformFactory: CopcCoordinateTransformFactory;
  private coordinateTransforms: CopcCoordinateTransformSet | undefined;
  private coordinateTransformStatus: CopcCoordinateTransformStatus | undefined;
  private loadPromise: Promise<void> | undefined;
  private loadedInspection: CopcInspection | undefined;
  private loadedHierarchy: CopcHierarchySummary | undefined;
  private destroyed = false;

  constructor(scene: Scene, options: CopcPointCloudLayerOptions) {
    this.scene = scene;
    this.source = new CopcSource(options.url, {
      maxCachedHierarchyPages: options.maxCachedHierarchyPages,
      maxCachedSampleSets: options.maxCachedSampleSets,
      maxCachedPointSampleBytes: options.maxCachedPointSampleBytes,
      pointSampleLoading: options.pointSampleLoading,
      createPointSampleWorker: options.createPointSampleWorker,
    });
    this.pointRenderer = (
      options.createPointRenderer ??
      ((scene) => new CesiumPointPrimitiveRenderer(scene))
    )(scene);
    this.boundsRenderer = new CesiumBoundsRenderer(scene);
    this.defaultMaxPointCountPerNode = options.maxPointCountPerNode;
    this.defaultShowBounds = options.showBounds ?? true;
    this.coordinateTransformFactory =
      options.coordinateTransforms ?? createDefaultCopcCoordinateTransforms;
  }

  get inspection(): CopcInspection | undefined {
    return this.loadedInspection;
  }

  get hierarchy(): CopcHierarchySummary | undefined {
    return this.loadedHierarchy;
  }

  get coordinateTransform(): CopcCoordinateTransformStatus | undefined {
    return this.coordinateTransformStatus;
  }

  async load(): Promise<CopcPointCloudLayerLoadResult> {
    this.assertNotDestroyed();

    this.loadPromise ??= Promise.all([
      this.source.inspect(),
      this.source.loadHierarchySummary(),
    ]).then(([inspection, hierarchy]) => {
      this.assertNotDestroyed();
      this.loadedInspection = inspection;
      this.loadedHierarchy = hierarchy;
      this.getCoordinateTransformStatus(inspection);
    });

    await this.loadPromise;
    this.assertNotDestroyed();

    return {
      inspection: this.requireInspection(),
      hierarchy: this.requireHierarchy(),
      coordinateTransform: this.requireCoordinateTransformStatus(),
    };
  }

  async loadHierarchyPage(pageKey: string): Promise<CopcHierarchySummary> {
    this.assertNotDestroyed();
    await this.load();
    this.loadedHierarchy = await this.source.loadHierarchyPage(pageKey);
    this.assertNotDestroyed();

    return this.loadedHierarchy;
  }

  async loadNextHierarchyPage(): Promise<CopcHierarchySummary | undefined> {
    this.assertNotDestroyed();
    await this.load();
    const hierarchy = await this.source.loadNextHierarchyPage();
    this.assertNotDestroyed();

    if (hierarchy) {
      this.loadedHierarchy = hierarchy;
    }

    return hierarchy;
  }

  async expandHierarchyForCamera(
    options: CopcPointCloudLayerHierarchyExpansionOptions,
  ): Promise<CopcPointCloudLayerHierarchyExpansionResult | undefined> {
    this.assertNotDestroyed();

    const { camera, signal, ...selectionOptions } = options;
    throwIfAborted(signal);
    const { inspection, hierarchy } = await this.load();
    throwIfAborted(signal);
    const pageSelection = selectHierarchyPagesForTarget(
      hierarchy.pendingPages,
      {
        ...selectionOptions,
        target: this.cameraPositionToCopc(camera, inspection),
      },
    );

    if (!pageSelection) {
      return undefined;
    }

    const result = await this.source.loadHierarchyPages(
      pageSelection.pages.map((page) => page.key),
    );
    throwIfAborted(signal);
    this.assertNotDestroyed();
    this.loadedHierarchy = result.hierarchy;

    return {
      hierarchy: result.hierarchy,
      pageSelection,
      loadedPageKeys: result.loadedPageKeys,
    };
  }

  async renderNode(
    nodeKey: string,
    options: CopcPointCloudLayerRenderNodeOptions = {},
  ): Promise<CopcPointCloudLayerNodeRenderResult> {
    this.assertNotDestroyed();

    const { inspection, hierarchy } = await this.load();
    throwIfAborted(options.signal);
    this.assertNotDestroyed();

    const node = findRequiredNode(hierarchy, nodeKey);
    const pointSamples = await this.source.loadNodePointSamples({
      nodeKey,
      maxPointCount:
        options.maxPointCount ?? this.defaultMaxPointCountPerNode,
      signal: options.signal,
    });
    this.assertNotDestroyed();

    const { points, renderStats } = this.renderPointSamples(
      pointSamples.points,
      inspection,
      options.showBounds,
      (coordinateTransforms) => {
        this.boundsRenderer.setBounds(
          node.bounds,
          inspection,
          coordinateTransforms.toCesium,
        );
      },
    );

    return {
      inspection,
      node,
      pointSamples,
      points,
      renderStats,
    };
  }

  async renderNodes(
    nodeKeys: readonly string[],
    options: CopcPointCloudLayerRenderNodesOptions = {},
  ): Promise<CopcPointCloudLayerNodesRenderResult> {
    this.assertNotDestroyed();

    const normalizedNodeKeys = uniqueNodeKeys(nodeKeys);
    const { inspection, hierarchy } = await this.load();
    throwIfAborted(options.signal);
    this.assertNotDestroyed();

    const nodes = normalizedNodeKeys.map((nodeKey) =>
      findRequiredNode(hierarchy, nodeKey),
    );
    const pointSamples = await this.source.loadNodesPointSamples({
      nodeKeys: normalizedNodeKeys,
      maxPointCountPerNode:
        options.maxPointCountPerNode ?? this.defaultMaxPointCountPerNode,
      maxTotalSampledPointCount: options.maxRenderedPointCount,
      signal: options.signal,
    });
    this.assertNotDestroyed();

    const { points, renderStats } = this.renderPointSamples(
      pointSamples.points,
      inspection,
      options.showBounds,
      (coordinateTransforms) => {
        this.boundsRenderer.setBoundsList(
          nodes.map((node) => node.bounds),
          inspection,
          coordinateTransforms.toCesium,
        );
      },
    );

    return {
      inspection,
      nodes,
      pointSamples,
      points,
      renderStats,
    };
  }

  async renderAutomatic(
    options: CopcPointCloudLayerAutomaticRenderOptions,
  ): Promise<CopcPointCloudLayerAutomaticRenderResult | undefined> {
    this.assertNotDestroyed();

    const {
      expandHierarchy,
      maxHierarchyPages,
      maxHierarchyPageDepth,
      maxPointCountPerNode,
      maxRenderedPointCount,
      signal,
      showBounds,
      ...selectionOptions
    } = options;
    throwIfAborted(signal);
    const hierarchyExpansion = (expandHierarchy ?? false)
      ? await this.expandHierarchyForCamera({
          camera: options.camera,
          maxPages: maxHierarchyPages,
          maxDepth: maxHierarchyPageDepth,
          signal,
        })
      : undefined;
    const cameraSelection = await this.selectNodesForCamera({
      ...selectionOptions,
      signal,
    });
    throwIfAborted(signal);

    if (!cameraSelection || cameraSelection.nodes.length === 0) {
      return undefined;
    }

    const renderResult = await this.renderNodes(
      cameraSelection.nodes.map((node) => node.key),
      {
        maxPointCountPerNode,
        maxRenderedPointCount,
        signal,
        showBounds,
      },
    );

    return {
      ...renderResult,
      cameraSelection,
      hierarchyExpansion,
    };
  }

  async selectNodesForCamera(
    options: CopcPointCloudLayerCameraSelectionOptions,
  ): Promise<CopcHierarchyNodeCameraSelection | undefined> {
    this.assertNotDestroyed();

    const {
      camera,
      viewportHeightPixels,
      spacing,
      signal,
      ...selectionOptions
    } = options;
    throwIfAborted(signal);
    const { inspection, hierarchy } = await this.load();
    throwIfAborted(signal);
    this.assertNotDestroyed();
    const target = this.cameraPositionToCopc(camera, inspection);
    const frustumFiltered = this.filterNodesForCameraFrustum(
      hierarchy.nodes,
      camera,
      inspection,
    );
    const selection = selectHierarchyNodesForCamera(frustumFiltered.nodes, {
      ...selectionOptions,
      spacing: spacing ?? inspection.spacing,
      target,
      viewDirection: this.cameraDirectionToCopc(camera, inspection, target),
      viewportHeightPixels:
        viewportHeightPixels ?? this.scene.canvas.clientHeight,
    });

    if (!selection) {
      return undefined;
    }

    return {
      ...selection,
      skippedByFrustumCount: frustumFiltered.skippedByFrustumCount,
      reason: appendFrustumSelectionReason(
        selection.reason,
        frustumFiltered.skippedByFrustumCount,
      ),
    };
  }

  suggestNodeForCamera(
    camera: Camera,
  ): CopcHierarchyNodeSuggestion | undefined {
    this.assertNotDestroyed();

    if (!this.loadedInspection || !this.loadedHierarchy) {
      return undefined;
    }

    return suggestHierarchyNode(this.loadedHierarchy.nodes, {
      target: this.cameraPositionToCopc(camera, this.loadedInspection),
    });
  }

  clear(): void {
    if (this.destroyed) {
      return;
    }

    this.pointRenderer.clear();
    this.boundsRenderer.clear();
  }

  clearPointSampleCache(): number {
    this.assertNotDestroyed();
    return this.source.clearPointSampleCache();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.loadedInspection = undefined;
    this.loadedHierarchy = undefined;
    this.coordinateTransforms = undefined;
    this.coordinateTransformStatus = undefined;
    this.source.destroy();
    this.pointRenderer.destroy();
    this.boundsRenderer.destroy();
  }

  private getCoordinateTransforms(
    inspection: CopcInspection,
  ): CopcCoordinateTransformSet {
    if (!this.coordinateTransforms) {
      this.coordinateTransforms = this.coordinateTransformFactory(inspection);
      this.coordinateTransformStatus = normalizeCoordinateTransformStatus(
        this.coordinateTransforms,
      );
    }

    return this.coordinateTransforms;
  }

  private getCoordinateTransformStatus(
    inspection: CopcInspection,
  ): CopcCoordinateTransformStatus {
    this.getCoordinateTransforms(inspection);

    if (!this.coordinateTransformStatus) {
      throw new Error("COPC coordinate transform status was not initialized.");
    }

    return this.coordinateTransformStatus;
  }

  private cameraPositionToCopc(
    camera: Camera,
    inspection: CopcInspection,
  ): CopcTargetPoint {
    const cartographic = Cartographic.fromCartesian(camera.positionWC);
    const transform = this.getCoordinateTransforms(inspection).toCopc;

    if (!transform) {
      throw new Error(
        "Camera-based COPC node selection requires coordinateTransforms to provide toCopc.",
      );
    }

    return transform(
      CesiumMath.toDegrees(cartographic.longitude),
      CesiumMath.toDegrees(cartographic.latitude),
      cartographic.height,
    );
  }

  private cameraDirectionToCopc(
    camera: Camera,
    inspection: CopcInspection,
    target: CopcTargetPoint,
  ): CopcTargetVector | undefined {
    if (!camera.directionWC) {
      return undefined;
    }

    const cartographic = Cartographic.fromCartesian(camera.positionWC);
    const transform = this.getCoordinateTransforms(inspection).toCopc;

    if (!transform) {
      return undefined;
    }

    const stepMeters = Math.min(
      10_000,
      Math.max(100, Math.abs(cartographic.height) * 0.02),
    );
    const directionEndpoint = Cartesian3.add(
      camera.positionWC,
      Cartesian3.multiplyByScalar(
        camera.directionWC,
        stepMeters,
        new Cartesian3(),
      ),
      new Cartesian3(),
    );
    const endpointCartographic = Cartographic.fromCartesian(directionEndpoint);
    const endpoint = transform(
      CesiumMath.toDegrees(endpointCartographic.longitude),
      CesiumMath.toDegrees(endpointCartographic.latitude),
      endpointCartographic.height,
    );
    const vector = {
      x: endpoint.x - target.x,
      y: endpoint.y - target.y,
      z: endpoint.z - target.z,
    };

    if (
      !Number.isFinite(vector.x) ||
      !Number.isFinite(vector.y) ||
      !Number.isFinite(vector.z) ||
      Math.hypot(vector.x, vector.y, vector.z) <= Number.EPSILON
    ) {
      return undefined;
    }

    return vector;
  }

  private filterNodesForCameraFrustum(
    nodes: readonly CopcHierarchyNodeSummary[],
    camera: Camera,
    inspection: CopcInspection,
  ): {
    readonly nodes: readonly CopcHierarchyNodeSummary[];
    readonly skippedByFrustumCount: number;
  } {
    if (
      !camera.frustum ||
      !camera.directionWC ||
      !camera.upWC ||
      !camera.positionWC
    ) {
      return {
        nodes,
        skippedByFrustumCount: 0,
      };
    }

    const toCesium = this.getCoordinateTransforms(inspection).toCesium;
    const cullingVolume = camera.frustum.computeCullingVolume(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    );
    const visibleNodes = nodes.filter((node) => {
      const boundingSphere = createCesiumBoundsSphere(node, toCesium);

      return cullingVolume.computeVisibility(boundingSphere) !== Intersect.OUTSIDE;
    });

    return {
      nodes: visibleNodes,
      skippedByFrustumCount: nodes.length - visibleNodes.length,
    };
  }

  private shouldShowBounds(showBounds: boolean | undefined): boolean {
    return showBounds ?? this.defaultShowBounds;
  }

  private renderPointSamples(
    sourcePoints: readonly CopcNodePointSampleResult["points"][number][],
    inspection: CopcInspection,
    showBounds: boolean | undefined,
    renderBounds: (coordinateTransforms: CopcCoordinateTransformSet) => void,
  ): {
    readonly points: readonly PointSample[];
    readonly renderStats: CopcPointCloudLayerRenderStats;
  } {
    const coordinateTransforms = this.getCoordinateTransforms(inspection);
    const renderStartedAt = nowMilliseconds();
    const transformStartedAt = nowMilliseconds();
    const points = createPointSamplesFromCopc(
      sourcePoints,
      inspection,
      coordinateTransforms.toCesium,
    );
    const transformEndedAt = nowMilliseconds();

    this.assertNotDestroyed();
    const rendererStartedAt = nowMilliseconds();
    this.pointRenderer.setPoints(points);
    const rendererEndedAt = nowMilliseconds();

    const boundsStartedAt = nowMilliseconds();
    if (this.shouldShowBounds(showBounds)) {
      renderBounds(coordinateTransforms);
    } else {
      this.boundsRenderer.clear();
    }
    const boundsEndedAt = nowMilliseconds();

    return {
      points,
      renderStats: {
        pointCount: points.length,
        estimatedRenderPayloadBytes: estimateRenderPayloadBytes(points.length),
        coordinateTransformMilliseconds: Math.max(
          0,
          transformEndedAt - transformStartedAt,
        ),
        rendererSetPointsMilliseconds: Math.max(
          0,
          rendererEndedAt - rendererStartedAt,
        ),
        boundsRenderMilliseconds: Math.max(0, boundsEndedAt - boundsStartedAt),
        totalRenderMilliseconds: Math.max(0, boundsEndedAt - renderStartedAt),
      },
    };
  }

  private requireInspection(): CopcInspection {
    if (!this.loadedInspection) {
      throw new Error("COPC inspection was not loaded.");
    }

    return this.loadedInspection;
  }

  private requireHierarchy(): CopcHierarchySummary {
    if (!this.loadedHierarchy) {
      throw new Error("COPC hierarchy was not loaded.");
    }

    return this.loadedHierarchy;
  }

  private requireCoordinateTransformStatus(): CopcCoordinateTransformStatus {
    if (!this.coordinateTransformStatus) {
      throw new Error("COPC coordinate transform status was not initialized.");
    }

    return this.coordinateTransformStatus;
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error("CopcPointCloudLayer has been destroyed.");
    }
  }
}

function normalizeCoordinateTransformStatus(
  transforms: CopcCoordinateTransformSet,
): CopcCoordinateTransformStatus {
  return {
    kind: transforms.status?.kind ?? "custom",
    label: transforms.status?.label ?? "Custom coordinate transform",
    supportsCameraSelection: Boolean(transforms.toCopc),
  };
}

function nowMilliseconds(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function estimateRenderPayloadBytes(pointCount: number): number {
  const positionBytes = 3 * Float64Array.BYTES_PER_ELEMENT;
  const colorBytes = 4 * Uint8Array.BYTES_PER_ELEMENT;

  return pointCount * (positionBytes + colorBytes);
}

function createCesiumBoundsSphere(
  node: CopcHierarchyNodeSummary,
  transform: CopcToCesiumTransform,
): BoundingSphere {
  return BoundingSphere.fromPoints(
    createCesiumBoundsCorners(node, transform),
  );
}

type CopcToCesiumTransform = CopcCoordinateTransformSet["toCesium"];

function createCesiumBoundsCorners(
  node: CopcHierarchyNodeSummary,
  transform: CopcToCesiumTransform,
): Cartesian3[] {
  const { minX, minY, minZ, maxX, maxY, maxZ } = node.bounds;
  const corners: Cartesian3[] = [];

  for (const x of [minX, maxX]) {
    for (const y of [minY, maxY]) {
      for (const z of [minZ, maxZ]) {
        const coordinate = transform(x, y, z);
        corners.push(
          Cartesian3.fromDegrees(
            coordinate.longitudeDegrees,
            coordinate.latitudeDegrees,
            coordinate.heightMeters,
          ),
        );
      }
    }
  }

  return corners;
}

function appendFrustumSelectionReason(
  reason: string,
  skippedByFrustumCount: number,
): string {
  if (skippedByFrustumCount === 0) {
    return reason;
  }

  return `${reason} Frustum-culled ${skippedByFrustumCount.toLocaleString()} off-screen candidate nodes.`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  const reason = signal.reason;

  if (reason instanceof Error) {
    throw reason;
  }

  if (typeof DOMException !== "undefined") {
    throw new DOMException(
      "COPC point sample request was aborted.",
      "AbortError",
    );
  }

  const error = new Error("COPC point sample request was aborted.");
  error.name = "AbortError";
  throw error;
}

function findRequiredNode(
  hierarchy: CopcHierarchySummary,
  nodeKey: string,
): CopcHierarchyNodeSummary {
  const node = hierarchy.nodes.find((candidate) => candidate.key === nodeKey);

  if (!node) {
    throw new Error(`COPC hierarchy node was not found: ${nodeKey}`);
  }

  return node;
}

function uniqueNodeKeys(nodeKeys: readonly string[]): string[] {
  const normalizedNodeKeys = [...new Set(nodeKeys)];

  if (normalizedNodeKeys.length === 0) {
    throw new Error("At least one COPC hierarchy node key is required.");
  }

  return normalizedNodeKeys;
}
