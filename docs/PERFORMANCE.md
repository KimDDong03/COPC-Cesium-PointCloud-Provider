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
through both the movement interval and the expected request's terminal
refinement. The split uses the page's exact post-movement timestamp, before the
final foreground request starts, so first response and remaining refinement
work cannot fall between measurement windows. A first response is recorded only
after the application either commits a frame (`app-render-commit`) or proves
that a relevant committed frame remains resident (`app-render-retained`). A
retained progress frame is not final: terminal completion still requires both
complete detail progress and a verified visual composition. The evidence
carries request identity, render disposition, and renderer revision; starting
work or finding cached data is not sufficient. The report also records
foreground completion, stream-stage timing, and the structured decoded-worker
cache envelope.

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
The 2026-07-14 example-build snapshot also verifies the deliberate `proj4`
split: uncompressed generated JavaScript was 367.93 kB for the app entry and
131.70 kB for the `proj4` chunk. Those figures identify one source build, not
compressed transfer size, startup cost, or a permanent size guarantee.

The JSON includes `browserGraphics` with the WebGL vendor, renderer, and version.
The benchmark launch requests Chromium's high-performance adapter; the recorded
renderer remains the source of truth because headless or GPU-limited systems may
fall back to another hardware adapter or software rendering.

Every renderer and smoothness report also carries `browserEnvironment` and
`runEvidence`. The assertion gates require a canonical UTC timestamp, Git HEAD,
clean/dirty state, SHA-256 fingerprint of the tracked diff and non-ignored
untracked content, Node/platform/npm context, and browser user agent/version.
`output/` and the approved baseline directory are excluded from the fingerprint
to avoid generated-artifact self-reference. Missing or malformed provenance is
a gate failure, not an optional annotation.

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

When tuning worker scheduling or LOD policy, compare independent browser
sessions against the committed same-device baseline instead of relying only on
the absolute pass/fail thresholds. Run:

```bash
npm run benchmark:smoothness:regression
```

Before launching a browser, this command performs one strict, non-retried
64-byte HTTP Range request against the Millsite source. It requires HTTP 206,
an exact `Content-Range`, the requested byte length, and the LAS `LASF`
signature. The source evidence and overall classification are written to:

```text
output/smoothness-benchmark/smoothness-regression-live-range.json
output/smoothness-benchmark/smoothness-regression-run-status.json
```

An external timeout, DNS/fetch failure, HTTP 408/425/429, or 5xx response is
classified as `external-source-unavailable` and exits with code 2. That result
means no performance-regression verdict was produced. A reachable source that
does not honor the expected Range/COPC contract exits with code 1, as does a
real benchmark or assertion failure. If the source becomes unavailable after
the preflight, the runner classifies the exact range/network error from the
failed session the same way. The preflight and classification layer do not add
retries or sleeps, reuse a stale success, or relax an assertion; they do not
change the library's existing request policy.

After the preflight, the command launches three fresh browser/cache lifecycles.
Every session runs the absolute warm-detail assertion, and the runner writes
the raw reports, assertion reports, and a compact session bundle under
`output/smoothness-benchmark/regression-sessions` before applying the relative
gate. The versioned baseline is
`benchmarks/baselines/smoothness-warm-zoom-detail-rtx3060.json`. It records five
independent approved sessions, the source profile, exact WebGL adapter, browser
version, canonical absolute-threshold snapshot, and each session's source-run
evidence. A threshold or actual renderer mismatch is incomparable rather than a
pass. The low-level
`benchmark:smoothness:regression:assert` command remains available with explicit
`--input` and `--baseline` paths when inspecting an existing bundle.

Each warm session does not count its first camera pass as a measurement. It
records one explicit warmup, waits up to 30 seconds for the already-scheduled
prefetch to complete, then captures a layer-bound benchmark-only hierarchy hold
before recording two measured runs. Warmup and settle evidence remain under
`warmups`, hold evidence remains under `hierarchyHolds`, and `results` contains
only run indices 1 and 2. Both measured runs must preserve the exact selected
node keys, additive render signature, loaded/pending/tracked hierarchy counts,
and eviction count. Geometry prefetch continues while held; only hierarchy
growth is suspended, and normal viewer streaming never enables this hold.

A fully cached run may perform no new point-geometry worker request. In that
case the report records the exact number of fresh final nodes returned by the
retained camera-stream node-sample cache with
`evidenceSource: "camera-stream-node-sample-cache"` and zero worker timing. A
zero-worker result is valid only when that fresh count equals the complete final
node count. Prepared-geometry cache deltas remain authoritative cache-hit
evidence, but they do not synthesize zero latency when worker timing is absent.
When a mixed run performs new worker requests and also reuses prepared geometry,
the minimum-hit gate uses the larger observed count from worker timing and the
before/after layer-cache delta without adding potentially overlapping counters.
When the renderer already contains that same exact terminal composition, the
application may also report `app-render-retained`; exact terminal reuse is valid
only when the layer identity and renderer revision match and either the
node/density/budget contract or the completed weighted render signature matches.
The same evidence source may describe an explicit retained-progress frame, but
that disposition cannot satisfy the terminal gate and must preserve the prior
committed-frame contract while target density continues loading.

`scripts/assert-smoothness-regression.mjs` first groups the two measured runs by
sample and stream budget, then uses the median of those group summaries across
the independent sessions. Average FPS, p95/max frame time, frames over 50 ms,
camera-stream first response and total time, rendered point count, and
current-view node coverage remain blocking relative checks. The low-latency max
frame and first-response checks use the larger of their ratio limit or a 20 ms
and 10 ms additive jitter allowance. Stream total uses the larger of 1.20x or
the baseline median plus `max(150 ms, 2 * robust sigma)`, where robust sigma is
`1.4826 * MAD`. One slow remote/decode session therefore cannot fail the gate,
while a slowdown present in at least two of three current sessions still can.

