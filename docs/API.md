# API

`copc-cesium` is currently a prototype package. The public surface is useful for
experiments and contest demos, but the API should stay version `0.0.0` until
more COPC samples and renderer paths are validated.

The main integration point is `CopcPointCloudLayer`. It opens a COPC URL,
loads metadata and hierarchy information, reads selected point-data nodes, maps
COPC coordinates into Cesium coordinates, and submits sampled points to a
Cesium-native renderer.

## Entry Points

```ts
import { CopcPointCloudLayer } from "copc-cesium";
import { CopcSource } from "copc-cesium/core";
import { CesiumPointPrimitiveRenderer } from "copc-cesium/cesium";
```

- `copc-cesium` exports both core and Cesium-facing APIs.
- `copc-cesium/core` exports COPC loading, hierarchy, cache, and point-sample
  helpers without Cesium-specific imports.
- `copc-cesium/cesium` exports Cesium layer, renderer, bounds, and coordinate
  transform helpers.

## Minimal Cesium Usage

```ts
import { Viewer } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import {
  CesiumPointPrimitiveRenderer,
  CopcPointCloudLayer,
} from "copc-cesium";

const viewer = new Viewer("cesium-container");

const layer = new CopcPointCloudLayer(viewer.scene, {
  url: "https://example.com/point-cloud.copc.laz",
  maxPointCountPerNode: 5_000,
  pointSampleLoading: "worker",
  createPointRenderer: (scene) => new CesiumPointPrimitiveRenderer(scene),
});

const { hierarchy, coordinateTransform } = await layer.load();
console.log(coordinateTransform.label);

const firstNode = hierarchy.nodes[0];

if (firstNode) {
  const result = await layer.renderNode(firstNode.key);
  console.log(result.renderStats.pointCount);
}
```

A type-checked integration slice is available at
[`examples/minimal-layer.ts`](../examples/minimal-layer.ts). The full browser
demo remains [`examples/basic-viewer`](../examples/basic-viewer).

## CopcPointCloudLayer

```ts
const layer = new CopcPointCloudLayer(scene, options);
```

`scene` is a Cesium `Scene`. `options.url` is required and should point to a
COPC file that is readable by browser HTTP range requests.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `url` | required | COPC file URL. |
| `maxPointCountPerNode` | `5_000` inside lower-level point sampling | Default sample budget for each rendered hierarchy node. |
| `maxCachedHierarchyPages` | `64` | Loaded hierarchy page cache limit. |
| `maxCachedSampleSets` | `32` | Point sample cache entry limit. |
| `maxCachedPointSampleBytes` | `32 * 1024 * 1024` | Estimated decoded point sample cache byte limit. |
| `pointSampleLoading` | `"main-thread"` unless a worker factory is provided | Use `"worker"` to move point-data reads and LAZ decoding into a Web Worker. |
| `createPointSampleWorker` | built-in worker factory | Custom worker factory for applications with their own bundling strategy. |
| `createPointRenderer` | `CesiumPointPrimitiveRenderer` | Renderer factory implementing `CopcPointCloudRenderer`. |
| `showBounds` | `true` | Whether render calls draw debug hierarchy bounds by default. |
| `coordinateTransforms` | `createDefaultCopcCoordinateTransforms` | Factory that maps COPC source XYZ to Cesium longitude, latitude, and height. |

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

### Render One Node

```ts
const result = await layer.renderNode("0-0-0-0", {
  maxPointCount: 10_000,
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
});
```

`renderNodes()` deduplicates node keys, reads each selected node, and renders
one combined point set. `maxRenderedPointCount` caps the total sampled points
submitted to Cesium across all selected nodes, which helps camera-driven
rendering avoid sudden point-count spikes.

### Camera Selection

