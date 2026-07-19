# Contributing

Thanks for helping improve **COPC Cesium PointCloud Provider**, distributed as
the `copc-cesium` package.

## Project Focus

This project is a CesiumJS-native COPC point cloud library. Contributions should keep the core goal clear:

- Load COPC files or URLs directly in the browser.
- Use COPC hierarchy and range reads instead of converting COPC to 3D Tiles.
- Keep COPC loading independent from Cesium-specific rendering and keep
  application-only orchestration in the example.
- Preserve the bounded camera-stream, cancellation, worker, and cache contracts
  when tuning LOD or performance.

This project is not a general point cloud viewer app, not a live LiDAR ingestion system, and not a COPC-to-3D-Tiles converter.

## Setup

Use Node.js 22 and preferably npm 11.16.0. The root `devEngines` contract fails
on a mismatched Node runtime and warns on an older npm; CI and release checks
use the exact npm version declared by `packageManager`.

```bash
node --version
npm --version
npm ci
npm run dev
```

Open `http://localhost:3000` for the example.

## Verification

Before opening a pull request, run the checks closest to your change:

```bash
npm test
npm run license:evidence:self-test
npm run build
npm run smoke:package
```

For browser rendering changes, also run:

```bash
npm run smoke:example
```

For release, LOD, worker, cache, CRS, or renderer changes, run the complete gate:

```bash
npm run qc
```

Performance changes must include the generated assertion/report paths and the
actual `browserGraphics.renderer`. Do not treat reports from different GPUs as
a same-device regression comparison.

If Playwright reports that Chrome for Testing is missing, run this once:

```bash
npm run smoke:example:install-browser
```

## Code Guidelines

- Keep `src/core` free of Cesium imports.
- Keep Cesium-specific rendering and coordinate conversion in `src/cesium`.
- Prefer small typed interfaces between layers.
- Avoid broad refactors unless they are required for the feature or bug fix.
- Add focused tests for changed behavior.
- Keep example UI changes tied to demonstrating library behavior.
- Run `npm run license:evidence` and commit both generated artifacts whenever
  dependency metadata changes.
- Do not add a sample-data preset without recording its canonical source,
  reuse terms, attribution, CRS, and redistribution status in
  `docs/DATASETS.md`.

## Reporting Issues

Please include:

- COPC URL or file characteristics, if shareable.
- Browser and OS.
- Expected behavior.
- Actual behavior, including console errors.
- Whether `npm test`, `npm run build`, or `npm run smoke:example` passes locally.
