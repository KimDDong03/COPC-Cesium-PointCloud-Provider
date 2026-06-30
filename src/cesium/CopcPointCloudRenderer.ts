import type { Scene } from "cesium";
import type { PointSample } from "../core/PointSample";

export interface CopcPointCloudRenderer {
  setPoints(points: readonly PointSample[]): void;
  clear(): void;
  destroy(): void;
}

export type CopcPointCloudRendererFactory = (
  scene: Scene,
) => CopcPointCloudRenderer;
