import { BoundingSphere, Cartesian3, type Primitive, type Scene } from "cesium";
import { describe, expect, it, vi } from "vitest";
import {
  alignEyeDomeLightingDerivedCommandPasses,
  type CesiumPointCloudEyeDomeLightingController,
  CesiumPointCloudEyeDomeLightingPrimitive,
  tryCreateCesiumPointCloudEyeDomeLightingPrimitive,
} from "./CesiumPointCloudEyeDomeLightingPrimitive";

describe("CesiumPointCloudEyeDomeLightingPrimitive", () => {
  it("limits EDL command processing to commands emitted by its children", () => {
    const update = vi.fn();
    const controller = createControllerStub(update);
    const primitive = new CesiumPointCloudEyeDomeLightingPrimitive(controller);
    const child = createPrimitiveStub((frameState) => {
      frameState.commandList.push({ pass: 8 });
    });
    const boundingSphere = new BoundingSphere(
      new Cartesian3(1, 2, 3),
      4,
    );
    primitive.add(child.primitive, boundingSphere);
    const frameState = {
      commandList: [{ pass: 2 }],
      passes: { render: true },
    };

    primitive.update(frameState);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      frameState,
      1,
      expect.objectContaining({ radius: 4 }),
    );
    const receivedBoundingSphere = update.mock.calls[0][2] as BoundingSphere;
    expect(receivedBoundingSphere.center).toEqual(new Cartesian3(1, 2, 3));
  });

  it("does not run EDL during non-render passes or empty updates", () => {
    const update = vi.fn();
    const primitive = new CesiumPointCloudEyeDomeLightingPrimitive(
      createControllerStub(update),
    );
    const child = createPrimitiveStub((frameState) => {
      frameState.commandList.push({ pass: 8 });
    });
    primitive.add(child.primitive, new BoundingSphere());

    primitive.update({ commandList: [], passes: { render: false } });
    expect(update).not.toHaveBeenCalled();

    const emptyPrimitive = new CesiumPointCloudEyeDomeLightingPrimitive(
      createControllerStub(update),
    );
    emptyPrimitive.update({ commandList: [], passes: { render: true } });
    expect(update).not.toHaveBeenCalled();
  });

  it("owns child and EDL controller lifecycles", () => {
    const destroyController = vi.fn();
    const primitive = new CesiumPointCloudEyeDomeLightingPrimitive({
      update: vi.fn(),
      destroy: destroyController,
    });
    const first = createPrimitiveStub();
    const second = createPrimitiveStub();
    primitive.add(first.primitive, new BoundingSphere());
    primitive.add(second.primitive, new BoundingSphere());

    expect(primitive.remove(first.primitive)).toBe(true);
    expect(first.destroy).toHaveBeenCalledTimes(1);

    primitive.destroy();
    primitive.destroy();

    expect(second.destroy).toHaveBeenCalledTimes(1);
    expect(destroyController).toHaveBeenCalledTimes(1);
    expect(primitive.isDestroyed()).toBe(true);
    expect(() =>
      primitive.add(createPrimitiveStub().primitive, new BoundingSphere()),
    ).toThrow(
      "CesiumPointCloudEyeDomeLightingPrimitive has been destroyed.",
    );
  });

  it("feature-detects Cesium's runtime-only EDL processor", () => {
    const unsupportedScene = {
      context: { drawBuffers: false, fragmentDepth: false },
    } as unknown as Scene;
    expect(
      tryCreateCesiumPointCloudEyeDomeLightingPrimitive(unsupportedScene, {
        strength: 1,
        radius: 1,
      }),
    ).toBeUndefined();

    const supportedScene = {
      context: { drawBuffers: true, fragmentDepth: true },
    } as unknown as Scene;
    const supported = tryCreateCesiumPointCloudEyeDomeLightingPrimitive(
      supportedScene,
      { strength: 1.5, radius: 2 },
    );

    expect(supported).toBeInstanceOf(
      CesiumPointCloudEyeDomeLightingPrimitive,
    );
    supported?.destroy();
  });

  it("aligns only EDL-derived point commands with the composite pass", () => {
    const edlFramebuffer = {};
    const commandList = [
      { pass: 2 },
      { framebuffer: edlFramebuffer, pass: 8 },
      { framebuffer: {}, pass: 8 },
      { pass: 5 },
      { framebuffer: edlFramebuffer, pass: 5 },
    ];

    alignEyeDomeLightingDerivedCommandPasses(
      commandList,
      1,
      3,
      edlFramebuffer,
      5,
    );

    expect(commandList.map((command) => command.pass)).toEqual([
      2, 5, 8, 5, 5,
    ]);
  });
});

function createControllerStub(
  update: CesiumPointCloudEyeDomeLightingController["update"] = vi.fn(),
): CesiumPointCloudEyeDomeLightingController {
  return {
    update,
    destroy: vi.fn(),
  };
}

function createPrimitiveStub(
  update: (frameState: { commandList: unknown[] }) => void = () => undefined,
): {
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly primitive: Primitive;
} {
  let destroyed = false;
  const destroy = vi.fn(() => {
    destroyed = true;
  });
  const primitive = {
    update,
    destroy,
    isDestroyed: () => destroyed,
  } as unknown as Primitive;

  return { destroy, primitive };
}
