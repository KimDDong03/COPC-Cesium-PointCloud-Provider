# Architecture

`copc-cesium` is a TypeScript library prototype for loading COPC point cloud data directly into CesiumJS.

The library is intentionally not a standalone viewer product. The example app exists to prove and demonstrate the reusable API.

## Goals

- Open a COPC file or URL in the browser.
- Inspect COPC metadata and hierarchy.
- Read selected point-data nodes with HTTP range requests.
- Convert COPC source coordinates into Cesium-friendly longitude, latitude, and height.
- Render sampled points in a Cesium scene.
- Provide a small Cesium-facing API that can grow into a reusable layer or primitive.

## Non-Goals

- No COPC-to-3D-Tiles conversion pipeline.
- No live LiDAR or sensor ingestion.
- No general point cloud editing/viewer application.
- No full production LOD, byte-based cache policy, worker pool, or low-level custom draw-command engine in the first milestone.

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
COPC URL
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

In this prototype, streaming means loading COPC hierarchy and point-data byte ranges on demand as the camera or selected node set changes.

The current implementation includes:

- `CopcSource.loadHierarchyPage` and `loadNextHierarchyPage` for on-demand COPC hierarchy page range reads.
- Hierarchy node and pending-page provenance tracking via the source hierarchy page ID, plus bounded hierarchy page eviction that restores evicted non-root leaf pages back to pending page references.
- `selectHierarchyPagesForTarget` for choosing nearby pending hierarchy pages from their octree bounds.
- `CopcSource` point sample caching by node key and sample count, with bounded LRU sample-set and estimated decoded-byte limits.
- `CopcPointCloudLayer.selectNodesForCamera` first culls requested-depth hierarchy node bounds with the Cesium camera frustum, then `selectHierarchyNodesForCamera` applies per-depth nearest-node screen-size estimates, COPC spacing-derived point spacing screen estimates, broad view-direction fallback culling, optional coverage-oriented node ordering, and optional point-count and point-data byte budgets.
- `CopcPointCloudLayer.expandHierarchyForCamera` for camera-targeted hierarchy expansion.
- `CopcPointCloudLayer.renderAutomatic` for selecting and rendering nodes in one call.
- `CopcPointCloudLayer.selectNodesForCamera` for selecting nodes without immediately rendering.
- Multi-node render budgets via `maxRenderedPointCount`, which cap total sampled points submitted to Cesium across selected nodes.
- Optional `pointSampleLoading: "worker"` support that moves COPC point-data reads and LAZ decoding into a Web Worker, with main-thread fallback when a worker cannot be created.
- A small `maxConcurrentPointSampleWorkerRequests` queue so worker-backed point sampling applies request backpressure before dispatch.
- `AbortSignal` support for point-sample loading and Cesium render calls so stale camera-stream worker requests can be canceled and late worker responses ignored.
- A `CopcPointCloudRenderer` interface with `CesiumPrimitivePointRenderer` as the default typed-array Cesium `Primitive` implementation, plus `CesiumPointPrimitiveRenderer` as the stable `PointPrimitiveCollection` fallback and `CesiumBufferPointRenderer` as an experimental `BufferPointCollection` comparison backend. `CesiumPointRenderer` remains as a compatibility alias.
- `renderStats` on Cesium layer render results for CPU-side coordinate transform timing, renderer submission timing, bounds submission timing, rendered point count, and estimated coordinate/color payload bytes.
- Example quality presets for changing `maxPointCountPerNode`, Auto LOD coverage budget, camera-stream point budget, and renderer point size together, plus manual controls for renderer benchmark runs.
- Example controls for changing the camera-stream point budget independently from the initial node sample budget.
- `benchmark:smoothness` for moving the Cesium camera while camera streaming is enabled and recording browser frame intervals plus selected depth, hierarchy expansion, hierarchy UI application, node selection, point rendering, and total stream-update timing across multiple samples and stream point budgets.
- Example-only `Stream on camera move` behavior that renders from the currently loaded hierarchy, selects coverage nodes through depth 3 in Balanced detail mode, queues one background camera-targeted hierarchy prefetch at a time, and avoids rebuilding the full node dropdown during the stream update.

The current streaming behavior still limits the number of hierarchy pages opened per camera update, but default node selection now prioritizes filling the visible COPC footprint over selecting only the closest nodes.

## Coordinate Transforms

`src/core` keeps points in source COPC XYZ coordinates. `src/cesium` converts them through a `coordinateTransforms` hook.

Available prototype paths:

- Geographic coordinates.
- Built-in EPSG:2992 handling for the public Autzen sample.
- `createProj4CoordinateTransforms` for projected CRS data when a proj4 definition is provided.

Camera-based selection requires both directions:

- `toCesium` for rendering source points.
- `toCopc` for mapping the Cesium camera position back to COPC source coordinates.

## Current Limitations

- Hierarchy page expansion and node selection are camera-targeted; node selection now supports both nearest-node and coverage-oriented ordering, but the screen-space error estimate is not yet calibrated against point-density metrics.
- Hierarchy page eviction is page-count based and deliberately keeps the root hierarchy page loaded; it is not byte-aware yet.
- Point rendering defaults to a typed-array Cesium `Primitive`, but it still rebuilds one full primitive per submitted point set and still performs coordinate conversion on the main thread.
- The point renderer boundary exists and has three backends. The typed-array primitive backend now reduces per-point Cesium object submission, but it still needs larger-dataset validation beyond the repeatable prototype benchmark before it should be treated as production-stable.
- Renderer timing currently measures browser CPU-side submission work. The smoothness benchmark measures browser frame intervals and stream-stage timing during camera movement, but it is still not a full GPU profiler.
- Renderer payload bytes are an estimated coordinate/color payload size, not full JavaScript heap or GPU memory usage.
- Point sample cache byte usage is estimated from decoded sample fields, not from JavaScript object heap size.
- Worker loading currently targets point data only; hierarchy metadata selection and cache policy remain on the main thread.
- Worker cancellation is request-level. It prevents stale responses from being applied and drops queued stale work before dispatch, but it does not yet interrupt every in-flight COPC range read inside lower-level dependencies.
- Camera streaming is prototype-oriented; it prefetches hierarchy pages in the background, selects a bounded coverage set of depth-3-or-shallower nodes by default, and applies configurable render-point budgets. The smoothness benchmark covers multiple bundled sample paths, but the higher-density defaults still need calibration against larger external COPC samples and repeated frame-time measurements.
- CRS detection is not complete; projected CRS data should pass explicit transform options.

## Near-Term Roadmap

1. Run the browser smoothness benchmark against larger external COPC samples.
2. Validate the higher-density depth-3 camera-stream setting against larger external COPC samples.
3. Calibrate screen-space error estimates and default render-point budgets against the measured frame-time data.
4. Tune worker concurrency defaults and add worker-pool support if one worker becomes a bottleneck.
5. Compare repeatable larger-point-count benchmark results across more COPC samples and decide whether the typed-array primitive should be split into reusable buffers, worker-prepared payloads, or a lower-level custom draw path.
