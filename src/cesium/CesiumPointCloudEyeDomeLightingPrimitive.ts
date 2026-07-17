import * as CesiumRuntime from "cesium";
import { BoundingSphere, type Primitive, type Scene } from "cesium";

export interface CesiumPointCloudEyeDomeLightingOptions {
  readonly strength: number;
  readonly radius: number;
}

interface CesiumFrameStateLike {
  readonly commandList: CesiumCommandLike[];
  readonly passes?: {
    readonly render?: boolean;
  };
}

interface CesiumCommandLike {
  framebuffer?: unknown;
  pass?: number;
}

interface CesiumPointPrimitiveLike {
  update(frameState: CesiumFrameStateLike): void;
  destroy(): unknown;
  isDestroyed(): boolean;
}

interface RuntimePointCloudShading {
  readonly eyeDomeLightingStrength: number;
  readonly eyeDomeLightingRadius: number;
}

interface RuntimePointCloudShadingConstructor {
  new (options: {
    readonly attenuation: boolean;
    readonly eyeDomeLighting: boolean;
    readonly eyeDomeLightingStrength: number;
    readonly eyeDomeLightingRadius: number;
  }): RuntimePointCloudShading;
  isSupported(scene: Scene): boolean;
}

interface RuntimePointCloudEyeDomeLighting {
  readonly framebuffer?: unknown;
  update(
    frameState: CesiumFrameStateLike,
    commandStart: number,
    shading: RuntimePointCloudShading,
    boundingVolume: BoundingSphere,
  ): void;
  destroy(): unknown;
  isDestroyed(): boolean;
}

interface RuntimePointCloudEyeDomeLightingConstructor {
  new (): RuntimePointCloudEyeDomeLighting;
  isSupported(context: unknown): boolean;
}

interface CesiumPointCloudRuntime {
  readonly PointCloudEyeDomeLighting?:
    RuntimePointCloudEyeDomeLightingConstructor;
  readonly PointCloudShading?: RuntimePointCloudShadingConstructor;
}

export interface CesiumPointCloudEyeDomeLightingController {
  update(
    frameState: CesiumFrameStateLike,
    commandStart: number,
    boundingVolume: BoundingSphere,
  ): void;
  destroy(): void;
}

/**
 * Scene primitive that limits Cesium's point-cloud EDL command rewriting to its
 * own children. Cesium 1.140 exports the EDL processor at runtime but omits its
 * public TypeScript declaration, so all access to that runtime API is isolated
 * in this module.
 */
export class CesiumPointCloudEyeDomeLightingPrimitive {
  show = true;

  private readonly controller: CesiumPointCloudEyeDomeLightingController;
  private readonly primitives: Primitive[] = [];
  private readonly boundingSpheres = new Map<Primitive, BoundingSphere>();
  private aggregateBoundingSphere: BoundingSphere | undefined;
  private boundingSphereDirty = false;
  private destroyed = false;

  constructor(controller: CesiumPointCloudEyeDomeLightingController) {
    this.controller = controller;
  }

  add(primitive: Primitive, boundingSphere: BoundingSphere): Primitive {
    this.assertNotDestroyed();
    this.primitives.push(primitive);
    this.boundingSpheres.set(
      primitive,
      BoundingSphere.clone(boundingSphere, new BoundingSphere()),
    );
    this.boundingSphereDirty = true;
    return primitive;
  }

  remove(primitive: Primitive): boolean {
    if (this.destroyed) {
      return false;
    }

    const index = this.primitives.indexOf(primitive);
    if (index < 0) {
      return false;
    }

    this.primitives.splice(index, 1);
    this.boundingSpheres.delete(primitive);
    this.boundingSphereDirty = true;
    destroyPrimitive(primitive);
    return true;
  }

  removeAll(): void {
    if (this.destroyed) {
      return;
    }

    for (const primitive of this.primitives) {
      destroyPrimitive(primitive);
    }
    this.primitives.length = 0;
    this.boundingSpheres.clear();
    this.aggregateBoundingSphere = undefined;
    this.boundingSphereDirty = false;
  }

  update(frameState: CesiumFrameStateLike): void {
    if (this.destroyed || !this.show) {
      return;
    }

    const commandStart = frameState.commandList.length;
    for (const primitive of this.primitives) {
      (primitive as unknown as CesiumPointPrimitiveLike).update(frameState);
    }

    if (
      frameState.passes?.render !== true ||
      frameState.commandList.length === commandStart
    ) {
      return;
    }

    const boundingVolume = this.getAggregateBoundingSphere();
    if (boundingVolume) {
      this.controller.update(frameState, commandStart, boundingVolume);
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): undefined {
    if (this.destroyed) {
      return undefined;
    }

    this.removeAll();
    this.controller.destroy();
    this.destroyed = true;
    return undefined;
  }

  private getAggregateBoundingSphere(): BoundingSphere | undefined {
    if (!this.boundingSphereDirty) {
      return this.aggregateBoundingSphere;
    }

    let aggregate: BoundingSphere | undefined;
    for (const boundingSphere of this.boundingSpheres.values()) {
      aggregate = aggregate
        ? BoundingSphere.union(aggregate, boundingSphere, aggregate)
        : BoundingSphere.clone(boundingSphere, new BoundingSphere());
    }

    this.aggregateBoundingSphere = aggregate;
    this.boundingSphereDirty = false;
    return aggregate;
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error(
        "CesiumPointCloudEyeDomeLightingPrimitive has been destroyed.",
      );
    }
  }
}

