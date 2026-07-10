# copc-cesium

[![CI](https://github.com/KimDDong03/COPC_VIEWER/actions/workflows/ci.yml/badge.svg)](https://github.com/KimDDong03/COPC_VIEWER/actions/workflows/ci.yml)

CesiumJS-native COPC point cloud streaming and visualization library.

`copc-cesium` lets a CesiumJS developer load COPC point cloud data directly from a COPC file or URL, inspect its hierarchy, range-read selected point nodes, transform source coordinates, and render sampled points in a Cesium scene without pre-converting the data to 3D Tiles.

## Goal

Allow a CesiumJS developer to load a COPC file or URL directly into a Cesium scene without pre-converting it to 3D Tiles.

This project handles already-created COPC files. It does not target live LiDAR input, a general point cloud viewer app, or a COPC-to-3D-Tiles conversion pipeline.
Here, streaming means on-demand COPC hierarchy and point-data range reads driven by camera/node selection, not real-time sensor ingestion.

## Current Scope

The pre-1.0 library currently supports:

1. Render hardcoded points in CesiumJS.
2. Open and inspect a COPC file or URL.
3. Read a small set of real XYZ points.
4. Transform the sample COPC CRS into Cesium-friendly longitude, latitude, and height.
5. Display sampled COPC hierarchy-node points in CesiumJS.
6. Load nearby COPC hierarchy pages progressively, track loaded hierarchy page provenance, reuse bounded caches, and prepare COPC point geometry in Web Workers.
7. Bind progressive LOD rendering to a Cesium camera through a reusable high-level controller.
8. Verify remote URL, local file, WKT CRS, package-consumer, and camera-stream paths in repeatable browser checks.

Persistent/offline cache storage, non-COPC formats, point-cloud editing, and
application-specific classification styling remain outside the current scope.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Quick API Example

```ts
import { Viewer } from "cesium";
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

const { hierarchy } = await layer.load();
const firstNode = hierarchy.nodes[0];

if (firstNode) {
  await layer.renderNode(firstNode.key);
}
```

For a reusable camera-movement loop, use the high-level stream controller
instead of wiring Cesium camera events, cancellation, LOD settings, and
progressive rendering by hand:

```ts
import { CopcPointCloudCameraStream } from "copc-cesium";

const cameraStream = new CopcPointCloudCameraStream({
  camera: viewer.camera,
  layer,
  quality: "balanced",
  onUpdate: ({ phase, result }) => {
    statusElement.textContent =
      `${phase}: ${result.renderStats.pointCount.toLocaleString()} points`;
  },
  onError: (error) => {
    statusElement.textContent =
      error instanceof Error ? error.message : "COPC camera stream failed.";
  },
});

cameraStream.start();

// Later:
cameraStream.destroy();
layer.destroy();
```

`start()` subscribes to Cesium camera movement, debounces updates, aborts stale
renders, derives bounded LOD settings from camera height and the selected quality
preset, and progressively renders the latest view. `lastResult` and `lastError`
remain available for application status surfaces.

For browser-selected files, pass the `File` or `Blob` through `source` instead
of `url`:

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

Remote COPC hosting must return `206 Partial Content` for byte-range requests.
For cross-origin URLs, allow the viewer origin with CORS and allow the `Range`
request header; exposing `Content-Range` is recommended for diagnostics.

See [API](docs/API.md) for the current public surface and
[examples/minimal-layer.ts](examples/minimal-layer.ts) for a type-checked
minimal integration slice.
The [2026 competition evidence map](docs/COMPETITION.md) links the Gaia3D
task requirements to implementation and repeatable verification artifacts.

## Build

```bash
npm run build:lib
npm run build:example
npm run build
npm run benchmark:renderers
npm run benchmark:smoothness
npm run benchmark:smoothness:qc
npm run benchmark:smoothness:regression -- output/baselines/smoothness-assertion.json
npm run benchmark:smoothness:contest
npm run benchmark:smoothness:cache-reset
npm run benchmark:smoothness:cold-reset
npm run qc
npm run smoke:example
npm run smoke:example:file
npm run smoke:package
```

`npm run build:lib` writes the library package contract to `dist/lib`.
`npm run build:example` writes the runnable demo bundle to `dist/example`.
`npm pack --dry-run` builds the library through `prepack` and inspects the
package contents without publishing. `npm publish` additionally runs the full
`prepublishOnly` QC gate before packaging; it is not part of normal builds.
`npm run smoke:example` builds the example, starts a temporary preview server, and verifies Autzen, SoFi, and Custom URL + proj4 rendering in a browser. Run `npm run smoke:example:install-browser` once if Playwright reports that Chrome for Testing is missing.
`npm run smoke:example:file` runs the same browser smoke flow, downloads the Autzen COPC sample into the ignored `output/local-copc-samples` cache, then verifies that the browser file input can load and render that local COPC file through the same layer API.
`npm run smoke:package` packs the local build, verifies required documentation and package/worker size budgets, installs it into a temporary consumer project, and verifies public imports from `copc-cesium`, `copc-cesium/core`, and `copc-cesium/cesium`.
`npm run benchmark:renderers` builds the example, starts a temporary preview server, renders the Autzen COPC sample with the typed-array, point-primitive, and buffer point renderers at a larger sample size, repeats each run, and writes browser-measured renderer timing to `output/renderer-benchmark/renderers.json`. The defaults are 10,000 max points per node and 3 repeats. On PowerShell, override them with `$env:COPC_BENCHMARK_POINT_COUNT="20000"; $env:COPC_BENCHMARK_REPEATS="5"; npm run benchmark:renderers`.
`npm run benchmark:smoothness` builds the example, starts a temporary preview server, enables camera streaming, moves the Cesium camera, records browser frame intervals, first foreground response timing, stream-stage timing, and selected LOD depth, then writes the result to `output/smoothness-benchmark/smoothness.json`. The defaults are Autzen, SoFi, and Custom SoFi URL samples; 2,500 / 5,000 / 10,000 / 20,000 camera-stream point budgets; 2 repeats per budget; 24 camera steps; 3 seconds per run; and sample-specific minimum selected-depth checks. On PowerShell, override them with `$env:COPC_SMOOTHNESS_SAMPLES="autzen-classified,sofi-stadium"; $env:COPC_SMOOTHNESS_POINT_BUDGETS="5000,10000"; $env:COPC_SMOOTHNESS_REPEATS="5"; $env:COPC_SMOOTHNESS_MIN_SELECTED_DEPTH="2"; npm run benchmark:smoothness`.
Browser smoke and benchmark commands request Chromium's high-performance GPU and
record the actual WebGL vendor/renderer/version in their result. Systems without
a discrete GPU can still fall back to their available adapter, so use the
recorded renderer instead of assuming a GPU from Windows numbering.
`npm run benchmark:smoothness:qc` runs a shorter Autzen camera-stream benchmark and then fails if the measured frame smoothness, first foreground response time, stream update time, end-to-end camera move duration, selected LOD depth, rendered point count, current-view node count, or current-view density falls below the configured regression thresholds.
`npm run benchmark:smoothness:regression -- <path>` compares the latest smoothness assertion report with a saved baseline and fails when FPS, frame timing, first foreground response time, stream time, queue time, rendered point count, or current-view node coverage/density regresses beyond tolerance.
`npm run benchmark:smoothness:contest` runs the same regression gate against both Autzen and SoFi so heavier projected-coordinate data is covered before contest/release checks.
`npm run benchmark:smoothness:cache-reset` clears retained camera-stream state before a SoFi camera movement run while keeping layer-level point samples, prepared point geometry, and worker-local decoded COPC node caches alive. The already-open COPC metadata, hierarchy, prepared Cesium geometry, and worker decoded views stay loaded, so this checks repeated zoom/pan recovery rather than a full first-page cold start or a forced worker/cache reset.
`npm run benchmark:smoothness:cold-reset` clears the active layer caches before a SoFi camera movement run and measures the first interactive coverage render instead of waiting for every detail node to finish. Detail refinement continues in the background, so this catches regressions in cold first-display responsiveness without confusing it with final-density completion.
`npm run qc` runs the main release-quality checks sequentially: tests, build, the three-backend renderer benchmark, contest/cold/warm camera-stream smoothness QC, package smoke, browser example smoke, local-file browser smoke, and `git diff --check`. Keep these checks sequential because the browser smoke commands rebuild the same `dist/example` output directory.
The same remote URL and local-file browser rendering smoke runs in the GitHub
Actions workflow `Example Browser Smoke` for pushes, pull requests, and manual
dispatches.
The `Release Candidate` workflow runs the full QC gate for version tags or a
manual dispatch, then uploads the verified package tarball, renderer and
smoothness reports, and browser screenshots without publishing them to npm.

The runnable reference viewer lives in `examples/basic-viewer`. The root `src` folder contains reusable COPC and Cesium integration code used by that example.
Reusable source entry points are `src/index.ts`, `src/core/index.ts`, and `src/cesium/index.ts`; package exports expose built JS and type declarations as `copc-cesium`, `copc-cesium/core`, and `copc-cesium/cesium`.
`CopcPointCloudLayer` is the main low-level Cesium-facing API: it owns a `CopcSource`, point renderer, bounds renderer, and camera-based node rendering helpers.
The default point renderer is now `CesiumPrimitivePointRenderer`, a Cesium `Primitive` backend that submits typed position and color arrays instead of creating one Cesium point object per COPC point. `CopcPointCloudLayer` also accepts a `createPointRenderer` factory so renderer backends can be swapped without changing COPC loading logic. `CesiumPointPrimitiveRenderer` remains available as the stable point-primitive fallback, `CesiumBufferPointRenderer` remains available as an experimental `BufferPointCollection` comparison backend, and `CesiumPointRenderer` remains as a compatibility alias.

The default example URL loads the public Autzen COPC sample, reads the root hierarchy, renders an initial node to place the camera, then automatically renders a denser camera-selected coverage LOD set.
Balanced detail mode now targets up to 240,000 Auto LOD points with 2 px typed-array primitive points and selects coverage nodes through depth 3 so the visible COPC footprint is filled more like tiles instead of only showing the nearest few nodes.
The example keeps sample COPC URLs and their transform factories in a small preset list while still allowing direct custom URL entry or a browser-selected local COPC file.
Bundled sample presets use the Vite `/copc-samples/*` proxy so local dev and preview runs can issue same-origin COPC range requests even when a browser blocks direct S3 requests.
For custom URLs or local files, the default path reads projected CRS WKT from the COPC metadata. The example also accepts an explicit source CRS and optional proj4 definition as an override for files with missing or unusable WKT.
The hierarchy node selector lists currently loaded nodes and lets the example render one selected node at a time.
The renderer selector starts on the typed-array primitive renderer and can switch to the stable point-primitive renderer or the experimental buffer renderer for comparison.
The Quality selector switches between fast preview, balanced detail, high detail, and ultra density presets. These presets tune the point budget and point pixel size together so the example can show a denser cloud without oversized marker dots.
The Max points / node input controls the active `CopcPointCloudLayer` sample budget, which makes manual and automated renderer comparison possible without changing source code.
The Camera stream points input controls the maximum point budget used by `Stream on camera move`; the example can temporarily lower the effective stream budget after slow updates and recover it after repeated fast updates.
`CopcSource` keeps the opened COPC metadata, loaded hierarchy pages, pending hierarchy page references with bounds and source-page provenance, hierarchy cache stats, and bounded in-memory caches for hierarchy pages and sampled node point data for the active URL. The hierarchy page cache evicts loaded non-root leaf pages back to pending page references when the configured page-count or hierarchy-byte limit is reached. The point sample cache is limited by both sample-set count and estimated decoded sample bytes.
The Load next page button range-reads the next pending COPC hierarchy page and refreshes the available node list without converting the file to 3D Tiles.
The example also computes the selected node bounds and renders a yellow debug bounding box in CesiumJS.
It can suggest the nearest loaded hierarchy node to the current camera position and apply that suggestion on demand.
The manual render set can combine multiple hierarchy nodes and render their sampled points together.
The Auto LOD button expands nearby pending hierarchy pages, estimates each available depth's nearest node screen size and COPC spacing-derived point spacing in screen pixels, culls nodes outside the Cesium camera frustum with a view-direction fallback, then uses coverage-oriented node selection so the current view is filled before it renders through the same multi-node path.
Multi-node rendering accepts `maxRenderedPointCount` so camera-driven paths can cap the total sampled points submitted to Cesium instead of multiplying the per-node sample budget by every selected node.
The Stream on camera move toggle renders from the currently loaded hierarchy after camera movement, selects current-view nodes with LOD-specific depth, node-count, source-point, and byte budgets, queues one background camera-targeted hierarchy/geometry prefetch at a time, applies an adaptive render-point budget capped by the UI input, publishes a quick coverage or partial-detail render as the foreground response, then keeps denser detail refinement running in the background. Final detail nodes are capped and selected across the visible range so zoomed views do not wait on an excessive tail of tiny COPC nodes before the screen is usable. Each camera-stream LOD also has its own final-node point cap, so close zooms can keep enough points per visible node for dense coverage without letting one large node consume the whole foreground budget. Preview selection prefers cheap coverage nodes, but falls back to distributed detail nodes when every coverage candidate exceeds the compressed-byte preview budget, so close zooms do not wait on one large parent block before detail can start. Current-view final detail uses the camera-stream selection order by default, so the active worker window stays spread across the visible screen instead of concentrating on one dense patch. Applications can still opt into `source-points-first` for explicit density-first refinement. The foreground detail pass keeps only a runtime-configured bounded window of missing nodes active at once, which reduces queued stale work when the camera moves again. Once the current-view completion policy is satisfied, active tail node loads can continue only as cache-warming background work instead of keeping the foreground camera response open. Current-view warmup now fills the integrated geometry cache without submitting its own Cesium render, and it only starts after enough same-node low-density coverage is already present so mostly cold zooms give worker slots to dense detail first. Later background prefetch uses the camera-selected source point counts to warm more important same-view nodes first, and progressive prepare work can also keep a bounded active request window, so nearby zoom and pan updates can reuse prepared Cesium batches without letting background work queue every missing node ahead of the latest camera view. It reuses the in-memory COPC point-sample cache for already loaded node/sample-count pairs without rebuilding the full node dropdown on each stream update.
Render results include `renderStats` with browser CPU-side coordinate transform time, renderer `setPoints` submission time, bounds submission time, total submission time, point count, and an estimated coordinate/color payload byte count. These numbers are intended for repeatable renderer comparison, not GPU frame-time profiling.
When integrated point-geometry workers are active, `renderStats.pointGeometryTimings` also separates summed worker work from the slowest single request and exposes `slowestNodes` so expensive COPC nodes can be identified without parsing logs.
The smoothness benchmark adds browser `requestAnimationFrame` interval measurements while the example camera-stream path is active, and also records first foreground response timing, selected depth, hierarchy expansion, hierarchy UI application, node selection, point rendering, and total stream-update timing so point-budget tuning can be compared with repeatable frame-time data.
The basic viewer enables `pointSampleLoading: "worker"` so COPC point-data reads and LAZ decoding run in a Web Worker when the browser supports it. If worker creation is unavailable, `CopcSource` falls back to the existing main-thread point sampling path. Worker point sampling uses a small concurrency limit so camera-driven requests do not all dispatch at once. Point sample APIs accept an `AbortSignal`; the basic viewer aborts stale camera-stream point reads when a newer camera request starts.
The basic viewer also warms the point-sample worker pool and integrated geometry worker pool when a COPC source is opened, so the first zoom or pan does not pay worker startup cost on top of range reads and decoding. Worker pool sizing is capped for interactive camera streaming: the helper falls back to four point-sample workers and five geometry workers, caps point-sample concurrency at six, caps integrated geometry concurrency at eight, reserves browser capacity for rendering, and avoids unbounded worker creation on high-core machines. Integrated geometry workers prefer decoded-node affinity so repeated zoom/pan density upgrades reuse worker-local decoded COPC views when that worker is available. The worker-pool helper uses a 120 ms decoded-worker fallback delay for the basic viewer, which avoids the measured duplicate-decode cost of immediate fallback while preventing one busy cached worker from holding the foreground detail pass for too long.

Included example presets:

- Autzen classified: EPSG:2992 sample handled by the default transform.
- SoFi Stadium: EPSG:32611 sample detected automatically from its compound WKT metadata.

## API Sketch

```ts
import {
  CesiumBufferPointRenderer,
  CesiumPointPrimitiveRenderer,
  CesiumPrimitivePointRenderer,
  CopcPointCloudLayer,
  createCopcCameraStreamLodSettings,
  createCopcCameraStreamPrefetchSettings,
  createDefaultCopcCoordinateTransforms,
} from "copc-cesium";

const layer = new CopcPointCloudLayer(viewer.scene, {
  url, // or source: fileOrBlob,
  maxCachedHierarchyPages: 64,
  maxCachedHierarchyPageBytes: 16 * 1024 * 1024,
  maxCachedSampleSets: 32,
  maxCachedPointSampleBytes: 32 * 1024 * 1024,
  maxConcurrentPointSampleWorkerRequests: 3,
  maxDecodedPointDataViewsPerWorker: 48,
  maxDecodedPointDataViewBytesPerWorker: 192 * 1024 * 1024,
  pointSampleLoading: "worker",
  pointGeometryLoading: "integrated-worker",
  maxConcurrentPointGeometryWorkerRequests: 6,
  createPointRenderer: (scene) => new CesiumPrimitivePointRenderer(scene),
  // Stable fallback:
  // createPointRenderer: (scene) => new CesiumPointPrimitiveRenderer(scene),
  // Experimental comparison backend:
  // createPointRenderer: (scene) => new CesiumBufferPointRenderer(scene),
  coordinateTransforms: createDefaultCopcCoordinateTransforms,
});
const { hierarchy, coordinateTransform } = await layer.load();

const nodeResult = await layer.renderNode(hierarchy.nodes[0].key);
console.log(nodeResult.renderStats.rendererSetPointsMilliseconds);
await layer.loadNextHierarchyPage();
await layer.expandHierarchyForCamera({ camera: viewer.camera, maxPages: 2 });
const abortController = new AbortController();
await layer.renderAutomatic({
  camera: viewer.camera,
  selectionMode: "coverage",
  maxNodes: 64,
  targetNodeScreenPixels: 120,
  maxRenderedPointCount: 240_000,
  signal: abortController.signal,
  maxViewAngleDegrees: 80,
  targetPointSpacingScreenPixels: 4,
  maxNodePointDataLength: 2_000_000,
  maxTotalPointDataLength: 128_000_000,
});

const streamLod = createCopcCameraStreamLodSettings({
  cameraHeightMeters: viewer.camera.positionCartographic.height,
  qualitySettings: {
    cameraStreamMaxRenderedPointCount: 360_000,
    cameraStreamMaxSourcePointCount: 900_000,
    cameraStreamMaxNodePointCount: 80_000,
    cameraStreamMaxPointDataLength: 16 * 1024 * 1024,
    cameraStreamMaxNodePointDataLength: 2 * 1024 * 1024,
    cameraStreamMaxNodes: 96,
    cameraStreamMaxDepth: 5,
    cameraStreamTargetNodeScreenPixels: 80,
    cameraStreamTargetPointSpacingScreenPixels: 4,
  },
});
const streamMaxPointCountPerNode = 2_500;
const prefetchBudget = createCopcCameraStreamPrefetchSettings({
  nodeCount: 48,
  basePointCountPerNode: 2_000,
  baseMaxRenderedPointCount: 96_000,
  minPointCountPerNode: streamMaxPointCountPerNode,
  minRenderedPointCount: 48 * streamMaxPointCountPerNode,
  lodSettings: streamLod,
});
const selection = await layer.selectNodesForCamera({ camera: viewer.camera });
await layer.prefetchNodePointGeometryBatches(
  selection.nodes.map((node) => node.key),
  {
    maxPointCountPerNode: prefetchBudget.maxPointCountPerNode,
    maxConcurrentRequests: 4,
    requestPriority: -1_000,
  },
);
const hierarchyCacheStats = layer.source.getHierarchyCacheStats();
const cacheStats = layer.source.getPointSampleCacheStats();
layer.clearPointSampleCache();

layer.destroy();
```

## Coordinate Transforms

`core` keeps COPC point samples in their source XYZ coordinates. Cesium-facing code converts those coordinates through a `coordinateTransforms` hook on `CopcPointCloudLayer`.

The default transform supports geographic coordinates, the public Autzen EPSG:2992 sample, and projected COPC sources with proj4-compatible WKT metadata. For compound WKT, it extracts the horizontal CRS for XY conversion and keeps the vertical unit scale for height conversion.
`layer.load()` returns a `coordinateTransform` status so examples and applications can show whether the active transform is `geographic`, `epsg:2992`, `wkt`, or `custom`, and whether camera-based selection is available.
For missing, malformed, grid-dependent, or application-specific CRS data, `createProj4CoordinateTransforms({ sourceCrs, sourceDefinition })` creates an explicit `coordinateTransforms` override backed by `proj4`.
In the basic viewer, custom URLs use WKT auto-detection when the Source CRS field is empty. If Source CRS is filled, the viewer uses the explicit proj4-backed override instead.

## Project Documents

- [API](docs/API.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Performance Notes](docs/PERFORMANCE.md)
- [Contributing](CONTRIBUTING.md)
- [License](LICENSE)

## Planned Shape

```text
src/index.ts           Public source entry point
src/core/              COPC loading and point data preparation
src/cesium/            CesiumJS rendering and coordinate conversion
examples/basic-viewer/ Minimal runnable example
```
