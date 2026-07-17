import type {
  CopcHierarchyNodeCameraSelection,
  CopcHierarchyNodeSummary,
} from "../core";
import type { CopcCameraStreamDetailProgressState } from "./CopcCameraStreamProgress";
import type { CopcCameraStreamLodSettings } from "./CopcCameraStreamSettings";

export interface CopcCameraStreamDiagnostics {
  readonly expandHierarchyMilliseconds: number;
  readonly applyHierarchyMilliseconds: number;
  readonly selectNodesMilliseconds: number;
  readonly renderNodesMilliseconds: number;
  readonly totalMilliseconds: number;
  readonly loadedHierarchyPageCount: number;
  readonly selectedNodeCount: number;
  readonly selectedDepth: number;
  readonly selectedSourcePointCount: number;
  readonly selectedPointDataLength: number;
}

export interface CopcCameraStreamSourceNodeSummary {
  readonly selectedSourcePointCount: number;
  readonly selectedPointDataLength: number;
}

export interface CopcCameraStreamFormatterOptions {
  readonly formatBytes?: (byteCount: number) => string;
  readonly formatMeters?: (meterCount: number) => string;
  readonly formatMilliseconds?: (millisecondCount: number) => string;
}

export interface CopcCameraStreamLodSummaryOptions
  extends CopcCameraStreamFormatterOptions {
  readonly lodSettings: CopcCameraStreamLodSettings | undefined;
  readonly effectiveSourcePointBudget: number;
  readonly effectiveNodePointBudget: number;
  readonly effectivePointDataLengthBudget: number;
  readonly effectiveNodePointDataLengthBudget: number;
  readonly emptyText?: string;
}

export function summarizeCopcCameraStreamSourceNodes(
  nodes: readonly CopcHierarchyNodeSummary[],
): CopcCameraStreamSourceNodeSummary {
  return {
    selectedSourcePointCount: nodes.reduce(
      (total, node) => total + node.pointCount,
      0,
    ),
    selectedPointDataLength: nodes.reduce(
      (total, node) => total + node.pointDataLength,
      0,
    ),
  };
}

export function formatCopcCameraStreamDiagnostics(
  diagnostics: CopcCameraStreamDiagnostics,
  options: CopcCameraStreamFormatterOptions = {},
): string {
  const formatMilliseconds =
    options.formatMilliseconds ?? formatDefaultMilliseconds;
  const formatBytes = options.formatBytes ?? formatDefaultBytes;

  return `expand ${formatMilliseconds(diagnostics.expandHierarchyMilliseconds)} ms, apply ${formatMilliseconds(diagnostics.applyHierarchyMilliseconds)} ms, select ${formatMilliseconds(diagnostics.selectNodesMilliseconds)} ms, render ${formatMilliseconds(diagnostics.renderNodesMilliseconds)} ms, total ${formatMilliseconds(diagnostics.totalMilliseconds)} ms, ${diagnostics.loadedHierarchyPageCount.toLocaleString()} pages, ${diagnostics.selectedNodeCount.toLocaleString()} nodes, depth ${diagnostics.selectedDepth.toLocaleString()}, source ${diagnostics.selectedSourcePointCount.toLocaleString()} pts / ${formatBytes(diagnostics.selectedPointDataLength)}`;
}

export function formatCopcCameraStreamDetailProgress(
  progress: CopcCameraStreamDetailProgressState | undefined,
): string {
  if (!progress) {
    return "Not streamed yet";
  }

  const weightedCoverageSummary =
    Math.abs(
      progress.renderedFinalNodeWeightCoverageRatio -
        progress.renderedFinalNodeCoverageRatio,
    ) > 0.001
      ? `, ${(progress.renderedFinalNodeWeightCoverageRatio * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}% weighted`
      : "";

  return `${progress.renderedFinalNodeCount.toLocaleString()} / ${progress.finalNodeCount.toLocaleString()} current-view nodes (${(progress.renderedFinalNodeCoverageRatio * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}% coverage${weightedCoverageSummary}${progress.reachedRenderBudget ? ", render budget reached" : ""})`;
}

