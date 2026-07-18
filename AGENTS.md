# AGENTS.md

Repository-local guidance for Codex and other coding agents working on this project.

## Project Goal

Build an open-source TypeScript library that lets CesiumJS developers load and render COPC point cloud data directly in a Cesium scene.

The project is not a general point cloud viewer app, not a real-time LiDAR streaming system, and not a COPC-to-3D-Tiles converter.

Core flow:

```text
COPC file or URL
-> read COPC metadata and point data
-> load needed point data using COPC's octree/range-read structure
-> transform coordinates for CesiumJS
-> render points in CesiumJS
```

## Competition Scope Guard

Keep implementation and performance work inside the Gaia3D competition task:
direct COPC URL/`File`/`Blob` reading, COPC octree/LOD and HTTP Range use,
browser-side decode/cache/worker logic, CesiumJS-native rendering, reusable
library APIs, the reference example, and repeatable library verification.

Do not add AWS, CloudFront, S3 operations, CDN/edge servers, backend or proxy
products, data-hosting infrastructure, deployment QC, or pre-tiling/format
conversion pipelines. Do not attribute library performance to external delivery
infrastructure. Public remote COPC URLs are test inputs only. Static hosting of
the reference example is demonstration support, not a runtime dependency or a
performance optimization.

## First Milestone Scope

Keep the first milestone as a small technical prototype:

1. Create a minimal TypeScript, Vite, and CesiumJS environment.
2. Confirm CesiumJS can render a small hardcoded point set.
3. Use a COPC library to inspect a COPC file or URL.
4. Read a small number of real points from the COPC file.
5. Render those points in the CesiumJS scene.

Do not include full LOD, cache management, Web Workers, custom WebGL primitives, npm publishing, or advanced styling in the first milestone.

## Architecture Direction

Keep COPC loading separate from CesiumJS rendering.

Intended structure:

```text
src/core/
  COPC loading, metadata inspection, point extraction, node selection, cache/data preparation later

src/cesium/
  Cesium-specific rendering, coordinate conversion, layer/primitive API later

examples/basic-viewer/
  Minimal runnable example for loading and displaying points
```

Prefer small interfaces between layers, such as a plain point sample shape, before introducing larger abstractions.

## Dependencies

Prefer existing open-source libraries for low-level work:

- CesiumJS for globe and scene rendering.
- `copc` / `copc.js` for COPC metadata, hierarchy, and point reads.
- LAZ decoding support only when required by the selected COPC path.
- `proj4` or a user-provided transform hook only when CRS conversion becomes necessary.

Do not copy architecture from Potree, Giro3D, maplibre-copc-layer, or maplibre-gl-lidar. Use them only as references for concepts and tradeoffs.

## Implementation Rules

- Start from the smallest verifiable slice.
- Keep public APIs unstable until the prototype proves real COPC point display.
- Do not add framework, packaging, worker, or rendering complexity before the basic COPC-to-Cesium path works.
- Keep Cesium rendering code Cesium-native.
- Keep COPC parsing/loading code independent from Cesium imports.
- Use TypeScript types for data boundaries between `core` and `cesium`.
- Avoid broad refactors or unrelated formatting churn.

## Verification

For every non-trivial change, state:

- Evidence observed.
- Root cause or reason for the change.
- Change made.
- Verification performed.

Useful checks will depend on project state, but prefer:

- Type check.
- Build.
- Browser smoke test for Cesium rendering.
- A focused COPC sample read test once COPC loading exists.
