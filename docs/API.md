# API

`copc-cesium` is a pre-1.0 ESM package. Version `0.1.0` establishes the first
package-consumer-verified API baseline; minor releases may still refine public
types while the library is below 1.0.

The main integration point is `CopcPointCloudLayer`. It opens a COPC URL or
browser `File`/`Blob`, loads metadata and hierarchy information, reads selected
point-data nodes, maps COPC coordinates into Cesium coordinates, and submits
sampled points to a Cesium-native renderer.

## Entry Points

```ts
import { CopcPointCloudLayer } from "copc-cesium";
import { CopcSource } from "copc-cesium/core";
import { CesiumPrimitivePointRenderer } from "copc-cesium/cesium";
```

- `copc-cesium` exports both core and Cesium-facing APIs.
- `copc-cesium/core` exports COPC loading, hierarchy, cache, and point-sample
  helpers without Cesium-specific imports.
- `copc-cesium/cesium` exports Cesium layer, renderer, bounds, and coordinate
  transform helpers.

Core range helpers are also exported for integrations that need to compose their
own source layer:

```ts
import {
  createCachedRangeGetter,
  createCopcRangeGetter,
  createHttpRangeGetter,
} from "copc-cesium/core";
```

`createCopcRangeGetter()` accepts URL strings and browser `Blob`/`File` values.
A remote HTTP source must honor exact byte ranges with `206 Partial Content`.
Cross-origin hosts must permit the viewer origin and the `Range` request header
through CORS. A browser-selected `File`/`Blob` avoids network and CORS
requirements while preserving the same getter contract.
It wraps exact byte-range reads with a small in-memory cache, so duplicate
metadata, hierarchy, or point-data requests can share an in-flight read and
later receive copied cached bytes without mutating the retained cache entry.

## Minimal Cesium Usage

```ts
import { Viewer } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import {
  CesiumPrimitivePointRenderer,
  CopcPointCloudLayer,
} from "copc-cesium";

const viewer = new Viewer("cesium-container");

const layer = new CopcPointCloudLayer(viewer.scene, {
  url: "https://example.com/point-cloud.copc.laz",
  maxPointCountPerNode: 5_000,
  pointSampleLoading: "worker",
  createPointRenderer: (scene) => new CesiumPrimitivePointRenderer(scene),
});

const { hierarchy, coordinateTransform } = await layer.load();
console.log(coordinateTransform.label);

const firstNode = hierarchy.nodes[0];

if (firstNode) {
  const result = await layer.renderNode(firstNode.key);
  console.log(result.renderStats.pointCount);
}
```

For a browser file picker, use `source`:

```ts
const file = fileInput.files?.[0];

if (file) {
  const layer = new CopcPointCloudLayer(viewer.scene, {
    source: file,
    pointSampleLoading: "worker",
  });

  await layer.load();
}
```

A type-checked integration slice is available at
[`examples/minimal-layer.ts`](../examples/minimal-layer.ts). The full browser
demo remains [`examples/basic-viewer`](../examples/basic-viewer).

## CopcPointCloudLayer

```ts
const layer = new CopcPointCloudLayer(scene, options);
```

`scene` is a Cesium `Scene`. Pass either `options.url` for a COPC file that is
readable by browser HTTP range requests, or `options.source` for a browser
`File`/`Blob`.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `url` | required unless `source` is set | COPC file URL readable by browser HTTP range requests. |
| `source` | required unless `url` is set | COPC input as a URL string, browser `File`, or `Blob`. Use this for local file picker flows. |
| `maxPointCountPerNode` | `5_000` inside lower-level point sampling | Default sample budget for each rendered hierarchy node. |
| `maxCachedHierarchyPages` | `64` | Loaded hierarchy page cache limit. |
| `maxCachedHierarchyPageBytes` | `16 * 1024 * 1024` | Estimated loaded hierarchy page byte limit. Loaded non-root leaf hierarchy pages are evicted back to pending references when either the page-count or byte limit is exceeded. |
| `maxCachedSampleSets` | `32` | Point sample cache entry limit. |
| `maxCachedPointSampleBytes` | `32 * 1024 * 1024` | Estimated decoded point sample cache byte limit. |
| `maxCachedPointGeometryBatches` | `96` | Integrated COPC geometry batch cache limit for worker-prepared Cesium payloads. |
| `maxCachedTransformedPointGeometryBatches` | `96` | Cache limit for transformed point geometry batches produced from decoded node samples. |
| `maxDecodedPointDataViewsPerWorker` | `48` in each worker | Decoded COPC point-data view count retained inside point-sample and integrated geometry workers. Raising this can speed repeated visits or density upgrades at higher memory cost. |
| `maxDecodedPointDataViewBytesPerWorker` | `192 * 1024 * 1024` in each worker | Estimated decoded point-data bytes retained inside each point-sample or integrated geometry worker. |
| `pointSampleLoading` | `"main-thread"` unless a worker factory is provided | Use `"worker"` to move point-data reads and LAZ decoding into a Web Worker. |
| `pointGeometryLoading` | `"main-thread"` | Use `"worker"` for point-data-to-Cesium geometry conversion workers or `"integrated-worker"` to combine COPC node reads, sampling, and Cesium geometry preparation in one worker path. |
| `maxConcurrentPointSampleWorkerRequests` | `3` | Backpressure limit for point sample worker requests. |
| `maxConcurrentPointGeometryWorkerRequests` | `2` | Backpressure limit for geometry worker requests. |
| `activePointGeometryWorkerCancellation` | `"soft"` | `"soft"` preserves an active integrated worker and lets stale work finish; `"terminate-uncached"` terminates only active workers that have not retained decoded node data, while soft-canceling cache-owning workers so repeated zoom/pan work can reuse decompressed COPC nodes; `"terminate"` always stops the active worker so queued current-view work can start sooner, at the cost of dropping that worker's decoded cache. |
| `decodedNodeWorkerFallbackDelayMilliseconds` | `Number.POSITIVE_INFINITY` | How long an integrated geometry request waits for the worker that last decoded the same node before using another idle worker. The default keeps strict decoded-cache affinity to avoid decompressing the same node on multiple workers; set `0` only for latency-first experiments after benchmarking the target dataset. |
| `createPointSampleWorker` | built-in worker factory | Custom worker factory for applications with their own bundling strategy. |
| `createPointGeometryWorker` | built-in worker factory | Custom worker factory for non-integrated point geometry workers. |
| `createCopcPointGeometryWorker` | built-in worker factory | Custom worker factory for integrated COPC point geometry workers. |
| `createPointRenderer` | `CesiumPrimitivePointRenderer` | Renderer factory implementing `CopcPointCloudRenderer`. |
| `showBounds` | `true` | Whether render calls draw debug hierarchy bounds by default. |
| `coordinateTransforms` | `createDefaultCopcCoordinateTransforms` | Factory that maps COPC source XYZ to Cesium longitude, latitude, and height. |

