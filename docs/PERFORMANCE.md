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

Package smoke also caps the compressed npm tarball at 650 KiB and each packed
worker JavaScript asset at 600 KiB. The integrated COPC geometry worker is
deliberately emitted as a separate worker asset; keeping a hard ceiling catches
dependency or bundling regressions without disguising Vite's raw chunk warning.
The 2026-07-14 example-build snapshot also verifies the deliberate `proj4`
split: uncompressed generated JavaScript was 367.93 kB for the app entry and
131.70 kB for the `proj4` chunk. Those figures identify one source build, not
compressed transfer size, startup cost, or a permanent size guarantee.

Reports record the actual WebGL adapter. The default requests high performance;
an integrated-GPU check removes that request and asserts the real renderer:

```powershell
$env:COPC_BROWSER_GPU_PROFILE="low-power"
$env:COPC_BROWSER_GPU_RENDERER_PATTERN="AMD Radeon\(TM\) Graphics"
npm run benchmark:smoothness:contest
```

Windows can still choose another adapter, so the assertion and recorded renderer
are authoritative. Prefer environment variables with `npm run`; set
`COPC_BROWSER_HEADED=1` for a visible smoothness run. The profile and headed
state are persisted.

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

### Integrated-GPU device check (2026-07-19)

On the Ryzen 5 7600 host, asserted AMD runs reached 20,000 points, full coverage,
and zero browser errors, but averaged only 22.10/23.51 FPS headless and
13.78/14.37 FPS headed on Autzen/Millsite. Asserted RTX 3060 runs reached 60 FPS.
Thus the iGPU is functionally compatible but fails the 30 FPS gate. A cold-detail
A/B retained the 64 KiB gap and four workers; 240,000 points kept the same 80
nodes and did not improve FPS. Artifacts remain under
`output/smoothness-benchmark/`; these are tuning results, not an iGPU release
pass.

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
| Point-geometry worker timing            |                              optional max round-trip/point-data-view/worker/queue gates |
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

`COPC_SMOOTHNESS_ASSERT_MAX_GEOMETRY_DECODE_MS` keeps its historical name for
artifact and environment compatibility, but it limits the full point-data-view
wait rather than pure decompression CPU. Current structured artifacts also
record range wait/count/bytes, laz-perf initialization, non-range view work,
and decoded-view cache wait separately. The non-range remainder includes setup
and view construction as well as decompression, so it is intentionally not
labeled as a pure decoder profile.

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
maximum worker point-data-view/round-trip timing of 1,789.3/1,798.7 ms (the
historical artifact labeled the first value as decode). The first visible
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
| Cold detail 1 |  56,715 |                         27/28 |        96.4% / 100.0% |    59.3 |  6,798.3 ms | max view 2,604.9 ms   |
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
source work, especially a high max point-data-view or worker round-trip time, the next
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
| Eptium stock | 1,047,575 | 86.151% | 0.2992% | 0.010569 | 17.05 ms | 17.25 ms | 16,843.0 ms | 55 |
| Local shipped balanced | 720,000 | 86.559% | 0.2450% | 0.010168 | 17.00 ms | 20.00 ms | 11,073.5 ms | 33.5 |
| Local high detail | 1,440,000 | 86.717% | 0.2230% | 0.009259 | 16.90 ms | 18.35 ms | 10,472.5 ms | 35 |
| Local equal count | 1,047,575 | 86.678% | 0.2238% | 0.009536 | 17.10 ms | 19.00 ms | 11,064.5 ms | 33.5 |

The shipped-default and high-detail rows are descriptive, non-equivalent
comparisons: the former renders 31.27% fewer points than Eptium at this pose,
while the latter renders 37.46% more. The high-detail target is the observed
1,440,000-point terminal result, not the 720,000-point preset base budget;
Eptium's tested discrete SSE values did not produce an equivalent point count.
Both descriptive local rows nevertheless passed all four visual/performance
gates at their respective point counts.

