import type { Geometry, GeometryAttribute, Primitive, Scene } from "cesium";
import { describe, expect, it } from "vitest";
import type { PointGeometryBatch } from "./CopcPointCloudRenderer";
import { CesiumPrimitivePointRenderer } from "./CesiumPrimitivePointRenderer";

describe("CesiumPrimitivePointRenderer adaptive point sizing", () => {
  it("keeps fixed point sizing as the default without an extra attribute", () => {
    const { addedPrimitives, scene } = createSceneStub();
    const renderer = new CesiumPrimitivePointRenderer(scene);

    renderer.setPointGeometryBatches([createPointGeometryBatch()]);

    const primitive = addedPrimitives[0] as Primitive;
    const vertexShaderSource = primitive.appearance.vertexShaderSource;
    const geometry = getPrimitiveGeometry(primitive);

    expect(vertexShaderSource).toContain(
      "gl_PointSize = 2.000 * czm_pixelRatio;",
    );
    expect(vertexShaderSource).not.toContain("in float pointSpacing;");
    expect(getPointSpacingAttribute(geometry)).toBeUndefined();
  });

  it("projects effective batch spacing in adaptive mode", () => {
    const { addedPrimitives, scene } = createSceneStub();
    const renderer = new CesiumPrimitivePointRenderer(scene, {
      pointSize: 2,
      pointSizeMode: "adaptive",
      minimumPointSize: 1.5,
      maximumPointSize: 7,
      adaptivePointSizeScale: 1.25,
    });

    renderer.setPointGeometryBatches([
      createPointGeometryBatch({
        pointSpacingMeters: 4,
        pointDensityScale: 0.25,
      }),
    ]);

    const primitive = addedPrimitives[0] as Primitive;
    const vertexShaderSource = primitive.appearance.vertexShaderSource;
    const geometry = getPrimitiveGeometry(primitive);
    const pointSpacing = getPointSpacingAttribute(geometry);

    expect(pointSpacing).toBeUndefined();
    expect(vertexShaderSource).toContain(
      "const float pointSpacing = 8.0;",
    );
    expect(vertexShaderSource).not.toContain("in float pointSpacing;");
    expect(vertexShaderSource).toContain(
      "vec4 positionEC = czm_modelViewRelativeToEye * p;",
    );
    expect(vertexShaderSource).toContain("czm_projection[1][1]");
    expect(vertexShaderSource).toContain("projectedSpacing * 1.250");
    expect(vertexShaderSource).toContain("* 1.000");
    expect(vertexShaderSource).toContain("1.500");
    expect(vertexShaderSource).toContain("7.000");
  });

  it("projects a ground-aligned ellipse with an explicit coverage overlap", () => {
    const { addedPrimitives, scene } = createSceneStub();
    const renderer = new CesiumPrimitivePointRenderer(scene, {
      pointSizeMode: "adaptive",
      pointSplatShape: "ground-ellipse",
      splatCoverageScale: 1.2,
      splatSafetyHaloPixels: 1,
      minimumPointSize: 1,
      maximumPointSize: 6,
    });

    renderer.setPointGeometryBatches([
      createPointGeometryBatch({
        pointSpacingMeters: 4,
        pointDensityScale: 0.25,
      }),
    ]);

    const primitive = addedPrimitives[0] as Primitive;
    const vertexShaderSource = primitive.appearance.vertexShaderSource;
    const fragmentShaderSource = primitive.appearance.fragmentShaderSource;

    expect(vertexShaderSource).toContain("out vec2 v_splatEast;");
    expect(vertexShaderSource).toContain(
      "pointSpacing * 1.000 *\n            1.200 * 0.5",
    );
    expect(vertexShaderSource).toContain("groundEast");
    expect(vertexShaderSource).toContain("groundNorth");
    expect(vertexShaderSource).toContain("projectedDiameter");
    expect(vertexShaderSource).toContain("czm_viewport.zw / czm_pixelRatio");
    expect(vertexShaderSource).toContain(
      "float splatSafetyHaloPixels = 1.000;",
    );
    expect(vertexShaderSource).toContain("float splatCovarianceXX");
    expect(vertexShaderSource).toContain("float splatCovarianceYY");
    expect(vertexShaderSource).toContain(
      "max(splatCovarianceXX, splatCovarianceYY)",
    );
    expect(vertexShaderSource).not.toContain("length(eastPixels)");
    expect(vertexShaderSource).toContain(
      "pointSize = basePointSize + 2.0 * splatSafetyHaloPixels",
    );
    expect(vertexShaderSource).toContain(
      "basePointSize / max(projectedDiameter, 0.000001)",
    );
    expect(vertexShaderSource).toContain("v_splatMinimumAxis");
    expect(vertexShaderSource).toContain("v_splatSafetyHalo");
    expect(fragmentShaderSource).toContain("splatMinorVariance");
    expect(fragmentShaderSource).toContain("minimumVariance");
    expect(fragmentShaderSource).toContain(
      ")) + v_splatSafetyHalo;",
    );
    expect(fragmentShaderSource).not.toContain("splatDeterminant");
    expect(fragmentShaderSource).toContain(
      "dot(splatCoordinate, splatCoordinate) > 1.0",
    );
  });

  it("keeps the legacy screen-circle shader unless ground ellipses are requested", () => {
    const { addedPrimitives, scene } = createSceneStub();
    const renderer = new CesiumPrimitivePointRenderer(scene, {
      pointSizeMode: "adaptive",
      splatCoverageScale: 1.15,
    });

    renderer.setPointGeometryBatches([
      createPointGeometryBatch({ pointSpacingMeters: 2 }),
    ]);

    const primitive = addedPrimitives[0] as Primitive;

    expect(primitive.appearance.vertexShaderSource).toContain(
      "projectedSpacing * 1.000 * 1.150",
    );
    expect(primitive.appearance.vertexShaderSource).not.toContain(
      "v_splatEast",
    );
    expect(primitive.appearance.fragmentShaderSource).not.toContain(
      "splatDeterminant",
    );
  });

  it("uses zero spacing to select the fixed shader fallback without metadata", () => {
    const { addedPrimitives, scene } = createSceneStub();
    const renderer = new CesiumPrimitivePointRenderer(scene, {
      pointSize: 3,
      pointSizeMode: "adaptive",
    });

    renderer.setPointGeometryBatches([createPointGeometryBatch()]);

    const primitive = addedPrimitives[0] as Primitive;
    const geometry = getPrimitiveGeometry(primitive);
    const pointSpacing = getPointSpacingAttribute(geometry);

    expect(pointSpacing).toBeUndefined();
    expect(primitive.appearance.vertexShaderSource).toContain(
      "const float pointSpacing = 0.0;",
    );
    expect(primitive.appearance.vertexShaderSource).toContain(
      "float pointSize = 3.000;",
    );
  });

  it("uses one shader constant when merged batches have the same effective spacing", () => {
    const { addedPrimitives, scene } = createSceneStub();
    const renderer = new CesiumPrimitivePointRenderer(scene, {
      pointSizeMode: "adaptive",
      maxGeometryBatchesPerPrimitive: 2,
    });

    renderer.setPointGeometryBatches([
      {
        ...createPointGeometryBatch({
          pointSpacingMeters: 4,
          pointDensityScale: 0.25,
        }),
        key: "0-0-0-0:2",
      },
      {
        ...createPointGeometryBatch({
          pointSpacingMeters: 8,
          pointDensityScale: 1,
        }),
        key: "1-0-0-0:2",
      },
    ]);

    const primitive = addedPrimitives[0] as Primitive;
    const geometry = getPrimitiveGeometry(primitive);

    expect(getPointSpacingAttribute(geometry)).toBeUndefined();
    expect(primitive.appearance.vertexShaderSource).toContain(
      "const float pointSpacing = 8.0;",
    );
    expect(primitive.appearance.vertexShaderSource).not.toContain(
      "in float pointSpacing;",
    );
  });

  it("keeps the per-vertex spacing attribute for mixed-spacing merged batches", () => {
    const { addedPrimitives, scene } = createSceneStub();
    const renderer = new CesiumPrimitivePointRenderer(scene, {
      pointSizeMode: "adaptive",
      maxGeometryBatchesPerPrimitive: 2,
    });

    renderer.setPointGeometryBatches([
      {
        ...createPointGeometryBatch({ pointSpacingMeters: 2 }),
        key: "0-0-0-0:2",
      },
      {
        ...createPointGeometryBatch({ pointSpacingMeters: 4 }),
        key: "1-0-0-0:2",
      },
    ]);

    const primitive = addedPrimitives[0] as Primitive;
    const geometry = getPrimitiveGeometry(primitive);
    const pointSpacing = getPointSpacingAttribute(geometry);

    expect(pointSpacing?.values).toEqual(new Float32Array([2, 2, 4, 4]));
    expect(primitive.appearance.vertexShaderSource).toContain(
      "in float pointSpacing;",
    );
    expect(primitive.appearance.vertexShaderSource).not.toContain(
      "const float pointSpacing =",
    );
  });

  it("validates adaptive options and batch metadata", () => {
    const { scene } = createSceneStub();

    expect(
      () =>
        new CesiumPrimitivePointRenderer(scene, {
          pointSizeMode: "invalid" as "adaptive",
        }),
    ).toThrow('pointSizeMode must be either "fixed" or "adaptive".');
    expect(
      () =>
        new CesiumPrimitivePointRenderer(scene, {
          minimumPointSize: 4,
          maximumPointSize: 2,
        }),
    ).toThrow(
      "minimumPointSize must be less than or equal to maximumPointSize.",
    );
    expect(
      () =>
        new CesiumPrimitivePointRenderer(scene, {
          adaptivePointSizeScale: 0,
        }),
    ).toThrow("adaptivePointSizeScale must be a positive number.");
    expect(
      () =>
        new CesiumPrimitivePointRenderer(scene, {
          splatCoverageScale: 0,
        }),
    ).toThrow("splatCoverageScale must be a positive number.");
    expect(
      () =>
        new CesiumPrimitivePointRenderer(scene, {
          splatSafetyHaloPixels: -1,
        }),
    ).toThrow("splatSafetyHaloPixels must be a non-negative number.");
    expect(
      () =>
        new CesiumPrimitivePointRenderer(scene, {
          splatSafetyHaloPixels: Number.NaN,
        }),
    ).toThrow("splatSafetyHaloPixels must be a non-negative number.");
    expect(
      () =>
        new CesiumPrimitivePointRenderer(scene, {
          splatSafetyHaloPixels: 0,
        }),
    ).not.toThrow();
    expect(
      () =>
        new CesiumPrimitivePointRenderer(scene, {
          pointSplatShape: "invalid" as "ground-ellipse",
        }),
    ).toThrow(
      'pointSplatShape must be either "screen-circle" or "ground-ellipse".',
    );
    expect(
      () =>
        new CesiumPrimitivePointRenderer(scene, {
          pointSplatShape: "ground-ellipse",
        }),
    ).toThrow(
      'pointSplatShape "ground-ellipse" requires pointSizeMode "adaptive".',
    );
    expect(
      () =>
        new CesiumPrimitivePointRenderer(scene, {
          eyeDomeLighting: "yes" as unknown as boolean,
        }),
    ).toThrow("eyeDomeLighting must be a boolean.");
    expect(
      () =>
        new CesiumPrimitivePointRenderer(scene, {
          eyeDomeLightingStrength: -1,
        }),
    ).toThrow("eyeDomeLightingStrength must be a non-negative number.");
    expect(
      () =>
        new CesiumPrimitivePointRenderer(scene, {
          eyeDomeLightingRadius: 0,
        }),
    ).toThrow("eyeDomeLightingRadius must be a positive number.");

    const renderer = new CesiumPrimitivePointRenderer(scene, {
      pointSizeMode: "adaptive",
    });
    expect(() =>
      renderer.setPointGeometryBatches([
        createPointGeometryBatch({ pointSpacingMeters: -1 }),
      ]),
    ).toThrow("pointSpacingMeters must be a positive number.");
    expect(() =>
      renderer.setPointGeometryBatches([
        createPointGeometryBatch({
          pointSpacingMeters: 1,
          pointDensityScale: Number.NaN,
        }),
      ]),
    ).toThrow("pointDensityScale must be a positive number.");
  });

  it("falls back to direct primitives when renderer-scoped EDL is unsupported", () => {
    const { addedPrimitives, scene } = createSceneStub();
    const renderer = new CesiumPrimitivePointRenderer(scene, {
      eyeDomeLighting: true,
    });

    renderer.setPointGeometryBatches([createPointGeometryBatch()]);

    expect(addedPrimitives).toHaveLength(1);
    expect(addedPrimitives[0]).toBeInstanceOf(Object);
    expect((addedPrimitives[0] as Primitive).appearance).toBeDefined();
  });
});

