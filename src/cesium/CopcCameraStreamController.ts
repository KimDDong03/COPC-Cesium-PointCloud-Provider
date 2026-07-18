import { shouldReuseCopcCameraStreamNodeKeys } from "./CopcCameraStreamNodePlan";

export interface CopcCameraStreamTimeoutScheduler {
  readonly setTimeout: (callback: () => void, delayMilliseconds: number) => unknown;
  readonly clearTimeout: (timeoutHandle: unknown) => void;
}

export interface CopcCameraStreamRequestControllerOptions {
  readonly maxReusedBackgroundRequests: number;
  readonly minExactNodeOverlapRatio?: number;
  readonly minNodeFamilyOverlapRatio: number;
  readonly reusedBackgroundRequestGraceMilliseconds?: number;
  readonly scheduler: CopcCameraStreamTimeoutScheduler;
}

export interface CopcCameraStreamPreviousRequest {
  readonly abortController: AbortController;
  readonly nodeKeys: readonly string[];
}

export interface CopcCameraStreamStartedRequest {
  readonly abortController: AbortController;
  readonly previousRequest?: CopcCameraStreamPreviousRequest;
  readonly requestId: number;
  readonly signal: AbortSignal;
}

export type CopcCameraStreamPrefetchTask = (
  signal: AbortSignal,
) => Promise<void>;

export interface CopcCameraStreamNodeSampleLike {
  readonly nodeKey: string;
  readonly nodePointCount: number;
  readonly sampledPointCount: number;
}

export interface CopcCameraStreamCommittedRenderReuseOptions<
  TNodeSample extends CopcCameraStreamNodeSampleLike,
> {
  readonly requiredNodeKeys: readonly string[];
  readonly renderedNodeSamples: readonly TNodeSample[];
  readonly maxPointCountPerNode: number;
  readonly previousMaxPointCountPerNode: number;
  readonly renderedPointBudget: number;
  readonly previousRenderedPointBudget: number;
}

export interface CopcCameraStreamProgressRenderDecisionOptions {
  readonly candidateRenderedPointCount: number;
  readonly currentRendererPointCount: number;
  readonly retainsCurrentRendererFrame: boolean;
  readonly isComplete: boolean;
}

export interface CopcCameraStreamNodeSampleCacheOptions<TNodeSample> {
  readonly maxSampleSetCount: number;
  readonly canRenderNodeSample?: (nodeSample: TNodeSample) => boolean;
}

export class CopcCameraStreamRequestController {
  readonly #maxReusedBackgroundRequests: number;
  readonly #minExactNodeOverlapRatio: number;
  readonly #minNodeFamilyOverlapRatio: number;
  readonly #reusedBackgroundRequestGraceMilliseconds: number;
  readonly #scheduler: CopcCameraStreamTimeoutScheduler;
  readonly #reusedAbortControllers = new Map<
    AbortController,
    unknown | undefined
  >();
  #activeAbortController: AbortController | undefined;
  #activeNodeKeys: readonly string[] = [];
  #lastRenderSignature = "";
  #queuedRenderTimeout: unknown;
  #requestId = 0;