### Load

```ts
const loadResult = await layer.load();
```

`load()` opens the COPC source, reads metadata, loads the root hierarchy page,
and prepares coordinate transform status.

Returns:

- `inspection`: COPC metadata, bounds, scale, offset, VLRs, WKT, and point
  count summary.
- `hierarchy`: currently loaded hierarchy nodes and pending hierarchy pages.
- `coordinateTransform`: transform label, kind, and whether camera-based
  selection can run.

### Render One Node

```ts
const result = await layer.renderNode("0-0-0-0", {
  maxPointCount: 10_000,
  requestPriority: 10,
  showBounds: true,
});
```

`renderNode()` reads point samples for one hierarchy node, converts them to
Cesium coordinates, sends them to the active point renderer, and optionally
draws the node bounds.

### Render Multiple Nodes

```ts
const result = await layer.renderNodes(["0-0-0-0", "0-0-0-1"], {
  maxPointCountPerNode: 5_000,
  maxRenderedPointCount: 8_000,
  requestPriority: 10,
});
```

`renderNodes()` deduplicates node keys, reads each selected node, and renders
one combined point set. `maxRenderedPointCount` caps the total sampled points
submitted to Cesium across all selected nodes, which helps camera-driven
rendering avoid sudden point-count spikes.

`renderNodesProgressively()` accepts `initialNodeResults` and
`backgroundNodeResults` for camera-stream style refinement. Lower-density
initial results for the same target nodes can be rendered immediately, then
replaced as denser node results finish. It also accepts
`shouldStopAfterProgress`, which lets a camera stream stop the current
progressive render after the visible point budget or detail-node coverage is
good enough. When this callback returns `true`, still-pending node loads for
that progressive render are aborted instead of letting slow tail nodes hold the
visible update open.

Set `continueLoadingAfterStop: true` when the foreground response should be
considered complete, but already queued target nodes should keep loading and
eventually replace the scene with denser current-view detail. By default the
returned Promise still waits for that post-stop loading to finish. Set
`postStopLoadingMode: "background"` when the Promise should resolve as soon as
the stop condition is reached while the remaining queued work continues only as
cache-warming background work. This is useful for camera streaming: panning away
still aborts the parent render signal, while staying on the same view lets
worker caches and Cesium geometry fill in without blocking the first "rendered"
status.
Set `postStopProgressMode: "load-only"` with `continueLoadingAfterStop` when
the queued tail work should warm COPC/geometry caches without submitting another
Cesium render during the same foreground camera update. This keeps camera moves
smoother while still making the same or nearby view cheaper to refine later.
Set `nodeRequestOrder` when the rendered node order should stay spatially
stable but worker requests should use a different loading priority and active
progressive request order. The
available orders are:

| Value | Request priority |
| --- | --- |
| `"selection"` | Use the selected node order. This is the default and keeps request priority aligned with the caller's spatial plan. |
| `"lightweight-first"` | Request smaller compressed chunks first. This is useful for low-density warmup or custom prefetch flows. |
| `"source-points-first"` | Request source-point-heavy nodes first, using smaller compressed chunks first when source counts tie. This is useful for explicit density-first refinement, but camera-stream defaults can prefer `"selection"` to keep first-pass coverage spatially distributed. |

Set `maxActiveProgressiveNodeRequests` when a camera stream should keep only a
bounded number of missing detail nodes active at a time. This reduces worker
queue pressure and makes off-screen cancellation cheaper when the camera moves
again. If `postStopLoadingMode: "background"` is also set, only the already
active tail requests continue after the foreground stop condition; not-yet-active
tail nodes are left for later prefetch or the next camera update.

