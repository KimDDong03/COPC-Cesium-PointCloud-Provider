import { describe, expect, it } from "vitest";
import type { Copc as CopcData } from "copc";
import { CesiumCopcPointGeometryWorkerPool } from "./CesiumCopcPointGeometryWorkerPool";
import type { CopcDecodedPointDataCacheSnapshot } from "../core/copc/CopcDecodedPointDataCache";
import type {
  CesiumCopcPointGeometryWorkerInboundMessage,
  CesiumCopcPointGeometryWorkerOutboundMessage,
  CopcNodePointGeometryBatchResult,
} from "./CesiumCopcPointGeometryWorkerProtocol";

describe("CesiumCopcPointGeometryWorkerPool", () => {
  it("brokers a planned outer range and returns only the worker's exact bytes", async () => {
    let worker: RecordingWorker | undefined;
    const bytes = new Uint8Array([10, 11, 12, 13, 14, 15]);
    const source = {
      key: "blob:broker-test",
      input: new Blob([bytes]),
    };
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () => {
        worker = new RecordingWorker();
        return worker as unknown as Worker;
      },
    });
    const result = pool.loadNodePointGeometryBatch({
      source,
      nodeKey: "0-0-0-0",
      node: {
        pointCount: 10,
        pointDataOffset: 2,
        pointDataLength: 2,
      },
      pointDataRange: { begin: 0, end: 6 },
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!worker || !result) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();
    expect(worker.messages[0]).toMatchObject({
      type: "loadNodePointGeometry",
      brokeredRangeRequests: true,
      pointDataRange: { begin: 0, end: 6 },
    });

    worker.dispatchMessage({
      type: "range:request",
      rangeRequestId: 41,
      sourceKey: source.key,
      begin: 2,
      end: 4,
      fetchBegin: 0,
      fetchEnd: 6,
    });
    await expect.poll(() => worker?.messages.length).toBe(2);

    const rangeResponse = worker.messages[1];
    expect(rangeResponse).toMatchObject({
      type: "range:success",
      rangeRequestId: 41,
    });
    if (rangeResponse?.type !== "range:success") {
      throw new Error("Expected brokered range success response.");
    }
    expect([...new Uint8Array(rangeResponse.buffer)]).toEqual([12, 13]);

    worker.dispatchMessage({
      id: 1,
      type: "loadNodePointGeometry:success",
      result: {
        ...createWorkerResult("0-0-0-0"),
        timing: {
          pointDataViewMilliseconds: 12,
          pointDataViewCacheHit: false,
          pointDataViewRangeWaitMilliseconds: 7,
          pointDataViewRangeRequestCount: 2,
          pointDataViewRangeBytes: 6,
          pointDataViewLazPerfMilliseconds: 1,
          pointDataViewNonRangeMilliseconds: 4,
          pointDataViewCacheWaitMilliseconds: 0,
          sampleMilliseconds: 2,
          geometryMilliseconds: 3,
          workerTotalMilliseconds: 17,
        },
      },
    });
    await expect(result).resolves.toMatchObject({
      pointSamples: { nodeKey: "0-0-0-0" },
      timing: {
        pointDataViewRangeWaitMilliseconds: 7,
        pointDataViewRangeRequestCount: 2,
        pointDataViewRangeBytes: 6,
        pointDataViewLazPerfMilliseconds: 1,
        pointDataViewNonRangeMilliseconds: 4,
        pointDataViewCacheWaitMilliseconds: 0,
        requestQueueMilliseconds: expect.any(Number),
        requestRoundTripMilliseconds: expect.any(Number),
      },
    });
  });

  it("passes range getter options to the shared brokered range getter", async () => {
    let worker: RecordingWorker | undefined;
    const bytes = new Uint8Array([10, 11, 12, 13, 14, 15]);
    const source = {
      key: "blob:broker-options-test",
      input: new Blob([bytes]),
    };
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      rangeGetterOptions: { maxRangeByteLength: 3 },
      createCopcPointGeometryWorker: () => {
        worker = new RecordingWorker();
        return worker as unknown as Worker;
      },
    });
    const result = pool.loadNodePointGeometryBatch({
      source,
      nodeKey: "0-0-0-0",
      node: {
        pointCount: 10,
        pointDataOffset: 0,
        pointDataLength: 4,
      },
      pointDataRange: { begin: 0, end: 4 },
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!worker || !result) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();
    worker.dispatchMessage({
      type: "range:request",
      rangeRequestId: 42,
      sourceKey: source.key,
      begin: 0,
      end: 4,
    });
    await expect.poll(() => worker?.messages.length).toBe(2);

    const rangeResponse = worker.messages[1];
    expect(rangeResponse).toMatchObject({
      type: "range:error",
      rangeRequestId: 42,
      error: {
        message: expect.stringContaining(
          "exceeds the configured maximum of 3 bytes",
        ),
      },
    });

    worker.dispatchMessage({
      id: 1,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("0-0-0-0"),
    });
    await expect(result).resolves.toMatchObject({
      pointSamples: { nodeKey: "0-0-0-0" },
    });
  });

  it("plans contiguous point-data ranges without crossing the configured cap", () => {
    const pool = new CesiumCopcPointGeometryWorkerPool({
      maxCoalescedPointDataRangeBytes: 15,
    });
    const plan = pool.planPointDataRanges([
      { key: "a", pointDataOffset: 0, pointDataLength: 10 },
      { key: "b", pointDataOffset: 10, pointDataLength: 10 },
    ]);

    expect(plan.get("a")).toEqual({ begin: 0, end: 10 });
    expect(plan.get("b")).toEqual({ begin: 10, end: 20 });
  });

  it("coalesces small point-data gaps by default without crossing 64 KiB", () => {
    const pool = new CesiumCopcPointGeometryWorkerPool();
    const plan = pool.planPointDataRanges([
      { key: "a", pointDataOffset: 0, pointDataLength: 10 },
      { key: "b", pointDataOffset: 10 + 64 * 1024, pointDataLength: 10 },
      { key: "c", pointDataOffset: 21 + 128 * 1024, pointDataLength: 10 },
    ]);

    expect(plan.get("a")).toEqual({
      begin: 0,
      end: 20 + 64 * 1024,
    });
    expect(plan.get("b")).toEqual(plan.get("a"));
    expect(plan.get("c")).toEqual({
      begin: 21 + 128 * 1024,
      end: 31 + 128 * 1024,
    });
  });

  it("soft-cancels active requests without terminating the worker cache", async () => {
    let worker: RecordingWorker | undefined;
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () => {
        worker = new RecordingWorker();
        return worker as unknown as Worker;
      },
    });
    const abortController = new AbortController();
    const firstResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
      signal: abortController.signal,
    });

    if (!worker || !firstResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    const firstRejects = expect(firstResult).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(worker.messages).toMatchObject([
      {
        id: 1,
        type: "loadNodePointGeometry",
        nodeKey: "0-0-0-0",
      },
    ]);

    abortController.abort();
    await firstRejects;

    expect(worker.terminated).toBe(false);
    expect(worker.messages).toMatchObject([
      {
        id: 1,
        type: "loadNodePointGeometry",
      },
      {
        id: 1,
        type: "cancel",
      },
    ]);

    const secondResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!secondResult) {
      throw new Error("Expected queued worker-backed geometry loading.");
    }

    expect(worker.messages).toHaveLength(2);

    worker.dispatchMessage({
      id: 1,
      type: "loadNodePointGeometry:canceled",
    });
    await Promise.resolve();

    expect(worker.messages).toMatchObject([
      {
        id: 1,
        type: "loadNodePointGeometry",
      },
      {
        id: 1,
        type: "cancel",
      },
      {
        id: 2,
        type: "loadNodePointGeometry",
        nodeKey: "1-0-0-0",
      },
    ]);

    const result = createWorkerResult("1-0-0-0");
    worker.dispatchMessage({
      id: 2,
      type: "loadNodePointGeometry:success",
      result,
    });

    const resolvedSecondResult = await secondResult;
    expect(resolvedSecondResult.pointSamples).toBe(result.pointSamples);
    expect(resolvedSecondResult.geometryBatch).toBe(result.geometryBatch);
    expect(resolvedSecondResult.timing).toMatchObject({
      requestQueueMilliseconds: expect.any(Number),
      requestRoundTripMilliseconds: expect.any(Number),
    });
  });

  it("can terminate canceled active requests so queued current-view work starts immediately", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      activeRequestCancellation: "terminate",
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const abortController = new AbortController();
    const firstResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
      signal: abortController.signal,
    });
    const secondResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!firstResult || !secondResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    const firstRejects = expect(firstResult).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(workers).toHaveLength(1);
    expect(workers[0].messages).toMatchObject([{
      id: 1,
      type: "loadNodePointGeometry",
      nodeKey: "0-0-0-0",
      brokeredRangeRequests: false,
    }]);

    abortController.abort();
    await firstRejects;

    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1].messages).toMatchObject([{
      id: 2,
      type: "loadNodePointGeometry",
      nodeKey: "1-0-0-0",
    }]);

    const result = createWorkerResult("1-0-0-0");
    workers[1].dispatchMessage({
      id: 2,
      type: "loadNodePointGeometry:success",
      result,
    });

    await expect(secondResult).resolves.toMatchObject({
      pointSamples: result.pointSamples,
      geometryBatch: result.geometryBatch,
    });
  });

  it("terminates uncached active workers in terminate-uncached mode", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      activeRequestCancellation: "terminate-uncached",
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const abortController = new AbortController();
    const result = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
      signal: abortController.signal,
    });

    if (!result) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();
    const rejects = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    abortController.abort();
    await rejects;

    expect(workers[0].terminated).toBe(true);
  });

  it("soft-cancels cache-owning active workers in terminate-uncached mode", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      activeRequestCancellation: "terminate-uncached",
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const prefetchResult = pool.prefetchNodePointData({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
    });

    if (!prefetchResult) {
      throw new Error("Expected worker-backed point data prefetch.");
    }

    await waitForScheduledQueueDrain();
    workers[0].dispatchMessage({
      id: 1,
      type: "prefetchNodePointData:success",
      result: {
        nodeKey: "0-0-0-0",
      },
    });
    await prefetchResult;

    const abortController = new AbortController();
    const activeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
      signal: abortController.signal,
    });

    if (!activeResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();
    const rejects = expect(activeResult).rejects.toMatchObject({
      name: "AbortError",
    });
    abortController.abort();
    await rejects;

    expect(workers[0].terminated).toBe(false);
    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "prefetchNodePointData",
      },
      {
        id: 2,
        type: "loadNodePointGeometry",
      },
      {
        id: 2,
        type: "cancel",
      },
    ]);
  });

  it("soft-cancels active workers with decoded data for the active node in terminate-uncached mode", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      activeRequestCancellation: "terminate-uncached",
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const prefetchResult = pool.prefetchNodePointData({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
    });

    if (!prefetchResult) {
      throw new Error("Expected worker-backed point data prefetch.");
    }

    await waitForScheduledQueueDrain();
    workers[0].dispatchMessage({
      id: 1,
      type: "prefetchNodePointData:success",
      result: {
        nodeKey: "0-0-0-0",
      },
    });
    await prefetchResult;

    const abortController = new AbortController();
    const activeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
      signal: abortController.signal,
    });

    if (!activeResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();
    const rejects = expect(activeResult).rejects.toMatchObject({
      name: "AbortError",
    });
    abortController.abort();
    await rejects;

    expect(workers[0].terminated).toBe(false);
    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "prefetchNodePointData",
      },
      {
        id: 2,
        type: "loadNodePointGeometry",
      },
      {
        id: 2,
        type: "cancel",
      },
    ]);

    workers[0].dispatchMessage({
      id: 2,
      type: "loadNodePointGeometry:canceled",
    });

    const cachedResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!cachedResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();
    expect(workers).toHaveLength(1);
    expect(workers[0].messages.at(-1)).toMatchObject({
      id: 3,
      type: "loadNodePointGeometry",
      nodeKey: "0-0-0-0",
    });

    workers[0].dispatchMessage({
      id: 3,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("0-0-0-0"),
    });
    await expect(cachedResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "0-0-0-0",
      }),
    });
  });

  it("replays source-aware warmup when terminate cancellation replaces a worker", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      activeRequestCancellation: "terminate",
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const source = {
      key: "url:https://example.com/a.copc.laz",
      input: "https://example.com/a.copc.laz",
    };

    pool.warmUp({
      workerCount: 1,
      source,
    });

    const abortController = new AbortController();
    const firstResult = pool.loadNodePointGeometryBatch({
      source,
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
      signal: abortController.signal,
    });
    const secondResult = pool.loadNodePointGeometryBatch({
      source,
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!firstResult || !secondResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    expect(workers).toHaveLength(1);
    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "warmup",
        source,
      },
      {
        id: 2,
        type: "loadNodePointGeometry",
        nodeKey: "0-0-0-0",
      },
    ]);

    const firstRejects = expect(firstResult).rejects.toMatchObject({
      name: "AbortError",
    });
    abortController.abort();
    await firstRejects;

    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1].messages).toMatchObject([
      {
        id: 4,
        type: "warmup",
        source,
      },
      {
        id: 3,
        type: "loadNodePointGeometry",
        nodeKey: "1-0-0-0",
      },
    ]);

    const result = createWorkerResult("1-0-0-0");
    workers[1].dispatchMessage({
      id: 3,
      type: "loadNodePointGeometry:success",
      result,
    });

    await expect(secondResult).resolves.toMatchObject({
      pointSamples: result.pointSamples,
      geometryBatch: result.geometryBatch,
    });
  });

  it("prewarms workers without blocking later geometry requests", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 3,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });

    pool.warmUp({
      workerCount: 2,
      source: {
        key: "url:https://example.com/a.copc.laz",
        input: "https://example.com/a.copc.laz",
      },
    });

    expect(workers).toHaveLength(2);
    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "warmup",
        source: {
          key: "url:https://example.com/a.copc.laz",
          input: "https://example.com/a.copc.laz",
        },
      },
    ]);
    expect(workers[1].messages).toMatchObject([
      {
        id: 2,
        type: "warmup",
        source: {
          key: "url:https://example.com/a.copc.laz",
          input: "https://example.com/a.copc.laz",
        },
      },
    ]);

    workers[0].dispatchMessage({
      id: 1,
      type: "warmup:success",
    });

    const result = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    expect(result).toBeDefined();
    await waitForScheduledQueueDrain();

    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "warmup",
      },
      {
        id: 3,
        type: "loadNodePointGeometry",
        nodeKey: "0-0-0-0",
      },
    ]);
  });

  it("forwards parsed COPC metadata to every source-aware warmup", () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 2,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const copc = {
      header: {
        pointDataRecordLength: 16,
      },
    } as CopcData;

    pool.warmUp({
      workerCount: 2,
      source: {
        key: "url:https://example.com/a.copc.laz",
        input: "https://example.com/a.copc.laz",
      },
      copc,
    });

    expect(workers).toHaveLength(2);
    expect(workers.map((worker) => worker.messages[0])).toEqual([
      expect.objectContaining({ copc }),
      expect.objectContaining({ copc }),
    ]);
  });

  it("forwards parsed COPC metadata to geometry and prefetch work requests", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const copc = {
      header: {
        pointDataRecordLength: 16,
      },
    } as CopcData;
    const geometryResult = pool.loadNodePointGeometryBatch({
      copc,
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!geometryResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();
    workers[0].dispatchMessage({
      id: 1,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("0-0-0-0"),
    });
    await geometryResult;

    const prefetchResult = pool.prefetchNodePointData({
      copc,
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
    });

    if (!prefetchResult) {
      throw new Error("Expected worker-backed point data prefetch.");
    }

    await waitForScheduledQueueDrain();

    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "loadNodePointGeometry",
        copc,
      },
      {
        id: 2,
        type: "prefetchNodePointData",
        copc,
      },
    ]);
  });

  it("waits until every requested source-aware warmup finishes", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 2,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const source = {
      key: "url:https://example.com/a.copc.laz",
      input: "https://example.com/a.copc.laz",
    };
    let warmupResolved = false;

    pool.warmUp({
      workerCount: 2,
      source,
    });

    const warmupWait = pool.waitForWarmup().then(() => {
      warmupResolved = true;
    });

    await Promise.resolve();
    expect(warmupResolved).toBe(false);

    workers[0].dispatchMessage({
      id: 1,
      type: "warmup:success",
    });
    await Promise.resolve();
    expect(warmupResolved).toBe(false);

    workers[1].dispatchMessage({
      id: 2,
      type: "warmup:success",
    });
    await warmupWait;

    expect(warmupResolved).toBe(true);
  });

  it("does not leave waiters blocked when a warmup worker reports an error", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });

    pool.warmUp({
      workerCount: 1,
      source: {
        key: "url:https://example.com/a.copc.laz",
        input: "https://example.com/a.copc.laz",
      },
    });

    workers[0].dispatchMessage({
      id: 1,
      type: "warmup:error",
      error: {
        name: "WarmupError",
        message: "warmup failed",
      },
    });

    await expect(pool.waitForWarmup()).resolves.toBeUndefined();
  });

  it("does not leave waiters blocked when a worker crashes during warmup", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });

    pool.warmUp({
      workerCount: 1,
      source: {
        key: "url:https://example.com/a.copc.laz",
        input: "https://example.com/a.copc.laz",
      },
    });

    workers[0].dispatchError(new Error("worker crashed during warmup"));

    await expect(pool.waitForWarmup()).resolves.toBeUndefined();
    expect(workers[0].terminated).toBe(true);
  });

  it("resets active and queued geometry requests without destroying the pool", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const activeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });
    const queuedResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!activeResult || !queuedResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    const activeRejects = expect(activeResult).rejects.toThrow(
      "Cesium COPC point geometry worker was reset.",
    );
    const queuedRejects = expect(queuedResult).rejects.toThrow(
      "Cesium COPC point geometry worker was reset.",
    );

    expect(pool.reset()).toBe(1);
    expect(workers[0].terminated).toBe(true);
    await activeRejects;
    await queuedRejects;

    const nextResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "2-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!nextResult) {
      throw new Error("Expected worker-backed geometry loading after reset.");
    }

    await waitForScheduledQueueDrain();

    expect(workers).toHaveLength(2);
    expect(workers[1].messages).toMatchObject([{
      id: 3,
      type: "loadNodePointGeometry",
      nodeKey: "2-0-0-0",
    }]);

    const result = createWorkerResult("2-0-0-0");
    workers[1].dispatchMessage({
      id: 3,
      type: "loadNodePointGeometry:success",
      result,
    });

    await expect(nextResult).resolves.toMatchObject({
      pointSamples: result.pointSamples,
      geometryBatch: result.geometryBatch,
    });
  });

  it("re-warms workers after reset when a previous warmup source exists", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 2,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const source = {
      key: "url:https://example.com/a.copc.laz",
      input: "https://example.com/a.copc.laz",
    };

    pool.warmUp({
      workerCount: 2,
      source,
    });

    expect(workers).toHaveLength(2);
    expect(workers[0].messages).toMatchObject([{
      id: 1,
      type: "warmup",
      source,
    }]);
    expect(workers[1].messages).toMatchObject([{
      id: 2,
      type: "warmup",
      source,
    }]);

    expect(pool.reset()).toBe(2);
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].terminated).toBe(true);
    expect(workers).toHaveLength(4);
    expect(workers[2].messages).toMatchObject([{
      id: 3,
      type: "warmup",
      source,
    }]);
    expect(workers[3].messages).toMatchObject([{
      id: 4,
      type: "warmup",
      source,
    }]);

    let warmupResolved = false;
    const warmupWait = pool.waitForWarmup().then(() => {
      warmupResolved = true;
    });

    workers[2].dispatchMessage({
      id: 3,
      type: "warmup:success",
    });
    await Promise.resolve();
    expect(warmupResolved).toBe(false);

    workers[3].dispatchMessage({
      id: 4,
      type: "warmup:success",
    });
    await warmupWait;
    expect(warmupResolved).toBe(true);
  });

  it("passes decoded point data cache limits to load requests", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxDecodedPointDataViewsPerWorker: 96,
      maxDecodedPointDataViewBytesPerWorker: 256 * 1024 * 1024,
      maxDecodedPointDataViewBytesAcrossWorkers: 64 * 1024 * 1024,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });

    const result = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    expect(result).toBeDefined();
    await waitForScheduledQueueDrain();

    expect(workers[0]?.messages[0]).toMatchObject({
      type: "loadNodePointGeometry",
      maxDecodedPointDataViews: 96,
      maxDecodedPointDataViewBytes: 32 * 1024 * 1024,
    });
  });

  it("validates decoded point data cache limit options", () => {
    expect(
      () =>
        new CesiumCopcPointGeometryWorkerPool({
          pointGeometryLoading: "integrated-worker",
          maxDecodedPointDataViewsPerWorker: 0,
        }),
    ).toThrow("maxDecodedPointDataViewsPerWorker must be a positive integer.");

    expect(
      () =>
        new CesiumCopcPointGeometryWorkerPool({
          pointGeometryLoading: "integrated-worker",
          maxDecodedPointDataViewBytesPerWorker: 0,
        }),
    ).toThrow(
      "maxDecodedPointDataViewBytesPerWorker must be a positive integer.",
    );

    expect(
      () =>
        new CesiumCopcPointGeometryWorkerPool({
          pointGeometryLoading: "integrated-worker",
          maxDecodedPointDataViewBytesAcrossWorkers: 0,
        }),
    ).toThrow(
      "maxDecodedPointDataViewBytesAcrossWorkers must be a positive integer.",
    );
  });

  it("synchronizes source-aware decoded affinity and cache stats from worker snapshots", async () => {
    const worker = new RecordingWorker();
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      maxDecodedPointDataViewBytesAcrossWorkers: 4_000,
      createCopcPointGeometryWorker: () => worker as unknown as Worker,
    });
    const firstSource = "https://example.com/first.copc.laz";
    const secondSource = "https://example.com/second.copc.laz";
    const firstResult = pool.loadNodePointGeometryBatch({
      url: firstSource,
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: { kind: "geographic", heightScaleToMeters: 1 },
    });

    if (!firstResult) {
      throw new Error("Expected first worker-backed geometry result.");
    }
    await waitForScheduledQueueDrain();
    expect(pool.hasDecodedNodePointData({
      url: firstSource,
      nodeKey: "1-0-0-0",
    })).toBe(false);
    worker.dispatchMessage({
      id: 1,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("1-0-0-0"),
      cache: createDecodedPointDataCacheSnapshot({
        retainedViewCount: 1,
        retainedBytes: 1_600,
        peakRetainedBytes: 1_600,
        cacheMissCount: 1,
        requestedNodeRetained: true,
      }),
    });
    await firstResult;
    expect(pool.hasDecodedNodePointData({
      url: firstSource,
      nodeKey: "1-0-0-0",
    })).toBe(true);

    const secondResult = pool.prefetchNodePointData({
      url: secondSource,
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
    });
    if (!secondResult) {
      throw new Error("Expected second worker-backed prefetch result.");
    }
    await waitForScheduledQueueDrain();
    worker.dispatchMessage({
      id: 2,
      type: "prefetchNodePointData:success",
      result: { nodeKey: "1-0-0-0" },
      cache: createDecodedPointDataCacheSnapshot({
        retainedViewCount: 1,
        retainedBytes: 800,
        peakRetainedBytes: 1_600,
        cacheMissCount: 2,
        cacheEvictionCount: 1,
        requestedNodeRetained: true,
        evictedNodeKeys: [
          {
            sourceKey: `url:${firstSource}`,
            nodeKey: "1-0-0-0",
          },
        ],
      }),
    });
    await secondResult;

    expect(pool.hasDecodedNodePointData({
      url: firstSource,
      nodeKey: "1-0-0-0",
    })).toBe(false);
    expect(pool.hasDecodedNodePointData({
      url: secondSource,
      nodeKey: "1-0-0-0",
    })).toBe(true);
    expect(pool.getDecodedPointDataCacheStats()).toEqual({
      workerCount: 1,
      retainedViewCount: 1,
      retainedBytes: 800,
      peakRetainedBytes: 1_600,
      cacheHitCount: 0,
      cacheMissCount: 2,
      cacheEvictionCount: 1,
      oversizedEntrySkipCount: 0,
      affinityEntryCount: 1,
      maxDecodedPointDataViewBytesPerWorker: 4_000,
      maxDecodedPointDataViewBytesAcrossWorkers: 4_000,
    });
  });

  it("does not create decoded affinity for an oversized unretained response", async () => {
    const worker = new RecordingWorker();
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () => worker as unknown as Worker,
    });
    const result = pool.prefetchNodePointData({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
    });
    if (!result) {
      throw new Error("Expected worker-backed prefetch result.");
    }
    await waitForScheduledQueueDrain();
    worker.dispatchMessage({
      id: 1,
      type: "prefetchNodePointData:success",
      result: { nodeKey: "0-0-0-0" },
      cache: createDecodedPointDataCacheSnapshot({
        cacheMissCount: 1,
        oversizedEntrySkipCount: 1,
        requestedNodeRetained: false,
      }),
    });
    await result;

    expect(pool.hasDecodedNodePointData({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
    })).toBe(false);
    expect(pool.getDecodedPointDataCacheStats()).toEqual(
      expect.objectContaining({
        retainedViewCount: 0,
        oversizedEntrySkipCount: 1,
        affinityEntryCount: 0,
      }),
    );
  });

  it("applies error snapshots without creating affinity for the failed request", async () => {
    const worker = new RecordingWorker();
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () => worker as unknown as Worker,
    });
    const sourceUrl = "https://example.com/a.copc.laz";
    const firstResult = pool.prefetchNodePointData({
      url: sourceUrl,
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
    });
    if (!firstResult) {
      throw new Error("Expected first worker-backed prefetch result.");
    }
    await waitForScheduledQueueDrain();
    worker.dispatchMessage({
      id: 1,
      type: "prefetchNodePointData:success",
      result: { nodeKey: "0-0-0-0" },
      cache: createDecodedPointDataCacheSnapshot({
        retainedViewCount: 1,
        retainedBytes: 1_600,
        peakRetainedBytes: 1_600,
        cacheMissCount: 1,
        requestedNodeRetained: true,
      }),
    });
    await firstResult;

    const failedResult = pool.loadNodePointGeometryBatch({
      url: sourceUrl,
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: { kind: "geographic", heightScaleToMeters: 1 },
    });
    if (!failedResult) {
      throw new Error("Expected failed worker-backed geometry result.");
    }
    await waitForScheduledQueueDrain();
    worker.dispatchMessage({
      id: 2,
      type: "loadNodePointGeometry:error",
      cache: createDecodedPointDataCacheSnapshot({
        retainedViewCount: 1,
        retainedBytes: 800,
        peakRetainedBytes: 1_600,
        cacheMissCount: 2,
        cacheEvictionCount: 1,
        requestedNodeRetained: true,
        evictedNodeKeys: [
          {
            sourceKey: `url:${sourceUrl}`,
            nodeKey: "0-0-0-0",
          },
        ],
      }),
      error: { message: "geometry failed" },
    });
    await expect(failedResult).rejects.toThrow("geometry failed");

    expect(pool.hasDecodedNodePointData({
      url: sourceUrl,
      nodeKey: "0-0-0-0",
    })).toBe(false);
    expect(pool.hasDecodedNodePointData({
      url: sourceUrl,
      nodeKey: "1-0-0-0",
    })).toBe(false);
    expect(pool.getDecodedPointDataCacheStats()).toEqual(
      expect.objectContaining({
        retainedViewCount: 1,
        retainedBytes: 800,
        cacheMissCount: 2,
        cacheEvictionCount: 1,
        affinityEntryCount: 0,
      }),
    );
  });

  it("applies soft-cancel snapshots and retains affinity for decoded data", async () => {
    const worker = new RecordingWorker();
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () => worker as unknown as Worker,
    });
    const sourceUrl = "https://example.com/a.copc.laz";
    const firstResult = pool.prefetchNodePointData({
      url: sourceUrl,
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
    });
    if (!firstResult) {
      throw new Error("Expected first worker-backed prefetch result.");
    }
    await waitForScheduledQueueDrain();
    worker.dispatchMessage({
      id: 1,
      type: "prefetchNodePointData:success",
      result: { nodeKey: "0-0-0-0" },
      cache: createDecodedPointDataCacheSnapshot({
        retainedViewCount: 1,
        retainedBytes: 1_600,
        peakRetainedBytes: 1_600,
        cacheMissCount: 1,
        requestedNodeRetained: true,
      }),
    });
    await firstResult;

    const abortController = new AbortController();
    const canceledResult = pool.prefetchNodePointData({
      url: sourceUrl,
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      signal: abortController.signal,
    });
    if (!canceledResult) {
      throw new Error("Expected canceled worker-backed prefetch result.");
    }
    await waitForScheduledQueueDrain();
    const rejects = expect(canceledResult).rejects.toMatchObject({
      name: "AbortError",
    });
    abortController.abort();
    await rejects;
    worker.dispatchMessage({
      id: 2,
      type: "prefetchNodePointData:canceled",
      cache: createDecodedPointDataCacheSnapshot({
        retainedViewCount: 1,
        retainedBytes: 800,
        peakRetainedBytes: 1_600,
        cacheMissCount: 2,
        cacheEvictionCount: 1,
        requestedNodeRetained: true,
        evictedNodeKeys: [
          {
            sourceKey: `url:${sourceUrl}`,
            nodeKey: "0-0-0-0",
          },
        ],
      }),
    });

    expect(pool.hasDecodedNodePointData({
      url: sourceUrl,
      nodeKey: "0-0-0-0",
    })).toBe(false);
    expect(pool.hasDecodedNodePointData({
      url: sourceUrl,
      nodeKey: "1-0-0-0",
    })).toBe(true);
    expect(pool.getDecodedPointDataCacheStats()).toEqual(
      expect.objectContaining({
        retainedViewCount: 1,
        retainedBytes: 800,
        cacheMissCount: 2,
        cacheEvictionCount: 1,
        affinityEntryCount: 1,
      }),
    );
  });

  it("prefers the worker that already decoded the requested COPC node", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 2,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });

    pool.warmUp({ workerCount: 2 });

    const blockingResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });
    const firstCachedNodeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!blockingResult || !firstCachedNodeResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    expect(workers).toHaveLength(2);
    expect(workers[0].messages.at(-1)).toMatchObject({
      id: 3,
      type: "loadNodePointGeometry",
      nodeKey: "0-0-0-0",
    });
    expect(workers[1].messages.at(-1)).toMatchObject({
      id: 4,
      type: "loadNodePointGeometry",
      nodeKey: "1-0-0-0",
    });

    const firstCachedResult = createWorkerResult("1-0-0-0");
    workers[1].dispatchMessage({
      id: 4,
      type: "loadNodePointGeometry:success",
      result: firstCachedResult,
    });
    await expect(firstCachedNodeResult).resolves.toMatchObject({
      pointSamples: firstCachedResult.pointSamples,
    });

    const blockingWorkerResult = createWorkerResult("0-0-0-0");
    workers[0].dispatchMessage({
      id: 3,
      type: "loadNodePointGeometry:success",
      result: blockingWorkerResult,
    });
    await expect(blockingResult).resolves.toMatchObject({
      pointSamples: blockingWorkerResult.pointSamples,
    });

    const secondCachedNodeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 8,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!secondCachedNodeResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    expect(workers[1].messages.at(-1)).toMatchObject({
      id: 5,
      type: "loadNodePointGeometry",
      nodeKey: "1-0-0-0",
      maxPointCount: 8,
    });
    expect(workers[0].messages.at(-1)).toMatchObject({
      id: 3,
      type: "loadNodePointGeometry",
    });
  });

  it("waits for the decoded-node worker instead of using an uncached fallback worker", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 2,
      decodedNodeWorkerFallbackDelayMilliseconds: Number.POSITIVE_INFINITY,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });

    const firstCachedNodeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!firstCachedNodeResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    expect(workers).toHaveLength(1);
    expect(workers[0].messages).toMatchObject([{
      id: 1,
      type: "loadNodePointGeometry",
      nodeKey: "0-0-0-0",
    }]);

    workers[0].dispatchMessage({
      id: 1,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("0-0-0-0"),
    });
    await expect(firstCachedNodeResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "0-0-0-0",
      }),
    });

    const blockingOtherNodeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!blockingOtherNodeResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "loadNodePointGeometry",
      },
      {
        id: 2,
        type: "loadNodePointGeometry",
        nodeKey: "1-0-0-0",
      },
    ]);

    const secondCachedNodeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 8,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!secondCachedNodeResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    expect(workers).toHaveLength(1);
    expect(workers[0].messages).toHaveLength(2);

    workers[0].dispatchMessage({
      id: 2,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("1-0-0-0"),
    });
    await expect(blockingOtherNodeResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "1-0-0-0",
      }),
    });

    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "loadNodePointGeometry",
      },
      {
        id: 2,
        type: "loadNodePointGeometry",
      },
      {
        id: 3,
        type: "loadNodePointGeometry",
        nodeKey: "0-0-0-0",
        maxPointCount: 8,
      },
    ]);

    workers[0].dispatchMessage({
      id: 3,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("0-0-0-0", 8),
    });
    await expect(secondCachedNodeResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "0-0-0-0",
        sampledPointCount: 8,
      }),
    });
  });

  it("falls back to an idle worker for cached decoded nodes when latency is preferred", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 2,
      decodedNodeWorkerFallbackDelayMilliseconds: 0,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });

    const firstCachedNodeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!firstCachedNodeResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();
    workers[0].dispatchMessage({
      id: 1,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("0-0-0-0"),
    });
    await expect(firstCachedNodeResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "0-0-0-0",
      }),
    });

    const blockingOtherNodeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!blockingOtherNodeResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    const secondCachedNodeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 8,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!secondCachedNodeResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    expect(workers).toHaveLength(2);
    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "loadNodePointGeometry",
      },
      {
        id: 2,
        type: "loadNodePointGeometry",
        nodeKey: "1-0-0-0",
      },
    ]);
    expect(workers[1].messages).toMatchObject([{
      id: 3,
      type: "loadNodePointGeometry",
      nodeKey: "0-0-0-0",
      maxPointCount: 8,
    }]);

    workers[1].dispatchMessage({
      id: 3,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("0-0-0-0", 8),
    });
    await expect(secondCachedNodeResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "0-0-0-0",
        sampledPointCount: 8,
      }),
    });

    workers[0].dispatchMessage({
      id: 2,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("1-0-0-0"),
    });
    await expect(blockingOtherNodeResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "1-0-0-0",
      }),
    });
  });

  it("waits for the active same-node worker while dispatching other queued nodes", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 2,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });

    const firstSameNodeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!firstSameNodeResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    const secondSameNodeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 8,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });
    const otherNodeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!secondSameNodeResult || !otherNodeResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    expect(workers).toHaveLength(2);
    expect(workers[0].messages).toMatchObject([{
      id: 1,
      type: "loadNodePointGeometry",
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
    }]);
    expect(workers[1].messages).toMatchObject([{
      id: 3,
      type: "loadNodePointGeometry",
      nodeKey: "1-0-0-0",
    }]);

    workers[1].dispatchMessage({
      id: 3,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("1-0-0-0"),
    });
    await expect(otherNodeResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "1-0-0-0",
      }),
    });

    expect(workers[1].messages).toHaveLength(1);

    workers[0].dispatchMessage({
      id: 1,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("0-0-0-0"),
    });
    await expect(firstSameNodeResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "0-0-0-0",
      }),
    });

    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "loadNodePointGeometry",
      },
      {
        id: 2,
        type: "loadNodePointGeometry",
        nodeKey: "0-0-0-0",
        maxPointCount: 8,
      },
    ]);

    workers[0].dispatchMessage({
      id: 2,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("0-0-0-0"),
    });
    await expect(secondSameNodeResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "0-0-0-0",
      }),
    });
  });

  it("coalesces identical geometry requests onto one worker task", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });

    const firstResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });
    const secondResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      priority: 20,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!firstResult || !secondResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    expect(workers).toHaveLength(1);
    expect(workers[0].messages).toMatchObject([{
      id: 1,
      type: "loadNodePointGeometry",
      nodeKey: "0-0-0-0",
      maxPointCount: 5,
    }]);

    const result = createWorkerResult("0-0-0-0");
    workers[0].dispatchMessage({
      id: 1,
      type: "loadNodePointGeometry:success",
      result,
    });

    await expect(firstResult).resolves.toMatchObject({
      pointSamples: result.pointSamples,
      geometryBatch: result.geometryBatch,
    });
    await expect(secondResult).resolves.toMatchObject({
      pointSamples: result.pointSamples,
      geometryBatch: result.geometryBatch,
    });
    expect(workers[0].messages).toHaveLength(1);
  });

  it("keeps geometry requests with different resolved color styles separate", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const commonOptions = {
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    } as const;
    const attributeResult = pool.loadNodePointGeometryBatch(commonOptions);
    const elevationResult = pool.loadNodePointGeometryBatch({
      ...commonOptions,
      pointColorStyle: {
        mode: "elevation",
        minimumZ: 10,
        inverseZRange: 0.01,
      },
    });

    if (!attributeResult || !elevationResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();
    expect(workers[0].messages).toHaveLength(1);

    workers[0].dispatchMessage({
      id: 1,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("0-0-0-0"),
    });
    await attributeResult;

    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "loadNodePointGeometry",
      },
      {
        id: 2,
        type: "loadNodePointGeometry",
        pointColorStyle: {
          mode: "elevation",
          minimumZ: 10,
          inverseZRange: 0.01,
        },
      },
    ]);

    workers[0].dispatchMessage({
      id: 2,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("0-0-0-0"),
    });
    await elevationResult;
  });

  it("keeps a coalesced worker task alive when one consumer aborts", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      activeRequestCancellation: "terminate",
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const abortController = new AbortController();
    const firstResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
      signal: abortController.signal,
    });
    const secondResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!firstResult || !secondResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    expect(workers).toHaveLength(1);
    expect(workers[0].messages).toHaveLength(1);

    const firstRejects = expect(firstResult).rejects.toMatchObject({
      name: "AbortError",
    });
    abortController.abort();
    await firstRejects;

    expect(workers[0].terminated).toBe(false);
    expect(workers[0].messages).toHaveLength(1);

    const result = createWorkerResult("0-0-0-0");
    workers[0].dispatchMessage({
      id: 1,
      type: "loadNodePointGeometry:success",
      result,
    });

    await expect(secondResult).resolves.toMatchObject({
      pointSamples: result.pointSamples,
      geometryBatch: result.geometryBatch,
    });
  });

  it("upgrades a queued lower-density geometry request when a denser same-node request arrives", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const activeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!activeResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    const lowerDensityResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      priority: 0,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });
    const higherDensityResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 10,
      priority: 20,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!lowerDensityResult || !higherDensityResult) {
      throw new Error("Expected queued worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();
    expect(workers[0].messages).toMatchObject([{
      id: 1,
      type: "loadNodePointGeometry",
      nodeKey: "0-0-0-0",
    }]);

    workers[0].dispatchMessage({
      id: 1,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("0-0-0-0"),
    });
    await expect(activeResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "0-0-0-0",
      }),
    });

    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "loadNodePointGeometry",
      },
      {
        id: 2,
        type: "loadNodePointGeometry",
        nodeKey: "1-0-0-0",
        maxPointCount: 10,
      },
    ]);

    workers[0].dispatchMessage({
      id: 2,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("1-0-0-0", 10),
    });

    await expect(lowerDensityResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "1-0-0-0",
        sampledPointCount: 5,
      }),
      geometryBatch: expect.objectContaining({
        pointCount: 5,
      }),
    });
    await expect(higherDensityResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "1-0-0-0",
        sampledPointCount: 10,
      }),
      geometryBatch: expect.objectContaining({
        pointCount: 10,
      }),
    });
  });

  it("does not let lower-priority dense geometry upgrade queued current-view warmup", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const activeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      priority: 0,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!activeResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    const warmupResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      priority: 20,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });
    const detailResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 10,
      priority: 10,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!warmupResult || !detailResult) {
      throw new Error("Expected queued worker-backed geometry loading.");
    }

    workers[0].dispatchMessage({
      id: 1,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("0-0-0-0"),
    });
    await expect(activeResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "0-0-0-0",
      }),
    });
    await waitForScheduledQueueDrain();

    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "loadNodePointGeometry",
        nodeKey: "0-0-0-0",
      },
      {
        id: 2,
        type: "loadNodePointGeometry",
        nodeKey: "1-0-0-0",
        maxPointCount: 5,
      },
    ]);

    workers[0].dispatchMessage({
      id: 2,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("1-0-0-0", 5),
    });
    await expect(warmupResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "1-0-0-0",
        sampledPointCount: 5,
      }),
      geometryBatch: expect.objectContaining({
        pointCount: 5,
      }),
    });
    await waitForScheduledQueueDrain();

    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "loadNodePointGeometry",
      },
      {
        id: 2,
        type: "loadNodePointGeometry",
        maxPointCount: 5,
      },
      {
        id: 3,
        type: "loadNodePointGeometry",
        nodeKey: "1-0-0-0",
        maxPointCount: 10,
      },
    ]);

    workers[0].dispatchMessage({
      id: 3,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("1-0-0-0", 10),
    });
    await expect(detailResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "1-0-0-0",
        sampledPointCount: 10,
      }),
      geometryBatch: expect.objectContaining({
        pointCount: 10,
      }),
    });
  });

  it("serves lower-density geometry consumers from an active denser same-node request", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const higherDensityResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 10,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!higherDensityResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    const lowerDensityResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 4,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!lowerDensityResult) {
      throw new Error("Expected coalesced worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();
    expect(workers[0].messages).toMatchObject([{
      id: 1,
      type: "loadNodePointGeometry",
      nodeKey: "0-0-0-0",
      maxPointCount: 10,
    }]);

    workers[0].dispatchMessage({
      id: 1,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("0-0-0-0", 10),
    });

    const higherDensity = await higherDensityResult;
    const lowerDensity = await lowerDensityResult;

    expect(higherDensity).toMatchObject({
      geometryBatch: expect.objectContaining({ pointCount: 10 }),
    });
    expect(lowerDensity).toMatchObject({
      pointSamples: expect.objectContaining({
        sampledPointCount: 4,
      }),
      geometryBatch: expect.objectContaining({
        pointCount: 4,
      }),
    });
    expect([...lowerDensity.geometryBatch.positions]).toEqual(
      [...higherDensity.geometryBatch.positions].slice(0, 12),
    );
    expect([...lowerDensity.geometryBatch.colors]).toEqual(
      [...higherDensity.geometryBatch.colors].slice(0, 16),
    );
    expect(workers[0].messages).toHaveLength(1);
  });

  it("raises queued denser same-node work for a later higher-priority current-view consumer", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const activeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      priority: 0,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!activeResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    const backgroundResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 10,
      priority: -10,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });
    const currentViewResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      priority: 20,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!backgroundResult || !currentViewResult) {
      throw new Error("Expected queued worker-backed geometry loading.");
    }

    workers[0].dispatchMessage({
      id: 1,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("0-0-0-0"),
    });
    await expect(activeResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "0-0-0-0",
      }),
    });
    await waitForScheduledQueueDrain();

    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "loadNodePointGeometry",
        nodeKey: "0-0-0-0",
      },
      {
        id: 2,
        type: "loadNodePointGeometry",
        nodeKey: "1-0-0-0",
        maxPointCount: 10,
      },
    ]);

    workers[0].dispatchMessage({
      id: 2,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("1-0-0-0", 10),
    });

    await expect(backgroundResult).resolves.toMatchObject({
      geometryBatch: expect.objectContaining({
        pointCount: 10,
      }),
    });
    await expect(currentViewResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        sampledPointCount: 5,
      }),
      geometryBatch: expect.objectContaining({
        pointCount: 5,
      }),
    });
    expect(workers[0].messages).toHaveLength(2);
  });

  it("dispatches higher-priority queued geometry requests before older background work", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });

    const activeResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      priority: 0,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!activeResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    expect(workers).toHaveLength(1);
    expect(workers[0].messages).toMatchObject([{
      id: 1,
      type: "loadNodePointGeometry",
      nodeKey: "0-0-0-0",
    }]);

    const backgroundResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      priority: -10,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });
    const currentViewResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "2-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      priority: 20,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!backgroundResult || !currentViewResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    workers[0].dispatchMessage({
      id: 1,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("0-0-0-0"),
    });
    await expect(activeResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "0-0-0-0",
      }),
    });

    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "loadNodePointGeometry",
      },
      {
        id: 3,
        type: "loadNodePointGeometry",
        nodeKey: "2-0-0-0",
      },
    ]);

    workers[0].dispatchMessage({
      id: 3,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("2-0-0-0"),
    });
    await expect(currentViewResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "2-0-0-0",
      }),
    });

    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "loadNodePointGeometry",
      },
      {
        id: 3,
        type: "loadNodePointGeometry",
      },
      {
        id: 2,
        type: "loadNodePointGeometry",
        nodeKey: "1-0-0-0",
      },
    ]);

    workers[0].dispatchMessage({
      id: 2,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("1-0-0-0"),
    });
    await expect(backgroundResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "1-0-0-0",
      }),
    });
  });

  it("batches same-tick geometry requests before dispatching by priority", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 1,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });

    const warmupResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      priority: 0,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });
    const currentViewResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "2-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      priority: 10,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!warmupResult || !currentViewResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();

    expect(workers).toHaveLength(1);
    expect(workers[0].messages).toMatchObject([{
      id: 2,
      type: "loadNodePointGeometry",
      nodeKey: "2-0-0-0",
    }]);

    workers[0].dispatchMessage({
      id: 2,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("2-0-0-0"),
    });
    await expect(currentViewResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "2-0-0-0",
      }),
    });

    expect(workers[0].messages).toMatchObject([
      {
        id: 2,
        type: "loadNodePointGeometry",
      },
      {
        id: 1,
        type: "loadNodePointGeometry",
        nodeKey: "1-0-0-0",
      },
    ]);

    workers[0].dispatchMessage({
      id: 1,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("1-0-0-0"),
    });
    await expect(warmupResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "1-0-0-0",
      }),
    });
  });

  it("prefetches decoded point data without requesting geometry", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxDecodedPointDataViewsPerWorker: 96,
      maxDecodedPointDataViewBytesPerWorker: 256 * 1024 * 1024,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });

    const result = pool.prefetchNodePointData({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      priority: -100,
    });

    if (!result) {
      throw new Error("Expected worker-backed point data prefetch.");
    }

    await waitForScheduledQueueDrain();

    expect(workers).toHaveLength(1);
    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "prefetchNodePointData",
        nodeKey: "0-0-0-0",
        maxDecodedPointDataViews: 96,
        maxDecodedPointDataViewBytes: 256 * 1024 * 1024,
      },
    ]);
    expect(
      pool.hasDecodedNodePointData({
        url: "https://example.com/a.copc.laz",
        nodeKey: "0-0-0-0",
      }),
    ).toBe(false);

    workers[0].dispatchMessage({
      id: 1,
      type: "prefetchNodePointData:success",
      result: {
        nodeKey: "0-0-0-0",
        timing: {
          pointDataViewMilliseconds: 10,
          pointDataViewCacheHit: false,
          pointDataViewRangeWaitMilliseconds: 6,
          pointDataViewRangeRequestCount: 1,
          pointDataViewRangeBytes: 1024,
          pointDataViewLazPerfMilliseconds: 1,
          pointDataViewNonRangeMilliseconds: 3,
          pointDataViewCacheWaitMilliseconds: 0,
          workerTotalMilliseconds: 12,
        },
      },
    });

    await expect(result).resolves.toMatchObject({
      nodeKey: "0-0-0-0",
      timing: {
        pointDataViewRangeWaitMilliseconds: 6,
        pointDataViewRangeRequestCount: 1,
        pointDataViewRangeBytes: 1024,
        pointDataViewLazPerfMilliseconds: 1,
        pointDataViewNonRangeMilliseconds: 3,
        pointDataViewCacheWaitMilliseconds: 0,
        requestQueueMilliseconds: expect.any(Number),
        requestRoundTripMilliseconds: expect.any(Number),
      },
    });
    expect(
      pool.hasDecodedNodePointData({
        url: "https://example.com/a.copc.laz",
        nodeKey: "0-0-0-0",
      }),
    ).toBe(true);
  });

  it("keeps cached decoded nodes on their worker instead of using an uncached fallback worker", async () => {
    const workers: RecordingWorker[] = [];
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      maxConcurrentPointGeometryWorkerRequests: 2,
      decodedNodeWorkerFallbackDelayMilliseconds: Number.POSITIVE_INFINITY,
      createCopcPointGeometryWorker: () => {
        const worker = new RecordingWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });

    const prefetchResult = pool.prefetchNodePointData({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      priority: -100,
    });

    if (!prefetchResult) {
      throw new Error("Expected worker-backed point data prefetch.");
    }

    await waitForScheduledQueueDrain();
    workers[0].dispatchMessage({
      id: 1,
      type: "prefetchNodePointData:success",
      result: {
        nodeKey: "0-0-0-0",
        timing: {
          pointDataViewMilliseconds: 10,
          pointDataViewCacheHit: false,
          workerTotalMilliseconds: 12,
        },
      },
    });
    await prefetchResult;

    const busyResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "1-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      priority: 0,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!busyResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();
    expect(workers).toHaveLength(1);
    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "prefetchNodePointData",
        nodeKey: "0-0-0-0",
      },
      {
        id: 2,
        type: "loadNodePointGeometry",
        nodeKey: "1-0-0-0",
      },
    ]);

    const cachedResult = pool.loadNodePointGeometryBatch({
      url: "https://example.com/a.copc.laz",
      nodeKey: "0-0-0-0",
      node: createWorkerNode(),
      maxPointCount: 5,
      priority: 0,
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
    });

    if (!cachedResult) {
      throw new Error("Expected worker-backed geometry loading.");
    }

    await waitForScheduledQueueDrain();
    expect(workers).toHaveLength(1);
    expect(workers[0].messages).toHaveLength(2);

    workers[0].dispatchMessage({
      id: 2,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("1-0-0-0"),
    });
    await busyResult;

    expect(workers[0].messages).toMatchObject([
      {
        id: 1,
        type: "prefetchNodePointData",
      },
      {
        id: 2,
        type: "loadNodePointGeometry",
      },
      {
        id: 3,
        type: "loadNodePointGeometry",
        nodeKey: "0-0-0-0",
      },
    ]);

    workers[0].dispatchMessage({
      id: 3,
      type: "loadNodePointGeometry:success",
      result: createWorkerResult("0-0-0-0"),
    });
    await expect(cachedResult).resolves.toMatchObject({
      pointSamples: expect.objectContaining({
        nodeKey: "0-0-0-0",
      }),
    });
  });

  it("validates geometry request priority", () => {
    const pool = new CesiumCopcPointGeometryWorkerPool({
      pointGeometryLoading: "integrated-worker",
      createCopcPointGeometryWorker: () =>
        new RecordingWorker() as unknown as Worker,
    });

    expect(() =>
      pool.loadNodePointGeometryBatch({
        url: "https://example.com/a.copc.laz",
        nodeKey: "0-0-0-0",
        node: createWorkerNode(),
        maxPointCount: 5,
        priority: Number.POSITIVE_INFINITY,
        transform: {
          kind: "geographic",
          heightScaleToMeters: 1,
        },
      }),
    ).toThrow("priority must be a finite number.");
  });

  it("validates decoded-node worker fallback delay", () => {
    expect(() =>
      new CesiumCopcPointGeometryWorkerPool({
        pointGeometryLoading: "integrated-worker",
        decodedNodeWorkerFallbackDelayMilliseconds: -1,
        createCopcPointGeometryWorker: () =>
          new RecordingWorker() as unknown as Worker,
      }),
    ).toThrow("decodedNodeWorkerFallbackDelayMilliseconds");
  });

  it("validates active request cancellation mode", () => {
    expect(() =>
      new CesiumCopcPointGeometryWorkerPool({
        pointGeometryLoading: "integrated-worker",
        activeRequestCancellation:
          "cancel-everything" as unknown as "terminate",
        createCopcPointGeometryWorker: () =>
          new RecordingWorker() as unknown as Worker,
      }),
    ).toThrow(
      "activeRequestCancellation must be 'soft', 'terminate-uncached', or 'terminate'.",
    );
  });
});

