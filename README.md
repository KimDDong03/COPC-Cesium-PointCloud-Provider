# COPC Cesium PointCloud Provider

[![CI](https://github.com/KimDDong03/COPC-Cesium-PointCloud-Provider/actions/workflows/ci.yml/badge.svg)](https://github.com/KimDDong03/COPC-Cesium-PointCloud-Provider/actions/workflows/ci.yml)
[![Live COPC Browser Evidence](https://github.com/KimDDong03/COPC-Cesium-PointCloud-Provider/actions/workflows/example-smoke.yml/badge.svg)](https://github.com/KimDDong03/COPC-Cesium-PointCloud-Provider/actions/workflows/example-smoke.yml)
[![GitHub Pages](https://github.com/KimDDong03/COPC-Cesium-PointCloud-Provider/actions/workflows/pages.yml/badge.svg)](https://github.com/KimDDong03/COPC-Cesium-PointCloud-Provider/actions/workflows/pages.yml)

CesiumJS-native COPC point-cloud streaming and visualization for browser
applications.

**Live demo:** <https://kimddong03.github.io/COPC-Cesium-PointCloud-Provider/>

The project is submitted as **COPC Cesium PointCloud Provider**. The npm package
name and JavaScript import identifier remain `copc-cesium`.

`copc-cesium` reads existing COPC data directly from a URL, `File`, or `Blob`,
selects the hierarchy nodes needed for the current camera, decodes them in the
browser, and renders them in CesiumJS. When configured, bounded workers can
perform point sampling and integrated geometry preparation. The library does
not require a COPC-to-3D Tiles conversion step.

> Status: `0.1.0`, pre-1.0 API. The npm registry release is pending; the source
> repository and locally verified package tarball are currently authoritative.

## What It Does

- Strict HTTP byte-range reads with `206` and `Content-Range` validation.
- COPC hierarchy expansion and bounded camera/frustum/LOD selection.
- Geographic, EPSG:2992, WKT/proj4, and application-provided coordinate
  transforms.
- Optional bounded worker decode and geometry preparation, plus cache reuse,
  priority, and cancellation.
- Cesium-native typed-array rendering, a point-primitive fallback, and an
  experimental buffer renderer.
- A high-level camera stream plus lower-level loading, selection, and rendering
  APIs.
- Repeatable URL, local-file, package-consumer, license, and browser performance
  verification.

### Competition scope boundary

The competition deliverable is the reusable TypeScript library, its CesiumJS
rendering path, the reference example, and reproducible verification.
Backend services, data hosting, COPC conversion, and external delivery infrastructure are explicitly out of scope.
Public COPC URLs are test inputs; GitHub Pages is only static demo hosting and
is not a runtime dependency or performance claim.

## Try the Demo

Use the [public viewer](https://kimddong03.github.io/COPC-Cesium-PointCloud-Provider/)
or run it locally with Node.js 22:

```bash
npm ci
npm run dev
```

Then open <http://localhost:3000>.

The example includes remote Autzen and Millsite COPC presets, custom URLs, and
browser-selected local files. Sample provenance and redistribution terms are
recorded in [DATASETS.md](docs/DATASETS.md).

## Consumer Setup

The package targets modern browser applications built with an ESM bundler.
CesiumJS `>=1.140.0 <2` is a peer dependency. Native Node.js execution is not a
supported runtime.

The public npm release is not available yet. To create and verify the current
local package candidate, clone this repository and run:

```bash
npm ci
npm run smoke:package
```

The installable tarball and checksum are written under
`output/package-smoke/`. Install that tarball together with Cesium in a consumer
application. Do not rely on `npm install copc-cesium` until a registry release
is published.

For a Vite consumer, configure Cesium's static assets with
`vite-plugin-cesium`:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";

export default defineConfig({
  plugins: [cesium()],
});
```

Other bundlers must copy Cesium's `Workers`, `Assets`, `Widgets`, and
`ThirdParty` directories and configure `CESIUM_BASE_URL`. The COPC decoding
workers are emitted as package-relative assets.

## Minimal Usage

```ts
import { Viewer } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import {
  CopcPointCloudCameraStream,
  CopcPointCloudLayer,
} from "copc-cesium";

const viewer = new Viewer("cesium-container", {
  animation: false,
  baseLayer: false,
  baseLayerPicker: false,
  timeline: false,
});

const layer = new CopcPointCloudLayer(viewer.scene, {
  url: "https://example.com/point-cloud.copc.laz",
  pointSampleLoading: "worker",
  maxPointCountPerNode: 5_000,
});

const { hierarchy } = await layer.load();
const firstNode = hierarchy.nodes[0];

if (firstNode) {
  await layer.renderNode(firstNode.key);
}

const cameraStream = new CopcPointCloudCameraStream({
  camera: viewer.camera,
  layer,
  quality: "balanced",
  renderOnStart: false,
  onError: console.error,
});

cameraStream.start();

// Later:
cameraStream.destroy();
layer.destroy();
viewer.destroy();
```

For a browser-selected local file, use `source` instead of `url`:

```ts
const file = fileInput.files?.[0];

if (file) {
  const localLayer = new CopcPointCloudLayer(viewer.scene, { source: file });
  await localLayer.load();
}
```

A complete type-checked integration is available in
[examples/minimal-layer.ts](examples/minimal-layer.ts).

## Remote Source Requirements

A remote COPC server must:

- honor `Range` requests and return `206 Partial Content`;
- return the exact requested byte count;
- expose `Content-Range` when exact range validation is required; and
- allow the viewer origin and `Range` header through CORS.

Persistent IndexedDB range reuse is opt-in and additionally requires a strong
validator such as an exposed `ETag`, or an application-owned immutable version
and authoritative source length. It improves repeat visits only; it is not a
cold-load performance claim.

## Public Imports

```ts
import { CopcPointCloudLayer } from "copc-cesium";
import { CopcSource } from "copc-cesium/core";
import { CesiumPrimitivePointRenderer } from "copc-cesium/cesium";
```

- `copc-cesium`: combined public surface.
- `copc-cesium/core`: COPC inspection, hierarchy, range, sampling, and cache
  APIs without Cesium imports.
- `copc-cesium/cesium`: coordinate transforms, renderers, layer, and camera
  streaming APIs.

See [API.md](docs/API.md) for the detailed contract.

## Verification

```bash
npm test
npm run build
npm run smoke:package
```

The full workstation gate is:

```bash
npm run qc:contest-device
```

It includes product tests, license/SBOM verification, real COPC Range checks,
browser and package smoke tests, renderer measurements, smoothness checks, and
a same-device regression comparison. Performance evidence records the actual
GPU, browser, source state, and commit fingerprint; it is not a universal FPS
guarantee. See the repository-only
[performance methodology](https://github.com/KimDDong03/COPC-Cesium-PointCloud-Provider/blob/main/docs/PERFORMANCE.md).

## Documentation

- [API reference](docs/API.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Sample data provenance](docs/DATASETS.md)
- [Performance methodology](https://github.com/KimDDong03/COPC-Cesium-PointCloud-Provider/blob/main/docs/PERFORMANCE.md) (repository-only)
- [Gaia3D competition evidence map](https://github.com/KimDDong03/COPC-Cesium-PointCloud-Provider/blob/main/docs/COMPETITION.md) (repository-only)
- [Release procedure](https://github.com/KimDDong03/COPC-Cesium-PointCloud-Provider/blob/main/docs/RELEASE.md) (repository-only)
- [Contributing](https://github.com/KimDDong03/COPC-Cesium-PointCloud-Provider/blob/main/CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [SPDX SBOM](docs/sbom.spdx.json)

## License and Stability

The project is licensed under [MIT](LICENSE). Third-party packages and bundled
worker components are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
and [docs/sbom.spdx.json](docs/sbom.spdx.json).

The API is pre-1.0 and may change between minor releases. Current limitations
include incomplete coverage across COPC producers and coordinate systems,
browser-only runtime support, and the need for application-supplied transforms
when a CRS requires unavailable external datum grids.