When an application keeps retained `CopcNodePointSampleResult` values between
camera updates, call `layer.canRenderNodeSampleResult(nodeResult)` before
treating a retained result as immediately reusable. Transfer-only results from
the integrated worker path are only directly renderable while their prepared
geometry batch is still cached; otherwise the layer should reload that node.
When rendering retained samples directly with `renderNodeSampleResults()`, pass
`maxPointCountPerNode` and `maxRenderedPointCount` to keep cached high-density
results inside the same current-view budget used by `renderNodes()` and
`renderNodesProgressively()`.

### Prepare Nodes

```ts
await layer.prepareNodes(["2-3-1-0", "2-3-2-0"], {
  maxPointCountPerNode: 4_000,
  maxRenderedPointCount: 32_000,
  requestPriority: -100,
});
```

`prepareNodes()` reads selected nodes without changing the current Cesium
rendered point set. When `pointGeometryLoading: "integrated-worker"` is active,
it fills the same worker-prepared geometry cache used by `renderNodes()` and
`renderNodesProgressively()`, which is useful for camera-stream prefetching.

For larger background prefetches, use `prepareNodesProgressively()` to observe
completed nodes before the whole prefetch finishes:

```ts
await layer.prepareNodesProgressively(["3-4-1-0", "3-4-2-0"], {
  maxPointCountPerNode: 2_000,
  maxActiveProgressiveNodeRequests: 2,
  progressBatchNodeCount: 1,
  requestPriority: -100,
  onProgress: (result) => {
    cachePreparedNodeSamples(result.pointSamples.nodeResults);
  },
});
```

This keeps the rendered scene unchanged, but lets an application retain partial
prefetch results immediately. In a camera-driven viewer, that means a later
zoom or pan can reuse whichever nodes finished before the prefetch was
superseded. `maxActiveProgressiveNodeRequests` keeps large prepare jobs from
filling the integrated geometry worker queue all at once, which leaves room for
newer current-view requests to dispatch first.

`requestPriority` is optional and affects queued integrated geometry worker
requests and queued core point-sample worker requests. Higher values dispatch
before lower values when a worker is available, while already running requests
keep their configured cancellation policy. Use higher priorities for the current
camera view and lower priorities for background prefetch.

`prefetchNodePointDataViews()` also accepts `maxConcurrentRequests` for
applications that want background decode-only prefetches to leave worker slots
available for immediate camera-view work. `prefetchNodePointGeometryBatches()`
goes one step further for the integrated worker path: it prepares decoded,
sampled, and Cesium-ready geometry batches without publishing them to the
renderer, so a later current-view render can reuse the batch cache instead of
starting from COPC decompression again. The basic viewer keeps prefetch
decode-only while the current detail pass is still loading, then uses
geometry-batch prefetch after detail settles because the benchmarked public
samples spend most of their time in point-data decode and worker queue work,
not Cesium point submission.

### Camera Stream Settings

```ts
import {
  createCopcCameraStreamEffectiveBudget,
  createCopcCameraStreamLodSettings,
  createCopcCameraStreamPrefetchSettings,
  createCopcPointCloudQualitySettings,
  updateCopcCameraStreamAdaptiveBudget,
} from "copc-cesium";

const qualitySettings = createCopcPointCloudQualitySettings("balanced");
const lod = createCopcCameraStreamLodSettings({
  cameraHeightMeters,
  qualitySettings,
});
const lastRenderedMaxPointCountPerNode = 2_500;

const prefetch = createCopcCameraStreamPrefetchSettings({
  nodeCount: selectedNodeKeys.length,
  basePointCountPerNode: 2_000,
  baseMaxRenderedPointCount: 96_000,
  minPointCountPerNode: lastRenderedMaxPointCountPerNode,
  minRenderedPointCount:
    selectedNodeKeys.length * lastRenderedMaxPointCountPerNode,
  lodSettings: lod,
});
let adaptiveBudgetState = {};
const limits = {
  maxRenderedPointCount: lod.maxRenderedPointCount,
  maxSourcePointCount: lod.maxSourcePointCount,
  maxNodePointCount: lod.maxNodePointCount,
  maxPointDataLength: lod.maxPointDataLength,
  maxNodePointDataLength: lod.maxNodePointDataLength,
};
const effectiveBudget = createCopcCameraStreamEffectiveBudget({
  limits,
  state: adaptiveBudgetState,
});
const budgetUpdate = updateCopcCameraStreamAdaptiveBudget({
  limits,
  state: adaptiveBudgetState,
  timings: {
    totalMilliseconds: diagnostics.totalMilliseconds,
    renderMilliseconds: renderStats.totalRenderMilliseconds,
    decodeMilliseconds:
      renderStats.pointGeometryTimings?.maxPointDataViewMilliseconds,
    workerMilliseconds:
      renderStats.pointGeometryTimings?.maxWorkerTotalMilliseconds,
    roundTripMilliseconds:
      renderStats.pointGeometryTimings?.maxRequestRoundTripMilliseconds,
  },
});
adaptiveBudgetState = budgetUpdate.state;
```

