# Architecture

`copc-cesium` is a TypeScript library prototype for loading COPC point cloud data directly into CesiumJS.

The library is intentionally not a standalone viewer product. The example app exists to prove and demonstrate the reusable API.

## Goals

- Open a COPC file or URL in the browser.
- Inspect COPC metadata and hierarchy.
- Read selected point-data nodes with HTTP range requests.
- Convert COPC source coordinates into Cesium-friendly longitude, latitude, and height.
- Render sampled points in a Cesium scene.
- Provide a small Cesium-facing API that can grow into a reusable layer or primitive.

## Non-Goals

- No COPC-to-3D-Tiles conversion pipeline.
- No live LiDAR or sensor ingestion.
- No general point cloud editing/viewer application.
- No full production LOD, byte-based cache policy, worker pool, or custom WebGL primitive in the first milestone.

## Layers

```text
src/core/
  COPC metadata, hierarchy, range reads, point sample preparation, cache state

src/cesium/
  Cesium scene integration, coordinate transforms, point and bounds rendering

examples/basic-viewer/
  Minimal browser demonstration of the reusable library
```

## Data Flow

```text
COPC URL
-> CopcSource
-> COPC metadata and loaded hierarchy pages
-> optional camera-targeted hierarchy page expansion
-> selected hierarchy node keys
-> range-read point data
-> sampled source XYZ points
-> coordinate transform
-> Cesium PointPrimitiveCollection
```

## Streaming Semantics

In this prototype, streaming means loading COPC hierarchy and point-data byte ranges on demand as the camera or selected node set changes.

The current implementation includes:

- `CopcSource.loadHierarchyPage` and `loadNextHierarchyPage` for on-demand COPC hierarchy page range reads.
- Hierarchy node and pending-page provenance tracking via the source hierarchy page ID, plus bounded hierarchy page eviction that restores evicted non-root leaf pages back to pending page references.
- `selectHierarchyPagesForTarget` for choosing nearby pending hierarchy pages from their octree bounds.
- `CopcSource` point sample caching by node key and sample count, with bounded LRU sample-set and estimated decoded-byte limits.
- `selectHierarchyNodesForCamera` for camera-based node selection using per-depth nearest-node screen-size estimates and COPC spacing-derived point spacing screen estimates, with optional point-count and point-data byte budgets.
- `CopcPointCloudLayer.expandHierarchyForCamera` for camera-targeted hierarchy expansion.
- `CopcPointCloudLayer.renderAutomatic` for selecting and rendering nodes in one call.
- `CopcPointCloudLayer.selectNodesForCamera` for selecting nodes without immediately rendering.
- Example-only `Stream on camera move` behavior that reruns hierarchy expansion, camera selection, and cached sample rendering.

The current streaming behavior is deliberately conservative. It limits the number of hierarchy pages opened per camera update and keeps example camera-stream rendering shallow so the prototype remains stable in a browser smoke test.

## Coordinate Transforms

`src/core` keeps points in source COPC XYZ coordinates. `src/cesium` converts them through a `coordinateTransforms` hook.

Available prototype paths:

- Geographic coordinates.
- Built-in EPSG:2992 handling for the public Autzen sample.
- `createProj4CoordinateTransforms` for projected CRS data when a proj4 definition is provided.

Camera-based selection requires both directions:

- `toCesium` for rendering source points.
- `toCopc` for mapping the Cesium camera position back to COPC source coordinates.

## Current Limitations

- Hierarchy page expansion and node selection are camera-targeted but still conservative; node selection now uses COPC spacing-derived screen estimates, but it is not yet calibrated against Cesium frustum parameters or point-density metrics.
- Hierarchy page eviction is page-count based and deliberately keeps the root hierarchy page loaded; it is not byte-aware yet.
- Point rendering uses Cesium point primitives, not a custom optimized WebGL primitive.
- Point sample cache byte usage is estimated from decoded sample fields, not from JavaScript object heap size.
- Camera streaming is prototype-oriented; it expands a small number of hierarchy pages per update while keeping the example's automatic render depth shallow.
- CRS detection is not complete; projected CRS data should pass explicit transform options.

## Near-Term Roadmap

1. Calibrate screen-space error estimates against Cesium camera frustum parameters and point-density metrics.
2. Tune hierarchy cache policy with byte-aware limits and camera-priority hints.
3. Move heavy point decoding/preparation work into Web Workers.
4. Replace point primitive rendering with a more scalable Cesium-native primitive path when the basic API stabilizes.
