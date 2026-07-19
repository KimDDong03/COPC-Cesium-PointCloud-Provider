# Performance and Verification

**COPC Cesium PointCloud Provider** (`copc-cesium`) is pre-1.0. Performance
results are reproducible measurements,
not fixed guarantees. Every blocking browser artifact records the actual WebGL
adapter, browser version, runtime, Git commit, and source fingerprint.

## Principles

- Keep configured point and LOD budgets fixed during a comparison. Automatic
  frame/GPU-driven quality reduction is not enabled by default.
- Measure a real browser and the actual Cesium render path.
- Separate product failures, external-source availability, source contract
  failures, and performance regressions.
- Treat clean-commit artifacts as evidence; dirty-worktree diagnostics are
  tuning data only.
- Attribute network timing to the observed source and route, not to the
  library's renderer.
- Compare regressions only on matching GPU/browser/threshold contracts unless
  a cross-device investigation is explicitly requested.

## Main Commands

| Command | Purpose |
| --- | --- |
| `npm run qc:product` | Unit tests, license/SPDX checks, library/example build, whitespace |
| `npm run live:copc-range` | Strict 64-byte `206`/`Content-Range`/`LASF` checks for documented live sources |
| `npm run benchmark:renderers` | Repeated Cesium renderer comparison in a real browser |
| `npm run benchmark:smoothness:contest` | Autzen and Millsite camera-movement gate |
| `npm run benchmark:smoothness:cold-detail` | Cold Millsite coverage and terminal-detail gate |
| `npm run benchmark:smoothness:regression` | Three fresh warm-detail sessions against the reviewed same-device baseline |
| `npm run smoke:package` | Build, pack, install, type-check, bundle, and browser-test the consumer tarball |
| `npm run qc:contest-device` | Full product, live-source, browser, package, performance, and evidence gate |

Generated results are written below `output/`, which is intentionally ignored
by Git.

## What the Smoothness Gate Measures

The browser benchmark moves a Cesium camera through a deterministic sequence
and records:

- `requestAnimationFrame` deltas during movement and terminal refinement;
- average FPS, p95/max frame time, and long-frame counts;
- first committed or proven-retained response for the expected request;
- foreground and terminal completion timing;
- rendered point count, selected depth, and final-node coverage;
- exact additive terminal composition and stale/missing node checks;
- worker decode, geometry, queue, cache, and hierarchy statistics;
- browser-observed HTTP Range request counts and bytes.

Finding cached data or starting work does not count as a visible response.
Terminal success requires the expected camera lineage, complete required-node
coverage, and a verified visual composition.

## Regression Gate

`npm run benchmark:smoothness:regression` first verifies the Millsite source
contract, then launches three fresh browser/cache sessions. Each session must
pass the absolute warm-detail assertion. The relative gate compares the median
of those sessions with
`benchmarks/baselines/smoothness-warm-zoom-detail-rtx3060.json`.

The comparison requires compatible source, WebGL renderer, browser contract,
and threshold snapshots. A source timeout, DNS/fetch failure, HTTP
`408`/`425`/`429`, or `5xx` is classified as external-source unavailability and
does not produce a performance verdict. A reachable source that violates the
Range/COPC contract is a failure.

## Evidence Contract

Browser JSON includes `runEvidence` with:

- canonical UTC generation time;
- Git HEAD and clean/dirty state;
- SHA-256 of tracked changes and non-ignored untracked content;
- Node, platform, architecture, npm lifecycle, browser, and WebGL adapter.

The final command creates
`output/contest-evidence/contest-evidence-manifest.json`. The manifest verifies
required JSON, screenshots, regression sessions, tarball, checksum, byte sizes,
SHA-256 values, passing statuses, and source-state agreement. Re-running
`npm run evidence:contest:check` rejects missing, modified, stale, or
source-mismatched artifacts.

## Verified Runtime Checkpoint

The last code-changing release candidate was commit
`f8294866d4637974e2613ecf712ce159376a25fb`. Its clean Windows/Chrome run used
the WebGL adapter reported as NVIDIA GeForce RTX 3060 and passed the complete
contest-device gate.

Cold Millsite detail:

| Metric | Result |
| --- | ---: |
| Rendered points | 360,000 |
| Required/rendered nodes | 80 / 80 |
| Node and weighted coverage | 100% / 100% |
| Selected depth | 5 |
| First visible response | 4.0 ms |
| Movement average FPS | 60.00 |
| Movement p95 / max frame | 16.8 / 16.9 ms |
| Terminal-refinement average FPS | 59.46 |
| Terminal p95 / max frame | 16.8 / 83.3 ms |
| Frames above 100 ms | 0 |
| HTTP Range requests | 134, all `206` |
| Requested Range bytes | 17,584,657 |
| Failed or duplicate ranges | 0 / 0 |

The same run passed 75 test files and 936 tests. The three-session performance
regression comparison reported zero failures. Exact package size and checksum
are release-candidate identities and belong in the manifest generated for the
target commit rather than in this historical runtime checkpoint.

These values describe that exact source state, browser, GPU, public dataset,
and network observation. They must not be generalized to all hardware or
networks. A new release candidate must generate a new clean-commit manifest.

## Package and Bundle Limits

Package smoke enforces:

- npm tarball at or below 650 KiB;
- each packed worker JavaScript asset at or below 600 KiB;
- all three typed ESM entry points and worker resources present;
- a fresh consumer type check and Vite bundle;
- successful Cesium canvas, COPC Range, worker, and camera-LOD browser smoke.

Vite may still report a raw chunk-size warning for worker assets. The explicit
tarball and worker ceilings are the blocking package-size contracts.

## Reproduction

Use Node.js 22 and the npm version declared by `packageManager`:

```bash
npm ci
npm run qc:contest-device
npm run evidence:contest:check
```

Run from a clean worktree on the target performance machine. Keep the resulting
manifest, QC status, benchmark JSON, screenshots, tarball, and checksum
together. Do not combine numbers from different commits, GPUs, or browser
contracts into one comparison.

## Limitations

- Browser frame intervals and CPU-side submission timing are measured; this is
  not a dedicated GPU profiler.
- Public source latency and availability can vary independently of the code.
- One workstation result is not a low-end-device guarantee.
- More COPC producers, coordinate systems, browsers, and hardware classes still
  require independent validation.
