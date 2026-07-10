# Architecture

`copc-cesium` is a pre-1.0 TypeScript library for loading COPC point cloud data directly into CesiumJS.

The library is intentionally not a standalone viewer product. The example app exists to prove and demonstrate the reusable API.

## Goals

- Open a COPC file or URL in the browser.
- Inspect COPC metadata and hierarchy.
- Read selected point-data nodes with HTTP range requests or browser Blob byte
  slices.
- Convert COPC source coordinates into Cesium-friendly longitude, latitude, and height.
- Render sampled points in a Cesium scene.
- Provide reusable low-level source/renderer APIs and a high-level Cesium camera-stream controller.

## Non-Goals

- No COPC-to-3D-Tiles conversion pipeline.
- No live LiDAR or sensor ingestion.
- No general point cloud editing/viewer application.
- No persistent/offline cache, COPC editing, non-COPC format adapter, or application-specific styling system.

## Layers

```text
src/core/
  COPC metadata, hierarchy, range reads, point sample preparation, cache state

src/cesium/
  Cesium scene integration, coordinate transforms, point renderer boundary, bounds rendering

examples/basic-viewer/
  Minimal browser demonstration of the reusable library
```

## Data Flow

```text
COPC URL/File/Blob
-> CopcSource
-> COPC metadata and loaded hierarchy pages
-> optional camera-targeted hierarchy page expansion
-> selected hierarchy node keys
-> range-read point data
-> sampled source XYZ points
-> coordinate transform
-> Cesium typed-array Primitive, PointPrimitiveCollection, or experimental BufferPointCollection
```

## Streaming Semantics

In this library, streaming means loading COPC hierarchy and point-data byte
ranges on demand as the camera or selected node set changes. Remote URLs use
HTTP `Range` requests, while browser-selected files use `Blob.slice` through
the same `CopcSource` getter boundary.

The current implementation includes:

- `createCopcRangeGetter` and `createHttpRangeGetter` wrap exact byte-range
  reads in a small bounded cache. This coalesces duplicate in-flight reads and
  returns copied cached bytes for repeated metadata, hierarchy, or point-data
  ranges while preserving the fail-fast HTTP `206 Partial Content` requirement.
- `CopcSource.loadHierarchyPage` and `loadNextHierarchyPage` for on-demand COPC hierarchy page range reads from URL or Blob-backed sources.
- Hierarchy node and pending-page provenance tracking via the source hierarchy page ID, plus bounded page-count and byte-aware hierarchy page eviction that restores evicted non-root leaf pages back to pending page references.
- `selectHierarchyPagesForTarget` for choosing nearby pending hierarchy pages from their octree bounds.
- `CopcSource` point sample caching by node key and sample count, with bounded LRU sample-set and estimated decoded-byte limits.
- `CopcPointCloudLayer.selectNodesForCamera` first culls requested-depth hierarchy node bounds with the Cesium camera frustum, then `selectHierarchyNodesForCamera` applies per-depth nearest-node screen-size estimates, COPC spacing-derived point spacing screen estimates, broad view-direction fallback culling, optional coverage-oriented node ordering, optional progressive coverage/detail mixing, and optional point-count and point-data byte budgets.
- `CopcPointCloudLayer.expandHierarchyForCamera` for camera-targeted hierarchy expansion.
- `CopcPointCloudLayer.renderAutomatic` for selecting and rendering nodes in one call.
- `CopcPointCloudLayer.selectNodesForCamera` for selecting nodes without immediately rendering.
- `CopcPointCloudLayer.prepareNodes` for warming selected node data and worker-prepared geometry caches without changing the currently rendered Cesium primitives.
- Transfer-only retained node results from integrated geometry workers are treated as cache references. If the matching prepared geometry batch has been evicted, the layer falls back to reloading that node instead of trying to render an empty payload.
- Multi-node render budgets via `maxRenderedPointCount`, which cap total sampled points submitted to Cesium across selected nodes.
- Optional `pointSampleLoading: "worker"` support that moves COPC point-data reads and LAZ decoding into a Web Worker, with main-thread fallback when a worker cannot be created.
- A small `maxConcurrentPointSampleWorkerRequests` queue so worker-backed point sampling applies request backpressure before dispatch.
- `AbortSignal` support for point-sample loading and Cesium render calls so stale camera-stream worker requests can be canceled and late worker responses ignored.
- Progressive camera-stream renders can stop through a `shouldStopAfterProgress` policy once the current view has enough detail. By default the layer aborts remaining node loads for that render pass, but camera streams can opt into `continueLoadingAfterStop` so the foreground response is considered complete while already queued same-view detail continues filling worker and geometry caches. `postStopProgressMode: "load-only"` lets that tail work warm caches without forcing an additional Cesium scene submission during the same camera update.
- A `CopcPointCloudRenderer` interface with `CesiumPrimitivePointRenderer` as the default typed-array Cesium `Primitive` implementation, plus `CesiumPointPrimitiveRenderer` as the stable `PointPrimitiveCollection` fallback and `CesiumBufferPointRenderer` as an experimental `BufferPointCollection` comparison backend. `CesiumPointRenderer` remains as a compatibility alias.
- `renderStats` on Cesium layer render results for CPU-side coordinate transform timing, renderer submission timing, bounds submission timing, rendered point count, estimated coordinate/color payload bytes, aggregate worker timing, and slowest per-node worker timing records.
- Example quality presets for changing `maxPointCountPerNode`, Auto LOD coverage budget, camera-stream point budget, and renderer point size together, plus manual controls for renderer benchmark runs.
- Example controls for changing the camera-stream point budget independently from the initial node sample budget.
- `benchmark:smoothness` for moving the Cesium camera while camera streaming is enabled and recording browser frame intervals plus selected depth, current-view node coverage, hierarchy expansion, hierarchy UI application, node selection, point rendering, and total stream-update timing across multiple samples and stream point budgets.
- `CopcPointCloudCameraStream` as a reusable high-level Cesium camera binding with debouncing, stale-request cancellation, height-based LOD budgets, hierarchy expansion, and progressive current-view rendering.
- The basic viewer layers custom preview, retained-node reuse, completion, and predictive-prefetch policies on the lower-level camera-stream helpers. Its initial Auto LOD path also applies quality-specific hierarchy expansion, per-node point-count and compressed point-data caps, starts with a lightweight preview, and starts background camera prefetch after its detail pass succeeds, so the first zoom or pan after load can reuse prepared current-view geometry.