export function tryCreateCesiumPointCloudEyeDomeLightingPrimitive(
  scene: Scene,
  options: CesiumPointCloudEyeDomeLightingOptions,
): CesiumPointCloudEyeDomeLightingPrimitive | undefined {
  const controller = tryCreateCesiumPointCloudEyeDomeLightingController(
    scene,
    options,
  );

  return controller
    ? new CesiumPointCloudEyeDomeLightingPrimitive(controller)
    : undefined;
}

function tryCreateCesiumPointCloudEyeDomeLightingController(
  scene: Scene,
  options: CesiumPointCloudEyeDomeLightingOptions,
): CesiumPointCloudEyeDomeLightingController | undefined {
  // Namespace lookup is intentional. A named ESM import would fail module
  // instantiation in Cesium versions that do not export the private processor.
  const runtime = CesiumRuntime as unknown as CesiumPointCloudRuntime;
  const EyeDomeLighting = runtime.PointCloudEyeDomeLighting;
  const PointCloudShading = runtime.PointCloudShading;
  const context = (scene as unknown as { readonly context?: unknown }).context;

  if (
    typeof EyeDomeLighting !== "function" ||
    typeof PointCloudShading !== "function" ||
    typeof EyeDomeLighting.isSupported !== "function" ||
    typeof PointCloudShading.isSupported !== "function" ||
    context === undefined
  ) {
    return undefined;
  }

  let processor: RuntimePointCloudEyeDomeLighting | undefined;
  try {
    if (
      !EyeDomeLighting.isSupported(context) ||
      !PointCloudShading.isSupported(scene)
    ) {
      return undefined;
    }

    processor = new EyeDomeLighting();
    const shading = new PointCloudShading({
      attenuation: true,
      eyeDomeLighting: true,
      eyeDomeLightingStrength: options.strength,
      eyeDomeLightingRadius: options.radius,
    });

    if (
      typeof processor.update !== "function" ||
      typeof processor.destroy !== "function"
    ) {
      destroyRuntimeProcessor(processor);
      return undefined;
    }

    return new CesiumRuntimePointCloudEyeDomeLightingController(
      processor,
      shading,
    );
  } catch {
    if (processor) {
      destroyRuntimeProcessor(processor);
    }
    return undefined;
  }
}

class CesiumRuntimePointCloudEyeDomeLightingController
  implements CesiumPointCloudEyeDomeLightingController
{
  private readonly processor: RuntimePointCloudEyeDomeLighting;
  private readonly shading: RuntimePointCloudShading;

  constructor(
    processor: RuntimePointCloudEyeDomeLighting,
    shading: RuntimePointCloudShading,
  ) {
    this.processor = processor;
    this.shading = shading;
  }

  update(
    frameState: CesiumFrameStateLike,
    commandStart: number,
    boundingVolume: BoundingSphere,
  ): void {
    const commandEnd = frameState.commandList.length;
    this.processor.update(
      frameState,
      commandStart,
      this.shading,
      boundingVolume,
    );

    // Cesium's EDL processor assumes its source point commands already use the
    // 3D Tiles pass. Generic Primitive commands use the later OPAQUE pass, so
    // align only the derived commands targeting this processor's framebuffer
    // with the generated composite command. This keeps draw -> composite ->
    // clear ordering intact without importing Cesium's private Pass enum.
    const compositeCommand = frameState.commandList[commandEnd];
    const framebuffer = this.processor.framebuffer;
    if (compositeCommand?.pass === undefined || framebuffer === undefined) {
      return;
    }

    alignEyeDomeLightingDerivedCommandPasses(
      frameState.commandList,
      commandStart,
      commandEnd,
      framebuffer,
      compositeCommand.pass,
    );
  }

  destroy(): void {
    destroyRuntimeProcessor(this.processor);
  }
}

/** @internal */
export function alignEyeDomeLightingDerivedCommandPasses(
  commandList: Array<{ framebuffer?: unknown; pass?: number }>,
  commandStart: number,
  commandEnd: number,
  framebuffer: unknown,
  compositePass: number,
): void {
  for (let index = commandStart; index < commandEnd; index += 1) {
    const command = commandList[index];
    if (command.framebuffer === framebuffer) {
      command.pass = compositePass;
    }
  }
}

function destroyPrimitive(primitive: Primitive): void {
  if (!primitive.isDestroyed()) {
    primitive.destroy();
  }
}

function destroyRuntimeProcessor(
  processor: RuntimePointCloudEyeDomeLighting,
): void {
  if (
    typeof processor.destroy === "function" &&
    (typeof processor.isDestroyed !== "function" || !processor.isDestroyed())
  ) {
    processor.destroy();
  }
}