export function formatCopcCameraStreamLodSummary(
  options: CopcCameraStreamLodSummaryOptions,
): string {
  const lodSettings = options.lodSettings;

  if (!lodSettings) {
    return options.emptyText ?? "Not streamed yet";
  }

  const formatBytes = options.formatBytes ?? formatDefaultBytes;
  const formatMeters = options.formatMeters ?? formatDefaultMeters;
  const sourcePointBudget = formatAdaptivePointBudget(
    options.effectiveSourcePointBudget,
    lodSettings.maxSourcePointCount,
    "source pts",
  );
  const pointDataLengthBudget = formatAdaptiveByteBudget(
    options.effectivePointDataLengthBudget,
    lodSettings.maxPointDataLength,
    "compressed",
    formatBytes,
  );
  const nodePointBudget = formatAdaptivePointBudget(
    options.effectiveNodePointBudget,
    lodSettings.maxNodePointCount,
    "per-node source pts",
  );
  const nodePointDataLengthBudget = formatAdaptiveByteBudget(
    options.effectiveNodePointDataLengthBudget,
    lodSettings.maxNodePointDataLength,
    "per-node",
    formatBytes,
  );

  return `${lodSettings.label}, camera ${formatMeters(
    lodSettings.cameraHeightMeters,
  )}, depth <= ${lodSettings.maxDepth.toLocaleString()}, tile target ${lodSettings.targetNodeScreenPixels.toLocaleString()} px, point spacing ${lodSettings.targetPointSpacingScreenPixels.toLocaleString(undefined, { maximumFractionDigits: 2 })} px, source budget ${sourcePointBudget} / ${nodePointBudget} / ${pointDataLengthBudget} / ${nodePointDataLengthBudget}, up to ${lodSettings.maxNodes.toLocaleString()} nodes`;
}

export function formatCopcHierarchyNodeCameraSelection(
  selection: CopcHierarchyNodeCameraSelection,
): string {
  const modeSummary =
    selection.selectionMode === "coverage"
      ? selection.coverageMode === "mixed-depth"
        ? "mixed-depth coverage"
        : selection.coverageMode === "progressive"
          ? "progressive coverage"
          : "coverage"
      : "nearest";
  const selectedDepths = selection.nodes.map((node) => node.depth);
  const selectedMinDepth =
    selectedDepths.length > 0
      ? Math.min(...selectedDepths)
      : selection.selectedDepth;
  const selectedDepthSummary =
    selectedMinDepth === selection.selectedDepth
      ? `depth ${selection.selectedDepth.toLocaleString()}`
      : `depths ${selectedMinDepth.toLocaleString()}-${selection.selectedDepth.toLocaleString()}`;
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

  return `${selection.nodes.length.toLocaleString()} ${modeSummary} nodes at ${selectedDepthSummary} (target depth ${selection.targetDepth.toLocaleString()}, selected depth ${selection.estimatedSelectedDepthScreenPixels.toLocaleString(undefined, { maximumFractionDigits: 0 })} px / ${selection.targetNodeScreenPixels.toLocaleString(undefined, { maximumFractionDigits: 0 })} px target, root ${selection.estimatedRootScreenPixels.toLocaleString(undefined, { maximumFractionDigits: 0 })} px${spacingSummary}${frustumSummary}${viewSummary}${budgetSummary})`;
}

export function formatCopcLoadedHierarchyPages(
  pageKeys: readonly string[],
): string {
  return pageKeys.length > 0
    ? ` after loading ${pageKeys.length.toLocaleString()} hierarchy pages`
    : "";
}

export function formatCopcCameraStreamFinalNodeMix(
  selectedDetailNodeCount: number,
  finalNodeCount: number,
): string {
  if (selectedDetailNodeCount > 0) {
    return `${selectedDetailNodeCount.toLocaleString()} selected detail nodes for the current view`;
  }

  return `${finalNodeCount.toLocaleString()} coverage nodes for this zoom level`;
}

function formatAdaptivePointBudget(
  effectiveBudget: number,
  maxBudget: number,
  label: string,
): string {
  return effectiveBudget === maxBudget
    ? `${maxBudget.toLocaleString()} ${label}`
    : `${effectiveBudget.toLocaleString()} / ${maxBudget.toLocaleString()} ${label} adaptive`;
}

function formatAdaptiveByteBudget(
  effectiveBudget: number,
  maxBudget: number,
  label: string,
  formatBytes: (byteCount: number) => string,
): string {
  return effectiveBudget === maxBudget
    ? `${formatBytes(maxBudget)} ${label}`
    : `${formatBytes(effectiveBudget)} / ${formatBytes(maxBudget)} ${label} adaptive`;
}

function formatDefaultBytes(byteCount: number): string {
  if (byteCount < 1024) {
    return `${byteCount.toLocaleString()} B`;
  }

  return `${(byteCount / 1024).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })} KB`;
}

function formatDefaultMeters(meterCount: number): string {
  return `${meterCount.toLocaleString(undefined, {
    maximumFractionDigits: 0,
  })} m`;
}

function formatDefaultMilliseconds(millisecondCount: number): string {
  return millisecondCount.toLocaleString(undefined, {
    maximumFractionDigits: 1,
  });
}
