# Performance Notes

`copc-cesium` is pre-1.0, so performance claims are backed by
repeatable browser measurements instead of fixed guarantees.

## Smoothness Benchmark

Run:

```bash
npm run benchmark:smoothness
```

The benchmark builds the basic viewer, opens each configured COPC sample in a
real browser, enables `Stream on camera move`, changes the camera-stream point
budget, moves the Cesium camera, and records `requestAnimationFrame` intervals
plus first foreground response and stream-stage timing.

The result is written to:

```text
output/smoothness-benchmark/smoothness.json
```

`benchmark:smoothness:*` QC presets preserve named evidence such as
`smoothness-contest.json`, `smoothness-cold-detail.json`, and
`smoothness-warm-zoom-detail.json` with matching `-assertion.json` reports, so
one release gate cannot overwrite another preset's result.

Package smoke also caps the compressed npm tarball at 600 KiB and each packed
worker JavaScript asset at 600 KiB. The integrated COPC geometry worker is
deliberately emitted as a separate worker asset; keeping a hard ceiling catches
dependency or bundling regressions without disguising Vite's raw chunk warning.

The JSON includes `browserGraphics` with the WebGL vendor, renderer, and version.
The benchmark launch requests Chromium's high-performance adapter; the recorded
renderer remains the source of truth because headless or GPU-limited systems may
fall back to another hardware adapter or software rendering.

To require a specific adapter for a local gate, set a case-insensitive regular
expression before running the QC command:

```powershell
$env:COPC_SMOOTHNESS_ASSERT_GPU_PATTERN="NVIDIA GeForce RTX 3060"
npm run benchmark:smoothness:contest
```

Regression reports require matching `browserGraphics.renderer` values by
default, preventing results from different GPUs from being treated as a valid
before/after comparison. Set
`COPC_SMOOTHNESS_REGRESSION_REQUIRE_SAME_GPU=0` only for an explicitly
cross-device exploratory comparison.

For a faster regression gate, run:

```bash
npm run benchmark:smoothness:qc
npm run benchmark:smoothness:contest
npm run benchmark:smoothness:cache-reset
npm run benchmark:smoothness:cold-reset
```

The quick QC command runs a short Autzen camera-stream benchmark, writes
`output/smoothness-benchmark/smoothness.json`, then validates it with
`scripts/assert-smoothness-benchmark.mjs`. The assertion report is written to:

```text
output/smoothness-benchmark/smoothness-assertion.json
```

When tuning worker scheduling or LOD policy, compare the new assertion report
against a saved baseline instead of relying only on the absolute pass/fail
thresholds:

```bash
npm run benchmark:smoothness:regression -- output/baselines/smoothness-assertion.json
```

`scripts/assert-smoothness-regression.mjs` groups runs by sample and stream
budget, then checks that average FPS, p95/max frame time, frames over 50 ms,
camera-stream first response, camera-stream total time, geometry queue time,
rendered point count, and current-view node coverage have not regressed beyond
the configured tolerance. This catches changes that still satisfy the broad QC
thresholds but make the Cesium camera stream visibly slower.

The contest QC preset uses the same gate but includes both Autzen and SoFi at a
20,000-point camera-stream budget. This keeps the faster day-to-day check
available while still making the heavier projected-coordinate sample part of
the stricter release path.

The cache-reset preset clears retained camera-stream state before each SoFi
camera movement run while keeping layer-level point samples, prepared point
geometry, and worker-local decoded COPC node caches alive. Already-open COPC
metadata, hierarchy pages, prepared Cesium geometry, and worker decoded views
stay loaded. This is not a full first-page cold-start benchmark or a forced
worker/cache reset; it is meant to catch regressions in repeat zoom/pan recovery
when previously decoded and prepared COPC data should be reused.

The cold-reset preset clears the active layer caches before a SoFi movement run
and measures the first interactive coverage render. It does not wait for every
selected detail node to finish before passing the foreground check. The
background detail stream remains active and keeps refining the same current-view
node set, so this preset separates cold first-display responsiveness from final
density completion.
The default foreground preview caps its compressed COPC point-data read at about
1.1 MB and targets roughly 5,500 rendered coverage points before letting detail
refinement continue in the background.

Default QC thresholds are intentionally about regression detection, not a final
performance guarantee:

| Metric | Default threshold |
| --- | ---: |
| Average FPS | at least 30 |
| p95 frame interval | at most 67 ms |
| Max frame interval | at most 100 ms |
| Frames over 50 ms | at most 10 |
| Camera stream first foreground response | at most 250 ms |
| Camera stream interactive total | at most 250 ms |
| Camera stream final-detail total | at most 1,500 ms quick / 2,500 ms contest |
| End-to-end camera move overrun | at most 2,000 ms quick / 2,500 ms contest |
| Rendered points | at least 10,000 in QC presets |
| Current-view node coverage | at least 90% in QC presets |
| Current-view weighted node coverage | at least 90% in close-detail QC presets |
| Point-geometry worker timing | optional max round-trip/decode/worker/queue gates |
| Selected LOD depth | sample expectation, or override |

