import type { Scene } from "cesium";
import { describe, expect, it } from "vitest";
import type { CopcBounds, CopcInspection } from "../core";
import { CesiumBoundsRenderer } from "./CesiumBoundsRenderer";
import { CesiumBufferPointRenderer } from "./CesiumBufferPointRenderer";
import { CesiumPointPrimitiveRenderer } from "./CesiumPointPrimitiveRenderer";
import { CesiumPointRenderer } from "./CesiumPointRenderer";

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
