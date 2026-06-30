import {
  Cartographic,
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
import { CopcSource } from "../core/copc/CopcSource";
import {
  selectHierarchyNodesForCamera,
  type CopcHierarchyNodeCameraSelection,
  type SelectHierarchyNodesForCameraOptions,
} from "../core/copc/selectHierarchyNodesForCamera";
import {
  suggestHierarchyNode,
  type CopcHierarchyNodeSuggestion,
  type CopcTargetPoint,
} from "../core/copc/suggestHierarchyNode";
import type { PointSample } from "../core/PointSample";
import { CesiumBoundsRenderer } from "./CesiumBoundsRenderer";
import { CesiumPointRenderer } from "./CesiumPointRenderer";
import { createCesiumToCopcCoordinateTransform } from "./copcCoordinateTransform";
import { createPointSamplesFromCopc } from "./createPointSamplesFromCopc";

export interface CopcPointCloudLayerOptions {
  readonly url: string;
  readonly maxPointCountPerNode?: number;
  readonly showBounds?: boolean;
}

export interface CopcPointCloudLayerLoadResult {
  readonly inspection: CopcInspection;
  readonly hierarchy: CopcHierarchySummary;
}

export interface CopcPointCloudLayerRenderNodeOptions {
  readonly maxPointCount?: number;
  readonly showBounds?: boolean;
}

export interface CopcPointCloudLayerRenderNodesOptions {
  readonly maxPointCountPerNode?: number;
  readonly showBounds?: boolean;
}

export interface CopcPointCloudLayerAutomaticRenderOptions
  extends Omit<
    SelectHierarchyNodesForCameraOptions,
    "target" | "viewportHeightPixels"
  > {
  readonly camera: Camera;
  readonly viewportHeightPixels?: number;
  readonly maxPointCountPerNode?: number;
  readonly showBounds?: boolean;
}

export interface CopcPointCloudLayerNodeRenderResult {
  readonly inspection: CopcInspection;
  readonly node: CopcHierarchyNodeSummary;
  readonly pointSamples: CopcNodePointSampleResult;
  readonly points: readonly PointSample[];
}

export interface CopcPointCloudLayerNodesRenderResult {
  readonly inspection: CopcInspection;
  readonly nodes: readonly CopcHierarchyNodeSummary[];
  readonly pointSamples: CopcMultiNodePointSampleResult;
  readonly points: readonly PointSample[];
}

export interface CopcPointCloudLayerAutomaticRenderResult
  extends CopcPointCloudLayerNodesRenderResult {
  readonly cameraSelection: CopcHierarchyNodeCameraSelection;
}

export class CopcPointCloudLayer {
  readonly source: CopcSource;

  private readonly scene: Scene;
  private readonly pointRenderer: CesiumPointRenderer;
  private readonly boundsRenderer: CesiumBoundsRenderer;
  private readonly defaultMaxPointCountPerNode: number | undefined;
  private readonly defaultShowBounds: boolean;
  private loadPromise: Promise<CopcPointCloudLayerLoadResult> | undefined;
  private loadedInspection: CopcInspection | undefined;
  private loadedHierarchy: CopcHierarchySummary | undefined;

  constructor(scene: Scene, options: CopcPointCloudLayerOptions) {
    this.scene = scene;
    this.source = new CopcSource(options.url);
    this.pointRenderer = new CesiumPointRenderer(scene);
    this.boundsRenderer = new CesiumBoundsRenderer(scene);
    this.defaultMaxPointCountPerNode = options.maxPointCountPerNode;
    this.defaultShowBounds = options.showBounds ?? true;
  }

  get inspection(): CopcInspection | undefined {
    return this.loadedInspection;
  }

  get hierarchy(): CopcHierarchySummary | undefined {
    return this.loadedHierarchy;
  }

  async load(): Promise<CopcPointCloudLayerLoadResult> {
    this.loadPromise ??= Promise.all([
      this.source.inspect(),
      this.source.loadHierarchySummary(),
    ]).then(([inspection, hierarchy]) => {
      this.loadedInspection = inspection;
      this.loadedHierarchy = hierarchy;

      return { inspection, hierarchy };
    });

    return this.loadPromise;
  }

  async renderNode(
    nodeKey: string,
    options: CopcPointCloudLayerRenderNodeOptions = {},
  ): Promise<CopcPointCloudLayerNodeRenderResult> {
    const { inspection, hierarchy } = await this.load();
    const node = findRequiredNode(hierarchy, nodeKey);
    const pointSamples = await this.source.loadNodePointSamples({
      nodeKey,
      maxPointCount:
        options.maxPointCount ?? this.defaultMaxPointCountPerNode,
    });
    const points = createPointSamplesFromCopc(pointSamples.points, inspection);

    this.pointRenderer.setPoints(points);
    if (this.shouldShowBounds(options.showBounds)) {
      this.boundsRenderer.setBounds(node.bounds, inspection);
    } else {
      this.boundsRenderer.clear();
    }

    return {
      inspection,
      node,
      pointSamples,
      points,
    };
  }

  async renderNodes(
    nodeKeys: readonly string[],
    options: CopcPointCloudLayerRenderNodesOptions = {},
  ): Promise<CopcPointCloudLayerNodesRenderResult> {
    const normalizedNodeKeys = uniqueNodeKeys(nodeKeys);
    const { inspection, hierarchy } = await this.load();
    const nodes = normalizedNodeKeys.map((nodeKey) =>
      findRequiredNode(hierarchy, nodeKey),
    );
    const pointSamples = await this.source.loadNodesPointSamples({
      nodeKeys: normalizedNodeKeys,
      maxPointCountPerNode:
        options.maxPointCountPerNode ?? this.defaultMaxPointCountPerNode,
    });
    const points = createPointSamplesFromCopc(pointSamples.points, inspection);

    this.pointRenderer.setPoints(points);
    if (this.shouldShowBounds(options.showBounds)) {
      this.boundsRenderer.setBoundsList(
        nodes.map((node) => node.bounds),
        inspection,
      );
    } else {
      this.boundsRenderer.clear();
    }

    return {
      inspection,
      nodes,
      pointSamples,
      points,
    };
  }

  async renderAutomatic(
    options: CopcPointCloudLayerAutomaticRenderOptions,
  ): Promise<CopcPointCloudLayerAutomaticRenderResult | undefined> {
    const {
      camera,
      viewportHeightPixels,
      maxPointCountPerNode,
      showBounds,
      ...selectionOptions
    } = options;
    const { inspection, hierarchy } = await this.load();
    const cameraSelection = selectHierarchyNodesForCamera(hierarchy.nodes, {
      ...selectionOptions,
      target: this.cameraPositionToCopc(camera, inspection),
      viewportHeightPixels:
        viewportHeightPixels ?? this.scene.canvas.clientHeight,
    });

    if (!cameraSelection || cameraSelection.nodes.length === 0) {
      return undefined;
    }

    const renderResult = await this.renderNodes(
      cameraSelection.nodes.map((node) => node.key),
      {
        maxPointCountPerNode,
        showBounds,
      },
    );

    return {
      ...renderResult,
      cameraSelection,
    };
  }

  suggestNodeForCamera(
    camera: Camera,
  ): CopcHierarchyNodeSuggestion | undefined {
    if (!this.loadedInspection || !this.loadedHierarchy) {
      return undefined;
    }

    return suggestHierarchyNode(this.loadedHierarchy.nodes, {
      target: this.cameraPositionToCopc(camera, this.loadedInspection),
    });
  }

  clear(): void {
    this.pointRenderer.setPoints([]);
    this.boundsRenderer.clear();
  }

  private cameraPositionToCopc(
    camera: Camera,
    inspection: CopcInspection,
  ): CopcTargetPoint {
    const cartographic = Cartographic.fromCartesian(camera.positionWC);
    const transform = createCesiumToCopcCoordinateTransform(inspection);

    return transform(
      CesiumMath.toDegrees(cartographic.longitude),
      CesiumMath.toDegrees(cartographic.latitude),
      cartographic.height,
    );
  }

  private shouldShowBounds(showBounds: boolean | undefined): boolean {
    return showBounds ?? this.defaultShowBounds;
  }
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