The end-to-end overrun gate compares `measuredDurationMilliseconds` with the
configured camera movement duration. It catches cases where the visible stream
status appears fast but the progressive render promise is still blocked by slow
tail nodes.

When `COPC_SMOOTHNESS_WAIT_FOR_FINAL_DETAIL=0`, the benchmark accepts
`Camera stream previewed` and `Camera stream partial render` statuses as the
foreground result. Use that mode only for first-display checks such as
`benchmark:smoothness:cold-reset`; release-oriented detail checks should keep
the default final-detail wait.

The assertion script separates those two modes. The first foreground response
uses `COPC_SMOOTHNESS_ASSERT_MAX_FIRST_RESPONSE_MS` and defaults to the same
value as `COPC_SMOOTHNESS_ASSERT_MAX_INTERACTIVE_STREAM_MS`. Interactive checks
use `COPC_SMOOTHNESS_ASSERT_MAX_INTERACTIVE_STREAM_MS` and still default to the
legacy `COPC_SMOOTHNESS_ASSERT_MAX_STREAM_TOTAL_MS` value. Final-detail checks
use `COPC_SMOOTHNESS_ASSERT_MAX_FINAL_DETAIL_MS`, because remote COPC range
reads plus LAZ decompression can legitimately take longer than the first visible
coverage response even when frame pacing remains smooth.

Higher-density presets also enable point-geometry timing gates with
`COPC_SMOOTHNESS_ASSERT_REQUIRE_GEOMETRY_TIMING=1`. Optional thresholds
`COPC_SMOOTHNESS_ASSERT_MAX_GEOMETRY_ROUNDTRIP_MS`,
`COPC_SMOOTHNESS_ASSERT_MAX_GEOMETRY_DECODE_MS`,
`COPC_SMOOTHNESS_ASSERT_MAX_GEOMETRY_WORKER_MS`,
`COPC_SMOOTHNESS_ASSERT_MAX_GEOMETRY_QUEUE_MS`, and
`COPC_SMOOTHNESS_ASSERT_MAX_AVG_GEOMETRY_QUEUE_MS` catch regressions where
Cesium frames remain smooth but visible COPC nodes are stuck behind slow
range-read, LAZ decode, or worker queue work.

The default frame thresholds are calibrated for short headless/browser smoke
runs, where `requestAnimationFrame` can be quantized around 30 fps even when
COPC streaming is already fast. Stream latency, rendered point count, and
selected LOD depth remain the primary regression checks.

Useful assertion overrides for stricter local runs:

```powershell
$env:COPC_SMOOTHNESS_ASSERT_MIN_AVG_FPS="55"
$env:COPC_SMOOTHNESS_ASSERT_MAX_P95_FRAME_MS="25"
$env:COPC_SMOOTHNESS_ASSERT_MAX_FIRST_RESPONSE_MS="120"
$env:COPC_SMOOTHNESS_ASSERT_MAX_INTERACTIVE_STREAM_MS="120"
$env:COPC_SMOOTHNESS_ASSERT_MAX_FINAL_DETAIL_MS="1500"
$env:COPC_SMOOTHNESS_ASSERT_MAX_MEASURED_DURATION_OVER_MS="1000"
$env:COPC_SMOOTHNESS_ASSERT_MIN_RENDERED_POINTS="200000"
$env:COPC_SMOOTHNESS_ASSERT_MIN_RENDERED_NODE_COVERAGE_RATIO="0.95"
$env:COPC_SMOOTHNESS_ASSERT_MIN_FINAL_NODES="48"
$env:COPC_SMOOTHNESS_ASSERT_MIN_RENDERED_FINAL_NODES="44"
$env:COPC_SMOOTHNESS_ASSERT_MIN_RENDERED_POINTS_PER_FINAL_NODE="2500"
$env:COPC_SMOOTHNESS_ASSERT_REQUIRE_GEOMETRY_TIMING="1"
$env:COPC_SMOOTHNESS_ASSERT_MAX_GEOMETRY_ROUNDTRIP_MS="12000"
$env:COPC_SMOOTHNESS_ASSERT_MAX_GEOMETRY_DECODE_MS="8000"
$env:COPC_SMOOTHNESS_ASSERT_MAX_GEOMETRY_WORKER_MS="8000"
$env:COPC_SMOOTHNESS_ASSERT_MAX_GEOMETRY_QUEUE_MS="12000"
$env:COPC_SMOOTHNESS_ASSERT_MAX_AVG_GEOMETRY_QUEUE_MS="4000"
$env:COPC_SMOOTHNESS_ASSERT_MIN_SELECTED_DEPTH="3"
npm run benchmark:smoothness:qc
```