The strict equal-count comparison is `passed`. With exactly 1,047,575 points,
local coverage is 0.5266 percentage points higher, bounded gaps are 25.18%
lower, and edge perimeter per foreground pixel is 9.78% lower. Fair p95 is
17.10 ms locally versus 17.05 ms for Eptium. Product first-ready time is
5,778.5 ms, or 34.31%, lower than Eptium; local product-ready time is also
6,641.0 ms, or 37.51%, lower because the local terminal is already stable when
first reported. Both equal-count point-count pairs are exact and all visual and
p95 gates pass. This establishes a visual-quality, request-count, and
product-ready advantage at this one controlled Autzen checkpoint.

This checkpoint also records product-only COPC request traffic. Eptium issued
55 ranges, requested 16,160,948 bytes, duplicated 17,792 exact-range bytes,
abandoned no requests, and had a 1.0011 request-amplification ratio. The two
local equal-count product runs issued 35 and 32 ranges (33.5 median), completed
31 in both runs, duplicated no exact ranges, and recorded zero overlapping
requested bytes with an exact 1.0 amplification ratio. Transition-time
predictive prefetch accounted for four abandoned requests in the first order
and one in the second; they received no body. Local responded requested bytes
were therefore a repeatable 17,069,105, 5.62% above Eptium, while the median
unique requested-byte union was 17,297,429 bytes, 7.15% above Eptium's
16,143,156 bytes. The extra byte volume remains a real tradeoff associated with
the higher measured coverage, but the local request count is 39.09% lower.

The structural optimization behind this checkpoint adds a pool-owned
main-thread range broker. Integrated geometry workers use a proxy COPC Getter,
so one validated URL or Blob getter and its bounded raw-byte cache are shared
across workers while LAZ decode remains parallel. At that checkpoint, each
render or prefetch wave sorted required node offsets and lazily grouped
exact-contiguous point data into spans capped at 2 MiB with zero configured
gap. Completed and in-flight larger
ranges can serve contained requests without another source read. Later plans
exclude nodes whose geometry or decoded point view is already reusable, which
removed the 1,393,625 bytes of partial overlap seen in the first broker
prototype. Terminating cancellation modes retain direct worker reads so worker
termination still stops their network work; the shared broker is used with the
default soft-cancellation path.

The example also keeps superseded uncached geometry work on soft cancellation
so a nearly completed large-node fetch can populate its worker cache instead of
terminating the worker and immediately repeating the same range. Relative to
the original pre-change capture, strict equal-count traffic fell from 85
requests and 22 exact duplicates to a 33.5-request median and zero exact
duplicates or overlap. Metadata reuse and strict decoded-worker affinity remain
part of that reduction: density upgrades wait for the worker that owns the
decoded node instead of repeating its range read and LAZ decode elsewhere. The
remaining network gap is byte volume rather than request count. Transition-time
predictive prefetch cancellation and validation on more cameras, datasets, and
devices are the next targets, without trading away the measured visual
advantage.

It does not establish total-network or universal superiority. The local median
per-repeat maximum is 19.00 ms versus Eptium's 17.25 ms, and local p95 is
0.05 ms higher in this run. Local request count and amplification are lower,
but completed response bytes and the unique byte union remain higher. Both FPS
results are effectively capped at 60, and other camera poses,
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
`4fb767e78a2207193469d3796a79e94c6b3f99266a8aafa8573340e21e835dd9`.
The separately hashed raw request ledger is
`output/eptium-comparison/eptium-comparison-network-trace.json` with SHA-256
`eb871d0ad738d038910bbed95cc5ef54464e553c634205579292dbc93bc80326`.

### Range-Wait Follow-up and 64 KiB Default

The next 2026-07-17 Millsite investigation added a browser HTTP Range ledger to
the smoothness harness and split point-data-view time into range wait,
laz-perf initialization, non-range view work, and decoded-view cache wait. The
ledger keeps the exact `Range` header, response status and `Content-Range`,
requested and received sizes, timing, outcome, duplicate bytes, and overlap
union for every measured request. Each result also contains summaries for
`camera-movement`, `terminal-refinement`, and `post-terminal-prefetch`.

The per-result request list and combined summary are the canonical workload
scope. The artifact-level list can also contain setup traffic outside a
measured result. Phases are assigned from request-start time against controller
boundaries, so a request racing a boundary can move between adjacent phase
counts; combined count and bytes remain canonical. The harness waits for
pending browser size records before finalizing successful requests and detaches
abandoned requests so late browser events cannot mutate a completed artifact.

