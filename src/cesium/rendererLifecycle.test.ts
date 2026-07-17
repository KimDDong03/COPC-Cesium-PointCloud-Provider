import type { Primitive, Scene } from "cesium";
import { describe, expect, it } from "vitest";
import type { CopcBounds, CopcInspection } from "../core";
import { CesiumBoundsRenderer } from "./CesiumBoundsRenderer";
import { CesiumBufferPointRenderer } from "./CesiumBufferPointRenderer";
import { CesiumPointPrimitiveRenderer } from "./CesiumPointPrimitiveRenderer";
import { CesiumPointRenderer } from "./CesiumPointRenderer";
import { CesiumPrimitivePointRenderer } from "./CesiumPrimitivePointRenderer";

describe("Cesium renderer lifecycle", () => {
  it("removes point primitive collections once when destroyed", () => {
    const { removedPrimitives, scene } = createSceneStub();
    const renderer = new CesiumPointPrimitiveRenderer(scene);

    renderer.setPoints([
      {
        longitudeDegrees: 127,
        latitudeDegrees: 37,
        heightMeters: 10,
      },
    ]);
    renderer.clear();
    renderer.destroy();
    renderer.destroy();

    expect(removedPrimitives).toHaveLength(1);
    expect(() => renderer.setPoints([])).toThrow(
      "CesiumPointPrimitiveRenderer has been destroyed.",
    );
  });

  it("keeps CesiumPointRenderer as a compatibility alias", () => {
    const { scene } = createSceneStub();
    const renderer = new CesiumPointRenderer(scene);

    renderer.destroy();

    expect(() => renderer.setPoints([])).toThrow(
      "CesiumPointRenderer has been destroyed.",
    );
  });

  it("rejects invalid point primitive styling options", () => {
    const { scene } = createSceneStub();

    expect(
      () => new CesiumPointPrimitiveRenderer(scene, { pixelSize: 0 }),
    ).toThrow("pixelSize must be a positive number.");
    expect(
      () => new CesiumPointPrimitiveRenderer(scene, { outlineWidth: -1 }),
    ).toThrow("outlineWidth must be a non-negative number.");
  });

  it("rebuilds buffer point collections when points change", () => {
    const { addedPrimitives, removedPrimitives, scene } = createSceneStub();
    const renderer = new CesiumBufferPointRenderer(scene);

    expect(addedPrimitives).toHaveLength(0);

    renderer.setPoints([
      {
        longitudeDegrees: 127,
        latitudeDegrees: 37,
        heightMeters: 10,
      },
    ]);

    expect(addedPrimitives).toHaveLength(1);
    expect(removedPrimitives).toHaveLength(0);

    renderer.setPoints([
      {
        longitudeDegrees: 127,
        latitudeDegrees: 37,
        heightMeters: 10,
      },
      {
        longitudeDegrees: 127.001,
        latitudeDegrees: 37.001,
        heightMeters: 15,
        color: {
          red: 255,
          green: 0,
          blue: 0,
        },
      },
    ]);

    expect(addedPrimitives).toHaveLength(2);
    expect(removedPrimitives).toHaveLength(1);

    renderer.clear();
    renderer.destroy();
    renderer.destroy();

    expect(removedPrimitives).toHaveLength(2);
    expect(() => renderer.setPoints([])).toThrow(
      "CesiumBufferPointRenderer has been destroyed.",
    );
  });

  it("rejects invalid buffer point styling options", () => {
    const { scene } = createSceneStub();

    expect(() => new CesiumBufferPointRenderer(scene, { pointSize: 0 })).toThrow(
      "pointSize must be a positive number.",
    );
    expect(
      () => new CesiumBufferPointRenderer(scene, { outlineWidth: -1 }),
    ).toThrow("outlineWidth must be a non-negative number.");
  });

  it("rebuilds typed-array primitives when points change", () => {
    const { addedPrimitives, removedPrimitives, scene } = createSceneStub();
    const renderer = new CesiumPrimitivePointRenderer(scene);

    expect(addedPrimitives).toHaveLength(0);

    renderer.setPoints([
      {
        longitudeDegrees: 127,
        latitudeDegrees: 37,
        heightMeters: 10,
      },
    ]);

    expect(addedPrimitives).toHaveLength(1);
    expect(removedPrimitives).toHaveLength(0);

    renderer.setPoints([
      {
        longitudeDegrees: 127,
        latitudeDegrees: 37,
        heightMeters: 10,
      },
      {
        longitudeDegrees: 127.001,
        latitudeDegrees: 37.001,
        heightMeters: 15,
        color: {
          red: 255,
          green: 0,
          blue: 0,
        },
      },
    ]);

    expect(addedPrimitives).toHaveLength(2);
    expect(removedPrimitives).toHaveLength(1);

    renderer.clear();
    renderer.destroy();
    renderer.destroy();

    expect(removedPrimitives).toHaveLength(2);
    expect(() => renderer.setPoints([])).toThrow(
      "CesiumPrimitivePointRenderer has been destroyed.",
    );
  });

  it("uses opaque depth-writing appearances unless point alpha requires blending", () => {
    const { addedPrimitives, scene } = createSceneStub();
    const renderer = new CesiumPrimitivePointRenderer(scene);

    renderer.setPoints([
      {
        longitudeDegrees: 127,
        latitudeDegrees: 37,
        heightMeters: 10,
        color: { red: 1, green: 2, blue: 3, alpha: 255 },
      },
    ]);

    const opaqueAppearance = (addedPrimitives[0] as Primitive).appearance;
    expect(opaqueAppearance.translucent).toBe(false);
    expect(opaqueAppearance.renderState.depthMask).toBe(true);

    renderer.setPoints([
      {
        longitudeDegrees: 127,
        latitudeDegrees: 37,
        heightMeters: 10,
        color: { red: 1, green: 2, blue: 3, alpha: 128 },
      },
    ]);

    const translucentAppearance = (addedPrimitives[1] as Primitive).appearance;
    expect(translucentAppearance.translucent).toBe(true);
    expect(translucentAppearance.renderState.depthMask).toBe(false);
  });

  it("reuses typed-array primitive chunks for unchanged node batches", () => {
    const { addedPrimitives, removedPrimitives, scene } = createSceneStub();
    const renderer = new CesiumPrimitivePointRenderer(scene, {
      maxBatchesPerPrimitive: 2,
    });

    renderer.setPointBatches([
      {
        key: "0-0-0-0:1",
        points: [
          {
            longitudeDegrees: 127,
            latitudeDegrees: 37,
            heightMeters: 10,
          },
        ],
      },
      {
        key: "1-0-0-0:1",
        points: [
          {
            longitudeDegrees: 127.001,
            latitudeDegrees: 37.001,
            heightMeters: 15,
          },
        ],
      },
    ]);

    expect(addedPrimitives).toHaveLength(1);
    expect(removedPrimitives).toHaveLength(0);

    renderer.setPointBatches([
      {
        key: "0-0-0-0:1",
        points: [
          {
            longitudeDegrees: 127,
            latitudeDegrees: 37,
            heightMeters: 10,
          },
        ],
      },
      {
        key: "1-0-0-0:1",
        points: [
          {
            longitudeDegrees: 127.001,
            latitudeDegrees: 37.001,
            heightMeters: 15,
          },
        ],
      },
    ]);

    expect(addedPrimitives).toHaveLength(1);
    expect(removedPrimitives).toHaveLength(0);

    renderer.setPointBatches([
      {
        key: "0-0-0-0:1",
        points: [
          {
            longitudeDegrees: 127,
            latitudeDegrees: 37,
            heightMeters: 10,
          },
        ],
      },
      {
        key: "1-0-0-0:1",
        points: [
          {
            longitudeDegrees: 127.001,
            latitudeDegrees: 37.001,
            heightMeters: 15,
          },
        ],
      },
      {
        key: "2-0-0-0:1",
        points: [
          {
            longitudeDegrees: 127.002,
            latitudeDegrees: 37.002,
            heightMeters: 20,
          },
        ],
      },
    ]);

    expect(addedPrimitives).toHaveLength(2);
    expect(removedPrimitives).toHaveLength(0);

    renderer.setPointBatches([
      {
        key: "0-0-0-0:1",
        points: [
          {
            longitudeDegrees: 127,
            latitudeDegrees: 37,
            heightMeters: 10,
          },
        ],
      },
      {
        key: "1-0-0-0:1",
        points: [
          {
            longitudeDegrees: 127.001,
            latitudeDegrees: 37.001,
            heightMeters: 15,
          },
        ],
      },
    ]);

    expect(addedPrimitives).toHaveLength(2);
    expect(removedPrimitives).toHaveLength(1);

    renderer.clear();
    renderer.destroy();

    expect(removedPrimitives).toHaveLength(2);
  });

  it("reuses primitive chunks for unchanged geometry batches", () => {
    const { addedPrimitives, removedPrimitives, scene } = createSceneStub();
    const renderer = new CesiumPrimitivePointRenderer(scene, {
      maxBatchesPerPrimitive: 2,
    });

    renderer.setPointGeometryBatches([
      createPointGeometryBatch("0-0-0-0:1", 127, 37, 10),
      createPointGeometryBatch("1-0-0-0:1", 127.001, 37.001, 15),
    ]);

    expect(addedPrimitives).toHaveLength(1);
    expect(removedPrimitives).toHaveLength(0);

    renderer.setPointGeometryBatches([
      createPointGeometryBatch("0-0-0-0:1", 127, 37, 10),
      createPointGeometryBatch("1-0-0-0:1", 127.001, 37.001, 15),
    ]);

    expect(addedPrimitives).toHaveLength(1);
    expect(removedPrimitives).toHaveLength(0);

    renderer.setPointGeometryBatches([
      createPointGeometryBatch("0-0-0-0:1", 127, 37, 10),
      createPointGeometryBatch("1-0-0-0:1", 127.001, 37.001, 15),
      createPointGeometryBatch("2-0-0-0:1", 127.002, 37.002, 20),
    ]);

    expect(addedPrimitives).toHaveLength(2);
    expect(removedPrimitives).toHaveLength(0);

    renderer.setPointGeometryBatches([
      createPointGeometryBatch("0-0-0-0:1", 127, 37, 10),
      createPointGeometryBatch("1-0-0-0:1", 127.001, 37.001, 15),
    ]);

    expect(addedPrimitives).toHaveLength(2);
    expect(removedPrimitives).toHaveLength(1);

    renderer.clear();
    renderer.destroy();

    expect(removedPrimitives).toHaveLength(2);
  });

  it("keeps default geometry batches as stable per-node primitives", () => {
    const { addedPrimitives, removedPrimitives, scene } = createSceneStub();
    const renderer = new CesiumPrimitivePointRenderer(scene);

    renderer.setPointGeometryBatches([
      createPointGeometryBatch("0-0-0-0:1", 127, 37, 10),
    ]);

    expect(addedPrimitives).toHaveLength(1);
    expect(removedPrimitives).toHaveLength(0);

    renderer.setPointGeometryBatches([
      createPointGeometryBatch("0-0-0-0:1", 127, 37, 10),
      createPointGeometryBatch("1-0-0-0:1", 127.001, 37.001, 15),
    ]);

    expect(addedPrimitives).toHaveLength(2);
    expect(removedPrimitives).toHaveLength(0);

    renderer.setPointGeometryBatches([
      createPointGeometryBatch("0-0-0-0:1", 127, 37, 10),
      createPointGeometryBatch("1-0-0-0:1", 127.001, 37.001, 15),
    ]);

    expect(addedPrimitives).toHaveLength(2);
    expect(removedPrimitives).toHaveLength(0);

    renderer.clear();
    renderer.destroy();

    expect(removedPrimitives).toHaveLength(2);
  });

  it("keeps an incomplete geometry merge tail stable until the chunk is full", () => {
    const { addedPrimitives, removedPrimitives, scene } = createSceneStub();
    const renderer = new CesiumPrimitivePointRenderer(scene, {
      maxGeometryBatchesPerPrimitive: 4,
    });
    const batches = [
      createPointGeometryBatch("0-0-0-0:1", 127, 37, 10),
      createPointGeometryBatch("1-0-0-0:1", 127.001, 37.001, 15),
      createPointGeometryBatch("2-0-0-0:1", 127.002, 37.002, 20),
      createPointGeometryBatch("3-0-0-0:1", 127.003, 37.003, 25),
      createPointGeometryBatch("4-0-0-0:1", 127.004, 37.004, 30),
    ];

    renderer.setPointGeometryBatches(batches.slice(0, 1));
    renderer.setPointGeometryBatches(batches.slice(0, 2));
    renderer.setPointGeometryBatches(batches.slice(0, 3));

    expect(addedPrimitives).toHaveLength(3);
    expect(removedPrimitives).toHaveLength(0);

    renderer.setPointGeometryBatches(batches.slice(0, 4));

    expect(addedPrimitives).toHaveLength(4);
    expect(removedPrimitives).toHaveLength(3);

    renderer.setPointGeometryBatches(batches);

    expect(addedPrimitives).toHaveLength(5);
    expect(removedPrimitives).toHaveLength(3);

    renderer.destroy();

    expect(removedPrimitives).toHaveLength(5);
  });

  it("rejects invalid typed-array primitive styling options", () => {
    const { scene } = createSceneStub();

    expect(
      () => new CesiumPrimitivePointRenderer(scene, { pointSize: 0 }),
    ).toThrow("pointSize must be a positive number.");
    expect(
      () =>
        new CesiumPrimitivePointRenderer(scene, {
          maxBatchesPerPrimitive: 0,
        }),
    ).toThrow("maxBatchesPerPrimitive must be a positive integer.");
    expect(
      () =>
        new CesiumPrimitivePointRenderer(scene, {
          maxGeometryBatchesPerPrimitive: 0,
        }),
    ).toThrow("maxGeometryBatchesPerPrimitive must be a positive integer.");
    expect(
      () =>
        new CesiumPrimitivePointRenderer(scene, {
          maxPointsPerPrimitive: 0,
        }),
    ).toThrow("maxPointsPerPrimitive must be a positive integer.");
  });

  it("removes bounds primitive collections once when destroyed", () => {
    const { removedPrimitives, scene } = createSceneStub();
    const renderer = new CesiumBoundsRenderer(scene);

    renderer.clear();
    renderer.destroy();
    renderer.destroy();

    expect(removedPrimitives).toHaveLength(1);
    expect(() =>
      renderer.setBounds(createBounds(), {} as CopcInspection),
    ).toThrow("CesiumBoundsRenderer has been destroyed.");
  });
});

function createSceneStub(): {
  readonly addedPrimitives: unknown[];
  readonly removedPrimitives: unknown[];
  readonly scene: Scene;
} {
  const addedPrimitives: unknown[] = [];
  const removedPrimitives: unknown[] = [];

  return {
    addedPrimitives,
    removedPrimitives,
    scene: {
      primitives: {
        add: <T>(primitive: T): T => {
          addedPrimitives.push(primitive);
          return primitive;
        },
        remove: (primitive: unknown): boolean => {
          removedPrimitives.push(primitive);
          return true;
        },
      },
    } as unknown as Scene,
  };
}

function createPointGeometryBatch(
  key: string,
  x: number,
  y: number,
  z: number,
) {
  return {
    key,
    pointCount: 1,
    positions: new Float64Array([x, y, z]),
    colors: new Uint8Array([1, 2, 3, 255]),
  };
}

function createBounds(): CopcBounds {
  return {
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: 1,
    maxY: 1,
    maxZ: 1,
  };
}
