import { describe, expect, it, vi } from "vitest";
import type { Getter } from "copc";
import {
  CopcWorkerRangeRequestBroker,
  type CopcRangeGetterFactory,
} from "./CopcWorkerRangeRequestBroker";
import {
  createCopcRangeGetter,
  type CopcSourceDescriptor,
} from "../core/copc/createCopcRangeGetter";

vi.mock("../core/copc/createCopcRangeGetter", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../core/copc/createCopcRangeGetter")>();

  return {
    ...actual,
    createCopcRangeGetter: vi.fn(actual.createCopcRangeGetter),
  };
});

describe("CopcWorkerRangeRequestBroker", () => {
  it("rejects range requests for unregistered sources", async () => {
    const broker = new CopcWorkerRangeRequestBroker(() => async () =>
      new Uint8Array());

    await expect(
      broker.getRange({ sourceKey: "missing", begin: 0, end: 1 }),
    ).rejects.toThrow("COPC source is not registered: missing");
  });

  it("rejects invalid ranges and outer ranges that do not contain the request", async () => {
    const broker = createBroker(new Uint8Array([1, 2, 3, 4]));
    broker.registerSource(createDescriptor("source"));

    await expect(
      broker.getRange({ sourceKey: "source", begin: 2, end: 1 }),
    ).rejects.toThrow("inner byte range end");
    await expect(
      broker.getRange({ sourceKey: "source", begin: -1, end: 1 }),
    ).rejects.toThrow("begin must be a non-negative safe integer");
    await expect(
      broker.getRange({
        sourceKey: "source",
        begin: 2,
        end: 4,
        fetchBegin: 1,
        fetchEnd: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow("fetchEnd must be a non-negative safe integer");
    await expect(
      broker.getRange({
        sourceKey: "source",
        begin: 2,
        end: 4,
        fetchBegin: 3,
        fetchEnd: 4,
      }),
    ).rejects.toThrow("must contain requested range 2-4");
  });

  it("reads exact requested ranges", async () => {
    const calls: Array<readonly [number, number]> = [];
    const broker = createBroker(new Uint8Array([10, 11, 12]), calls);
    broker.registerSource(createDescriptor("source"));

    await expect(
      broker.getRange({ sourceKey: "source", begin: 5, end: 8 }),
    ).resolves.toEqual(new Uint8Array([10, 11, 12]));
    expect(calls).toEqual([[5, 8]]);
  });

  it("reads planned outer ranges and returns only the requested slice", async () => {
    const calls: Array<readonly [number, number]> = [];
    const broker = createBroker(new Uint8Array([20, 21, 22, 23, 24]), calls);
    broker.registerSource(createDescriptor("source"));

    await expect(
      broker.getRange({
        sourceKey: "source",
        begin: 12,
        end: 15,
        fetchBegin: 10,
        fetchEnd: 15,
      }),
    ).resolves.toEqual(new Uint8Array([22, 23, 24]));
    expect(calls).toEqual([[10, 15]]);
  });

  it("returns an independent byte array for sliced responses", async () => {
    const outerBytes = new Uint8Array([30, 31, 32, 33]);
    const broker = createBroker(outerBytes);
    broker.registerSource(createDescriptor("source"));

    const result = await broker.getRange({
      sourceKey: "source",
      begin: 101,
      end: 103,
      fetchBegin: 100,
      fetchEnd: 104,
    });

    result[0] = 99;

    expect([...result]).toEqual([99, 32]);
    expect([...outerBytes]).toEqual([30, 31, 32, 33]);
    expect(result.buffer).not.toBe(outerBytes.buffer);
  });

  it("creates one getter per registered source", async () => {
    let factoryCallCount = 0;
    const broker = new CopcWorkerRangeRequestBroker(() => {
      factoryCallCount += 1;
      return async (begin, end) => new Uint8Array(end - begin).fill(7);
    });
    broker.registerSource(createDescriptor("source"));
    broker.registerSource(createDescriptor("source"));

    await expect(
      broker.getRange({ sourceKey: "source", begin: 0, end: 2 }),
    ).resolves.toEqual(new Uint8Array([7, 7]));
    await expect(
      broker.getRange({ sourceKey: "source", begin: 4, end: 5 }),
    ).resolves.toEqual(new Uint8Array([7]));

    expect(factoryCallCount).toBe(1);
  });

  it("passes range getter options to the default getter factory", async () => {
    const source = createDescriptor("source");
    const rangeGetterOptions = { maxRangeByteLength: 17 };
    const createGetter = vi.mocked(createCopcRangeGetter);

    createGetter.mockImplementationOnce(() => async () =>
      new Uint8Array([8, 9]));
    const broker = new CopcWorkerRangeRequestBroker(
      undefined,
      rangeGetterOptions,
    );
    broker.registerSource(source);

    await expect(
      broker.getRange({ sourceKey: source.key, begin: 3, end: 5 }),
    ).resolves.toEqual(new Uint8Array([8, 9]));
    expect(createGetter).toHaveBeenCalledWith(
      source.input,
      rangeGetterOptions,
    );
  });

  it("rejects reusing a source key for a different input", () => {
    const broker = createBroker(new Uint8Array());
    broker.registerSource(createDescriptor("source"));

    expect(() =>
      broker.registerSource({
        key: "source",
        input: "https://example.test/different.copc.laz",
      }),
    ).toThrow("already registered with a different input");
  });

});

function createBroker(
  bytes: Uint8Array,
  calls: Array<readonly [number, number]> = [],
): CopcWorkerRangeRequestBroker {
  const factory: CopcRangeGetterFactory = (): Getter => async (begin, end) => {
    calls.push([begin, end]);
    expect(end - begin).toBe(bytes.byteLength);
    return bytes;
  };

  return new CopcWorkerRangeRequestBroker(factory);
}

function createDescriptor(key: string): CopcSourceDescriptor {
  return {
    key,
    input: `https://example.test/${key}.copc.laz`,
  };
}
