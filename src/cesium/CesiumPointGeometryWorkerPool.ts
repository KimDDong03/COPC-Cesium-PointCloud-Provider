import type { CopcPointDataSampleArrays } from "../core/copc/CopcPointDataSample";
import type { PointGeometryBatch } from "./CopcPointCloudRenderer";
import type { ResolvedCopcPointColorStyle } from "./copcPointColorizer";
import { createCesiumPointGeometryWorker } from "./createCesiumPointGeometryWorker";
import type {
  CesiumPointGeometryWorkerBuildRequest,
  CesiumPointGeometryWorkerResponse,
} from "./CesiumPointGeometryWorkerProtocol";
import type { CesiumPointGeometryTransform } from "./pointGeometryBatch";

export type CesiumPointGeometryLoadingMode =
  | "main-thread"
  | "worker"
  | "integrated-worker";

export interface CesiumPointGeometryWorkerPoolOptions {
  readonly pointGeometryLoading?: CesiumPointGeometryLoadingMode;
  readonly maxConcurrentPointGeometryWorkerRequests?: number;
  readonly createPointGeometryWorker?: () => Worker;
}

interface PointGeometryWorkerRequestEntry {
  worker?: Worker;
  readonly request: CesiumPointGeometryWorkerBuildRequest;
  readonly signal?: AbortSignal;
  readonly cleanup: () => void;
  readonly resolve: (batch: PointGeometryBatch) => void;
  readonly reject: (error: Error) => void;
  state: "queued" | "active";
}

const DEFAULT_MAX_CONCURRENT_POINT_GEOMETRY_WORKER_REQUESTS = 2;

export class CesiumPointGeometryWorkerPool {
  private readonly pointGeometryLoading: CesiumPointGeometryLoadingMode;
  private readonly maxConcurrentPointGeometryWorkerRequests: number;
  private readonly createPointGeometryWorker: () => Worker;
  private readonly workers: Worker[] = [];
  private readonly activeWorkers = new Set<Worker>();
  private readonly requests = new Map<number, PointGeometryWorkerRequestEntry>();
  private readonly queue: PointGeometryWorkerRequestEntry[] = [];
  private workerUnavailable = false;
  private requestId = 0;
  private destroyed = false;

  constructor(options: CesiumPointGeometryWorkerPoolOptions = {}) {
    const maxConcurrentPointGeometryWorkerRequests =
      options.maxConcurrentPointGeometryWorkerRequests ??
      DEFAULT_MAX_CONCURRENT_POINT_GEOMETRY_WORKER_REQUESTS;

    if (
      !Number.isSafeInteger(maxConcurrentPointGeometryWorkerRequests) ||
      maxConcurrentPointGeometryWorkerRequests <= 0
    ) {
      throw new Error(
        "maxConcurrentPointGeometryWorkerRequests must be a positive integer.",
      );
    }

    if (
      options.pointGeometryLoading !== undefined &&
      options.pointGeometryLoading !== "main-thread" &&
      options.pointGeometryLoading !== "worker" &&
      options.pointGeometryLoading !== "integrated-worker"
    ) {
      throw new Error(
        "pointGeometryLoading must be 'main-thread', 'worker', or 'integrated-worker'.",
      );
    }

    this.pointGeometryLoading = options.pointGeometryLoading ?? "main-thread";
    this.maxConcurrentPointGeometryWorkerRequests =
      maxConcurrentPointGeometryWorkerRequests;
    this.createPointGeometryWorker =
      options.createPointGeometryWorker ?? createCesiumPointGeometryWorker;
  }

  buildPointGeometryBatch(
    options: {
      readonly key: string;
      readonly pointData: CopcPointDataSampleArrays;
      readonly transform: CesiumPointGeometryTransform;
      readonly pointColorStyle?: ResolvedCopcPointColorStyle;
      readonly signal?: AbortSignal;
    },
  ): Promise<PointGeometryBatch> | undefined {
    if (this.destroyed || !this.canUseWorker()) {
      return undefined;
    }

    throwIfAborted(options.signal);

    const id = ++this.requestId;
    const request: CesiumPointGeometryWorkerBuildRequest = {
      id,
      type: "buildPointGeometryBatch",
      key: options.key,
      pointData: options.pointData,
      transform: options.transform,
      pointColorStyle: options.pointColorStyle,
    };

    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.cancelRequest(id, createAbortError(options.signal));
      };
      const cleanup = (): void => {
        options.signal?.removeEventListener("abort", abort);
      };

      if (options.signal?.aborted) {
        reject(createAbortError(options.signal));
        return;
      }

