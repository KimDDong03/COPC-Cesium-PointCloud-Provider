# Changelog

All notable changes to this project will be documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-19

### Added

- Direct COPC URL and browser `File`/`Blob` loading with bounded HTTP range,
  hierarchy, point-sample, decoded-node, and prepared-geometry caches.
- Cesium-native typed-array primitive rendering with stable per-node progressive
  updates, plus point-primitive and experimental buffer renderer alternatives.
- Camera-frustum COPC hierarchy selection, progressive interactive LOD,
  complete-depth additive terminal composition, request cancellation, worker
  backpressure, current-view priorities, and repeatable browser smoothness
  regression gates.
- `CopcPointCloudCameraStream` as the reusable high-level Cesium camera binding.
- Automatic projected CRS conversion from COPC WKT metadata, including compound
  WKT horizontal CRS extraction and vertical-unit scaling.
- Package-consumer, remote URL, local file, Autzen, and large projected-dataset
  browser smoke verification.
- Reproducible release QC with actual WebGL adapter identity, per-preset
  performance evidence, renderer comparison, and package/worker size budgets.
- Reproducible third-party dependency notices and an SPDX 2.3 SBOM, enforced by
  CI, release QC, prepack, and package-consumer verification.
- Full license and copyright texts for the six runtime components bundled into
  browser worker assets, with mutation-tested package evidence.
- A version-controlled RTX 3060 warm-zoom performance baseline with strict
  same-WebGL-adapter regression comparison.
- Self-contained benchmark provenance with UTC, source revision and dirty-state
  fingerprint, Node/platform details, browser version, and actual WebGL adapter.
- Auditable sample-data provenance and a Hobu-hosted COPC matching the
  public-domain USGS 3DEP Millsite collection, replacing the former
  license-unspecified large preset.
- A clean-worktree contest evidence manifest that binds required JSON reports,
  screenshots, regression sessions, and the exact package tarball/checksum by
  source provenance, byte length, SHA-256, and linked browser contracts.

- Security policy, structured issue/PR templates, Dependabot, pinned workflow
  actions, CodeQL analysis, release procedure, and competition submission/demo
  checklists.
- A protected, manual-only npm publication workflow that verifies a matching
  version tag, reruns release QC, checks the exact tarball checksum, and uses
  OIDC provenance without enabling automatic deployment.
- Structured camera-stream visual-quality diagnostics that verify an antichain
  frontier, complete additive ancestor closure, and zero missing or stale nodes
  before a render is labeled terminal.
- A reusable `runCopcCameraStreamTerminalRender()` executor that preserves
  caller-owned cancellation and request identity while completing bounded
  progressive windows and rejecting non-terminal final compositions.
- Optional point-geometry resident-byte budgeting with alias-aware backing
  buffer accounting, cross-cache LRU eviction, peak/eviction telemetry, and an
  explicit 384 MiB bound in the reference viewer.
- Optional aggregate decoded-point-data budgeting across both worker pools,
  source-aware worker-global LRU eviction, and structured retained/peak/hit/miss
  telemetry. The reference viewer now enforces a 768 MiB layer-wide ceiling
  instead of allowing the per-worker ceiling to multiply with CPU-scaled
  concurrency.
- Deterministic spatially progressive COPC sampling based on 10-bit-per-axis
  quantized Morton codes, a stable four-pass radix sort, and centered
  bit-reversal prefixes shared by every density. Retained decoded worker views
  cache the order and account for its `Uint32Array` at exactly 4 bytes per
  decoded point.
- Optional projected-spacing adaptive splats in the typed Cesium primitive
  renderer, with per-node CRS-aware metre spacing and sample-density metadata.
- Optional ECEF tangent-plane ground ellipses and post-density splat coverage
  scaling for oblique-view continuity. Covariance row extents correctly bound
  rotated ellipses, and balanced/detail/ultra add 1.25/1/1 CSS-pixel safety
  halos after the bounded base-size calculation. Renderer defaults retain the
  compatible unit-scale screen circle and zero halo. Ground ellipses require
  adaptive sizing. Projected covariance row extents bound the rotated sprite,
  while the fragment shader reconstructs its axes and keeps a one-pixel minor
  footprint at grazing angles.