Average geometry queue time remains recorded in every session summary but is
informational in the relative report. A warm session mixes real worker timing
with authoritative cache-hit evidence whose synthetic queue duration is zero,
and repeated same-source measurements showed scheduler variance large enough
to make a ratio-only blocker misleading. The per-run 500 ms average and 2,000
ms max queue gates remain blocking, as do stream-total and first-response
checks, so removing the relative queue ratio does not remove user-visible path
protection.

Create a candidate on the named workstation with five absolute-passing
sessions. This command never overwrites the versioned baseline:

```powershell
node scripts/smoothness-regression-qc.mjs --session-count 5 --create-baseline-candidate
```

Review every raw/assertion artifact, the candidate's session metrics, source
identity, browser/GPU contract, median, and MAD. Only then install that exact
candidate with the separate confirmation step printed by the capture command:

```powershell
node scripts/smoothness-regression-qc.mjs --install-baseline-candidate "output/smoothness-benchmark/regression-sessions/smoothness-baseline-candidate.json" --confirm-reviewed-baseline
```

The installer validates the candidate again before replacing the versioned
baseline. Candidate creation and installation are not part of normal QC.
`npm run qc:product` is the deterministic product group (tests, license/SBOM,
build, and whitespace). `npm run qc:live-copc` is the separate live
external-source group and begins with `npm run live:copc-range`, which probes
both documented samples and writes
`output/live-copc-range/live-copc-range.json`. `npm run qc` remains the blocking
combination of both groups and writes `output/qc/qc-status.json` so product
failure, live source contract failure, external unavailability, and live
benchmark failure are not conflated. The renderer benchmark belongs to the live
group because its benchmark node is decoded from the remote Autzen sample. The
cold-detail gate runs immediately after the range preflight, before the renderer
and contest GPU workloads, so its cold-frame evidence is not contaminated by
earlier benchmark processes in the same QC chain.

`npm run qc:contest-device` avoids a duplicate one-session warm run in the main
QC chain and finishes with the three-session regression runner.
An adapter mismatch is a failed comparison, not a performance regression or a
pass. Use `npm run qc:contest-device` for the full release gate plus this
same-device comparison on the approved workstation.

The contest QC preset uses the same gate but includes both Autzen and the
Hobu-hosted COPC matching the public-domain USGS 3DEP Millsite collection at a
20,000-point camera-stream budget. This keeps the faster day-to-day check
available while still making the heavier projected-coordinate sample part of
the stricter release path.

The cache-reset preset clears retained camera-stream state before each Millsite
camera movement run while keeping layer-level point samples, prepared point
geometry, and worker-local decoded COPC node caches alive. Already-open COPC
metadata, hierarchy pages, prepared Cesium geometry, and worker decoded views
stay loaded. This is not a full first-page cold-start benchmark or a forced
worker/cache reset; it is meant to catch regressions in repeat zoom/pan recovery
when previously decoded and prepared COPC data should be reused.

The cold-reset preset clears the active layer caches before a Millsite movement run
and measures the first interactive coverage render. It does not wait for every
selected node to finish before passing the foreground check. The same camera
request can keep refining afterward, but the captured preview or
`interactive-ready` state is explicitly non-terminal. This preset separates
cold first-display responsiveness from verified final composition.
The default foreground preview caps its compressed COPC point-data read at about
1.1 MB and targets roughly 2,800 rendered coverage points across up to two
early nodes before letting detail refinement continue in the background.

The cold-detail profile uses the same 550 m-above-cloud, 10 m movement as the
warm profile but resets layer caches and requires final detail. This isolates
the real range-read/LAZ/geometry path from the warm cache-reuse path. Final mode
now requires a verified terminal visual composition: an antichain frontier, the
complete required additive ancestor closure, zero missing nodes, zero stale or
unexpected rendered nodes, and no unopened hierarchy page relevant to the
current camera target. Hierarchy expansion selects Cesium-frustum-visible
current-view pending pages instead of only the viewport-center tile and spends
one bounded budget across newly revealed levels. Background refinement stops at
the deepest complete frontier that the current node/point/data budgets can
render rather than chasing a deeper screen-space ceiling or speculative
future-zoom pages.
The engine then reselects the same camera and keeps refining when expansion
reveals a different frontier.

For typed terminal geometry, refinement keeps the current preview or retained
frame on screen while worker requests complete and performs one final exact
renderer commit. Incremental full-budget commits had repeatedly changed
per-node weighted allocations and primitive keys as nodes arrived, causing
Cesium/WebGL upload stalls even when JavaScript submission time was small. The
terminal executor still supports an explicit incremental override, while
non-typed renderers retain the adaptive progress policy.

The source cache's `pendingPageCount` is global and can legitimately remain
nonzero for deeper hierarchy pages. Current-frame completion is governed by
`pendingRelevantHierarchyPageCount`, which is restricted to visible pages
through the selected frontier depth.

Cold-detail allows up to 30 seconds for the post-prefetch result. That evidence
must show a newer request at an unchanged camera epoch and pose fingerprint, a
completed prefetch, selected depth at least 5, at least 300,000 rendered points,
`isTerminalReady: true`, and `pendingRelevantHierarchyPageCount: 0`. Its final
stage stays inside the frame gate: at least 30 FPS, p95 at most 67 ms, max at
most 150 ms, and at most one terminal-refinement frame above 100 ms. Existing initial
request point, depth, node-count, weighted-coverage, and per-node density
thresholds remain supplemental regression gates; none can substitute for the
post-prefetch same-camera or exact-composition checks.

Default QC thresholds are intentionally about regression detection, not a final
performance guarantee:

| Metric                                  |                                                                        Default threshold |
| --------------------------------------- | ---------------------------------------------------------------------------------------: |
| Average FPS                             |                                                                              at least 30 |
| p95 frame interval                      |                                                                            at most 67 ms |
| Max frame interval                      |                       at most 100 ms quick/contest; 150 ms cold/warm high-density detail |
| Frames over 50 ms                       |                                                                               at most 10 |
| Terminal-refinement average FPS         |                                                                              at least 30 |
| Terminal-refinement p95 / max interval  | same as the active frame gates; cold detail allows one frame over 100 ms, all other presets allow zero |
| Decoded worker cache                    |                    retained and peak bytes must stay within the reported aggregate limit |
| Camera stream first visible application response |                                                                  at most 250 ms |
| Camera stream interactive total         |                                                                           at most 250 ms |
| Camera stream final-detail total        | at most 1,500 ms quick / 8,000 ms contest / 15,000 ms cold detail / 8,000 ms warm detail |
| End-to-end camera move overrun          |                                                at most 2,000 ms quick / 2,500 ms contest |
| Rendered points                         |                                                            at least 10,000 in QC presets |
| Current-view node coverage              |                        100% by default in final mode; interactive presets may disable it |
| Current-view weighted node coverage     |                                                   supplemental close-detail density gate |
| Terminal visual composition             |             antichain frontier, complete additive closure, 0 missing, 0 stale/unexpected |
| Point-geometry worker timing            |                                        optional max round-trip/decode/worker/queue gates |
| Selected LOD depth                      |                                                          sample expectation, or override |

The end-to-end overrun gate compares `measuredDurationMilliseconds` with the
configured camera movement duration. It catches cases where the visible stream
status appears fast but the progressive render promise is still blocked by slow
tail nodes.

Current smoothness artifacts are schema-versioned and must include the raw
terminal-refinement frame intervals, their recomputed summary, and structured
decoded-worker cache telemetry with an aggregate byte limit. The assertion
recomputes FPS, p95, max, and stall counts from the raw intervals rather than
trusting only a reported summary. Unversioned historical artifacts remain
readable for comparison, but cannot be mistaken for newly generated complete
evidence.

When `COPC_SMOOTHNESS_WAIT_FOR_FINAL_DETAIL=0`, the benchmark accepts
`Camera stream previewed`, `Camera stream interactive-ready`, and `Camera stream
partial render` statuses as the foreground result. Use that mode only for first-display checks such as
`benchmark:smoothness:cold-reset`; release-oriented detail checks should keep
the default final-detail wait.

