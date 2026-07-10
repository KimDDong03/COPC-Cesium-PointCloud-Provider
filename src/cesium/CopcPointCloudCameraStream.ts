import type { Camera } from "cesium";
import {
  type CopcPointCloudLayer,
  type CopcPointCloudLayerAutomaticRenderResult,
  type CopcPointCloudLayerProgressiveAutomaticRenderOptions,
} from "./CopcPointCloudLayer";
import {
  createCopcCameraStreamLodSettings,
  createCopcCameraStreamRuntimeSettings,
  type CopcCameraStreamLodSettings,
} from "./CopcCameraStreamSettings";
import {
  createCopcPointCloudQualitySettings,
  type CopcPointCloudQualityPreset,
  type CopcPointCloudQualitySettings,
} from "./CopcPointCloudQualitySettings";

export type CopcPointCloudCameraStreamLayer = Pick<
  CopcPointCloudLayer,
  "renderAutomaticProgressively"
>;

export type CopcPointCloudCameraStreamRenderOptions = Omit<
  Partial<CopcPointCloudLayerProgressiveAutomaticRenderOptions>,
  "camera" | "onProgress" | "signal"
>;

export interface CopcPointCloudCameraStreamUpdate {
  readonly phase: "progress" | "complete";
  readonly requestId: number;
  readonly lodSettings: CopcCameraStreamLodSettings;
  readonly result: CopcPointCloudLayerAutomaticRenderResult;
}

export interface CopcPointCloudCameraStreamOptions {
  readonly camera: Camera;
  readonly layer: CopcPointCloudCameraStreamLayer;
  readonly quality?:
    | CopcPointCloudQualityPreset
    | CopcPointCloudQualitySettings;
  readonly debounceMilliseconds?: number;
  readonly renderOnStart?: boolean;
  readonly renderOptions?: CopcPointCloudCameraStreamRenderOptions;
  readonly onError?: (error: unknown, requestId: number) => void;
  readonly onUpdate?: (update: CopcPointCloudCameraStreamUpdate) => void;
}

export class CopcPointCloudCameraStream {
  readonly #camera: Camera;
  readonly #layer: CopcPointCloudCameraStreamLayer;
  readonly #qualitySettings: CopcPointCloudQualitySettings;
  readonly #debounceMilliseconds: number;
  readonly #renderOnStart: boolean;
  readonly #renderOptions: CopcPointCloudCameraStreamRenderOptions;
  readonly #onError:
    | ((error: unknown, requestId: number) => void)
    | undefined;
  readonly #onUpdate:
    | ((update: CopcPointCloudCameraStreamUpdate) => void)
    | undefined;
  readonly #removeCameraListeners: Array<() => void> = [];
  #activeAbortController: AbortController | undefined;
  #scheduledRender: ReturnType<typeof globalThis.setTimeout> | undefined;
  #requestId = 0;
  #running = false;
  #destroyed = false;
  #lastError: unknown;
  #lastResult: CopcPointCloudLayerAutomaticRenderResult | undefined;