Useful overrides:

```powershell
$env:COPC_SMOOTHNESS_SAMPLES="autzen-classified,sofi-stadium"
$env:COPC_SMOOTHNESS_POINT_BUDGETS="2500,5000,10000"
$env:COPC_SMOOTHNESS_REPEATS="5"
$env:COPC_SMOOTHNESS_MIN_SELECTED_DEPTH="2"
npm run benchmark:smoothness
```

The bundled smoothness sample cases expect camera streaming to select at least
depth 2, so a run does not pass just because it fell back to a shallower and
cheaper LOD. `COPC_SMOOTHNESS_MIN_SELECTED_DEPTH` can raise, lower, or disable
that global threshold for local experiments.

## Current Local Result

Contest QC checkpoint measured on 2026-07-08 with the typed-array primitive
renderer, a 20,000-point camera-stream budget, 12 camera steps, and the Autzen
classified plus SoFi Stadium samples:

| Sample | Rendered points | Avg FPS | p95 frame | Max frame | Frames > 50 ms | Stream total | Max decode | Current-view coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Autzen classified | 15,064 | 60.0 | 16.80 ms | 16.80 ms | 0 | 271.5 ms | 994.2 ms | 100.0% |
| SoFi Stadium | 20,000 | 60.0 | 16.70 ms | 16.80 ms | 0 | 899.7 ms | 872.3 ms | 100.0% |

This run passed `npm run benchmark:smoothness:contest`. The SoFi result is
still dominated by COPC point-data decompression, not Cesium draw submission:
the renderer timing for the final 20,000 points was effectively 0 ms while the
slowest point-data decode was 872.3 ms.

Measured on 2026-07-01 with the previous point-primitive default:

- Sources: Autzen classified, SoFi Stadium, Custom SoFi URL
- Renderer: `PointPrimitiveCollection`
- Max points / node: 20,000
- Camera steps: 24
- Repeats: 2 per budget

| Sample | Camera stream budget | Rendered points | Avg FPS | p95 frame | Max frame | Frames > 50 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Autzen classified | 2,500 | 2,500 | 59.1 | 16.80 ms | 50.10 ms | 1 |
| Autzen classified | 5,000 | 5,000 | 58.8 | 16.80 ms | 66.60 ms | 1 |
| Autzen classified | 10,000 | 10,000 | 53.9 | 33.30 ms | 100.10 ms | 2 |
| Autzen classified | 20,000 | 20,000 | 44.9 | 33.40 ms | 133.30 ms | 2 |
| SoFi Stadium | 2,500 | 2,500 | 36.6 | 174.95 ms | 250.00 ms | 26 |
| SoFi Stadium | 5,000 | 5,000 | 28.9 | 300.00 ms | 433.40 ms | 25 |
| SoFi Stadium | 10,000 | 10,000 | 19.0 | 441.65 ms | 616.80 ms | 25 |
| SoFi Stadium | 20,000 | 20,000 | 21.8 | 416.60 ms | 616.70 ms | 23 |
| Custom SoFi URL | 2,500 | 2,500 | 36.5 | 166.70 ms | 266.70 ms | 25 |
| Custom SoFi URL | 5,000 | 5,000 | 23.1 | 358.30 ms | 533.30 ms | 26 |
| Custom SoFi URL | 10,000 | 10,000 | 19.6 | 424.95 ms | 600.00 ms | 27 |
| Custom SoFi URL | 20,000 | 20,000 | 15.6 | 449.95 ms | 533.40 ms | 34 |

## Renderer Benchmark Checkpoint

Measured on 2026-07-02 with `COPC_BENCHMARK_POINT_COUNT=10000` and
`COPC_BENCHMARK_REPEATS=1`:

| Renderer | Points | Transform | Renderer submit | Total |
| --- | ---: | ---: | ---: | ---: |
| `Primitive typed arrays` | 10,000 | 32.1 ms | 1.1 ms | 33.4 ms |
| `PointPrimitiveCollection` | 10,000 | 45.4 ms | 3.9 ms | 49.6 ms |
| `BufferPointCollection` | 10,000 | 45.8 ms | 11.4 ms | 57.6 ms |

The current default `CesiumPrimitivePointRenderer` submits one typed-array
`Primitive` instead of creating one Cesium point object per point. This checkpoint
shows a CPU submission-time win at 10,000 points. The total render path is still
largely coordinate-transform dominated, so the next performance step should
reduce main-thread coordinate conversion and data preparation overhead.

