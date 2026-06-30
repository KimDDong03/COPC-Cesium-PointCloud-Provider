import {
  Cartesian3,
  Color,
  Material,
  PolylineCollection,
  type Scene,
} from "cesium";
import type { CopcBounds, CopcInspection } from "../core/copc/CopcInspection";
import {
  createCopcCoordinateTransform,
  type CopcToCesiumCoordinateTransform,
} from "./copcCoordinateTransform";

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
  private readonly scene: Scene;
  private readonly collection: PolylineCollection;
  private destroyed = false;

  constructor(scene: Scene) {
    this.scene = scene;
    this.collection = scene.primitives.add(new PolylineCollection());
  }

  setBounds(
    bounds: CopcBounds,
    inspection: CopcInspection,
    coordinateTransform?: CopcToCesiumCoordinateTransform,
  ): void {
    this.setBoundsList([bounds], inspection, coordinateTransform);
  }

  setBoundsList(
    boundsList: readonly CopcBounds[],
    inspection: CopcInspection,
    coordinateTransform?: CopcToCesiumCoordinateTransform,
  ): void {
    this.assertNotDestroyed();
    this.clear();

    const transform =
      coordinateTransform ?? createCopcCoordinateTransform(inspection);
    for (const bounds of boundsList) {
      this.addBounds(bounds, transform);
    }
  }

  clear(): void {
    if (this.destroyed) {
      return;
    }

    this.collection.removeAll();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.clear();
    this.scene.primitives.remove(this.collection);
    this.destroyed = true;
  }

  private addBounds(
    bounds: CopcBounds,
    transform: CopcToCesiumCoordinateTransform,
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

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error("CesiumBoundsRenderer has been destroyed.");
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