Rejected A/B experiments remain absent from the runtime: same-range worker
serialization was 4.4% slower, predictive-prefetch deferral did not change the
workload, and planned-range prewarm's noise-sized 1.6% terminal gain came with a
91% regression in maximum per-node range wait.

The remaining controlled sweep changed only the maximum gap bridged within the
existing 2 MiB span cap. All runs retained 59.2 average FPS, 16.8 ms p95 frame
time, and 100% terminal node and weighted-node coverage.

| Maximum gap | Run | Terminal refinement | Movement + refinement | HTTP ranges | Requested bytes |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 1 | 21,612.3 ms | 23,111.0 ms | 138 | 17,526,206 |
| 64 KiB | 1 | 20,230.7 ms | 21,750.2 ms | 134 | 17,584,657 |
| 64 KiB | 2 | 20,230.0 ms | 21,723.9 ms | 134 | 17,584,657 |
| 128 KiB | 1 | 20,326.3 ms | 21,804.8 ms | 132 | 17,812,624 |
| 256 KiB | 1 | 20,822.6 ms | 22,329.5 ms | 117 | 19,821,404 |

The 64 KiB setting was adopted as the integrated-worker pool default because
it deterministically removed four requests for 58,451 extra bytes, a 0.33%
increase, and repeated without changing quality. The 128 KiB setting fetched
more bytes without a meaningful time win, while 256 KiB crossed into 13.1%
overfetch and worse tail network timing. These are live-network samples rather
than a latency guarantee; the conservative default is justified primarily by
the repeatable request/byte tradeoff, with `0` remaining available for sources
where gap overfetch is expensive.

A final no-override run confirmed that the default itself produced the expected
134 requests and 17,584,657 requested bytes: 9 / 1,676,486 during movement,
82 / 8,557,857 during terminal refinement, and 43 / 7,350,314 during
post-terminal prefetch. It held 59.2 FPS, 16.8 ms p95, 33.3 ms maximum frame,
and 100% terminal node/weight coverage. The adjacent-phase split can vary when
requests race a boundary, while the combined total is deterministic for this
workload.

A one-repeat equal-count Eptium check then confirmed that the 64 KiB default
preserved the existing visual and p95 gates while retaining the known
fewer-requests/more-bytes tradeoff. The later two-repeat result below is the
stronger comparison evidence.

A controlled worker-concurrency sweep then varied only the integrated geometry
worker count for Millsite cold-detail runs. Workers 2, 4, 6, and 8 averaged
20,546.9 ms, 20,098.4 ms, 20,513.2 ms, and 20,665.0 ms terminal refinement,
respectively. Each setting had two repeats except worker 8, which had three.
Every run rendered 360,000 points with 80/80 nodes, 100% weighted coverage, 134
ranges, 17,584,657 requested bytes, zero duplicate/overlap/abandoned bytes, and
16.8-16.9 ms p95 frame time.

| Integrated geometry workers | Terminal refinement mean | Range-wait sum mean | Max range wait mean | Queue sum mean | Max queue mean |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | 20,546.9 ms | 10,032.4 ms | 553.6 ms | 11,781.1 ms | 769.9 ms |
| 4 | 20,098.4 ms | 19,368.5 ms | 1,085.6 ms | 3,933.5 ms | 317.7 ms |
| 6 | 20,513.2 ms | 28,870.6 ms | 1,568.7 ms | 1.7 ms | 0.4 ms |
| 8 | 20,665.0 ms | 28,500.1 ms | 1,560.5 ms | 1.4 ms | 0.3 ms |

The same pass included a controlled Autzen A/B/A comparison against Eptium:
local workers 4 produced 7,949 ms, Eptium 15,704 ms; local workers 8 produced
11,233 ms, Eptium 15,795 ms; then local workers 4 produced 9,533 ms, Eptium
15,904 ms. All three strict comparisons rendered exactly 1,047,575 points,
passed strict quality, kept local p95 at 16.9 ms, 16.9 ms, and 17.0 ms, used
33-35 local product ranges, and responded with 17,069,105 requested bytes.
Worker 4 averaged 8,741 ms versus worker 8 at 11,233 ms, about 22.2% lower,
but this remains live-network evidence only. An auxiliary high-detail worker-4
second run also showed a 33.7 ms p95 anomaly, so frame gates remain required
instead of treating worker count as a standalone pass condition.

