# API

`copc-cesium` is a pre-1.0 ESM package. The planned `0.1.0` release establishes
the first package-consumer-verified API baseline; minor releases may still
refine public types while the library is below 1.0.

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

The supported runtime contract is a modern browser application built with an
ESM bundler and CesiumJS `>=1.140.0 <2`. CesiumJS 1.140.0 is the lower bound
because the public experimental `CesiumBufferPointRenderer` uses the
`BufferPointCollection` family introduced in that release. Native Node.js ESM
execution is not a supported runtime: Node.js 22 and npm 11 are the repository
development, build, and QC toolchain. Package smoke installs the exact Cesium
lower bound before strict Bundler and NodeNext declaration checks, a consumer
bundle build, and a package-installed browser render.

## Consumer Setup

```bash
npm install copc-cesium cesium
npm install --save-dev vite vite-plugin-cesium typescript
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";

export default defineConfig({
  plugins: [cesium()],
});
```

The Vite plugin copies Cesium's runtime assets and configures their base URL.
For another bundler, provide the equivalent `Workers`, `Assets`, `Widgets`, and
`ThirdParty` copy step and `CESIUM_BASE_URL`. Always import
`cesium/Build/Cesium/Widgets/widgets.css` when constructing a `Viewer` with
widgets. The package's COPC point-sample and geometry workers are resolved
relative to its emitted modules and ship inside the tarball.

Core range helpers are also exported for integrations that need to compose their
own source layer:

```ts
import {
  CopcIndexedDbRangeCache,
  CopcRangeRequestError,
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
The HTTP getter rejects truncated bodies even when the server returns `206`.
When `Content-Range` is exposed through CORS, its start/end values and complete
length must also be well formed and consistent with the requested half-open
byte range. This prevents corrupt metadata or LAZ chunks from reaching the COPC
parser as apparently successful reads.
It wraps exact byte-range reads with a small in-memory cache, so duplicate
metadata, hierarchy, or point-data requests can share an in-flight read and
later receive copied cached bytes without mutating the retained cache entry.
Both URL and `Blob` getters reject a single requested range larger than
`256 * 1024 * 1024` bytes by default, before fetching or slicing it. Override
that defensive ceiling with the positive integer `maxRangeByteLength` only for
a trusted dataset that genuinely contains a larger contiguous hierarchy or
point-data record. Blob reads also reject ranges outside `blob.size` and verify
the exact slice length.

Remote URL getters can opt into a persistent, fixed-block IndexedDB cache. The
default remains disabled and the default aligned block size is 64 KiB.
Automatic validation performs a one-byte Range probe with browser-cache
revalidation (`Request.cache = "reload"`)
for a strong `ETag` and the complete source length before serving stored
blocks. A changed validator creates a new cache namespace; a missing or weak
validator, hidden `Content-Range`, or `Cache-Control: no-store` safely bypasses
persistence. Cross-origin servers using this mode must expose both `ETag` and
`Content-Range` through CORS. The normalized URL is SHA-256 hashed before it is
used as a default cache namespace, so query-string credentials are not stored
verbatim. URL fragments are removed first because they are not part of an HTTP
resource identity. If Web Crypto cannot create that opaque key, persistent mode
fails closed before HTTP instead of leaving an existing source cache outside a
future `no-store` revocation. `sourceKey` is an advanced override that can be
used in that environment, is persisted as supplied, and must never contain a
token or other secret.

```ts
const persistentCache = new CopcIndexedDbRangeCache({
  databaseName: "my-viewer-copc-ranges-v1",
  maxCachedRangeBytes: 256 * 1024 * 1024,
  maxCachedRangeCount: 4_096,
});

