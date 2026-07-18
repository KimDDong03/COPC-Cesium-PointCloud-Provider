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
import type {
  CopcPointCloudGeometryBatchRenderer,
  PointGeometryBatch,
  PointGeometryBatchPositionBounds,
  PointSampleBatch,
} from "./CopcPointCloudRenderer";
import {
  type CesiumPointCloudEyeDomeLightingPrimitive,
  tryCreateCesiumPointCloudEyeDomeLightingPrimitive,
} from "./CesiumPointCloudEyeDomeLightingPrimitive";

const DEFAULT_POINT_COLOR: PointColor = {
  red: 0,
  green: 255,
  blue: 255,
  alpha: 255,
};
const DEFAULT_POINT_SIZE = 2;
const DEFAULT_POINT_SIZE_MODE = "fixed";
const DEFAULT_MINIMUM_POINT_SIZE = 1;
const DEFAULT_MAXIMUM_POINT_SIZE = 8;
const DEFAULT_ADAPTIVE_POINT_SIZE_SCALE = 1;
const DEFAULT_SPLAT_COVERAGE_SCALE = 1;
const DEFAULT_SPLAT_SAFETY_HALO_PIXELS = 0;
const DEFAULT_POINT_SPLAT_SHAPE = "screen-circle";
const DEFAULT_EYE_DOME_LIGHTING = false;
const DEFAULT_EYE_DOME_LIGHTING_STRENGTH = 1;
const DEFAULT_EYE_DOME_LIGHTING_RADIUS = 1;
const DEFAULT_MAX_BATCHES_PER_PRIMITIVE = 8;
const DEFAULT_MAX_GEOMETRY_BATCHES_PER_PRIMITIVE = 1;
const DEFAULT_MAX_POINTS_PER_PRIMITIVE = 240_000;

export interface CesiumPrimitivePointRendererOptions {
  /** Fixed point size in CSS pixels and the fallback used without spacing metadata. */
  readonly pointSize?: number;
  /** Enables projected world-space point sizing when set to `"adaptive"`. */
  readonly pointSizeMode?: "fixed" | "adaptive";
  /** Minimum adaptive point size in CSS pixels. */
  readonly minimumPointSize?: number;
  /** Maximum adaptive point size in CSS pixels. */
  readonly maximumPointSize?: number;
  /** Scale applied to projected point spacing before clamping. */
  readonly adaptivePointSizeScale?: number;
  /**
   * Extra footprint scale applied after sampling-density compensation.
   * Values above one deliberately overlap neighbouring splats to close small
   * screen-space holes without loading more source points.
   */
  readonly splatCoverageScale?: number;
  /**
   * Isotropic CSS-pixel padding added to each projected ground-ellipse axis.
   * This closes sub-pixel sampling gaps without changing the world-space
   * spacing estimate used for the base splat footprint.
   */
  readonly splatSafetyHaloPixels?: number;
  /**
   * `ground-ellipse` projects an ECEF-local tangent disc into screen space.
   * It preserves an approximately ground-aligned footprint under oblique
   * cameras instead of drawing every point as a screen-facing circle.
   */
  readonly pointSplatShape?: "screen-circle" | "ground-ellipse";
  /** Enables renderer-scoped eye-dome lighting when Cesium supports it. */
  readonly eyeDomeLighting?: boolean;
  /** EDL edge and slope contrast. */
  readonly eyeDomeLightingStrength?: number;
  /** EDL contour sampling radius in CSS pixels. */
  readonly eyeDomeLightingRadius?: number;
  readonly maxBatchesPerPrimitive?: number;
  readonly maxGeometryBatchesPerPrimitive?: number;
  readonly maxPointsPerPrimitive?: number;
}

interface PointBatchPrimitiveChunk {
  readonly key: string;
  readonly batches: readonly PointSampleBatch[];
  readonly pointCount: number;
}

interface PointGeometryBatchPrimitiveChunk {
  readonly key: string;
  readonly batches: readonly PointGeometryBatch[];
  readonly pointCount: number;
}

interface PointGeometryAttributes extends GeometryAttributes {
  pointSpacing?: GeometryAttribute;
}

/**
 * Cesium Primitive renderer backed by one typed-array Geometry per submitted point set.
 *
 * This path avoids creating one Cesium point object per COPC point. It still performs
 * coordinate conversion on the main thread, but submits positions/colors as compact
 * vertex attributes so the WebGL draw path is closer to the final library target.
 */
