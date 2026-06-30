import type { CopcInspection } from "../core/copc/CopcInspection";
import type { CopcPointDataSample } from "../core/copc/CopcPointDataSample";
import type { PointSample } from "../core/PointSample";
import {
  createCopcCoordinateTransform,
  type CopcToCesiumCoordinateTransform,
} from "./copcCoordinateTransform";

export function createPointSamplesFromCopc(
  points: readonly CopcPointDataSample[],
  inspection: CopcInspection,
  coordinateTransform: CopcToCesiumCoordinateTransform =
    createCopcCoordinateTransform(inspection),
): PointSample[] {
  return points.map((point) => {
    const coordinate = coordinateTransform(point.x, point.y, point.z);

    return {
      longitudeDegrees: coordinate.longitudeDegrees,
      latitudeDegrees: coordinate.latitudeDegrees,
      heightMeters: coordinate.heightMeters,
      color: point.color,
    };
  });
}