const getter = createCopcRangeGetter("https://cdn.example.com/cloud.copc.laz", {
  persistentRangeCache: {
    cache: persistentCache,
    validation: { mode: "strong-etag" },
  },
});
```

An application with an immutable version contract can avoid the validator
probe by supplying both `version` and the authoritative complete byte length.
It must change that version whenever the source bytes change. A network miss
whose response says `Cache-Control: no-store` is returned without being stored.
The policy header is applied before status, Range metadata, body, or validator
validation, so a malformed or retried response cannot suppress source
revocation; one `no-store` response keeps the whole logical read non-cacheable.
The in-memory cache is disabled for that getter, while the built-in IndexedDB
store atomically purges every validator/version namespace for the stable source
identity and keeps one identity tombstone across getter and page recreation.
Other live getters consult that shared tombstone before reusing an in-memory
entry, so the revocation is source-wide rather than getter-local. They also
capture a module-session source-policy epoch. `no-store` advances that epoch
before purge begins, permanently disabling older getters' memory and validated
persistent namespaces even if a later fresh strong-ETag probe removes the
tombstone. Only a getter initialized in the new epoch can resume persistence.
If a custom or built-in store cannot confirm the atomic purge, that rejected
revocation is retained for the source identity and both existing and newly
created getters fail closed for the rest of the module session.
This also bounds tombstone growth when a server rotates ETags. A fresh,
browser-cache-revalidated strong-ETag probe that permits storage removes the
source tombstone. Application-version mode cannot make that network assertion,
so a prior source tombstone keeps persistence disabled until the application
explicitly re-enables or clears the cache.

Custom `CopcPersistentRangeCache` implementations must implement
`isSourceDisabled`, `disableSource`, and `enableSource`. `disableSource` must
atomically purge every key whose `sourceIdentityKey` matches, record one
identity tombstone, and make `get`/`set` honor it. A custom cache without that
policy surface is rejected rather than allowed to reuse protected blocks.
Because a fully cached application-version read performs no HTTP request, use
this mode only when the application's immutable-version contract itself
authorizes browser storage.

```ts
persistentRangeCache: {
  cache: persistentCache,
  validation: {
    mode: "application-version",
    version: "cloud-2026-07-18",
    sourceByteLength: 1_445_463_233,
  },
}
```

Persistent caching currently applies only to HTTP(S) sources. Enabling it for
a browser `Blob`/`File` is rejected. Cache read/write failures fall back to the
validated HTTP path, and malformed or wrong-length entries are discarded.
Same-length payload corruption is not independently checksummed by this layer;
the validator prevents reuse across source versions. The configured persistent
block and coalesced fetch sizes remain bounded by `maxRangeByteLength`.
`getStats()` reports hit/miss/write/eviction counts and retained bytes;
`clear()` removes entries owned by that IndexedDB database.
Schema version 3 clears legacy pre-source-identity entries once on upgrade so
they cannot escape identity-scoped invalidation. The normal bounded in-memory
cache and its `maxCachedRangeBytes`/`maxCachedRangeCount` controls remain active
when persistence is enabled or safely bypassed; `no-store` revokes that cache
for the lifetime of the getter.

HTTP reads use a 30-second request deadline by default. Set
`requestTimeoutMilliseconds` to another positive integer when the deployment
has a measured latency requirement, and pass `signal` to cancel all reads made
by that getter. The caller signal is combined with an internal timeout signal;
the helper never aborts or reuses the caller's controller.

```ts
const controller = new AbortController();
const getter = createCopcRangeGetter("https://example.com/data.copc.laz", {
  maxRangeByteLength: 64 * 1024 * 1024,
  requestTimeoutMilliseconds: 15_000,
  signal: controller.signal,
});
```

Recognized HTTP request and response failures reject with
`CopcRangeRequestError`. Its `code` is stable for programmatic handling;
`begin` and `end` preserve the requested half-open range `[begin, end)`,
`status` is present for HTTP-status and response-contract failures, and `cause`
preserves the underlying browser error when one is available. Browser
network/CORS and timeout failures can leave `status` unavailable even if a
body stream had started. `retriable` describes
whether the built-in policy considers the failure category eligible for retry.
The getter performs those retries before returning a final error, so a final
error can still have `retriable: true` after all attempts are exhausted.

| `code` | Meaning | Built-in retry policy |
| --- | --- | --- |
| `network-or-cors` | Fetch could not distinguish a network failure from a CORS rejection. The original `TypeError` is available as `cause`. | Retried |
| `http-status` | The server returned a non-success HTTP status. `status` contains that value. | Retried for `429` and `5xx` |
| `range-not-supported` | A successful response was not `206 Partial Content`. | Not retried |
| `timeout` | The per-attempt request deadline expired. | Not retried |
| `malformed-content-range` | An exposed `Content-Range` header was not valid. | Not retried |
| `mismatched-content-range` | An exposed `Content-Range` did not match the requested bytes. | Not retried |
| `body-length-mismatch` | The response body was shorter or longer than the requested range. Exact-length validation remains mandatory on every attempt. | Retried |

```ts
try {
  await getter(0, 64);
} catch (error) {
  if (error instanceof CopcRangeRequestError) {
    console.error({
      code: error.code,
      range: [error.begin, error.end],
      status: error.status,
      retriable: error.retriable,
      cause: error.cause,
    });
  }

  throw error;
}
```

Caller cancellation keeps an Error-valued caller abort reason instead of
wrapping it; other abort reasons retain the existing `AbortError` fallback.
URL, option, and byte-range validation errors also remain ordinary errors.
`Blob`/`File` getter errors are unchanged and do not use this HTTP-only error
contract.

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
| `rangeGetterOptions` | unset | Options forwarded to the main `CopcSource` getter and shared integrated-worker Range broker. Configure `persistentRangeCache` here for validated IndexedDB reuse across new layer/page lifecycles. Direct worker reads used by terminating cancellation modes do not share this main-thread cache. |
| `maxPointCountPerNode` | `5_000` inside lower-level point sampling | Default sample budget for each rendered hierarchy node. |
| `maxCachedHierarchyPages` | `64` | Loaded hierarchy page cache limit. |
| `maxCachedHierarchyPageBytes` | `16 * 1024 * 1024` | Estimated loaded hierarchy page byte limit. Loaded non-root leaf hierarchy pages are evicted back to pending references when either the page-count or byte limit is exceeded. |
| `maxCachedSampleSets` | `32` | Point sample cache entry limit. |
| `maxCachedPointSampleBytes` | `32 * 1024 * 1024` | Estimated decoded point sample cache byte limit. |
| `maxCachedPointGeometryBatches` | `96` | Integrated COPC geometry batch cache limit for worker-prepared Cesium payloads. |
| `maxCachedTransformedPointGeometryBatches` | `96` | Cache limit for transformed point geometry batches produced from decoded node samples. |
| `maxCachedPointGeometryBytes` | unset | Optional hard resident-byte cap shared by the loaded and transformed geometry caches. Backing buffers are counted once by identity even when both caches reference them; resolved least-recently-used entries are evicted without canceling pending requests. The basic viewer sets `384 * 1024 * 1024`. |
| `maxDecodedPointDataViewsPerWorker` | `48` in each worker | Decoded COPC point-data view count retained inside point-sample and integrated geometry workers. Raising this can speed repeated visits or density upgrades at higher memory cost. |
| `maxDecodedPointDataViewBytesPerWorker` | `192 * 1024 * 1024` in each worker | Estimated decoded point-data bytes retained inside each point-sample or integrated geometry worker. |
| `maxDecodedPointDataViewBytesAcrossWorkers` | unset | Optional layer-wide decoded-view byte ceiling across the point-sample and integrated COPC geometry worker pools. The layer divides the ceiling by active worker slots, then applies `maxDecodedPointDataViewBytesPerWorker` as an additional per-worker ceiling. The basic viewer uses a 768 MiB aggregate ceiling and a 128 MiB per-worker ceiling. |
| `pointSampleLoading` | `"main-thread"` unless a worker factory is provided | Use `"worker"` to move point-data reads and LAZ decoding into a Web Worker. |
| `pointGeometryLoading` | `"main-thread"` | Use `"worker"` for point-data-to-Cesium geometry conversion workers or `"integrated-worker"` to combine COPC node reads, sampling, and Cesium geometry preparation in one worker path. |
| `maxConcurrentPointSampleWorkerRequests` | `3` | Backpressure limit for point sample worker requests. |
| `maxConcurrentPointGeometryWorkerRequests` | `2` | Backpressure limit for geometry worker requests. |
| `activePointGeometryWorkerCancellation` | `"soft"` | `"soft"` preserves an active integrated worker and lets stale work finish; `"terminate-uncached"` terminates only active workers that have not retained decoded node data, while soft-canceling cache-owning workers so repeated zoom/pan work can reuse decompressed COPC nodes; `"terminate"` always stops the active worker so queued current-view work can start sooner, at the cost of dropping that worker's decoded cache. |
| `decodedNodeWorkerFallbackDelayMilliseconds` | `Number.POSITIVE_INFINITY` | How long an integrated geometry request waits for the worker that last decoded the same node before using another idle worker. The default keeps strict decoded-cache affinity to avoid decompressing the same node on multiple workers; set `0` only for latency-first experiments after benchmarking the target dataset. |
| `brokeredRangeRequests` | `true` with soft cancellation | Routes integrated-worker byte reads through one shared main-thread range broker. Terminating cancellation modes use direct worker reads so terminating a worker also stops its network work. |
| `maxCoalescedPointDataRangeBytes` | `2 * 1024 * 1024` | Maximum half-open point-data span planned for one brokered outer range read. This cap also bounds any bytes added by gap coalescing. |
| `maxCoalescedPointDataRangeGapBytes` | `64 * 1024` | Maximum gap allowed between adjacent point-data ranges merged into one brokered read. Set `0` for exact-contiguous-only planning. A larger value can reduce request count but deliberately fetches the intervening bytes and should be tuned with the HTTP ledger. |
| `createPointSampleWorker` | built-in worker factory | Custom worker factory for applications with their own bundling strategy. |
| `createPointGeometryWorker` | built-in worker factory | Custom worker factory for non-integrated point geometry workers. |
| `createCopcPointGeometryWorker` | built-in worker factory | Custom worker factory for integrated COPC point geometry workers. |
| `createPointRenderer` | `CesiumPrimitivePointRenderer` | Renderer factory implementing `CopcPointCloudRenderer`. |
| `pointColorMode` | `"attribute"` | `"attribute"` uses RGB/classification/intensity fallbacks. `"elevation"` uses one viridis-like palette normalized against the loaded COPC file's global source-Z bounds. |
| `showBounds` | `true` | Whether render calls draw debug hierarchy bounds by default. |
| `coordinateTransforms` | `createDefaultCopcCoordinateTransforms` | Factory that maps COPC source XYZ to Cesium longitude, latitude, and height. |

`getDecodedPointDataCacheStats()` reports the aggregate retained/peak bytes,
hits, misses, evictions, oversized-entry skips, and affinity count, plus separate
`pointSample` and `integratedPointGeometry` pool snapshots. Cache ownership is
recorded only after a response proves that decoded data is retained (including
a completed decode followed by soft cancellation) and is removed when the worker
reports an eviction. Failed or oversized requests do not create new affinity;
a canceled request does so only when its cancellation snapshot proves the
decoded view was retained. Error and canceled responses still synchronize the
post-operation retained-byte and eviction snapshot, so a failed decode cannot
leave an older node falsely marked as cached.

Each retained decoded node can also own one cached `Uint32Array` spatial point
order. Its memory is included in the decoded-view limit as exactly 4 additional
bytes per decoded point. The order is created once from quantized XYZ Morton
codes, a stable four-pass radix sort, and a centered bit-reversal traversal;
subsequent density requests reuse nested prefixes of that same order rather than
sorting or changing which already-visible points are retained.

`getRendererRevision()` returns a monotonic number that advances after every
successful mutation of the layer's point renderer, including `clear()`. It does
not identify a node set by itself. An application may use it with an exact
committed node/density/budget record to prove that no intervening layer render
has invalidated a retained frame.

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

After loading, `getCameraHeightAbovePointCloudMeters(absoluteHeightMeters)`
returns the non-negative camera height above the highest transformed top corner
of the COPC bounds. It applies the configured horizontal and vertical
coordinate transform before subtraction. The method returns `undefined` before
metadata is loaded, allowing camera integrations to retain an absolute-height
fallback during startup.

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

`shouldRenderProgress(candidate)` is the pre-commit counterpart for
intermediate frames. The candidate contains the post-budget `nodeKeys` and
`sampledPointCount`, plus `nodeSamples` entries with `nodeKey`,
`nodePointCount`, and `sampledPointCount`. Returning `false` keeps the
existing point renderer, bounds renderer, and `getRendererRevision()` unchanged
and suppresses that `onProgress` notification. The callback is never asked to
approve the final candidate after all requested progressive loads finish; that
frame is always committed. This lets an application keep an already visible
same-view coverage frame instead of briefly replacing it with lower-density
partial detail.

Set `continueLoadingAfterStop: true` when the stop callback marks an interactive
readiness point but already queued target nodes should keep loading. By default,
and with `postStopLoadingMode: "await"`, the returned Promise waits for every
bounded request window and can commit one complete final render after the
interactive threshold. Set `postStopLoadingMode: "background"` only when the
Promise should resolve at that intermediate point; only requests already active
at that moment continue in the background.
Set `postStopProgressMode: "load-only"` with `continueLoadingAfterStop` when
the queued tail work should warm COPC/geometry caches without submitting another
Cesium render during the same foreground camera update. This keeps camera moves
smoother while still making the same or nearby view cheaper to refine later.
The early Promise result in this mode is intentionally non-terminal: cache-only
work cannot retroactively make its rendered node set complete. A final-quality
camera stream should use `postStopLoadingMode: "await"`,
`postStopProgressMode: "render"`, and verify the final composition with
`createCopcCameraStreamVisualQualityState()`.

`nodePointCountWeights` is an optional array of positive finite source-point
weights aligned with the requested node keys. When supplied, the global render
budget is assigned with a deterministic integer weighted water-fill: allocation
is proportional to the weights, capped by each available result and
`maxPointCountPerNode`, and any points left by a saturated node are redistributed
among the remaining nodes. Foreground/current-view entries are still allocated
before retained background entries. The same allocator limits object samples,
typed attribute channels, and integrated-worker geometry batches. Omitting the
array preserves the previous equal-share fair allocation.

`useSourcePointBudgetHeadroom: true` separates load density from submission
density. Progressive node reads can then request up to the configured
`maxPointCountPerNode`, while `maxRenderedPointCount` is enforced when the
loaded results are composed. It defaults to `false`; enable it only when the
upstream node/point/byte plan has already bounded the source work.

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
samples spend most of their time in point-data view loading and worker queue
work, not Cesium point submission. Point-data view loading includes range
wait, laz-perf initialization, decompression/view construction, and cache wait;
use the structured render timing fields below to distinguish them.

### Camera Stream Settings

```ts
import {
  createCopcCameraStreamEffectiveBudget,
  createCopcCameraStreamLodSettings,
  createCopcCameraStreamMixedDepthThresholds,
  createCopcCameraStreamPrefetchSettings,
  createCopcPointCloudQualitySettings,
  resolveCopcCameraStreamHierarchyExpansionDepth,
  updateCopcCameraStreamAdaptiveBudget,
} from "copc-cesium";