export class CesiumPrimitivePointRenderer
  implements CopcPointCloudGeometryBatchRenderer
{
  private readonly scene: Scene;
  private readonly pointSize: number;
  private readonly pointSizeMode: "fixed" | "adaptive";
  private readonly minimumPointSize: number;
  private readonly maximumPointSize: number;
  private readonly adaptivePointSizeScale: number;
  private readonly splatCoverageScale: number;
  private readonly splatSafetyHaloPixels: number;
  private readonly pointSplatShape: "screen-circle" | "ground-ellipse";
  private readonly maxBatchesPerPrimitive: number;
  private readonly maxGeometryBatchesPerPrimitive: number;
  private readonly maxPointsPerPrimitive: number;
  private readonly eyeDomeLightingPrimitive:
    | CesiumPointCloudEyeDomeLightingPrimitive
    | undefined;
  private readonly positionScratch = new Cartesian3();
  private primitive: Primitive | undefined;
  private readonly batchPrimitives = new Map<string, Primitive>();
  private eyeDomeLightingPrimitiveAdded = false;
  private destroyed = false;

  constructor(scene: Scene, options: CesiumPrimitivePointRendererOptions = {}) {
    this.scene = scene;
    this.pointSize = readPositiveNumber(
      options.pointSize,
      DEFAULT_POINT_SIZE,
      "pointSize",
    );
    this.pointSizeMode = readPointSizeMode(options.pointSizeMode);
    this.minimumPointSize = readPositiveNumber(
      options.minimumPointSize,
      DEFAULT_MINIMUM_POINT_SIZE,
      "minimumPointSize",
    );
    this.maximumPointSize = readPositiveNumber(
      options.maximumPointSize,
      DEFAULT_MAXIMUM_POINT_SIZE,
      "maximumPointSize",
    );
    if (this.minimumPointSize > this.maximumPointSize) {
      throw new Error(
        "minimumPointSize must be less than or equal to maximumPointSize.",
      );
    }
    this.adaptivePointSizeScale = readPositiveNumber(
      options.adaptivePointSizeScale,
      DEFAULT_ADAPTIVE_POINT_SIZE_SCALE,
      "adaptivePointSizeScale",
    );
    this.splatCoverageScale = readPositiveNumber(
      options.splatCoverageScale,
      DEFAULT_SPLAT_COVERAGE_SCALE,
      "splatCoverageScale",
    );
    this.splatSafetyHaloPixels = readNonNegativeNumber(
      options.splatSafetyHaloPixels,
      DEFAULT_SPLAT_SAFETY_HALO_PIXELS,
      "splatSafetyHaloPixels",
    );
    this.pointSplatShape = readPointSplatShape(options.pointSplatShape);
    if (
      this.pointSplatShape === "ground-ellipse" &&
      this.pointSizeMode !== "adaptive"
    ) {
      throw new Error(
        'pointSplatShape "ground-ellipse" requires pointSizeMode "adaptive".',
      );
    }
    this.maxBatchesPerPrimitive = readPositiveInteger(
      options.maxBatchesPerPrimitive,
      DEFAULT_MAX_BATCHES_PER_PRIMITIVE,
      "maxBatchesPerPrimitive",
    );
    this.maxGeometryBatchesPerPrimitive = readPositiveInteger(
      options.maxGeometryBatchesPerPrimitive ??
        options.maxBatchesPerPrimitive,
      DEFAULT_MAX_GEOMETRY_BATCHES_PER_PRIMITIVE,
      "maxGeometryBatchesPerPrimitive",
    );
    this.maxPointsPerPrimitive = readPositiveInteger(
      options.maxPointsPerPrimitive,
      DEFAULT_MAX_POINTS_PER_PRIMITIVE,
      "maxPointsPerPrimitive",
    );
    const eyeDomeLighting = readBoolean(
      options.eyeDomeLighting,
      DEFAULT_EYE_DOME_LIGHTING,
      "eyeDomeLighting",
    );
    const eyeDomeLightingStrength = readNonNegativeNumber(
      options.eyeDomeLightingStrength,
      DEFAULT_EYE_DOME_LIGHTING_STRENGTH,
      "eyeDomeLightingStrength",
    );
    const eyeDomeLightingRadius = readPositiveNumber(
      options.eyeDomeLightingRadius,
      DEFAULT_EYE_DOME_LIGHTING_RADIUS,
      "eyeDomeLightingRadius",
    );
    this.eyeDomeLightingPrimitive = eyeDomeLighting
      ? tryCreateCesiumPointCloudEyeDomeLightingPrimitive(scene, {
          strength: eyeDomeLightingStrength,
          radius: eyeDomeLightingRadius,
        })
      : undefined;
  }

  setPoints(points: readonly PointSample[]): void {
    this.assertNotDestroyed();
    this.removePrimitive();
    this.removeBatchPrimitives();

    if (points.length === 0) {
      return;
    }

    this.primitive = this.addPrimitive(points);
  }

  setPointBatches(batches: readonly PointSampleBatch[]): void {
    this.assertNotDestroyed();
    this.removePrimitive();

    const chunks = createPointBatchPrimitiveChunks(batches, {
      maxBatchesPerPrimitive: this.maxBatchesPerPrimitive,
      maxPointsPerPrimitive: this.maxPointsPerPrimitive,
    });
    const nextKeys = new Set(chunks.map((chunk) => chunk.key));
    for (const [key, primitive] of this.batchPrimitives) {
      if (!nextKeys.has(key)) {
        this.removePointPrimitive(primitive);
        this.batchPrimitives.delete(key);
      }
    }

    for (const chunk of chunks) {
      if (this.batchPrimitives.has(chunk.key)) {
        continue;
      }

      this.batchPrimitives.set(
        chunk.key,
        this.addPrimitive(flattenPointBatchPrimitiveChunk(chunk)),
      );
    }
  }

  setPointGeometryBatches(batches: readonly PointGeometryBatch[]): void {
    this.assertNotDestroyed();
    this.removePrimitive();

    const chunks = createPointGeometryBatchPrimitiveChunks(batches, {
      maxBatchesPerPrimitive: this.maxGeometryBatchesPerPrimitive,
      maxPointsPerPrimitive: this.maxPointsPerPrimitive,
      pointSizeMode: this.pointSizeMode,
    });
    const nextKeys = new Set(chunks.map((chunk) => chunk.key));
    for (const [key, primitive] of this.batchPrimitives) {
      if (!nextKeys.has(key)) {
        this.removePointPrimitive(primitive);
        this.batchPrimitives.delete(key);
      }
    }

    for (const chunk of chunks) {
      if (this.batchPrimitives.has(chunk.key)) {
        continue;
      }

      const flattened = flattenPointGeometryBatchPrimitiveChunk(
        chunk,
        this.pointSizeMode,
      );
      this.batchPrimitives.set(
        chunk.key,
        this.addPrimitiveFromGeometryAttributes(
          flattened.positions,
          flattened.colors,
          flattened.pointSpacing,
          flattened.pointSpacings,
          flattened.positionBounds,
          flattened.hasTranslucentColors,
        ),
      );
    }
  }

  clear(): void {
    if (this.destroyed) {
      return;
    }

    this.removePrimitive();
    this.removeBatchPrimitives();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.clear();
    this.destroyEyeDomeLightingPrimitive();
    this.destroyed = true;
  }

  private removePrimitive(): void {
    if (!this.primitive) {
      return;
    }

    this.removePointPrimitive(this.primitive);
    this.primitive = undefined;
  }

  private removeBatchPrimitives(): void {
    for (const primitive of this.batchPrimitives.values()) {
      this.removePointPrimitive(primitive);
    }

    this.batchPrimitives.clear();
  }

  private addPrimitive(points: readonly PointSample[]): Primitive {
    const { colors, positions } = createGeometryAttributes(
      points,
      this.positionScratch,
    );

    return this.addPrimitiveFromGeometryAttributes(positions, colors);
  }

  private addPrimitiveFromGeometryAttributes(
    positions: Float64Array,
    colors: Uint8Array,
    pointSpacing?: number,
    pointSpacings?: Float32Array,
    positionBounds?: PointGeometryBatchPositionBounds,
    hasTranslucentColors?: boolean,
  ): Primitive {
    const attributes = new GeometryAttributes() as PointGeometryAttributes;
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
    if (this.pointSizeMode === "adaptive" && pointSpacings !== undefined) {
      attributes.pointSpacing = new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 1,
        values: pointSpacings,
      });
    }
    const boundingSphere = positionBounds
      ? BoundingSphere.fromCornerPoints(
          new Cartesian3(
            positionBounds.minX,
            positionBounds.minY,
            positionBounds.minZ,
          ),
          new Cartesian3(
            positionBounds.maxX,
            positionBounds.maxY,
            positionBounds.maxZ,
          ),
        )
      : BoundingSphere.fromVertices(positions);
    const geometry = new Geometry({
      attributes,
      primitiveType: PrimitiveType.POINTS,
      boundingSphere,
    });

    const primitive = new Primitive({
      geometryInstances: new GeometryInstance({ geometry }),
      appearance: createPointAppearance({
        adaptivePointSizeScale: this.adaptivePointSizeScale,
        splatCoverageScale: this.splatCoverageScale,
        splatSafetyHaloPixels: this.splatSafetyHaloPixels,
        pointSplatShape: this.pointSplatShape,
        maximumPointSize: this.maximumPointSize,
        minimumPointSize: this.minimumPointSize,
        pointSize: this.pointSize,
        pointSizeMode: this.pointSizeMode,
        pointSpacing:
          this.pointSizeMode === "adaptive" && pointSpacings === undefined
            ? (pointSpacing ?? 0)
            : undefined,
        translucent:
          hasTranslucentColors ?? hasTranslucentPointColors(colors),
      }),
      asynchronous: false,
      allowPicking: false,
      compressVertices: false,
      releaseGeometryInstances: true,
    });

    return this.addPointPrimitive(primitive, boundingSphere);
  }

  private addPointPrimitive(
    primitive: Primitive,
    boundingSphere: BoundingSphere,
  ): Primitive {
    const eyeDomeLightingPrimitive = this.eyeDomeLightingPrimitive;
    if (!eyeDomeLightingPrimitive) {
      return this.scene.primitives.add(primitive) as Primitive;
    }

    if (!this.eyeDomeLightingPrimitiveAdded) {
      this.scene.primitives.add(eyeDomeLightingPrimitive);
      this.eyeDomeLightingPrimitiveAdded = true;
    }

    return eyeDomeLightingPrimitive.add(primitive, boundingSphere);
  }

  private removePointPrimitive(primitive: Primitive): void {
    if (this.eyeDomeLightingPrimitive) {
      this.eyeDomeLightingPrimitive.remove(primitive);
      return;
    }

    this.scene.primitives.remove(primitive);
  }

  private destroyEyeDomeLightingPrimitive(): void {
    const eyeDomeLightingPrimitive = this.eyeDomeLightingPrimitive;
    if (!eyeDomeLightingPrimitive) {
      return;
    }

    if (this.eyeDomeLightingPrimitiveAdded) {
      this.scene.primitives.remove(eyeDomeLightingPrimitive);
      this.eyeDomeLightingPrimitiveAdded = false;
    }

    if (!eyeDomeLightingPrimitive.isDestroyed()) {
      eyeDomeLightingPrimitive.destroy();
    }
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error("CesiumPrimitivePointRenderer has been destroyed.");
    }
  }
}

