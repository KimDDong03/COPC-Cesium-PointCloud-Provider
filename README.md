# copc-cesium

[![CI](https://github.com/KimDDong03/COPC_VIEWER/actions/workflows/ci.yml/badge.svg)](https://github.com/KimDDong03/COPC_VIEWER/actions/workflows/ci.yml)
[![Live COPC Browser Evidence](https://github.com/KimDDong03/COPC_VIEWER/actions/workflows/example-smoke.yml/badge.svg)](https://github.com/KimDDong03/COPC_VIEWER/actions/workflows/example-smoke.yml)
[![GitHub Pages](https://github.com/KimDDong03/COPC_VIEWER/actions/workflows/pages.yml/badge.svg)](https://github.com/KimDDong03/COPC_VIEWER/actions/workflows/pages.yml)

CesiumJS-native COPC point cloud streaming and visualization library.

**Live demo:** <https://kimddong03.github.io/COPC_VIEWER/>

`copc-cesium` lets a CesiumJS developer load COPC point cloud data directly from a COPC file or URL, inspect its hierarchy, range-read selected point nodes, transform source coordinates, and render sampled points in a Cesium scene without pre-converting the data to 3D Tiles.

## Goal

Allow a CesiumJS developer to load a COPC file or URL directly into a Cesium scene without pre-converting it to 3D Tiles.

This project handles already-created COPC files. It does not target live LiDAR input, a general point cloud viewer app, or a COPC-to-3D-Tiles conversion pipeline.
Here, streaming means on-demand COPC hierarchy and point-data range reads driven by camera/node selection, not real-time sensor ingestion.

## Current Scope

The pre-1.0 library currently supports:

1. Open remote COPC URLs and browser-selected `File`/`Blob` inputs through one
   source contract.
2. Validate exact HTTP byte ranges, inspect COPC metadata, and load hierarchy
   pages and point-data nodes on demand.
3. Transform geographic, EPSG:2992, and proj4-compatible WKT source coordinates
   into Cesium longitude, latitude, and height.
4. Select camera-visible octree nodes with bounded depth, source-point,
   compressed-byte, and rendered-point budgets.
5. Decode LAZ and prepare Cesium geometry in bounded worker pools with cache
   reuse, cancellation, and request priority.
6. Render through Cesium-native typed-array primitives, point primitives, or an
   experimental buffer backend with shared attribute or layer-global elevation
   coloring, adaptive screen/ground splats, calibrated coverage overlap, and
   optional renderer-scoped eye-dome lighting.
7. Bind camera-driven LOD to Cesium with progressive interactive previews and
   an exact additive terminal composition, immediate stale-task cancellation,
   and revision-proven temporal safe swaps. The reusable high-level controller
   defaults to complete-depth coverage; the reference viewer explicitly opts
   into a coverage-preserving mixed-depth antichain.
8. Verify URL, local file, WKT CRS, package-consumer, cold/warm performance, and
   renderer paths through repeatable browser, paired-image quality A/B, and
   release gates.

Persistent/offline cache storage, non-COPC formats, point-cloud editing, and
application-specific classification styling remain outside the current scope.

The published runtime target is a modern browser application built with an ESM
bundler. CesiumJS 1.140.0 is the minimum supported peer because it is the first
release that provides the exported experimental `BufferPointCollection`
comparison backend; the supported peer range is `>=1.140.0 <2`. Native Node.js
ESM execution is not supported. Node.js 22 and npm 11 are the repository's
development, build, and release-QC toolchain.

## Run

Open the [public reference viewer](https://kimddong03.github.io/COPC_VIEWER/),
or run the same example locally as follows.

Use Node.js 22 and preferably npm 11.16.0. The repository `devEngines` contract
rejects a different Node runtime and warns on an older npm without imposing a
Node engine on installed browser consumers. CI and release workflows bootstrap
the declared npm version before running repository commands.

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`.

## Install in a Cesium App

After the planned 0.1.0 registry release, install the library and its Cesium
peer, then configure Cesium's workers, widgets, and other static assets in the
consuming application. Before that release, `npm run smoke:package` produces the
same installable local tarball under `output/package-smoke/`.

```bash
npm install copc-cesium cesium
npm install --save-dev vite vite-plugin-cesium typescript
```

For Vite, the same asset setup exercised by the packed-consumer browser smoke
is:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";

export default defineConfig({
  plugins: [cesium()],
});
```

Import Cesium's widget stylesheet in the browser entry point. Applications
using another bundler must instead copy Cesium's `Workers`, `Assets`, `Widgets`,
and `ThirdParty` directories and set `CESIUM_BASE_URL` according to that
bundler's Cesium integration. `copc-cesium`'s own point-decoding worker assets
are package-relative and are included in the npm tarball.

## Quick API Example

```ts
import { Viewer } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { CesiumPrimitivePointRenderer, CopcPointCloudLayer } from "copc-cesium";

const viewer = new Viewer("cesium-container", {
  animation: false,
  baseLayer: false,
  baseLayerPicker: false,
  timeline: false,
});
const layer = new CopcPointCloudLayer(viewer.scene, {
  url: "https://example.com/point-cloud.copc.laz",
  maxPointCountPerNode: 5_000,
  pointSampleLoading: "worker",
  pointColorMode: "elevation",
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
  onUpdate: ({ phase, result, visualQuality }) => {
    statusElement.textContent =
      `${phase}: ${result.renderStats.pointCount.toLocaleString()} points` +
      (visualQuality?.isTerminalReady ? " (terminal)" : "");
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
renders, derives bounded LOD settings from height above the transformed COPC
bounds and the selected quality preset, uses the camera eye for screen-space
size estimates while retaining the viewport center for node priority, selects
complete-depth coverage, and progressively renders the latest view with
additive ancestors included.
The default complete-depth path distributes the current LOD point budget across
the full additive node set instead of imposing the small preview-only per-node
cap. Progressive node requests stay bounded, and zoom LOD can therefore use its
larger point budget without flooding the worker queue. `visualQuality` verifies
the exact additive composition when hierarchy data is available.
Both complete-depth and opt-in mixed-depth terminal paths derive a positive
source-point weight for every node in that additive set. A deterministic integer
weighted water-fill gives source-heavy nodes a proportionate share, respects
available samples and the per-node cap, and redistributes budget left by nodes
that saturate early. Low-level progressive calls that omit weights retain the
existing equal-share allocation. The mixed-depth render plan additionally opts
into source headroom: it can load to the configured per-node cap because its
selector already budgeted the complete additive closure, then applies the global
point limit during composition. The complete-depth default retains its
render-budget-derived load cap.
`lastResult`, `lastVisualQuality`, and `lastError` remain available for
application status surfaces.

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
request header; exposing `Content-Range` enables exact range validation. The
loader always rejects response bodies whose byte length differs from the
requested range.

See [API](docs/API.md) for the current public surface and
[examples/minimal-layer.ts](examples/minimal-layer.ts) for a type-checked
minimal integration slice.
The [2026 competition evidence map](docs/COMPETITION.md) links the Gaia3D
task requirements to implementation and repeatable verification artifacts.
[Sample data provenance](docs/DATASETS.md) records the source, reuse terms,
attribution, and non-bundling policy for every built-in COPC preset.

## Build

```bash
npm run build:lib
npm run build:example
npm run build
npm run benchmark:renderers
npm run benchmark:eptium-comparison
npm run benchmark:quality-ab
npm run benchmark:smoothness
npm run benchmark:smoothness:qc
npm run benchmark:smoothness:regression
npm run benchmark:smoothness:contest
npm run benchmark:smoothness:cache-reset
npm run benchmark:smoothness:cold-reset
npm run license:evidence:check
npm run qc
npm run qc:contest-device
npm run evidence:contest
npm run evidence:contest:check
npm run smoke:example
npm run smoke:example:file
npm run smoke:package
```

`npm run build:lib` writes the library package contract to `dist/lib`.
`npm run build:example` writes the runnable demo bundle to `dist/example`.
The default public base is `/`, so local development, preview, CI browser smoke,
and package smoke keep their existing URLs. A repository-site build sets an
explicit pathname through `COPC_VIEWER_PUBLIC_BASE`; for example, PowerShell can
reproduce the Pages artifact with:

```powershell
$env:COPC_VIEWER_PUBLIC_BASE = "/COPC_VIEWER/"
npm run build:example
npm run verify:pages
Remove-Item Env:COPC_VIEWER_PUBLIC_BASE
```

The pinned `GitHub Pages` workflow obtains the repository's actual Pages
`base_path`, builds with that value, verifies every HTML asset plus Cesium,
point-worker, and LAZ WASM paths, and only then uploads and deploys
`dist/example`. The repository owner must select **GitHub Actions** as the Pages
source before the first deployment; the workflow does not change repository
settings itself.
In the latest 2026-07-14 release-candidate build snapshot, Vite split the
projected-CRS dependency out of the application entry: the uncompressed
generated JavaScript was 367.93 kB for the app entry and 131.70 kB for the
`proj4` chunk. These are source-snapshot build artifacts, not network-transfer
or runtime-memory guarantees.
`npm pack --dry-run` builds the library through `prepack` and inspects the
package contents without publishing. `npm publish` additionally runs the full
`prepublishOnly` QC gate before packaging; it is not part of normal builds.
`npm run smoke:example` builds the example, starts a temporary preview server, and verifies the CC BY 4.0 Autzen sample, the Hobu-hosted COPC matching the public-domain USGS 3DEP Millsite collection, and Custom URL + proj4 rendering in a browser. Run `npm run smoke:example:install-browser` once if Playwright reports that Chrome for Testing is missing.
`npm run smoke:example:file` runs the same browser smoke flow, downloads the Autzen COPC sample into the ignored `output/local-copc-samples` cache, then verifies that the browser file input can load and render that local COPC file through the same layer API.
`npm run smoke:package` first validates the generated license/SPDX evidence, then packs the local build, verifies required documentation and package/worker size budgets, and installs the exact tarball into a temporary consumer pinned to CesiumJS 1.140.0. The consumer passes strict Bundler and NodeNext declaration checks, builds with the documented Cesium Vite asset setup, then starts a real browser, creates `Viewer` and a package-imported layer, renders an Autzen node through the packaged worker path, and rejects console, page, worker, or missing-asset errors.
`npm run benchmark:renderers` builds the example, starts a temporary preview server, renders the Autzen COPC sample with the typed-array, point-primitive, and buffer point renderers at a larger sample size, repeats each run, and writes browser-measured renderer timing to `output/renderer-benchmark/renderers.json`. The defaults are 10,000 max points per node and 3 repeats. On PowerShell, override them with `$env:COPC_BENCHMARK_POINT_COUNT="20000"; $env:COPC_BENCHMARK_REPEATS="5"; npm run benchmark:renderers`.
`npm run benchmark:quality-ab` performs a renderer-only screen-door A/B on the
same Autzen source response, terminal node keys, render signature, point count,
camera, drawing buffer, and device pixel ratio. It captures paired point-on and
point-off Cesium canvases, removes the unchanged background, and gates canvas
coverage, bounded 1-3 px gaps, isolated pixels, edge complexity, p95 frame time,
retention of the baseline shape, expansion outside a 3 px baseline support
region, intrusion into large baseline voids, console errors, and page errors.
The default is a two-repeat AB/BA order, and either an incomparable run or a
failed quality/performance gate exits nonzero. The report and masks are written
to `output/quality-ab`.
`npm run benchmark:eptium-comparison` runs a live, controlled comparison with
Eptium's Autzen viewer. It verifies the exact COPC URL, ETag, camera, 1600x900
canvas, DPR, terminal state, stock Eptium styling, and WebGL adapter; hides UI
and map context; captures stable point-on/point-off pairs; and uses alternating
AB/BA order. It reports the shipped balanced preset, the high-detail preset,
and a strict equal-rendered-point comparison separately. Because the two LOD
engines can select different point IDs, cross-mask support remains descriptive
rather than source-truth evidence. It also records fresh-page first-ready time
and a product-only COPC range ledger with exact duplicates, overlap,
amplification, abandoned work, and coalescing estimates. The JSON report, raw
request trace, images, backgrounds, and masks are written to
`output/eptium-comparison`.
The latest two-repeat RTX 3060 checkpoint passed the strict equal-count gate. At
1,047,575 points the local renderer recorded 86.678% coverage, 0.2238% bounded
gaps, 0.009536 edge/foreground, 17.15 ms p95, and 15.556 s product first-ready,
versus Eptium's 86.151%, 0.2992%, 0.010569, 17.15 ms, and 16.495 s. Parsed
metadata is carried by warmup and every geometry load/prefetch request, soft
cancellation lets superseded uncached geometry finish into the worker cache,
and strict decoded-worker affinity prevents an idle worker from repeating a
cached node's range read and LAZ decode. Together with the final-only typed
terminal commit, the current path reduced the local equal-count request count
from 85 in the original pre-change capture to 60 and exact duplicate requests
from 22 to zero. Four predictive prefetch requests were still abandoned when
the harness left the product page for its geometry-mask reload. Eptium used 55
ranges with no abandoned work and an 8.02% smaller unique-byte union, while the
local request amplification was exactly 1.0 versus Eptium's 1.0011. The local
p95 matched Eptium and its median maximum frame was 1.20 ms slower
(19.35 versus 18.15 ms). This remains controlled Autzen evidence, not a
universal cross-device, cross-dataset, or total-network-efficiency superiority
claim.
`npm run benchmark:smoothness` builds the example, starts a temporary preview server, enables camera streaming, moves the Cesium camera, records browser frame intervals through both camera movement and the exact terminal-refinement boundary, first visible application response timing, stream-stage timing, selected LOD depth, and structured decoded-worker cache telemetry, then writes the result to `output/smoothness-benchmark/smoothness.json`. A first response is accepted only after an actual scene commit (`app-render-commit`) or after the application proves that the unchanged exact frame is still resident (`app-render-retained`); beginning a load or resolving a cache lookup is not response evidence. Versioned current artifacts must contain terminal-frame and aggregate cache-envelope evidence; only explicitly unversioned legacy artifacts retain compatibility. The defaults are Autzen, Millsite Reservoir, and Custom Millsite URL samples; 2,500 / 5,000 / 10,000 / 20,000 camera-stream point budgets; 2 repeats per budget; 24 camera steps; 3 seconds per run; and sample-specific minimum selected-depth checks. On PowerShell, override them with `$env:COPC_SMOOTHNESS_SAMPLES="autzen-classified,millsite-reservoir"; $env:COPC_SMOOTHNESS_POINT_BUDGETS="5000,10000"; $env:COPC_SMOOTHNESS_REPEATS="5"; $env:COPC_SMOOTHNESS_MIN_SELECTED_DEPTH="2"; npm run benchmark:smoothness`.
Browser smoke and benchmark commands request Chromium's high-performance GPU and
record the actual WebGL vendor/renderer/version in their result. Systems without
a discrete GPU can still fall back to their available adapter, so use the
recorded renderer instead of assuming a GPU from Windows numbering.
Renderer and smoothness benchmark JSON also embeds a validated `runEvidence`
record: generation UTC, Git HEAD and clean/dirty state, a SHA-256 fingerprint of
the tracked diff plus non-ignored untracked content, Node/platform/npm context,
and the browser user agent/version. The same metadata is copied into assertion
reports and the approved baseline so a detached artifact remains attributable
to its source state.
The installed-package `output/package-smoke/browser-result.json` embeds the
same validated `runEvidence` and an explicit `releaseCandidateArtifact` record,
so its tested tarball SHA-256 and byte length remain bound to that exact source
commit, clean/dirty state, and source fingerprint.
`npm run benchmark:smoothness:qc` runs a shorter Autzen camera-stream benchmark and then fails if the measured frame smoothness, first visible application response time, stream update time, end-to-end camera move duration, selected LOD depth, rendered point count, current-view node count, or current-view density falls below the configured regression thresholds.
`npm run live:copc-range` performs one strict, non-retried HTTP range probe against each documented live sample. It requires `206 Partial Content`, an exact `Content-Range`, the requested 64-byte body, and the LAS `LASF` signature, then writes `output/live-copc-range/live-copc-range.json`. Exit code 2 and classification `external-source-unavailable` mean the external host or network was unavailable; exit code 1 means the reachable source violated the range/COPC contract.
`npm run benchmark:smoothness:regression` first records that strict Millsite live-range evidence, then captures three independent warm zoom sessions, each in a fresh browser lifecycle, and compares the median session-group metrics with the committed five-session RTX 3060 baseline in `benchmarks/baselines`. The baseline retains every session's source evidence, actual renderer/browser contract, absolute-threshold snapshot, and median absolute deviation (MAD) inputs. It fails when those contracts differ or FPS, frame timing, first visible application response time, stream time, rendered point count, or current-view node coverage/density regresses beyond tolerance. Worker queue timing remains in the comparison report but uses the per-run absolute gate because mixed worker/cache evidence and scheduler variance make a single relative queue ratio unstable. `output/smoothness-benchmark/smoothness-regression-run-status.json` distinguishes a real absolute/relative performance failure from external source unavailability without relaxing either performance gate.
`npm run benchmark:smoothness:contest` runs the same assertion gate against both Autzen and the 374-million-point Millsite Reservoir source so heavier projected-coordinate data is covered before contest/release checks.
`npm run benchmark:smoothness:cache-reset` clears retained camera-stream state before a Millsite camera movement run while keeping layer-level point samples, prepared point geometry, and worker-local decoded COPC node caches alive. The already-open COPC metadata, hierarchy, prepared Cesium geometry, and worker decoded views stay loaded, so this checks repeated zoom/pan recovery rather than a full first-page cold start or a forced worker/cache reset.
`npm run benchmark:smoothness:cold-reset` clears the active layer caches before a Millsite movement run and measures the first interactive coverage render instead of waiting for every required node. The same camera request may continue refining asynchronously, so this catches cold first-display regressions without treating the captured preview as final.
`npm run benchmark:smoothness:cold-detail` resets layer caches at 550 m above the transformed cloud bounds. Its measured request requires at least a complete depth-4 frontier, density, bounded decode/queue timing, and a verified terminal additive composition. It then waits up to 30 seconds for post-prefetch refinement and requires a newer request with the same camera epoch and pose fingerprint, completed prefetch, selected depth 5 or deeper, at least 300,000 rendered points, `isTerminalReady: true`, and zero pending hierarchy pages for the view. Frame collection continues through that final stage: terminal-refinement p95/max use the active 67/150 ms gates, and cold detail permits at most one recorded frame above 100 ms while still rejecting any frame above 150 ms. Default, contest, and warm checks retain the zero-frame-above-100-ms contract. `npm run benchmark:smoothness:warm-zoom-detail` uses the same view without resetting caches, records one excluded warmup plus a completed prefetch settle, then holds that layer's hierarchy only for the two measured runs. Both repeats must report the same selected node keys, additive render signature, and hierarchy-cache snapshot; production camera streaming remains free to refine hierarchy normally. Zero worker timing is accepted only when every final node has a fresh retained camera-stream sample. Prepared-geometry cache deltas remain cache-hit evidence but never synthesize zero latency, and mixed runs retain their real worker timing.

The latest passing 2026-07-17 RTX 3060 cold-detail snapshot rendered 360,000
points from all 80 required additive nodes at selected depth 5, with a depth
3-5 mixed frontier, 100% node and weighted coverage, zero pending current-view
hierarchy pages, and terminal-ready composition. Camera movement recorded 59.2
average FPS, 16.8 ms p95, 33.3 ms max, and a 7.6 ms retained-frame first
response. Frame collection continued through 22.947 seconds of terminal
refinement and recorded 59.4 average FPS, 16.8 ms p95, 100.1 ms max, and the
single permitted frame above 100 ms. Typed terminal loading now retains the
preview/previous frame and submits the weighted full-budget geometry once when
all required nodes are ready, avoiding repeated full-budget primitive uploads.
Hierarchy follow-up signatures also include refined depth so the final deeper
same-camera pass cannot be deduplicated against an earlier complete pass.
These are machine-specific regression observations from a dirty source
snapshot, not universal performance guarantees.
`npm run license:evidence` regenerates [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the [SPDX 2.3 SBOM](docs/sbom.spdx.json) from the lockfile and installed dependency manifests. `npm run license:evidence:check` is the read-only artifact gate. `npm run license:evidence:self-test` additionally proves that package/notice deletion, unreviewed licenses, unknown or duplicate packages, and broken relationship endpoints are rejected while platform-specific optional packages remain portable; CI and release QC use this stronger form.
`npm run qc:product` runs the deterministic product gate: tests, license/SBOM evidence, build, and `git diff --check`. `npm run qc:live-copc` separately runs the strict live-range evidence, the latency-sensitive cold-detail camera-stream gate before other GPU workloads, the live Autzen renderer benchmark, contest/warm camera-stream QC, package smoke, remote browser smoke, and local-file browser smoke. `npm run qc` runs both groups sequentially and remains the blocking release command. Its machine-readable result is `output/qc/qc-status.json`; external host/network failure is reported as `external-source-unavailable` with exit code 2 instead of as a product regression. Keep the live checks sequential because the renderer and browser smoke commands rebuild the same `dist/example` output directory.
`npm run qc:contest-device` runs the full release chain without duplicating the one-session warm check, then performs the stricter three-fresh-session median regression gate. It finishes by running `npm run evidence:contest` and `npm run evidence:contest:check`, so the successful JSON reports, exact package tarball and checksum, browser-result contracts, screenshots, and fresh regression sessions are byte-for-byte bound into `output/contest-evidence/contest-evidence-manifest.json`. Run this final gate from a clean Git worktree: manifest generation intentionally rejects dirty source state. `npm run evidence:contest` can rebuild the manifest from an already complete clean-worktree evidence set, while the read-only `npm run evidence:contest:check` rejects missing, stale, changed, or source-mismatched artifacts. The current approved baseline targets the recorded RTX 3060 WebGL renderer and deliberately rejects incomparable adapters. The live range and unchanged absolute/relative performance assertions remain blocking; the new classification only states whether a verdict was actually possible.
The strict range probe, installed-package consumer proof, and the same remote
URL and local-file browser rendering smoke run in the separate GitHub Actions
workflow `Live COPC Browser Evidence` for pushes, pull requests, and manual
dispatches. The main `CI` workflow runs only `qc:product`, so an external COPC
host outage cannot be reported as a deterministic product regression.
The `Release Candidate` workflow runs the full QC gate for version tags or a
manual dispatch, then uploads the verified package tarball, renderer and
smoothness reports, and browser screenshots without publishing them to npm.

The runnable reference viewer lives in `examples/basic-viewer`. The root `src` folder contains reusable COPC and Cesium integration code used by that example.
Reusable source entry points are `src/index.ts`, `src/core/index.ts`, and `src/cesium/index.ts`; package exports expose built JS and type declarations as `copc-cesium`, `copc-cesium/core`, and `copc-cesium/cesium`.
`CopcPointCloudLayer` is the main low-level Cesium-facing API: it owns a `CopcSource`, point renderer, bounds renderer, and camera-based node rendering helpers.
The default point renderer is now `CesiumPrimitivePointRenderer`, a Cesium `Primitive` backend that submits typed position and color arrays instead of creating one Cesium point object per COPC point. `pointColorMode: "attribute"` remains the layer and reference-viewer default: RGB-less data uses known ASPRS classification colors, intensity for unclassified or unknown points, and a neutral fallback consistently across typed and object renderers. `pointColorMode: "elevation"` instead maps source Z through one six-stop viridis-like palette normalized against the COPC file's global inspection bounds, so neighboring nodes do not acquire incompatible local color ranges. `CopcPointCloudLayer` also accepts a `createPointRenderer` factory so renderer backends can be swapped without changing COPC loading logic. `CesiumPointPrimitiveRenderer` remains available as the stable point-primitive fallback, `CesiumBufferPointRenderer` remains available as an experimental `BufferPointCollection` comparison backend, and `CesiumPointRenderer` remains as a compatibility alias.

The default example URL loads the public Autzen COPC sample, reads the root hierarchy, renders an initial node to place the camera, then automatically renders a denser camera-selected coverage LOD set.
Balanced detail mode now targets up to 240,000 Auto LOD points with 1.75-5 px
projected-spacing adaptive splats. Its 1.25 coverage scale, ground-aligned
elliptical footprint, 1.25 CSS-pixel safety halo, and renderer-scoped EDL close
small screen-space gaps without requesting a denser COPC node set, while the
coverage selector fills the visible footprint before spending budget on deeper
branches.
The example keeps sample COPC URLs and their transform factories in a small preset list while still allowing direct custom URL entry or a browser-selected local COPC file.
Bundled sample presets use the Vite `/copc-samples/*` proxy so local dev and preview runs can issue same-origin COPC range requests even when a browser blocks direct S3 requests.
For custom URLs or local files, the default path reads projected CRS WKT from the COPC metadata. The example also accepts an explicit source CRS and optional proj4 definition as an override for files with missing or unusable WKT.
The hierarchy node selector lists currently loaded nodes and lets the example render one selected node at a time.
The renderer selector starts on the typed-array primitive renderer and can switch to the stable point-primitive renderer or the experimental buffer renderer for comparison.
The Quality selector switches between fast preview, balanced detail, high
detail, and ultra density presets. These presets tune the point budget together
with bounded adaptive splat size. The typed renderer derives projected size
from each COPC node's spacing, hierarchy depth, CRS-to-metre scale, and retained
sample ratio, while data without spacing metadata keeps the configured
fixed-size fallback. Balanced, detail, and ultra project each splat as an
ECEF-local tangent-plane ellipse, apply calibrated overlap plus 1.25/1/1 CSS
pixel safety halos, disable scene FXAA, enable renderer-scoped eye-dome lighting,
and hold the previous camera frame until the next progressive frame has safe
spatial coverage. Preview keeps a screen circle, no halo, no EDL, and direct
per-node primitives. Unsupported EDL environments keep the direct Primitive
path.
The Max points / node input controls the active `CopcPointCloudLayer` sample budget, which makes manual and automated renderer comparison possible without changing source code.
The Camera stream points input controls the maximum point budget used by `Stream on camera move`. The default value leaves room for closer LOD bands to raise the current budget (up to 2x the overview budget in the default profiles), while explicit lower values remain hard caps for constrained devices and reproducible benchmarks. The example can temporarily lower the effective stream budget after slow updates and recover it after repeated fast updates while the camera is moving; once movement stops, the terminal current-view plan uses the configured quality ceiling so the same pose converges to the same final density.
`CopcSource` keeps the opened COPC metadata, loaded hierarchy pages, pending hierarchy page references with bounds and source-page provenance, hierarchy cache stats, and bounded in-memory caches for hierarchy pages and sampled node point data for the active URL. The hierarchy page cache evicts loaded non-root leaf pages back to pending page references when the configured page-count or hierarchy-byte limit is reached. The point sample cache is limited by both sample-set count and estimated decoded sample bytes.
The Load next page button range-reads the next pending COPC hierarchy page and refreshes the available node list without converting the file to 3D Tiles.
The example also computes the selected node bounds and renders a yellow debug bounding box in CesiumJS.
It can suggest the nearest loaded hierarchy node to the current camera position and apply that suggestion on demand.
The manual render set can combine multiple hierarchy nodes and render their sampled points together.
The Auto LOD button expands nearby pending hierarchy pages, estimates each available depth's nearest node screen size and COPC spacing-derived point spacing in screen pixels, culls nodes outside the Cesium camera frustum with a view-direction fallback, then uses coverage-oriented node selection so the current view is filled before it renders through the same multi-node path. Immutable transformed node bounding spheres are cached by hierarchy-node identity, while the camera-frustum test still runs for every selection.
Multi-node rendering accepts `maxRenderedPointCount` so camera-driven paths can cap the total sampled points submitted to Cesium instead of multiplying the per-node sample budget by every selected node.
The Stream on camera move toggle explicitly uses coverage-preserving mixed-depth
selection. It first reserves a visible baseline near one level above the target
depth, including that baseline's complete additive ancestor closure. Remaining
node, source-point, and compressed-byte budget can refine a frontier node only
when all of its immediate visible, renderable children fit as one atomic sibling
group; otherwise the parent stays in the frontier. The refinement trigger tests
the current frontier parent's screen-space error against the refine/retain
hysteresis threshold, rather than requiring its already-finer children to exceed
that threshold. This produces an antichain
whose depths can vary by branch without leaving isolated high-detail patches or
coverage holes. It can publish a quick preview or `interactive-ready` refinement
while the camera request is active, but those states are not final quality. The
foreground preview targets roughly 2,800 coverage points across at most two
early nodes, then the default stream keeps a bounded worker window moving until
every planned node is available and submits one exact terminal render. Medium,
close, and near profiles never lower individual-node eligibility below the
overview profile; their aggregate source budgets rise so wheel zoom cannot make
the selected frontier shallower. The browser smoke gate verifies the Autzen
overview-to-zoom depth, frontier, and rendered-density transition.

[COPC](https://copc.io/) follows [EPT's additive hierarchy
semantics](https://entwine.io/en/latest/entwine-point-tile.html): points in an
ancestor are not replaced by points in its descendants. The terminal render
plan therefore contains the complete available ancestor closure of the selected
frontier, ordered coarse-to-fine, and spreads the render budget across that
whole required set. A mixed-depth frontier is terminal only when it is the
planned coverage-preserving antichain; an arbitrary mixed coarse/detail set,
85-95% node subset, or cache-only tail is not complete.

For an exact terminal commit, source-point weights come from the hierarchy entry
for every required key, including additive ancestors rather than only the
selected frontier. The same deterministic weighted water-fill is used for
object samples, typed attribute channels, and integrated-worker geometry, so the
render budget does not collapse into an equal absolute cap that undersamples
dense nodes.

`createCopcCameraStreamVisualQualityState()` is the structural terminal gate.
It requires an antichain frontier, every required frontier and additive ancestor
node, no missing nodes, and no stale or unexpected node from an older camera
request. A render also remains non-terminal while a hierarchy page relevant to
the current camera target is still unopened. Hierarchy expansion considers the
Cesium-frustum-visible pending pages for the whole current view instead of only
the viewport-center tile, then spends one bounded page budget across newly
revealed levels. Background refinement opens pages only through the deepest
complete frontier that the current node/point/data budgets can render. It does
not chase a deeper screen-space LOD ceiling or speculative future-zoom pages.
The engine reselects the same camera, and the example queues a guarded
same-camera refinement after its fast foreground response when the available
frontier changes. Benchmark evidence accepts that follow-up only when the
request advances without changing the camera epoch or pose fingerprint,
prefetch is completed, `isTerminalReady` is true, and the pending relevant
hierarchy-page count (`pendingRelevantHierarchyPageCount`) is zero. Low-level
callers can still opt into progressive mixed-depth selection or `postStopProgressMode:
"load-only"` for deliberately non-terminal previews and cache warming.
The source-level hierarchy `pendingPageCount` is global and may remain nonzero;
only frustum-visible pages at or above the committed frontier depth block that
current frame from becoming terminal.

Preview selection still prefers cheap coverage nodes and falls back to
distributed detail nodes when a parent exceeds the preview byte budget. Worker
requests remain spatially ordered and bounded; current-view warmup and later
predictive prefetch fill caches without publishing a terminal status or
overwriting the verified current-view composition.
Before a new render-capable request starts, the reference viewer aborts every
superseded render request; overlap reuse is reserved for load-only work that
cannot mutate the shared renderer. If the new terminal plan, density, point
budget, layer, and rendered node samples exactly match the last committed
frame, the viewer can retain it without resubmitting geometry, but only while
the layer's monotonic renderer revision still matches. Predictive prefetch
after that retained response is delayed by at least 350 ms and is not queued
while camera movement is active.
For balanced and higher presets, a non-terminal frame may replace that retained
GPU frame only after it contains every coarse coverage node, at least 65% of
the source-weighted final-node set, and at least 60% of the comparable
exact-terminal point-count high-water mark. Intermediate swaps never lower that
mark, so rapid moves cannot compound 60% of 60%. Camera `changed` and `moveEnd`
events abort the superseded render immediately, before the debounced successor
starts, so stale progress cannot mutate the renderer during the debounce
interval. The exact terminal frame is still always committed and remains
subject to the structural terminal gate.
Render results include `renderStats` with browser CPU-side coordinate transform time, renderer `setPoints` submission time, bounds submission time, total submission time, point count, and an estimated coordinate/color payload byte count. These numbers are intended for repeatable renderer comparison, not GPU frame-time profiling.
When integrated point-geometry workers are active, `renderStats.pointGeometryTimings` also separates summed worker work from the slowest single request and exposes `slowestNodes` so expensive COPC nodes can be identified without parsing logs.
The smoothness benchmark adds browser `requestAnimationFrame` interval measurements while the example camera-stream path is active. It splits the trace at the exact end of synthetic camera movement and keeps collecting through the expected request's terminal refinement, so worker-driven detail cannot hide outside the frame gate. It also records first-response source and renderer revision, selected depth, exact frontier/additive signatures, structured hierarchy-cache state, hierarchy expansion, hierarchy UI application, node selection, retained node reuse, point rendering, total stream-update timing, and the decoded-worker memory envelope so point-budget tuning can be compared with repeatable frame-time and cache data.
The basic viewer enables `pointSampleLoading: "worker"` so COPC point-data reads and LAZ decoding run in a Web Worker when the browser supports it. If worker creation is unavailable, `CopcSource` falls back to the existing main-thread point sampling path. Worker point sampling uses a small concurrency limit so camera-driven requests do not all dispatch at once. Point sample APIs accept an `AbortSignal`; the basic viewer aborts stale camera-stream point reads when a newer camera request starts.
The basic viewer also warms the point-sample worker pool and integrated geometry worker pool when a COPC source is opened, so the first zoom or pan does not pay worker startup cost on top of range reads and decoding. It parses COPC metadata once on the main source, passes that metadata with point-sample work and every integrated-geometry load/prefetch request, and seeds every integrated geometry worker during source-aware warmup instead of making each worker repeat the LAS/COPC header and VLR ranges. A later parsed value replaces a failed worker-local bootstrap promise, covering pre-load warmup and lazily created workers. Worker pool sizing is capped for interactive camera streaming: the helper falls back to four point-sample workers and five geometry workers, caps point-sample concurrency at six, caps integrated geometry concurrency at eight, reserves browser capacity for rendering, and avoids unbounded worker creation on high-core machines. Integrated geometry workers prefer decoded-node affinity so repeated zoom/pan density upgrades reuse worker-local decoded COPC views when that worker is available. Each retained decoded node also caches one `Uint32Array` spatial order, adding exactly 4 bytes per decoded point to the cache estimate; density changes reuse that order instead of sorting the node again. The worker-pool helper keeps strict decoded-worker affinity by default, preventing a busy cache owner from triggering the same HTTP range read and LAZ decode on an idle worker; applications can supply a finite `decodedNodeWorkerFallbackDelayMilliseconds` only when their own measurements favor bounded wait latency over cache reuse. The demo uses soft cancellation for superseded integrated-geometry work so a nearly complete cold range/decode can enter the worker cache rather than terminating the worker and repeating that range on the next view. A 768 MiB layer-wide decoded-view ceiling, divided across both worker pools with a 128 MiB per-worker ceiling, prevents that cache from multiplying into several GiB on high-core machines; `getDecodedPointDataCacheStats()` exposes the measured envelope.

Spatial ordering quantizes each decoded node to 10 bits per XYZ axis, performs a
stable four-pass radix sort over Morton codes, then applies a centered
bit-reversal traversal. Every density is a nested prefix of that one order, so
raising density retains the already visible points while filling the node more
uniformly than a source-order prefix.

The viewer also caps retained main-thread geometry at 384 MiB. Loaded and
transformed cache entries share identity-based backing-buffer accounting, so an
aliased typed array is counted once; resolved LRU entries are evicted when the
byte cap is exceeded while pending foreground work remains protected.

The typed renderer API keeps `maxGeometryBatchesPerPrimitive: 1` as its
compatibility default. Balanced, detail, and ultra use `4`: a still-growing
progressive tail remains as stable per-node primitives, then a full group is
merged once when sealed instead of rebuilding a 1 -> 2 -> 3 -> 4 buffer. A
single batch, or merged batches with one effective spacing, embeds that spacing
as a shader constant; only mixed-spacing chunks allocate the 4-byte-per-point
spacing attribute.

Included example presets:

- Autzen classified: EPSG:2992 sample handled by the default transform.
- Millsite Reservoir: Hobu-hosted COPC matching the public-domain USGS 3DEP collection, with horizontal EPSG:6341 detected automatically from its compound WKT metadata. The exact-object provenance qualification is recorded in [DATASETS.md](docs/DATASETS.md).

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
  maxDecodedPointDataViewBytesAcrossWorkers: 768 * 1024 * 1024,
  pointSampleLoading: "worker",
  pointGeometryLoading: "integrated-worker",
  pointColorMode: "elevation",
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
  coverageMode: "complete-depth",
  includeAncestorNodes: true,
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
- [Release Procedure](docs/RELEASE.md)
- [Sample Data Provenance](docs/DATASETS.md)
- [2026 Competition Evidence](docs/COMPETITION.md)
- [KOSSA 2026 Submission Checklist](docs/SUBMISSION_CHECKLIST_KO.md)
- [Three-Minute Demo Script](docs/DEMO_SCRIPT_KO.md)
- [Third-Party Notices](THIRD_PARTY_NOTICES.md)
- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [License](LICENSE)

## Planned Shape

```text
src/index.ts           Public source entry point
src/core/              COPC loading and point data preparation
src/cesium/            CesiumJS rendering and coordinate conversion
examples/basic-viewer/ Minimal runnable example
```