function createSceneStub(): {
  readonly addedPrimitives: unknown[];
  readonly scene: Scene;
} {
  const addedPrimitives: unknown[] = [];

  return {
    addedPrimitives,
    scene: {
      primitives: {
        add: <T>(primitive: T): T => {
          addedPrimitives.push(primitive);
          return primitive;
        },
        remove: () => true,
      },
    } as unknown as Scene,
  };
}

function createPointGeometryBatch(
  metadata: Pick<
    PointGeometryBatch,
    "pointDensityScale" | "pointSpacingMeters"
  > = {},
): PointGeometryBatch {
  return {
    key: "0-0-0-0:2",
    pointCount: 2,
    positions: new Float64Array([127, 37, 10, 127.001, 37.001, 15]),
    colors: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]),
    ...metadata,
  };
}

function getPrimitiveGeometry(primitive: Primitive): Geometry {
  const geometryInstances = primitive.geometryInstances;
  const geometryInstance = Array.isArray(geometryInstances)
    ? geometryInstances[0]
    : geometryInstances;

  return geometryInstance.geometry as Geometry;
}

function getPointSpacingAttribute(
  geometry: Geometry,
): GeometryAttribute | undefined {
  return (geometry.attributes as { pointSpacing?: GeometryAttribute })
    .pointSpacing;
}