`createCopcCameraStreamLodSettings()` maps camera height to bounded stream
budgets for node count, hierarchy depth, compressed point-data reads, and
screen-space point spacing. `createCopcPointCloudQualitySettings()` provides the
same preview, balanced, detail, and ultra presets used by the basic viewer, so
applications can start from reusable Cesium/COPC budgets instead of copying demo
constants. `createCopcCameraStreamPrefetchSettings()` uses that same LOD target
to increase background preparation density as the camera gets closer, while
still capping per-node and total prefetch point counts. Pass
`minPointCountPerNode` and `minRenderedPointCount` when idle prefetch should
prepare the current view at least as densely as the last visible render, so the
next small zoom or pan can reuse cached COPC node samples instead of decoding
the same nodes again.
`createCopcCameraStreamEffectiveBudget()` applies the current adaptive state to
the configured LOD limits, and `updateCopcCameraStreamAdaptiveBudget()` lowers
or recovers those adaptive limits from render/worker timing feedback.

These helpers do not start requests or render points by themselves. They are
small policy helpers intended to feed `expandHierarchyForCamera()`,
`selectNodesForCamera()`, `renderNodesProgressively()`, and
`prepareNodesProgressively()` from an application-owned camera-stream loop.

### Camera Stream Node Planning

```ts
import {
  createCopcCameraStreamCoverageNodeKeys,
  createCopcCameraStreamFinalNodeKeys,
  createCopcCameraStreamPreviewNodeKeys,
  createCopcCameraStreamRenderNodeKeys,
  orderCopcCameraStreamNodeKeysForProgressiveCoverage,
  shouldReuseCopcCameraStreamNodeKeys,
} from "copc-cesium";

const renderNodeKeys = createCopcCameraStreamRenderNodeKeys(
  cameraSelection.nodes,
  layer.hierarchy,
);
const coverageNodeKeys = createCopcCameraStreamCoverageNodeKeys(
  renderNodeKeys,
  cameraSelection.selectedDepth,
);
const finalNodeKeys = orderCopcCameraStreamNodeKeysForProgressiveCoverage(
  createCopcCameraStreamFinalNodeKeys(
    cameraSelection.nodes.map((node) => node.key),
    coverageNodeKeys,
  ),
);
const previewNodeKeys = createCopcCameraStreamPreviewNodeKeys(
  coverageNodeKeys,
  layer.hierarchy,
  {
    maxNodeCount: 32,
    maxPointDataLength: 12 * 1024 * 1024,
  },
);
```

These helpers keep the first visible camera-stream pass coverage-oriented, then
let an application refine the selected detail nodes progressively. They also
provide node-family overlap checks through
`shouldReuseCopcCameraStreamNodeKeys()` so a viewer can decide whether an older
background request is still useful after a small pan or zoom.

### Camera Stream Render Plan

```ts
import {
  createCopcCameraStreamDetailProgressState,
  createCopcCameraStreamRenderPlan,
} from "copc-cesium";

const plan = createCopcCameraStreamRenderPlan({
  cameraSelection,
  configuredMaxPointCountPerNode: 120_000,
  effectiveNodePointDataLengthBudget,
  effectivePointDataLengthBudget,
  effectiveSourcePointBudget,
  hierarchy: layer.hierarchy,
  lodSettings,
  previewMaxNodeCount: 32,
  previewMaxPointDataLength: 1_100_000,
  renderedPointBudget: 240_000,
});

if (!requestController.hasRenderSignature(plan.renderSignature)) {
  requestController.setActiveNodeKeys(plan.finalNodeKeys);
  await layer.renderNodesProgressively(plan.finalNodeKeys, {
    maxPointCountPerNode: plan.maxPointCountPerNode,
    maxRenderedPointCount: plan.renderedPointBudget,
    continueLoadingAfterStop: true,
    postStopLoadingMode: "background",
    postStopProgressMode: "load-only",
    shouldStopAfterProgress: (result) => {
      const progress = createCopcCameraStreamDetailProgressState({
        finalNodeKeys: plan.finalNodeKeys,
        renderedNodeKeys: result.pointSamples.nodeKeys,
        minBudgetCompletionNodeCoverageRatio: 0.9,
        renderedPointBudget: plan.renderedPointBudget,
        renderedPointCount: result.pointSamples.sampledPointCount,
      });

      return progress.isComplete;
    },
  });
}
```

`createCopcCameraStreamRenderPlan()` turns a camera selection into the concrete
node sets a streaming layer needs: selected nodes, ancestor-backed render nodes,
coverage nodes, final detail nodes, preview nodes, a per-node point cap, and a
stable render signature. This keeps app code from duplicating the same
COPC-octree planning rules. `previewMinFinalNodeCount` lets an application skip
the temporary coverage preview when only a few final detail nodes are needed, so
those dense current-view nodes can be submitted to workers immediately.

### High-Level Camera Stream

```ts
import {
  CopcPointCloudCameraStream,
  CopcPointCloudLayer,
} from "copc-cesium";

const layer = new CopcPointCloudLayer(viewer.scene, { url });
await layer.load();

const cameraStream = new CopcPointCloudCameraStream({
  camera: viewer.camera,
  layer,
  quality: "balanced",
  onUpdate: ({ phase, requestId, lodSettings, result }) => {
    renderStatus({ phase, requestId, lodSettings, result });
  },
  onError: (error) => {
    showCameraStreamError(error);
  },
});

cameraStream.start();

// Stop listening without destroying the layer:
cameraStream.stop();

// Release the controller permanently:
cameraStream.destroy();
```

`CopcPointCloudCameraStream` is the reusable default camera loop. It subscribes
to Cesium `moveStart`, `changed`, and `moveEnd`, debounces duplicate updates,
aborts stale renders, maps camera height and a quality preset to bounded LOD and
byte budgets, expands nearby hierarchy pages, and calls
`renderAutomaticProgressively()` for the latest view. `renderOptions` can
override individual selection or progressive-render settings without replacing
the lifecycle controller. `lastResult`, `lastError`, `isRunning`, and
`isRendering` expose state for application UI and diagnostics.