- Renderer-scoped optional eye-dome lighting for opaque typed point batches,
  with Cesium runtime/WebGL feature detection and direct-primitive fallback.
  Balanced, detail, and ultra opt in and keep scene FXAA disabled; preview keeps
  both EDL and scene FXAA disabled.
- Geometry-batch draw consolidation with a compatibility default of one batch
  per primitive and a four-batch ceiling in balanced/detail/ultra. An incomplete
  progressive tail remains stable per-node and merges once only when sealed.
  Uniform effective spacing is embedded as one shader constant; mixed-spacing
  chunks retain the per-point Float32 attribute fallback.
- A renderer-independent mixed-depth hierarchy traversal planner with required
  baseline/additive closure reservation, atomic visible-sibling refinement,
  parent-frontier SSE hysteresis, readiness, visual-benefit/resource-cost
  ranking, and node/point/compressed-byte budgets.
- Layer-wide `pointColorMode` styling with backward-compatible attribute color
  and global-bounds elevation color through a six-stop viridis-like palette,
  shared by object, typed-array, standalone-worker, and integrated-worker paths.
  The reference viewer keeps the backward-compatible attribute default.
- A strict renderer-only quality A/B harness with paired point-on/point-off
  canvas masks, exact source/node/signature/point/canvas equivalence gates,
  camera floating-point tolerances, screen-door and baseline-support/large-void
  preservation metrics, AB/BA ordering, frame timing, source response
  provenance, browser error invalidation, and nonzero failed-gate exits.
- A live Eptium comparison harness with exact source, ETag, camera, canvas,
  terminal-state, stock-style, stable-background, and same-WebGL-adapter gates;
  shipped-default, high-detail, and equal-point-count result classes; AB/BA
  ordering; non-blocking cross-LOD support diagnostics; fresh-page readiness
  timing; and a hashed product-only COPC request ledger with exact duplicate,
  overlap, amplification, abandoned-work, and coalescing estimates. The latest
  two-repeat controlled Autzen checkpoint passes the strict equal-count visual
  and p95 gates and records a product-ready advantage, while retaining the
  explicit unique-byte/request-count deficit and cross-run tail-latency caveat.
- High-performance/low-power browser GPU profiles with actual-renderer
  assertions, persisted device evidence, and optional headed smoothness runs.
- A hierarchy-node picker capped at 300 DOM options, with filtering/direct entry
  for every loaded node.

### Changed

- Worker-prepared geometry bounds and opacity hints avoid main-thread rescans;
  custom batches retain the compatible fallback.
- Typed camera-stream terminal refinement now retains the current preview or
  revision-proven frame while bounded worker requests finish, then performs one
  exact weighted full-budget renderer commit. This avoids repeated primitive
  reallocations and GPU uploads as individual nodes arrive. Non-typed renderers
  keep adaptive incremental progress, and low-level terminal-executor callers
  can explicitly opt typed rendering back into `"incremental"` mode.
- Point-sample work, source-aware integrated-geometry warmup, and every
  integrated geometry load/prefetch now reuse COPC metadata already parsed by
  the main source. Later metadata recovers a worker from a rejected fallback
  bootstrap, while soft cancellation lets superseded uncached geometry finish
  into its worker cache. Strict decoded-worker affinity now prevents a busy
  cache owner from sending a density upgrade through an uncached fallback
  worker. The controlled equal-count sequence reduced product ranges from 85
  to 60 and exact duplicate requests from 22 to zero without changing the
  terminal node or point-count contract. Four transition-time predictive
  prefetch requests and the larger unique-byte union remain explicit network
  blockers.
- The viewer warms point-sample workers only before manual node rendering;
  camera streaming still warms geometry workers at source load.