## Current Default

The basic viewer starts in Balanced detail mode: 120,000 max points per node,
240,000 max Auto LOD points, 120,000 max camera-stream points, and 2 px
typed-array primitive points. The initial load renders one real COPC node to
place the camera, then automatically renders a denser camera-selected coverage
LOD set through depth 3. The stream input acts as a maximum budget: camera
streaming can lower the effective point budget after slow visible updates and
gradually recover it after repeated fast updates. This keeps the demo from
staying overloaded on heavier samples or slower machines.

Auto LOD also has source-point, total compressed-byte, per-node point-count,
and per-node compressed-byte budgets. The per-node caps keep the initial
automatic pass from spending a worker slot on one unusually large COPC node
before cheaper visible coverage has been shown.
Balanced and denser presets also allow Auto LOD to open more hierarchy pages
before choosing nodes, favoring smaller visible octree chunks over coarser
nodes that are expensive to decompress.
The per-node source-point caps are intentionally separate from
`maxPointCountPerNode`: the former decides which COPC nodes may be selected,
while the latter decides how many sampled points are submitted from each
selected node.

Additional targeted diagnostics on the SoFi sample with a 2,500-point stream
budget originally measured average stream-stage timing at
expand/select/render/total `234.3/127.2/10.0/470.0 ms`. After limiting Cesium
frustum checks to the requested camera selection depth range, a follow-up run
measured expand/apply/select/render/total
`240.7/105.1/19.0/10.7/375.5 ms`.

After avoiding full node-dropdown rebuilds during camera streaming, the same
targeted check measured expand/apply/select/render/total
`220.2/0.1/0.6/17.1/238.0 ms`, with 60.0 average FPS, 16.80 ms p95 frame time,
and 0 frames over 50 ms.

After moving camera-targeted hierarchy expansion out of the visible stream
update and into a single background prefetch queue, the targeted visible-update
check measured expand/apply/select/render/total
`0.0/0.0/3.0/30.4/33.5 ms`, with 59.4 average FPS, 16.80 ms p95 frame time, and
0 frames over 50 ms.

After allowing camera streaming to select up to two nearby depth-2 nodes, the
same targeted check measured depth avg `2.0`, expand/apply/select/render/total
`0.0/0.0/1.5/17.5/19.0 ms`, with 60.0 average FPS, 16.70 ms p95 frame time,
and 0 frames over 50 ms.

After adding adaptive camera-stream point budgeting, a targeted SoFi run with a
20,000-point maximum stream budget and 2 repeats kept depth avg `2.0` while
lowering the effective render count from 2,668 to 1,000 points after a slow
update. The run measured 59.7 average FPS, 16.80 ms p95 frame time, 33.50 ms
max frame time, and 0 frames over 50 ms. This improves smoothness by sacrificing
temporary point density when the visible stream update is too expensive.

Rendering the submitted points was not the dominant cost in these runs. The
visible camera-stream update is now mostly renderer submission time, while
hierarchy page expansion happens in the background.

The current demo now prioritizes visible COPC coverage more aggressively than
the older smoothness table above: camera streaming uses progressive coverage
selection, keeping coarse full-view coverage nodes visible while spending the
remaining node and byte budget on distributed target-depth detail nodes. Ultra
density can target up to 1,000,000 Auto LOD points. The next performance work
should rerun the smoothness benchmark at the new higher budgets and tune
adaptive recovery against these denser defaults.

The basic viewer also opts into
`activePointGeometryWorkerCancellation: "terminate-uncached"` for the integrated
COPC geometry worker path. Camera streaming no longer terminates every previous
render immediately. On camera movement the old render is first marked stale so
late progress cannot update the screen. After the next camera selection is
known, the viewer compares the previous and current node families: overlapping
zoom/pan work is allowed to finish in the background and populate the layer and
worker caches, while unrelated stale work is aborted so fresh current-view
requests can start on new workers. That reused background work is bounded by a
short grace period, so a near-finished overlap can still warm caches while
long-running previous-view detail does not keep current-view requests queued for
seconds. The `"terminate-uncached"` policy terminates workers that have not yet
retained decoded node data, while preserving cache-owning workers to avoid
turning repeated zoom/pan work into cold decompression. The library default remains `"soft"` so
applications that prioritize maximum decoded-worker cache retention can keep
that behavior without the example's stale-work termination policy. When
terminate cancellation does replace a worker, the integrated geometry worker
pool remembers the most recent source-aware warmup request and replays it on
replacement workers. That preserves fast stale-work cancellation for cold
workers while reducing the cost of starting the next current-view request on an
otherwise cold worker.

