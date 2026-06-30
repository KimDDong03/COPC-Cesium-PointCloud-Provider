import {
  Cartesian3,
  Viewer,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import {
  CesiumPointRenderer,
  CopcPointCloudLayer,
  type CopcBounds,
  type CopcCoordinateTransformStatus,
  type CopcHierarchyNodeCameraSelection,
  type CopcHierarchyNodeSuggestion,
  type CopcHierarchyNodeSummary,
  type CopcHierarchySummary,
  type CopcInspection,
  type CopcMultiNodePointSampleResult,
  type CopcNodePointSampleResult,
  type CopcPointCloudLayerHierarchyExpansionResult,
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
const CAMERA_STREAM_MAX_HIERARCHY_PAGES = 1;
const CAMERA_STREAM_MAX_NODES = 1;
const CAMERA_STREAM_MAX_DEPTH = 0;

const elements = getPrototypeElements();
let currentLayer: CopcPointCloudLayer | undefined;
let currentInspection: CopcInspection | undefined;
let currentHierarchy: CopcHierarchySummary | undefined;
let currentCoordinateTransform: CopcCoordinateTransformStatus | undefined;
let currentSuggestion: CopcHierarchyNodeSuggestion | undefined;
let currentSource: CopcSourceConfig = DEFAULT_SAMPLE_COPC_SOURCE;
let automaticStreamRequestId = 0;
let lastAutomaticStreamNodeKeySignature = "";
const renderNodeSet = new Set<string>();

const viewer = new Viewer(elements.container, {
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

const points = createHardcodedPointSamples();
const previewRenderer = new CesiumPointRenderer(viewer.scene);
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

  if (elements.autoStreamCheckbox.checked) {
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

populateSampleSelect();
void inspectSource(DEFAULT_SAMPLE_COPC_SOURCE);

async function inspectSource(source: CopcSourceConfig): Promise<void> {
  const activeSource = normalizeSourceConfig(source);
  const previousLayer = currentLayer;
  currentLayer = undefined;
  previousLayer?.destroy();
  setInspectionLoading();
  previewRenderer.clear();
  const layer = new CopcPointCloudLayer(viewer.scene, {
    url: activeSource.url,
    coordinateTransforms: activeSource.coordinateTransforms,
  });
  currentLayer = layer;
  currentInspection = undefined;
  currentHierarchy = undefined;
  currentCoordinateTransform = undefined;
  currentSuggestion = undefined;
  currentSource = activeSource;
  automaticStreamRequestId += 1;
  lastAutomaticStreamNodeKeySignature = "";
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
): void {
  elements.statusText.textContent = "COPC metadata loaded.";
  elements.metadataList.replaceChildren(
    metadataRow("Point count", inspection.pointCount.toLocaleString()),
    metadataRow("Source preset", currentSource.label),
    metadataRow("Source note", currentSource.description),
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
      currentHierarchy ? formatHierarchyPageStats(currentHierarchy) : "Not loaded",
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
    renderInspection(result.inspection, result.pointSamples, result.node);
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
  const requestId = (automaticStreamRequestId += 1);

  try {
    const hierarchyExpansion = await layer.expandHierarchyForCamera({
      camera: viewer.camera,
      maxPages: CAMERA_STREAM_MAX_HIERARCHY_PAGES,
    });

    if (
      layer !== currentLayer ||
      requestId !== automaticStreamRequestId ||
      !elements.autoStreamCheckbox.checked
    ) {
      return;
    }

    const loadedPageKeys = applyHierarchyExpansion(hierarchyExpansion);
    const cameraSelection = await layer.selectNodesForCamera({
      camera: viewer.camera,
      maxNodes: CAMERA_STREAM_MAX_NODES,
      maxDepth: CAMERA_STREAM_MAX_DEPTH,
    });

    if (
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

    if (!forceRender && nodeKeySignature === lastAutomaticStreamNodeKeySignature) {
      return;
    }

    lastAutomaticStreamNodeKeySignature = nodeKeySignature;
    elements.statusText.textContent = `Streaming ${nodeKeys.length.toLocaleString()} COPC nodes for camera position...`;

    const result = await layer.renderNodes(nodeKeys);

    if (
      layer !== currentLayer ||
      requestId !== automaticStreamRequestId ||
      !elements.autoStreamCheckbox.checked
    ) {
      return;
    }

    renderNodeSet.clear();
    result.nodes.forEach((node) => renderNodeSet.add(node.key));
    renderRenderSetControls();
    renderInspection(
      result.inspection,
      undefined,
      undefined,
      result.pointSamples,
      cameraSelection,
    );
    elements.statusText.textContent = `Camera stream rendered ${result.pointSamples.sampledPointCount.toLocaleString()} points from ${result.pointSamples.nodeKeys.length.toLocaleString()} COPC nodes${formatLoadedHierarchyPages(loadedPageKeys)}.`;
    updateSuggestedNode();
  } catch (error) {
    if (layer !== currentLayer) {
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
    const result = await layer.renderNodes(nodeKeys);

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
): readonly string[] {
  if (!expansion) {
    return [];
  }

  const selectedNodeKey = elements.nodeSelect.value;
  currentHierarchy = expansion.hierarchy;
  populateNodeSelect(expansion.hierarchy, selectedNodeKey);
  renderHierarchyPageControls();
  return expansion.loadedPageKeys;
}

function renderHierarchyPageControls(): void {
  if (!currentHierarchy) {
    elements.hierarchyPagesText.textContent = "Hierarchy pages: not loaded.";
    elements.loadMoreHierarchyButton.disabled = true;
    return;
  }

  elements.hierarchyPagesText.textContent = `Hierarchy pages: ${currentHierarchy.loadedPageCount.toLocaleString()} loaded, ${currentHierarchy.pendingPageCount.toLocaleString()} pending.`;
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
  return `${stats.cachedSampleSetCount.toLocaleString()} sample sets, ${stats.cacheHitCount.toLocaleString()} hits, ${stats.cacheMissCount.toLocaleString()} misses`;
}

function formatHierarchyPageStats(hierarchy: CopcHierarchySummary): string {
  return `${hierarchy.loadedPageCount.toLocaleString()} loaded, ${hierarchy.pendingPageCount.toLocaleString()} pending`;
}

function formatLoadedHierarchyPages(pageKeys: readonly string[]): string {
  return pageKeys.length > 0
    ? ` after loading ${pageKeys.length.toLocaleString()} hierarchy pages`
    : "";
}

function formatCameraSelection(
  selection: CopcHierarchyNodeCameraSelection,
): string {
  const budgetSummary =
    selection.skippedByBudgetCount > 0
      ? `, ${selection.skippedByBudgetCount.toLocaleString()} skipped by budget`
      : "";

  return `${selection.nodes.length.toLocaleString()} nodes at depth ${selection.selectedDepth.toLocaleString()} (target depth ${selection.targetDepth.toLocaleString()}, root span ${selection.estimatedRootScreenPixels.toLocaleString(undefined, { maximumFractionDigits: 0 })} px${budgetSummary})`;
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