- Camera-stream temporal LOD can now retain a revision-proven GPU frame until
  the first replacement contains the complete coarse baseline, at least 65%
  weighted final-node coverage, and at least 60% of the comparable
  exact-terminal point-count high-water mark. Intermediate frames cannot ratchet
  that floor downward. Camera changes abort superseded rendering before debounce
  so stale progress cannot mutate that transition frame; exact terminal commits
  remain ungated.
- Camera-stream reuse now separates cached final-node detail from non-final
  background coverage, retains an unchanged lower-density frame as explicit
  progress without resubmitting geometry, and promotes only a matching,
  completed weighted render signature to exact terminal reuse. Smoothness QC
  binds completion to both visual composition and detail progress and reads
  rendered point counts from the applied-frame state before using legacy
  status-text parsing.
- Camera-stream prefetch progress, completion, cancellation, and failure now
  refresh the visible metadata row immediately; browser smoke verifies that the
  settled runtime state and panel text stay synchronized.
- Adaptive camera-stream limits now govern in-motion work only; settled
  terminal views return to the configured LOD ceilings so identical camera and
  quality inputs converge to identical final depth and density after slow or
  superseded requests.
- Decoded worker-cache snapshots now accompany failed and soft-canceled work,
  keeping retained-byte telemetry and source-aware affinity synchronized after
  an in-flight decode evicts older nodes.
- Progressive foreground/background point budgeting and typed/object/geometry
  payload limiting now live in a focused internal module with independent
  allocation and channel-preservation tests.
- Complete-depth and mixed-depth terminal paths now derive source-point weights
  for every required additive node and share a deterministic integer weighted
  water-fill with cap-aware leftover redistribution. Low-level calls without
  weights keep equal-share allocation. Ancestor-budgeted mixed-depth plans also
  opt into configured per-node source headroom and apply the global point limit
  during composition; complete-depth keeps its budget-derived load cap.
- The reference viewer's fast foreground coverage preview now targets roughly
  2,800 points across at most two early nodes before denser refinement.
- Cold and warm Millsite profiles now use dataset-relative height, explicit
  warmup/settle evidence, strict request/run contracts, and a versioned
  same-adapter baseline.
- Cold-detail QC now allows a 30-second post-prefetch wait and requires a newer
  same-epoch, same-pose request with completed prefetch, depth 5 or deeper, at
  least 300,000 points, terminal-ready composition, zero pending view hierarchy
  pages, and final-stage frame checks.
- The CesiumJS peer floor is now 1.140.0, the first version providing the
  statically exported experimental buffer-point API, and package smoke verifies
  an exact minimum-version consumer.
- The supported runtime is now stated precisely as a browser ESM-bundler
  integration; Node 22 is the repository development/QC toolchain rather than
  a native Node ESM runtime claim.
- Package smoke now installs the exact tarball with strict Bundler and NodeNext
  declaration checks, documented Cesium static-asset setup, and a real browser
  render through both packaged COPC worker paths.
- Release candidates now reject tag/package version mismatches, preserve a
  tarball SHA-256 file, upload only current approved demo screenshots, and offer
  a public no-details request form when private vulnerability reporting is not
  yet enabled.
- Performance baseline updates now require a five-session candidate followed by
  a separate reviewed installation command; capture never overwrites the
  versioned baseline directly.
- Browser QC now executes the exact lockfile-installed Playwright, Vite, and
  TypeScript package binaries, and the development lock is current with Cesium
  1.143.0 and Vitest 4.1.10.
- The high-level camera stream keeps complete-depth coverage and available COPC
  ancestors as its default. The reference viewer explicitly uses a required
  visible coverage baseline plus atomic visible-sibling refinements to produce a
  separately validated mixed-depth antichain. Interactive preview thresholds
  remain separate from either exact terminal-quality contract.
- The high-level camera stream now distributes the full LOD render budget across
  a complete-depth additive set, bounds active progressive node requests, and
  reports structural visual-quality state with each observable update.
- Real `CopcPointCloudLayer` camera streams now share one internal headless
  selection, additive render-plan, source-weight, and terminal-executor path;
  explicit low-level progressive policies retain the compatibility adapter.
