import {
  Cartesian3,
  Color,
  PointPrimitiveCollection,
  type Scene,
} from "cesium";
import type { PointColor, PointSample } from "../core/PointSample";
import type { CopcPointCloudRenderer } from "./CopcPointCloudRenderer";

const DEFAULT_POINT_COLOR = Color.CYAN;
const DEFAULT_PIXEL_SIZE = 12;

export class CesiumPointRenderer implements CopcPointCloudRenderer {
  private readonly scene: Scene;
  private readonly collection: PointPrimitiveCollection;
  private destroyed = false;

  constructor(scene: Scene) {
    this.scene = scene;
    this.collection = scene.primitives.add(new PointPrimitiveCollection());
  }

  setPoints(points: readonly PointSample[]): void {
    this.assertNotDestroyed();
    this.clear();

    for (const point of points) {
      this.collection.add({
        position: Cartesian3.fromDegrees(
          point.longitudeDegrees,
          point.latitudeDegrees,
          point.heightMeters,
        ),
        color: point.color
          ? toCesiumColor(point.color)
          : DEFAULT_POINT_COLOR,
        pixelSize: DEFAULT_PIXEL_SIZE,
        outlineColor: Color.BLACK,
        outlineWidth: 1,
      });
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

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error("CesiumPointRenderer has been destroyed.");
    }
  }
}

function toCesiumColor(color: PointColor): Color {
  return Color.fromBytes(
    color.red,
    color.green,
    color.blue,
    color.alpha ?? 255,
  );
}