  constructor(options: CopcCameraStreamRequestControllerOptions) {
    this.#maxReusedBackgroundRequests = Math.max(
      0,
      options.maxReusedBackgroundRequests,
    );
    this.#minExactNodeOverlapRatio = Math.max(
      0,
      options.minExactNodeOverlapRatio ?? 0,
    );
    this.#minNodeFamilyOverlapRatio = options.minNodeFamilyOverlapRatio;
    this.#reusedBackgroundRequestGraceMilliseconds =
      normalizeGraceMilliseconds(
        options.reusedBackgroundRequestGraceMilliseconds,
      );
    this.#scheduler = options.scheduler;
  }

  startRequest(): CopcCameraStreamStartedRequest {
    this.clearQueuedRender();

    const previousRequest = this.#activeAbortController
      ? {
          abortController: this.#activeAbortController,
          nodeKeys: this.#activeNodeKeys,
        }
      : undefined;
    const abortController = new AbortController();

    this.#activeAbortController = abortController;
    this.#activeNodeKeys = [];
    this.#requestId += 1;

    return {
      abortController,
      previousRequest,
      requestId: this.#requestId,
      signal: abortController.signal,
    };
  }

  setActiveNodeKeys(nodeKeys: readonly string[]): void {
    this.#activeNodeKeys = [...nodeKeys];
  }

  completeRequest(abortController: AbortController): void {
    this.#clearReusedAbortController(abortController);

    if (this.#activeAbortController === abortController) {
      abortController.abort();
      this.#activeAbortController = undefined;
      this.#activeNodeKeys = [];
      this.invalidateRequest();
    }
  }

  isCurrentRequest(requestId: number, signal: AbortSignal): boolean {
    return !signal.aborted && requestId === this.#requestId;
  }

  invalidateRequest(): void {
    this.#requestId += 1;
  }

  cancelRequest(): void {
    this.invalidateRequest();
    this.#activeAbortController?.abort();
    this.#activeAbortController = undefined;
    this.#activeNodeKeys = [];

    for (const abortController of [...this.#reusedAbortControllers.keys()]) {
      abortController.abort();
      this.#clearReusedAbortController(abortController);
    }
  }

  reconcilePreviousRequestForNodeReuse(
    previousRequest: CopcCameraStreamPreviousRequest | undefined,
    nextNodeKeys: readonly string[],
  ): void {
    if (!previousRequest || previousRequest.abortController.signal.aborted) {
      return;
    }

    const canReusePreviousRequest = shouldReuseCopcCameraStreamNodeKeys(
      previousRequest.nodeKeys,
      nextNodeKeys,
      this.#minNodeFamilyOverlapRatio,
      this.#minExactNodeOverlapRatio,
    );

    if (!canReusePreviousRequest) {
      previousRequest.abortController.abort();
      return;
    }

    this.#addReusedAbortController(previousRequest.abortController);
    this.#trimReusedRequests();
  }

  /**
   * Aborts every superseded request while preserving the current request.
   * Use this before a new render-capable task starts; background reuse is only
   * safe for load-only work that cannot mutate a shared renderer.
   */
  abortSupersededRenderRequests(
    previousRequest?: CopcCameraStreamPreviousRequest,
  ): void {
    if (previousRequest) {
      this.#clearReusedAbortController(previousRequest.abortController);
      previousRequest.abortController.abort();
    }

    for (const abortController of [...this.#reusedAbortControllers.keys()]) {
      this.#clearReusedAbortController(abortController);
      abortController.abort();
    }
  }

  queueRender(delayMilliseconds: number, render: () => void): void {
    this.invalidateRequest();
    this.clearQueuedRender();
    this.#queuedRenderTimeout = this.#scheduler.setTimeout(() => {
      this.#queuedRenderTimeout = undefined;
      render();
    }, delayMilliseconds);
  }

  clearQueuedRender(): void {
    if (this.#queuedRenderTimeout === undefined) {
      return;
    }

    this.#scheduler.clearTimeout(this.#queuedRenderTimeout);
    this.#queuedRenderTimeout = undefined;
  }

  clearRenderSignature(): void {
    this.#lastRenderSignature = "";
  }

  hasRenderSignature(renderSignature: string): boolean {
    return renderSignature === this.#lastRenderSignature;
  }

  rememberRenderSignature(renderSignature: string): void {
    this.#lastRenderSignature = renderSignature;
  }

  get reusedRequestCount(): number {
    return this.#reusedAbortControllers.size;
  }

  get isActive(): boolean {
    return (
      this.#activeAbortController !== undefined ||
      this.#queuedRenderTimeout !== undefined
    );
  }

  #trimReusedRequests(): void {
    while (
      this.#reusedAbortControllers.size > this.#maxReusedBackgroundRequests
    ) {
      const oldestAbortController =
        this.#reusedAbortControllers.keys().next().value;

      if (!oldestAbortController) {
        return;
      }

      this.#clearReusedAbortController(oldestAbortController);
      oldestAbortController.abort();
    }
  }

  #addReusedAbortController(abortController: AbortController): void {
    this.#clearReusedAbortController(abortController);

    if (this.#reusedBackgroundRequestGraceMilliseconds <= 0) {
      abortController.abort();
      return;
    }

    const timeoutHandle = Number.isFinite(
      this.#reusedBackgroundRequestGraceMilliseconds,
    )
      ? this.#scheduler.setTimeout(() => {
          this.#abortReusedAbortController(abortController);
        }, this.#reusedBackgroundRequestGraceMilliseconds)
      : undefined;

    this.#reusedAbortControllers.set(abortController, timeoutHandle);
  }

  #abortReusedAbortController(abortController: AbortController): void {
    this.#clearReusedAbortController(abortController);
    abortController.abort();
  }

  #clearReusedAbortController(abortController: AbortController): void {
    if (!this.#reusedAbortControllers.has(abortController)) {
      return;
    }

    const timeoutHandle = this.#reusedAbortControllers.get(abortController);

    if (timeoutHandle !== undefined) {
      this.#scheduler.clearTimeout(timeoutHandle);
    }

    this.#reusedAbortControllers.delete(abortController);
  }
}

