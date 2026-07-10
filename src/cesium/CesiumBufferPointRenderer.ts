import {
  BufferPoint,
  BufferPointCollection,
  BufferPointMaterial,
  Cartesian3,
  Color,
  type Scene,
} from "cesium";
import type { PointColor, PointSample } from "../core/PointSample";
import type { CopcPointCloudRenderer } from "./CopcPointCloudRenderer";

const DEFAULT_POINT_COLOR = Color.CYAN;
const DEFAULT_POINT_SIZE = 3;
const DEFAULT_OUTLINE_WIDTH = 0;

export interface CesiumBufferPointRendererOptions {
  readonly pointSize?: number;
  readonly outlineColor?: Color;
  readonly outlineWidth?: number;
}

/**
 * Experimental GPU-buffer point renderer backed by Cesium BufferPointCollection.
 *
 * BufferPointCollection is a Cesium-native primitive path, but Cesium currently
 * marks it experimental. The library keeps this backend available for explicit
 * comparisons while the typed-array `CesiumPrimitivePointRenderer` remains the
 * default and the stable point-primitive renderer remains a fallback.
 */
export class CesiumBufferPointRenderer implements CopcPointCloudRenderer {
  private readonly scene: Scene;
  private readonly pointSize: number;
  private readonly outlineColor: Color;
  private readonly outlineWidth: number;
  private readonly pointScratch = new BufferPoint();
  private readonly positionScratch = new Cartesian3();
  private readonly materialCache = new Map<string, BufferPointMaterial>();
  private collection: BufferPointCollection | undefined;
  private destroyed = false;

  constructor(scene: Scene, options: CesiumBufferPointRendererOptions = {}) {
    this.scene = scene;
    this.pointSize = readPositiveNumber(
      options.pointSize,
      DEFAULT_POINT_SIZE,
      "pointSize",
    );
    this.outlineColor = options.outlineColor ?? Color.BLACK;
    this.outlineWidth = readNonNegativeNumber(
      options.outlineWidth,
      DEFAULT_OUTLINE_WIDTH,
      "outlineWidth",
    );
  }

  setPoints(points: readonly PointSample[]): void {
    this.assertNotDestroyed();
    this.removeCollection();

    if (points.length === 0) {
      return;
    }

    const collection = new BufferPointCollection({
      primitiveCountMax: points.length,
      allowPicking: false,
    });

    for (const point of points) {
      const position = Cartesian3.fromDegrees(
        point.longitudeDegrees,
        point.latitudeDegrees,
        point.heightMeters,
        undefined,
        this.positionScratch,
      );

      collection.add(
        {
          position,
          material: this.getMaterial(point.color),
        },
        this.pointScratch,
      );
    }

    this.collection = this.scene.primitives.add(collection);
  }

  clear(): void {
    if (this.destroyed) {
      return;
    }

    this.removeCollection();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.clear();
    this.destroyed = true;
  }

  private getMaterial(color: PointColor | undefined): BufferPointMaterial {
    const cacheKey = color
      ? `${color.red},${color.green},${color.blue},${color.alpha ?? 255}`
      : "default";
    const cachedMaterial = this.materialCache.get(cacheKey);

    if (cachedMaterial) {
      return cachedMaterial;
    }

    const material = new BufferPointMaterial({
      color: color ? toCesiumColor(color) : DEFAULT_POINT_COLOR,
      outlineColor: this.outlineColor,
      outlineWidth: this.outlineWidth,
      size: this.pointSize,
    });
    this.materialCache.set(cacheKey, material);
    return material;
  }

  private removeCollection(): void {
    if (!this.collection) {
      return;
    }

    this.scene.primitives.remove(this.collection);
    this.collection = undefined;
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error("CesiumBufferPointRenderer has been destroyed.");
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

function readPositiveNumber(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return value;
}

function readNonNegativeNumber(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }

  return value;
}