Call `render()` directly when an application needs an awaited refresh. `start()`
uses the same method for camera events and reports asynchronous failures through
`onError` while retaining the value in `lastError`.

The lower-level helpers below remain available for applications that need the
basic viewer's custom preview, retained-node, completion, and predictive-prefetch
policies.

### Low-Level Camera Stream Controllers

```ts
import {
  CopcCameraStreamNodeSampleCache,
  CopcCameraStreamPrefetchController,
  CopcCameraStreamRequestController,
} from "copc-cesium";

const requests = new CopcCameraStreamRequestController({
  maxReusedBackgroundRequests: 2,
  minNodeFamilyOverlapRatio: 0.35,
  scheduler: {
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  },
});
const prefetches = new CopcCameraStreamPrefetchController();
const nodeSamples = new CopcCameraStreamNodeSampleCache({
  maxSampleSetCount: 512,
});
```

`CopcCameraStreamRequestController` owns active camera-stream abort signals,
debounced render scheduling, node-family request reuse, and render signatures.
`CopcCameraStreamPrefetchController` limits background preparation to one active
task and aborts it when a newer view supersedes it. `CopcCameraStreamNodeSampleCache`
keeps retained node samples ordered by node and density so an application can
show coverage immediately while denser current-view samples load.

### Camera Stream Policies

```ts
import {
  CopcCameraStreamNodeSampleCache,
  CopcCameraStreamRequestController,
  createCopcCameraStreamPrefetchPlan,
  createCopcCameraStreamPrefetchNodeKeys,
  createCopcCameraStreamPrefetchSelectionPlan,
  createCopcCameraStreamDetailProgressState,
  createCopcCameraStreamRequestPriority,
  createCopcCameraStreamRuntimeSettings,
  createCopcWorkerPoolSettings,
  formatCopcCameraStreamBudgetSummary,
  selectCopcCameraStreamDetailProgressPolicy,
  selectCopcCameraStreamDetailWarmupPolicy,
  selectCopcCameraStreamRequestPriorityOffsets,
} from "copc-cesium";

const priorities = selectCopcCameraStreamRequestPriorityOffsets();
const runtime = createCopcCameraStreamRuntimeSettings();
const requests = new CopcCameraStreamRequestController({
  maxReusedBackgroundRequests: runtime.maxReusedBackgroundStreams,
  minExactNodeOverlapRatio: runtime.reuseMinExactNodeOverlapRatio,
  minNodeFamilyOverlapRatio: runtime.reuseMinNodeFamilyOverlapRatio,
  reusedBackgroundRequestGraceMilliseconds:
    runtime.reusedBackgroundStreamGraceMilliseconds,
  scheduler,
});
const retainedSamples = new CopcCameraStreamNodeSampleCache({
  maxSampleSetCount: runtime.retainedNodeSampleLimit,
});
const prefetchSelectionPlan = createCopcCameraStreamPrefetchSelectionPlan({
  lodSettings,
  maxNodeCount: runtime.prefetchMaxNodeCount,
  maxNodePointCount: effectiveNodePointBudget,
  maxNodePointDataLength: effectiveNodePointDataLengthBudget,
  maxTotalPointCount: effectiveSourcePointBudget,
  maxTotalPointDataLength: effectivePointDataLengthBudget,
});
const prefetchNodeKeys = createCopcCameraStreamPrefetchNodeKeys({
  selectedNodeKeys: finalNodeKeys,
  coverageNodeKeys,
  hasUsableNodeSample: (nodeKey) => cache.has(nodeKey),
  maxNodeCount: runtime.prefetchMaxNodeCount,
});
const lastRenderedMaxPointCountPerNode = 2_500;
const prefetchPlan = createCopcCameraStreamPrefetchPlan({
  selectedNodeKeys: finalNodeKeys,
  coverageNodeKeys,
  maxNodeCount: runtime.prefetchMaxNodeCount,
  basePointCountPerNode: runtime.prefetchPointCountPerNode,
  baseMaxRenderedPointCount: runtime.prefetchMaxRenderedPointCount,
  minPointCountPerNode: lastRenderedMaxPointCountPerNode,
  lodSettings,
  hasUsableNodeSample: (nodeKey, maxPointCountPerNode) =>
    cache.find(nodeKey, maxPointCountPerNode) !== undefined,
});
await layer.prefetchNodePointGeometryBatches(prefetchPlan.prefetchNodeKeys, {
  maxPointCountPerNode: prefetchPlan.maxPointCountPerNode,
  maxConcurrentRequests: runtime.backgroundPrefetchMaxConcurrentRequests,
  requestPriority: runtime.backgroundPrefetchRequestPriority,
});
const progress = selectCopcCameraStreamDetailProgressPolicy({
  finalNodeKeys,
  initialNodeResults,
  rendererKind: "typed",
  fastRendererProgressBatchNodeCount: 1,
  pointPrimitiveProgressBatchNodeCount: 4,
});
const warmup = selectCopcCameraStreamDetailWarmupPolicy({
  finalNodeKeys,
  initialNodeResults,
  detailMaxPointCountPerNode: 6_500,
  warmupPointCountPerNode: runtime.detailWarmupPointCountPerNode,
  minSameNodeInitialCoverageRatio:
    runtime.detailWarmupMinInitialCoverageRatio,
});
const priority = createCopcCameraStreamRequestPriority({
  requestId,
  offset: priorities.detail,
});
requests.queueRender(runtime.moveDebounceMilliseconds, renderCurrentView);
const progress = createCopcCameraStreamDetailProgressState({
  finalNodeKeys,
  renderedNodeKeys: progressResult.pointSamples.nodeKeys,
  minBudgetCompletionNodeCoverageRatio: 0.9,
  renderedPointBudget: 240_000,
  renderedPointCount: progressResult.pointSamples.sampledPointCount,
});
const isDetailComplete = progress.isComplete;
const workers = createCopcWorkerPoolSettings({
  hardwareConcurrency: navigator.hardwareConcurrency,
});
const budgetText = formatCopcCameraStreamBudgetSummary({
  configuredRenderedPointBudget: 240_000,
  effectiveRenderedPointBudget: 180_000,
  effectiveSourcePointBudget: 900_000,
  maxSourcePointBudget: 900_000,
  effectiveNodePointBudget: 80_000,
  maxNodePointBudget: 80_000,
  effectivePointDataLengthBudget: 16 * 1024 * 1024,
  maxPointDataLengthBudget: 16 * 1024 * 1024,
  effectiveNodePointDataLengthBudget: 2 * 1024 * 1024,
  maxNodePointDataLengthBudget: 2 * 1024 * 1024,
  formatBytes: (byteCount) => `${byteCount.toLocaleString()} B`,
});
```

