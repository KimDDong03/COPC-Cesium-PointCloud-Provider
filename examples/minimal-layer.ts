import { Viewer } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import {
  CopcPointCloudCameraStream,
  CopcPointCloudLayer,
  createProj4CoordinateTransforms,
  type CopcPointCloudLayerLoadResult,
  type CopcPointCloudLayerNodeRenderResult,
} from "copc-cesium";

export interface MinimalCopcLayerExampleOptions {
  readonly container: string | HTMLElement;
  readonly url: string;
  readonly sourceCrs?: string;
  readonly sourceDefinition?: string;
  readonly maxPointCountPerNode?: number;
}

export interface MinimalCopcLayerExampleResult {
  readonly viewer: Viewer;
  readonly layer: CopcPointCloudLayer;
  readonly cameraStream: CopcPointCloudCameraStream;
  readonly loadResult: CopcPointCloudLayerLoadResult;
  readonly renderResult: CopcPointCloudLayerNodeRenderResult;
  destroy(): void;
}

export async function mountMinimalCopcLayerExample(
  options: MinimalCopcLayerExampleOptions,
): Promise<MinimalCopcLayerExampleResult> {
  const viewer = new Viewer(options.container, {
    animation: false,
    baseLayer: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    navigationHelpButton: false,
  });
  const layer = new CopcPointCloudLayer(viewer.scene, {
    url: options.url,
    maxPointCountPerNode: options.maxPointCountPerNode ?? 5_000,
    pointSampleLoading: "worker",
    coordinateTransforms: options.sourceCrs
      ? createProj4CoordinateTransforms({
          sourceCrs: options.sourceCrs,
          sourceDefinition: options.sourceDefinition,
        })
      : undefined,
  });

  try {
    const loadResult = await layer.load();
    const firstNode = loadResult.hierarchy.nodes[0];

    if (!firstNode) {
      throw new Error("COPC hierarchy did not contain a renderable node.");
    }

    const renderResult = await layer.renderNode(firstNode.key);
    const cameraStream = new CopcPointCloudCameraStream({
      camera: viewer.camera,
      layer,
      quality: "balanced",
      renderOnStart: false,
    });
    cameraStream.start();

    return {
      viewer,
      layer,
      cameraStream,
      loadResult,
      renderResult,
      destroy: () => {
        cameraStream.destroy();
        layer.destroy();
        viewer.destroy();
      },
    };
  } catch (error) {
    layer.destroy();
    viewer.destroy();
    throw error;
  }
}