export class CopcCameraStreamPrefetchController {
  #abortController: AbortController | undefined;
  #promise: Promise<void> | undefined;

  start(task: CopcCameraStreamPrefetchTask): boolean {
    if (this.#promise) {
      return false;
    }

    const abortController = new AbortController();
    let promise: Promise<void>;

    try {
      promise = task(abortController.signal).catch(() => undefined);
    } catch {
      promise = Promise.resolve();
    }

    this.#abortController = abortController;
    this.#promise = promise;

    void promise.finally(() => {
      if (this.#promise === promise) {
        this.#promise = undefined;
      }

      if (this.#abortController === abortController) {
        this.#abortController = undefined;
      }
    });

    return true;
  }

  cancel(): void {
    this.#abortController?.abort();
    this.#abortController = undefined;
    this.#promise = undefined;
  }

  async waitForIdle(): Promise<void> {
    await this.#promise;
  }

  get isActive(): boolean {
    return this.#promise !== undefined;
  }
}

export class CopcCameraStreamNodeSampleCache<
  TNodeSample extends CopcCameraStreamNodeSampleLike,
> {
  readonly #maxSampleSetCount: number;
  readonly #canRenderNodeSample: (nodeSample: TNodeSample) => boolean;
  readonly #nodeSamples = new Map<string, TNodeSample>();

  constructor(options: CopcCameraStreamNodeSampleCacheOptions<TNodeSample>) {
    this.#maxSampleSetCount = Math.max(0, options.maxSampleSetCount);
    this.#canRenderNodeSample =
      options.canRenderNodeSample ?? (() => true);
  }

  clear(): void {
    this.#nodeSamples.clear();
  }

  remember(nodeSamples: readonly TNodeSample[]): void {
    nodeSamples.forEach((nodeSample) => {
      const cacheKey = createCopcCameraStreamNodeSampleCacheKey(nodeSample);

      this.#nodeSamples.delete(cacheKey);
      this.#nodeSamples.set(cacheKey, nodeSample);
    });

    this.#trim();
  }

  read(
    nodeKeys: readonly string[],
    maxPointCountPerNode: number,
  ): readonly TNodeSample[] {
    return nodeKeys
      .map((nodeKey) => this.find(nodeKey, maxPointCountPerNode))
      .filter(isDefined);
  }

  find(
    nodeKey: string,
    maxPointCountPerNode: number,
  ): TNodeSample | undefined {
    const candidates = [...this.#nodeSamples.values()].filter(
      (nodeSample) => nodeSample.nodeKey === nodeKey,
    );
    const renderableCandidates = candidates.filter((nodeSample) =>
      this.#canRenderNodeSample(nodeSample),
    );

    candidates
      .filter((nodeSample) => !renderableCandidates.includes(nodeSample))
      .forEach((nodeSample) => {
        this.#nodeSamples.delete(
          createCopcCameraStreamNodeSampleCacheKey(nodeSample),
        );
      });

    if (renderableCandidates.length === 0) {
      return undefined;
    }

    const bestCandidate = selectBestCopcCameraStreamNodeSample(
      renderableCandidates,
      maxPointCountPerNode,
    );

    if (bestCandidate) {
      const cacheKey =
        createCopcCameraStreamNodeSampleCacheKey(bestCandidate);
      this.#nodeSamples.delete(cacheKey);
      this.#nodeSamples.set(cacheKey, bestCandidate);
    }

    return bestCandidate;
  }

  get size(): number {
    return this.#nodeSamples.size;
  }

  #trim(): void {
    while (this.#nodeSamples.size > this.#maxSampleSetCount) {
      const oldestCacheKey = this.#nodeSamples.keys().next().value;

      if (!oldestCacheKey) {
        return;
      }

      this.#nodeSamples.delete(oldestCacheKey);
    }
  }
}

export function hasFreshCopcCameraStreamNodeSamples<
  TNodeSample extends CopcCameraStreamNodeSampleLike,
>(
  nodeKeys: readonly string[],
  nodeSamples: readonly TNodeSample[],
  maxPointCountPerNode: number,
): boolean {
  const resultByNodeKey = new Map(
    nodeSamples.map((nodeSample) => [nodeSample.nodeKey, nodeSample]),
  );

  return nodeKeys.every((nodeKey) => {
    const nodeSample = resultByNodeKey.get(nodeKey);

    return (
      nodeSample !== undefined &&
      nodeSample.sampledPointCount >=
        requiredCopcCameraStreamNodeSamplePointCount(
          nodeSample,
          maxPointCountPerNode,
        )
    );
  });
}