      const entry: PointGeometryWorkerRequestEntry = {
        request,
        signal: options.signal,
        cleanup,
        resolve: (batch) => {
          cleanup();
          resolve(batch);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        state: "queued",
      };

      this.requests.set(id, entry);
      options.signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(entry);
      this.drainQueue();
    });
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.terminateAllWorkers(
      new Error("Cesium point geometry worker was terminated."),
    );
  }

  reset(): number {
    if (this.destroyed) {
      return 0;
    }

    const workerCount = this.workers.length;
    this.terminateAllWorkers(
      new Error("Cesium point geometry worker was reset."),
    );
    return workerCount;
  }

  private canUseWorker(): boolean {
    if (
      this.pointGeometryLoading !== "worker" ||
      this.workerUnavailable ||
      this.destroyed
    ) {
      return false;
    }

    if (this.workers.length === 0) {
      const worker = this.createAndRegisterWorker();

      if (worker) {
        this.workers.push(worker);
      } else {
        return false;
      }
    }

    return true;
  }

  private getIdleWorker(): Worker | undefined {
    const idleWorker = this.workers.find(
      (worker) => !this.activeWorkers.has(worker),
    );

    if (idleWorker) {
      return idleWorker;
    }

    if (this.workers.length < this.maxConcurrentPointGeometryWorkerRequests) {
      const worker = this.createAndRegisterWorker();

      if (worker) {
        this.workers.push(worker);
        return worker;
      }
    }

    return undefined;
  }

  private createAndRegisterWorker(): Worker | undefined {
    try {
      const worker = this.createPointGeometryWorker();
      worker.addEventListener("message", (event) => {
        this.handleWorkerMessage(
          event as MessageEvent<CesiumPointGeometryWorkerResponse>,
        );
      });
      worker.addEventListener("error", (event) => {
        this.handleWorkerFailure(
          worker,
          event.error instanceof Error
            ? event.error
            : new Error("Cesium point geometry worker failed."),
        );
      });
      return worker;
    } catch {
      if (this.workers.length === 0) {
        this.workerUnavailable = true;
      }
      return undefined;
    }
  }

  private handleWorkerMessage(
    event: MessageEvent<CesiumPointGeometryWorkerResponse>,
  ): void {
    const response = event.data;
    const request = this.requests.get(response.id);

    if (!request) {
      return;
    }

    this.requests.delete(response.id);
    this.finishRequest(request);

    if (response.type === "buildPointGeometryBatch:success") {
      request.resolve(response.batch);
      return;
    }

    request.reject(createErrorFromWorkerResponse(response.error));
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    const request = [...this.requests.values()].find(
      (entry) => entry.worker === worker,
    );

    this.removeWorker(worker);

    if (!request) {
      return;
    }

    this.requests.delete(request.request.id);
    request.cleanup();
    request.reject(error);
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const worker = this.getIdleWorker();

      if (!worker) {
        return;
      }

      const request = this.queue.shift();

      if (!request || this.requests.get(request.request.id) !== request) {
        continue;
      }

      if (request.signal?.aborted) {
        this.requests.delete(request.request.id);
        request.cleanup();
        request.reject(createAbortError(request.signal));
        continue;
      }

      request.worker = worker;
      request.state = "active";
      this.activeWorkers.add(worker);
      worker.postMessage(request.request);
    }
  }

  private cancelRequest(id: number, error: Error): void {
    const request = this.requests.get(id);

    if (!request) {
      return;
    }

    this.requests.delete(id);
    if (request.state === "queued") {
      this.removeQueuedRequest(request);
    } else {
      this.terminateActiveRequest(request);
    }

    request.cleanup();
    request.reject(error);
    this.drainQueue();
  }

  private removeQueuedRequest(request: PointGeometryWorkerRequestEntry): void {
    const index = this.queue.indexOf(request);

    if (index !== -1) {
      this.queue.splice(index, 1);
    }
  }

  private finishRequest(request: PointGeometryWorkerRequestEntry): void {
    request.cleanup();

    if (request.state === "active") {
      this.finishActiveRequest(request);
      this.drainQueue();
    }
  }

  private finishActiveRequest(request: PointGeometryWorkerRequestEntry): void {
    if (request.worker) {
      this.activeWorkers.delete(request.worker);
      request.worker = undefined;
    }
  }

  private terminateActiveRequest(
    request: PointGeometryWorkerRequestEntry,
  ): void {
    const worker = request.worker;

    if (!worker) {
      return;
    }

    this.removeWorker(worker);
    request.worker = undefined;
  }

  private terminateAllWorkers(error: Error): void {
    const workers = [...this.workers];
    this.workers.length = 0;

    for (const worker of workers) {
      worker.terminate();
    }

    for (const request of this.requests.values()) {
      request.cleanup();
      request.reject(error);
    }

    this.requests.clear();
    this.queue.length = 0;
    this.activeWorkers.clear();
  }

  private removeWorker(worker: Worker): void {
    this.activeWorkers.delete(worker);

    const workerIndex = this.workers.indexOf(worker);
    if (workerIndex !== -1) {
      this.workers.splice(workerIndex, 1);
    }

    worker.terminate();
  }
}

function createErrorFromWorkerResponse(error: {
  readonly name?: string;
  readonly message: string;
  readonly stack?: string;
}): Error {
  const restoredError = new Error(error.message);
  restoredError.name = error.name ?? "Error";
  restoredError.stack = error.stack;
  return restoredError;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  throw createAbortError(signal);
}

function createAbortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }

  if (typeof DOMException !== "undefined") {
    return new DOMException(
      "Cesium point geometry request was aborted.",
      "AbortError",
    );
  }

  const error = new Error("Cesium point geometry request was aborted.");
  error.name = "AbortError";
  return error;
}
