import { Copc } from "copc";
import type { Copc as CopcData, Getter } from "copc";
import { createHttpRangeGetter } from "./createHttpRangeGetter";
import { loadCopcNodePointSamples } from "./loadCopcNodePointSamples";
import type {
  CopcPointSampleWorkerRequest,
  CopcPointSampleWorkerResponse,
} from "./CopcPointSampleWorkerProtocol";

interface WorkerCopcSource {
  readonly getter: Getter;
  readonly copc: Promise<CopcData>;
}

const copcSources = new Map<string, WorkerCopcSource>();
const workerScope = globalThis as unknown as {
  addEventListener(
    type: "message",
    listener: (event: { readonly data: CopcPointSampleWorkerRequest }) => void,
  ): void;
  postMessage(message: CopcPointSampleWorkerResponse): void;
};

workerScope.addEventListener("message", (event) => {
  void handleRequest(event.data);
});

async function handleRequest(
  request: CopcPointSampleWorkerRequest,
): Promise<void> {
  try {
    if (request.type !== "loadNodePointSamples") {
      throw new Error(`Unsupported COPC point sample worker request: ${request.type}`);
    }

    const source = getWorkerCopcSource(request.url);
    const result = await loadCopcNodePointSamples({
      getter: source.getter,
      copc: await source.copc,
      nodeKey: request.nodeKey,
      node: request.node,
      maxPointCount: request.maxPointCount,
    });

    workerScope.postMessage({
      id: request.id,
      type: "loadNodePointSamples:success",
      result,
    });
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      type: "loadNodePointSamples:error",
      error: serializeError(error),
    });
  }
}

function getWorkerCopcSource(url: string): WorkerCopcSource {
  let source = copcSources.get(url);

  if (!source) {
    const getter = createHttpRangeGetter(url);
    source = {
      getter,
      copc: Copc.create(getter),
    };
    copcSources.set(url, source);
  }

  return source;
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