```ts
await layer.expandHierarchyForCamera({
  camera: viewer.camera,
  maxPages: 2,
});

const selection = await layer.selectNodesForCamera({
  camera: viewer.camera,
  maxNodes: 4,
  maxTotalPointDataLength: 2_000_000,
});

if (selection) {
  await layer.renderNodes(selection.nodes.map((node) => node.key));
}
```

Camera selection requires coordinate transforms with both `toCesium` and
`toCopc`. If `toCopc` is unavailable, `coordinateTransform.supportsCameraSelection`
will be `false`.

### Automatic Camera Render

```ts
const result = await layer.renderAutomatic({
  camera: viewer.camera,
  expandHierarchy: true,
  maxHierarchyPages: 2,
  maxNodes: 4,
  maxPointCountPerNode: 5_000,
  maxRenderedPointCount: 20_000,
});
```

`renderAutomatic()` is a convenience path that can expand nearby hierarchy
pages, select camera-relevant nodes, and render them in one call.

### Lifecycle

```ts
layer.clear();
layer.clearPointSampleCache();
layer.destroy();
```

- `clear()` removes rendered points and bounds while keeping the source and
  caches.
- `clearPointSampleCache()` drops decoded point sample cache entries.
- `destroy()` removes Cesium primitives and rejects later layer operations.

## Render Stats

Render calls return `renderStats`:

```ts
const { renderStats } = await layer.renderNode("0-0-0-0");

console.log(renderStats.pointCount);
console.log(renderStats.rendererSetPointsMilliseconds);
```

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

These numbers are prototype comparison metrics, not GPU frame-time profiling.

## Render Budgets

There are two related budgets:

- `maxPointCountPerNode`: maximum samples read from each individual hierarchy
  node.
- `maxRenderedPointCount`: maximum samples submitted to Cesium across a
  multi-node render call.

Use `maxRenderedPointCount` for camera streaming and Auto LOD paths where the
number of selected nodes may change as the camera moves.

## Renderers

`CopcPointCloudLayer` uses `CesiumPointPrimitiveRenderer` by default. It is
backed by Cesium `PointPrimitiveCollection` and is the stable renderer path for
now.

```ts
new CopcPointCloudLayer(viewer.scene, {
  url,
  createPointRenderer: (scene) =>
    new CesiumPointPrimitiveRenderer(scene, {
      pixelSize: 2,
      outlineWidth: 0,
    }),
});
```

`CesiumBufferPointRenderer` is available for experiments with Cesium
`BufferPointCollection`, but it should not become the default until larger COPC
benchmarks show a consistent benefit.

```ts
import { CesiumBufferPointRenderer } from "copc-cesium";

new CopcPointCloudLayer(viewer.scene, {
  url,
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

The default factory supports likely geographic coordinates and the public Autzen
EPSG:2992 sample:

```ts
import { createDefaultCopcCoordinateTransforms } from "copc-cesium";
```

For projected data, pass a proj4-backed transform:

```ts
import { createProj4CoordinateTransforms } from "copc-cesium";

const layer = new CopcPointCloudLayer(viewer.scene, {
  url,
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
import { CopcSource } from "copc-cesium/core";

const source = new CopcSource(url, {
  maxCachedHierarchyPages: 64,
  maxCachedSampleSets: 32,
});

const inspection = await source.inspect();
const hierarchy = await source.loadHierarchySummary();
const pointSamples = await source.loadNodePointSamples({
  nodeKey: hierarchy.nodes[0]?.key,
  maxPointCount: 5_000,
});
```

This is the boundary that should stay independent of Cesium imports.

## Current Stability

- Stable default renderer: `CesiumPointPrimitiveRenderer`.
- Experimental renderer: `CesiumBufferPointRenderer`.
- Prototype-level camera streaming and Auto LOD.
- CRS detection is limited. Pass `createProj4CoordinateTransforms` for projected
  COPC files outside the built-in/default cases.
- Package is still private and versioned as `0.0.0`; treat APIs as draft until
  the project is ready for npm publishing.