- Camera-stream updates now expose `preview`, `refining`, `interactive-ready`,
  and `terminal` stages while retaining `progress` / `complete` as the
  backward-compatible request-phase alias.
- Smoothness QC now measures animation frames through terminal refinement, not
  only during camera movement, and rejects malformed evidence or a terminal
  refinement frame above the existing responsiveness gates.
- Warm smoothness QC now completes the normal warmup prefetch and then applies a
  benchmark-only, layer-bound hierarchy hold across measured repeats. Exact
  frontier keys, additive render signature, and hierarchy cache state must stay
  identical while geometry prefetch remains enabled.
- Smoothness first-response evidence now distinguishes an actual application
  scene commit from an exactly retained renderer frame and records request
  identity, render disposition, and renderer revision for either path.
- The example build now splits `proj4` from the main application entry; the
  latest release-candidate snapshot produced 367.93 kB and 131.70 kB
  uncompressed JavaScript chunks respectively.

### Fixed

- Browser smoke validates current point-geometry timing text and, when present,
  structured finite/cache-consistency data instead of obsolete wording.
- Smoothness browser-flow output allows 64 MiB, preventing multi-repeat
  cold-detail `ENOBUFS` failures.
- Same-camera hierarchy follow-up signatures now include refined depth. A
  hierarchy-complete depth-5 transition can no longer collide with a prior
  depth-4 complete signature for the same visible node set and leave a cold
  detail view permanently non-terminal.
- Mixed-depth sibling refinement now tests the current frontier parent's SSE
  against the refine/retain threshold. Target-depth children can legitimately
  be below that threshold; requiring them to exceed it left qualifying branches
  one depth too coarse.
- Repeated camera selections now reuse each immutable hierarchy node's
  transformed eight-corner `BoundingSphere` through an identity-keyed `WeakMap`.
  Current camera-frustum tests still run on every selection, and replacement
  hierarchy node identities are recomputed.
- Camera-selected hierarchy expansion now chooses Cesium-frustum-visible
  current-view pending pages instead of only the viewport-center tile, spends
  one bounded budget across newly revealed levels, and keeps visual quality
  non-terminal while relevant pages remain. Background refinement stops at the
  active LOD `maxDepth` instead of chasing speculative `maxDepth + 1` pages.
  The reference viewer schedules a same-camera follow-up after its fast
  foreground response and binds it to the unchanged camera epoch and pose, so
  zoomed regions no longer stay permanently sparse or promote stale work.
- Concurrent callers for the same hierarchy page now share the page merge and
  eviction mutation as well as the byte read. This preserves parent provenance,
  prevents duplicate LRU mutations, and keeps descendant eviction restorable.
- Worker-pool warmup now rejects promptly when a worker crashes, progressive
  sibling requests are aborted after a peer fails, and a failed initial layer
  load can be retried instead of remaining permanently rejected.
- HTTP and Blob range getters now enforce a configurable 256 MiB default
  single-read ceiling, exact source bounds and response lengths, plus a 30
  second HTTP deadline that covers response-body streaming. Oversized,
  truncated, stalled, or overlong range responses fail before unbounded bytes
  reach the COPC parser.
- Decoded-view affinity and retained-byte telemetry no longer become stale when
  a decode fails or a soft-canceled request evicts another cached node. Error
  and canceled worker responses now synchronize the resulting cache snapshot
  without granting affinity to a failed request.
- Zoomed public camera-stream renders no longer underfill the 360k/720k LOD
  budgets because of a preview-oriented 5k-6.5k per-node cap. Explicit
  progressive preview mode keeps that conservative cap.
- Terminal visual-quality checks no longer accept disjoint mixed-depth
  frontiers. The default contract requires one uniform frontier depth; the
  explicit mixed-depth contract requires an antichain produced from preserved
  baseline coverage and atomic sibling refinement. Both require complete
  additive closure and zero missing or stale nodes.
- Aborted hierarchy callers now stop waiting before page merge without
  canceling shared range work, and failed metadata, root, or hierarchy-page
  promises are removed from caches so a later request can retry cleanly.