Integrated COPC geometry requests and core point-sample worker requests also
carry an optional `requestPriority`. The basic viewer assigns monotonically
increasing positive priorities to interactive Auto LOD and camera-stream work,
and a negative priority to background prefetch. This keeps newer current-view
work ahead of older retained background work in the worker queue while still
letting overlapping stale work finish when it can warm useful caches.

Within a camera-stream update, request priority is ordered as coverage preview,
visible dense detail refinement, then current-view detail cache warmup. The
warmup opens the same COPC nodes through `prefetchNodePointGeometryBatches()`
without submitting another Cesium render, so the visible detail pass can
coalesce in-flight worker requests or reuse prepared geometry batches while still
outranking cache-only warmup work.

The integrated geometry worker pool batches requests queued during the same
JavaScript tick before dispatching them. This gives current-view high-priority
detail requests a chance to outrank lower-priority warmup or prefetch requests
instead of letting the first low-priority request immediately occupy an idle
worker.

The same pool also coalesces identical in-flight geometry requests by COPC
source key, node key, sample count, and serializable transform. When camera movement,
detail warmup, and progressive rendering ask for the same node at the same
density before the prepared batch cache has been populated, only one worker task
is dispatched and all still-active callers receive that result. If one caller is
aborted, the shared worker task remains alive as long as another caller still
needs it.

For compatible same-node geometry requests, the integrated worker pool can also
reuse a denser in-flight request for lower-density consumers. If a lower-density
request is still queued and a denser same-node request arrives before dispatch,
the queued task is upgraded instead of sending two worker jobs. Lower-density
callers receive a downsampled copy of the denser result, which avoids spending a
worker slot on warmup data that would be immediately superseded by current-view
detail.

That density upgrade is priority-aware in both the integrated geometry worker
pool and the lower-level point-sample worker queue. A lower-priority warmup or
prefetch request does not upgrade an already queued higher-priority current-view
detail request for the same node. Higher-priority dense current-view requests
can still upgrade lower-priority queued work, and lower-density callers can
still reuse active dense work that is already running.

Camera-targeted background prefetch now goes through
`CopcPointCloudLayer.prepareNodesProgressively()` instead of calling the
lower-level source directly. In the integrated worker path this warms the same
prepared geometry cache that later render calls use, so a completed prefetch
can become a render cache hit instead of only warming decoded point samples.
Progressive preparation also retains each completed node as soon as it arrives,
so a partially completed idle prefetch can still help the next zoom or pan.
It accepts the same active progressive request window used by rendering, so a
large cache-warming prepare job does not enqueue every missing node ahead of a
newer current-view camera request.
The prefetch policy can now carry the last visible per-node detail target,
which lets idle work prepare current-view nodes at a reusable density instead
of caching a lower-density sample that the next view immediately replaces.
After the initial Auto LOD detail pass succeeds, the basic viewer now starts
the same camera-targeted prefetch queue. This warms one deeper current-view
selection while the user is still looking at the first rendered scene, reducing
the chance that the first zoom or pan has to start every low-density detail
decode from cold caches.

Camera streaming also forces a coarse coverage preview whenever the retained
node cache does not already contain the current view's preview coverage nodes.
This keeps the full visible COPC footprint represented while denser target-depth
nodes are still decoding, instead of showing only the subset of detail nodes
that happened to be cached first. Quality presets now include a per-node point
data byte cap for camera streaming, so one unusually expensive COPC node cannot
consume the whole source budget by itself.

The basic viewer's camera-stream adaptive budget now also adjusts the per-node
source-point and point-data caps. When a completed camera stream reports slow
source work, especially a high max decode or worker round-trip time, the next
stream update reduces not only the render/source/total compressed budgets but
also the maximum source points and compressed bytes allowed for any single
selected node. Background prefetch uses the same adaptive caps, so stale or
next-view work cannot keep decoding node ranges that the current-view budget
has already judged too expensive. After a few fast runs, the caps recover
gradually with the other adaptive budgets.

The adaptive source-point floor stays high enough for the camera stream to keep
the current-view density meaningful after repeated slow source runs. This avoids
the failure mode where queue time improves only because the next render has
fallen below the benchmark's minimum visible point count.

Closer camera-stream LOD profiles also start with smaller per-node source
caps instead of waiting for the first slow run to prove that a large node is
too expensive. The total source and rendered-point budgets can still rise for
near-camera detail, but medium, close, and near zooms prefer smaller COPC node
chunks from the first selection pass. Slow source work then decays those
source budgets more aggressively on the next pass, which steers repeat zoom
or pan updates away from long LAZ-decode tail nodes while keeping the visible
footprint filled by more distributed nodes.