const qualitySettings = createCopcPointCloudQualitySettings("balanced");
const lod = createCopcCameraStreamLodSettings({
  cameraHeightMeters,
  qualitySettings,
});
const mixedDepthThresholds =
  createCopcCameraStreamMixedDepthThresholds({
    cameraSettled: !cameraMoving,
    targetPointSpacingScreenPixels:
      lod.targetPointSpacingScreenPixels,
  });
const cameraSelection = await layer.selectNodesForCamera({
  camera,
  selectionMode: "coverage",
  coverageMode: "mixed-depth",
  targetPointSpacingScreenPixels:
    lod.targetPointSpacingScreenPixels,
  ...mixedDepthThresholds,
});
const hierarchyExpansionDepth =
  resolveCopcCameraStreamHierarchyExpansionDepth(
    lod.maxDepth,
    cameraSelection.selectedDepth,
  );
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

`decodeMilliseconds` is retained as the adaptive-budget input name for API
compatibility. The value shown above is the full point-data-view wait, not a
pure decompression CPU measurement.

`createCopcCameraStreamLodSettings()` maps height above the point cloud to bounded stream
budgets for node count, hierarchy depth, compressed point-data reads, and
screen-space point spacing. `createCopcPointCloudQualitySettings()` provides the
same preview, balanced, detail, and ultra presets used by the basic viewer, so
applications can start from reusable Cesium/COPC budgets instead of copying demo
constants. In addition to point/node/byte budgets, each preset contains
renderer and transition policy:

`createCopcCameraStreamMixedDepthThresholds()` leaves the core mixed-depth
refine/retain hysteresis unchanged while the camera is moving. After movement
settles, it returns equal refine and retain thresholds at the default retention
edge, 75% of the point-spacing target. Spreading those values into
`selectNodesForCamera()` makes the final frontier independent of whether a fast
cache path or a slower chain of retained selections reached the same camera
pose. This intentionally chooses the denser retained high-water mark and remains
subject to the configured node, point, and compressed-byte budgets.

| Field | Meaning |
| --- | --- |
| `maxGeometryBatchesPerPrimitive` | Maximum worker-prepared geometry batches in one Cesium draw primitive. |
| `pointSizeMode`, `minimumPointPixelSize`, `maximumPointPixelSize`, `adaptivePointSizeScale` | Bounded projected-spacing point sizing. |
| `splatCoverageScale` | Multiplier applied after sampling-density compensation; values above one overlap adjacent splats. |
| `splatSafetyHaloPixels` | CSS-pixel radius added to both projected ellipse axes after the bounded base footprint is computed. |
| `pointSplatShape` | `"screen-circle"` or adaptive-only ECEF tangent-plane `"ground-ellipse"`. |
| `sceneFxaa` | Whether the reference viewer enables Cesium scene FXAA. |
| `temporalLodSafeSwap` | Whether a proven retained frame stays visible until progressive replacement coverage is safe. |
| `eyeDomeLighting`, `eyeDomeLightingStrength`, `eyeDomeLightingRadius` | Renderer-scoped EDL policy. |

The preview preset uses one geometry batch per primitive, a screen circle, no
safety halo, no scene FXAA, and no EDL. Balanced, detail, and ultra use up to
four geometry batches per primitive, ground ellipses, 1.25/1/1 CSS-pixel halos,
no scene FXAA, and renderer-scoped EDL with strength 1.4/1.5/1.7 and radius 0.8.

