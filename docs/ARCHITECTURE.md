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
- No AWS, CloudFront, S3 operations guidance, CDN/edge server, backend proxy,
  data-hosting product, or other external infrastructure component. Public
  sample URLs are test inputs only, and infrastructure behavior is not used as
  library performance evidence.
- No general offline-package/service-worker system, COPC editing, non-COPC
  format adapter, or application-specific styling system. A validated opt-in
  IndexedDB byte-range cache supports repeat HTTP views as a browser library
  feature, not as cold-start or Eptium-comparison evidence.

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
-> selected frontier (complete-depth default or coverage-preserving mixed-depth opt-in)
-> available additive ancestor closure
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

[COPC](https://copc.io/) uses the [EPT additive octree
model](https://entwine.io/en/latest/entwine-point-tile.html). A child node adds
points; it does not replace the unique points stored in its ancestors. The
terminal scene contract is therefore a frontier plus its complete available
ancestor closure, not a replacement-style leaf set.

The current implementation includes:

- `createCopcRangeGetter` and `createHttpRangeGetter` wrap exact byte-range
  reads in a small bounded cache. This coalesces duplicate in-flight reads and
  returns copied cached bytes for repeated metadata, hierarchy, or point-data
  ranges while preserving the fail-fast HTTP `206 Partial Content` requirement.
  Response bodies must match the requested byte count; an exposed
  `Content-Range` must also match the exact requested range and a valid complete
  length before bytes enter the COPC parser. A configurable 256 MiB default
  single-read ceiling applies before allocation, HTTP requests use a 30 second
  body-inclusive deadline, and Blob reads must stay within the source bounds.
- URL getters can additionally use an opt-in persistent fixed-block cache.
  Strong-ETag mode uses a browser-cache-revalidated probe and validates the
  complete source length before
  reading IndexedDB, removes non-HTTP URL fragments, and keys 64 KiB default
  blocks by an opaque SHA-256 URL identity/validator/range. Missing validation
  headers or storage failures bypass persistence. If Web Crypto cannot create
  the default opaque identity, the persistent path fails closed unless the
  caller supplied a non-secret stable `sourceKey`.
  Application-version mode instead requires an app-owned immutable version and
  authoritative source length. The store is bounded by bytes and entry count,
  returns copied buffers, maintains aggregate accounting without scanning stored
  payloads on every write, and evicts least-recently-used blocks. Persistent
  fetch coalescing remains bounded by the getter's public range ceiling.
  `no-store` disables the getter's in-memory cache, atomically purges every
  validator/version namespace for the stable source identity, and records one
  identity tombstone in IndexedDB. Reads and writes honor that tombstone until
  a fresh strong-validator response re-enables storage. A module-session
  source-policy epoch advances before each source purge, so getters holding an
  older epoch remain network-only after that re-enable and cannot revive stale
  memory or validator state. Re-enable and revoke operations are serialized so
  a racing `no-store` purge is the final policy writer. Custom stores without
  this atomic source-policy contract are rejected. Header policy is applied
  before Range/body/validator validation, including error responses.
- `CopcSource.loadHierarchyPage` and `loadNextHierarchyPage` for on-demand COPC hierarchy page range reads from URL or Blob-backed sources.
- Hierarchy node and pending-page provenance tracking via the source hierarchy page ID, plus bounded page-count and byte-aware hierarchy page eviction that restores evicted non-root leaf pages back to pending page references.
- `selectHierarchyPagesForTarget` for choosing nearby pending hierarchy pages from their octree bounds.
- `CopcSource` point sample caching by node key and sample count, with bounded LRU sample-set and estimated decoded-byte limits.
- `CopcSource` retains the parsed cloneable COPC metadata after the first open.
  Point-sample work carries that metadata into a worker's source state, and
  source-aware integrated-geometry warmup seeds every geometry worker with the
  same parsed value. Integrated-geometry load and prefetch requests carry it as
  well, covering callers that skip explicit warmup and workers created lazily
  later. A supplied value replaces a rejected worker-local bootstrap promise.
  Workers retain the URL/Blob getter for hierarchy and point-data ranges, but no
  longer repeat the LAS/COPC header and VLR bootstrap simply because they run in
  separate global scopes. If no parsed metadata is supplied, the worker
  protocol retains its standalone `Copc.create(getter)` fallback.
- Point-sample and integrated geometry workers use source-aware, worker-global
  decoded-view LRU ledgers. A layer-wide optional byte ceiling is divided across
  both active worker pools, oversized decoded views are used without retention,
  and cache snapshots keep main-thread affinity and telemetry synchronized with
  worker evictions. Each retained node's memory estimate includes a cached
  `Uint32Array` spatial order at exactly 4 bytes per decoded point.
- `CopcPointCloudLayer.selectNodesForCamera` first culls requested-depth
  hierarchy node bounds with the Cesium camera frustum. The eight-corner
  transformed `BoundingSphere` is cached in a `WeakMap` by immutable hierarchy
  node identity, so repeated selections reuse coordinate transforms while each
  call still executes the current camera-frustum test. After culling,
  `selectHierarchyNodesForCamera` uses the viewport-center COPC target for node
  priority and the separate camera-eye COPC position for per-depth projected
  size and spacing estimates. It then applies broad view-direction fallback
  culling, coverage-oriented ordering, and optional point-count and point-data
  byte budgets. Coverage selection defaults to the deepest complete same-depth
  set that fits. Mixed-depth selection is explicit: it reserves a visible
  baseline and its additive closure, then refines only complete groups of
  immediate visible siblings so a budget-limited branch retains its parent.
  The trigger compares the current frontier parent's SSE with the active
  refine/retain hysteresis threshold; children may already be below it because
  they are the finer replacement.
- Camera-stream LOD uses camera height above the highest transformed top corner
  of the loaded COPC bounds, not raw ellipsoid altitude. This keeps the same
  near/close/overview policy meaningful for both sea-level and high-elevation
  datasets, including vertical-unit conversion. Pre-load and custom adapter
  paths keep an absolute-height fallback.
- `CopcPointCloudLayer.expandHierarchyForCamera` for camera-targeted hierarchy expansion.
- `CopcPointCloudLayer.renderAutomatic` for selecting and rendering nodes in one call.
- `CopcPointCloudLayer.selectNodesForCamera` for selecting nodes without immediately rendering.
- `CopcPointCloudLayer.prepareNodes` for warming selected node data and worker-prepared geometry caches without changing the currently rendered Cesium primitives.
- Transfer-only retained node results from integrated geometry workers are treated as cache references. If the matching prepared geometry batch has been evicted, the layer falls back to reloading that node instead of trying to render an empty payload.
- Multi-node render budgets via `maxRenderedPointCount`, which cap total sampled points submitted to Cesium across selected nodes.
- `progressivePointResultBudget` isolates foreground-first fair allocation and
  object/typed/geometry payload limiting from the stateful layer. Its tests
  preserve every typed channel, including Classification and Intensity, when a
  progressive result is truncated to the current render budget. Optional
  source-point weights switch the same three payload paths to a deterministic
  integer weighted water-fill. Per-result availability and per-node caps are
  enforced before leftover budget is redistributed; omitting weights preserves
  the equal-share behavior.
- Optional `pointSampleLoading: "worker"` support that moves COPC point-data reads and LAZ decoding into a Web Worker, with main-thread fallback when a worker cannot be created.
- A small `maxConcurrentPointSampleWorkerRequests` queue so worker-backed point sampling applies request backpressure before dispatch.
- `AbortSignal` support for point-sample loading and Cesium render calls so stale camera-stream worker requests can be canceled and late worker responses ignored.
- `CopcPointCloudLayer.getRendererRevision()` exposes a monotonic revision that
  advances after every successful point-renderer mutation. Application-level
  orchestration can combine it with exact node/density/budget checks to prove
  that a previously committed frame is still resident before skipping an
  equivalent geometry submission.
- Progressive renders expose `shouldStopAfterProgress` as a low-level policy
  hook. With `continueLoadingAfterStop`, `postStopLoadingMode: "await"`, and
  `postStopProgressMode: "render"`, that hook marks interactive readiness while
  the bounded request windows continue and the layer commits one complete final
  render. `"background"` plus `"load-only"` remains available for cache-only,
  explicitly non-terminal workflows.
- A `CopcPointCloudRenderer` interface with `CesiumPrimitivePointRenderer` as the default typed-array Cesium `Primitive` implementation, plus `CesiumPointPrimitiveRenderer` as the stable `PointPrimitiveCollection` fallback and `CesiumBufferPointRenderer` as an experimental `BufferPointCollection` comparison backend. `CesiumPointRenderer` remains as a compatibility alias.
- The package peer floor is CesiumJS 1.140.0 because that is where the
  statically exported experimental `BufferPointCollection` API first exists;
  the package-consumer smoke pins that lower bound so the declared range is
  executable rather than aspirational.
- `renderStats` on Cesium layer render results for CPU-side coordinate transform timing, renderer submission timing, bounds submission timing, rendered point count, estimated coordinate/color payload bytes, aggregate worker timing, and slowest per-node worker timing records.
- Example quality presets for changing `maxPointCountPerNode`, Auto LOD coverage
  budget, camera-stream point budget, bounded adaptive splat sizing, splat
  footprint/coverage, scene FXAA, temporal safe-swap, and EDL together, plus
  manual controls for renderer benchmark runs.
- Example controls for changing the camera-stream point budget independently from the initial node sample budget.
- `benchmark:smoothness` for moving the Cesium camera while camera streaming is enabled and recording browser frame intervals plus selected depth, current-view node coverage, hierarchy expansion, hierarchy UI application, node selection, point rendering, and total stream-update timing across multiple samples and stream point budgets.
- `CopcPointCloudCameraStream` as a reusable high-level Cesium camera binding
  with debouncing, stale-request cancellation, height-based LOD budgets,
  hierarchy expansion, complete-depth coverage selection, and additive ancestor
  inclusion by default.
- An internal, headless `CopcCameraStreamEngine` boundary that prepares one
  camera snapshot by expanding hierarchy pages, selecting the frontier, and
  creating its additive render plan and source-point weights before invoking
  `runCopcCameraStreamTerminalRender()`. The public camera binding owns Cesium
  event lifecycle and compatibility fallback; the engine owns neither DOM state
  nor example-specific scheduling and is not exported from the package barrel.
- The basic viewer layers a quick preview, retained-node reuse, interactive
  readiness, exact terminal composition, and predictive-prefetch policies on
  the same render-plan, source-weight, visual-quality, and terminal-executor
  primitives used by the internal engine. Its DOM status, retained-request,
  adaptive-budget, and predictive-prefetch policies stay application-owned.
  Its initial Auto LOD path also applies quality-specific hierarchy expansion
  and per-node point-count and compressed point-data caps, then starts
  background prefetch after visible work succeeds.
  Unlike the public high-level controller's complete-depth default, the viewer
  explicitly selects a coverage-preserving mixed-depth antichain and validates
  that terminal mode separately.
  Before each new render-capable request it aborts all superseded render
  requests, because late progress from an older request could otherwise mutate
  the shared renderer even when publication is rejected. Load-only prefetch is
  the only overlap allowed to survive. An exact committed terminal frame can be
  retained when its layer, renderer revision, node set, density, and budgets all
  still match, or when its completed weighted render signature matches the new
  plan. A relevant but lower-density committed frame can be retained explicitly
  as progress without changing the committed terminal contract while density
  continues loading. Retained-frame predictive prefetch is skipped during active
  movement and delayed by at least 350 ms after movement settles.
- The high-level camera binding and reference viewer implement temporal LOD as
  a renderer-mutation gate rather than a second point-cloud layer. When the
  renderer revision proves that the last frame is still resident, the first
  progressive replacement must contain the full coarse coverage baseline, at
  least 65% source-weighted final-node coverage, and at least 60% of the
  comparable exact-terminal point-count high-water mark. Intermediate frames
  never lower that mark. The terminal candidate bypasses this intermediate
  gate. Camera `changed` and `moveEnd` events abort the old task before debounce,
  preventing a stale callback from overwriting the transition frame while the
  successor request has not started yet.

The current streaming behavior still limits the number of hierarchy pages
opened per camera refinement, but spends that budget across hierarchy levels
revealed by the same camera target before reselecting its frontier. The reusable
high-level controller prioritizes a uniform complete-depth frontier. The
reference viewer explicitly uses required baseline coverage plus atomic
visible-sibling refinements, allowing deeper branches without abandoning the
rest of the visible footprint. Preview and `interactive-ready` states may be
partial; only an exact, stale-free additive composition with no remaining
relevant hierarchy page is terminal.

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

- Hierarchy page expansion and node selection are camera-targeted. Complete-depth
  coverage is the high-level default; nearest-node ordering, overlapping
  progressive coverage, and the stricter baseline-plus-sibling mixed-depth mode
  remain available to low-level callers. The reference viewer opts into the
  stricter mode. The screen-space error estimate is not yet calibrated against
  point-density metrics.
- Hierarchy page eviction is page-count and byte-limit based, and deliberately keeps the root hierarchy page loaded even if the root page alone exceeds the configured byte limit.
- Point rendering defaults to a typed-array Cesium `Primitive`. Worker-prepared
  geometry batches use stable per-node primitives with the renderer API's
  compatibility default. Balanced, detail, and ultra instead merge up to four
  batches: an incomplete progressive tail stays per-node, then a sealed group is
  merged once without rebuilding a growing 1 -> 2 -> 3 -> 4 buffer. COPC spacing
  is converted through the active CRS transform into a per-node metre scale,
  combined with the retained sample ratio, and projected in the vertex shader
  to produce bounded adaptive splats; one common effective spacing is embedded
  as a shader constant, while only mixed-spacing chunks allocate a per-point
  Float32 attribute. Missing metadata retains the fixed-size fallback. The
  compatibility footprint is a screen-facing circle. Balanced and higher
  presets instead construct ECEF-local east/north tangent axes, project a
  world-space disc to a ground-aligned screen ellipse, and apply calibrated
  overlap before the size clamp. Covariance row extents bound the rotated
  ellipse correctly, then 1.25/1/1 CSS-pixel safety halos expand the balanced,
  detail, and ultra axes without raising the bounded base-size clamp. A
  covariance row extents keep grazing projections continuous and bound the
  rotated sprite. The fragment shader reconstructs the ellipse axes and clamps
  only the minor footprint to one pixel instead of falling back to a full
  circle. These splats stay opaque and
  depth-writing. The balanced, detail, and
  ultra presets keep scene FXAA disabled and enable the optional aggregate scene primitive that
  scopes Cesium's runtime point-cloud EDL processor to this renderer's commands;
  unsupported runtimes fall back to direct primitives. The main-thread
  point-sample fallback still performs coordinate conversion on the main thread,
  and the typed-array primitive path still relies on Cesium primitive creation
  rather than a reusable low-level draw-command buffer.
- COPC decode and worker transfer boundaries preserve RGB, Classification, and
  Intensity. Both typed and object renderers share an allocation-free color
  policy: RGB, known ASPRS class color, intensity for unclassified/unknown
  points, neutral gray, then cyan only when no usable attribute exists. A layer
  can instead select elevation coloring: one six-stop viridis-like palette is
  normalized against the file-global source-Z inspection bounds and propagated
  through every main-thread and worker rendering path, avoiding node-local color
  seams. The reference viewer retains the backward-compatible attribute mode by
  default while applications can opt into the elevation style per layer.
- The point renderer boundary has three backends. The typed-array primitive backend reduces per-point Cesium object submission and is covered by repeatable Autzen and 374-million-point USGS 3DEP Millsite source benchmarks, but broader device, browser, CRS, and dataset diversity is still required before a 1.0 stability claim.
- Renderer timing currently measures browser CPU-side submission work. The smoothness benchmark measures browser frame intervals and stream-stage timing during camera movement, but it is still not a full GPU profiler.
- Renderer payload bytes are an estimated coordinate/color payload size, not full JavaScript heap or GPU memory usage.
- Optional eye-dome lighting uses a Cesium runtime export that is not present in
  Cesium's public TypeScript declarations. The adapter is isolated and
  feature-detected with a direct-render fallback, but browser smoke verification
  remains required when upgrading Cesium.
- Point sample cache byte usage is estimated from decoded sample fields, not from JavaScript object heap size.
- Point geometry cache bytes are measured from distinct retained typed-array
  backing buffers. Loaded and transformed entries share one ref-counted ledger,
  so aliases are not double-counted; the basic viewer enforces a 384 MiB
  per-layer hard cap in addition to entry-count limits.
- Worker loading currently targets point data and worker-prepared Cesium geometry; hierarchy metadata selection remains on the main thread.
- With default soft cancellation, integrated geometry workers proxy COPC byte
  reads through one main-thread range broker while LAZ view construction stays
  parallel inside the workers. The pool lazily plans point-data spans up to
  2 MiB and may bridge at most 64 KiB between adjacent ranges. Setting
  `maxCoalescedPointDataRangeGapBytes` to `0` restores exact-contiguous-only
  planning. The span cap bounds the combined request and any deliberate gap
  overfetch; terminating cancellation modes retain direct worker reads so
  termination still stops their network work.
- `rangeGetterOptions` is passed to both `CopcSource` and that shared broker,
  allowing metadata, hierarchy, and brokered point-data blocks to reuse one
  persistent store across new layers or page lifecycles. Direct worker reads
  used by terminating cancellation modes intentionally bypass the main-thread
  IndexedDB cache.
- Worker cancellation is request-level for queued work and configurable for active integrated COPC geometry work. The default `"soft"` mode preserves a worker and ignores stale responses after the in-flight decode finishes; `"terminate-uncached"` terminates only active workers that have not retained decoded node data, while soft-canceling cache-owning workers so repeated zoom/pan work can reuse decompressed COPC nodes; `"terminate"` always stops the active worker so newer current-view work can start sooner, at the cost of dropping that worker's decoded cache. Queued integrated geometry requests can also carry a `requestPriority`, which the basic viewer uses to keep current-view camera work ahead of background prefetch and retained stale work. Integrated geometry queue dispatch is microtask-batched, so same-tick current-view detail requests can outrank lower-priority warmup requests before either one occupies an idle worker. The pool coalesces identical in-flight integrated geometry requests before they reach a worker, preserving per-caller abort handling while avoiding duplicate decode and geometry work for the same node/sample/transform request. Compatible same-node requests can also share a denser in-flight geometry task; queued lower-density work is upgraded when denser current-view detail arrives before dispatch, and lower-density callers receive a downsampled result.
- Point-sample workers and integrated COPC geometry workers keep a source-aware
  LRU cache of decoded point-data views. Both worker pools prefer the worker
  that already owns a decoded view when possible, while allowing unrelated
  queued nodes to continue dispatching in parallel. Integrated geometry
  requests use `decodedNodeWorkerFallbackDelayMilliseconds` to choose between
  current-view latency and strict decoded-cache affinity when that preferred
  worker is busy with another node; the low-level pool default keeps strict
  affinity, and `createCopcWorkerPoolSettings()` now keeps that same default
  for the browser demo after the controlled Eptium request ledger still showed
  duplicate same-node range work with a short fallback delay. Duplicate active
  same-node requests still
  coalesce/wait instead of decompressing the same node twice. Both queued paths
  honor `requestPriority`, so current-view point reads stay ahead of retained
  background or warmup work even when the Cesium layer is using the
  non-integrated sample path. They also coalesce compatible queued same-node
  density upgrades where a denser request can serve lower-density callers with
  a downsampled result, and that upgrade is priority-aware so lower-priority
  dense work cannot delay a higher-priority quick current-view fill. The
  default per-worker decoded-view limit is conservative; applications can add
  `maxDecodedPointDataViewBytesAcrossWorkers` to guarantee a layer-wide
  retained-byte envelope even as worker concurrency changes. Worker pool sizing
  is deliberately interactive-first for browser responsiveness:
  `createCopcWorkerPoolSettings()` keeps browser-derived point-sample
  concurrency capped at six workers and integrated COPC geometry concurrency
  capped at four workers while reserving browser capacity for Cesium rendering
  and per-origin Range traffic. This avoids saturating high-core machines with
  queued remote reads and LAZ decompression when the current view needs a fast
  visible refinement instead of maximum background throughput.
- Camera streaming is bounded and regression-tested. The default terminal plan
  keeps the complete-depth frontier intact, expands it to the available additive
  ancestor closure, orders that closure coarse-to-fine, and distributes the
  render budget across the whole required set. Progressive final-node count and
  per-node caps remain available for explicit preview policies but do not
  truncate a default complete-depth terminal plan.
- Both complete-depth and mixed-depth terminal executors build aligned
  source-point weights from the active hierarchy for every required node,
  including additive ancestors. Their common progressive compositor uses the
  weighted water-fill for object, typed-channel, and integrated-worker results.
  The layer's low-level `useSourcePointBudgetHeadroom` switch is opt-in and
  defaults off, so callers without upstream source accounting retain the legacy
  render-budget-derived load cap.
- The reference viewer's opt-in mixed-depth plan first reserves a visible-tree
  baseline near one level above the target depth plus its complete additive
  closure. Optional refinements are accepted as atomic groups of all immediate
  visible, renderable siblings. The result remains an antichain; if a group does
  not fit the remaining node/point/byte budget, its parent remains the frontier
  for that branch. Because this selector charges the complete additive closure
  against source-point and compressed-byte budgets, its render plan enables
  source headroom: node loads may reach the configured per-node cap while the
  global rendered-point limit is applied during composition. The complete-depth
  default keeps its budget-derived load cap because its selector budgets the
  same-depth frontier before additive ancestors are appended.
- Camera-stream LOD budgets are monotonic from overview to near zoom. Aggregate
  source and compressed-byte budgets can rise with refinement, while an
  individual-node limit is never reduced merely because the camera moved
  closer. This prevents one dense node from rejecting an entire complete-depth
  frontier. The reference viewer also lowers Cesium's camera-change threshold
  and keeps hierarchy expansion off the foreground response path. After that
  fast response owns its terminal composition, background expansion warms the
  hierarchy and geometry caches and queues a bounded same-camera refinement if
  the newly available node set changes. A camera-epoch signature guard prevents
  eviction cycles or no-progress residual pages from spinning indefinitely.
  That signature includes the refined hierarchy depth, so a completed deeper
  pass cannot collide with an earlier complete signature for the same node set
  and lose the final same-camera follow-up.
- The basic viewer publishes a fast preview or retains a revision-proven prior
  frame while a bounded active request window advances. Reaching interactive
  readiness does not end terminal work: remaining windows continue loading.
  Typed terminal geometry uses a final-only commit by default, so the weighted
  full-budget allocation and Cesium primitive upload occur once after all
  required nodes are ready; non-typed renderers retain adaptive incremental
  progress, and low-level callers can explicitly opt typed rendering back into
  that mode. The previous preview/background layer is removed only in the
  complete final commit. The reusable
  `runCopcCameraStreamTerminalRender()` executor owns this bounded terminal pass
  and independently verifies the returned final result; request identity,
  hierarchy expansion, prefetch, and follow-up scheduling remain caller-owned.
  The internal camera-stream engine supplies that executor with the shared
  camera selection, additive render plan, and source-point weights, while the
  basic viewer composes the same primitives with its application-only preview
  and retained-background policies.
  `createCopcCameraStreamVisualQualityState()` rejects a
  frontier with ancestor overlaps, a missing frontier or ancestor node, and any
  stale or unexpected rendered node. The high-level engine also demotes an
  otherwise exact render while a relevant current-view hierarchy page remains
  unopened, then performs bounded same-camera follow-up refinement.
- Background hierarchy expansion, warmup, and predictive geometry prefetch
  remain cache-only optimizations. The viewer prioritizes current-view requests,
  aborts unrelated stale work, and retains only bounded overlapping work for a
  short grace period. Render-capable superseded work is never retained; the
  grace period applies only to load-only overlap. Predictive prefetch after an
  exact retained render is suppressed during active movement and delayed by at
  least 350 ms after it stops. When a committed renderer revision is still
  current, the reference viewer also keeps that world-space point frame stable
  during camera motion while the new current-view plan warms through cache-only
  prefetch. `moveEnd` cancels the last in-motion render-capable request before
  the settled request takes ownership, so small pans and zooms do not repeatedly
  replace full-budget Cesium primitives. If the settled plan is unchanged, the
  committed frame is retained exactly; otherwise one settled replacement
  converges to the new additive set. Moving selections keep the mixed-depth
  refine/retain hysteresis band. Settled selections collapse both thresholds to
  the band's 75% retention edge, so the same pose converges to the same denser
  frontier regardless of whether hierarchy and geometry arrived through a fast
  cache path or a slower retained-request sequence. Decoded-node XYZ is quantized to 10 bits per axis,
  ordered by a stable four-pass Morton radix sort, then traversed with a centered
  bit-reversal permutation. Every lower density is therefore a nested,
  spatially distributed prefix of the denser result. Workers cache that order
  once per retained decoded node, with its exact 4-byte-per-point `Uint32Array`
  cost included in the decoded-view limit. These policies remain subject to calibration on more devices and COPC
  distributions.
- WKT-backed CRS handling does not download datum grid files. Sources that require external grids or contain unsupported/malformed WKT should pass an explicit application-provided transform.

## Near-Term Roadmap

1. Expand the sample matrix across additional CRS families, COPC producers, browsers, and low-/high-end devices.
2. Calibrate screen-space error estimates and default render-point budgets against measured GPU frame time and memory, not only browser frame intervals.
3. Split the reference viewer's advanced orchestration into smaller example modules without moving application-only policy into the core library.
4. Stabilize the pre-1.0 public API from downstream integration feedback, then define the 1.0 compatibility contract.
