import {
  Cartesian3,
  Cartographic,
  Math as CesiumMath,
  Viewer,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import {
  CesiumBoundsRenderer,
  CesiumPointRenderer,
  CopcSource,
  createCesiumToCopcCoordinateTransform,
  createPointSamplesFromCopc,
  selectHierarchyNodesForCamera,
  suggestHierarchyNode,
  type CopcBounds,
  type CopcHierarchyNodeCameraSelection,
  type CopcHierarchyNodeSuggestion,
  type CopcHierarchyNodeSummary,
  type CopcHierarchySummary,
  type CopcInspection,
  type CopcMultiNodePointSampleResult,
  type CopcNodePointSampleResult,
  type CopcTargetPoint,
  type PointSample,
} from "copc-viewer";
import { createHardcodedPointSamples } from "./hardcodedPointSamples";
import "./style.css";

const elements = getPrototypeElements();
let currentSource: CopcSource | undefined;
let currentInspection: CopcInspection | undefined;
let currentHierarchy: CopcHierarchySummary | undefined;
let currentSuggestion: CopcHierarchyNodeSuggestion | undefined;
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
const renderer = new CesiumPointRenderer(viewer.scene);
const boundsRenderer = new CesiumBoundsRenderer(viewer.scene);
renderer.setPoints(points);

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
  void inspectUrl(elements.urlInput.value);
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

elements.autoLodButton.addEventListener("click", () => {
  void renderAutomaticNodeSet();
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
});

void inspectUrl(elements.urlInput.value);

async function inspectUrl(url: string): Promise<void> {
  setInspectionLoading();
  const source = new CopcSource(url);
  currentSource = source;
  currentInspection = undefined;
  currentHierarchy = undefined;
  currentSuggestion = undefined;
  renderNodeSet.clear();
  boundsRenderer.clear();
  renderSuggestion(undefined);
  renderRenderSetControls();

  try {
    const [inspection, hierarchy] = await Promise.all([
      source.inspect(),
      source.loadHierarchySummary(),
    ]);

    if (source !== currentSource) {
      return;
    }

    currentInspection = inspection;
    currentHierarchy = hierarchy;
    populateNodeSelect(hierarchy);
    renderInspection(inspection);
    updateSuggestedNode();
    await renderSelectedHierarchyNode();
  } catch (error) {
    setInspectionError(error);
  }
}

function setInspectionLoading(): void {
  elements.statusText.textContent = "Reading COPC metadata...";
  elements.metadataList.replaceChildren();
  elements.nodeSelect.disabled = true;
  elements.nodeSelect.replaceChildren(new Option("Loading hierarchy...", ""));
  boundsRenderer.clear();
  renderSuggestion(undefined);
  renderRenderSetControls();
}

function setInspectionError(error: unknown): void {
  elements.statusText.textContent =
    error instanceof Error
      ? `COPC inspection failed: ${error.message}`
      : "COPC inspection failed.";
  elements.metadataList.replaceChildren();
  elements.nodeSelect.disabled = true;
  boundsRenderer.clear();
  renderSuggestion(undefined);
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
    metadataRow("GPS time", formatVector(inspection.gpsTimeRange)),
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
  if (!currentInspection || !currentSource || !elements.nodeSelect.value) {
    return;
  }

  const source = currentSource;
  const inspection = currentInspection;
  const nodeKey = elements.nodeSelect.value;
  const selectedNode = findNode(nodeKey);

  if (!selectedNode) {
    setInspectionError(new Error(`COPC hierarchy node was not found: ${nodeKey}`));
    return;
  }

  elements.statusText.textContent = `Reading COPC node ${nodeKey}...`;

  try {
    const pointSamples = await source.loadNodePointSamples({ nodeKey });

    if (source !== currentSource) {
      return;
    }

    const cesiumPoints = createPointSamplesFromCopc(
      pointSamples.points,
      inspection,
    );

    renderer.setPoints(cesiumPoints);
    boundsRenderer.setBounds(selectedNode.bounds, inspection);
    viewer.camera.flyTo({
      destination: cameraTargetForPointCloud(cesiumPoints),
      duration: 0,
    });
    renderInspection(inspection, pointSamples, selectedNode);
    elements.statusText.textContent = `Rendered ${pointSamples.sampledPointCount.toLocaleString()} real COPC points from node ${nodeKey}.`;
    updateSuggestedNode();
    renderRenderSetControls();
  } catch (error) {
    setInspectionError(error);
  }
}

async function renderSelectedNodeSet(): Promise<void> {
  await renderNodeKeySet([...renderNodeSet]);
}

async function renderAutomaticNodeSet(): Promise<void> {
  if (!currentInspection || !currentHierarchy) {
    return;
  }

  const selection = selectHierarchyNodesForCamera(currentHierarchy.nodes, {
    target: cameraPositionToCopc(currentInspection),
    viewportHeightPixels: viewer.scene.canvas.clientHeight,
    maxNodes: 4,
  });

  if (!selection || selection.nodes.length === 0) {
    return;
  }

  renderNodeSet.clear();
  selection.nodes.forEach((node) => renderNodeSet.add(node.key));
  renderRenderSetControls();
  await renderNodeKeySet(
    selection.nodes.map((node) => node.key),
    selection,
  );
}

async function renderNodeKeySet(
  nodeKeys: readonly string[],
  cameraSelection?: CopcHierarchyNodeCameraSelection,
): Promise<void> {
  if (!currentInspection || !currentSource || nodeKeys.length === 0) {
    return;
  }

  const source = currentSource;
  const inspection = currentInspection;
  const nodes = nodeKeys.map(findRequiredNode);
  elements.statusText.textContent = `Reading ${nodeKeys.length.toLocaleString()} COPC nodes...`;

  try {
    const pointSamples = await source.loadNodesPointSamples({ nodeKeys });

    if (source !== currentSource) {
      return;
    }

    const cesiumPoints = createPointSamplesFromCopc(
      pointSamples.points,
      inspection,
    );

    renderer.setPoints(cesiumPoints);
    boundsRenderer.setBoundsList(
      nodes.map((node) => node.bounds),
      inspection,
    );
    viewer.camera.flyTo({
      destination: cameraTargetForPointCloud(cesiumPoints),
      duration: 0,
    });
    renderInspection(
      inspection,
      undefined,
      undefined,
      pointSamples,
      cameraSelection,
    );
    elements.statusText.textContent = cameraSelection
      ? `Auto LOD rendered ${pointSamples.sampledPointCount.toLocaleString()} points from ${pointSamples.nodeKeys.length.toLocaleString()} COPC nodes.`
      : `Rendered ${pointSamples.sampledPointCount.toLocaleString()} points from ${pointSamples.nodeKeys.length.toLocaleString()} COPC nodes.`;
    updateSuggestedNode();
    renderRenderSetControls();
  } catch (error) {
    setInspectionError(error);
  }
}

function updateSuggestedNode(): void {
  currentSuggestion = undefined;

  if (!currentInspection || !currentHierarchy) {
    renderSuggestion(undefined);
    return;
  }

  try {
    currentSuggestion = suggestHierarchyNode(currentHierarchy.nodes, {
      target: cameraPositionToCopc(currentInspection),
    });
    renderSuggestion(currentSuggestion);
  } catch (error) {
    elements.suggestionText.textContent =
      error instanceof Error
        ? `Suggested node unavailable: ${error.message}`
        : "Suggested node unavailable.";
    elements.applySuggestionButton.disabled = true;
  }
}

function cameraPositionToCopc(inspection: CopcInspection): CopcTargetPoint {
  const cartographic = Cartographic.fromCartesian(viewer.camera.positionWC);
  const transform = createCesiumToCopcCoordinateTransform(inspection);

  return transform(
    CesiumMath.toDegrees(cartographic.longitude),
    CesiumMath.toDegrees(cartographic.latitude),
    cartographic.height,
  );
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

function findNode(nodeKey: string): CopcHierarchyNodeSummary | undefined {
  return currentHierarchy?.nodes.find((node) => node.key === nodeKey);
}

function findRequiredNode(nodeKey: string): CopcHierarchyNodeSummary {
  const node = findNode(nodeKey);

  if (!node) {
    throw new Error(`COPC hierarchy node was not found: ${nodeKey}`);
  }

  return node;
}

function addNodeToRenderSet(nodeKey: string): void {
  renderNodeSet.add(nodeKey);
  renderRenderSetControls();
}

function renderRenderSetControls(): void {
  const nodeKeys = [...renderNodeSet];
  const hasNodes = nodeKeys.length > 0;
  const selectedNodeKey = elements.nodeSelect.value;
  const suggestedNodeKey = currentSuggestion?.node.key;

  elements.renderSetText.textContent = hasNodes
    ? `Render set: ${nodeKeys.join(", ")}`
    : "Render set: empty.";
  elements.addSelectedButton.disabled =
    !selectedNodeKey || renderNodeSet.has(selectedNodeKey);
  elements.addSuggestionButton.disabled =
    !suggestedNodeKey || renderNodeSet.has(suggestedNodeKey);
  elements.autoLodButton.disabled = !currentInspection || !currentHierarchy;
  elements.renderSetButton.disabled = !hasNodes;
  elements.clearSetButton.disabled = !hasNodes;
}

function populateNodeSelect(hierarchy: CopcHierarchySummary): void {
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
  elements.nodeSelect.value = hierarchy.nodes[0]?.key ?? "";
}

function getPrototypeElements(): {
  readonly container: HTMLDivElement;
  readonly form: HTMLFormElement;
  readonly urlInput: HTMLInputElement;
  readonly nodeSelect: HTMLSelectElement;
  readonly suggestionText: HTMLParagraphElement;
  readonly applySuggestionButton: HTMLButtonElement;
  readonly renderSetText: HTMLParagraphElement;
  readonly addSelectedButton: HTMLButtonElement;
  readonly addSuggestionButton: HTMLButtonElement;
  readonly autoLodButton: HTMLButtonElement;
  readonly renderSetButton: HTMLButtonElement;
  readonly clearSetButton: HTMLButtonElement;
  readonly statusText: HTMLParagraphElement;
  readonly metadataList: HTMLDListElement;
} {
  const container = document.querySelector<HTMLDivElement>("#cesium-container");
  const form = document.querySelector<HTMLFormElement>("#copc-form");
  const urlInput = document.querySelector<HTMLInputElement>("#copc-url");
  const nodeSelect = document.querySelector<HTMLSelectElement>("#copc-node-select");
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
  const renderSetButton = document.querySelector<HTMLButtonElement>(
    "#copc-render-set-button",
  );
  const clearSetButton = document.querySelector<HTMLButtonElement>("#copc-clear-set");
  const statusText = document.querySelector<HTMLParagraphElement>("#copc-status");
  const metadataList = document.querySelector<HTMLDListElement>("#copc-metadata");

  if (
    !container ||
    !form ||
    !urlInput ||
    !nodeSelect ||
    !suggestionText ||
    !applySuggestionButton ||
    !renderSetText ||
    !addSelectedButton ||
    !addSuggestionButton ||
    !autoLodButton ||
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
    urlInput,
    nodeSelect,
    suggestionText,
    applySuggestionButton,
    renderSetText,
    addSelectedButton,
    addSuggestionButton,
    autoLodButton,
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

function formatCameraSelection(
  selection: CopcHierarchyNodeCameraSelection,
): string {
  return `${selection.nodes.length.toLocaleString()} nodes at depth ${selection.selectedDepth.toLocaleString()} (target depth ${selection.targetDepth.toLocaleString()}, root span ${selection.estimatedRootScreenPixels.toLocaleString(undefined, { maximumFractionDigits: 0 })} px)`;
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
