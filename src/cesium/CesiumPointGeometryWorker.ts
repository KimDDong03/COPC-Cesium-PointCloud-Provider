import type {
  CesiumPointGeometryWorkerRequest,
  CesiumPointGeometryWorkerResponse,
} from "./CesiumPointGeometryWorkerProtocol";
import { createPointGeometryBatchFromSerializableTransform } from "./pointGeometryBatch";
import type { PointGeometryBatch } from "./CopcPointCloudRenderer";

const CANCELED_REQUEST_TTL_MS = 60_000;
const canceledRequestIds = new Set<number>();
const workerScope = globalThis as unknown as {
  addEventListener(
    type: "message",
    listener: (event: { readonly data: CesiumPointGeometryWorkerRequest }) => void,
  ): void;
  postMessage(
    message: CesiumPointGeometryWorkerResponse,
    transfer?: readonly Transferable[],
  ): void;
};

workerScope.addEventListener("message", (event) => {
  handleRequest(event.data);
});

function handleRequest(request: CesiumPointGeometryWorkerRequest): void {
  try {
    if (request.type === "cancel") {
      canceledRequestIds.add(request.id);
      setTimeout(() => {
        canceledRequestIds.delete(request.id);
      }, CANCELED_REQUEST_TTL_MS);
      return;
    }

    if (canceledRequestIds.has(request.id)) {
      return;
    }

    const batch = createPointGeometryBatchFromSerializableTransform({
      key: request.key,
      pointData: request.pointData,
      transform: request.transform,
      pointColorStyle: request.pointColorStyle,
    });

    if (canceledRequestIds.delete(request.id)) {
      return;
    }

    workerScope.postMessage(
      {
        id: request.id,
        type: "buildPointGeometryBatch:success",
        batch,
      },
      getPointGeometryBatchTransferables(batch),
    );
  } catch (error) {
    if (canceledRequestIds.delete(request.id)) {
      return;
    }

    workerScope.postMessage({
      id: request.id,
      type: "buildPointGeometryBatch:error",
      error: serializeError(error),
    });
  }
}

function getPointGeometryBatchTransferables(
  batch: PointGeometryBatch,
): Transferable[] {
  const transferables: Transferable[] = [];
  addTransferableBuffer(transferables, batch.positions.buffer);
  addTransferableBuffer(transferables, batch.colors.buffer);
  return transferables;
}

function addTransferableBuffer(
  transferables: Transferable[],
  buffer: ArrayBufferLike,
): void {
  if (buffer instanceof ArrayBuffer) {
    transferables.push(buffer);
  }
}

function serializeError(error: unknown): {
  readonly name?: string;
  readonly message: string;
  readonly stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}