function createPointBatchPrimitiveChunks(
  batches: readonly PointSampleBatch[],
  options: {
    readonly maxBatchesPerPrimitive: number;
    readonly maxPointsPerPrimitive: number;
  },
): PointBatchPrimitiveChunk[] {
  const chunks: PointBatchPrimitiveChunk[] = [];
  let currentBatches: PointSampleBatch[] = [];
  let currentPointCount = 0;

  const pushCurrentChunk = (): void => {
    if (currentBatches.length === 0 || currentPointCount === 0) {
      return;
    }

    chunks.push({
      key: createPointBatchPrimitiveChunkKey(currentBatches),
      batches: currentBatches,
      pointCount: currentPointCount,
    });
    currentBatches = [];
    currentPointCount = 0;
  };

  for (const batch of batches) {
    if (batch.points.length === 0) {
      continue;
    }

    const exceedsBatchLimit =
      currentBatches.length >= options.maxBatchesPerPrimitive;
    const exceedsPointLimit =
      currentPointCount > 0 &&
      currentPointCount + batch.points.length > options.maxPointsPerPrimitive;

    if (exceedsBatchLimit || exceedsPointLimit) {
      pushCurrentChunk();
    }

    currentBatches.push(batch);
    currentPointCount += batch.points.length;
  }

  pushCurrentChunk();

  return chunks;
}

