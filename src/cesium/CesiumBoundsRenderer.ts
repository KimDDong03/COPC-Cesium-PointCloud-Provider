import {
  Cartesian3,
  Color,
  Material,
  PolylineCollection,
  Scene,
} from "cesium";
import type { CopcBounds, CopcInspection } from "../core/copc/CopcInspection";
import { createCopcCoordinateTransform } from "./copcCoordinateTransform";

const EDGE_INDEXES = [
  [0, 1],
  [1, 3],
  [3, 2],
  [2, 0],
  [4, 5],
  [5, 7],
  [7, 6],
  [6, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
] as const;

export class CesiumBoundsRenderer {
  private readonly collection: PolylineCollection;

  constructor(scene: Scene) {
    this.collection = scene.primitives.add(new PolylineCollection());
  }

  setBounds(bounds: CopcBounds, inspection: CopcInspection): void {
    this.setBoundsList([bounds], inspection);
  }

  setBoundsList(boundsList: readonly CopcBounds[], inspection: CopcInspection): void {
    this.collection.removeAll();

    const transform = createCopcCoordinateTransform(inspection);
    for (const bounds of boundsList) {
      this.addBounds(bounds, transform);
    }
  }

  clear(): void {
    this.collection.removeAll();
  }

  private addBounds(
    bounds: CopcBounds,
    transform: ReturnType<typeof createCopcCoordinateTransform>,
  ): void {
    const corners = createBoundsCorners(bounds).map(([x, y, z]) => {
      const coordinate = transform(x, y, z);

      return Cartesian3.fromDegrees(
        coordinate.longitudeDegrees,
        coordinate.latitudeDegrees,
        coordinate.heightMeters,
      );
    });
    for (const [start, end] of EDGE_INDEXES) {
      this.collection.add({
        positions: [corners[start], corners[end]],
        width: 2,
        material: Material.fromType(Material.ColorType, {
          color: Color.YELLOW.withAlpha(0.9),
        }),
      });
    }
  }
}

function createBoundsCorners(bounds: CopcBounds): [
  [number, number, number],
  [number, number, number],
  [number, number, number],
  [number, number, number],
  [number, number, number],
  [number, number, number],
  [number, number, number],
  [number, number, number],
] {
  return [
    [bounds.minX, bounds.minY, bounds.minZ],
    [bounds.maxX, bounds.minY, bounds.minZ],
    [bounds.minX, bounds.maxY, bounds.minZ],
    [bounds.maxX, bounds.maxY, bounds.minZ],
    [bounds.minX, bounds.minY, bounds.maxZ],
    [bounds.maxX, bounds.minY, bounds.maxZ],
    [bounds.minX, bounds.maxY, bounds.maxZ],
    [bounds.maxX, bounds.maxY, bounds.maxZ],
  ];
}