The current streaming behavior still limits the number of hierarchy pages opened per camera update, but default node selection now prioritizes filling the visible COPC footprint over selecting only the closest nodes.

## Coordinate Transforms

`src/core` keeps points in source COPC XYZ coordinates. `src/cesium` converts them through a `coordinateTransforms` hook.

Available transform paths:

- Geographic coordinates.
- Built-in EPSG:2992 handling for the public Autzen sample.
- Automatic projected-coordinate handling from proj4-compatible COPC WKT metadata, including horizontal CRS extraction from WKT1 compound coordinate systems and vertical unit scaling.
- `createProj4CoordinateTransforms` for explicit CRS overrides when a source has missing, malformed, or application-specific WKT.

Camera-based selection requires both directions:

- `toCesium` for rendering source points.
- `toCopc` for mapping the Cesium camera position back to COPC source coordinates.

## Current Limitations

- Hierarchy page expansion and node selection are camera-targeted; node selection now supports nearest-node ordering, complete-depth coverage, and progressive coverage/detail mixing, but the screen-space error estimate is not yet calibrated against point-density metrics.
- Hierarchy page eviction is page-count and byte-limit based, and deliberately keeps the root hierarchy page loaded even if the root page alone exceeds the configured byte limit.
- Point rendering defaults to a typed-array Cesium `Primitive`. Worker-prepared geometry batches are submitted as stable per-node primitives by default so progressive camera updates do not rebuild earlier completed nodes. The main-thread point-sample fallback still performs coordinate conversion on the main thread, and the typed-array primitive path still relies on Cesium primitive creation rather than a reusable low-level draw-command buffer.
- The point renderer boundary has three backends. The typed-array primitive backend reduces per-point Cesium object submission and is covered by repeatable Autzen and 364-million-point SoFi source benchmarks, but broader device, browser, CRS, and dataset diversity is still required before a 1.0 stability claim.
- Renderer timing currently measures browser CPU-side submission work. The smoothness benchmark measures browser frame intervals and stream-stage timing during camera movement, but it is still not a full GPU profiler.
- Renderer payload bytes are an estimated coordinate/color payload size, not full JavaScript heap or GPU memory usage.
- Point sample cache byte usage is estimated from decoded sample fields, not from JavaScript object heap size.
- Worker loading currently targets point data and worker-prepared Cesium geometry; hierarchy metadata selection remains on the main thread.
- Worker cancellation is request-level for queued work and configurable for active integrated COPC geometry work. The default `"soft"` mode preserves a worker and ignores stale responses after the in-flight decode finishes; `"terminate-uncached"` terminates only active workers that have not retained decoded node data, while soft-canceling cache-owning workers so repeated zoom/pan work can reuse decompressed COPC nodes; `"terminate"` always stops the active worker so newer current-view work can start sooner, at the cost of dropping that worker's decoded cache. Queued integrated geometry requests can also carry a `requestPriority`, which the basic viewer uses to keep current-view camera work ahead of background prefetch and retained stale work. Integrated geometry queue dispatch is microtask-batched, so same-tick current-view detail requests can outrank lower-priority warmup requests before either one occupies an idle worker. The pool coalesces identical in-flight integrated geometry requests before they reach a worker, preserving per-caller abort handling while avoiding duplicate decode and geometry work for the same node/sample/transform request. Compatible same-node requests can also share a denser in-flight geometry task; queued lower-density work is upgraded when denser current-view detail arrives before dispatch, and lower-density callers receive a downsampled result.
- Point-sample workers and integrated COPC geometry workers keep an LRU cache of decoded point-data views. Both worker pools prefer the worker that already owns a decoded view when possible, while allowing unrelated queued nodes to continue dispatching in parallel. Integrated geometry requests use `decodedNodeWorkerFallbackDelayMilliseconds` to choose between current-view latency and strict decoded-cache affinity when that preferred worker is busy with another node; the low-level pool default keeps strict affinity, while `createCopcWorkerPoolSettings()` returns a 120 ms fallback delay for the browser demo after benchmarked immediate fallback increased duplicate decompression. Duplicate active same-node requests still coalesce/wait instead of decompressing the same node twice. Both queued paths honor `requestPriority`, so current-view point reads stay ahead of retained background or warmup work even when the Cesium layer is using the non-integrated sample path. They also coalesce compatible queued same-node density upgrades where a denser request can serve lower-density callers with a downsampled result, and that upgrade is priority-aware so lower-priority dense work cannot delay a higher-priority quick current-view fill. The default decoded-view cache limit is conservative, while applications can raise `maxDecodedPointDataViewsPerWorker` and `maxDecodedPointDataViewBytesPerWorker` when repeated zoom/pan responsiveness is more important than memory. Worker pool sizing is deliberately interactive-first for browser responsiveness: `createCopcWorkerPoolSettings()` keeps browser-derived point-sample concurrency capped at six workers and integrated COPC geometry concurrency capped at eight workers while reserving browser capacity for Cesium rendering. This avoids saturating high-core machines with LAZ decompression when the current view needs a fast visible refinement instead of maximum background throughput.
- Camera streaming is bounded and regression-tested; it prefetches hierarchy pages in the background, progressively prepares likely next-view COPC geometry without changing the rendered scene, selects a bounded progressive coverage/detail set for the current view, and applies configurable render-point budgets. The basic viewer invalidates stale camera renders immediately, then keeps overlapping previous node-family work alive for only a bounded grace period so near-finished work can populate caches without letting the previous view occupy worker slots for several seconds. Unrelated stale work is aborted immediately. Background prefetch retains completed node results as they arrive, so partial idle work can still help the next zoom or pan. Progressive prepare jobs can also keep only a bounded active request window, so cache warming does not enqueue every missing node ahead of a newer current-view request. Initial Auto LOD success also seeds that same prefetch path, and camera streaming queues low-priority predictive prefetch after visible coverage is available. Auto LOD and camera streaming both cap per-node point count and compressed point-data length so one unusually large COPC node is skipped in favor of cheaper visible coverage before a later denser pass can consider it. Camera-stream LOD profiles reduce per-node source caps as the camera gets closer, while keeping the total source and rendered-point budgets high enough for dense current-view refinement. Final-detail planning also carries a separate LOD-specific per-node sample cap, so close zooms can distribute dense samples across the visible node set without one large node taking the whole foreground budget. Preview planning prefers shallow coverage nodes only while they fit the preview byte budget; otherwise it falls back to distributed current-view detail nodes so close zooms do not block on one oversized parent node before detail starts. Close/near detail completion can finish before every target-depth node arrives because the coverage preview remains underneath the detail layer, but the same current-view node coverage threshold is applied even when retained samples or cache hits have already filled most of the point budget. Slow same-view tail nodes continue as cache/detail refinement after the foreground status is published, but are still canceled when the parent camera request is invalidated. Progressive rendering can display lower-density retained results for the same target nodes before replacing them with denser worker results, and can run a bounded lower-priority warmup for current-view detail nodes so worker-local decoded point-data views are reused. Foreground final-detail rendering keeps only a runtime-configured bounded window of missing nodes active, capped by the integrated geometry worker count, so not-yet-started tail nodes do not occupy worker queues after a later camera move invalidates the view. Capped preview, warmup, and background prefetch subsets are selected across the full ordered node range instead of from the first contiguous prefix, and render point budgets are spread across currently renderable current-view nodes before remaining points go to background coverage. Background prefetch uses the camera-selected source point counts as node weights, so its progressive coverage order warms visually important nodes before tiny tail nodes. The final-detail pass uses the camera-stream selection order by default so active worker windows stay spatially distributed; applications can still opt into source-point-heavy request order for explicit density-first refinement. Defaults remain subject to calibration on additional devices and COPC distributions.
- WKT-backed CRS handling does not download datum grid files. Sources that require external grids or contain unsupported/malformed WKT should pass an explicit application-provided transform.

## Near-Term Roadmap

1. Expand the sample matrix across additional CRS families, COPC producers, browsers, and low-/high-end devices.
2. Calibrate screen-space error estimates and default render-point budgets against measured GPU frame time and memory, not only browser frame intervals.
3. Split the reference viewer's advanced orchestration into smaller example modules without moving application-only policy into the core library.
4. Stabilize the pre-1.0 public API from downstream integration feedback, then define the 1.0 compatibility contract.
