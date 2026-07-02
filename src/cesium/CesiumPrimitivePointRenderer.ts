import {
  Appearance,
  BoundingSphere,
  Cartesian3,
  ComponentDatatype,
  Geometry,
  GeometryAttribute,
  GeometryAttributes,
  GeometryInstance,
  Primitive,
  PrimitiveType,
  type Scene,
} from "cesium";
import type { PointColor, PointSample } from "../core/PointSample";
import type { CopcPointCloudRenderer } from "./CopcPointCloudRenderer";

const DEFAULT_POINT_COLOR: PointColor = {
  red: 0,
  green: 255,
  blue: 255,
  alpha: 255,
};
const DEFAULT_POINT_SIZE = 2;

export interface CesiumPrimitivePointRendererOptions {
  readonly pointSize?: number;
}

/**
 * Cesium Primitive renderer backed by one typed-array Geometry per submitted point set.
 *
 * This path avoids creating one Cesium point object per COPC point. It still performs
 * coordinate conversion on the main thread, but submits positions/colors as compact
 * vertex attributes so the WebGL draw path is closer to the final library target.
 */
export class CesiumPrimitivePointRenderer implements CopcPointCloudRenderer {
  private readonly scene: Scene;
  private readonly pointSize: number;
  private readonly positionScratch = new Cartesian3();
  private primitive: Primitive | undefined;
  private destroyed = false;

  constructor(scene: Scene, options: CesiumPrimitivePointRendererOptions = {}) {
    this.scene = scene;
    this.pointSize = readPositiveNumber(
      options.pointSize,
      DEFAULT_POINT_SIZE,
      "pointSize",
    );
  }

  setPoints(points: readonly PointSample[]): void {
    this.assertNotDestroyed();
    this.removePrimitive();

    if (points.length === 0) {
      return;
    }

    const { colors, positions } = createGeometryAttributes(
      points,
      this.positionScratch,
    );
    const attributes = new GeometryAttributes();
    attributes.position = new GeometryAttribute({
      componentDatatype: ComponentDatatype.DOUBLE,
      componentsPerAttribute: 3,
      values: positions,
    });
    attributes.color = new GeometryAttribute({
      componentDatatype: ComponentDatatype.UNSIGNED_BYTE,
      componentsPerAttribute: 4,
      normalize: true,
      values: colors,
    });
    const geometry = new Geometry({
      attributes,
      primitiveType: PrimitiveType.POINTS,
      boundingSphere: BoundingSphere.fromVertices(positions),
    });

    this.primitive = this.scene.primitives.add(
      new Primitive({
        geometryInstances: new GeometryInstance({ geometry }),
        appearance: createPointAppearance(this.pointSize),
        asynchronous: false,
        allowPicking: false,
        compressVertices: false,
        releaseGeometryInstances: true,
      }),
    );
  }

  clear(): void {
    if (this.destroyed) {
      return;
    }

    this.removePrimitive();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.clear();
    this.destroyed = true;
  }

  private removePrimitive(): void {
    if (!this.primitive) {
      return;
    }

    this.scene.primitives.remove(this.primitive);
    this.primitive = undefined;
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error("CesiumPrimitivePointRenderer has been destroyed.");
    }
  }
}

function createGeometryAttributes(
  points: readonly PointSample[],
  positionScratch: Cartesian3,
): {
  readonly positions: Float64Array;
  readonly colors: Uint8Array;
} {
  const positions = new Float64Array(points.length * 3);
  const colors = new Uint8Array(points.length * 4);

  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const point = points[pointIndex];
    const position = Cartesian3.fromDegrees(
      point.longitudeDegrees,
      point.latitudeDegrees,
      point.heightMeters,
      undefined,
      positionScratch,
    );
    const positionOffset = pointIndex * 3;
    const colorOffset = pointIndex * 4;
    const color = point.color ?? DEFAULT_POINT_COLOR;

    positions[positionOffset] = position.x;
    positions[positionOffset + 1] = position.y;
    positions[positionOffset + 2] = position.z;
    colors[colorOffset] = color.red;
    colors[colorOffset + 1] = color.green;
    colors[colorOffset + 2] = color.blue;
    colors[colorOffset + 3] = color.alpha ?? 255;
  }

  return { positions, colors };
}

function createPointAppearance(pointSize: number): Appearance {
  const pointSizeLiteral = pointSize.toFixed(3);

  return new Appearance({
    translucent: true,
    vertexShaderSource: `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec4 color;
in float batchId;

out vec4 v_color;

void main()
{
    vec4 p = czm_computePosition();

    v_color = color;
    gl_Position = czm_modelViewProjectionRelativeToEye * p;
    gl_PointSize = ${pointSizeLiteral} * czm_pixelRatio;
}
`,
    fragmentShaderSource: `
in vec4 v_color;

void main()
{
    vec2 pointCenterOffset = gl_PointCoord - vec2(0.5);
    if (dot(pointCenterOffset, pointCenterOffset) > 0.25)
    {
        discard;
    }

    out_FragColor = czm_gammaCorrect(v_color);
}
`,
    renderState: {
      depthTest: {
        enabled: true,
      },
      depthMask: false,
    },
  });
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