These helpers are intentionally independent from the example viewer. They cover
current-view prefetch choice, preview/detail/warmup request priority, progressive
detail batch size, worker pool sizing, and diagnostic budget text. Applications
can replace any policy, but the defaults keep camera movement focused on visible
COPC nodes while limiting worker and Cesium renderer pressure. Use
`createCopcWorkerPoolSettings()` when sizing browser worker pools from
`navigator.hardwareConcurrency`; the default policy is interactive-first, so it
falls back to four point-sample and five integrated geometry workers, caps
point-sample pools at six workers, and caps integrated geometry pools at
eight workers while reserving browser capacity for rendering. It also returns
a 120 ms `decodedNodeWorkerFallbackDelayMilliseconds` value that the basic
viewer passes to `CopcPointCloudLayer` to balance worker-local decoded-cache
reuse with foreground camera-stream latency.
Use
`createCopcCameraStreamRuntimeSettings()` for the default debounce, request
reuse, retained sample cache, prefetch, preview, warmup, and cold-detail
completion thresholds used by the basic viewer, then override only the values
your application needs. `previewMaxPointDataLength` caps the compressed point
data used for quick coverage preview candidates; when coverage candidates are
too large and detail candidates exist, preview planning falls back to distributed
detail nodes instead of forcing one oversized parent block. `detailMaxActiveNodeRequests` limits how many missing
current-view detail nodes the foreground pass keeps active at once; the basic
viewer applies the smaller of that runtime setting and the integrated geometry
worker count. Reused background requests are kept only for
`reusedBackgroundStreamGraceMilliseconds` by default, so a small pan or zoom can
reuse near-finished work without letting the previous view occupy worker slots
for several seconds. Use
`minSameNodeInitialCoverageRatio` when low-density warmup should only run after
enough current-view nodes are already available. The default runtime requires
35% same-node initial coverage before warmup starts, which prevents background
warmup from delaying the first dense render for a mostly cold view.
`createCopcCameraStreamDetailProgressState()` reports how many current-view
detail nodes are represented in the latest progressive render and whether that
render can stop. Pass `minBudgetCompletionNodeCoverageRatio` when a point budget
fill should not be enough by itself; this keeps a cold camera view from
finishing with only one dense patch while other visible nodes are still sparse.
Pass the same completion policy to `renderNodesProgressively()` through
`shouldStopAfterProgress` when the desired behavior is to abort the remaining
tail work only after the visible current-view coverage threshold is met.

`createCopcCameraStreamPrefetchSelectionPlan()` makes the background camera
selection one depth step denser than the foreground view and tightens
screen-space spacing for the next likely frame. `createCopcCameraStreamPrefetchPlan()`
then combines selected detail nodes, coverage fallback nodes, cache freshness,
and density-aware point budgets into the concrete node list for
`prepareNodesProgressively()`. Pass `nodeWeights` when the prefetch list should
prioritize source-point-heavy nodes while keeping the same progressive coverage
ordering; the basic viewer uses camera-selected node point counts for this.

### Camera Stream Telemetry

```ts
import {
  formatCopcCameraStreamDiagnostics,
  formatCopcCameraStreamLodSummary,
  formatCopcHierarchyNodeCameraSelection,
  summarizeCopcCameraStreamSourceNodes,
} from "copc-cesium";

const sourceSummary = summarizeCopcCameraStreamSourceNodes(result.nodes);
const diagnosticsText = formatCopcCameraStreamDiagnostics({
  expandHierarchyMilliseconds: 0.8,
  applyHierarchyMilliseconds: 0,
  selectNodesMilliseconds: 17.1,
  renderNodesMilliseconds: 8.7,
  totalMilliseconds: 28.4,
  loadedHierarchyPageCount: loadedPageKeys.length,
  selectedNodeCount: result.nodes.length,
  selectedDepth: cameraSelection.selectedDepth,
  ...sourceSummary,
});
const lodText = formatCopcCameraStreamLodSummary({
  lodSettings,
  effectiveSourcePointBudget,
  effectiveNodePointBudget,
  effectivePointDataLengthBudget,
  effectiveNodePointDataLengthBudget,
});
const selectionText = formatCopcHierarchyNodeCameraSelection(cameraSelection);
```