/**
 * Returns true when an already committed renderer frame is exactly equivalent
 * to the newly planned terminal composition and density constraints.
 *
 * Callers must additionally verify renderer/layer identity. This helper only
 * proves that the node composition and point-budget contract are unchanged;
 * it does not inspect external renderer state.
 */
export function canReuseCopcCameraStreamCommittedRender<
  TNodeSample extends CopcCameraStreamNodeSampleLike,
>(
  options: CopcCameraStreamCommittedRenderReuseOptions<TNodeSample>,
): boolean {
  if (
    options.maxPointCountPerNode !==
      options.previousMaxPointCountPerNode ||
    options.renderedPointBudget !== options.previousRenderedPointBudget
  ) {
    return false;
  }

  const requiredNodeKeys = uniqueNonEmptyNodeKeys(options.requiredNodeKeys);
  const renderedNodeKeys = uniqueNonEmptyNodeKeys(
    options.renderedNodeSamples.map((nodeSample) => nodeSample.nodeKey),
  );

  if (
    requiredNodeKeys.length === 0 ||
    requiredNodeKeys.length !== renderedNodeKeys.length
  ) {
    return false;
  }

  const renderedNodeKeySet = new Set(renderedNodeKeys);

  return (
    requiredNodeKeys.every((nodeKey) => renderedNodeKeySet.has(nodeKey)) &&
    hasFreshCopcCameraStreamNodeSamples(
      requiredNodeKeys,
      options.renderedNodeSamples,
      options.maxPointCountPerNode,
    )
  );
}

/**
 * Keeps an already committed dense frame until progressive detail either
 * completes or preserves its point count. A previous-request frame must only
 * be supplied when the caller proves that the same-view frame is intentionally
 * retained and still matches the layer's renderer revision.
 */
export function shouldRenderCopcCameraStreamProgress(
  options: CopcCameraStreamProgressRenderDecisionOptions,
): boolean {
  return (
    !options.retainsCurrentRendererFrame ||
    options.isComplete ||
    options.candidateRenderedPointCount >= options.currentRendererPointCount
  );
}

export function mergeCopcCameraStreamNodeSamples<
  TNodeSample extends CopcCameraStreamNodeSampleLike,
>(
  ...groups: ReadonlyArray<readonly TNodeSample[]>
): readonly TNodeSample[] {
  const resultByNodeKey = new Map<string, TNodeSample>();

  groups.flat().forEach((nodeSample) => {
    const previous = resultByNodeKey.get(nodeSample.nodeKey);

    if (
      !previous ||
      nodeSample.sampledPointCount > previous.sampledPointCount
    ) {
      resultByNodeKey.set(nodeSample.nodeKey, nodeSample);
    }
  });

  return [...resultByNodeKey.values()];
}

function selectBestCopcCameraStreamNodeSample<
  TNodeSample extends CopcCameraStreamNodeSampleLike,
>(
  nodeSamples: readonly TNodeSample[],
  maxPointCountPerNode: number,
): TNodeSample | undefined {
  return [...nodeSamples].sort((first, second) => {
    const firstIsFresh = isFreshCopcCameraStreamNodeSample(
      first,
      maxPointCountPerNode,
    )
      ? 1
      : 0;
    const secondIsFresh = isFreshCopcCameraStreamNodeSample(
      second,
      maxPointCountPerNode,
    )
      ? 1
      : 0;

    if (firstIsFresh !== secondIsFresh) {
      return secondIsFresh - firstIsFresh;
    }

    return second.sampledPointCount - first.sampledPointCount;
  })[0];
}

function isFreshCopcCameraStreamNodeSample(
  nodeSample: CopcCameraStreamNodeSampleLike,
  maxPointCountPerNode: number,
): boolean {
  return (
    nodeSample.sampledPointCount >=
    requiredCopcCameraStreamNodeSamplePointCount(
      nodeSample,
      maxPointCountPerNode,
    )
  );
}

function requiredCopcCameraStreamNodeSamplePointCount(
  nodeSample: CopcCameraStreamNodeSampleLike,
  maxPointCountPerNode: number,
): number {
  return Math.min(nodeSample.nodePointCount, maxPointCountPerNode);
}

function createCopcCameraStreamNodeSampleCacheKey(
  nodeSample: CopcCameraStreamNodeSampleLike,
): string {
  return `${nodeSample.nodeKey}:${nodeSample.sampledPointCount}`;
}

function normalizeGraceMilliseconds(value: number | undefined): number {
  if (value === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  if (!Number.isFinite(value)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, value);
}

function uniqueNonEmptyNodeKeys(nodeKeys: readonly string[]): readonly string[] {
  return [...new Set(nodeKeys.filter((nodeKey) => nodeKey.length > 0))];
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
