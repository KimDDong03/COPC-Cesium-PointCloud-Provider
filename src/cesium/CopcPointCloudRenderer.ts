import type { Scene } from "cesium";
import type { PointSample } from "../core/PointSample";

export interface PointSampleBatch {
  readonly key: string;
  readonly points: readonly PointSample[];
}

export interface PointGeometryBatch {
  readonly key: string;
  readonly pointCount: number;
  readonly positions: Float64Array;
  readonly colors: Uint8Array;
  /** Representative world-space spacing of the unsampled points. */
  readonly pointSpacingMeters?: number;
  /**
   * Density relative to the points represented by `pointSpacingMeters`.
   * A value below one means that the batch was downsampled. Adaptive renderers
   * can use this to expand the effective spacing by `1 / sqrt(densityScale)`.
   */
  readonly pointDensityScale?: number;
}

export interface CopcPointCloudRenderer {
  setPoints(points: readonly PointSample[]): void;
  clear(): void;
  destroy(): void;
}

export interface CopcPointCloudBatchRenderer extends CopcPointCloudRenderer {
  setPointBatches(batches: readonly PointSampleBatch[]): void;
}

export interface CopcPointCloudGeometryBatchRenderer
  extends CopcPointCloudBatchRenderer {
  setPointGeometryBatches(batches: readonly PointGeometryBatch[]): void;
}

export type CopcPointCloudRendererFactory = (
  scene: Scene,
) => CopcPointCloudRenderer;

export function isCopcPointCloudBatchRenderer(
  renderer: CopcPointCloudRenderer,
): renderer is CopcPointCloudBatchRenderer {
  return "setPointBatches" in renderer;
}

export function isCopcPointCloudGeometryBatchRenderer(
  renderer: CopcPointCloudRenderer,
): renderer is CopcPointCloudGeometryBatchRenderer {
  return "setPointGeometryBatches" in renderer;
}
