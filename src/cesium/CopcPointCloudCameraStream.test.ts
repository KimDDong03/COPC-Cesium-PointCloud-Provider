import type { Camera } from "cesium";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CopcPointCloudLayerAutomaticRenderResult,
  CopcPointCloudLayerProgressiveAutomaticRenderOptions,
} from "./CopcPointCloudLayer";
import {
  CopcPointCloudCameraStream,
  type CopcPointCloudCameraStreamLayer,
  type CopcPointCloudCameraStreamUpdate,
} from "./CopcPointCloudCameraStream";

describe("CopcPointCloudCameraStream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a camera view with reusable LOD defaults", async () => {
    const camera = createCameraStub(3_000);
    const calls: CopcPointCloudLayerProgressiveAutomaticRenderOptions[] = [];
    const updates: CopcPointCloudCameraStreamUpdate[] = [];
    const result = createRenderResult();
    const layer = createLayerStub(async (options) => {
      calls.push(options);
      options.onProgress?.(result);
      return result;
    });
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer,
      quality: "balanced",
      onUpdate: (update) => updates.push(update),
    });

    await expect(stream.render()).resolves.toBe(result);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      camera: camera.camera,
      selectionMode: "coverage",
      coverageMode: "progressive",
      expandHierarchy: true,
      includePointsInResult: false,
      nodeRenderOrder: "selection",
      nodeRequestOrder: "selection",
      progressBatchNodeCount: 1,
      progressRenderMode: "incremental",
      showBounds: false,
    });
    expect(calls[0].maxNodes).toBeGreaterThan(0);
    expect(calls[0].maxRenderedPointCount).toBeGreaterThan(0);
    expect(calls[0].signal?.aborted).toBe(false);
    expect(updates.map((update) => update.phase)).toEqual([
      "progress",
      "complete",
    ]);
    expect(stream.lastResult).toBe(result);
  });

  it("debounces camera events and removes listeners when stopped", async () => {
    vi.useFakeTimers();
    const camera = createCameraStub(1_000);
    const render = vi.fn(async () => createRenderResult());
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer: createLayerStub(render),
      debounceMilliseconds: 25,
      renderOnStart: false,
    });

    stream.start();
    camera.changed.raise();
    camera.changed.raise();
    await vi.advanceTimersByTimeAsync(24);
    expect(render).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(render).toHaveBeenCalledTimes(1);

    stream.stop();
    expect(stream.isRunning).toBe(false);
    expect(camera.changed.listenerCount).toBe(0);
    expect(camera.moveEnd.listenerCount).toBe(0);
    expect(camera.moveStart.listenerCount).toBe(0);

    camera.moveEnd.raise();
    await vi.advanceTimersByTimeAsync(25);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("aborts stale renders and ignores their late progress", async () => {
    const camera = createCameraStub(500);
    const requests: Array<{
      options: CopcPointCloudLayerProgressiveAutomaticRenderOptions;
      resolve: (
        result: CopcPointCloudLayerAutomaticRenderResult | undefined,
      ) => void;
    }> = [];
    const updates: CopcPointCloudCameraStreamUpdate[] = [];
    const layer = createLayerStub(
      (options) =>
        new Promise((resolve) => {
          requests.push({ options, resolve });
        }),
    );
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer,
      onUpdate: (update) => updates.push(update),
    });
    const firstRender = stream.render();
    const secondRender = stream.render();
    const firstResult = createRenderResult();
    const secondResult = createRenderResult();

    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal?.aborted).toBe(true);
    requests[0].options.onProgress?.(firstResult);
    requests[0].resolve(firstResult);
    requests[1].options.onProgress?.(secondResult);
    requests[1].resolve(secondResult);

    await expect(firstRender).resolves.toBeUndefined();
    await expect(secondRender).resolves.toBe(secondResult);
    expect(updates.map((update) => update.requestId)).toEqual([2, 2]);
  });

  it("reports render failures and rejects use after destroy", async () => {
    const camera = createCameraStub(1_000);
    const failure = new Error("render failed");
    const errors: unknown[] = [];
    const stream = new CopcPointCloudCameraStream({
      camera: camera.camera,
      layer: createLayerStub(async () => {
        throw failure;
      }),
      onError: (error) => errors.push(error),
    });

    await expect(stream.render()).rejects.toBe(failure);
    expect(errors).toEqual([failure]);
    expect(stream.lastError).toBe(failure);

    stream.destroy();
    expect(stream.isDestroyed).toBe(true);
    await expect(stream.render()).rejects.toThrow(
      "CopcPointCloudCameraStream has been destroyed.",
    );
  });
});

class CameraEventStub {
  readonly #listeners = new Set<() => void>();

  addEventListener(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  raise(): void {
    [...this.#listeners].forEach((listener) => listener());
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}

function createCameraStub(height: number): {
  readonly camera: Camera;
  readonly changed: CameraEventStub;
  readonly moveEnd: CameraEventStub;
  readonly moveStart: CameraEventStub;
} {
  const changed = new CameraEventStub();
  const moveEnd = new CameraEventStub();
  const moveStart = new CameraEventStub();
  const camera = {
    changed,
    moveEnd,
    moveStart,
    positionCartographic: { height },
  } as unknown as Camera;

  return { camera, changed, moveEnd, moveStart };
}

function createLayerStub(
  render: (
    options: CopcPointCloudLayerProgressiveAutomaticRenderOptions,
  ) => Promise<CopcPointCloudLayerAutomaticRenderResult | undefined>,
): CopcPointCloudCameraStreamLayer {
  return {
    renderAutomaticProgressively: render,
  };
}

function createRenderResult(): CopcPointCloudLayerAutomaticRenderResult {
  return {} as CopcPointCloudLayerAutomaticRenderResult;
}
