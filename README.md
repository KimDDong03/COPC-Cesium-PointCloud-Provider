# COPC Viewer

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
5. Display sampled root-node COPC points in CesiumJS.

Advanced LOD, cache management, workers, custom primitives, packaging, and styling come later.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

The default example URL loads the public Autzen COPC sample, reads the root hierarchy node, samples up to 5,000 points, and renders them in CesiumJS.
The hierarchy node selector lists nodes from the root hierarchy page and lets the example render one selected node at a time.
`CopcSource` keeps the opened COPC metadata, hierarchy page, and sampled node point data in memory for the active URL.

## Planned Shape

```text
src/core/      COPC loading and point data preparation
src/cesium/    CesiumJS rendering and coordinate conversion
examples/      Minimal runnable examples
```