The adopted cap of four integrated geometry workers is therefore limited to
`createCopcWorkerPoolSettings()` and the basic viewer policy. The reusable
library layer still defaults to two integrated geometry workers, and explicit
application overrides remain supported for local Blob workloads, alternate
transports, or other measured environments.

After adoption, a no-override verification also clamped background prefetch to
three requests so one of the four integrated workers remains available to a
new foreground camera request. Millsite cold detail still rendered 360,000
points from 80/80 nodes with 100% weighted coverage, 134 ranges, and 17,584,657
requested bytes. Terminal refinement was 20,270.2 ms; summed/max range wait was
19,365.5/1,145.6 ms and summed/max queue wait was 1.1/0.3 ms. Movement frames
held 16.8 ms p95 and 33.3 ms maximum. Terminal-refinement frames held 16.8 ms
p95; one 100.2 ms frame used the cold-detail profile's single-frame allowance
and remained below its 150 ms hard ceiling.

The final no-override Autzen run also passed the strict equal-count contract:
both viewers rendered exactly 1,047,575 points, Eptium reached product-ready in
15,895 ms, and the local viewer reached it in 9,517 ms, 40.1% lower in this
repeat. Local p95 was 17.0 ms versus 17.2 ms, coverage was 86.678% versus
86.151%, and bounded gaps were 0.2238% versus 0.2990%. The local product issued
34 ranges versus 55, with zero exact duplicate or overlapping requested bytes;
it requested 17,394,176 bytes and received responses for 17,069,105 bytes. This
closes the default-wiring check, but it remains one live Autzen repeat rather
than a device-, dataset-, or network-independent guarantee.

A subsequent warm-detail investigation separated one remaining long frame from
network and decode cost. The failing run had 75/75 point-geometry cache hits,
zero Range requests, zero worker/queue time, and a complete 360,000-point,
80-node terminal composition, but exact 88-to-80-node renderer reconciliation
took 55.1 ms inside an 82.6 ms camera-stream pass and landed on a 100.0 ms
frame. The second repeat performed the same handoff in 66.7 ms, just below the
67 ms p95 gate. Re-running until this noise passed would not remove the viewer
stall.

The reference viewer now retains a revision-proven committed world-space point
frame during camera motion, continues current-view selection and cache-only
warming, cancels the last in-motion render before the settled request, and only
replaces Cesium geometry after movement when the exact additive plan changed.
The warm hierarchy harness also snapshots and restores the settled frontier so
both measured repeats receive the same hysteresis input rather than whichever
movement request happened to finish last.

The no-override warm-detail rerun passed both repeats with 360,000 points,
80/80 required nodes, selected depth 5, and 100% node and weighted coverage.
Both runs retained the exact render at the same renderer revision, recorded
60.0 FPS, 16.8 ms p95, 16.8 ms maximum, and zero frames above 50 ms. The
no-override cold-detail rerun also passed with the same point/node/depth/coverage
contract, 134 requests and 17,584,657 requested bytes. Camera movement recorded
59.2 FPS, 16.8 ms p95, 33.4 ms maximum, and zero frames above 50 ms; the 19.948
second cold terminal-refinement window recorded 16.8 ms p95 and 83.4 ms maximum.

The post-change direct `--repeats=1` Autzen comparison passed the strict
equal-count contract again. At exactly 1,047,575 points, Eptium/local coverage
was 86.151%/86.678%, bounded gaps were 0.2991%/0.2238%, and fair p95 was
17.1/17.1 ms. Eptium/local product first-ready was 15,467/8,411 ms, so local was
45.6% lower in this repeat; stable product-ready was 16,344/8,411 ms. Local used
34 product ranges versus 55, with zero exact duplicates or overlapping requested
bytes. It requested 17,394,176 bytes and received 17,069,105 bytes, so the lower
request count and timing still carry the previously documented higher-byte
tradeoff. This is one live remote repeat on one GPU and pose, not a universal
superiority claim.

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

Point-geometry timing separates aggregate work from the slowest single request.
The example shows summed point-data-view and worker time for work accounting,
while camera-stream adaptive throttling uses the max view/worker/round-trip
fields plus the measured stream total time. Structured timing additionally
separates range wait/count/bytes, laz-perf initialization, non-range view work,
and decoded-view cache wait. This both avoids over-throttling a healthy parallel
worker run and prevents the full range-plus-decompression wait from being
misreported as pure decoder CPU time.