Cold close/near detail completion is now calibrated around the coverage preview
remaining visible underneath the detail layer. Instead of waiting for nearly
every selected target-depth node to finish, close zoom can publish final detail
once about 90% of current-view detail nodes have rendered, and near zoom uses
about 95%. This trades a small amount of tail-node completeness for much lower
queue wait on the visible update while the retained preview keeps the full
screen footprint represented.

Typed-array camera-stream progress is also evaluated in smaller spatially
balanced batches. Cesium primitive submission is no longer the dominant cost in
the benchmark, so checking completion more often lets the stream publish the
foreground result without waiting for a large progress batch to finish.

The basic viewer now keeps the remaining current-view detail loads alive after
that foreground completion instead of aborting them immediately. The first
`Camera stream rendered` status and the foreground render Promise both complete
as soon as the completion policy is satisfied. Already queued worker tasks then
continue filling the same view's COPC and geometry caches in the background
without immediately submitting another Cesium render during that foreground
camera update. Moving the camera still aborts the parent request, so off-screen
tail work is not kept alive after the view changes.
The completion policy applies the current-view node coverage threshold even
when retained low-density samples or warm worker caches have already filled much
of the point budget. This prevents a stream from reporting final detail when
only one visible patch is dense while other selected nodes are still sparse.
For close-detail runs, the foreground completion policy can relax the raw node
count slightly only when the rendered nodes cover enough source-point weight for
the current view. This keeps tiny low-point tail nodes from blocking the screen
while still requiring at least 90% weighted current-view coverage in QC.

Current-view final detail uses the camera-stream selection order by default, so
the active worker window remains spatially distributed across the visible screen
instead of concentrating first on one dense patch. Applications can still choose
`nodeRequestOrder: "source-points-first"` for explicit density-first refinement,
and background prefetch can use source-point weights to warm important same-view
nodes first. This does not remove the cost of the first range read and LAZ
decompression for a cold node; those remain the dominant source of final-detail
latency in cold zooms.

Preview selection avoids treating a large low-depth coverage parent as mandatory
when close zoom detail is available. If every coverage preview candidate exceeds
the configured compressed-byte preview budget, the basic viewer falls back to a
distributed subset of the current detail nodes. This keeps the first interactive
foreground response from waiting on one large parent COPC block when smaller
visible detail blocks can start filling the current screen.

The basic viewer also limits how many missing final-detail nodes a foreground
progressive render keeps active at once. The limit is the smaller of the
runtime `detailMaxActiveNodeRequests` setting and the integrated geometry worker
count, so visible detail work can use enough parallelism without filling every
worker with not-yet-needed tail nodes. When the foreground completion policy is
satisfied, already active tail loads can finish as background cache work, but
nodes that were not active yet are left for predictive prefetch or the next
camera update. This improves cancellation behavior when the user pans or zooms
away before the full tail has started decompressing.

The same adaptive per-node source-point and compressed caps are now applied to
Auto LOD. If the initial automatic pass hits slow source work, the next Auto
LOD attempt lowers the maximum source points and compressed bytes allowed for a
single selected node along with the total source and compressed-byte budgets.
This favors a faster full-view coverage pass over waiting on a single expensive
node.

Progressive detail rendering also reuses lower-density retained results for the
same target nodes. If a background prefetch or earlier preview already prepared
a small sample for a visible node, the integrated worker path renders that
sample immediately and replaces it when the denser sample finishes. This keeps
the visible area more uniformly covered during refinement instead of leaving
some selected nodes blank until their high-density decode completes.

When same-node retained coverage is sparse, the basic viewer now publishes
detail refinement in balanced node groups instead of one node at a time. The
coverage preview remains visible while workers decode detail nodes, and the
denser layer advances in larger spatially distributed steps. Once enough
same-node low-density results are already cached, the typed-array renderer goes
back to one-node progress for the fastest possible refinement.

Alongside high-density detail refinement, the basic viewer can also warm a
bounded, spatially distributed subset of the current view's target detail nodes
through the integrated geometry cache. This does not avoid the first LAZ
decompression for a new node, but it lets following visible detail requests
coalesce with the same in-flight worker task or reuse the worker-local decoded
point-data view. The warmup no longer submits its own scene render, so it cannot
overwrite newer detail results or add extra main-thread renderer work while the
foreground detail pass is trying to settle. The default runtime only starts this
warmup after at least 35% of same-node low-density current-view results are
already present, so a mostly cold zoom gives worker slots to dense detail first.

When warmup, preview, or background prefetch work must be capped to fit the
current budget, the example now chooses nodes across the full ordered range
instead of taking only the first `N` nodes. This keeps limited background work
spread across the visible footprint, so repeated zoom or pan updates are less
likely to produce one dense area while distant visible areas remain at preview
density.