Telemetry helpers keep status panels, benchmarks, and consuming applications on
the same terminology: hierarchy expansion time, camera selection time, render
time, loaded hierarchy pages, selected node depth, source point count, LOD
budget, and camera selection coverage. They are presentation helpers only; the
underlying numeric diagnostics remain available as plain objects.

### Worker Warmup

```ts
layer.warmUpPointSampleWorkers({ workerCount: 4 });
layer.warmUpPointGeometryWorkers({ workerCount: 4 });
```

`warmUpPointSampleWorkers()` starts the layer-owned COPC point-sample worker
pool before the first camera-stream request. It does not load COPC nodes or
dispatch point requests; it only removes worker startup latency from the first
visible interaction. `workerCount` is capped by
`maxConcurrentPointSampleWorkerRequests`.

### Camera Selection

```ts
await layer.expandHierarchyForCamera({
  camera: viewer.camera,
  maxPages: 2,
});

const selection = await layer.selectNodesForCamera({
  camera: viewer.camera,
  selectionMode: "coverage",
  coverageMode: "progressive",
  maxNodes: 64,
  targetNodeScreenPixels: 120,
  maxTotalPointDataLength: 128_000_000,
});

if (selection) {
  await layer.renderNodes(selection.nodes.map((node) => node.key));
}
```

Camera selection requires coordinate transforms with both `toCesium` and
`toCopc`. If `toCopc` is unavailable, `coordinateTransform.supportsCameraSelection`
will be `false`.

`selectionMode: "coverage"` defaults to `coverageMode: "complete-depth"`,
which only selects a same-depth coverage set when the whole depth fits the
configured node and byte budgets. Use `coverageMode: "progressive"` for camera
streaming flows that should keep a coarse full-view coverage layer while also
adding distributed target-depth detail nodes inside the same selection.

### Automatic Camera Render

```ts
const result = await layer.renderAutomatic({
  camera: viewer.camera,
  expandHierarchy: true,
  maxHierarchyPages: 2,
  selectionMode: "coverage",
  coverageMode: "progressive",
  maxNodes: 64,
  targetNodeScreenPixels: 120,
  maxPointCountPerNode: 5_000,
  maxRenderedPointCount: 240_000,
});
```

`renderAutomatic()` is a convenience path that can expand nearby hierarchy
pages, select camera-relevant nodes, and render them in one call.
Use `selectionMode: "coverage"` when the goal is to fill the current view with
COPC nodes instead of only rendering the nearest few nodes around the camera
target.

### Lifecycle

```ts
layer.clear();
layer.clearPointSampleCache();
layer.resetStreamingCaches();
layer.destroy();
```

- `clear()` removes rendered points and bounds while keeping the source and
  caches.
- `clearPointSampleCache()` drops decoded point sample cache entries.
- `resetStreamingCaches()` drops point sample and geometry caches, terminates
  active layer worker pools, rejects pending layer-owned point requests, and
  keeps the opened COPC metadata and hierarchy available for the next camera
  render.
- `warmUpPointSampleWorkers()` creates idle point-sample workers ahead of the
  first point-data read when `pointSampleLoading: "worker"` is active.
- `warmUpPointGeometryWorkers()` creates idle integrated geometry workers ahead
  of the first geometry request.
- `destroy()` removes Cesium primitives and rejects later layer operations.

## Render Stats

Render calls return `renderStats`:

```ts
const { renderStats } = await layer.renderNode("0-0-0-0");

console.log(renderStats.pointCount);
console.log(renderStats.rendererSetPointsMilliseconds);
console.log(renderStats.pointGeometryTimings?.maxRequestRoundTripMilliseconds);
console.log(renderStats.pointGeometryTimings?.slowestNodes[0]?.nodeKey);
```

When integrated point-geometry workers are active, `pointGeometryTimings`
reports both aggregate worker time and per-node maximum time. Aggregate fields
such as `workerTotalMilliseconds` are useful for total work accounting, while
`maxWorkerTotalMilliseconds` and `maxRequestRoundTripMilliseconds` are closer to
the slowest request the user waited on during a parallel load. `slowestNodes`
keeps the slowest per-node timing records with node key, source point count,
sampled point count, optional compressed point-data length, and worker timing
fields so applications can identify expensive COPC nodes without parsing logs.

Fields:

- `pointCount`: rendered point count.
- `estimatedRenderPayloadBytes`: estimated coordinate/color payload size.
- `coordinateTransformMilliseconds`: CPU time spent converting COPC source
  coordinates into Cesium coordinates.
- `rendererSetPointsMilliseconds`: CPU time spent submitting points to the
  active renderer.
- `boundsRenderMilliseconds`: CPU time spent submitting debug bounds.
- `totalRenderMilliseconds`: total CPU-side render submission time measured by
  the layer.

These numbers are repeatable comparison metrics, not GPU frame-time profiling.

## Render Budgets

There are two related budgets:

- `maxPointCountPerNode`: maximum samples read from each individual hierarchy
  node.
- `maxRenderedPointCount`: maximum samples submitted to Cesium across a
  multi-node render call.

Use `maxRenderedPointCount` for camera streaming and Auto LOD paths where the
number of selected nodes may change as the camera moves.

## Renderers

`CopcPointCloudLayer` uses `CesiumPrimitivePointRenderer` by default. It builds
one Cesium `Primitive` from typed position and color arrays, avoiding one
Cesium point object per rendered COPC point. This keeps the default renderer
Cesium-native while moving closer to the final high-density path.

You can configure the default typed-array primitive renderer explicitly when you
need to tune point size or primitive chunking.

```ts
import { CesiumPrimitivePointRenderer } from "copc-cesium";

new CopcPointCloudLayer(viewer.scene, {
  url, // or source: fileOrBlob,
  createPointRenderer: (scene) =>
    new CesiumPrimitivePointRenderer(scene, {
      pointSize: 2,
      maxGeometryBatchesPerPrimitive: 1,
    }),
});
```

`maxGeometryBatchesPerPrimitive` defaults to `1` so worker-prepared COPC
geometry batches stay as stable per-node primitives during progressive camera
updates. This avoids rebuilding earlier node primitives when a later node
finishes decoding. If an application prefers fewer Cesium primitives over lower
incremental update cost, it can raise this value. The older
`maxBatchesPerPrimitive` option still controls non-geometry point batches and is
also used as the geometry fallback when `maxGeometryBatchesPerPrimitive` is not
provided.

`CesiumPointPrimitiveRenderer` remains available as a stable Cesium
`PointPrimitiveCollection` fallback. `CesiumBufferPointRenderer` is also
available for comparison with Cesium's experimental `BufferPointCollection`.

```ts
import { CesiumPointPrimitiveRenderer } from "copc-cesium";

new CopcPointCloudLayer(viewer.scene, {
  url, // or source: fileOrBlob,
  createPointRenderer: (scene) =>
    new CesiumPointPrimitiveRenderer(scene, {
      pixelSize: 2,
      outlineWidth: 0,
    }),
});
```

```ts
import { CesiumBufferPointRenderer } from "copc-cesium";

new CopcPointCloudLayer(viewer.scene, {
  url, // or source: fileOrBlob,
  createPointRenderer: (scene) =>
    new CesiumBufferPointRenderer(scene, {
      pointSize: 2,
      outlineWidth: 0,
    }),
});
```

Applications can provide their own renderer by implementing
`CopcPointCloudRenderer`:

```ts
interface CopcPointCloudRenderer {
  setPoints(points: readonly PointSample[]): void;
  clear(): void;
  destroy(): void;
}
```

## Coordinate Transforms

`core` keeps point samples in source COPC XYZ. The Cesium layer needs a transform
factory that returns at least `toCesium`.

The default factory supports likely geographic coordinates, the public Autzen
EPSG:2992 sample, and projected COPC sources that include proj4-compatible WKT.
WKT1 compound coordinate systems are split into a horizontal CRS for XY
conversion and a vertical unit scale for height conversion:

```ts
import { createDefaultCopcCoordinateTransforms } from "copc-cesium";
```

For projected data with missing, malformed, grid-dependent, or application-specific
WKT, pass an explicit proj4-backed transform override:

```ts
import { createProj4CoordinateTransforms } from "copc-cesium";

const layer = new CopcPointCloudLayer(viewer.scene, {
  url, // or source: fileOrBlob,
  coordinateTransforms: createProj4CoordinateTransforms({
    sourceCrs: "EPSG:32611",
    sourceDefinition:
      "+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs",
  }),
});
```

If a transform includes `toCopc`, camera-based node suggestion, hierarchy
expansion, and automatic rendering can use the camera position in COPC space.

## Core API

Use `CopcSource` when an application wants COPC metadata and point samples
without creating Cesium primitives.

```ts
import { CopcSource, type CopcSourceInput } from "copc-cesium/core";

const input: CopcSourceInput = url; // URL string, File, or Blob
const source = new CopcSource(input, {
  maxCachedHierarchyPages: 64,
  maxCachedHierarchyPageBytes: 16 * 1024 * 1024,
  maxCachedSampleSets: 32,
});

const inspection = await source.inspect();
const hierarchy = await source.loadHierarchySummary();
const pointSamples = await source.loadNodePointSamples({
  nodeKey: hierarchy.nodes[0]?.key,
  maxPointCount: 5_000,
  requestPriority: 10,
});
```

This is the boundary that should stay independent of Cesium imports. When source
point-sample workers are enabled, `requestPriority` gives current-view reads a
way to stay ahead of retained background work without changing the Cesium layer.

## Current Stability

- Default renderer: `CesiumPrimitivePointRenderer`.
- Stable fallback renderer: `CesiumPointPrimitiveRenderer`.
- Experimental comparison renderer: `CesiumBufferPointRenderer`.
- Pre-1.0 camera-streaming and Auto LOD defaults that remain open to measured calibration.
- Projected COPC WKT is detected automatically when proj4 can parse its horizontal
  CRS. Pass `createProj4CoordinateTransforms` for missing or unsupported WKT and
  for transformations that require application-managed datum grids.
- Package metadata and consumer checks target public version `0.1.0`; pre-1.0
  minor releases may still refine public types before the 1.0 compatibility contract.
