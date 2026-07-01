import {
  Cartesian3,
  ImageryLayer,
  TileMapServiceImageryProvider,
  Viewer,
  buildModuleUrl,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import {
  CesiumBufferPointRenderer,
  CesiumPointPrimitiveRenderer,
  CopcPointCloudLayer,
  type CopcBounds,
  type CopcCoordinateTransformStatus,
  type CopcHierarchyCacheStats,
  type CopcHierarchyNodeCameraSelection,
  type CopcHierarchyNodeSuggestion,
  type CopcHierarchyNodeSummary,
  type CopcHierarchySummary,
  type CopcInspection,
  type CopcMultiNodePointSampleResult,
  type CopcNodePointSampleResult,
  type CopcPointCloudLayerHierarchyExpansionResult,
  type CopcPointCloudLayerRenderStats,
  type CopcPointCloudRendererFactory,
  type CopcPointSampleCacheStats,
  type PointSample,
} from "copc-cesium";
import { createHardcodedPointSamples } from "./hardcodedPointSamples";
import {
  createCustomCopcSource,
  DEFAULT_SAMPLE_COPC_SOURCE,
  SAMPLE_COPC_SOURCES,
  type CustomCopcProjectionOptions,
  type CopcSourceConfig,
  type SampleCopcSource,
} from "./sampleCopcSources";
import "./style.css";

const CUSTOM_SAMPLE_OPTION_VALUE = "custom";
const AUTO_LOD_MAX_HIERARCHY_PAGES = 2;
const AUTO_LOD_MAX_NODE_POINT_DATA_LENGTH = 1_000_000;
const AUTO_LOD_MAX_TOTAL_POINT_DATA_LENGTH = 2_000_000;
const AUTO_LOD_MAX_RENDERED_POINT_COUNT = 20_000;
const CAMERA_STREAM_MAX_HIERARCHY_PAGES = 1;
const CAMERA_STREAM_MAX_NODES = 2;
const CAMERA_STREAM_MAX_DEPTH = 2;
const CAMERA_STREAM_MIN_RENDERED_POINT_COUNT = 1_000;
const CAMERA_STREAM_SLOW_RENDER_MILLISECONDS = 32;
const CAMERA_STREAM_SLOW_TOTAL_MILLISECONDS = 50;
const CAMERA_STREAM_RECOVERY_TOTAL_MILLISECONDS = 24;
const CAMERA_STREAM_RECOVERY_RENDER_MILLISECONDS = 18;
const CAMERA_STREAM_RECOVERY_STREAK = 3;
const DEFAULT_CAMERA_STREAM_MAX_RENDERED_POINT_COUNT = 5_000;
const DEFAULT_MAX_POINT_COUNT_PER_NODE = 5_000;
const BENCHMARK_CAMERA_STEP_COUNT = 24;
const BENCHMARK_CAMERA_DURATION_MILLISECONDS = 2400;
const BENCHMARK_CAMERA_MOVE_METERS = 25;
const HIERARCHY_PAGE_CACHE_LIMIT = 64;
const POINT_SAMPLE_CACHE_LIMIT = 32;
const POINT_SAMPLE_CACHE_BYTE_LIMIT = 32 * 1024 * 1024;
const POINT_RENDERER_LABELS = {
  primitive: "PointPrimitiveCollection",
  buffer: "BufferPointCollection (experimental)",
} as const;

type PointRendererKind = keyof typeof POINT_RENDERER_LABELS;

interface BasicViewerBenchmarkCameraOptions {
  readonly steps?: number;
  readonly durationMilliseconds?: number;
  readonly moveMeters?: number;
}

interface BasicViewerBenchmarkStatus {
  readonly status: string;
  readonly pointRenderer?: string;
  readonly rendererTiming?: string;
  readonly rendererPayload?: string;
  readonly cameraStreamDiagnostics?: string;
  readonly hierarchyPages?: string;
  readonly pointCache?: string;
  readonly renderSet?: string;
  readonly autoLod?: string;
  readonly cameraStreamBudget?: string;
}

interface BasicViewerBenchmarkApi {
  readonly moveCameraForSmoothness: (
    options?: BasicViewerBenchmarkCameraOptions,
  ) => Promise<BasicViewerBenchmarkStatus>;
  readonly getStatus: () => BasicViewerBenchmarkStatus;
}

interface CameraStreamDiagnostics {
  readonly expandHierarchyMilliseconds: number;
  readonly applyHierarchyMilliseconds: number;
  readonly selectNodesMilliseconds: number;
  readonly renderNodesMilliseconds: number;
  readonly totalMilliseconds: number;
  readonly loadedHierarchyPageCount: number;
  readonly selectedNodeCount: number;
  readonly selectedDepth: number;
}

declare global {
  interface Window {
    __copcBasicViewerBenchmark?: BasicViewerBenchmarkApi;
  }
}

const elements = getPrototypeElements();
initializeRendererBenchmarkControls();
let currentLayer: CopcPointCloudLayer | undefined;
let currentInspection: CopcInspection | undefined;
let currentHierarchy: CopcHierarchySummary | undefined;
let currentCoordinateTransform: CopcCoordinateTransformStatus | undefined;
let currentSuggestion: CopcHierarchyNodeSuggestion | undefined;
let currentSource: CopcSourceConfig = DEFAULT_SAMPLE_COPC_SOURCE;
let currentPointRendererKind: PointRendererKind = "primitive";
let lastCameraStreamDiagnostics: CameraStreamDiagnostics | undefined;
let automaticStreamRequestId = 0;
let automaticStreamAbortController: AbortController | undefined;
let automaticStreamPrefetchPromise: Promise<void> | undefined;
let lastAutomaticStreamNodeKeySignature = "";
let adaptiveCameraStreamPointBudget: number | undefined;
let adaptiveCameraStreamFastRunCount = 0;
let lastCameraStreamRenderedPointBudget: number | undefined;
const renderNodeSet = new Set<string>();

const viewer = new Viewer(elements.container, {
  animation: false,
  baseLayer: ImageryLayer.fromProviderAsync(
    TileMapServiceImageryProvider.fromUrl(
      buildModuleUrl("Assets/Textures/NaturalEarthII"),
    ),
  ),
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

const points = createHardcodedPointSamples();
const previewRenderer = new CesiumPointPrimitiveRenderer(viewer.scene);
previewRenderer.setPoints(points);

viewer.camera.flyTo({
  destination: cameraTargetForPoints(points),
  duration: 0,
});

function cameraTargetForPoints(pointSamples: readonly PointSample[]): Cartesian3 {
  const firstPoint = pointSamples[0];

  if (!firstPoint) {
    throw new Error("Cannot focus the camera without point samples.");
  }

  return Cartesian3.fromDegrees(
    firstPoint.longitudeDegrees,
    firstPoint.latitudeDegrees,
    firstPoint.heightMeters + 1200,
  );
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    void inspectSource(createSourceConfigFromForm());
  } catch (error) {
    setInspectionError(error);
  }
});

elements.sampleSelect.addEventListener("change", () => {
  const sample = findSampleById(elements.sampleSelect.value);

  if (!sample) {
    syncCustomProjectionControls();
    elements.urlInput.focus();
    return;
  }

  elements.urlInput.value = sample.url;
  clearCustomProjectionInputs();
  syncCustomProjectionControls();
  void inspectSource(sample);
});

elements.rendererSelect.addEventListener("change", () => {
  void inspectSource(createSourceConfigFromForm());
});

elements.maxPointCountInput.addEventListener("change", () => {
  void inspectSource(createSourceConfigFromForm());
});

elements.cameraStreamPointBudgetInput.addEventListener("change", () => {
  resetCameraStreamAdaptiveBudget();

  if (!elements.autoStreamCheckbox.checked) {
    return;
  }

  lastAutomaticStreamNodeKeySignature = "";
  void renderAutomaticNodeSetForCameraMove(true);
});

elements.urlInput.addEventListener("input", () => {
  syncSampleSelectWithUrl(elements.urlInput.value);
});

elements.applySuggestionButton.addEventListener("click", () => {
  if (!currentSuggestion) {
    return;
  }

  elements.nodeSelect.value = currentSuggestion.node.key;
  void renderSelectedHierarchyNode();
});

elements.addSelectedButton.addEventListener("click", () => {
  if (elements.nodeSelect.value) {
    addNodeToRenderSet(elements.nodeSelect.value);
  }
});

elements.addSuggestionButton.addEventListener("click", () => {
  if (currentSuggestion) {
    addNodeToRenderSet(currentSuggestion.node.key);
  }
});

elements.loadMoreHierarchyButton.addEventListener("click", () => {
  void loadNextHierarchyPage();
});

elements.autoLodButton.addEventListener("click", () => {
  void renderAutomaticNodeSet();
});

elements.autoStreamCheckbox.addEventListener("change", () => {
  lastAutomaticStreamNodeKeySignature = "";

  if (!elements.autoStreamCheckbox.checked) {
    automaticStreamAbortController?.abort();
    automaticStreamAbortController = undefined;
    automaticStreamPrefetchPromise = undefined;
    resetCameraStreamAdaptiveBudget();
    return;
  }

  if (elements.autoStreamCheckbox.checked) {
    resetCameraStreamAdaptiveBudget();
    void renderAutomaticNodeSetForCameraMove(true);
  }
});

elements.renderSetButton.addEventListener("click", () => {
  void renderSelectedNodeSet();
});

elements.clearSetButton.addEventListener("click", () => {
  renderNodeSet.clear();
  renderRenderSetControls();
});

viewer.camera.moveEnd.addEventListener(() => {
  updateSuggestedNode();
  void renderAutomaticNodeSetForCameraMove(false);
});

installBasicViewerBenchmarkApi();
populateSampleSelect();
void inspectSource(DEFAULT_SAMPLE_COPC_SOURCE);

function installBasicViewerBenchmarkApi(): void {
  window.__copcBasicViewerBenchmark = {
    moveCameraForSmoothness,
    getStatus: readBenchmarkStatus,
  };
}

async function moveCameraForSmoothness(
  options: BasicViewerBenchmarkCameraOptions = {},
): Promise<BasicViewerBenchmarkStatus> {
  const steps = readBenchmarkPositiveInteger(
    options.steps,
    BENCHMARK_CAMERA_STEP_COUNT,
  );
  const durationMilliseconds = readBenchmarkPositiveNumber(
    options.durationMilliseconds,
    BENCHMARK_CAMERA_DURATION_MILLISECONDS,
  );
  const moveMeters = readBenchmarkPositiveNumber(
    options.moveMeters,
    BENCHMARK_CAMERA_MOVE_METERS,
  );
  const waitMilliseconds = durationMilliseconds / steps;

  for (let index = 0; index < steps; index += 1) {
    moveBenchmarkCamera(index, moveMeters);
    updateSuggestedNode();
    void renderAutomaticNodeSetForCameraMove(false);
    viewer.scene.requestRender();
    await delayForBenchmark(waitMilliseconds);
  }

  await renderAutomaticNodeSetForCameraMove(true);
  await delayForBenchmark(200);
  return readBenchmarkStatus();
}

function moveBenchmarkCamera(index: number, moveMeters: number): void {
  switch (index % 4) {
    case 0:
      viewer.camera.moveRight(moveMeters);
      break;
    case 1:
      viewer.camera.moveForward(moveMeters);
      break;
    case 2:
      viewer.camera.moveLeft(moveMeters);
      break;
    default:
      viewer.camera.moveBackward(moveMeters);
      break;
  }
}

function readBenchmarkStatus(): BasicViewerBenchmarkStatus {
  const metadata = readBenchmarkMetadataRows();

  return {
    status: elements.statusText.textContent?.trim() ?? "",
    pointRenderer: metadata["Point renderer"],
    rendererTiming: metadata["Renderer timing"],
    rendererPayload: metadata["Renderer payload"],
    cameraStreamDiagnostics: metadata["Camera stream diagnostics"],
    hierarchyPages: metadata["Hierarchy pages"],
    pointCache: metadata["Point cache"],
    renderSet: metadata["Render set"],
    autoLod: metadata["Auto LOD"],
    cameraStreamBudget: metadata["Camera stream budget"],
  };
}

function readBenchmarkMetadataRows(): Record<string, string> {
  const rows: Record<string, string> = {};

  elements.metadataList.querySelectorAll("dt").forEach((label) => {
    const key = label.textContent?.trim();

    if (!key) {
      return;
    }

    rows[key] = label.nextElementSibling?.textContent?.trim() ?? "";
  });

  return rows;
}

function readBenchmarkPositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && isPositiveSafeInteger(value) ? value : fallback;
}