function createPointBatchPrimitiveChunkKey(
  batches: readonly PointSampleBatch[],
): string {
  return `points:${batches
    .map((batch) => `${batch.key}:${batch.points.length}`)
    .join("|")}`;
}

function flattenPointBatchPrimitiveChunk(
  chunk: PointBatchPrimitiveChunk,
): readonly PointSample[] {
  if (chunk.batches.length === 1) {
    return chunk.batches[0].points;
  }

  const points = new Array<PointSample>(chunk.pointCount);
  let offset = 0;

  for (const batch of chunk.batches) {
    for (let index = 0; index < batch.points.length; index += 1) {
      points[offset] = batch.points[index];
      offset += 1;
    }
  }

  return points;
}

function createPointGeometryBatchPrimitiveChunks(
  batches: readonly PointGeometryBatch[],
  options: {
    readonly maxBatchesPerPrimitive: number;
    readonly maxPointsPerPrimitive: number;
    readonly pointSizeMode: "fixed" | "adaptive";
  },
): PointGeometryBatchPrimitiveChunk[] {
  const chunks: PointGeometryBatchPrimitiveChunk[] = [];
  let currentBatches: PointGeometryBatch[] = [];
  let currentPointCount = 0;

  const pushCurrentChunk = (preserveIncompleteTail = false): void => {
    if (currentBatches.length === 0 || currentPointCount === 0) {
      return;
    }

    const isIncompleteTail =
      preserveIncompleteTail &&
      currentBatches.length < options.maxBatchesPerPrimitive &&
      currentPointCount < options.maxPointsPerPrimitive;

    if (isIncompleteTail) {
      for (const batch of currentBatches) {
        chunks.push({
          key: createPointGeometryBatchPrimitiveChunkKey(
            [batch],
            options.pointSizeMode,
          ),
          batches: [batch],
          pointCount: batch.pointCount,
        });
      }
    } else {
      chunks.push({
        key: createPointGeometryBatchPrimitiveChunkKey(
          currentBatches,
          options.pointSizeMode,
        ),
        batches: currentBatches,
        pointCount: currentPointCount,
      });
    }
    currentBatches = [];
    currentPointCount = 0;
  };

  for (const batch of batches) {
    if (batch.pointCount === 0) {
      continue;
    }

    const exceedsBatchLimit =
      currentBatches.length >= options.maxBatchesPerPrimitive;
    const exceedsPointLimit =
      currentPointCount > 0 &&
      currentPointCount + batch.pointCount > options.maxPointsPerPrimitive;

    if (exceedsBatchLimit || exceedsPointLimit) {
      pushCurrentChunk();
    }

    currentBatches.push(batch);
    currentPointCount += batch.pointCount;
  }

  // Keep an incomplete progressive tail as stable per-node primitives. Once
  // enough batches arrive to seal the chunk, they are merged exactly once
  // instead of rebuilding a growing 1 -> 2 -> 3 -> 4 batch buffer.
  pushCurrentChunk(true);

  return chunks;
}