The 2026-07-17 Millsite cold-detail run on the documented RTX 3060 test host
confirmed why this split matters. Its 1,800.4 ms maximum point-data-view wait
contained 1,787.7 ms of range-getter wait and at most 18.2 ms of non-range view
work; laz-perf initialization was 0.1 ms. Across the terminal result, range wait
was 29,447.6 ms of 29,752.7 ms summed per-node view wait, with 23 successful
exact-range getter returns totaling 3,941.4 KiB and 57 cache hits among 80 node
timings. Multiple nodes can await the same broker outer-range promise, so this
sum is work/wait accounting rather than unique wall-clock latency. The run still
held 59.2 FPS average, 16.8 ms p95, a 33.2 ms maximum frame, and 100% terminal
node/weight coverage. This single live run identifies the Range getter path as
the next investigation target; it does not by itself distinguish remote
transfer latency from shared-span scheduling, nor identify LAZ CPU or Cesium
submission as the dominant bottleneck. Getter-return bytes are not equivalent
to broker outer-range wire bytes, so network-ledger evidence remains required
for request amplification comparisons.

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
The basic viewer calls it lazily before its first manual single-node render. The
default camera-stream path uses the integrated geometry workers, which are still
warmed when the COPC source opens. This avoids starting an otherwise unused
worker pool while keeping manual rendering free of repeated startup cost. No
warmup decompresses a COPC node in advance.

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
background throughput. The default policy falls back to four point-sample and
four integrated geometry workers, caps point-sample concurrency at six and
integrated geometry concurrency at four, keeps strict decoded-node worker
affinity for the basic viewer, reserves browser capacity for rendering and
remote Range traffic, and warms the selected geometry pool up front while still
bounding total worker creation. This reflects the measured bottleneck:
typed-array Cesium submission is usually near-zero milliseconds, while too many
simultaneous remote Range reads accumulate browser-side wait. Applications can
still pass explicit worker counts to `CopcPointCloudLayer` when a different
transport or local Blob workload favors more parallel decoding. Benchmark runs
can also override the basic viewer's integrated geometry worker count with
`COPC_SMOOTHNESS_POINT_GEOMETRY_WORKER_CONCURRENCY` when repeating controlled
concurrency sweeps.

Background camera prefetch is deliberately capped below the integrated geometry
worker pool size. While the current screen is still trying to load denser
detail, the basic viewer keeps background preparation decode-only. After the
current detail pass settles, it can prepare decoded, sampled, Cesium-ready
geometry batches without publishing them to the renderer. This should improve
the next nearby view, but it must not occupy every worker while the current
screen is still loading. The default `backgroundPrefetchMaxConcurrentRequests`
remains four as a reusable upper bound, while the basic viewer clamps the
applied value to one less than its integrated geometry worker count. The
current four-worker viewer therefore dispatches at most three background
requests, preserving one slot for a newer foreground camera request. The
runtime prefetch policy also warms up to 24 base nodes, 120,000 rendered
prefetch points, and 2,500 points per prefetched node before the screen asks for
full detail. Close and near zooms
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
cache exact and contained byte ranges with a bounded in-memory LRU policy. This
does not replace node-level decoded-view caches. Integrated geometry workers
share that lower boundary through the pool-owned broker; the separate
point-sample worker path still retains its own source-local getter. Parsed COPC
metadata is explicitly seeded across both worker paths so metadata bootstrap is
not repeated per worker.

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

### Settled-LOD Checkpoint (2026-07-18)

The 550 m close-detail pose exposed a timing-dependent mixed-depth result. A
fresh fast selection entered at the configured 2.25 px spacing threshold and
could stop at depth 4 with 64 additive nodes, while a slower sequence retained a
deeper frontier down to the planner's 75% threshold, 1.6875 px, and finished at
depth 5 with 80 nodes. Comparing those terminal times would have compared
different visual workloads.

