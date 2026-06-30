# Architecture

`copc-cesium` is a TypeScript library prototype for loading COPC point cloud data directly into CesiumJS.

The library is intentionally not a standalone viewer product. The example app exists to prove and demonstrate the reusable API.

## Goals

- Open a COPC file or URL in the browser.
- Inspect COPC metadata and root hierarchy.
- Read selected point-data nodes with HTTP range requests.
- Convert COPC source coordinates into Cesium-friendly longitude, latitude, and height.
- Render sampled points in a Cesium scene.
- Provide a small Cesium-facing API that can grow into a reusable layer or primitive.

## Non-Goals

- No COPC-to-3D-Tiles conversion pipeline.
- No live LiDAR or sensor ingestion.
- No general point cloud editing/viewer application.
- No full production LOD, eviction policy, worker pool, or custom WebGL primitive in the first milestone.

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
-> COPC metadata and root hierarchy
-> selected hierarchy node keys
-> range-read point data
-> sampled source XYZ points
-> coordinate transform
-> Cesium PointPrimitiveCollection
```

## Streaming Semantics

In this prototype, streaming means loading COPC hierarchy and point-data byte ranges on demand as the camera or selected node set changes.

The current implementation includes:

- `CopcSource` point sample caching by node key and sample count.
- `selectHierarchyNodesForCamera` for simple camera-based node selection.
- `CopcPointCloudLayer.renderAutomatic` for selecting and rendering nodes in one call.
- `CopcPointCloudLayer.selectNodesForCamera` for selecting nodes without immediately rendering.
- Example-only `Stream on camera move` behavior that reruns camera selection and reuses cached samples.

The current streaming behavior is deliberately conservative. It limits the example camera stream to a shallow node selection so the prototype remains stable in a browser smoke test.

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

- Only the root hierarchy page is summarized.
- Point rendering uses Cesium point primitives, not a custom optimized WebGL primitive.
- Cache is in-memory and unbounded.
- Camera streaming is shallow and prototype-oriented.
- CRS detection is not complete; projected CRS data should pass explicit transform options.

## Near-Term Roadmap

1. Expand cache policy with explicit stats, limits, and invalidation.
2. Improve hierarchy traversal beyond the root page.
3. Add a better progressive loading policy for camera movement.
4. Move heavy point decoding/preparation work into Web Workers.
5. Replace point primitive rendering with a more scalable Cesium-native primitive path when the basic API stabilizes.
