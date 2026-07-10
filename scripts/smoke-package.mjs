import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outputRoot = path.join(repoRoot, "output");
const smokeRoot = path.join(outputRoot, "package-smoke");
const consumerRoot = path.join(smokeRoot, "consumer");
const isWindows = process.platform === "win32";
const npmCommand = "npm";
const npxCommand = "npx";
const MAX_PACKAGE_TARBALL_BYTES = 600 * 1024;
const MAX_PACKED_WORKER_ASSET_BYTES = 600 * 1024;

function assertInside(parent, target) {
  const relative = path.relative(parent, target);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to operate outside ${parent}: ${target}`);
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    shell: isWindows,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function runCapture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: isWindows,
    stdio: ["ignore", "pipe", "inherit"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }

  return result.stdout;
}

function toFileDependency(filePath) {
  return `file:${filePath.replaceAll("\\", "/")}`;
}

await mkdir(outputRoot, { recursive: true });
assertInside(outputRoot, smokeRoot);
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(path.join(consumerRoot, "src"), { recursive: true });

console.log("Building library and example...");
run(npmCommand, ["run", "build"], repoRoot);

console.log("Packing local package...");
const packOutput = runCapture(
  npmCommand,
  ["pack", "--json", "--ignore-scripts", "--pack-destination", smokeRoot],
  repoRoot,
);
const [packResult] = JSON.parse(packOutput);
const tarballName = packResult?.filename;

if (!tarballName) {
  throw new Error("npm pack did not return a tarball name.");
}

const packedPaths = new Set(
  packResult.files.map((entry) => entry.path),
);

for (const requiredPath of [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "docs/API.md",
  "docs/ARCHITECTURE.md",
  "docs/COMPETITION.md",
  "docs/PERFORMANCE.md",
  "examples/minimal-layer.ts",
]) {
  if (!packedPaths.has(requiredPath)) {
    throw new Error(`Packed package is missing ${requiredPath}.`);
  }
}

if (packResult.size > MAX_PACKAGE_TARBALL_BYTES) {
  throw new Error(
    `Packed package is ${packResult.size.toLocaleString()} bytes; expected at most ${MAX_PACKAGE_TARBALL_BYTES.toLocaleString()} bytes.`,
  );
}

const oversizedWorkerAsset = packResult.files.find(
  (entry) =>
    entry.path.includes("/assets/") &&
    entry.path.includes("Worker-") &&
    entry.path.endsWith(".js") &&
    entry.size > MAX_PACKED_WORKER_ASSET_BYTES,
);

if (oversizedWorkerAsset) {
  throw new Error(
    `Packed worker asset ${oversizedWorkerAsset.path} is ${oversizedWorkerAsset.size.toLocaleString()} bytes; expected at most ${MAX_PACKED_WORKER_ASSET_BYTES.toLocaleString()} bytes.`,
  );
}

if ([...packedPaths].some((filePath) => filePath.endsWith(".d.ts.map"))) {
  throw new Error(
    "Packed package contains declaration maps without packaged TypeScript sources.",
  );
}

const tarballPath = path.join(smokeRoot, tarballName);

if (!existsSync(tarballPath)) {
  throw new Error(`Packed tarball was not created: ${tarballPath}`);
}

await writeFile(
  path.join(consumerRoot, "package.json"),
  `${JSON.stringify(
    {
      private: true,
      type: "module",
      scripts: {
        build: "vite build",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        "copc-cesium": toFileDependency(tarballPath),
      },
      devDependencies: {
        typescript: "^5.9.3",
        vite: "^7.2.7",
      },
      allowScripts: {
        "esbuild@0.28.1": true,
      },
    },
    null,
    2,
  )}\n`,
);

await writeFile(
  path.join(consumerRoot, "tsconfig.json"),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        useDefineForClassFields: true,
        module: "ESNext",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        skipLibCheck: true,
        moduleResolution: "Bundler",
        allowSyntheticDefaultImports: true,
        isolatedModules: true,
        moduleDetection: "force",
        noEmit: true,
        strict: true,
      },
      include: ["src"],
    },
    null,
    2,
  )}\n`,
);

await writeFile(
  path.join(consumerRoot, "index.html"),
  `<div id="app"></div><script type="module" src="/src/main.ts"></script>\n`,
);

