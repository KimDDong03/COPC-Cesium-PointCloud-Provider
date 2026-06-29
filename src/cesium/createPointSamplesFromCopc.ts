import type { CopcInspection } from "../core/copc/CopcInspection";
import type { CopcPointDataSample } from "../core/copc/CopcPointDataSample";
import type { PointSample } from "../core/PointSample";
import { createCopcCoordinateTransform } from "./copcCoordinateTransform";

export function createPointSamplesFromCopc(
  points: readonly CopcPointDataSample[],
  inspection: CopcInspection,
): PointSample[] {
  const transform = createCopcCoordinateTransform(inspection);

  return points.map((point) => {
    const coordinate = transform(point.x, point.y, point.z);

    return {
      longitudeDegrees: coordinate.longitudeDegrees,
      latitudeDegrees: coordinate.latitudeDegrees,
      heightMeters: coordinate.heightMeters,
      color: point.color,
    };
  });
}