- Camera zoom no longer lowers the hidden per-node source budget and falls back
  from Autzen depth 2 to depth 1. Screen-space estimates now use the camera eye,
  zoom LOD resource limits are monotonic, and browser smoke locks the
  overview-to-close refinement contract.
- HTTP range reads now reject malformed or mismatched `Content-Range` metadata
  instead of passing corrupt COPC bytes to the parser.
- Camera-stream LOD now uses height above transformed COPC bounds, so
  high-elevation datasets no longer remain in an erroneously distant profile.
- RGB-less point clouds now preserve Classification and Intensity through
  worker/cache boundaries and share a classification/intensity color fallback
  across renderer backends.
- Smoothness measurements now bind completion to the expected camera-stream
  request and preserve the measured snapshot separately from later prefetch
  observations.
- Warm-cache assertions now recognize authoritative layer geometry-cache hit
  deltas when a mixed run's worker timing reports zero local hits, eliminating
  a false negative without weakening the minimum-reuse requirement.
- Fully retained camera-stream repeats now report exact final-node reuse as
  `camera-stream-node-sample-cache` evidence instead of failing because a
  zero-worker hot path has no decode timing.
- Zero-worker benchmark evidence now requires fresh retained samples for every
  final node; partial/stale reuse and prepared-geometry hit deltas can no longer
  synthesize zero decode or worker latency.
- Same-device smoothness regression now compares three fresh-browser session
  medians against a five-session MAD-backed baseline, uses bounded additive
  jitter allowances for low-latency timings, and keeps scheduler-sensitive
  relative queue time informational while preserving strict absolute gates.
- Emitted declarations now use NodeNext-compatible `.js` relative specifiers,
  and consumers receive the Emscripten ambient types required by the upstream
  COPC/LAZ declarations instead of relying on `skipLibCheck`.
- Aborting one caller no longer cancels a same-node point-sample or transformed
  geometry task still used by another caller; the underlying worker is stopped
  only after the final active consumer cancels, and already-aborted renders no
  longer start unowned geometry work after an asynchronous sampling boundary.
- Camera streaming no longer treats an 85-95% mixed-depth render or a cache-only
  tail as final. Bounded request windows continue through the complete required
  set, one exact terminal render removes retained preview nodes, and cached
  density reduction keeps a spatially distributed nested prefix instead of
  either source-order bias or a density-dependent resampling pattern.
- Fully cached progressive renders now omit retained background nodes on their
  first commit instead of waiting for a nonexistent follow-up load, and empty
  zero-point hierarchy entries are excluded from camera frontiers and additive
  terminal validation.
- Opaque typed-array point batches now use depth writes, and cold terminal
  refinement commits at most one new geometry node per progress step with an
  animation-frame yield between additions.
- Exact committed camera-stream renders can now be retained without geometry
  resubmission only when the layer identity, monotonic renderer revision, node
  set, density, and point budgets still match. Every superseded render-capable
  request is aborted before this decision so stale progress cannot mutate the
  shared renderer.
- Predictive prefetch after an exact retained render is skipped during active
  camera movement and delayed by at least 350 ms after movement stops.
- Progressive camera refinement can now reject a lower-density intermediate
  frame before it mutates the point or bounds renderer. Rejected progress keeps
  the renderer revision unchanged, while the complete final frame is always
  committed.
- Superseding a progressive render now observes every already-enqueued worker
  promise before aborting, preventing an unhandled abort rejection from leaking
  into the page while the replacement camera request continues successfully.
- Package browser smoke now records every observed range response and accepts a
  transient 429/5xx only when the exact same URL and byte range later succeeds
  with a valid `206 Content-Range`; unrecovered or mismatched responses fail QC.
- Camera hierarchy refinement now stops at the deepest complete frontier the
  active node and point budgets can render. Wide overview views no longer
  chase a deeper screen-space target through more pages than the bounded cache
  can retain, eliminating terminal timeouts caused by hierarchy cache churn.

[Unreleased]: https://github.com/KimDDong03/COPC_VIEWER/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/KimDDong03/COPC_VIEWER/releases/tag/v0.1.0