The reference viewer now keeps the default hysteresis while the camera moves and
uses equal refine/retain thresholds at the retention edge after movement stops.
The fixed-pose core regression test confirms that an empty and a prior frontier
select the same nodes when those settled thresholds are equal. The cold and
cache-controlled browser paths then both rendered 360,000 points from the same
80/80 additive nodes at depth 5, with zero budget skips and terminal QC passing.

### Product Persistent-Range Cache Checkpoint (2026-07-18)

`npm run benchmark:persistent-range-cache` measures the opt-in browser
IndexedDB range-cache path as a repeat-visit library feature. The benchmark
builds the real example, clears its browser HTTP and IndexedDB range caches,
loads the Millsite
COPC through the normal `CopcPointCloudLayer`/shared worker broker path, reloads
the page, and requires the repeat to reproduce the same validator-scoped
source, 550 m camera fingerprint, render signature, depth-5 frontier, 80/80
required/rendered additive nodes, 360,000 rendered points, and terminal
renderer-input fingerprint. Every finished
HTTP response must also be a matching `206` with consistent `Content-Range` and
`Content-Length` metadata.

The default persistent block size is 64 KiB. Replaying the prior 132-request
high-detail ledger showed why the original 1 MiB prototype was unsuitable for
this browser storage path: 16.95 MiB of requested spans would occupy 81.00 MiB of unique
1 MiB blocks, versus 23.06 MiB of unique 64 KiB blocks. The smaller default
keeps cross-request reuse while limiting this observed alignment overhead to
1.36x instead of 4.78x.

| Real page lifecycle | Elapsed | Upstream ranges | Response-confirmed bytes | Cache hits / misses | Visual work |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cleared browser and persistent cache | 70,362 ms | 120 | 25,953,475 | 32 / 397 | depth 5, 80/80 nodes, 360,000 points |
| Reloaded page | 3,916 ms | 2 | 2 | 429 / 0 | identical |

The reload reduced end-to-end elapsed time by 94.434%, request count by
98.333%, and upstream bytes by 99.999992% on this run. The cold phase retained
397 blocks / 25,953,473 bytes; the repeat had zero persistent misses. Cache
clear state was verified at zero bytes and entries, the browser HTTP cache was
explicitly cleared, Range metadata had zero invalid responses, and browser
console/page errors were zero. Both phases produced the same ordered terminal
renderer-geometry fingerprint, `4136b54194783a14`, over transformed positions,
colors, batch keys, point counts, and density metadata. The machine-readable
evidence is
`output/persistent-range-cache/persistent-range-cache-result.json`.

This is production-path evidence for repeat visits, not a claim that browser
storage fixes a first user's network path and not a direct Eptium comparison.
It must not be used as evidence that the library beats Eptium in cold-load
conditions. Strong-ETag mode also requires CORS-visible `ETag` and complete
`Content-Range`; otherwise it bypasses persistence. Application-version mode is
available only when the host application can authoritatively version immutable
bytes and provide their length.

The current live Eptium comparison was then rerun with two AB/BA repeats in one
Chromium session on the documented RTX 3060 host. Both viewers used the same
Autzen COPC source, exact camera and 1600x900 canvas, and the strict equal-count
case rendered 1,047,575 points in every repeat.

| Strict equal-count mean | Eptium | Local | Local delta |
| --- | ---: | ---: | ---: |
| Product first-ready | 17,665 ms | 9,699 ms | 45.11% lower |
| Stable product-ready | 18,546 ms | 9,699 ms | 47.70% lower |
| Product range requests | 55 | 34 | 38.18% fewer |
| Canvas coverage | 86.1513% | 86.6780% | +0.5267 percentage points |
| Bounded gaps | 0.2992% | 0.2238% | 25.18% lower |
| Fair movement p95 | 17.0 ms | 17.0 ms | equal |
| Fair movement maximum | 19.7 ms | 20.3 ms | 0.6 ms higher locally |

Local first-ready ranged from 8,941 to 10,457 ms; Eptium ranged from 16,926 to
18,404 ms, so the alternating order did not reverse the result. The local path
requested 17,394,176 bytes and received 17,069,105 bytes versus Eptium's
16,160,948 bytes for both, retaining the known 7.63% requested-byte and 5.62%
received-byte tradeoff. These results prove a repeatable win for this one live
dataset, pose, browser, GPU, and date. They do not prove universal superiority
across devices, networks, COPC distributions, camera paths, or future Eptium
releases.