The final detail node set is also bounded. The default camera stream keeps at
most 48 final detail nodes in the foreground plan, while still respecting the
LOD-specific minimum final-node count. The cap is applied through the render
plan's distributed node selection, so an expanded zoom view spends work across
the visible range instead of queuing every tiny tail node before foreground
detail can settle.

The final detail per-node sample cap is now separate from the minimum
final-node count. Close zooms use a 6,500-point cap per final node, while near
zooms use a lower cap to keep many small nodes moving through the worker pool.
This keeps the visible area denser than the low-density preview without letting
one or two expensive nodes dominate the foreground render budget.

For the default typed-array primitive renderer, camera-stream detail rendering
publishes each completed detail node immediately only when enough same-node
low-density results are already available. Otherwise it batches progress to
reduce patchy high-density islands. The older four-node progress cadence is
kept for the slower `PointPrimitiveCollection` fallback to avoid excessive
renderer resubmission cost.

After adding progressive early-stop cancellation, a targeted 20,000-point
camera-stream run with 12 camera steps stopped waiting for slow tail nodes once
the visible detail budget was sufficiently filled. On SoFi, the same scenario
that previously waited about 23,839 ms for the render promise to settle now
completed in 1,500.5 ms including the 1,200 ms camera move, while the visible
stream stage reported 26.1 ms total, 60.0 average FPS, 16.80 ms p95/max frame
intervals, 0 frames over 50 ms, and 18,469 rendered points at selected depth 5.
Autzen in the same targeted run completed in 1,473.8 ms, with a 13.3 ms stream
stage, 60.0 average FPS, 16.80 ms p95/max frame intervals, 0 frames over 50 ms,
and 18,257 rendered points at selected depth 5.

The typed-array primitive renderer now keeps worker-prepared geometry batches
as per-node primitives by default. Since the integrated worker already returns
node-sized typed arrays, this avoids concatenating multiple decoded nodes into a
new large array just to submit them to Cesium. During progressive camera
updates, previously completed nodes keep their primitive key when later nodes
finish, so the renderer can add only the new node primitive instead of removing
and rebuilding an accumulated chunk.

Progressive render point budgets are distributed across the currently
renderable current-view nodes before leftover budget is assigned to retained
background coverage. This avoids spending the whole budget on the first
completed nodes in selection order, which made some visible areas dense while
later nodes stayed sparse or blank. The current detail set still has priority
over background coverage, but leftover background points are spread across
available coverage nodes so the visible footprint remains more uniform while
detail workers continue decoding.

Point-geometry timing now separates aggregate work from the slowest single
request. The example still shows summed decode/worker time to estimate total
CPU work, but camera-stream adaptive throttling uses the max decode/worker/round
trip fields plus the measured stream total time. This avoids over-throttling a
healthy parallel worker run just because several worker durations were added
together.

The point-sample worker pool and integrated COPC geometry worker pool also track
which worker last decoded each node. Later requests for the same node prefer
that worker when it is idle, which lets the worker-local decoded point-data
cache serve density upgrades or repeated camera visits without randomly sending
the node to a different worker that would need to decompress it again. If that
cached worker is busy with another node, `decodedNodeWorkerFallbackDelayMilliseconds`
controls the latency/cache tradeoff: the default `Number.POSITIVE_INFINITY`
keeps strict decoded-cache affinity, while `0` lets the request use any idle
worker immediately for latency-first experiments. The worker-pool helper used by
the basic viewer returns a 120 ms fallback delay after benchmark comparisons
showed that immediate fallback increased duplicate decompression while strict
affinity left some foreground detail passes waiting behind one busy cached
worker. If the exact same node is already active, the duplicate node request
still waits for it instead of starting the same LAZ decompression twice. The
queue still scans past that blocked request, so unrelated current-view nodes can continue to dispatch
in parallel.

The same density-upgrade coalescing is available in the lower-level
point-sample worker path. When `CopcSource.loadNodePointSamples()` has queued a
lower-density worker request and a denser request for the same node and sample
format arrives before dispatch, the queued request is upgraded and the
lower-density caller receives a downsampled result. This keeps the reusable
`core` API aligned with the Cesium integrated geometry path.

Pending source-level point sample cache hits can also raise the queued worker
priority. If a background prefetch creates the first Promise for a node and the
current camera view asks for the same sample before it dispatches, the cached
Promise is reused but its queued worker task is promoted so it does not stay
behind unrelated lower-value work.

The library also exposes `warmUpPointSampleWorkers()` on `CopcPointCloudLayer`.
The basic viewer calls it when a COPC source is opened, alongside geometry
worker warmup. This does not decompress any COPC node in advance, but it removes
worker construction latency from the first visible zoom or pan so the first
camera-stream request can start range reads and decoding immediately.

