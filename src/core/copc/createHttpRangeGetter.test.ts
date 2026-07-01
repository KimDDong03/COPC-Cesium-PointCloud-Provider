import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpRangeGetter } from "./createHttpRangeGetter";

describe("createHttpRangeGetter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves browser-relative COPC URLs against the current page location", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2]), {
      status: 206,
    }));
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");
    const bytes = await getter(10, 12);

    expect([...bytes]).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/copc-samples/sample.copc.laz",
      {
        headers: {
          Range: "bytes=10-11",
        },
      },
    );
  });

  it("retries transient browser range fetch failures", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([3, 4]), {
          status: 206,
        }),
      );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");
    const bytes = await getter(20, 22);

    expect([...bytes]).toEqual([3, 4]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries retriable HTTP range failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([5, 6]), {
          status: 206,
        }),
      );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/sample.copc.laz");
    const bytes = await getter(30, 32);

    expect([...bytes]).toEqual([5, 6]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retriable HTTP range failures", async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 404 }),
    );
    vi.stubGlobal("location", { href: "http://localhost:3000/viewer/" });
    vi.stubGlobal("fetch", fetchMock);

    const getter = createHttpRangeGetter("/copc-samples/missing.copc.laz");

    await expect(getter(40, 42)).rejects.toThrow(
      "COPC range request failed with HTTP 404.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
