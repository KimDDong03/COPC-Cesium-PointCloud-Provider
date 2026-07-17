import type { CopcCameraStreamLodQualitySettings } from "./CopcCameraStreamSettings";

export type CopcPointCloudQualityPreset =
  | "preview"
  | "balanced"
  | "detail"
  | "ultra";

export interface CopcAutoLodQualitySettings {
  readonly autoLodMaxRenderedPointCount: number;
  readonly autoLodMaxSourcePointCount: number;
  readonly autoLodMaxNodePointCount: number;
  readonly autoLodMaxPointDataLength: number;
  readonly autoLodMaxNodePointDataLength: number;
  readonly autoLodMaxNodes: number;
  readonly autoLodMaxHierarchyPages: number;
  readonly autoLodTargetNodeScreenPixels: number;
  readonly autoLodTargetPointSpacingScreenPixels: number;
}

export interface CopcPointCloudQualitySettings
  extends CopcCameraStreamLodQualitySettings,
    CopcAutoLodQualitySettings {
  readonly maxPointCountPerNode: number;
  readonly pointPixelSize: number;
  readonly pointOutlineWidth: number;
  /** Maximum geometry batches merged into one Cesium draw primitive. */
  readonly maxGeometryBatchesPerPrimitive: number;
  readonly pointSizeMode: "fixed" | "adaptive";
  readonly minimumPointPixelSize: number;
  readonly maximumPointPixelSize: number;
  readonly adaptivePointSizeScale: number;
  readonly splatCoverageScale: number;
  /** CSS-pixel radius added around projected splats to close sub-pixel holes. */
  readonly splatSafetyHaloPixels: number;
  readonly pointSplatShape: "screen-circle" | "ground-ellipse";
  /** Enables Cesium's scene FXAA in the reference viewer. */
  readonly sceneFxaa: boolean;
  /** Holds the last committed frame until a new camera view is safe to swap. */
  readonly temporalLodSafeSwap: boolean;
  readonly eyeDomeLighting: boolean;
  readonly eyeDomeLightingStrength: number;
  readonly eyeDomeLightingRadius: number;
}

export const DEFAULT_COPC_POINT_CLOUD_QUALITY_PRESET: CopcPointCloudQualityPreset =
  "balanced";

export const COPC_POINT_CLOUD_QUALITY_SETTINGS: Readonly<
  Record<CopcPointCloudQualityPreset, CopcPointCloudQualitySettings>