The basic viewer now checks retained transfer-only node samples against
`CopcPointCloudLayer.canRenderNodeSampleResult()` before using them as immediate
camera-stream coverage. If the worker-prepared geometry batch has already been
evicted, the retained reference is dropped and the stream performs a real
preview or reload instead of falsely assuming that the current view is covered.

The worker-local decoded point-data cache is configurable through
`maxDecodedPointDataViewsPerWorker` and
`maxDecodedPointDataViewBytesPerWorker` for both point-sample workers and
integrated COPC geometry workers. The library defaults stay conservative at 48
decoded views and 192 MiB per worker. The basic viewer raises that to 96
decoded views and 256 MiB per worker to improve repeated zoom/pan visits and
density upgrades on the current demo samples, with the tradeoff that high
worker concurrency can use more memory.

The worker pool sizing policy keeps point-sample workers conservative and caps
integrated COPC geometry workers for visible latency instead of maximum
background throughput. The default policy falls back to four point-sample
workers and five integrated geometry workers, caps point-sample concurrency at
six, caps integrated geometry concurrency at eight, uses a 120 ms decoded-node
fallback delay for the basic viewer, reserves browser capacity for rendering,
and warms the selected geometry pool up front while still bounding total worker
creation. This reflects the current bottleneck: typed-array Cesium submission is
usually near-zero milliseconds in the current benchmark, while COPC point-data
decompression and worker queue time dominate high-density detail completion. If
a target deployment has tighter CPU or memory limits, applications can still
pass explicit worker counts to `CopcPointCloudLayer`.

Background camera prefetch is deliberately capped below the integrated geometry
worker pool size. While the current screen is still trying to load denser
detail, the basic viewer keeps background preparation decode-only. After the
current detail pass settles, it can prepare decoded, sampled, Cesium-ready
geometry batches without publishing them to the renderer. This should improve
the next nearby view, but it must not occupy every worker while the current
screen is still loading. The default `backgroundPrefetchMaxConcurrentRequests`
is therefore four, leaving room for foreground camera-stream detail requests on
the basic viewer's warmed worker pool. The runtime prefetch policy also warms
up to 24 base nodes, 120,000 rendered prefetch points, and 2,500 points per
prefetched node before the screen asks for full detail. Close and near zooms
still scale that node count upward through the LOD-aware prefetch multiplier,
so the cache warms a larger part of the current view instead of only a small
cluster of dense tiles. Background prefetch intentionally uses the LOD prefetch
density instead of the final foreground per-node cap; the worker-local decoded
point-data view is the expensive reusable artifact, while denser geometry can
be prepared later from that decoded view. Prefetch node ordering now accepts
source-point weights from the camera selection. The basic viewer passes each selected node's source
point count, so the prefetch queue still follows progressive spatial coverage
but requests visually important, source-point-heavy nodes before tiny tail nodes
inside the same coverage group.

At the lower COPC source boundary, URL and Blob range getters now coalesce and
cache exact byte ranges with a bounded in-memory LRU policy. This does not
replace node-level decoded-view caches, and it does not share bytes across
separate browser workers, but it avoids duplicate metadata, hierarchy, or
point-data range reads inside the same source or worker when callers ask for the
same byte span concurrently or repeatedly.

The camera-stream render plan can skip the coarse coverage preview when the
current final detail set is already small. The basic viewer uses this for views
with fewer than five final detail nodes, so those views submit dense
current-view nodes to the worker pool immediately instead of spending a pass on
temporary preview coverage that would be replaced almost at once.

Because that fast path can finish while the camera is still moving, background
hierarchy and point prefetch is now delayed and canceled by newer camera moves.
This keeps background preparation from competing with the current-view stream
while the user is actively navigating.

For longer high-density camera-stream passes, the basic viewer waits until the
current-view detail pass has made final progress before preparing the next
likely view. Earlier predictive prefetch can warm more nodes sooner, but the
warm close-zoom benchmark showed that it competes with foreground LAZ decoding
and hurts smoothness. The prefetch controller still allows only one active
prefetch and newer camera moves still cancel it, but background work is kept out
of the way until the current view has produced usable detail.

Warm close-zoom detail benchmarks with the 360,000-point camera-stream budget
have passed assertions in repeated SoFi runs after the lower-density background
prefetch change. A clean run reported a 28.6 ms average first foreground
response and a 6,821.5 ms average final-detail total across two runs, with
154,163-255,509 rendered points, 93.8% average current-view node coverage, 59.7
average FPS, 16.8 ms p95 frame interval, and 0 frames over 50 ms. A later
confirmation while the desktop had more background Node processes measured a
35.6 ms first response and 8,054.2 ms final-detail total, with the same 93.8%
average coverage but lower frame smoothness. The remaining long pole is still
the cold range-read and LAZ decode cost for final detail nodes, not Cesium point
submission.
