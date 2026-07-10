# Changelog

All notable changes to this project will be documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-10

### Added

- Direct COPC URL and browser `File`/`Blob` loading with bounded HTTP range,
  hierarchy, point-sample, decoded-node, and prepared-geometry caches.
- Cesium-native typed-array primitive rendering with stable per-node progressive
  updates, plus point-primitive and experimental buffer renderer alternatives.
- Camera-frustum COPC hierarchy selection, progressive coverage/detail LOD,
  request cancellation, worker backpressure, current-view priorities, and
  repeatable browser smoothness regression gates.
- `CopcPointCloudCameraStream` as the reusable high-level Cesium camera binding.
- Automatic projected CRS conversion from COPC WKT metadata, including compound
  WKT horizontal CRS extraction and vertical-unit scaling.
- Package-consumer, remote URL, local file, Autzen, and SoFi Stadium browser
  smoke verification.
- Reproducible release QC with actual WebGL adapter identity, per-preset
  performance evidence, renderer comparison, and package/worker size budgets.

[Unreleased]: https://github.com/KimDDong03/COPC_VIEWER/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/KimDDong03/COPC_VIEWER/releases/tag/v0.1.0