> = {
  preview: {
    maxPointCountPerNode: 20_000,
    cameraStreamMaxRenderedPointCount: 10_000,
    cameraStreamMaxSourcePointCount: 250_000,
    cameraStreamMaxNodePointCount: 80_000,
    cameraStreamMaxPointDataLength: 6 * 1024 * 1024,
    cameraStreamMaxNodePointDataLength: 2 * 1024 * 1024,
    cameraStreamMaxNodes: 12,
    cameraStreamMaxDepth: 2,
    cameraStreamTargetNodeScreenPixels: 220,
    cameraStreamTargetPointSpacingScreenPixels: 8,
    autoLodMaxRenderedPointCount: 20_000,
    autoLodMaxSourcePointCount: 250_000,
    autoLodMaxNodePointCount: 80_000,
    autoLodMaxPointDataLength: 6 * 1024 * 1024,
    autoLodMaxNodePointDataLength: 1 * 1024 * 1024,
    autoLodMaxNodes: 12,
    autoLodMaxHierarchyPages: 3,
    autoLodTargetNodeScreenPixels: 220,
    autoLodTargetPointSpacingScreenPixels: 8,
    pointPixelSize: 3,
    pointOutlineWidth: 0,
    maxGeometryBatchesPerPrimitive: 1,
    pointSizeMode: "adaptive",
    minimumPointPixelSize: 1.5,
    maximumPointPixelSize: 5,
    adaptivePointSizeScale: 1.1,
    splatCoverageScale: 1.05,
    splatSafetyHaloPixels: 0,
    pointSplatShape: "screen-circle",
    sceneFxaa: false,
    temporalLodSafeSwap: false,
    eyeDomeLighting: false,
    eyeDomeLightingStrength: 0.1,
    eyeDomeLightingRadius: 1,
  },
  balanced: {
    maxPointCountPerNode: 180_000,
    cameraStreamMaxRenderedPointCount: 360_000,
    cameraStreamMaxSourcePointCount: 900_000,
    cameraStreamMaxNodePointCount: 80_000,
    cameraStreamMaxPointDataLength: 16 * 1024 * 1024,
    cameraStreamMaxNodePointDataLength: 2 * 1024 * 1024,
    cameraStreamMaxNodes: 96,
    cameraStreamMaxDepth: 5,
    cameraStreamTargetNodeScreenPixels: 80,
    cameraStreamTargetPointSpacingScreenPixels: 4,
    autoLodMaxRenderedPointCount: 240_000,
    autoLodMaxSourcePointCount: 900_000,
    autoLodMaxNodePointCount: 80_000,
    autoLodMaxPointDataLength: 16 * 1024 * 1024,
    autoLodMaxNodePointDataLength: 1 * 1024 * 1024,
    autoLodMaxNodes: 32,
    autoLodMaxHierarchyPages: 5,
    autoLodTargetNodeScreenPixels: 180,
    autoLodTargetPointSpacingScreenPixels: 8,
    pointPixelSize: 2,
    pointOutlineWidth: 0,
    maxGeometryBatchesPerPrimitive: 4,
    pointSizeMode: "adaptive",
    minimumPointPixelSize: 1.75,
    maximumPointPixelSize: 5,
    adaptivePointSizeScale: 0.9,
    splatCoverageScale: 1.25,
    splatSafetyHaloPixels: 1.25,
    pointSplatShape: "ground-ellipse",
    sceneFxaa: false,
    temporalLodSafeSwap: true,
    eyeDomeLighting: true,
    eyeDomeLightingStrength: 1.4,
    eyeDomeLightingRadius: 0.8,
  },
  detail: {
    maxPointCountPerNode: 300_000,
    cameraStreamMaxRenderedPointCount: 720_000,
    cameraStreamMaxSourcePointCount: 1_800_000,
    cameraStreamMaxNodePointCount: 160_000,
    cameraStreamMaxPointDataLength: 32 * 1024 * 1024,
    cameraStreamMaxNodePointDataLength: 4 * 1024 * 1024,
    cameraStreamMaxNodes: 160,
    cameraStreamMaxDepth: 6,
    cameraStreamTargetNodeScreenPixels: 56,
    cameraStreamTargetPointSpacingScreenPixels: 2.5,
    autoLodMaxRenderedPointCount: 500_000,
    autoLodMaxSourcePointCount: 1_800_000,
    autoLodMaxNodePointCount: 160_000,
    autoLodMaxPointDataLength: 32 * 1024 * 1024,
    autoLodMaxNodePointDataLength: 2 * 1024 * 1024,
    autoLodMaxNodes: 64,
    autoLodMaxHierarchyPages: 6,
    autoLodTargetNodeScreenPixels: 130,
    autoLodTargetPointSpacingScreenPixels: 5,
    pointPixelSize: 1,
    pointOutlineWidth: 0,
    maxGeometryBatchesPerPrimitive: 4,
    pointSizeMode: "adaptive",
    minimumPointPixelSize: 1,
    maximumPointPixelSize: 5.5,
    adaptivePointSizeScale: 0.85,
    splatCoverageScale: 1.3,
    splatSafetyHaloPixels: 1,
    pointSplatShape: "ground-ellipse",
    sceneFxaa: false,
    temporalLodSafeSwap: true,
    eyeDomeLighting: true,
    eyeDomeLightingStrength: 1.5,
    eyeDomeLightingRadius: 0.8,
  },
  ultra: {
    maxPointCountPerNode: 500_000,
    cameraStreamMaxRenderedPointCount: 1_200_000,
    cameraStreamMaxSourcePointCount: 3_600_000,
    cameraStreamMaxNodePointCount: 320_000,
    cameraStreamMaxPointDataLength: 64 * 1024 * 1024,
    cameraStreamMaxNodePointDataLength: 8 * 1024 * 1024,
    cameraStreamMaxNodes: 256,
    cameraStreamMaxDepth: 7,
    cameraStreamTargetNodeScreenPixels: 42,
    cameraStreamTargetPointSpacingScreenPixels: 1.75,
    autoLodMaxRenderedPointCount: 1_000_000,
    autoLodMaxSourcePointCount: 3_600_000,
    autoLodMaxNodePointCount: 320_000,
    autoLodMaxPointDataLength: 64 * 1024 * 1024,
    autoLodMaxNodePointDataLength: 4 * 1024 * 1024,
    autoLodMaxNodes: 96,
    autoLodMaxHierarchyPages: 7,
    autoLodTargetNodeScreenPixels: 100,
    autoLodTargetPointSpacingScreenPixels: 4,
    pointPixelSize: 1,
    pointOutlineWidth: 0,
    maxGeometryBatchesPerPrimitive: 4,
    pointSizeMode: "adaptive",
    minimumPointPixelSize: 1,
    maximumPointPixelSize: 5,
    adaptivePointSizeScale: 0.8,
    splatCoverageScale: 1.4,
    splatSafetyHaloPixels: 1,
    pointSplatShape: "ground-ellipse",
    sceneFxaa: false,
    temporalLodSafeSwap: true,
    eyeDomeLighting: true,
    eyeDomeLightingStrength: 1.7,
    eyeDomeLightingRadius: 0.8,
  },
};

export function createCopcPointCloudQualitySettings(
  preset: CopcPointCloudQualityPreset = DEFAULT_COPC_POINT_CLOUD_QUALITY_PRESET,
): CopcPointCloudQualitySettings {
  return { ...COPC_POINT_CLOUD_QUALITY_SETTINGS[preset] };
}