function createPointGeometryBatchPrimitiveChunkKey(
  batches: readonly PointGeometryBatch[],
  pointSizeMode: "fixed" | "adaptive",
): string {
  return `geometry:${batches
    .map((batch) => {
      const baseKey = `${batch.key}:${batch.pointCount}`;
      if (pointSizeMode === "fixed") {
        return baseKey;
      }

      return `${baseKey}:${resolvePointGeometryBatchSpacing(batch)}`;
    })
    .join("|")}`;
}

function flattenPointGeometryBatchPrimitiveChunk(
  chunk: PointGeometryBatchPrimitiveChunk,
  pointSizeMode: "fixed" | "adaptive",
): {
  readonly positions: Float64Array;
  readonly colors: Uint8Array;
  readonly pointSpacing?: number;
  readonly pointSpacings?: Float32Array;
  readonly positionBounds?: PointGeometryBatchPositionBounds;
  readonly hasTranslucentColors?: boolean;
} {
  const resolvedPointSpacings =
    pointSizeMode === "adaptive"
      ? chunk.batches.map(resolvePointGeometryBatchSpacing)
      : undefined;
  const pointSpacing = resolvedPointSpacings
    ? findCommonFloatPointSpacing(resolvedPointSpacings)
    : undefined;

  if (chunk.batches.length === 1) {
    const batch = chunk.batches[0];

    return {
      positions: batch.positions,
      colors: batch.colors,
      pointSpacing,
      pointSpacings:
        resolvedPointSpacings !== undefined && pointSpacing === undefined
          ? createPointSpacingAttribute(
              batch.pointCount,
              resolvedPointSpacings[0],
            )
          : undefined,
      positionBounds: batch.positionBounds,
      hasTranslucentColors: batch.hasTranslucentColors,
    };
  }

  const positions = new Float64Array(chunk.pointCount * 3);
  const colors = new Uint8Array(chunk.pointCount * 4);
  const pointSpacings =
    resolvedPointSpacings !== undefined && pointSpacing === undefined
      ? new Float32Array(chunk.pointCount)
      : undefined;
  let pointOffset = 0;

  for (let batchIndex = 0; batchIndex < chunk.batches.length; batchIndex += 1) {
    const batch = chunk.batches[batchIndex];
    positions.set(batch.positions, pointOffset * 3);
    colors.set(batch.colors, pointOffset * 4);
    pointSpacings?.fill(
      resolvedPointSpacings?.[batchIndex] ?? 0,
      pointOffset,
      pointOffset + batch.pointCount,
    );
    pointOffset += batch.pointCount;
  }

  return {
    positions,
    colors,
    pointSpacing,
    pointSpacings,
    positionBounds: mergePointGeometryBatchPositionBounds(chunk.batches),
    hasTranslucentColors: resolvePointGeometryBatchTranslucency(chunk.batches),
  };
}