class RecordingWorker {
  readonly messages: CesiumCopcPointGeometryWorkerInboundMessage[] = [];
  terminated = false;
  private readonly listeners = new Map<
    string,
    Array<
      (event: {
        readonly data?: CesiumCopcPointGeometryWorkerOutboundMessage;
        readonly error?: unknown;
      }) => void
    >
  >();

  addEventListener(
    type: string,
    listener: (event: {
      readonly data?: CesiumCopcPointGeometryWorkerOutboundMessage;
      readonly error?: unknown;
    }) => void,
  ): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  postMessage(message: CesiumCopcPointGeometryWorkerInboundMessage): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  dispatchMessage(response: CesiumCopcPointGeometryWorkerOutboundMessage): void {
    this.listeners.get("message")?.forEach((listener) => {
      listener({ data: response });
    });
  }

  dispatchError(error: Error): void {
    this.listeners.get("error")?.forEach((listener) => {
      listener({ error });
    });
  }
}

async function waitForScheduledQueueDrain(): Promise<void> {
  await Promise.resolve();
}

function createWorkerNode(): WorkerHierarchyNode {
  return {
    pointCount: 10,
    pointDataOffset: 0,
    pointDataLength: 10,
  };
}

function createWorkerResult(
  nodeKey: string,
  pointCount = 0,
): CopcNodePointGeometryBatchResult {
  const positions = new Float64Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    positions[pointIndex * 3] = pointIndex;
    positions[pointIndex * 3 + 1] = pointIndex + 0.1;
    positions[pointIndex * 3 + 2] = pointIndex + 0.2;
    colors[pointIndex * 4] = pointIndex;
    colors[pointIndex * 4 + 1] = pointIndex;
    colors[pointIndex * 4 + 2] = pointIndex;
    colors[pointIndex * 4 + 3] = 255;
  }

  return {
    pointSamples: {
      nodeKey,
      nodePointCount: 10,
      sampledPointCount: pointCount,
      points: [],
    },
    geometryBatch: {
      key: `${nodeKey}:${pointCount}`,
      pointCount,
      positions,
      colors,
    },
  };
}

function createDecodedPointDataCacheSnapshot(
  overrides: Partial<CopcDecodedPointDataCacheSnapshot> = {},
): CopcDecodedPointDataCacheSnapshot {
  return {
    retainedViewCount: 0,
    retainedBytes: 0,
    peakRetainedBytes: 0,
    cacheHitCount: 0,
    cacheMissCount: 0,
    cacheEvictionCount: 0,
    oversizedEntrySkipCount: 0,
    requestedNodeRetained: false,
    evictedNodeKeys: [],
    ...overrides,
  };
}

interface WorkerHierarchyNode {
  readonly pointCount: number;
  readonly pointDataOffset: number;
  readonly pointDataLength: number;
}