  constructor(options: CopcPointCloudCameraStreamOptions) {
    this.#camera = options.camera;
    this.#layer = options.layer;
    this.#qualitySettings =
      typeof options.quality === "string" || options.quality === undefined
        ? createCopcPointCloudQualitySettings(options.quality)
        : { ...options.quality };
    this.#debounceMilliseconds = normalizeNonNegativeNumber(
      options.debounceMilliseconds,
      createCopcCameraStreamRuntimeSettings().moveDebounceMilliseconds,
    );
    this.#renderOnStart = options.renderOnStart ?? true;
    this.#renderOptions = { ...options.renderOptions };
    this.#onError = options.onError;
    this.#onUpdate = options.onUpdate;
  }

  start(): void {
    this.#assertNotDestroyed();

    if (this.#running) {
      return;
    }

    this.#running = true;
    this.#removeCameraListeners.push(
      this.#camera.moveStart.addEventListener(() => {
        this.cancel();
      }),
      this.#camera.changed.addEventListener(() => {
        this.#queueRender();
      }),
      this.#camera.moveEnd.addEventListener(() => {
        this.#queueRender();
      }),
    );

    if (this.#renderOnStart) {
      this.#runScheduledRender();
    }
  }

  stop(): void {
    if (this.#destroyed) {
      return;
    }

    this.#running = false;
    this.#clearScheduledRender();
    this.cancel();

    while (this.#removeCameraListeners.length > 0) {
      this.#removeCameraListeners.pop()?.();
    }
  }

  cancel(): void {
    this.#clearScheduledRender();
    this.#requestId += 1;
    this.#activeAbortController?.abort();
    this.#activeAbortController = undefined;
  }

  async render(): Promise<
    CopcPointCloudLayerAutomaticRenderResult | undefined
  > {
    this.#assertNotDestroyed();
    this.#clearScheduledRender();
    this.#activeAbortController?.abort();

    const abortController = new AbortController();
    const requestId = (this.#requestId += 1);
    const lodSettings = createCopcCameraStreamLodSettings({
      cameraHeightMeters: this.#camera.positionCartographic.height,
      qualitySettings: this.#qualitySettings,
    });
    this.#activeAbortController = abortController;

    try {
      const result = await this.#layer.renderAutomaticProgressively({
        selectionMode: "coverage",
        coverageMode: "progressive",
        maxNodes: lodSettings.maxNodes,
        maxDepth: lodSettings.maxDepth,
        maxNodePointCount: lodSettings.maxNodePointCount,
        maxNodePointDataLength: lodSettings.maxNodePointDataLength,
        maxTotalPointCount: lodSettings.maxSourcePointCount,
        maxTotalPointDataLength: lodSettings.maxPointDataLength,
        targetNodeScreenPixels: lodSettings.targetNodeScreenPixels,
        targetPointSpacingScreenPixels:
          lodSettings.targetPointSpacingScreenPixels,
        maxPointCountPerNode: lodSettings.detailMaxPointCountPerNode,
        maxRenderedPointCount: lodSettings.maxRenderedPointCount,
        expandHierarchy: true,
        maxHierarchyPages: lodSettings.maxHierarchyPages,
        maxHierarchyPageDepth: lodSettings.maxDepth,
        nodeRenderOrder: "selection",
        nodeRequestOrder: "selection",
        progressBatchNodeCount: 1,
        progressRenderMode: "incremental",
        includePointsInResult: false,
        showBounds: false,
        ...this.#renderOptions,
        camera: this.#camera,
        signal: abortController.signal,
        onProgress: (progressResult) => {
          if (!this.#isCurrentRequest(requestId, abortController.signal)) {
            return;
          }

          this.#lastResult = progressResult;
          this.#onUpdate?.({
            phase: "progress",
            requestId,
            lodSettings,
            result: progressResult,
          });
        },
      });

      if (
        !result ||
        !this.#isCurrentRequest(requestId, abortController.signal)
      ) {
        return undefined;
      }

      this.#lastResult = result;
      this.#lastError = undefined;
      this.#onUpdate?.({
        phase: "complete",
        requestId,
        lodSettings,
        result,
      });
      return result;
    } catch (error) {
      if (
        abortController.signal.aborted ||
        requestId !== this.#requestId ||
        isAbortError(error)
      ) {
        return undefined;
      }

      this.#lastError = error;
      this.#onError?.(error, requestId);
      throw error;
    } finally {
      if (this.#activeAbortController === abortController) {
        this.#activeAbortController = undefined;
      }
    }
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }

    this.stop();
    this.#destroyed = true;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  get isRendering(): boolean {
    return this.#activeAbortController !== undefined;
  }

  get isDestroyed(): boolean {
    return this.#destroyed;
  }

  get lastResult(): CopcPointCloudLayerAutomaticRenderResult | undefined {
    return this.#lastResult;
  }

  get lastError(): unknown {
    return this.#lastError;
  }

  #queueRender(): void {
    if (!this.#running || this.#destroyed) {
      return;
    }

    this.#clearScheduledRender();
    this.#scheduledRender = globalThis.setTimeout(() => {
      this.#scheduledRender = undefined;
      this.#runScheduledRender();
    }, this.#debounceMilliseconds);
  }

  #runScheduledRender(): void {
    void this.render().catch(() => undefined);
  }

  #clearScheduledRender(): void {
    if (this.#scheduledRender === undefined) {
      return;
    }

    globalThis.clearTimeout(this.#scheduledRender);
    this.#scheduledRender = undefined;
  }

  #isCurrentRequest(requestId: number, signal: AbortSignal): boolean {
    return !signal.aborted && requestId === this.#requestId;
  }

  #assertNotDestroyed(): void {
    if (this.#destroyed) {
      throw new Error("CopcPointCloudCameraStream has been destroyed.");
    }
  }
}

function normalizeNonNegativeNumber(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