function readBenchmarkPositiveNumber(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function delayForBenchmark(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

async function inspectSource(source: CopcSourceConfig): Promise<void> {
  const activeSource = normalizeSourceConfig(source);
  const pointRendererKind = readPointRendererKind();
  const maxPointCountPerNode = readMaxPointCountPerNode();
  const previousLayer = currentLayer;
  automaticStreamAbortController?.abort();
  automaticStreamAbortController = undefined;
  currentLayer = undefined;
  previousLayer?.destroy();
  setInspectionLoading();
  previewRenderer.clear();
  const layer = new CopcPointCloudLayer(viewer.scene, {
    url: activeSource.url,
    maxCachedHierarchyPages: HIERARCHY_PAGE_CACHE_LIMIT,
    maxCachedSampleSets: POINT_SAMPLE_CACHE_LIMIT,
    maxCachedPointSampleBytes: POINT_SAMPLE_CACHE_BYTE_LIMIT,
    maxPointCountPerNode,
    pointSampleLoading: "worker",
    createPointRenderer: createPointRendererFactory(pointRendererKind),
    coordinateTransforms: activeSource.coordinateTransforms,
  });
  currentLayer = layer;
  currentInspection = undefined;
  currentHierarchy = undefined;
  currentCoordinateTransform = undefined;
  currentSuggestion = undefined;
  lastCameraStreamDiagnostics = undefined;
  currentSource = activeSource;
  currentPointRendererKind = pointRendererKind;
  automaticStreamRequestId += 1;
  automaticStreamPrefetchPromise = undefined;
  lastAutomaticStreamNodeKeySignature = "";
  resetCameraStreamAdaptiveBudget();
  elements.urlInput.value = activeSource.url;
  syncSampleSelectWithSource(activeSource);
  renderNodeSet.clear();
  renderSuggestion(undefined);
  renderHierarchyPageControls();
  renderRenderSetControls();

  try {
    const { inspection, hierarchy, coordinateTransform } = await layer.load();

    if (layer !== currentLayer) {
      return;
    }

    currentInspection = inspection;
    currentHierarchy = hierarchy;
    currentCoordinateTransform = coordinateTransform;
    populateNodeSelect(hierarchy);
    renderHierarchyPageControls();
    renderInspection(inspection);
    updateSuggestedNode();
    await renderSelectedHierarchyNode();
  } catch (error) {
    if (layer !== currentLayer) {
      return;
    }

    layer.destroy();
    currentLayer = undefined;
    currentCoordinateTransform = undefined;
    setInspectionError(error);
  }
}

function setInspectionLoading(): void {
  elements.statusText.textContent = "Reading COPC metadata...";
  elements.metadataList.replaceChildren();
  elements.nodeSelect.disabled = true;
  elements.nodeSelect.replaceChildren(new Option("Loading hierarchy...", ""));
  currentLayer?.clear();
  renderSuggestion(undefined);
  renderHierarchyPageControls();
  renderRenderSetControls();
}

function setInspectionError(error: unknown): void {
  elements.statusText.textContent =
    error instanceof Error
      ? `COPC inspection failed: ${error.message}`
      : "COPC inspection failed.";
  elements.metadataList.replaceChildren();
  elements.nodeSelect.disabled = true;
  currentLayer?.clear();
  renderSuggestion(undefined);
  renderHierarchyPageControls();
  renderRenderSetControls();
}

function renderInspection(
  inspection: CopcInspection,
  pointResult?: CopcNodePointSampleResult,
  selectedNode?: CopcHierarchyNodeSummary,
  nodeSetResult?: CopcMultiNodePointSampleResult,
  cameraSelection?: CopcHierarchyNodeCameraSelection,
  renderStats?: CopcPointCloudLayerRenderStats,
): void {
  elements.statusText.textContent = "COPC metadata loaded.";
  elements.metadataList.replaceChildren(
    metadataRow("Point count", inspection.pointCount.toLocaleString()),
    metadataRow("Source preset", currentSource.label),
    metadataRow("Source note", currentSource.description),
    metadataRow("Point renderer", POINT_RENDERER_LABELS[currentPointRendererKind]),
    metadataRow("Max points / node", readMaxPointCountPerNode().toLocaleString()),
    metadataRow(
      "Camera stream budget",
      formatCameraStreamBudget(),
    ),
    metadataRow(
      "Renderer timing",
      renderStats ? formatRenderStats(renderStats) : "Not rendered yet",
    ),
    metadataRow(
      "Renderer payload",
      renderStats ? formatRendererPayload(renderStats) : "Not rendered yet",
    ),
    metadataRow(
      "Camera stream diagnostics",
      lastCameraStreamDiagnostics
        ? formatCameraStreamDiagnostics(lastCameraStreamDiagnostics)
        : "Not streamed yet",
    ),
    metadataRow("LAS version", inspection.lasVersion),
    metadataRow(
      "Point format",
      `${inspection.pointDataRecordFormat} (${inspection.pointDataRecordLength} bytes)`,
    ),
    metadataRow("Bounds min", formatBoundsMin(inspection.bounds)),
    metadataRow("Bounds max", formatBoundsMax(inspection.bounds)),
    metadataRow("COPC cube min", formatBoundsMin(inspection.cube)),
    metadataRow("COPC cube max", formatBoundsMax(inspection.cube)),
    metadataRow("Scale", formatVector(inspection.scale)),
    metadataRow("Offset", formatVector(inspection.offset)),
    metadataRow("Spacing", formatNumber(inspection.spacing)),
    metadataRow(
      "Root hierarchy",
      `${inspection.rootHierarchyPage.pageLength.toLocaleString()} bytes at ${inspection.rootHierarchyPage.pageOffset.toLocaleString()}`,
    ),
    metadataRow(
      "Hierarchy pages",
      currentHierarchy && currentLayer
        ? formatHierarchyPageStats(
            currentHierarchy,
            currentLayer.source.getHierarchyCacheStats(),
          )
        : "Not loaded",
    ),
    metadataRow("GPS time", formatVector(inspection.gpsTimeRange)),
    metadataRow(
      "Coordinate transform",
      currentCoordinateTransform
        ? formatCoordinateTransform(currentCoordinateTransform)
        : "Not loaded yet",
    ),
    metadataRow(
      "Selected node",
      pointResult
        ? `${pointResult.nodePointCount.toLocaleString()} loaded, ${pointResult.sampledPointCount.toLocaleString()} rendered`
        : "Not loaded yet",
    ),
    metadataRow(
      "Node bounds min",
      selectedNode ? formatBoundsMin(selectedNode.bounds) : "Not selected",
    ),
    metadataRow(
      "Node bounds max",
      selectedNode ? formatBoundsMax(selectedNode.bounds) : "Not selected",
    ),
    metadataRow(
      "Node density",
      selectedNode ? formatDensity(selectedNode.pointDensity) : "Not selected",
    ),
    metadataRow(
      "Render set",
      nodeSetResult
        ? `${nodeSetResult.nodeKeys.length.toLocaleString()} nodes, ${nodeSetResult.sampledPointCount.toLocaleString()} points rendered`
        : formatRenderSetSummary(),
    ),
    metadataRow(
      "Point cache",
      currentLayer
        ? formatPointSampleCacheStats(currentLayer.source.getPointSampleCacheStats())
        : "Not loaded",
    ),
    metadataRow("Point loader", "Web Worker with main-thread fallback"),
    metadataRow(
      "Auto LOD",
      cameraSelection ? formatCameraSelection(cameraSelection) : "Not applied",
    ),
    metadataRow("VLRs", formatVlrs(inspection)),
    metadataRow("WKT", inspection.wkt ? truncateText(inspection.wkt, 220) : "Not found"),
  );
}

function cameraTargetForPointCloud(pointSamples: readonly PointSample[]): Cartesian3 {
  if (pointSamples.length === 0) {
    throw new Error("Cannot focus the camera without point samples.");
  }

  const totals = pointSamples.reduce(
    (sum, point) => ({
      longitudeDegrees: sum.longitudeDegrees + point.longitudeDegrees,
      latitudeDegrees: sum.latitudeDegrees + point.latitudeDegrees,
      maxHeightMeters: Math.max(sum.maxHeightMeters, point.heightMeters),
    }),
    {
      longitudeDegrees: 0,
      latitudeDegrees: 0,
      maxHeightMeters: Number.NEGATIVE_INFINITY,
    },
  );

  return Cartesian3.fromDegrees(
    totals.longitudeDegrees / pointSamples.length,
    totals.latitudeDegrees / pointSamples.length,
    totals.maxHeightMeters + 2_400,
  );
}

elements.nodeSelect.addEventListener("change", () => {
  void renderSelectedHierarchyNode();
});

async function renderSelectedHierarchyNode(): Promise<void> {
  if (!currentInspection || !currentLayer || !elements.nodeSelect.value) {
    return;
  }

  const layer = currentLayer;
  const nodeKey = elements.nodeSelect.value;
  elements.statusText.textContent = `Reading COPC node ${nodeKey}...`;

  try {
    const result = await layer.renderNode(nodeKey);

    if (layer !== currentLayer) {
      return;
    }

    viewer.camera.flyTo({
      destination: cameraTargetForPointCloud(result.points),
      duration: 0,
    });
    renderInspection(
      result.inspection,
      result.pointSamples,
      result.node,
      undefined,
      undefined,
      result.renderStats,
    );
    elements.statusText.textContent = `Rendered ${result.pointSamples.sampledPointCount.toLocaleString()} real COPC points from node ${nodeKey}.`;
    updateSuggestedNode();
    renderRenderSetControls();
  } catch (error) {
    if (layer !== currentLayer) {
      return;
    }

    setInspectionError(error);
  }
}

async function loadNextHierarchyPage(): Promise<void> {
  if (!currentInspection || !currentLayer || !currentHierarchy) {
    return;
  }

  const layer = currentLayer;
  const inspection = currentInspection;
  const nextPage = currentHierarchy.pendingPages[0];

  if (!nextPage) {
    elements.statusText.textContent = "No pending COPC hierarchy pages remain.";
    renderHierarchyPageControls();
    return;
  }

  const previousNodeKey = elements.nodeSelect.value;
  elements.statusText.textContent = `Reading COPC hierarchy page ${nextPage.key}...`;

  try {
    const hierarchy = await layer.loadNextHierarchyPage();

    if (layer !== currentLayer || !hierarchy) {
      return;
    }

    currentHierarchy = hierarchy;
    populateNodeSelect(hierarchy, previousNodeKey);
    renderHierarchyPageControls();
    updateSuggestedNode();
    renderInspection(inspection);
    elements.statusText.textContent = `Loaded hierarchy page ${nextPage.key}. ${hierarchy.nodes.length.toLocaleString()} nodes are available.`;
  } catch (error) {
    if (layer !== currentLayer) {
      return;
    }

    setInspectionError(error);
  }
}

async function renderSelectedNodeSet(): Promise<void> {
  await renderNodeKeySet([...renderNodeSet]);
}

async function renderAutomaticNodeSet(): Promise<void> {
  if (!currentInspection || !currentHierarchy || !currentLayer) {
    return;
  }

  if (!currentCoordinateTransform?.supportsCameraSelection) {
    elements.statusText.textContent =
      "Auto LOD unavailable: coordinateTransforms.toCopc is required.";
    return;
  }

  const layer = currentLayer;

  try {
    const result = await layer.renderAutomatic({
      camera: viewer.camera,
      expandHierarchy: true,
      maxNodes: 4,
      maxHierarchyPages: AUTO_LOD_MAX_HIERARCHY_PAGES,
      maxNodePointDataLength: AUTO_LOD_MAX_NODE_POINT_DATA_LENGTH,
      maxTotalPointDataLength: AUTO_LOD_MAX_TOTAL_POINT_DATA_LENGTH,
      maxRenderedPointCount: AUTO_LOD_MAX_RENDERED_POINT_COUNT,
    });

    if (!result || layer !== currentLayer) {
      return;
    }

    const loadedPageKeys = applyHierarchyExpansion(result.hierarchyExpansion);
    renderNodeSet.clear();
    result.nodes.forEach((node) => renderNodeSet.add(node.key));
    renderRenderSetControls();
    viewer.camera.flyTo({
      destination: cameraTargetForPointCloud(result.points),
      duration: 0,
    });
    renderInspection(
      result.inspection,
      undefined,
      undefined,
      result.pointSamples,
      result.cameraSelection,
      result.renderStats,
    );
    elements.statusText.textContent = `Auto LOD rendered ${result.pointSamples.sampledPointCount.toLocaleString()} points from ${result.pointSamples.nodeKeys.length.toLocaleString()} COPC nodes${formatLoadedHierarchyPages(loadedPageKeys)}.`;
    updateSuggestedNode();
    renderRenderSetControls();
  } catch (error) {
    if (layer !== currentLayer) {
      return;
    }

    setInspectionError(error);
  }
}

async function renderAutomaticNodeSetForCameraMove(
  forceRender: boolean,
): Promise<void> {
  if (
    !elements.autoStreamCheckbox.checked ||
    !currentInspection ||
    !currentHierarchy ||
    !currentLayer ||
    !currentCoordinateTransform?.supportsCameraSelection
  ) {
    return;
  }

  const layer = currentLayer;
  automaticStreamAbortController?.abort();
  const abortController = new AbortController();
  automaticStreamAbortController = abortController;
  const { signal } = abortController;
  const requestId = (automaticStreamRequestId += 1);
  const streamStartedAt = performance.now();
  const loadedPageKeys: readonly string[] = [];
  const expandHierarchyMilliseconds = 0;
  const applyHierarchyMilliseconds = 0;

  try {
    const selectNodesStartedAt = performance.now();
    const cameraSelection = await layer.selectNodesForCamera({
      camera: viewer.camera,
      maxNodes: CAMERA_STREAM_MAX_NODES,
      maxDepth: CAMERA_STREAM_MAX_DEPTH,
      signal,
    });
    const selectNodesMilliseconds = performance.now() - selectNodesStartedAt;

    if (
      signal.aborted ||
      !cameraSelection ||
      cameraSelection.nodes.length === 0 ||
      layer !== currentLayer ||
      requestId !== automaticStreamRequestId ||
      !elements.autoStreamCheckbox.checked
    ) {
      return;
    }

    const nodeKeys = cameraSelection.nodes.map((node) => node.key);
    const nodeKeySignature = nodeKeys.join("|");
    const streamPointBudget = readEffectiveCameraStreamMaxRenderedPointCount();
    const renderSignature = `${nodeKeySignature}@${streamPointBudget}`;

    if (!forceRender && renderSignature === lastAutomaticStreamNodeKeySignature) {
      queueCameraHierarchyPrefetch(layer);
      return;
    }

    elements.statusText.textContent = `Streaming ${nodeKeys.length.toLocaleString()} COPC nodes for camera position...`;

    const renderNodesStartedAt = performance.now();
    const result = await layer.renderNodes(nodeKeys, {
      maxRenderedPointCount: streamPointBudget,
      signal,
    });
    const renderNodesMilliseconds = performance.now() - renderNodesStartedAt;

    if (
      signal.aborted ||
      layer !== currentLayer ||
      requestId !== automaticStreamRequestId ||
      !elements.autoStreamCheckbox.checked
    ) {
      return;
    }

    lastCameraStreamRenderedPointBudget = streamPointBudget;
    lastCameraStreamDiagnostics = {
      expandHierarchyMilliseconds,
      applyHierarchyMilliseconds,
      selectNodesMilliseconds,
      renderNodesMilliseconds,
      totalMilliseconds: performance.now() - streamStartedAt,
      loadedHierarchyPageCount: loadedPageKeys.length,
      selectedNodeCount: nodeKeys.length,
      selectedDepth: cameraSelection.selectedDepth,
    };
    updateCameraStreamAdaptiveBudget(
      lastCameraStreamDiagnostics.totalMilliseconds,
      result.renderStats,
    );
    lastAutomaticStreamNodeKeySignature = renderSignature;
    renderNodeSet.clear();
    result.nodes.forEach((node) => renderNodeSet.add(node.key));
    renderRenderSetControls();
    renderInspection(
      result.inspection,
      undefined,
      undefined,
      result.pointSamples,
      cameraSelection,
      result.renderStats,
    );
    elements.statusText.textContent = `Camera stream rendered ${result.pointSamples.sampledPointCount.toLocaleString()} points from ${result.pointSamples.nodeKeys.length.toLocaleString()} COPC nodes${formatLoadedHierarchyPages(loadedPageKeys)}.`;
    updateSuggestedNode();
    queueCameraHierarchyPrefetch(layer);
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }

    if (layer !== currentLayer) {
      return;
    }

    setInspectionError(error);
  } finally {
    if (automaticStreamAbortController === abortController) {
      automaticStreamAbortController = undefined;
    }
  }
}

function queueCameraHierarchyPrefetch(layer: CopcPointCloudLayer): void {
  if (
    automaticStreamPrefetchPromise ||
    layer !== currentLayer ||
    !elements.autoStreamCheckbox.checked
  ) {
    return;
  }

  const prefetchPromise = prefetchCameraHierarchy(layer);
  automaticStreamPrefetchPromise = prefetchPromise;
  void prefetchPromise.finally(() => {
    if (automaticStreamPrefetchPromise === prefetchPromise) {
      automaticStreamPrefetchPromise = undefined;
    }
  });
}

async function prefetchCameraHierarchy(
  layer: CopcPointCloudLayer,
): Promise<void> {
  try {
    const hierarchyExpansion = await layer.expandHierarchyForCamera({
      camera: viewer.camera,
      maxPages: CAMERA_STREAM_MAX_HIERARCHY_PAGES,
    });

    if (
      layer !== currentLayer ||
      !elements.autoStreamCheckbox.checked ||
      !hierarchyExpansion
    ) {
      return;
    }

    applyHierarchyExpansion(hierarchyExpansion, {
      refreshNodeSelect: false,
    });
    updateSuggestedNode();
  } catch (error) {
    if (layer !== currentLayer || !elements.autoStreamCheckbox.checked) {
      return;
    }

    setInspectionError(error);
  }
}

async function renderNodeKeySet(
  nodeKeys: readonly string[],
): Promise<void> {
  if (!currentInspection || !currentLayer || nodeKeys.length === 0) {
    return;
  }

  const layer = currentLayer;
  elements.statusText.textContent = `Reading ${nodeKeys.length.toLocaleString()} COPC nodes...`;

  try {
    const result = await layer.renderNodes(nodeKeys, {
      maxRenderedPointCount: Math.max(readMaxPointCountPerNode(), nodeKeys.length),
    });

    if (layer !== currentLayer) {
      return;
    }

    viewer.camera.flyTo({
      destination: cameraTargetForPointCloud(result.points),
      duration: 0,
    });
    renderInspection(
      result.inspection,
      undefined,
      undefined,
      result.pointSamples,
      undefined,
      result.renderStats,
    );
    elements.statusText.textContent = `Rendered ${result.pointSamples.sampledPointCount.toLocaleString()} points from ${result.pointSamples.nodeKeys.length.toLocaleString()} COPC nodes.`;
    updateSuggestedNode();
    renderRenderSetControls();
  } catch (error) {
    if (layer !== currentLayer) {
      return;
    }

    setInspectionError(error);
  }
}

function updateSuggestedNode(): void {
  currentSuggestion = undefined;

  if (!currentInspection || !currentHierarchy || !currentLayer) {
    renderSuggestion(undefined);
    return;
  }

  if (!currentCoordinateTransform?.supportsCameraSelection) {
    renderSuggestionUnavailable(
      "Suggested node unavailable: coordinateTransforms.toCopc is required.",
    );
    return;
  }

  try {
    currentSuggestion = currentLayer.suggestNodeForCamera(viewer.camera);
    renderSuggestion(currentSuggestion);
  } catch (error) {
    renderSuggestionUnavailable(
      error instanceof Error
        ? `Suggested node unavailable: ${error.message}`
        : "Suggested node unavailable.",
    );
  }
}

function renderSuggestion(
  suggestion: CopcHierarchyNodeSuggestion | undefined,
): void {
  if (!suggestion) {
    elements.suggestionText.textContent = "Suggested node: not available.";
    elements.applySuggestionButton.disabled = true;
    return;
  }

  const isSelected = suggestion.node.key === elements.nodeSelect.value;
  elements.suggestionText.textContent = `Suggested node: ${suggestion.node.key} (${formatSuggestionDistance(suggestion.distanceToBounds)})`;
  elements.applySuggestionButton.disabled = isSelected;
  renderRenderSetControls();
}

function renderSuggestionUnavailable(message: string): void {
  elements.suggestionText.textContent = message;
  elements.applySuggestionButton.disabled = true;
}

function addNodeToRenderSet(nodeKey: string): void {
  renderNodeSet.add(nodeKey);
  renderRenderSetControls();
}

function applyHierarchyExpansion(
  expansion: CopcPointCloudLayerHierarchyExpansionResult | undefined,
  options: {
    readonly refreshNodeSelect?: boolean;
  } = {},
): readonly string[] {
  if (!expansion) {
    return [];
  }

  const refreshNodeSelect = options.refreshNodeSelect ?? true;
  currentHierarchy = expansion.hierarchy;

  if (refreshNodeSelect) {
    populateNodeSelect(expansion.hierarchy, elements.nodeSelect.value);
  }

  renderHierarchyPageControls();
  return expansion.loadedPageKeys;
}

function renderHierarchyPageControls(): void {
  if (!currentHierarchy) {
    elements.hierarchyPagesText.textContent = "Hierarchy pages: not loaded.";
    elements.loadMoreHierarchyButton.disabled = true;
    return;
  }

  elements.hierarchyPagesText.textContent = `Hierarchy pages: ${formatHierarchyPageStats(
    currentHierarchy,
    currentLayer?.source.getHierarchyCacheStats(),
  )}.`;
  elements.loadMoreHierarchyButton.disabled =
    !currentLayer || currentHierarchy.pendingPageCount === 0;
}

function renderRenderSetControls(): void {
  const nodeKeys = [...renderNodeSet];
  const hasNodes = nodeKeys.length > 0;
  const selectedNodeKey = elements.nodeSelect.value;
  const suggestedNodeKey = currentSuggestion?.node.key;
  const canUseCameraSelection = Boolean(
    currentInspection &&
      currentHierarchy &&
      currentCoordinateTransform?.supportsCameraSelection,
  );

  elements.renderSetText.textContent = hasNodes
    ? `Render set: ${nodeKeys.join(", ")}`
    : "Render set: empty.";
  elements.addSelectedButton.disabled =
    !selectedNodeKey || renderNodeSet.has(selectedNodeKey);
  elements.addSuggestionButton.disabled =
    !suggestedNodeKey || renderNodeSet.has(suggestedNodeKey);
  elements.autoLodButton.disabled = !canUseCameraSelection;
  elements.autoLodButton.title = canUseCameraSelection
    ? ""
    : "Auto LOD requires coordinateTransforms.toCopc.";
  elements.autoStreamCheckbox.disabled = !canUseCameraSelection;
  if (!canUseCameraSelection) {
    elements.autoStreamCheckbox.checked = false;
    lastAutomaticStreamNodeKeySignature = "";
    automaticStreamPrefetchPromise = undefined;
    resetCameraStreamAdaptiveBudget();
  }
  elements.renderSetButton.disabled = !hasNodes;
  elements.clearSetButton.disabled = !hasNodes;
}

function populateSampleSelect(): void {
  elements.sampleSelect.replaceChildren(
    ...SAMPLE_COPC_SOURCES.map((sample) => {
      const option = new Option(sample.label, sample.id);
      option.title = sample.description;
      return option;
    }),
    new Option("Custom URL", CUSTOM_SAMPLE_OPTION_VALUE),
  );
  elements.sampleSelect.value = DEFAULT_SAMPLE_COPC_SOURCE.id;
  elements.urlInput.value = DEFAULT_SAMPLE_COPC_SOURCE.url;
  clearCustomProjectionInputs();
  syncCustomProjectionControls();
}

function syncSampleSelectWithUrl(url: string): void {
  const sample = findSampleByUrl(url.trim());
  elements.sampleSelect.value = sample?.id ?? CUSTOM_SAMPLE_OPTION_VALUE;
  syncCustomProjectionControls();
}

function syncSampleSelectWithSource(source: CopcSourceConfig): void {
  const sample = isSampleCopcSource(source) ? source : undefined;
  elements.sampleSelect.value = sample?.id ?? CUSTOM_SAMPLE_OPTION_VALUE;
  syncCustomProjectionControls();
}

function findSampleById(sampleId: string): SampleCopcSource | undefined {
  return SAMPLE_COPC_SOURCES.find((sample) => sample.id === sampleId);
}

function findSampleByUrl(url: string): SampleCopcSource | undefined {
  return SAMPLE_COPC_SOURCES.find((sample) => sample.url === url);
}

function isSampleCopcSource(
  source: CopcSourceConfig,
): source is SampleCopcSource {
  return "id" in source;
}

function createSourceConfigFromForm(): CopcSourceConfig {
  const normalizedUrl = elements.urlInput.value.trim();
  const sample =
    elements.sampleSelect.value === CUSTOM_SAMPLE_OPTION_VALUE
      ? undefined
      : findSampleByUrl(normalizedUrl);

  return (
    sample ??
    createCustomCopcSource(normalizedUrl, readCustomProjectionOptions())
  );
}

function normalizeSourceConfig(source: CopcSourceConfig): CopcSourceConfig {
  return {
    ...source,
    url: source.url.trim(),
  };
}

function readCustomProjectionOptions(): CustomCopcProjectionOptions {
  return {
    sourceCrs: elements.sourceCrsInput.value,
    sourceDefinition: elements.sourceDefinitionInput.value,
  };
}

function readPointRendererKind(): PointRendererKind {
  return elements.rendererSelect.value === "buffer" ? "buffer" : "primitive";
}

function initializeRendererBenchmarkControls(): void {
  const params = new URLSearchParams(window.location.search);
  const renderer = params.get("renderer");

  if (renderer === "buffer" || renderer === "primitive") {
    elements.rendererSelect.value = renderer;
  }

  const maxPointCountParam =
    params.get("maxPointCountPerNode") ?? params.get("maxPoints");

  if (!maxPointCountParam) {
    elements.maxPointCountInput.value = String(DEFAULT_MAX_POINT_COUNT_PER_NODE);
  } else {
    const maxPointCount = Number(maxPointCountParam);
    elements.maxPointCountInput.value = String(
      isPositiveSafeInteger(maxPointCount)
        ? maxPointCount
        : DEFAULT_MAX_POINT_COUNT_PER_NODE,
    );
  }

  const streamPointBudgetParam =
    params.get("cameraStreamMaxPoints") ?? params.get("streamMaxPoints");

  if (!streamPointBudgetParam) {
    elements.cameraStreamPointBudgetInput.value = String(
      DEFAULT_CAMERA_STREAM_MAX_RENDERED_POINT_COUNT,
    );
  } else {
    const streamPointBudget = Number(streamPointBudgetParam);
    elements.cameraStreamPointBudgetInput.value = String(
      isPositiveSafeInteger(streamPointBudget)
        ? streamPointBudget
        : DEFAULT_CAMERA_STREAM_MAX_RENDERED_POINT_COUNT,
    );
  }
}

function readMaxPointCountPerNode(): number {
  const maxPointCount = Number(elements.maxPointCountInput.value);
  return isPositiveSafeInteger(maxPointCount)
    ? maxPointCount
    : DEFAULT_MAX_POINT_COUNT_PER_NODE;
}

function readCameraStreamMaxRenderedPointCount(): number {
  const pointBudget = Number(elements.cameraStreamPointBudgetInput.value);
  return isPositiveSafeInteger(pointBudget)
    ? pointBudget
    : DEFAULT_CAMERA_STREAM_MAX_RENDERED_POINT_COUNT;
}

function readEffectiveCameraStreamMaxRenderedPointCount(): number {
  return Math.min(
    readCameraStreamMaxRenderedPointCount(),
    adaptiveCameraStreamPointBudget ?? Number.POSITIVE_INFINITY,
  );
}

function resetCameraStreamAdaptiveBudget(): void {
  adaptiveCameraStreamPointBudget = undefined;
  adaptiveCameraStreamFastRunCount = 0;
  lastCameraStreamRenderedPointBudget = undefined;
}

function updateCameraStreamAdaptiveBudget(
  totalMilliseconds: number,
  renderStats: CopcPointCloudLayerRenderStats,
): void {
  const maxPointBudget = readCameraStreamMaxRenderedPointCount();
  const currentPointBudget = readEffectiveCameraStreamMaxRenderedPointCount();
  const minPointBudget = Math.min(
    maxPointBudget,
    CAMERA_STREAM_MIN_RENDERED_POINT_COUNT,
  );
  const isSlow =
    totalMilliseconds > CAMERA_STREAM_SLOW_TOTAL_MILLISECONDS ||
    renderStats.totalRenderMilliseconds > CAMERA_STREAM_SLOW_RENDER_MILLISECONDS;

  if (isSlow) {
    adaptiveCameraStreamFastRunCount = 0;

    if (currentPointBudget > minPointBudget) {
      adaptiveCameraStreamPointBudget = Math.max(
        minPointBudget,
        Math.floor(currentPointBudget * 0.75),
      );
    }

    return;
  }

  if (
    currentPointBudget < maxPointBudget &&
    totalMilliseconds < CAMERA_STREAM_RECOVERY_TOTAL_MILLISECONDS &&
    renderStats.totalRenderMilliseconds < CAMERA_STREAM_RECOVERY_RENDER_MILLISECONDS
  ) {
    adaptiveCameraStreamFastRunCount += 1;

    if (adaptiveCameraStreamFastRunCount >= CAMERA_STREAM_RECOVERY_STREAK) {
      adaptiveCameraStreamPointBudget = Math.min(
        maxPointBudget,
        Math.ceil(currentPointBudget * 1.25),
      );
      adaptiveCameraStreamFastRunCount = 0;
    }

    return;
  }

  adaptiveCameraStreamFastRunCount = 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function createPointRendererFactory(
  kind: PointRendererKind,
): CopcPointCloudRendererFactory {
  return kind === "buffer"
    ? (scene) => new CesiumBufferPointRenderer(scene)
    : (scene) => new CesiumPointPrimitiveRenderer(scene);
}

function syncCustomProjectionControls(): void {
  const isCustomSource =
    elements.sampleSelect.value === CUSTOM_SAMPLE_OPTION_VALUE;
  elements.sourceCrsInput.disabled = !isCustomSource;
  elements.sourceDefinitionInput.disabled = !isCustomSource;
}

function clearCustomProjectionInputs(): void {
  elements.sourceCrsInput.value = "";
  elements.sourceDefinitionInput.value = "";
}

function populateNodeSelect(
  hierarchy: CopcHierarchySummary,
  preferredNodeKey = "",
): void {
  elements.nodeSelect.replaceChildren(
    ...hierarchy.nodes.map((node) => {
      const option = new Option(
        `${node.key} | ${node.pointCount.toLocaleString()} pts | ${formatBytes(node.pointDataLength)}`,
        node.key,
      );
      option.title = `offset ${node.pointDataOffset.toLocaleString()}`;
      return option;
    }),
  );
  elements.nodeSelect.disabled = hierarchy.nodes.length === 0;
  elements.nodeSelect.value = hierarchy.nodes.some(
    (node) => node.key === preferredNodeKey,
  )
    ? preferredNodeKey
    : hierarchy.nodes[0]?.key ?? "";
}

function getPrototypeElements(): {
  readonly container: HTMLDivElement;
  readonly form: HTMLFormElement;
  readonly sampleSelect: HTMLSelectElement;
  readonly rendererSelect: HTMLSelectElement;
  readonly maxPointCountInput: HTMLInputElement;
  readonly cameraStreamPointBudgetInput: HTMLInputElement;
  readonly urlInput: HTMLInputElement;
  readonly sourceCrsInput: HTMLInputElement;
  readonly sourceDefinitionInput: HTMLTextAreaElement;
  readonly nodeSelect: HTMLSelectElement;
  readonly hierarchyPagesText: HTMLParagraphElement;
  readonly loadMoreHierarchyButton: HTMLButtonElement;
  readonly suggestionText: HTMLParagraphElement;
  readonly applySuggestionButton: HTMLButtonElement;
  readonly renderSetText: HTMLParagraphElement;
  readonly addSelectedButton: HTMLButtonElement;
  readonly addSuggestionButton: HTMLButtonElement;
  readonly autoLodButton: HTMLButtonElement;
  readonly autoStreamCheckbox: HTMLInputElement;
  readonly renderSetButton: HTMLButtonElement;
  readonly clearSetButton: HTMLButtonElement;
  readonly statusText: HTMLParagraphElement;
  readonly metadataList: HTMLDListElement;
} {
  const container = document.querySelector<HTMLDivElement>("#cesium-container");
  const form = document.querySelector<HTMLFormElement>("#copc-form");
  const sampleSelect = document.querySelector<HTMLSelectElement>(
    "#copc-sample-select",
  );
  const rendererSelect = document.querySelector<HTMLSelectElement>(
    "#copc-renderer-select",
  );
  const maxPointCountInput = document.querySelector<HTMLInputElement>(
    "#copc-max-point-count",
  );
  const cameraStreamPointBudgetInput = document.querySelector<HTMLInputElement>(
    "#copc-camera-stream-point-budget",
  );
  const urlInput = document.querySelector<HTMLInputElement>("#copc-url");
  const sourceCrsInput = document.querySelector<HTMLInputElement>(
    "#copc-source-crs",
  );
  const sourceDefinitionInput = document.querySelector<HTMLTextAreaElement>(
    "#copc-source-definition",
  );
  const nodeSelect = document.querySelector<HTMLSelectElement>("#copc-node-select");
  const hierarchyPagesText = document.querySelector<HTMLParagraphElement>(
    "#copc-hierarchy-pages",
  );
  const loadMoreHierarchyButton = document.querySelector<HTMLButtonElement>(
    "#copc-load-more-hierarchy",
  );
  const suggestionText = document.querySelector<HTMLParagraphElement>("#copc-suggestion");
  const applySuggestionButton = document.querySelector<HTMLButtonElement>(
    "#copc-apply-suggestion",
  );
  const renderSetText = document.querySelector<HTMLParagraphElement>("#copc-render-set");
  const addSelectedButton = document.querySelector<HTMLButtonElement>(
    "#copc-add-selected",
  );
  const addSuggestionButton = document.querySelector<HTMLButtonElement>(
    "#copc-add-suggestion",
  );
  const autoLodButton = document.querySelector<HTMLButtonElement>("#copc-auto-lod");
  const autoStreamCheckbox = document.querySelector<HTMLInputElement>(
    "#copc-auto-stream",
  );
  const renderSetButton = document.querySelector<HTMLButtonElement>(
    "#copc-render-set-button",
  );
  const clearSetButton = document.querySelector<HTMLButtonElement>("#copc-clear-set");
  const statusText = document.querySelector<HTMLParagraphElement>("#copc-status");
  const metadataList = document.querySelector<HTMLDListElement>("#copc-metadata");

  if (
    !container ||
    !form ||
    !sampleSelect ||
    !rendererSelect ||
    !maxPointCountInput ||
    !cameraStreamPointBudgetInput ||
    !urlInput ||
    !sourceCrsInput ||
    !sourceDefinitionInput ||
    !nodeSelect ||
    !hierarchyPagesText ||
    !loadMoreHierarchyButton ||
    !suggestionText ||
    !applySuggestionButton ||
    !renderSetText ||
    !addSelectedButton ||
    !addSuggestionButton ||
    !autoLodButton ||
    !autoStreamCheckbox ||
    !renderSetButton ||
    !clearSetButton ||
    !statusText ||
    !metadataList
  ) {
    throw new Error("Missing prototype DOM elements.");
  }

  return {
    container,
    form,
    sampleSelect,
    rendererSelect,
    maxPointCountInput,
    cameraStreamPointBudgetInput,
    urlInput,
    sourceCrsInput,
    sourceDefinitionInput,
    nodeSelect,
    hierarchyPagesText,
    loadMoreHierarchyButton,
    suggestionText,
    applySuggestionButton,
    renderSetText,
    addSelectedButton,
    addSuggestionButton,
    autoLodButton,
    autoStreamCheckbox,
    renderSetButton,
    clearSetButton,
    statusText,
    metadataList,
  };
}

function metadataRow(label: string, value: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const term = document.createElement("dt");
  const description = document.createElement("dd");

  term.textContent = label;
  description.textContent = value;
  fragment.append(term, description);

  return fragment;
}

function formatBoundsMin(bounds: CopcBounds): string {
  return formatVector([bounds.minX, bounds.minY, bounds.minZ]);
}

function formatBoundsMax(bounds: CopcBounds): string {
  return formatVector([bounds.maxX, bounds.maxY, bounds.maxZ]);
}

function formatVector(values: readonly number[]): string {
  return values.map(formatNumber).join(", ");
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString()
    : value.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function formatMilliseconds(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatVlrs(inspection: CopcInspection): string {
  return inspection.vlrs
    .map((vlr) => {
      const kind = vlr.isExtended ? "EVLR" : "VLR";
      const description = vlr.description ? `, ${vlr.description}` : "";
      return `${kind} ${vlr.userId}/${vlr.recordId} (${vlr.contentLength.toLocaleString()} bytes${description})`;
    })
    .join(" | ");
}

function formatDensity(value: number): string {
  return `${value.toExponential(3)} pts / unit^3`;
}

function formatRenderSetSummary(): string {
  return renderNodeSet.size > 0
    ? `${renderNodeSet.size.toLocaleString()} nodes queued`
    : "Empty";
}

function formatPointSampleCacheStats(
  stats: CopcPointSampleCacheStats,
): string {
  return `${stats.cachedSampleSetCount.toLocaleString()} / ${stats.maxCachedSampleSetCount.toLocaleString()} sample sets, ${formatBytes(stats.cachedPointSampleBytes)} / ${formatBytes(stats.maxCachedPointSampleBytes)}, ${stats.cacheHitCount.toLocaleString()} hits, ${stats.cacheMissCount.toLocaleString()} misses, ${stats.cacheEvictionCount.toLocaleString()} evictions`;
}

function formatRenderStats(stats: CopcPointCloudLayerRenderStats): string {
  return `${stats.pointCount.toLocaleString()} pts, transform ${formatMilliseconds(stats.coordinateTransformMilliseconds)} ms, renderer ${formatMilliseconds(stats.rendererSetPointsMilliseconds)} ms, bounds ${formatMilliseconds(stats.boundsRenderMilliseconds)} ms, total ${formatMilliseconds(stats.totalRenderMilliseconds)} ms`;
}

function formatRendererPayload(stats: CopcPointCloudLayerRenderStats): string {
  return `${formatBytes(stats.estimatedRenderPayloadBytes)} estimated coordinate/color payload`;
}

function formatCameraStreamBudget(): string {
  const maxPointBudget = readCameraStreamMaxRenderedPointCount();
  const effectivePointBudget = readEffectiveCameraStreamMaxRenderedPointCount();
  const budgetText =
    effectivePointBudget === maxPointBudget
      ? `${maxPointBudget.toLocaleString()} points`
      : `${effectivePointBudget.toLocaleString()} / ${maxPointBudget.toLocaleString()} points adaptive`;

  return lastCameraStreamRenderedPointBudget === undefined
    ? budgetText
    : `${budgetText}, last ${lastCameraStreamRenderedPointBudget.toLocaleString()} points`;
}

function formatCameraStreamDiagnostics(
  diagnostics: CameraStreamDiagnostics,
): string {
  return `expand ${formatMilliseconds(diagnostics.expandHierarchyMilliseconds)} ms, apply ${formatMilliseconds(diagnostics.applyHierarchyMilliseconds)} ms, select ${formatMilliseconds(diagnostics.selectNodesMilliseconds)} ms, render ${formatMilliseconds(diagnostics.renderNodesMilliseconds)} ms, total ${formatMilliseconds(diagnostics.totalMilliseconds)} ms, ${diagnostics.loadedHierarchyPageCount.toLocaleString()} pages, ${diagnostics.selectedNodeCount.toLocaleString()} nodes, depth ${diagnostics.selectedDepth.toLocaleString()}`;
}

function formatHierarchyPageStats(
  hierarchy: CopcHierarchySummary,
  stats?: CopcHierarchyCacheStats,
): string {
  const loadedPageCount = stats?.loadedPageCount ?? hierarchy.loadedPageCount;
  const pendingPageCount = stats?.pendingPageCount ?? hierarchy.pendingPageCount;
  const limitSummary = stats
    ? ` / ${stats.maxCachedPageCount.toLocaleString()} page cache limit, ${stats.trackedNodeCount.toLocaleString()} tracked nodes`
    : "";
  const evictionSummary = stats
    ? `, ${stats.cacheEvictionCount.toLocaleString()} evictions`
    : "";
  const overLimitSummary = stats?.isOverLimit ? ", over limit" : "";

  return `${loadedPageCount.toLocaleString()} loaded${limitSummary}, ${pendingPageCount.toLocaleString()} pending${evictionSummary}${overLimitSummary}`;
}

function formatLoadedHierarchyPages(pageKeys: readonly string[]): string {
  return pageKeys.length > 0
    ? ` after loading ${pageKeys.length.toLocaleString()} hierarchy pages`
    : "";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function formatCameraSelection(
  selection: CopcHierarchyNodeCameraSelection,
): string {
  const budgetSummary =
    selection.skippedByBudgetCount > 0
      ? `, ${selection.skippedByBudgetCount.toLocaleString()} skipped by budget`
      : "";
  const frustumSummary =
    selection.skippedByFrustumCount > 0
      ? `, ${selection.skippedByFrustumCount.toLocaleString()} outside frustum`
      : "";
  const viewSummary =
    selection.skippedByViewCount > 0
      ? `, ${selection.skippedByViewCount.toLocaleString()} outside view`
      : "";
  const spacingSummary =
    selection.estimatedSelectedDepthPointSpacingScreenPixels !== undefined &&
    selection.targetPointSpacingScreenPixels !== undefined
      ? `, spacing ${selection.estimatedSelectedDepthPointSpacingScreenPixels.toLocaleString(undefined, { maximumFractionDigits: 1 })} px / ${selection.targetPointSpacingScreenPixels.toLocaleString(undefined, { maximumFractionDigits: 1 })} px target`
      : "";

  return `${selection.nodes.length.toLocaleString()} nodes at depth ${selection.selectedDepth.toLocaleString()} (target depth ${selection.targetDepth.toLocaleString()}, selected depth ${selection.estimatedSelectedDepthScreenPixels.toLocaleString(undefined, { maximumFractionDigits: 0 })} px / ${selection.targetNodeScreenPixels.toLocaleString(undefined, { maximumFractionDigits: 0 })} px target, root ${selection.estimatedRootScreenPixels.toLocaleString(undefined, { maximumFractionDigits: 0 })} px${spacingSummary}${frustumSummary}${viewSummary}${budgetSummary})`;
}

function formatCoordinateTransform(
  status: CopcCoordinateTransformStatus,
): string {
  return `${status.label} (${status.kind}, camera selection ${
    status.supportsCameraSelection ? "supported" : "unavailable"
  })`;
}

function formatSuggestionDistance(value: number): string {
  return value === 0
    ? "camera position inside XY bounds"
    : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} COPC units from camera XY`;
}

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function formatBytes(byteCount: number): string {
  if (byteCount < 1024) {
    return `${byteCount.toLocaleString()} B`;
  }

  return `${(byteCount / 1024).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })} KB`;
}
