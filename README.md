# COPC Viewer

[![CI](https://github.com/KimDDong03/COPC_VIEWER/actions/workflows/ci.yml/badge.svg)](https://github.com/KimDDong03/COPC_VIEWER/actions/workflows/ci.yml)

CesiumJS-native COPC point cloud visualization library prototype.

## Goal

Allow a CesiumJS developer to load a COPC file or URL directly into a Cesium scene without pre-converting it to 3D Tiles.

This project handles already-created COPC files. It does not target live LiDAR input, a general point cloud viewer app, or a COPC-to-3D-Tiles conversion pipeline.

## First Prototype Target

The current prototype is intentionally small:

1. Render hardcoded points in CesiumJS.
2. Open and inspect a COPC file or URL.
3. Read a small set of real XYZ points.
4. Transform the sample COPC CRS into Cesium-friendly longitude, latitude, and height.
5. Display sampled COPC hierarchy-node points in CesiumJS.

Full LOD, persistent cache management, workers, custom primitives, packaging, and advanced styling come later.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Build

```bash
npm run build:lib
npm run build:example
npm run build
npm run smoke:package
```

`npm run build:lib` writes the library package contract to `dist/lib`.
`npm run build:example` writes the runnable demo bundle to `dist/example`.
`npm pack --dry-run` can be used after `npm run build` to inspect the package contents without publishing.
`npm run smoke:package` packs the local build, installs it into a temporary consumer project, and verifies public imports from `copc-viewer`, `copc-viewer/core`, and `copc-viewer/cesium`.

The runnable prototype lives in `examples/basic-viewer`. The root `src` folder contains reusable COPC and Cesium integration code used by that example.
Reusable source entry points are `src/index.ts`, `src/core/index.ts`, and `src/cesium/index.ts`; package exports expose built JS and type declarations as `copc-viewer`, `copc-viewer/core`, and `copc-viewer/cesium`.
`CopcPointCloudLayer` is the first thin Cesium-facing API: it owns a `CopcSource`, point renderer, bounds renderer, and simple camera-based node rendering helpers.

The default example URL loads the public Autzen COPC sample, reads the root hierarchy node, samples up to 5,000 points, and renders them in CesiumJS.
The hierarchy node selector lists nodes from the root hierarchy page and lets the example render one selected node at a time.
`CopcSource` keeps the opened COPC metadata, hierarchy page, and sampled node point data in memory for the active URL.
The example also computes the selected node bounds and renders a yellow debug bounding box in CesiumJS.
It can suggest the nearest loaded hierarchy node to the current camera position and apply that suggestion on demand.
The manual render set can combine multiple hierarchy nodes and render their sampled points together.
The Auto LOD button selects a few nearby root-hierarchy nodes from the current camera position and viewport height, then renders them through the same multi-node path.

## API Sketch

```ts
import {
  CopcPointCloudLayer,
  createDefaultCopcCoordinateTransforms,
} from "copc-viewer";

const layer = new CopcPointCloudLayer(viewer.scene, {
  url,
  coordinateTransforms: createDefaultCopcCoordinateTransforms,
});
const { hierarchy, coordinateTransform } = await layer.load();

await layer.renderNode(hierarchy.nodes[0].key);
await layer.renderAutomatic({ camera: viewer.camera, maxNodes: 4 });

layer.destroy();
```

## Coordinate Transforms

`core` keeps COPC point samples in their source XYZ coordinates. Cesium-facing code converts those coordinates through a `coordinateTransforms` hook on `CopcPointCloudLayer`.

The prototype default transform supports geographic coordinates and the public Autzen EPSG:2992 sample. Other CRS values should pass a custom transform factory that returns `toCesium`; camera-based node suggestion and Auto LOD also require `toCopc`.
`layer.load()` returns a `coordinateTransform` status so examples and applications can show whether the active transform is `geographic`, `epsg:2992`, or `custom`, and whether camera-based selection is available.

## Planned Shape

```text
src/index.ts           Public source entry point
src/core/              COPC loading and point data preparation
src/cesium/            CesiumJS rendering and coordinate conversion
examples/basic-viewer/ Minimal runnable example
```