`createCopcCameraStreamPrefetchSettings()` uses that same LOD target
to increase background preparation density as the camera gets closer, while
still capping per-node and total prefetch point counts. Pass
`minPointCountPerNode` and `minRenderedPointCount` when idle prefetch should
prepare the current view at least as densely as the last visible render, so the
next small zoom or pan can reuse cached COPC node samples instead of decoding
the same nodes again.
`createCopcCameraStreamEffectiveBudget()` applies the current adaptive state to
the configured LOD limits, and `updateCopcCameraStreamAdaptiveBudget()` lowers
or recovers those adaptive limits from render/worker timing feedback.
`resolveCopcCameraStreamHierarchyExpansionDepth()` caps hierarchy loading at
the complete frontier that the current point/node/data budgets can actually
render. Use that value as `expandHierarchyForCamera({ maxDepth })`; expanding
to a deeper screen-space target cannot improve the current bounded frame and
can otherwise churn a small hierarchy-page cache on wide datasets.

These helpers do not start requests or render points by themselves. They are
small policy helpers intended to feed `expandHierarchyForCamera()`,
`selectNodesForCamera()`, `renderNodesProgressively()`, and
`prepareNodesProgressively()` from an application-owned camera-stream loop.

`CopcPointCloudCameraStream` obtains this relative height from a loaded
`CopcPointCloudLayer`. Custom layer-like adapters that do not implement
`getCameraHeightAbovePointCloudMeters()` retain the backward-compatible
absolute ellipsoid-height behavior.

### Camera Stream Node Planning

