import type { Camera } from "cesium";
import {
  isCopcCameraStreamEngineLayer,
  runCopcCameraStreamEngine,
  supportsCopcCameraStreamEngineOptions,
  type CopcCameraStreamEngineResult,
} from "./CopcCameraStreamEngine";
import {
  type CopcPointCloudLayer,
  type CopcPointCloudLayerAutomaticRenderResult,
  type CopcPointCloudLayerProgressiveAutomaticRenderOptions,
} from "./CopcPointCloudLayer";
import {
  createCopcCameraStreamLodSettings,
  createCopcCameraStreamRuntimeSettings,
  type CopcCameraStreamLodSettings,
  type CopcCameraStreamRuntimeSettings,
} from "./CopcCameraStreamSettings";
import { createCopcCameraStreamRenderNodeKeys } from "./CopcCameraStreamNodePlan";
import {
  createCopcCameraStreamVisualQualityState,
  type CopcCameraStreamVisualQualityState,
  withCopcCameraStreamHierarchyQuality,
} from "./CopcCameraStreamVisualQuality";
import { createCopcCameraStreamSafeSwapState } from "./CopcCameraStreamTransition";
import {
  createCopcPointCloudQualitySettings,
  type CopcPointCloudQualityPreset,
  type CopcPointCloudQualitySettings,
} from "./CopcPointCloudQualitySettings";

export type CopcPointCloudCameraStreamLayer = Pick<
  CopcPointCloudLayer,
  "renderAutomaticProgressively"
> &
  Partial<
    Pick<
      CopcPointCloudLayer,
      | "expandHierarchyForCamera"
      | "getCameraHeightAbovePointCloudMeters"
      | "getRendererRevision"
      | "hierarchy"
      | "renderNodesProgressively"
      | "selectNodesForCamera"
    >
  >;

export type CopcPointCloudCameraStreamRenderOptions = Omit<
  Partial<CopcPointCloudLayerProgressiveAutomaticRenderOptions>,
  "camera" | "onProgress" | "signal"
>;

export interface CopcPointCloudCameraStreamUpdate {
  /**
   * Backward-compatible request phase. `complete` means the request settled;
   * use `stage === "terminal"` for the exact visual-quality contract.
   */
  readonly phase: "progress" | "complete";
  /** Fine-grained camera-stream state shared with the terminal engine. */
  readonly stage:
    | "preview"
    | "refining"
    | "interactive-ready"
    | "terminal";
  readonly requestId: number;
  readonly lodSettings: CopcCameraStreamLodSettings;
  readonly result: CopcPointCloudLayerAutomaticRenderResult;
  /** Exact additive-composition state when the layer exposes hierarchy data. */
  readonly visualQuality?: CopcCameraStreamVisualQualityState;
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
  readonly #runtimeSettings: CopcCameraStreamRuntimeSettings;
  readonly #debounceMilliseconds: number;
  readonly #maxActiveProgressiveNodeRequests: number;
  readonly #progressBatchNodeCount: number;
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
  #lastVisualQuality: CopcCameraStreamVisualQualityState | undefined;
  #lastRendererRevision: number | undefined;
  #safeSwapPointCountHighWaterMark: number | undefined;
  #previousMixedDepthFrontierKeys: readonly string[] = [];
  readonly #seenPendingHierarchyPageSignatures = new Set<string>();