await writeFile(
  path.join(consumerRoot, "src", "main.ts"),
  `import {
  CopcPointCloudCameraStream,
  CopcPointCloudLayer,
  CopcCameraStreamNodeSampleCache,
  CopcCameraStreamPrefetchController,
  CopcCameraStreamRequestController,
  createCopcCameraStreamEffectiveBudget,
  createCopcWorkerPoolSettings,
  createCopcCameraStreamCoverageNodeKeys,
  createCopcCameraStreamFinalNodeKeys,
  createCopcCameraStreamDetailProgressState,
  createCopcCameraStreamLodSettings,
  createCopcCameraStreamPrefetchPlan,
  createCopcCameraStreamPrefetchNodeKeys,
  createCopcCameraStreamPrefetchSelectionPlan,
  createCopcCameraStreamPreviewNodeKeys,
  createCopcCameraStreamPrefetchSettings,
  createCopcCameraStreamRenderPlan,
  createCopcCameraStreamRenderNodeKeys,
  createDefaultCopcCoordinateTransforms,
  createProj4CoordinateTransforms,
  estimateCopcNodeFamilyOverlapRatio,
  formatCopcCameraStreamBudgetSummary,
  formatCopcCameraStreamDiagnostics,
  formatCopcCameraStreamDetailProgress,
  formatCopcCameraStreamFinalNodeMix,
  formatCopcCameraStreamLodSummary,
  formatCopcHierarchyNodeCameraSelection,
  formatCopcLoadedHierarchyPages,
  hasFreshCopcCameraStreamNodeSamples,
  maxCopcNodeKeyDepth,
  mergeCopcCameraStreamNodeSamples,
  orderCopcCameraStreamNodeKeysForProgressiveCoverage,
  selectCopcCameraStreamDetailProgressPolicy,
  selectCopcCameraStreamDetailWarmupPolicy,
  selectCopcCameraStreamRequestPriorityOffsets,
  selectHierarchyPagesForTarget,
  shouldCompleteCopcCameraStreamDetailProgress,
  shouldReuseCopcCameraStreamNodeKeys,
  summarizeCopcCameraStreamSourceNodes,
  updateCopcCameraStreamAdaptiveBudget,
  type CopcCameraStreamAdaptiveBudgetState,
  type CopcCameraStreamBudgetLimits,
  type CopcCameraStreamDetailProgressPolicy,
  type CopcCameraStreamDetailWarmupPolicy,
  type CopcCameraStreamDiagnostics,
  type CopcCameraStreamLodQualitySettings,
  type CopcCameraStreamLodSettings,
  type CopcCameraStreamNodeSampleLike,
  type CopcCameraStreamNodeSummaryLike,
  type CopcCameraStreamPrefetchSettings,
  type CopcCameraStreamTimeoutScheduler,
  type CopcWorkerPoolSettings,
  type CopcHierarchyNodeCameraSelection,
  type CopcHierarchyNodeDepthEstimate,
  type CopcPointCloudLayerCameraSelectionOptions,
  type CopcCoordinateTransformStatus,
  type CopcHierarchyPageReference,
  type CopcHierarchyPageTargetSelection,
  type CopcInspection,
  type CopcPointCloudLayerOptions,
  type CopcPointCloudLayerHierarchyExpansionOptions,
  type CopcPointCloudLayerRenderStats,
} from "copc-cesium";
import {
  CopcSource,
  createCopcPointSampleWorker,
  type CopcHierarchyCacheStats,
  type CopcHierarchyNodeSelectionMode,
  type LoadNodePointSamplesOptions,
  type CopcPointSampleLoadingMode,
  type CopcPointSampleCacheStats,
  type CopcTargetVector,
  type CopcSourceInput,
  type CopcSourceOptions,
} from "copc-cesium/core";
import {
  CesiumBufferPointRenderer,
  CesiumPointPrimitiveRenderer,
  CesiumPointRenderer,
  CesiumPrimitivePointRenderer,
  type CesiumBufferPointRendererOptions,
  type CesiumPointPrimitiveRendererOptions,
  type CesiumPrimitivePointRendererOptions,
  type CopcPointCloudRendererFactory,
} from "copc-cesium/cesium";

const exportedConstructors = [
  CopcPointCloudCameraStream,
  CopcPointCloudLayer,
  CopcCameraStreamNodeSampleCache,
  CopcCameraStreamPrefetchController,
  CopcCameraStreamRequestController,
  createCopcWorkerPoolSettings,
  CopcSource,
  CesiumBufferPointRenderer,
  CesiumPointRenderer,
  CesiumPointPrimitiveRenderer,
  CesiumPrimitivePointRenderer,
  createDefaultCopcCoordinateTransforms,
  createProj4CoordinateTransforms,
  createCopcCameraStreamEffectiveBudget,
  createCopcCameraStreamCoverageNodeKeys,
  createCopcCameraStreamDetailProgressState,
  createCopcCameraStreamFinalNodeKeys,
  createCopcCameraStreamLodSettings,
  createCopcCameraStreamPrefetchPlan,
  createCopcCameraStreamPrefetchNodeKeys,
  createCopcCameraStreamPrefetchSelectionPlan,
  createCopcCameraStreamRenderPlan,
  createCopcCameraStreamPreviewNodeKeys,
  createCopcCameraStreamPrefetchSettings,
  createCopcCameraStreamRenderNodeKeys,
  estimateCopcNodeFamilyOverlapRatio,
  formatCopcCameraStreamBudgetSummary,
  formatCopcCameraStreamDiagnostics,
  formatCopcCameraStreamDetailProgress,
  formatCopcCameraStreamFinalNodeMix,
  formatCopcCameraStreamLodSummary,
  formatCopcHierarchyNodeCameraSelection,
  formatCopcLoadedHierarchyPages,
  maxCopcNodeKeyDepth,
  orderCopcCameraStreamNodeKeysForProgressiveCoverage,
  selectCopcCameraStreamDetailProgressPolicy,
  selectCopcCameraStreamDetailWarmupPolicy,
  selectCopcCameraStreamRequestPriorityOffsets,
  shouldCompleteCopcCameraStreamDetailProgress,
  summarizeCopcCameraStreamSourceNodes,
  updateCopcCameraStreamAdaptiveBudget,
  createCopcPointSampleWorker,
  selectHierarchyPagesForTarget,
  shouldReuseCopcCameraStreamNodeKeys,
] as const;
const pointSampleLoadingMode: CopcPointSampleLoadingMode = "worker";
const inspection: CopcInspection | undefined = undefined;
const transformStatus: CopcCoordinateTransformStatus | undefined = undefined;
const hierarchyCacheStats: CopcHierarchyCacheStats = {
  loadedPageCount: 1,
  maxCachedPageCount: 3,
  loadedPageBytes: 512,
  maxCachedPageBytes: 1024,
  pendingPageCount: 0,
  trackedNodeCount: 1,
  trackedPendingPageCount: 0,
  cacheEvictionCount: 0,
  isOverLimit: false,
};
const cacheStats: CopcPointSampleCacheStats | undefined = undefined;
const sourceOptions: CopcSourceOptions = {
  maxCachedHierarchyPages: 3,
  maxCachedHierarchyPageBytes: 1024,
  maxCachedSampleSets: 2,
  maxCachedPointSampleBytes: 1024,
  maxConcurrentPointSampleWorkerRequests: 2,
  pointSampleLoading: pointSampleLoadingMode,
};
const nodeSampleOptions: LoadNodePointSamplesOptions = {
  nodeKey: "0-0-0-0",
  signal: new AbortController().signal,
};
const viewDirection: CopcTargetVector = { x: 1, y: 0, z: 0 };
const selectionMode: CopcHierarchyNodeSelectionMode = "coverage";
const pointRendererFactory: CopcPointCloudRendererFactory = () => ({
  setPoints: () => undefined,
  clear: () => undefined,
  destroy: () => undefined,
});
const primitiveRendererOptions: CesiumPointPrimitiveRendererOptions = {
  pixelSize: 3,
  outlineWidth: 0,
};
const bufferRendererOptions: CesiumBufferPointRendererOptions = {
  pointSize: 3,
  outlineWidth: 0,
};
const primitiveTypedArrayRendererOptions: CesiumPrimitivePointRendererOptions = {
  pointSize: 3,
};
const streamQualitySettings: CopcCameraStreamLodQualitySettings = {
  cameraStreamMaxRenderedPointCount: 360_000,
  cameraStreamMaxSourcePointCount: 900_000,
  cameraStreamMaxNodePointCount: 80_000,
  cameraStreamMaxPointDataLength: 16 * 1024 * 1024,
  cameraStreamMaxNodePointDataLength: 2 * 1024 * 1024,
  cameraStreamMaxNodes: 96,
  cameraStreamMaxDepth: 5,
  cameraStreamTargetNodeScreenPixels: 80,
  cameraStreamTargetPointSpacingScreenPixels: 4,
};
const streamLodSettings: CopcCameraStreamLodSettings =
  createCopcCameraStreamLodSettings({
    cameraHeightMeters: 300,
    qualitySettings: streamQualitySettings,
  });
const streamBudgetLimits: CopcCameraStreamBudgetLimits = {
  maxRenderedPointCount: streamLodSettings.maxRenderedPointCount,
  maxSourcePointCount: streamLodSettings.maxSourcePointCount,
  maxNodePointCount: streamLodSettings.maxNodePointCount,
  maxPointDataLength: streamLodSettings.maxPointDataLength,
  maxNodePointDataLength: streamLodSettings.maxNodePointDataLength,
};
let streamAdaptiveBudgetState: CopcCameraStreamAdaptiveBudgetState = {};
const streamEffectiveBudget = createCopcCameraStreamEffectiveBudget({
  limits: streamBudgetLimits,
  state: streamAdaptiveBudgetState,
});
const streamAdaptiveBudgetUpdate = updateCopcCameraStreamAdaptiveBudget({
  limits: streamBudgetLimits,
  state: streamAdaptiveBudgetState,
  timings: {
    totalMilliseconds: 1_000,
    renderMilliseconds: 3_000,
  },
});
streamAdaptiveBudgetState = streamAdaptiveBudgetUpdate.state;
const streamPrefetchSettings: CopcCameraStreamPrefetchSettings =
  createCopcCameraStreamPrefetchSettings({
    nodeCount: 24,
    basePointCountPerNode: 2_000,
    baseMaxRenderedPointCount: 96_000,
    minPointCountPerNode: 2_500,
    minRenderedPointCount: 24 * 2_500,
    lodSettings: streamLodSettings,
  });
const streamPrefetchSelectionPlan =
  createCopcCameraStreamPrefetchSelectionPlan({
    lodSettings: streamLodSettings,
    maxNodeCount: 24,
    maxNodePointCount: streamLodSettings.maxNodePointCount,
    maxNodePointDataLength: streamLodSettings.maxNodePointDataLength,
    maxTotalPointCount: streamLodSettings.maxSourcePointCount,
    maxTotalPointDataLength: streamLodSettings.maxPointDataLength,
  });
const streamNodes: readonly CopcCameraStreamNodeSummaryLike[] = [
  { key: "2-0-0-0", pointDataLength: 4_000 },
  { key: "2-1-0-0", pointDataLength: 4_000 },
];
const streamRenderNodeKeys = createCopcCameraStreamRenderNodeKeys(streamNodes, {
  nodes: [{ key: "0-0-0-0", pointDataLength: 1_000 }, ...streamNodes],
});
const streamCoverageNodeKeys = createCopcCameraStreamCoverageNodeKeys(
  streamRenderNodeKeys,
  2,
);
const streamFinalNodeKeys = createCopcCameraStreamFinalNodeKeys(
  streamNodes.map((node) => node.key),
  streamCoverageNodeKeys,
);
const streamPreviewNodeKeys = createCopcCameraStreamPreviewNodeKeys(
  streamCoverageNodeKeys,
  { nodes: streamNodes },
  { maxNodeCount: 2, maxPointDataLength: 8_000 },
);
const streamRenderPlan = createCopcCameraStreamRenderPlan({
  cameraSelection: {
    nodes: streamNodes.map((node) => ({
      ...node,
      depth: 2,
      x: 0,
      y: 0,
      z: 0,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
      pointCount: 10_000,
      pointDensity: 10_000,
      pointDataOffset: 0,
    })),
    selectedDepth: 2,
  },
  configuredMaxPointCountPerNode: 20_000,
  effectiveNodePointDataLengthBudget: 2 * 1024 * 1024,
  effectivePointDataLengthBudget: 16 * 1024 * 1024,
  effectiveSourcePointBudget: 900_000,
  hierarchy: { nodes: streamNodes },
  lodSettings: streamLodSettings,
  previewMaxNodeCount: 2,
  previewMaxPointDataLength: 8_000,
  renderedPointBudget: 20_000,
});
const streamOrderedNodeKeys =
  orderCopcCameraStreamNodeKeysForProgressiveCoverage(streamFinalNodeKeys);
const streamNodeFamilyOverlapRatio = estimateCopcNodeFamilyOverlapRatio(
  streamRenderNodeKeys,
  streamFinalNodeKeys,
);
const canReuseStreamNodeKeys = shouldReuseCopcCameraStreamNodeKeys(
  streamRenderNodeKeys,
  streamFinalNodeKeys,
  0.25,
);
const streamMaxDepth = maxCopcNodeKeyDepth(streamFinalNodeKeys);
const streamScheduler: CopcCameraStreamTimeoutScheduler = {
  setTimeout: (callback) => {
    callback();
    return 1;
  },
  clearTimeout: () => undefined,
};
const streamRequestController = new CopcCameraStreamRequestController({
  maxReusedBackgroundRequests: 2,
  minNodeFamilyOverlapRatio: 0.25,
  scheduler: streamScheduler,
});
const streamRequest = streamRequestController.startRequest();
streamRequestController.setActiveNodeKeys(streamFinalNodeKeys);
const streamPrefetchController = new CopcCameraStreamPrefetchController();
const didStartPrefetch = streamPrefetchController.start(async () => undefined);
streamPrefetchController.cancel();
const streamPrefetchNodeKeys = createCopcCameraStreamPrefetchNodeKeys({
  selectedNodeKeys: streamFinalNodeKeys,
  coverageNodeKeys: streamCoverageNodeKeys,
  hasUsableNodeSample: (nodeKey) => nodeKey === "2-0-0-0",
  maxNodeCount: 2,
});
const streamPrefetchPlan = createCopcCameraStreamPrefetchPlan({
  selectedNodeKeys: streamFinalNodeKeys,
  coverageNodeKeys: streamCoverageNodeKeys,
  maxNodeCount: 2,
  basePointCountPerNode: 2_000,
  baseMaxRenderedPointCount: 96_000,
  minPointCountPerNode: streamRenderPlan.maxPointCountPerNode,
  lodSettings: streamLodSettings,
  hasUsableNodeSample: (nodeKey, maxPointCountPerNode) =>
    nodeKey === "2-0-0-0" && maxPointCountPerNode <= 8_000,
});
interface ConsumerNodeSample extends CopcCameraStreamNodeSampleLike {
  readonly source: "consumer";
}
const streamNodeSampleCache =
  new CopcCameraStreamNodeSampleCache<ConsumerNodeSample>({
    maxSampleSetCount: 4,
  });
const streamNodeSamples: readonly ConsumerNodeSample[] = [
  {
    nodeKey: "2-0-0-0",
    nodePointCount: 10_000,
    sampledPointCount: 2_000,
    source: "consumer",
  },
];
streamNodeSampleCache.remember(streamNodeSamples);
const hasFreshStreamNodeSamples = hasFreshCopcCameraStreamNodeSamples(
  ["2-0-0-0"],
  streamNodeSamples,
  2_000,
);
const mergedStreamNodeSamples = mergeCopcCameraStreamNodeSamples(
  streamNodeSamples,
  [
    {
      nodeKey: "2-0-0-0",
      nodePointCount: 10_000,
      sampledPointCount: 4_000,
      source: "consumer",
    },
  ],
);
const streamRequestPriorityOffsets = selectCopcCameraStreamRequestPriorityOffsets();
const streamDetailProgressPolicy: CopcCameraStreamDetailProgressPolicy =
  selectCopcCameraStreamDetailProgressPolicy({
    finalNodeKeys: streamFinalNodeKeys,
    initialNodeResults: streamNodeSamples,
    rendererKind: "typed",
    fastRendererProgressBatchNodeCount: 1,
    pointPrimitiveProgressBatchNodeCount: 4,
    minInitialPointCount: 2_000,
  });
const streamDetailWarmupPolicy: CopcCameraStreamDetailWarmupPolicy =
  selectCopcCameraStreamDetailWarmupPolicy({
    finalNodeKeys: streamFinalNodeKeys,
    initialNodeResults: streamNodeSamples,
    detailMaxPointCountPerNode: 6_000,
    warmupPointCountPerNode: 2_000,
  });
const didCompleteStreamDetailProgress =
  shouldCompleteCopcCameraStreamDetailProgress({
    finalNodeCount: streamFinalNodeKeys.length,
    renderedFinalNodeCount: streamFinalNodeKeys.length - 1,
    renderedPointBudget: 20_000,
    renderedPointCount: 18_000,
  });
const streamDetailProgress = createCopcCameraStreamDetailProgressState({
  finalNodeKeys: streamFinalNodeKeys,
  renderedNodeKeys: streamFinalNodeKeys.slice(0, -1),
  renderedPointBudget: 20_000,
  renderedPointCount: 18_000,
});
const streamDetailProgressSummary =
  formatCopcCameraStreamDetailProgress(streamDetailProgress);
const streamBudgetSummary = formatCopcCameraStreamBudgetSummary({
  configuredRenderedPointBudget: 20_000,
  effectiveRenderedPointBudget: 20_000,
  effectiveSourcePointBudget: 900_000,
  maxSourcePointBudget: 900_000,
  effectiveNodePointBudget: 80_000,
  maxNodePointBudget: 80_000,
  effectivePointDataLengthBudget: 16 * 1024 * 1024,
  maxPointDataLengthBudget: 16 * 1024 * 1024,
  effectiveNodePointDataLengthBudget: 2 * 1024 * 1024,
  maxNodePointDataLengthBudget: 2 * 1024 * 1024,
  lastRenderedPointBudget: 19_892,
  formatBytes: (byteCount) => \`\${byteCount.toLocaleString()} B\`,
});
const workerPoolSettings: CopcWorkerPoolSettings =
  createCopcWorkerPoolSettings({
    hardwareConcurrency: 8,
  });
const streamDiagnostics: CopcCameraStreamDiagnostics = {
  expandHierarchyMilliseconds: 0,
  applyHierarchyMilliseconds: 0,
  selectNodesMilliseconds: 1,
  renderNodesMilliseconds: 2,
  totalMilliseconds: 3,
  loadedHierarchyPageCount: 1,
  selectedNodeCount: 2,
  selectedDepth: 2,
  selectedSourcePointCount: 3_000,
  selectedPointDataLength: 4_000,
};
const streamDiagnosticsText =
  formatCopcCameraStreamDiagnostics(streamDiagnostics);
const streamLodText = formatCopcCameraStreamLodSummary({
  lodSettings: streamLodSettings,
  effectiveSourcePointBudget: streamLodSettings.maxSourcePointCount,
  effectiveNodePointBudget: streamLodSettings.maxNodePointCount,
  effectivePointDataLengthBudget: streamLodSettings.maxPointDataLength,
  effectiveNodePointDataLengthBudget: streamLodSettings.maxNodePointDataLength,
});
const streamPageText = formatCopcLoadedHierarchyPages(["0"]);
const streamNodeMixText = formatCopcCameraStreamFinalNodeMix(1, 2);
const streamCameraSelectionText = formatCopcHierarchyNodeCameraSelection({
  nodes: [],
  targetDepth: 2,
  selectedDepth: 1,
  selectionMode: "coverage",
  coverageMode: "progressive",
  estimatedRootScreenPixels: 100,
  estimatedSelectedDepthScreenPixels: 50,
  targetNodeScreenPixels: 80,
  estimatedSelectedDepthPointSpacingScreenPixels: undefined,
  targetPointSpacingScreenPixels: undefined,
  maxViewAngleDegrees: undefined,
  spacing: undefined,
  depthEstimates: [],
  skippedByFrustumCount: 0,
  skippedByViewCount: 0,
  skippedByBudgetCount: 0,
  reason: "consumer",
});
const streamSourceSummary = summarizeCopcCameraStreamSourceNodes([]);
const createSource = (): CopcSource =>
  new CopcSource("https://example.com/sample.copc.laz", sourceOptions);
const blobSourceInput: CopcSourceInput = new Blob([
  new Uint8Array([1, 2, 3, 4]),
]);
const createBlobSource = (): CopcSource =>
  new CopcSource(blobSourceInput, sourceOptions);
const layerOptionsWithBlobSource: CopcPointCloudLayerOptions = {
  source: blobSourceInput,
  createPointRenderer: pointRendererFactory,
};
const depthEstimate: CopcHierarchyNodeDepthEstimate | undefined = undefined;
const hierarchyPage: CopcHierarchyPageReference | undefined = undefined;
const pageSelection: CopcHierarchyPageTargetSelection | undefined = undefined;
const hierarchyExpansionOptions:
  | CopcPointCloudLayerHierarchyExpansionOptions
  | undefined = undefined;
const cameraSelectionOptions:
  | CopcPointCloudLayerCameraSelectionOptions
  | undefined = {
    camera: {} as CopcPointCloudLayerCameraSelectionOptions["camera"],
    maxViewAngleDegrees: 80,
  };
const cameraSelectionStats:
  | Pick<
      CopcHierarchyNodeCameraSelection,
      "selectionMode" | "skippedByFrustumCount" | "skippedByViewCount"
    >
  | undefined = undefined;
const renderStats: CopcPointCloudLayerRenderStats = {
  pointCount: 1,
  estimatedRenderPayloadBytes: 28,
  coordinateTransformMilliseconds: 0,
  rendererSetPointsMilliseconds: 0,
  boundsRenderMilliseconds: 0,
  totalRenderMilliseconds: 0,
};
const app = document.querySelector<HTMLDivElement>("#app");

if (app) {
  app.textContent = [
    exportedConstructors.map((constructor) => constructor.name).join(", "),
    String(Boolean(createSource)),
    String(Boolean(createBlobSource)),
    String(Boolean(layerOptionsWithBlobSource.source)),
    pointSampleLoadingMode,
    String(sourceOptions.maxCachedHierarchyPages),
    String(sourceOptions.maxCachedHierarchyPageBytes),
    String(sourceOptions.maxCachedSampleSets),
    String(sourceOptions.maxCachedPointSampleBytes),
    String(sourceOptions.maxConcurrentPointSampleWorkerRequests),
    String(Boolean(nodeSampleOptions.signal)),
    String(Boolean(viewDirection)),
    selectionMode,
    String(Boolean(pointRendererFactory)),
    String(Boolean(depthEstimate)),
    String(Boolean(inspection)),
    String(Boolean(transformStatus)),
    String(hierarchyCacheStats.cacheEvictionCount),
    String(hierarchyCacheStats.loadedPageBytes),
    String(Boolean(cacheStats)),
    String(Boolean(hierarchyPage)),
    String(Boolean(pageSelection)),
    String(Boolean(hierarchyExpansionOptions)),
    String(Boolean(cameraSelectionOptions)),
    String(Boolean(cameraSelectionStats)),
    String(renderStats.estimatedRenderPayloadBytes),
    String(primitiveRendererOptions.pixelSize),
    String(bufferRendererOptions.pointSize),
    String(primitiveTypedArrayRendererOptions.pointSize),
    streamLodSettings.label,
    String(streamEffectiveBudget.renderedPointCount),
    streamAdaptiveBudgetUpdate.action,
    String(streamAdaptiveBudgetState.renderedPointBudget),
    String(streamPrefetchSettings.maxPointCountPerNode),
    String(streamPrefetchSettings.maxRenderedPointCount),
    String(streamPrefetchSelectionPlan.maxDepth),
    String(streamPrefetchSelectionPlan.targetPointSpacingScreenPixels),
    streamRenderNodeKeys.join(","),
    streamCoverageNodeKeys.join(","),
    streamFinalNodeKeys.join(","),
    streamPreviewNodeKeys.join(","),
    streamRenderPlan.renderSignature,
    streamOrderedNodeKeys.join(","),
    String(streamNodeFamilyOverlapRatio),
    String(canReuseStreamNodeKeys),
    String(streamMaxDepth),
    String(streamRequest.requestId),
    String(didStartPrefetch),
    streamPrefetchNodeKeys.join(","),
    String(streamPrefetchPlan.shouldPrefetch),
    String(streamPrefetchPlan.maxPointCountPerNode),
    String(streamNodeSampleCache.size),
    String(hasFreshStreamNodeSamples),
    String(mergedStreamNodeSamples[0]?.sampledPointCount),
    String(streamRequestPriorityOffsets.preview),
    String(streamDetailProgressPolicy.progressBatchNodeCount),
    String(streamDetailWarmupPolicy.maxRenderedPointCount),
    String(didCompleteStreamDetailProgress),
    streamDetailProgressSummary,
    streamBudgetSummary,
    String(workerPoolSettings.pointGeometryWorkerConcurrency),
    streamDiagnosticsText,
    streamLodText,
    streamPageText,
    streamNodeMixText,
    streamCameraSelectionText,
    String(streamSourceSummary.selectedSourcePointCount),
  ].join(" | ");
}
`,
);

console.log("Installing packed package into temporary consumer...");
run(npmCommand, ["install"], consumerRoot);

console.log("Type-checking temporary consumer...");
run(npxCommand, ["tsc", "--noEmit"], consumerRoot);

console.log("Building temporary consumer...");
run(npxCommand, ["vite", "build"], consumerRoot);

console.log(`Package smoke test passed: ${tarballPath}`);