```ts
import {
  createCopcCameraStreamCoverageNodeKeys,
  createCopcCameraStreamFinalNodeKeys,
  createCopcCameraStreamPreviewNodeKeys,
  createCopcCameraStreamRenderNodeKeys,
  orderCopcCameraStreamNodeKeysForAdditiveProgress,
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
const additiveRenderNodeKeys = orderCopcCameraStreamNodeKeysForAdditiveProgress(
  renderNodeKeys,
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

These helpers keep an interactive camera-stream pass coverage-oriented, then let
an application refine the selected detail nodes progressively.
`orderCopcCameraStreamNodeKeysForProgressiveCoverage()` is an interactive
request-order helper; its mixed coarse/detail result is not by itself a terminal
frontier. `orderCopcCameraStreamNodeKeysForAdditiveProgress()` orders a known
additive closure coarse-to-fine without dropping ancestors. The helpers also
provide node-family overlap checks through
`shouldReuseCopcCameraStreamNodeKeys()` so a viewer can decide whether an older
background request is still useful after a small pan or zoom.

### Camera Stream Render Plan

The terminal example below assumes `cameraSelection.coverageMode` is
`"complete-depth"`, which remains the reusable high-level default. A mixed-depth
selection may also be terminal when it comes from the coverage-baseline and
atomic visible-sibling refinement path and is validated with
`terminalFrontierMode: "mixed-depth-antichain"`; an arbitrary progressive
coarse/detail set should not be labeled terminal.

```ts
import {
  createCopcCameraStreamDetailProgressState,
  createCopcCameraStreamRenderPlan,
  createCopcCameraStreamVisualQualityState,
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
  const result = await layer.renderNodesProgressively(plan.finalNodeKeys, {
    maxPointCountPerNode: plan.maxPointCountPerNode,
    maxRenderedPointCount: plan.renderedPointBudget,
    continueLoadingAfterStop: true,
    postStopLoadingMode: "await",
    postStopProgressMode: "render",
    shouldStopAfterProgress: (result) => {
      const progress = createCopcCameraStreamDetailProgressState({
        finalNodeKeys: plan.finalNodeKeys,
        renderedNodeKeys: result.pointSamples.nodeKeys,
        // Interactive readiness only; not the terminal-quality test.
        minBudgetCompletionNodeCoverageRatio: 0.9,
        renderedPointBudget: plan.renderedPointBudget,
        renderedPointCount: result.pointSamples.sampledPointCount,
      });

      return progress.isComplete;
    },
  });

  const visualQuality = createCopcCameraStreamVisualQualityState({
    frontierNodeKeys: plan.selectedNodeKeys,
    requiredNodeKeys: plan.finalNodeKeys,
    renderedNodeKeys: result.pointSamples.nodeKeys,
  });

  if (!visualQuality.isTerminalReady) {
    throw new Error("Camera stream did not reach terminal visual quality.");
  }
}
```

`createCopcCameraStreamRenderPlan()` turns a camera selection into the concrete
node sets a streaming layer needs: selected nodes, ancestor-backed render nodes,
coverage nodes, the terminal node set, preview nodes, a per-node point cap, and a
stable render signature. For a `complete-depth` selection, `finalNodeKeys` is the
full available additive ancestor closure of the selected frontier. The complete
frontier is not truncated by the progressive final-node cap, and the rendered
point budget is distributed across the closure instead of being consumed by a
contiguous node prefix. `previewMinFinalNodeCount` can still skip a temporary
interactive preview when the terminal set is already small.

The shared camera-stream engine creates `finalNodeWeights` from the hierarchy
`pointCount` of every `finalNodeKeys` entry, including additive ancestors, and
`runCopcCameraStreamTerminalRender()` aligns those weights with the required
node order before passing them to `renderNodesProgressively()`. Complete-depth
and mixed-depth terminal commits therefore use the same deterministic weighted
water-fill. The render plan sets `useSourcePointBudgetHeadroom` automatically
for `mixed-depth`, whose selector has already charged the full additive closure
against source-point and compressed-byte budgets. The complete-depth default
keeps the legacy render-budget-derived per-node load cap because its selector
budgets the same-depth frontier before the ancestors are appended. A low-level
caller can explicitly opt into source headroom when it has equivalent upstream
resource accounting.

COPC uses [EPT's additive hierarchy
semantics](https://entwine.io/en/latest/entwine-point-tile.html), so descendants
do not replace their ancestors. `createCopcCameraStreamVisualQualityState()`
therefore treats a frame as terminal only when the frontier is an antichain, the
entire required additive set is rendered, and there are no missing, stale, or
unexpected nodes. A numeric point budget or 85-95% detail-node ratio is only an
interactive readiness signal.

`runCopcCameraStreamTerminalRender()` packages the correctness-critical part of
that low-level flow. It keeps a bounded request window running after interactive
readiness and resolves only after the returned layer result passes the exact
additive terminal gate. Typed geometry defaults `progressRenderMode` to
`"final-only"`: the caller's preview or retained frame remains visible while
bounded worker requests finish, then the full weighted point budget is
submitted once as the exact terminal composition. This avoids repeatedly
reallocating and uploading the same full-budget typed primitives as individual
nodes arrive. Non-typed renderers keep the adaptive incremental policy, and a
low-level terminal-executor caller can explicitly set
`progressRenderMode: "incremental"` when intermediate renderer commits are
preferred. The caller still owns the request ID, `AbortSignal`, hierarchy
expansion, prefetch, render signature, and any later camera update; a
superseded request therefore cannot schedule an unowned follow-up render.

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
  onUpdate: ({ phase, stage, requestId, lodSettings, result, visualQuality }) => {
    renderStatus({ phase, stage, requestId, lodSettings, result, visualQuality });
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
byte budgets, and renders the latest view. With a real `CopcPointCloudLayer`, an
internal headless engine expands hierarchy pages, selects the camera frontier,
creates the additive render plan and source-point weights, then delegates the
bounded final pass to `runCopcCameraStreamTerminalRender()`. Its defaults are
`coverageMode: "complete-depth"` and `includeAncestorNodes: true`, so the final
render contains the selected same-depth frontier plus every available additive
COPC ancestor. That default path distributes the full LOD render budget over the
additive set and keeps active progressive node requests bounded. It does not
reuse the small per-node preview cap, so moving from an overview profile to a
closer profile can produce the intended density increase.

`phase` remains the backward-compatible request lifecycle alias:
`"progress"` is emitted while work is advancing and `"complete"` when that
request settles. Use `stage` for visual semantics. Its values are `"preview"`,
`"refining"`, `"interactive-ready"`, and `"terminal"`; only `"terminal"`
asserts the exact additive visual-quality contract. On the default real-layer
engine path, the terminal update is reported as `phase: "complete"` and
`stage: "terminal"`. Mixed-depth selections also use the engine when additive
ancestors are enabled, with the separate mixed-depth-antichain terminal check.
Structurally limited layer-like test adapters and callers that request
ancestor-omitting or custom low-level progressive completion behavior retain the legacy
`renderAutomaticProgressively()` fallback. For that compatibility path,
`phase: "complete"` means only that the requested operation settled, so callers
must still inspect `stage` and `visualQuality` before claiming terminal quality.

Each update includes `visualQuality` when the layer exposes hierarchy data. The
default terminal state requires a same-depth antichain; explicit mixed-depth
selection requires a mixed-depth antichain. Both require complete ancestor
closure and zero missing or stale nodes. `renderOptions` can opt into that
mixed-depth path or omit ancestors for a non-terminal preview without replacing
the lifecycle controller. `lastResult`, `lastVisualQuality`,
`lastError`, `isRunning`, and `isRendering` expose state for application UI and
diagnostics.

When the selected quality has `temporalLodSafeSwap: true`, the high-level
controller may keep the last committed GPU frame while the next view loads. It
does so only when `getRendererRevision()` proves that frame is still resident.
The first intermediate replacement must include every coarse coverage node, at
least 65% of the source-weighted final-node set, and at least 60% of the smaller
of the exact-terminal point-count high-water mark and new rendered-point
budget. Intermediate frames never lower that high-water mark, preventing a
rapid sequence from accepting 60% of 60% repeatedly. After a safe replacement,
normal additive progress continues. The exact final candidate is never blocked
by this policy. A `changed` or `moveEnd` camera event aborts the superseded
render before the debounce interval begins, leaving its already committed GPU
frame visible but preventing stale progress from mutating it.

Applications implementing a custom loop can call
`createCopcCameraStreamSafeSwapState()` with a progressive candidate, coverage
and final node keys, optional final-node weights, point budget, and retained
point count. Its returned diagnostics include baseline coverage, weighted
coverage, point-retention ratio, and `canSwap`.

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
Call `abortSupersededRenderRequests(previousRequest)` before starting a new task
that can mutate a shared renderer. It aborts the direct predecessor and any
grace-retained request; `reconcilePreviousRequestForNodeReuse()` is appropriate
only for load-only overlap. `canReuseCopcCameraStreamCommittedRender()` verifies
exact required-node equality, fresh per-node density, and unchanged per-node and
total point budgets. The caller must additionally verify layer identity and
`layer.getRendererRevision()` because the helper deliberately cannot inspect
external renderer state.
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
const interactiveProgress = createCopcCameraStreamDetailProgressState({
  finalNodeKeys,
  renderedNodeKeys: progressResult.pointSamples.nodeKeys,
  // Readiness threshold only. Use visual quality for terminal status.
  minBudgetCompletionNodeCoverageRatio: 0.9,
  renderedPointBudget: 240_000,
  renderedPointCount: progressResult.pointSamples.sampledPointCount,
});
const isInteractiveReady = interactiveProgress.isComplete;
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
falls back to four point-sample and four integrated geometry workers, caps
point-sample pools at six workers, and caps integrated geometry pools at four
workers while reserving browser capacity for rendering and remote Range reads.
It also returns
`Number.POSITIVE_INFINITY` for
`decodedNodeWorkerFallbackDelayMilliseconds`, which the basic viewer passes to
`CopcPointCloudLayer` to keep strict worker-local decoded-cache affinity and
avoid repeating a COPC range read and LAZ decode on a fallback worker. Pass an
explicit finite value only after measuring that bounded wait latency is more
important for the target workload than decoded-node reuse.
Use
`createCopcCameraStreamRuntimeSettings()` for the default debounce, request
reuse, retained sample cache, prefetch, preview, warmup, and interactive-detail
readiness thresholds used by the basic viewer, then override only the values
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
detail nodes are represented in the latest progressive render and whether it is
interactive-ready. Pass `minBudgetCompletionNodeCoverageRatio` when a point
budget fill should not be enough by itself; this keeps an early camera response
from containing only one dense patch. This state must not be used as a terminal
quality claim. Use `createCopcCameraStreamVisualQualityState()` after the final
render for exact frontier, additive-closure, missing-node, and stale-node checks.

`createCopcCameraStreamPrefetchSelectionPlan()` makes the background camera
selection one depth step denser than the foreground view and tightens
screen-space spacing for the next likely frame. `createCopcCameraStreamPrefetchPlan()`
then combines selected detail nodes, coverage fallback nodes, cache freshness,
and density-aware point budgets into the concrete node list for
`prepareNodesProgressively()`. Pass `nodeWeights` when the prefetch list should
prioritize source-point-heavy nodes while keeping the same progressive coverage
ordering; the basic viewer uses camera-selected node point counts for this.
The reference viewer adds application-owned scheduling around these helpers:
after an exact retained render it skips predictive prefetch during active
camera movement and otherwise delays it by at least 350 ms. This timing is not
a library API default.

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
  coverageMode: "complete-depth",
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

`CopcPointCloudLayer.selectNodesForCamera()` derives two distinct COPC-space
positions from the Cesium camera: the viewport-center target orders candidate
nodes, while the camera-eye position drives projected node-size and point-spacing
estimates. Low-level `selectHierarchyNodesForCamera()` callers can provide the
same separation with the optional `cameraPosition` field; omitting it preserves
the legacy behavior of using `target` for both roles.

`selectionMode: "coverage"` defaults to `coverageMode: "complete-depth"`,
which only selects a same-depth coverage set when the whole depth fits the
configured node and byte budgets. Use `coverageMode: "progressive"` for camera
streaming flows that should keep a coarse full-view coverage layer while also
adding distributed target-depth detail nodes inside the same selection. That
mixed selection is suitable for an interactive preview, not a terminal
frontier, because it can contain ancestor/descendant overlaps.

Applications with their own residency manager can use the pure-core
`planMixedDepthHierarchyTraversal()` planner for a stricter mixed-depth path.
It reserves `requiredNodeKeys` and their complete additive closure before
optional refinements compete for node/point/compressed-byte budget. Its default
`refinementMode: "node"` preserves the low-level visual-benefit/resource-cost
planner. `refinementMode: "visible-sibling-group"` requires that baseline and
replaces a current frontier parent only when all immediate visible, renderable
children fit atomically; a partial sibling group is never selected. Both modes
apply separate refine/retain SSE thresholds, accept `previousFrontierKeys` for
hysteresis, and return planned, renderable, requested, blocked, and retained
parent node sets. Sibling-group refinement tests the current frontier parent's
SSE against the active threshold; its children may already be below that
threshold because they are the finer replacement. `selectHierarchyNodesForCamera({ coverageMode: "mixed-depth"
})` uses the baseline plus sibling-group mode. The high-level camera stream
continues to use its verified complete-depth terminal contract by default, while
the reference viewer explicitly opts into the mixed-depth antichain contract.

Hierarchy cache telemetry distinguishes global source state from current-frame
quality. `CopcHierarchyCacheStats.pendingPageCount` may include deeper pages
that are irrelevant to the selected frontier. Terminal camera-stream checks
must use `pendingRelevantHierarchyPageCount`, which counts only visible pending
pages through the resource-bounded selected depth.

### Automatic Camera Render

```ts
const result = await layer.renderAutomatic({
  camera: viewer.camera,
  expandHierarchy: true,
  maxHierarchyPages: 2,
  selectionMode: "coverage",
  coverageMode: "complete-depth",
  includeAncestorNodes: true,
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
target. Set `includeAncestorNodes: true` when the automatic result must preserve
COPC/EPT additive semantics; `CopcPointCloudCameraStream` enables it by default.

### Lifecycle

```ts
layer.clear();
layer.clearPointSampleCache();
layer.resetStreamingCaches();
layer.destroy();
```

- `clear()` removes rendered points and bounds while keeping the source and
  caches, and advances `getRendererRevision()`.
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

`pointDataViewMilliseconds` and `maxPointDataViewMilliseconds` remain the
end-to-end point-data-view wait fields. They intentionally include more than
LAZ decompression. New structured fields split successful worker work into:

- `pointDataViewRangeWaitMilliseconds`, `pointDataViewRangeRequestCount`, and
  `pointDataViewRangeBytes`: aggregate range-getter wait, successful getter
  calls, and returned exact-range bytes. With brokered/coalesced reads, this byte
  count is worker-visible payload rather than outer HTTP wire traffic; use the
  network benchmark ledger for wire-byte comparisons.
- `pointDataViewLazPerfMilliseconds`: time awaiting shared laz-perf
  initialization. This is normally near zero after the first worker use.
- `pointDataViewNonRangeMilliseconds`: remaining non-range view-load time after
  subtracting range wait and laz-perf initialization. It includes
  decompression/view construction and small setup overhead, so it must not be
  interpreted as a pure decoder CPU profile.
- `pointDataViewCacheWaitMilliseconds`: time awaiting an existing resolved or
  in-flight decoded view. Cache-hit requests attribute no new range, laz-perf,
  or non-range work.

Each duration and count/byte field also has a `maxPointDataView...` counterpart
for the slowest or largest single node. Missing split fields from older worker
responses are normalized to zero, preserving compatibility with older timing
artifacts.

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
a bounded set of Cesium `Primitive` objects from typed position and color
arrays, avoiding one Cesium point object per rendered COPC point. This keeps the
default renderer Cesium-native while moving closer to the final high-density
path.

Decoded point attributes preserve RGB, Classification, and Intensity. With the
default `pointColorMode: "attribute"`, rendering uses complete RGB first, then
fixed colors for known ASPRS classifications. Created-never-classified,
unclassified, and unknown values use gamma-adjusted intensity when available,
followed by a neutral gray; cyan remains the final fallback only when none of
those attributes exists. The reference viewer keeps this default.
`pointColorMode: "elevation"` instead clips source Z to
the COPC inspection's global `minZ`/`maxZ`, interpolates a six-stop viridis-like
palette, and uses its midpoint for non-finite or degenerate bounds. The style is
resolved once per layer and passed through main-thread, typed, object, and both
worker geometry paths, preventing per-node color normalization seams.

You can configure the default typed-array primitive renderer explicitly when you
need to tune point size or primitive chunking.

```ts
import { CesiumPrimitivePointRenderer } from "copc-cesium";

new CopcPointCloudLayer(viewer.scene, {
  url, // or source: fileOrBlob,
  pointColorMode: "elevation",
  createPointRenderer: (scene) =>
    new CesiumPrimitivePointRenderer(scene, {
      pointSize: 1,
      pointSizeMode: "adaptive",
      minimumPointSize: 1,
      maximumPointSize: 5.5,
      adaptivePointSizeScale: 0.85,
      splatCoverageScale: 1.3,
      splatSafetyHaloPixels: 1,
      pointSplatShape: "ground-ellipse",
      eyeDomeLighting: true,
      eyeDomeLightingStrength: 1.5,
      eyeDomeLightingRadius: 0.8,
      maxGeometryBatchesPerPrimitive: 4,
    }),
});
```

Adaptive sizing projects each batch's world-space point spacing into screen
pixels and clamps the result to `minimumPointSize` / `maximumPointSize`.
`CopcPointCloudLayer` supplies CRS-aware COPC node spacing and the retained
sample ratio automatically. Custom geometry-batch renderers can provide the
optional `pointSpacingMeters` and `pointDensityScale` fields on
`PointGeometryBatch`; missing spacing keeps the fixed `pointSize` fallback.
The renderer API itself defaults to `pointSizeMode: "fixed"` for compatibility,
while the reference viewer's quality presets enable adaptive sizing.

`splatCoverageScale` defaults to `1`. Increasing it overlaps neighbouring
footprints after density compensation, closing small screen-space holes without
loading more points. `pointSplatShape: "ground-ellipse"` constructs local ECEF
east/north tangent axes for each point, projects a world-space disc through the
current camera, and clips the fragment against the resulting ellipse. This
avoids the foreshortening error of a screen-facing circle under oblique views.
It requires `pointSizeMode: "adaptive"`; the constructor rejects a fixed-mode
ground ellipse instead of silently using a screen circle. A batch without
spacing metadata still uses the documented fixed-size circular fallback. Near
  a grazing projection, the fragment shader reconstructs the ellipse axes and
  clamps the minor axis to a one-pixel footprint instead of discontinuously
  replacing it with a full circle.
`splatSafetyHaloPixels` adds an isotropic CSS-pixel radius to both ellipse axes
after the bounded base footprint is computed. The point-sprite bounding box uses
the projected covariance row extents, so a rotated ellipse and its halo remain
inside the rasterized sprite without inflating the maximum base-size clamp.
The shader remains opaque and depth-writing so it composes with EDL; scene FXAA
is an application/quality-preset setting rather than a renderer option, and all
four reference presets currently keep it disabled. The renderer defaults remain
`splatCoverageScale: 1`, `splatSafetyHaloPixels: 0`, and
`pointSplatShape: "screen-circle"` for compatibility.

`eyeDomeLighting` enables a renderer-scoped eye-dome-lighting pass for opaque
point batches. It does not apply a post-process stage to the rest of the Cesium
scene. The adapter feature-detects Cesium's runtime point-cloud processor and
the required WebGL capabilities; unsupported environments keep the direct
Primitive path. Because the processor is runtime-exported but not part of
Cesium's public TypeScript declarations, this option defaults to `false` in the
renderer API. The reference viewer enables it for balanced, detail, and ultra
presets and keeps it off for preview.

`maxGeometryBatchesPerPrimitive` defaults to `1` so worker-prepared COPC
geometry batches stay as stable per-node primitives during progressive camera
updates. This avoids rebuilding earlier node primitives when a later node
finishes decoding. Balanced, detail, and ultra set it to `4`; an incomplete
progressive tail remains as stable per-node primitives, and a group is merged
once only after it reaches the batch or point seal instead of rebuilding a
growing 1 -> 2 -> 3 -> 4 buffer. A single batch, or merged batches with the same
effective Float32 spacing, embeds that spacing as one shader constant. Only a
mixed-spacing chunk allocates the 4-byte-per-point spacing attribute. If an
application prefers fewer Cesium primitives over lower incremental update cost,
it can raise this value. The older
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