function mergePointGeometryBatchPositionBounds(
  batches: readonly PointGeometryBatch[],
): PointGeometryBatchPositionBounds | undefined {
  if (batches.some((batch) => batch.positionBounds === undefined)) {
    return undefined;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const batch of batches) {
    const bounds = batch.positionBounds!;
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    minZ = Math.min(minZ, bounds.minZ);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
    maxZ = Math.max(maxZ, bounds.maxZ);
  }

  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function resolvePointGeometryBatchTranslucency(
  batches: readonly PointGeometryBatch[],
): boolean | undefined {
  if (batches.some((batch) => batch.hasTranslucentColors === true)) {
    return true;
  }

  return batches.every((batch) => batch.hasTranslucentColors === false)
    ? false
    : undefined;
}

function createPointSpacingAttribute(
  pointCount: number,
  pointSpacing: number,
): Float32Array {
  const pointSpacings = new Float32Array(pointCount);
  pointSpacings.fill(pointSpacing);
  return pointSpacings;
}

function findCommonFloatPointSpacing(
  pointSpacings: readonly number[],
): number | undefined {
  const firstPointSpacing = Math.fround(pointSpacings[0] ?? 0);
  if (!Number.isFinite(firstPointSpacing)) {
    return undefined;
  }

  for (let index = 1; index < pointSpacings.length; index += 1) {
    const pointSpacing = Math.fround(pointSpacings[index]);
    if (!Object.is(pointSpacing, firstPointSpacing)) {
      return undefined;
    }
  }

  return firstPointSpacing;
}

function resolvePointGeometryBatchSpacing(
  batch: PointGeometryBatch,
): number {
  const spacing = readOptionalPositiveNumber(
    batch.pointSpacingMeters,
    "pointSpacingMeters",
  );
  const densityScale = readOptionalPositiveNumber(
    batch.pointDensityScale,
    "pointDensityScale",
  );

  if (spacing === undefined) {
    return 0;
  }

  return spacing / Math.sqrt(densityScale ?? 1);
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

function createPointAppearance(options: {
  readonly adaptivePointSizeScale: number;
  readonly splatCoverageScale: number;
  readonly splatSafetyHaloPixels: number;
  readonly pointSplatShape: "screen-circle" | "ground-ellipse";
  readonly maximumPointSize: number;
  readonly minimumPointSize: number;
  readonly pointSize: number;
  readonly pointSizeMode: "fixed" | "adaptive";
  readonly pointSpacing?: number;
  readonly translucent: boolean;
}): Appearance {
  const pointSizeLiteral = options.pointSize.toFixed(3);
  const pointSizeSource =
    options.pointSizeMode === "adaptive"
      ? createAdaptivePointSizeShaderSource(options)
      : options.splatCoverageScale === 1
        ? `    gl_PointSize = ${pointSizeLiteral} * czm_pixelRatio;`
        : `    gl_PointSize = ${pointSizeLiteral} * ${options.splatCoverageScale.toFixed(3)} * czm_pixelRatio;`;
  const usesGroundEllipse =
    options.pointSizeMode === "adaptive" &&
    options.pointSplatShape === "ground-ellipse";
  const pointSpacingDeclaration =
    options.pointSizeMode !== "adaptive"
      ? ""
      : options.pointSpacing === undefined
        ? "in float pointSpacing;"
        : `const float pointSpacing = ${formatShaderFloatLiteral(options.pointSpacing)};`;

  return new Appearance({
    translucent: options.translucent,
    vertexShaderSource: `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec4 color;
in float batchId;
${pointSpacingDeclaration}

out vec4 v_color;
  ${usesGroundEllipse ? "out vec2 v_splatEast;\nout vec2 v_splatNorth;\nout float v_splatMinimumAxis;\nout float v_splatSafetyHalo;" : ""}

void main()
{
    vec4 p = czm_computePosition();

    v_color = color;
    gl_Position = czm_modelViewProjectionRelativeToEye * p;
${pointSizeSource}
}
`,
    fragmentShaderSource: `
in vec4 v_color;
  ${usesGroundEllipse ? "in vec2 v_splatEast;\nin vec2 v_splatNorth;\nin float v_splatMinimumAxis;\nin float v_splatSafetyHalo;" : ""}

void main()
{
    vec2 pointCenterOffset = (gl_PointCoord - vec2(0.5)) * 2.0;
${
  usesGroundEllipse
    ? `    float splatCovarianceXX =
        v_splatEast.x * v_splatEast.x +
        v_splatNorth.x * v_splatNorth.x;
    float splatCovarianceXY =
        v_splatEast.x * v_splatEast.y +
        v_splatNorth.x * v_splatNorth.y;
    float splatCovarianceYY =
        v_splatEast.y * v_splatEast.y +
        v_splatNorth.y * v_splatNorth.y;
    float splatTrace = splatCovarianceXX + splatCovarianceYY;
    float splatDiscriminant = sqrt(max(
        (splatCovarianceXX - splatCovarianceYY) *
            (splatCovarianceXX - splatCovarianceYY) +
            4.0 * splatCovarianceXY * splatCovarianceXY,
        0.0
    ));
    float splatMajorVariance = max(
        0.5 * (splatTrace + splatDiscriminant),
        0.0
    );
    float splatMinorVariance = max(
        0.5 * (splatTrace - splatDiscriminant),
        0.0
    );
    vec2 splatMajorDirection;
    if (abs(splatCovarianceXY) > 0.000001)
    {
        splatMajorDirection = normalize(vec2(
            splatMajorVariance - splatCovarianceYY,
            splatCovarianceXY
        ));
    }
    else
    {
        splatMajorDirection =
            splatCovarianceXX >= splatCovarianceYY
                ? vec2(1.0, 0.0)
                : vec2(0.0, 1.0);
    }
    vec2 splatMinorDirection = vec2(
        -splatMajorDirection.y,
        splatMajorDirection.x
    );
    float minimumVariance =
        v_splatMinimumAxis * v_splatMinimumAxis;
    float splatMajorRadius = sqrt(max(
        splatMajorVariance,
        minimumVariance
    )) + v_splatSafetyHalo;
    float splatMinorRadius = sqrt(max(
        splatMinorVariance,
        minimumVariance
    )) + v_splatSafetyHalo;
    vec2 splatCoordinate = vec2(
        dot(pointCenterOffset, splatMajorDirection) / splatMajorRadius,
        dot(pointCenterOffset, splatMinorDirection) / splatMinorRadius
    );
`
    : "    vec2 splatCoordinate = pointCenterOffset;\n"
}    if (dot(splatCoordinate, splatCoordinate) > 1.0)
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
      depthMask: !options.translucent,
    },
  });
}

function formatShaderFloatLiteral(value: number): string {
  const floatValue = Math.fround(value);
  const source = String(Object.is(floatValue, -0) ? 0 : floatValue);
  return /[.eE]/.test(source) ? source : `${source}.0`;
}

function createAdaptivePointSizeShaderSource(options: {
  readonly adaptivePointSizeScale: number;
  readonly splatCoverageScale: number;
  readonly splatSafetyHaloPixels: number;
  readonly pointSplatShape: "screen-circle" | "ground-ellipse";
  readonly maximumPointSize: number;
  readonly minimumPointSize: number;
  readonly pointSize: number;
}): string {
  const pointSizeLiteral = options.pointSize.toFixed(3);
  const minimumPointSizeLiteral = options.minimumPointSize.toFixed(3);
  const maximumPointSizeLiteral = options.maximumPointSize.toFixed(3);
  const scaleLiteral = options.adaptivePointSizeScale.toFixed(3);
  const coverageScaleLiteral = options.splatCoverageScale.toFixed(3);

  if (options.pointSplatShape === "ground-ellipse") {
    return createGroundEllipsePointSizeShaderSource({
      coverageScaleLiteral,
      maximumPointSizeLiteral,
      minimumPointSizeLiteral,
      pointSizeLiteral,
      scaleLiteral,
      splatSafetyHaloPixelsLiteral:
        options.splatSafetyHaloPixels.toFixed(3),
    });
  }

  return `    float pointSize = ${pointSizeLiteral};
    if (pointSpacing > 0.0)
    {
        vec4 positionEC = czm_modelViewRelativeToEye * p;
        float viewportHeight = max(czm_viewport.w / czm_pixelRatio, 1.0);
        float verticalProjectionScale =
            abs(czm_projection[1][1]) * viewportHeight * 0.5;
        float projectionDivisor =
            abs(czm_projection[3][3]) < 0.5
                ? max(-positionEC.z, 0.001)
                : 1.0;
        float projectedSpacing =
            pointSpacing * verticalProjectionScale / projectionDivisor;
        pointSize = clamp(
            projectedSpacing * ${scaleLiteral} * ${coverageScaleLiteral},
            ${minimumPointSizeLiteral},
            ${maximumPointSizeLiteral}
        );
    }
    gl_PointSize = pointSize * czm_pixelRatio;`;
}

function createGroundEllipsePointSizeShaderSource(options: {
  readonly coverageScaleLiteral: string;
  readonly maximumPointSizeLiteral: string;
  readonly minimumPointSizeLiteral: string;
  readonly pointSizeLiteral: string;
  readonly scaleLiteral: string;
  readonly splatSafetyHaloPixelsLiteral: string;
}): string {
  return `    float basePointSize = ${options.pointSizeLiteral};
    float splatSafetyHaloPixels = ${options.splatSafetyHaloPixelsLiteral};
    float pointSize = basePointSize + 2.0 * splatSafetyHaloPixels;
    float halfPointSize = max(pointSize * 0.5, 0.000001);
    float fallbackRadius = basePointSize * 0.5 / halfPointSize;
    v_splatEast = vec2(fallbackRadius, 0.0);
    v_splatNorth = vec2(0.0, fallbackRadius);
    v_splatMinimumAxis = min(
        1.0,
        1.0 / max(pointSize, 1.0)
    );
    v_splatSafetyHalo = min(
        1.0,
        splatSafetyHaloPixels / halfPointSize
    );
    if (pointSpacing > 0.0)
    {
        vec4 positionEC = czm_modelViewRelativeToEye * p;
        vec3 positionWC = position3DHigh + position3DLow;
        vec3 groundUp = normalize(positionWC);
        vec3 groundEast = cross(vec3(0.0, 0.0, 1.0), groundUp);
        if (dot(groundEast, groundEast) < 0.000001)
        {
            groundEast = vec3(1.0, 0.0, 0.0);
        }
        else
        {
            groundEast = normalize(groundEast);
        }
        vec3 groundNorth = normalize(cross(groundUp, groundEast));
        float splatRadiusMeters =
            pointSpacing * ${options.scaleLiteral} *
            ${options.coverageScaleLiteral} * 0.5;
        vec4 centerClip = czm_projection * positionEC;
        vec4 eastClip = czm_projection *
            (positionEC + czm_modelView * vec4(
                groundEast * splatRadiusMeters,
                0.0
            ));
        vec4 northClip = czm_projection *
            (positionEC + czm_modelView * vec4(
                groundNorth * splatRadiusMeters,
                0.0
            ));
        vec2 centerNdc = centerClip.xy / max(abs(centerClip.w), 0.000001);
        vec2 viewportSize = max(
            czm_viewport.zw / czm_pixelRatio,
            vec2(1.0)
        );
        vec2 eastPixels =
            (eastClip.xy / max(abs(eastClip.w), 0.000001) - centerNdc) *
            viewportSize * 0.5;
        vec2 northPixels =
            (northClip.xy / max(abs(northClip.w), 0.000001) - centerNdc) *
            viewportSize * 0.5;
        float splatCovarianceXX =
            eastPixels.x * eastPixels.x +
            northPixels.x * northPixels.x;
        float splatCovarianceYY =
            eastPixels.y * eastPixels.y +
            northPixels.y * northPixels.y;
        float projectedDiameter = 2.0 * sqrt(max(
            max(splatCovarianceXX, splatCovarianceYY),
            0.0
        ));
        basePointSize = clamp(
            projectedDiameter,
            ${options.minimumPointSizeLiteral},
            ${options.maximumPointSizeLiteral}
        );
        pointSize = basePointSize + 2.0 * splatSafetyHaloPixels;
        float footprintScale =
            basePointSize / max(projectedDiameter, 0.000001);
        halfPointSize = max(pointSize * 0.5, 0.000001);
        v_splatEast = eastPixels * footprintScale / halfPointSize;
        v_splatNorth = northPixels * footprintScale / halfPointSize;
        v_splatMinimumAxis = min(
            1.0,
            1.0 / max(pointSize, 1.0)
        );
        v_splatSafetyHalo = min(
            1.0,
            splatSafetyHaloPixels / halfPointSize
        );
    }
    gl_PointSize = pointSize * czm_pixelRatio;`;
}

function hasTranslucentPointColors(colors: Uint8Array): boolean {
  for (let alphaIndex = 3; alphaIndex < colors.length; alphaIndex += 4) {
    if (colors[alphaIndex] < 255) {
      return true;
    }
  }

  return false;
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

function readOptionalPositiveNumber(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
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

function readBoolean(
  value: boolean | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }

  return value;
}

function readPointSizeMode(
  value: CesiumPrimitivePointRendererOptions["pointSizeMode"],
): "fixed" | "adaptive" {
  if (value === undefined) {
    return DEFAULT_POINT_SIZE_MODE;
  }

  if (value !== "fixed" && value !== "adaptive") {
    throw new Error('pointSizeMode must be either "fixed" or "adaptive".');
  }

  return value;
}

function readPointSplatShape(
  value: CesiumPrimitivePointRendererOptions["pointSplatShape"],
): "screen-circle" | "ground-ellipse" {
  if (
    value === undefined ||
    value === "screen-circle" ||
    value === "ground-ellipse"
  ) {
    return value ?? DEFAULT_POINT_SPLAT_SHAPE;
  }

  throw new Error(
    'pointSplatShape must be either "screen-circle" or "ground-ellipse".',
  );
}

function readPositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}
