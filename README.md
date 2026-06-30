# copc-cesium

[![CI](https://github.com/KimDDong03/COPC_VIEWER/actions/workflows/ci.yml/badge.svg)](https://github.com/KimDDong03/COPC_VIEWER/actions/workflows/ci.yml)

CesiumJS-native COPC point cloud streaming and visualization library prototype.

`copc-cesium` lets a CesiumJS developer load COPC point cloud data directly from a COPC file or URL, inspect its hierarchy, range-read selected point nodes, transform source coordinates, and render sampled points in a Cesium scene without pre-converting the data to 3D Tiles.

## Goal

Allow a CesiumJS developer to load a COPC file or URL directly into a Cesium scene without pre-converting it to 3D Tiles.

This project handles already-created COPC files. It does not target live LiDAR input, a general point cloud viewer app, or a COPC-to-3D-Tiles conversion pipeline.
Here, streaming means on-demand COPC hierarchy and point-data range reads driven by camera/node selection, not real-time sensor ingestion.

## Prototype Scope

The current prototype is intentionally small:

1. Render hardcoded points in CesiumJS.
2. Open and inspect a COPC file or URL.
3. Read a small set of real XYZ points.
4. Transform the sample COPC CRS into Cesium-friendly longitude, latitude, and height.
5. Display sampled COPC hierarchy-node points in CesiumJS.
6. Load nearby COPC hierarchy pages progressively and reuse in-memory node sample cache.

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
npm run smoke:example
npm run smoke:package
```

`npm run build:lib` writes the library package contract to `dist/lib`.
`npm run build:example` writes the runnable demo bundle to `dist/example`.
`npm pack --dry-run` can be used after `npm run build` to inspect the package contents without publishing.
`npm run smoke:example` builds the example, starts a temporary preview server, and verifies Autzen, SoFi, and Custom URL + proj4 rendering in a browser. Run `npm run smoke:example:install-browser` once if Playwright reports that Chrome for Testing is missing.
`npm run smoke:package` packs the local build, installs it into a temporary consumer project, and verifies public imports from `copc-cesium`, `copc-cesium/core`, and `copc-cesium/cesium`.
The same browser rendering smoke is available as the manual GitHub Actions workflow `Example Browser Smoke`.

The runnable prototype lives in `examples/basic-viewer`. The root `src` folder contains reusable COPC and Cesium integration code used by that example.
Reusable source entry points are `src/index.ts`, `src/core/index.ts`, and `src/cesium/index.ts`; package exports expose built JS and type declarations as `copc-cesium`, `copc-cesium/core`, and `copc-cesium/cesium`.
`CopcPointCloudLayer` is the first thin Cesium-facing API: it owns a `CopcSource`, point renderer, bounds renderer, and simple camera-based node rendering helpers.

The default example URL loads the public Autzen COPC sample, reads the root hierarchy node, samples up to 5,000 points, and renders them in CesiumJS.
The example keeps sample COPC URLs and their transform factories in a small preset list while still allowing direct custom URL entry.
For custom URLs, the example can also accept a source CRS and optional proj4 definition before loading the COPC file.
The hierarchy node selector lists currently loaded nodes and lets the example render one selected node at a time.
`CopcSource` keeps the opened COPC metadata, loaded hierarchy pages, pending hierarchy page references with bounds, and sampled node point data in memory for the active URL.
The Load next page button range-reads the next pending COPC hierarchy page and refreshes the available node list without converting the file to 3D Tiles.
The example also computes the selected node bounds and renders a yellow debug bounding box in CesiumJS.
It can suggest the nearest loaded hierarchy node to the current camera position and apply that suggestion on demand.
The manual render set can combine multiple hierarchy nodes and render their sampled points together.
The Auto LOD button expands a small number of nearby pending hierarchy pages, selects nearby loaded hierarchy nodes from the current camera position and viewport height, applies a small point-data byte budget, then renders them through the same multi-node path.
The Stream on camera move toggle reruns camera-based hierarchy expansion and node selection after camera movement, then reuses the in-memory COPC point-sample cache for already loaded node/sample-count pairs.

Included example presets:

- Autzen classified: EPSG:2992 sample handled by the default transform.
- SoFi Stadium: EPSG:32611 sample handled by `createProj4CoordinateTransforms`.

## API Sketch

```ts
import {
  CopcPointCloudLayer,
  createDefaultCopcCoordinateTransforms,
} from "copc-cesium";

const layer = new CopcPointCloudLayer(viewer.scene, {
  url,
  coordinateTransforms: createDefaultCopcCoordinateTransforms,
});
const { hierarchy, coordinateTransform } = await layer.load();

await layer.renderNode(hierarchy.nodes[0].key);
await layer.loadNextHierarchyPage();
await layer.expandHierarchyForCamera({ camera: viewer.camera, maxPages: 2 });
await layer.renderAutomatic({
  camera: viewer.camera,
  maxNodes: 4,
  maxNodePointDataLength: 1_000_000,
  maxTotalPointDataLength: 2_000_000,
});
const selection = await layer.selectNodesForCamera({ camera: viewer.camera });

layer.destroy();
```

## Coordinate Transforms

`core` keeps COPC point samples in their source XYZ coordinates. Cesium-facing code converts those coordinates through a `coordinateTransforms` hook on `CopcPointCloudLayer`.

The prototype default transform supports geographic coordinates and the public Autzen EPSG:2992 sample. Other CRS values should pass a custom transform factory that returns `toCesium`; camera-based node suggestion and Auto LOD also require `toCopc`.
`layer.load()` returns a `coordinateTransform` status so examples and applications can show whether the active transform is `geographic`, `epsg:2992`, or `custom`, and whether camera-based selection is available.
For projected CRS data, `createProj4CoordinateTransforms({ sourceCrs, sourceDefinition })` creates a `coordinateTransforms` factory backed by `proj4`.
In the basic viewer, custom URLs use the default transform when the Source CRS field is empty. If Source CRS is filled, the viewer creates a proj4-backed transform from that CRS and the optional proj4 definition field.

## Project Documents

- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [License](LICENSE)

## Planned Shape

```text
src/index.ts           Public source entry point
src/core/              COPC loading and point data preparation
src/cesium/            CesiumJS rendering and coordinate conversion
examples/basic-viewer/ Minimal runnable example
```