  constructor(options: CopcPointCloudCameraStreamOptions) {
    this.#camera = options.camera;
    this.#layer = options.layer;
    this.#qualitySettings =
      typeof options.quality === "string" || options.quality === undefined
        ? createCopcPointCloudQualitySettings(options.quality)
        : { ...options.quality };
    const runtimeSettings = createCopcCameraStreamRuntimeSettings();
    this.#runtimeSettings = runtimeSettings;
    this.#debounceMilliseconds = normalizeNonNegativeNumber(
      options.debounceMilliseconds,
      runtimeSettings.moveDebounceMilliseconds,
    );
    this.#maxActiveProgressiveNodeRequests =
      runtimeSettings.detailMaxActiveNodeRequests;
    this.#progressBatchNodeCount =
      runtimeSettings.fastRendererProgressBatchNodeCount;
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
        this.#queueRenderForCameraChange();
      }),
      this.#camera.moveEnd.addEventListener(() => {
        this.#queueRenderForCameraChange();
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
    this.#previousMixedDepthFrontierKeys = [];

    while (this.#removeCameraListeners.length > 0) {
      this.#removeCameraListeners.pop()?.();
    }
  }

  cancel(): void {
    this.#clearScheduledRender();
    this.#resetHierarchyFollowupGuard();
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
    const absoluteCameraHeightMeters =
      this.#camera.positionCartographic.height;
    const cameraHeightMeters =
      this.#layer.getCameraHeightAbovePointCloudMeters?.(
        absoluteCameraHeightMeters,
      ) ?? absoluteCameraHeightMeters;
    const lodSettings = createCopcCameraStreamLodSettings({
      cameraHeightMeters,
      qualitySettings: this.#qualitySettings,
    });
    this.#activeAbortController = abortController;

    try {
      const previousFrontierKeys =
        this.#renderOptions.coverageMode === "mixed-depth"
          ? (this.#renderOptions.previousFrontierKeys ??
            this.#previousMixedDepthFrontierKeys)
          : this.#renderOptions.previousFrontierKeys;
      const automaticRenderOptions: CopcPointCloudLayerProgressiveAutomaticRenderOptions = {
        selectionMode: "coverage",
        coverageMode: "complete-depth",
        maxNodes: lodSettings.maxNodes,
        maxDepth: lodSettings.maxDepth,
        maxNodePointCount: lodSettings.maxNodePointCount,
        maxNodePointDataLength: lodSettings.maxNodePointDataLength,
        maxTotalPointCount: lodSettings.maxSourcePointCount,
        maxTotalPointDataLength: lodSettings.maxPointDataLength,
        targetNodeScreenPixels: lodSettings.targetNodeScreenPixels,
        targetPointSpacingScreenPixels:
          lodSettings.targetPointSpacingScreenPixels,
        // Complete-depth terminal renders divide the aggregate budget across
        // the additive set inside the layer. The smaller LOD detail cap is a
        // preview policy and would otherwise leave most of the zoom budget
        // unused when many required nodes are visible.
        maxPointCountPerNode:
          this.#renderOptions.coverageMode === "progressive"
            ? lodSettings.detailMaxPointCountPerNode
            : this.#qualitySettings.maxPointCountPerNode,
        maxRenderedPointCount: lodSettings.maxRenderedPointCount,
        maxActiveProgressiveNodeRequests:
          this.#maxActiveProgressiveNodeRequests,
        expandHierarchy: true,
        maxHierarchyPages: lodSettings.maxHierarchyPages,
        maxHierarchyPageDepth: lodSettings.maxDepth,
        nodeRenderOrder: "selection",
        nodeRequestOrder: "selection",
        progressBatchNodeCount: this.#progressBatchNodeCount,
        progressRenderMode: "incremental",
        includePointsInResult: false,
        includeAncestorNodes: true,
        showBounds: false,
        ...this.#renderOptions,
        previousFrontierKeys,
        camera: this.#camera,
        signal: abortController.signal,
      };

      if (
        isCopcCameraStreamEngineLayer(this.#layer) &&
        supportsCopcCameraStreamEngineOptions(this.#renderOptions)
      ) {
        let didPublishSettledUpdate = false;
        let didCommitCurrentRequestFrame = false;
        const retainedRendererRevision = this.#lastRendererRevision;
        // Intermediate progress may itself become the currently resident GPU
        // frame, but it must not lower the density floor for the next camera
        // transition. Anchor that floor to the exact-terminal high-water mark
        // so rapid superseding moves cannot ratchet 60% of 60% downward.
        const retainedRendererPointCount =
          this.#safeSwapPointCountHighWaterMark;
        const canHoldRetainedRendererFrame =
          this.#qualitySettings.temporalLodSafeSwap &&
          retainedRendererRevision !== undefined &&
          retainedRendererPointCount !== undefined &&
          retainedRendererPointCount > 0 &&
          this.#layer.getRendererRevision?.() === retainedRendererRevision;
        const engineResult = await runCopcCameraStreamEngine({
          layer: this.#layer,
          lodSettings,
          renderOptions: automaticRenderOptions,
          runtimeSettings: this.#runtimeSettings,
          shouldPublish: () =>
            this.#isCurrentRequest(requestId, abortController.signal),
          onProgressCommitted: () => {
            if (this.#isCurrentRequest(requestId, abortController.signal)) {
              this.#lastRendererRevision =
                this.#layer.getRendererRevision?.();
            }
          },
          shouldRenderProgress: canHoldRetainedRendererFrame
            ? (candidate, prepared) => {
                if (didCommitCurrentRequestFrame) {
                  return true;
                }

                if (
                  this.#layer.getRendererRevision?.() !==
                  retainedRendererRevision
                ) {
                  didCommitCurrentRequestFrame = true;
                  return true;
                }

                const safeSwap = createCopcCameraStreamSafeSwapState({
                  candidate,
                  coverageNodeKeys: prepared.renderPlan.coverageNodeKeys,
                  finalNodeKeys: prepared.renderPlan.finalNodeKeys,
                  finalNodeWeights: prepared.finalNodeWeights,
                  renderedPointBudget:
                    prepared.renderPlan.renderedPointBudget,
                  retainedRendererPointCount,
                });

                didCommitCurrentRequestFrame = safeSwap.canSwap;
                return safeSwap.canSwap;
              }
            : undefined,
          onUpdate: ({ stage, result, visualQuality }) => {
            if (!this.#isCurrentRequest(requestId, abortController.signal)) {
              return;
            }

            const phase = stage === "terminal" ? "complete" : "progress";
            didPublishSettledUpdate ||= phase === "complete";
            this.#publishUpdate({
              phase,
              stage,
              requestId,
              lodSettings,
              result,
              visualQuality,
            });
          },
        });

        if (
          !engineResult ||
          !this.#isCurrentRequest(requestId, abortController.signal)
        ) {
          return undefined;
        }

        this.#lastError = undefined;
        this.#rememberMixedDepthFrontier(engineResult.result);
        this.#scheduleHierarchyFollowup(engineResult);

        if (!didPublishSettledUpdate) {
          this.#publishUpdate({
            phase: "complete",
            stage: engineResult.visualQuality.isTerminalReady
              ? "terminal"
              : "interactive-ready",
            requestId,
            lodSettings,
            result: engineResult.result,
            visualQuality: engineResult.visualQuality,
          });
        }

        return engineResult.result;
      }

      const result = await this.#layer.renderAutomaticProgressively({
        ...automaticRenderOptions,
        onProgress: (progressResult) => {
          if (!this.#isCurrentRequest(requestId, abortController.signal)) {
            return;
          }

          const visualQuality = this.#createVisualQuality(progressResult);
          this.#publishUpdate({
            phase: "progress",
            stage: this.#isExplicitPreviewMode() ? "preview" : "refining",
            requestId,
            lodSettings,
            result: progressResult,
            visualQuality,
          });
        },
      });

      if (
        !result ||
        !this.#isCurrentRequest(requestId, abortController.signal)
      ) {
        return undefined;
      }

      const visualQuality = this.#createVisualQuality(result);
      this.#lastError = undefined;
      this.#rememberMixedDepthFrontier(result);
      this.#publishUpdate({
        phase: "complete",
        stage:
          visualQuality?.isTerminalReady === true
            ? "terminal"
            : this.#isExplicitPreviewMode()
              ? "preview"
              : "interactive-ready",
        requestId,
        lodSettings,
        result,
        visualQuality,
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

  get lastVisualQuality(): CopcCameraStreamVisualQualityState | undefined {
    return this.#lastVisualQuality;
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

  #queueRenderForCameraChange(): void {
    // Abort before the debounce window so a superseded layer task cannot
    // mutate the shared renderer after the camera epoch has changed. The
    // renderer itself is intentionally left intact as the transition frame.
    this.cancel();
    this.#queueRender();
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

  #scheduleHierarchyFollowup(result: CopcCameraStreamEngineResult): void {
    if (result.isHierarchyCompleteForView) {
      this.#resetHierarchyFollowupGuard();
      return;
    }

    const signature = result.pendingRelevantHierarchyPageSignature;
    const repeatedSignature =
      signature !== undefined &&
      this.#seenPendingHierarchyPageSignatures.has(signature);

    if (signature) {
      this.#seenPendingHierarchyPageSignatures.add(signature);
    }

    if (!signature || repeatedSignature) {
      return;
    }

    this.#queueRender();
  }

  #resetHierarchyFollowupGuard(): void {
    this.#seenPendingHierarchyPageSignatures.clear();
  }

  #createVisualQuality(
    result: CopcPointCloudLayerAutomaticRenderResult,
  ): CopcCameraStreamVisualQualityState | undefined {
    const frontierNodes = result.cameraSelection?.nodes;
    const frontierNodeKeys = frontierNodes?.map((node) => node.key);
    const renderedNodeKeys = result.pointSamples?.nodeKeys;

    if (!frontierNodeKeys || !renderedNodeKeys) {
      return undefined;
    }

    const hierarchy = this.#layer.hierarchy;

    if (!hierarchy) {
      return undefined;
    }

    const visualQuality = createCopcCameraStreamVisualQualityState({
      frontierNodeKeys,
      requiredNodeKeys: createCopcCameraStreamRenderNodeKeys(
        frontierNodes,
        hierarchy,
      ),
      renderedNodeKeys,
      terminalFrontierMode:
        result.cameraSelection.coverageMode === "mixed-depth"
          ? "mixed-depth-antichain"
          : "same-depth",
    });

    return this.#renderOptions.expandHierarchy === false
      ? withCopcCameraStreamHierarchyQuality(visualQuality, 0, false)
      : visualQuality;
  }

  #publishUpdate(update: CopcPointCloudCameraStreamUpdate): void {
    this.#lastResult = update.result;
    this.#lastVisualQuality = update.visualQuality;
    this.#lastRendererRevision = this.#layer.getRendererRevision?.();
    if (update.stage === "terminal") {
      const sampledPointCount = update.result.pointSamples?.sampledPointCount;
      if (
        typeof sampledPointCount === "number" &&
        Number.isSafeInteger(sampledPointCount) &&
        sampledPointCount > 0
      ) {
        this.#safeSwapPointCountHighWaterMark = Math.max(
          this.#safeSwapPointCountHighWaterMark ?? 0,
          sampledPointCount,
        );
      }
    }
    this.#onUpdate?.(update);
  }

  #rememberMixedDepthFrontier(
    result: CopcPointCloudLayerAutomaticRenderResult,
  ): void {
    const cameraSelection = result.cameraSelection;

    this.#previousMixedDepthFrontierKeys =
      cameraSelection?.coverageMode === "mixed-depth"
        ? (cameraSelection.nodes?.map((node) => node.key) ?? [])
        : [];
  }

  #isExplicitPreviewMode(): boolean {
    return (
      this.#renderOptions.coverageMode === "progressive" ||
      this.#renderOptions.includeAncestorNodes === false
    );
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