The assertion script separates those two modes. The first visible application response
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
$env:COPC_SMOOTHNESS_SAMPLES="autzen-classified,millsite-reservoir"
$env:COPC_SMOOTHNESS_POINT_BUDGETS="2500,5000,10000"
$env:COPC_SMOOTHNESS_REPEATS="5"
$env:COPC_SMOOTHNESS_MIN_SELECTED_DEPTH="2"
npm run benchmark:smoothness
```

The generic bundled smoothness sample cases expect camera streaming to select
at least depth 2. The low-density quick/contest presets use depth 1 because a
20,000-point total render budget cannot honestly promise a complete deeper
frontier, while the 360,000-point close-detail presets require at least depth 4.
`COPC_SMOOTHNESS_MIN_SELECTED_DEPTH` can raise, lower, or disable that global
threshold for local experiments. Exact frontier and additive-closure checks are
still mandatory in every final-detail preset.

## Exact Terminal-Gate Checkpoint

The latest cold-detail checkpoint was measured on 2026-07-17 with the
typed-array primitive renderer and the recorded RTX 3060 WebGL adapter. It
rendered 360,000 points from all 80 required additive nodes, using a depth 3-5
mixed-depth antichain frontier with 100% node and weighted coverage, zero
missing or stale/unexpected nodes, zero pending current-view hierarchy pages,
and `isTerminalReady: true`.

| Profile | Runs | Points | Required nodes | Movement avg FPS | Movement p95 | Movement max | First response | First-response source |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Cold detail Millsite | 1 | 360,000 | 80/80 | 59.2 | 16.8 ms | 33.4 ms | 4.4 ms | `app-render-retained` |

Frame collection continued for 24.517 seconds through hierarchy and terminal
refinement. Across that phase it recorded 59.5 average FPS, 16.8 ms p95,
83.3 ms maximum, three frames above 50 ms, and zero frames above 100 ms, all
inside the cold-detail gate. The final retained exact result reported depth 5,
selection/render/total CPU timing of 2.4/3.2/17.1 ms, renderer revision 8, and
maximum worker decode/round-trip timing of 1,789.3/1,798.7 ms. The first visible
response retained the existing 2,800-point frame; it is application response
latency, not full terminal-load latency.

The authoritative result is
`output/smoothness-benchmark/smoothness-cold-detail.json` with SHA-256
`e1be4f55e6e981822ef5c59f8239c6ba82e5a2699138facd7d013f4b57f735e4`.
Its assertion report is
`output/smoothness-benchmark/smoothness-cold-detail-assertion.json` with
SHA-256
`0d7d99f687ade681bf5c717d0f07201d300ac3fa0b597c33bce4c909fa3db9b6`.
These values are machine-specific regression evidence from a dirty source
snapshot, not cross-device guarantees.

## Superseded Pre-Terminal-Gate Checkpoint

The measurements in this section predate the exact additive-composition gate.
They remain useful as timing history, but they are not current terminal-quality
evidence. In particular, a 90-96% node-coverage result is now classified as
refining even when it passed the numeric thresholds used at the time. A fresh
checkpoint must report `cameraStreamVisualQuality.isTerminalReady: true`.

Contest QC checkpoint measured on 2026-07-10 with the typed-array primitive
renderer, a 20,000-point camera-stream budget, 12 camera steps, and the Autzen
classified plus Millsite Reservoir samples. The recorded WebGL adapter was
`ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, D3D11)`:

| Sample             | Measured request | Rendered points | Avg FPS | p95 frame | Max frame | Frames > 50 ms | First response | Final total | Coverage | Geometry evidence   |
| ------------------ | ---------------: | --------------: | ------: | --------: | --------: | -------------: | -------------: | ----------: | -------: | ------------------- |
| Autzen classified  |               19 |          15,064 |    60.0 |  16.80 ms |  16.90 ms |              0 |         6.5 ms |      6.4 ms |   100.0% | cache delta: 2 hits |
| Millsite Reservoir |               40 |          10,323 |    60.0 |  16.80 ms |  16.80 ms |              0 |        16.0 ms |     16.0 ms |   100.0% | cache delta: 3 hits |

This run passed the then-current `npm run benchmark:smoothness:contest` gate. Measured request 40
remained the result even though a later Millsite prefetch observation reported
another request as partial; the benchmark binds completion and diagnostics to the
expected request ID and stores the later prefetch snapshot separately.

The same device produced the following 550 m close-detail checkpoint. Cold
resets layer caches; warm records one excluded warmup and completed 43 of 44
prefetch targets during a 6.701-second settle before measuring:

| Profile/run   |  Points | Final nodes rendered/selected | Raw/weighted coverage | Avg FPS | Final total | Geometry evidence     |
| ------------- | ------: | ----------------------------: | --------------------: | ------: | ----------: | --------------------- |
| Cold detail 1 |  56,715 |                         27/28 |        96.4% / 100.0% |    59.3 |  6,798.3 ms | max decode 2,604.9 ms |
| Warm detail 1 | 185,715 |                         27/29 |         93.1% / 95.6% |    60.0 |  1,828.0 ms | timing cache hits 2   |
| Warm detail 2 | 250,590 |                         37/41 |         90.2% / 91.4% |    60.0 |     12.9 ms | cache-counter delta 2 |

These runs passed the then-current absolute and same-adapter regression gates.
They do not pass the new terminal contract because their required node sets were
incomplete.

The tables below this paragraph are retained only as pre-submission engineering
history. They include the former SoFi test source, which was removed from every
current preset, smoke, and release gate on 2026-07-10 because its public example
page did not state reuse terms. Those measurements are not competition evidence;
current evidence uses only the attributed Autzen and public-domain USGS 3DEP
Millsite sources documented in [DATASETS.md](DATASETS.md).

Measured on 2026-07-01 with the previous point-primitive default:

- Sources: Autzen classified, SoFi Stadium, Custom SoFi URL
- Renderer: `PointPrimitiveCollection`
- Max points / node: 20,000
- Camera steps: 24
- Repeats: 2 per budget

| Sample            | Camera stream budget | Rendered points | Avg FPS | p95 frame | Max frame | Frames > 50 ms |
| ----------------- | -------------------: | --------------: | ------: | --------: | --------: | -------------: |
| Autzen classified |                2,500 |           2,500 |    59.1 |  16.80 ms |  50.10 ms |              1 |
| Autzen classified |                5,000 |           5,000 |    58.8 |  16.80 ms |  66.60 ms |              1 |
| Autzen classified |               10,000 |          10,000 |    53.9 |  33.30 ms | 100.10 ms |              2 |
| Autzen classified |               20,000 |          20,000 |    44.9 |  33.40 ms | 133.30 ms |              2 |
| SoFi Stadium      |                2,500 |           2,500 |    36.6 | 174.95 ms | 250.00 ms |             26 |
| SoFi Stadium      |                5,000 |           5,000 |    28.9 | 300.00 ms | 433.40 ms |             25 |
| SoFi Stadium      |               10,000 |          10,000 |    19.0 | 441.65 ms | 616.80 ms |             25 |
| SoFi Stadium      |               20,000 |          20,000 |    21.8 | 416.60 ms | 616.70 ms |             23 |
| Custom SoFi URL   |                2,500 |           2,500 |    36.5 | 166.70 ms | 266.70 ms |             25 |
| Custom SoFi URL   |                5,000 |           5,000 |    23.1 | 358.30 ms | 533.30 ms |             26 |
| Custom SoFi URL   |               10,000 |          10,000 |    19.6 | 424.95 ms | 600.00 ms |             27 |
| Custom SoFi URL   |               20,000 |          20,000 |    15.6 | 449.95 ms | 533.40 ms |             34 |

## Renderer Benchmark Checkpoint

Measured on 2026-07-02 with `COPC_BENCHMARK_POINT_COUNT=10000` and
`COPC_BENCHMARK_REPEATS=1`:

| Renderer                   | Points | Transform | Renderer submit |   Total |
| -------------------------- | -----: | --------: | --------------: | ------: |
| `Primitive typed arrays`   | 10,000 |   32.1 ms |          1.1 ms | 33.4 ms |
| `PointPrimitiveCollection` | 10,000 |   45.4 ms |          3.9 ms | 49.6 ms |
| `BufferPointCollection`    | 10,000 |   45.8 ms |         11.4 ms | 57.6 ms |

The current default `CesiumPrimitivePointRenderer` submits typed-array
`Primitive` chunks instead of creating one Cesium point object per point. This
checkpoint shows a CPU submission-time win at 10,000 points. The total render path is still
largely coordinate-transform dominated, so the next performance step should
reduce main-thread coordinate conversion and data preparation overhead.

## Current Default

The basic viewer starts in Balanced detail mode: 180,000 max points per node,
240,000 max Auto LOD points, 360,000 max camera-stream points, and 1.75-5 px
projected-spacing adaptive splats. Balanced uses a 1.25 coverage scale, a 1.25
CSS-pixel safety halo, renderer-scoped EDL at strength 1.4/radius 0.8, and no
scene FXAA. The viewer keeps the layer's attribute-color default. The initial
load renders one real COPC node to place the camera, then automatically renders a denser camera-selected
coverage LOD set through depth 3. The stream input acts as a maximum budget: camera
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

The final controlled Autzen pose also caches each immutable hierarchy node's
transformed eight-corner bounding sphere by object identity. Frustum tests still
run for every camera selection, but repeated legacy/enhanced selection measured
2.1/3.0 ms instead of the earlier 8.7-12.0 ms evidence range, a roughly 66-82%
reduction without reusing a stale camera visibility result.

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

The current demo selects a coverage-preserving mixed-depth antichain that fits
the camera LOD's node, source-point, and compressed-byte budgets. It reserves a
visible baseline and only replaces a parent with a complete visible sibling
group, rather than mixing a few greedy target-depth nodes into an unprotected
coarse frontier. The render plan expands that frontier to its complete available
additive ancestor closure, orders the required nodes coarse-to-fine, and
distributes the point budget across the whole closure. The reusable high-level
controller retains complete-depth as its default.

The basic viewer uses the library's `activePointGeometryWorkerCancellation:
"soft"` policy for the integrated COPC geometry worker path. On camera movement
the old render is first marked stale so late progress cannot update the screen.
After the next camera selection is known, the viewer compares the previous and
current node families: overlapping zoom/pan work may finish in the background,
while unrelated stale consumers are canceled. Soft cancellation keeps the
worker alive long enough for an in-flight range/decode to populate its decoded
cache before reporting cancellation, instead of terminating a cold worker and
repeating the same large range on another worker. Independent current-view nodes
can still use other idle workers. The controlled Eptium trace accepted this
tradeoff only after the repeatable large-node abandonment disappeared without a
first-ready regression.

Applications can still opt into `"terminate-uncached"` or `"terminate"` when
discarding stale work is more important than cache/network reuse. When terminate
cancellation replaces a worker, the integrated geometry worker pool remembers
the most recent source-aware warmup request and replays it on replacement
workers, including the already parsed COPC metadata.

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
consume the whole source budget by itself. This preview is an interactive
placeholder and is never counted as terminal composition.

The basic viewer's camera-stream adaptive budget now also adjusts the per-node
source-point and point-data caps. When a completed camera stream reports slow
source work, especially a high max decode or worker round-trip time, the next
stream update reduces not only the render/source/total compressed budgets but
also the maximum source points and compressed bytes allowed for any single
selected node. Background prefetch uses the same adaptive caps, so stale or
next-view work cannot keep decoding node ranges that the current-view budget
has already judged too expensive. After a few fast runs, the caps recover
gradually with the other adaptive budgets.

Adaptive limits apply to in-motion requests only. Once the camera settles, the
terminal current-view request uses the configured LOD ceilings again while
retaining the adaptive history for the next movement. This prevents a slow or
superseded request from making an unchanged pose terminate one complete depth
shallower, so final density is determined by camera, quality preset, and hard
user cap rather than request timing history.

The adaptive source-point floor stays high enough for the camera stream to keep
the current-view density meaningful after repeated slow source runs. This avoids
the failure mode where queue time improves only because the next render has
fallen below the benchmark's minimum visible point count.

Closer camera-stream LOD profiles keep individual-node eligibility at least as
large as overview while raising aggregate source and compressed-byte budgets.
This is required by complete-depth selection: lowering a per-node cap can make
one dense tile reject the whole depth and produce less detail after zooming in.
Adaptive camera-stream control therefore constrains aggregate work without
letting its per-node eligibility fall below the active LOD profile. Autzen
browser smoke compares overview and 946 m terminal states and requires deeper
selection, a larger current-view frontier, non-decreasing rendered points, and
an exact additive terminal composition.

Cold close/near streams may publish `interactive-ready` once their point and
coverage policy is satisfied, but that status is not final detail. The default
terminal path waits for every bounded request window and then replaces the
preview/background composition with the exact required node set. A 90% or 95%
subset remains `refining` regardless of point count or weighted coverage.

Typed-array camera-stream progress is also evaluated in smaller spatially
balanced batches. Cesium primitive submission is no longer the dominant cost in
the benchmark, so checking completion more often lets the stream publish the
foreground result without waiting for a large progress batch to finish.

The basic viewer keeps remaining current-view loads alive after interactive
readiness, but uses `postStopLoadingMode: "await"` and
`postStopProgressMode: "render"`. The active window is refilled until all
planned nodes have settled; the final render Promise does not resolve as
terminal at the early threshold. Moving the camera still aborts the parent
request, so an invalidated view cannot publish late progress.

`createCopcCameraStreamVisualQualityState()` is the terminal gate. It requires
an ancestor-free frontier, every frontier node, the complete planned additive
ancestor closure, and no stale or unexpected rendered node. Point-budget fill,
raw node coverage, and weighted coverage remain useful interactive and density
telemetry, but none can make an incomplete composition terminal.

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
worker with not-yet-needed tail nodes. In the default terminal path this is a
concurrency window, not a completeness cap: after interactive readiness it
continues enqueueing later windows, suppresses misleading intermediate final
commits, and submits the exact terminal composition only after all required
nodes are available. Low-level `background`/`load-only` callers may deliberately
stop after the active window, but that result is non-terminal.

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

Progressive preview plans can still cap and distribute a final-node subset, but
the default `complete-depth` terminal plan does not truncate its frontier with
that cap. Once a complete depth fits the source and byte budgets, every selected
frontier node and every available additive ancestor belongs to the required
terminal set.

Likewise, the LOD-specific progressive per-final-node cap is not applied to a
complete-depth terminal plan. The configured total render budget is divided
across the full additive closure and bounded by the caller's general per-node
limit. Both complete-depth and mixed-depth terminal paths derive weights from
the hierarchy `pointCount` of every required key, including additive ancestors.
A deterministic integer weighted water-fill assigns a proportionate share,
caps each node at its available samples and per-node limit, and redistributes
unused points when a small node saturates. The object, typed-channel, and
integrated-worker geometry paths use the same allocator; low-level calls without
weights keep the previous equal-share behavior.

The reference viewer deliberately exercises the stricter mixed-depth terminal
path instead of changing that public default. It reserves a visible-tree
baseline near one depth above the target and its complete additive closure, then
uses remaining node/point/compressed-byte budget only for atomic groups of all
immediate visible, renderable siblings. If the whole group does not fit, the
parent stays in the frontier. This keeps the terminal frontier an antichain and
prevents one greedy child refinement from creating isolated dense patches over
an otherwise coarse footprint. Since this selector has already charged the
complete additive closure to its source-point and compressed-byte budgets, the
mixed-depth render plan enables source headroom: it loads up to the configured
per-node cap and applies the total point budget during composition. The
complete-depth default retains its render-budget-derived per-node load cap
because its selector budgets the same-depth frontier before ancestors are
appended. The low-level headroom switch remains explicit and defaults off.

For the default typed-array primitive renderer, camera-stream detail rendering
commits at most one newly decoded node per progress step and yields to an
animation frame between terminal-tail additions. This avoids uploading several
new GPU buffers in one frame. The slower `PointPrimitiveCollection` fallback
keeps its separate four-node cadence to limit object-renderer resubmission cost.

Interactive response timing and terminal-settle timing are now measured as
separate contracts. Early preview or readiness may stay fast even when cold
range reads and LAZ decode make the verified terminal commit slower; benchmark
reports must not relabel that early timestamp as final-detail total. The early
timestamp must itself be tied to `app-render-commit` or a revision-verified
`app-render-retained` frame.

The typed-array primitive renderer API keeps worker-prepared geometry batches as
per-node primitives by default. Since the integrated worker already returns
node-sized typed arrays, this avoids concatenating multiple decoded nodes into a
new large array just to submit them to Cesium. Balanced, detail, and ultra use a
four-batch ceiling to reduce draw primitives. Their incomplete progressive tail
still keeps one stable primitive per node; when the batch or point limit seals a
group, it is merged once instead of rebuilding a growing 1 -> 2 -> 3 -> 4
buffer. During progressive camera updates, completed chunks retain their keys
while later nodes finish.

Adaptive splats project each batch's CRS-aware world-space spacing and retained
sample ratio to screen pixels, then clamp the size to the active quality
preset's minimum and maximum. Missing spacing metadata keeps the fixed-size
fallback. A single batch, or a merged group whose effective Float32 spacing is
uniform, embeds the spacing once as a shader constant instead of uploading a
4-byte-per-point attribute; mixed-spacing chunks keep that attribute fallback.
For ground ellipses, covariance row extents bound a rotated footprint, and the
balanced/detail/ultra 1.25/1/1 CSS-pixel safety halos expand both axes after the
  bounded base-size calculation. The fragment shader reconstructs the ellipse
  axes from the projected covariance and applies the analytic coverage test.
  Optional eye-dome lighting wraps only this
renderer's opaque point commands and feature-detects the Cesium runtime/WebGL
support; unsupported devices keep direct primitives. Balanced, detail, and
ultra enable EDL and disable scene FXAA; preview keeps both off. Performance
comparisons must therefore record the selected quality preset instead of
treating either post-process policy as a scene-wide constant.

The renderer-quality A/B gate isolates footprint quality from COPC selection.
`npm run benchmark:quality-ab` renders the same source, terminal additive node
set, point budget, camera pose, drawing buffer, DPR, and render signature with
the compatibility renderer and the enhanced renderer. Each capture pairs a
point-on canvas with a point-off canvas; their RGB difference removes the
unchanged Cesium background and UI before coverage, bounded 1-3 px gaps,
isolated pixels, edge perimeter, and morphology-based micro-hole metrics are
calculated. The candidate mask is also checked against a 3 px dilation of the
compatibility mask: at least 95% of baseline foreground must remain, no more
than 0.1% of candidate foreground may lie outside that support, and no more
than 0.1% of the remaining large baseline-void area may be painted. This keeps
a full-canvas or halo-producing splat from passing merely by increasing
coverage and reducing edge count. Exact string equality is used for node keys, render signatures,
point counts, canvas dimensions, and projection state. Camera position allows
10 micrometres and orientation allows `1e-12` only to ignore floating-point
roundoff; the latest diagnostic observed zero position and orientation delta.
Console and page errors invalidate the run.
The default command runs AB then BA and exits nonzero for both incomparable
(`invalid`) and failed quality/performance (`needs-work`) verdicts.

The latest 2026-07-16 post-change checkpoint on Chromium WebGL2/ANGLE
Direct3D11 with an RTX 3060 used the Autzen classified source response identified
by ETag `dbb36ebb301306feb94c5e313524492c-10`, 53 required additive nodes,
1,047,575 rendered points, and a 1600x900 drawing buffer. This diagnostic run
used the command's normal two-repeat AB/BA order. The compatibility
screen-circle path and enhanced ground-ellipse path produced:

| Metric | Compatibility | Enhanced | Ratio |
| --- | ---: | ---: | ---: |
| Point-pixel canvas coverage | 62.080% | 70.939% | 1.143x |
| Bounded 1-3 px gap ratio | 12.586% | 0.839% | 0.067x |
| Isolated foreground ratio | 0.000447% | 0% | 0x |
| Edge perimeter / foreground pixel | 0.3215 | 0.0328 | 0.102x |
| Average FPS during the camera step | 60.000 | 59.997 | 1.000x |
| p95 frame interval | 16.75 ms | 16.80 ms | 1.003x |

The enhanced mask retained 99.4542% of baseline foreground; both unsupported
candidate expansion and large-void intrusion were 0%. All
equivalence and quality gates passed; the machine-readable report, paired
images, and binary masks are written to `output/quality-ab`. This proves the
enhanced renderer against this repository's compatibility path under controlled
conditions. It is not a same-camera, same-source comparison with Eptium and
must not be used by itself to claim product-level superiority over that viewer.

## Controlled Eptium Comparison

`npm run benchmark:eptium-comparison` performs the external comparison that the
renderer-only A/B above intentionally does not claim. The harness opens live
Eptium and the local viewer in one isolated Chromium session, verifies the same
Autzen COPC URL, ETag, 81,123,042-byte object, 21-field ECEF camera pose,
1600x900 drawing buffer, DPR 1, and WebGL renderer, and rejects non-terminal or
UI-contaminated captures. Stock EDL-on visual output is preserved as a separate
image for each configuration. Geometry-mask metrics are instead captured with
EDL disabled for both viewers and paired with point-off counterfactuals. Eptium
uses `Cesium3DTileStyle.show=false` plus `makeStyleDirty()` before and after its
point-on image; those two baseline images must be byte-identical. Eptium's base
canvas is deterministically nonblack even though the Cesium scene is configured
opaque black, so blackness is recorded only as a diagnostic and is not treated
as point coverage. The local point-off frames are pure black and stable. Fair
frame timing remains on the stock visual page and uses the same discarded warmup
and fixed 1.2-second, 12-step camera movement at a 60 FPS target. The local stock
and geometry-mask reloads must also have identical terminal point counts, render
signatures, selected node keys, camera fingerprints, canvas sizes, and DPR.

The live 2026-07-17 two-repeat AB/BA run used Eptium's stock SSE 32, 3 px point
style, attenuation, EDL strength 2.4/radius 0.8, MSAA 4, and its normal 10 FPS
application cap. The fair-timing pass temporarily set both viewers to 60 FPS.
The browser reported an NVIDIA GeForce RTX 3060 through ANGLE Direct3D11. The
table reports the median across the two opposite-order repeats. `Product first
ready` includes fresh page navigation, initial terminal loading, and the shared
comparison pose; unlike frame timing, it observes browser HTTP-cache state
rather than forcing a cold browser cache.

| Configuration | Rendered points | Coverage | Bounded gaps | Edge / foreground | Fair p95 | Fair max | Product first ready | Product ranges |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Eptium stock | 1,047,575 | 86.151% | 0.2991% | 0.010569 | 17.15 ms | 18.15 ms | 16,495.0 ms | 55 |
| Local shipped balanced | 720,000 | 86.559% | 0.2450% | 0.010168 | 17.10 ms | 19.65 ms | 15,971.0 ms | 60 |
| Local high detail | 1,440,000 | 86.717% | 0.2230% | 0.009259 | 17.00 ms | 19.30 ms | 14,081.0 ms | 60 |
| Local equal count | 1,047,575 | 86.678% | 0.2238% | 0.009536 | 17.15 ms | 19.35 ms | 15,555.5 ms | 60 |

The shipped-default and high-detail rows are descriptive, non-equivalent
comparisons: the former renders 31.27% fewer points than Eptium at this pose,
while the latter renders 37.46% more. The high-detail target is the observed
1,440,000-point terminal result, not the 720,000-point preset base budget;
Eptium's tested discrete SSE values did not produce an equivalent point count.
Both descriptive local rows nevertheless passed all four visual/performance
gates at their respective point counts.

The strict equal-count comparison is `passed`. With exactly 1,047,575 points,
local coverage is 0.5266 percentage points higher, bounded gaps are 25.18%
lower, edge perimeter per foreground pixel is 9.79% lower, and fair p95 is
equal at 17.15 ms. Product first-ready time is 939.5 ms, or 5.70%, lower than
Eptium; local product-ready time is also 1,797.0 ms, or 10.36%, lower because
the local terminal is already stable when first reported. Both equal-count point-count
pairs are exact, all visual and p95 gates pass, Eptium foreground retention is
99.9497%, and unsupported expansion plus large-void intrusion are both zero.
This establishes a visual-quality and product-ready advantage at this one
controlled Autzen checkpoint, with matching p95 frame timing.

This checkpoint also records product-only COPC request traffic. Eptium issued
55 ranges, requested 16,160,948 bytes, duplicated 17,792 exact-range bytes,
abandoned no requests, and had a 1.0011 request-amplification ratio. The local
equal-count run issued 60 ranges, requested a 17,437,756-byte unique union,
duplicated no exact ranges, abandoned four transition-time predictive prefetch
requests, and had an exact 1.0 amplification ratio. The four abandoned ranges
total 368,651 bytes and received no body before the harness moved to the
geometry-mask reload, leaving 17,069,105 responded requested bytes. The local
viewer therefore wins this checkpoint's visible quality, readiness, exact
duplicate, and amplification measures, but still issues five more ranges and
its unique requested-byte union is 1,294,600 bytes or 8.02% above Eptium's
16,143,156 bytes.

The structural optimization behind this checkpoint reuses parsed main-thread
COPC metadata when point-sample workers start, when integrated geometry workers
perform source-aware warmup, and on every geometry load or prefetch request. A
later parsed value also replaces a failed worker-local bootstrap promise, so a
pre-metadata warmup cannot poison that worker. An older one-repeat capture
repeated the 64 KiB LAS/COPC header and COPC VLR roughly ten times across
worker-local sources; the current captures request each once, including for
workers created lazily after warmup.

The example also keeps superseded uncached geometry work on soft cancellation
so a nearly completed large-node fetch can populate its worker cache instead of
terminating the worker and immediately repeating the same range. Relative to
the original pre-change capture, strict equal-count traffic fell from 85 to 60
ranges and from 22 exact duplicates to zero. Strict decoded-worker affinity is
the final step in that reduction: density upgrades now wait for the worker that
owns the decoded node instead of crossing the former 120 ms fallback boundary
and repeating the range read and LAZ decode elsewhere. The remaining network
gap is unique work: three extra completed nodes support the higher measured
coverage, while four predictive prefetches are cut off only when the comparison
harness leaves the product page. Coalescing adjacent ranges and cancelling
transition-time prefetch earlier are the next optimization targets, without
silently trading away the measured visual advantage.

It does not establish total-network or universal superiority. The local median
per-repeat maximum is 19.35 ms versus Eptium's 18.15 ms in this run, and this
tail metric remains sensitive to individual browser/GPU stalls. Local request
amplification is lower, but request count and the unique byte union remain
higher. Both FPS results are effectively capped at 60, and other camera poses,
COPC distributions, GPUs, drivers, browsers, and Eptium releases still require
their own measurement.
Different LODs may select different source point IDs, so Eptium mask support and
void comparisons remain non-blocking diagnostics. All six local stock/mask
workload pairs matched on point count, render signature, selected node keys,
camera pose, canvas, and DPR. Both masks for each configuration were
byte-identical, and every point-off pre/post pair was byte-stable.

The machine-readable result and hashed paired images are in
`output/eptium-comparison/eptium-comparison-result.json`. It records the live
Eptium main-bundle URL and ETag because the remote application can change after
this checkpoint. Its SHA-256 is
`a8ac8d1e72c8a7dfc53b9e6142110704fd8e406ac5609283ba9df860a363f1e2`.
The separately hashed raw request ledger is
`output/eptium-comparison/eptium-comparison-network-trace.json` with SHA-256
`9f91a00b788fbdff075da0a96be8428632232e2cda95d082bdf479aaa2646116`.

For an unchanged exact terminal plan, even that stable-batch resubmission is
unnecessary. The viewer retains the committed result only when the complete
node set, per-node density, total point budget, layer identity, and the layer's
monotonic renderer revision all still match. Any renderer mutation invalidates
that proof. Before evaluating retention, the request controller aborts every
superseded render-capable request because a stale progress callback could still
mutate the shared Cesium renderer even if its later publication were rejected;
only load-only overlap may remain reusable.

During preview/refinement, render point budgets are distributed across all
currently renderable current-view nodes before leftover budget is assigned to
retained background coverage. The terminal commit then distributes its budget
across the exact additive closure and removes the retained preview layer. When a
cached object, typed-channel, or geometry result must be reduced, it keeps a
prefix of the node's stable Morton/bit-reversal progression. The initial Morton
order quantizes XYZ to 10 bits per axis and uses a four-pass stable radix sort;
every density (including the full node) shares the same prefix. Positions,
colors, and attribute channels stay aligned, density changes retain the already
visible points, and the prefix is
distributed through the node rather than biased toward source payload order.
Point-sample and integrated geometry workers cache this spatial order once per
retained decoded node. It is a `Uint32Array`, so decoded-view accounting adds
exactly 4 bytes per decoded point; later density changes reuse the cached order
instead of paying another sort.

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
the basic viewer now keeps the same strict default because the controlled
Eptium request ledger showed that a short fallback delay could still re-fetch a
node that had just been decoded on another worker. If the exact same node is
already active, the duplicate node request still waits for it instead of
starting the same LAZ decompression twice. The queue still scans past that
blocked request, so unrelated current-view nodes can continue to dispatch in
parallel.

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
decoded views and 192 MiB per worker. Applications can additionally set
`maxDecodedPointDataViewBytesAcrossWorkers`; the layer splits that aggregate
ceiling across active sample and integrated-geometry worker slots, and each
pool derives a per-worker share that cannot exceed the explicit per-worker
ceiling. This prevents hardware-scaled concurrency from multiplying the cache
into an unbounded multi-gigabyte envelope. The basic viewer retains up to 128
views per worker, caps each worker at 128 MiB, and enforces a 768 MiB aggregate
decoded-view ceiling across both pools. Worker responses publish retained,
peak, hit, miss, eviction, and oversized-skip snapshots so the browser demo and
benchmarks can verify the envelope instead of inferring it from configuration.

The worker pool sizing policy keeps point-sample workers conservative and caps
integrated COPC geometry workers for visible latency instead of maximum
background throughput. The default policy falls back to four point-sample
workers and five integrated geometry workers, caps point-sample concurrency at
six, caps integrated geometry concurrency at eight, keeps strict decoded-node
worker affinity for the basic viewer, reserves browser capacity for rendering,
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
replace node-level decoded-view caches, and point/hierarchy bytes are still not
shared across separate browser workers. Parsed COPC metadata is now explicitly
seeded across that boundary; all remaining exact-range reuse is local to one
source or worker. A future source-wide request broker is still needed to
coalesce overlapping point-data work across worker globals.

The camera-stream render plan can skip the coarse coverage preview when the
current final detail set is already small. The basic viewer uses this for views
with fewer than five final detail nodes, so those views submit dense
current-view nodes to the worker pool immediately instead of spending a pass on
temporary preview coverage that would be replaced almost at once.

Because that fast path can finish while the camera is still moving, background
hierarchy and point prefetch is delayed and canceled by newer camera moves. In
the exact-retained path the viewer does not queue predictive prefetch at all
while movement is active; once movement stops, it uses at least a 350 ms delay.
This keeps background preparation from competing with the current-view stream
while the user is actively navigating.

For longer high-density camera-stream passes, the basic viewer waits until the
current-view detail pass has made final progress before preparing the next
likely view. Earlier predictive prefetch can warm more nodes sooner, but the
warm close-zoom benchmark showed that it competes with foreground LAZ decoding
and hurts smoothness. The prefetch controller still allows only one active
prefetch and newer camera moves still cancel it, but background work is kept out
of the way until the current view has produced usable detail.

The remaining terminal-settle long pole is the cold range-read and LAZ decode
cost for required nodes, not Cesium point submission. New performance baselines
must be captured after the terminal visual-quality gate and must include the
structured composition state; pre-gate partial-coverage runs are not comparable
final-detail evidence.
