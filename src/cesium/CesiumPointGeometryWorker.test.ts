import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CesiumPointGeometryWorkerRequest,
  CesiumPointGeometryWorkerResponse,
} from "./CesiumPointGeometryWorkerProtocol";

const mocks = vi.hoisted(() => ({
  createPointGeometryBatchFromSerializableTransform: vi.fn(() => ({
    key: "batch",
    pointCount: 1,
    positions: new Float64Array(3),
    colors: new Uint8Array(4),
  })),
}));

vi.mock("./pointGeometryBatch", () => ({
  createPointGeometryBatchFromSerializableTransform:
    mocks.createPointGeometryBatchFromSerializableTransform,
}));

describe("CesiumPointGeometryWorker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("forwards the resolved color style into standalone geometry creation", async () => {
    let listener:
      | ((event: { readonly data: CesiumPointGeometryWorkerRequest }) => void)
      | undefined;
    const responses: CesiumPointGeometryWorkerResponse[] = [];

    vi.resetModules();
    vi.stubGlobal(
      "addEventListener",
      (
        type: string,
        nextListener: (
          event: { readonly data: CesiumPointGeometryWorkerRequest },
        ) => void,
      ) => {
        if (type === "message") {
          listener = nextListener;
        }
      },
    );
    vi.stubGlobal(
      "postMessage",
      (response: CesiumPointGeometryWorkerResponse) => {
        responses.push(response);
      },
    );

    await import("./CesiumPointGeometryWorker");

    if (!listener) {
      throw new Error("Expected the worker message listener to be registered.");
    }

    const request = {
      id: 1,
      type: "buildPointGeometryBatch",
      key: "batch",
      pointData: {
        x: new Float64Array([0]),
        y: new Float64Array([0]),
        z: new Float64Array([25]),
      },
      transform: {
        kind: "geographic",
        heightScaleToMeters: 1,
      },
      pointColorStyle: {
        mode: "elevation",
        minimumZ: 0,
        inverseZRange: 0.01,
      },
    } as const;

    listener({ data: request });

    expect(
      mocks.createPointGeometryBatchFromSerializableTransform,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        pointColorStyle: request.pointColorStyle,
      }),
    );
    expect(responses).toEqual([
      expect.objectContaining({
        id: 1,
        type: "buildPointGeometryBatch:success",
      }),
    ]);
  });
});
